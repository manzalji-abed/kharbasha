-- Usage analytics. Times are milliseconds since the Unix epoch (UTC).
-- `visitor` is an anonymous random id stored in the player's browser.

-- One row per page load of the game.
CREATE TABLE visits (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  visitor TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  device TEXT,
  os TEXT,
  browser TEXT,
  ui_lang TEXT,
  referrer TEXT,
  invited INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX visits_ts ON visits (ts);

-- One row per room opened (quick play that lands in an existing room adds none).
CREATE TABLE rooms (
  code TEXT NOT NULL,
  ts INTEGER NOT NULL,
  lang TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  visitor TEXT,
  country TEXT
);
CREATE INDEX rooms_ts ON rooms (ts);

-- One row each time a player takes a seat in a room (reconnects are not counted).
CREATE TABLE joins (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  room TEXT NOT NULL,
  visitor TEXT,
  name TEXT,
  country TEXT,
  device TEXT,
  os TEXT,
  browser TEXT
);
CREATE INDEX joins_ts ON joins (ts);

-- One row per game; ended_at stays NULL while it is being played.
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  room_name TEXT,
  lang TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  players INTEGER,
  rounds INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  completed INTEGER NOT NULL DEFAULT 0,
  winner TEXT
);
CREATE INDEX games_started ON games (started_at);

-- One row per drawing turn that got as far as choosing a word.
CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  game TEXT,
  word_en TEXT,
  word_ar TEXT,
  custom INTEGER NOT NULL DEFAULT 0,
  drawer TEXT,
  guessers INTEGER,
  correct INTEGER,
  duration_ms INTEGER,
  reason TEXT
);
CREATE INDEX turns_ts ON turns (ts);
CREATE INDEX turns_game ON turns (game);
