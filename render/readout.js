// render/readout.js — renderReadout(state) / setReadoutFocus(sid) /
//                     railAddSection(spec).
//
// ── THE RAIL ─────────────────────────────────────────────────────────────
//
// This file also owns `#rail`, the persistent column down the right-hand side
// of the screen. It used to draw a small panel that followed the cursor. That
// panel was click-transparent so it never ate a commit, but it appeared beside
// the station the player was about to click — i.e. exactly where their
// attention and their cursor already were — and covered the board at the one
// moment the board mattered most. The answer to that is not a cleverer anchor.
// It is a place on screen that is always the same place.
//
// The rail is a flex SIBLING of .board-wrap, never an overlay (index.html,
// `.stage`). That is a safety property, not a layout preference: anything
// painted over the board that accepts pointer events swallows the click that
// commits an attack and the game stops responding with no error at all. In
// normal flow the rail displaces the board instead — the SVG has a viewBox, so
// it simply rescales, and render/camera.js's ResizeObserver rebuilds its fit
// rect so marquee selection stays aligned with what is drawn.
//
// ── THE SEAM: railAddSection(spec) ───────────────────────────────────────
//
// The rail is a STACK of sections, not one panel. Station detail is merely the
// first one. To add another later, call railAddSection() from your own file —
// do not append to `#rail` by hand and do not invent a second convention:
//
//   railAddSection({
//     id:     'supply',            // unique; a second call with the same id
//                                  // replaces the first, so a file can be
//                                  // reloaded in the console
//     title:  'Supply',            // optional section header, or omit for none
//     order:  20,                  // ascending; station detail is 10
//     build:  function (host) {     // runs ONCE. Build every node you will
//       ...                        // ever need and return them.
//       return nodes;
//     },
//     update: function (state, nodes) {   // runs EVERY FRAME. Read-only.
//       ...                               // return false to hide the section
//       return true;                      // this frame, true to show it.
//     },
//   });
//
// Contract for a section, all four points load-bearing:
//
//   * `build` runs once and `update` must MUTATE those nodes, never rebuild
//     them. renderReadout runs at 60fps behind safeRender; a section that
//     recreates DOM thrashes layout and destroys text selection.
//   * `update` must not mutate game state. render/ reads (01-data-schema.md).
//   * A throw in `update` is caught and that ONE section is retired after
//     RDO_SECTION_FAIL_LIMIT failures. This mirrors safeRender in app/loop.js
//     deliberately: without it a broken second section would take the station
//     readout — and, three frames later, every other renderer — down with it.
//   * Sections may take pointer events. The rail is beside the board, not over
//     it, so a button here cannot eat a commit.
//
// Registration may happen at any time, including after the first frame; the
// rail re-sorts when the registry changes. Load order in index.html therefore
// does not matter, only that render/readout.js is present.
//
// No speculative empty sections exist. There is one section, it is real, and
// the next one is a ~15-line call.
//
// 00-vision.md §8: "Click a station for a small readout: type, garrison by unit
// type, capacity, growth rate and what's modifying it."
//
// The last clause is the feature. Growth on this board is a product of four
// separate things — where the station sits on its logistic curve, how many farms
// reach it, the control tier of the countries those farms are in, and whether it
// is cut off — and a bare number tells you none of that. The panel is built
// around the breakdown; the headline number is the footnote.
//
// TWO RULES THIS FILE IS BUILT AROUND
//
// 1. **Never reimplement a growth fact.** Every number below comes out of
//    sim/growth.js or core/state.js by calling it:
//
//      - the multiplier total          growthMultiplier(state, sid)
//      - which farms reach this one    multiplierStationIds() + territoryHops()
//      - a farm's control weight       controlWeight(territoryControl(...).tier)
//      - is a farm/station contested   stationAttackers(state, sid)
//      - growth this tick              _applyGrowth() run against a THROWAWAY
//                                      station object (see _rdoGrowthPerTick)
//
//    A formula copied into a renderer silently drifts the first time the sim is
//    tuned, and then the panel is confidently wrong — worse than absent. The one
//    thing mirrored here is growthTick()'s *branch order* (contested → cut off →
//    over capacity → at cap → growing), which is control flow, not arithmetic;
//    it is labelled at the branch so it can be re-checked against the sim.
//
// 2. **Read only.** Nothing here mutates state — the growth probe runs against
//    a scratch object, not against state.stations[sid].
//
// Driven from outside: render/select.js owns pointer handling on #board, so this
// file attaches NO board listener (01-data-schema.md, "Hover is shared"). Focus
// arrives via setReadoutFocus(). As a convenience, renderReadout falls back to
// the selection when no explicit focus is set — a read of selectedSources(),
// not a second pointer handler.
//
// renderReadout runs every frame and writes only the fields whose text actually
// changed; a quiet frame touches the DOM zero times.
//
// The station section is NEVER blank. With no focus it shows the player's own
// empire at a glance, because a fixed-width column that empties out reads as a
// broken layout rather than as "nothing selected". The idle body deliberately
// does not repeat the top HUD (territories / forces / day) — it shows what the
// HUD cannot fit: composition by unit type, stations held, full-vs-majority
// control, and how much capacity headroom is left to grow into.

'use strict';

// ── tuning of the panel itself ──────────────────────────────────────────

