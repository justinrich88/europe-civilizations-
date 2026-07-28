// render/coverage.js — multiplier coverage overlay.
//
// 00-vision.md §8: "Multiplier coverage is shown on the map — hold a farm and
// see the territories it's boosting light up." §2 calls multiplier stations the
// most interesting objects on the board and open question #4 says the mechanic
// "may prove too strong or too invisible". This file is the answer to
// *invisible*: focus a farm and the countries it feeds light up, each labelled
// with the factor THAT farm contributes to growth there.
//
// Two rules govern everything below.
//
//   1. The numbers come from the sim, not from a second copy of the rule.
//      growthMultiplier() in sim/growth.js is the only place that knows how
//      reach, hop falloff, control tier and contested-ness combine. An overlay
//      that re-derives that formula drifts out of sync the first time the
//      formula is tuned, and a pretty overlay that disagrees with the
//      simulation is worse than none (known-issues #9: two implementations of
//      one rule is a bug that has already happened in this project).
//
//      So the contribution of ONE farm is measured by calling the sim's own
//      function against a *probe* state — a shallow, throwaway view of the real
//      state in which every other multiplier station is fallow. What comes back
//      is exactly the factor this farm alone applies. See _covProbeState().
//
//   2. Nothing here mutates state. The probe copies the handful of station
//      records it changes; the real state object is never written to.
//
// Layer: #g-coverage, owned by this file and nothing else, pointer-events:none
// in style.css. Any layer over the board that takes pointer events eats the
// click that commits an attack and the game stops responding with no error.
//
// Hover: render/select.js owns pointer handling on #board. This file attaches
// no listener of its own; it is driven entirely through setCoverageFocus().

'use strict';

// Opacity ramp for the wash. A farm's contribution runs from 1.0 (nothing) to
// roughly 1.7 on this map, so the ramp is calibrated over the *bonus* rather
// than the raw factor: bonus 0 -> invisible, bonus at _COV_BONUS_FULL -> full.
// Tuned against a near-white wash, which carries far more weight per unit of
// alpha than a mid-tone tint would.
var _COV_ALPHA_MIN = 0.06;
var _COV_ALPHA_MAX = 0.24;
var _COV_BONUS_FULL = 0.7;
var _COV_EPS = 0.005;      // below this a "boost" is not worth drawing

// ── the live index ──────────────────────────────────────────────────────
//
// Same discipline as render/map.js's LIVE index, and for the same reason:
// renderCoverage() is called every frame. The polygons and labels are built
// ONCE, one pair per territory, and thereafter only attributes change. A frame
// where the focus and its reach are unchanged costs one territoryControl()
// call and returns — zero DOM writes.
var _COV = {
  built: false,
  layer: null,
  terr: Object.create(null),   // tid -> { poly, label, alpha, text, cls }
  focus: null,                 // sid currently focused, or null
  sig: null,                   // signature of what is currently DRAWN
  shown: [],                   // tids currently lit
  writes: 0,                   // diagnostics, as in render/map.js
};

function _covSetAttr(node, name, value) {
  node.setAttribute(name, value);
  _COV.writes++;
}

// ── geometry ────────────────────────────────────────────────────────────
//
// Reuses the same vertex table render/map.js draws territories from, so the
// wash lands exactly on the country and not a hair beside it. Bare `typeof`
// reads throughout — top-level `const` in a classic script is not a property
// of `window` (known-issues #3).

function _covPoints(tid) {
  if (typeof VERTS === 'undefined' || typeof TERRITORIES === 'undefined') return null;
  var t = TERRITORIES[tid];
  var shape = t && t.shape;
  if (!Array.isArray(shape) || shape.length < 3) return null;
  var out = [];
  for (var i = 0; i < shape.length; i++) {
    var v = VERTS[shape[i]];
    if (!v || v.length < 2) return null;
    out.push([Number(v[0]), Number(v[1])]);
  }
  return out;
}

function _covPointsAttr(pts) {
  var s = [];
  for (var i = 0; i < pts.length; i++) s.push(pts[i][0] + ',' + pts[i][1]);
  return s.join(' ');
}

// Where the magnitude figure goes. Territories carry an authored `label`
// anchor; fall back to the polygon centroid, exactly as the map labels do.
// Nudged below the country name so the two do not overprint.
function _covLabelAt(tid, pts) {
  var t = (typeof TERRITORIES !== 'undefined') ? TERRITORIES[tid] : null;
  var at = (t && t.label && t.label.length >= 2) ? t.label : centroid(pts);
  return [at[0], at[1] + 12];
}

