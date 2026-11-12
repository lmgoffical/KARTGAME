import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack, validateDef, createProgress, updateProgress, medalFor, gridPose, isOnRoad, nearest, surfaceAt, terrainAt, GAP } from '../src/game/track.js';
import { referenceTime, medalTimes, createKart, createAI, stepKart, stepTrack, aiInput, THEME_GRIP } from '../src/game/physics.js';
import { LEVELS } from '../src/game/levels.js';

const square = { name: 'Square', theme: 'meadow', width: 14, laps: 2, checkpoints: 4, points: [[0, -60], [60, 0], [0, 60], [-60, 0]] };

/** Drives a point straight through gate `i`, from just before it to just after. */
function passGate(track, p, i, time) {
  const g = track.gates[i];
  return updateProgress(track, p, g.x - g.tx, g.z - g.tz, g.x + g.tx, g.z + g.tz, time);
}

test('track samples are evenly spaced round a closed loop', () => {
  const t = buildTrack(square);
  assert.ok(t.length > 300);
  for (let i = 0; i < t.count; i++) {
    const a = t.samples[i];
    const b = t.samples[(i + 1) % t.count];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    assert.ok(Math.abs(d - t.step) < t.step * 0.2, `gap ${d} at ${i}`);
  }
  assert.equal(t.gates.length, 4);
});

test('gates must be taken in order to finish', () => {
  const t = buildTrack(square);
  const p = createProgress();
  let time = 0;
  assert.equal(passGate(t, p, 0, time), 'gate');
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 1; i < 4; i++) assert.equal(passGate(t, p, i, (time += 5)), 'gate');
    assert.equal(passGate(t, p, 0, (time += 5)), lap === 1 ? 'finish' : 'lap');
  }
  assert.equal(p.finished, true);
  assert.equal(p.lapTimes.length, 2);
  assert.equal(p.finishTime, 40);
});

test('skipping straight back to the finish line earns nothing', () => {
  const t = buildTrack(square);
  const p = createProgress();
  passGate(t, p, 0, 0);
  for (let i = 0; i < 10; i++) passGate(t, p, 0, i + 1);
  assert.equal(p.count, 1);
  assert.equal(p.finished, false);
  // Jumping ahead to gate 2 is flagged and does not count either.
  assert.equal(passGate(t, p, 2, 20), 'missed');
  assert.equal(p.count, 1);
  assert.equal(p.missed, true);
  assert.equal(passGate(t, p, 1, 21), 'gate');
  assert.equal(p.missed, false);
});

test('driving a gate backwards or wide of it does not count', () => {
  const t = buildTrack(square);
  const p = createProgress();
  const g = t.gates[0];
  assert.equal(updateProgress(t, p, g.x + g.tx, g.z + g.tz, g.x - g.tx, g.z - g.tz, 0), null);
  const off = g.half + 10;
  assert.equal(
    updateProgress(t, p, g.x - g.tx + g.rx * off, g.z - g.tz + g.rz * off, g.x + g.tx + g.rx * off, g.z + g.tz + g.rz * off, 0),
    null,
  );
  assert.equal(p.count, 0);
});

test('validateDef rejects bad tracks and clamps values', () => {
  assert.throws(() => validateDef({ points: [[0, 0], [1, 1]] }), /at least/);
  assert.throws(() => validateDef({ points: [[0, 0], [5, 0], [5, 5], [0, 5]] }), /too short/);
  const d = validateDef({ ...square, width: 999, laps: 0, theme: 'lava', name: '<b>Hi</b>', pads: [{ u: 5, lat: 9 }] });
  assert.equal(d.width, 24);
  assert.equal(d.laps, 1);
  assert.equal(d.theme, 'meadow');
  assert.equal(d.name, 'bHi/b');
  assert.ok(d.pads[0].u < 1 && d.pads[0].lat <= 0.8);
});

test('medals follow the time thresholds', () => {
  const m = { gold: 60, silver: 70, bronze: 80 };
  assert.equal(medalFor(59.9, m), 'gold');
  assert.equal(medalFor(65, m), 'silver');
  assert.equal(medalFor(80, m), 'bronze');
  assert.equal(medalFor(81, m), null);
});

test('the starting grid is on the road, behind the line', () => {
  for (const def of LEVELS) {
    const t = buildTrack(def);
    const g = t.gates[0];
    for (let slot = 0; slot < 8; slot++) {
      const pose = gridPose(t, slot);
      assert.ok(isOnRoad(t, pose.x, pose.z), `${def.id} slot ${slot}`);
      assert.ok((pose.x - g.x) * g.tx + (pose.z - g.z) * g.tz < 0, `${def.id} slot ${slot} is past the line`);
    }
  }
});