// Ticks per day, matching render/hud.js's day counter so "+2.4 /day" here and
// "Day 42" up there are the same unit of time.
var RDO_TICKS_PER_DAY = 10;

// Farm rows shown before collapsing into "+n more". Four is already a very
// crowded corner of the map.
var RDO_MAX_FARMS = 4;

// A neutral station's fill clock is only interesting once it is actually
// filling up; below this it reads as noise.
var RDO_NEUTRAL_WARN = 0.75;

// Hard stop on the fill-clock simulation. ~2500 ticks is the worst realistic
// case (a scoured rate-0.3 station), so this never binds in practice; it exists
// so a tuning change that stalls growth cannot hang the renderer.
var RDO_ETA_MAX_TICKS = 20000;

// Frames between fill-clock recomputes. Everything else on the panel is O(1);
// this one walks a few thousand growth steps, so it runs at ~2Hz.
var RDO_ETA_EVERY = 30;

// Frames between empire-summary recomputes. The idle body walks all 108
// stations; nothing on it moves fast enough to justify 60Hz, and 10Hz is still
// faster than a human reads. Only shown when nothing is focused, so on a frame
// where the player is actually hovering this costs nothing at all.
var RDO_EMPIRE_EVERY = 6;

// Order slot for the station-detail section. Sections sort ascending, and the
// gaps are the point: detail is the thing the player asked for by hovering, so
// it stays at the top, and a later section can land above (< 10) or below
// (> 10) without renumbering anything.
var RDO_SECTION_ORDER = 10;

// Consecutive throws before a section is retired, matching RENDER_FAIL_LIMIT in
// app/loop.js. A section that cannot survive three frames is broken, not
// unlucky, and the rest of the rail should outlive it.
var RDO_SECTION_FAIL_LIMIT = 3;

// ── module state ────────────────────────────────────────────────────────
//
// `var` at top level so it is inspectable from the console, matching
// render/hud.js and core/state.js.

var _rdoFocus = null;        // sid the panel is pinned to, or null
var _rdoNodes = null;        // built-once DOM, see _rdoBuild()
var _rdoLast = null;         // key -> last string written, so we can skip
var _rdoFrame = 0;
var _rdoEta = { sid: null, text: '' };
var _rdoEmpire = { frame: -1, pid: null, data: null };

// Rail registry. `_rdoSections` is the authored list; `_rdoOrder` is it sorted
// and is rebuilt only when `_rdoDirty` says the list changed, so the per-frame
// path never sorts.
var _rdoSections = [];
var _rdoOrder = [];
var _rdoDirty = true;
var _rdoRail = null;         // the #rail element, once found

function _rdoTicksPerDay() {
  // Bare `typeof` — a top-level `const BAL` is never a property of window
  // (known-issues #3).
  if (typeof BAL !== 'undefined' && isFinite(BAL.TICKS_PER_SEC) && BAL.TICKS_PER_SEC > 0) {
    return BAL.TICKS_PER_SEC;
  }
  return RDO_TICKS_PER_DAY;
}

// ── small formatters ────────────────────────────────────────────────────

// Garrisons are floats in state (core/state.js rule 1). One decimal: enough to
// see a battle draining a station, not so much that the panel looks like a
// spreadsheet.
function _rdoNum(v) {
  if (!isFinite(v)) return '-';
  if (v === 0) return '0';
  if (Math.abs(v) >= 100) return String(Math.round(v));
  return (Math.round(v * 10) / 10).toFixed(1);
}

function _rdoMul(v) {
  if (!isFinite(v)) return '-';
  return '×' + (Math.round(v * 100) / 100).toFixed(2);
}

function _rdoPct(v) {
  if (!isFinite(v)) return '-';
  return Math.round(v * 100) + '%';
}

// Percentages for the small tuning constants. DISCONNECT_DECAY is 0.002, which
// an integer-percent formatter renders as "0%" — i.e. "cut off, losing 0% per
// tick", which is both wrong and reassuring. Caught on screen, not in review.
function _rdoPctFine(v) {
  if (!isFinite(v)) return '-';
  var p = v * 100;
  if (p !== 0 && Math.abs(p) < 1) return (Math.round(p * 100) / 100) + '%';
  return Math.round(p) + '%';
}

function _rdoTypeLabel(d) {
  var t = d && d.type;
  if (t === 'multiplier') return 'farmland';
  if (t === 'producer') return 'works';
  if (t === 'defensive') return 'fortress';
  if (t === 'holding') return 'city';
  return t || 'station';
}

function _rdoPowerName(pid) {
  if (typeof POWERS !== 'undefined' && POWERS[pid] && POWERS[pid].name) return POWERS[pid].name;
  return pid === 'neutral' ? 'Neutral' : String(pid);
}

function _rdoPowerColor(pid) {
  if (typeof POWERS === 'undefined' || !POWERS[pid]) return null;
  return POWERS[pid].color || null;
}

function _rdoTerritoryName(tid) {
  if (typeof TERRITORIES !== 'undefined' && TERRITORIES[tid] && TERRITORIES[tid].name) {
    return TERRITORIES[tid].name;
  }
  return String(tid);
}