// ── the probe ───────────────────────────────────────────────────────────
//
// A read-only view of `state` in which every multiplier station EXCEPT `sid` is
// unowned, and `sid` itself is owned by `ownerOverride`. growthMultiplier()
// skips fallow farms (isRealPower), so the product it returns against this view
// is the contribution of `sid` and nothing else.
//
// Everything is shallow: the stations map is a fresh object, the two or three
// station records that change are fresh objects, and every other record — units,
// attackers, waves, powers — is the SAME object the sim holds. Nothing is
// written to. This is a lens, not a snapshot.
//
// The one assumption: each multiplier's territory-control tier is read from
// this view, so blanking the other farms would shift a tier if two multiplier
// stations shared a territory. None do on the 1914 map (one farm per country),
// and if that ever changes the wrong value is a slightly-off tier on a farm
// that is not the one being described.
function _covProbeState(state, sid, ownerOverride) {
  var mids = multiplierStationIds();
  var stations = Object.create(null);
  for (var k in state.stations) stations[k] = state.stations[k];

  for (var i = 0; i < mids.length; i++) {
    var mid = mids[i];
    var src = state.stations[mid];
    var owner = (mid === sid) ? ownerOverride : 'neutral';
    if (src.owner === owner) continue;
    var copy = {};
    for (var f in src) copy[f] = src[f];
    copy.owner = owner;
    stations[mid] = copy;
  }

  var probe = {};
  for (var g in state) probe[g] = state[g];
  probe.stations = stations;
  return probe;
}

// tid -> factor, for every territory this farm reaches. The home territory is
// included: a farm boosts the ground it stands on.
//
// Territories are asked via one representative station because growthMultiplier
// keys reach off the *territory* of the station it is asked about — every
// station in a country sees the same farm at the same distance. A territory
// with no stations has no growth to boost and is left dark.
function _covContributions(state, sid, ownerOverride) {
  var probe = _covProbeState(state, sid, ownerOverride);
  var out = Object.create(null);
  for (var i = 0; i < TERRITORY_IDS.length; i++) {
    var tid = TERRITORY_IDS[i];
    var ids = stationsIn(tid);
    if (!ids.length) continue;
    var f = growthMultiplier(probe, ids[0]);
    if (isFinite(f) && f > 1 + _COV_EPS) out[tid] = f;
  }
  return out;
}

// Everything the drawn overlay depends on, in one cheap string. Recomputing the
// contributions costs 48 growthMultiplier() calls; this costs one
// territoryControl() on one country, and on a settled board it is what makes
// the per-frame cost of this file effectively zero.
function _covSignature(state, sid, ownerOverride) {
  var terr = STATIONS[sid].territory;
  var c = territoryControl(state, terr);
  var contested = (typeof stationAttackers === 'function' &&
                   stationAttackers(state, sid).length) ? 1 : 0;
  return sid + '|' + ownerOverride + '|' + c.tier + '|' + c.held + '|' + contested;
}

// ── DOM ─────────────────────────────────────────────────────────────────

// One polygon and one label per territory, built once, hidden until used.
// Two passes so that every wash is painted before any figure, or a neighbour
// drawn later covers an earlier territory's number.
function _covBuild() {
  if (_COV.built) return true;
  var layer = byId('g-coverage');
  if (!layer || typeof TERRITORIES === 'undefined') return false;

  var tids = Object.keys(TERRITORIES).sort();
  var made = [];
  for (var i = 0; i < tids.length; i++) {
    var pts = _covPoints(tids[i]);
    if (!pts) continue;
    var at = _covLabelAt(tids[i], pts);
    var rec = {
      poly: el('polygon', 'coverage-wash', {
        points: _covPointsAttr(pts), 'data-territory': tids[i],
      }),
      label: el('text', 'coverage-figure', { x: at[0], y: at[1] }),
      alpha: null, text: null, cls: null,
    };
    _COV.terr[tids[i]] = rec;
    made.push(rec);
  }
  for (var a = 0; a < made.length; a++) layer.appendChild(made[a].poly);
  for (var b = 0; b < made.length; b++) layer.appendChild(made[b].label);

  _COV.layer = layer;
  _COV.built = true;
  return true;
}

// Magnitude, twice: as ink and as a figure. The wash alone answers "which
// countries"; §8 asks the board to answer "and by how much" as well, and a
// single flat colour cannot — a 1.05 nudge and a 1.7 doubling would look
// identical.
function _covAlphaFor(factor) {
  var t = clamp((factor - 1) / _COV_BONUS_FULL, 0, 1);
  return lerp(_COV_ALPHA_MIN, _COV_ALPHA_MAX, Math.sqrt(t));
}

// NOTE the inline style rather than a `fill-opacity` attribute. A CSS rule
// beats an SVG *presentation attribute* — .coverage-wash's `fill-opacity: 0`
// default silently won over every attribute written here, and the overlay was
// correct in the DOM and invisible on screen. Inline style outranks both.
function _covPaint(tid, factor, cls) {
  var rec = _COV.terr[tid];
  if (!rec) return;
  var alpha = _covAlphaFor(factor).toFixed(3);
  var text = '×' + factor.toFixed(2);
  if (rec.cls !== cls) { _covSetAttr(rec.poly, 'class', 'coverage-wash ' + cls);
                         _covSetAttr(rec.label, 'class', 'coverage-figure ' + cls);
                         rec.cls = cls; }
  if (rec.alpha !== alpha) { rec.poly.style.fillOpacity = alpha; _COV.writes++; rec.alpha = alpha; }
  if (rec.text !== text) { rec.label.textContent = text; _COV.writes++; rec.text = text; }
}

