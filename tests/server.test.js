import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../server/server.js';
import { LEVELS } from '../src/game/levels.js';

async function boot() {
  const app = createServer({});
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { app, base, call };
}

/** A WebSocket client that lets a test wait for the next message of a type. */
function client(base) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const queue = [];
  const waiting = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiting.findIndex((w) => w.type === m.t);
    if (i >= 0) waiting.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  });
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next: (type) =>
      new Promise((resolve, reject) => {
        const i = queue.findIndex((m) => m.t === type);
        if (i >= 0) return resolve(queue.splice(i, 1)[0]);
        waiting.push({ type, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
      }),
    open: () => new Promise((r) => ws.on('open', r)),
  };
}

test('accounts: register, sign in, and reject bad input', async () => {
  const { app, call } = await boot();
  try {
    assert.equal((await call('POST', '/api/register', { name: 'x', password: 'secret1' })).status, 400);
    assert.equal((await call('POST', '/api/register', { name: 'Racer_1', password: '123' })).status, 400);
    const reg = await call('POST', '/api/register', { name: 'Racer_1', password: 'secret1' });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.user.name, 'Racer_1');
    assert.equal((await call('POST', '/api/register', { name: 'racer_1', password: 'secret1' })).status, 409);
    assert.equal((await call('POST', '/api/login', { name: 'Racer_1', password: 'nope-nope' })).status, 401);
    assert.equal((await call('POST', '/api/login', { name: '__proto__', password: 'nope-nope' })).status, 401);
    const login = await call('POST', '/api/login', { name: 'RACER_1', password: 'secret1' });
    assert.equal(login.status, 200);
    assert.equal((await call('GET', '/api/me', null, login.body.token)).body.user.name, 'Racer_1');
    assert.equal((await call('GET', '/api/me', null, 'f'.repeat(64))).status, 401);
    await call('POST', '/api/logout', null, login.body.token);
    assert.equal((await call('GET', '/api/me', null, login.body.token)).status, 401);
    // Passwords are never stored as typed.
    assert.ok(!JSON.stringify(app.store.data).includes('secret1'));
  } finally {
    await app.close();
  }
});

test('best times only improve, and feed the leaderboard', async () => {
  const { app, call } = await boot();
  try {
    const a = (await call('POST', '/api/register', { name: 'Anna', password: 'secret1' })).body.token;
    const b = (await call('POST', '/api/register', { name: 'Ben', password: 'secret1' })).body.token;
    assert.equal((await call('POST', '/api/times', { track: 'sunny-meadows', time: 90, medal: 'silver' })).status, 401);
    await call('POST', '/api/times', { track: 'sunny-meadows', time: 90, medal: 'silver' }, a);
    const worse = await call('POST', '/api/times', { track: 'sunny-meadows', time: 120, medal: 'bronze' }, a);
    assert.deepEqual(worse.body.record, { best: 90, medal: 'silver' });
    await call('POST', '/api/times', { track: 'sunny-meadows', time: 80, medal: 'gold' }, b);
    assert.equal((await call('POST', '/api/times', { track: 'sunny-meadows', time: -1 }, b)).status, 400);
    const board = (await call('GET', '/api/leaderboard?track=sunny-meadows')).body.rows;
    assert.deepEqual(board.map((r) => r.name), ['Ben', 'Anna']);
  } finally {
    await app.close();
  }
});

test('maps: publish, list, fetch, and only the author can delete', async () => {
  const { app, call } = await boot();
  try {
    const a = (await call('POST', '/api/register', { name: 'Anna', password: 'secret1' })).body.token;
    const b = (await call('POST', '/api/register', { name: 'Ben', password: 'secret1' })).body.token;
    const def = { ...LEVELS[0], name: 'My Loop' };
    assert.equal((await call('POST', '/api/maps', { def })).status, 401);
    assert.equal((await call('POST', '/api/maps', { def: { points: [] } }, a)).status, 400);
    const pub = await call('POST', '/api/maps', { def }, a);
    assert.equal(pub.status, 200);
    const id = pub.body.id;
    // Publishing the same name again updates rather than duplicating.
    assert.equal((await call('POST', '/api/maps', { def: { ...def, laps: 5 } }, a)).body.id, id);
    const list = (await call('GET', '/api/maps')).body.maps;
    assert.equal(list.length, 1);
    assert.equal(list[0].author, 'Anna');
    assert.equal(list[0].def.name, 'My Loop');
    const got = (await call('GET', `/api/maps/${id}`)).body;
    assert.equal(got.def.laps, 5);
    assert.equal(got.def.id, id);
    assert.equal((await call('DELETE', `/api/maps/${id}`, null, b)).status, 403);
    assert.equal((await call('DELETE', `/api/maps/${id}`, null, a)).status, 200);
    assert.equal((await call('GET', `/api/maps/${id}`)).status, 404);
  } finally {
    await app.close();
  }
});

test('versus: two players share a room, race and get results', async () => {
  const { app, base } = await boot();
  const host = client(base);
  const guest = client(base);
  try {
    await Promise.all([host.open(), guest.open()]);
    const hostId = (await host.next('welcome')).id;
    const guestId = (await guest.next('welcome')).id;
    host.send({ t: 'hello', name: 'Host<script>', color: 2 });
    guest.send({ t: 'hello', name: 'Friend', color: 2 });
    host.send({ t: 'create' });
    const code = (await host.next('room')).room.code;
    assert.match(code, /^[A-Z2-9]{5}$/);

    guest.send({ t: 'join', code: 'ZZZZZ' });
    assert.match((await guest.next('error')).msg, /No room/);
    guest.send({ t: 'join', code: code.toLowerCase() });
    const joined = await guest.next('room');
    assert.deepEqual(joined.room.players.map((p) => p.name), ['Hostscript', 'Friend']);
    // Both asked for colour 2; the second racer is moved to a free one.
    assert.deepEqual(joined.room.players.map((p) => p.color), [2, 0]);

    // Only the host may change the track or start.
    guest.send({ t: 'start' });
    assert.match((await guest.next('error')).msg, /host/);
    host.send({ t: 'track', track: { ...LEVELS[1] } });
    host.send({ t: 'start' });
    const cd = await guest.next('countdown');
    assert.equal(cd.slots[hostId], 0);
    assert.equal(cd.slots[guestId], 1);

    host.send({ t: 'state', s: [1, 2, 3, 4, 5, 0, 0] });
    const st = await guest.next('state');
    assert.equal(st.id, hostId);
    assert.deepEqual(st.s, [1, 2, 3, 4, 5, 0, 0]);

    guest.send({ t: 'finish', time: 61.5 });
    host.send({ t: 'finish', time: 70 });
    const results = (await host.next('results')).results;
    assert.deepEqual(results.map((r) => r.name), ['Friend', 'Hostscript']);

    // When the host leaves, the room passes to the remaining player.
    host.ws.close();
    let room;
    do room = (await guest.next('room')).room;
    while (room.players.length !== 1);
    assert.equal(room.hostId, guestId);
  } finally {
    host.ws.terminate();
    guest.ws.terminate();
    await app.close();
  }
});
