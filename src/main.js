// App shell: menus, HUD, results, accounts and the versus lobby. The race
// itself lives in game/game.js and the map builder in editor/editor.js.

import { Game } from './game/game.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { LEVELS, KART_COLORS, AI_NAMES } from './game/levels.js';
import { buildTrack, validateDef, formatTime, medalFor, MEDAL_RANK, wrapAngle } from './game/track.js';
import { medalTimes } from './game/physics.js';
import { api } from './net/api.js';
import { Versus } from './net/versus.js';
import { PeerVersus } from './net/peer-versus.js';
import { openSupabaseChannel } from './net/supabase-channel.js';
import { Editor } from './editor/editor.js';
import { storage } from './storage.js';

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder. Text always goes in as text, never as HTML. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

/** Replaces an element's children, skipping the empty results of `cond && element`. */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

// ------------------------------------------------------------------ profile

const PROFILE_KEY = 'tk.profile';
const profile = { name: '', color: 0, progress: {}, maps: [] };
try {
  Object.assign(profile, JSON.parse(storage.get(PROFILE_KEY) || '{}'));
} catch {
  /* start fresh */
}
const saveProfile = () => storage.set(PROFILE_KEY, JSON.stringify(profile));
const playerName = () => api.user?.name || profile.name || 'Player';
const playerColor = () => KART_COLORS[profile.color] || KART_COLORS[0];

/** Best result for a track, combining this device and the signed-in account. */
function progressFor(id) {
  const a = profile.progress[id];
  const b = api.user?.progress?.[id];
  if (!a && !b) return null;
  const times = [a?.best, b?.best].filter((t) => t > 0);
  const rank = Math.max(MEDAL_RANK[a?.medal] || 0, MEDAL_RANK[b?.medal] || 0);
  return { best: times.length ? Math.min(...times) : 0, medal: [null, 'bronze', 'silver', 'gold'][rank] };
}

const canSync = (id) => typeof id === 'string' && !id.startsWith('local-');

function recordResult(id, time, medal) {
  if (!id) return { isBest: false };
  const before = progressFor(id);
  const isBest = !before?.best || time < before.best;
  const cur = profile.progress[id] || {};
  profile.progress[id] = {
    best: cur.best ? Math.min(cur.best, time) : time,
    medal: [null, 'bronze', 'silver', 'gold'][Math.max(MEDAL_RANK[cur.medal] || 0, MEDAL_RANK[medal] || 0)],
  };
  saveProfile();
  if (api.user && canSync(id)) {
    api.submitTime(id, time, medal).then((r) => (api.user.progress[id] = r.record)).catch(() => {});
  }
  return { isBest, before };
}

const medalCache = new Map();
function medalsFor(def) {
  const key = JSON.stringify([def.points, def.width, def.laps, def.checkpoints, def.theme, def.pads, def.obstacles]);
  if (!medalCache.has(key)) medalCache.set(key, medalTimes(def));
  return medalCache.get(key);
}

// ------------------------------------------------------------------- basics

const input = new Input();
const sound = new Sound();
const game = new Game($('view'), input, sound);
// With the game server, versus goes through it. Without one (a plain website),
// boot swaps this for the server-free kind that shares a realtime channel.
let versus = new Versus();
input.bindTouch(document.body);
window.addEventListener('pointerdown', () => sound.unlock(), { capture: true });
window.addEventListener('keydown', () => sound.unlock(), { capture: true });
const isTouch = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', isTouch);

function toast(text, bad = false) {
  const el = h('div', { class: `toast${bad ? ' bad' : ''}` }, text);
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3300);
}

function openModal(...content) {
  fill($('modal-card'), ...content);
  $('modal').hidden = false;
}
const closeModal = () => ($('modal').hidden = true);
$('modal').addEventListener('pointerdown', (e) => e.target === $('modal') && closeModal());

function textDialog(title, text, value, editable = false) {
  return new Promise((resolve) => {
    const area = h('textarea', { readonly: !editable, spellcheck: 'false' });
    area.value = value;
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    openModal(
      h('h3', {}, title),
      h('p', {}, text),
      area,
      h('div', { class: 'row' }, editable && h('button', { class: 'btn primary', onclick: () => done(area.value) }, 'Load'), h('button', { class: 'btn', onclick: () => done(null) }, 'Close')),
    );
    area.focus();
    area.select();
  });
}

function confirmDialog(title, text, yes) {
  return new Promise((resolve) => {
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    openModal(h('h3', {}, title), h('p', {}, text), h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: () => done(true) }, yes), h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel')));
  });
}

// ------------------------------------------------------------------ screens

let screen = 'menu';
let race = null; // { def, mode, medals, id, cupIndex }

