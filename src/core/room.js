import { LANGS, pickEntries, parseCustomWords } from './words.js';
import { answerKeys, cleanText, isClose, toKey } from './normalize.js';
import { randomId, randomInt, randomString } from './random.js';

export const AVATAR_COUNT = 24;

const CHOOSE_MS = 15_000;
const REVEAL_MS = 6_000;
const GAMEOVER_MS = 15_000;
const AUTOSTART_MS = 20_000;
const GRACE_MS = 20_000; // how long a disconnected player keeps their seat and score
const W = 800; // logical canvas size shared by every client
const H = 600;
const MAX_OPS = 4_000;
const MAX_POINTS = 100_000;
const ORDER_BONUS = [50, 30, 15];
const MAX_VOICE = 8; // every voice player connects to every other one, which stays light up to about 8
const MAX_SIGNAL = 16_000; // bytes of one WebRTC offer/answer/candidate
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const LETTER = /[\p{L}\p{N}]/u;
const TOKEN_RE = /^[\w-]{16,64}$/;
const VISITOR_RE = /^[\w-]{8,64}$/;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function cleanPoints(p, max) {
  if (!Array.isArray(p) || p.length < 2 || p.length > max || p.length % 2) return null;
  const out = new Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    if (!Number.isFinite(p[i]) || !Number.isFinite(p[i + 1])) return null;
    out[i] = clamp(Math.round(p[i]), 0, W);
    out[i + 1] = clamp(Math.round(p[i + 1]), 0, H);
  }
  return out;
}

// Validates what a client sends about itself. The token is the client's secret seat key;
// the visitor id is an anonymous per-browser id used only for usage statistics.
export function cleanProfile(data) {
  return {
    name: cleanText(data?.name, 20) || `Player${100 + randomInt(900)}`,
    avatar: Number.isInteger(data?.avatar) && data.avatar >= 0 && data.avatar < AVATAR_COUNT ? data.avatar : 0,
    token: typeof data?.token === 'string' && TOKEN_RE.test(data.token) ? data.token : randomString(24, 'abcdefghijklmnopqrstuvwxyz0123456789'),
    visitor: typeof data?.visitor === 'string' && VISITOR_RE.test(data.visitor) ? data.visitor : null,
  };
}

/**
 * One game room: players, turns, timer, hints, scoring and the shared drawing.
 * It knows nothing about the network; the hosting platform passes in a transport:
 *   send(connId, event, data)  deliver a message to one connection
 *   close(connId, reason)      tell a connection it is no longer in the room, then drop it
 *   changed()                  room state changed (persist it, refresh the lobby listing)
 *   track(event, data)         a moment worth counting happened (player joined, game started,
 *                              turn ended, game ended); the platform decides where it's stored
 */
export class Room {
  constructor(code, { isPublic = false, lang = 'en' } = {}, transport) {
    this.code = code;
    this.transport = transport;
    this.isPublic = isPublic === true;
    this.settings = { name: '', lang: LANGS.includes(lang) ? lang : 'en', rounds: 3, drawTime: 80, maxPlayers: 10, hints: 2, customOnly: false };
    this.customText = '';
    this.customEntries = [];
    this.players = new Map();
    this.hostId = null;
    this.kicked = new Set();
    this.state = 'lobby'; // lobby → choosing → drawing → reveal → … → gameover → lobby
    this.round = 0;
    this.queue = [];
    this.drawerId = null;
    this.options = null;
    this.entry = null;
    this.answers = [];
    this.revealed = {};
    this.hintTimes = [];
    this.guessCount = 0;
    this.turnStart = 0;
    this.lastReveal = null;
    this.ready = new Set(); // players who pressed Continue on the reveal screen
    this.gameId = null;
    this.gameStartedAt = 0;
    this.usedWords = new Set();
    this.history = [];
    this.historyPoints = 0;
    this.stroke = null;
    this.timer = null;
    this.ticker = null;
    this.deadline = 0;
  }

  get connected() {
    return [...this.players.values()].filter(p => p.connected);
  }

  get inGame() {
    return this.state === 'choosing' || this.state === 'drawing' || this.state === 'reveal';
  }

  langs() {
    return this.settings.lang === 'both' ? ['en', 'ar'] : [this.settings.lang];
  }

