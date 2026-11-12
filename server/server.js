// One small server for everything: the built game files, the accounts API
// and the WebSocket used for online versus races.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store, HttpError } from './store.js';
import { Rooms } from './rooms.js';
import { LEVELS } from '../src/game/levels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'That is too much data.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new HttpError(400, 'Bad request.'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ dataFile, staticDir } = {}) {
  const store = new Store(dataFile);
  const rooms = new Rooms(store, LEVELS[0]);

  // Slows down password guessing: 10 failed sign-ins per address per 10 minutes.
  const failures = new Map();
  const blocked = (ip) => {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > 600_000) {
      failures.delete(ip);
      return false;
    }
    return f.count >= 10;
  };
  const noteFailure = (ip) => {
    const f = failures.get(ip) || { count: 0, since: Date.now() };
    f.count++;
    failures.set(ip, f);
    if (failures.size > 10_000) failures.clear();
  };

  async function api(req, res, url) {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const needUser = () => {
      const key = store.auth(token);
      if (!key) throw new HttpError(401, 'Please sign in again.');
      return key;
    };
    const route = `${req.method} ${url.pathname}`;
    const ip = req.socket.remoteAddress || '';
    try {
      if (route === 'GET /api/health') return send(200, { ok: true });
      if (route === 'POST /api/register' || route === 'POST /api/login') {
        if (blocked(ip)) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
        const body = await readBody(req);
        try {
          const out = route.endsWith('register') ? await store.register(body.name, body.password) : await store.login(body.name, body.password);
          return send(200, out);
        } catch (err) {
          if (err.status === 401) noteFailure(ip);
          throw err;
        }
      }
      if (route === 'POST /api/logout') {
        store.logout(token);
        return send(200, { ok: true });
      }
      if (route === 'GET /api/me') return send(200, { user: store.publicUser(needUser()) });
      if (route === 'POST /api/color') {
        const key = needUser();
        store.setColor(key, (await readBody(req)).color);
        return send(200, { ok: true });
      }
      if (route === 'POST /api/times') {
        const key = needUser();
        const body = await readBody(req);
        return send(200, { record: store.submitTime(key, body.track, Number(body.time), body.medal) });
      }
      if (route === 'GET /api/leaderboard') return send(200, { rows: store.leaderboard(String(url.searchParams.get('track'))) });
      if (route === 'GET /api/maps') return send(200, { maps: store.listMaps() });
      if (route === 'POST /api/maps') {
        const key = needUser();
        return send(200, store.publishMap(key, (await readBody(req)).def));
      }
      const mapMatch = url.pathname.match(/^\/api\/maps\/([\w-]{1,40})$/);
      if (mapMatch && req.method === 'GET') return send(200, store.getMap(mapMatch[1]));
      if (mapMatch && req.method === 'DELETE') {
        store.deleteMap(needUser(), mapMatch[1]);
        return send(200, { ok: true });
      }
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      send(err instanceof HttpError ? err.status : 500, { error: err instanceof HttpError ? err.message : 'Server error.' });
    }
  }

  function serveStatic(req, res, url) {
    if (!staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end('Not found');
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    let file = path.join(staticDir, path.normalize(rel));
    if (file !== staticDir && !file.startsWith(staticDir + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticDir, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('The game has not been built yet. Run "npm run build" first.');
      return;
    }
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) api(req, res, url);
    else serveStatic(req, res, url);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => rooms.attach(ws));
  });

  return { server, store, rooms, close: () => new Promise((r) => (wss.close(), server.close(r), server.closeAllConnections())) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  const app = createServer({
    dataFile: process.env.DATA_FILE || path.join(here, 'data', 'db.json'),
    staticDir: path.resolve(here, '..', 'dist'),
  });
  app.server.listen(port, () => console.log(`Turbo Karts is running at http://localhost:${port}`));
  const stop = () => {
    app.store.flush();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
