// Arcade kart handling: grippy by default, slidey while drifting, with a
// mini-turbo for holding a drift. No rendering code in here.

import { clamp, mod, wrapAngle, nearestAround, surfaceAt, updateProgress, createProgress, gridPose, poseAt, buildTrack, CONE_RESET, GRAVITY, GAP } from './track.js';

export const TUNING = {
  maxSpeed: 29,
  boostSpeed: 38,
  accel: 17,
  boostAccel: 34,
  brake: 38,
  reverseSpeed: 8,
  offroadFactor: 0.42,
  grip: 9,
  driftGrip: 2.6,
  radius: 1.15,
  padBoost: 1.3,
};

export const THEME_GRIP = { meadow: 1, desert: 0.95, snow: 0.72, neon: 1 };

export function createKart(pose = { x: 0, z: 0, heading: 0 }) {
  return {
    x: pose.x,
    z: pose.z,
    y: pose.y || 0, // height
    vy: 0,
    air: false, // off the ground: jumping or falling
    slope: 0, // rise per metre in the direction the kart faces
    landed: 0, // how hard the last landing was, for effects
    fell: 0, // counts falls into gaps
    lastGap: -1,
    gapTries: 0,
    heading: pose.heading,
    vx: 0,
    vz: 0,
    speed: 0, // forward speed, m/s
    slip: 0, // sideways speed, m/s
    steer: 0, // smoothed steering, -1..1 (positive is left)
    drifting: false,
    driftDir: 0,
    driftCharge: 0,
    boost: 0, // seconds of boost left
    boostLevel: 0,
    onRoad: true,
    padCooldown: 0,
    slick: 0, // seconds of sliding left after hitting oil
    braking: false,
    hit: 0, // strength of the last bump, for effects
  };
}

export const NO_INPUT = { throttle: 0, brake: 0, steer: 0, drift: false };