function show(name) {
  screen = name;
  for (const s of ['menu', 'levels', 'versus', 'results', 'pause']) $(`s-${s}`).hidden = s !== name;
  const driving = name === 'race' || name === 'pause';
  $('hud').hidden = !driving;
  $('touch').hidden = !(driving && isTouch);
  if (name !== 'editor') editor.hide();
  if (!driving) $('vignette').classList.remove('on');
  input.clear();
  if (['menu', 'levels', 'versus'].includes(name)) backdrop();
  if (name === 'menu') renderMenu();
}

/** Computer karts race behind the menus. */
function backdrop() {
  if (game.mode === 'demo' && game.world) return;
  const def = LEVELS[Math.floor(Math.random() * LEVELS.length)];
  game.load({
    def,
    mode: 'demo',
    rivals: KART_COLORS.slice(0, 6).map((color, i) => ({ name: AI_NAMES[i], color, skill: 0.84 + i * 0.025, slot: i })),
  });
}

// --------------------------------------------------------------------- menu

function renderMenu() {
  $('b-account').textContent = api.user ? api.user.name : api.online ? 'Sign in' : 'Guest';
  $('offline-note').hidden = api.online;
  fill($('colors'), 
    ...KART_COLORS.map((c, i) =>
      h('button', {
        class: i === profile.color ? 'on' : '', style: `--c:${c}`, 'aria-label': `Kart colour ${i + 1}`,
        onclick: () => {
          profile.color = i;
          saveProfile();
          if (api.user) api.setColor(i);
          sound.play('click');
          renderMenu();
        },
      }),
    ),
  );
}

$('b-play').addEventListener('click', () => {
  show('levels');
  renderLevels();
});
$('b-builder').addEventListener('click', () => openEditor(null));
$('b-versus').addEventListener('click', async () => {
  await ready;
  show('versus');
  renderVersus();
});
$('b-settings').addEventListener('click', settingsDialog);
$('b-account').addEventListener('click', accountDialog);
for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => show(b.dataset.go));

function settingsDialog() {
  const seg = (options, current, pick) =>
    h('div', { class: 'seg' }, options.map(([value, label]) => h('button', { class: value === current ? 'on' : '', onclick: () => (pick(value), settingsDialog()) }, label)));
  openModal(
    h('h3', {}, 'Settings'),
    h('span', { class: 'label' }, 'GRAPHICS'),
    seg([['low', 'Fast'], ['medium', 'Balanced'], ['high', 'Best']], game.quality.name, (q) => game.setQuality(q)),
    h('span', { class: 'label' }, 'ENGINE SOUND'),
    seg([['off', 'Off'], ['low', 'Quiet'], ['on', 'Normal']], sound.engineLevel, (v) => sound.setEngine(v)),
    h('span', { class: 'label' }, 'SOUND EFFECTS'),
    seg([[true, 'On'], [false, 'Off']], sound.sfx, (v) => sound.setSfx(v)),
    h('span', { class: 'label' }, 'ALL SOUND'),
    seg([[false, 'On'], [true, 'Muted']], sound.muted, (m) => sound.setMuted(m)),
    h('p', { class: 'note' }, 'Keys: arrows or WASD to drive, Space to drift, R to go back to the last checkpoint, M to mute, Esc to pause. Hold a drift until the sparks turn blue or orange, then let go for a boost. Gamepads work too.'),
    h('button', { class: 'btn', style: 'width:100%;margin-top:14px', onclick: closeModal }, 'Done'),
  );
}

function accountDialog() {
  if (!api.online) return toast('Sign-in needs the game server. You can still play as a guest.', true);
  if (api.user) {
    openModal(
      h('h3', {}, `Signed in as ${api.user.name}`),
      h('p', {}, 'Your medals and best times are saved to your account, and you can share maps online.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          await api.signOut();
          closeModal();
          renderMenu();
          toast('Signed out.');
        } }, 'Sign out'),
        h('button', { class: 'btn primary', onclick: closeModal }, 'Done')),
    );
    return;
  }
  let create = false;
  const name = h('input', { maxlength: 16, autocomplete: 'username', placeholder: '3 to 16 letters or numbers' });
  const pass = h('input', { type: 'password', maxlength: 128, autocomplete: 'current-password', placeholder: 'At least 6 characters' });
  const error = h('p', { class: 'form-error' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const tabs = h('div', { class: 'seg' });
  const drawTabs = () => {
    fill(tabs, 
      h('button', { type: 'button', class: create ? '' : 'on', onclick: () => ((create = false), drawTabs()) }, 'Sign in'),
      h('button', { type: 'button', class: create ? 'on' : '', onclick: () => ((create = true), drawTabs()) }, 'New account'),
    );
    submit.textContent = create ? 'Create account' : 'Sign in';
    pass.autocomplete = create ? 'new-password' : 'current-password';
    error.textContent = '';
  };
  drawTabs();
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api.signIn(name.value.trim(), pass.value, create);
        // Bring results earned as a guest into the account.
        for (const [id, p] of Object.entries(profile.progress)) {
          if (canSync(id) && p.best) api.submitTime(id, p.best, p.medal).then((r) => (api.user.progress[id] = r.record)).catch(() => {});
        }
        if (create) api.setColor(profile.color);
        else if (Number.isInteger(api.user.color)) profile.color = api.user.color;
        saveProfile();
        closeModal();
        renderMenu();
        toast(`Welcome, ${api.user.name}!`);
      } catch (err) {
        error.textContent = err.message;
      }
      submit.disabled = false;
    },
  }, h('label', {}, 'Name', name), h('label', {}, 'Password', pass), error, h('div', { class: 'row' }, submit, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel')));
  openModal(h('h3', {}, 'Your account'), tabs, form);
  name.focus();
}

