// render/map.js — draws the static board: territories, borders, links,
// stations, labels.
//
// Reads the globals authored under data/: VERTS, TERRITORIES, STATIONS,
// LINKS, POWERS, SETUP. Those files are written by other hands and may not
// exist yet, so every read is guarded: renderBoard() never throws on missing
// data, it draws a placeholder and names exactly what is absent.
//
// Rules from 00-vision.md §8, non-negotiable:
//   - colour carries OWNERSHIP only
//   - shape carries station TYPE  (circle / shield / square / star)
//   - size carries CAPACITY
//   - the garrison number is the interface: large, centred, high contrast

'use strict';

// Fallback ownership palette, used only if POWERS is missing a colour.
const FALLBACK_POWER_COLORS = [
  '#5b7fbd', '#c25b52', '#6fae72', '#b4894a', '#8f6bb0', '#4fa5a8', '#b56a95',
];

const NODE_R_MIN = 9;
const NODE_R_MAX = 19;

// ── the live index ──────────────────────────────────────────────────────
//
// renderBoard() builds the 108 station <g>s and the 48 territory polygons
// exactly once and files the nodes here. renderLive() then only ever writes
// attributes on them.
//
// Two reasons this matters, and neither is micro-optimisation. First,
// render/select.js appends its own carets and hover state into these same
// <g> elements; rebuilding them would delete another file's work mid-frame.
// Second, each record also carries the LAST value written for every field, so
// a frame where nothing changed costs zero DOM writes. On a settled board that
// is most frames — the numbers only move when growth crosses an integer.
const LIVE = { stat: Object.create(null), terr: Object.create(null), writes: 0 };

function resetLiveIndex() {
  LIVE.stat = Object.create(null);
  LIVE.terr = Object.create(null);
  LIVE.writes = 0;
}

// Every DOM write in this file goes through here so the per-frame cost is a
// measured number rather than a belief.
function setAttr(node, name, value) {
  node.setAttribute(name, value);
  LIVE.writes++;
}

function setText(node, value) {
  node.textContent = value;
  LIVE.writes++;
}

// ── colour helpers ──────────────────────────────────────────────────────

function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!isFinite(n) || h.length !== 6) return [120, 130, 145];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return '#' + rgb.map(function (c) {
    return clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0');
  }).join('');
}

