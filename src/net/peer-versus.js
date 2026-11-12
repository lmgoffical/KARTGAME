// Versus without a game server. Everyone in a room shares one broadcast
// channel and the player who made the room runs it: they keep the player
// list, pick the track, start the race and collect the results. If they
// leave, the next player in the list takes over.
//
// It has the same shape as the WebSocket client in versus.js, so the rest of
// the game does not care which one it is talking to.

import { validateDef } from '../game/track.js';
import { LEVELS } from '../game/levels.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULTS = { pingMs: 2000, goneMs: 8000, joinMs: 6000, settleMs: 700, graceMs: 45000, countdownMs: 4500, maxPlayers: 8 };

const cleanName = (n) => String(n ?? 'Guest').replace(/[^\w \-]/g, '').trim().slice(0, 16) || 'Guest';
const cleanColor = (c) => Math.max(0, Math.min(7, c | 0));
const randomId = () => Array.from({ length: 10 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export class PeerVersus {
  /** openChannel(code, onMessage) resolves to { send(type, data), close() }. */
  constructor(openChannel, options = {}) {
    this.open = openChannel;
    this.opt = { ...DEFAULTS, ...options };
    this.id = randomId();
    this.me = { name: 'Guest', color: 0 };
    this.room = null;
    this.on = () => {};
    this.sendMs = 100; // how often the game should send kart positions
    this.channel = null;
    this.timers = [];
    this.seen = new Map(); // player id -> when we last heard from them
    this.results = [];
    this.racers = new Set();
    this.joining = false;
    this.session = 0; // bumps whenever we change room, so late callbacks are ignored
  }

  get connected() {
    return true;
  }

  get isHost() {
    return !!this.room && this.room.hostId === this.id;
  }

  connect(hello) {
    this.me = { name: cleanName(hello.name), color: cleanColor(hello.color) };
    if (this.room) this.announce();
    return Promise.resolve();
  }

  send(m) {
    switch (m.t) {
      case 'create': return void this.create();
      case 'join': return void this.join(String(m.code ?? '').toUpperCase().trim());
      case 'leave': return this.leave();
      case 'color':
        this.me.color = cleanColor(m.color);
        if (this.room) this.announce();
        return;
      case 'track': return this.setTrack(m.track);
      case 'start': return this.start();
      case 'lobby': return this.backToLobby();
      case 'state':
        if (this.room?.state === 'racing' && this.racers.has(this.id)) this.cast('state', { id: this.id, s: m.s });
        return;
      case 'finish': return this.finish(Number(m.time));
      default:
    }
  }

  // ------------------------------------------------------------- joining

  async create() {
    this.leave();
    const session = this.session;
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
      let taken = false;
      let channel;
      try {
        channel = await this.open(code, (e, d) => {
          if (e === 'room' || e === 'ping') taken = true;
          if (this.channel === channel) this.receive(e, d);
        });
      } catch {
        if (session === this.session) this.on('error', { msg: 'Could not reach the multiplayer service.' });
        return;
      }
      // Listen briefly in case somebody is already using this code.
      await new Promise((r) => setTimeout(r, this.opt.settleMs));
      if (session !== this.session) return void channel.close();
      if (taken) {
        channel.close();
        continue;
      }
      this.channel = channel;
      this.room = { code, hostId: this.id, state: 'lobby', track: LEVELS[0], players: [{ id: this.id, name: this.me.name, color: this.me.color, racing: false }] };
      this.startTimers();
      this.shareRoom();
      return;
    }
    this.on('error', { msg: 'Could not make a room. Try again.' });
  }

  async join(code) {
    this.leave();
    const session = this.session;
    if (!/^[A-Z0-9]{5}$/.test(code)) return this.on('error', { msg: 'No room has that code.' });
    let channel;
    try {
      channel = await this.open(code, (e, d) => this.channel === channel && this.receive(e, d));
    } catch {
      if (session === this.session) this.on('error', { msg: 'Could not reach the multiplayer service.' });
      return;
    }
    if (session !== this.session) return void channel.close();
    this.channel = channel;
    this.joining = true;
    this.cast('hello', { id: this.id, ...this.me });
    const knock = setInterval(() => this.joining && this.cast('hello', { id: this.id, ...this.me }), 1000);
    const giveUp = setTimeout(() => {
      if (!this.joining) return;
      this.leave();
      this.on('error', { msg: 'No room has that code.' });
    }, this.opt.joinMs);
    this.timers.push(() => clearInterval(knock), () => clearTimeout(giveUp));
  }

  leave() {
    this.session++;
    if (this.channel) {
      if (this.room) this.cast('bye', { id: this.id });
      const channel = this.channel;
      // Give the goodbye a moment to go out before closing.
      setTimeout(() => channel.close(), 50);
    }
    for (const stop of this.timers) stop();
    this.timers = [];
    this.channel = null;
    this.room = null;
    this.joining = false;
    this.seen.clear();
    this.results = [];
    this.racers = new Set();
    clearTimeout(this.graceTimer);
  }

  startTimers() {
    const tick = setInterval(() => this.tick(), this.opt.pingMs);
    this.timers.push(() => clearInterval(tick));
  }

  // ----------------------------------------------------------- messaging

  cast(type, data) {
    try {
      this.channel?.send(type, data);
    } catch {
      /* a dropped message is recovered by the next heartbeat */
    }
  }

  /** Tells the host our current name and colour. */
  announce() {
    if (this.isHost) {
      const mine = this.room.players.find((p) => p.id === this.id);
      Object.assign(mine, { name: this.me.name, color: this.freeColor(this.me.color, this.id) });
      this.shareRoom();
    } else this.cast('hello', { id: this.id, ...this.me });
  }

  /** Host only: sends the room to everyone and shows it locally. */
  shareRoom() {
    for (const p of this.room.players) p.racing = this.racers.has(p.id);
    this.cast('room', { from: this.id, room: this.room });
    this.on('room', { room: this.room });
  }

  freeColor(wanted, forId) {
    const taken = new Set(this.room.players.filter((p) => p.id !== forId).map((p) => p.color));
    return taken.has(wanted) ? [0, 1, 2, 3, 4, 5, 6, 7].find((i) => !taken.has(i)) ?? wanted : wanted;
  }

  receive(type, d) {
    if (!d || typeof d !== 'object') return;
    const from = typeof d.id === 'string' ? d.id.slice(0, 16) : typeof d.from === 'string' ? d.from.slice(0, 16) : null;
    if (!from || from === this.id) return;
    this.seen.set(from, Date.now());
    const room = this.room;
    switch (type) {
      case 'hello': {
        if (!this.isHost) return;
        const known = room.players.find((p) => p.id === from);
        if (known) Object.assign(known, { name: cleanName(d.name), color: this.freeColor(cleanColor(d.color), from) });
        else if (room.players.length >= this.opt.maxPlayers) return this.cast('full', { id: this.id, to: from });
        else room.players.push({ id: from, name: cleanName(d.name), color: this.freeColor(cleanColor(d.color), from), racing: false });
        this.shareRoom();
        break;
      }
      case 'full':
        if (this.joining && d.to === this.id) {
          this.leave();
          this.on('error', { msg: 'That room is full.' });
        }
        break;
      case 'room':
        this.takeRoom(from, d.room);
        break;
      case 'state':
        if (room?.state === 'racing' && Array.isArray(d.s) && d.s.length <= 12 && d.s.every((v) => typeof v === 'number' && Number.isFinite(v))) this.on('state', { id: from, s: d.s });
        break;
      case 'finish': {
        const time = Number(d.time);
        if (!room || room.state !== 'racing' || !(time > 0 && time < 3600)) return;
        this.on('finished', { id: from, time });
        if (this.isHost) this.record(from, time);
        break;
      }
      case 'countdown':
        if (room && from === room.hostId && d.slots && typeof d.slots === 'object') {
          this.racers = new Set(Object.keys(d.slots));
          this.on('countdown', { startIn: Number(d.startIn) || this.opt.countdownMs, slots: d.slots });
        }
        break;
      case 'results':
        if (room && from === room.hostId && Array.isArray(d.results)) this.on('results', { results: d.results.slice(0, this.opt.maxPlayers).map((r) => ({ id: String(r.id), name: cleanName(r.name), color: cleanColor(r.color), time: r.time > 0 ? Number(r.time) : null })) });
        break;
      case 'bye':
        this.dropPlayer(from);
        break;
      default:
    }
  }

  /** A room snapshot arrived. Only the host's word counts. */
  takeRoom(from, incoming) {
    if (!incoming || !Array.isArray(incoming.players) || incoming.hostId !== from) return;
    const players = incoming.players.slice(0, this.opt.maxPlayers).map((p) => ({ id: String(p.id).slice(0, 16), name: cleanName(p.name), color: cleanColor(p.color), racing: !!p.racing }));
    const included = players.some((p) => p.id === this.id);
    if (!this.room) {
      if (!this.joining || !included) return;
      this.joining = false;
      this.startTimers();
    } else if (this.isHost) {
      return; // we are running this room; ignore anyone else claiming to
    } else if (from !== this.room.hostId) {
      // A new host is only believed if the old one has gone quiet or left.
      const old = this.seen.get(this.room.hostId) || 0;
      const stillThere = players.some((p) => p.id === this.room.hostId);
      if (stillThere && Date.now() - old < this.opt.goneMs / 2) return;
    }
    if (!included) {
      // The host dropped us (we went quiet for too long).
      this.leave();
      this.on('closed', {});
      return;
    }
    let track = this.room?.track || LEVELS[0];
    try {
      const clean = validateDef(incoming.track);
      if (typeof incoming.track.id === 'string') clean.id = incoming.track.id.slice(0, 40);
      track = clean;
    } catch {
      /* keep the track we had */
    }
    const state = ['lobby', 'racing', 'results'].includes(incoming.state) ? incoming.state : 'lobby';
    this.room = { code: this.room?.code || String(incoming.code).slice(0, 5), hostId: from, state, track, players };
    this.on('room', { room: this.room });
  }

  dropPlayer(id) {
    const room = this.room;
    if (!room || !room.players.some((p) => p.id === id)) return;
    this.on('left', { id });
    this.seen.delete(id);
    if (this.isHost) {
      room.players = room.players.filter((p) => p.id !== id);
      this.racers.delete(id);
      this.shareRoom();
      this.checkAllFinished();
    } else if (id === room.hostId) this.elect();
  }

  /** The host is gone: the first player left in the list takes over. */
  elect() {
    const room = this.room;
    const now = Date.now();
    const alive = room.players.filter((p) => p.id !== room.hostId && (p.id === this.id || now - (this.seen.get(p.id) || 0) < this.opt.goneMs));
    if (!alive.length || alive[0].id !== this.id) return;
    room.players = room.players.filter((p) => p.id !== room.hostId);
    room.hostId = this.id;
    // The old host held the race results, so a race in progress is called off.
    room.state = 'lobby';
    this.racers = new Set();
    this.results = [];
    this.shareRoom();
  }

  tick() {
    const room = this.room;
    if (!room) return;
    const now = Date.now();
    this.cast('ping', { id: this.id });
    if (this.isHost) {
      for (const p of [...room.players]) {
        if (p.id !== this.id && now - (this.seen.get(p.id) || now) > this.opt.goneMs) {
          this.cast('bye', { id: p.id });
          this.dropPlayer(p.id);
        }
      }
      this.shareRoom(); // heartbeat: keeps late joiners and stragglers in step
    } else if (now - (this.seen.get(room.hostId) || now) > this.opt.goneMs) {
      this.on('left', { id: room.hostId });
      this.elect();
    }
  }

  // --------------------------------------------------------------- racing

  setTrack(raw) {
    if (!this.isHost || this.room.state !== 'lobby') return;
    try {
      const def = validateDef(raw);
      if (typeof raw.id === 'string') def.id = raw.id.slice(0, 40);
      this.room.track = def;
      this.shareRoom();
    } catch (err) {
      this.on('error', { msg: err.message });
    }
  }

  start() {
    if (!this.room) return;
    if (!this.isHost) return this.on('error', { msg: 'Only the host can do that.' });
    if (this.room.state !== 'lobby') return;
    this.room.state = 'racing';
    this.results = [];
    this.racers = new Set(this.room.players.map((p) => p.id));
    const slots = {};
    this.room.players.forEach((p, i) => (slots[p.id] = i));
    this.shareRoom();
    const msg = { id: this.id, startIn: this.opt.countdownMs, slots };
    this.cast('countdown', msg);
    this.on('countdown', msg);
  }

  finish(time) {
    if (this.room?.state !== 'racing' || !this.racers.has(this.id) || !(time > 0 && time < 3600)) return;
    this.cast('finish', { id: this.id, time });
    this.on('finished', { id: this.id, time });
    if (this.isHost) this.record(this.id, time);
  }

  record(id, time) {
    if (!this.racers.has(id) || this.results.some((r) => r.id === id)) return;
    const p = this.room.players.find((q) => q.id === id);
    if (!p) return;
    this.results.push({ id, name: p.name, color: p.color, time });
    if (this.results.length === 1) this.graceTimer = setTimeout(() => this.endRace(), this.opt.graceMs);
    this.checkAllFinished();
  }

  checkAllFinished() {
    if (!this.isHost || this.room.state !== 'racing') return;
    const racing = this.room.players.filter((p) => this.racers.has(p.id));
    if (racing.every((p) => this.results.some((r) => r.id === p.id))) this.endRace();
  }

  endRace() {
    clearTimeout(this.graceTimer);
    if (!this.isHost || this.room.state !== 'racing') return;
    const results = [...this.results].sort((a, b) => a.time - b.time);
    for (const p of this.room.players) {
      if (this.racers.has(p.id) && !results.some((r) => r.id === p.id)) results.push({ id: p.id, name: p.name, color: p.color, time: null });
    }
    this.room.state = 'results';
    this.cast('results', { id: this.id, results });
    this.on('results', { results });
    this.shareRoom();
  }

  backToLobby() {
    if (!this.room) return;
    if (!this.isHost) return this.on('error', { msg: 'Only the host can do that.' });
    this.endRace();
    this.room.state = 'lobby';
    this.racers = new Set();
    this.shareRoom();
  }
}
