import { DurableObject } from 'cloudflare:workers';
import { Directory } from './core/directory.js';
import { randomString } from './core/random.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L look-alikes
const CREATE_LIMIT = 6; // new rooms per visitor per minute
const CREATE_WINDOW_MS = 60_000;

/**
 * A single global Durable Object that hands out room codes and keeps the public room list.
 * Rooms report their summary here whenever it changes; entries are mirrored to storage so the
 * list survives this object being unloaded.
 */
export class LobbyObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.directory = new Directory();
    this.creates = new Map(); // visitor IP → { n, reset }
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.list({ prefix: 'room:' });
      this.directory = new Directory([...saved.values()]);
    });
  }

  async list(lang) {
    const now = Date.now();
    for (const code of this.directory.stale(now)) await this.remove(code);
    return this.directory.list(lang, now);
  }

  pickQuick(lang) {
    return this.directory.pickQuick(lang, Date.now());
  }

  // A code not used by any known room. The room object itself has the final say (see RoomObject.init).
  allocate(ip) {
    const now = Date.now();
    let quota = this.creates.get(ip);
    if (!quota || now > quota.reset) this.creates.set(ip, (quota = { n: 0, reset: now + CREATE_WINDOW_MS }));
    if (++quota.n > CREATE_LIMIT) return { error: 'slowDown' };
    let code;
    do code = randomString(5, CODE_CHARS);
    while (this.directory.has(code));
    return { code };
  }

  async update(summary) {
    const entry = this.directory.update(summary, Date.now());
    await this.ctx.storage.put(`room:${summary.code}`, entry);
  }

  async remove(code) {
    this.directory.remove(code);
    await this.ctx.storage.delete(`room:${code}`);
  }
}