/** Moves one kart forward by dt seconds. `gripMul` comes from the track theme. */
export function stepKart(k, input, dt, track, gripMul = 1) {
  const T = TUNING;
  k.steer += (clamp(input.steer, -1, 1) - k.steer) * Math.min(1, 9 * dt);
  k.braking = input.brake > 0;

  let fx = Math.sin(k.heading);
  let fz = Math.cos(k.heading);
  const fwd = k.vx * fx + k.vz * fz;
  const absSpeed = Math.abs(fwd);

  // --- drifting
  if (!k.drifting && input.drift && absSpeed > 11 && Math.abs(k.steer) > 0.25 && k.onRoad && !k.air) {
    k.drifting = true;
    k.driftDir = Math.sign(k.steer);
    k.driftCharge = 0;
  }
  if (k.drifting) {
    if (!input.drift || absSpeed < 7 || k.air) {
      if (input.drift === false && k.driftCharge > 0.9 && absSpeed >= 7) {
        k.boostLevel = k.driftCharge > 2.1 ? 2 : 1;
        k.boost = Math.max(k.boost, k.boostLevel === 2 ? 1.5 : 0.75);
      }
      k.drifting = false;
      k.driftCharge = 0;
    } else {
      k.driftCharge += dt * (k.onRoad ? 1 : 0.3);
    }
  }

  // --- steering
  let steer = k.steer;
  if (k.drifting) steer = k.driftDir * 0.62 + k.steer * 0.55;
  const authority = clamp(absSpeed / 5, 0, 1) * (k.slick > 0 ? 0.35 : 1) * (k.air ? 0.25 : 1);
  const turnRate = 2.5 - 0.95 * clamp(absSpeed / T.maxSpeed, 0, 1);
  k.heading = wrapAngle(k.heading + steer * turnRate * authority * (fwd < -0.5 ? -1 : 1) * dt);

  // --- velocity in the kart's new frame
  fx = Math.sin(k.heading);
  fz = Math.cos(k.heading);
  const rx = -fz;
  const rz = fx;
  let vf = k.vx * fx + k.vz * fz;
  let vr = k.vx * rx + k.vz * rz;

  const boosting = k.boost > 0;
  let top = boosting ? T.boostSpeed : T.maxSpeed;
  if (!k.onRoad) top *= T.offroadFactor;
  if (input.topMul) top *= input.topMul;

  if (k.air) {
    // Nothing to push against in the air: keep the speed we took off with.
  } else {
  vf -= GRAVITY * 0.3 * k.slope * dt; // hills: slower up, faster down
  if (input.throttle > 0 && vf < top) {
    const a = boosting ? T.boostAccel : T.accel;
    vf += a * input.throttle * clamp(1.15 - vf / top, 0.12, 1) * dt;
  }
  if (boosting && vf < top) vf += T.boostAccel * 0.5 * dt;
  if (input.brake > 0) {
    if (vf > 0.5) vf -= T.brake * input.brake * dt;
    else if (vf > -T.reverseSpeed) vf -= 12 * input.brake * dt;
  }
  if (vf > top) vf -= (vf - top) * Math.min(1, (k.onRoad ? 2.2 : 3.5) * dt);
  // Rolling resistance, stronger when coasting.
  vf -= vf * (input.throttle > 0 ? 0.05 : 0.55) * dt;
  if (Math.abs(vf) < 0.05 && input.throttle === 0 && input.brake === 0 && Math.abs(k.slope) < 0.02) vf = 0;

  const grip = (k.drifting ? T.driftGrip : T.grip) * (k.onRoad ? gripMul : 0.6) * (k.slick > 0 ? 0.1 : 1);
  vr -= vr * Math.min(1, grip * dt);
  }

  k.vx = fx * vf + rx * vr;
  k.vz = fz * vf + rz * vr;
  k.x += k.vx * dt;
  k.z += k.vz * dt;
  k.speed = vf;
  k.slip = vr;

  // --- height: follow the ground, take off over crests and ramps, fall into gaps
  const surf = surfaceAt(track, k.x, k.z, k.y);
  k.onRoad = surf.onRoad;
  if (k.landed > 0) k.landed = Math.max(0, k.landed - dt * 3);
  if (k.air) {
    k.vy -= GRAVITY * dt;
    k.y += k.vy * dt;
    if (surf.hole) k.overGap = surf.gap;
    if (k.y <= surf.y) {
      if (k.overGap && k.y < surf.y - 1.2) {
        fallInGap(k, track, k.overGap, input.auto); // hit the far wall of the gap
      } else {
        k.landed = clamp(-k.vy / 9, 0, 1);
        k.y = surf.y;
        k.vy = 0;
        k.air = false;
        k.overGap = null;
        k.gapTries = 0;
      }
    } else if (k.overGap && k.y < surf.roadY - 6) {
      fallInGap(k, track, k.overGap, input.auto);
    }
  } else {
    const free = k.y + k.vy * dt - GRAVITY * dt * dt; // where we would be with nothing under us
    if (surf.y < free - 0.03) {
      k.air = true;
      k.vy -= GRAVITY * dt;
      k.y += k.vy * dt;
      k.overGap = surf.hole ? surf.gap : null;
    } else {
      // Climbing speed is capped by how fast the kart is moving, so a sudden
      // step up (the side of a ramp, a shove from another kart) can't fling it skywards.
      k.vy = clamp((surf.y - k.y) / dt, -30, Math.abs(vf) * 0.45 + 1.5);
      k.y = surf.y;
    }
  }
  k.slope = k.air ? 0 : surf.slope * (fx * track.samples[surf.index].tx + fz * track.samples[surf.index].tz);

  if (k.boost > 0) k.boost = Math.max(0, k.boost - dt);
  if (k.padCooldown > 0) k.padCooldown -= dt;
  if (k.slick > 0) k.slick = Math.max(0, k.slick - dt);
  hitRoadObstacles(k, track);
  if (k.hit > 0) k.hit = Math.max(0, k.hit - dt * 3);

  if (k.padCooldown <= 0) {
    for (const p of track.pads) {
      const dx = k.x - p.x;
      const dz = k.z - p.z;
      if (dx * dx + dz * dz < 10 && Math.abs(k.y - p.y) < 1) {
        k.boost = Math.max(k.boost, T.padBoost);
        k.boostLevel = 2;
        k.padCooldown = 1;
        k.padHit = true;
        break;
      }
    }
  }
}

