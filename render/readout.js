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

// Retired. The empire summary used to recompute on a FRAME throttle of its own;
// it is now the empire header's tick-throttled aggregate (RDO_HEADER_EVERY_TICKS
// and _rdoHeaderStats), because two caches of the same fact drift apart and get
// printed side by side. Kept as a named constant only so a console habit or an
// old bookmark does not throw.
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

// A station's display name. STATIONS is the static table, so this is safe to
// call for any id the sim hands back — including one the player does not own.
function _rdoStationName(sid) {
  if (typeof STATIONS !== 'undefined' && STATIONS[sid] && STATIONS[sid].name) {
    return STATIONS[sid].name;
  }
  return String(sid);
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

// The idle body — what is left to say once the empire header above has said the
// rest. It used to carry the power's name, its station count and its force
// composition; the header now owns all three, and printing them twice in one
// 284px column six inches apart is worse than not printing them at all.
//
// So this is now exactly the two facts the header deliberately does not carry:
//
//   HEADROOM  — force against total capacity. The header's growth figure says
//               how fast you are growing; this says how much room is left to
//               grow INTO, which is the other half of the logistic and the
//               reason a full empire's growth number collapses.
//   CONTROL   — outright vs majority. The HUD's single territory count is
//               majority-or-better, so the split between the two is the thing
//               neither the HUD nor the header can show, and it is what says
//               whether an empire is consolidated or over-extended (§3).
function _rdoBuildIdle(n) {
  var b = n.idle;

  n.iGarr = _rdoRow(b, 'rdo-garr', 'Headroom');
  var bar = el('div', 'rdo-bar');
  n.iBarFill = el('div', 'rdo-bar-fill');
  bar.appendChild(n.iBarFill);
  b.appendChild(bar);

  n.iCtlRow = _rdoRow(b, 'rdo-mod', 'control');

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
  // RETURNED, not written. `n.note` has two would-be authors — this and the
  // neutral fill clock at the bottom of _rdoFillDetail — and while both wrote to
  // it directly they fought over the same _rdoLast key every single frame: this
  // one set '', the clock set its text, the cache saw a change both times, and a
  // PAUSED game hovering a neutral station cost 2 DOM writes per frame forever.
  // Measured at exactly 2.007/frame before this change and 0 after.
  //
  // The diff gate is only sound with ONE author per key. Anything that can write
  // a node must be the only thing that writes it.
  return extra > 0 ? '+' + extra + ' more farm' + (extra > 1 ? 's' : '') + ' in reach' : '';
}

// ── the idle body ───────────────────────────────────────────────────────

// Walks the player's stations once. Cached for RDO_EMPIRE_EVERY frames because
// nothing on it moves faster than that matters, and because this is the one
// O(stations) read in the file. Read-only: it never touches a station object.
// ONE walk, shared. This used to be a second pass over the same stations on its
// own frame-based throttle, and the moment the empire header landed the two
// disagreed on screen: the header said 158 infantry and the idle body said 159,
// six inches apart, because they had sampled different ticks. Two independent
// caches of the same fact will always eventually print different numbers.
//
// So the idle body now reads the header's aggregate verbatim. It is also half
// the work — there was never a reason to walk the empire twice.
function _rdoEmpireStats(state, pid) {
  return _rdoHeaderStats(state, pid);
}

function _rdoFillIdle(state) {
  var n = _rdoNodes;
  var pid = window.PLAYER || null;
  if (!pid) return;
  var e = _rdoEmpireStats(state, pid);

  var fill = e.cap > 0 ? e.held / e.cap : 0;
  _rdoSet(n.iGarr.v, 'igarr', _rdoNum(e.held) + ' / ' + Math.round(e.cap) + '  ·  ' + _rdoPct(fill));
  _rdoStyle(n.iBarFill, 'ibar', 'width', _rdoPct(Math.min(1, fill)));
  // Same meaning as on a single station: full means growth has stopped paying.
  _rdoClass(n.iBarFill, 'ibar', 'is-full', fill >= BAL.GROWTH_CAP_EPSILON);

  var part = Math.max(0, e.maj - e.full);
  _rdoSet(n.iCtlRow.v, 'ictl',
    e.full + ' outright' + (part ? '  ·  ' + part + ' by majority' : ''));
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
  // Written as a LEVEL, not a multiplier. `defense` is a rating whose excess
  // over 1.0 becomes flat power (DEFENSE_BONUS_POWER), so "×3.2" here would
  // contradict the additive fort block below and misstate the single number
  // that decides an assault. Same vocabulary as that block's "→ +2.20 lvl".
  if (d.defense && d.defense !== 1) typeText += ' · def +' + (d.defense - 1).toFixed(1) + ' lvl';
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
  var farmNote = _rdoFillFarms(state, sid, farms);
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
  // The single write to n.note. The neutral clock still wins over the farm
  // overflow when both have something to say — same precedence as before.
  _rdoSet(n.note, 'note', neutralNote || farmNote);
}

// ════════════════════════════════════════════════════════════════════════
// THE EMPIRE HEADER — always on screen, nothing selected
// ════════════════════════════════════════════════════════════════════════
//
// Everything else in the rail answers a question you asked by pointing at a
// station. A player running several attacks at once is not pointing at anything
// — they are watching the board — and until now that player could learn nothing
// without giving up their place. So this section sorts ABOVE the station detail
// (RDO_HEADER_ORDER < RDO_SECTION_ORDER) and is never hidden.
//
// THREE LINES, AND THE SHAPE OF EACH IS AN ARGUMENT
//
// 1. GROWTH — one number, because growth genuinely sums. Units per minute is
//    the sim's own _applyGrowth run on scratch paper for every station held,
//    branch-for-branch with growthTick(): contested recruits nothing, a cut-off
//    station grows at DISCONNECT_GROWTH, a full one has stopped paying. Its
//    sub-line names the largest farm feeding the empire and, when it applies,
//    how many stations are cut off — a pocket contributes exactly zero and
//    there is nothing anywhere else on screen that says so.
//
// 2. FORCE — THREE numbers, never one. It is tempting to blend them into a
//    single "strength", and it would be wrong in both directions at once:
//    BAL.UNITS gives infantry 1.0/1.2, artillery 1.8/0.6 and armour 1.5/0.9, so
//    the same stack is a different size attacking than defending; the matchup
//    triangle then makes it a different size again depending on who it meets,
//    and the additive fortress block (DEFENSE_BONUS_POWER) makes it a different
//    size again depending on where. Three counts keep the triangle visible and
//    still read at a glance.
//
// 3. TERRITORY — stations and territories against the board total. It is the
//    victory currency and it costs nothing to show.
//
// DELIBERATELY ABSENT: any empire-wide march or speed number. Speed is a
// property of a ROUTE, not of an empire — artillery 0.6 against armour 1.8, a
// wave moving at its slowest type, terrain on the territory entered and
// SEA_SPEED_MUL on top. An average would be a lie, and worse, it would hide the
// spread in arrival times that makes defeat in detail readable. March stays
// per-route, on the preview line and in the March section above.
//
// COST: the aggregate walks every station held, so it is throttled on SIM TICKS
// rather than on frames — a paused empire recomputes never and writes nothing.

// Sorts first. Left well below RDO_SECTION_ORDER (10) so something can still be
// inserted between the header and the station detail.
var RDO_HEADER_ORDER = 5;

// Sim ticks between recomputes of the empire aggregate. 10 ticks is one day
// (BAL.TICKS_PER_SEC), which is the unit the growth figure is already quoted
// in, so the number cannot visibly lag the thing it describes.
var RDO_HEADER_EVERY_TICKS = 10;

// Growth is quoted per MINUTE here, not per day. A single station makes
// fractions of a unit a day and reads as noise; a whole empire makes tens of
// units a minute, which is a number a player can hold in their head and compare
// against the cost of an attack.
var RDO_HEADER_PER_MIN = 60;

var _rdoHead = { tick: -1e9, pid: null, data: null };

// One pass over the player's stations. Read-only throughout: the growth probe
// runs against a throwaway object inside _rdoGrowthPerTick, and nothing here
// touches a station.
//
// The branch order below MIRRORS growthTick() — contested → cut off → over
// capacity → at cap → growing. That is control flow, not arithmetic; every
// number still comes from the sim.
function _rdoHeaderStats(state, pid) {
  if (_rdoHead.data && _rdoHead.pid === pid &&
      (state.tick - _rdoHead.tick) < RDO_HEADER_EVERY_TICKS) {
    return _rdoHead.data;
  }

  var ids = (typeof powerStations === 'function') ? powerStations(state, pid) : [];
  var e = {
    n: ids.length, inf: 0, art: 0, arm: 0, transit: 0, cap: 0,
    perTick: 0, cut: 0, contested: 0, atCap: 0,
    topFarm: null, topMul: 0, farms: 0,
    // Standing orders. Counted on THIS walk rather than on one of their own:
    // the aggregate already visits every station this power holds, on a tick
    // throttle, and a second per-frame sweep for three integers would be the
    // exact mistake the idle body made before it started reading this function
    // (two caches of one fact, printed side by side, disagreeing).
    //
    // feedSend is what LEAVES, not what the feeders are willing to part with —
    // the same correction the station panel got, and for the same reason: this
    // line said "20.1 units leave on the next sweep" while a full rally was
    // taking none of them. feedWant keeps the willingness so the two can be
    // compared, and feedBlocked/feedWhy/feedWhyAt carry the explanation the
    // number on its own cannot.
    rally: 0, feed: 0, feedSend: 0, feedWant: 0, feedBlocked: 0,
    feedWhy: null, feedWhyAt: null,
  };

  // ONE plan for the whole power, not one per feed city. standingOrderNext()
  // plans the entire sweep to answer about a single station, so a per-station
  // loop would repeat an 80us search once per feeder — 560us in a single frame
  // on a seven-city fixture, and worse the more the player automates.
  // standingOrderPlan is the same planner, asked once.
  var oplan = (typeof standingOrderPlan === 'function') ? standingOrderPlan(state, pid) : {};

  var mine = {};
  for (var i = 0; i < ids.length; i++) {
    var sid = ids[i];
    var st = state.stations[sid];
    var d = STATIONS[sid];
    var u = st.units;
    e.inf += u.infantry; e.art += u.artillery; e.arm += u.armour;
    e.cap += d.capacity || 0;
    mine[d.territory] = true;

    // Counted BEFORE the growth branches below, every one of which `continue`s.
    // A contested or cut-off station still carries its order — that is the
    // point of the order surviving everything but a capture — so counting it
    // after the branches would undercount exactly the stations whose logistics
    // the player most needs to know about.
    var ord = (typeof stationOrder === 'function') ? stationOrder(state, sid) : (st.order || 'hold');
    if (ord === 'rally') {
      e.rally++;
    } else if (ord === 'feed') {
      e.feed++;
      // The sim's own arithmetic, never a copy of it (01-data-schema.md:
      // "so a panel never reimplements the arithmetic and drifts from it") —
      // and the arithmetic that knows about the far end of the pipe. Read off
      // the single plan taken above; this loop does no searching of its own.
      var nx = oplan[sid];
      if (nx) {
        e.feedSend += nx.units;
        if (nx.units <= 0) {
          e.feedBlocked++;
          // The FIRST blocked feeder in sorted station order, so the summary
          // line is deterministic rather than "whichever the walk saw last".
          if (!e.feedWhy) { e.feedWhy = nx.blocked; e.feedWhyAt = nx.target; }
        }
      }
      if (typeof standingOrderSend === 'function') e.feedWant += standingOrderSend(state, sid);
    }

    var total = u.infantry + u.artillery + u.armour;
    var contested = (typeof stationAttackers === 'function') && stationAttackers(state, sid).length > 0;
    if (contested) { e.contested++; continue; }
    if (st.connected === false) {
      e.cut++;
      // DISCONNECT_GROWTH is 0.0 as shipped, so this adds nothing — which is
      // the point of counting the station separately. If the constant is ever
      // turned on, the sum picks it up with no edit here.
      e.perTick += _rdoGrowthPerTick(state, sid, u, BAL.DISCONNECT_GROWTH) || 0;
      continue;
    }
    if (total > d.capacity) continue;                       // bleeding off, not growing
    if (total >= d.capacity * BAL.GROWTH_CAP_EPSILON) { e.atCap++; continue; }
    e.perTick += _rdoGrowthPerTick(state, sid, u, 1) || 0;
  }

  // Which farms are actually feeding this empire, using sim/growth.js's own
  // reach test. A farm feeds whoever is in range regardless of who holds it
  // (growthMultiplier does not check), so this counts by REACH, not by owner.
  if (typeof multiplierStationIds === 'function' && typeof territoryHops === 'function') {
    var mids = multiplierStationIds();
    for (var f = 0; f < mids.length; f++) {
      var mid = mids[f];
      if (typeof isRealPower === 'function' && !isRealPower(state.stations[mid].owner)) continue;
      var mTerr = STATIONS[mid].territory;
      if (controlWeight(territoryControl(state, mTerr).tier) <= 0) continue;
      var hops = territoryHops(mTerr);
      var reaches = false;
      for (var t in mine) {
        if (hops[t] !== undefined && hops[t] <= BAL.MULTIPLIER_REACH) { reaches = true; break; }
      }
      if (!reaches) continue;
      e.farms++;
      if (STATIONS[mid].multiplier > e.topMul) {
        e.topMul = STATIONS[mid].multiplier;
        e.topFarm = STATIONS[mid].name;
      }
    }
  }

  var waves = state.waves || [];
  for (var w = 0; w < waves.length; w++) {
    if (waves[w].owner === pid) e.transit += totalUnits(waves[w].units);
  }

  e.held = e.inf + e.art + e.arm;
  e.terr = (typeof countTerritories === 'function') ? countTerritories(state, pid) : 0;
  // Full vs majority: the difference is whether an empire is consolidated or
  // over-extended. `maj` is an alias so the idle body reads the same field the
  // HUD's number means.
  e.maj = e.terr;
  e.full = (typeof countFullTerritories === 'function') ? countFullTerritories(state, pid) : 0;
  _rdoHead = { tick: state.tick, pid: pid, data: e };
  return e;
}

function _rdoHeaderBuild(host) {
  _rdoForget('hdr');
  var n = {};

  // Swatch-then-name, the .rdo-sub grammar the station body already uses for
  // ownership, so the player's colour means the same thing everywhere.
  var head = el('div', 'rdo-sub rdo-empire-head');
  n.swatch = el('span', 'rdo-swatch');
  n.name = el('span', 'rdo-name');
  head.appendChild(n.swatch);
  head.appendChild(n.name);
  host.appendChild(head);

  n.growth = _rdoRow(host, 'rdo-mod is-head', 'growth');
  n.growthSrc = _rdoSrcGroup(host);

  // FORCE as three cells, sharing the .rdo-units grammar the station block uses
  // for exactly the same reason: composition is the decision.
  n.forceRow = _rdoRow(host, 'rdo-mod', 'force');
  var units = el('div', 'rdo-units');
  n.inf = _rdoRow(units, 'rdo-unit', 'infantry');
  n.art = _rdoRow(units, 'rdo-unit', 'artillery');
  n.arm = _rdoRow(units, 'rdo-unit', 'armour');
  host.appendChild(units);

  n.terr = _rdoRow(host, 'rdo-mod', 'territory');
  n.terrSrc = _rdoSrcGroup(host);

  // LOGISTICS. Last, and hidden outright while every city is on `hold`, so the
  // three rows above it never move: a line that appears and disappears at the
  // BOTTOM of a section costs nothing to read past, while one inserted in the
  // middle shifts everything under it every time the player's last feed city is
  // captured. Suppressed rather than shown as "0 · 0" for the same reason the
  // whole `supply` section is hidden while a station is connected — the default
  // is not news, and this is a section the player is reading at a glance.
  n.logi = _rdoRow(host, 'rdo-mod', 'logistics');
  n.logiSrc = _rdoSrcGroup(host);
  return n;
}

function _rdoHeaderUpdate(state, n) {
  if (!state || !state.stations) return false;
  var pid = window.PLAYER || null;
  if (!pid) return false;

  var e = _rdoHeaderStats(state, pid);

  _rdoSet(n.name, 'hdrname', _rdoPowerName(pid));
  _rdoStyle(n.swatch, 'hdrswatch', 'background', _rdoPowerColor(pid) || 'var(--neutral-node)');

  var perMin = e.perTick * _rdoTicksPerDay() * RDO_HEADER_PER_MIN;
  _rdoSet(n.growth.v, 'hdrgrowth', (perMin > 0 ? '+' : '') + _rdoNum(perMin) + ' / min');
  _rdoClass(n.growth.row, 'hdrgrowthrow', 'is-stalled', perMin <= 0);

  var g = [];
  if (e.farms > 0 && e.topFarm) {
    g.push('×' + e.topMul + ' ' + e.topFarm + ' · ' + e.farms + ' farm' +
      (e.farms > 1 ? 's' : '') + ' in reach of your ground');
  }
  if (e.cut > 0) {
    g.push(e.cut + ' station' + (e.cut > 1 ? 's' : '') + ' cut off — growing nothing' +
      (BAL.DISCONNECT_GROWTH > 0 ? '' : ' at all'));
  }
  if (e.contested > 0) {
    g.push(e.contested + ' under attack — not recruiting');
  }
  if (e.atCap > 0) {
    g.push(e.atCap + ' at capacity — stopped paying dividends');
  }
  _rdoSources(n.growthSrc, 'hdrgrowthsrc', g);

  // Three counts, never a blend — see the header comment.
  _rdoSet(n.forceRow.v, 'hdrforce', _rdoNum(e.inf + e.art + e.arm) +
    (e.transit > 0 ? '  ·  ' + _rdoNum(e.transit) + ' moving' : ''));
  _rdoSet(n.inf.v, 'hdrinf', _rdoNum(e.inf));
  _rdoSet(n.art.v, 'hdrart', _rdoNum(e.art));
  _rdoSet(n.arm.v, 'hdrarm', _rdoNum(e.arm));

  var tTotal = (typeof TERRITORY_IDS !== 'undefined' && TERRITORY_IDS.length)
    ? TERRITORY_IDS.length
    : (typeof TERRITORIES !== 'undefined' ? Object.keys(TERRITORIES).length : 0);
  var sTotal = (typeof STATION_IDS !== 'undefined') ? STATION_IDS.length : 0;
  _rdoSet(n.terr.v, 'hdrterr', e.terr + ' / ' + tTotal);
  _rdoSources(n.terrSrc, 'hdrterrsrc', [
    e.n + ' of ' + sTotal + ' stations · a territory counts at majority',
  ]);

  // One line, on the aggregate's existing tick throttle — no second walk.
  var anyOrder = (e.rally > 0 || e.feed > 0);
  _rdoShow(n.logi, 'hdrlogi', anyOrder);
  if (anyOrder) {
    var parts = [];
    if (e.rally > 0) parts.push(e.rally + ' rallying');
    if (e.feed > 0) parts.push(e.feed + ' feeding');
    _rdoSet(n.logi.v, 'hdrlogiv', parts.join('  ·  '));
  }
  // The row and its source lines are hidden together, always. Forgetting that
  // once left a stale source line hanging under a hidden row, indistinguishable
  // from a live reading — see the comment on _rdoSources.
  var logiSrc = [];
  if (anyOrder && e.feed > 0) {
    // THE SAME CORRECTION THE STATION PANEL GOT. `feedSend` is what actually
    // leaves; it used to be the sum of what the feeders were WILLING to ship,
    // which stayed at "20.1 units leave on the next sweep" while a full rally
    // shipped none of them for the rest of the game.
    //
    // Every feeder blocked prints the reason instead of a bare 0 — a zero with
    // no explanation is the same failure in a smaller font.
    if (e.feedSend > 0) {
      logiSrc.push(_rdoNum(e.feedSend) + ' units leave on the next sweep, one every ' +
        BAL.ORDERS.INTERVAL + ' ticks' +
        (e.rally === 0 ? ' — no rally set, so they go to the front' : ''));
      if (e.feedBlocked > 0) {
        logiSrc.push(e.feedBlocked + ' of ' + e.feed + ' feed ' +
          (e.feedBlocked > 1 ? 'cities ship' : 'city ships') + ' nothing — ' +
          _rdoOrdersWhyShort(e.feedWhy, e.feedWhyAt));
      }
    } else {
      logiSrc.push('nothing leaves on the next sweep — ' +
        _rdoOrdersWhyShort(e.feedWhy, e.feedWhyAt));
      // What the blockage is COSTING, which is the number that makes a player
      // act. This is the one place `standingOrderSend`'s willingness belongs on
      // screen: not as a forecast of what will happen, but as the size of what
      // is not happening.
      if (e.feedWant > 0) {
        logiSrc.push(_rdoNum(e.feedWant) + ' units held back per sweep');
      }
    }
  } else if (anyOrder) {
    logiSrc.push('nothing is feeding them yet — a rally is a sink, not a source');
  }
  _rdoSources(n.logiSrc, 'hdrlogisrc', logiSrc);
  return true;
}

// ════════════════════════════════════════════════════════════════════════
// THE OTHER MODIFIERS — supply, strength, march
// ════════════════════════════════════════════════════════════════════════
//
// The growth block above answers "why does this city grow at this rate". It was
// the only question the rail could answer. A player deciding where to attack is
// asking two more — "why are those defenders hard" and "why is a march out of
// here slow" — and neither number existed on screen.
//
// Three more sections, each registered through the same public seam. They are
// separate sections rather than more rows on the station block because they are
// separate DECISIONS: you read Strength when choosing a target and March when
// choosing a route, and a fortress on a mountain would otherwise push the
// growth breakdown off the top of a 284px column.
//
// FOUR RULES, all inherited from the growth block and all load-bearing:
//
// 1. **Every number names its source.** "×1.8" is the thing the player asked to
//    get away from. Each headline is a labelled row and each contribution to it
//    is a `.rdo-farm` line naming the station, the terrain or the unit type it
//    came from.
//
// 2. **Nothing here reimplements a combat or movement fact.** Every figure is a
//    call into the sim:
//
//      defending power        stationPower(state, sid, 'defender')
//      body vs fort block     _bodyPower() / the difference from stationPower
//      fort scale-in + strip  _fortBonus() run twice, once with no attackers
//      armour vs forts        _strength('armour', false, fort)
//      march speed            waveSpeed() on a THROWAWAY wave (same trick as
//                             _rdoGrowthPerTick uses with _applyGrowth)
//
//    Only the tuning CONSTANTS are read directly (DEFENSE_BONUS_POWER,
//    SEA_ARTILLERY_LOSS, DISCONNECT_*), and they are read from BAL, never
//    copied as literals — data/tuning.js stays the single owner of every one.
//
// 3. **Additive is drawn additive.** The station defense block is the single
//    most important number in a fight and it is NOT a multiplier
//    (sim/combat.js, DEFENSE_BONUS_POWER). It is rendered "+18.0 power" with a
//    plus sign, in its own colour, never "×". Presenting it as a multiplier
//    would be lying about the one number the player most needs to be right.
//
// 4. **A row that is always the same is not shown.** A plains holding city has
//    fortLevel 0, terrain move 1.00, no sea link and an all-infantry garrison
//    at speed 1.00 — every one of those rows is suppressed, so the rail on an
//    ordinary city stays as short as it is today. Verdun on hills lights up.
//    The whole `supply` section is hidden while a station is connected, because
//    connected is the normal state; being cut off is the news.

// Order slots. Supply sits directly under the station detail because it
// invalidates half of it; strength and march follow in the order a player asks
// the questions. Gaps left between them, as with RDO_SECTION_ORDER.
var RDO_SUPPLY_ORDER = 11;
var RDO_STRENGTH_ORDER = 12;
var RDO_MARCH_ORDER = 14;

// Source lines shown under one row. Six is the worst real case (a fortress on
// mountains, under-garrisoned, being shelled) and nothing on the map exceeds it.
var RDO_MAX_SOURCES = 6;

// A value equal to 1.0 within this is the baseline, and the baseline is not a
// modifier. Floating-point slack rather than a design number.
var RDO_MOD_EPS = 0.005;

// Drop every remembered write whose key starts with `prefix`. Needed because
// _rdoLast survives a rebuild of the nodes it remembers — the same bug the farm
// row pool comment describes. Sections build in `order`, so the station block
// (10) recreates _rdoLast before these (11+) build; this makes that ordering
// non-load-bearing instead of merely true.
function _rdoForget(prefix) {
  if (!_rdoLast) { _rdoLast = Object.create(null); return; }
  var keys = Object.keys(_rdoLast);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(prefix) === 0) delete _rdoLast[keys[i]];
  }
}

