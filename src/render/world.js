// Builds the 3D world for a track: sky, ground, road, kerbs, checkpoint
// arches, boost pads and scenery. Everything is generated in code, so the
// game ships with no art files to download.

import * as THREE from 'three';
import { rng, hashString, nearest, terrainAt, terrainInfo, mod } from '../game/track.js';

export const THEME_LOOK = {
  meadow: {
    skyTop: '#2f7fe0', skyBottom: '#cfe9ff', fog: '#cfe6f7', fogDensity: 0.0016,
    ground: ['#58b04a', '#4a9c40', '#66bd55'], road: '#4a4d57', line: '#ffffff', kerb: ['#e63946', '#ffffff'],
    sun: '#fff3d6', sunPower: 3.0, sunDir: [0.5, 0.85, 0.35], hemi: ['#bfe0ff', '#4c7a3a', 1.0],
    mountain: '#6f8f7a', scenery: 'trees', bloom: 0.25, exposure: 1.0,
  },
  desert: {
    skyTop: '#3d8fd9', skyBottom: '#ffe2b0', fog: '#f7dcae', fogDensity: 0.0018,
    ground: ['#e0b56c', '#d3a65c', '#eac57f'], road: '#5a544f', line: '#ffe9a8', kerb: ['#ff8a2a', '#fff3dc'],
    sun: '#ffe2b0', sunPower: 3.4, sunDir: [-0.55, 0.7, 0.4], hemi: ['#ffe9c4', '#b8864a', 1.0],
    mountain: '#c98d55', scenery: 'cacti', bloom: 0.3, exposure: 1.0,
  },
  snow: {
    skyTop: '#6ea3d8', skyBottom: '#eef6ff', fog: '#e6f0fa', fogDensity: 0.0028,
    ground: ['#f2f7fc', '#e3ecf5', '#ffffff'], road: '#5b6675', line: '#bfe4ff', kerb: ['#2f8bff', '#ffffff'],
    sun: '#ffffff', sunPower: 2.6, sunDir: [0.4, 0.6, -0.6], hemi: ['#e8f3ff', '#9fb4c9', 1.15],
    mountain: '#b9c9dc', scenery: 'pines', bloom: 0.2, exposure: 0.95,
  },
  neon: {
    skyTop: '#05021a', skyBottom: '#3a1466', fog: '#1a0b3a', fogDensity: 0.0022,
    ground: ['#120a2c', '#0d0722', '#1a1040'], road: '#1c1c2b', line: '#00f0ff', kerb: ['#ff2bd6', '#00f0ff'],
    sun: '#9fb0ff', sunPower: 1.3, sunDir: [0.3, 0.8, 0.5], hemi: ['#7a5cff', '#1a0b3a', 1.3],
    mountain: '#1d1147', scenery: 'neon', bloom: 0.9, exposure: 1.1, night: true,
  },
};

function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function speckle(g, w, h, colors, count, size, rand, alpha = 0.5) {
  for (let i = 0; i < count; i++) {
    g.fillStyle = colors[Math.floor(rand() * colors.length)];
    g.globalAlpha = alpha * (0.4 + rand() * 0.6);
    const s = size * (0.5 + rand());
    g.fillRect(rand() * w, rand() * h, s, s);
  }
  g.globalAlpha = 1;
}

/**
 * A strip that follows the track. Offsets are metres to the right of the
 * centre line; yIn/yOut are added to the road height at each edge. `skip(i)`
 * leaves out the piece between sample i and the next one.
 */
function ribbon(samples, innerOffset, outerOffset, yIn, uScale, skip = null, yOut = yIn) {
  const n = samples.length;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const s = samples[i % n];
    const d = i === n ? s.d + (samples[1].d - samples[0].d) * n : s.d;
    pos.set([s.x + s.rx * innerOffset, s.y + yIn, s.z + s.rz * innerOffset, s.x + s.rx * outerOffset, s.y + yOut, s.z + s.rz * outerOffset], i * 6);
    uv.set([0, d * uScale, 1, d * uScale], i * 4);
    if (i < n && !(skip && skip(i))) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function bannerTexture(text, bg, fg) {
  return canvasTexture(
    512,
    96,
    (g, w, h) => {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      if (text === 'START') {
        const s = 16;
        for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
          g.fillStyle = ((x + y) / s) % 2 ? '#111' : '#fff';
          g.fillRect(x, y, s, s);
        }
        g.fillStyle = 'rgba(0,0,0,0.75)';
        g.fillRect(110, 14, w - 220, h - 28);
        text = 'START / FINISH';
      }
      g.fillStyle = fg;
      g.font = 'italic 900 52px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 3);
    },
    false,
  );
}

