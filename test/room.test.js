import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, cleanProfile } from '../src/core/room.js';

// Runs a Room against an in-memory transport: every message a connection receives is recorded.
function setup(t, options = { lang: 'ar' }) {
  const inbox = new Map();
  const closed = new Map();
  const tracked = [];
  const transport = {
    send: (connId, event, data) => inbox.get(connId)?.push({ event, data: structuredClone(data) }),
    close: (connId, reason) => closed.set(connId, reason),
    changed: () => {},
    track: (event, data) => tracked.push({ event, ...data }),
  };
  const room = new Room('ABCDE', options, transport);
  t.after(() => room.destroy());

  let connCount = 0;
  const connect = (name, token = `${name}-token`.padEnd(20, 'x'), client = {}) => {
    const connId = `conn${++connCount}`;
    inbox.set(connId, []);
    const result = room.join(connId, cleanProfile({ name, avatar: 1, token, visitor: `visitor-${name}` }), client);
    const all = event => inbox.get(connId).filter(m => m.event === event).map(m => m.data);
    return { connId, result, all, last: event => all(event).at(-1), player: () => room.players.get(result.playerId) };
  };
  return { room, connect, closed, tracked };
}

// Starts a game and returns [drawer, guesser] client handles.
function startGame(room, clients) {
  room.startGame();
  const drawer = clients.find(c => c.last('room:state').me.options);
  return [drawer, ...clients.filter(c => c !== drawer)];
}

beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] }));

test('a full turn: choose, draw, guess in Arabic, score', t => {
  const { room, connect } = setup(t);
  const a = connect('Sara');
  const b = connect('عمر');
  const [drawer, guesser] = startGame(room, [a, b]);

  assert.equal(drawer.last('room:state').me.options.length, 3);
  assert.equal(guesser.last('room:state').me.options, undefined, 'guessers never see the options');

  room.chooseWord(drawer.player(), 0);
  const word = drawer.last('room:state').me.word.ar;
  const guesserView = guesser.last('room:state');
  assert.equal(guesserView.state, 'drawing');
  assert.equal(guesserView.me.word, undefined, 'guessers never receive the word');
  assert.ok(guesserView.masks[0].chars.every(c => c === null || !/\p{L}/u.test(c)), 'mask hides every letter');

  room.handleDraw(drawer.player(), { k: 'b', i: 7, c: '#FF0000', s: 6, p: [10.4, 20] });
  assert.deepEqual(guesser.last('draw'), { k: 'b', i: 7, c: '#ff0000', s: 6, p: [10, 20] });
  assert.equal(drawer.all('draw').some(op => op.k === 'b'), false, 'the drawer is not echoed its own strokes');

  room.handleChat(guesser.player(), 'zzzz');
  assert.equal(drawer.last('chat').text, 'zzzz');

  // A spelling variant: article added (unless already there) and ة written as ه.
  const variant = (word.startsWith('ال') ? word : `ال${word}`).replace(/ة/g, 'ه');
  t.mock.timers.tick(5_000);
  room.handleChat(guesser.player(), variant);
  assert.equal(drawer.last('chat').type, 'correct');
  const reveal = guesser.last('room:state');
  assert.equal(reveal.state, 'reveal');
  assert.equal(reveal.reveal.reason, 'allGuessed');
  assert.equal(reveal.reveal.word.ar, word);
  const score = c => reveal.players.find(p => p.id === c.result.playerId).score;
  assert.ok(score(guesser) >= 300, 'fast first guess earns time + order bonus');
  assert.equal(score(drawer), 200, 'drawer earns points when everyone guesses');
});

test('hints reveal letters over time and time running out ends the turn', t => {
  const { room, connect } = setup(t, { lang: 'en' });
  const clients = [connect('A'), connect('B')];
  room.settings.hints = 2;
  const [drawer, guesser] = startGame(room, clients);
  room.chooseWord(drawer.player(), 0);
  const hidden = () => guesser.last('room:state').masks[0].chars.filter(c => c === null).length;
  const before = hidden();

  t.mock.timers.tick(70_000);
  const letters = before;
  const maxShown = Math.min(2, Math.floor((letters - 1) / 2));
  assert.equal(before - hidden(), maxShown, 'up to two letters revealed, never half the word');

  t.mock.timers.tick(10_000);
  assert.equal(guesser.last('room:state').reveal.reason, 'timeUp');
  t.mock.timers.tick(6_000);
  assert.equal(guesser.last('room:state').state, 'choosing', 'next player is up');
});

test('only the drawer can draw, and late joiners get the drawing so far', t => {
  const { room, connect } = setup(t, { lang: 'en' });
  const [drawer, other] = startGame(room, [connect('A'), connect('B')]);
  room.chooseWord(drawer.player(), 1);

  room.handleDraw(other.player(), { k: 'b', i: 1, c: '#000000', s: 6, p: [1, 1] });
  room.handleDraw(drawer.player(), { k: 'b', i: 2, c: '#123456', s: 12, p: [5, 5] });
  room.handleDraw(drawer.player(), { k: 'm', i: 2, p: [6, 6, 7, 7] });
  room.handleDraw(drawer.player(), { k: 'f', x: 400, y: 300, c: '#00ff00' });

  const late = connect('C');
  assert.deepEqual(late.last('draw:history'), [
    { k: 's', i: 2, c: '#123456', s: 12, p: [5, 5, 6, 6, 7, 7] },
    { k: 'f', x: 400, y: 300, c: '#00ff00' },
  ]);
});

