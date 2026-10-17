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
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const LETTER = /[\p{L}\p{N}]/u;
const TOKEN_RE = /^[\w-]{16,64}$/;

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

// Validates what a client sends about itself. The token is the client's secret seat key.
export function cleanProfile(data) {
  return {
    name: cleanText(data?.name, 20) || `Player${100 + randomInt(900)}`,
    avatar: Number.isInteger(data?.avatar) && data.avatar >= 0 && data.avatar < AVATAR_COUNT ? data.avatar : 0,
    token: typeof data?.token === 'string' && TOKEN_RE.test(data.token) ? data.token : randomString(24, 'abcdefghijklmnopqrstuvwxyz0123456789'),
  };
}

/**
 * One game room: players, turns, timer, hints, scoring and the shared drawing.
 * It knows nothing about the network; the hosting platform passes in a transport:
 *   send(connId, event, data)  deliver a message to one connection
 *   close(connId, reason)      tell a connection it is no longer in the room, then drop it
 *   changed()                  room state changed (persist it, refresh the lobby listing)
 */
export class Room {
  constructor(code, { isPublic = false, lang = 'en' } = {}, transport) {
    this.code = code;
    this.transport = transport;
    this.isPublic = isPublic === true;
    this.settings = { lang: LANGS.includes(lang) ? lang : 'en', rounds: 3, drawTime: 80, maxPlayers: 10, hints: 2, customOnly: false };
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
  snapshot() {
    return {
      code: this.code,
      isPublic: this.isPublic,
      settings: this.settings,
      customText: this.customText,
      hostId: this.hostId,
      kicked: [...this.kicked],
      players: [...this.players.values()].map(({ id, token, name, avatar, score }) => ({ id, token, name, avatar, score })),
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
      const player = { ...p, gain: 0, guessed: false, connId: live.get(p.id) ?? null, connected: live.has(p.id) };
      room.players.set(p.id, player);
      if (!player.connected) player.graceTimer = setTimeout(() => room.remove(player.id, 'left'), GRACE_MS);
    }
    room.hostId = room.players.has(snapshot.hostId) ? snapshot.hostId : null;
    if (!room.players.get(room.hostId)?.connected) room.pickHost();
    room.checkAutostart();
    return room;
  }

  // ---------------------------------------------------------------- membership

  join(connId, profile) {
    if (this.kicked.has(profile.token)) return { error: 'kicked' };
    let player = [...this.players.values()].find(p => p.token === profile.token);
    if (player) {
      clearTimeout(player.graceTimer);
      if (player.connected && player.connId !== connId) this.transport.close(player.connId, 'elsewhere');
      Object.assign(player, { name: profile.name, avatar: profile.avatar });
    } else {
      if (this.players.size >= this.settings.maxPlayers) return { error: 'full' };
      player = { id: randomId(), token: profile.token, name: profile.name, avatar: profile.avatar, score: 0, gain: 0, guessed: false };
      this.players.set(player.id, player);
      if (this.inGame) this.queue.push(player.id);
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
    player.connected = false;
    player.graceTimer = setTimeout(() => this.remove(player.id, 'left'), GRACE_MS);
    if (this.hostId === player.id) this.pickHost();
    if (this.drawerId === player.id && (this.state === 'choosing' || this.state === 'drawing')) {
      this.endTurn('drawerLeft');
    } else {
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
    if (LANGS.includes(s.lang)) st.lang = s.lang;
    if (Number.isInteger(s.rounds)) st.rounds = clamp(s.rounds, 1, 10);
    if (Number.isInteger(s.drawTime)) st.drawTime = clamp(s.drawTime, 30, 240);
    if (Number.isInteger(s.maxPlayers)) st.maxPlayers = clamp(s.maxPlayers, Math.max(2, this.players.size), 16);
    if (Number.isInteger(s.hints)) st.hints = clamp(s.hints, 0, 3);
    if (typeof s.customOnly === 'boolean') st.customOnly = s.customOnly;
    if (typeof s.isPublic === 'boolean') this.isPublic = s.isPublic;
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
    this.lastReveal = { reason, word: this.entry ? this.label(this.entry) : null };
    this.state = 'reveal';
    this.options = null;
    this.setTimer(this.entry ? REVEAL_MS : 2_500, () => this.nextTurn());
    this.broadcastState();
  }

  endGame() {
    this.clearTimers();
    Object.assign(this, { state: 'gameover', drawerId: null, entry: null, options: null });
    this.setTimer(GAMEOVER_MS, () => this.toLobby());
    this.broadcastState();
  }

  toLobby() {
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
      players: [...this.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: p.score,
        gain: p.gain,
        guessed: p.guessed,
        connected: p.connected,
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
