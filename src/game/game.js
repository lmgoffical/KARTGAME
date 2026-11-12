// The running race: owns the renderer, the world and the karts, steps the
// physics and tells the UI what happened through `onEvent` and `onHud`.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  buildTrack, gridPose, createProgress, updateProgress, currentLap, gatesThisLap, raceScore, nearest, wrapAngle, clamp,
} from './track.js';
import { createKart, stepKart, stepTrack, collideKarts, collideObstacles, createAI, aiInput, respawn, NO_INPUT, TUNING, THEME_GRIP } from './physics.js';
import { buildWorld } from '../render/world.js';
import { storage } from '../storage.js';
import { createKartModel, poseKartModel, Particles, kartEffects, setKartEnvironment } from '../render/kart.js';

export const QUALITY = {
  low: { name: 'low', pixelRatio: 1, shadows: false, shadowSize: 512, bloom: false, scenery: 110 },
  medium: { name: 'medium', pixelRatio: 1.5, shadows: true, shadowSize: 1024, bloom: true, scenery: 200 },
  high: { name: 'high', pixelRatio: 2, shadows: true, shadowSize: 2048, bloom: true, scenery: 320 },
};

function nameTag(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.font = 'italic 800 34px system-ui, sans-serif';
  const w = Math.min(240, g.measureText(text).width + 36);
  g.fillStyle = 'rgba(10,12,20,0.7)';
  g.beginPath();
  g.roundRect((256 - w) / 2, 8, w, 48, 24);
  g.fill();
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 34, 220);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.scale.set(3.4, 0.85, 1);
  sprite.position.y = 2.5;
  return sprite;
}

export class Game {
  constructor(canvas, input, sound) {
    this.canvas = canvas;
    this.input = input;
    this.sound = sound;
    this.onEvent = () => {};
    this.onHud = () => {};
    this.racers = [];
    this.state = 'idle';
    this.paused = false;
    this.time = 0;
    this.clock = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    // Soft studio lighting for the karts to reflect.
    setKartEnvironment(new THREE.PMREMGenerator(this.renderer).fromScene(new RoomEnvironment(), 0.04).texture);
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 2600);
    this.camPos = new THREE.Vector3(0, 30, -30);
    this.camLook = new THREE.Vector3();
    this.camHeading = 0;
    this.focus = new THREE.Vector3();

    const mobile = matchMedia('(pointer: coarse)').matches;
    this.setQuality(storage.get('tk.quality') || (mobile ? 'medium' : 'high'));
    window.addEventListener('resize', () => this.resize());

    this.last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (this.world) this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  setQuality(name) {
    this.quality = { ...(QUALITY[name] || QUALITY.high) };
    storage.set('tk.quality', this.quality.name);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
    this.composer?.dispose();
    this.composer = null;
    if (this.quality.bloom) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(this.renderer, target);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.7, 0.9);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    this.resize();
    if (this.config) this.load(this.config);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Sets up a race. config = {
   *   def, mode: 'race' | 'versus' | 'test' | 'demo',
   *   player: { name, color }, slot,
   *   rivals: [{ id?, name, color, skill?, remote?, slot }]
   * }
   */
  load(config) {
    this.unload();
    this.config = config;
    this.mode = config.mode;
    const track = (this.track = buildTrack(config.def));
    this.grip = THEME_GRIP[track.def.theme] ?? 1;
    this.world = buildWorld(track, this.scene, this.quality);
    this.renderer.toneMappingExposure = this.world.look.exposure;
    if (this.bloom) this.bloom.strength = this.world.look.bloom;
    this.fx = new Particles(this.scene);

    const add = (spec, kind, slot) => {
      const kart = createKart(gridPose(track, slot));
      const model = createKartModel(spec.color, slot + 1);
      if (kind !== 'player') model.root.add(nameTag(spec.name, spec.color));
      this.scene.add(model.root);
      const r = {
        id: spec.id ?? `${kind}${slot}`, name: spec.name, color: spec.color, kind, kart, model, progress: createProgress(),
        ai: createAI(spec.skill ?? 0.9, (slot % 2 ? 1 : -1) * (0.25 + (slot % 3) * 0.2)), slot, net: null, place: slot + 1,
      };
      r.ai.index = nearest(track, kart.x, kart.z).index;
      this.racers.push(r);
      poseKartModel(model, kart, 0, 0);
      return r;
    };
    this.player = null;
    if (config.mode !== 'demo') this.player = add(config.player, 'player', config.slot ?? 0);
    for (const rv of config.rivals || []) add(rv, rv.remote ? 'remote' : 'ai', rv.slot);

    this.state = 'idle';
    this.paused = false;
    this.time = 0;
    this.wrongWay = 0;
    this.goAt = 0;
    this.lastCount = 0;
    this.demoAngle = 0;
    const lead = this.player || this.racers[0];
    this.camHeading = lead.kart.heading;
    this.snapCamera();
    if (config.mode === 'demo') {
      this.state = 'racing';
      this.world.setNextGate(-1);
    }
    this.frame(0);
  }

