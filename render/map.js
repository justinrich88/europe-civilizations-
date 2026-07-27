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

function stationGarrison(D, stationId) {
  const s = D.SETUP && D.SETUP[stationId];
  if (!s || !s.units) return null;
  let total = 0;
  for (const k in s.units) total += Number(s.units[k]) || 0;
  return total;
}

// Territory control is derived, never authored (00-vision.md §3): a territory
// belongs to a power when every station inside it does. Mixed -> contested,
// empty or unowned -> neutral.
function territoryController(D, territoryId) {
  if (!D.STATIONS) return { owner: null, contested: false };
  let owner;
  let seen = 0;
  for (const sid in D.STATIONS) {
    const st = D.STATIONS[sid];
    if (!st || st.territory !== territoryId) continue;
    seen++;
    const o = stationOwner(D, sid);
    if (seen === 1) owner = o;
    else if (o !== owner) return { owner: null, contested: true };
  }
  if (!seen || !owner || owner === 'neutral') return { owner: null, contested: false };
  return { owner: owner, contested: false };
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

function drawTerritories(D, layer) {
  const ids = Object.keys(D.TERRITORIES).sort();
  let drawn = 0;
  for (const tid of ids) {
    const t = D.TERRITORIES[tid];
    const pts = shapePoints(D, t && t.shape);
    if (!pts) {
      console.warn('[render/map] territory "' + tid + '" has an unusable shape; skipped');
      continue;
    }
    const ctrl = territoryController(D, tid);
    const color = powerColor(D, ctrl.owner);
    const cls = 'territory' + (ctrl.contested ? ' is-contested'
      : (color ? '' : ' is-neutral'));
    const poly = el('polygon', cls, { points: pointsAttr(pts), 'data-territory': tid });
    if (color) poly.setAttribute('fill', color);
    layer.appendChild(poly);
    if (ctrl.contested) {
      layer.appendChild(el('polygon', 'territory-hatch', { points: pointsAttr(pts) }));
    }
    drawn++;
  }
  return drawn;
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

function drawStations(D, layer) {
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
    const owner = stationOwner(D, sid);
    const color = powerColor(D, owner);

    const g = el('g', 'station', {
      transform: 'translate(' + st.pos[0] + ',' + st.pos[1] + ')',
      'data-station': sid,
      'data-type': st.type || 'holding',
      'data-owner': owner || 'neutral',
    });

    const shape = stationShape(st.type, r);
    if (color) {
      // dark fill so the garrison number stays high contrast; the saturated
      // ownership colour lives in the outline
      shape.setAttribute('fill', mixHex(color, '#0c0f14', 0.58));
      shape.setAttribute('stroke', color);
    } else {
      shape.setAttribute('fill', '#252c37');
      shape.setAttribute('stroke', '#6c7686');
    }
    g.appendChild(shape);

    // The number is the interface.
    const garrison = stationGarrison(D, sid);
    if (garrison !== null) {
      g.appendChild(el('text', 'station-garrison', {
        y: 0.5,
        'font-size': clamp(r * 1.0, 9, 17).toFixed(1),
        text: formatNum(garrison),
      }));
    }

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

  ensureDefs();
  const gTerr = clearLayer('g-territories');
  const gBord = clearLayer('g-borders');
  const gLink = clearLayer('g-links');
  clearLayer('g-waves');
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
    territories: drawTerritories(D, gTerr),
    borders: drawBorders(D, gBord),
    links: D.STATIONS ? drawLinks(D, gLink) : 0,
    stations: D.STATIONS ? drawStations(D, gStat) : 0,
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

// Global export — no modules anywhere in this project.
window.renderBoard = renderBoard;

// Self-bootstrap so the shell is viewable before app/main.js exists. Once the
// app layer lands it sets window.APP_OWNS_RENDER = true and this stands down.
document.addEventListener('DOMContentLoaded', function () {
  if (!window.APP_OWNS_RENDER) renderBoard();
});
