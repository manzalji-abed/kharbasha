// Network layer: small JSON API calls for the lobby, and one WebSocket per room.

const PING_MS = 25_000; // keeps idle connections open through proxies; answered without waking the room
const MAX_RETRY_MS = 8_000;

export async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * A live connection to one room. Messages are JSON `{ t: type, d: data }`.
 * If the connection drops it reconnects with backoff and calls `onOpen` again, so the caller
 * can re-send its join (the server recognises the player by their token and restores their seat).
 * A `room:closed` message from the server ends the connection for good.
 */
export class RoomConnection {
  constructor(code, { onOpen, onMessage, onDrop }) {
    this.code = code;
    this.handlers = { onOpen, onMessage, onDrop };
    this.closed = false;
    this.attempt = 0;
    this.connect();
  }

  connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws/${this.code}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.pinger = setInterval(() => ws.send('ping'), PING_MS);
      this.handlers.onOpen();
    };
    ws.onmessage = e => {
      if (e.data === 'pong') return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'room:closed') this.closed = true;
      this.handlers.onMessage(msg.t, msg.d);
    };
    ws.onclose = () => {
      clearInterval(this.pinger);
      if (this.closed) return;
      this.handlers.onDrop?.();
      this.retry = setTimeout(() => this.connect(), Math.min(MAX_RETRY_MS, 500 * 2 ** this.attempt++));
    };
  }

  send(type, data) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: type, d: data }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.pinger);
    this.ws.close(1000);
  }
}