  unload() {
    for (const r of this.racers) {
      this.scene.remove(r.model.root);
      r.model.root.traverse((o) => {
        if (o.isSprite) {
          o.material.map.dispose();
          o.material.dispose();
        }
      });
      r.model.dispose();
    }
    this.racers = [];
    this.world?.dispose();
    this.world = null;
    this.fx?.dispose();
    this.fx = null;
    this.config = null;
    this.state = 'idle';
  }

  /** Starts the 3-2-1 countdown; the race begins `ms` from now. */
  startCountdown(ms = 3500) {
    this.state = 'countdown';
    this.goAt = performance.now() + ms;
    this.lastCount = 4;
  }

  setPaused(p) {
    if (this.mode === 'versus') return; // an online race can't be frozen
    this.paused = p;
  }

  removeRacer(id) {
    const i = this.racers.findIndex((r) => r.id === id);
    if (i < 0) return;
    const [r] = this.racers.splice(i, 1);
    this.scene.remove(r.model.root);
    r.model.dispose();
  }

  /** Latest position of an online rival: [x, z, heading, vx, vz, steer, flags, charge, gates taken]. */
  remoteState(id, s) {
    const r = this.racers.find((q) => q.id === id);
    if (!r) return;
    r.net = { s, at: performance.now() };
    // Checkpoints the rival has taken, so live places work online too.
    if (!r.progress.finished && s[8] >= 0) {
      r.progress.count = s[8] | 0;
      r.progress.next = r.progress.count % this.track.gates.length;
    }
  }

  remoteFinished(id, time) {
    const r = this.racers.find((q) => q.id === id);
    if (r) Object.assign(r.progress, { finished: true, finishTime: time });
  }

  playerNetState() {
    const k = this.player.kart;
    const flags = (k.drifting ? 1 : 0) | (k.boost > 0 ? 2 : 0) | (k.onRoad ? 4 : 0) | (k.driftDir > 0 ? 8 : 0) | (k.air ? 16 : 0);
    const r2 = (v) => Math.round(v * 100) / 100;
    return [r2(k.x), r2(k.z), r2(k.heading), r2(k.vx), r2(k.vz), r2(k.steer), flags, r2(k.driftCharge), this.player.progress.count, r2(k.y)];
  }

  respawnPlayer() {
    const r = this.player;
    if (!r || this.state !== 'racing' || r.progress.finished) return;
    const index = r.progress.count > 0 ? this.track.gates[r.progress.lastGate].index + 2 : nearest(this.track, gridPose(this.track, r.slot).x, gridPose(this.track, r.slot).z).index;
    respawn(r.kart, this.track, index);
    r.ai.index = index;
    r.progress.missed = false;
    this.wrongWay = 0;
  }

  // ------------------------------------------------------------------ frame

  frame(dt) {
    const now = performance.now();
    if (this.state === 'countdown') {
      const left = (this.goAt - now) / 1000;
      const n = Math.ceil(left);
      if (left <= 0) {
        this.state = 'racing';
        this.time = 0;
        this.onEvent('go');
      } else if (n !== this.lastCount && n <= 3) {
        this.lastCount = n;
        this.onEvent('count', n);
      }
    }
    if (!this.paused && dt > 0) {
      this.clock += dt;
      const steps = Math.max(1, Math.ceil(dt / (1 / 90)));
      for (let i = 0; i < steps; i++) this.step(dt / steps);
      this.animate(dt);
    }
    this.updateCamera(this.paused ? 0 : dt);
    this.world.update(this.clock, this.focus);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.emitHud();
  }