  label(entry) {
    const out = {};
    for (const lang of this.langs()) if (entry[lang]?.length) out[lang] = entry[lang][0];
    return out;
  }

  summary() {
    return {
      code: this.code,
      name: this.settings.name,
      isPublic: this.isPublic,
      lang: this.settings.lang,
      players: this.connected.length,
      maxPlayers: this.settings.maxPlayers,
      state: this.state,
      round: this.round,
      rounds: this.settings.rounds,
      host: this.players.get(this.hostId)?.name ?? '',
    };
  }

  // ---------------------------------------------------------------- persistence

  // What must survive the room being unloaded from memory. A running game can't be resumed,
  // so only the room itself (settings, players, scores) is kept and play restarts from the lobby.
  // Voice flags are kept too: a quiet room sleeps while its players are still talking, and their
  // audio (which flows between browsers, not through the room) must not be cut when it wakes.
  snapshot() {
    return {
      code: this.code,
      isPublic: this.isPublic,
      settings: this.settings,
      customText: this.customText,
      hostId: this.hostId,
      kicked: [...this.kicked],
      players: [...this.players.values()].map(({ id, token, visitor, bot, name, avatar, score, voice, muted }) =>
        ({ id, token, visitor, bot, name, avatar, score, voice: Boolean(voice), muted: Boolean(muted) })),
    };
  }

  // `live` maps player id → connection id for connections that are still open.
  // Everyone else gets the usual grace period to come back.
  static restore(snapshot, transport, live) {
    const room = new Room(snapshot.code, { isPublic: snapshot.isPublic }, transport);
    Object.assign(room.settings, snapshot.settings);
    room.customText = snapshot.customText;
    room.customEntries = parseCustomWords(snapshot.customText);
    room.kicked = new Set(snapshot.kicked);
    for (const p of snapshot.players) {
      const connected = live.has(p.id);
      const voice = connected && !room.isPublic && p.voice === true;
      const player = { ...p, gain: 0, guessed: false, connId: live.get(p.id) ?? null, connected, voice, muted: voice && p.muted === true };
      room.players.set(p.id, player);
      if (!player.connected) player.graceTimer = setTimeout(() => room.remove(player.id, 'left'), GRACE_MS);
    }
    room.hostId = room.players.has(snapshot.hostId) ? snapshot.hostId : null;
    if (!room.players.get(room.hostId)?.connected) room.pickHost();
    room.checkAutostart();
    return room;
  }

  // ---------------------------------------------------------------- membership

  // `client` is what the platform knows about the connection (country, device…), for statistics.
  join(connId, profile, client = {}) {
    if (this.kicked.has(profile.token)) return { error: 'kicked' };
    let player = [...this.players.values()].find(p => p.token === profile.token);
    if (player) {
      clearTimeout(player.graceTimer);
      if (player.connected && player.connId !== connId) this.transport.close(player.connId, 'elsewhere');
      Object.assign(player, { name: profile.name, avatar: profile.avatar });
    } else {
      if (this.players.size >= this.settings.maxPlayers) return { error: 'full' };
      player = {
        id: randomId(),
        token: profile.token,
        visitor: profile.visitor,
        bot: client.bot === true,
        name: profile.name,
        avatar: profile.avatar,
        score: 0,
        gain: 0,
        guessed: false,
        voice: false,
        muted: false,
      };
      this.players.set(player.id, player);
      if (this.inGame) this.queue.push(player.id);
      this.track('player_joined', { visitor: profile.visitor, name: profile.name, ...client });
    }
    player.connId = connId;
    player.connected = true;
    if (!this.players.get(this.hostId)?.connected) this.hostId = player.id;

    this.system('joined', { name: player.name });
    this.broadcastState();
    this.send(player, 'draw:history', this.history);
    this.checkAutostart();
    return { ok: true, playerId: player.id };
  }

  disconnect(player) {
    // Their audio connections are gone; the browser rejoins voice itself after reconnecting.
    Object.assign(player, { connected: false, voice: false, muted: false });
    player.graceTimer = setTimeout(() => this.remove(player.id, 'left'), GRACE_MS);
    if (this.hostId === player.id) this.pickHost();
    if (this.drawerId === player.id && (this.state === 'choosing' || this.state === 'drawing')) {
      this.endTurn('drawerLeft');
    } else if (!this.checkAllReady()) {
      this.checkAllGuessed();
      this.checkAutostart();
      this.broadcastState();
    }
  }

