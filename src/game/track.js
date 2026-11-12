// Track maths. Pure functions with no rendering code, so the server and the
// tests can share them with the game.

export const THEMES = ['meadow', 'desert', 'snow', 'neon'];

export const LIMITS = {
  minPoints: 4,
  maxPoints: 120,
  maxCoord: 600,
  minWidth: 9,
  maxWidth: 24,
  minLaps: 1,
  maxLaps: 9,
  minCheckpoints: 3,
  maxCheckpoints: 24,
  maxPads: 30,
  maxObstacles: 40,
  maxHeight: 40,
  minLength: 150,
  maxName: 32,
};

// Things placed on the road. Cones slow you a little and get knocked over,
// tyre stacks are solid, oil makes you slide.
export const OBSTACLES = {
  cone: { r: 0.6, label: 'Cone' },
  tyres: { r: 0.95, label: 'Tyre stack' },
  oil: { r: 1.7, label: 'Oil slick' },
  // These two span the whole road rather than sitting at one spot.
  ramp: { r: 0, span: true, label: 'Jump ramp' },
  gap: { r: 0, span: true, label: 'Gap to jump' },
};
export const RAMP = { len: 8, h: 1.6 };
// A gap is a short take-off lip followed by a hole. Too slow and you fall in.
export const GAP = { lip: 5, lipH: 0.9, hole: 10, runUp: 34 };
export const GRAVITY = 18;
export const CONE_RESET = 4; // seconds before a knocked cone stands back up

export const mod = (a, n) => ((a % n) + n) % n;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const wrapAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Checks a track definition and returns a clean copy. Throws an Error with a
 * message a player can read when the definition can't be used.
 */
export function validateDef(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Track data is missing.');
  const num = (v, lo, hi, fallback) => (Number.isFinite(+v) ? clamp(+v, lo, hi) : fallback);
  if (!Array.isArray(raw.points)) throw new Error('Track has no points.');
  if (raw.points.length < LIMITS.minPoints) throw new Error(`A track needs at least ${LIMITS.minPoints} points.`);
  if (raw.points.length > LIMITS.maxPoints) throw new Error(`A track can have at most ${LIMITS.maxPoints} points.`);
  const points = raw.points.map((p) => {
    if (!Array.isArray(p) || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) throw new Error('Track has a broken point.');
    const out = [
      Math.round(clamp(+p[0], -LIMITS.maxCoord, LIMITS.maxCoord) * 10) / 10,
      Math.round(clamp(+p[1], -LIMITS.maxCoord, LIMITS.maxCoord) * 10) / 10,
    ];
    // Optional third number: how high the road is at this point, in metres.
    const h = Number.isFinite(+p[2]) ? Math.round(clamp(+p[2], 0, LIMITS.maxHeight) * 10) / 10 : 0;
    if (h > 0) out.push(h);
    return out;
  });
  const name = String(raw.name ?? 'Untitled').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, LIMITS.maxName) || 'Untitled';
  const def = {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 40) : undefined,
    name,
    theme: THEMES.includes(raw.theme) ? raw.theme : 'meadow',
    width: num(raw.width, LIMITS.minWidth, LIMITS.maxWidth, 14),
    laps: Math.round(num(raw.laps, LIMITS.minLaps, LIMITS.maxLaps, 3)),
    checkpoints: Math.round(num(raw.checkpoints, LIMITS.minCheckpoints, LIMITS.maxCheckpoints, 6)),
    points,
    pads: [],
  };
  if (Array.isArray(raw.pads)) {
    def.pads = raw.pads.slice(0, LIMITS.maxPads).map((p) => ({
      u: num(p?.u, 0, 0.9999, 0),
      lat: num(p?.lat, -0.8, 0.8, 0),
    }));
  }
  def.obstacles = [];
  if (Array.isArray(raw.obstacles)) {
    def.obstacles = raw.obstacles.slice(0, LIMITS.maxObstacles).map((o) => ({
      type: Object.hasOwn(OBSTACLES, o?.type) ? o.type : 'cone',
      u: num(o?.u, 0, 0.9999, 0),
      lat: num(o?.lat, -0.9, 0.9, 0),
    }));
  }
  if (typeof raw.author === 'string') def.author = raw.author.slice(0, 20);
  const track = buildTrack(def);
  if (track.length < LIMITS.minLength) throw new Error('The track is too short. Spread the points out more.');
  return def;
}