// ------------------------------------------------------------- track select

const THEME_COLORS = { meadow: ['#2f6e33', '#e9f5e6'], desert: ['#b98d4c', '#3a2a12'], snow: ['#c9d6e4', '#243447'], neon: ['#140c30', '#00f0ff'] };
const trackCache = new WeakMap();
function trackOf(def) {
  if (!trackCache.has(def)) trackCache.set(def, buildTrack(def));
  return trackCache.get(def);
}

function trackPreview(def) {
  const t = trackOf(def);
  const b = t.bounds;
  const pad = t.width + 6;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `${b.minX - pad} ${b.minZ - pad} ${b.maxX - b.minX + pad * 2} ${b.maxZ - b.minZ + pad * 2}`);
  const [bg, fg] = THEME_COLORS[def.theme] || THEME_COLORS.meadow;
  svg.style.setProperty('--tbg', bg);
  const d = t.samples.filter((_, i) => i % 3 === 0).map((s, i) => `${i ? 'L' : 'M'}${s.x.toFixed(1)} ${s.z.toFixed(1)}`).join('') + 'Z';
  for (const [color, width] of [['rgba(0,0,0,0.35)', t.width + 5], [fg, t.width * 0.8]]) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', width);
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  const g0 = t.gates[0];
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', g0.x);
  dot.setAttribute('cy', g0.z);
  dot.setAttribute('r', t.width * 0.6);
  dot.setAttribute('fill', '#ff5a1f');
  svg.append(dot);
  return svg;
}

let levelTab = 'cups';
let selected = null; // { def, kind, index }
let community = null;

for (const b of $('level-tabs').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    levelTab = b.dataset.tab;
    selected = null;
    renderLevels();
  });
}

const laps = (n) => `${n} ${n === 1 ? 'lap' : 'laps'}`;
const cupUnlocked = (i) => i === 0 || !!progressFor(LEVELS[i - 1].id)?.medal;