test('every built-in level is valid and the computer can finish it cleanly', () => {
  for (const def of LEVELS) {
    validateDef(def);
    const t = buildTrack(def);
    const time = referenceTime(t);
    const naive = (t.length * t.laps) / 18;
    assert.ok(time < naive, `${def.id}: reference lap did not finish (${time})`);
    const m = medalTimes(def);
    assert.ok(m.gold < m.silver && m.silver < m.bronze);

    // A slower rival should stay on the tarmac nearly all the time.
    const k = createKart(gridPose(t, 3));
    const ai = createAI(0.9, 0.5);
    ai.index = nearest(t, k.x, k.z).index;
    let off = 0;
    const steps = 60 * 60;
    for (let i = 0; i < steps; i++) {
      stepKart(k, aiInput(k, t, ai, 1 / 60), 1 / 60, t, THEME_GRIP[def.theme]);
      stepTrack(t, 1 / 60);
      if (!k.onRoad) off++;
    }
    assert.ok(off / steps < 0.03, `${def.id}: rival off road ${((off / steps) * 100).toFixed(1)}%`);
  }
});

test('road obstacles: cones slow and fall, tyres block, oil makes you slide', () => {
  const at = (type) => buildTrack({ ...square, obstacles: [{ type, u: 0.1, lat: 0 }] });
  /** Drives a kart flat out along the centre line, straight at the obstacle. */
  const target = at('cone').obstacles[0];
  const drive = (t, steps) => {
    const start = t.samples[target.index - 5];
    const len = Math.hypot(target.x - start.x, target.z - start.z);
    const dir = [(target.x - start.x) / len, (target.z - start.z) / len];
    const k = createKart({ x: start.x, z: start.z, heading: Math.atan2(dir[0], dir[1]) });
    k.vx = dir[0] * 20;
    k.vz = dir[1] * 20;
    for (let i = 0; i < steps; i++) {
      stepKart(k, { throttle: 1, brake: 0, steer: 0, drift: false }, 1 / 60, t);
      stepTrack(t, 1 / 60);
    }
    return k;
  };
  const clear = drive(buildTrack(square), 40);

  const cones = at('cone');
  const afterCone = drive(cones, 40);
  assert.ok(cones.coneDown[0] > 0, 'cone was knocked over');
  assert.ok(afterCone.speed < clear.speed - 2, 'cone slowed the kart');
  drive(cones, 60 * 5);
  assert.equal(cones.coneDown[0], 0, 'cone stood back up');

  const tyres = at('tyres');
  const o = tyres.obstacles[0];
  const blocked = drive(tyres, 40);
  assert.ok(Math.hypot(blocked.x - o.x, blocked.z - o.z) >= o.r, 'kart never ends up inside the stack');
  assert.ok(blocked.speed < clear.speed - 8, 'tyre stack stopped the kart');

  const oil = at('oil');
  assert.ok(drive(oil, 30).slick > 0, 'oil made the kart slide');

  const clean = validateDef({ ...square, obstacles: [{ type: 'lava', u: 9, lat: -9 }] });
  assert.deepEqual(clean.obstacles, [{ type: 'cone', u: 0.9999, lat: -0.9 }]);
});

// A long oval: two 400 m straights, so there is room to test jumps in a straight line.
const oval = { name: 'Oval', theme: 'meadow', width: 14, laps: 1, checkpoints: 4, points: [[-200, -60], [200, -60], [200, 60], [-200, 60]] };

/** Sends a kart at a ramp or gap at a steady speed and reports what happened. */
function approach(track, speed) {
  const start = track.samples[track.ramps[0].index - 4];
  const k = createKart({ x: start.x, z: start.z, y: start.y, heading: Math.atan2(start.tx, start.tz) });
  k.vx = start.tx * speed;
  k.vz = start.tz * speed;
  let peak = 0;
  let flew = false;
  for (let i = 0; i < 90 * 3 && !k.fell; i++) {
    stepKart(k, { throttle: k.speed < speed ? 1 : 0, brake: 0, steer: 0, drift: false }, 1 / 90, track);
    peak = Math.max(peak, k.y);
    flew = flew || k.air;
  }
  return { k, peak, flew };
}

