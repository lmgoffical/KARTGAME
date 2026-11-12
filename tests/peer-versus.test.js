import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerVersus } from '../src/net/peer-versus.js';
import { LEVELS } from '../src/game/levels.js';

/** A stand-in for the realtime service: everyone on a code hears everyone else, never themselves. */
function bus() {
  const rooms = new Map();
  return (code, onMessage) => {
    const members = rooms.get(code) || rooms.set(code, new Set()).get(code);
    const me = { onMessage };
    members.add(me);
    return Promise.resolve({
      send: (e, d) => {
        const copy = JSON.parse(JSON.stringify(d));
        for (const m of members) if (m !== me) setTimeout(() => members.has(m) && m.onMessage(e, copy), 1);
      },
      close: () => members.delete(me),
    });
  };
}

const FAST = { pingMs: 40, goneMs: 200, joinMs: 300, settleMs: 20, graceMs: 150, countdownMs: 50 };

function player(open, name, color = 0) {
  const v = new PeerVersus(open, FAST);
  const log = [];
  const waiting = [];
  v.on = (type, m) => {
    log.push([type, m]);
    for (const w of [...waiting]) if (w.test(type, m)) {
      waiting.splice(waiting.indexOf(w), 1);
      w.resolve(m);
    }
  };
  v.connect({ name, color });
  /** Resolves with the next event of this type (optionally matching), or fails after a second. */
  v.next = (type, match = () => true) =>
    new Promise((resolve, reject) => {
      waiting.push({ test: (t, m) => t === type && match(m), resolve });
      setTimeout(() => reject(new Error(`${name} timed out waiting for ${type}`)), 1000);
    });
  v.log = log;
  return v;
}

async function roomOfTwo(open) {
  const host = player(open, 'Host', 2);
  const guest = player(open, 'Friend', 2);
  const made = host.next('room');
  host.send({ t: 'create' });
  const code = (await made).room.code;
  const joined = guest.next('room');
  const seen = host.next('room', (m) => m.room.players.length === 2);
  guest.send({ t: 'join', code: code.toLowerCase() });
  await Promise.all([joined, seen]);
  return { host, guest, code };
}

test('server-free versus: create, join, race and results', async () => {
  const open = bus();
  const { host, guest, code } = await roomOfTwo(open);
  try {
    assert.match(code, /^[A-Z2-9]{5}$/);
    assert.equal(host.isHost, true);
    assert.equal(guest.isHost, false);
    assert.deepEqual(guest.room.players.map((p) => p.name), ['Host', 'Friend']);
    assert.deepEqual(guest.room.players.map((p) => p.color), [2, 0], 'second racer is moved off the taken colour');

    // Only the host can change the track or start.
    const refused = guest.next('error');
    guest.send({ t: 'start' });
    assert.match((await refused).msg, /host/);
    const newTrack = guest.next('room', (m) => m.room.track.id === LEVELS[1].id);
    host.send({ t: 'track', track: LEVELS[1] });
    await newTrack;

    const go = guest.next('countdown');
    host.send({ t: 'start' });
    const cd = await go;
    assert.equal(cd.slots[host.id], 0);
    assert.equal(cd.slots[guest.id], 1);
    assert.equal(host.room.state, 'racing');

    const pos = guest.next('state');
    host.send({ t: 'state', s: [1, 2, 3, 4, 5, 0, 0, 0, 1, 0] });
    assert.deepEqual(await pos, { id: host.id, s: [1, 2, 3, 4, 5, 0, 0, 0, 1, 0] });

    const hostResults = host.next('results');
    const guestResults = guest.next('results');
    guest.send({ t: 'finish', time: 61.5 });
    host.send({ t: 'finish', time: 70 });
    assert.deepEqual((await hostResults).results.map((r) => r.name), ['Friend', 'Host']);
    assert.deepEqual((await guestResults).results.map((r) => r.time), [61.5, 70]);

    const lobby = guest.next('room', (m) => m.room.state === 'lobby');
    host.send({ t: 'lobby' });
    await lobby;
  } finally {
    host.leave();
    guest.leave();
  }
});

test('server-free versus: wrong codes, slow racers and a host who leaves', async () => {
  const open = bus();
  const stranger = player(open, 'Nobody');
  const none = stranger.next('error');
  stranger.send({ t: 'join', code: 'ZZZZZ' });
  assert.match((await none).msg, /No room/);
  assert.equal(stranger.room, null);

  const { host, guest } = await roomOfTwo(open);
  try {
    // One racer never finishes: the race still ends after the grace time.
    const go = guest.next('countdown');
    host.send({ t: 'start' });
    await go;
    const results = guest.next('results');
    host.send({ t: 'finish', time: 50 });
    assert.deepEqual((await results).results.map((r) => [r.name, r.time]), [['Host', 50], ['Friend', null]]);

    // The host leaves: the remaining player takes over the room.
    const mine = guest.next('room', (m) => m.room.hostId === guest.id);
    host.leave();
    const room = (await mine).room;
    assert.deepEqual(room.players.map((p) => p.name), ['Friend']);
    assert.equal(room.state, 'lobby');
    assert.equal(guest.isHost, true);
  } finally {
    host.leave();
    guest.leave();
  }
});

test('server-free versus: a host that vanishes without saying goodbye is replaced', async () => {
  const open = bus();
  const { host, guest } = await roomOfTwo(open);
  try {
    // Simulate a closed laptop: the host just stops, with no goodbye.
    for (const stop of host.timers) stop();
    host.channel.close();
    await guest.next('room', (m) => m.room.hostId === guest.id);
    assert.equal(guest.room.players.length, 1);
  } finally {
    guest.leave();
  }
});

test('server-free versus: a ninth player is told the room is full', async () => {
  const open = bus();
  const host = player(open, 'Host');
  const made = host.next('room');
  host.send({ t: 'create' });
  const code = (await made).room.code;
  const others = [];
  try {
    for (let i = 0; i < 7; i++) {
      const p = player(open, `P${i}`);
      others.push(p);
      const joined = p.next('room');
      p.send({ t: 'join', code });
      await joined;
    }
    assert.equal(host.room.players.length, 8);
    assert.equal(new Set(host.room.players.map((p) => p.color)).size, 8, 'everyone has their own colour');
    const late = player(open, 'Late');
    others.push(late);
    const full = late.next('error');
    late.send({ t: 'join', code });
    assert.match((await full).msg, /full/);
  } finally {
    host.leave();
    for (const p of others) p.leave();
  }
});