// A group of source lines hanging off one row. Same pool discipline as the farm
// rows: grows, never shrinks, surplus hidden rather than removed.
function _rdoSrcGroup(parent) {
  var host = el('div', 'rdo-srcs');
  parent.appendChild(host);
  return { host: host, pool: [] };
}

// Hiding a ROW must also hide the lines hanging off it, and that is easy to
// forget because the two live in different nodes. It was forgotten once and the
// symptom was the worst kind: Bordeaux, which has no fortification at all,
// showed "urban · Germany → +0.60 lvl" underneath a hidden fortification row —
// a stale source line for a station the player was no longer looking at,
// attached to nothing, indistinguishable from a real reading.
//
// So every caller passes `on`, and a hidden row passes an empty list. There is
// no path that updates a row's visibility without updating its sources.
function _rdoSources(g, key, lines) {
  if (!lines) lines = [];
  var want = lines.length < RDO_MAX_SOURCES ? lines.length : RDO_MAX_SOURCES;
  while (g.pool.length < want) {
    var r = el('div', 'rdo-farm');
    g.host.appendChild(r);
    g.pool.push(r);
  }
  for (var i = 0; i < g.pool.length; i++) {
    var on = i < want;
    _rdoStyle(g.pool[i], key + '@' + i, 'display', on ? '' : 'none');
    if (on) _rdoSet(g.pool[i], key + '~' + i, lines[i]);
  }
}