/**
 * Returns { group, obstacles, setNextGate(i), update(time), dispose() }.
 * `obstacles` are the solid bits of scenery for the physics.
 */
export function buildWorld(track, scene, quality) {
  const look = THEME_LOOK[track.def.theme] || THEME_LOOK.meadow;
  const rand = rng(hashString(track.def.name + track.def.points.length));
  const group = new THREE.Group();
  const disposables = [];
  const keep = (x) => (disposables.push(x), x);
  const B = track.bounds;
  const reach = Math.max(B.maxX - B.minX, B.maxZ - B.minZ) / 2 + 160;

  // --- sky and light
  scene.fog = new THREE.FogExp2(look.fog, look.fogDensity);
  const skyMat = keep(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(look.skyTop) }, bottom: { value: new THREE.Color(look.skyBottom) } },
      vertexShader: 'varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 bottom; varying vec3 vPos; void main(){ float h = clamp(normalize(vPos).y * 1.6 + 0.08, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(h, 0.7)), 1.0); }',
    }),
  );
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(1800, 24, 12)), skyMat);
  group.add(sky);

  const hemi = new THREE.HemisphereLight(look.hemi[0], look.hemi[1], look.hemi[2]);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(look.sun, look.sunPower);
  const sunDir = new THREE.Vector3(...look.sunDir).normalize();
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -55;
  sc.right = sc.top = 55;
  sc.near = 1;
  sc.far = 260;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  group.add(sun, sun.target);

  if (look.night) {
    const starPos = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const a = rand() * Math.PI * 2;
      const e = Math.acos(rand() * 0.95);
      starPos.set([Math.sin(e) * Math.cos(a) * 1500, Math.cos(e) * 1500, Math.sin(e) * Math.sin(a) * 1500], i * 3);
    }
    const sg = keep(new THREE.BufferGeometry());
    sg.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    group.add(new THREE.Points(sg, keep(new THREE.PointsMaterial({ color: '#ffffff', size: 2.2, sizeAttenuation: false, fog: false }))));
  } else {
    const cloudMat = keep(new THREE.MeshLambertMaterial({ color: '#ffffff', fog: false, transparent: true, opacity: 0.92 }));
    const cloudGeo = keep(new THREE.IcosahedronGeometry(1, 1));
    const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, 90);
    const m = new THREE.Matrix4();
    let ci = 0;
    for (let c = 0; c < 18; c++) {
      const a = rand() * Math.PI * 2;
      const r = 300 + rand() * 700;
      const cx = B.cx + Math.cos(a) * r;
      const cz = B.cz + Math.sin(a) * r;
      const cy = 170 + rand() * 120;
      for (let p = 0; p < 5; p++) {
        const s = 22 + rand() * 26;
        m.compose(new THREE.Vector3(cx + (rand() - 0.5) * 80, cy + (rand() - 0.5) * 10, cz + (rand() - 0.5) * 50), new THREE.Quaternion(), new THREE.Vector3(s * 1.5, s * 0.55, s));
        clouds.setMatrixAt(ci++, m);
      }
    }
    group.add(clouds);
  }

  // --- ground
  const groundTex = keep(
    canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = look.ground[0];
      g.fillRect(0, 0, w, h);
      speckle(g, w, h, look.ground, 2600, 5, rand);
    }),
  );
  groundTex.repeat.set(260, 260);
  const TILE = 4000 / 260; // metres covered by one copy of the ground texture
  const groundMat = keep(new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }));
  const ground = new THREE.Mesh(keep(new THREE.PlaneGeometry(4000, 4000)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(B.cx, 0, B.cz);
  ground.receiveShadow = true;

  // Which pieces of road are missing (gaps) or carried on a bridge.
  const S = track.samples;
  const N = track.count;
  const shaped = !track.flat || track.gaps.length > 0;
  const inGap = S.map((s) => track.gaps.some((g) => mod(s.d + track.step / 2 - g.d0, track.length) < g.len));
  const nearGap = S.map((_, i) => {
    for (let o = -4; o <= 4; o++) if (inGap[mod(i + o, N)]) return true;
    return false;
  });
  const bridge = S.map((s) => !track.flat && terrainAt(track, s.x, s.z) < s.y - 1.5);
  const PIT = 12; // how deep a gap is

  // Hilly tracks, and ones with gaps, get real terrain around the road. The
  // wide flat plane stays underneath as the land beyond it.
  const area = { x0: B.minX - 75, x1: B.maxX + 75, z0: B.minZ - 75, z1: B.maxZ + 75 };
  const landY = (x, z) => {
    const t = terrainInfo(track, x, z);
    let h = t.h;
    if (nearGap[t.index] && t.dist < track.half + 6) return S[t.index].y - PIT - 2; // dig the pit
    if (t.dist < track.half + 3.5) h -= 0.6; // keep the land clear of the road surface
    return h;
  };
  /** Height of the visible ground, for standing scenery on. */
  const groundY = (x, z) => {
    if (!shaped) return 0;
    if (x < area.x0 + 6 || x > area.x1 - 6 || z < area.z0 + 6 || z > area.z1 - 6) return -0.3;
    return terrainAt(track, x, z);
  };
  if (!shaped) group.add(ground);
  if (shaped) {
    // The far land is four big slabs around the terrain patch, so nothing lies under the pits.
    const far = 2000;
    const slabs = [
      [B.cx - far, area.x0, B.cz - far, B.cz + far], [area.x1, B.cx + far, B.cz - far, B.cz + far],
      [area.x0, area.x1, B.cz - far, area.z0], [area.x0, area.x1, area.z1, B.cz + far],
    ];
    const sp = [];
    const su = [];
    const si = [];
    slabs.forEach(([xa, xb, za, zb], k) => {
      for (const [x, z] of [[xa, za], [xb, za], [xa, zb], [xb, zb]]) {
        sp.push(x, -0.3, z);
        su.push(x / TILE, z / TILE);
      }
      si.push(k * 4, k * 4 + 2, k * 4 + 1, k * 4 + 1, k * 4 + 2, k * 4 + 3);
    });

    const CELL = 3;
    const nx = Math.ceil((area.x1 - area.x0) / CELL);
    const nz = Math.ceil((area.z1 - area.z0) / CELL);
    const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
    const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
    const idx = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = area.x0 + ((area.x1 - area.x0) * i) / nx;
        const z = area.z0 + ((area.z1 - area.z0) * j) / nz;
        const k = j * (nx + 1) + i;
        const edge = i === 0 || j === 0 || i === nx || j === nz;
        pos.set([x, edge ? -0.3 : landY(x, z), z], k * 3);
        uv.set([x / TILE, z / TILE], k * 2);
        if (i < nx && j < nz) idx.push(k, k + nx + 1, k + 1, k + 1, k + nx + 1, k + nx + 2);
      }
    }
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const landTex = keep(groundTex.clone());
    landTex.repeat.set(1, 1);
    landTex.needsUpdate = true;
    const landMat = keep(new THREE.MeshStandardMaterial({ map: landTex, roughness: 1 }));
    const land = new THREE.Mesh(geo, landMat);
    land.receiveShadow = true;
    group.add(land);
    const slabGeo = keep(new THREE.BufferGeometry());
    slabGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    slabGeo.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
    slabGeo.setIndex(si);
    slabGeo.computeVertexNormals();
    const farLand = new THREE.Mesh(slabGeo, landMat);
    farLand.receiveShadow = true;
    group.add(farLand);

    // Grass verges tie the road edge into the land; bridges get a deck instead.
    const noVerge = (i) => bridge[i] || bridge[mod(i + 1, N)] || nearGap[i];
    const deckMat = keep(new THREE.MeshStandardMaterial({ color: '#3a3f4b', roughness: 0.8, side: THREE.DoubleSide }));
    const notBridge = (i) => !(bridge[i] || bridge[mod(i + 1, N)]);
    for (const side of [-1, 1]) {
      const a = side * (track.half + 1.3);
      const b = side * (track.half + 6);
      const verge = new THREE.Mesh(keep(ribbon(S, Math.min(a, b), Math.max(a, b), side < 0 ? -0.7 : -0.01, 1 / TILE, noVerge, side < 0 ? -0.01 : -0.7)), groundMat);
      verge.receiveShadow = true;
      group.add(verge);
      if (bridge.some(Boolean)) {
        const wall = new THREE.Mesh(keep(ribbon(S, a, a, 0.5, 1 / 4, notBridge, -1.2)), deckMat);
        wall.castShadow = true;
        group.add(wall);
      }
    }
    if (bridge.some(Boolean)) {
      const under = new THREE.Mesh(keep(ribbon(S, -track.half - 1.3, track.half + 1.3, -1.2, 1 / 4, notBridge)), deckMat);
      under.castShadow = true;
      group.add(under);
    }
  }

  /** A point `d` metres round the track, with the road's height and sideways direction. */
  const at = (d) => {
    const f = mod(d, track.length) / track.step;
    const i = Math.floor(f) % N;
    const a = S[i];
    const b = S[(i + 1) % N];
    const t = f - Math.floor(f);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, rx: a.rx, rz: a.rz };
  };
  const hazardTex = keep(
    canvasTexture(64, 64, (g, w, h) => {
      g.fillStyle = '#16181d';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffd23b';
      for (let x = -h; x < w; x += 32) {
        g.beginPath();
        g.moveTo(x, h);
        g.lineTo(x + 16, h);
        g.lineTo(x + 16 + h, 0);
        g.lineTo(x + h, 0);
        g.fill();
      }
    }),
  );
  const hazardMat = keep(new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.6, side: THREE.DoubleSide, emissiveMap: look.night ? hazardTex : null, emissive: new THREE.Color(look.night ? '#ffffff' : '#000000'), emissiveIntensity: 0.6 }));

  // --- jump ramps (and the take-off lip in front of each gap)
  for (const r of track.ramps) {
    const SEG = 5;
    const w = track.half + 1.3;
    const pos = [];
    const uv = [];
    const idx = [];
    for (let j = 0; j <= SEG; j++) {
      const p = at(r.d0 + (r.len * j) / SEG);
      const top = p.y + (r.h * j) / SEG + 0.06;
      for (const side of [-1, 1]) {
        pos.push(p.x + p.rx * side * w, top, p.z + p.rz * side * w, p.x + p.rx * side * w, p.y - 0.2, p.z + p.rz * side * w);
        uv.push(side < 0 ? 0 : 4, j * 0.5, side < 0 ? 0 : 4, j * 0.5 + 0.3);
      }
      if (j < SEG) {
        const a = j * 4; // per row: left top, left bottom, right top, right bottom
        idx.push(a, a + 2, a + 4, a + 2, a + 6, a + 4); // surface
        idx.push(a, a + 4, a + 1, a + 1, a + 4, a + 5); // left side
        idx.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6); // right side
      }
    }
    const e = SEG * 4;
    idx.push(e, e + 1, e + 2, e + 1, e + 3, e + 2); // the drop at the end
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const ramp = new THREE.Mesh(geo, hazardMat);
    ramp.castShadow = ramp.receiveShadow = true;
    group.add(ramp);
  }

  // --- gaps: a walled pit with something nasty glowing at the bottom
  if (track.gaps.length) {
    const rockMat = keep(new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 1, side: THREE.DoubleSide }));
    const glowMat = keep(new THREE.MeshBasicMaterial({ color: look.pit || '#ff4a12', side: THREE.DoubleSide }));
    const w = track.half + 1.3;
    const pitPiece = (i) => !(inGap[i] || inGap[mod(i - 1, N)] || inGap[mod(i + 1, N)]);
    for (const side of [-1, 1]) {
      group.add(new THREE.Mesh(keep(ribbon(S, side * w, side * w, 0, 1 / 6, pitPiece, -PIT)), rockMat));
      const a = side * w;
      const b = side * (w + 9.5);
      const apron = new THREE.Mesh(keep(ribbon(S, Math.min(a, b), Math.max(a, b), -0.02, 1 / 6, (i) => !nearGap[i])), hazardMat);
      apron.receiveShadow = true;
      group.add(apron);
    }
    group.add(new THREE.Mesh(keep(ribbon(S, -w, w, -PIT, 1 / 6, pitPiece)), glowMat));
    // End walls where the road stops and starts again.
    for (let i = 0; i < N; i++) {
      const before = inGap[mod(i - 1, N)];
      if (inGap[i] === before) continue;
      for (const s of inGap[i] ? [S[mod(i - 1, N)]] : [S[mod(i + 1, N)]]) {
        const pos = [];
        for (const [side, dy] of [[-1, 0.1], [1, 0.1], [-1, -PIT], [1, -PIT]]) pos.push(s.x + s.rx * side * w, s.y + dy, s.z + s.rz * side * w);
        const geo = keep(new THREE.BufferGeometry());
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex([0, 2, 1, 1, 2, 3]);
        geo.computeVertexNormals();
        group.add(new THREE.Mesh(geo, rockMat));
      }
    }
  }

  // --- road
  const roadTex = keep(
    canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = look.road;
      g.fillRect(0, 0, w, h);
      speckle(g, w, h, ['#000000', '#ffffff', look.road], 3500, 2, rand, 0.16);
      g.fillStyle = look.line;
      g.fillRect(8, 0, 7, h);
      g.fillRect(w - 15, 0, 7, h);
      g.globalAlpha = 0.85;
      g.fillRect(w / 2 - 3, 0, 6, h * 0.5);
      g.globalAlpha = 1;
    }),
  );
  const roadMat = keep(
    new THREE.MeshStandardMaterial({
      map: roadTex, roughness: look.night ? 0.45 : 0.85, metalness: look.night ? 0.3 : 0,
      emissive: look.night ? new THREE.Color(look.line) : new THREE.Color(0), emissiveMap: look.night ? roadTex : null, emissiveIntensity: look.night ? 0.12 : 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  );
  const road = new THREE.Mesh(keep(ribbon(track.samples, -track.half, track.half, 0.02, 1 / 12, (i) => inGap[i])), roadMat);
  road.receiveShadow = true;
  group.add(road);

  const kerbTex = keep(
    canvasTexture(32, 64, (g, w, h) => {
      g.fillStyle = look.kerb[0];
      g.fillRect(0, 0, w, h / 2);
      g.fillStyle = look.kerb[1];
      g.fillRect(0, h / 2, w, h / 2);
    }),
  );
  const kerbMat = keep(
    new THREE.MeshStandardMaterial({
      map: kerbTex, roughness: 0.7, emissiveMap: look.night ? kerbTex : null, emissive: new THREE.Color(look.night ? '#ffffff' : '#000000'), emissiveIntensity: look.night ? 0.9 : 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }),
  );
  for (const side of [-1, 1]) {
    const a = side * track.half;
    const b = side * (track.half + 1.3);
    const kerb = new THREE.Mesh(keep(ribbon(track.samples, Math.min(a, b), Math.max(a, b), 0.03, 1 / 4, (i) => inGap[i])), kerbMat);
    kerb.receiveShadow = true;
    group.add(kerb);
  }

  // --- start line
  const g0 = track.gates[0];
  const startTex = keep(
    canvasTexture(128, 32, (g, w, h) => {
      for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) {
        g.fillStyle = (x + y) % 2 ? '#111' : '#fff';
        g.fillRect(x * 16, y * 16, 16, 16);
      }
    }),
  );
  startTex.repeat.set(Math.round(track.width / 8), 1);
  const startLine = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(track.width, 2.4)),
    keep(new THREE.MeshStandardMaterial({ map: startTex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })),
  );
  startLine.rotation.order = 'YXZ';
  startLine.rotation.y = Math.atan2(g0.tx, g0.tz);
  startLine.rotation.x = -Math.PI / 2;
  startLine.position.set(g0.x, g0.y + 0.04, g0.z);
  startLine.receiveShadow = true;
  group.add(startLine);

  // --- checkpoint arches
  const postGeo = keep(new THREE.CylinderGeometry(0.35, 0.45, 7, 10));
  const beamGeo = keep(new THREE.BoxGeometry(1, 1.5, 0.5));
  const sheetGeo = keep(new THREE.PlaneGeometry(1, 6));
  const postMat = keep(new THREE.MeshStandardMaterial({ color: '#2a2f3a', metalness: 0.6, roughness: 0.4 }));
  const gates = track.gates.map((g, i) => {
    const arch = new THREE.Group();
    const span = track.width + 5;
    arch.position.set(g.x, g.y, g.z);
    arch.rotation.y = Math.atan2(g.tx, g.tz);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set((side * span) / 2, 3.5, 0);
      post.castShadow = true;
      arch.add(post);
    }
    const tex = keep(bannerTexture(i === 0 ? 'START' : `CHECKPOINT ${i}`, '#10131c', '#ffffff'));
    const bannerMat = keep(new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.35, roughness: 0.6 }));
    const beam = new THREE.Mesh(beamGeo, bannerMat);
    beam.scale.x = span + 0.9;
    beam.position.y = 7.2;
    beam.castShadow = true;
    arch.add(beam);
    const glowMat = keep(new THREE.MeshBasicMaterial({ color: '#35ff9a', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    const sheet = new THREE.Mesh(sheetGeo, glowMat);
    sheet.scale.x = span - 0.8;
    sheet.position.y = 3.4;
    arch.add(sheet);
    const stripMat = keep(new THREE.MeshBasicMaterial({ color: '#35ff9a' }));
    const strip = new THREE.Mesh(beamGeo, stripMat);
    strip.scale.set(span + 1, 0.16, 1.15);
    strip.position.y = 6.3;
    arch.add(strip);
    group.add(arch);
    return { glowMat, stripMat };
  });
  let nextGate = 0;
  const COL_NEXT = new THREE.Color('#35ff9a');
  const COL_IDLE = new THREE.Color('#566074');
  const setNextGate = (i) => {
    nextGate = i;
    gates.forEach((g, k) => g.stripMat.color.copy(k === i ? COL_NEXT : COL_IDLE));
  };
  setNextGate(0);

  // --- boost pads
  const padTex = keep(
    canvasTexture(64, 64, (g, w, h) => {
      g.fillStyle = '#10131c';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffd23b';
      g.lineWidth = 9;
      g.lineJoin = 'round';
      for (const y of [50, 26]) {
        g.beginPath();
        g.moveTo(10, y);
        g.lineTo(32, y - 20);
        g.lineTo(54, y);
        g.stroke();
      }
    }),
  );
  const padMat = keep(new THREE.MeshBasicMaterial({ map: padTex, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }));
  const padGeo = keep(new THREE.PlaneGeometry(4.4, 6));
  for (const p of track.pads) {
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.rotation.order = 'YXZ';
    pad.rotation.y = p.heading + Math.PI;
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(p.x, p.y + 0.07, p.z);
    group.add(pad);
  }

  // --- things on the road: cones, tyre stacks and oil
  const coneGeo = keep(new THREE.ConeGeometry(0.24, 0.66, 18));
  const coneBaseGeo = keep(new THREE.BoxGeometry(0.56, 0.05, 0.56));
  const coneBandGeo = keep(new THREE.CylinderGeometry(0.115, 0.165, 0.14, 18));
  const tyreGeo = keep(new THREE.TorusGeometry(0.6, 0.28, 12, 28).rotateX(Math.PI / 2));
  const oilGeo = keep(new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2));
  const coneMat = keep(new THREE.MeshStandardMaterial({ color: '#ff6a1a', roughness: 0.55, emissive: look.night ? '#ff6a1a' : '#000000', emissiveIntensity: 0.35 }));
  const bandMat = keep(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, emissive: look.night ? '#ffffff' : '#000000', emissiveIntensity: 0.5 }));
  const tyreMat = keep(new THREE.MeshStandardMaterial({ color: '#17181c', roughness: 0.9 }));
  const tyrePaint = keep(new THREE.MeshStandardMaterial({ color: look.kerb[0], roughness: 0.6 }));
  const oilMat = keep(new THREE.MeshStandardMaterial({ color: '#05060a', roughness: 0.04, metalness: 1, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
  const cones = [];
  track.obstacles.forEach((o, i) => {
    const g = new THREE.Group();
    g.position.set(o.x, o.y, o.z);
    if (o.type === 'cone') {
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.y = 0.38;
      const band = new THREE.Mesh(coneBandGeo, bandMat);
      band.position.y = 0.4;
      const base = new THREE.Mesh(coneBaseGeo, coneMat);
      base.position.y = 0.03;
      cone.castShadow = base.castShadow = true;
      g.add(cone, band, base);
      g.scale.setScalar(1.5);
      cones.push({ i, g, x: o.x, y: o.y, z: o.z, flying: false, v: new THREE.Vector3(), spin: new THREE.Vector3() });
    } else if (o.type === 'tyres') {
      for (let k = 0; k < 3; k++) {
        const t = new THREE.Mesh(tyreGeo, k === 1 ? tyrePaint : tyreMat);
        t.position.y = 0.28 + k * 0.54;
        t.castShadow = true;
        g.add(t);
      }
    } else {
      const oil = new THREE.Mesh(oilGeo, oilMat);
      oil.scale.set(o.r * 1.1, 1, o.r * 0.85);
      oil.rotation.y = rand() * Math.PI;
      oil.position.y = 0.045;
      g.add(oil);
    }
    group.add(g);
  });
  let lastTime = 0;

  // --- scenery
  const obstacles = [];
  const spots = [];
  const wanted = Math.round(quality.scenery * Math.min(1.6, (reach * reach) / 60000));
  for (let tries = 0; tries < wanted * 6 && spots.length < wanted; tries++) {
    const x = B.cx + (rand() * 2 - 1) * reach;
    const z = B.cz + (rand() * 2 - 1) * reach;
    const near = nearest(track, x, z);
    if (near.dist < track.half + 7) continue;
    if (Math.hypot(x - g0.x, z - g0.z) < track.half + 16) continue;
    if (nearGap[near.index] && near.dist < track.half + 13) continue;
    spots.push({ x, z, y: groundY(x, z), s: 0.75 + rand() * 0.7, rot: rand() * Math.PI * 2, dist: near.dist });
  }
  const inst = (geo, mat, list, place, shadow = quality.shadows) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(keep(geo), keep(mat), list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach((s, i) => {
      const p = place(s);
      q.setFromAxisAngle(up, s.rot);
      m.compose(new THREE.Vector3(s.x, p.y + (s.y || 0), s.z), q, new THREE.Vector3(p.sx, p.sy, p.sx));
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = shadow;
    group.add(mesh);
  };
  const solid = (list, r) => list.forEach((s) => s.dist < 60 && obstacles.push({ x: s.x, z: s.z, y: s.y, r: r * s.s }));
  const kind = look.scenery;
  if (kind === 'trees' || kind === 'pines') {
    const pine = kind === 'pines';
    const trunk = new THREE.MeshStandardMaterial({ color: '#6b4a2e', roughness: 1 });
    inst(new THREE.CylinderGeometry(0.35, 0.5, 3, 7), trunk, spots, (s) => ({ y: 1.5 * s.s, sx: s.s, sy: s.s }));
    const leaf = new THREE.MeshStandardMaterial({ color: pine ? '#2f6b4f' : '#3f9a3f', roughness: 0.9, flatShading: true });
    if (pine) {
      inst(new THREE.ConeGeometry(2.4, 5, 8), leaf, spots, (s) => ({ y: 5 * s.s, sx: s.s, sy: s.s }));
      inst(new THREE.ConeGeometry(1.7, 3.6, 8), new THREE.MeshStandardMaterial({ color: '#f4f9ff', roughness: 0.8, flatShading: true }), spots, (s) => ({ y: 7.4 * s.s, sx: s.s, sy: s.s }));
    } else {
      inst(new THREE.IcosahedronGeometry(2.6, 1), leaf, spots, (s) => ({ y: 5 * s.s, sx: s.s, sy: s.s * 1.1 }));
      inst(new THREE.IcosahedronGeometry(1.8, 1), new THREE.MeshStandardMaterial({ color: '#58b84c', roughness: 0.9, flatShading: true }), spots, (s) => ({ y: 7 * s.s, sx: s.s, sy: s.s }));
    }
    solid(spots, 0.6);
  } else if (kind === 'cacti') {
    const cactus = spots.filter((_, i) => i % 3 !== 0);
    const rocks = spots.filter((_, i) => i % 3 === 0);
    const green = new THREE.MeshStandardMaterial({ color: '#4f9a54', roughness: 0.9 });
    inst(new THREE.CapsuleGeometry(0.55, 3.6, 4, 8), green, cactus, (s) => ({ y: 2.3 * s.s, sx: s.s, sy: s.s }));
    inst(new THREE.CapsuleGeometry(0.35, 1.2, 4, 8).translate(1.1, 0.3, 0), green, cactus, (s) => ({ y: 2.6 * s.s, sx: s.s, sy: s.s }));
    inst(new THREE.DodecahedronGeometry(1.8, 0), new THREE.MeshStandardMaterial({ color: '#b07a4a', roughness: 1, flatShading: true }), rocks, (s) => ({ y: 0.7 * s.s, sx: s.s * 1.2, sy: s.s * 0.8 }));
    solid(cactus, 0.6);
    solid(rocks, 1.9);
  } else {
    // Neon city: glowing towers with a lit cap.
    const colors = ['#ff2bd6', '#00f0ff', '#7a5cff', '#ffd23b'];
    colors.forEach((c, ci) => {
      const list = spots.filter((_, i) => i % colors.length === ci).map((s) => ({ ...s, h: 6 + ((s.s * 977) % 1) * 30 + (s.dist > 60 ? 20 : 0) }));
      inst(new THREE.BoxGeometry(5, 1, 5), new THREE.MeshStandardMaterial({ color: '#141026', roughness: 0.35, metalness: 0.6 }), list, (s) => ({ y: s.h / 2, sx: s.s, sy: s.h }));
      inst(new THREE.BoxGeometry(5.2, 0.5, 5.2), new THREE.MeshBasicMaterial({ color: c }), list, (s) => ({ y: s.h, sx: s.s, sy: 1 }));
      inst(new THREE.BoxGeometry(5.15, 0.25, 5.15), new THREE.MeshBasicMaterial({ color: c }), list, (s) => ({ y: s.h * 0.5, sx: s.s, sy: 1 }));
      solid(list, 3.2);
    });
  }

  // Distant mountains ring the map.
  const peaks = [];
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rand() * 0.1;
    const r = reach + 260 + rand() * 260;
    peaks.push({ x: B.cx + Math.cos(a) * r, z: B.cz + Math.sin(a) * r, s: 1, rot: rand() * 6, h: 70 + rand() * 150, w: 110 + rand() * 120 });
  }
  inst(new THREE.ConeGeometry(1, 1, 6, 1), new THREE.MeshStandardMaterial({ color: look.mountain, roughness: 1, flatShading: true }), peaks, (s) => ({ y: s.h / 2 - 2, sx: s.w, sy: s.h }), false);

  scene.add(group);

  return {
    group,
    look,
    obstacles,
    setNextGate,
    /** Keeps the sun's shadow box and the sky centred on the camera's subject. */
    update(time, focus) {
      sun.position.copy(focus).addScaledVector(sunDir, 120);
      sun.target.position.copy(focus);
      sky.position.set(focus.x, 0, focus.z);
      const pulse = 0.09 + 0.05 * Math.sin(time * 5);
      gates.forEach((g, k) => (g.glowMat.opacity = k === nextGate ? pulse : 0));
      // Knocked cones tumble away, then stand back up when the track resets them.
      const dt = Math.min(0.05, Math.max(0, time - lastTime));
      lastTime = time;
      for (const c of cones) {
        const down = track.coneDown[c.i] > 0;
        if (down && !c.flying) {
          c.flying = true;
          c.v.set((focus.x - c.x) * -0.25 + (Math.random() - 0.5) * 4, 6 + Math.random() * 2, (focus.z - c.z) * -0.25 + (Math.random() - 0.5) * 4).clampLength(0, 12);
          c.spin.set(Math.random() * 10 - 5, Math.random() * 6 - 3, Math.random() * 10 - 5);
        } else if (!down && c.flying) {
          c.flying = false;
          c.g.position.set(c.x, c.y, c.z);
          c.g.rotation.set(0, 0, 0);
        }
        if (c.flying && (c.g.position.y > c.y + 0.1 || c.v.y > 0)) {
          c.v.y -= 22 * dt;
          c.g.position.addScaledVector(c.v, dt);
          c.g.rotation.x += c.spin.x * dt;
          c.g.rotation.y += c.spin.y * dt;
          c.g.rotation.z += c.spin.z * dt;
          if (c.g.position.y <= c.y + 0.1) {
            c.g.position.y = c.y + 0.1;
            c.g.rotation.set(Math.PI / 2, c.g.rotation.y, 0);
          }
        }
      }
    },
    dispose() {
      scene.remove(group);
      scene.fog = null;
      for (const d of disposables) d.dispose?.();
      group.traverse((o) => {
        if (o.isInstancedMesh) o.dispose();
      });
    },
  };
}
