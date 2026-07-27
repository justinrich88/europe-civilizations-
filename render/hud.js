// render/hud.js — renderHud(state).
//
// The chrome around the board: territory count, total forces, day counter,
// power strip, event ticker. 00-vision.md §8 sketches it exactly:
//
//   │  Territories 14/48   Forces 312   ⏸ 1x 2x 4x   │ Day 42  │
//   │  send: 25 · 50 · [75] · All     powers + event ticker    │
//
// This function runs EVERY FRAME, at up to 60fps, alongside renderLive() and
// renderWaves(). So the rule from 01-data-schema.md that governs renderLive
// governs this file too: **mutate existing DOM nodes, never rebuild them**.
// Rebuilding the power strip and the ticker sixty times a second is both
// wasteful and visibly wrong — it kills text selection, and `aria-live` on the
// ticker would re-announce the same events forever.
//
// The pattern used throughout: compute a cheap value, compare it to the last
// one written, and touch the DOM only on a change. Most frames do nothing.
//
// Reads window.PLAYER (set by app/main.js) for whose numbers to show, and
// countTerritories() / powerForces() from core/state.js. Never mutates state.

'use strict';

// ── sim time -> days ────────────────────────────────────────────────────
//
// The sim has no calendar; `state.tick` is the only clock. The scale is a
// presentation choice made here, once.
//
// Chosen: ONE SIM-SECOND = ONE DAY, i.e. BAL.TICKS_PER_SEC (10) ticks per day.
// Rationale from data/tuning.js: a 20-minute game is ~12,000 ticks, which at
// this scale reads as ~1,200 days — a hair over three years, which lands a
// full-length game squarely on the 1914-1918 span the scenario is set in.
// It also makes the numbers legible: a ~20s battle is a two-day engagement,
// a long march is a few days, and rebuilding a gutted city (~1,220 ticks) is
// the better part of a campaign season. Day 0 is 28 June 1914.
const HUD_TICKS_PER_DAY = 10;

function hudTicksPerDay() {
  // Known-issues #3: bare `typeof`, never `window.BAL` — top-level `const` in a
  // classic script never lands on the global object.
  if (typeof BAL !== 'undefined' && isFinite(BAL.TICKS_PER_SEC) && BAL.TICKS_PER_SEC > 0) {
    return BAL.TICKS_PER_SEC;
  }
  if (typeof BAL !== 'undefined' && isFinite(BAL.TICK_MS) && BAL.TICK_MS > 0) {
    return Math.max(1, Math.round(1000 / BAL.TICK_MS));
  }
  return HUD_TICKS_PER_DAY;
}

// ── cached nodes and last-written values ────────────────────────────────
//
// `var` at top level so these are inspectable from the console, matching
// core/state.js. The cache is refreshed if the document changes underneath us
// (which in practice only happens in the test harness).

var _hudNodes = null;

// Last values actually written to the DOM. `undefined` means "never written",
// which is distinct from any legitimate value, so the first frame always paints.
var _hudLast = {
  territories: undefined,
  forces: undefined,
  day: undefined,
};

// Power strip: one chip per power, built once, then only its number and its
// dead/alive class are touched.
var _hudChips = null;          // pid -> { row, count, chip }
var _hudChipLast = null;       // pid -> { n, alive }

// Ticker: the tail of state.log. We reuse <li> nodes and only rewrite text.
var _hudTickerItems = [];      // live <li> nodes, index 0 = newest
var _hudTickerLastLen = -1;
var _hudTickerLastTail = null; // identity of the newest log entry

const HUD_TICKER_MAX = 8;

function hudNodes() {
  if (_hudNodes && _hudNodes.territories && _hudNodes.territories.isConnected) {
    return _hudNodes;
  }
  _hudNodes = {
    territories: byId('stat-territories'),
    forces: byId('stat-forces'),
    day: byId('stat-day'),
    strip: byId('powers-strip'),
    ticker: byId('ticker-list'),
  };
  // A re-cache means the DOM was replaced; every memo is now stale.
  _hudLast = { territories: undefined, forces: undefined, day: undefined };
  _hudChips = null;
  _hudChipLast = null;
  _hudTickerItems = [];
  _hudTickerLastLen = -1;
  _hudTickerLastTail = null;
  return _hudNodes;
}

// Single write point, so "skip work when nothing changed" is enforced in one
// place rather than remembered at five call sites.
function setTextIfChanged(node, key, value) {
  if (!node || _hudLast[key] === value) return false;
  _hudLast[key] = value;
  node.textContent = value;
  return true;
}

// ── ownership colour ────────────────────────────────────────────────────
//
// Mirrors powerColor() in render/map.js: colour carries ownership and nothing
// else (00-vision.md §8), so the chip swatch must be the exact colour the
// player sees on the map.
function hudPowerColor(pid) {
  if (typeof POWERS === 'undefined' || !POWERS[pid]) return null;
  return POWERS[pid].color || null;
}

function hudPowerName(pid) {
  if (typeof POWERS !== 'undefined' && POWERS[pid] && POWERS[pid].name) {
    return POWERS[pid].name;
  }
  return pid;
}

// ── stat block ──────────────────────────────────────────────────────────