// Additive power, signed. The sign is the message: this is troops added to the
// defence, not a factor applied to it.
function _rdoPlus(v) {
  if (!isFinite(v)) return '-';
  return (v >= 0 ? '+' : '−') + _rdoNum(Math.abs(v));
}

// Short unit tags, from BAL.UNIT_ORDER so a fourth unit type would appear here
// without an edit.
function _rdoUnitTag(t) { return String(t).slice(0, 3); }

// "inf ×1.2, art ×0.6" — the per-type factor each present type contributes,
// read out of BAL.UNITS rather than restated.
function _rdoTypeFactors(units, defending) {
  var out = [];
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    if (!(units[t] > BAL.ANNIHILATION_EPSILON)) continue;
    var u = BAL.UNITS[t];
    out.push(_rdoUnitTag(t) + ' ×' + (defending ? u.def : u.atk));
  }
  return out.join(', ');
}

// The heaviest type in a resolved mix, for naming who the matchup is against.
function _rdoTopType(mix) {
  if (!mix) return '';
  var best = '', bv = -1;
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    if (mix[t] > bv) { bv = mix[t]; best = t; }
  }
  return best;
}

// "an artillery-heavy assault", not "a artillery-heavy assault". The unit names
// come out of BAL.UNIT_ORDER, so this cannot be baked into a literal.
function _rdoArticle(word) {
  return /^[aeiou]/i.test(String(word)) ? 'an' : 'a';
}