// Blend `hex` toward `toward` by t (0 = unchanged, 1 = fully toward).
function mixHex(hex, toward, t) {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  return rgbToHex([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
}

// ── data access, all guarded ────────────────────────────────────────────

// Top-level `const` in a classic script does NOT land on `window`, so these
// must be bare `typeof` checks rather than window lookups.
function readGlobals() {
  return {
    VERTS:       (typeof VERTS       !== 'undefined') ? VERTS       : null,
    TERRITORIES: (typeof TERRITORIES !== 'undefined') ? TERRITORIES : null,
    STATIONS:    (typeof STATIONS    !== 'undefined') ? STATIONS    : null,
    LINKS:       (typeof LINKS       !== 'undefined') ? LINKS       : null,
    POWERS:      (typeof POWERS      !== 'undefined') ? POWERS      : null,
    SETUP:       (typeof SETUP       !== 'undefined') ? SETUP       : null,
  };
}

function missingNames(d) {
  const out = [];
  for (const k in d) if (!d[k]) out.push(k);
  return out;
}

// Ownership colour for a power id. `neutral`, unknown ids and missing data
// all collapse to the neutral grey.
function powerColor(D, ownerId, fallbackIndex) {
  if (!ownerId || ownerId === 'neutral') return null;
  const p = D.POWERS && D.POWERS[ownerId];
  if (p && p.color) return p.color;
  const ids = D.POWERS ? Object.keys(D.POWERS).sort() : [];
  const i = ids.indexOf(ownerId);
  const idx = i >= 0 ? i : (fallbackIndex || 0);
  return FALLBACK_POWER_COLORS[idx % FALLBACK_POWER_COLORS.length];
}

function stationOwner(D, stationId) {
  const s = D.SETUP && D.SETUP[stationId];
  return (s && s.owner) ? s.owner : null;
}

// Territory control is derived, never authored (00-vision.md §3), and comes in
// three tiers:
//
//   full       every station         -> solid tint
//   majority   more than half        -> lighter wash of the same colour
//   contested  nobody past half      -> hatched, no owner
//
// THE RULE LIVES IN core/state.js. This file used to keep a second copy called
// `territoryControl`, and that was worse than duplication: top-level function
// declarations in a classic script land on `window`, and render/map.js loads
// AFTER core/state.js, so the renderer's copy silently overwrote the sim's.
// Every unqualified `territoryControl(state, tid)` call in core/ and sim/ was
// resolving to a function that read the static turn-zero SETUP instead of the
// live state. Two implementations of one rule is a bug waiting to happen; this
// one had already happened. There is now exactly one, and it is core's.
//
// The only thing the renderer adds on top is a *visual* case core has no
// opinion about: `neutral` is a power id in POWERS, so it can legitimately come
// back as `owner`. Unowned ground is drawn as empty grey, not as somebody's
// territory, so that collapses to a fourth CSS class. The tier arithmetic is
// untouched.
function controlOf(state, territoryId) {
  if (typeof territoryControl !== 'function' || !state || !state.stations) {
    return { owner: null, tier: 'contested', cls: 'contested' };
  }
  const c = territoryControl(state, territoryId);
  const cls = (c.owner === 'neutral') ? 'neutral' : c.tier;
  return { owner: c.owner === 'neutral' ? null : c.owner, tier: c.tier, cls: cls };
}

// core's territoryControl() reads `state.stations[sid].owner` and nothing else,
// so the turn-zero snapshot can be handed to it as a state-shaped object. That
// is how renderBoard() tints the board before app/main.js has made a GAME —
// same function, same rule, no second implementation.
function setupPseudoState(D) {
  const stations = Object.create(null);
  if (D.STATIONS) {
    for (const sid in D.STATIONS) {
      stations[sid] = { owner: stationOwner(D, sid) || 'neutral' };
    }
  }
  return { stations: stations };
}

// ── geometry helpers ────────────────────────────────────────────────────

// Vertex-id list -> array of [x, y]. Returns null if any id is unknown, so a
// typo in the map data shows up as one skipped shape rather than NaN soup.
function shapePoints(D, shape) {
  if (!Array.isArray(shape) || shape.length < 3) return null;
  const pts = [];
  for (const vid of shape) {
    const v = D.VERTS[vid];
    if (!v || v.length < 2) return null;
    pts.push([Number(v[0]), Number(v[1])]);
  }
  return pts;
}

function pointsAttr(pts) {
  return pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
}

// ── station silhouettes — four types, four shapes, never four colours ───

function stationShape(type, r) {
  if (type === 'defensive') {
    // shield
    return el('path', 'station-shape', {
      d: 'M0,' + (-r) +
         ' L' + (r * 0.86) + ',' + (-r * 0.42) +
         ' L' + (r * 0.86) + ',' + (r * 0.30) +
         ' L0,' + (r * 1.02) +
         ' L' + (-r * 0.86) + ',' + (r * 0.30) +
         ' L' + (-r * 0.86) + ',' + (-r * 0.42) + ' Z',
    });
  }
  if (type === 'producer') {
    // square
    const s = r * 0.88;
    return el('rect', 'station-shape', {
      x: -s, y: -s, width: s * 2, height: s * 2, rx: r * 0.12,
    });
  }
  if (type === 'multiplier') {
    // four-point star. Multiplier stations are the smallest on the board, so
    // the arms stay fat enough to carry a number.
    const i = r * 0.40;
    return el('path', 'station-shape', {
      d: 'M0,' + (-r) +
         ' L' + i + ',' + (-i) +
         ' L' + r + ',0' +
         ' L' + i + ',' + i +
         ' L0,' + r +
         ' L' + (-i) + ',' + i +
         ' L' + (-r) + ',0' +
         ' L' + (-i) + ',' + (-i) + ' Z',
    });
  }
  // holding, and anything unrecognised
  return el('circle', 'station-shape', { r: r });
}

function stationRadius(capacity, capMin, capMax) {
  const cap = Number(capacity);
  if (!isFinite(cap) || capMax <= capMin) return (NODE_R_MIN + NODE_R_MAX) / 2;
  // sqrt so node AREA tracks capacity rather than diameter
  const t = Math.sqrt(clamp((cap - capMin) / (capMax - capMin), 0, 1));
  return lerp(NODE_R_MIN, NODE_R_MAX, t);
}

// ── defs ────────────────────────────────────────────────────────────────

function ensureDefs() {
  const defs = byId('board-defs');
  if (!defs || defs.querySelector('#hatch-contested')) return;
  const pat = el('pattern', null, {
    id: 'hatch-contested', width: 8, height: 8,
    patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  });
  pat.appendChild(el('line', 'hatch-line', { x1: 0, y1: 0, x2: 0, y2: 8 }));
  defs.appendChild(pat);
}

function clearLayer(id) {
  const layer = byId(id);
  if (layer) while (layer.firstChild) layer.removeChild(layer.firstChild);
  return layer;
}

// ── drawing passes ──────────────────────────────────────────────────────

function drawTerritories(D, layer, state) {
  const ids = Object.keys(D.TERRITORIES).sort();
  const made = [];
  for (const tid of ids) {
    const t = D.TERRITORIES[tid];
    const pts = shapePoints(D, t && t.shape);
    if (!pts) {
      console.warn('[render/map] territory "' + tid + '" has an unusable shape; skipped');
      continue;
    }
    const poly = el('polygon', 'territory is-contested', {
      points: pointsAttr(pts),
      'data-territory': tid,
      'data-tier': 'contested',
    });
    // The hatch is created ONCE and toggled by class from renderLive. Creating
    // and destroying it as territories flip would mean DOM churn on the layer
    // every time a border moves, which is exactly what renderLive exists to
    // avoid.
    const hatch = el('polygon', 'territory-hatch', { points: pointsAttr(pts) });
    made.push({ tid: tid, poly: poly, hatch: hatch });
    LIVE.terr[tid] = { poly: poly, hatch: hatch, cls: null, color: null };
  }

  // Two passes: every fill first, then every hatch. In one pass a territory
  // drawn later paints over an earlier neighbour's hatch, which made contested
  // ground look solid depending on alphabetical order.
  for (const m of made) layer.appendChild(m.poly);
  for (const m of made) layer.appendChild(m.hatch);

  // Tint from the turn-zero snapshot so the board is correct the instant it is
  // drawn; renderLive takes over from the next frame.
  liveTerritories(D, state);
  return made.length;
}

// Borders are derived from the shared vertex table: an edge referenced by two
// territories is internal (thin), an edge referenced once is an outer
// coast/frontier line (thicker). This is only correct because neighbouring
// shapes reuse the *same* vertex ids — see 01-data-schema.md.
function drawBorders(D, layer) {
  const edges = new Map();
  for (const tid in D.TERRITORIES) {
    const shape = D.TERRITORIES[tid] && D.TERRITORIES[tid].shape;
    if (!Array.isArray(shape) || shape.length < 3) continue;
    for (let i = 0; i < shape.length; i++) {
      const a = shape[i];
      const b = shape[(i + 1) % shape.length];
      const key = a < b ? a + '|' + b : b + '|' + a;
      const rec = edges.get(key);
      if (rec) rec.count++;
      else edges.set(key, { a: a, b: b, count: 1 });
    }
  }

  const inner = [];
  const coast = [];
  for (const rec of edges.values()) {
    const va = D.VERTS[rec.a];
    const vb = D.VERTS[rec.b];
    if (!va || !vb) continue;
    (rec.count > 1 ? inner : coast).push([va, vb]);
  }

  // internal first, coastline over the top
  for (const [va, vb] of inner) {
    layer.appendChild(el('line', 'border-inner',
      { x1: va[0], y1: va[1], x2: vb[0], y2: vb[1] }));
  }
  for (const [va, vb] of coast) {
    layer.appendChild(el('line', 'border-coast',
      { x1: va[0], y1: va[1], x2: vb[0], y2: vb[1] }));
  }
  return { inner: inner.length, coast: coast.length };
}

function drawLinks(D, layer) {
  if (!D.LINKS || !D.STATIONS) return 0;
  let drawn = 0;
  for (const link of D.LINKS) {
    const a = D.STATIONS[link && link.a];
    const b = D.STATIONS[link && link.b];
    if (!a || !b || !a.pos || !b.pos) {
      console.warn('[render/map] link references an unknown station:', link);
      continue;
    }
    layer.appendChild(el('line', 'link' + (link.sea ? ' is-sea' : ''), {
      x1: a.pos[0], y1: a.pos[1], x2: b.pos[0], y2: b.pos[1],
      'data-link': link.a + '-' + link.b,
    }));
    drawn++;
  }
  return drawn;
}

function drawStations(D, layer, state) {
  const ids = Object.keys(D.STATIONS).sort();

  let capMin = Infinity;
  let capMax = -Infinity;
  for (const sid of ids) {
    const c = Number(D.STATIONS[sid] && D.STATIONS[sid].capacity);
    if (!isFinite(c)) continue;
    if (c < capMin) capMin = c;
    if (c > capMax) capMax = c;
  }

  let drawn = 0;
  for (const sid of ids) {
    const st = D.STATIONS[sid];
    if (!st || !st.pos || st.pos.length < 2) {
      console.warn('[render/map] station "' + sid + '" has no usable pos; skipped');
      continue;
    }
    const r = stationRadius(st.capacity, capMin, capMax);

    const g = el('g', 'station', {
      transform: 'translate(' + st.pos[0] + ',' + st.pos[1] + ')',
      'data-station': sid,
      'data-type': st.type || 'holding',
      'data-owner': 'neutral',
    });

    // Battle ring, created once and revealed by class. A fight is the most
    // time-critical thing on the board (§5) so it gets an animated ring rather
    // than a static mark — the animation is CSS, which costs the renderer
    // nothing per frame.
    g.appendChild(el('circle', 'station-battle', { r: r + 5 }));

    const shape = stationShape(st.type, r);
    shape.setAttribute('fill', '#252c37');
    shape.setAttribute('stroke', '#6c7686');
    g.appendChild(shape);

    // Cut-off mark: a broken link glyph at the node's shoulder. Connection is
    // one of the three systems holding the snowball back (§5) and it was
    // completely invisible before this — a station that has stopped growing
    // and started decaying must say so on the board.
    g.appendChild(el('path', 'station-cut', {
      d: 'M' + (-4) + ',' + (-4) + ' L' + (-1) + ',' + (-1) +
         ' M' + 1 + ',' + 1 + ' L' + 4 + ',' + 4 +
         ' M' + (-4) + ',' + 4 + ' L' + 4 + ',' + (-4),
      transform: 'translate(' + (r + 6).toFixed(1) + ',' + (-r - 3).toFixed(1) + ')',
    }));

    // The number is the interface (§8). Floats are internal; floor at render.
    const num = el('text', 'station-garrison', {
      y: 0.5,
      'font-size': clamp(r * 1.0, 9, 17).toFixed(1),
      text: '0',
    });
    g.appendChild(num);

    // Everything renderLive needs, captured at build time. Querying the DOM per
    // frame for 108 stations is the other way to do this and it is slower and
    // fragile — select.js inserts its own children into these same <g>s.
    LIVE.stat[sid] = {
      g: g, shape: shape, num: num,
      owner: undefined, garrison: undefined, cut: undefined, fight: undefined,
    };

    // Modifiers labelled in place, next to the node (§8).
    if (st.type === 'multiplier' && st.multiplier) {
      g.appendChild(el('text', 'station-modifier', {
        x: r + 5, y: -r * 0.85, 'text-anchor': 'start',
        text: '×' + st.multiplier,
      }));
    }

    if (st.name) {
      g.appendChild(el('text', 'station-name', { y: r + 9, text: st.name }));
    }

    layer.appendChild(g);
    drawn++;
  }

  // Paint the turn-zero snapshot through the same path every later frame uses.
  liveStations(D, state);
  return drawn;
}

function drawTerritoryLabels(D, layer) {
  let drawn = 0;
  for (const tid of Object.keys(D.TERRITORIES).sort()) {
    const t = D.TERRITORIES[tid];
    if (!t || !t.name) continue;
    let at = t.label;
    if (!at || at.length < 2) {
      const pts = shapePoints(D, t.shape);
      if (!pts) continue;
      at = centroid(pts);
    }
    layer.appendChild(el('text', 'territory-label',
      { x: at[0], y: at[1], text: t.name }));
    drawn++;
  }
  return drawn;
}

// Provisional ownership legend in the bottom bar. render/hud.js should take
// this over once it exists; until then it is what makes the colours legible.
function drawPowerLegend(D) {
  const strip = byId('powers-strip');
  if (!strip) return;
  while (strip.firstChild) strip.removeChild(strip.firstChild);
  if (!D.POWERS) return;
  for (const pid of Object.keys(D.POWERS).sort()) {
    if (pid === 'neutral') continue;
    const p = D.POWERS[pid];
    const chip = el('span', 'power-chip');
    const sw = el('span', 'power-swatch');
    sw.style.background = powerColor(D, pid) || 'var(--neutral-node)';
    chip.appendChild(sw);
    chip.appendChild(el('span', null, { text: p.name || pid }));
    strip.appendChild(chip);
  }
}

// ── live update — everything that changes, every frame ──────────────────
//
// The board is not a photograph. Ownership, garrisons, control tiers, cut
// supply and running battles all move while you watch, and every one of them
// is a thing the player is supposed to react to.
//
// The discipline throughout: compute the value, compare it against what was
// last written, and return early when they match. Comparison is a number or a
// string; a DOM write is layout. Skipping is always the cheaper branch.

// Is anyone actually fighting for this station right now? `attackers` is left
// in place as an empty bag by sim/combat.js after a fight resolves, so the
// presence of the key is not the question — the presence of units is.
function stationContested(state, sid) {
  if (state.battles && state.battles[sid]) return true;
  const a = state.stations[sid] && state.stations[sid].attackers;
  if (!a) return false;
  for (const pid in a) {
    const u = a[pid];
    if (!u) continue;
    if ((u.infantry || 0) + (u.artillery || 0) + (u.armour || 0) > 1e-6) return true;
  }
  return false;
}

function liveStations(D, state) {
  if (!state || !state.stations) return;
  for (const sid in LIVE.stat) {
    const rec = LIVE.stat[sid];
    const st = state.stations[sid];
    if (!st) continue;

    // Ownership colour — from live state, never from SETUP. The saturated
    // colour lives in the outline and the fill stays dark so the number keeps
    // its contrast (§8).
    const owner = st.owner && st.owner !== 'neutral' ? st.owner : null;
    if (owner !== rec.owner) {
      rec.owner = owner;
      const color = powerColor(D, owner);
      if (color) {
        setAttr(rec.shape, 'fill', mixHex(color, '#0c0f14', 0.58));
        setAttr(rec.shape, 'stroke', color);
      } else {
        setAttr(rec.shape, 'fill', '#252c37');
        setAttr(rec.shape, 'stroke', '#6c7686');
      }
      setAttr(rec.g, 'data-owner', owner || 'neutral');
    }

    // The number is the interface. Units are floats internally (100ms attrition
    // rounds to zero on integers) — floored here and nowhere else, which is
    // also why this only writes on the frames where the integer actually moved.
    const u = st.units;
    const n = Math.floor((u.infantry || 0) + (u.artillery || 0) + (u.armour || 0));
    if (n !== rec.garrison) {
      rec.garrison = n;
      setText(rec.num, formatNum(n));
    }

    // Cut off from its capital: not growing, actively decaying (§5).
    const cut = st.connected === false;
    if (cut !== rec.cut) {
      rec.cut = cut;
      rec.g.classList.toggle('is-cut', cut);
      LIVE.writes++;
    }

    const fight = stationContested(state, sid);
    if (fight !== rec.fight) {
      rec.fight = fight;
      rec.g.classList.toggle('is-fighting', fight);
      LIVE.writes++;
    }
  }
}

function liveTerritories(D, state) {
  if (!state || !state.stations) return;
  for (const tid in LIVE.terr) {
    const rec = LIVE.terr[tid];
    const ctrl = controlOf(state, tid);
    const color = powerColor(D, ctrl.owner);

    // Class carries the tier; the fill carries the owner. A majority is the
    // SAME hue at lower opacity, never a second colour — colour means
    // ownership and only ownership (§8), so the tier has to live in opacity.
    if (ctrl.cls !== rec.cls) {
      rec.cls = ctrl.cls;
      setAttr(rec.poly, 'class', 'territory is-' + ctrl.cls);
      setAttr(rec.poly, 'data-tier', ctrl.cls);
      rec.hatch.classList.toggle('is-on', ctrl.cls === 'contested');
      LIVE.writes++;
    }
    if (color !== rec.color) {
      rec.color = color;
      if (color) setAttr(rec.poly, 'fill', color);
      else rec.poly.removeAttribute('fill');
    }
  }
}

// renderLive(state) — the pinned per-frame entry point (01-data-schema.md).
// Safe to call before renderBoard() has run and safe to call with a half-built
// board; it updates whatever is indexed and writes nothing otherwise.
function renderLive(state) {
  if (!state || !state.stations) return 0;
  const D = readGlobals();
  const before = LIVE.writes;
  liveStations(D, state);
  liveTerritories(D, state);
  return LIVE.writes - before;
}

// ── placeholder for missing data ────────────────────────────────────────

function drawMissingNotice(missing) {
  const layer = byId('g-ui');
  if (!layer) return;
  layer.appendChild(el('text', 'board-message',
    { x: 500, y: 330, text: 'map data not loaded' }));
  layer.appendChild(el('text', 'board-message-sub',
    { x: 500, y: 356, text: 'missing: ' + missing.join(', ') }));
  layer.appendChild(el('text', 'board-message-sub',
    { x: 500, y: 374, text: 'rendering shell is up — waiting on data/' }));
}

// ── entry point ─────────────────────────────────────────────────────────

function renderBoard() {
  const svg = byId('board');
  if (!svg) {
    console.error('[render/map] no #board svg in the document');
    return false;
  }

  const D = readGlobals();
  const missing = missingNames(D);

  // core/state.js caches "which stations are in this territory" against its
  // sorted id list, and that list is only built by indexIds(). renderBoard can
  // run before app/main.js has made a GAME, so prime it here or every territory
  // comes back empty and the whole map draws contested.
  if (typeof indexIds === 'function') indexIds();

  // The board draws from the live game if there is one, and from the turn-zero
  // snapshot if there is not. Same code path either way — one renderer, one
  // control rule, no "static mode".
  const state = (window.GAME && window.GAME.stations)
    ? window.GAME
    : setupPseudoState(D);

  ensureDefs();
  resetLiveIndex();
  const gTerr = clearLayer('g-territories');
  const gBord = clearLayer('g-borders');
  const gLink = clearLayer('g-links');
  clearLayer('g-waves');
  // render/waves.js keeps its own id->node index; emptying its layer behind its
  // back would leave it holding orphans forever.
  if (typeof resetWaveLayer === 'function') resetWaveLayer();
  const gStat = clearLayer('g-stations');
  const gLab = clearLayer('g-labels');
  clearLayer('g-ui');

  if (missing.length) {
    console.warn('[render/map] data not loaded yet — missing globals: ' +
      missing.join(', '));
  }

  // Geometry is the floor. Without it there is no board to draw.
  if (!D.VERTS || !D.TERRITORIES) {
    drawMissingNotice(missing);
    return false;
  }

  const counts = {
    territories: drawTerritories(D, gTerr, state),
    borders: drawBorders(D, gBord),
    links: D.STATIONS ? drawLinks(D, gLink) : 0,
    stations: D.STATIONS ? drawStations(D, gStat, state) : 0,
    labels: drawTerritoryLabels(D, gLab),
  };
  drawPowerLegend(D);

  if (!D.STATIONS) {
    console.warn('[render/map] STATIONS missing — territories drawn, no nodes');
  } else if (!D.SETUP) {
    console.warn('[render/map] SETUP missing — nodes drawn neutral, no garrisons');
  }

  console.log('[render/map] board drawn', counts);
  return true;
}

// Global exports — no modules anywhere in this project.
window.renderBoard = renderBoard;
window.renderLive = renderLive;

// Self-bootstrap so the shell is viewable before app/main.js exists. Once the
// app layer lands it sets window.APP_OWNS_RENDER = true and this stands down.
document.addEventListener('DOMContentLoaded', function () {
  if (!window.APP_OWNS_RENDER) renderBoard();
});
