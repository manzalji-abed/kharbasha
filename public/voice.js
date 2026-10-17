// Voice chat between the players of a room: one direct WebRTC audio connection to every other
// player in voice (a "mesh", light enough for up to 8 people). The room's WebSocket only carries
// the set-up messages; the audio itself goes browser to browser.

import { api } from './net.js';

const SPEAKING_LEVEL = 0.03; // RMS of the waveform that counts as talking
const SPEAKING_HOLD_MS = 400; // keep the glow between words
const MEASURE_MS = 100;
const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export class VoiceChat {
  constructor({ send, onChange }) {
    this.send = send;
    this.onChange = onChange;
    this.meId = null;
    this.local = null; // our microphone stream while in voice
    this.muted = false;
    this.peers = new Map(); // player id → { pc, audio, pending: [] }
    this.blocked = new Set(); // players muted on this device only
    this.speaking = new Set();
    this.levels = new Map(); // player id → { analyser, data, source, loudAt }
    this.iceServers = null;
    this.lastAnnounce = 0;
    this.audioBox = Object.assign(document.createElement('div'), { hidden: true });
    document.body.append(this.audioBox);
  }

  get active() {
    return Boolean(this.local);
  }

  // Must be called from a click: browsers only allow the microphone and audio playback after one.
  async join(meId) {
    if (this.local) return;
    this.meId = meId;
    const [stream] = await Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
      this.loadIceServers(),
    ]);
    this.local = stream;
    this.muted = false;
    this.audioContext ??= new AudioContext();
    await this.audioContext.resume();
    this.watchLevel(meId, stream);
    this.meter = setInterval(() => this.measure(), MEASURE_MS);
    this.announce();
    this.onChange();
  }

  leave({ notify = true } = {}) {
    if (!this.local) return;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const track of this.local.getTracks()) track.stop();
    this.local = null;
    clearInterval(this.meter);
    this.dropLevel(this.meId);
    this.speaking.clear();
    if (notify) this.send('voice', { on: false });
    this.onChange();
  }

  setMuted(muted) {
    if (!this.local) return;
    this.muted = muted;
    for (const track of this.local.getAudioTracks()) track.enabled = !muted;
    this.announce();
    this.onChange();
  }

  // Silence one player on this device only (they don't know).
  toggleBlocked(id) {
    if (this.blocked.has(id)) this.blocked.delete(id);
    else this.blocked.add(id);
    const peer = this.peers.get(id);
    if (peer) peer.audio.muted = this.blocked.has(id);
    this.onChange();
  }

  announce() {
    this.lastAnnounce = Date.now();
    this.send('voice', { on: true, muted: this.muted });
  }

  // Called with every room state: connect to everyone in voice, drop everyone who left.
  sync(players, meId, allowed) {
    this.meId = meId;
    if (!this.local) return;
    if (!allowed) return this.leave({ notify: false });
    const me = players.find(p => p.id === meId);
    if (me && !me.voice) {
      // The server forgot us (we reconnected): start over with fresh connections.
      if (Date.now() - this.lastAnnounce > 3000) {
        for (const id of [...this.peers.keys()]) this.closePeer(id);
        this.announce();
      }
      return;
    }
    const wanted = new Set(players.filter(p => p.id !== meId && p.voice && p.connected).map(p => p.id));
    for (const id of [...this.peers.keys()]) if (!wanted.has(id)) this.closePeer(id);
    // Exactly one side starts each connection: the player with the smaller id.
    for (const id of wanted) if (!this.peers.has(id) && meId < id) this.call(id);
  }

  async loadIceServers() {
    if (this.iceServers) return;
    try {
      this.iceServers = (await api('/api/ice')).iceServers;
    } catch {
      this.iceServers = FALLBACK_ICE;
    }
  }

  createPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers ?? FALLBACK_ICE });
    const audio = Object.assign(new Audio(), { autoplay: true, playsInline: true, muted: this.blocked.has(id) });
    this.audioBox.append(audio);
    const peer = { pc, audio, pending: [] };
    this.peers.set(id, peer);
    for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
    pc.onicecandidate = e => e.candidate && this.send('rtc', { to: id, signal: { candidate: e.candidate.toJSON() } });
    pc.ontrack = e => {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
      this.watchLevel(id, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.meId < id) {
        // Retry once the network settles; the other side accepts a fresh offer.
        this.closePeer(id);
        setTimeout(() => this.local && !this.peers.has(id) && this.call(id), 1500);
      }
      this.onChange();
    };
    return peer;
  }

  async call(id) {
    const { pc } = this.createPeer(id);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      this.send('rtc', { to: id, signal: { description: pc.localDescription.toJSON() } });
    } catch (err) {
      console.warn('voice: offer failed', err);
    }
  }

  async handleSignal(from, signal) {
    if (!this.local || !signal) return;
    let peer = this.peers.get(from);
    try {
      if (signal.description?.type === 'offer') {
        if (peer) this.closePeer(from); // a new offer replaces any older connection
        peer = this.createPeer(from);
        await peer.pc.setRemoteDescription(signal.description);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.send('rtc', { to: from, signal: { description: peer.pc.localDescription.toJSON() } });
        await this.flushCandidates(peer);
      } else if (signal.description?.type === 'answer' && peer) {
        await peer.pc.setRemoteDescription(signal.description);
        await this.flushCandidates(peer);
      } else if (signal.candidate && peer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate);
        else peer.pending.push(signal.candidate);
      }
    } catch (err) {
      console.warn('voice: signal failed', err);
    }
  }

  async flushCandidates(peer) {
    for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
  }

  closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
    this.dropLevel(id);
    this.speaking.delete(id);
  }

  // ---------------------------------------------------------------- "who's talking"

  watchLevel(id, stream) {
    this.dropLevel(id);
    const source = this.audioContext.createMediaStreamSource(stream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    this.levels.set(id, { analyser, source, data: new Float32Array(analyser.fftSize), loudAt: 0 });
  }

  dropLevel(id) {
    this.levels.get(id)?.source.disconnect();
    this.levels.delete(id);
  }

  measure() {
    const now = performance.now();
    let changed = false;
    for (const [id, level] of this.levels) {
      level.analyser.getFloatTimeDomainData(level.data);
      let sum = 0;
      for (const v of level.data) sum += v * v;
      const loud = Math.sqrt(sum / level.data.length) > SPEAKING_LEVEL;
      if (loud && !(id === this.meId && this.muted)) level.loudAt = now;
      const speaking = now - level.loudAt < SPEAKING_HOLD_MS;
      if (speaking !== this.speaking.has(id)) {
        if (speaking) this.speaking.add(id);
        else this.speaking.delete(id);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  // Connection state per player, for the UI ("connecting…" vs connected).
  connectionOf(id) {
    return this.peers.get(id)?.pc.connectionState ?? null;
  }
}
