// All sound is synthesised with the Web Audio API: engine, tyre squeal and
// short effects. Nothing is downloaded.

import { storage } from './storage.js';

const ENGINE_LEVELS = { off: 0, low: 0.45, on: 1 };

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = storage.get('tk.muted') === '1';
    this.engineLevel = Object.hasOwn(ENGINE_LEVELS, storage.get('tk.engine')) ? storage.get('tk.engine') : 'on';
    this.sfx = storage.get('tk.sfx') !== '0';
  }

  /** Browsers only allow audio after a tap or key press, so call this from one. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.engineBus = ctx.createGain();
    this.engineBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.applyLevels();

    // Engine: a low saw with a sub an octave down and a soft overtone, kept
    // mellow by a low-pass filter that opens as the revs rise.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 0.8;
    this.engineFilter.frequency.value = 300;
    this.oscs = [['sawtooth', 1, 0.5, 0], ['sawtooth', 1, 0.35, 9], ['square', 0.5, 0.45, 0], ['triangle', 2, 0.25, 0]].map(([type, ratio, level, detune]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = 50 * ratio;
      o.detune.value = detune;
      g.gain.value = level;
      o.connect(g).connect(this.engineFilter);
      o.start();
      return { o, ratio };
    });
    this.engineFilter.connect(this.engineGain).connect(this.engineBus);

    // Tyre squeal: filtered noise.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    bp.Q.value = 5;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    noise.connect(bp).connect(this.skidGain).connect(this.sfxBus);
    noise.start();
  }

  applyLevels() {
    if (!this.ctx) return;
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.engineBus.gain.value = ENGINE_LEVELS[this.engineLevel];
    this.sfxBus.gain.value = this.sfx ? 1 : 0;
  }

  setMuted(m) {
    this.muted = m;
    storage.set('tk.muted', m ? '1' : '0');
    this.applyLevels();
  }

  /** 'off', 'low' or 'on'. */
  setEngine(level) {
    this.engineLevel = level;
    storage.set('tk.engine', level);
    this.applyLevels();
  }

  setSfx(on) {
    this.sfx = on;
    storage.set('tk.sfx', on ? '1' : '0');
    this.applyLevels();
  }

  /** Call every frame while driving. speed01 is speed as a share of top speed. */
  engine(speed01, throttle, skid, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Four gears: revs climb, drop at each change, and climb again.
    const s = Math.min(1.35, Math.abs(speed01)) * 4;
    const gear = Math.min(3, Math.floor(s));
    const revs = gear === 0 ? 0.15 + 0.85 * s : 0.4 + 0.6 * Math.min(1.4, s - gear);
    const f = 42 + revs * 78 + gear * 5 + throttle * 5;
    for (const { o, ratio } of this.oscs) o.frequency.setTargetAtTime(f * ratio, t, 0.06);
    this.engineFilter.frequency.setTargetAtTime(220 + revs * 650 + throttle * 350, t, 0.1);
    this.engineGain.gain.setTargetAtTime(active ? 0.07 + throttle * 0.05 : 0, t, 0.12);
    this.skidGain.gain.setTargetAtTime(active ? skid * 0.09 : 0, t, 0.06);
  }

  tone(freq, dur, type = 'sine', vol = 0.3, slideTo = null, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  play(name) {
    switch (name) {
      case 'count': return this.tone(440, 0.18, 'square', 0.2);
      case 'go': return this.tone(880, 0.5, 'square', 0.25);
      case 'gate': this.tone(880, 0.12, 'triangle', 0.3); return this.tone(1320, 0.2, 'triangle', 0.3, null, 0.08);
      case 'lap': [660, 880, 1100].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.3, null, i * 0.09)); return;
      case 'finish': [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.25, 'square', 0.2, null, i * 0.13)); return;
      case 'missed': return this.tone(220, 0.35, 'sawtooth', 0.25, 140);
      case 'boost': return this.tone(260, 0.5, 'sawtooth', 0.22, 1100);
      case 'bump': return this.tone(110, 0.15, 'square', 0.25, 50);
      case 'jump': return this.tone(300, 0.25, 'sine', 0.18, 620);
      case 'cone': return this.tone(320, 0.12, 'triangle', 0.3, 160);
      case 'oil': return this.tone(500, 0.6, 'sine', 0.2, 180);
      case 'click': return this.tone(700, 0.05, 'triangle', 0.15);
      default:
    }
  }
}