// Tier wording. `contested` deliberately does not say "nobody owns it" — it
// means no power holds a strict majority, which is a different and more useful
// statement (core/state.js, three tiers).
function _rdoTierLabel(ctl) {
  if (!ctl) return '';
  if (ctl.tier === 'full') return 'full control';
  if (ctl.tier === 'majority') return 'majority ' + ctl.held + '/' + ctl.total;
  return 'contested';
}

// ── sim reads ───────────────────────────────────────────────────────────

// Growth this tick, computed by running the SIM's own _applyGrowth against a
// throwaway station object. Nothing in state is touched: the probe carries only
// the four fields _applyGrowth reads (units, growthMul, capturedTick) plus a
// stub state for `tick`.
//
// This is why the panel cannot disagree with the simulation — it is not a model
// of the growth rule, it is the growth rule, run once on scratch paper.
function _rdoGrowthPerTick(state, sid, units, extraMul) {
  if (typeof _applyGrowth !== 'function') return null;
  var d = STATIONS[sid];
  var st = state.stations[sid];
  var probe = {
    units: { infantry: 0, artillery: 0, armour: 0 },
    growthMul: st.growthMul,
    capturedTick: st.capturedTick,
  };
  var total = units.infantry + units.artillery + units.armour;
  try {
    _applyGrowth({ tick: state.tick }, sid, probe, d, total, extraMul);
  } catch (e) {
    return null;
  }
  return probe.units.infantry + probe.units.artillery + probe.units.armour;
}

// Ticks for a station to reach `frac` of capacity, by stepping the sim's own
// growth function forward. Iterative rather than closed-form on purpose: the
// closed form is a second copy of the logistic, and this is not.
//
// Assumes nothing changes meanwhile (no attack, no multiplier flip), which is
// exactly the assumption the player is making when they read it.
function _rdoTicksToFill(state, sid, frac) {
  if (typeof _applyGrowth !== 'function') return -1;
  var d = STATIONS[sid];
  var st = state.stations[sid];
  var cap = d.capacity;
  if (!(cap > 0)) return -1;
  var target = cap * frac;
  var u = totalUnits(st.units);
  if (u >= target) return 0;

  var stub = { tick: state.tick };
  var probe = { units: { infantry: 0, artillery: 0, armour: 0 }, growthMul: st.growthMul };
  for (var i = 0; i < RDO_ETA_MAX_TICKS; i++) {
    probe.units.infantry = 0;
    probe.units.artillery = 0;
    probe.units.armour = 0;
    _applyGrowth(stub, sid, probe, d, u, 1);
    var g = probe.units.infantry + probe.units.artillery + probe.units.armour;
    if (!(g > 0)) return -1;
    u += g;
    if (u >= target) return i + 1;
  }
  return -1;
}

// Every multiplier station whose reach covers `sid`, using sim/growth.js's own
// reach test (real-power owner + territory hop distance <= MULTIPLIER_REACH).
// Returns the INPUTS to each contribution — raw multiplier, hops, control tier,
// contested flag — never a recomputed contribution, which would be the formula
// copied. The product itself comes from growthMultiplier().
function _rdoFarms(state, sid) {
  var out = [];
  if (typeof multiplierStationIds !== 'function' || typeof territoryHops !== 'function') return out;
  var home = STATIONS[sid].territory;
  var mids = multiplierStationIds();
  for (var i = 0; i < mids.length; i++) {
    var mid = mids[i];
    var owner = state.stations[mid].owner;
    // Same gate as growthMultiplier(): an unclaimed farm is fallow.
    if (typeof isRealPower === 'function' && !isRealPower(owner)) continue;
    var mTerr = STATIONS[mid].territory;
    var hops = territoryHops(mTerr)[home];
    if (hops === undefined || hops > BAL.MULTIPLIER_REACH) continue;
    var ctl = territoryControl(state, mTerr);
    var weight = controlWeight(ctl.tier);
    var siege = (typeof stationAttackers === 'function') && stationAttackers(state, mid).length > 0;
    out.push({
      sid: mid,
      name: STATIONS[mid].name,
      mult: STATIONS[mid].multiplier,
      hops: hops,
      owner: owner,
      tier: ctl.tier,
      weight: weight,
      siege: siege,
      dead: weight <= 0,
    });
  }
  // Strongest first: raw multiplier, then nearest, then id for determinism.
  out.sort(function (a, b) {
    if (b.mult !== a.mult) return b.mult - a.mult;
    if (a.hops !== b.hops) return a.hops - b.hops;
    return a.sid < b.sid ? -1 : 1;
  });
  return out;
}

// ── DOM ─────────────────────────────────────────────────────────────────
//
// Built once. renderReadout only ever rewrites text and toggles classes on
// these nodes — the panel is never torn down and rebuilt, because it is on
// screen at 60fps and rebuilding kills text selection and thrashes layout.

function _rdoRow(parent, cls, labelText) {
  var row = el('div', 'rdo-row ' + cls);
  var lab = el('span', 'rdo-k', { text: labelText || '' });
  var val = el('span', 'rdo-v');
  row.appendChild(lab);
  row.appendChild(val);
  parent.appendChild(row);
  return { row: row, k: lab, v: val };
}

