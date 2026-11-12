// Talks to the game server: accounts, best times, leaderboards, shared maps.
// Everything degrades to guest play when the server can't be reached.

import { storage } from '../storage.js';

const TOKEN_KEY = 'tk.token';

export const api = {
  online: false,
  token: storage.get(TOKEN_KEY) || '',
  user: null,

  async call(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Could not reach the game server.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON: the server is not there */
    }
    if (!res.ok || !data) throw new Error(data?.error || 'Could not reach the game server.');
    return data;
  },

  /** Checks the server is there and restores a saved sign-in. */
  async init() {
    try {
      const h = await this.call('GET', '/api/health');
      this.online = !!h.ok;
    } catch {
      this.online = false;
      return;
    }
    if (!this.token) return;
    try {
      this.user = (await this.call('GET', '/api/me')).user;
    } catch {
      this.setSession('', null);
    }
  },

  setSession(token, user) {
    this.token = token;
    this.user = user;
    if (token) storage.set(TOKEN_KEY, token);
    else storage.remove(TOKEN_KEY);
  },

  async signIn(name, password, create) {
    const out = await this.call('POST', create ? '/api/register' : '/api/login', { name, password });
    this.setSession(out.token, out.user);
    return out.user;
  },

  async signOut() {
    try {
      await this.call('POST', '/api/logout');
    } catch {
      /* signing out locally is enough */
    }
    this.setSession('', null);
  },

  submitTime: (track, time, medal) => api.call('POST', '/api/times', { track, time, medal }),
  leaderboard: (track) => api.call('GET', `/api/leaderboard?track=${encodeURIComponent(track)}`).then((r) => r.rows),
  maps: () => api.call('GET', '/api/maps').then((r) => r.maps),
  map: (id) => api.call('GET', `/api/maps/${encodeURIComponent(id)}`),
  publish: (def) => api.call('POST', '/api/maps', { def }),
  deleteMap: (id) => api.call('DELETE', `/api/maps/${encodeURIComponent(id)}`),
  setColor: (color) => api.call('POST', '/api/color', { color }).catch(() => {}),
};