function hudStats(state, nodes) {
  const me = window.PLAYER;

  // Territories counts MAJORITY control, matching countTerritories() and the
  // victory metric — not "stations owned". Holding half a country is worth
  // nothing on this readout, which is the point (00-vision.md §3).
  const total = (typeof TERRITORY_IDS !== 'undefined' && TERRITORY_IDS.length)
    ? TERRITORY_IDS.length
    : (typeof TERRITORIES !== 'undefined' ? Object.keys(TERRITORIES).length : 0);

  let held = 0;
  if (typeof countTerritories === 'function' && me) held = countTerritories(state, me);
  setTextIfChanged(nodes.territories, 'territories', held + '/' + total);

  // Unit counts are floats (01-data-schema.md); floor only at render — here.
  let forces = 0;
  if (typeof powerForces === 'function' && me) forces = powerForces(state, me);
  setTextIfChanged(nodes.forces, 'forces', String(Math.floor(forces)));

  const day = Math.floor((state.tick || 0) / hudTicksPerDay());
  setTextIfChanged(nodes.day, 'day', String(day));
}

// ── power strip ─────────────────────────────────────────────────────────
//
// render/map.js draws a provisional legend into #powers-strip so the colours
// are legible before this file exists; the comment there says hud.js should
// take it over. We do, once, and mark the node so we know not to do it again.

function buildPowerStrip(strip) {
  while (strip.firstChild) strip.removeChild(strip.firstChild);
  _hudChips = Object.create(null);
  _hudChipLast = Object.create(null);

  const ids = (typeof POWER_IDS !== 'undefined' && POWER_IDS.length)
    ? POWER_IDS
    : (typeof POWERS !== 'undefined' ? Object.keys(POWERS).sort() : []);

  for (const pid of ids) {
    if (pid === 'neutral') continue;      // neutral is empty ground, not a power

    const chip = el('span', 'power-chip', { 'data-power': pid, title: hudPowerName(pid) });

    const sw = el('span', 'power-swatch');
    const color = hudPowerColor(pid);
    if (color) sw.style.background = color;
    chip.appendChild(sw);

    // Short id rather than the full name: seven "German Empire"s do not fit in
    // the bottom bar, and the swatch is already carrying the identity.
    chip.appendChild(el('span', 'power-name', { text: pid.toUpperCase() }));

    const count = el('span', 'power-count', { text: '0' });
    chip.appendChild(count);

    strip.appendChild(chip);
    _hudChips[pid] = { chip: chip, count: count };
    _hudChipLast[pid] = { n: -1, alive: null };
  }

  strip.setAttribute('data-hud-built', '1');
}

function hudPowerStrip(state, nodes) {
  const strip = nodes.strip;
  if (!strip) return;

  // Rebuild only if the strip has never been built, or renderBoard() blew it
  // away and re-seeded it with the provisional legend.
  if (!_hudChips || strip.getAttribute('data-hud-built') !== '1') {
    buildPowerStrip(strip);
  }

  for (const pid in _hudChips) {
    const rec = _hudChips[pid];
    const last = _hudChipLast[pid];

    const p = state.powers && state.powers[pid];
    const alive = p ? !!p.alive : false;
    const n = (typeof countTerritories === 'function') ? countTerritories(state, pid) : 0;

    if (n !== last.n) {
      last.n = n;
      rec.count.textContent = String(n);
    }
    // Dead powers stay on the strip, struck through — .power-chip.is-dead in
    // style.css. Who has been knocked out is as informative as who is winning,
    // and removing the chip would silently reflow every other one.
    if (alive !== last.alive) {
      last.alive = alive;
      rec.chip.classList.toggle('is-dead', !alive);
    }
  }
}

// ── ticker ──────────────────────────────────────────────────────────────
//
// state.log entries are { tick, kind, text } and core/state.js caps the array
// at 400 with a shift(), so length alone is not a change signal once the cap is
// hit. We compare the identity of the newest entry as well — cheap, and exact.

function hudTicker(state, nodes) {
  const list = nodes.ticker;
  if (!list) return;

  const log = state.log || [];
  const len = log.length;
  const tail = len ? log[len - 1] : null;
  if (len === _hudTickerLastLen && tail === _hudTickerLastTail) return;
  _hudTickerLastLen = len;
  _hudTickerLastTail = tail;

  const show = Math.min(HUD_TICKER_MAX, len);

  // Grow/shrink the pool of <li> nodes to match, then rewrite text in place.
  // The list only ever changes by a few entries, so this is a handful of DOM
  // writes on the frames where anything happened and none on the rest.
  while (_hudTickerItems.length < show) {
    const li = el('li', 'ticker-item');
    list.appendChild(li);
    _hudTickerItems.push(li);
  }
  while (_hudTickerItems.length > show) {
    const li = _hudTickerItems.pop();
    if (li.parentNode) li.parentNode.removeChild(li);
  }

  // Newest first in DOM order. style.css lays .ticker-list out with
  // flex-direction: column-reverse and brightens :first-child, so index 0 is
  // the newest event and reads at the bottom of the stack.
  for (let i = 0; i < show; i++) {
    const e = log[len - 1 - i];
    const li = _hudTickerItems[i];
    const text = e && e.text ? String(e.text) : '';
    if (li.textContent !== text) li.textContent = text;
    // `kind` is exposed for styling without this file needing to know the
    // vocabulary the sim logs with.
    const kind = (e && e.kind) ? String(e.kind) : '';
    if (li.getAttribute('data-kind') !== kind) li.setAttribute('data-kind', kind);
  }
}

// ── entry point ─────────────────────────────────────────────────────────

function renderHud(state) {
  if (!state) return false;
  const nodes = hudNodes();
  hudStats(state, nodes);
  hudPowerStrip(state, nodes);
  hudTicker(state, nodes);
  return true;
}

// Global export — no modules anywhere in this project.
window.renderHud = renderHud;