// The section's build(). `host` is the .rail-body handed over by _rdoRailSync;
// it carries the id and class the old floating panel had so console habits,
// `byId('station-readout')` and every .rdo-* rule in style.css keep working.
//
// Two sibling bodies, exactly one of them displayed: `detail` when a station is
// focused, `idle` when none is. Both are built here, once, so switching between
// them is one style write and never a rebuild.
function _rdoBuild(host) {
  while (host.firstChild) host.removeChild(host.firstChild);
  host.id = 'station-readout';
  host.classList.add('station-readout');

  var n = { host: host };
  n.detail = el('div', 'rdo-detail');
  n.idle = el('div', 'rdo-idle');
  host.appendChild(n.detail);
  host.appendChild(n.idle);

  var d = n.detail;

  var head = el('div', 'rdo-head');
  n.name = el('span', 'rdo-name');
  n.type = el('span', 'rdo-type');
  head.appendChild(n.name);
  head.appendChild(n.type);
  d.appendChild(head);

  var sub = el('div', 'rdo-sub');
  n.swatch = el('span', 'rdo-swatch');
  n.owner = el('span', 'rdo-owner');
  sub.appendChild(n.swatch);
  sub.appendChild(n.owner);
  d.appendChild(sub);

  // Territory + control tier. Invisible everywhere else on screen, and a
  // partly-held country pays reduced benefits (00-vision.md §3).
  n.terr = _rdoRow(d, 'rdo-terr', 'Territory');
  n.tier = el('span', 'rdo-tier');
  n.terr.row.appendChild(n.tier);

  d.appendChild(el('div', 'rdo-sep'));

  // Garrison BY UNIT TYPE. Never collapsed to a total: the soft triangle in
  // 00-vision.md §4 is entirely about composition, so a panel that hides it is
  // hiding the decision.
  n.garr = _rdoRow(d, 'rdo-garr', 'Garrison');
  n.bar = el('div', 'rdo-bar');
  n.barFill = el('div', 'rdo-bar-fill');
  n.bar.appendChild(n.barFill);
  d.appendChild(n.bar);

  var units = el('div', 'rdo-units');
  n.inf = _rdoRow(units, 'rdo-unit', 'infantry');
  n.art = _rdoRow(units, 'rdo-unit', 'artillery');
  n.arm = _rdoRow(units, 'rdo-unit', 'armour');
  d.appendChild(units);

  d.appendChild(el('div', 'rdo-sep'));

  n.growth = _rdoRow(d, 'rdo-growth', 'Growth');
  n.status = el('div', 'rdo-status');
  d.appendChild(n.status);

  // The breakdown. Fixed slots, hidden when they do not apply, so no frame ever
  // creates or destroys a node here.
  var mods = el('div', 'rdo-mods');
  n.modBase = _rdoRow(mods, 'rdo-mod', 'base rate');
  n.modLog = _rdoRow(mods, 'rdo-mod', 'logistic');
  n.modMul = _rdoRow(mods, 'rdo-mod', 'farm reach');
  n.farms = el('div', 'rdo-farms');
  mods.appendChild(n.farms);
  n.modCap = _rdoRow(mods, 'rdo-mod', 'recaptured');
  n.modCut = _rdoRow(mods, 'rdo-mod', 'cut off');
  d.appendChild(mods);

  n.farmRows = [];
  n.note = el('div', 'rdo-note');
  d.appendChild(n.note);

  _rdoBuildIdle(n);

  _rdoLast = Object.create(null);
  _rdoNodes = n;
  return n;
}

// The idle body — the player's own empire, in the same visual grammar as the
// detail body so the column does not appear to change shape when the cursor
// leaves a station. Deliberately NOT a copy of the top HUD: the HUD already
// shows territories, total forces and the day, so repeating them here would
// spend the whole rail saying nothing. What it adds is composition, station
// count, the full-vs-majority split and empire-wide capacity headroom.
function _rdoBuildIdle(n) {
  var b = n.idle;

  var head = el('div', 'rdo-head');
  n.iName = el('span', 'rdo-name');
  head.appendChild(n.iName);
  head.appendChild(el('span', 'rdo-type', { text: 'your empire' }));
  b.appendChild(head);

  var sub = el('div', 'rdo-sub');
  n.iSwatch = el('span', 'rdo-swatch');
  n.iCtl = el('span', 'rdo-owner');
  sub.appendChild(n.iSwatch);
  sub.appendChild(n.iCtl);
  b.appendChild(sub);

  n.iStations = _rdoRow(b, 'rdo-terr', 'Stations');

  b.appendChild(el('div', 'rdo-sep'));

  n.iGarr = _rdoRow(b, 'rdo-garr', 'Garrison');
  var bar = el('div', 'rdo-bar');
  n.iBarFill = el('div', 'rdo-bar-fill');
  bar.appendChild(n.iBarFill);
  b.appendChild(bar);

  var units = el('div', 'rdo-units');
  n.iInf = _rdoRow(units, 'rdo-unit', 'infantry');
  n.iArt = _rdoRow(units, 'rdo-unit', 'artillery');
  n.iArm = _rdoRow(units, 'rdo-unit', 'armour');
  b.appendChild(units);

  n.iTransit = _rdoRow(b, 'rdo-mod', 'in transit');

  n.iHint = el('div', 'rdo-hint', {
    text: 'Hover a station for its garrison and growth breakdown.',
  });
  b.appendChild(n.iHint);
}

// Single write point: compare against what was last written and touch the DOM
// only on a change. Most frames write nothing at all.
function _rdoSet(node, key, text) {
  if (!node) return;
  if (_rdoLast[key] === text) return;
  _rdoLast[key] = text;
  node.textContent = text;
}

