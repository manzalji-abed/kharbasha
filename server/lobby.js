import { randomInt } from 'node:crypto';
import { AVATAR_COUNT, LANGS, Room } from './room.js';
import { cleanText } from './normalize.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function cleanProfile(data) {
  const name = cleanText(data?.name, 20) || `Player${randomInt(100, 1000)}`;
  const avatar = Number.isInteger(data?.avatar) && data.avatar >= 0 && data.avatar < AVATAR_COUNT ? data.avatar : 0;
  const token = typeof data?.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(data.token)
    ? data.token
    : Array.from({ length: 24 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  return { name, avatar, token };
}

export class Lobby {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  create({ isPublic, lang }) {
    let code;
    do code = Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    while (this.rooms.has(code));
    const room = new Room(this.io, code, { isPublic, lang });
    room.onDestroy = () => this.rooms.delete(code);
    this.rooms.set(code, room);
    return room;
  }

  list(lang) {
    return [...this.rooms.values()]
      .filter(r => r.isPublic && r.connected.length > 0 && (!LANGS.includes(lang) || r.settings.lang === lang))
      .map(r => r.summary())
      .sort((a, b) => b.players - a.players)
      .slice(0, 50);
  }

  // Busiest public room in the language that still has a free seat, or a fresh one.
  quick(lang) {
    lang = LANGS.includes(lang) ? lang : 'en';
    const open = [...this.rooms.values()]
      .filter(r => r.isPublic && r.settings.lang === lang && r.connected.length > 0 && r.players.size < r.settings.maxPlayers)
      .sort((a, b) => b.connected.length - a.connected.length);
    return open[0] ?? this.create({ isPublic: true, lang });
  }

  attach(socket) {
    const hits = new Map();
    const allow = (key, max, ms) => {
      const now = Date.now();
      let h = hits.get(key);
      if (!h || now > h.reset) hits.set(key, (h = { n: 0, reset: now + ms }));
      return ++h.n <= max;
    };
    const current = () => {
      const room = this.rooms.get(socket.data.room);
      const player = room?.players.get(socket.data.pid);
      return player?.socketId === socket.id ? { room, player } : {};
    };
    const reply = (ack, data) => typeof ack === 'function' && ack(data);
    const leave = () => {
      const { room, player } = current();
      room?.remove(player.id, 'left');
    };
    const enter = (room, data, ack) => {
      if (current().room === room) return reply(ack, { ok: true, code: room.code });
      leave();
      reply(ack, room.join(socket, cleanProfile(data)));
    };

    socket.on('rooms:list', (lang, ack) => reply(ack, this.list(lang)));

    socket.on('room:create', (data, ack) => {
      if (!allow('create', 5, 60_000)) return reply(ack, { error: 'slowDown' });
      enter(this.create({ isPublic: data?.isPublic === true, lang: data?.lang }), data, ack);
    });

    socket.on('room:join', (data, ack) => {
      const room = this.rooms.get(String(data?.code ?? '').trim().toUpperCase());
      if (!room) return reply(ack, { error: 'notFound' });
      enter(room, data, ack);
    });

    socket.on('room:quick', (data, ack) => enter(this.quick(data?.lang), data, ack));

    socket.on('room:leave', leave);

    socket.on('room:settings', s => {
      const { room, player } = current();
      if (room && s && typeof s === 'object') room.updateSettings(player, s);
    });

    socket.on('game:start', () => {
      const { room, player } = current();
      if (room && player.id === room.hostId) room.startGame();
    });

    socket.on('word:choose', index => {
      const { room, player } = current();
      room?.chooseWord(player, index);
    });

    socket.on('draw', op => {
      if (!allow('draw', 240, 1000)) return;
      const { room, player } = current();
      room?.handleDraw(player, op);
    });

    socket.on('chat', text => {
      if (!allow('chat', 8, 5000)) return socket.emit('chat', { type: 'sys', key: 'slowDown', params: {} });
      const { room, player } = current();
      room?.handleChat(player, text);
    });

    socket.on('player:kick', id => {
      const { room, player } = current();
      room?.kick(player, id);
    });

    socket.on('disconnect', () => {
      const { room, player } = current();
      room?.disconnect(player);
    });
  }
}
