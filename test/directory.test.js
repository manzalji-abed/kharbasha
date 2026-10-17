import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Directory, STALE_MS } from '../src/core/directory.js';

const room = (code, extra) => ({ code, isPublic: true, lang: 'en', players: 2, maxPlayers: 10, state: 'lobby', round: 0, rounds: 3, host: 'x', ...extra });

test('lists busy public rooms only, busiest first', () => {
  const d = new Directory();
  d.update(room('AAAAA', { players: 2 }), 0);
  d.update(room('BBBBB', { players: 5 }), 0);
  d.update(room('CCCCC', { isPublic: false }), 0);
  d.update(room('DDDDD', { players: 0 }), 0);
  d.update(room('EEEEE', { lang: 'ar' }), 0);
  assert.deepEqual(d.list('en', 1).map(r => r.code), ['BBBBB', 'AAAAA']);
  assert.equal(d.list(null, 1).length, 3, 'no language filter lists every public room');
  assert.equal('isPublic' in d.list('en', 1)[0], false);
});

test('quick play picks the busiest room with a free seat', () => {
  const d = new Directory();
  d.update(room('FULLL', { players: 10 }), 0);
  d.update(room('BUSYY', { players: 6 }), 0);
  d.update(room('QUIET', { players: 1 }), 0);
  assert.equal(d.pickQuick('en', 1), 'BUSYY');
  assert.equal(d.pickQuick('ar', 1), null);
});

test('rooms that stop reporting go stale', () => {
  const d = new Directory([{ ...room('OLDDD'), seen: 0 }]);
  assert.deepEqual(d.stale(STALE_MS + 1), ['OLDDD']);
  assert.equal(d.list('en', STALE_MS + 1).length, 0);
});
