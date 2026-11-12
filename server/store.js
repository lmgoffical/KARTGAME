// Accounts, sessions, best times and shared maps, kept in one JSON file.
// Small and dependency-free; swap for a real database if the game grows.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { validateDef, MEDAL_RANK } from '../src/game/track.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const MAX_MAPS_PER_USER = 30;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { users: {}, sessions: {}, maps: {} };
    this.timer = null;
    if (file && fs.existsSync(file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        // Keep the unreadable file for inspection instead of overwriting it.
        fs.copyFileSync(file, `${file}.broken-${Date.now()}`);
        console.error('Could not read the data file, starting empty:', err.message);
      }
    }
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // ------------------------------------------------------------- accounts

  async register(name, password) {
    name = String(name ?? '').trim();
    password = String(password ?? '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new HttpError(400, 'Names are 3 to 16 letters, numbers or underscores.');
    if (password.length < 6 || password.length > 128) throw new HttpError(400, 'Passwords need at least 6 characters.');
    const key = name.toLowerCase();
    if (this.data.users[key]) throw new HttpError(409, 'That name is taken.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    if (this.data.users[key]) throw new HttpError(409, 'That name is taken.');
    this.data.users[key] = { name, salt, hash, created: Date.now(), progress: {}, color: 0 };
    return this.openSession(key);
  }

  async login(name, password) {
    const key = String(name ?? '').trim().toLowerCase();
    const user = Object.hasOwn(this.data.users, key) ? this.data.users[key] : null;
    // Hash even for unknown names so both cases take the same time.
    const salt = user ? user.salt : '00000000000000000000000000000000';
    const hash = await scrypt(String(password ?? ''), salt, 64);
    const ok = user && crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
    if (!ok) throw new HttpError(401, 'Wrong name or password.');
    return this.openSession(key);
  }

  openSession(key) {
    const now = Date.now();
    for (const [h, s] of Object.entries(this.data.sessions)) if (s.exp < now) delete this.data.sessions[h];
    const token = crypto.randomBytes(32).toString('hex');
    this.data.sessions[sha(token)] = { user: key, exp: now + SESSION_DAYS * 864e5 };
    this.save();
    return { token, user: this.publicUser(key) };
  }

  /** Returns the user key for a token, or null. */
  auth(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const s = this.data.sessions[sha(token)];
    if (!s || s.exp < Date.now() || !this.data.users[s.user]) return null;
    return s.user;
  }

  logout(token) {
    if (typeof token === 'string') delete this.data.sessions[sha(token)];
    this.save();
  }

  publicUser(key) {
    const u = this.data.users[key];
    return { name: u.name, progress: u.progress, color: u.color || 0 };
  }

  setColor(key, color) {
    this.data.users[key].color = Math.max(0, Math.min(7, color | 0));
    this.save();
  }

  // ---------------------------------------------------------- best times

  /** Records a finished race. Only ever improves the stored time and medal. */
  submitTime(key, trackId, time, medal) {
    if (typeof trackId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(trackId)) throw new HttpError(400, 'Unknown track.');
    if (!(time > 5 && time < 3600)) throw new HttpError(400, 'That time does not look right.');
    const progress = this.data.users[key].progress;
    if (!Object.hasOwn(progress, trackId) && Object.keys(progress).length >= 300) throw new HttpError(400, 'Too many records.');
    const cur = progress[trackId] || {};
    const best = cur.best ? Math.min(cur.best, time) : time;
    const rank = Math.max(MEDAL_RANK[cur.medal] || 0, MEDAL_RANK[medal] || 0);
    progress[trackId] = { best: Math.round(best * 1000) / 1000, medal: ['', 'bronze', 'silver', 'gold'][rank] || null };
    this.save();
    return progress[trackId];
  }

  leaderboard(trackId) {
    const rows = [];
    for (const u of Object.values(this.data.users)) {
      const p = Object.hasOwn(u.progress, trackId) ? u.progress[trackId] : null;
      if (p?.best) rows.push({ name: u.name, time: p.best, medal: p.medal });
    }
    return rows.sort((a, b) => a.time - b.time).slice(0, 10);
  }

  // ----------------------------------------------------------------- maps

  listMaps() {
    return Object.values(this.data.maps)
      .sort((a, b) => b.created - a.created)
      .slice(0, 100)
      .map((m) => ({ id: m.id, author: m.author, created: m.created, def: { ...m.def, id: m.id, author: m.author } }));
  }

  getMap(id) {
    const m = typeof id === 'string' && Object.hasOwn(this.data.maps, id) ? this.data.maps[id] : null;
    if (!m) throw new HttpError(404, 'That map no longer exists.');
    return { id: m.id, author: m.author, def: { ...m.def, id: m.id, author: m.author } };
  }

  publishMap(key, rawDef) {
    let def;
    try {
      def = validateDef(rawDef);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const author = this.data.users[key].name;
    const mine = Object.values(this.data.maps).filter((m) => m.owner === key);
    // Publishing again under the same name updates the map.
    const existing = mine.find((m) => m.def.name.toLowerCase() === def.name.toLowerCase());
    if (!existing && mine.length >= MAX_MAPS_PER_USER) throw new HttpError(400, `You can share up to ${MAX_MAPS_PER_USER} maps. Delete one first.`);
    const id = existing ? existing.id : `m-${crypto.randomBytes(5).toString('hex')}`;
    delete def.id;
    delete def.author;
    this.data.maps[id] = { id, owner: key, author, def, created: existing ? existing.created : Date.now() };
    this.save();
    return this.getMap(id);
  }

  deleteMap(key, id) {
    const m = typeof id === 'string' && Object.hasOwn(this.data.maps, id) ? this.data.maps[id] : null;
    if (!m) throw new HttpError(404, 'That map no longer exists.');
    if (m.owner !== key) throw new HttpError(403, 'Only the author can delete a map.');
    delete this.data.maps[id];
    this.save();
  }
}