function _rdoShow(rec, key, on) {
  if (!rec) return;
  var k = key + '#vis';
  if (_rdoLast[k] === on) return;
  _rdoLast[k] = on;
  rec.row.style.display = on ? '' : 'none';
}

function _rdoStyle(node, key, prop, value) {
  if (!node) return;
  var k = key + '#' + prop;
  if (_rdoLast[k] === value) return;
  _rdoLast[k] = value;
  node.style[prop] = value;
}

function _rdoClass(node, key, cls, on) {
  if (!node) return;
  var k = key + '#' + cls;
  if (_rdoLast[k] === on) return;
  _rdoLast[k] = on;
  node.classList.toggle(cls, !!on);
}

// ── the rail ────────────────────────────────────────────────────────────
//
// There is no placement code any more — that is the feature. The rail is a
// fixed column laid out by the stylesheet; nothing here measures the board,
// nothing calls getBoundingClientRect(), nothing listens for resize. The old
// panel needed all three and still ended up under the cursor.

// Register (or replace) a section. See the seam contract in the file header.
// Returns the section id. Safe to call before or after the first frame.
function railAddSection(spec) {
  if (!spec || !spec.id || typeof spec.build !== 'function' || typeof spec.update !== 'function') {
    console.error('[render/readout] railAddSection needs { id, build, update }');
    return null;
  }
  var rec = {
    id: String(spec.id),
    title: spec.title || '',
    order: isFinite(spec.order) ? spec.order : 100,
    build: spec.build,
    update: spec.update,
    root: null,       // the .rail-section element, created on first pump
    body: null,       // where build() put its nodes
    nodes: null,      // whatever build() returned
    fails: 0,
    shown: null,      // last visibility written, so we do not touch [hidden]
  };
  // Replace by id rather than appending a duplicate: re-running a file in the
  // console is a normal thing to do while tuning a panel.
  for (var i = 0; i < _rdoSections.length; i++) {
    if (_rdoSections[i].id === rec.id) {
      var old = _rdoSections[i];
      if (old.root && old.root.parentNode) old.root.parentNode.removeChild(old.root);
      _rdoSections[i] = rec;
      _rdoDirty = true;
      return rec.id;
    }
  }
  _rdoSections.push(rec);
  _rdoDirty = true;
  return rec.id;
}

function _rdoRailEnsure() {
  if (_rdoRail && _rdoRail.isConnected) return _rdoRail;
  _rdoRail = byId('rail');
  // A rail that vanished (or was never in the document, e.g. tests.html) means
  // every section must be rebuilt into the new one.
  _rdoDirty = true;
  for (var i = 0; i < _rdoSections.length; i++) {
    _rdoSections[i].root = null;
    _rdoSections[i].shown = null;
  }
  return _rdoRail;
}

// Sort and (re)attach. Only runs when the registry changed — never per frame.
function _rdoRailSync(rail) {
  _rdoDirty = false;
  _rdoOrder = _rdoSections.slice().sort(function (a, b) {
    if (a.order !== b.order) return a.order - b.order;
    return a.id < b.id ? -1 : 1;
  });
  for (var i = 0; i < _rdoOrder.length; i++) {
    var s = _rdoOrder[i];
    if (!s.root) {
      s.root = el('section', 'rail-section', { 'data-rail-section': s.id });
      if (s.title) s.root.appendChild(el('div', 'rail-title', { text: s.title }));
      s.body = el('div', 'rail-body');
      s.root.appendChild(s.body);
      s.nodes = s.build(s.body);
      s.shown = null;
    }
    // appendChild on a node already in place is a move, so this both attaches
    // new sections and reorders after a late registration.
    rail.appendChild(s.root);
  }
}

// Per-frame pump. Each section is isolated: one that throws is retired on its
// own after RDO_SECTION_FAIL_LIMIT, exactly as app/loop.js retires a renderer,
// so a bad section cannot take the rail (or the game loop) down with it.
function _rdoRailPump(state) {
  var rail = _rdoRailEnsure();
  if (!rail) return false;
  if (_rdoDirty) _rdoRailSync(rail);

  for (var i = 0; i < _rdoOrder.length; i++) {
    var s = _rdoOrder[i];
    if (s.fails >= RDO_SECTION_FAIL_LIMIT) continue;
    var on = false;
    try {
      on = s.update(state, s.nodes) !== false;
    } catch (e) {
      s.fails++;
      console.error('[render/readout] rail section "' + s.id + '" threw (' +
        s.fails + '/' + RDO_SECTION_FAIL_LIMIT + ')', e);
      if (s.fails >= RDO_SECTION_FAIL_LIMIT) {
        console.error('[render/readout] retiring rail section "' + s.id + '"');
        s.root.hidden = true;
      }
      continue;
    }
    if (s.shown !== on) {
      s.shown = on;
      s.root.hidden = !on;
    }
  }
  return true;
}

// ── focus ───────────────────────────────────────────────────────────────