async function renderLevels() {
  for (const b of $('level-tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === levelTab);
  const grid = $('level-grid');
  let items = [];
  if (levelTab === 'cups') items = LEVELS.map((def, index) => ({ def, kind: 'cup', index, locked: !cupUnlocked(index) }));
  else if (levelTab === 'mine') items = profile.maps.map((def, index) => ({ def, kind: 'mine', index }));
  else {
    if (!api.online) {
      fill(grid, h('div', { class: 'empty' }, 'Community maps need the game server.'));
      fill($('level-detail'));
      return;
    }
    if (!community) {
      fill(grid, h('div', { class: 'empty' }, 'Loading maps…'));
      try {
        community = (await api.maps()).filter((m) => {
          try {
            validateDef(m.def);
            return true;
          } catch {
            return false;
          }
        });
      } catch (err) {
        fill(grid, h('div', { class: 'empty' }, err.message));
        return;
      }
      if (levelTab !== 'community') return;
    }
    items = community.map((m, index) => ({ def: m.def, kind: 'community', index }));
  }
  if (!items.length) {
    fill(grid, 
      h('div', { class: 'empty' }, levelTab === 'mine' ? 'You have not made any maps yet. ' : 'Nobody has shared a map yet. Be the first! ', h('button', { class: 'btn', onclick: () => openEditor(null) }, 'Open the map builder')),
    );
    fill($('level-detail'));
    return;
  }
  if (!selected) selected = items.find((i) => !i.locked) || null;
  fill(grid, 
    ...items.map((item) => {
      const def = item.def;
      const p = progressFor(def.id);
      const on = selected && selected.kind === item.kind && selected.index === item.index;
      return h('button', { class: `level${on ? ' on' : ''}${item.locked ? ' locked' : ''}`, onclick: () => pickLevel(item) },
        trackPreview(def),
        h('div', { class: 'name' }, def.name),
        h('div', { class: 'meta' },
          h('span', {}, item.kind === 'community' ? `by ${def.author}` : p?.best ? formatTime(p.best) : laps(def.laps)),
          h('span', { class: `medal ${p?.medal || 'none'}` })),
        item.locked && h('div', { class: 'lock' }, `Earn a medal on ${LEVELS[item.index - 1].name} to unlock`),
      );
    }),
  );
  renderDetail();
}

function pickLevel(item) {
  if (item.locked) return toast(`Earn a medal on ${LEVELS[item.index - 1].name} first.`);
  sound.play('click');
  selected = item;
  renderLevels();
}

function renderDetail() {
  const box = $('level-detail');
  if (!selected?.def) return fill(box, h('p', { class: 'note' }, 'Pick a track to see its medal times.'));
  const { def, kind, index } = selected;
  const m = medalsFor(def);
  const p = progressFor(def.id);
  const board = h('ul', { class: 'board' });
  fill(box, 
    h('h3', {}, def.name),
    h('p', { class: 'blurb' }, def.blurb || (def.author ? `A map by ${def.author}.` : 'One of your own maps.')),
    h('div', { class: 'label' }, `${laps(def.laps).toUpperCase()} · ${trackOf(def).gates.length} CHECKPOINTS · ${Math.round(trackOf(def).length)} M`),
    h('div', { class: 'targets-list' },
      ['gold', 'silver', 'bronze'].map((k) => h('div', {}, h('i', { class: `medal ${k}` }), k[0].toUpperCase() + k.slice(1), h('span', {}, formatTime(m[k])))),
      h('div', {}, h('i', { class: `medal ${p?.medal || 'none'}` }), 'Your best', h('span', {}, formatTime(p?.best)))),
    h('button', { class: 'btn primary', onclick: () => startRace(def, { mode: 'race', cupIndex: kind === 'cup' ? index : -1 }) }, 'RACE'),
    kind === 'mine' && h('button', { class: 'btn', onclick: () => openEditor(def) }, 'Edit in builder'),
    kind === 'community' && h('button', { class: 'btn', onclick: () => openEditor({ ...def, id: undefined, author: undefined, name: `${def.name} remix`.slice(0, 32) }) }, 'Remix in builder'),
    kind === 'mine' && h('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmDialog('Delete this map?', `"${def.name}" will be removed from this device.`, 'Delete'))) return;
      profile.maps.splice(index, 1);
      saveProfile();
      selected = null;
      renderLevels();
    } }, 'Delete'),
    kind === 'community' && api.user && def.author === api.user.name && h('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmDialog('Remove this shared map?', `"${def.name}" will disappear for everyone.`, 'Remove'))) return;
      try {
        await api.deleteMap(def.id);
      } catch (err) {
        return toast(err.message, true);
      }
      community = null;
      selected = null;
      renderLevels();
    } }, 'Remove from community'),
    board,
  );
  if (api.online && canSync(def.id) && def.id) {
    api.leaderboard(def.id).then((rows) => {
      if (selected?.def !== def || !rows.length) return;
      fill(board, h('div', { class: 'label', style: 'margin-bottom:6px' }, 'FASTEST RACERS'), ...rows.map((r, i) => h('li', {}, h('b', {}, i + 1), r.name, h('span', {}, formatTime(r.time)))));
    }).catch(() => {});
  }
}

// --------------------------------------------------------------------- race

function startRace(def, opts) {
  closeModal();
  race = { def, mode: opts.mode, id: def.id, cupIndex: opts.cupIndex ?? -1, medals: medalsFor(def), done: false };
  let rivals = [];
  if (opts.mode === 'race') {
    const colors = KART_COLORS.filter((_, i) => i !== profile.color);
    rivals = [0.985, 0.955, 0.925, 0.89, 0.85].map((skill, i) => ({ name: AI_NAMES[i], color: colors[i], skill, slot: i }));
  }
  game.load({ def, mode: opts.mode, player: { name: playerName(), color: playerColor() }, slot: rivals.length, rivals });
  beginHud();
  show('race');
  setTimeout(() => race && !race.done && game.state === 'idle' && game.startCountdown(3500), 500);
}

const hudEls = {};
for (const id of ['lap', 'laps', 'gate', 'gates', 'pips', 'time', 'medals', 'place', 'map', 'speed', 'charge', 'msg', 'warn', 'arrow', 'warn-text', 'count', 'wait']) hudEls[id] = $(`h-${id}`);
let hudCache = {};
let mapImage = null;

