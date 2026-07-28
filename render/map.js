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
  // Every supply-route chevron on the board, flat. Rebuilt by mapOrderIndex()
  // whenever a route is added or dropped; read by mapApplySymbolScale to hold
  // them at a constant on-screen size, exactly as LIVE.label does for captions.
  LIVE.chev = [];
  // Every drawn supply route, flat, from the same rebuild. Their lines are
  // arcs off the link seam, so — exactly like the links themselves — their
  // shape depends on the symbol scale and has to be re-derived when the camera
  // moves, not only when the player edits a supply list.
  LIVE.ordline = [];
  // Every link path on the board, flat. Links are geography and are NOT
  // counter-scaled, but their two ends are trimmed to the live symbol radius
  // and sea links are bowed around it, so both are functions of the camera —
  // mapApplySymbolScale rewrites them from this list exactly as it rewrites
  // the station transforms.
  LIVE.link = [];
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
  // Supply routes. Their line is an arc off the same seam the links are drawn
  // from, and both the bow and the anchor a chevron sits on are functions of
  // the symbol radius in board units — so they are re-derived here rather than
  // only when the player edits a supply list. Without this pass the routes
  // would visibly slide off their own links as the player zooms, which is worse
  // than a straight line that at least stays put. Zero-length on a board with
  // no supply lines, so it costs nothing until somebody draws one, and an
  // all-land route diffs to the same `d` and writes nothing either.
  for (const rec of (LIVE.ordline || [])) mapOrderRepath(rec);
  // The chevrons themselves: counter-scaled about the anchor the pass above
  // just refreshed, the same bargain every symbol on this map makes.
  for (const rec of (LIVE.chev || [])) {
    setAttr(rec.node, 'transform', mapOrientTransform(rec.x, rec.y, k, rec.deg));
  }
  // Links. Their ENDPOINTS are geography and never move; what moves is where
  // the node symbol stops covering them, and on a sea crossing how far the arc
  // has to bow to get out from under it — both derived from the same symbol
  // scale every station transform above was just written with. Diffed against
  // the last `d`, so the links that did not change shape cost nothing.
  for (const rec of (LIVE.link || [])) mapLinkPath(rec);
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
//
// IT IS HANDED TO liveStations() TOO, and that is a bigger contract than
// territoryControl's. drawStations() finishes by painting the turn-zero
// snapshot through the same path every later frame uses — which is the right
// design, one renderer and no "static mode" — but it means this object has to
// satisfy every read liveStations makes, not just `owner`. It did not: with no
// `units` bag, `const u = st.units; u.infantry` threw, renderBoard() died
// part-way through, and the shell that is supposed to be viewable before
// app/main.js exists took drawTerritoryLabels and drawPowerLegend down with it.
//
// Nothing in the running game noticed, because the start screen creates GAME
// before it calls renderBoard(). A bootstrap path that only runs when something
// else has failed is exactly the path nobody exercises, so it is filled in from
// SETUP rather than zeroed: the pre-game board then shows the real opening
// garrisons, which makes "did the data load?" answerable by looking at it.
//
// EVERY FIELD liveStations READS lives here, `supplyTo` included. A pseudo-state
// that is missing one is not a smaller state, it is a state that throws.
//
// FOG (5.7 stage 3) DELIBERATELY ADDS NOTHING TO THIS LIST, and that is a
// property worth stating rather than a coincidence. The mask is gated on
// `state.human`, which this object does not have and must not gain: no viewer
// means mask nothing, so liveStations never calls believedStation on it and
// never reads `state.seen`. The pre-game board is therefore the unmasked board,
// which is what the empire picker needs — it paints the seven homelands on the
// real map — and it is why this bootstrap path did not have to be re-derived
// for fog at all. The check is `mapFogLevels(setupPseudoState(D)) === null`.
function setupPseudoState(D) {
  const stations = Object.create(null);
  if (D.STATIONS) {
    for (const sid in D.STATIONS) {
      const setup = (D.SETUP && D.SETUP[sid]) || null;
      const u = (setup && setup.units) || null;
      stations[sid] = {
        owner: stationOwner(D, sid) || 'neutral',
        units: {
          infantry: (u && u.infantry) || 0,
          artillery: (u && u.artillery) || 0,
          armour: (u && u.armour) || 0,
        },
        connected: true,
        growthMul: 1,
        supplyTo: [],
      };
    }
  }
  return { stations: stations, tick: 0, waves: [], battles: {}, powers: {} };
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

// ── combat alert — "there is a fight HERE", from across the board ───────
//
// The momentum ring answers *who is winning*. It does not answer *is anyone
// fighting at all* from four inches away: at 1x a saturated ring on a 15-unit
// node is a small mark among 108 small marks, and the player has to sweep the
// board to find it. The complaint, verbatim: *"it should be more visibly
// obvious when combat is happening at a particular location."*
//
// So the ring keeps its job and a second signal takes the new one: two
// ACHROMATIC RIPPLES expanding out of the node and fading, 50% out of phase
// with each other. Everything about that sentence is load-bearing.
//
// MOTION, not colour. Peripheral vision resolves almost no detail and almost no
// hue, but it is extremely sensitive to motion and to luminance change. An
// expanding ring is the strongest cue available for "look over here" and it is
// pure CSS, so the renderer pays nothing per frame for it.
//
// OUTSIDE the momentum ring, never on it. The amber pulse that used to live on
// `.station-battle` was switched off because animating a stroke WIDTH makes two
// adjacent arc LENGTHS hard to compare, and that comparison is the ring's whole
// job. Nothing here touches the ring: the ripples start 2.5 units clear of it
// and travel outward, so the arcs keep a dead-constant 3px stroke.
//
// WHITE, not red — despite red being what was asked for. Red is not available
// on this board. `--warn` (#d1604a) is already the attack-verb colour in
// render/select.js, and `gbr` is #c9524a — an actual ownership hue. A red pulse
// would be the exact failure the amber pulse was removed for, twice over.
// Achromatic is the same escape the fullness ring takes: it claims no hue, so
// it cannot be misread as ownership (§8), and white is the highest-contrast
// mark available on a #0c0f14 board. It still reads as a flash.
//
// TWO, staggered. One ripple is invisible in a still frame caught at its faint
// end — and a still frame is how this gets reviewed, and how a player who
// glances at the board for 200ms sees it. Half a cycle apart, the brighter of
// the pair never drops below ~0.48 stroke-opacity, so there is always something
// to see.
//
// The AMPLITUDE carries the size of the fight: a skirmish throws a 5-unit
// ripple, an army-scale battle a 13-unit one. Chosen over "how close is this to
// resolving" because it is the reading nobody can get backwards — big ring, big
// fight — and because it does not change between frames, so it never flickers.
// It is one inherited custom property on the battlegroup, diff-gated on an
// integer, which in practice is one DOM write per fight for its whole duration.
//
// Cost on a peaceful board: zero. The circles live in the battlegroup, which is
// built on a station's first battle and is `display:none` unless the node
// carries `.is-fighting` — and a `display:none` element runs no animation.
const MAP_ALERT_GAP = 2.5;    // ripples start this far outside the momentum ring
const MAP_ALERT_MIN = 6;      // travel, board units, for the smallest skirmish
const MAP_ALERT_MAX = 15;     // and for the largest battle. Capped, and the cap
                              // is the reason the mapping is not simply linear:
                              // the board's nearest-neighbour gap is 16.9 units,
                              // and a ripple that reaches a neighbour's garrison
                              // number is a second problem, not a louder signal.

// How far this fight's ripple travels, in board units. log10 because Power in
// play spans two or three orders of magnitude across a match and a linear map
// would put every fight but the last at the floor. Rounded to a whole unit so
// the value is a bucket: a battle whose Power drifts by 0.4 a tick produces no
// write at all.
//
// The coefficients are not decoration. The first pass (4 + 3·log10) was measured
// on a staged board and every real fight came out between 8 and 11 units — a
// 3-unit spread, about 3 screen pixels at 1x, which is a channel nobody can
// read. 2 + 4.5·log10 puts a village skirmish at the 6-unit floor and a capital
// assault at the 15-unit cap, a 2.5x ripple, which is a difference you see
// without being told to look for it.
function mapAlertReach(power) {
  const p = (isFinite(power) && power > 0) ? power : 0;
  return clamp(Math.round(2 + 4.5 * Math.log10(1 + p)), MAP_ALERT_MIN, MAP_ALERT_MAX);
}

// ── fog of war — the mask, Milestone 5.7 stage 3 ────────────────────────
//
// core/vision.js decides what a power may READ. This file decides what that
// looks like. Nothing here re-derives a level: `visibleTo` returns 0 or 2 and
// `believedStation` composes the memory into the 0/1/2 table
// (02-visibility-and-sea.md §1), and both are called, never reimplemented.
//
// FOG ADDS NO LAYER OVER THE BOARD, and that is a hard rule rather than a
// preference. It is drawn by SUBTRACTING from #g-stations (a hidden station's
// <g> is display:none) and by MODULATING #g-territories (an unknown country is
// tinted with nobody's colour). A full-board rect painted over #g-stations
// would swallow the click that commits an attack, produce no error whatsoever,
// and simply make the game stop responding — that has happened five times on
// this project. If a wash is ever genuinely wanted it belongs inside
// #g-coverage, which is already pointer-events:none AND already below
// #g-stations, so layer order makes it harmless even if the CSS rule is later
// deleted.
//
// THE PALETTE IS LOCKED (00-vision.md §8: "colour carries ownership only").
// There is no fog hue and there must never be one, or fog reads as an eighth
// power. The three free channels are opacity, stroke dash, and absence:
//
//   0 hidden   the station <g> is absent from the board. The territory polygon
//              is still drawn, untinted. "Territory shape only."
//   1 fogged   the REMEMBERED owner colour at reduced opacity, outline dashed,
//              garrison number in --ink-faint, and the fullness ring REMOVED —
//              you remember who held it and roughly what was in it; you do not
//              know how full it is now, and a ring drawn from a stale number
//              would be a live answer to a stale question.
//   2 visible  byte-identical to a board built before fog existed.
//
// WHO IS LOOKING: `state.human`, and nothing else. `window.PLAYER` is set from
// the query string before the empire picker has run, so reading it would fog
// the picker's board — render/start.js calls renderBoard() while GAME.human is
// still undefined, deliberately (00-vision.md §8, "the pick happens before
// GAME.human is set"). No viewer means MASK NOTHING, which is also what the
// turn-zero pseudo-state and every headless harness get.

// The unknown owner, for the believed board handed to territoryControl(). It is
// deliberately a string no power id can collide with rather than null or
// 'neutral': territoryControl counts owners and then walks POWER_IDS, so a
// sentinel outside that list is counted and then never wins — which is exactly
// what "somebody holds it and I do not know who" should do to a majority test.
const MAP_FOG_UNKNOWN = '~fog~';

// Fogged treatment, as three numbers. Not a colour: the remembered ownership
// hue is kept and only its weight is reduced, so a fogged German city still
// reads as German. Dashed, because a dash is the one silhouette channel §8
// leaves free on a station (it means "sea" on a LINK, and a link is not a node).
const MAP_FOG_DASH = '3.4 2.6';
const MAP_FOG_STROKE_OP = '0.5';
const MAP_FOG_FILL_OP = '0.42';

// visibleTo() is 24-38us and pure. It is safe once a frame and quadratic in a
// 108-station loop, so it is computed ONCE and passed down — the memo below is
// not an optimisation of vision.js (core/vision.js: "DO NOT ADD A CACHE"), it
// is this file declining to ask the same question 108 times in one frame.
//
// The key is (state identity, tick, ownerEpoch, pid). ownerEpoch alone is the
// exact and total invalidation signal for visibility — vision.js names it as
// the sanctioned key — and `tick` is carried as well so this can never outlive
// a tick even if some future path moves a station without the epoch. A PAUSED
// board therefore recomputes nothing at all, and a running one recomputes at
// most once per tick against a 671us tick.
let _mapFogState = null;
let _mapFogTick = -1;
let _mapFogEpoch = -1;
let _mapFogPid = null;
let _mapFogVis = null;
let _mapFogBoard = null;

// Whose eyes the board is drawn through, or null for "nobody — draw it all".
function mapViewer(state) {
  return (state && typeof state.human === 'string' && state.human) ? state.human : null;
}

// { sid: 0|2 } for the viewer, or null when there is no viewer and nothing is
// masked. Every consumer in render/ goes through here so the whole frame — the
// board, the waves, the hit test and the coverage overlay — is masked against
// one answer rather than four that agree today.
function mapFogLevels(state) {
  const pid = mapViewer(state);
  if (!pid || typeof visibleTo !== 'function') return null;
  const tick = state.tick || 0;
  const epoch = state.ownerEpoch || 0;
  if (_mapFogState === state && _mapFogTick === tick &&
      _mapFogEpoch === epoch && _mapFogPid === pid) return _mapFogVis;
  _mapFogState = state;
  _mapFogTick = tick;
  _mapFogEpoch = epoch;
  _mapFogPid = pid;
  _mapFogVis = visibleTo(state, pid);
  _mapFogBoard = null;                 // derived from it; recompute on demand
  return _mapFogVis;
}

// The board AS THE VIEWER BELIEVES IT — a state-shaped object carrying nothing
// but `owner` per station, for handing to core's territoryControl().
//
// This is the proxy-state idiom the AI and render/coverage.js already use, and
// it exists so the tier arithmetic has exactly ONE implementation
// (known-issues #9: this file once kept a second territoryControl and silently
// overwrote the sim's). The believed owner comes out of believedStation, which
// is the only function allowed to mint a level 1.
//
// ⚠ IT MUST NEVER REACH routeFor() / commandRoute(). `_ownRouteCache` in
// sim/movement.js invalidates on state OBJECT IDENTITY, so a fresh proxy handed
// to routing blows the real state's route cache too and movementTick recomputes
// its Dijkstras from scratch every tick — 0.115us becomes 161us, with no wrong
// answer anywhere, only a game that crawls (02-visibility-and-sea.md §1).
// Nothing outside liveTerritories() below is given this object.
function mapBelievedBoard(state, pid, vis) {
  if (_mapFogBoard) return _mapFogBoard;
  const stations = Object.create(null);
  const unknown = Object.create(null);
  const ids = (typeof STATION_IDS !== 'undefined' && STATION_IDS) ? STATION_IDS : [];
  for (let i = 0; i < ids.length; i++) {
    const sid = ids[i];
    const b = believedStation(state, pid, sid, vis);
    if (b.level === 0) {
      stations[sid] = { owner: MAP_FOG_UNKNOWN };
      unknown[sid] = true;
    } else {
      stations[sid] = { owner: b.owner };
    }
  }
  _mapFogBoard = { proxy: { stations: stations }, unknown: unknown };
  return _mapFogBoard;
}

// The control tier of one territory on the believed board.
//
// The arithmetic is core's, unchanged. The ONE case this adds is the case the
// arithmetic cannot express: "contested" is a positive claim — nobody is past
// half — and a country you have only partly seen does not support it. So a
// contested verdict reached with any unknown station in the country is demoted
// to the untinted class instead of the hatch. A country you have seen ALL of
// and which really is split still hatches, which is the whole value of the mark.
//
// A strict majority is never demoted, because it cannot be wrong: three of four
// stations believed German is a majority whatever the fourth turns out to be.
function mapBelievedControl(bel, tid) {
  const c = controlOf(bel.proxy, tid);
  if (c.tier !== 'contested') return c;
  const ids = (typeof stationsIn === 'function') ? stationsIn(tid) : [];
  for (let i = 0; i < ids.length; i++) {
    if (bel.unknown[ids[i]]) return { owner: null, tier: 'contested', cls: 'neutral' };
  }
  return c;
}

// Hidden: the whole station group leaves the board.
//
// `display` is written as an INLINE STYLE, never as an attribute. A stylesheet
// rule silently outranks an SVG presentation attribute with no error anywhere
// (known-issues #15, which has recurred twice on this project and once inside
// this very system), and this is a per-frame computed visual property.
//
// A hidden node also drops any supply routes drawn out of it. Those live in
// #g-links, not inside the station <g>, so display:none on the group does not
// take them with it — and a line drawn out of a city that is no longer on the
// board is the loudest leak fog could possibly ship. In practice a station the
// human owns is always level 2, so this only fires on the frame after a capture
// costs the player its sight; it is here because "in practice" is not a check.
function mapFogHide(rec, hide) {
  if (hide !== rec.hidden) {
    rec.hidden = hide;
    rec.g.style.display = hide ? 'none' : '';
    LIVE.writes++;
    if (hide) {
      let had = false;
      for (const to in rec.ordRoute) { mapOrderDrop(rec, to); had = true; }
      if (had) { rec.ordKey = ''; rec.ordEpoch = -1; mapOrderIndex(); }
    }
  }
  return hide;
}

// Fogged: remembered, not live. Opacity, dash and absence — no new colour.
//
// The fullness ring goes away entirely, track included. It is a PROPORTION of
// the current garrison against capacity, and the current garrison is precisely
// the thing you do not know; drawing it from memory would answer "how full is
// it now" with a number from four minutes ago, which is known-issues #18 in
// render form. The number itself stays, because a stale number marked stale is
// the whole point of level 1 — "decide whether last minute's number is still
// true" (02-visibility-and-sea.md §1).
//
// Every write here is a style. Same reason as mapFogHide above; `opacity`,
// `display` and `stroke-dasharray` written as attributes would be outranked by
// any class rule that ever lands on `.station-shape`.
function mapFogStale(rec, on) {
  if (on === rec.fogged) return;
  rec.fogged = on;
  const sh = rec.shape.style;
  sh.strokeDasharray = on ? MAP_FOG_DASH : '';
  sh.strokeOpacity = on ? MAP_FOG_STROKE_OP : '';
  sh.fillOpacity = on ? MAP_FOG_FILL_OP : '';
  // The number is the interface, so its treatment is the loudest half of this:
  // --ink-faint against --garrison is the difference between "this is what is
  // there" and "this is what was there".
  rec.num.style.fill = on ? 'var(--ink-faint)' : '';
  if (rec.fillArc) rec.fillArc.style.display = on ? 'none' : '';
  if (rec.fillTrack) rec.fillTrack.style.display = on ? 'none' : '';
  LIVE.writes += 5;
}

// ── supply routes ───────────────────────────────────────────────────────
//
// 01-data-schema.md, "Standing orders": a city carries `supplyTo`, the list of
// cities it streams surplus to. Each entry is drawn as THE ROUTE THE UNITS WILL
// ACTUALLY WALK — a solid polyline in the owner's power colour, with chevrons
// repeated along it showing which way the supply flows.
//
// IT USED TO BE AN ARROW ON THE NODE and that was not enough. A 15-unit glyph
// in the slot under the source said "this city supplies somebody, roughly that
// way"; it did not say WHICH somebody, it did not say by what path, and it was
// nearly invisible on a 108-station board. Worse, measured on the live board at
// the 800px window this game is played at: Berlin's lines to Leipzig Works and
// Frankfurt are 6.4 degrees apart, which put their two arrows 2.8 SCREEN PIXELS
// apart while each was 9.8 pixels long. They drew on top of each other, and one
// of them was barred. Neighbouring cities cluster on a real map, so that is the
// normal case rather than a corner. The route is tens of pixels long, cannot be
// occluded by its own sibling, and answers all three questions at once.
//
// THE ROUTE, NOT THE CROW-FLIES SEGMENT. routeFor() is the same
// ownership-aware search applyCommand uses to build the wave, so the line on
// the board is the path the units take, hop by hop. Drawing a straight segment
// where the stream will actually go three hops around a mountain would be a
// readout answering a different question from the one on screen —
// known-issues #18, which this project has already paid for once. Nothing here
// reimplements routing; it asks the one authority.
//
// COLOUR IS OWNERSHIP, which is why it is allowed. §8 reserves colour for who
// holds what, and these lines are exactly that: whose supply this is. With
// three powers running networks across the same ground it is the only channel
// that separates them. Solid, never dashed — a dash already means a sea
// crossing on this board (`.link.is-sea`) and overloading it would make a
// supply line read as water.
//
// WHAT IS DRAWN FOR A CITY THAT SUPPLIES NOWHERE: nothing at all. That is the
// default and, on any real board, what ~all 108 stations carry. The DOM below
// is built lazily on a station's first supply line, so a board nobody has
// ordered renders byte-identically to one built before this existed — checkable
// rather than asserted — and a PAUSED board recomputes nothing, because the two
// things that invalidate a route (the list, and state.ownerEpoch) are both
// state and neither moves while the game is stopped.
//
// POINTER-EVENTS ARE OFF IN THE STYLESHEET, on the group and on every child.
// These lines cross the whole board and pass over dozens of stations. Anything
// painted over the board that accepts pointer events swallows the click that
// commits an attack, with no error at all; that has happened five times on this
// project and this is the largest hit area anything in render/map.js has ever
// added. It is checked on the live board by sampling elementFromPoint along a
// route, not by reading the stylesheet.

// Chevron pointing along +X, filled, ~10.8 units long. Counter-scaled by
// cameraSymbolScale() like every other symbol on this map, so it holds ~7
// screen pixels at 1x through 4x (known-issues #17: a length authored in board
// units and divided by cameraScale() alone is constant under zoom and NOT under
// window size — nothing here divides by anything, the counter-scale does it).
const MAP_ORDER_CHEV_D = 'M-4.8,-6.3 L3.3,0 L-4.8,6.3 L-7.5,3.9 L-2.1,0 L-7.5,-3.9 Z';

// A bar ACROSS the route, for a line that cannot deliver right now. Authored
// perpendicular to +X and rotated with the segment it sits on, so it reads as a
// bar across the pipe at every bearing rather than a stroke along it.
const MAP_ORDER_BLOCK_D = 'M-1.9,-7.0 L1.9,-7.0 L1.9,7.0 L-1.9,7.0 Z';

// Sim ticks between order-plan recomputes. The plan is the one read on the
// board that is not O(1), so it is throttled on SIM TICKS rather than on
// frames: a PAUSED board recomputes never, and a board with no supply lines
// pays nothing at all because the branch below is never entered. 5 ticks
// against BAL.ORDERS.INTERVAL's 25 means the marks can never be more than a
// fifth of a sweep stale, and a freshly-drawn line refreshes immediately
// regardless (see `justOrdered` in liveStations).
//
// ONE PLAN PER POWER PER FRAME, not one per station: standingOrderPlan answers
// for every supplying city a power holds in one pass, so forty sources cost
// what one costs. `_mapOrdPlans` is built lazily inside a frame and dropped at
// the top of the next one — a cache that cannot outlive the state it was
// computed from, which is the only kind this file is allowed to keep.
const MAP_ORDER_BLOCK_TICKS = 5;
let _mapOrdTick = -1e9;
let _mapOrdDue = false;
let _mapOrdPlans = null;

function mapOrderPlan(state, pid) {
  if (!_mapOrdPlans) _mapOrdPlans = Object.create(null);
  if (_mapOrdPlans[pid]) return _mapOrdPlans[pid];
  const p = (typeof standingOrderPlan === 'function') ? standingOrderPlan(state, pid) : {};
  _mapOrdPlans[pid] = p;
  return p;
}

// translate + counter-scale + rotate, for a symbol that has a bearing.
// mapSymbolTransform's sibling; kept separate rather than given an optional
// argument because every other caller writes the two-part form and a rounded
// `rotate(0)` on 138 station groups would be 138 pointless bytes per frame.
function mapOrientTransform(x, y, k, deg) {
  return 'translate(' + x + ',' + y + ') scale(' + (Math.round(k * 100000) / 100000) +
         ') rotate(' + deg + ')';
}

// Every drawn supply route on the board, and every chevron on those routes,
// flat — so mapApplySymbolScale can rewrite them all in one pass, the same
// list-and-rewrite the territory captions use. Rebuilt whenever a route is
// added or dropped, which happens on a player edit or a capture and never per
// frame.
function mapOrderIndex() {
  LIVE.chev = [];
  LIVE.ordline = [];
  for (const sid in LIVE.stat) {
    const routes = LIVE.stat[sid].ordRoute;
    for (const to in routes) {
      const route = routes[to];
      LIVE.ordline.push(route);
      const marks = route.marks;
      for (let i = 0; i < marks.length; i++) LIVE.chev.push(marks[i]);
    }
  }
}

// Build or rebuild one route: source -> destination, over the path the sweep's
// own routing says the units will walk.
//
// UNREACHABLE STILL DRAWS. routeFor returns null when every path runs through
// ground this power does not hold, and the honest thing on screen is not
// silence — the player asked for this line and it is real, it just cannot
// deliver. So the crow-flies segment is drawn and the caller marks it blocked,
// which is exactly what the planner reports ('unreachable'). A line that
// vanishes when a corridor is cut looks identical to one the player never drew.
//
// ON THE LINKS, NOT ACROSS THEM. Every hop comes out of the route seam above,
// so a supply line over a sea crossing follows the same bowed arc the link is
// painted on and the same arc render/waves.js walks its markers down. That is
// not decoration: the stream a supply line describes IS a wave, drawn by
// waves.js on the arc, so a straight line here would have the player's own
// convoy visibly floating off the pipe it was sent down — one geometry rule
// with two answers, which is known-issues #9 in its most legible form.
//
// The unreachable case needs no branch. It hands the seam two stations with no
// link between them, which resolves to sagitta 0 — exactly the straight
// crow-flies segment this drew before — because it is not a sea crossing, not
// because anything here asks whether it is a route.
function mapOrderRoute(D, state, rec, sid, to) {
  const layer = byId('g-links');
  const dst = D.STATIONS && D.STATIONS[to];
  if (!layer || !dst || !dst.pos) return null;

  const path = (typeof routeFor === 'function')
    ? routeFor(state, state.stations[sid].owner, sid, to) : null;
  // Station IDS, not points: the seam is keyed on ids, because the arc between
  // two stations depends on their symbol radii and not only on where they are.
  const hops = (path && path.length >= 2) ? path.slice() : [sid, to];
  const geoms = linkRouteGeoms(hops);
  if (!geoms) return null;

  const g = el('g', 'station-orderroute');
  const color = powerColor(D, state.stations[sid].owner) || '#ffffff';
  const d = linkRouteD(geoms);
  const line = el('path', 'station-orderline', { d: d });
  // Written as a STYLE, not an attribute. The colour is computed by this
  // renderer from live state, and a presentation attribute sits at the bottom
  // of the cascade where any stray class rule outranks it silently —
  // known-issues #15, which has recurred twice on this project, both times on a
  // stroke or a fill-opacity exactly like this one.
  line.style.stroke = color;
  g.appendChild(line);

  // One chevron per HOP, at the midpoint OF ITS ARC, size counter-scaled so it
  // holds its screen size at every zoom. Spacing therefore comes from the map's
  // own geography: a long multi-hop route gets several, a single hop gets one,
  // and nothing has to measure a length in pixels to decide.
  //
  // Its position used to be pure board space and was reached only by the scale
  // rewrite. A bowed hop's apex is a function of the symbol radius in board
  // units, so it MOVES with the camera now — mapOrderRepath below re-derives
  // every anchor on a camera change, immediately before the pass that writes
  // these transforms. A land hop lands on the numbers it already had.
  const k = mapSymbolScale();
  const marks = [];
  for (let i = 0; i < geoms.length; i++) {
    const m = _mapHopMark(geoms[i]);
    const node = el('path', 'station-orderchev', {
      d: MAP_ORDER_CHEV_D, transform: mapOrientTransform(m.x, m.y, k, m.deg),
    });
    node.style.fill = color;
    g.appendChild(node);
    marks.push({ node: node, x: m.x, y: m.y, deg: m.deg, hop: i });
  }

  // The bar, on the middle hop, shown only while the route is blocked.
  const mid = geoms.length > 1 ? Math.floor(geoms.length / 2) : 0;
  const bm = _mapHopMark(geoms[mid]);
  const bar = el('path', 'station-orderbar', {
    d: MAP_ORDER_BLOCK_D, transform: mapOrientTransform(bm.x, bm.y, k, bm.deg),
  });
  g.appendChild(bar);
  marks.push({ node: bar, x: bm.x, y: bm.y, deg: bm.deg, hop: mid });

  layer.appendChild(g);
  return {
    g: g, line: line, hops: hops, d: d, marks: marks,
    epoch: state.ownerEpoch || 0,
  };
}

// Re-derive one drawn route for a new camera scale, diffed. Only the SHAPE is
// camera-dependent — where the arcs bow to clear the symbols — so a route with
// no water on it produces the identical `d` and writes nothing at all.
function mapOrderRepath(route) {
  if (!route || !route.line || !route.hops) return;
  const geoms = linkRouteGeoms(route.hops);
  if (!geoms) return;
  const d = linkRouteD(geoms);
  if (d !== route.d) {
    route.d = d;
    setAttr(route.line, 'd', d);
  }
  // The marks are not written here: their transforms are rewritten for the new
  // scale by the one pass in mapApplySymbolScale that writes every counter-
  // scaled symbol on the board. This only moves the anchor it will use.
  for (let i = 0; i < route.marks.length; i++) {
    const m = route.marks[i];
    const g = geoms[m.hop];
    if (!g) continue;
    const p = _mapHopMark(g);
    m.x = p.x;
    m.y = p.y;
    m.deg = p.deg;
  }
}

function mapOrderDrop(rec, to) {
  const r = rec.ordRoute[to];
  if (r && r.g && r.g.parentNode) r.g.parentNode.removeChild(r.g);
  delete rec.ordRoute[to];
  delete rec.ordBlocked[to];
}

// Reconcile this station's drawn routes against the list in state. Called only
// when that list changed, or when a capture moved state.ownerEpoch and the
// routes may therefore run somewhere else — never per frame.
function mapOrderAim(D, state, rec, sid, targets, epoch) {
  const want = Object.create(null);
  for (let i = 0; i < targets.length; i++) {
    const to = targets[i];
    want[to] = true;
    const have = rec.ordRoute[to];
    if (have && have.epoch === epoch) continue;      // still the same path
    if (have) mapOrderDrop(rec, to);
    const built = mapOrderRoute(D, state, rec, sid, to);
    if (built) rec.ordRoute[to] = built;
    LIVE.writes++;
  }
  for (const to in rec.ordRoute) if (!want[to]) mapOrderDrop(rec, to);
}

// Mark the routes that are shipping nothing. `plan.edges` is the sim's
// per-destination answer, so this file decides nothing — it draws what
// _ordPlanPower already worked out, which is what makes the board and any panel
// structurally unable to disagree (known-issues #18).
//
// The chevrons ARE the flow, so a blocked route simply stops having any: no
// arrows moving down it, plus a bar across it and the line itself dimmed. That
// needs no legend and no second colour.
function mapOrderFlow(rec, next) {
  const edges = (next && next.edges) || [];
  const blocked = Object.create(null);
  for (let i = 0; i < edges.length; i++) {
    if (!(edges[i].units > 0)) blocked[edges[i].target] = true;
  }
  for (const to in rec.ordRoute) {
    const stuck = !!blocked[to];
    if (stuck === (rec.ordBlocked[to] === true)) continue;
    rec.ordBlocked[to] = stuck;
    rec.ordRoute[to].g.classList.toggle('is-blocked', stuck);
    LIVE.writes++;
  }
}

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

// ── link geometry — ONE rule, two consumers ─────────────────────────────
//
// This block is the single authority for "where does the line between two
// stations actually run". `drawLinks` below paints it; `render/waves.js` walks
// markers and trails along it. There is deliberately no second derivation:
// known-issues #9 and #12 are both "two implementations of one geometry rule",
// and a wave that travelled the chord while the link was drawn as an arc would
// be that bug in its most visible form — every sea crossing on the board with
// its army floating off its own route.
//
// THE PROBLEM THIS SOLVES. Links used to be drawn centre to centre. A station
// symbol is ~12 screen px of radius, and five sea crossings on this map are
// shorter than two symbols laid end to end — Dover to Lille is 27 board units
// between centres against 18 + 22 of node. The line's visible length was
// NEGATIVE: the two nodes covered all of it and then some. Those five carry
// 42% of the sea traffic on the board, so the single most punishing move in
// the game (§3, "sea crossings are simply slow and punishing") was invisible
// at the exact places it mattered most. No amount of colour or dash fixes a
// line of length zero.
//
// So, two changes, and they are not independent:
//
//   1. every link is TRIMMED to the symbol edge, so a line starts and ends
//      where the node stops rather than under it;
//   2. a SEA link is BOWED into an arc whose apex clears the bigger of the two
//      symbols. That is the only geometry that can be visible between two
//      overlapping discs — and it doubles as the "this is water" signal, which
//      a dash never managed against a dark blue sea.
//
// The sagitta is DERIVED, not authored: it is whatever it takes for the apex
// to stand `LINK_SEA_CLEAR` clear of the larger node, floored by a proportion
// of the chord so a long crossing still reads as a curve. A short link
// therefore bows hard and a long one bows gently, which is the correct
// relationship — the bow exists to escape the symbols, and only a short link
// is in trouble. It is also self-correcting under zoom: the symbols
// counter-scale, so at 2x there is more open water and the derived term falls
// away to the proportional floor on its own.
//
// The symbol radius comes from mapNodeExtents(), which is the SAME table
// drawStations() sizes the nodes from — not a second guess at the same number
// (known-issues #17 is three files independently authoring one screen-space
// constant). It is multiplied by mapSymbolScale() because the station groups
// are counter-scaled and the links are not, so the node's radius IN BOARD
// UNITS shrinks as the camera zooms in.

const LINK_TRIM_GAP = 1;          // …and clear of the fullness ring track too
const LINK_SEA_CLEAR = 7;         // board units the arc's apex clears the node by
const LINK_SEA_BOW_FRAC = 0.10;   // never flatter than this share of the chord
// Below this much visible line, a LAND link is left untrimmed rather than
// drawn as a stub: two land stations whose symbols overlap are exactly as they
// were before this existed, which is a thing that can be checked rather than a
// new failure mode invented to fix an old one. Sea links never reach it — the
// bow above guarantees them clearance.
const LINK_TRIM_MIN = 6;

// sid -> { r, outer }: the node's radius and the extent of its silhouette,
// derived once from the static capacity table. drawStations() reads the same
// record, so the line stops exactly where the shape it was measured against
// stops.
let _mapExtent = null;

function mapNodeExtents() {
  if (_mapExtent) return _mapExtent;
  const S = (typeof STATIONS !== 'undefined') ? STATIONS : null;
  const out = Object.create(null);
  if (!S) return out;               // not cached — the data may still be coming
  let capMin = Infinity;
  let capMax = -Infinity;
  for (const sid in S) {
    const c = Number(S[sid] && S[sid].capacity);
    if (!isFinite(c)) continue;
    if (c < capMin) capMin = c;
    if (c > capMax) capMax = c;
  }
  for (const sid in S) {
    const st = S[sid];
    const r = stationRadius(st && st.capacity, capMin, capMax);
    out[sid] = { r: r, outer: mapOuterExtent(st && st.type, r) };
  }
  _mapExtent = out;
  return out;
}

// Is this crossing water? Asked of sim/movement.js's link index rather than
// re-scanned out of LINKS here — same rule, one authority (known-issues #9).
function _mapLinkIsSea(a, b) {
  if (typeof linkBetween !== 'function') return false;
  const l = linkBetween(a, b);
  return !!(l && l.sea);
}

// The rendered path between two stations, oriented from -> to.
//
// `p1` (the quadratic's control point) is computed from a CANONICAL ordering of
// the two ids, so `linkPathGeom('dov','lil')` and `linkPathGeom('lil','dov')`
// describe the identical arc traversed in opposite directions. A wave crossing
// the Channel southbound and the link drawn northbound must be the same curve
// or the marker leaves the road.
//
// A land link gets sagitta 0, and a quadratic with its control point at the
// midpoint IS the straight segment — exactly, not approximately. So there is
// one code path here, not a curve case and a line case.
function linkPathGeom(fromSid, toSid) {
  const S = (typeof STATIONS !== 'undefined') ? STATIONS : null;
  const sa = S && S[fromSid];
  const sb = S && S[toSid];
  const A = sa && sa.pos;
  const B = sb && sb.pos;
  if (!A || !B || A.length < 2 || B.length < 2) return null;

  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const k = mapSymbolScale();
  const ext = mapNodeExtents();
  const ea = ext[fromSid];
  const eb = ext[toSid];
  // Out to the fullness ring's track, not just to the silhouette: the track is
  // drawn on every station whether or not it is full, so a line stopping at the
  // shape alone still crosses a ring.
  const r0 = ea ? (ea.outer + RING_GAP + LINK_TRIM_GAP) * k : 0;
  const r1 = eb ? (eb.outer + RING_GAP + LINK_TRIM_GAP) * k : 0;

  const sea = _mapLinkIsSea(fromSid, toSid);

  let nx = 0;
  let ny = 0;
  let sag = 0;
  if (len > 0) {
    const flip = (String(fromSid) > String(toSid)) ? -1 : 1;
    const ux = (dx / len) * flip;
    const uy = (dy / len) * flip;
    nx = -uy;                       // canonical outward normal
    ny = ux;
    if (sea) {
      // Apex clearance: the apex sits sqrt((len/2)^2 + sag^2) from either end,
      // so requiring that to reach `need` inverts to this exactly.
      const need = Math.max(r0, r1) + LINK_SEA_CLEAR * k;
      const half = len / 2;
      const sMin = (need > half) ? Math.sqrt(need * need - half * half) : 0;
      sag = Math.max(sMin, len * LINK_SEA_BOW_FRAC);
    }
  }
  // Control point at 2x the sagitta: a quadratic passes through the midpoint of
  // P0 and P1 and P2, i.e. half way to its control point.
  return {
    p0: [A[0], A[1]],
    p1: [(A[0] + B[0]) / 2 + nx * sag * 2, (A[1] + B[1]) / 2 + ny * sag * 2],
    p2: [B[0], B[1]],
    len: len, sea: sea, sag: sag, r0: r0, r1: r1, nx: nx, ny: ny,
  };
}

// The point at fraction t along a rendered path, plus the unit tangent there
// and the arc's outward normal. `t` is the bezier parameter, which for a land
// link is exactly the fraction of the way along and for a bowed one is close
// enough that a marker stays on its own line — which is the only thing anything
// here needs it for.
function linkGeomPoint(g, t) {
  const u = 1 - t;
  let dx = 2 * (u * (g.p1[0] - g.p0[0]) + t * (g.p2[0] - g.p1[0]));
  let dy = 2 * (u * (g.p1[1] - g.p0[1]) + t * (g.p2[1] - g.p1[1]));
  const m = Math.sqrt(dx * dx + dy * dy) || 1;
  return {
    x: u * u * g.p0[0] + 2 * u * t * g.p1[0] + t * t * g.p2[0],
    y: u * u * g.p0[1] + 2 * u * t * g.p1[1] + t * t * g.p2[1],
    tx: dx / m, ty: dy / m, nx: g.nx, ny: g.ny,
  };
}

// The sub-arc between t0 and t1 as a path `d`. Exact — the standard quadratic
// subdivision, not a polyline approximation — so a trimmed link and a wave's
// trail along the same crossing lie on top of each other to the pixel.
function linkGeomD(g, t0, t1) {
  const a = linkGeomPoint(g, t0);
  const b = linkGeomPoint(g, t1);
  const u0 = 1 - t0;
  const u1 = 1 - t1;
  const cx = u0 * u1 * g.p0[0] + (u0 * t1 + u1 * t0) * g.p1[0] + t0 * t1 * g.p2[0];
  const cy = u0 * u1 * g.p0[1] + (u0 * t1 + u1 * t0) * g.p1[1] + t0 * t1 * g.p2[1];
  return 'M' + a.x.toFixed(2) + ',' + a.y.toFixed(2) +
         ' Q' + cx.toFixed(2) + ',' + cy.toFixed(2) +
         ' ' + b.x.toFixed(2) + ',' + b.y.toFixed(2);
}

function _mapDist2(g, t, c) {
  const p = linkGeomPoint(g, t);
  const dx = p.x - c[0];
  const dy = p.y - c[1];
  return dx * dx + dy * dy;
}

// First t out from `tEnd` at which the curve leaves the disc of radius r around
// `c`. Bisection rather than a closed form: the closed form is a quartic, and
// eighteen halvings of a unit interval is 4e-6 of a parameter — far below a
// pixel — for about twenty multiplies.
function _mapTrimT(g, c, r, tEnd, tMid) {
  if (!(r > 0)) return tEnd;
  if (_mapDist2(g, tMid, c) < r * r) return tMid;   // symbol swallows the half
  let lo = tEnd;                                    // inside
  let hi = tMid;                                    // outside
  for (let i = 0; i < 18; i++) {
    const m = (lo + hi) / 2;
    if (_mapDist2(g, m, c) < r * r) lo = m; else hi = m;
  }
  return hi;
}

// [t0, t1] — where the drawn line should start and stop.
function linkGeomTrim(g) {
  if (!(g.len > 0)) return [0, 1];
  const t0 = _mapTrimT(g, g.p0, g.r0, 0, 0.5);
  const t1 = _mapTrimT(g, g.p2, g.r1, 1, 0.5);
  if (!(t1 > t0)) return [0, 1];
  if (!g.sea && (t1 - t0) * g.len < LINK_TRIM_MIN * mapSymbolScale()) return [0, 1];
  return [t0, t1];
}

// ── the same seam, for a whole ROUTE ────────────────────────────────────
//
// A route is a list of station ids, and every consumer that draws one wants the
// same three things: the geometry hop by hop, one `d` that walks all of it, and
// a polyline dense enough to walk by arc length. Both drawers of routes on this
// board — the supply lines below and the volley preview in render/select.js —
// call these rather than each looping over linkPathGeom themselves. A second
// loop in another file is exactly the shape of known-issues #9/#12, which this
// project has now logged three times.
//
// A pair of stations with NO LINK between them still resolves, and resolves
// STRAIGHT: _mapLinkIsSea reports false, the sagitta is 0, and a quadratic with
// its control point at the midpoint is exactly the segment. So the crow-flies
// fallback drawn for an unreachable supply destination is straight because it
// is not a sea crossing — not because anything here branches on it.

// Samples per bowed hop when a route is walked by arc length. Eight chords
// across a curve whose sagitta is at most a tenth of its span puts the walker
// well inside a pixel of the drawn `d`, and a sag-0 hop is skipped entirely, so
// an all-land route costs precisely what it did before this existed.
const LINK_ARC_STEPS = 8;

function linkRouteGeoms(path) {
  if (!path || path.length < 2) return null;
  const out = [];
  for (let i = 0; i < path.length - 1; i++) {
    const g = linkPathGeom(path[i], path[i + 1]);
    if (!g) return null;
    out.push(g);
  }
  return out;
}

// One continuous `d` for the whole route. Each hop contributes its own
// quadratic; the leading moveto of every hop after the first is dropped,
// because its point is the previous hop's endpoint EXACTLY — same station, same
// seam — so the result is a single subpath and a bend at a transit city renders
// as a join rather than as two capped ends butting together.
function linkRouteD(geoms) {
  if (!geoms || !geoms.length) return '';
  let d = linkGeomD(geoms[0], 0, 1);
  for (let i = 1; i < geoms.length; i++) {
    const seg = linkGeomD(geoms[i], 0, 1);
    const q = seg.indexOf(' Q');
    d += (q < 0) ? (' ' + seg) : seg.slice(q);
  }
  return d;
}

// The route as a polyline. For anything that has to place something a fixed
// DISTANCE along a route — an ETA label — the chord between two stations is the
// wrong ruler on a bowed hop, and it is wrong in the one place it matters most:
// the short Channel crossings, whose whole visible length is the bow.
function linkRoutePoints(geoms) {
  if (!geoms || !geoms.length) return null;
  const out = [[geoms[0].p0[0], geoms[0].p0[1]]];
  for (let i = 0; i < geoms.length; i++) {
    const g = geoms[i];
    const n = (g.sag > 0) ? LINK_ARC_STEPS : 1;
    for (let s = 1; s <= n; s++) {
      const P = linkGeomPoint(g, s / n);
      out.push([P.x, P.y]);
    }
  }
  return out;
}

// Where a marker sits on one hop, and which way it faces: the MIDPOINT OF THE
// ARC and the tangent there, not the midpoint of the chord. On a land hop the
// two are the same point to the last decimal; on a bowed crossing the chord's
// midpoint is off the line by the full sagitta, which is the one place a
// chevron would visibly float.
function _mapHopMark(g) {
  const p = linkGeomPoint(g, 0.5);
  return {
    x: p.x, y: p.y,
    deg: Math.round(Math.atan2(p.ty, p.tx) * 180 / Math.PI * 10) / 10,
  };
}

// Write one link's `d`, diffed. Called at build time and again from
// mapApplySymbolScale on every camera change.
function mapLinkPath(rec) {
  const g = linkPathGeom(rec.a, rec.b);
  if (!g) return;
  const t = linkGeomTrim(g);
  const d = linkGeomD(g, t[0], t[1]);
  if (d === rec.d) return;
  rec.d = d;
  setAttr(rec.node, 'd', d);
}

function drawLinks(D, layer) {
  if (!D.LINKS || !D.STATIONS) return 0;
  LIVE.link = [];
  let drawn = 0;
  for (const link of D.LINKS) {
    const a = D.STATIONS[link && link.a];
    const b = D.STATIONS[link && link.b];
    if (!a || !b || !a.pos || !b.pos) {
      console.warn('[render/map] link references an unknown station:', link);
      continue;
    }
    // A <path>, not a <line>: a straight link is the sag-0 case of the same
    // quadratic, so there is one element type and one geometry function rather
    // than a branch that could drift.
    const node = el('path', 'link' + (link.sea ? ' is-sea' : ''), {
      'data-link': link.a + '-' + link.b,
    });
    const rec = { node: node, a: link.a, b: link.b, d: null };
    LIVE.link.push(rec);
    mapLinkPath(rec);
    layer.appendChild(node);
    drawn++;
  }
  return drawn;
}

function drawStations(D, layer, state) {
  const ids = Object.keys(D.STATIONS).sort();
  // One table, shared with the link geometry above. It used to be a capMin /
  // capMax sweep right here and a stationRadius() call per node; links now need
  // the same two numbers to know where a node stops, and two sweeps agreeing
  // today is exactly the shape of known-issues #9.
  const ext = mapNodeExtents();

  let drawn = 0;
  for (const sid of ids) {
    const st = D.STATIONS[sid];
    if (!st || !st.pos || st.pos.length < 2) {
      console.warn('[render/map] station "' + sid + '" has no usable pos; skipped');
      continue;
    }
    const e = ext[sid];
    const r = e ? e.r : (NODE_R_MIN + NODE_R_MAX) / 2;

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

    const outer = e ? e.outer : mapOuterExtent(st.type, r);

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
    // Kept, not appended-and-forgotten: fog removes the whole ring, and the
    // track is the denominator half of it. Hiding the arc alone would leave a
    // full faint circle on a fogged node saying "out of this much", which is a
    // denominator for a numerator that is no longer on screen.
    const fillTrack = el('circle', 'station-fill-track', { r: ringR });
    g.appendChild(fillTrack);
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
      g: g, shape: shape, num: num, fillArc: fillArc, fillTrack: fillTrack,
      pos: [st.pos[0], st.pos[1]],
      capacity: Number(st.capacity) || 0,
      owner: undefined, garrison: undefined, cut: undefined, fight: undefined,
      fillBucket: undefined,
      // Fog, as last WRITTEN. Both start false, which is what an unmasked board
      // is, so a game with no viewer never touches either.
      hidden: false, fogged: false,
      // Supply routes: DOM on this station's first supply line and not before.
      // `ordKey` is the joined destination list as last DRAWN — the empty
      // string on an untouched board, which is what every station's empty
      // `supplyTo` joins to, so the build branch is taken exactly never and an
      // untouched board pays nothing. Comparing a joined string rather than the
      // array is what makes "did this list change?" one compare instead of a
      // walk, on 108 stations every frame.
      ordKey: '', ordEpoch: -1,
      ordRoute: Object.create(null),    // destination -> { g, marks, epoch }
      ordBlocked: Object.create(null),  // destination -> last drawn bar state
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

  // Combat alert, first in the group so it paints UNDER the momentum arcs and
  // the attacker number — the alert is there to be caught out of the corner of
  // the eye, the readout is there to be read, and the readout wins any overlap.
  // Both circles are identical; the phase offset is a class, and the amplitude
  // is a custom property inherited from this group, so per-fight state is one
  // property on one element rather than two.
  const alertR = rec.momR + MAP_ALERT_GAP;
  g.appendChild(el('circle', 'station-alert', { r: alertR }));
  g.appendChild(el('circle', 'station-alert is-late', { r: alertR }));

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
  rec.bat = {
    arcs: arcs, cache: cache, num: num, text: null, color: null, tick: -1,
    g: g, alertR: alertR, reach: null,
  };
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

  // Combat alert amplitude. A scale FACTOR rather than a radius, because the
  // ripple expands by animating `transform: scale()` about its own centre and
  // the circles are built at a radius that varies with node size. Written as an
  // inline custom property on the group — a per-frame visual value must be a
  // style, not an attribute (docs/testing/known-issues.md #15), and custom
  // properties inherit, so one write feeds both ripples.
  const reach = mapAlertReach(total);
  if (reach !== bat.reach) {
    bat.reach = reach;
    const k = Math.round(((bat.alertR + reach) / bat.alertR) * 100) / 100;
    bat.g.style.setProperty('--alert-k', String(k));
    LIVE.writes++;
  }

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
  // ONE visibility solve for the whole board, not one per station. Null when
  // there is no viewer — the empire picker, the turn-zero pseudo-state, a
  // harness — in which case nothing below masks anything and this function is
  // the function it was before fog existed.
  const vis = mapFogLevels(state);
  const me = mapViewer(state);
  const believes = !!(vis && typeof believedStation === 'function');

  for (const sid in LIVE.stat) {
    const rec = LIVE.stat[sid];
    const st = state.stations[sid];
    if (!st) continue;

    // ── the fog gate ────────────────────────────────────────────────────
    //
    // believedStation() composes live sight and memory into the 0/1/2 table and
    // is the ONLY function that mints a 1. Every value painted below comes out
    // of it rather than off `st`, so there is no path by which a fogged node can
    // show a live number: the live record is simply not read.
    let level = 2;
    let bOwner = st.owner;
    let bUnits = st.units;
    let bConn = st.connected !== false;
    if (believes) {
      const b = believedStation(state, me, sid, vis);
      level = b.level;
      bOwner = b.owner;
      bUnits = b.units;
      bConn = b.connected;
    }
    // Hidden: off the board, and nothing else about it is drawn or computed.
    if (mapFogHide(rec, level === 0)) continue;
    mapFogStale(rec, level === 1);

    // Ownership colour — from the BELIEVED board, never from SETUP and never
    // from `st` directly. The saturated colour lives in the outline and the
    // fill stays dark so the number keeps its contrast (§8).
    const owner = bOwner && bOwner !== 'neutral' ? bOwner : null;
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
    // At level 1 this is the garrison AS OF `b.tick`, and mapFogStale has
    // already said so in ink; regaining sight rewrites it on the same frame,
    // because the value compared here came from believedStation either way.
    const total = mapUnitTotal(bUnits);
    const n = Math.floor(total);
    if (n !== rec.garrison) {
      rec.garrison = n;
      setText(rec.num, formatNum(n));
    }

    // Fullness arc. Bucketed so a garrison drifting up by 0.03 units a tick
    // does not produce a DOM write every frame — the ring only moves when it
    // would move by a visible amount.
    //
    // LEVEL 2 ONLY. The ring is "how full is this station RIGHT NOW", and at
    // level 1 the ring is not on screen at all (mapFogStale removes it), so
    // computing a bucket from a remembered number would be arithmetic nobody
    // can see, cached into rec.fillBucket, and then wrong the moment sight
    // returns. The last written bucket is left exactly as it is and the frame
    // that regains sight corrects it.
    if (level === 2 && rec.fillArc && rec.capacity > 0) {
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

    // Supply lines. Read through core's accessor, never off the raw field:
    // stationSupply() defaults a state built before the field existed and is
    // the one place "no supply lines" is spelled, and this renderer must not be
    // the second place that rule is written down.
    //
    // NEVER CACHED ACROSS A CAPTURE. setStationOwner() empties `supplyTo`
    // (01-data-schema.md: "an order does not survive a capture"), and the sweep
    // drops individual edges whose destination has changed hands — so a
    // captured city's routes have to vanish on their own, which they do,
    // because the list compared here is re-read from state every frame and the
    // only thing remembered is what was last DRAWN. There is no path by which
    // this file can keep showing a line the sim has already cleared.
    //
    // TWO THINGS INVALIDATE A ROUTE, and ownerEpoch is the second. The list can
    // be unchanged while the PATH between the same two cities is not: routeFor
    // is ownership-aware, so a capture three provinces away can reroute a stream
    // around a corridor that just closed. Redrawing only on a list change would
    // leave the board showing a path the units have stopped taking — the same
    // class of quiet lie as a stale number, and harder to notice because a line
    // that is merely in the wrong place still looks like a line.
    //
    // Both are STATE, so a paused board recomputes neither: two integer/string
    // compares per station per frame, which is the whole cost of this feature
    // until somebody draws a line.
    //
    // THE HUMAN'S OWN CITIES ONLY, under fog. A supply route is logistics: it
    // names a destination, a path and a flow rate, and drawing an enemy's would
    // hand the player a live read of where a rival is massing and by which
    // corridor — from a city they may only be looking at from memory. The
    // filter is `[]` rather than a skip on purpose: an empty list is exactly
    // what the reconciler below already means by "this city supplies nowhere",
    // so a city that changes hands tears its lines down through the same path
    // it always did, with no second rule about when a route dies.
    const mine = !me || st.owner === me;
    const supply = !mine ? [] : (typeof stationSupply === 'function')
      ? stationSupply(state, sid)
      : (st.supplyTo || []);
    const key = supply.join(',');
    const epoch = state.ownerEpoch || 0;
    let justOrdered = false;
    if (key !== rec.ordKey || epoch !== rec.ordEpoch) {
      const listChanged = key !== rec.ordKey;
      rec.ordKey = key;
      rec.ordEpoch = epoch;
      justOrdered = true;
      // Nothing is drawn for a city that supplies nowhere, and on an untouched
      // board that is every city — so DOM is built only when a line actually
      // arrives, and a board nobody has ordered has no order DOM at all.
      // mapOrderAim adds and removes per destination, so an edit that changes
      // one line of four leaves the other three alone.
      if (supply.length || listChanged) {
        mapOrderAim(D, state, rec, sid, supply, epoch);
        mapOrderIndex();
        LIVE.writes++;
      }
    }

    // Which of those pipes is actually flowing? See MAP_ORDER_BLOCK_D. Only
    // supplying cities pay anything here: a board with no lines — which is every
    // board until the player draws one — never enters this branch at all, and a
    // station whose answer has not changed costs one boolean compare per line
    // and zero DOM writes. `justOrdered` overrides the tick throttle so drawing
    // a line while the game is PAUSED still shows the answer on the next frame
    // rather than at the next tick that never comes.
    if (supply.length && (_mapOrdDue || justOrdered)) {
      mapOrderFlow(rec, mapOrderPlan(state, st.owner)[sid]);
    }

    // Cut off from its capital: not growing, actively decaying (§5). Believed,
    // like everything else — at level 1 this is whether it was cut when you last
    // looked, which is a fact about the past and is drawn as one by the same
    // dashed, dimmed treatment the rest of the node carries.
    const cut = bConn === false;
    if (cut !== rec.cut) {
      rec.cut = cut;
      rec.g.classList.toggle('is-cut', cut);
      LIVE.writes++;
    }

    // A BATTLE YOU CANNOT SEE IS INVISIBLE. Gated on level 2 at the station,
    // not on the fight itself: the momentum ring, the attacker's count and the
    // combat alert are all live reads of `state.stations[sid].attackers` and
    // `stationPower()`, so any of them on a fogged node would be a live answer
    // beside a remembered one. Nothing is remembered about a fight either —
    // state.seen records owner, units, connected and a tick, and a battle is
    // none of those.
    const fight = level === 2 && stationContested(state, sid);
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

// The country tint was the LOUDEST LEAK on the board and it is worth naming why.
//
// A territory is tinted by its controller, and that tier is derived from who
// owns the stations in it — every one of them, seen or not. So on a board where
// every node was correctly hidden, the tint still announced that Serbia had
// fallen to Austria, that Russia had taken the Baltic, that the Ottomans held
// all of Anatolia: the shape of the whole war, from cities the player had never
// laid eyes on. Hiding the nodes and leaving the tint would have been fog that
// hid the detail and published the summary.
//
// It is masked by recomputing the tier against the BELIEVED board and by
// nothing else. The polygon is always drawn — "Hidden: territory shape only"
// (02-visibility-and-sea.md §1) — it simply carries nobody's colour until the
// player has seen enough of the country to say whose it is.
//
// The standings are NOT fogged, and that is a separate, deliberate hole:
// 02-visibility-and-sea.md's sequencing section decides that "who is winning is
// public knowledge", so the HUD's territory count and render/victory.js keep
// reading the true board. Fog covers what is in a city, not who holds the map —
// and those two files belong to other hands in any case.
function liveTerritories(D, state) {
  if (!state || !state.stations) return;
  const vis = mapFogLevels(state);
  const me = mapViewer(state);
  const bel = (vis && typeof believedStation === 'function')
    ? mapBelievedBoard(state, me, vis) : null;
  for (const tid in LIVE.terr) {
    const rec = LIVE.terr[tid];
    const ctrl = bel ? mapBelievedControl(bel, tid) : controlOf(state, tid);
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
  // The blocked-feeder read's tick gate, opened once here rather than tested per
  // station: a paused board never advances state.tick, so it never reopens and
  // the whole read costs nothing while the game is stopped.
  _mapOrdDue = (state.tick - _mapOrdTick) >= MAP_ORDER_BLOCK_TICKS;
  if (_mapOrdDue) _mapOrdTick = state.tick;
  _mapOrdPlans = null;            // never survives the frame it was computed in
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
// The link-geometry seam. render/waves.js and render/select.js are the other
// consumers: markers, trails, supply lines and volley previews all ride the
// same curve this file paints, out of these functions, so "the wave is on the
// link" and "the preview is on the link" are structural rather than a
// coincidence between files edited on the same afternoon.
//
// It is deliberately "resolve the link once, then sample it" rather than one
// `linkPathPoint(a, b, t)` call: renderWaves runs this per wave per frame and
// the resolve is the part that costs anything (a linkBetween lookup, the
// extents table, the symbol scale). Nothing else is exported — every wrapper
// that had no caller is gone, because in a globals-only project an exported
// name nobody uses is a collision waiting for its second author
// (known-issues #12).
window.linkPathGeom = linkPathGeom;
window.linkGeomPoint = linkGeomPoint;
window.linkGeomD = linkGeomD;
window.linkGeomTrim = linkGeomTrim;
// …and the route-level layer over it, for the two things on this board that
// are drawn along a SEQUENCE of links: the supply lines above and the volley
// preview in render/select.js.
window.linkRouteGeoms = linkRouteGeoms;
window.linkRouteD = linkRouteD;
window.linkRoutePoints = linkRoutePoints;

// The fog seam, for the three other files that mask something: render/waves.js
// (an enemy stack on a hop it cannot see), render/select.js (a hidden station
// must not be pickable by the nearest-centre override, which never consults the
// DOM) and render/coverage.js (no focus on a remembered farm). They call this
// rather than visibleTo() directly, so the whole frame is masked against ONE
// solve — and so "is fog on?" has a single answer (`null` means no viewer,
// mask nothing) instead of four files each deciding what an absent
// state.human means.
window.mapFogLevels = mapFogLevels;
window.mapViewer = mapViewer;

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