test('hills: the road, the ground beside it and the karts all follow the height', () => {
  const hill = buildTrack({ ...oval, points: [[-200, -60], [0, -60, 12], [200, -60], [200, 60], [-200, 60]] });
  assert.equal(hill.flat, false);
  const top = hill.samples.reduce((a, b) => (b.y > a.y ? b : a));
  assert.ok(top.y > 11 && top.y <= 12.5, `peak ${top.y}`);
  assert.ok(Math.abs(surfaceAt(hill, top.x, top.z, top.y).y - top.y) < 0.2, 'road surface is at the top of the hill');
  assert.ok(terrainAt(hill, top.x + top.rx * 12, top.z + top.rz * 12) > 10, 'ground beside the road rises with it');
  assert.equal(terrainAt(hill, top.x, top.z - 400), 0, 'far away the land is flat again');
  assert.equal(buildTrack(oval).flat, true);
  assert.deepEqual(validateDef({ ...oval, points: [[-200, -60, 999], [200, -60, -5], [200, 60], [-200, 60]] }).points[0], [-200, -60, 40]);
});

test('a bridge: the road underneath is a separate level', () => {
  // A figure of eight whose second pass over the middle is 10 m up.
  const eight = buildTrack({ ...oval, points: [[0, 0], [80, -60], [160, 0], [80, 60], [0, 0, 10], [-80, -60], [-160, 0], [-80, 60]] });
  assert.ok(Math.abs(surfaceAt(eight, 0, 0, 0).y) < 0.5, 'a kart on the ground stays on the lower road');
  assert.ok(Math.abs(surfaceAt(eight, 0, 0, 10).y - 10) < 0.5, 'a kart on the bridge stays on the bridge');
  assert.ok(terrainAt(eight, 0, 0) < 1, 'the land is cut away under the bridge');
  // A checkpoint on the bridge cannot be taken from underneath it.
  const g = { ...eight.gates[0], y: 10 };
  const under = { ...eight, gates: [g, ...eight.gates.slice(1)] };
  const p = createProgress();
  assert.equal(updateProgress(under, p, g.x - g.tx, g.z - g.tz, g.x + g.tx, g.z + g.tz, 0, 0), null);
  assert.equal(updateProgress(under, p, g.x - g.tx, g.z - g.tz, g.x + g.tx, g.z + g.tz, 0, 10), 'gate');
});

test('jump ramps launch a kart and it lands back on the road', () => {
  const t = buildTrack({ ...oval, obstacles: [{ type: 'ramp', u: 0.2, lat: 0 }] });
  const { k, peak, flew } = approach(t, 25);
  assert.equal(flew, true);
  assert.ok(peak > 1.5 && peak < 5, `peak ${peak}`);
  assert.equal(k.air, false);
  assert.equal(k.onRoad, true);
  assert.ok(Math.abs(k.y) < 0.01);
});

test('gaps: fast karts clear them, slow karts fall in and are put back with a run-up', () => {
  const t = buildTrack({ ...oval, obstacles: [{ type: 'gap', u: 0.2, lat: 0 }] });
  const gap = t.gaps[0];
  const hole = t.samples[Math.round((gap.d0 + gap.len / 2) / t.step)];
  assert.equal(surfaceAt(t, hole.x, hole.z, 0).hole, true);

  const fast = approach(t, 26);
  assert.equal(fast.k.fell, 0);
  assert.ok(fast.k.x > hole.x + gap.len / 2, 'landed on the far side');

  const slow = approach(t, 11);
  assert.equal(slow.k.fell, 1);
  const lip = t.samples[t.ramps[0].index];
  assert.ok(lip.x - slow.k.x > GAP.runUp - 4, 'respawned well back from the gap');
  assert.equal(slow.k.air, false);
  assert.equal(slow.k.speed, 0);
});

test('nothing flings a kart into the sky', () => {
  // Shoving a kart sideways onto the high end of a ramp is a sudden 1.6 m step up.
  const t = buildTrack({ ...oval, obstacles: [{ type: 'ramp', u: 0.2, lat: 0 }] });
  const r = t.ramps[0];
  const s = t.samples[r.index + 3];
  const k = createKart({ x: s.x, z: s.z, y: s.y, heading: Math.atan2(s.tx, s.tz) });
  let peak = 0;
  for (let i = 0; i < 180; i++) {
    stepKart(k, { throttle: 0, brake: 0, steer: 0, drift: false }, 1 / 90, t);
    peak = Math.max(peak, k.y);
  }
  assert.ok(peak < 2.2, `peak ${peak}`);
});