function beginHud() {
  hudCache = {};
  const t = game.track;
  fill(hudEls.pips, ...t.gates.map(() => h('span')));
  hudEls.laps.textContent = `/${t.laps}`;
  hudEls.gates.textContent = `/${t.gates.length}`;
  hudEls.count.textContent = '';
  hudEls.count.className = 'count';
  hudEls.msg.className = 'msg';
  hudEls.wait.hidden = true;
  hudEls.warn.hidden = true;
  const m = race.medals;
  fill(hudEls.medals, ...['gold', 'silver', 'bronze'].map((k) => h('span', { 'data-m': k }, h('i', { class: `medal small ${k}` }), formatTime(m[k]))));
  hudEls.medals.hidden = race.mode === 'versus';

  // Draw the minimap road once; karts are dotted on top each frame.
  const size = hudEls.map.width;
  const b = t.bounds;
  const scale = (size - 36) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const tx = (x) => (x - b.cx) * scale + size / 2;
  const tz = (z) => (z - b.cz) * scale + size / 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.lineJoin = g.lineCap = 'round';
  g.beginPath();
  t.samples.forEach((s, i) => (i ? g.lineTo(tx(s.x), tz(s.z)) : g.moveTo(tx(s.x), tz(s.z))));
  g.closePath();
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = Math.max(9, t.width * scale + 5);
  g.stroke();
  g.strokeStyle = '#e8ecf5';
  g.lineWidth = Math.max(5, t.width * scale);
  g.stroke();
  mapImage = { c, tx, tz };
}

function setText(key, el, value) {
  if (hudCache[key] === value) return;
  hudCache[key] = value;
  el.textContent = value;
}

function flash(text) {
  hudEls.msg.textContent = text;
  hudEls.msg.className = 'msg';
  void hudEls.msg.offsetWidth;
  hudEls.msg.className = 'msg show';
}

const ORDINAL = ['th', 'st', 'nd', 'rd'];
const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ORDINAL[n % 10] || 'th');

game.onHud = (d) => {
  if (screen !== 'race' && screen !== 'pause') return;
  if (input.take('pause') && screen === 'race' && !race.done) pauseRace();
  setText('lap', hudEls.lap, d.lap);
  setText('gate', hudEls.gate, d.gate);
  if (hudCache.pips !== d.gate) {
    hudCache.pips = d.gate;
    [...hudEls.pips.children].forEach((p, i) => p.classList.toggle('on', i < d.gate));
  }
  setText('time', hudEls.time, formatTime(d.time || 0.0001).replace('--:--.--', '0:00.00'));
  setText('speed', hudEls.speed, Math.round(d.speed));
  const m = race.medals;
  const pace = race.mode === 'versus' ? '' : d.time <= m.gold ? 'gold' : d.time <= m.silver ? 'silver' : d.time <= m.bronze ? 'bronze' : '';
  if (hudCache.pace !== pace) {
    hudCache.pace = pace;
    hudEls.time.className = `timer ${pace}`;
    for (const s of hudEls.medals.children) s.classList.toggle('gone', (MEDAL_RANK[s.dataset.m] || 0) > (MEDAL_RANK[pace] || 0));
  }
  const place = d.showPlace ? d.place : 0;
  if (hudCache.place !== `${place}/${d.racers}`) {
    hudCache.place = `${place}/${d.racers}`;
    hudEls.place.hidden = !place;
    fill(hudEls.place, h('b', {}, place), h('sup', {}, ordinal(place)), h('i', {}, `/${d.racers}`));
  }
  const charge = d.charge;
  if (hudCache.charge !== charge) {
    hudCache.charge = charge;
    hudEls.charge.className = `charge${charge >= 0 ? ' on' : ''}${charge > 0 ? ` l${charge}` : ''}`;
  }
  if (charge >= 0) hudEls.charge.firstElementChild.style.width = `${Math.min(100, (d.kart.driftCharge / 2.1) * 100)}%`;
  if (hudCache.boost !== d.boost) {
    hudCache.boost = d.boost;
    $('vignette').classList.toggle('on', d.boost);
  }
  const warn = d.finished ? '' : d.missed ? 'MISSED A CHECKPOINT! GO BACK' : d.wrongWay ? 'WRONG WAY' : d.lost ? `PRESS ${isTouch ? 'RESET' : 'R'} TO GET BACK ON TRACK` : '';
  if (hudCache.warn !== warn) {
    hudCache.warn = warn;
    hudEls.warn.hidden = !warn;
    hudEls['warn-text'].textContent = warn;
  }
  if (warn) {
    const g = d.nextGate;
    const bearing = wrapAngle(Math.atan2(g.x - d.kart.x, g.z - d.kart.z) - d.kart.heading);
    hudEls.arrow.style.transform = `rotate(${(-bearing * 180) / Math.PI}deg)`;
  }

  // minimap
  const ctx = hudEls.map.getContext('2d');
  const size = hudEls.map.width;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(mapImage.c, 0, 0);
  const g = d.nextGate;
  ctx.fillStyle = '#35ff9a';
  ctx.beginPath();
  ctx.arc(mapImage.tx(g.x), mapImage.tz(g.z), 9, 0, Math.PI * 2);
  ctx.fill();
  for (const r of [...game.racers].reverse()) {
    const me = r === game.player;
    ctx.beginPath();
    ctx.arc(mapImage.tx(r.kart.x), mapImage.tz(r.kart.z), me ? 11 : 8, 0, Math.PI * 2);
    ctx.fillStyle = r.color;
    ctx.fill();
    ctx.lineWidth = me ? 4 : 2;
    ctx.strokeStyle = me ? '#fff' : '#10131c';
    ctx.stroke();
  }
};

