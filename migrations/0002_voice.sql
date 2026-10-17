-- One row each time a player joins voice chat in a room.
CREATE TABLE voice (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  room TEXT NOT NULL,
  visitor TEXT,
  name TEXT
);
CREATE INDEX voice_ts ON voice (ts);
