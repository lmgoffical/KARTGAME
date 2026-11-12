// The map builder: a top-down editor where you place points and the road
// loops through them. Also places boost pads and sets laps, width, scenery
// and how many checkpoints the track has.

import { buildTrack, validateDef, nearest, formatTime, LIMITS, OBSTACLES, RAMP, GAP, clamp } from '../game/track.js';
import { medalTimes } from '../game/physics.js';

const THEME_BG = { meadow: '#2f6e33', desert: '#b98d4c', snow: '#c9d6e4', neon: '#140c30' };
const THEME_ROAD = { meadow: '#4a4d57', desert: '#5a544f', snow: '#5b6675', neon: '#23233a' };
const $ = (id) => document.getElementById(id);

export const BLANK = () => ({ name: 'My Track', theme: 'meadow', width: 14, laps: 3, checkpoints: 6, points: [], pads: [], obstacles: [] });

export function encodeMap(def) {
  return 'TK1:' + btoa(unescape(encodeURIComponent(JSON.stringify(def))));
}

export function decodeMap(code) {
  const text = String(code).trim();
  if (!text.startsWith('TK1:')) throw new Error('That is not a Turbo Karts map code.');
  let raw;
  try {
    raw = JSON.parse(decodeURIComponent(escape(atob(text.slice(4)))));
  } catch {
    throw new Error('That map code is damaged.');
  }
  const def = validateDef(raw);
  delete def.id;
  return def;
}