game.onEvent = (type, data) => {
  if (!race || game.mode === 'demo') return;
  switch (type) {
    case 'count':
    case 'go':
      hudEls.count.textContent = type === 'go' ? 'GO!' : data;
      hudEls.count.className = 'count';
      void hudEls.count.offsetWidth;
      hudEls.count.className = `count tick${type === 'go' ? ' go' : ''}`;
      sound.play(type);
      break;
    case 'gate':
      sound.play('gate');
      break;
    case 'lap':
      sound.play('lap');
      flash(data.lap === game.track.laps ? 'FINAL LAP!' : `LAP ${data.lap}`);
      break;
    case 'missed':
      sound.play('missed');
      break;
    case 'boost':
      sound.play('boost');
      break;
    case 'bump':
      sound.play('bump');
      break;
    case 'jump':
      sound.play('jump');
      break;
    case 'land':
      sound.play('bump');
      break;
    case 'fell':
      sound.play('missed');
      flash('TOO SLOW!');
      break;
    case 'oil':
      sound.play('oil');
      flash('OIL!');
      break;
    case 'finish':
      sound.play('finish');
      flash('FINISH!');
      race.done = true;
      if (race.mode === 'versus') {
        versus.send({ t: 'finish', time: data.time });
        hudEls.wait.hidden = false;
        hudEls.wait.textContent = `You finished in ${formatTime(data.time)}. Waiting for the others…`;
      } else {
        setTimeout(() => race?.done && screen === 'race' && showResults(data), 2200);
      }
      break;
    default:
  }
};

function showResults(data) {
  const { def, medals, mode, cupIndex } = race;
  const medal = medalFor(data.time, medals);
  const saved = mode === 'race' ? recordResult(race.id, data.time, medal) : { isBest: false };
  $('r-medal').className = `medal big ${medal || 'none'}`;
  $('r-medal').hidden = false;
  $('r-title').textContent = medal ? `${medal[0].toUpperCase()}${medal.slice(1)} medal!` : 'Finished, but no medal';
  $('r-time').textContent = formatTime(data.time);
  const next = medal === 'gold' ? null : medal === 'silver' ? 'gold' : medal === 'bronze' ? 'silver' : 'bronze';
  const parts = [];
  if (mode === 'race') parts.push(`You came ${data.place}${ordinal(data.place)}.`);
  if (saved.isBest && mode === 'race') parts.push('New personal best!');
  if (next) parts.push(`${next[0].toUpperCase()}${next.slice(1)} needs ${formatTime(medals[next])}, ${(data.time - medals[next]).toFixed(2)}s faster.`);
  if (mode === 'test') parts.push('Test drives are not saved.');
  $('r-sub').textContent = parts.join(' ');
  fill($('r-table'), h('table', {}, data.laps.map((t, i) => h('tr', {}, h('td', {}, `Lap ${i + 1}`), h('td', {}, formatTime(t))))));
  const nextCup = cupIndex >= 0 && cupIndex < LEVELS.length - 1 && cupUnlocked(cupIndex + 1) ? LEVELS[cupIndex + 1] : null;
  fill($('r-buttons'), 
    nextCup && h('button', { class: 'btn primary', onclick: () => startRace(nextCup, { mode: 'race', cupIndex: cupIndex + 1 }) }, 'Next track'),
    h('button', { class: `btn${nextCup ? '' : ' primary'}`, onclick: () => startRace(def, { mode, cupIndex }) }, 'Race again'),
    mode === 'test'
      ? h('button', { class: 'btn', onclick: () => openEditor() }, 'Back to builder')
      : h('button', { class: 'btn', onclick: () => {
        selected = null;
        show('levels');
        renderLevels();
      } }, 'Tracks'),
  );
  show('results');
}

