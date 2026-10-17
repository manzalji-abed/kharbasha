import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, cleanProfile } from '../src/core/room.js';

function setup(t, options) {
  const inbox = new Map();
  const tracked = [];
  const transport = {
    send: (connId, event, data) => inbox.get(connId)?.push({ event, data }),
    close: () => {},
    changed: () => {},
    track: (event, data) => tracked.push({ event, ...data }),
  };
  const room = new Room('VOICE', options, transport);
  t.after(() => room.destroy());
  let n = 0;
  const connect = name => {
    const connId = `c${++n}`;
    inbox.set(connId, []);
    const { playerId } = room.join(connId, cleanProfile({ name, token: `${name}-voice-token-xx`, visitor: `visitor-${name}` }));
    const all = event => inbox.get(connId).filter(m => m.event === event).map(m => m.data);
    return { player: () => room.players.get(playerId), all, last: event => all(event).at(-1) };
  };
  return { room, connect, tracked };
}

beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] }));

test('players opt in to voice in private rooms and everyone sees who is in it', t => {
  const { room, connect, tracked } = setup(t, { lang: 'en' });
  const a = connect('A');
  const b = connect('B');
  assert.equal(b.last('room:state').voiceAllowed, true);
  room.setVoice(a.player(), { on: true });
  const view = b.last('room:state').players.find(p => p.name === 'A');
  assert.deepEqual([view.voice, view.muted], [true, false]);
  room.setVoice(a.player(), { on: true, muted: true });
  assert.equal(b.last('room:state').players.find(p => p.name === 'A').muted, true);
  assert.deepEqual(tracked.filter(e => e.event === 'voice_joined').map(e => e.name), ['A'], 'muting is not a new call');
});

test('voice is refused in public rooms and switched off when a room goes public', t => {
  const pub = setup(t, { lang: 'en', isPublic: true });
  const p = pub.connect('P');
  pub.room.setVoice(p.player(), { on: true });
  assert.equal(p.player().voice, false);
  assert.equal(p.last('chat').key, 'voicePrivateOnly');

  const { room, connect } = setup(t, { lang: 'en' });
  const host = connect('Host');
  room.setVoice(host.player(), { on: true });
  room.updateSettings(host.player(), { isPublic: true });
  assert.equal(host.player().voice, false);
  assert.equal(host.last('room:state').voiceAllowed, false);
});

test('connection set-up messages only pass between players who are both in voice', t => {
  const { room, connect } = setup(t, { lang: 'en' });
  const a = connect('A');
  const b = connect('B');
  const offer = { description: { type: 'offer', sdp: 'v=0' } };
  room.setVoice(a.player(), { on: true });
  room.relaySignal(a.player(), b.player().id, offer);
  assert.equal(b.all('rtc').length, 0, 'B is not in voice yet');
  room.setVoice(b.player(), { on: true });
  room.relaySignal(a.player(), b.player().id, offer);
  assert.deepEqual(b.last('rtc'), { from: a.player().id, signal: offer });
  room.relaySignal(a.player(), b.player().id, { description: { type: 'offer', sdp: 'x'.repeat(20_000) } });
  assert.equal(b.all('rtc').length, 1, 'oversized messages are dropped');
});

test('a room waking up from sleep keeps who is in voice, so calls are not cut', t => {
  const { room, connect } = setup(t, { lang: 'en' });
  const a = connect('A');
  const b = connect('B');
  room.setVoice(a.player(), { on: true, muted: true });
  room.setVoice(b.player(), { on: true });
  const snapshot = structuredClone(room.snapshot());
  const quiet = { send: () => {}, close: () => {}, changed: () => {}, track: () => {} };
  // Only A's connection is still open after waking up.
  const restored = Room.restore(snapshot, quiet, new Map([[a.player().id, 'c1']]));
  t.after(() => restored.destroy());
  const [ra, rb] = [restored.players.get(a.player().id), restored.players.get(b.player().id)];
  assert.deepEqual([ra.voice, ra.muted], [true, true]);
  assert.equal(rb.voice, false, 'a player whose connection is gone is not in voice');
});

test('a dropped connection leaves voice, and voice is capped at 8 people', t => {
  const { room, connect } = setup(t, { lang: 'en' });
  const players = Array.from({ length: 9 }, (_, i) => connect(`P${i}`));
  room.settings.maxPlayers = 16;
  for (const p of players) room.setVoice(p.player(), { on: true });
  assert.equal([...room.players.values()].filter(p => p.voice).length, 8);
  assert.equal(players[8].last('chat').key, 'voiceFull');
  room.disconnect(players[0].player());
  assert.equal(players[0].player().voice, false);
  room.setVoice(players[8].player(), { on: true });
  assert.equal(players[8].player().voice, true, 'a seat freed up');
});