function _covHide(tid) {
  var rec = _COV.terr[tid];
  if (!rec || rec.cls === null) return;
  _covSetAttr(rec.poly, 'class', 'coverage-wash');
  _covSetAttr(rec.label, 'class', 'coverage-figure');
  rec.poly.style.fillOpacity = '';
  _COV.writes++;
  rec.label.textContent = '';
  rec.cls = null; rec.alpha = null; rec.text = null;
}

function _covClearDrawn() {
  for (var i = 0; i < _COV.shown.length; i++) _covHide(_COV.shown[i]);
  _COV.shown = [];
  _COV.sig = null;
}

// ── public API (01-data-schema.md, "Render API — Milestone 5 additions") ──

// Show the reach of one multiplier station, or clear with null. The only way
// other files drive this overlay; render/select.js calls it from the hover it
// already owns.
function setCoverageFocus(sid) {
  var ok = sid && typeof STATIONS !== 'undefined' && STATIONS[sid] &&
           STATIONS[sid].type === 'multiplier' && STATIONS[sid].multiplier > 1;
  _COV.focus = ok ? sid : null;
  return _COV.focus;
}

// ── fog ─────────────────────────────────────────────────────────────────
//
// Level 0 is already safe and costs nothing: focus is set from the hover
// render/select.js owns, a hidden station's <g> is display:none, and a
// display:none element is never an event target — so a farm the player has
// never seen cannot be hovered and cannot become the focus.
//
// LEVEL 1 IS REFUSED, and that is not symmetry for its own sake. This overlay
// is not a picture of a farm; it is a set of LIVE answers about the rest of the
// board. _covSignature reads territoryControl(state, …) on the farm's own
// country, and _covContributions calls the sim's growthMultiplier against the
// present state for all 30 territories — reach, hop falloff, CONTROL TIER and
// contested-ness, every one of them evaluated on ground the player may not be
// able to see. Painting that beside a remembered node is a live answer to a
// stale question: known-issues #18, the failure mode where a number is
// plausible, stable, recomputed every frame, and describes something other than
// what is on screen.
//
// There is no honest fogged version of it either. A believed multiplier would
// need a believed control tier for every country the farm reaches, which is a
// second implementation of the tier rule (known-issues #9) and would still be
// wrong the moment a single station three countries away changed hands. So the
// overlay simply says nothing until the player can see the farm, which is the
// same bargain the fullness ring makes on a fogged node.
function _covFogged(state, sid) {
  if (typeof mapFogLevels !== 'function' || typeof believedStation !== 'function') return false;
  var vis = mapFogLevels(state);
  if (!vis) return false;                       // no viewer: nothing is masked
  if (vis[sid] === 2) return false;
  return true;                                  // level 0 or level 1: no answer
}

// Draw the focused farm's reach into #g-coverage. Called every frame.
function renderCoverage(state) {
  if (!state || !state.stations) return false;
  if (!_COV.built && !_covBuild()) return false;

  var sid = _COV.focus;
  if (sid && _covFogged(state, sid)) {
    if (_COV.sig !== null) _covClearDrawn();
    return false;
  }
  if (!sid || !state.stations[sid] ||
      typeof growthMultiplier !== 'function' ||
      typeof multiplierStationIds !== 'function') {
    if (_COV.sig !== null) _covClearDrawn();
    return false;
  }

  // A farm nobody owns projects nothing (sim/growth.js: an unclaimed farm is
  // fallow). Showing an empty overlay there would answer the wrong question —
  // what the player wants to know while hovering someone else's farm is what
  // they would GAIN by taking it. So an unowned or enemy-held farm is costed
  // as if the player held it, and drawn in the prospective style.
  var owner = state.stations[sid].owner;
  var me = state.human || window.PLAYER || null;
  var prospective = (owner !== me);
  var asOwner = prospective ? (me || owner) : owner;
  var cls = prospective ? 'is-prospective' : 'is-held';

  var sig = _covSignature(state, sid, asOwner) + '|' + cls;
  if (sig === _COV.sig) return false;      // nothing moved — zero DOM writes

  var contrib = _covContributions(state, sid, asOwner);
  var next = Object.keys(contrib).sort();

  for (var i = 0; i < _COV.shown.length; i++) {
    if (contrib[_COV.shown[i]] === undefined) _covHide(_COV.shown[i]);
  }
  for (var j = 0; j < next.length; j++) _covPaint(next[j], contrib[next[j]], cls);

  // The source itself gets a heavier outline so "which farm am I looking at"
  // survives a wash that spans four countries.
  var home = STATIONS[sid].territory;
  if (contrib[home] !== undefined) _covPaint(home, contrib[home], cls + ' is-home');

  _COV.shown = next;
  _COV.sig = sig;
  return true;
}

// Globals — no modules anywhere in this project. Only the two pinned names are
// published; every helper above is prefixed by FILE (`_cov`), not by subsystem,
// because a shared prefix concentrates collisions between files in the same
// domain rather than preventing them (known-issues #12).
window.setCoverageFocus = setCoverageFocus;
window.renderCoverage = renderCoverage;
window.COVERAGE = _COV;