/** Cones, tyre stacks and oil placed on the road. */
function hitRoadObstacles(k, track) {
  const list = track.obstacles;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.type === 'cone' && track.coneDown[i] > 0) continue;
    if (Math.abs(k.y - o.y) > 1.2) continue; // jumped clean over it
    const dx = k.x - o.x;
    const dz = k.z - o.z;
    const R = o.r + (o.type === 'oil' ? 0.2 : TUNING.radius * 0.75);
    const d2 = dx * dx + dz * dz;
    if (d2 >= R * R) continue;
    if (o.type === 'oil') {
      if (k.slick <= 0 && Math.abs(k.speed) > 6) k.slick = 1.1;
    } else if (o.type === 'cone') {
      track.coneDown[i] = CONE_RESET;
      k.vx *= 0.8;
      k.vz *= 0.8;
      k.hit = Math.max(k.hit, 0.6);
    } else if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      k.x = o.x + nx * R;
      k.z = o.z + nz * R;
      const vn = k.vx * nx + k.vz * nz;
      if (vn < 0) {
        k.vx = (k.vx - nx * vn * 1.4) * 0.6;
        k.vz = (k.vz - nz * vn * 1.4) * 0.6;
        k.hit = Math.min(1, -vn / 10);
      }
    }
  }
}

/** A kart dropped into a gap: put it back up the road with room to build speed. */
function fallInGap(k, track, gap, auto) {
  k.gapTries = k.lastGap === gap.id ? k.gapTries + 1 : 1;
  k.lastGap = gap.id;
  // Computer drivers that keep falling are waved through so they never get stuck.
  const index = auto && k.gapTries >= 2 ? gap.index + Math.round((GAP.lip + GAP.hole + 6) / track.step) : gap.index - Math.round(GAP.runUp / track.step);
  respawn(k, track, index);
  k.fell++;
}

/** Call once per physics step: stands knocked cones back up when their time is over. */
export function stepTrack(track, dt) {
  const c = track.coneDown;
  for (let i = 0; i < c.length; i++) if (c[i] > 0) c[i] = Math.max(0, c[i] - dt);
}

/** Pushes overlapping karts apart. `movable[i] === false` keeps kart i in place (remote players). */
export function collideKarts(karts, movable) {
  const R = TUNING.radius * 2;
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i];
      const b = karts[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R || d2 < 1e-6 || Math.abs(a.y - b.y) > 1.5) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      const overlap = R - d;
      const ma = !movable || movable[i] !== false;
      const mb = !movable || movable[j] !== false;
      if (!ma && !mb) continue;
      const wa = ma ? (mb ? 0.5 : 1) : 0;
      const wb = mb ? (ma ? 0.5 : 1) : 0;
      a.x -= nx * overlap * wa;
      a.z -= nz * overlap * wa;
      b.x += nx * overlap * wb;
      b.z += nz * overlap * wb;
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const imp = -rel * 0.8;
        if (ma) {
          a.vx -= nx * imp * (mb ? 0.5 : 1);
          a.vz -= nz * imp * (mb ? 0.5 : 1);
          a.hit = Math.min(1, -rel / 8);
        }
        if (mb) {
          b.vx += nx * imp * (ma ? 0.5 : 1);
          b.vz += nz * imp * (ma ? 0.5 : 1);
          b.hit = Math.min(1, -rel / 8);
        }
      }
    }
  }
}