function _rdoTerrainKey(sid) {
  var d = STATIONS[sid];
  var t = (typeof TERRITORIES !== 'undefined' && d) ? TERRITORIES[d.territory] : null;
  return (t && t.terrain) ? t.terrain : 'plains';
}

// ── supply ──────────────────────────────────────────────────────────────
//
// Cut off is the one modifier on this list that is invisible on the board and
// fatal on the clock: growth stops dead (DISCONNECT_GROWTH) and the garrison
// bleeds (DISCONNECT_DECAY). The section shows nothing at all while a station
// is connected — see rule 4 — so its mere presence is the alarm.

function _rdoSupplyBuild(host) {
  _rdoForget('sup');
  var n = {};
  n.state = _rdoRow(host, 'rdo-mod is-cut', 'supply');
  n.stateSrc = _rdoSrcGroup(host);
  n.growth = _rdoRow(host, 'rdo-mod', 'growth');
  n.decay = _rdoRow(host, 'rdo-mod', 'decay');
  n.decaySrc = _rdoSrcGroup(host);
  return n;
}

function _rdoSupplyUpdate(state, n) {
  var sid = _rdoResolve();
  if (!sid || !state || !state.stations || !state.stations[sid] || !STATIONS[sid]) return false;
  var st = state.stations[sid];
  // computeConnectivity() writes this every tick; `undefined` on a state that
  // has not ticked yet is not "cut off", it is "not known yet".
  if (st.connected !== false) return false;

  var owner = st.owner;
  var pdef = (typeof POWERS !== 'undefined') ? POWERS[owner] : null;
  var capSid = pdef ? pdef.capital : null;
  var capHeld = capSid && state.stations[capSid] && state.stations[capSid].owner === owner;
  // A power that has lost its capital anchors on its largest surviving
  // component instead (BAL.FALLBACK_ANCHOR_ON_CAPITAL_LOSS), so naming the
  // capital would name a place that is no longer the thing it is cut off from.
  _rdoSet(n.state.v, 'supstate', capHeld ? 'no path home' : 'cut from the main body');
  _rdoSources(n.stateSrc, 'supstatesrc', [
    capHeld && STATIONS[capSid]
      ? 'no chain of ' + _rdoPowerName(owner) + ' stations reaches ' + STATIONS[capSid].name
      : _rdoPowerName(owner) + ' has lost its capital; this pocket is not the largest one left',
  ]);

  _rdoSet(n.growth.v, 'supgrowth', _rdoMul(BAL.DISCONNECT_GROWTH));
  _rdoClass(n.growth.row, 'supgrowthrow', 'is-off', true);

  var since = (st.discSince === undefined || st.discSince < 0) ? state.tick : st.discSince;
  var elapsed = state.tick - since;
  var decaying = elapsed >= BAL.DISCONNECT_GRACE;
  var total = totalUnits(st.units);
  if (decaying) {
    _rdoSet(n.decay.v, 'supdecay', '−' + _rdoPctFine(BAL.DISCONNECT_DECAY) + ' / tick');
    _rdoSources(n.decaySrc, 'supdecaysrc', [
      'cut off for ' + elapsed + ' ticks — ' +
      _rdoNum(total * BAL.DISCONNECT_DECAY * _rdoTicksPerDay()) + ' / day at this size',
    ]);
  } else {
    _rdoSet(n.decay.v, 'supdecay', 'in ' + (BAL.DISCONNECT_GRACE - elapsed) + ' ticks');
    _rdoSources(n.decaySrc, 'supdecaysrc', [
      'grace period is ' + BAL.DISCONNECT_GRACE + ' ticks; relieve it before then and nothing is lost',
    ]);
  }
  return true;
}

