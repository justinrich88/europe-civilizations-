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
const LIVE = {
  stat: Object.create(null), terr: Object.create(null),
  label: [],          // territory labels, counter-scaled with the stations
  symK: null,         // last symbol scale written into a transform
  writes: 0,
};

function resetLiveIndex() {
  LIVE.stat = Object.create(null);
  LIVE.terr = Object.create(null);
  LIVE.label = [];
  LIVE.symK = null;
  LIVE.writes = 0;
}

// ── symbol counter-scale ────────────────────────────────────────────────
//
// render/camera.js zooms by narrowing the viewBox, which magnifies geography
// and symbols alike — at 4x the Ruhr was four times bigger and exactly as
// tangled. Stations, their garrison numbers, their name and ×1.4 labels and the
// territory captions are counter-scaled by 1/scale about their own anchors, so
// they hold a constant on-screen size and zooming actually separates a cluster.
//
// Territory FILLS, borders and links are deliberately NOT counter-scaled: those
// are geography and must scale with the map.
//
// The exponent lives in camera.js and nowhere else; this only asks for the
// number. Guarded because renderBoard() can run before initCamera().
function mapSymbolScale() {
  return (typeof cameraSymbolScale === 'function') ? cameraSymbolScale() : 1;
}

function mapSymbolTransform(x, y, k) {
  return (k === 1)
    ? 'translate(' + x + ',' + y + ')'
    : 'translate(' + x + ',' + y + ') scale(' + (Math.round(k * 100000) / 100000) + ')';
}

