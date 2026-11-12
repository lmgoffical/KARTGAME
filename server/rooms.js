// Online versus rooms. Each player simulates their own kart and the server
// relays positions, keeps the lobby in sync and decides when a race is over.

import crypto from 'node:crypto';
import { validateDef } from '../src/game/track.js';

const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COUNTDOWN_MS = 4500;
const FINISH_GRACE_MS = 45000;
const MAX_ROOMS = 500;

export class Rooms {
  constructor(store, defaultTrack) {
    this.store = store;
    this.defaultTrack = defaultTrack;
    this.rooms = new Map();
    this.nextId = 1;
  }

  /** Call once for each new WebSocket. */
  attach(ws) {
    const c = { ws, id: String(this.nextId++), name: 'Guest', color: 0, room: null, lastState: 0, msgCount: 0, msgWindow: Date.now() };
    ws.on('message', (raw) => {
      // Flood guard: 60 messages a second is far more than the game sends.
      const now = Date.now();
      if (now - c.msgWindow > 1000) {
        c.msgWindow = now;
        c.msgCount = 0;
      }
      if (++c.msgCount > 60) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      try {
        this.handle(c, msg);
      } catch (err) {
        this.send(c, { t: 'error', msg: err.message || 'Something went wrong.' });
      }
    });
    ws.on('close', () => this.leave(c));
    ws.on('error', () => {});
    this.send(c, { t: 'welcome', id: c.id });
  }

  send(c, msg) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  broadcast(room, msg, except) {
    const text = JSON.stringify(msg);
    for (const p of room.players) if (p !== except && p.ws.readyState === 1) p.ws.send(text);
  }

  roomView(room) {
    return {
      code: room.code,
      hostId: room.host.id,
      state: room.state,
      track: room.track,
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, racing: room.racers.has(p.id) })),
    };
  }

  sync(room) {
    this.broadcast(room, { t: 'room', room: this.roomView(room) });
  }

  handle(c, m) {
    switch (m.t) {
      case 'hello': {
        const key = this.store.auth(m.token);
        if (key) c.name = this.store.publicUser(key).name;
        else c.name = String(m.name ?? 'Guest').replace(/[^\w \-]/g, '').trim().slice(0, 16) || 'Guest';
        c.color = Math.max(0, Math.min(7, m.color | 0));
        if (c.room) this.sync(c.room);
        break;
      }
      case 'create': {
        this.leave(c);
        if (this.rooms.size >= MAX_ROOMS) throw new Error('The server is full. Try again in a minute.');
        let code;
        do {
          code = Array.from(crypto.randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
        } while (this.rooms.has(code));
        const room = { code, host: c, players: [c], state: 'lobby', track: this.defaultTrack, racers: new Set(), results: [], timer: null };
        this.rooms.set(code, room);
        c.room = room;
        this.sync(room);
        break;
      }
      case 'join': {
        this.leave(c);
        const room = this.rooms.get(String(m.code ?? '').toUpperCase().trim());
        if (!room) throw new Error('No room has that code.');
        if (room.players.length >= MAX_PLAYERS) throw new Error('That room is full.');
        // Two racers in the same colour are hard to tell apart, so hand out a free one.
        const taken = new Set(room.players.map((p) => p.color));
        if (taken.has(c.color)) c.color = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => !taken.has(i)) ?? c.color;
        room.players.push(c);
        c.room = room;
        this.sync(room);
        break;
      }
      case 'leave':
        this.leave(c);
        break;
      case 'color': {
        c.color = Math.max(0, Math.min(7, m.color | 0));
        if (c.room) this.sync(c.room);
        break;
      }
      case 'track': {
        const room = this.hostRoom(c);
        if (room.state !== 'lobby') return;
        const def = validateDef(m.track);
        if (typeof m.track.id === 'string') def.id = m.track.id.slice(0, 40);
        room.track = def;
        this.sync(room);
        break;
      }
      case 'start': {
        const room = this.hostRoom(c);
        if (room.state !== 'lobby') return;
        room.state = 'racing';
        room.results = [];
        room.racers = new Set(room.players.map((p) => p.id));
        const slots = {};
        room.players.forEach((p, i) => (slots[p.id] = i));
        this.sync(room);
        this.broadcast(room, { t: 'countdown', startIn: COUNTDOWN_MS, slots });
        break;
      }
      case 'state': {
        const room = c.room;
        if (!room || room.state !== 'racing' || !room.racers.has(c.id)) return;
        if (!Array.isArray(m.s) || m.s.length > 10 || !m.s.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
        this.broadcast(room, { t: 'state', id: c.id, s: m.s }, c);
        break;
      }
      case 'finish': {
        const room = c.room;
        if (!room || room.state !== 'racing' || !room.racers.has(c.id)) return;
        if (room.results.some((r) => r.id === c.id)) return;
        const time = Number(m.time);
        if (!(time > 0 && time < 3600)) return;
        room.results.push({ id: c.id, name: c.name, color: c.color, time });
        this.broadcast(room, { t: 'finished', id: c.id, time });
        if (!room.timer) room.timer = setTimeout(() => this.endRace(room), FINISH_GRACE_MS);
        this.checkAllFinished(room);
        break;
      }
      case 'lobby': {
        const room = this.hostRoom(c);
        this.endRace(room, true);
        break;
      }
      default:
        break;
    }
  }

  hostRoom(c) {
    if (!c.room) throw new Error('You are not in a room.');
    if (c.room.host !== c) throw new Error('Only the host can do that.');
    return c.room;
  }

  checkAllFinished(room) {
    if (room.state !== 'racing') return;
    const racing = room.players.filter((p) => room.racers.has(p.id));
    if (racing.every((p) => room.results.some((r) => r.id === p.id))) this.endRace(room);
  }

  endRace(room, toLobby = false) {
    clearTimeout(room.timer);
    room.timer = null;
    if (room.state === 'racing') {
      const results = [...room.results].sort((a, b) => a.time - b.time);
      for (const p of room.players) {
        if (room.racers.has(p.id) && !results.some((r) => r.id === p.id)) results.push({ id: p.id, name: p.name, color: p.color, time: null });
      }
      room.state = 'results';
      this.broadcast(room, { t: 'results', results });
    }
    if (toLobby) {
      room.state = 'lobby';
      room.racers = new Set();
    }
    this.sync(room);
  }

  leave(c) {
    const room = c.room;
    if (!room) return;
    c.room = null;
    room.players = room.players.filter((p) => p !== c);
    room.racers.delete(c.id);
    if (room.players.length === 0) {
      clearTimeout(room.timer);
      this.rooms.delete(room.code);
      return;
    }
    if (room.host === c) room.host = room.players[0];
    this.broadcast(room, { t: 'left', id: c.id });
    this.sync(room);
    this.checkAllFinished(room);
  }
}