export class Editor {
  /** hooks: { toast, onExit, onTest(def), onSave(def), onPublish(def), textDialog(title, text, value) } */
  constructor(hooks) {
    this.hooks = hooks;
    this.root = $('editor');
    this.canvas = $('ed-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.def = BLANK();
    this.track = null;
    this.error = '';
    this.tool = 'draw';
    this.view = { cx: 0, cz: 0, scale: 2 };
    this.undoStack = [];
    this.pointers = new Map();
    this.drag = null;
    this.selected = -1; // the point whose height the slider edits
    this.dirty = false;

    for (const b of this.root.querySelectorAll('[data-tool]')) {
      b.addEventListener('click', () => {
        this.tool = b.dataset.tool;
        this.root.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('on', x === b));
      });
    }
    const field = (id, key, parse) => {
      $(id).addEventListener('input', () => {
        if (!this.fieldUndo) this.pushUndo();
        this.fieldUndo = true;
        this.def[key] = parse($(id).value);
        this.changed();
      });
      $(id).addEventListener('change', () => (this.fieldUndo = false));
    };
    field('ed-name', 'name', (v) => v.slice(0, LIMITS.maxName));
    field('ed-theme', 'theme', (v) => v);
    field('ed-width', 'width', Number);
    field('ed-laps', 'laps', Number);
    field('ed-cp', 'checkpoints', Number);
    $('ed-height').addEventListener('input', () => {
      const p = this.def.points[this.selected];
      if (!p) return;
      if (!this.fieldUndo) this.pushUndo();
      this.fieldUndo = true;
      const h = Number($('ed-height').value);
      p.length = 2;
      if (h > 0) p.push(h);
      this.changed();
    });
    $('ed-height').addEventListener('change', () => (this.fieldUndo = false));

    $('ed-undo').addEventListener('click', () => this.undo());
    $('ed-zoom-in').addEventListener('click', () => this.zoom(1.3));
    $('ed-zoom-out').addEventListener('click', () => this.zoom(1 / 1.3));
    $('ed-fit').addEventListener('click', () => this.fit());
    $('ed-exit').addEventListener('click', () => hooks.onExit());
    $('ed-flip').addEventListener('click', () => {
      if (this.def.points.length < 2) return;
      this.pushUndo();
      const [first, ...rest] = this.def.points;
      this.def.points = [first, ...rest.reverse()];
      this.def.pads = this.def.pads.map((p) => ({ u: (1 - p.u) % 1, lat: -p.lat }));
      const length = this.track?.length || 1;
      this.def.obstacles = this.def.obstacles.map((o) => {
        // Ramps and gaps keep covering the same stretch of road, now entered from the other end.
        const len = o.type === 'ramp' ? RAMP.len : o.type === 'gap' ? GAP.lip + GAP.hole : 0;
        return { type: o.type, u: (((1 - o.u - len / length) % 1) + 1) % 1, lat: -o.lat };
      });
      this.changed();
    });
    $('ed-new').addEventListener('click', () => {
      this.pushUndo();
      this.load(BLANK());
    });
    $('ed-test').addEventListener('click', () => this.withValid((def) => hooks.onTest(def)));
    $('ed-save').addEventListener('click', () => this.withValid((def) => hooks.onSave(def)));
    $('ed-publish').addEventListener('click', () => this.withValid((def) => hooks.onPublish(def)));
    $('ed-export').addEventListener('click', () =>
      this.withValid(async (def) => {
        const code = encodeMap(def);
        try {
          await navigator.clipboard.writeText(code);
          hooks.toast('Map code copied. Send it to a friend!');
        } catch {
          hooks.textDialog('Map code', 'Copy this code and send it to a friend.', code);
        }
      }),
    );
    $('ed-import').addEventListener('click', async () => {
      const code = await hooks.textDialog('Paste a map code', 'Paste a code a friend sent you.', '', true);
      if (!code) return;
      try {
        const def = decodeMap(code);
        this.pushUndo();
        this.load(def);
        hooks.toast('Map loaded.');
      } catch (err) {
        hooks.toast(err.message, true);
      }
    });

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    c.addEventListener('pointerup', (e) => this.pointerUp(e));
    c.addEventListener('pointercancel', (e) => this.pointerUp(e, true));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.offsetX, e.offsetY);
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => this.root.hidden || this.draw());
    window.addEventListener('keydown', (e) => {
      if (this.root.hidden || e.target instanceof HTMLInputElement) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        this.undo();
      }
    });
  }

  show(def) {
    this.root.hidden = false;
    if (def) this.load(def);
    else this.syncFields();
    this.rebuild();
    this.fit();
  }

  hide() {
    this.root.hidden = true;
  }

  load(def) {
    this.def = JSON.parse(JSON.stringify({ ...BLANK(), ...def }));
    this.selected = -1;
    this.def.obstacles ||= [];
    this.def.pads ||= [];
    this.syncFields();
    this.changed();
    this.fit();
  }

  syncFields() {
    const d = this.def;
    $('ed-name').value = d.name;
    $('ed-theme').value = d.theme;
    $('ed-width').value = d.width;
    $('ed-laps').value = d.laps;
    $('ed-cp').value = d.checkpoints;
  }

  withValid(fn) {
    try {
      const clean = validateDef(this.def);
      if (this.def.id) clean.id = this.def.id;
      fn(clean);
    } catch (err) {
      this.hooks.toast(err.message, true);
    }
  }

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.def));
    if (this.undoStack.length > 60) this.undoStack.shift();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.def = JSON.parse(prev);
    this.def.obstacles ||= [];
    this.syncFields();
    this.changed();
  }

  changed() {
    this.dirty = true;
    if (this.selected >= this.def.points.length) this.selected = -1;
    this.select(this.selected);
    this.rebuild();
    this.draw();
  }

  rebuild() {
    this.track = null;
    this.error = '';
    const d = this.def;
    $('ed-width-out').textContent = `${d.width} m`;
    $('ed-laps-out').textContent = d.laps;
    $('ed-cp-out').textContent = d.checkpoints;
    const info = $('ed-info');
    if (d.points.length < LIMITS.minPoints) {
      this.error = `Tap the map to add points. ${LIMITS.minPoints - d.points.length} more to make a loop.`;
    } else {
      try {
        validateDef(d);
        this.track = buildTrack(d);
      } catch (err) {
        this.error = err.message;
        try {
          this.track = buildTrack(d);
        } catch {
          /* nothing to preview */
        }
      }
    }
    info.classList.toggle('bad', !!this.error);
    if (this.error) {
      info.textContent = this.error;
      return;
    }
    const t = this.track;
    info.textContent = `${Math.round(t.length)} m a lap · ${t.gates.length} checkpoints · working out medal times…`;
    clearTimeout(this.medalTimer);
    this.medalTimer = setTimeout(() => {
      if (this.track !== t) return;
      const m = medalTimes(t);
      info.replaceChildren(
        `${Math.round(t.length)} m a lap · ${t.gates.length} checkpoints · ${d.points.length} points`,
        document.createElement('br'),
        `Gold ${formatTime(m.gold)} · Silver ${formatTime(m.silver)} · Bronze ${formatTime(m.bronze)}`,
      );
    }, 350);
  }

  // ----------------------------------------------------------------- view

  size() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
  }

  toScreen(x, z) {
    const { w, h } = this.dims;
    return [(x - this.view.cx) * this.view.scale + w / 2, (z - this.view.cz) * this.view.scale + h / 2];
  }

  toWorld(sx, sy) {
    const { w, h } = this.dims;
    return [(sx - w / 2) / this.view.scale + this.view.cx, (sy - h / 2) / this.view.scale + this.view.cz];
  }

  zoom(f, sx, sy) {
    this.dims = this.size();
    sx ??= this.dims.w / 2;
    sy ??= this.dims.h / 2;
    const [wx, wz] = this.toWorld(sx, sy);
    this.view.scale = clamp(this.view.scale * f, 0.35, 12);
    const [nx, nz] = this.toWorld(sx, sy);
    this.view.cx += wx - nx;
    this.view.cz += wz - nz;
    this.draw();
  }

  fit() {
    this.dims = this.size();
    const pts = this.def.points;
    if (pts.length < 2) {
      this.view = { cx: 0, cz: 0, scale: Math.min(this.dims.w, this.dims.h) / 420 };
    } else {
      const xs = pts.map((p) => p[0]);
      const zs = pts.map((p) => p[1]);
      const spanX = Math.max(...xs) - Math.min(...xs) + 90;
      const spanZ = Math.max(...zs) - Math.min(...zs) + 90;
      this.view = {
        cx: (Math.max(...xs) + Math.min(...xs)) / 2,
        cz: (Math.max(...zs) + Math.min(...zs)) / 2,
        scale: clamp(Math.min(this.dims.w / spanX, this.dims.h / spanZ), 0.35, 12),
      };
    }
    this.draw();
  }

  // ------------------------------------------------------------- pointers

  hitPoint(sx, sy) {
    const pts = this.def.points;
    let best = -1;
    let bd = 18;
    for (let i = 0; i < pts.length; i++) {
      const [px, py] = this.toScreen(pts[i][0], pts[i][1]);
      const d = Math.hypot(px - sx, py - sy);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  hitPad(sx, sy) {
    if (!this.track) return -1;
    return this.track.pads.findIndex((p) => {
      const [px, py] = this.toScreen(p.x, p.z);
      return Math.hypot(px - sx, py - sy) < 16;
    });
  }

  /** Where an obstacle from the definition sits on the current track. */
  obstacleSpot(o) {
    const t = this.track;
    const s = t.samples[Math.floor(o.u * t.count) % t.count];
    const span = !!OBSTACLES[o.type].span;
    const lat = span ? 0 : o.lat * t.half;
    return { s, span, x: s.x + s.rx * lat, z: s.z + s.rz * lat, len: o.type === 'ramp' ? RAMP.len : GAP.lip + GAP.hole };
  }

  hitObstacle(sx, sy) {
    if (!this.track) return -1;
    return this.def.obstacles.findIndex((o) => {
      const spot = this.obstacleSpot(o);
      // Ramps and gaps are grabbed by their middle.
      const x = spot.span ? spot.x + spot.s.tx * spot.len * 0.5 : spot.x;
      const z = spot.span ? spot.z + spot.s.tz * spot.len * 0.5 : spot.z;
      const [px, py] = this.toScreen(x, z);
      const reach = spot.span ? this.track.half : OBSTACLES[o.type].r;
      return Math.hypot(px - sx, py - sy) < Math.max(14, reach * this.view.scale);
    });
  }

  select(i) {
    this.selected = i;
    const p = this.def.points[i];
    $('ed-height').disabled = !p;
    $('ed-height').value = p ? p[2] || 0 : 0;
    $('ed-height-out').textContent = p ? `${p[2] || 0} m` : 'tap a point';
  }

  pointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.view.scale };
      this.drag = null;
      return;
    }
    const point = this.tool === 'draw' ? this.hitPoint(e.offsetX, e.offsetY) : -1;
    if (point >= 0) {
      this.select(point);
      this.draw();
    }
    this.drag = { x0: e.offsetX, y0: e.offsetY, x: e.offsetX, y: e.offsetY, point, moved: false, saved: false };
  }

  pointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.offsetX;
    p.y = e.offsetY;
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.view.scale = clamp((this.pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / this.pinch.dist, 0.35, 12);
      this.draw();
      return;
    }
    const d = this.drag;
    if (!d) return;
    const dx = e.offsetX - d.x;
    const dy = e.offsetY - d.y;
    if (!d.moved && Math.hypot(e.offsetX - d.x0, e.offsetY - d.y0) < 6) return;
    d.moved = true;
    d.x = e.offsetX;
    d.y = e.offsetY;
    if (d.point >= 0) {
      if (!d.saved) {
        this.pushUndo();
        d.saved = true;
      }
      const [wx, wz] = this.toWorld(e.offsetX, e.offsetY);
      const moved = [clamp(Math.round(wx), -LIMITS.maxCoord, LIMITS.maxCoord), clamp(Math.round(wz), -LIMITS.maxCoord, LIMITS.maxCoord)];
      if (this.def.points[d.point][2]) moved.push(this.def.points[d.point][2]);
      this.def.points[d.point] = moved;
      this.changed();
    } else {
      this.view.cx -= dx / this.view.scale;
      this.view.cz -= dy / this.view.scale;
      this.draw();
    }
  }

  pointerUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      this.drag = null;
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved || cancelled) return;
    this.tap(d.x0, d.y0);
  }

  tap(sx, sy) {
    const [wx, wz] = this.toWorld(sx, sy);
    const d = this.def;
    if (this.tool === 'erase') {
      const pad = this.hitPad(sx, sy);
      const obstacle = this.hitObstacle(sx, sy);
      const point = this.hitPoint(sx, sy);
      if (pad < 0 && point < 0 && obstacle < 0) return;
      this.pushUndo();
      if (obstacle >= 0) d.obstacles.splice(obstacle, 1);
      else if (pad >= 0) d.pads.splice(pad, 1);
      else d.points.splice(point, 1);
      this.selected = -1;
      this.changed();
      return;
    }
    if (this.tool === 'pad') {
      if (!this.track) return this.hooks.toast('Draw the road first.', true);
      const near = nearest(this.track, wx, wz);
      if (near.dist > this.track.half) return this.hooks.toast('Boost pads go on the road.', true);
      if (d.pads.length >= LIMITS.maxPads) return this.hooks.toast(`A track can have ${LIMITS.maxPads} boost pads.`, true);
      this.pushUndo();
      d.pads.push({ u: near.index / this.track.count, lat: clamp(near.lateral / this.track.half, -0.8, 0.8) });
      this.changed();
      return;
    }
    if (this.tool === 'obstacle') {
      if (!this.track) return this.hooks.toast('Draw the road first.', true);
      const near = nearest(this.track, wx, wz);
      if (near.dist > this.track.half) return this.hooks.toast('Obstacles go on the road.', true);
      if (d.obstacles.length >= LIMITS.maxObstacles) return this.hooks.toast(`A track can have ${LIMITS.maxObstacles} obstacles.`, true);
      this.pushUndo();
      d.obstacles.push({ type: $('ed-obstacle').value, u: near.index / this.track.count, lat: clamp(near.lateral / this.track.half, -0.9, 0.9) });
      this.changed();
      return;
    }
    if (this.hitPoint(sx, sy) >= 0) return;
    if (d.points.length >= LIMITS.maxPoints) return this.hooks.toast(`A track can have ${LIMITS.maxPoints} points.`, true);
    this.pushUndo();
    const p = [clamp(Math.round(wx), -LIMITS.maxCoord, LIMITS.maxCoord), clamp(Math.round(wz), -LIMITS.maxCoord, LIMITS.maxCoord)];
    // Tapping the road inserts a point there; anywhere else extends the loop.
    let at = d.points.length;
    if (this.track && nearest(this.track, wx, wz).dist < this.track.half) {
      let bd = Infinity;
      for (let i = 0; i < d.points.length; i++) {
        const a = d.points[i];
        const b = d.points[(i + 1) % d.points.length];
        const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1;
        const t = clamp(((wx - a[0]) * (b[0] - a[0]) + (wz - a[1]) * (b[1] - a[1])) / len2, 0, 1);
        const dist = Math.hypot(wx - (a[0] + (b[0] - a[0]) * t), wz - (a[1] + (b[1] - a[1]) * t));
        if (dist < bd) {
          bd = dist;
          at = i + 1;
        }
      }
    }
    d.points.splice(at, 0, p);
    this.selected = at;
    this.changed();
  }

  // ----------------------------------------------------------------- draw

  draw() {
    if (this.root.hidden) return;
    const dims = (this.dims = this.size());
    const g = this.ctx;
    const s = this.view.scale;
    g.setTransform(dims.dpr, 0, 0, dims.dpr, 0, 0);
    g.fillStyle = THEME_BG[this.def.theme];
    g.fillRect(0, 0, dims.w, dims.h);

    // 50 m grid
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    const [x0, z0] = this.toWorld(0, 0);
    const [x1, z1] = this.toWorld(dims.w, dims.h);
    g.beginPath();
    for (let x = Math.floor(x0 / 50) * 50; x < x1; x += 50) {
      const sx = this.toScreen(x, 0)[0];
      g.moveTo(sx, 0);
      g.lineTo(sx, dims.h);
    }
    for (let z = Math.floor(z0 / 50) * 50; z < z1; z += 50) {
      const sy = this.toScreen(0, z)[1];
      g.moveTo(0, sy);
      g.lineTo(dims.w, sy);
    }
    g.stroke();

    const pts = this.def.points;
    const t = this.track;
    if (t) {
      const path = () => {
        g.beginPath();
        t.samples.forEach((p, i) => {
          const [sx, sy] = this.toScreen(p.x, p.z);
          if (i) g.lineTo(sx, sy);
          else g.moveTo(sx, sy);
        });
        g.closePath();
      };
      g.lineJoin = g.lineCap = 'round';
      path();
      g.strokeStyle = '#ffffff';
      g.lineWidth = (t.width + 2.6) * s;
      g.stroke();
      g.strokeStyle = THEME_ROAD[this.def.theme];
      g.lineWidth = t.width * s;
      g.stroke();
      g.setLineDash([6 * s, 6 * s]);
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.lineWidth = Math.max(1, 0.4 * s);
      g.stroke();
      g.setLineDash([]);

      // boost pads
      for (const p of t.pads) {
        const [sx, sy] = this.toScreen(p.x, p.z);
        g.save();
        g.translate(sx, sy);
        g.rotate(Math.atan2(Math.cos(p.heading), Math.sin(p.heading)));
        g.fillStyle = '#ffd23b';
        g.beginPath();
        g.moveTo(3.4 * s, 0);
        g.lineTo(-2.4 * s, -2.6 * s);
        g.lineTo(-0.8 * s, 0);
        g.lineTo(-2.4 * s, 2.6 * s);
        g.closePath();
        g.fill();
        g.restore();
      }

      // obstacles, ramps and gaps
      for (const o of this.def.obstacles) {
        const spot = this.obstacleSpot(o);
        if (spot.span) {
          // A band across the road: yellow for the take-off, dark for the hole.
          const band = (from, to, color) => {
            g.strokeStyle = color;
            g.lineWidth = (t.width + 2.6) * s;
            g.lineCap = 'butt';
            g.beginPath();
            g.moveTo(...this.toScreen(spot.x + spot.s.tx * from, spot.z + spot.s.tz * from));
            g.lineTo(...this.toScreen(spot.x + spot.s.tx * to, spot.z + spot.s.tz * to));
            g.stroke();
            g.lineCap = 'round';
          };
          if (o.type === 'ramp') band(0, RAMP.len, '#ffd23b');
          else {
            band(0, GAP.lip, '#ffd23b');
            band(GAP.lip, GAP.lip + GAP.hole, '#0b0c12');
          }
          continue;
        }
        const [sx, sy] = this.toScreen(spot.x, spot.z);
        const r = Math.max(5, OBSTACLES[o.type].r * s);
        g.beginPath();
        if (o.type === 'cone') {
          g.moveTo(sx, sy - r * 1.3);
          g.lineTo(sx + r * 1.1, sy + r);
          g.lineTo(sx - r * 1.1, sy + r);
          g.closePath();
          g.fillStyle = '#ff6a1a';
        } else {
          g.arc(sx, sy, r, 0, Math.PI * 2);
          g.fillStyle = o.type === 'oil' ? 'rgba(5,6,12,0.85)' : '#17181c';
        }
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = o.type === 'oil' ? '#7a5cff' : '#ffffff';
        g.stroke();
      }

      // checkpoints
      g.font = `800 ${Math.max(11, Math.min(16, 5 * s))}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      t.gates.forEach((gate, i) => {
        const a = this.toScreen(gate.x - gate.rx * (gate.half + 2), gate.z - gate.rz * (gate.half + 2));
        const b = this.toScreen(gate.x + gate.rx * (gate.half + 2), gate.z + gate.rz * (gate.half + 2));
        g.strokeStyle = i === 0 ? '#ffffff' : '#35ff9a';
        g.lineWidth = i === 0 ? 5 : 3;
        g.beginPath();
        g.moveTo(...a);
        g.lineTo(...b);
        g.stroke();
        g.fillStyle = i === 0 ? '#ffffff' : '#35ff9a';
        g.beginPath();
        g.arc(a[0], a[1], 10, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#10131c';
        g.fillText(i === 0 ? 'S' : String(i), a[0], a[1] + 0.5);
      });

      // direction arrow just after the start line
      const st = t.samples[Math.min(t.count - 1, Math.round(8 / t.step))];
      const [ax, ay] = this.toScreen(st.x, st.z);
      g.save();
      g.translate(ax, ay);
      g.rotate(Math.atan2(st.tz, st.tx));
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(4 * s, 0);
      g.lineTo(-2 * s, -3 * s);
      g.lineTo(-2 * s, 3 * s);
      g.closePath();
      g.fill();
      g.restore();
    } else if (pts.length > 1) {
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = 2;
      g.setLineDash([6, 6]);
      g.beginPath();
      pts.forEach((p, i) => {
        const [sx, sy] = this.toScreen(p[0], p[1]);
        if (i) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
      });
      g.stroke();
      g.setLineDash([]);
    }

    g.font = '800 12px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    pts.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p[0], p[1]);
      const picked = i === this.selected;
      g.beginPath();
      g.arc(sx, sy, picked ? 9 : 7, 0, Math.PI * 2);
      g.fillStyle = i === 0 ? '#ff5a1f' : '#ffffff';
      g.fill();
      g.lineWidth = picked ? 4 : 2;
      g.strokeStyle = picked ? '#35ff9a' : '#10131c';
      g.stroke();
      if (p[2]) {
        g.fillStyle = '#ffffff';
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = 3;
        g.strokeText(`${p[2]} m`, sx + 12, sy);
        g.fillText(`${p[2]} m`, sx + 12, sy);
      }
    });


    if (!pts.length) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = '800 18px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('Tap anywhere to start drawing your track', dims.w / 2, dims.h / 2);
    }
  }
}
