import { DurableObject } from 'cloudflare:workers';
import { Room, cleanProfile } from './core/room.js';
import { randomId } from './core/random.js';

const SAVE_DELAY_MS = 1_000;
const HEARTBEAT_MS = 5 * 60_000; // keeps the lobby's listing fresh; also cleans up rooms nobody joined
// Messages a connection may send per window before the rest are dropped.
const RATE_LIMITS = { draw: [240, 1_000], chat: [8, 5_000], other: [40, 5_000] };

/**
 * One Durable Object per room code. It owns the room's WebSocket connections and wires them
 * to the platform-independent Room. Connections use the Hibernation API, so an idle room
 * (e.g. players chatting in the lobby) is unloaded from memory without dropping anyone;
 * the room is restored from storage when the next message arrives.
 */
export class RoomObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.hadPlayers = false;
    this.saveTimer = null;
    this.lastSaved = '';
    this.lastReported = '';
    this.buckets = new Map(); // connId → { [kind]: { n, reset } }
    this.transport = {
      send: (connId, event, data) => this.sendTo(connId, event, data),
      close: (connId, reason) => this.closeConnection(connId, reason),
      changed: () => this.scheduleSave(),
    };
    // Keep-alive pings are answered by the runtime without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const snapshot = await ctx.storage.get('room');
      if (!snapshot) return;
      this.lastSaved = JSON.stringify(snapshot);
      this.room = Room.restore(snapshot, this.transport, this.liveConnections());
      this.hadPlayers = this.room.players.size > 0;
    });
  }

  // ------------------------------------------------------------ RPC from the Worker

  // Claims this code for a new room. Returns false if the code is already in use.
  async init({ code, isPublic, lang }) {
    if (this.room) return false;
    this.room = new Room(code, { isPublic, lang }, this.transport);
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    return true;
  }

  // ------------------------------------------------------------ WebSockets

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    const connId = randomId();
    this.ctx.acceptWebSocket(server, [connId]);
    server.serializeAttachment({ connId });
    if (!this.room) this.closeConnection(connId, 'notFound');
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (!this.room || typeof raw !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { connId, pid } = ws.deserializeAttachment() ?? {};
    if (!this.allow(connId, msg.t)) return;

    if (msg.t === 'join') {
      const result = this.room.join(connId, cleanProfile(msg.d));
      if (result.error) return this.closeConnection(connId, result.error);
      this.hadPlayers = true;
      ws.serializeAttachment({ connId, pid: result.playerId });
      return;
    }

    const room = this.room;
    const player = room.players.get(pid);
    if (player?.connId !== connId) return;
    switch (msg.t) {
      case 'leave':
        room.remove(player.id, 'left');
        ws.close(1000, 'left');
        break;
      case 'settings':
        if (msg.d && typeof msg.d === 'object') room.updateSettings(player, msg.d);
        break;
      case 'start':
        if (player.id === room.hostId) room.startGame();
        break;
      case 'choose':
        room.chooseWord(player, msg.d);
        break;
      case 'draw':
        room.handleDraw(player, msg.d);
        break;
      case 'chat':
        room.handleChat(player, msg.d);
        break;
      case 'kick':
        room.kick(player, msg.d);
        break;
    }
  }

  async webSocketClose(ws) {
    this.dropConnection(ws);
  }

  async webSocketError(ws) {
    this.dropConnection(ws);
  }

  dropConnection(ws) {
    const { connId, pid } = ws.deserializeAttachment() ?? {};
    this.buckets.delete(connId);
    const player = this.room?.players.get(pid);
    if (player?.connected && player.connId === connId) this.room.disconnect(player);
  }

  sendTo(connId, event, data) {
    const text = JSON.stringify({ t: event, d: data });
    for (const ws of this.ctx.getWebSockets(connId)) {
      try {
        ws.send(text);
      } catch {
        // socket is already closing
      }
    }
  }

  closeConnection(connId, reason) {
    this.sendTo(connId, 'room:closed', { reason });
    for (const ws of this.ctx.getWebSockets(connId)) {
      ws.serializeAttachment({ connId }); // forget the player so the close event is ignored
      try {
        ws.close(4000, reason);
      } catch {
        // already closed
      }
    }
  }

  allow(connId, type) {
    const kind = type in RATE_LIMITS ? type : 'other';
    const [max, windowMs] = RATE_LIMITS[kind];
    const now = Date.now();
    const buckets = this.buckets.get(connId) ?? {};
    this.buckets.set(connId, buckets);
    let bucket = buckets[kind];
    if (!bucket || now > bucket.reset) bucket = buckets[kind] = { n: 0, reset: now + windowMs };
    bucket.n++;
    if (kind === 'chat' && bucket.n === max + 1) this.sendTo(connId, 'chat', { type: 'sys', key: 'slowDown', params: {} });
    return bucket.n <= max;
  }

  // ------------------------------------------------------------ persistence & lobby listing

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(err => console.error('room save failed', err));
    }, SAVE_DELAY_MS);
  }

  async save() {
    const room = this.room;
    if (!room) return;
    if (this.hadPlayers && room.players.size === 0) return this.dispose();
    const snapshot = room.snapshot();
    const text = JSON.stringify(snapshot);
    if (text !== this.lastSaved) {
      this.lastSaved = text;
      await this.ctx.storage.put('room', snapshot);
    }
    await this.report();
  }

  async report(force = false) {
    const summary = this.room.summary();
    const text = JSON.stringify(summary);
    if (!force && text === this.lastReported) return;
    this.lastReported = text;
    await this.lobby().update(summary);
  }

  async alarm() {
    if (!this.room) return;
    if (this.room.players.size === 0) return this.dispose();
    await this.report(true);
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  // Last player left (or nobody ever came): forget the room and free its code.
  async dispose() {
    const { code } = this.room;
    this.room.destroy();
    this.room = null;
    this.hadPlayers = false;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.lastSaved = this.lastReported = '';
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.lobby().remove(code);
  }

  liveConnections() {
    const live = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const { connId, pid } = ws.deserializeAttachment() ?? {};
      if (pid) live.set(pid, connId);
    }
    return live;
  }

  lobby() {
    return this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
  }
}