/**
 * Turns a definition (a loop of control points) into everything the game
 * needs: evenly spaced centre-line samples, checkpoint gates and boost pads.
 */
export function buildTrack(def) {
  const pts = def.points;
  const n = pts.length;
  const SUB = 20;
  const dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[mod(i - 1, n)];
    const p1 = pts[i];
    const p2 = pts[mod(i + 1, n)];
    const p3 = pts[mod(i + 2, n)];
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB;
      dense.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t), Math.max(0, catmull(p0[2] || 0, p1[2] || 0, p2[2] || 0, p3[2] || 0, t))]);
    }
  }
  const cum = [0];
  for (let i = 0; i < dense.length; i++) {
    const a = dense[i];
    const b = dense[(i + 1) % dense.length];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[dense.length];
  const count = Math.max(48, Math.round(length / 2));
  const step = length / count;

  const samples = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (seg < dense.length - 1 && cum[seg + 1] < target) seg++;
    const a = dense[seg];
    const b = dense[(seg + 1) % dense.length];
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / span;
    samples.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, y: a[2] + (b[2] - a[2]) * t, d: target });
  }
  for (let k = 0; k < count; k++) {
    const a = samples[mod(k - 1, count)];
    const b = samples[mod(k + 1, count)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const s = samples[k];
    s.tx = (b.x - a.x) / len;
    s.tz = (b.z - a.z) / len;
    // Right-hand side of the direction of travel.
    s.rx = -s.tz;
    s.rz = s.tx;
    s.slope = (b.y - a.y) / (2 * step); // rise per metre travelled
  }
  const flat = samples.every((s) => s.y === 0);

  const half = def.width / 2;
  const gateCount = clamp(def.checkpoints, LIMITS.minCheckpoints, Math.min(LIMITS.maxCheckpoints, Math.floor(count / 6)));
  const gates = [];
  for (let i = 0; i < gateCount; i++) {
    const index = Math.round((i * count) / gateCount) % count;
    const s = samples[index];
    gates.push({ index, x: s.x, z: s.z, y: s.y, tx: s.tx, tz: s.tz, rx: s.rx, rz: s.rz, half });
  }

  const pads = (def.pads || []).map((p) => {
    const s = samples[Math.floor(p.u * count) % count];
    const lat = p.lat * half;
    return { x: s.x + s.rx * lat, z: s.z + s.rz * lat, y: s.y, heading: Math.atan2(s.tx, s.tz), u: p.u, lat: p.lat };
  });

  const obstacles = [];
  const ramps = []; // { d0, len, h }: the road rises by h over len metres, then drops away
  const gaps = []; // { d0, len, index }: a missing stretch of road
  for (const o of def.obstacles || []) {
    const index = Math.floor(o.u * count) % count;
    const s = samples[index];
    if (o.type === 'ramp') ramps.push({ d0: s.d, len: RAMP.len, h: RAMP.h, index });
    else if (o.type === 'gap') {
      ramps.push({ d0: s.d, len: GAP.lip, h: GAP.lipH, index });
      gaps.push({ d0: s.d + GAP.lip, len: GAP.hole, index, id: gaps.length });
    } else {
      const lat = o.lat * half;
      obstacles.push({ type: o.type, r: OBSTACLES[o.type].r, x: s.x + s.rx * lat, z: s.z + s.rz * lat, y: s.y, index, lat, heading: Math.atan2(s.tx, s.tz) });
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z);
    maxZ = Math.max(maxZ, s.z);
  }

  return {
    def,
    samples,
    count,
    step,
    length,
    width: def.width,
    half,
    gates,
    pads,
    obstacles,
    ramps,
    gaps,
    flat,
    // Seconds until each knocked-over cone is back. Shared by every kart on the track.
    coneDown: new Float32Array(obstacles.length),
    laps: def.laps,
    bounds: { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 },
  };
}