function pauseRace() {
  game.setPaused(true);
  $('b-restart').hidden = race.mode === 'versus';
  $('b-quit').textContent = race.mode === 'versus' ? 'Leave race' : race.mode === 'test' ? 'Back to builder' : 'Quit race';
  $('s-pause').querySelector('h2').textContent = race.mode === 'versus' ? 'Leave the race?' : 'Paused';
  show('pause');
}
$('b-sound').addEventListener('click', settingsDialog);
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  sound.setMuted(!sound.muted);
  toast(sound.muted ? 'Sound off' : 'Sound on');
});
$('b-resume').addEventListener('click', () => {
  game.setPaused(false);
  show('race');
});
$('b-restart').addEventListener('click', () => startRace(race.def, race));
$('b-quit').addEventListener('click', () => {
  const mode = race.mode;
  race = null;
  if (mode === 'versus') {
    versus.leave();
    show('versus');
    renderVersus();
  } else if (mode === 'test') openEditor();
  else {
    show('levels');
    renderLevels();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && screen === 'race' && race && !race.done && race.mode !== 'versus') pauseRace();
});

// ------------------------------------------------------------------- editor

const editor = new Editor({
  toast,
  textDialog,
  onExit: () => show('menu'),
  onTest: (def) => startRace(def, { mode: 'test' }),
  onSave: (def) => {
    saveMap(def);
    toast('Saved to My maps.');
  },
  onPublish: async (def) => {
    if (!api.online) return toast('Sharing needs the game server.', true);
    if (!api.user) {
      toast('Sign in to share your map.');
      return accountDialog();
    }
    saveMap(def);
    try {
      await api.publish({ ...def, id: undefined });
      community = null;
      toast('Shared! Find it under Community.');
    } catch (err) {
      toast(err.message, true);
    }
  },
});

function saveMap(def) {
  if (!def.id || !def.id.startsWith('local-')) def.id = `local-${Math.random().toString(16).slice(2, 10)}`;
  editor.def.id = def.id;
  const i = profile.maps.findIndex((m) => m.id === def.id);
  if (i >= 0) profile.maps[i] = def;
  else profile.maps.unshift(def);
  saveProfile();
  editor.dirty = false;
}

/** Opens the builder. Pass a def to load it, null for a blank map, nothing to keep the current one. */
function openEditor(def) {
  race = null;
  game.unload();
  show('editor');
  editor.show(def === null ? { points: [] } : def);
}

// ------------------------------------------------------------------- versus

function renderVersus() {
  const room = versus.room;
  $('vs-join').hidden = !!room;
  $('vs-lobby').hidden = !room;
  $('vs-name-row').hidden = !!api.user;
  if (!room) {
    if (!$('vs-name').value) $('vs-name').value = profile.name;
    return;
  }
  const host = versus.isHost;
  $('vs-room-code').textContent = room.code;
  fill($('vs-players'), 
    ...room.players.map((p) => h('li', {}, h('i', { style: `--c:${KART_COLORS[p.color] || KART_COLORS[0]}` }), p.name, p.id === versus.id && ' (you)', p.id === room.hostId && h('em', {}, 'HOST'))),
  );
  $('vs-track').textContent = `${room.track.name} · ${laps(room.track.laps)}`;
  $('vs-track-pick-row').hidden = !host;
  if (host) {
    const options = [...LEVELS, ...profile.maps];
    fill($('vs-track-pick'), ...options.map((d, i) => h('option', { value: i, selected: d.id === room.track.id }, LEVELS.includes(d) ? d.name : `${d.name} (your map)`)));
    $('vs-track-pick').onchange = (e) => versus.send({ t: 'track', track: options[+e.target.value] });
  }
  const racing = room.state !== 'lobby';
  $('b-vs-start').hidden = !host;
  $('b-vs-start').disabled = racing;
  $('vs-status').textContent = racing
    ? 'A race is running. You will join the next one.'
    : host
      ? room.players.length < 2 ? 'Send the code to your friends, or start now to race alone.' : 'Everyone here? Hit start!'
      : 'Waiting for the host to start the race…';
}

async function vsConnect() {
  if (!api.user) {
    profile.name = $('vs-name').value.replace(/[^\w \-]/g, '').trim().slice(0, 16);
    saveProfile();
  }
  await versus.connect({ name: playerName(), token: api.token, color: profile.color });
}

$('b-vs-create').addEventListener('click', async () => {
  try {
    await vsConnect();
    versus.send({ t: 'create' });
  } catch (err) {
    toast(err.message, true);
  }
});
async function vsJoin(code) {
  if (!/^[A-Za-z0-9]{5}$/.test(code)) return toast('Room codes are 5 letters or numbers.', true);
  try {
    await vsConnect();
    versus.send({ t: 'join', code });
  } catch (err) {
    toast(err.message, true);
  }
}
$('b-vs-join').addEventListener('click', () => vsJoin($('vs-code').value.trim()));
$('vs-code').addEventListener('keydown', (e) => e.key === 'Enter' && vsJoin($('vs-code').value.trim()));
$('b-vs-back').addEventListener('click', () => {
  if (versus.room) {
    versus.leave();
    renderVersus();
  } else show('menu');
});
$('b-vs-copy').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?room=${versus.room.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied.');
  } catch {
    textDialog('Invite link', 'Send this link to your friends.', link);
  }
});
$('b-vs-start').addEventListener('click', () => versus.send({ t: 'start' }));

