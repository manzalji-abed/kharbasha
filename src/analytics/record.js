// Writes usage events to the D1 database. Statistics must never break the game,
// so every write swallows (and logs) its own errors.

const VISITOR_RE = /^[\w-]{8,64}$/;
const LANGS = ['en', 'ar'];

const visitorOf = value => (typeof value === 'string' && VISITOR_RE.test(value) ? value : null);
const short = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

async function run(db, sql, ...params) {
  if (!db) return;
  try {
    await db.prepare(sql).bind(...params).run();
  } catch (err) {
    console.error('analytics write failed', err);
  }
}

// A page load of the game. `body` comes from the browser.
export function recordVisit(db, client, body) {
  const visitor = visitorOf(body.visitor);
  if (client.bot || !visitor) return;
  let referrer = '';
  try {
    referrer = body.referrer ? new URL(body.referrer).hostname : '';
  } catch {
    // not a URL
  }
  return run(
    db,
    `INSERT INTO visits (ts, visitor, country, region, city, device, os, browser, ui_lang, referrer, invited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Date.now(), visitor, client.country, client.region, client.city, client.device, client.os, client.browser,
    LANGS.includes(body.uiLang) ? body.uiLang : null, short(referrer, 100), body.invited ? 1 : 0,
  );
}

export function recordRoomOpened(db, client, { code, lang, isPublic, visitor }) {
  if (client.bot) return;
  return run(
    db,
    'INSERT INTO rooms (code, ts, lang, is_public, visitor, country) VALUES (?, ?, ?, ?, ?, ?)',
    code, Date.now(), lang ?? null, isPublic ? 1 : 0, visitorOf(visitor), client.country,
  );
}

// Events announced by a Room (see Room.track).
export function recordRoomEvent(db, room, event, data) {
  const now = Date.now();
  switch (event) {
    case 'player_joined':
      if (data.bot) return;
      return run(
        db,
        'INSERT INTO joins (ts, room, visitor, name, country, device, os, browser) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        now, room, visitorOf(data.visitor), short(data.name, 20), data.country ?? null, data.device ?? null, data.os ?? null, data.browser ?? null,
      );
    case 'game_started':
      return run(
        db,
        `INSERT INTO games (id, room, room_name, lang, is_public, players, rounds, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        data.gameId, room, short(data.roomName, 30), data.lang, data.isPublic ? 1 : 0, data.players, data.rounds, now,
      );
    case 'turn_ended':
      return run(
        db,
        `INSERT INTO turns (ts, game, word_en, word_ar, custom, drawer, guessers, correct, duration_ms, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        now, data.gameId, short(data.wordEn, 30), short(data.wordAr, 30), data.custom ? 1 : 0, short(data.drawer, 20),
        data.guessers, data.correct, data.durationMs, data.reason,
      );
    case 'voice_joined':
      return run(
        db,
        'INSERT INTO voice (ts, room, visitor, name) VALUES (?, ?, ?, ?)',
        now, room, visitorOf(data.visitor), short(data.name, 20),
      );
    case 'game_ended':
      return run(
        db,
        'UPDATE games SET ended_at = ?, completed = ?, winner = ?, players = MAX(players, ?) WHERE id = ?',
        now, data.completed ? 1 : 0, short(data.winner, 20), data.players, data.gameId,
      );
  }
}