// ── strength ────────────────────────────────────────────────────────────

function _rdoStrengthBuild(host) {
  _rdoForget('str');
  var n = {};
  n.hold = _rdoRow(host, 'rdo-mod is-head', 'holding here');
  n.body = _rdoRow(host, 'rdo-mod', 'garrison');
  n.bodySrc = _rdoSrcGroup(host);
  n.fort = _rdoRow(host, 'rdo-mod is-add', 'fortification');
  n.fortSrc = _rdoSrcGroup(host);
  n.match = _rdoRow(host, 'rdo-mod', 'matchup');
  n.matchSrc = _rdoSrcGroup(host);
  n.atk = _rdoRow(host, 'rdo-mod', 'attacking out');
  n.atkSrc = _rdoSrcGroup(host);
  return n;
}

function _rdoStrengthUpdate(state, n) {
  var sid = _rdoResolve();
  if (!sid || !state || !state.stations || !state.stations[sid] || !STATIONS[sid]) return false;
  if (typeof stationPower !== 'function' || typeof fortLevel !== 'function') return false;

  var d = STATIONS[sid];
  var st = state.stations[sid];
  var units = st.units;
  var fort = fortLevel(sid);

  // Every hostile stack standing here, via the sim's own reader. Pure: it
  // builds a fresh unit bag with emptyUnits()/addUnits and never writes back.
  var atk = (typeof _allAttackerUnits === 'function') ? _allAttackerUnits(state, sid) : emptyUnits();
  var anyAtk = totalUnits(atk) > BAL.ANNIHILATION_EPSILON;
  var enemyMix = (typeof _mix === 'function') ? _mix(atk, false, fort) : null;

  // The headline IS the sim's number, not a sum of the rows below it.
  var pDef = stationPower(state, sid, 'defender');
  var body = (typeof _bodyPower === 'function') ? _bodyPower(units, true, fort, enemyMix) : pDef;
  // …and the fort block is the remainder, so the two rows cannot fail to add up
  // to the headline even if sim/combat.js gains another term.
  var fbonus = pDef - body;

  _rdoSet(n.hold.v, 'strhold', _rdoNum(pDef) + ' power');

  _rdoSet(n.body.v, 'strbody', _rdoNum(body) + ' power');
  var bodyLines = [];
  var facs = _rdoTypeFactors(units, true);
  if (facs) bodyLines.push(facs + ' defending · ' + _rdoNum(totalUnits(units)) + ' units');
  else bodyLines.push('no garrison — this station changes hands without a fight');
  _rdoSources(n.bodySrc, 'strbodysrc', bodyLines);

  // ── the additive block ──
  var fortLines = [];
  _rdoShow(n.fort, 'strfort', fort > 0);
  if (fort > 0) {
    _rdoSet(n.fort.v, 'strfortv', _rdoPlus(fbonus) + ' power');
    var own = d.defense - 1;
    if (Math.abs(own) > RDO_MOD_EPS) {
      fortLines.push(_rdoTypeLabel(d) + ', defense ' + d.defense + ' → ' +
        (own > 0 ? '+' : '−') + Math.abs(own).toFixed(2) + ' lvl');
    }
    var tKey = _rdoTerrainKey(sid);
    var tDef = terrainOf(sid).defense;
    if (Math.abs(tDef) > RDO_MOD_EPS) {
      fortLines.push(tKey + ' · ' + _rdoTerritoryName(d.territory) + ' → +' + tDef.toFixed(2) + ' lvl');
    }
    fortLines.push(fort.toFixed(2) + ' lvl × ' + BAL.DEFENSE_BONUS_POWER + ' = ' +
      _rdoPlus(fort * BAL.DEFENSE_BONUS_POWER) + ' at full garrison');

    // Scale-in and artillery strip, both derived from the sim's own
    // _fortBonus rather than restated: run it once with no attackers to get
    // the un-stripped block, and the two factors fall out of the ratio.
    var fNoAtk = (typeof _fortBonus === 'function')
      ? _fortBonus(sid, units, emptyUnits(), fort) : fbonus;
    var full = fort * BAL.DEFENSE_BONUS_POWER;
    var scale = full > 0 ? fNoAtk / full : 1;
    if (scale < 1 - RDO_MOD_EPS) {
      fortLines.push('only ' + _rdoNum(totalUnits(units)) + ' of ' + BAL.DEFENSE_BONUS_FULL_AT +
        ' defenders manning it — ' + _rdoMul(scale));
    }
    var strip = fNoAtk > 0 ? 1 - (fbonus / fNoAtk) : 0;
    if (strip > RDO_MOD_EPS) {
      fortLines.push('enemy artillery strips ' + _rdoPctFine(strip) +
        (strip >= BAL.FORT_STRIP_CAP - RDO_MOD_EPS ? ' (capped)' : ''));
    }
    if (typeof _strength === 'function' && BAL.UNITS.armour) {
      var armF = _strength('armour', false, fort) / BAL.UNITS.armour.atk;
      if (armF < 1 - RDO_MOD_EPS) {
        fortLines.push('armour attacks at ' + _rdoMul(armF) + ' — tanks do not reduce forts');
      }
    }
  }
  _rdoSources(n.fortSrc, 'strfortsrc', fortLines);

  // ── matchup, only while somebody is actually standing here ──
  var bodyPlain = (typeof _bodyPower === 'function') ? _bodyPower(units, true, fort, null) : 0;
  var m = bodyPlain > 0 ? body / bodyPlain : 1;
  var showMatch = anyAtk && bodyPlain > 0 && Math.abs(m - 1) > RDO_MOD_EPS;
  _rdoShow(n.match, 'strmatch', showMatch);
  if (showMatch) {
    _rdoSet(n.match.v, 'strmatchv', _rdoMul(m));
    _rdoClass(n.match.row, 'strmatchrow', 'is-off', m < 1);
  }
  _rdoSources(n.matchSrc, 'strmatchsrc', showMatch ? [
    'against ' + _rdoArticle(_rdoTopType(enemyMix)) + ' ' + _rdoTopType(enemyMix) +
      '-heavy assault of ' + _rdoNum(totalUnits(atk)) + ' units',
  ] : []);

  // ── what this garrison is worth on the offensive ──
  //
  // The same troops, at their atk values, on open ground: no fort, no matchup.
  // This is the number that says a fortress garrison is not a field army.
  var open = (typeof _bodyPower === 'function') ? _bodyPower(units, false, 0, null) : 0;
  var showAtk = totalUnits(units) > BAL.ANNIHILATION_EPSILON;
  _rdoShow(n.atk, 'stratk', showAtk);
  if (showAtk) _rdoSet(n.atk.v, 'stratkv', _rdoNum(open) + ' power');
  _rdoSources(n.atkSrc, 'stratksrc', showAtk ? [
    _rdoTypeFactors(units, false) + ' attacking · open ground, before the target’s fort',
  ] : []);
  return true;
}