test('reconnecting with the same token keeps your seat and score', t => {
  const { room, connect, closed } = setup(t, { lang: 'en' });
  connect('A');
  const b = connect('B', 'secret-token-of-b-123');
  b.player().score = 420;

  // Same token on a new connection while the old one is still open: the old one is told to go.
  const again = connect('B', 'secret-token-of-b-123');
  assert.equal(again.result.playerId, b.result.playerId);
  assert.equal(closed.get(b.connId), 'elsewhere');

  // Dropped connection: seat kept during the grace period, then released.
  room.disconnect(again.player());
  const back = connect('B', 'secret-token-of-b-123');
  assert.equal(back.player().score, 420);
  assert.equal(room.players.size, 2);
  room.disconnect(back.player());
  t.mock.timers.tick(20_000);
  assert.equal(room.players.size, 1);
});

test('the host can kick, and kicked players cannot come back', t => {
  const { room, connect, closed } = setup(t, { lang: 'en' });
  const host = connect('Host');
  const guest = connect('Guest');
  room.kick(guest.player(), host.result.playerId);
  assert.equal(room.players.size, 2, 'only the host may kick');
  room.kick(host.player(), guest.result.playerId);
  assert.equal(closed.get(guest.connId), 'kicked');
  assert.deepEqual(connect('Guest').result, { error: 'kicked' });
});

test('public rooms start by themselves once two players are in', t => {
  const { room, connect } = setup(t, { lang: 'both', isPublic: true });
  const a = connect('A');
  t.mock.timers.tick(30_000);
  assert.equal(room.state, 'lobby', 'one player alone waits');
  connect('B');
  assert.ok(a.last('room:state').timeLeft > 0, 'countdown is shown');
  t.mock.timers.tick(20_000);
  assert.equal(room.state, 'choosing');
});

test('a room restored from storage keeps players, scores and settings', t => {
  const { room, connect } = setup(t, { lang: 'ar', isPublic: true });
  const a = connect('A');
  const b = connect('B');
  room.updateSettings(a.player(), { rounds: 5, customText: 'قطة|cat, كلب' });
  a.player().score = 150;
  const snapshot = structuredClone(room.snapshot());

  const sent = [];
  const transport = { send: (connId, event) => sent.push([connId, event]), close: () => {}, changed: () => {} };
  // Only A's connection survived; B gets the grace period to reconnect.
  const restored = Room.restore(snapshot, transport, new Map([[a.result.playerId, a.connId]]));
  t.after(() => restored.destroy());
  assert.equal(restored.state, 'lobby');
  assert.equal(restored.settings.rounds, 5);
  assert.equal(restored.customEntries.length, 2);
  assert.equal(restored.players.get(a.result.playerId).score, 150);
  assert.equal(restored.players.get(b.result.playerId).connected, false);
  t.mock.timers.tick(20_000);
  assert.equal(restored.players.has(b.result.playerId), false);
});

test('Continue moves on once everyone still here is ready', t => {
  const { room, connect } = setup(t, { lang: 'en' });
  const clients = [connect('A'), connect('B'), connect('C')];
  const [drawer, ...guessers] = startGame(room, clients);
  room.chooseWord(drawer.player(), 0);
  room.endTurn('timeUp');
  assert.equal(room.state, 'reveal');

  room.markReady(drawer.player());
  room.markReady(guessers[0].player());
  assert.equal(room.state, 'reveal', 'still waiting for one player');
  assert.deepEqual(guessers[1].last('room:state').ready.length, 2);

  // The last one leaving counts too: nobody is left to wait for.
  room.disconnect(guessers[1].player());
  assert.equal(room.state, 'choosing', 'next turn started without waiting for the timer');
});

test('the host can name the room, and the name is cleaned and listed', t => {
  const { room, connect } = setup(t, { lang: 'en', isPublic: true });
  const host = connect('Host');
  const guest = connect('Guest');
  room.updateSettings(guest.player(), { name: 'Hijacked' });
  assert.equal(room.settings.name, '', 'only the host renames');
  room.updateSettings(host.player(), { name: '  ‮Friday   night  sketches with the whole family!  ' });
  assert.equal(room.settings.name, 'Friday night sketches with the');
  assert.equal(room.summary().name, room.settings.name);
  assert.equal(guest.last('room:state').settings.name, room.settings.name);
});

test('the room announces joins, games and turns for statistics', t => {
  const { room, connect, tracked } = setup(t, { lang: 'both' });
  connect('Sara', undefined, { country: 'AE', device: 'mobile' });
  connect('Omar');
  connect('Sara'); // reconnect with the same token: not a new join
  assert.deepEqual(tracked.filter(e => e.event === 'player_joined').map(e => [e.name, e.visitor, e.country]), [
    ['Sara', 'visitor-Sara', 'AE'],
    ['Omar', 'visitor-Omar', undefined],
  ]);

  const drawer = [...room.players.values()].find(p => p.id === (startGame(room, []), room.drawerId));
  const started = tracked.find(e => e.event === 'game_started');
  assert.equal(started.players, 2);
  room.chooseWord(drawer, 0);
  t.mock.timers.tick(80_000);
  const turn = tracked.find(e => e.event === 'turn_ended');
  assert.equal(turn.gameId, started.gameId);
  assert.equal(turn.reason, 'timeUp');
  assert.ok(turn.wordEn && turn.wordAr, 'both languages recorded in a Both room');

  room.remove(drawer.id, 'left'); // only one player left: game abandoned
  const ended = tracked.find(e => e.event === 'game_ended');
  assert.deepEqual([ended.gameId, ended.completed, ended.winner], [started.gameId, false, null]);
});

test('client profiles are cleaned', () => {
  const p = cleanProfile({ name: '  ‮Sara\u0000  ', avatar: 99, token: 'short' });
  assert.equal(p.name, 'Sara');
  assert.equal(p.avatar, 0);
  assert.match(p.token, /^[a-z0-9]{24}$/);
});
