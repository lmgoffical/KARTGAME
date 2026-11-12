// The kart and driver model, plus the particle effects (smoke, dust, sparks).
// Everything is built from code: rounded bodywork with clear-coated paint, a
// tube frame, spoked wheels and a driver with a helmet, arms on the wheel and
// legs on the pedals.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// Shapes and the materials every kart has in common are made once and reused.
const shapes = new Map();
const shape = (key, make) => {
  if (!shapes.has(key)) shapes.set(key, make());
  return shapes.get(key);
};
const rbox = (w, h, d, r = 0.05) => shape(`box${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, 4, r));
const ball = (r) => shape(`ball${r}`, () => new THREE.SphereGeometry(r, 24, 16));
const disc = (r, h, seg = 20) => shape(`disc${r},${h},${seg}`, () => new THREE.CylinderGeometry(r, r, h, seg));
const ROD = () => shape('rod', () => new THREE.CylinderGeometry(1, 1, 1, 12));

// Reflections come from a studio-style environment that only the karts use,
// so the paint and chrome shine without washing out the rest of the scene.
let environment = null;
export function setKartEnvironment(texture) {
  environment = texture;
}
const lit = (material, strength) => {
  material.envMap = environment;
  material.envMapIntensity = strength;
  return material;
};

let common = null;
function commonMaterials() {
  if (common) return common;
  const std = (o) => lit(new THREE.MeshStandardMaterial(o), o.metalness >= 0.8 ? 1 : 0.25);
  common = {
    rubber: std({ color: '#141518', roughness: 0.92 }),
    rim: std({ color: '#dfe3ea', metalness: 1, roughness: 0.22 }),
    frame: std({ color: '#2b2f38', metalness: 0.85, roughness: 0.35 }),
    carbon: lit(new THREE.MeshPhysicalMaterial({ color: '#16181d', roughness: 0.45, metalness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.3 }), 0.6),
    chrome: std({ color: '#f1f3f7', metalness: 1, roughness: 0.12 }),
    engine: std({ color: '#8d94a3', metalness: 0.9, roughness: 0.4 }),
    seat: std({ color: '#1d1f25', roughness: 0.8 }),
    white: std({ color: '#f5f6fa', roughness: 0.55 }),
    dark: std({ color: '#191b20', roughness: 0.7 }),
    visor: lit(new THREE.MeshPhysicalMaterial({ color: '#0a1020', metalness: 1, roughness: 0.06, clearcoat: 1 }), 1.2),
    lamp: new THREE.MeshBasicMaterial({ color: '#fff6d8' }),
  };
  return common;
}

function put(parent, geometry, material, x, y, z, shadow = true) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  parent.add(m);
  return m;
}

const UP = new THREE.Vector3(0, 1, 0);
/** A round bar from point a to point b: frame tubes, limbs, axles. */
function rod(parent, a, b, radius, material, shadow = true) {
  const va = new THREE.Vector3(...a);
  const dir = new THREE.Vector3(...b).sub(va);
  const len = dir.length();
  const m = new THREE.Mesh(ROD(), material);
  m.position.copy(va).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  m.scale.set(radius, len, radius);
  m.castShadow = shadow;
  parent.add(m);
  return m;
}

function tyreShape(R, w) {
  return shape(`tyre${R},${w}`, () => {
    const e = 0.045;
    const pts = [[R * 0.56, -w / 2], [R - e, -w / 2], [R - e * 0.3, -w / 2 + e * 0.3], [R, -w / 2 + e], [R, w / 2 - e], [R - e * 0.3, w / 2 - e * 0.3], [R - e, w / 2], [R * 0.56, w / 2]];
    return new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 28).rotateZ(Math.PI / 2);
  });
}

function numberPlate(number) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f5f6fa';
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#12141a';
  g.font = 'italic 900 84px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(number), 60, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Builds a kart facing +z. Returns the group and the parts that animate. */
export function createKartModel(color, number = 1) {
  const C = commonMaterials();
  const paint = lit(new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.06 }), 0.5);
  const suit = lit(new THREE.MeshStandardMaterial({ color, roughness: 0.78 }), 0.15);
  const tail = new THREE.MeshStandardMaterial({ color: '#3a0508', emissive: '#ff1a1a', emissiveIntensity: 0.8, roughness: 0.4 });
  const glow = new THREE.MeshBasicMaterial({ color: '#ff7a1f' });
  const plateTex = numberPlate(number);
  const plate = new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.5, transparent: true });
  const own = [paint, suit, tail, glow, plate, plateTex];

  const root = new THREE.Group();
  const body = new THREE.Group(); // leans and slides without moving the wheels' ground contact
  root.add(body);

  // --- chassis
  put(body, rbox(0.9, 0.05, 1.95, 0.02), C.carbon, 0, 0.17, 0.05);
  for (const s of [-1, 1]) {
    rod(body, [s * 0.42, 0.2, -1.05], [s * 0.42, 0.2, 1.0], 0.035, C.frame);
    rod(body, [s * 0.42, 0.2, 1.0], [s * 0.24, 0.2, 1.26], 0.035, C.frame, false);
    rod(body, [s * 0.42, 0.22, 0.95], [s * 0.7, 0.26, 0.95], 0.03, C.chrome, false); // front stub axle
    put(body, rbox(0.26, 0.2, 1.0, 0.09), paint, s * 0.66, 0.31, 0.05); // side pod
    put(body, rbox(0.1, 0.02, 0.78, 0.008), C.white, s * 0.66, 0.412, 0.05, false);
    put(body, rbox(0.05, 0.16, 0.34, 0.02), C.carbon, s * 0.68, 0.24, 1.42, false); // wing end plate
    put(body, ball(0.055), C.lamp, s * 0.22, 0.36, 1.43, false).scale.set(1.3, 0.8, 0.5); // headlight
  }
  put(body, rbox(0.7, 0.22, 0.5, 0.1), paint, 0, 0.33, 1.18); // nose
  put(body, rbox(1.36, 0.05, 0.3, 0.022), paint, 0, 0.19, 1.42); // front wing
  const panel = put(body, rbox(0.4, 0.32, 0.07, 0.03), paint, 0, 0.7, 0.6); // number panel
  panel.rotation.x = -0.5;
  const badge = put(body, shape('badge', () => new THREE.CircleGeometry(0.12, 24)), plate, 0, 0.72, 0.645, false);
  badge.rotation.x = -0.5;
  put(body, ball(0.15), C.dark, 0, 0.34, 0.3, false).scale.set(1, 0.7, 1.5); // fuel tank

  // --- seat
  put(body, rbox(0.5, 0.1, 0.46, 0.045), C.seat, 0, 0.3, -0.3);
  put(body, rbox(0.5, 0.6, 0.1, 0.045), C.seat, 0, 0.58, -0.6).rotation.x = -0.22;
  for (const s of [-1, 1]) put(body, rbox(0.06, 0.22, 0.4, 0.028), C.seat, s * 0.27, 0.4, -0.32, false);

  // --- engine, axle, exhaust
  put(body, rbox(0.3, 0.26, 0.36, 0.04), C.engine, 0.36, 0.36, -0.74);
  for (let i = 0; i < 4; i++) put(body, rbox(0.28, 0.018, 0.3, 0.008), C.engine, 0.36, 0.52 + i * 0.035, -0.74, false);
  put(body, disc(0.085, 0.2), paint, 0.36, 0.5, -0.47, false).rotation.x = Math.PI / 2; // air filter
  put(body, rbox(0.06, 0.22, 0.3, 0.02), C.carbon, -0.4, 0.33, -0.8, false); // chain guard
  rod(body, [-0.78, 0.29, -0.85], [0.78, 0.29, -0.85], 0.03, C.chrome, false);
  const exhausts = [];
  for (const s of [-1, 1]) {
    rod(body, [s * 0.2, 0.44, -0.9], [s * 0.22, 0.42, -1.34], 0.042, C.chrome, false);
    rod(body, [s * 0.22, 0.42, -1.3], [s * 0.22, 0.42, -1.4], 0.055, C.chrome, false);
    const flame = new THREE.Mesh(shape('flame', () => new THREE.ConeGeometry(0.13, 0.9, 10).rotateX(-Math.PI / 2)), glow);
    flame.position.set(s * 0.22, 0.42, -1.85);
    flame.visible = false;
    body.add(flame);
    exhausts.push(flame);
  }

  // --- rear bumper, lights and wing
  rod(body, [-0.62, 0.28, -1.24], [0.62, 0.28, -1.24], 0.04, C.frame);
  for (const s of [-1, 1]) {
    rod(body, [s * 0.42, 0.2, -1.05], [s * 0.5, 0.28, -1.24], 0.03, C.frame, false);
    rod(body, [s * 0.3, 0.3, -1.05], [s * 0.3, 0.86, -1.12], 0.025, C.frame, false);
    put(body, rbox(0.04, 0.3, 0.36, 0.015), C.carbon, s * 0.56, 0.8, -1.13);
  }
  put(body, rbox(0.56, 0.07, 0.05, 0.02), tail, 0, 0.37, -1.23, false);
  put(body, rbox(1.1, 0.05, 0.3, 0.022), paint, 0, 0.88, -1.13).rotation.x = -0.12;

  // --- steering
  rod(body, [0, 0.36, 0.72], [0, 0.82, 0.3], 0.022, C.frame, false);
  const steerTilt = new THREE.Group();
  steerTilt.position.set(0, 0.84, 0.28);
  steerTilt.rotation.x = 0.78;
  const steer = new THREE.Group(); // turns with the steering input
  steerTilt.add(steer);
  body.add(steerTilt);
  put(steer, shape('wheelRim', () => new THREE.TorusGeometry(0.16, 0.024, 8, 24)), C.dark, 0, 0, 0, false);
  for (const a of [Math.PI / 2, Math.PI * 1.17, Math.PI * 1.83]) {
    rod(steer, [0, 0, 0], [Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0], 0.014, C.frame, false);
  }
  put(steer, disc(0.04, 0.03, 12), paint, 0, 0, 0, false).rotation.x = Math.PI / 2;

  // --- driver (leans into corners)
  const driver = new THREE.Group();
  body.add(driver);
  put(driver, ball(0.2), suit, 0, 0.42, -0.32).scale.set(1.15, 0.8, 1);
  const torso = put(driver, shape('torso', () => new THREE.CapsuleGeometry(0.2, 0.3, 6, 14)), suit, 0, 0.72, -0.4);
  torso.rotation.x = -0.18;
  torso.scale.set(1.18, 1, 0.9);
  put(driver, rbox(0.08, 0.34, 0.02, 0.008), C.white, 0, 0.74, -0.215, false).rotation.x = -0.18;
  put(driver, disc(0.07, 0.1, 12), C.dark, 0, 1.02, -0.44, false);
  for (const s of [-1, 1]) {
    const shoulder = [s * 0.27, 0.88, -0.4];
    const elbow = [s * 0.35, 0.66, -0.06];
    const hand = [s * 0.15, 0.85, 0.24];
    put(driver, ball(0.09), C.white, ...shoulder, false);
    rod(driver, shoulder, elbow, 0.065, suit);
    put(driver, ball(0.066), suit, ...elbow, false);
    rod(driver, elbow, hand, 0.055, suit);
    put(driver, ball(0.068), C.dark, ...hand, false);
    const hip = [s * 0.13, 0.4, -0.2];
    const knee = [s * 0.25, 0.52, 0.3];
    const ankle = [s * 0.22, 0.27, 0.72];
    rod(driver, hip, knee, 0.085, suit);
    put(driver, ball(0.086), C.white, ...knee, false);
    rod(driver, knee, ankle, 0.07, suit);
    put(driver, rbox(0.11, 0.1, 0.24, 0.04), C.dark, s * 0.22, 0.25, 0.8, false);
  }
  const head = new THREE.Group();
  head.position.set(0, 1.22, -0.44);
  head.scale.set(1, 1.02, 1.12);
  put(head, ball(0.23), paint, 0, 0, 0);
  // The visor wraps the front of the helmet: a slice of a slightly larger sphere.
  put(head, shape('visor', () => new THREE.SphereGeometry(0.236, 24, 10, Math.PI * 0.13, Math.PI * 0.74, Math.PI * 0.3, Math.PI * 0.24)), C.visor, 0, 0, 0, false);
  put(head, shape('stripe', () => new THREE.TorusGeometry(0.232, 0.02, 6, 24, Math.PI).rotateY(Math.PI / 2)), C.white, 0, 0, 0, false);
  put(head, rbox(0.2, 0.05, 0.06, 0.02), C.dark, 0, -0.13, 0.19, false);
  put(head, rbox(0.03, 0.07, 0.18, 0.012), C.dark, 0, 0.21, -0.12, false);
  driver.add(head);

  // --- wheels
  const wheels = [];
  const fronts = [];
  for (const [x, z, front] of [[-0.74, 0.95, true], [0.74, 0.95, true], [-0.78, -0.85, false], [0.78, -0.85, false]]) {
    const R = front ? 0.26 : 0.3;
    const w = front ? 0.22 : 0.34;
    const side = Math.sign(x);
    const pivot = new THREE.Group();
    pivot.position.set(x, R, z);
    const spin = new THREE.Group();
    spin.userData.radius = R;
    put(spin, tyreShape(R, w), C.rubber, 0, 0, 0);
    put(spin, disc(R * 0.57, w * 0.86, 24), C.rim, 0, 0, 0, false).rotation.z = Math.PI / 2;
    for (let i = 0; i < 5; i++) {
      const spoke = put(spin, rbox(0.03, R * 1.08, 0.05, 0.012), C.chrome, side * w * 0.45, 0, 0, false);
      spoke.rotation.x = (i / 5) * Math.PI;
    }
    put(spin, disc(0.06, 0.05, 12), paint, side * w * 0.47, 0, 0, false).rotation.z = Math.PI / 2;
    pivot.add(spin);
    root.add(pivot);
    wheels.push(spin);
    if (front) fronts.push(pivot);
  }

  return {
    root,
    body,
    head,
    driver,
    steer,
    tail,
    wheels,
    fronts,
    exhausts,
    lean: 0,
    yaw: 0,
    dispose() {
      for (const o of own) o.dispose();
    },
  };
}

/** Moves a model to match a kart's physics state, with lean, wheel spin and flames. */
export function poseKartModel(model, k, dt, time) {
  model.root.position.set(k.x, k.y, k.z);
  model.root.rotation.order = 'YXZ';
  model.root.rotation.y = k.heading;
  // Nose follows the slope on the ground and the arc of a jump in the air.
  const pitch = k.air ? Math.atan2(k.vy, Math.abs(k.speed) + 6) * 0.7 : Math.atan(k.slope);
  model.pitch = (model.pitch || 0) + (pitch - (model.pitch || 0)) * Math.min(1, 10 * dt);
  model.root.rotation.x = -model.pitch;
  const targetYaw = k.drifting ? k.driftDir * 0.42 : 0;
  model.yaw += (targetYaw - model.yaw) * Math.min(1, 8 * dt);
  const targetLean = -k.steer * Math.min(1, Math.abs(k.speed) / 20) * 0.09 - model.yaw * 0.12;
  model.lean += (targetLean - model.lean) * Math.min(1, 8 * dt);
  model.body.rotation.set(k.boost > 0 ? -0.04 : 0, model.yaw, model.lean);
  model.body.scale.y = 1 - k.landed * 0.18; // squash on landing
  model.body.position.y = k.air ? 0 : Math.abs(k.speed) > 1 ? Math.sin(time * 38 + k.x) * 0.008 * (k.onRoad ? 1 : 5) : 0;
  model.head.rotation.y = k.steer * 0.35;
  model.driver.rotation.z = model.lean * 1.6;
  model.steer.rotation.z = k.steer * 1.1;
  model.tail.emissiveIntensity = k.braking ? 4 : 0.8;
  for (const w of model.wheels) w.rotation.x += (k.speed / w.userData.radius) * dt;
  for (const f of model.fronts) f.rotation.y = k.steer * 0.45 + model.yaw;
  const flame = k.boost > 0;
  for (const e of model.exhausts) {
    e.visible = flame;
    if (flame) e.scale.set(1, 1, 0.7 + Math.random() * 0.7);
  }
}

// ------------------------------------------------------------------ particles

const MAX = 700;

export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 4);
    this.size = new Float32Array(MAX);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX).fill(1);
    this.grow = new Float32Array(MAX);
    this.gravity = new Float32Array(MAX);
    this.floor = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { scale: { value: 600 } },
      vertexShader:
        'attribute float size; attribute vec4 color; varying vec4 vColor; uniform float scale; void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader:
        'varying vec4 vColor; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.15, d) * vColor.a; if (a < 0.01) discard; gl_FragColor = vec4(vColor.rgb, a); }',
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.scene = scene;
  }

  emit(x, y, z, vx, vy, vz, r, g, b, alpha, size, life, grow = 0, gravity = 0) {
    const i = this.cursor;
    this.cursor = (i + 1) % MAX;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([r, g, b, alpha], i * 4);
    this.alpha[i] = alpha;
    this.size[i] = size;
    this.life[i] = this.maxLife[i] = life;
    this.grow[i] = grow;
    this.gravity[i] = gravity;
    this.floor[i] = y - 0.15;
  }

  update(dt) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      this.vel[i * 3 + 1] -= this.gravity[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(this.floor[i], this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.col[i * 4 + 3] = this.alpha[i] * (this.life[i] / this.maxLife[i]);
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.color.needsUpdate = a.size.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

const DUST = { meadow: [0.45, 0.62, 0.32], desert: [0.85, 0.7, 0.45], snow: [0.95, 0.97, 1], neon: [0.5, 0.4, 0.9] };

/** Spawns the right effects behind a kart for what it is doing this frame. */
export function kartEffects(fx, k, theme, dt) {
  const speed = Math.abs(k.speed);
  if (speed < 3 || k.air) return;
  const y = k.y;
  const fx_ = Math.sin(k.heading);
  const fz_ = Math.cos(k.heading);
  const rear = (side) => [k.x - fx_ * 0.9 - fz_ * side * -0.76, k.z - fz_ * 0.9 + fx_ * side * -0.76];
  const chance = (rate) => Math.random() < rate * dt;
  if (k.drifting) {
    const level = k.driftCharge > 2.1 ? 2 : k.driftCharge > 0.9 ? 1 : 0;
    const c = level === 2 ? [1, 0.45, 0.1] : level === 1 ? [0.3, 0.75, 1] : [1, 1, 0.75];
    for (const side of [-1, 1]) {
      if (!chance(55)) continue;
      const [x, z] = rear(side);
      fx.emit(x, y + 0.12, z, -k.vx * 0.15 + (Math.random() - 0.5) * 4, 1.5 + Math.random() * 3, -k.vz * 0.15 + (Math.random() - 0.5) * 4, c[0], c[1], c[2], 1, 0.22, 0.3, 0, 12);
      if (chance(30)) fx.emit(x, y + 0.2, z, (Math.random() - 0.5) * 2, 0.8, (Math.random() - 0.5) * 2, 0.9, 0.9, 0.92, 0.28, 0.8, 0.55, 3);
    }
  }
  if (!k.onRoad && chance(50)) {
    const [x, z] = rear(Math.random() < 0.5 ? -1 : 1);
    const c = DUST[theme] || DUST.meadow;
    fx.emit(x, y + 0.2, z, (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3, c[0], c[1], c[2], 0.55, 0.9, 0.7, 3.5);
  }
  if (k.boost > 0 && chance(70)) {
    const side = Math.random() < 0.5 ? -1 : 1;
    fx.emit(k.x - fx_ * 1.6 + fz_ * side * 0.22, 0.5, k.z - fz_ * 1.6 - fx_ * side * 0.22, -fx_ * 6, Math.random(), -fz_ * 6, 1, 0.5 + Math.random() * 0.4, 0.15, 0.9, 0.5, 0.25, -1);
  }
}