// ── march ───────────────────────────────────────────────────────────────
//
// Speed is not a property of a station, it is a property of a LINK — terrain
// modifies the march INTO a territory, and the sea multipliers belong to the
// crossing. So the section reports the two things a station can honestly say:
// how fast this garrison itself moves (its slowest type), and what leaving by
// each exit actually costs in days.

// Exit rows. Quickest and slowest bracket the choice; a full list of six
// neighbours would be a table, and the rail is 284px wide.
var RDO_MARCH_EXITS = 2;

function _rdoMarchBuild(host) {
  _rdoForget('mar');
  var n = { exits: [] };
  n.pace = _rdoRow(host, 'rdo-mod', 'pace');
  n.paceSrc = _rdoSrcGroup(host);
  for (var i = 0; i < RDO_MARCH_EXITS; i++) {
    var r = _rdoRow(host, 'rdo-mod', '');
    n.exits.push({ row: r, src: _rdoSrcGroup(host) });
  }
  n.inb = _rdoRow(host, 'rdo-mod', 'arriving here');
  n.inbSrc = _rdoSrcGroup(host);
  n.sea = _rdoRow(host, 'rdo-mod', 'by sea');
  n.seaSrc = _rdoSrcGroup(host);
  n.land = _rdoRow(host, 'rdo-mod', 'landing');
  n.landSrc = _rdoSrcGroup(host);
  return n;
}

function _rdoMarchUpdate(state, n) {
  var sid = _rdoResolve();
  if (!sid || !state || !state.stations || !state.stations[sid] || !STATIONS[sid]) return false;
  if (typeof waveSpeed !== 'function' || typeof stationAdjacency !== 'function') return false;

  var d = STATIONS[sid];
  var st = state.stations[sid];
  var tpd = _rdoTicksPerDay();

  // An empty station still has exits worth pricing; quote them for infantry and
  // say so, rather than showing a speed of zero.
  var real = totalUnits(st.units) > BAL.ANNIHILATION_EPSILON;
  var ref = real ? st.units : { infantry: 1, artillery: 0, armour: 0 };

  // ── pace: the slowest type present, which is what the whole stack moves at ──
  var slowest = Infinity, slowType = '';
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    if (!(ref[t] > BAL.ANNIHILATION_EPSILON)) continue;
    if (BAL.UNITS[t].speed < slowest) { slowest = BAL.UNITS[t].speed; slowType = t; }
  }
  var showPace = isFinite(slowest) && Math.abs(slowest - 1) > RDO_MOD_EPS;
  _rdoShow(n.pace, 'marpace', showPace);
  if (showPace) {
    _rdoSet(n.pace.v, 'marpacev', _rdoMul(slowest));
    _rdoClass(n.pace.row, 'marpacerow', 'is-off', slowest < 1);
  }
  _rdoSources(n.paceSrc, 'marpacesrc', showPace ? [
    slowType + ' is the slowest type here — a stack moves at its slowest',
  ] : []);

  // ── exits, priced with the sim's own waveSpeed on a throwaway wave ──
  var adj = stationAdjacency()[sid] || [];
  var exits = [];
  for (var k = 0; k < adj.length; k++) {
    var nb = adj[k];
    var l = (typeof linkBetween === 'function') ? linkBetween(sid, nb) : null;
    var dist = (l && l.dist > 0) ? l.dist : 1;
    // Read-only probe: waveSpeed only reads w.path / w.hop / w.units.
    var v = waveSpeed({ path: [sid, nb], hop: 0, units: ref, owner: st.owner });
    if (!(v > 0)) continue;
    exits.push({ sid: nb, days: (dist / v) / tpd, sea: !!(l && l.sea) });
  }
  exits.sort(function (a, b) {
    if (a.days !== b.days) return a.days - b.days;
    return a.sid < b.sid ? -1 : 1;
  });
  var picked = [];
  if (exits.length) picked.push({ tag: exits.length > 1 ? 'quickest out' : 'only exit', e: exits[0] });
  if (exits.length > 1) picked.push({ tag: 'slowest out', e: exits[exits.length - 1] });

  for (var x = 0; x < RDO_MARCH_EXITS; x++) {
    var on = x < picked.length;
    _rdoShow(n.exits[x].row, 'marexit' + x, on);
    if (!on) { _rdoSources(n.exits[x].src, 'marexitsrc' + x, []); continue; }
    var p = picked[x];
    _rdoSet(n.exits[x].row.k, 'marexitk' + x, p.tag);
    _rdoSet(n.exits[x].row.v, 'marexitv' + x, _rdoNum(p.e.days) + ' days');
    var why = [];
    var nk = _rdoTerrainKey(p.e.sid);
    var nm = BAL.TERRAIN[nk] ? BAL.TERRAIN[nk].move : 1;
    if (Math.abs(nm - 1) > RDO_MOD_EPS) why.push(nk + ' ' + _rdoMul(nm));
    if (p.e.sea) {
      why.push('sea ' + _rdoMul(BAL.SEA_SPEED_MUL));
      if (ref.artillery > BAL.ANNIHILATION_EPSILON) {
        why.push('guns ' + _rdoMul(BAL.SEA_ARTILLERY_SPEED_MUL));
      }
    }
    if (showPace) why.push(slowType + ' ' + _rdoMul(slowest));
    _rdoSources(n.exits[x].src, 'marexitsrc' + x, [
      'to ' + STATIONS[p.e.sid].name + (why.length ? ' — ' + why.join(', ') : ' — no penalties') +
      (real ? '' : ' (quoted for infantry; nothing garrisoned)'),
    ]);
  }

  // ── the modifier this station imposes on everyone marching IN ──
  var tKey = _rdoTerrainKey(sid);
  var tMove = BAL.TERRAIN[tKey] ? BAL.TERRAIN[tKey].move : 1;
  var showInb = Math.abs(tMove - 1) > RDO_MOD_EPS;
  _rdoShow(n.inb, 'marinb', showInb);
  if (showInb) {
    _rdoSet(n.inb.v, 'marinbv', _rdoMul(tMove));
    _rdoClass(n.inb.row, 'marinbrow', 'is-off', tMove < 1);
  }
  _rdoSources(n.inbSrc, 'marinbsrc', showInb ? [
    tKey + ' · every march into ' + _rdoTerritoryName(d.territory) + ' pays this',
  ] : []);

  // ── water ──
  var seaNames = [];
  for (var s = 0; s < exits.length; s++) if (exits[s].sea) seaNames.push(STATIONS[exits[s].sid].name);
  _rdoShow(n.sea, 'marsea', seaNames.length > 0);
  if (seaNames.length) {
    _rdoSet(n.sea.v, 'marseav', _rdoMul(BAL.SEA_SPEED_MUL));
    _rdoClass(n.sea.row, 'marsearow', 'is-off', true);
  }
  _rdoSources(n.seaSrc, 'marseasrc', seaNames.length ? [
    'water link to ' + seaNames.join(', '),
    'guns ' + _rdoMul(BAL.SEA_ARTILLERY_SPEED_MUL) + ' again, −' +
      _rdoPctFine(BAL.SEA_ARTILLERY_LOSS) + ' of them lost per crossing',
  ] : []);

  // ── a landing in progress, which is a speed modifier on an arrival ──
  var lw = null;
  var waves = state.waves || [];
  for (var w = 0; w < waves.length; w++) {
    var wv = waves[w];
    if (wv.landing && wv.path && wv.path[wv.path.length - 1] === sid) { lw = wv; break; }
  }
  _rdoShow(n.land, 'marland', !!lw);
  if (lw) _rdoSet(n.land.v, 'marlandv', _rdoNum(lw.landing.ashore) + ' / ' + _rdoNum(lw.landing.total));
  _rdoSources(n.landSrc, 'marlandsrc', lw ? [
    _rdoPowerName(lw.owner) + ' coming ashore over ' + BAL.LANDING_TICKS +
      ' ticks — ' + _rdoNum(totalUnits(lw.units)) + ' still at sea and unhittable',
  ] : []);
  return true;
}