// The pinned entry point. `null` drops back to the idle body — it no longer
// hides anything, because the rail is always on screen. Unknown ids are ignored
// rather than throwing — this is called from a pointer handler in another file.
function setReadoutFocus(sid) {
  if (sid && (typeof STATIONS === 'undefined' || !STATIONS[sid])) sid = null;
  if (sid === _rdoFocus) return _rdoFocus;
  _rdoFocus = sid || null;
  _rdoEta = { sid: null, text: '' };
  return _rdoFocus;
}

// While nothing drives us yet, describe the selection. Read-only, and NOT a
// pointer listener — render/select.js still owns every event on #board.
function _rdoResolve() {
  if (_rdoFocus) return _rdoFocus;
  if (typeof selectedSources !== 'function') return null;
  var sel = selectedSources();
  return (sel && sel.length === 1) ? sel[0] : null;
}

// ── the breakdown ───────────────────────────────────────────────────────

function _rdoFillFarms(state, sid, farms) {
  var n = _rdoNodes;
  var show = Math.min(farms.length, RDO_MAX_FARMS);

  // The pool only ever GROWS, and surplus rows are hidden rather than removed.
  //
  // The first version destroyed them, and that was a real bug: focus a station
  // with no farms, focus the previous one again, and its farm row came back
  // EMPTY — the node had been recreated but _rdoLast still held the identical
  // text from last time, so the write was skipped as a no-op. Any "write only
  // what changed" cache is only sound while the node it remembers survives.
  while (n.farmRows.length < show) {
    var row = el('div', 'rdo-farm');
    n.farms.appendChild(row);
    n.farmRows.push(row);
  }
  for (var j = show; j < n.farmRows.length; j++) {
    _rdoStyle(n.farmRows[j], 'farmvis' + j, 'display', 'none');
  }

  for (var i = 0; i < show; i++) {
    _rdoStyle(n.farmRows[i], 'farmvis' + i, 'display', '');
    var f = farms[i];
    // Distance in territories, which is the unit MULTIPLIER_REACH is measured
    // in — "adjacent" is the whole mechanic (00-vision.md §2).
    var where = f.hops === 0 ? 'here' : (f.hops === 1 ? 'adjacent' : f.hops + ' away');
    var txt = f.name + ' ×' + f.mult + ' · ' + where + ' · ' + f.tier;
    if (f.weight > 0 && f.weight < 1) txt += ' (' + _rdoMul(f.weight) + ')';
    if (f.siege) txt += ' · under attack';
    if (f.dead) txt += ' — feeding nobody';
    _rdoSet(n.farmRows[i], 'farm' + i, txt);
    _rdoClass(n.farmRows[i], 'farm' + i, 'is-dead', f.dead || f.siege);
  }

  var extra = farms.length - show;
  _rdoSet(n.note, 'note', extra > 0 ? '+' + extra + ' more farm' + (extra > 1 ? 's' : '') + ' in reach' : '');
}

// ── the idle body ───────────────────────────────────────────────────────

// Walks the player's stations once. Cached for RDO_EMPIRE_EVERY frames because
// nothing on it moves faster than that matters, and because this is the one
// O(stations) read in the file. Read-only: it never touches a station object.
function _rdoEmpireStats(state, pid) {
  if (_rdoEmpire.data && _rdoEmpire.pid === pid &&
      (_rdoFrame - _rdoEmpire.frame) < RDO_EMPIRE_EVERY) {
    return _rdoEmpire.data;
  }
  var ids = (typeof powerStations === 'function') ? powerStations(state, pid) : [];
  var e = { n: ids.length, inf: 0, art: 0, arm: 0, held: 0, cap: 0, transit: 0 };
  for (var i = 0; i < ids.length; i++) {
    var u = state.stations[ids[i]].units;
    e.inf += u.infantry;
    e.art += u.artillery;
    e.arm += u.armour;
    e.cap += STATIONS[ids[i]].capacity || 0;
  }
  e.held = e.inf + e.art + e.arm;
  // Stacks already committed and walking. They are the player's forces but
  // they are in nobody's garrison, so without this line the empire total
  // visibly dips every time they launch an attack.
  var waves = state.waves || [];
  for (var w = 0; w < waves.length; w++) {
    if (waves[w].owner === pid) e.transit += totalUnits(waves[w].units);
  }
  // Full vs majority: the HUD's single number is majority-or-better, and the
  // difference between the two is what says whether an empire is consolidated
  // or over-extended (00-vision.md §3).
  e.full = (typeof countFullTerritories === 'function') ? countFullTerritories(state, pid) : 0;
  e.maj = (typeof countTerritories === 'function') ? countTerritories(state, pid) : 0;
  _rdoEmpire = { frame: _rdoFrame, pid: pid, data: e };
  return e;
}