  remove(id, reason) {
    const player = this.players.get(id);
    if (!player) return;
    clearTimeout(player.graceTimer);
    this.players.delete(id);
    this.queue = this.queue.filter(x => x !== id);
    if (reason === 'kicked' && player.connected) this.transport.close(player.connId, 'kicked');
    this.system(reason === 'kicked' ? 'kicked' : 'left', { name: player.name });
    if (this.players.size === 0) return this.toLobby();
    if (this.hostId === id) this.pickHost();

    if (this.inGame && this.connected.length < 2) {
      this.system('notEnough');
      return this.toLobby();
    }
    if (this.drawerId === id && (this.state === 'choosing' || this.state === 'drawing')) return this.endTurn('drawerLeft');
    if (this.checkAllReady()) return;
    this.checkAllGuessed();
    this.checkAutostart();
    this.broadcastState();
  }

  kick(by, targetId) {
    const target = this.players.get(targetId);
    if (!target || by.id !== this.hostId || target.id === by.id) return;
    this.kicked.add(target.token);
    this.remove(target.id, 'kicked');
  }

  pickHost() {
    const next = this.connected[0] ?? [...this.players.values()][0];
    if (!next || next.id === this.hostId) return;
    this.hostId = next.id;
    if (next.connected) this.system('host', { name: next.name });
  }

  destroy() {
    this.clearTimers();
    for (const p of this.players.values()) clearTimeout(p.graceTimer);
    this.players.clear();
  }

  // ---------------------------------------------------------------- timers