// ── orders ──────────────────────────────────────────────────────────────
//
// 01-data-schema.md, "Standing orders". The section answers the two questions a
// player has after pressing R or F over a group: *did that land on this city*,
// and *what is it actually worth per sweep*.
//
// RULE 4 FROM THE BLOCK ABOVE DECIDES ALMOST EVERYTHING HERE. "A row that is
// always the same is not shown" — and `hold` is not merely the common value,
// it is what ~all 108 stations on the board carry, because it is the default
// and the off switch. So a station on `hold` hides the WHOLE section, exactly
// as `supply` hides itself while a station is connected. The section's presence
// is the reading; its absence is the other one.
//
// This is also why there is no "order: hold" row and no set-it-here control.
// The rail is where you find out what is true, not where the game is played
// (00-vision.md §8) — the order is SET on the map, on a whole group at once,
// with one keystroke that leaves the selection intact. A per-station dropdown
// here would make setting twelve cities twelve trips to the right-hand column.
//
// EVERY NUMBER COMES OUT OF THE SIM — AND IT IS THE RIGHT ONE.
//
// This row used to read `standingOrderSend(state, sid)`, which is the SOURCE'S
// WILLINGNESS: how much a feed city wants to ship, before the destination gets
// a say. Once the headroom ceiling landed in sim/movement.js those two numbers
// stopped being the same number, and the panel went on printing the first one.
// Measured live on the 8-city German opening, 7 feeders into one rally:
//
//   rail said     "next sweep — 5.6 units · 12% of the surplus above the keep floor"
//   header said   "20.1 units leave on the next sweep, one every 25 ticks"
//   reality       Leipzig Works sat at 28.5 / 28. Zero sends, zero units,
//                 forever — orderStats.sends stayed at 0 across 400 ticks.
//
// A promise that never happens, with nothing on screen explaining why, is worse
// than showing no number: the player has no way to tell a working supply line
// from a stalled one, and the fix (spend that stack, or set a rally with room)
// is invisible.
//
// So the headline is `standingOrderNext(state, sid)` — what ACTUALLY leaves,
// which rally it is aimed at, and a machine-readable reason when the answer is
// zero. That function shares the sweep's own planner, so it cannot drift from
// what the sweep does; the willingness is still quoted, but only as the FRACTION
// on the source line, where it is a description of the rule rather than a
// forecast.
//
// THE BLOCKED CASE IS THE IMPORTANT ONE and it names the city: "nothing ships —
// Leipzig Works is full" reads correctly and tells the player exactly what to
// do. Each reason gets its own sentence in _rdoOrdersWhy below, because the
// fixes are different — a city at its keep floor should be LEFT ALONE, one under
// the minimum stream needs nothing but time, and a full rally needs spending.
var RDO_ORDERS_ORDER = 13;

function _rdoOrdersBuild(host) {
  _rdoForget('ord');
  var n = {};
  n.order = _rdoRow(host, 'rdo-mod is-head', 'order');
  n.order.v.classList.add('rdo-order-v');
  n.orderSrc = _rdoSrcGroup(host);
  // `rdo-order-sweep` exists so a blocked stream can be coloured without the
  // rule reaching the empire header's growth row, which carries `is-stalled`
  // too. Scoped in the orders: block in style.css.
  n.sweep = _rdoRow(host, 'rdo-mod rdo-order-sweep', 'next sweep');
  n.sweepSrc = _rdoSrcGroup(host);
  n.feeders = _rdoRow(host, 'rdo-mod', 'feeding in');
  n.feedersSrc = _rdoSrcGroup(host);
  return n;
}

// One sentence per blocked reason, in the player's terms and naming the city
// when the sim named one. The reasons come from sim/movement.js; a reason this
// file has not been taught falls through to the bare statement rather than
// throwing, so a new sim reason degrades to "nothing ships" instead of retiring
// the section.
function _rdoOrdersWhy(state, sid, next) {
  var d = STATIONS[sid];
  var st = state.stations[sid];
  var dest = next.target ? _rdoStationName(next.target) : null;

  switch (next.blocked) {
    case 'destination-full':
      return dest
        ? 'nothing ships — ' + dest + ' is full. Spend that stack, or set a rally with room'
        : 'nothing ships — every rally you hold is already at its ceiling';
    case 'at-keep-floor':
      return 'holding ' + _rdoNum(totalUnits(st.units)) + ' against a ' +
        _rdoNum(BAL.ORDERS.KEEP_FLOOR * (d.capacity || 0)) +
        '-unit keep floor — a feed city never ships itself defenceless';
    case 'below-min-send':
      return 'the surplus is under the ' + BAL.ORDERS.MIN_SEND +
        '-unit minimum stream — it ships once it has grown';
    case 'unreachable':
      return 'nothing ships — no route to a rally over ground you hold';
    case 'no-seed':
      return 'nothing ships — no rally set, and this city has no frontier to fall back to';
    case 'already-there':
      return 'nothing ships — with no rally set, this city is itself the front';
    default:
      return 'nothing ships';
  }
}