/** Nearest centre-line sample to a point, with distance and signed side offset. */
export function nearest(track, x, z) {
  const S = track.samples;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < S.length; i++) {
    const dx = x - S[i].x;
    const dz = z - S[i].z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) {
      bd = d2;
      best = i;
    }
  }
  const s = S[best];
  return { index: best, dist: Math.sqrt(bd), lateral: (x - s.x) * s.rx + (z - s.z) * s.rz };
}

/** Like nearest(), but only looks around a known index. Cheap, and safe where tracks cross. */
export function nearestAround(track, x, z, hint, back = 6, ahead = 30) {
  const S = track.samples;
  let best = hint;
  let bd = Infinity;
  for (let o = -back; o <= ahead; o++) {
    const i = mod(hint + o, S.length);
    const dx = x - S[i].x;
    const dz = z - S[i].z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) {
      bd = d2;
      best = i;
    }
  }
  return { index: best, dist: Math.sqrt(bd) };
}

export function isOnRoad(track, x, z) {
  const lim = (track.half + 1.2) ** 2;
  const S = track.samples;
  for (let i = 0; i < S.length; i++) {
    const dx = x - S[i].x;
    const dz = z - S[i].z;
    if (dx * dx + dz * dz < lim) return true;
  }
  return false;
}

/**
 * Height of the open ground at a point. The land follows the road's height
 * near it and eases back down to zero further away. Where a lower stretch of
 * road passes close by, the ground stays down at that level, which is what
 * turns a crossing into a bridge.
 */
export function terrainAt(track, x, z) {
  return track.flat ? 0 : terrainInfo(track, x, z).h;
}

/** terrainAt() plus the nearest bit of road: { h, index, dist }. */
export function terrainInfo(track, x, z) {
  const S = track.samples;
  const n = S.length;
  const cut = (track.half + 7) ** 2;
  let bd = Infinity;
  let bi = 0;
  near.length = 0;
  for (let i = 0; i < n; i++) {
    const dx = x - S[i].x;
    const dz = z - S[i].z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) {
      bd = d2;
      bi = i;
    }
    if (d2 < cut) near.push(i);
  }
  const dist = Math.sqrt(bd);
  const t = clamp((dist - track.half - 5) / 40, 0, 1);
  let h = S[bi].y * (1 - t * t * (3 - 2 * t));
  // Only a different stretch of road counts, not the same road a little further on.
  for (const i of near) {
    const apart = Math.min(mod(i - bi, n), mod(bi - i, n));
    if (apart > 30 && S[i].y < h - 1.5) h = S[i].y;
  }
  return { h, index: bi, dist };
}
const near = [];

/**
 * What is under a kart at (x, z) that is currently at height y.
 * Returns { onRoad, y, roadY, slope, hole, gap, index }. Knowing the kart's
 * height lets it pick the right road where one passes over another.
 */
export function surfaceAt(track, x, z, y) {
  const S = track.samples;
  let best = 0;
  let bs = Infinity;
  let bd = 0;
  for (let i = 0; i < S.length; i++) {
    const dx = x - S[i].x;
    const dz = z - S[i].z;
    const d2 = dx * dx + dz * dz;
    const dy = track.flat ? 0 : S[i].y - y;
    const score = d2 + dy * dy * 3;
    if (score < bs) {
      bs = score;
      bd = d2;
      best = i;
    }
  }
  const s = S[best];
  if (bd > (track.half + 1.2) ** 2) return { onRoad: false, y: terrainAt(track, x, z), roadY: s.y, slope: 0, hole: false, gap: null, index: best };
  const along = (x - s.x) * s.tx + (z - s.z) * s.tz;
  let roadY = s.y + s.slope * along;
  let slope = s.slope;
  const d = s.d + along;
  for (const r of track.ramps) {
    const rel = mod(d - r.d0, track.length);
    if (rel < r.len) {
      roadY += (r.h * rel) / r.len;
      slope += r.h / r.len;
    }
  }
  for (const g of track.gaps) {
    if (mod(d - g.d0, track.length) < g.len) return { onRoad: true, y: roadY - 40, roadY, slope: 0, hole: true, gap: g, index: best };
  }
  return { onRoad: true, y: roadY, roadY, slope, hole: false, gap: null, index: best };
}

