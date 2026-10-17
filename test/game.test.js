import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { startServer } from '../server/index.js';

async function setup(t) {
  const server = await startServer(0);
  const clients = [];
  const client = () => {
    const socket = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
    clients.push(socket);
    return socket;
  };
  t.after(() => {
    for (const c of clients) c.close();
    server.io.close();
    for (const room of server.lobby.rooms.values()) room.destroy();
  });
  return client;
}

const waitFor = (socket, event, pred = () => true) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 3000);
  const handler = data => {
    if (!pred(data)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(data);
  };
  socket.on(event, handler);
});

const profile = (name, token) => ({ name, avatar: 1, token: token.padEnd(20, 'x') });

test('a full turn: choose, draw, guess in Arabic, score', async t => {
  const client = await setup(t);
  const a = client();
  const b = client();

  const created = await a.emitWithAck('room:create', { ...profile('Sara', 'tokenA'), lang: 'ar' });
  assert.ok(created.ok);
  const joined = await b.emitWithAck('room:join', { ...profile('عمر', 'tokenB'), code: created.code });
  assert.ok(joined.ok);

  const choosing = Promise.all([a, b].map(s => waitFor(s, 'room:state', st => st.state === 'choosing')));
  a.emit('game:start');
  const [sa, sb] = await choosing;
  const [drawer, guesser, drawerState, guesserState] = sa.me.options ? [a, b, sa, sb] : [b, a, sb, sa];
  assert.equal(drawerState.me.options.length, 3);
  assert.equal(guesserState.me.options, undefined, 'guessers never see the options');

  const drawing = Promise.all([drawer, guesser].map(s => waitFor(s, 'room:state', st => st.state === 'drawing')));
  drawer.emit('word:choose', 0);
  const [dd, gd] = await drawing;
  const word = dd.me.word.ar;
  assert.ok(word);
  assert.equal(gd.me.word, undefined, 'guessers never receive the word');
  assert.ok(gd.masks[0].chars.every(c => c === null || !/\p{L}/u.test(c)), 'mask hides every letter');

  const relayed = waitFor(guesser, 'draw', op => op.k === 'b');
  drawer.emit('draw', { k: 'b', i: 7, c: '#FF0000', s: 6, p: [10.4, 20] });
  assert.deepEqual(await relayed, { k: 'b', i: 7, c: '#ff0000', s: 6, p: [10, 20] });

  const wrong = waitFor(drawer, 'chat', m => m.type === 'msg');
  guesser.emit('chat', 'zzzz');
  assert.equal((await wrong).text, 'zzzz');

  // Guess with a spelling variant: added article (unless already there) and ة written as ه.
  const variant = (word.startsWith('ال') ? word : `ال${word}`).replace(/ة/g, 'ه');
  const correct = waitFor(drawer, 'chat', m => m.type === 'correct');
  const reveal = waitFor(guesser, 'room:state', st => st.state === 'reveal');
  guesser.emit('chat', variant);
  await correct;
  const rs = await reveal;
  assert.equal(rs.reveal.reason, 'allGuessed');
  assert.equal(rs.reveal.word.ar, word);
  const scoreOf = st => rs.players.find(p => p.id === st.me.id).score;
  assert.ok(scoreOf(guesserState) >= 300, 'fast first guess earns time + order bonus');
  assert.equal(scoreOf(drawerState), 200, 'drawer earns points when everyone guesses');
});

test('only the drawer can draw, and late joiners get the drawing so far', async t => {
  const client = await setup(t);
  const a = client();
  const b = client();
  const { code } = await a.emitWithAck('room:create', { ...profile('A', 'tokenA'), lang: 'en' });
  await b.emitWithAck('room:join', { ...profile('B', 'tokenB'), code });

  const choosing = waitFor(a, 'room:state', st => st.state === 'choosing');
  a.emit('game:start');
  const st = await choosing;
  const [drawer, other] = st.me.options ? [a, b] : [b, a];
  const drawing = waitFor(drawer, 'room:state', s => s.state === 'drawing');
  drawer.emit('word:choose', 1);
  await drawing;

  other.emit('draw', { k: 'b', i: 1, c: '#000000', s: 6, p: [1, 1] });
  drawer.emit('draw', { k: 'b', i: 2, c: '#123456', s: 12, p: [5, 5] });
  drawer.emit('draw', { k: 'm', i: 2, p: [6, 6, 7, 7] });
  drawer.emit('draw', { k: 'f', x: 400, y: 300, c: '#00ff00' });
  await new Promise(r => setTimeout(r, 100));

  const c = client();
  const history = waitFor(c, 'draw:history');
  await c.emitWithAck('room:join', { ...profile('C', 'tokenC'), code });
  assert.deepEqual(await history, [
    { k: 's', i: 2, c: '#123456', s: 12, p: [5, 5, 6, 6, 7, 7] },
    { k: 'f', x: 400, y: 300, c: '#00ff00' },
  ]);
});

test('reconnecting with the same token keeps your seat and score', async t => {
  const client = await setup(t);
  const a = client();
  const b = client();
  const { code } = await a.emitWithAck('room:create', { ...profile('A', 'tokenA'), lang: 'en' });
  const first = waitFor(b, 'room:state');
  await b.emitWithAck('room:join', { ...profile('B', 'tokenB'), code });
  const id = (await first).me.id;

  b.disconnect();
  await waitFor(a, 'room:state', st => st.players.find(p => p.id === id)?.connected === false);

  const b2 = client();
  const again = waitFor(b2, 'room:state');
  await b2.emitWithAck('room:join', { ...profile('B', 'tokenB'), code });
  const st = await again;
  assert.equal(st.me.id, id);
  assert.equal(st.players.length, 2);
});

test('rooms list and quick play', async t => {
  const client = await setup(t);
  const a = client();
  const quick = await a.emitWithAck('room:quick', { ...profile('A', 'tokenA'), lang: 'both' });
  assert.ok(quick.ok);
  const b = client();
  const rooms = await b.emitWithAck('rooms:list', 'both');
  assert.deepEqual(rooms.map(r => [r.code, r.lang, r.players]), [[quick.code, 'both', 1]]);
  const joined = await b.emitWithAck('room:quick', { ...profile('B', 'tokenB'), lang: 'both' });
  assert.equal(joined.code, quick.code, 'quick play fills the existing room first');
  assert.deepEqual(await b.emitWithAck('room:join', { ...profile('B', 'tokenB'), code: 'ZZZZZ' }), { error: 'notFound' });
});