  step(dt) {
    const track = this.track;
    const racing = this.state === 'racing';
    if (racing) this.time += dt;
    const live = [];
    const movable = [];
    for (const r of this.racers) {
      const k = r.kart;
      const x0 = k.x;
      const z0 = k.z;
      if (r.kind === 'remote') {
        this.stepRemote(r, dt);
        live.push(k);
        movable.push(false);
        continue;
      }
      let input = NO_INPUT;
      // `autopilot` lets the automated tests drive a full race.
      const selfDriving = r.kind === 'ai' || r.progress.finished || this.autopilot;
      if (racing && selfDriving) {
        input = aiInput(k, track, r.ai, dt);
        if (r.progress.finished) input.topMul = 0.75;
        else if (r === this.player) input.topMul = 1;
        if (r.ai.stuck > 2.5) {
          respawn(k, track, r.ai.index + 3);
          r.ai.stuck = 0;
        }
      } else if (racing) {
        input = this.input.read();
      }
      const wasBoost = k.boost > 0;
      const wasSlick = k.slick > 0;
      const wasAir = k.air;
      const falls = k.fell;
      stepKart(k, input, dt, track, this.grip);
      collideObstacles(k, this.world.obstacles);
      if (r === this.player) {
        if (k.boost > 0 && !wasBoost) this.onEvent('boost');
        if (k.slick > 0 && !wasSlick) this.onEvent('oil');
        if (k.fell > falls) this.onEvent('fell');
        else if (wasAir && !k.air && k.landed > 0.25) this.onEvent('land');
        else if (!wasAir && k.air && k.vy > 2.5) this.onEvent('jump');
        if (k.hit > 0.5 && !r.bumped) this.onEvent('bump');
        r.bumped = k.hit > 0.3;
      }
      if (racing) {
        const ev = updateProgress(track, r.progress, x0, z0, k.x, k.z, this.time, k.y);
        if (ev && this.mode === 'demo') {
          if (ev === 'finish') r.progress = createProgress();
        } else if (ev && r === this.player) {
          if (ev !== 'missed') this.world.setNextGate(r.progress.next);
          if (ev === 'finish') {
            r.ai.index = nearest(track, k.x, k.z).index;
            this.finishPlace = this.racers.filter((q) => q.progress.finished).length;
          }
          this.onEvent(ev, { time: r.progress.finishTime, laps: r.progress.lapTimes, place: this.finishPlace, lap: currentLap(track, r.progress) });
        }
      }
      live.push(k);
      movable.push(true);
    }
    collideKarts(live, movable);
    stepTrack(track, dt);

    if (racing && this.player && !this.player.progress.finished) {
      const k = this.player.kart;
      const near = nearest(track, k.x, k.z);
      const s = track.samples[near.index];
      const along = k.vx * s.tx + k.vz * s.tz;
      this.wrongWay = along < -4 && near.dist < track.half + 4 ? this.wrongWay + dt : 0;
      this.offTrack = near.dist;
      if (near.dist > 140) this.respawnPlayer();
      if (this.input.take('reset')) this.respawnPlayer();
    }
  }

  stepRemote(r, dt) {
    const k = r.kart;
    if (!r.net) return;
    const s = r.net.s;
    const age = Math.min(0.3, (performance.now() - r.net.at) / 1000);
    const tx = s[0] + s[3] * age;
    const tz = s[1] + s[4] * age;
    const blend = 1 - Math.exp(-14 * dt);
    if (Math.hypot(tx - k.x, tz - k.z) > 25) {
      k.x = tx;
      k.z = tz;
    } else {
      k.x += (tx - k.x) * blend;
      k.z += (tz - k.z) * blend;
    }
    k.heading = wrapAngle(k.heading + wrapAngle(s[2] - k.heading) * blend);
    k.y += ((s[9] || 0) - k.y) * blend;
    k.air = !!(s[6] & 16);
    k.vy = 0;
    k.vx = s[3];
    k.vz = s[4];
    k.speed = s[3] * Math.sin(k.heading) + s[4] * Math.cos(k.heading);
    k.steer = s[5];
    k.drifting = !!(s[6] & 1);
    k.boost = s[6] & 2 ? 0.2 : 0;
    k.onRoad = !!(s[6] & 4);
    k.driftDir = s[6] & 8 ? 1 : -1;
    k.driftCharge = s[7] || 0;
  }

  animate(dt) {
    for (const r of this.racers) {
      poseKartModel(r.model, r.kart, dt, this.clock);
      if (this.quality.name !== 'low' || r === this.player) kartEffects(this.fx, r.kart, this.track.def.theme, dt);
    }
    this.fx.update(dt);
    const k = this.player?.kart;
    if (k) {
      const driving = this.state === 'racing' && !this.paused;
      const skid = k.drifting ? 1 : clamp((Math.abs(k.slip) - 3) / 6, 0, 1);
      const mine = driving && !this.player.progress.finished;
      this.sound.engine(k.speed / TUNING.maxSpeed, mine ? this.input.read().throttle : 0, mine ? skid : 0, this.state !== 'idle' && !this.paused && !this.player.progress.finished);
    } else {
      this.sound.engine(0, 0, 0, false);
    }
  }