// Rewrite every symbol transform for a new camera scale. Called from the camera
// change notification AND as a cheap guard at the top of renderLive() — a zoom
// while the game is paused produces no frames, and a board drawn before
// initCamera() has to pick the scale up on its first frame. Both paths return
// immediately when the scale has not moved, so the per-frame cost of the safety
// net is one float comparison.
function mapApplySymbolScale(force) {
  const k = mapSymbolScale();
  if (!force && k === LIVE.symK) return 0;
  LIVE.symK = k;
  const before = LIVE.writes;
  for (const sid in LIVE.stat) {
    const rec = LIVE.stat[sid];
    if (rec.pos) setAttr(rec.g, 'transform', mapSymbolTransform(rec.pos[0], rec.pos[1], k));
  }
  for (const rec of LIVE.label) {
    setAttr(rec.node, 'transform', mapSymbolTransform(rec.x, rec.y, k));
  }
  return LIVE.writes - before;
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

// The four silhouettes do not have the same outer extent for a given `r`: the
// square's corners reach r*1.24 while the circle, shield and star stop at r.
// Anything drawn as a concentric ring has to clear the widest of them or it
// slices through the producer nodes.
function mapOuterExtent(type, r) {
  return (type === 'producer') ? r * 1.25 : r;
}

// ── fullness ring — how full is this station, as a proportion ───────────
//
// Measured on the real map: neutral stations hold 441 units at tick 0 and 1804
// by tick 3000, with all 59 sitting above 90% of capacity. Neutral ground is
// cheap early and expensive forever after, and that clock was completely
// invisible — a two-station country that falls to one volley at the opening is
// a wall of full garrisons five sim-minutes later, and nothing on the board
// said so.
//
// §8 rules out the two obvious encodings: **colour carries ownership only**, so
// fullness may not tint a node; **shape encodes type**, so it may not deform
// one either. What is left is length, weight and opacity of a secondary mark.
//
// Chosen: an ARC around the node — a faint full-circle track with a brighter
// arc swept over it, arc length = garrison / capacity. It is honest about being
// a proportion (the track is the denominator, drawn even at 0%), it is
// achromatic so it claims no hue and cannot be mistaken for ownership, it does
// not touch the silhouette, and it reads as "nearly closed" vs "barely started"
// across sixty nodes at once without anyone reading a number. Cost is one
// `stroke-dasharray` write per node per *bucket* change, which on a settled
// board is almost never.
//
// Applied to EVERY station, not only neutrals. The same question — "75% of
// what, and is it worth spending?" — is what makes the `send 75%` control hard
// to reason about on your own cities, and §2 turns on it directly: full
// stations have stopped paying dividends and should be spent. Restricting the
// ring to neutrals would also make its presence a second ownership channel,
// which is exactly the thing §8 forbids.
//
// pathLength=100 normalises the dash units, so the arc is written as a literal
// percentage and the ring's radius is free to vary with node size.
const RING_GAP = 3;
const RING_BUCKETS = 40;      // 2.5% steps — finer than the eye resolves at 9px

// ── battle legibility ───────────────────────────────────────────────────
//
// The complaint this answers, in the player's words: *"60 units attacking a
// station of 10 often lose with making no noticeable impact"* — followed by the
// realisation that they had in fact won, they just could not see it happening.
// The sim was right the whole time. A 6:1 fight takes atanh(1/r)/COMBAT_RATE ≈
// 76 ticks, several wall-clock seconds at 1x, and for every one of those the
// node rendered the DEFENDER's garrison and nothing else. The attacking stack is
// sitting right there in state.stations[sid].attackers and was never drawn, so
// "I am winning this" and "my army evaporated" looked identical.
//
// Three questions have to be answerable without a click:
//
//   1. is this station fighting?      -> a complete ring appears where a
//                                        peaceful node has only the faint
//                                        achromatic fullness arc
//   2. how much is mine vs theirs?    -> a SECOND number under the node, in the
//                                        attacker's ownership colour, against
//                                        the garrison number in the middle
//   3. am I winning?                  -> the ring is split by POWER share, one
//                                        arc per power, in ownership colours,
//                                        with a notch at the 50% mark
//
// §8 is not bent to do this. Colour still carries ownership ONLY: the arcs and
// the second number are drawn in the participants' own power colours, which
// reinforces the rule rather than competing with it. The garrison number is not
// moved, resized or recoloured — everything here is secondary to it, and all of
// it is `display:none` on a node that is not fighting, so a peaceful board is
// byte-identical to before.
//
// POWER, not unit count. 60 infantry walking into a 3.0-defense fortress are
// nowhere near 6:1, and a ring drawn from unit totals would lie at exactly the
// moment the player is asking it a question. stationPower() already folds in
// defense, terrain, matchup and the artillery-stripped fort block, and it is a
// pure read (sim/combat.js — it allocates locals and touches nothing), so the
// renderer may call it.
//
// The DEFENDER's arc is the `.station-battle` circle that already existed: it is
// already at the right radius, already revealed by `.is-fighting`, already
// pointer-events:none. Only the attacker arcs, the notch and the second number
// are new, and those are built lazily on a station's first battle.
const MAP_MOM_GAP = 3;        // momentum ring sits this far outside the fill ring
const MAP_MOM_ATK = 2;        // attacker arcs built; a 3rd+ power folds into the last
const MAP_MOM_BUCKETS = 100;  // 1% steps — same "rewrite on a visible change" rule
const MAP_MOM_NEUTRAL = '#8b94a4';

function mapUnitTotal(u) {
  if (!u) return 0;
  return (u.infantry || 0) + (u.artillery || 0) + (u.armour || 0);
}

function mapRingFraction(units, capacity) {
  const cap = Number(capacity);
  if (!isFinite(cap) || cap <= 0) return 0;
  return clamp(units / cap, 0, 1);
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

    // translate(pos) scale(1/cameraScale): everything inside the group —
    // circles, garrison number, fullness ring, cut marks, name and ×N label —
    // is positioned relative to this origin, so the counter-scale comes free
    // and is applied about the node's own centre rather than sliding it.
    const g = el('g', 'station', {
      transform: mapSymbolTransform(st.pos[0], st.pos[1], mapSymbolScale()),
      'data-station': sid,
      'data-type': st.type || 'holding',
      'data-owner': 'neutral',
    });

    const outer = mapOuterExtent(st.type, r);

    // Battle ring, created once and revealed by class. A fight is the most
    // time-critical thing on the board (§5) so it gets an animated ring rather
    // than a static mark — the animation is CSS, which costs the renderer
    // nothing per frame. Sits outside the fullness ring so the two never
    // overlap on a square node.
    // Doubles as the DEFENDER's arc once a fight starts — see the battle
    // section above. Kept as one circle with pathLength=100 so the arc is
    // written as a literal percentage, exactly like the fullness ring.
    const momR = outer + RING_GAP + MAP_MOM_GAP;
    // rotate(90) starts the sweep at 6 o'clock rather than 12. The 50% mark
    // then lands at the TOP of the ring, which is the only part of the node's
    // surround that nothing else claims — the attacker's number hangs below and
    // a notch at 6 o'clock landed straight on it.
    const battleRing = el('circle', 'station-battle', {
      r: momR, pathLength: 100, 'stroke-dasharray': '100 0',
      'stroke-dashoffset': 0, transform: 'rotate(90)',
    });
    g.appendChild(battleRing);

    // Fullness ring: faint track (the denominator) + swept arc (the value).
    // Both are built once; only the arc's dasharray is ever written again.
    const ringR = outer + RING_GAP;
    g.appendChild(el('circle', 'station-fill-track', { r: ringR }));
    const fillArc = el('circle', 'station-fill', {
      r: ringR, pathLength: 100, 'stroke-dasharray': '0 100',
      transform: 'rotate(-90)',      // start the sweep at 12 o'clock
    });
    g.appendChild(fillArc);

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
      g: g, shape: shape, num: num, fillArc: fillArc,
      pos: [st.pos[0], st.pos[1]],
      capacity: Number(st.capacity) || 0,
      owner: undefined, garrison: undefined, cut: undefined, fight: undefined,
      fillBucket: undefined,
      // battle readout: geometry now, DOM on this station's first fight
      ring: battleRing,
      momR: momR,
      attY: momR + 9,
      // Near-peer with the garrison number, not a footnote: in a battle "how
      // many of mine" and "how many of theirs" are the same question asked
      // twice, and a caption-sized second number was unreadable against the
      // neighbouring nodes at 1x.
      attSize: Number(clamp(r * 0.95, 9.5, 16).toFixed(1)),
      bat: null,
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
    // Position lives in the TRANSFORM, not in x/y, so the counter-scale
    // shrinks the caption toward its own anchor instead of sliding it across
    // the country. With x/y set, scale(k) would multiply the position too and
    // "GERMANY" would drift off toward the origin as you zoomed.
    const node = el('text', 'territory-label', {
      x: 0, y: 0,
      transform: mapSymbolTransform(at[0], at[1], mapSymbolScale()),
      text: t.name,
    });
    layer.appendChild(node);
    LIVE.label.push({ node: node, x: at[0], y: at[1] });
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

// Built on a station's FIRST battle, never in renderBoard(). A board that has
// not seen a fight has exactly the DOM it had before this feature existed,
// which is what makes "a peaceful node renders identically" checkable rather
// than asserted. One insert per station per game; after that it is reused.
function mapBattleNodes(rec) {
  if (rec.bat) return rec.bat;
  const g = el('g', 'station-battlegroup');

  const arcs = [rec.ring];
  const cache = [{ len: null, off: null, color: null }];
  for (let i = 0; i < MAP_MOM_ATK; i++) {
    arcs.push(g.appendChild(el('circle', 'station-mom', {
      r: rec.momR, pathLength: 100, transform: 'rotate(90)',
      'stroke-dasharray': '0 100', 'stroke-dashoffset': 0,
    })));
    cache.push({ len: null, off: null, color: null });
  }

  // The 50% mark, cut into the top of the ring. The defender's arc starts at 6
  // o'clock and sweeps clockwise, so its boundary reaching past this notch
  // means the defender holds more than half the Power in play. Without it the
  // player has to judge two arc lengths against each other; with it, "past the
  // notch" is the whole read. Static, so it costs nothing per frame.
  g.appendChild(el('line', 'station-mom-half', {
    x1: 0, y1: -(rec.momR - 3.4), x2: 0, y2: -(rec.momR + 3.4),
  }));

  const num = el('text', 'station-attackers', {
    y: rec.attY, 'font-size': rec.attSize, text: '',
  });
  g.appendChild(num);

  rec.g.appendChild(g);
  rec.bat = { arcs: arcs, cache: cache, num: num, text: null, color: null, tick: -1 };
  return rec.bat;
}

// One arc write, diffed three ways. Stroke goes in as an INLINE STYLE, not as a
// presentation attribute: `.station-battle { stroke: var(--warn) }` is a
// stylesheet rule and a stylesheet rule silently outranks a presentation
// attribute (docs/testing/known-issues.md #15). Inline style outranks the
// stylesheet, so this is the direction that actually lands.
function mapBattleArc(node, c, len, off, color) {
  if (color !== c.color) {
    c.color = color;
    node.style.stroke = color;
    LIVE.writes++;
  }
  if (len !== c.len) {
    c.len = len;
    setAttr(node, 'stroke-dasharray', len + ' ' + (100 - len));
  }
  if (off !== c.off) {
    c.off = off;
    setAttr(node, 'stroke-dashoffset', off);
  }
}

// Everyone with forces at this station and their share of the Power in play,
// defender first, attackers strongest-first.
//
// state.stations[sid].attackers is keyed by power id and MORE THAN ONE power
// can be attacking the same station at once — a three-way fight over Belgrade
// is a normal thing for this board to produce. That case is not special-cased,
// it is the general case: one arc per participant. Only the arc BUDGET is
// finite, and the tail folds into the last arc rather than being dropped.
function mapBattleParts(D, state, sid) {
  const st = state.stations[sid];
  const hasPower = (typeof stationPower === 'function');
  const defP = hasPower ? Number(stationPower(state, sid, 'defender')) : mapUnitTotal(st.units);
  const def = {
    color: powerColor(D, st.owner) || MAP_MOM_NEUTRAL,
    p: (isFinite(defP) && defP > 0) ? defP : 0,
    units: mapUnitTotal(st.units),
    pid: st.owner || 'neutral',
  };

  const atk = [];
  const bag = st.attackers;
  if (bag) {
    for (const pid in bag) {
      const units = mapUnitTotal(bag[pid]);
      if (units <= 1e-6) continue;
      const p = hasPower ? Number(stationPower(state, sid, pid)) : units;
      atk.push({
        color: powerColor(D, pid) || MAP_MOM_NEUTRAL,
        p: (isFinite(p) && p > 0) ? p : 0,
        units: units, pid: pid,
      });
    }
  }
  // Strongest first so the fold keeps the two loudest claims intact, and by pid
  // on a tie so the ring does not reshuffle between frames on equal stacks.
  atk.sort(function (a, b) { return (b.p - a.p) || (a.pid < b.pid ? -1 : 1); });
  return { def: def, atk: atk };
}

// Per-tick, per-fighting-station update. Everything else on the node is already
// diffed against its last written value; this is the same discipline one level
// down.
function mapBattleLive(D, state, sid, rec) {
  const bat = mapBattleNodes(rec);
  // Power only moves when the sim moves. renderLive() runs per FRAME — up to
  // six frames per tick at 1x — so gating on the tick collapses the whole
  // battle readout to one evaluation per tick per fighting station, and
  // stationPower() (which allocates) is not called sixty times a second.
  if (bat.tick === state.tick) return;
  bat.tick = state.tick;

  const parts = mapBattleParts(D, state, sid);
  const def = parts.def;
  const atk = parts.atk;

  // Fold power N+1.. into the last arc, coloured by the strongest of them, so
  // a four-way fight renders as "defender / biggest / everyone else" instead of
  // silently dropping two armies off the ring.
  const slices = [def];
  for (let i = 0; i < MAP_MOM_ATK && i < atk.length; i++) slices.push(atk[i]);
  if (atk.length > MAP_MOM_ATK) {
    const last = slices[slices.length - 1];
    let extra = 0;
    for (let i = MAP_MOM_ATK; i < atk.length; i++) extra += atk[i].p;
    slices[slices.length - 1] = { color: last.color, p: last.p + extra, units: last.units, pid: last.pid };
  }

  let total = 0;
  for (const s of slices) total += s.p;

  // Nothing to divide by: a garrison of zero being walked into, or a battle
  // record that outlived its units. Draw the ring as pure attacker rather than
  // as NaN.
  let acc = 0;
  for (let i = 0; i < bat.arcs.length; i++) {
    const s = slices[i];
    let len = 0;
    if (s && total > 0) {
      len = Math.round((s.p / total) * MAP_MOM_BUCKETS) * (100 / MAP_MOM_BUCKETS);
    } else if (s && i === 1 && total <= 0) {
      len = 100;                       // attacker present, defender annihilated
    }
    mapBattleArc(bat.arcs[i], bat.cache[i], len, -acc,
      (s && s.color) || MAP_MOM_NEUTRAL);
    acc += len;
  }

  // The second number. Prefer the HUMAN's own stack when the human is one of
  // the attackers — "how much of mine is there" is the question that started
  // this — and otherwise the largest, which is the one that decides the fight.
  // Colour says whose it is either way, so the number is never ambiguous.
  let pick = null;
  const me = (typeof PLAYER === 'string') ? PLAYER : null;
  for (const a of atk) if (a.pid === me) { pick = a; break; }
  if (!pick) pick = atk[0] || null;

  // Trailing '+' when other powers are also attacking, so a multi-party fight
  // never reads as a straight duel.
  const text = pick ? (formatNum(Math.floor(pick.units)) + (atk.length > 1 ? '+' : '')) : '';
  if (text !== bat.text) {
    bat.text = text;
    setText(bat.num, text);
  }
  // Lifted toward white before it is painted. The saturated ownership colours
  // are tuned to be read as a 2px outline around a node, and at text weight on
  // the dark board they came out dim enough that the territory caption behind
  // them competed — measured on the real map, not guessed. Same hue, so it
  // still says whose it is; enough luminance to be read at a glance, which is
  // the entire point of the number.
  const color = pick ? mixHex(pick.color, '#ffffff', 0.4) : MAP_MOM_NEUTRAL;
  if (color !== bat.color) {
    bat.color = color;
    bat.num.style.fill = color;
    LIVE.writes++;
  }
}

// A fight ended. The group is hidden by CSS the moment `.is-fighting` comes off
// the <g>, so nothing has to be unwritten — only the tick gate is released so
// the next battle at this station recomputes from scratch instead of being
// skipped as "already done this tick".
function mapBattleEnd(rec) {
  if (rec.bat) rec.bat.tick = -1;
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
    const total = (u.infantry || 0) + (u.artillery || 0) + (u.armour || 0);
    const n = Math.floor(total);
    if (n !== rec.garrison) {
      rec.garrison = n;
      setText(rec.num, formatNum(n));
    }

    // Fullness arc. Bucketed so a garrison drifting up by 0.03 units a tick
    // does not produce a DOM write every frame — the ring only moves when it
    // would move by a visible amount.
    if (rec.fillArc && rec.capacity > 0) {
      const bucket = Math.round(mapRingFraction(total, rec.capacity) * RING_BUCKETS);
      if (bucket !== rec.fillBucket) {
        rec.fillBucket = bucket;
        const pct = (bucket * 100 / RING_BUCKETS).toFixed(1);
        setAttr(rec.fillArc, 'stroke-dasharray', pct + ' 100');
        // Binary "this one is done growing" read, for scanning the board at a
        // glance rather than comparing arc lengths. Class only — no colour.
        rec.fillArc.classList.toggle('is-full', bucket >= RING_BUCKETS - 1);
      }
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
      if (!fight) mapBattleEnd(rec);
      // A fighting node paints above its neighbours. Station <g>s are appended
      // in sorted id order, so on the real map "Zurich" sat on top of the fight
      // at Verdun 33 units away and ate the attacker's number — measured, not
      // hypothetical. SVG has no z-index; sibling order IS z-order, so the node
      // is moved to the end of #g-stations. Once when a battle opens, never per
      // frame, and the <g> takes its own children with it, so nothing another
      // file appended into it is disturbed. It cannot swallow a click either:
      // everything this file adds is pointer-events:none, so the raised node's
      // hit area is still exactly its own silhouette and numbers.
      if (fight && rec.g.parentNode) rec.g.parentNode.appendChild(rec.g);
    }
    // Only fighting stations pay for any of this; on a quiet board the cost of
    // the whole battle readout is the boolean above, which was already here.
    if (fight) mapBattleLive(D, state, sid, rec);
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
  // One float comparison on the frames where the camera has not moved. This is
  // the safety net for a board drawn before initCamera(); the primary path is
  // the onCameraChange subscription at the bottom of this file, which fires
  // even when the loop is paused and producing no frames at all.
  mapApplySymbolScale(false);
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
  // Stations and labels were built at whatever the scale is right now; record
  // it so the first renderLive() does not rewrite 138 transforms for nothing.
  LIVE.symK = mapSymbolScale();
  mapWireCamera();

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
window.mapApplySymbolScale = mapApplySymbolScale;

// Counter-scale the symbols the moment the camera moves, not on the next frame.
// A wheel zoom with the game paused produces no frames at all, and the stations
// would sit at the old scale until the player unpaused. Guarded: camera.js may
// not be loaded, and it self-bootstraps after this file either way, so the
// subscription is deferred to DOMContentLoaded below.
// Idempotent, and called from renderBoard() rather than only from a
// DOMContentLoaded handler: handler order between render/ and app/ is not
// something this file gets to assume (app/main.js sets APP_OWNS_RENDER inside
// its own DOMContentLoaded callback, so which of the two runs first is already
// load-order-dependent). renderBoard() always runs exactly once per board, so
// hanging the subscription off it is the one hook that cannot be missed.
let MAP_CAM_WIRED = false;

function mapWireCamera() {
  if (MAP_CAM_WIRED) return true;
  if (typeof onCameraChange !== 'function') return false;
  onCameraChange(function () { mapApplySymbolScale(false); });
  MAP_CAM_WIRED = true;
  return true;
}

// Self-bootstrap so the shell is viewable before app/main.js exists. Once the
// app layer lands it sets window.APP_OWNS_RENDER = true and this stands down.
document.addEventListener('DOMContentLoaded', function () {
  if (!window.APP_OWNS_RENDER) renderBoard();
  mapWireCamera();
});