  setTimer(ms, fn) {
    clearTimeout(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deadline = 0;
      fn();
    }, ms);
  }

  clearTimers() {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    this.timer = this.ticker = null;
    this.deadline = 0;
  }

  // ---------------------------------------------------------------- settings

  updateSettings(player, s) {
    if (player.id !== this.hostId || this.state !== 'lobby') return;
    const st = this.settings;
    if (typeof s.name === 'string') st.name = cleanText(s.name, 30);
    if (LANGS.includes(s.lang)) st.lang = s.lang;
    if (Number.isInteger(s.rounds)) st.rounds = clamp(s.rounds, 1, 10);
    if (Number.isInteger(s.drawTime)) st.drawTime = clamp(s.drawTime, 30, 240);
    if (Number.isInteger(s.maxPlayers)) st.maxPlayers = clamp(s.maxPlayers, Math.max(2, this.players.size), 16);
    if (Number.isInteger(s.hints)) st.hints = clamp(s.hints, 0, 3);
    if (typeof s.customOnly === 'boolean') st.customOnly = s.customOnly;
    if (typeof s.isPublic === 'boolean') this.isPublic = s.isPublic;
    if (this.isPublic) for (const p of this.players.values()) Object.assign(p, { voice: false, muted: false });
    if (typeof s.customText === 'string') {
      this.customText = s.customText.slice(0, 5000);
      this.customEntries = parseCustomWords(this.customText);
    }
    this.broadcastState();
    this.checkAutostart();
  }

  // Public rooms start by themselves so strangers are never stuck waiting on an idle host.
  checkAutostart() {
    if (this.state !== 'lobby') return;
    const want = this.isPublic && this.connected.length >= 2;
    if (want && !this.timer) {
      this.setTimer(AUTOSTART_MS, () => this.startGame());
      this.broadcastState();
    } else if (!want && this.timer) {
      this.clearTimers();
      this.broadcastState();
    }
  }

  // ---------------------------------------------------------------- game flow

  startGame() {
    if (this.state !== 'lobby' && this.state !== 'gameover') return;
    if (this.connected.length < 2) {
      this.system('needPlayers');
      return;
    }
    this.clearTimers();
    for (const p of this.players.values()) Object.assign(p, { score: 0, gain: 0, guessed: false });
    this.round = 0;
    this.usedWords.clear();
    this.gameId = randomId();
    this.gameStartedAt = Date.now();
    this.track('game_started', {
      gameId: this.gameId,
      roomName: this.settings.name,
      lang: this.settings.lang,
      isPublic: this.isPublic,
      players: this.connected.length,
      rounds: this.settings.rounds,
    });
    this.nextRound();
  }

  nextRound() {
    this.round++;
    if (this.round > this.settings.rounds) return this.endGame();
    this.queue = this.connected.map(p => p.id);
    this.system('round', { n: this.round });
    this.nextTurn();
  }

  nextTurn() {
    this.clearTimers();
    if (this.connected.length < 2) {
      this.system('notEnough');
      return this.toLobby();
    }
    let drawer = null;
    while (!drawer && this.queue.length) {
      const p = this.players.get(this.queue.shift());
      if (p?.connected) drawer = p;
    }
    if (!drawer) return this.nextRound();

    for (const p of this.players.values()) Object.assign(p, { gain: 0, guessed: false });
    Object.assign(this, { drawerId: drawer.id, entry: null, answers: [], lastReveal: null, guessCount: 0 });
    this.resetCanvas();
    this.options = pickEntries(3, this.settings.lang, this.customEntries, this.settings.customOnly, this.usedWords);
    this.state = 'choosing';
    this.setTimer(CHOOSE_MS, () => this.chooseWord(drawer, randomInt(this.options.length)));
    this.broadcastState();
  }

  chooseWord(player, index) {
    if (this.state !== 'choosing' || player.id !== this.drawerId) return;
    const entry = this.options?.[index];
    if (!entry) return;
    this.entry = entry;
    this.options = null;
    this.usedWords.add(entry.key);
    this.answers = answerKeys(entry, this.langs());
    this.revealed = Object.fromEntries(Object.keys(this.label(entry)).map(lang => [lang, new Set()]));

    const total = this.settings.drawTime * 1000;
    const hints = this.settings.hints;
    this.hintTimes = Array.from({ length: hints }, (_, i) => total * (0.35 + (0.5 * (i + 1)) / (hints + 1)));
    this.state = 'drawing';
    this.turnStart = Date.now();
    this.setTimer(total, () => this.endTurn('timeUp'));
    this.ticker = setInterval(() => this.tickHints(), 1000);
    this.system('drawing', { name: player.name });
    this.broadcastState();
  }

  tickHints() {
    if (this.state !== 'drawing') return;
    const elapsed = Date.now() - this.turnStart;
    let changed = false;
    while (this.hintTimes.length && elapsed >= this.hintTimes[0]) {
      this.hintTimes.shift();
      changed = this.revealLetter() || changed;
    }
    if (changed) this.broadcastState();
  }

  // Reveals one more letter per language, but never more than half the word.
  revealLetter() {
    let changed = false;
    for (const [lang, shown] of Object.entries(this.revealed)) {
      const chars = Array.from(this.entry[lang][0]);
      const letters = chars.filter(c => LETTER.test(c)).length;
      const hidden = chars.map((c, i) => i).filter(i => LETTER.test(chars[i]) && !shown.has(i));
      if (shown.size >= Math.floor((letters - 1) / 2) || !hidden.length) continue;
      shown.add(hidden[randomInt(hidden.length)]);
      changed = true;
    }
    return changed;
  }

  masks() {
    return Object.entries(this.revealed).map(([lang, shown]) => ({
      lang,
      chars: Array.from(this.entry[lang][0]).map((c, i) => (!LETTER.test(c) || shown.has(i) ? c : null)),
    }));
  }

  correctGuess(player) {
    const total = this.settings.drawTime * 1000;
    const remaining = Math.max(0, this.deadline - Date.now());
    const gain = 100 + Math.round((200 * remaining) / total) + (ORDER_BONUS[this.guessCount] ?? 0);
    this.guessCount++;
    Object.assign(player, { guessed: true, gain, score: player.score + gain });
    this.system('guessed', { name: player.name }, 'correct');
    this.broadcastState();
    this.checkAllGuessed();
  }

  checkAllGuessed() {
    if (this.state !== 'drawing') return;
    const guessers = this.connected.filter(p => p.id !== this.drawerId);
    if (guessers.length && guessers.every(p => p.guessed)) this.endTurn('allGuessed');
  }

  endTurn(reason) {
    if (this.state !== 'choosing' && this.state !== 'drawing') return;
    const wasDrawing = this.state === 'drawing';
    this.clearTimers();
    const drawer = this.players.get(this.drawerId);
    const guessers = [...this.players.values()].filter(p => p.id !== this.drawerId && (p.connected || p.guessed));
    const correct = guessers.filter(p => p.guessed).length;
    if (wasDrawing && drawer && correct) {
      drawer.gain = Math.round((200 * correct) / guessers.length);
      drawer.score += drawer.gain;
    }
    if (wasDrawing) {
      this.track('turn_ended', {
        gameId: this.gameId,
        wordEn: this.entry.en[0] ?? null,
        wordAr: this.entry.ar[0] ?? null,
        custom: this.entry.key.startsWith('c:'),
        drawer: drawer?.name ?? null,
        guessers: guessers.length,
        correct,
        durationMs: Date.now() - this.turnStart,
        reason,
      });
    }
    this.lastReveal = { reason, word: this.entry ? this.label(this.entry) : null };
    this.state = 'reveal';
    this.options = null;
    this.ready.clear();
    this.setTimer(this.entry ? REVEAL_MS : 2_500, () => this.nextTurn());
    this.broadcastState();
  }

  // Continue button on the reveal screen: once everyone still here has pressed it, move on.
  markReady(player) {
    if (this.state !== 'reveal') return;
    this.ready.add(player.id);
    if (!this.checkAllReady()) this.broadcastState();
  }

  checkAllReady() {
    if (this.state !== 'reveal') return false;
    const waiting = this.connected.filter(p => !this.ready.has(p.id));
    if (waiting.length || !this.ready.size) return false;
    this.nextTurn();
    return true;
  }

  endGame() {
    this.clearTimers();
    this.finishGame(true);
    Object.assign(this, { state: 'gameover', drawerId: null, entry: null, options: null });
    this.setTimer(GAMEOVER_MS, () => this.toLobby());
    this.broadcastState();
  }

  // Records how a game ended: played to the end, or abandoned when players left.
  finishGame(completed) {
    if (!this.gameId) return;
    const ranked = [...this.players.values()].sort((a, b) => b.score - a.score);
    this.track('game_ended', {
      gameId: this.gameId,
      completed,
      durationMs: Date.now() - this.gameStartedAt,
      winner: completed ? ranked[0]?.name ?? null : null,
      players: this.players.size,
    });
    this.gameId = null;
  }

  toLobby() {
    this.finishGame(false);
    this.clearTimers();
    Object.assign(this, { state: 'lobby', round: 0, queue: [], drawerId: null, entry: null, options: null, lastReveal: null });
    for (const p of this.players.values()) p.guessed = false;
    this.resetCanvas();
    this.broadcastState();
    this.checkAutostart();
  }

  // ---------------------------------------------------------------- chat & drawing

  handleChat(player, raw) {
    const text = cleanText(raw, 100);
    if (!text) return;
    const msg = { type: 'msg', from: player.id, name: player.name, text };
    if (this.state === 'drawing') {
      // The drawer and players who already guessed talk on a private channel so they can't leak the word.
      if (player.id === this.drawerId || player.guessed) {
        msg.type = 'secret';
        for (const p of this.players.values()) if (p.id === this.drawerId || p.guessed) this.send(p, 'chat', msg);
        return;
      }
      const key = toKey(text);
      if (this.answers.includes(key)) return this.correctGuess(player);
      this.emit('chat', msg);
      if (isClose(key, this.answers)) this.send(player, 'chat', { type: 'close', key: 'close', params: { text } });
      return;
    }
    this.emit('chat', msg);
  }

  handleDraw(player, op) {
    if (this.state !== 'drawing' || player.id !== this.drawerId || !op || typeof op !== 'object') return;
    const relay = data => this.emit('draw', data, player.id);
    switch (op.k) {
      case 'b': {
        const p = cleanPoints(op.p, 2);
        if (!p || !COLOR_RE.test(op.c) || !Number.isInteger(op.s) || this.history.length >= MAX_OPS) return;
        const stroke = { k: 's', i: op.i | 0, c: op.c.toLowerCase(), s: clamp(op.s, 1, 60), p };
        this.history.push(stroke);
        this.historyPoints += 1;
        this.stroke = stroke;
        return relay({ k: 'b', i: stroke.i, c: stroke.c, s: stroke.s, p });
      }
      case 'm': {
        const stroke = this.stroke;
        const p = cleanPoints(op.p, 400);
        if (!stroke || stroke.i !== (op.i | 0) || !p || this.historyPoints + p.length / 2 > MAX_POINTS) return;
        stroke.p.push(...p);
        this.historyPoints += p.length / 2;
        return relay({ k: 'm', i: stroke.i, p });
      }
      case 'f': {
        if (!COLOR_RE.test(op.c) || !Number.isFinite(op.x) || !Number.isFinite(op.y) || this.history.length >= MAX_OPS) return;
        const fill = { k: 'f', x: clamp(Math.round(op.x), 0, W - 1), y: clamp(Math.round(op.y), 0, H - 1), c: op.c.toLowerCase() };
        this.history.push(fill);
        this.stroke = null;
        return relay(fill);
      }
      case 'u': {
        const last = this.history.pop();
        if (!last) return;
        if (last.k === 's') this.historyPoints -= last.p.length / 2;
        this.stroke = null;
        return relay({ k: 'u' });
      }
      case 'x':
        this.resetCanvas(player.id);
    }
  }

  resetCanvas(exceptId) {
    this.history = [];
    this.historyPoints = 0;
    this.stroke = null;
    this.emit('draw', { k: 'x' }, exceptId);
  }

  // ---------------------------------------------------------------- voice chat

  // Voice is only offered in private rooms (people who know each other), mic off until each player opts in.
  setVoice(player, { on, muted } = {}) {
    const joining = on === true && !player.voice;
    if (on === true && this.isPublic) return this.send(player, 'chat', { type: 'sys', key: 'voicePrivateOnly', params: {} });
    if (joining && this.connected.filter(p => p.voice).length >= MAX_VOICE) {
      return this.send(player, 'chat', { type: 'sys', key: 'voiceFull', params: { n: MAX_VOICE } });
    }
    const leaving = on === false && player.voice;
    player.voice = on === true;
    player.muted = player.voice && muted === true;
    if (joining) {
      this.system('voiceOn', { name: player.name });
      if (!player.bot) this.track('voice_joined', { visitor: player.visitor, name: player.name });
    }
    if (leaving) this.system('voiceOff', { name: player.name });
    this.broadcastState();
  }

  // Passes WebRTC set-up messages (offers, answers, network candidates) between two voice players.
  relaySignal(from, toId, signal) {
    const to = this.players.get(toId);
    if (!from.voice || !to?.voice || !signal || typeof signal !== 'object') return;
    if (JSON.stringify(signal).length > MAX_SIGNAL) return;
    this.send(to, 'rtc', { from: from.id, signal });
  }

  // ---------------------------------------------------------------- state sync

  send(player, event, data) {
    if (player.connected) this.transport.send(player.connId, event, data);
  }

  emit(event, data, exceptId) {
    for (const p of this.players.values()) if (p.id !== exceptId) this.send(p, event, data);
  }

  system(key, params = {}, type = 'sys') {
    this.emit('chat', { type, key, params });
  }

  track(event, data) {
    this.transport.track?.(event, data);
  }

  publicState() {
    return {
      code: this.code,
      isPublic: this.isPublic,
      hostId: this.hostId,
      state: this.state,
      round: this.round,
      settings: { ...this.settings },
      customCount: this.customEntries.length,
      drawerId: this.drawerId,
      timeLeft: this.timer ? Math.max(0, this.deadline - Date.now()) : 0,
      masks: this.state === 'drawing' ? this.masks() : null,
      reveal: this.state === 'reveal' ? this.lastReveal : null,
      ready: this.state === 'reveal' ? [...this.ready] : [],
      voiceAllowed: !this.isPublic,
      players: [...this.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: p.score,
        gain: p.gain,
        guessed: p.guessed,
        connected: p.connected,
        voice: Boolean(p.voice),
        muted: Boolean(p.muted),
      })),
    };
  }

  // Secrets only one player may see: word options for the drawer, the word once you know it.
  privateState(player) {
    const me = { id: player.id };
    if (this.state === 'choosing' && player.id === this.drawerId) me.options = this.options.map(e => this.label(e));
    if (this.state === 'drawing' && (player.id === this.drawerId || player.guessed)) me.word = this.label(this.entry);
    if (player.id === this.hostId) me.customText = this.customText;
    return me;
  }

  broadcastState() {
    const pub = this.publicState();
    for (const p of this.players.values()) this.send(p, 'room:state', { ...pub, me: this.privateState(p) });
    this.transport.changed();
  }
}
