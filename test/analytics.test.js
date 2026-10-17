import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserAgent } from '../src/analytics/client.js';
import { recordRoomEvent, recordVisit } from '../src/analytics/record.js';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

test('user agents map to device, OS and browser', () => {
  assert.deepEqual(parseUserAgent(UA.iphone), { device: 'mobile', os: 'iOS', browser: 'Safari' });
  assert.deepEqual(parseUserAgent(UA.ipad), { device: 'tablet', os: 'iOS', browser: 'Safari' });
  assert.deepEqual(parseUserAgent(UA.android), { device: 'mobile', os: 'Android', browser: 'Samsung Internet' });
  assert.deepEqual(parseUserAgent(UA.androidTablet), { device: 'tablet', os: 'Android', browser: 'Chrome' });
  assert.deepEqual(parseUserAgent(UA.windowsEdge), { device: 'desktop', os: 'Windows', browser: 'Edge' });
  assert.deepEqual(parseUserAgent(UA.mac), { device: 'desktop', os: 'macOS', browser: 'Safari' });
});

// A stand-in for the D1 binding that records the statements it is asked to run.
function fakeDb() {
  const runs = [];
  return {
    runs,
    prepare: sql => ({ bind: (...params) => ({ run: async () => runs.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }) }) }),
  };
}

test('visits are recorded without bots or bad ids, and referrers keep only the host', async () => {
  const db = fakeDb();
  const client = { country: 'AE', region: 'Dubai', city: 'Dubai', device: 'mobile', os: 'iOS', browser: 'Safari', bot: false };
  await recordVisit(db, client, { visitor: 'abcdefghij', uiLang: 'ar', referrer: 'https://wa.me/some/path?x=1', invited: true });
  await recordVisit(db, { ...client, bot: true }, { visitor: 'abcdefghij' });
  await recordVisit(db, client, { visitor: 'bad id!' });
  assert.equal(db.runs.length, 1);
  assert.deepEqual(db.runs[0].params.slice(1), ['abcdefghij', 'AE', 'Dubai', 'Dubai', 'mobile', 'iOS', 'Safari', 'ar', 'wa.me', 1]);
});

test('room events become rows, and a failing database never throws', async () => {
  const db = fakeDb();
  await recordRoomEvent(db, 'ABCDE', 'player_joined', { visitor: 'visitor-123', name: 'Sara', country: 'SA', device: 'desktop', os: 'Windows', browser: 'Chrome' });
  await recordRoomEvent(db, 'ABCDE', 'game_started', { gameId: 'g1', roomName: 'Friends', lang: 'both', isPublic: false, players: 3, rounds: 2 });
  await recordRoomEvent(db, 'ABCDE', 'turn_ended', { gameId: 'g1', wordEn: 'cat', wordAr: 'قطة', custom: false, drawer: 'Sara', guessers: 2, correct: 1, durationMs: 40_000, reason: 'timeUp' });
  await recordRoomEvent(db, 'ABCDE', 'game_ended', { gameId: 'g1', completed: true, winner: 'Sara', players: 3 });
  assert.deepEqual(db.runs.map(r => r.sql.split(' ').slice(0, 3).join(' ')), [
    'INSERT INTO joins', 'INSERT INTO games', 'INSERT INTO turns', 'UPDATE games SET',
  ]);

  const broken = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('daily limit'); } }) }) };
  const errors = console.error;
  console.error = () => {};
  await assert.doesNotReject(recordRoomEvent(broken, 'ABCDE', 'game_started', { gameId: 'g2' }));
  console.error = errors;
});