function _rdoFillIdle(state) {
  var n = _rdoNodes;
  var pid = window.PLAYER || null;
  if (!pid) {
    _rdoSet(n.iName, 'iname', 'No power');
    return;
  }
  var e = _rdoEmpireStats(state, pid);

  _rdoSet(n.iName, 'iname', _rdoPowerName(pid));
  _rdoStyle(n.iSwatch, 'iswatch', 'background', _rdoPowerColor(pid) || 'var(--neutral-node)');

  var part = Math.max(0, e.maj - e.full);
  _rdoSet(n.iCtl, 'ictl', e.full + ' held outright' + (part ? '  ·  ' + part + ' contested majority' : ''));
  _rdoSet(n.iStations.v, 'istations', String(e.n));

  var fill = e.cap > 0 ? e.held / e.cap : 0;
  _rdoSet(n.iGarr.v, 'igarr', _rdoNum(e.held) + ' / ' + Math.round(e.cap) + '  ·  ' + _rdoPct(fill));
  _rdoStyle(n.iBarFill, 'ibar', 'width', _rdoPct(Math.min(1, fill)));
  // Same meaning as on a single station: full means growth has stopped paying.
  _rdoClass(n.iBarFill, 'ibar', 'is-full', fill >= BAL.GROWTH_CAP_EPSILON);

  _rdoSet(n.iInf.v, 'iinf', _rdoNum(e.inf));
  _rdoSet(n.iArt.v, 'iart', _rdoNum(e.art));
  _rdoSet(n.iArm.v, 'iarm', _rdoNum(e.arm));

  _rdoShow(n.iTransit, 'itransit', e.transit > 0);
  if (e.transit > 0) _rdoSet(n.iTransit.v, 'itransitv', _rdoNum(e.transit) + ' on the move');
}

// ── entry point ─────────────────────────────────────────────────────────

// The station section's update(). Always returns true: the section is never
// hidden, because a fixed column that empties out reads as a broken layout.
function _rdoSectionUpdate(state, nodes) {
  _rdoNodes = nodes;
  if (!state) return true;
  _rdoFrame++;

  var sid = _rdoResolve();
  if (sid && (!state.stations || !state.stations[sid] || !STATIONS[sid])) sid = null;

  // One style write per mode change, not per frame — _rdoStyle skips a repeat.
  _rdoStyle(nodes.detail, 'mode', 'display', sid ? '' : 'none');
  _rdoStyle(nodes.idle, 'imode', 'display', sid ? 'none' : '');

  if (!sid) {
    _rdoFillIdle(state);
    return true;
  }
  _rdoFillDetail(state, sid);
  return true;
}