/** Position and heading for a kart placed at a sample, `lateral` metres to the right. */
export function poseAt(track, index, lateral = 0) {
  const s = track.samples[mod(index, track.count)];
  return { x: s.x + s.rx * lateral, z: s.z + s.rz * lateral, y: s.y, heading: Math.atan2(s.tx, s.tz) };
}

/** Starting grid: two columns lined up behind the start/finish line. */
export function gridPose(track, slot) {
  const row = Math.floor(slot / 2);
  const back = Math.round((7 + row * 6 + (slot % 2) * 2.5) / track.step);
  const lateral = (slot % 2 === 0 ? -1 : 1) * track.half * 0.42;
  return poseAt(track, -back, lateral);
}

// ---------------------------------------------------------------- checkpoints

/** Per-kart race progress. `count` is how many gates have been taken in order. */
export function createProgress() {
  return { count: 0, next: 0, finished: false, finishTime: 0, lapTimes: [], lapStart: 0, lastGate: 0, missed: false };
}

function crossedGate(g, x0, z0, x1, z1, y) {
  if (y !== undefined && Math.abs(y - g.y) > 5) return false; // a different level of the track
  const s0 = (x0 - g.x) * g.tx + (z0 - g.z) * g.tz;
  const s1 = (x1 - g.x) * g.tx + (z1 - g.z) * g.tz;
  if (!(s0 < 0 && s1 >= 0)) return false;
  const t = s0 / (s0 - s1);
  const px = x0 + (x1 - x0) * t;
  const pz = z0 + (z1 - z0) * t;
  const lat = (px - g.x) * g.rx + (pz - g.z) * g.rz;
  return Math.abs(lat) <= g.half + 2.5;
}

/**
 * Advances a kart's progress after it moved from (x0,z0) to (x1,z1).
 * Gates only count in order, so cutting across the map earns nothing.
 * Returns 'gate', 'lap', 'finish', 'missed' or null.
 */
export function updateProgress(track, p, x0, z0, x1, z1, time, y) {
  if (p.finished) return null;
  const G = track.gates;
  const N = G.length;
  if (crossedGate(G[p.next], x0, z0, x1, z1, y)) {
    p.missed = false;
    p.lastGate = p.next;
    p.count++;
    p.next = (p.next + 1) % N;
    if (p.lastGate !== 0) return 'gate';
    if (p.count === 1) {
      p.lapStart = time;
      return 'gate';
    }
    p.lapTimes.push(time - p.lapStart);
    p.lapStart = time;
    if (p.count >= track.laps * N + 1) {
      p.finished = true;
      p.finishTime = time;
      return 'finish';
    }
    return 'lap';
  }
  // Going through a later gate first means one was skipped.
  for (let k = 1; k < N; k++) {
    const gi = (p.next + k) % N;
    if (gi === p.lastGate && p.count > 0) continue;
    if (crossedGate(G[gi], x0, z0, x1, z1, y)) {
      p.missed = true;
      return 'missed';
    }
  }
  return null;
}

export function currentLap(track, p) {
  return clamp(Math.floor(Math.max(p.count - 1, 0) / track.gates.length) + 1, 1, track.laps);
}

/** Gates taken so far in the current lap (the start line counts as the first). */
export function gatesThisLap(track, p) {
  if (p.count === 0) return 0;
  return ((p.count - 1) % track.gates.length) + 1;
}

/** Bigger is further ahead. Used for live race positions. */
export function raceScore(track, p, x, z) {
  if (p.finished) return 1e9 - p.finishTime;
  const g = track.gates[p.next];
  return p.count * 10000 - Math.hypot(g.x - x, g.z - z);
}

export function medalFor(time, medals) {
  if (!medals || !(time > 0)) return null;
  if (time <= medals.gold) return 'gold';
  if (time <= medals.silver) return 'silver';
  if (time <= medals.bronze) return 'bronze';
  return null;
}

export const MEDAL_RANK = { gold: 3, silver: 2, bronze: 1 };

export function formatTime(t) {
  if (!(t > 0) || !Number.isFinite(t)) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

// Small seeded random generator so scenery is the same for every player.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