  snapCamera() {
    this.updateCamera(0, true);
  }

  updateCamera(dt, snap = false) {
    const lead = this.player || this.racers[0];
    if (!lead) return;
    const k = lead.kart;
    this.focus.set(k.x, k.y, k.z);
    const orbit = this.mode === 'demo' || (this.player && this.player.progress.finished);
    let wantPos;
    let wantLook;
    let wantFov = 62;
    if (orbit) {
      this.demoAngle += dt * 0.25;
      const a = this.demoAngle + k.heading * 0.3;
      const dist = this.mode === 'demo' ? 15 : 10;
      wantPos = new THREE.Vector3(k.x + Math.sin(a) * dist, k.y + (this.mode === 'demo' ? 5.5 : 4), k.z + Math.cos(a) * dist);
      wantLook = new THREE.Vector3(k.x, k.y + 1, k.z);
      wantFov = 55;
    } else {
      // Follow the direction of travel a little, so drifts show the kart side-on.
      const moving = Math.hypot(k.vx, k.vz) > 4 && k.speed > 0;
      const travel = moving ? Math.atan2(k.vx, k.vz) : k.heading;
      const target = k.heading + wrapAngle(travel - k.heading) * 0.55;
      this.camHeading = snap ? target : wrapAngle(this.camHeading + wrapAngle(target - this.camHeading) * Math.min(1, 5.5 * dt));
      const fx = Math.sin(this.camHeading);
      const fz = Math.cos(this.camHeading);
      const speed01 = clamp(Math.abs(k.speed) / TUNING.maxSpeed, 0, 1.4);
      const back = 6.6 + speed01 * 1.6;
      // Sit a little higher going downhill and lower going up, so the road ahead stays in view.
      const tilt = clamp(k.slope, -0.25, 0.25);
      wantPos = new THREE.Vector3(k.x - fx * back, k.y + 3.1 + speed01 * 0.4 - tilt * back, k.z - fz * back);
      wantLook = new THREE.Vector3(k.x + fx * 5, k.y + 1.1 + tilt * 5, k.z + fz * 5);
      wantFov = 62 + speed01 * 9 + (k.boost > 0 ? 9 : 0);
      if (k.boost > 0 && dt > 0) {
        wantPos.x += (Math.random() - 0.5) * 0.08;
        wantPos.y += (Math.random() - 0.5) * 0.08;
      }
    }
    if (snap) {
      this.camPos.copy(wantPos);
      this.camLook.copy(wantLook);
    } else {
      this.camPos.lerp(wantPos, Math.min(1, (orbit ? 2.5 : 9) * dt));
      this.camLook.lerp(wantLook, Math.min(1, 12 * dt));
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (Math.abs(this.camera.fov - wantFov) > 0.05) {
      this.camera.fov += (wantFov - this.camera.fov) * Math.min(1, 4 * dt || 1);
      this.camera.updateProjectionMatrix();
    }
  }

  emitHud() {
    const p = this.player;
    if (!p) return;
    const track = this.track;
    const scored = this.racers.map((r) => ({ r, score: raceScore(track, r.progress, r.kart.x, r.kart.z) }));
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((s, i) => (s.r.place = i + 1));
    const k = p.kart;
    this.onHud({
      state: this.state,
      time: this.state === 'racing' || p.progress.finished ? (p.progress.finished ? p.progress.finishTime : this.time) : 0,
      speed: Math.abs(k.speed) * 3.6,
      lap: currentLap(track, p.progress),
      laps: track.laps,
      gate: gatesThisLap(track, p.progress),
      gates: track.gates.length,
      place: p.place,
      racers: this.racers.length,
      showPlace: this.racers.length > 1,
      missed: p.progress.missed,
      wrongWay: this.wrongWay > 1,
      lost: this.offTrack > track.half + 30,
      boost: k.boost > 0,
      charge: k.drifting ? (k.driftCharge > 2.1 ? 2 : k.driftCharge > 0.9 ? 1 : 0) : -1,
      finished: p.progress.finished,
      nextGate: track.gates[p.progress.next],
      kart: k,
    });
  }
}