let netTimer = null;
versus.on = (type, m) => {
  switch (type) {
    case 'room':
      if (screen === 'versus') renderVersus();
      // If the host left during the results, the new host needs the lobby button.
      if (screen === 'results' && race?.mode === 'versus' && lastResults && m.room.state !== 'lobby') showVersusResults(lastResults);
      // The host sent everyone back to the lobby.
      if (m.room.state === 'lobby' && race?.mode === 'versus') {
        race = null;
        show('versus');
        renderVersus();
      }
      break;
    case 'error':
      toast(m.msg, true);
      break;
    case 'countdown': {
      const room = versus.room;
      const def = room.track;
      closeModal();
      race = { def, mode: 'versus', id: null, cupIndex: -1, medals: medalsFor(def), done: false };
      const rivals = room.players.filter((p) => p.id !== versus.id && p.id in m.slots).map((p) => ({ id: p.id, name: p.name, color: KART_COLORS[p.color] || KART_COLORS[0], remote: true, slot: m.slots[p.id] }));
      const me = room.players.find((p) => p.id === versus.id);
      game.load({ def, mode: 'versus', player: { name: playerName(), color: KART_COLORS[me?.color] || playerColor() }, slot: m.slots[versus.id] ?? 0, rivals });
      beginHud();
      show('race');
      game.startCountdown(m.startIn);
      clearInterval(netTimer);
      netTimer = setInterval(() => {
        if (race?.mode !== 'versus' || !game.player) return clearInterval(netTimer);
        versus.send({ t: 'state', s: game.playerNetState() });
      }, versus.sendMs || 66);
      break;
    }
    case 'state':
      if (race?.mode === 'versus') game.remoteState(m.id, m.s);
      break;
    case 'finished':
      if (race?.mode === 'versus') game.remoteFinished(m.id, m.time);
      break;
    case 'left':
      if (race?.mode === 'versus') game.removeRacer(m.id);
      break;
    case 'results':
      if (race?.mode === 'versus') showVersusResults(m.results);
      break;
    case 'closed':
      if (race?.mode === 'versus' || screen === 'versus') {
        race = null;
        toast('Lost the connection to the room.', true);
        show('versus');
        renderVersus();
      }
      break;
    default:
  }
};

let lastResults = null;
function showVersusResults(results) {
  lastResults = results;
  race.done = true;
  const mine = results.findIndex((r) => r.id === versus.id);
  const me = results[mine];
  $('r-medal').hidden = true;
  $('r-title').textContent = !me?.time ? 'Race over' : mine === 0 ? 'You won!' : `You came ${mine + 1}${ordinal(mine + 1)}`;
  $('r-time').textContent = me?.time ? formatTime(me.time) : '';
  $('r-sub').textContent = versus.room?.track.name || '';
  fill($('r-table'), 
    h('table', {}, results.map((r, i) => h('tr', { class: r.id === versus.id ? 'me' : '' }, h('td', {}, r.time ? i + 1 : '-'), h('td', {}, r.name), h('td', {}, r.time ? formatTime(r.time) : 'Did not finish')))),
  );
  fill($('r-buttons'), 
    versus.isHost
      ? h('button', { class: 'btn primary', onclick: () => versus.send({ t: 'lobby' }) }, 'Back to lobby')
      : h('p', { class: 'note', style: 'flex:1' }, 'Waiting for the host to go back to the lobby…'),
    h('button', { class: 'btn', onclick: () => {
      versus.leave();
      race = null;
      show('versus');
      renderVersus();
    } }, 'Leave room'),
  );
  show('results');
}

// --------------------------------------------------------------------- boot

show('menu');
const ready = api.init().then(() => {
  if (!api.online) {
    const handler = versus.on;
    versus = new PeerVersus(openSupabaseChannel);
    versus.on = handler;
  }
  if (api.user && Number.isInteger(api.user.color) && !storage.get(PROFILE_KEY)) profile.color = api.user.color;
  if (screen === 'menu') renderMenu();
  const code = new URLSearchParams(location.search).get('room');
  if (code) {
    history.replaceState(null, '', location.pathname);
    show('versus');
    renderVersus();
    $('vs-code').value = code.toUpperCase().slice(0, 5);
    if (api.user || profile.name) vsJoin(code);
    else toast('Type your name, then press Join.');
  }
});

// Handy for debugging from the browser console.
window.__tk = { game, api, profile, editor, get versus() { return versus; } };