function _rdoFillDetail(state, sid) {
  var n = _rdoNodes;
  var d = STATIONS[sid];
  var st = state.stations[sid];
  var units = st.units;
  var total = totalUnits(units);
  var cap = d.capacity;
  var fill = cap > 0 ? total / cap : 0;

  // ── identity ──
  _rdoSet(n.name, 'name', d.name);
  var typeText = _rdoTypeLabel(d);
  if (d.type === 'producer' && d.produces) typeText += ' · ' + d.produces;
  if (d.defense && d.defense !== 1) typeText += ' · def ×' + d.defense;
  _rdoSet(n.type, 'type', typeText);

  var owner = st.owner;
  _rdoSet(n.owner, 'owner', _rdoPowerName(owner));
  var col = _rdoPowerColor(owner);
  _rdoStyle(n.swatch, 'swatch', 'background', col || 'var(--neutral-node)');

  var ctl = territoryControl(state, d.territory);
  _rdoSet(n.terr.v, 'terr', _rdoTerritoryName(d.territory));
  _rdoSet(n.tier, 'tier', _rdoTierLabel(ctl));
  _rdoClass(n.tier, 'tier', 'is-contested', ctl.tier === 'contested');
  _rdoClass(n.tier, 'tier', 'is-partial', ctl.tier === 'majority');

  // ── garrison ──
  _rdoSet(n.garr.v, 'garr', _rdoNum(total) + ' / ' + cap + '  ·  ' + _rdoPct(fill));
  _rdoStyle(n.barFill, 'bar', 'width', _rdoPct(Math.min(1, fill)));
  _rdoClass(n.barFill, 'bar', 'is-full', fill >= BAL.GROWTH_CAP_EPSILON);
  _rdoSet(n.inf.v, 'inf', _rdoNum(units.infantry));
  _rdoSet(n.art.v, 'art', _rdoNum(units.artillery));
  _rdoSet(n.arm.v, 'arm', _rdoNum(units.armour));

  // ── which growth branch the sim will take ──
  //
  // Mirrors growthTick()'s branch order exactly: contested → cut off → over
  // capacity → at cap → growing. Control flow only; every NUMBER below still
  // comes from the sim.
  var contested = (typeof stationAttackers === 'function') && stationAttackers(state, sid).length > 0;
  var cut = st.connected === false;
  var over = total > cap;
  var atCap = !over && total >= cap * BAL.GROWTH_CAP_EPSILON;

  var perDay = 0;
  var status = '';
  var statusBad = true;

  if (contested) {
    status = 'under attack — not recruiting';
  } else if (cut) {
    var since = (st.discSince === undefined || st.discSince < 0) ? state.tick : st.discSince;
    var decaying = (state.tick - since) >= BAL.DISCONNECT_GRACE;
    status = decaying
      ? 'cut off — losing ' + _rdoPctFine(BAL.DISCONNECT_DECAY) + ' per tick'
      : 'cut off — decay in ' + (BAL.DISCONNECT_GRACE - (state.tick - since)) + ' ticks';
    var gCut = _rdoGrowthPerTick(state, sid, units, BAL.DISCONNECT_GROWTH);
    perDay = (gCut || 0) * _rdoTicksPerDay();
    // Attrition, so the headline is not a flat "0 / day" while the pocket dies.
    // Mirrors growthTick()'s `_scaleUnits(units, 1 - DISCONNECT_DECAY)` — one
    // multiplication against a BAL constant, not the growth formula.
    if (decaying) perDay -= total * BAL.DISCONNECT_DECAY * _rdoTicksPerDay();
  } else if (over) {
    // Same deal: growthTick() bleeds `excess * OVERSTACK_DECAY` per tick. There
    // is no growth term to probe up here — growth is off above the ceiling.
    perDay = -(total - cap) * BAL.OVERSTACK_DECAY * _rdoTicksPerDay();
    status = 'over capacity — bleeding off';
  } else if (atCap) {
    status = 'at capacity — stopped paying dividends';
  } else {
    var g = _rdoGrowthPerTick(state, sid, units, 1);
    perDay = (g === null ? 0 : g) * _rdoTicksPerDay();
    statusBad = false;
    status = 'into ' + (typeof growthType === 'function' ? growthType(sid) : 'infantry');
  }

  var sign = perDay > 0 ? '+' : '';
  _rdoSet(n.growth.v, 'growth', sign + _rdoNum(perDay) + ' / day');
  _rdoClass(n.growth.row, 'growthrow', 'is-stalled', perDay <= 0);
  _rdoSet(n.status, 'status', status);
  _rdoClass(n.status, 'status', 'is-bad', statusBad);

  // ── what's modifying it ──
  //
  // The three standing factors of _applyGrowth's product, each labelled with
  // where it comes from, plus the two situational ones.
  _rdoSet(n.modBase.v, 'modbase', _rdoMul(d.rate) + '  ' + _rdoTypeLabel(d));
  _rdoSet(n.modLog.v, 'modlog', _rdoMul(Math.max(0, 1 - fill)) + '  ' + _rdoPct(fill) + ' full');

  // Multiplier total straight from the sim. state.stations[sid].growthMul is
  // the value growth actually USED (one tick of latency, by design — see the
  // header of sim/growth.js); growthMultiplier() is what it will be next tick.
  // The published one is the honest thing to show.
  var mul = (typeof st.growthMul === 'number' && isFinite(st.growthMul)) ? st.growthMul : 1;
  var farms = _rdoFarms(state, sid);
  var capped = mul >= BAL.GROWTH_MUL_CAP;
  _rdoSet(n.modMul.v, 'modmul', _rdoMul(mul) + (capped ? '  capped' : ''));
  _rdoClass(n.modMul.row, 'modmulrow', 'is-off', mul <= 1);
  _rdoFillFarms(state, sid, farms);
  _rdoShow(n.modMul, 'modmul', true);

  // Capture penalty ships at 1.0 (OFF). Show the row only when it is both
  // active and actually doing something, so turning the constant on lights it
  // up with no further work here.
  var capPen = (typeof st.capturedTick === 'number') &&
    (state.tick - st.capturedTick) < BAL.CAPTURE_PENALTY_TICKS &&
    BAL.CAPTURE_GROWTH_PENALTY !== 1;
  _rdoShow(n.modCap, 'modcap', capPen);
  if (capPen) {
    _rdoSet(n.modCap.v, 'modcapv', _rdoMul(BAL.CAPTURE_GROWTH_PENALTY) + '  ' +
      (BAL.CAPTURE_PENALTY_TICKS - (state.tick - st.capturedTick)) + ' ticks left');
  }

  _rdoShow(n.modCut, 'modcut', cut);
  if (cut) _rdoSet(n.modCut.v, 'modcutv', _rdoMul(BAL.DISCONNECT_GROWTH) + '  no path to capital');

  // ── the neutral clock ──
  //
  // A two-station country falls to one volley early and is a wall of full
  // garrisons later, and nothing else on screen says so. Recomputed at ~2Hz
  // because it steps the sim forward a few thousand ticks.
  var neutralNote = '';
  if (!isRealPower(owner) && !contested) {
    if (fill >= BAL.GROWTH_CAP_EPSILON) {
      neutralNote = 'neutral and full — as expensive as it will ever be';
    } else if (fill >= RDO_NEUTRAL_WARN || _rdoEta.sid === sid) {
      if (_rdoEta.sid !== sid || _rdoFrame % RDO_ETA_EVERY === 0) {
        var t = _rdoTicksToFill(state, sid, BAL.GROWTH_CAP_EPSILON);
        _rdoEta = {
          sid: sid,
          text: t < 0 ? '' : 'neutral — full in ~' + Math.max(1, Math.round(t / _rdoTicksPerDay())) + ' days',
        };
      }
      neutralNote = _rdoEta.text;
    }
  }
  if (neutralNote) _rdoSet(n.note, 'note', neutralNote);
}

// ── registration ────────────────────────────────────────────────────────
//
// Station detail is the rail's first section, registered here at load. It is
// registered through the same public seam any later section will use — there
// is no privileged path — so if this call works, so will the next one.
railAddSection({
  id: 'station',
  order: RDO_SECTION_ORDER,
  build: _rdoBuild,
  update: _rdoSectionUpdate,
});

// The per-frame pump, called by app/loop.js behind safeRender. It drives the
// whole rail, not just this file's section: `renderReadout` is the only
// per-frame hook the loop offers here, so it is what the rail rides on.
function renderReadout(state) {
  return _rdoRailPump(state);
}

// Global exports — no modules anywhere in this project.
window.renderReadout = renderReadout;
window.setReadoutFocus = setReadoutFocus;
window.railAddSection = railAddSection;