// Does this block need the PLAYER, or only time?
//
// The warning colour is spent only on the first kind. A city sitting at its keep
// floor, or with a surplus under the minimum stream, is the rule working exactly
// as designed and will ship as it grows — colouring those is crying wolf on the
// normal case, and a rail that shouts about everything is a rail nobody reads.
// A full rally, a cut corridor and "no rally anywhere" are different: nothing
// changes until the player does something.
function _rdoOrdersActionable(reason) {
  return reason === 'destination-full' || reason === 'unreachable' || reason === 'no-seed';
}

// The same reasons as a fragment, for the empire header's one-line summary.
function _rdoOrdersWhyShort(reason, target) {
  var dest = target ? _rdoStationName(target) : null;
  switch (reason) {
    case 'destination-full':
      return dest ? dest + ' is full' : 'every rally is full';
    case 'at-keep-floor':   return 'they are at their keep floor';
    case 'below-min-send':  return 'their surplus is under the ' + BAL.ORDERS.MIN_SEND + '-unit minimum';
    case 'unreachable':     return 'no route to a rally over ground you hold';
    case 'no-seed':         return 'no rally set, and no frontier to fall back to';
    case 'already-there':   return 'they are already on the front';
    default:                return 'nothing is getting through';
  }
}

function _rdoOrdersUpdate(state, n) {
  var sid = _rdoResolve();
  if (!sid || !state || !state.stations || !state.stations[sid] || !STATIONS[sid]) return false;

  var st = state.stations[sid];
  // Through core's accessor, so this file is not the second place the default
  // is written down. Read LIVE every frame and cached nowhere: an order does
  // not survive a capture (setStationOwner resets it), so a panel holding on to
  // one would keep describing a city that has changed hands.
  var order = (typeof stationOrder === 'function')
    ? stationOrder(state, sid)
    : (st.order || 'hold');
  if (order === 'hold') return false;

  var isFeed = (order === 'feed');
  _rdoSet(n.order.v, 'ordv', order);
  _rdoSources(n.orderSrc, 'ordsrc', [
    isFeed
      ? 'a source — ships surplus to the nearest rally, or to the front if none is set'
      : 'a sink — feed cities stream their surplus to the nearest rally',
  ]);

  // ── what leaves next sweep (feed only) ──
  //
  // The row is suppressed on a rally for the same reason `pace` is suppressed
  // on an all-infantry garrison: a rally never ships, so the answer is not
  // merely zero, it is not a question this station has.
  _rdoShow(n.sweep, 'ordsweep', isFeed);
  var sweepSrc = [];
  if (isFeed) {
    // What ACTUALLY leaves, not what this city is willing to part with. See the
    // block comment above RDO_ORDERS_ORDER.
    var next = (typeof standingOrderNext === 'function')
      ? standingOrderNext(state, sid)
      : { units: 0, target: null, blocked: 'no-order' };
    var ships = next.units > 0;
    var tpd = _rdoTicksPerDay();
    _rdoSet(n.sweep.v, 'ordsweepv', ships ? _rdoNum(next.units) + ' units' : 'nothing');
    _rdoClass(n.sweep.row, 'ordsweeprow', 'is-stalled',
      !ships && _rdoOrdersActionable(next.blocked));
    if (ships) {
      // The destination is named FIRST: a stream is a pipe and the far end is
      // the half the player cannot see on the map. The fraction below it is the
      // rule, not a forecast — the number above already is the forecast.
      sweepSrc.push('to ' + _rdoStationName(next.target) + ' · ' +
        _rdoPct(BAL.ORDERS.SEND_FRACTION) + ' of the surplus above the keep floor');
      sweepSrc.push(_rdoNum(next.units * tpd / BAL.ORDERS.INTERVAL) + ' / day at this size');
    } else {
      sweepSrc.push(_rdoOrdersWhy(state, sid, next));
    }
  }
  _rdoSources(n.sweepSrc, 'ordsweepsrc', sweepSrc);

  // ── what is aimed at this rally ──
  //
  // Read off the empire aggregate, which already walks every station this power
  // holds on a tick throttle — so hovering a rally costs no extra sweep. Only
  // for the human's own ground: the aggregate is keyed to PLAYER, and quoting
  // it under another power's city would be a number about somebody else.
  var me = window.PLAYER || null;
  var mine = (me && st.owner === me);
  var e = (!isFeed && mine) ? _rdoHeaderStats(state, me) : null;
  var showFeeders = !!(e && e.feed > 0);
  _rdoShow(n.feeders, 'ordfeed', showFeeders);
  var feedSrc = [];
  if (showFeeders) {
    _rdoSet(n.feeders.v, 'ordfeedv', e.feed + ' cities  ·  ' + _rdoNum(e.feedSend) + ' / sweep');
    // Deliberately an EMPIRE-wide figure, and said so. A feed city ships to its
    // NEAREST rally, and which one that is comes out of an ownership-aware
    // search inside sim/movement.js that this file has no access to. Quoting
    // the empire total as if it were this rally's inbound would be a confident
    // lie the moment a second rally exists; naming the scope is honest and
    // still answers "is my network actually running".
    feedSrc.push(e.rally > 1
      ? 'empire-wide — each feed city ships to its nearest of your ' + e.rally +
        ' rallies, which may not be this one'
      : 'empire-wide — the only rally you hold, so every feed city that can reach it ships here');
    // "7 cities · 0.0 / sweep" is true and still leaves the player guessing.
    // The rally being hovered is very often the reason itself.
    if (!(e.feedSend > 0) && e.feedBlocked > 0) {
      feedSrc.push('nothing is getting through — ' + _rdoOrdersWhyShort(e.feedWhy, e.feedWhyAt));
    }
  }
  _rdoSources(n.feedersSrc, 'ordfeedsrc', feedSrc);
  return true;
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

railAddSection({
  id: 'empire',
  title: 'Empire',
  order: RDO_HEADER_ORDER,
  build: _rdoHeaderBuild,
  update: _rdoHeaderUpdate,
});

railAddSection({
  id: 'supply',
  title: 'Supply',
  order: RDO_SUPPLY_ORDER,
  build: _rdoSupplyBuild,
  update: _rdoSupplyUpdate,
});

railAddSection({
  id: 'strength',
  title: 'Strength',
  order: RDO_STRENGTH_ORDER,
  build: _rdoStrengthBuild,
  update: _rdoStrengthUpdate,
});

railAddSection({
  id: 'orders',
  title: 'Orders',
  order: RDO_ORDERS_ORDER,
  build: _rdoOrdersBuild,
  update: _rdoOrdersUpdate,
});

railAddSection({
  id: 'march',
  title: 'March',
  order: RDO_MARCH_ORDER,
  build: _rdoMarchBuild,
  update: _rdoMarchUpdate,
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
