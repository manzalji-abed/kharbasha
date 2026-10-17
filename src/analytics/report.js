// The numbers behind the admin dashboard, for activity since `since` (ms since epoch).
// One batch of read-only queries; days are UTC.

const breakdown = (table, column, valueSql = 'COUNT(DISTINCT visitor)') =>
  `SELECT COALESCE(${column}, 'Unknown') AS label, ${valueSql} AS n FROM ${table}
   WHERE ts >= ?1 GROUP BY label ORDER BY n DESC LIMIT 15`;

const wordStats = `SELECT word_en AS en, word_ar AS ar, COUNT(*) AS plays,
  COALESCE(SUM(correct), 0) AS correct, COALESCE(SUM(guessers), 0) AS guessers
  FROM turns WHERE ts >= ?1 GROUP BY word_en, word_ar`;

const QUERIES = {
  visits: `SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor) AS visitors, COALESCE(SUM(invited), 0) AS invited
    FROM visits WHERE ts >= ?1`,
  newVisitors: `SELECT COUNT(*) AS n FROM (SELECT MIN(ts) AS first FROM visits GROUP BY visitor) WHERE first >= ?1`,
  players: `SELECT COUNT(*) AS joins, COUNT(DISTINCT COALESCE(visitor, name)) AS players FROM joins WHERE ts >= ?1`,
  rooms: `SELECT COUNT(*) AS rooms, COALESCE(SUM(is_public), 0) AS public FROM rooms WHERE ts >= ?1`,
  games: `SELECT COUNT(*) AS started, COALESCE(SUM(completed), 0) AS completed,
    AVG(CASE WHEN completed = 1 THEN ended_at - started_at END) AS avgMs, AVG(players) AS avgPlayers
    FROM games WHERE started_at >= ?1`,
  voice: `SELECT COUNT(*) AS sessions, COUNT(DISTINCT COALESCE(visitor, name)) AS players, COUNT(DISTINCT room) AS rooms
    FROM voice WHERE ts >= ?1`,
  turns: `SELECT COUNT(*) AS turns, COALESCE(SUM(correct), 0) AS correct, COALESCE(SUM(guessers), 0) AS guessers,
    AVG(duration_ms) AS avgMs FROM turns WHERE ts >= ?1`,
  dailyVisits: `SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS visits
    FROM visits WHERE ts >= ?1 GROUP BY day`,
  dailyPlayers: `SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(DISTINCT COALESCE(visitor, name)) AS players
    FROM joins WHERE ts >= ?1 GROUP BY day`,
  dailyGames: `SELECT date(started_at / 1000, 'unixepoch') AS day, COUNT(*) AS games
    FROM games WHERE started_at >= ?1 GROUP BY day`,
  countries: breakdown('visits', 'country'),
  playerCountries: breakdown('joins', 'country', 'COUNT(DISTINCT COALESCE(visitor, name))'),
  cities: `SELECT city || ', ' || country AS label, COUNT(DISTINCT visitor) AS n FROM visits
    WHERE ts >= ?1 AND city IS NOT NULL GROUP BY label ORDER BY n DESC LIMIT 15`,
  devices: breakdown('visits', 'device'),
  os: breakdown('visits', 'os'),
  browsers: breakdown('visits', 'browser'),
  uiLangs: breakdown('visits', 'ui_lang'),
  referrers: `SELECT referrer AS label, COUNT(*) AS n FROM visits
    WHERE ts >= ?1 AND referrer <> '' GROUP BY referrer ORDER BY n DESC LIMIT 10`,
  roomLangs: `SELECT lang AS label, COUNT(*) AS n FROM games WHERE started_at >= ?1 GROUP BY lang ORDER BY n DESC`,
  topWords: `${wordStats} ORDER BY plays DESC LIMIT 12`,
  hardWords: `${wordStats} HAVING plays >= 2 AND SUM(guessers) > 0
    ORDER BY CAST(SUM(correct) AS REAL) / SUM(guessers), plays DESC LIMIT 10`,
  recentGames: `SELECT g.id, g.room, g.room_name AS roomName, g.lang, g.is_public AS isPublic, g.players, g.rounds,
    g.started_at AS startedAt, g.ended_at AS endedAt, g.completed, g.winner,
    (SELECT COUNT(*) FROM turns t WHERE t.game = g.id) AS turns
    FROM games g WHERE g.started_at >= ?1 ORDER BY g.started_at DESC LIMIT 25`,
  // SQLite returns the other columns from the row holding MAX(ts): the player's latest name and place.
  recentPlayers: `SELECT name, country, device, COUNT(*) AS rooms, MAX(ts) AS lastSeen FROM joins
    WHERE ts >= ?1 GROUP BY COALESCE(visitor, name) ORDER BY lastSeen DESC LIMIT 30`,
};

export async function buildReport(db, since) {
  const names = Object.keys(QUERIES);
  const results = await db.batch(names.map(name => db.prepare(QUERIES[name]).bind(since)));
  const rows = Object.fromEntries(names.map((name, i) => [name, results[i].results ?? []]));
  const one = name => rows[name][0] ?? {};

  return {
    totals: {
      ...one('visits'),
      newVisitors: one('newVisitors').n ?? 0,
      ...one('players'),
      ...one('rooms'),
      games: one('games'),
      turns: one('turns'),
      voice: one('voice'),
    },
    daily: mergeDays(rows.dailyVisits, rows.dailyPlayers, rows.dailyGames),
    countries: mergeCountries(rows.countries, rows.playerCountries),
    cities: rows.cities,
    devices: rows.devices,
    os: rows.os,
    browsers: rows.browsers,
    uiLangs: rows.uiLangs,
    referrers: rows.referrers,
    roomLangs: rows.roomLangs,
    topWords: rows.topWords,
    hardWords: rows.hardWords,
    recentGames: rows.recentGames,
    recentPlayers: rows.recentPlayers,
  };
}

function mergeDays(...series) {
  const days = new Map();
  for (const rows of series) {
    for (const { day, ...values } of rows) days.set(day, { ...(days.get(day) ?? { day, visitors: 0, visits: 0, players: 0, games: 0 }), ...values });
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function mergeCountries(visitors, players) {
  const byCountry = new Map(visitors.map(r => [r.label, { country: r.label, visitors: r.n, players: 0 }]));
  for (const r of players) byCountry.set(r.label, { ...(byCountry.get(r.label) ?? { country: r.label, visitors: 0 }), players: r.n });
  return [...byCountry.values()].sort((a, b) => b.visitors - a.visitors || b.players - a.players);
}
