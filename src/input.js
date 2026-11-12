// Keyboard, touch and gamepad, merged into one set of driving controls.

const KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  gas: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  drift: ['Space', 'ShiftLeft', 'ShiftRight'],
};

export class Input {
  constructor() {
    this.down = new Set();
    this.touch = { left: false, right: false, gas: false, brake: false, drift: false };
    this.pressed = new Set(); // one-shot actions: 'reset', 'pause'
    this.usedTouch = false;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === 'KeyR') this.pressed.add('reset');
      if (e.code === 'Escape' || e.code === 'KeyP') this.pressed.add('pause');
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  /** Wires up on-screen buttons marked with data-touch="left|right|gas|brake|drift|reset|pause". */
  bindTouch(root) {
    for (const el of root.querySelectorAll('[data-touch]')) {
      const name = el.dataset.touch;
      const set = (v) => (e) => {
        e.preventDefault();
        this.usedTouch = true;
        if (name === 'reset' || name === 'pause') {
          if (v) this.pressed.add(name);
          return;
        }
        this.touch[name] = v;
        el.classList.toggle('held', v);
      };
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture?.(e.pointerId);
        set(true)(e);
      });
      el.addEventListener('pointerup', set(false));
      el.addEventListener('pointercancel', set(false));
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  take(action) {
    const had = this.pressed.has(action);
    this.pressed.delete(action);
    return had;
  }

  clear() {
    this.pressed.clear();
    for (const k of Object.keys(this.touch)) this.touch[k] = false;
    document.querySelectorAll('[data-touch].held').forEach((el) => el.classList.remove('held'));
  }

  read() {
    const key = (name) => KEYS[name].some((c) => this.down.has(c)) || this.touch[name];
    let steer = (key('left') ? 1 : 0) - (key('right') ? 1 : 0);
    let throttle = key('gas') ? 1 : 0;
    let brake = key('brake') ? 1 : 0;
    let drift = key('drift');
    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const x = pad.axes[0] || 0;
      if (Math.abs(x) > 0.15) steer = -x;
      if (pad.buttons[14]?.pressed) steer = 1;
      if (pad.buttons[15]?.pressed) steer = -1;
      throttle = Math.max(throttle, pad.buttons[7]?.value || 0, pad.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, pad.buttons[6]?.value || 0, pad.buttons[2]?.pressed ? 1 : 0);
      drift = drift || !!pad.buttons[5]?.pressed || !!pad.buttons[1]?.pressed;
      const edge = (i, action) => {
        const now = !!pad.buttons[i]?.pressed;
        if (now && !this[`pad${i}`]) this.pressed.add(action);
        this[`pad${i}`] = now;
      };
      edge(3, 'reset');
      edge(9, 'pause');
    }
    return { steer, throttle, brake, drift };
  }
}