/** Solid scenery: trees, rocks and so on, each a circle {x, z, r}. */
export function collideObstacles(k, obstacles) {
  for (const o of obstacles) {
    if (Math.abs(k.y - (o.y || 0)) > 4) continue;
    const dx = k.x - o.x;
    const dz = k.z - o.z;
    const R = o.r + TUNING.radius * 0.8;
    const d2 = dx * dx + dz * dz;
    if (d2 >= R * R || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const nz = dz / d;
    k.x = o.x + nx * R;
    k.z = o.z + nz * R;
    const vn = k.vx * nx + k.vz * nz;
    if (vn < 0) {
      k.vx -= nx * vn * 1.4;
      k.vz -= nz * vn * 1.4;
      k.vx *= 0.6;
      k.vz *= 0.6;
      k.hit = Math.min(1, -vn / 10);
    }
  }
}

// ------------------------------------------------------------------ AI driver

export function createAI(skill = 1, lane = 0) {
  return { index: 0, skill, lane, stuck: 0, offset: lane };
}

/** Works out throttle, brake and steering for a computer-driven kart. */
export function aiInput(k, track, ai, dt) {
  const S = track.samples;
  const n = S.length;
  const found = nearestAround(track, k.x, k.z, ai.index);
  // After a respawn the kart can be far from where it was; look everywhere.
  ai.index = found.dist > 20 ? surfaceAt(track, k.x, k.z, k.y).index : found.index;
  const speed = Math.hypot(k.vx, k.vz);

  const look = 7 + speed * 0.42;
  const s = S[mod(ai.index + Math.round(look / track.step), n)];
  // Pick a line, moving over for anything solid or slippery coming up.
  let lane = ai.lane * track.half * 0.55;
  const see = 12 + speed * 1.2;
  for (let i = 0; i < track.obstacles.length; i++) {
    const o = track.obstacles[i];
    if (o.type === 'cone' && track.coneDown[i] > 0) continue;
    const ahead = mod(o.index - ai.index, n) * track.step;
    if (ahead > see || Math.abs(o.lat - lane) > o.r + 1.7) continue;
    lane = clamp(o.lat + (o.lat >= 0 ? -1 : 1) * (o.r + 2.3), -track.half + 1.4, track.half - 1.4);
  }
  ai.offset += (lane - ai.offset) * Math.min(1, 5 * dt);
  const tx = s.x + s.rx * ai.offset;
  const tz = s.z + s.rz * ai.offset;
  const diff = wrapAngle(Math.atan2(tx - k.x, tz - k.z) - k.heading);
  const steer = clamp(diff * 2.4, -1, 1);

  // How sharply the road bends over the stretch we are about to cover.
  const here = S[ai.index];
  const h0 = Math.atan2(here.tx, here.tz);
  let bend = 0;
  const reach = Math.round((12 + speed * 1.15) / track.step);
  for (let o = 4; o <= reach; o += 4) {
    const f = S[mod(ai.index + o, n)];
    bend = Math.max(bend, Math.abs(wrapAngle(Math.atan2(f.tx, f.tz) - h0)));
  }
  const target = TUNING.maxSpeed * ai.skill * clamp(1.2 - bend * 0.5, 0.4, 1);
  // A gap needs speed: never lift off on the run-up to one.
  const here_d = here.d;
  const gapAhead = track.gaps.some((g) => mod(g.d0 - here_d, track.length) < 55);
  const out = {
    auto: true,
    steer,
    throttle: gapAhead || speed < target ? 1 : 0,
    brake: !gapAhead && speed > target + 2.5 ? 0.9 : 0,
    drift: false,
    topMul: ai.skill,
  };
  ai.stuck = speed < 1.5 ? ai.stuck + dt : 0;
  return out;
}

/** Puts a kart back on the road, stopped, facing the right way. */
export function respawn(k, track, index, lateral = 0) {
  const pose = poseAt(track, index, lateral);
  Object.assign(k, { x: pose.x, z: pose.z, y: pose.y, vy: 0, air: false, overGap: null, heading: pose.heading, vx: 0, vz: 0, speed: 0, slip: 0, drifting: false, driftCharge: 0, boost: 0 });
}

/**
 * Drives a lap-perfect computer kart round the track with nothing drawn and
 * returns its race time. Medal targets are set from this, so every track,
 * including ones made in the builder, gets fair times.
 */
export function referenceTime(def) {
  const track = def.samples ? def : buildTrack(def);
  const grip = THEME_GRIP[track.def.theme] ?? 1;
  const k = createKart(gridPose(track, 0));
  const ai = createAI(1, 0);
  ai.index = mod(-Math.round(7 / track.step), track.count);
  const p = createProgress();
  const dt = 1 / 60;
  const limit = 60 * 60 * 12;
  let t = 0;
  for (let i = 0; i < limit && !p.finished; i++) {
    const x0 = k.x;
    const z0 = k.z;
    stepKart(k, aiInput(k, track, ai, dt), dt, track, grip);
    stepTrack(track, dt);
    t += dt;
    updateProgress(track, p, x0, z0, k.x, k.z, t, k.y);
    if (ai.stuck > 2) {
      respawn(k, track, ai.index + 2);
      ai.stuck = 0;
    }
  }
  track.coneDown.fill(0);
  if (p.finished) return p.finishTime;
  return (track.length * track.laps) / 18;
}

export function medalTimes(def) {
  const ref = referenceTime(def);
  const round = (v) => Math.round(v * 10) / 10;
  return { gold: round(ref * 1.0), silver: round(ref * 1.12), bronze: round(ref * 1.3) };
}
