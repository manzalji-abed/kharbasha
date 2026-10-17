import { LANGS } from './words.js';

// A room that hasn't reported in this long is assumed gone (rooms check in every few minutes).
export const STALE_MS = 12 * 60_000;

/** Registry of live rooms: lists public rooms and picks one for quick play. */
export class Directory {
  constructor(entries = []) {
    this.rooms = new Map(entries.map(e => [e.code, e]));
  }

  has(code) {
    return this.rooms.has(code);
  }

  update(summary, now) {
    const entry = { ...summary, seen: now };
    this.rooms.set(summary.code, entry);
    return entry;
  }

  remove(code) {
    this.rooms.delete(code);
  }

  stale(now) {
    return [...this.rooms.values()].filter(r => now - r.seen > STALE_MS).map(r => r.code);
  }

  // Public rooms with people in them, busiest first. `lang` filters when it is a known language.
  list(lang, now) {
    return [...this.rooms.values()]
      .filter(r => r.isPublic && r.players > 0 && now - r.seen <= STALE_MS && (!LANGS.includes(lang) || r.lang === lang))
      .sort((a, b) => b.players - a.players)
      .slice(0, 50)
      .map(({ seen, isPublic, ...room }) => room);
  }

  // Busiest public room in the language that still has a free seat.
  pickQuick(lang, now) {
    return this.list(lang, now).find(r => r.players < r.maxPlayers)?.code ?? null;
  }
}
