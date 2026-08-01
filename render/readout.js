// render/readout.js — renderReadout(state) / setReadoutFocus(sid) /
//                     railAddSection(spec).
//
// ── THE RAIL ─────────────────────────────────────────────────────────────
//
// This file owns `#rail`, the persistent column down the right-hand side of the
// screen. It used to draw a small panel that followed the cursor. That panel was
// click-transparent so it never ate a commit, but it appeared beside the station
// the player was about to click — i.e. exactly where their attention and their
// cursor already were — and covered the board at the one moment the board
// mattered most. The answer to that is not a cleverer anchor. It is a place on
// screen that is always the same place.
//
// The rail is a flex SIBLING of .board-wrap, never an overlay (index.html,
// `.stage`). That is a safety property, not a layout preference: anything
// painted over the board that accepts pointer events swallows the click that
// commits an attack and the game stops responding with no error at all. In
// normal flow the rail displaces the board instead — the SVG has a viewBox, so
// it simply rescales, and render/camera.js's ResizeObserver rebuilds its fit
// rect so marquee selection stays aligned with what is drawn.
//
// ── WHAT THIS COLUMN IS FOR, AFTER THE CUT ───────────────────────────────
//
// It used to be ~30 rows of labelled text in a 284px column: five sections,
// four section titles, a growth breakdown of five rows, four farm rows, an
// eight-row STRENGTH block and a six-row MARCH block. Every number in it was
// true. Most of them did not change a decision.
//
// The test applied to every row that survived: **does this number change what
// the player is about to do?** A player looking at this column is choosing one
// of four things — where to attack, what to attack with, what to reinforce, and
// what to spend before it stops growing. A row that does not move one of those
// four is gone, however correct it was.
//
// So, deleted and why:
//
//   base rate ×1.00 city    the type badge already says "city", and the rate is
//                           a constant of the station. It never moves.
//   logistic ×0.10 90% full the capacity bar IS the logistic term, drawn. Two
//                           renderings of one fact in one column.
//   farm rows, four of them the coverage overlay puts farm reach ON THE MAP
//                           (§8), which is where it belongs; the rail keeps the
//                           product and names the strongest one.
//   garrison / fortification the split is kept, but as one power row and one
//   / matchup / attacking    conditional additive row, not five rows and six
//   out, six source lines    source lines.
//   quickest+slowest exits,  a range on one row. The per-route ETA a player
//   four source lines        actually commits on is on the preview line (§8),
//                           computed for the route they chose.
//   territory full-vs-       the map already draws the three tiers differently
//   majority split           (solid / wash / hatched, §3). Reading it off a
//                           number was the second copy.
//   the idle body            the empire section is always on screen now, so the
//                           rail can never be an empty gutter without it.
//
// Kept, and why, because these are the ones that decide a fight:
//
//   garrison / capacity      full means "stopped paying dividends" (§2) and is
//                           the whole spend-it signal.
//   composition by type      the soft triangle (§4) is composition. A total
//                           hides the decision.
//   defence vs attack power  the two numbers an assault is decided by, side by
//                           side, in the same unit.
//   fortification, ADDITIVE  see the rule below. It is the single most
//                           important number in a fight.
//   cut off                  invisible on the board, fatal on the clock.
//   march range              distance is how defeat in detail happens (§8).
//
// ── ICONS ────────────────────────────────────────────────────────────────
//
// Four, and they replace the four section-title rows that used to be pure
// chrome (STRENGTH / MARCH / SUPPLY / ORDERS). They mark the things a player
// scans FOR — "how hard is this to take", "how long is the march", "is
// something wrong" — and nothing else. An icon per row would be a differently
// shaped wall.
//
// None of them replaces an ambiguous word. `power` still says power, `d` still
// says days, `+3.6 power` still carries its plus sign. Every icon additionally
// carries `title` + `aria-label` on the element that holds it, because an icon
// that has to be learned is worse than the word it replaced.
//
// ── TWO RULES THIS FILE IS BUILT AROUND ──────────────────────────────────
//
// 1. **Never reimplement a sim fact.** Every number below comes out of
//    sim/ or core/state.js by calling it:
//
//      growth this tick      _applyGrowth() run against a THROWAWAY station
//      the multiplier total  state.stations[sid].growthMul (what growth USED)
//      which farms reach     multiplierStationIds() + territoryHops()
//      defending power       stationPower(state, sid, 'defender')
//      the fort block        the REMAINDER of stationPower over _bodyPower, so
//                            the two cannot fail to add up even if
//                            sim/combat.js gains another term
//      fort scale-in + strip _fortBonus() run twice, once with no attackers
//      march speed           waveSpeed() on a THROWAWAY wave
//      supply lines          stationSupply / stationSuppliedBy (core/state.js)
//      what actually ships   standingOrderNext / standingOrderPlan
//
//    Only tuning CONSTANTS are read directly, and they are read from BAL, never
//    copied as literals. A formula copied into a renderer silently drifts the
//    first time the sim is tuned, and then the panel is confidently wrong —
//    worse than absent. The one thing mirrored here is growthTick()'s *branch
//    order* (contested → cut off → over capacity → at cap → growing), which is
//    control flow, not arithmetic; it is labelled at the branch.
//
// 2. **ADDITIVE IS NEVER DRAWN AS A MULTIPLIER.** Station defense is a rating
//    whose excess over 1.0 becomes FLAT POWER (BAL.DEFENSE_BONUS_POWER = 6.0).
//    This panel once wrote `DEF ×3.2` for it, which was not a rounding error —
//    it misstated the one number an assault is decided by, in the direction
//    that makes a fortress look unassailable. It is written `+3.6 power` with a
//    plus sign in the garrison colour, and its working is quoted in `lvl`, the
//    same vocabulary sim/combat.js uses. If a `×` ever appears in that row the
//    renderer is lying.
//
//    The corollary, and it is why several rows here keep a word next to their
//    icon: **if a number's units are not obvious, it needs the word.** An icon
//    is not a unit.
//
// 3. **A readout must never answer a different question from the one on
//    screen** (docs/testing/known-issues.md #18). The supply row prints
//    `standingOrderNext()` — what the sweep's own planner will actually do —
//    never `standingOrderSend()`, which is what the source is *willing* to part
//    with. Those two stopped being the same number the day destinations gained
//    a veto, and the panel went on printing the first one for a whole
//    milestone. Willingness is a fine thing to compute and a terrible thing to
//    print.
//
// 4. **A SECTION MAY ONLY SPEAK ABOUT A STATION THE PLAYER CAN SEE**
//    (Milestone 5.7). One call — `believedStation()` in core/vision.js —
//    decides, once per frame, and the four station sections read the answer
//    from `_rdoBelief()`. A visible station reads exactly as it always did; a
//    fogged one gets its name, its owner and its garrison AS REMEMBERED, marked
//    stale and dated, and no strength block at all; ground never seen gets one
//    sentence. The long argument for where that line falls — and in particular
//    why a remembered GARRISON is honest and a remembered DEFENCE is
//    known-issues #18 — is at "the fog gate", below _rdoFocusOn.
//
// ── THE SEAM: railAddSection(spec) ───────────────────────────────────────
//
// The rail is a STACK of sections, not one panel. Station detail is merely one
// of them. To add another later, call railAddSection() from your own file — do
// not append to `#rail` by hand and do not invent a second convention:
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
// Sections after this rewrite no longer carry `title` strings. That is a
// decision about THIS rail's content, not a change to the seam: four uppercase
// header rows in a 200px column were four rows that said nothing a labelled row
// underneath them did not already say. `title` still works for anyone who wants
// it.
//
// Driven from outside: render/select.js owns pointer handling on #board, so this
// file attaches NO board listener (01-data-schema.md, "Hover is shared"). Focus
// arrives via setReadoutFocus(). As a convenience, renderReadout falls back to
// the selection when no explicit focus is set — a read of selectedSources(),
// not a second pointer handler.
//
// renderReadout runs every frame and writes only the fields whose text actually
// changed; a quiet frame touches the DOM zero times. That is not an
// optimisation, it is a bug class: a pre-existing pair of functions writing the
// same cache key cost 2.007 DOM writes per frame on a PAUSED game. Every write
// in this file goes through _rdoSet / _rdoStyle / _rdoClass / _rdoShow, and
// every key has exactly ONE author.

'use strict';

// ── tuning of the panel itself ──────────────────────────────────────────

// Ticks per day, matching render/hud.js's day counter so "+2.4 /day" here and
// "Day 42" up there are the same unit of time.
var RDO_TICKS_PER_DAY = 10;

// Farms NAMED on the growth line before it collapses to a count. Two, because
// the line is one line: the map's coverage overlay is where the full picture
// lives (00-vision.md §8, "hold a farm and see the territories it's boosting
// light up") and duplicating it as four rows of text was the rail's single
// largest block of words.
var RDO_MAX_FARMS = 2;

// A neutral station's fill clock is only interesting once it is actually
// filling up; below this it reads as noise.
var RDO_NEUTRAL_WARN = 0.75;

// Hard stop on the fill-clock simulation. ~2500 ticks is the worst realistic
// case (a scoured rate-0.3 station), so this never binds in practice; it exists
// so a tuning change that stalls growth cannot hang the renderer.
var RDO_ETA_MAX_TICKS = 20000;

// Frames between fill-clock recomputes. Everything else on the panel is O(1) or
// O(board) on a tick throttle; this one walks a few thousand growth steps, so
// it runs at ~2Hz.
var RDO_ETA_EVERY = 30;

// Retired. The empire summary used to recompute on a FRAME throttle of its own;
// it is now the empire section's tick-throttled aggregate (RDO_HEADER_EVERY_TICKS
// and _rdoHeaderStats), because two caches of the same fact drift apart and get
// printed side by side. Kept as a named constant only so a console habit or an
// old bookmark does not throw.
var RDO_EMPIRE_EVERY = 6;

// Order slots. Ascending, and the gaps are the point: a later section can land
// between any two of these without renumbering anything.
//
//   5   empire    always on screen, nothing selected
//    2  selection what is selected and what the next click will do to it
//   10  station   what you asked for by hovering
//   11  supply    an alarm, and it invalidates half of the station block
//   12  fight     what decides an assault, both directions
//   13  orders    standing supply lines
//   14  build     what may be built here, and what it is running at
var RDO_SELECTION_ORDER = 2;
var RDO_HEADER_ORDER = 5;
var RDO_SECTION_ORDER = 10;
var RDO_SUPPLY_ORDER = 11;
var RDO_FIGHT_ORDER = 12;
var RDO_ORDERS_ORDER = 13;
var RDO_BUILD_ORDER = 14;

// Consecutive throws before a section is retired, matching RENDER_FAIL_LIMIT in
// app/loop.js. A section that cannot survive three frames is broken, not
// unlucky, and the rest of the rail should outlive it.
var RDO_SECTION_FAIL_LIMIT = 3;

// Sim ticks between recomputes of the empire aggregate. 10 ticks is one day
// (BAL.TICKS_PER_SEC), which is the unit the growth figure is quoted in, so the
// number cannot visibly lag the thing it describes. Tick-throttled rather than
// frame-throttled so a PAUSED empire recomputes never and writes nothing.
var RDO_HEADER_EVERY_TICKS = 10;

// Growth is quoted per MINUTE for the empire and per DAY for one station. A
// single station makes fractions of a unit a day and reads as noise; a whole
// empire makes tens of units a minute, which is a number a player can hold in
// their head and compare against the cost of an attack.
var RDO_HEADER_PER_MIN = 60;

// Source lines shown under one row. Two is the worst real case now that each
// block collapses its working into a single sentence.
var RDO_MAX_SOURCES = 2;

// Destination lines the orders section will print under one city, INCLUDING the
// "+N more" line when it has to cut. Not RDO_MAX_SOURCES: those two are a
// WORKING (where a number came from) and can always be collapsed to a sentence,
// while these are N independent facts about N different routes and collapsing
// them is the bug this section was rewritten to fix.
//
// MEASURED AGAINST THE COLUMN, not guessed. .rail is 200px with 12px of padding
// each side and .rdo-src adds a 7px rule-and-indent, so a destination line has
// 169px; at .rdo-src's 9.5px that is ~34 characters before it wraps to a second
// row. "× Ankara — no owned route" is 25. Four lines is ~53px of a rail that
// measured 666px of empty column at the 800x900 window the game is played at
// (docs/design/05-command-clarity.md §3), so the cap is not fighting for space —
// it exists so that a player who has drawn twelve lines out of one city gets a
// readable four and a count, rather than a wall.
//
// WHAT IS CUT IS NEVER ARBITRARY, and it is never silent: see _rdoOrdersLines.
var RDO_ORDERS_MAX_LINES = 4;

// A value equal to 1.0 within this is the baseline, and the baseline is not a
// modifier. Floating-point slack rather than a design number.
var RDO_MOD_EPS = 0.005;

// ── icons ───────────────────────────────────────────────────────────────
//
// Lucide (https://lucide.dev), **ISC licence**, path data taken from
// lucide-static v1.27.0: `icons/shield.svg`, `icons/swords.svg`,
// `icons/timer.svg`, `icons/triangle-alert.svg`.
//
// Inlined rather than fetched because this project has no npm, no bundler, no
// CDN and no webfonts (README, "Rules of the codebase"), and four glyphs are
// not worth breaking that for. Four `d` strings is less code than the
// `<link>` tag that would have replaced them.
//
// TRANSCRIPTION, NOT REDRAW. `shield` ships as a single `<path>` and is copied
// character for character. `swords`, `timer` and `triangle-alert` ship as a mix
// of `<polyline>`, `<line>` and `<circle>`; each is written here as the
// equivalent `d` (a polyline is `M` then implicit linetos, a line is `M…L`, the
// circle `cx=12 cy=14 r=8` is two half arcs). The geometry is unchanged.
//
// `fill: none` and `stroke: currentColor` live in the STYLESHEET, not as
// presentation attributes on these elements. That is known-issues #15 answered
// before it can happen: a presentation attribute sits at the bottom of the
// cascade and any stray class rule silently outranks it. Nothing here is
// computed per frame anyway — these nodes are built once and never touched
// again — so the stylesheet is simply where static paint belongs.
var RDO_SVG_NS = 'http://www.w3.org/2000/svg';

var RDO_ICONS = {
  // lucide `shield` — the power a garrison holds this station with.
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',

  // lucide `swords` — the same troops' worth on the offensive.
  swords: 'M14.5 17.5L3 6L3 3L6 3L17.5 14.5 M13 19L19 13 M16 16L20 20 M19 21L21 19 ' +
          'M14.5 6.5L18 3L21 3L21 6L17.5 9.5 M5 14L9 18 M7 17L4 20 M3 19L5 21',

  // lucide `timer` — march time out of here, in days.
  timer: 'M10 2L14 2 M12 14L15 11 M20 14A8 8 0 1 1 4 14A8 8 0 1 1 20 14',

  // The three developments (04-development.md §5). Stroke-only silhouettes, sized
  // for 11px: at that size a detailed glyph is a smudge, so each is three or four
  // strokes and is meant to be recognised by OUTLINE rather than read.
  //
  // Type is carried by SHAPE, never by colour — colour is spent on ownership and
  // cannot be borrowed (00-vision.md §8). Same rule the map pips follow.
  fort: 'M3 21V10h3V7h3v3h3V7h3v3h3v11z M9 21v-5h6v5',
  port: 'M12 4.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M12 8.5V21 M7 12h10 M4 14a8 8 0 0 0 16 0',
  factory: 'M2 21V12l6 3v-3l6 3v-3l6 3v6z M6 12V4h3v8',

  // lucide `triangle-alert` — the one icon that means "something is wrong
  // here". Spent on cut-off pockets, sieges and stalled supply, and on nothing
  // else, because a column that warns about everything warns about nothing.
  alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3 M12 9v4 M12 17h.01',
};

// Built once per row, never per frame. aria-hidden because the icon is
// decoration on a row whose label element carries the real aria-label — a
// screen reader should hear "defending power, 81.6", not "image, image".
function _rdoIcon(name) {
  var svg = el('svg', 'rdo-ico rdo-ico-' + name, {
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.appendChild(el('path', null, { d: RDO_ICONS[name] || '' }));
  return svg;
}

// ── module state ────────────────────────────────────────────────────────
//
// `var` at top level so it is inspectable from the console, matching
// render/hud.js and core/state.js.

var _rdoFocus = null;        // sid the panel is pinned to, or null
var _rdoFrame = 0;
var _rdoEta = { sid: null, text: '' };

// key -> last string/flag written, so we can skip. Created ONCE, at load, and
// never replaced: it used to be reset wholesale inside the station section's
// build(), which meant the empire section (order 5, built first) had its cache
// wiped underneath it. That was harmless only because every build happens
// before every update in the same sync pass — i.e. it was correct by accident.
// Each build now forgets its OWN prefix instead, so section order is no longer
// load-bearing.
var _rdoLast = Object.create(null);

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

// Additive power, signed. The sign is the message: this is troops added to the
// defence, not a factor applied to it. See rule 2 in the file header.
function _rdoPlus(v) {
  if (!isFinite(v)) return '-';
  return (v >= 0 ? '+' : '−') + _rdoNum(Math.abs(v));
}

// A signed LEVEL, the unit sim/combat.js measures fortification in. Kept
// distinct from _rdoPlus so the working and the result cannot be confused for
// each other: one is levels, one is the power those levels buy.
function _rdoLvl(v) {
  if (!isFinite(v)) return '-';
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + ' lvl';
}

// Short unit tags, from BAL.UNIT_ORDER so a fourth unit type would appear here
// without an edit.
function _rdoUnitTag(t) { return String(t).slice(0, 3); }

// "40 inf · 12 art" — the SAME grammar the map's volley preview uses for a
// payload (00-vision.md §8), deliberately, so a stack reads identically wherever
// it appears. Zero-count types are omitted rather than printed as "0": three
// cells of which two are always zero was a row of noise on 78 of 108 stations.
function _rdoComp(units) {
  var out = [];
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    // Gated on what will actually PRINT, not on what exists. The sim's
    // annihilation epsilon is far below one decimal place, so a trace of 0.03
    // artillery used to render as the tag "0.0 art" — a unit type announced on
    // the strength of a rounding error.
    if (Math.round(units[t] * 10) / 10 <= 0) continue;
    out.push(_rdoNum(units[t]) + ' ' + _rdoUnitTag(t));
  }
  return out.join(' · ');
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

// Tier as a VALUE, not a sentence. The territory's name is the row's label, so
// "Germany … 8/9" reads as stations-held-here without the word "majority"
// having to be printed 108 times. `contested` keeps its word because it is not
// a count and because it means something specific: nobody holds a strict
// majority, which is not the same as "unowned" (core/state.js, three tiers).
// The row carries the long form as a title.
function _rdoTierLabel(ctl) {
  if (!ctl) return '';
  if (ctl.tier === 'full') return 'all ' + ctl.total;
  if (ctl.tier === 'majority') return ctl.held + '/' + ctl.total;
  return 'contested';
}

function _rdoTerrainKey(sid) {
  var d = STATIONS[sid];
  var t = (typeof TERRITORIES !== 'undefined' && d) ? TERRITORIES[d.territory] : null;
  return (t && t.terrain) ? t.terrain : 'plains';
}

// The heaviest type in a resolved mix, for naming who a matchup is against.
function _rdoTopType(mix) {
  if (!mix) return '';
  var best = '', bv = -1;
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    if (mix[t] > bv) { bv = mix[t]; best = t; }
  }
  return best;
}

// ── sim reads ───────────────────────────────────────────────────────────

// Where growth actually STOPS, as a multiple of capacity. Since the
// over-capacity rework (data/tuning.js, 2026-07 — "rather than making
// production stop when a city is full, just slow the production speed by 50%")
// capacity is where growth gets slow and GROWTH_OVERFLOW_CEIL x capacity is
// where it reaches zero and OVERSTACK_DECAY takes over.
//
// Read by INTENT with a fallback, the same way sim/movement.js _ordCeilingMul
// does, because this constant has already moved once. Every branch in this
// file that used to compare against `capacity` was reporting "over capacity —
// bleeding off" and a NEGATIVE growth number for the entire band the player
// asked for, where the station is in fact growing at half rate and bleeding
// nothing at all.
function _rdoOverflowCeil() {
  if (typeof BAL === 'undefined') return 1;
  if (isFinite(BAL.GROWTH_OVERFLOW_CEIL) && BAL.GROWTH_OVERFLOW_CEIL > 0) {
    return BAL.GROWTH_OVERFLOW_CEIL;
  }
  return 1;
}

// The fraction of capacity at which a city counts as FULL — the "is-full" bar,
// the "1 full" tally, and the last point an ETA can honestly aim at.
//
// With the overflow on this is capacity exactly: growth is a real rate right up
// to the line and crosses it in finite time. With GROWTH_OVERFLOW_RATE at 0 —
// the documented off switch — growth is the bare logistic again, which
// ASYMPTOTES at capacity and never arrives, so "full" has to mean
// GROWTH_CAP_EPSILON of it or none of these three ever fire again. Deriving it
// rather than typing 1 is what keeps the off switch an exact revert.
function _rdoFullAt() {
  if (typeof BAL === 'undefined') return 1;
  if (BAL.GROWTH_OVERFLOW_RATE > 0) return 1;
  return isFinite(BAL.GROWTH_CAP_EPSILON) ? BAL.GROWTH_CAP_EPSILON : 1;
}

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
  var total = totalUnits(units);
  try {
    _applyGrowth({ tick: state.tick }, sid, probe, d, total, extraMul);
  } catch (e) {
    return null;
  }
  return totalUnits(probe.units);
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
    var g = totalUnits(probe.units);
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
// copied. The product itself comes from state.stations[sid].growthMul.
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
// Built once. Every update() only ever rewrites text and toggles classes on
// these nodes — nothing here is torn down and rebuilt, because it is on screen
// at 60fps and rebuilding kills text selection and thrashes layout.

function _rdoRow(parent, cls, labelText) {
  var row = el('div', 'rdo-row ' + cls);
  var lab = el('span', 'rdo-k', { text: labelText || '' });
  var val = el('span', 'rdo-v');
  row.appendChild(lab);
  row.appendChild(val);
  parent.appendChild(row);
  return { row: row, k: lab, v: val };
}

// A row whose label LEADS with an icon. `labelText` is still passed for
// everything whose units or direction an icon cannot carry — "out" on the march
// row is the difference between leaving and arriving, and no clock face says
// which. `title` lands on the label element and doubles as its aria-label, so
// the icon is never the only explanation of the row.
function _rdoIcoRow(parent, cls, icon, labelText, title) {
  var rec = _rdoRow(parent, cls, '');
  rec.k.appendChild(_rdoIcon(icon));
  if (labelText) rec.k.appendChild(document.createTextNode(labelText));
  if (title) {
    rec.k.setAttribute('title', title);
    rec.k.setAttribute('aria-label', title);
  }
  return rec;
}

// An icon + number pair INSIDE a value cell, for the one row that carries two
// numbers in the same unit. Returns the node the number is written to.
function _rdoIcoVal(parent, icon, title) {
  var wrap = el('span', 'rdo-pair', { title: title, 'aria-label': title });
  wrap.appendChild(_rdoIcon(icon));
  var v = el('span', 'rdo-pair-v');
  wrap.appendChild(v);
  parent.appendChild(wrap);
  return v;
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

// Same skip-if-unchanged contract as _rdoSet, for an ATTRIBUTE rather than text.
// Needed because a 200px line has to put its full sentence somewhere, and that
// somewhere is `title` — which is written per frame and therefore has to go
// through the same cache as everything else in this file.
function _rdoAttr(node, key, name, value) {
  if (!node) return;
  var k = key + '@@' + name;
  if (_rdoLast[k] === value) return;
  _rdoLast[k] = value;
  if (value === null || value === undefined || value === '') node.removeAttribute(name);
  else node.setAttribute(name, value);
}

function _rdoClass(node, key, cls, on) {
  if (!node) return;
  var k = key + '#' + cls;
  if (_rdoLast[k] === on) return;
  _rdoLast[k] = on;
  node.classList.toggle(cls, !!on);
}

// Drop every remembered write whose key starts with `prefix`. Needed because
// _rdoLast outlives the nodes it remembers: a rebuilt node is blank, while the
// cache still holds the identical text from last time and skips the write as a
// no-op. Every build() calls this with its own prefix as its first statement.
function _rdoForget(prefix) {
  var keys = Object.keys(_rdoLast);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(prefix) === 0) delete _rdoLast[keys[i]];
  }
}

// A group of source lines hanging off one row. Pool discipline: it GROWS, never
// shrinks, and surplus rows are hidden rather than removed — see _rdoForget for
// why destroying a cached node is a bug rather than a tidy-up.
//
// Hiding a ROW must also hide the lines hanging off it, and that is easy to
// forget because the two live in different nodes. It was forgotten once and the
// symptom was the worst kind: Bordeaux, which has no fortification at all,
// showed "urban · Germany → +0.60 lvl" underneath a hidden fortification row —
// a stale source line attached to nothing, indistinguishable from a real
// reading. So every caller passes a list, and a hidden row passes an empty one.
function _rdoSrcGroup(parent) {
  var host = el('div', 'rdo-srcs');
  parent.appendChild(host);
  return { host: host, pool: [] };
}

function _rdoSources(g, key, lines) {
  if (!lines) lines = [];
  var want = lines.length < RDO_MAX_SOURCES ? lines.length : RDO_MAX_SOURCES;
  while (g.pool.length < want) {
    var r = el('div', 'rdo-src');
    g.host.appendChild(r);
    g.pool.push(r);
  }
  for (var i = 0; i < g.pool.length; i++) {
    var on = i < want;
    _rdoStyle(g.pool[i], key + '@' + i, 'display', on ? '' : 'none');
    if (on) _rdoSet(g.pool[i], key + '~' + i, lines[i]);
  }
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

  _rdoFrame++;
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

// The pinned entry point. Unknown ids are ignored rather than throwing — this is
// called from a pointer handler in another file.
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

// The four station sections all begin the same way and all hide themselves the
// same way. One helper, so "is there a station to talk about" cannot be answered
// four subtly different ways.
function _rdoFocusOn(state) {
  var sid = _rdoResolve();
  if (!sid || !state || !state.stations || !state.stations[sid] || !STATIONS[sid]) return null;
  return sid;
}

// ── the fog gate ────────────────────────────────────────────────────────
//
// **This panel is the highest-leverage leak on the board.** Every other surface
// shows a fogged city as a shape or a colour; this one showed its exact
// defending power, its exact garrison, its composition and its march times, one
// hover away, for any of the 108 stations. A player who could not see Brussels
// could still read what it would cost to take it.
//
// ONE CALL DECIDES, AND IT IS NOT THIS FILE'S CALL.
//
//   believedStation(state, pid, sid) -> { owner, units, connected, tick, level }
//
// core/vision.js composes live sight with `state.seen` and is the only function
// in the project that can mint a level 1. Nothing here re-derives it, reads
// `state.seen`, or asks `visibleTo` a second question — that would be two
// authorities for one fact, which is how known-issues #9 and #18 both happened.
//
// THE THREE LEVELS, AND WHAT EACH IS ALLOWED TO PRINT
// (02-visibility-and-sea.md §1, the three-level table):
//
//   2  visible   everything, live, exactly as before this change.
//   1  fogged    name, type, territory, and the owner and garrison AS OF the
//                tick this power last looked — marked stale, with an age.
//                **NO STRENGTH BLOCK.** See below; it is the whole point.
//   0  hidden    the idle body. Not the station's name, not its type, not its
//                capacity: "territory shape only, no node, no number".
//
// WHY LEVEL 1 PRINTS A REMEMBERED GARRISON BUT NEVER A REMEMBERED DEFENCE.
//
// They look like the same concession and they are not. A remembered garrison is
// a claim about the PAST and is labelled as one: "last seen … 41 days ago" is
// true whatever has happened since, and the design asks for it by name
// ("garrison shown stale and marked stale") because the skill fog creates is
// deciding whether last minute's number is still true.
//
// A defending power is a claim about NOW. `stationPower()` folds the live
// garrison together with fortification scale-in, the artillery strip and the
// matchup against whoever is currently standing there — three of its four
// inputs are facts about this instant that no memory contains. Printing it from
// a remembered garrison would produce known-issues #18 in its purest form: a
// number that is plausible, stable, recomputed every frame, and answering a
// different question from the one on screen. There is no way to label it
// honestly, because the label would have to say "this is what it WOULD hold
// with troops it may no longer have, against attackers it has never met".
//
// So the fight section is live-only and hides itself, and so do supply and
// orders — both of which read live per-tick clocks (`discSince`, the sweep
// planner) that memory cannot age. Hiding a section costs the player nothing
// they are entitled to; a fogged city they have to march on to price is the
// feature.
//
// COST. `believedStation` without a visibility map costs one `visibleTo`, which
// is 24-38us — the sanctioned once-per-frame budget (core/vision.js). It is
// asked about exactly ONE station, the hovered one, and the answer is memoised
// for the frame so that all four sections share the single call rather than
// making four.

var _rdoBel = { frame: -1, sid: null, data: null };

// The fallback belief: everything, live. Used when there is no fog to apply —
// core/vision.js absent, or `window.PLAYER` unset (tests.html, the empire
// picker, a console session). Degrading to the TRUE board rather than to a
// blank one is the right direction for a *renderer*: the failure mode here is
// a build that shows what it always showed, and the failure mode of the other
// choice is a rail that silently goes empty and reads as broken.
function _rdoLiveBelief(state, sid) {
  var st = state.stations[sid];
  return {
    owner: st.owner,
    units: st.units,
    connected: st.connected !== false,
    tick: state.tick,
    level: 2,
  };
}

// One belief per station per frame, shared by all four sections. `_rdoFrame` is
// bumped once per pump by _rdoRailPump, so the key is exact rather than
// approximate.
function _rdoBelief(state, sid) {
  if (_rdoBel.frame === _rdoFrame && _rdoBel.sid === sid && _rdoBel.data) {
    return _rdoBel.data;
  }
  var pid = window.PLAYER || null;
  var b = (pid && typeof believedStation === 'function')
    ? believedStation(state, pid, sid)
    : _rdoLiveBelief(state, sid);
  _rdoBel = { frame: _rdoFrame, sid: sid, data: b };
  return b;
}

// "41 days ago". Quoted in DAYS, the same unit the top bar's counter uses
// (render/hud.js: one sim-second is one day, day 0 is 28 June 1914), so "last
// seen 41 days ago" and "Day 63" are readings off one clock. A staleness age in
// ticks would be a second unit of time on screen for no reader's benefit.
function _rdoAgo(ticks) {
  if (!isFinite(ticks) || ticks < 0) return 'moments ago';
  var days = Math.floor(ticks / _rdoTicksPerDay());
  if (days <= 0) return 'less than a day ago';
  return days + ' day' + (days === 1 ? '' : 's') + ' ago';
}

// Opacity for the two rows that are MEMORY rather than reading. It is a second,
// wordless signal beside the "last seen" label and the age line, because a
// number is the thing that gets misread and one marker three rows away is one
// marker too far. Inline rather than a class: style.css belongs to another
// agent this milestone. 0.65 of --ink-dim lands about on --ink-faint, which the
// panel already uses for legible secondary text.
var RDO_STALE_OPACITY = '0.65';

// ════════════════════════════════════════════════════════════════════════
// EMPIRE — always on screen, nothing selected
// ════════════════════════════════════════════════════════════════════════
//
// Every other section answers a question the player asked by pointing at a
// station. A player running several attacks at once is not pointing at anything
// — they are watching the board — so this one sorts first and is never hidden.
// It is also what stops the rail being an empty gutter, which is why the old
// station section's "idle body" is gone: two blocks were competing to be the
// thing on screen when nothing was hovered, and they printed the same numbers
// six inches apart.
//
// FOUR ROWS, and the shape of each is an argument.
//
// 1. IDENTITY — swatch and name. The swatch is the colour key for the whole
//    board; it costs one row and it is the only place the player's colour is
//    stated rather than implied.
//
// 2. GROWTH — one number, because growth genuinely sums. Units per minute is
//    the sim's own _applyGrowth run on scratch paper for every station held,
//    branch-for-branch with growthTick(): contested recruits nothing, a cut-off
//    station grows at DISCONNECT_GROWTH, a full one has stopped paying.
//
// 3. FORCE — held against total capacity, with the bar. The bar is the headroom
//    and headroom is the other half of the logistic: it is why a large empire's
//    growth number collapses, and there is nothing else on screen that says so.
//
// 4. COMPOSITION — infantry / artillery / armour, zero types omitted. It is
//    tempting to blend them into a single "strength" and it would be wrong in
//    both directions at once: BAL.UNITS gives infantry 1.0/1.2, artillery
//    1.8/0.6 and armour 1.5/0.9, so the same stack is a different size
//    attacking than defending; the matchup triangle makes it a different size
//    again depending on who it meets, and the additive fortress block makes it
//    a different size again depending on where.
//
// Two more rows appear only when they have something to say: an ALERT line for
// pockets and sieges, and a SUPPLY line while any city is streaming.
//
// DELIBERATELY ABSENT.
//
//   territory count        the HUD counts it, four inches up and larger.
//   full vs majority       the MAP draws the three tiers differently (§3):
//                          solid tint, lighter wash, hatched. A number was the
//                          second copy of a thing already rendered.
//   farms in reach         the coverage overlay is the farm display (§8).
//   any march or speed     speed is a property of a ROUTE, not of an empire —
//                          artillery 0.6 against armour 1.8, a wave moving at
//                          its slowest type, terrain on the territory entered
//                          and SEA_SPEED_MUL on top. An average would be a lie,
//                          and worse, it would hide the spread in arrival times
//                          that makes defeat in detail readable.
//
// COST: the aggregate walks every station held, so it is throttled on SIM TICKS
// rather than on frames — a paused empire recomputes never and writes nothing.

var _rdoHead = { tick: -1e9, pid: null, data: null };

// One pass over the player's stations. Read-only throughout: the growth probe
// runs against a throwaway object inside _rdoGrowthPerTick, and nothing here
// touches a station.
//
// The branch order below MIRRORS growthTick() — contested → cut off → over
// capacity → at cap → growing. That is control flow, not arithmetic; every
// number still comes from the sim.
//
// ── FOG: THIS AGGREGATE IS OWN-ONLY, AND IT IS CHECKED RATHER THAN ASSUMED ──
//
// Every input is scoped to `pid`: powerStations(state, pid) supplies the ids,
// the transit loop tests `waves[w].owner === pid`, and standingOrderPlan takes
// pid. So the empire header needs no fog gate — a power always sees its own
// cities, and level 2 is exactly what visibleTo() returns for ground you hold.
//
// But that is a property of a function in ANOTHER FILE, and "it only returns
// mine" is precisely the kind of claim that is true on the afternoon it is
// written. So the loop asserts it. The `continue` is not a filter — if it ever
// fires, this panel has been summing somebody else's army into the player's
// growth number, and the console says so once rather than never.
var _rdoHeadLeaked = false;

function _rdoHeaderStats(state, pid) {
  if (_rdoHead.data && _rdoHead.pid === pid &&
      (state.tick - _rdoHead.tick) < RDO_HEADER_EVERY_TICKS) {
    return _rdoHead.data;
  }

  var ids = (typeof powerStations === 'function') ? powerStations(state, pid) : [];
  var e = {
    // A REAL unit bundle, not three loose accumulators. The per-type split is
    // load-bearing — the composition line ("42 inf · 9 art") is the only place
    // in the panel that distinguishes the types, so it cannot be collapsed to a
    // scalar ahead of the sim. But it does not follow that this file should
    // spell the bundle out: as `inf/art/arm` the accumulation and its total
    // were a fourth hand-rolled copy of core/state.js, and the day the bundle
    // changes shape they would go on adding up three properties that no longer
    // exist. Held as a bundle, addUnits()/totalUnits() carry it, and _rdoComp
    // becomes the single site that has to answer what a composition means.
    n: ids.length, units: emptyUnits(), transit: 0, cap: 0,
    perTick: 0, cut: 0, contested: 0, atCap: 0,
    // Standing supply. Counted on THIS walk rather than on one of their own:
    // the aggregate already visits every station this power holds, on a tick
    // throttle, and a second per-frame sweep for three integers would be the
    // exact mistake the old idle body made (two caches of one fact, printed
    // side by side, disagreeing).
    //
    // supSend is what LEAVES, not what the sources are willing to part with —
    // known-issues #18. supBlocked/supWhy/supWhyAt carry the explanation the
    // number on its own cannot: a zero with no reason is the same failure in a
    // smaller font.
    //
    // supStuck is counted PER EDGE, not per city, and it is the reason the
    // header quotes when there is one. A city's edges disagree in the normal
    // case: `nx.blocked` is `edges[0].blocked` — the first destination in sorted
    // id order — so a city with two full destinations and one unreachable one
    // used to report "no route over ground you hold" for all three, and a city
    // shipping down two lines while a third was dead reported nothing wrong at
    // all, because `nx.units > 0` cleared it. Both are known-issues #18.
    supN: 0, supSend: 0, supBlocked: 0, supWhy: null, supWhyAt: null,
    supEdges: 0, supStuck: 0, supStuckWhy: null, supStuckAt: null,
  };

  // ONE plan for the whole power, not one per supplying city. standingOrderNext()
  // plans the entire sweep to answer about a single station, so a per-station
  // loop would repeat an ~80us search once per source — and worse the more the
  // player automates. standingOrderPlan is the same planner, asked once.
  var oplan = (typeof standingOrderPlan === 'function') ? standingOrderPlan(state, pid) : {};

  for (var i = 0; i < ids.length; i++) {
    var sid = ids[i];
    var st = state.stations[sid];
    // The own-only ASSERTION. See the note above the function.
    if (!st || st.owner !== pid) {
      if (!_rdoHeadLeaked) {
        _rdoHeadLeaked = true;
        console.error('[render/readout] empire aggregate was handed ' + sid +
          ', which ' + pid + ' does not own — powerStations() is no longer own-only ' +
          'and this panel has been reporting a fogged army as the player\'s');
      }
      continue;
    }
    var d = STATIONS[sid];
    var u = st.units;
    addUnits(e.units, u);
    e.cap += d.capacity || 0;

    // Counted BEFORE the growth branches below, every one of which `continue`s.
    // A contested or cut-off station still carries its supply lines — that is
    // the point of a line surviving everything but a capture — so counting it
    // after the branches would undercount exactly the cities whose logistics
    // the player most needs to know about.
    var nx = oplan[sid];
    if (nx) {
      e.supN++;
      e.supSend += nx.units;
      if (nx.units <= 0) {
        e.supBlocked++;
        // The FIRST blocked source in sorted station order, so the summary line
        // is deterministic rather than "whichever the walk saw last".
        if (!e.supWhy) { e.supWhy = nx.blocked; e.supWhyAt = nx.target; }
      }
      // Per EDGE, and independent of whether the source ships anything at all.
      var nxe = nx.edges || [];
      for (var ei = 0; ei < nxe.length; ei++) {
        e.supEdges++;
        if (_rdoOrdersEdgeState(nxe[ei]) !== 'stuck') continue;
        e.supStuck++;
        if (!e.supStuckWhy) {
          e.supStuckWhy = nxe[ei].blocked;
          e.supStuckAt = nxe[ei].target;
        }
      }
    }

    var total = totalUnits(u);
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
    // Past the HARD ceiling: bleeding off, not growing. `capacity` was the
    // line here until the over-capacity rework, which meant every full city —
    // the ones the change exists to keep productive — was dropped out of the
    // empire's growth sum entirely and the header under-reported the very
    // number the change was supposed to raise.
    if (total > d.capacity * _rdoOverflowCeil()) continue;
    // Still growing, at somewhere between full rate and GROWTH_OVERFLOW_RATE of
    // this station's own peak. `atCap` is now a COUNT for the composition line
    // ("3 full"), not a reason to skip the station: _rdoGrowthPerTick runs the
    // sim's own _applyGrowth, and _growthRoom already knows what a full city
    // produces.
    if (total >= d.capacity * _rdoFullAt()) e.atCap++;
    e.perTick += _rdoGrowthPerTick(state, sid, u, 1) || 0;
  }

  var waves = state.waves || [];
  for (var w = 0; w < waves.length; w++) {
    if (waves[w].owner === pid) e.transit += totalUnits(waves[w].units);
  }

  e.held = totalUnits(e.units);
  _rdoHead = { tick: state.tick, pid: pid, data: e };
  return e;
}

function _rdoHeaderBuild(host) {
  _rdoForget('hdr');
  var n = {};

  // Swatch-then-name, the .rdo-sub grammar the station body also uses for
  // ownership, so the player's colour means the same thing everywhere.
  var head = el('div', 'rdo-sub rdo-empire-head');
  n.swatch = el('span', 'rdo-swatch');
  n.name = el('span', 'rdo-name');
  head.appendChild(n.swatch);
  head.appendChild(n.name);
  host.appendChild(head);

  n.growth = _rdoRow(host, 'rdo-mod', 'growth');
  n.force = _rdoRow(host, 'rdo-mod', 'force');
  var bar = el('div', 'rdo-bar');
  n.barFill = el('div', 'rdo-bar-fill');
  bar.appendChild(n.barFill);
  host.appendChild(bar);
  n.comp = el('div', 'rdo-src rdo-comp');
  host.appendChild(n.comp);

  // Both conditional rows sit at the BOTTOM, and that is deliberate: a line
  // that appears and disappears at the end of a section costs nothing to read
  // past, while one inserted in the middle shifts everything under it every
  // time the player's last pocket is relieved.
  n.alert = _rdoIcoRow(host, 'rdo-mod is-cut', 'alert', '',
    'stations that are not growing and need you');
  n.supply = _rdoRow(host, 'rdo-mod', 'supply');
  n.supplySrc = _rdoSrcGroup(host);

  // The only instructional text in the whole interface, and it earns that by
  // being the answer to the question an otherwise-idle column raises. Shown at
  // EVERY width: an earlier change hid a hint below 1000px and the player, whose
  // window is 800px, therefore never saw it once.
  n.hint = el('div', 'rdo-hint', { text: 'Hover a city for its garrison, defence and march.' });
  host.appendChild(n.hint);
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

  var fill = e.cap > 0 ? e.held / e.cap : 0;
  _rdoSet(n.force.v, 'hdrforce', _rdoNum(e.held) + ' / ' + Math.round(e.cap));
  // The clamp is what keeps a 1.4x empire inside its track rather than drawing
  // a 140%-wide fill over the rail; the text beside it still reads the true
  // "312 / 224", which is where the overflow is legible.
  _rdoStyle(n.barFill, 'hdrbar', 'width', _rdoPct(Math.min(1, fill)));
  // Same meaning as on a single station: full means growth has HALVED (§2). Not
  // GROWTH_CAP_EPSILON — sim/growth.js stopped reading that constant in the
  // over-capacity rework, and a readout keyed to a threshold nothing enforces
  // is the drift known-issues #9 is about.
  _rdoClass(n.barFill, 'hdrbar', 'is-full', fill >= _rdoFullAt());

  var comp = _rdoComp(e.units);
  if (e.transit > 0) comp += (comp ? '  ·  ' : '') + _rdoNum(e.transit) + ' moving';
  if (e.atCap > 0) comp += (comp ? '  ·  ' : '') + e.atCap + ' full';
  _rdoSet(n.comp, 'hdrcomp', comp);

  // The alert row is spent on the two states nothing else on screen reports and
  // that stop growth dead. "At capacity" is deliberately NOT here — it is an
  // opportunity, not an emergency, and it rides on the composition line above.
  var bad = [];
  if (e.cut > 0) bad.push(e.cut + ' cut off');
  if (e.contested > 0) bad.push(e.contested + ' under attack');
  _rdoShow(n.alert, 'hdralert', bad.length > 0);
  if (bad.length) _rdoSet(n.alert.v, 'hdralertv', bad.join('  ·  '));

  // ONE line, on the aggregate's existing tick throttle — no second walk.
  // `supSend` is what actually leaves; see known-issues #18 and the note in
  // _rdoHeaderStats.
  var anySupply = e.supN > 0;
  _rdoShow(n.supply, 'hdrsupply', anySupply);
  var src = [];
  if (anySupply) {
    var ships = e.supSend > 0;
    // DEFECT 2. "nothing leaves" is a statement about the whole empire and it
    // may only be printed when the whole empire really ships nothing. It is
    // keyed to supSend — the SUM over every edge — so a single shipping edge
    // anywhere puts a number here instead. Asserted, because "it is a sum so it
    // cannot be wrong" is exactly the reasoning that produced this bug one level
    // down, where `nx.blocked` was likewise "just the summary".
    _rdoSet(n.supply.v, 'hdrsupplyv',
      ships ? _rdoNum(e.supSend) + ' / sweep' : 'nothing leaves');
    // The alarm belongs to the STUCK EDGES, not to the total. A power shipping
    // 40 units a sweep with one corridor cut is a power that has to do
    // something, and `!ships` could never say so.
    _rdoClass(n.supply.row, 'hdrsupplyrow', 'is-stalled', e.supStuck > 0);
    src.push(e.supN + ' cit' + (e.supN > 1 ? 'ies' : 'y') + ' supplying, one sweep every ' +
      BAL.ORDERS.INTERVAL + ' ticks');
    // THE LINE THAT NEEDS THE PLAYER GOES FIRST AND IS COUNTED IN LINES. It used
    // to be counted in CITIES and reasoned from `nx.blocked`, which is the first
    // edge in alphabetical order — so Berlin, with Hamburg and Leipzig merely
    // full and Ankara unreachable, read "1 of them send nothing — no route over
    // ground you hold", which is Ankara's reason printed over all three.
    if (e.supStuck > 0) {
      src.push(e.supStuck + ' line' + (e.supStuck > 1 ? 's need' : ' needs') + ' you — ' +
        _rdoOrdersWhyShort(e.supStuckWhy, e.supStuckAt));
    }
    // The self-recovering half, and it says so. Only printed when it is not
    // already covered by the line above.
    if (e.supBlocked > 0 && e.supStuck === 0) {
      src.push(e.supBlocked + ' of them send nothing for now — ' +
        _rdoOrdersWhyShort(e.supWhy, e.supWhyAt));
    }
  }
  // The row and its source lines are hidden together, ALWAYS. Forgetting that
  // once left a stale source line hanging under a hidden row, indistinguishable
  // from a live reading — see the comment on _rdoSources.
  _rdoSources(n.supplySrc, 'hdrsupplysrc', src);

  // The hint answers "what is this column for", so it is only up while the
  // column is not busy answering something else.
  _rdoStyle(n.hint, 'hdrhint', 'display', _rdoResolve() ? 'none' : '');
  return true;
}

// ════════════════════════════════════════════════════════════════════════
// STATION — what you asked for by hovering
// ════════════════════════════════════════════════════════════════════════
//
// 00-vision.md §8: "Click a station for a small readout: type, garrison by unit
// type, capacity, growth rate and what's modifying it."
//
// The last clause is the feature, and it is also where this block used to spend
// nine rows. Growth on this board is a product of four separate things — where
// the station sits on its logistic curve, how many farms reach it, the control
// tier of the countries those farms are in, and whether it is cut off — and a
// bare number tells you none of that.
//
// But it does not follow that all four deserve a row. Two of them are already
// drawn:
//
//   the logistic term      IS the capacity bar. `×0.10  90% full` was that bar
//                          spelled out in words directly underneath itself.
//   the base rate          is the station's type, which is the badge on the
//                          first row and the node's silhouette on the map (§8,
//                          "node shape encodes type"). It is a constant.
//
// So the breakdown that survives is the one that MOVES: farm reach, which
// changes when a farm is taken, when its country flips tier, and when it comes
// under siege — and each of those is a thing the player can act on. It is one
// row plus one sentence naming the strongest farms and flagging any that have
// stopped feeding.
//
// The status line is likewise conditional. Growing normally is not news; the
// number says so with a plus sign. Under attack, cut off, at capacity and over
// capacity are news, and each of them means growth is not what the number above
// would otherwise imply.

function _rdoStationBuild(host) {
  _rdoForget('sta');
  // The id and class the old floating panel had. Nothing in JS needs them any
  // more, but `byId('station-readout')` is a console habit and the base
  // .station-readout rule in style.css still carries the panel's colours.
  host.id = 'station-readout';
  host.classList.add('station-readout');
  var n = {};

  var head = el('div', 'rdo-head');
  n.name = el('span', 'rdo-name');
  n.type = el('span', 'rdo-type');
  head.appendChild(n.name);
  head.appendChild(n.type);
  host.appendChild(head);

  // `n.sub` is kept because the OWNER row is one of the three things a fogged
  // station reports from memory, so it has to be dimmable and hideable — at
  // level 0 there is no owner to name at all.
  n.sub = el('div', 'rdo-sub');
  n.swatch = el('span', 'rdo-swatch');
  n.owner = el('span', 'rdo-owner');
  n.sub.appendChild(n.swatch);
  n.sub.appendChild(n.owner);
  host.appendChild(n.sub);

  // Territory + control tier. Invisible everywhere else in text, and a
  // partly-held country pays reduced benefits (00-vision.md §3). The territory
  // NAME is the label and the tier is the value, so the row costs no words of
  // its own.
  n.terr = _rdoRow(host, 'rdo-terr', '');
  n.terr.row.setAttribute('title', 'stations held here, and what that tier pays');

  // Garrison. Never collapsed to a total on its own: the soft triangle in
  // 00-vision.md §4 is entirely about composition, so a panel that hides it is
  // hiding the decision. The composition rides under the bar as one line rather
  // than as three fixed cells of which two are usually "0".
  n.garr = _rdoRow(host, 'rdo-garr', 'garrison');
  // `n.bar` (the track, not just the fill) is kept for the same reason: a
  // capacity bar is an UNMARKED picture of a fill level, and there is no honest
  // way to draw a remembered one — so the fogged body hides it and prints the
  // remembered number in words instead.
  n.bar = el('div', 'rdo-bar');
  n.barFill = el('div', 'rdo-bar-fill');
  n.bar.appendChild(n.barFill);
  host.appendChild(n.bar);
  n.comp = el('div', 'rdo-src rdo-comp');
  host.appendChild(n.comp);

  n.growth = _rdoRow(host, 'rdo-mod', 'growth');
  n.status = el('div', 'rdo-status');
  host.appendChild(n.status);

  // The one modifier that moves. Hidden at ×1.00 — the baseline is not a
  // modifier, and 101 of 108 stations sit at it for most of a game.
  n.mul = _rdoRow(host, 'rdo-mod', 'farms');
  n.mulSrc = _rdoSrcGroup(host);

  n.note = el('div', 'rdo-note');
  host.appendChild(n.note);
  return n;
}

// The type badge. Everything static about the station that is not its name:
// what it is, what it makes, and how much it multiplies. The DEFENSE rating is
// NOT here — it moved into the fight section's fortification row, where it is
// quoted in `lvl` alongside the terrain that adds to it and the flat power the
// two of them together are worth. One vocabulary for one quantity, in one
// place; see rule 2 in the file header.
function _rdoTypeBadge(d) {
  var t = _rdoTypeLabel(d);
  if (d.type === 'producer' && d.produces) return t + ' · ' + _rdoUnitTag(d.produces);
  if (d.type === 'multiplier' && d.multiplier) return t + ' ×' + d.multiplier;
  return t;
}

// WHICH ROWS EXIST AT WHICH LEVEL — one author, three modes.
//
// Every row this block can draw is switched here and nowhere else. That is not
// tidiness: this file has already shipped the bug where a row was hidden and
// the source lines hanging off it were not, leaving "urban · Germany → +0.60
// lvl" attached to nothing and indistinguishable from a real reading (see
// _rdoSources). Under fog the same slip is worse by a category — a live number
// left standing under a fogged header is not a stale line, it is intelligence
// the player has not earned.
function _rdoStationChrome(n, level) {
  // The owner has a name only once somebody has seen who holds it.
  _rdoStyle(n.sub, 'stasub', 'display', level === 0 ? 'none' : '');
  // The TERRITORY survives every level: 02-visibility-and-sea.md's hidden tier
  // is "territory shape only", and the shape is drawn on the map with its name.
  // Its control TIER does not survive — that is a count of who holds cities you
  // cannot see — so the value cell is written empty below level 2.
  _rdoShow(n.garr, 'stagarr', level > 0);
  _rdoStyle(n.bar, 'stabarwrap', 'display', level === 2 ? '' : 'none');
  _rdoShow(n.growth, 'stagrowth', level === 2);
  if (level !== 2) {
    _rdoShow(n.mul, 'stamul', false);
    _rdoSources(n.mulSrc, 'stamulsrc', []);
  }
  // Memory, marked wordlessly as well as in words.
  var dim = level === 1 ? RDO_STALE_OPACITY : '';
  _rdoStyle(n.sub, 'stasub', 'opacity', dim);
  _rdoStyle(n.garr.row, 'stagarrrow', 'opacity', dim);
  _rdoStyle(n.comp, 'stacomp', 'opacity', dim);
}

// ── LEVEL 0 — the idle body ─────────────────────────────────────────────
//
// Never seen. The design's own words for this tier are "territory shape only.
// No node, no number." So this body names NOTHING the player has not been
// shown: not the city's name, not its type, not its capacity — a capacity is a
// number, and a station's name on a rail is a claim that there is a station
// there.
//
// It is a body rather than a hidden section on purpose. The rail is driven by
// hover; a column that simply vanishes when the cursor crosses unexplored
// ground reads as the panel breaking, and the player never learns that the
// blankness IS the reading. One sentence is cheaper than that confusion.
function _rdoStationIdle(state, n, sid) {
  _rdoStationChrome(n, 0);
  _rdoSet(n.name, 'staname', 'Unknown ground');
  _rdoSet(n.type, 'statype', '');
  _rdoSet(n.owner, 'staowner', '');
  _rdoStyle(n.swatch, 'staswatch', 'background', 'var(--neutral-node)');
  _rdoSet(n.terr.k, 'staterr', _rdoTerritoryName(STATIONS[sid].territory));
  _rdoSet(n.terr.v, 'statier', '');
  _rdoClass(n.terr.v, 'statier', 'is-contested', false);
  _rdoClass(n.terr.v, 'statier', 'is-partial', false);
  _rdoSet(n.garr.k, 'stagarrk', 'garrison');
  _rdoSet(n.comp, 'stacomp', '');
  _rdoSet(n.status, 'stastatus', 'never seen — nothing is known here');
  _rdoClass(n.status, 'stastatus', 'is-bad', false);
  _rdoSet(n.note, 'stanote', '');
  return true;
}

// ── LEVEL 1 — fogged ────────────────────────────────────────────────────
//
// Seen once, not seen now. Reads:
//
//     Brussels                          city
//     ● French Republic
//     Belgium
//     last seen                   14.2 units
//     8.0 inf · 6.2 art
//     41 days ago — may have changed
//
// Three markers on one fact, which is not redundancy — it is the number, the
// label and the age, and each answers a different question. "last seen" says
// the value is memory; "14.2 units" is the memory; "41 days ago" is the only
// thing that lets a player decide whether to believe it, and it is the whole
// skill the fog exists to create (02-visibility-and-sea.md §1: "decide whether
// last minute's number is still true").
//
// WHAT IS NOT HERE, and each absence is the point:
//
//   defence / attack power   live. Three of stationPower's four inputs are
//                            facts about this instant. See the fog gate note.
//   fortification            live: it scales in with the garrison manning it
//                            and is stripped by artillery standing there now.
//   growth per day           live, and it is a rate rather than a quantity —
//                            a remembered rate is not stale, it is fiction.
//   the capacity bar         a picture with no room on it for the word "stale".
//   farm multiplier          reads state.stations[…].growthMul across the board.
//   the neutral fill clock   steps the sim forward from the LIVE garrison.
//   the control tier         counts who holds cities the player cannot see.
function _rdoStationFogged(state, n, sid, b) {
  _rdoStationChrome(n, 1);
  var d = STATIONS[sid];

  _rdoSet(n.name, 'staname', d.name);
  _rdoSet(n.type, 'statype', _rdoTypeBadge(d));

  _rdoSet(n.owner, 'staowner', _rdoPowerName(b.owner));
  _rdoStyle(n.swatch, 'staswatch', 'background',
    _rdoPowerColor(b.owner) || 'var(--neutral-node)');

  // Name only. The tier is a live count over stations the player cannot see.
  _rdoSet(n.terr.k, 'staterr', _rdoTerritoryName(d.territory));
  _rdoSet(n.terr.v, 'statier', '');
  _rdoClass(n.terr.v, 'statier', 'is-contested', false);
  _rdoClass(n.terr.v, 'statier', 'is-partial', false);

  // "14.2 units", never "14.2 / 26". The ratio is half live-looking — the
  // denominator is real and current, so the pair reads as a measurement rather
  // than as a recollection, and the capacity is not the question anyway.
  var u = b.units || { infantry: 0, artillery: 0, armour: 0 };
  _rdoSet(n.garr.k, 'stagarrk', 'last seen');
  _rdoSet(n.garr.v, 'stagarr', _rdoNum(totalUnits(u)) + ' units');
  _rdoSet(n.comp, 'stacomp', _rdoComp(u));

  // The age carries the warning colour, because "may have changed" is the
  // actionable half of the sentence and the number above it is the bait.
  _rdoSet(n.status, 'stastatus', _rdoAgo(state.tick - b.tick) + ' — may have changed');
  _rdoClass(n.status, 'stastatus', 'is-bad', true);
  _rdoSet(n.note, 'stanote', '');
  return true;
}

function _rdoStationUpdate(state, n) {
  var sid = _rdoFocusOn(state);
  // Hiding rather than swapping to an idle body: the empire section above is
  // always on screen, so the rail is never the empty gutter this block used to
  // exist to prevent.
  if (!sid) return false;

  // THE GATE. Everything below this line is the level-2 body, unchanged from
  // before fog landed — a station you can see reads exactly as it always did.
  var bel = _rdoBelief(state, sid);
  if (bel.level === 0) return _rdoStationIdle(state, n, sid);
  if (bel.level === 1) return _rdoStationFogged(state, n, sid, bel);
  _rdoStationChrome(n, 2);
  _rdoSet(n.garr.k, 'stagarrk', 'garrison');

  var d = STATIONS[sid];
  var st = state.stations[sid];
  var units = st.units;
  var total = totalUnits(units);
  var cap = d.capacity;
  var fill = cap > 0 ? total / cap : 0;

  // ── identity ──
  _rdoSet(n.name, 'staname', d.name);
  _rdoSet(n.type, 'statype', _rdoTypeBadge(d));

  var owner = st.owner;
  _rdoSet(n.owner, 'staowner', _rdoPowerName(owner));
  _rdoStyle(n.swatch, 'staswatch', 'background', _rdoPowerColor(owner) || 'var(--neutral-node)');

  var ctl = territoryControl(state, d.territory);
  _rdoSet(n.terr.k, 'staterr', _rdoTerritoryName(d.territory));
  _rdoSet(n.terr.v, 'statier', _rdoTierLabel(ctl));
  _rdoClass(n.terr.v, 'statier', 'is-contested', ctl.tier === 'contested');
  _rdoClass(n.terr.v, 'statier', 'is-partial', ctl.tier === 'majority');

  // ── garrison ──
  _rdoSet(n.garr.v, 'stagarr', _rdoNum(total) + ' / ' + cap);
  // Clamped so a garrison in the overflow band pins the fill at 100% instead of
  // painting past the end of the track. The true ratio is right beside it in
  // the "39.0 / 26" text, which is where a number over capacity belongs.
  _rdoStyle(n.barFill, 'stabar', 'width', _rdoPct(Math.min(1, fill)));
  _rdoClass(n.barFill, 'stabar', 'is-full', fill >= _rdoFullAt());
  _rdoSet(n.comp, 'stacomp', _rdoComp(units));

  // ── which growth branch the sim will take ──
  //
  // Mirrors growthTick()'s branch order exactly: contested → cut off → over the
  // CEILING → growing (full or not). Control flow only; every NUMBER below
  // still comes from the sim.
  //
  // `over` was `total > cap` until the over-capacity rework, and `atCap` was a
  // dead-stop branch that reported 0/day. Both were then wrong for the whole
  // band between capacity and the ceiling — the band the rework created — where
  // a station grows at GROWTH_OVERFLOW_RATE of its peak and bleeds nothing.
  var contested = (typeof stationAttackers === 'function') && stationAttackers(state, sid).length > 0;
  var cut = st.connected === false;
  var ceilUnits = cap * _rdoOverflowCeil();
  var over = total > ceilUnits;
  var full = !over && total >= cap * _rdoFullAt();

  var perDay = 0;
  var status = '';
  var statusBad = true;

  if (contested) {
    // Not "under attack — not recruiting": the growth row directly above it
    // already reads "0 inf / day", so the second clause was the first clause
    // said twice.
    status = 'under attack';
  } else if (cut) {
    // No status word. The supply section IMMEDIATELY below exists only in this
    // state, leads with the alert icon and says "cut off" in the warning
    // colour; printing it here too put the same two words twice in four rows.
    // The growth number carries `is-stalled` and goes negative on its own.
    var gCut = _rdoGrowthPerTick(state, sid, units, BAL.DISCONNECT_GROWTH);
    perDay = (gCut || 0) * _rdoTicksPerDay();
    var since = (st.discSince === undefined || st.discSince < 0) ? state.tick : st.discSince;
    // Attrition, so the headline is not a flat "0 / day" while the pocket dies.
    // Mirrors growthTick()'s `_scaleUnits(units, 1 - DISCONNECT_DECAY)` — one
    // multiplication against a BAL constant, not the growth formula.
    if ((state.tick - since) >= BAL.DISCONNECT_GRACE) {
      perDay -= total * BAL.DISCONNECT_DECAY * _rdoTicksPerDay();
    }
  } else if (over) {
    // Same deal: growthTick() bleeds `excess * OVERSTACK_DECAY` per tick, and
    // the excess is measured against the CEILING, not capacity — growth is
    // legal all the way up to it, so a bleed aimed at capacity would be two
    // rules pulling on the same units in opposite directions. There is no
    // growth term to probe up here: growth is exactly zero above the ceiling.
    perDay = -(total - ceilUnits) * BAL.OVERSTACK_DECAY * _rdoTicksPerDay();
    status = 'over the ceiling — bleeding off';
  } else {
    // Full or not, the station grows and the number comes from the sim's own
    // _applyGrowth. Nothing is special-cased: _growthRoom already knows that a
    // full city produces GROWTH_OVERFLOW_RATE of its peak.
    var g = _rdoGrowthPerTick(state, sid, units, 1);
    perDay = (g === null ? 0 : g) * _rdoTicksPerDay();
    statusBad = false;

    if (full) {
      // Still worth a line: production has halved and the growth number above
      // cannot say why on its own. The percentage is DERIVED from the constant
      // rather than typed as "50%", so the word on screen and the rule in
      // sim/growth.js cannot drift apart. "Spend it" is advice you can only
      // take on your own city; on a neutral one the note at the bottom says the
      // more useful thing.
      var pct = Math.round((BAL.GROWTH_OVERFLOW_RATE || 0) * 100);
      var head = pct > 0 ? ('full at ' + pct + '%') : 'full';   // OFF switch: the old wording, back
      status = isRealPower(owner) ? (head + ' — spend it') : head;
      statusBad = true;
    }
  }

  // The unit type is folded into the VALUE rather than costing a status line of
  // its own ("into infantry"). It matters most on a producer, where the answer
  // is not infantry, and there it is now impossible to miss.
  var made = (typeof growthType === 'function') ? _rdoUnitTag(growthType(sid)) : 'inf';
  _rdoSet(n.growth.v, 'stagrowth',
    (perDay > 0 ? '+' : '') + _rdoNum(perDay) + ' ' + made + ' / day');
  _rdoClass(n.growth.row, 'stagrowthrow', 'is-stalled', perDay <= 0);
  _rdoSet(n.status, 'stastatus', statusBad ? status : '');
  _rdoClass(n.status, 'stastatus', 'is-bad', statusBad && !!status);

  // ── what's modifying it ──
  //
  // state.stations[sid].growthMul is the value growth actually USED (one tick
  // of latency, by design — see the header of sim/growth.js). The published one
  // is the honest thing to show.
  var mul = (typeof st.growthMul === 'number' && isFinite(st.growthMul)) ? st.growthMul : 1;
  var showMul = Math.abs(mul - 1) > RDO_MOD_EPS;
  _rdoShow(n.mul, 'stamul', showMul);
  var mulSrc = [];
  if (showMul) {
    var capped = mul >= BAL.GROWTH_MUL_CAP;
    _rdoSet(n.mul.v, 'stamulv', _rdoMul(mul) + (capped ? '  capped' : ''));
    _rdoClass(n.mul.row, 'stamulrow', 'is-off', mul < 1);

    var farms = _rdoFarms(state, sid);
    var names = [], sick = 0;
    for (var i = 0; i < farms.length; i++) {
      var f = farms[i];
      if (f.dead || f.siege) sick++;
      if (names.length < RDO_MAX_FARMS) {
        // Distance in TERRITORIES, which is the unit MULTIPLIER_REACH is
        // measured in — "adjacent" is the whole mechanic (00-vision.md §2).
        names.push(f.name + ' ×' + f.mult + (f.hops === 0 ? '' : ' · ' + f.hops + ' away'));
      }
    }
    var extra = farms.length - names.length;
    if (extra > 0) names.push('+' + extra + ' more');
    if (names.length) mulSrc.push(names.join('  ·  '));
    // The only farm state worth a second line: one that has stopped paying, or
    // is about to. Everything else about coverage is ON THE MAP.
    if (sick > 0) {
      mulSrc.push(sick + ' of them ' + (sick > 1 ? 'are' : 'is') +
        ' under attack or feeding nobody');
    }
  }
  _rdoSources(n.mulSrc, 'stamulsrc', mulSrc);

  // ── the neutral clock ──
  //
  // A two-station country falls to one volley early and is a wall of full
  // garrisons later, and nothing else on screen says so. Recomputed at ~2Hz
  // because it steps the sim forward a few thousand ticks.
  var note = '';
  if (!isRealPower(owner) && !contested) {
    // The clock runs to CAPACITY, not to the hard ceiling. Both the threshold
    // and the ETA target used to be GROWTH_CAP_EPSILON, and both had to move:
    // that constant is no longer read by the sim, and "as expensive as it will
    // ever be" stopped being true when a neutral city gained another half a
    // capacity to grow into. Capacity is also the last target an ETA can
    // honestly quote — above it the room factor tapers linearly to zero at the
    // ceiling, so the approach is exponential and the true answer is "never".
    if (fill >= _rdoFullAt()) {
      note = 'neutral and full — still creeping up';
    } else if (fill >= RDO_NEUTRAL_WARN || _rdoEta.sid === sid) {
      if (_rdoEta.sid !== sid || _rdoFrame % RDO_ETA_EVERY === 0) {
        var t = _rdoTicksToFill(state, sid, _rdoFullAt());
        _rdoEta = {
          sid: sid,
          text: t < 0 ? '' : 'neutral — full in ~' + Math.max(1, Math.round(t / _rdoTicksPerDay())) + ' days',
        };
      }
      note = _rdoEta.text;
    }
  }
  // The SINGLE write to n.note, and it has exactly one author. Two functions
  // once shared this node and fought over the same cache key every frame: one
  // set '', the other set its text, the diff saw a change both times, and a
  // PAUSED game hovering a neutral station cost 2.007 DOM writes per frame
  // forever. The diff gate is only sound with one author per key.
  _rdoSet(n.note, 'stanote', note);
  return true;
}

// ════════════════════════════════════════════════════════════════════════
// SUPPLY — cut off, and nothing else
// ════════════════════════════════════════════════════════════════════════
//
// Cut off is the one modifier that is invisible on the board and fatal on the
// clock: growth stops dead (DISCONNECT_GROWTH) and the garrison bleeds
// (DISCONNECT_DECAY). The section shows nothing at all while a station is
// connected, because connected is the normal state and the default is not news.
// **Its mere presence is the alarm** — which is why it is worth two rows and an
// icon rather than a suppressed line inside the station block.

function _rdoSupplyBuild(host) {
  _rdoForget('sup');
  var n = {};
  n.state = _rdoIcoRow(host, 'rdo-mod is-cut is-head', 'alert', 'cut off',
    'no chain of this power’s stations reaches home: growth stops and the garrison bleeds');
  n.stateSrc = _rdoSrcGroup(host);
  return n;
}

function _rdoSupplyUpdate(state, n) {
  var sid = _rdoFocusOn(state);
  if (!sid) return false;
  // LIVE ONLY. The headline is a countdown — "decays in 34 ticks" — read off
  // `st.discSince` against the current tick, and there is no such thing as a
  // remembered countdown: it would be wrong by exactly the age of the memory
  // and would look right. `state.seen` does record `connected`, but the alarm
  // this section raises is a clock rather than a flag.
  //
  // This costs the player nothing they had: a cut-off pocket is always the
  // player's OWN city, and a power always sees the ground it holds — so every
  // station this section has ever fired on is level 2 by construction.
  if (_rdoBelief(state, sid).level !== 2) return false;
  var st = state.stations[sid];
  // computeConnectivity() writes this every tick; `undefined` on a state that
  // has not ticked yet is not "cut off", it is "not known yet".
  if (st.connected !== false) return false;

  var since = (st.discSince === undefined || st.discSince < 0) ? state.tick : st.discSince;
  var elapsed = state.tick - since;
  var decaying = elapsed >= BAL.DISCONNECT_GRACE;
  var total = totalUnits(st.units);

  // The headline is the CLOCK, because the clock is the decision: relieve it
  // before the grace period ends and nothing is lost at all.
  _rdoSet(n.state.v, 'supstate', decaying
    ? '−' + _rdoNum(total * BAL.DISCONNECT_DECAY * _rdoTicksPerDay()) + ' / day'
    : 'decays in ' + (BAL.DISCONNECT_GRACE - elapsed) + ' ticks');

  var owner = st.owner;
  var pdef = (typeof POWERS !== 'undefined') ? POWERS[owner] : null;
  var capSid = pdef ? pdef.capital : null;
  var capHeld = capSid && state.stations[capSid] && state.stations[capSid].owner === owner;
  // A power that has lost its capital anchors on its largest surviving
  // component instead (BAL.FALLBACK_ANCHOR_ON_CAPITAL_LOSS), so naming the
  // capital would name a place that is no longer the thing it is cut off from.
  _rdoSources(n.stateSrc, 'supsrc', [
    capHeld && STATIONS[capSid]
      ? 'no route home to ' + STATIONS[capSid].name + ' · growth ' + _rdoMul(BAL.DISCONNECT_GROWTH)
      : _rdoPowerName(owner) + ' has lost its capital; this pocket is not the largest one left',
  ]);
  return true;
}

// ════════════════════════════════════════════════════════════════════════
// FIGHT — what decides an assault, both directions
// ════════════════════════════════════════════════════════════════════════
//
// This was two sections and fourteen rows: a STRENGTH block that decomposed the
// defending power into garrison / fortification / matchup / attacking-out with
// six source lines under them, and a MARCH block that priced two exits, the
// terrain coming in, the sea crossing and any landing in progress.
//
// A player reading it is asking one question — **can I take this, and with
// what** — and the answer is two numbers in the same unit:
//
//     power   ⛨ 81.6   ⚔ 65.0
//
// The shield is what this garrison holds the station WITH. The swords are what
// the same troops are worth attacking OUT, on open ground, at their atk values
// with no fort and no matchup. Side by side they say the thing a fortress
// garrison most needs to say about itself: it is not a field army. The word
// "power" stays because power is a game unit and no icon carries a unit.
//
// Then FORT, and only when there is one. It is additive (rule 2), it is drawn
// additive, and its one source line carries the entire working that used to be
// four: which levels came from the station and which from the terrain, whether
// there are enough defenders to man it, and how much enemy artillery is
// stripping. `armour attacks at ×0.82 — tanks do not reduce forts` was a fifth
// line saying a constant rule of the game; it is the row's title now.
//
// MATCHUP appears only while somebody is actually standing here, because until
// then there is nobody to be matched against.
//
// MARCH is one row: the range of exit times, quickest to slowest, in days. The
// old block quoted each end on its own row with a source line naming the city
// and its penalties — but the per-route number a player actually commits on is
// on the PREVIEW LINE at the moment of the click (§8), computed for the route
// they chose. What the rail can honestly add is the spread, which is the thing
// defeat in detail is made of, and the penalties that cause it.

// The smallest fortification worth a row, in POWER. One unit's worth: below
// that the row is true, correct and beneath the resolution of any decision.
var RDO_FORT_MIN_POWER = 1;

function _rdoFightBuild(host) {
  _rdoForget('fgt');
  var n = {};

  n.pwr = _rdoRow(host, 'rdo-mod is-head', 'power');
  n.def = _rdoIcoVal(n.pwr.v, 'shield', 'power defending here, fortification included');
  n.atk = _rdoIcoVal(n.pwr.v, 'swords', 'what these troops are worth attacking out, on open ground');

  n.fort = _rdoRow(host, 'rdo-mod is-add', 'fort');
  n.fort.row.setAttribute('title',
    'ADDITIVE power, not a multiplier: fortification is troops added to the ' +
    'defence. Artillery strips it; armour cannot reduce it.');
  n.fortSrc = _rdoSrcGroup(host);

  n.match = _rdoRow(host, 'rdo-mod', 'matchup');
  n.matchSrc = _rdoSrcGroup(host);

  n.march = _rdoIcoRow(host, 'rdo-mod', 'timer', 'out',
    'march time from here to its quickest and slowest neighbour, in days');
  n.marchSrc = _rdoSrcGroup(host);

  n.land = _rdoIcoRow(host, 'rdo-mod is-cut', 'alert', 'landing',
    'an amphibious assault coming ashore here');
  return n;
}

function _rdoFightUpdate(state, n) {
  var sid = _rdoFocusOn(state);
  if (!sid) return false;
  // LIVE ONLY, AND THIS IS THE LOAD-BEARING LINE OF THE WHOLE STAGE.
  //
  // Every number in this section is a claim about NOW. The defending power
  // folds the live garrison together with fortification scale-in (how many
  // troops are manning it this instant), the artillery strip (whose guns are
  // standing there this instant) and the matchup against those same attackers.
  // The march row prices exits for the units currently in the station. A
  // remembered version of any of them is known-issues #18 exactly: plausible,
  // stable, recomputed every frame, and answering a different question from the
  // one on screen — with the added cruelty that it is the number an assault is
  // decided by.
  //
  // Hidden rather than approximated. "You find out what a city holds when you
  // march on it" is legible fog behaviour; a fortress rated from a garrison it
  // lost a campaign season ago is a lie the player cannot detect.
  if (_rdoBelief(state, sid).level !== 2) return false;
  if (typeof stationPower !== 'function' || typeof fortLevel !== 'function') return false;

  var d = STATIONS[sid];
  var st = state.stations[sid];
  var units = st.units;
  // WITH state, so the fight readout agrees with the fight. Passing sid alone
  // here would print a defence number that ignored a garrisoned fortification
  // while stationPower() below counted it — known-issue #18 exactly: a readout
  // answering a different question from the one on screen, and never looking
  // wrong.
  var fort = fortLevel(sid, state);

  // Every hostile stack standing here, via the sim's own reader. Pure: it
  // builds a fresh unit bag with emptyUnits()/addUnits and never writes back.
  var atk = (typeof _allAttackerUnits === 'function') ? _allAttackerUnits(state, sid) : emptyUnits();
  var anyAtk = totalUnits(atk) > BAL.ANNIHILATION_EPSILON;
  var enemyMix = (typeof _mix === 'function') ? _mix(atk, false, fort) : null;

  // The headline IS the sim's number, not a sum of the rows below it…
  var pDef = stationPower(state, sid, 'defender');
  var body = (typeof _bodyPower === 'function') ? _bodyPower(units, true, fort, enemyMix) : pDef;
  // …and the fort block is the REMAINDER, so the two cannot fail to add up to
  // the headline even if sim/combat.js gains another term.
  var fbonus = pDef - body;
  // The same troops at their atk values on open ground: no fort, no matchup.
  var open = (typeof _bodyPower === 'function') ? _bodyPower(units, false, 0, null) : 0;

  _rdoSet(n.def, 'fgtdef', _rdoNum(pDef));
  _rdoSet(n.atk, 'fgtatk', _rdoNum(open));
  _rdoClass(n.pwr.row, 'fgtpwrrow', 'is-stalled', totalUnits(units) <= BAL.ANNIHILATION_EPSILON);

  // ── the additive block ──
  //
  // Gated on the POWER it is worth, not on the level existing. Every producer
  // on the board carries defense 1.05, which is 0.05 lvl and +0.3 power — less
  // than one infantryman, on a station holding seven of them. A row that true
  // and that irrelevant is the kind this rewrite exists to delete.
  var fortLines = [];
  var showFort = fort * BAL.DEFENSE_BONUS_POWER >= RDO_FORT_MIN_POWER;
  _rdoShow(n.fort, 'fgtfort', showFort);
  if (showFort) {
    // Never "×". See rule 2 in the file header, and .rdo-mod.is-add in
    // style.css, which paints this row the garrison colour precisely so it
    // cannot be read as one of the dim grey multipliers above it.
    _rdoSet(n.fort.v, 'fgtfortv', _rdoPlus(fbonus) + ' power');

    var why = [];
    var own = d.defense - 1;
    if (Math.abs(own) > RDO_MOD_EPS) why.push(_rdoTypeLabel(d) + ' ' + _rdoLvl(own));
    var tDef = terrainOf(sid).defense;
    if (Math.abs(tDef) > RDO_MOD_EPS) why.push(_rdoTerrainKey(sid) + ' ' + _rdoLvl(tDef));
    // Deliberately "6 power per lvl" and never "× 6". A multiplication sign
    // anywhere in this block is the exact misreading rule 2 exists to stop:
    // levels are what the station and its ground contribute, power-per-level is
    // the rate they buy flat defenders at, and neither is a factor applied to
    // the garrison.
    why.push(BAL.DEFENSE_BONUS_POWER + ' power per lvl');
    fortLines.push(why.join(' · '));

    // Scale-in and artillery strip, both derived from the sim's own _fortBonus
    // rather than restated: run it once with no attackers to get the
    // un-stripped block, and the two factors fall out of the ratio.
    var fNoAtk = (typeof _fortBonus === 'function')
      ? _fortBonus(sid, units, emptyUnits(), fort) : fbonus;
    var full = fort * BAL.DEFENSE_BONUS_POWER;
    var scale = full > 0 ? fNoAtk / full : 1;
    var strip = fNoAtk > 0 ? 1 - (fbonus / fNoAtk) : 0;
    var cut = [];
    if (scale < 1 - RDO_MOD_EPS) {
      cut.push('only ' + _rdoNum(totalUnits(units)) + ' of ' + BAL.DEFENSE_BONUS_FULL_AT +
        ' manning it');
    }
    if (strip > RDO_MOD_EPS) {
      cut.push('guns strip ' + _rdoPctFine(strip) +
        (strip >= BAL.FORT_STRIP_CAP - RDO_MOD_EPS ? ' (capped)' : ''));
    }
    if (cut.length) fortLines.push(cut.join(' · '));
  }
  _rdoSources(n.fortSrc, 'fgtfortsrc', fortLines);

  // ── matchup, only while somebody is actually standing here ──
  var bodyPlain = (typeof _bodyPower === 'function') ? _bodyPower(units, true, fort, null) : 0;
  var m = bodyPlain > 0 ? body / bodyPlain : 1;
  var showMatch = anyAtk && bodyPlain > 0 && Math.abs(m - 1) > RDO_MOD_EPS;
  _rdoShow(n.match, 'fgtmatch', showMatch);
  if (showMatch) {
    _rdoSet(n.match.v, 'fgtmatchv', _rdoMul(m));
    _rdoClass(n.match.row, 'fgtmatchrow', 'is-off', m < 1);
  }
  _rdoSources(n.matchSrc, 'fgtmatchsrc', showMatch ? [
    'against ' + _rdoNum(totalUnits(atk)) + ' units, mostly ' + _rdoTopType(enemyMix),
  ] : []);

  _rdoFightMarch(state, n, sid);

  // ── a landing in progress, which is a modifier on an ARRIVAL ──
  var lw = null;
  var waves = state.waves || [];
  for (var w = 0; w < waves.length; w++) {
    var wv = waves[w];
    if (wv.landing && wv.path && wv.path[wv.path.length - 1] === sid) { lw = wv; break; }
  }
  _rdoShow(n.land, 'fgtland', !!lw);
  if (lw) {
    _rdoSet(n.land.v, 'fgtlandv', _rdoNum(lw.landing.ashore) + ' of ' +
      _rdoNum(lw.landing.total) + ' ashore');
  }
  return true;
}

// Speed is not a property of a station, it is a property of a LINK — terrain
// modifies the march INTO a territory and the sea multipliers belong to the
// crossing. So the row reports the only thing a station can honestly say about
// leaving: the range of exit times, priced with the sim's own waveSpeed on a
// throwaway wave (the same trick _rdoGrowthPerTick uses with _applyGrowth).
function _rdoFightMarch(state, n, sid) {
  if (typeof waveSpeed !== 'function' || typeof stationAdjacency !== 'function') {
    _rdoShow(n.march, 'fgtmarch', false);
    _rdoSources(n.marchSrc, 'fgtmarchsrc', []);
    return;
  }
  var st = state.stations[sid];
  var tpd = _rdoTicksPerDay();

  // An empty station still has exits worth pricing; quote them for infantry and
  // say so, rather than showing a speed of zero.
  var real = totalUnits(st.units) > BAL.ANNIHILATION_EPSILON;
  var ref = real ? st.units : { infantry: 1, artillery: 0, armour: 0 };

  // The slowest type present, which is what the whole stack moves at.
  var slowest = Infinity, slowType = '';
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    if (!(ref[t] > BAL.ANNIHILATION_EPSILON)) continue;
    if (BAL.UNITS[t].speed < slowest) { slowest = BAL.UNITS[t].speed; slowType = t; }
  }

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

  _rdoShow(n.march, 'fgtmarch', exits.length > 0);
  if (!exits.length) { _rdoSources(n.marchSrc, 'fgtmarchsrc', []); return; }

  var lo = exits[0], hi = exits[exits.length - 1];
  _rdoSet(n.march.v, 'fgtmarchv', exits.length > 1
    ? _rdoNum(lo.days) + ' – ' + _rdoNum(hi.days) + ' d'
    : _rdoNum(lo.days) + ' d');

  // WHY it is slow, not WHERE each road goes. The destinations are on the map,
  // named, one link away from the node under the cursor; the penalties are not
  // anywhere.
  var why = [];
  var anySea = false;
  for (var s = 0; s < exits.length; s++) if (exits[s].sea) { anySea = true; break; }
  if (isFinite(slowest) && Math.abs(slowest - 1) > RDO_MOD_EPS) {
    why.push(_rdoUnitTag(slowType) + ' ' + _rdoMul(slowest) + ' — a stack moves at its slowest');
  }
  if (anySea) {
    why.push('sea ' + _rdoMul(BAL.SEA_SPEED_MUL) + ' · −' +
      _rdoPctFine(BAL.SEA_ARTILLERY_LOSS) + ' of the guns per crossing');
  }
  // WHAT THIS CITY COSTS TO WALK AT. The other lines here explain why leaving is
  // slow; this one explains why arriving is expensive, and it belongs beside them
  // because it is the same question asked from the attacker's side.
  //
  // The whole point of the mechanic is that a fortress projects OUTWARD
  // (06-movement-and-attrition.md §6), and a toll nobody can see is a toll nobody
  // routes around — which would leave the player losing armies to a number that
  // never appears anywhere. OPERATING tier, from the sim, so an ungarrisoned
  // fortress correctly advertises nothing.
  if (typeof operatingTier === 'function' && developmentKind(state, sid) === 'fort') {
    var oTier = operatingTier(state, sid);
    if (oTier > 0 && BAL.DEV && BAL.DEV.FORT_APPROACH_LOSS > 0) {
      why.push('fortified — assaults lose −' +
        _rdoPctFine(BAL.DEV.FORT_APPROACH_LOSS * oTier) + ' per tick closing on it');
    }
  }
  if (!real) why.push('quoted for infantry; nothing garrisoned');
  _rdoSources(n.marchSrc, 'fgtmarchsrc', why);
}

// ════════════════════════════════════════════════════════════════════════
// ORDERS — standing supply lines
// ════════════════════════════════════════════════════════════════════════
//
// ── THE SEAM ─────────────────────────────────────────────────────────────
//
// Standing orders were rewritten underneath this file while it was being
// rewritten. The mechanic is now ONE verb: a station carries `supplyTo`, a
// sorted array of stations it streams units to. Empty means no order. A city
// can feed several. There is no second verb and no per-station mode.
//
// **Every fact this section prints comes through the four calls named below,
// and nothing here re-derives any of them.** If the mechanic moves again, this
// list is the whole surface to re-point:
//
//   what does this city supply    stationSupply(state, sid)      core/state.js
//   who supplies this city        stationSuppliedBy(state, sid)  core/state.js
//   what leaves next sweep, and   standingOrderNext(state, sid)  sim/movement.js
//     if not, why not               -> { units, target, blocked, edges }
//   the same for a whole power    standingOrderPlan(state, pid)  sim/movement.js
//
// Everything is typeof-guarded, so a build in which the mechanic is mid-rewrite
// hides this section rather than retiring it — a missing global here must not
// cost the player the three sections above.
//
// WHY standingOrderNext AND NOT standingOrderSend. known-issues #18, and it is
// the single most expensive mistake this panel has made. `standingOrderSend` is
// a source's WILLINGNESS — how much it wants to ship, before the destination
// gets a say. The two were the same number until destinations gained a headroom
// veto, then silently stopped being, and the rail went on printing the
// willingness:
//
//   rail said     "next sweep — 5.6 units"
//   header said   "20.1 units leave on the next sweep"
//   reality        0 sends. 0 units. Forever.
//
// A wrong number is eventually noticed. That one was plausible, stable and
// recomputed every frame, and the fix it hid — spend that stack, or supply a
// city with room — was invisible. `standingOrderNext` shares the sweep's own
// planner, so it cannot drift from what the sweep does. **Willingness is a fine
// thing to compute and a terrible thing to print.**
//
// THE BLOCKED CASE IS THE IMPORTANT ONE, and it names the city. A bare zero is
// the same failure in a smaller font.
//
// There is no set-it-here control and there is not going to be one. The rail is
// where you find out what is true, not where the game is played (00-vision.md
// §8) — a line is drawn on the MAP, on a whole selection at once, with `R` and
// a click. A per-station widget here would make supplying twelve cities twelve
// trips to the right-hand column.

// ── THE VOCABULARY IS THE BOARD'S, READ FROM THE BOARD'S OWN TABLE ───────
//
// known-issues #18 in its purest form was this section: it collapsed a city's
// edges into ONE summary reason (`_ordSummarise` hands back `edges[0].blocked`,
// which is only ever a fair summary when every edge agrees) and printed the
// scariest one for all of them. Berlin supplying Hamburg, Leipzig and Ankara —
// two merely full, one genuinely unreachable — read as
//
//     nothing leaves · 1 of them send nothing — no route over ground you hold
//
// while render/map.js drew those same three edges in TWO visibly different
// states. The board and the rail were answering different questions about the
// same three lines, and the rail was picking the answer that panics.
//
// So this section reads the board's own classification rather than keeping a
// second opinion:
//
//   MAP_ORDER_STUCK    needs the player. Nothing changes until they take ground
//                      or redraw the line. render/map.js strikes a bar across it.
//   everything else    recovers on its own. The throttle, the headroom ceiling
//                      and the keep floor are the rule working as designed, and
//                      colouring them is crying wolf on the normal case.
//
// GUARDED, BECAUSE THE LOAD ORDER IS REAL: index.html puts render/readout.js
// above render/map.js so that railAddSection exists before anything registers
// (known-issues #22), and `const MAP_ORDER_STUCK` is not a property of window
// (known-issues #3), so a bare `typeof` is the only test that works. But the
// guard is LOUD. known-issues #22 is exactly this shape: a quiet guard turns a
// load-order mistake into a feature that silently stops working, and this one
// would degrade to a fallback table that must be kept in step by hand — which
// is the drift the guard exists to survive, not something to survive silently.
var RDO_ORDERS_STUCK_FALLBACK = {
  'unreachable': true,
  'target-lost': true,
};

var _rdoOrdersVocabWarned = false;

function _rdoOrdersStuck(reason) {
  if (typeof MAP_ORDER_STUCK === 'undefined') {
    if (!_rdoOrdersVocabWarned) {
      _rdoOrdersVocabWarned = true;
      console.error('[render/readout] MAP_ORDER_STUCK is not defined — render/map.js ' +
        'has not run, or no longer exports it. The rail is falling back to its own ' +
        'copy of the stuck list (RDO_ORDERS_STUCK_FALLBACK) and can now DRIFT from ' +
        'what the board draws on the same routes. Load render/map.js.');
    }
    return RDO_ORDERS_STUCK_FALLBACK[reason] === true;
  }
  return MAP_ORDER_STUCK[reason] === true;
}

// Does this block need the PLAYER, or only time? One question, one answer, and
// the answer is render/map.js's.
//
// This used to carry its own list, and that list said `destination-full` needs
// the player. The board says it does not — a full destination drains and the
// stream resumes with no input at all, which is why MAP_ORDER_WAITING has it —
// so the two surfaces disagreed about the single most common blocked reason on
// the board. That disagreement is the bug, not a detail of it.
function _rdoOrdersActionable(reason) {
  return _rdoOrdersStuck(reason);
}

// ONE PHRASEBOOK, TWO RENDERINGS. `long` is the sentence; `tag` is the 2-4 word
// form a 200px line can carry N times over. They are two FIELDS OF ONE RECORD
// rather than two switch statements in two functions, because a second
// phrasebook drifting from the first is known-issues #9 and this project has
// logged that five times.
//
// A reason this file has not been taught falls through to a bare statement
// rather than throwing, so a NEW sim reason degrades to "nothing is getting
// through" instead of retiring the section — the same
// degrade-safely-and-say-so contract render/map.js applies to an unclassified
// reason, and test/scenarios-routeview.js already fails the day a sixth reason
// lands unclassified.
// ── "UNDER MINIMUM" WAS A TRUE SENTENCE THAT TAUGHT THE WRONG THING ───────
//
// It described the ARITHMETIC — the share fell under MIN_SEND — and the player
// read a VERDICT. Measured, AI off, one uncontested route: a feed city of
// capacity 13 ships on 6% of its sweeps and reads "under minimum" on the other
// 94%, with dark runs up to 17 sweeps (425 ticks); over 32,000 ticks its
// garrison is stationary to within a unit, so 100% of what it produces leaves
// down that line. Nothing is wrong, nothing is lost, and the rail said the same
// words a genuinely broken line would say. That is what sent the player looking
// for a bug twice.
//
// The number is what separates the two states, and the sim already computes it
// (`shortBy`, sim/movement.js — the inverse of _ordAllowedFraction). It is
// passed in on the EDGE rather than recomputed here, because a renderer deriving
// the keep-floor rule for itself is known-issues #9 and this project has logged
// that five times.
//
//   shortfall > 0   the source cannot yet pay for one stream. It is ACCUMULATING
//                   and this is how many more units it needs. Units, not an ETA:
//                   the garrison is drawn on the station, so the claim can be
//                   checked against the board, and it stays true while the city
//                   is being spent (the shortfall grows) where a countdown lies.
//   shortfall === 0 the source can pay; this LINE did not get this sweep.
//   no edge         an empire-header summary over many lines, which has no one
//                   source and therefore no honest number.
//
// The shortfall===0 wording deliberately does not say "the other line is next".
// The rotation is the usual cause but not the only one — a share trimmed by
// SEND_KEEP_UNITS lands here too — so it states what is true in both cases and
// claims nothing about what happens next.
function _rdoOrdersWhy(reason, target, edge) {
  var dest = target ? _rdoStationName(target) : null;
  var short = (edge && isFinite(edge.shortfall)) ? edge.shortfall : null;
  switch (reason) {
    case 'destination-full':
      return { tag: 'full', long: dest ? dest + ' is full' : 'every destination is full' };
    case 'target-lost':
      return { tag: 'not yours', long: dest ? dest + ' is not yours any more' : 'a destination was lost' };
    case 'at-keep-floor':
      // Always short by definition — the fraction is zero exactly while the
      // garrison sits under KEEP_FLOOR x capacity — but the number is only
      // printed when it was actually handed over.
      return short > 0
        ? { tag: 'saving up', whole: true, long: 'at the keep floor — ' + _rdoNum(short) +
            ' more units before it can spare any' }
        : { tag: 'keep floor', long: 'at the keep floor — a city never ships itself defenceless' };
    case 'below-min-send':
      if (short > 0) {
        return { tag: 'saving up', whole: true, long: 'saving up — ' + _rdoNum(short) +
          ' more units at the source and it ships' };
      }
      if (short === 0) {
        return { tag: 'waiting its turn', whole: true, long: 'the source can pay for ' +
          'a stream; this line did not get this sweep' };
      }
      return { tag: 'saving up', long: 'no city has produced a shippable batch yet' };
    case 'unreachable':
      return { tag: 'no owned route', long: 'no route over ground you hold' };
    case 'no-order':
      return { tag: 'no line set', long: 'no supply line set' };
    default:
      return { tag: 'blocked', long: 'nothing is getting through' };
  }
}

// The long form, unchanged, for every caller that has room for a sentence — the
// empire header's summary line and every destination line's `title`.
function _rdoOrdersWhyShort(reason, target, edge) {
  return _rdoOrdersWhy(reason, target, edge).long;
}

// ── ONE DESTINATION, THREE WORDS FOR IT ─────────────────────────────────
//
// 'flowing' | 'waiting' | 'stuck', the same three words and the same precedence
// render/map.js's _mapRouteState uses, so a line the board strikes through is a
// line this column marks `×` and never the other way round.
//
// It is deliberately NOT the whole of _mapRouteState. That function also
// rescues an edge to 'flowing' on an in-flight wave and on four sweeps of
// hysteresis, both of which exist to stop a LINE ON THE BOARD strobing at
// 60fps; a text row that says "Hamburg — full" for one sweep and then a number
// is not flickering, it is reporting. The half that matters is identical: a
// STUCK reason beats everything in both, so the two surfaces cannot disagree
// about which edges are in trouble, which is the only agreement this bug is
// about. Where they differ, the rail is the STRICTER of the two — it will call
// an edge waiting that the board is still holding as flowing — so the rail can
// never be the one that says a dead line is fine.
function _rdoOrdersEdgeState(e) {
  if (e && e.units > 0) return 'flowing';
  if (e && _rdoOrdersStuck(e.blocked)) return 'stuck';
  return 'waiting';
}

// Leading glyph per state. `×` is the rail's echo of the bar render/map.js
// strikes across a stuck route's middle hop, `→` is the same arrow the
// destination list has always used, and `·` is the file's own separator doing
// duty as a neutral bullet. ASCII-safe, and load-bearing: the state has to be
// readable with no stylesheet at all, because .rdo-src carries no state classes
// today and style.css belongs to another agent this milestone.
var RDO_ORDERS_GLYPH = { flowing: '→', waiting: '·', stuck: '×' };

var _rdoOrdersRank = { stuck: 0, waiting: 1, flowing: 2 };

// Log key for the cap, so a truncation is stated once rather than 60 times a
// second. Truncating in silence is the failure this whole section is about,
// one layer down.
var _rdoOrdersCapKey = null;

// ════════════════════════════════════════════════════════════════════════
// THE FIX, AS A PURE FUNCTION
// ════════════════════════════════════════════════════════════════════════
//
// `next` is standingOrderNext(state, sid). Returns one record per destination:
//
//   { sid, state, text, title }
//
// plus, when the list had to be cut, a final record with `state: 'more'`.
//
// PURE — no DOM, no state, no cache, no sim call. That is not tidiness: it is
// the only way the rule is assertable headlessly (test/scenarios-orderswhy.js),
// and the two defects it fixes are both defects of a DECISION, not of a
// rendering.
//
// THE TWO DEFECTS, NAMED.
//
//   1. A `units > 0` summary must not suppress a dead sibling. At HEAD this
//      function's job was done by `if (next.units > 0)`, which then printed a
//      comma list of destination NAMES — so a city shipping happily down two
//      lines and permanently cut off from a third rendered as three names and a
//      tick count, with nothing anywhere saying which one was dead. The city
//      total was right. The line the player had to fix was invisible.
//
//   2. A single verdict must not be printed over edges that disagree. At HEAD
//      the else-branch printed `_rdoOrdersWhyShort(next.blocked, next.target)`,
//      and `next.blocked` is `edges[0].blocked` — the FIRST destination in
//      sorted id order, chosen by the alphabet and by nothing else. Berlin's
//      "no route over ground you hold" was Ankara's reason wearing Hamburg's and
//      Leipzig's names.
//
// Both are answered the same way: walk the edges and say one thing per edge.
//
// ORDER. Sim order (sorted destination id) is kept EXACTLY as long as
// everything fits, because a list that re-sorts itself every sweep as edges flip
// between waiting and flowing is a list nobody can read. Only when the cap
// actually binds does priority take over — stuck, then waiting, then flowing —
// so the line that needs the player is the last thing that can ever be cut. The
// sort is stable within a rank, so destination order survives inside each group.
function _rdoOrdersLines(next, max) {
  if (!isFinite(max) || max < 2) max = RDO_ORDERS_MAX_LINES;
  var edges = (next && next.edges) || [];
  var out = [], i, e;

  // No edges at all is not a disagreement — it is the whole city's answer, and
  // `_ordSummarise` gives it a reason of its own ('no-order'). One clause.
  if (!edges.length) {
    var w = _rdoOrdersWhy(next && next.blocked, next && next.target);
    return [{
      sid: (next && next.target) || null,
      state: 'stuck',
      text: RDO_ORDERS_GLYPH.stuck + ' ' + w.tag,
      title: w.long,
    }];
  }

  for (i = 0; i < edges.length; i++) {
    e = edges[i];
    var st = _rdoOrdersEdgeState(e);
    var name = _rdoStationName(e.target);
    var rec = { sid: e.target, state: st, text: '', title: '' };
    if (st === 'flowing') {
      rec.text = RDO_ORDERS_GLYPH.flowing + ' ' + name + '  ' + _rdoNum(e.units);
      rec.title = name + ' — ' + _rdoNum(e.units) + ' units on the next sweep, one ' +
        'sweep every ' + BAL.ORDERS.INTERVAL + ' ticks';
    } else {
      var why = _rdoOrdersWhy(e.blocked, e.target, e);
      rec.text = RDO_ORDERS_GLYPH[st] + ' ' + name + ' — ' + why.tag;
      // The full sentence, plus what the STATE means — which is a fact about the
      // classification, not a second word for the reason.
      // `whole` marks a sentence that already says what happens next — "…and it
      // ships" needs no "…and the stream resumes" bolted onto it, and reading
      // both is how a tooltip stops being read at all. A FLAG ON THE RECORD
      // rather than a substring test here, so the phrase and the claim about the
      // phrase are edited in one place.
      rec.title = why.long + (st === 'stuck'
        ? ' — this line needs you; nothing changes until you take ground or redraw it'
        : (why.whole ? '' : ' — it clears itself, and the stream resumes'));
    }
    out.push(rec);
  }

  if (out.length <= max) return out;

  // The cap binds. Priority sort (stable), keep max-1, and SAY WHAT WAS CUT —
  // both on screen as a count and in the console by name.
  var ranked = out.map(function (r, idx) { return { r: r, idx: idx }; });
  ranked.sort(function (a, b) {
    var d = _rdoOrdersRank[a.r.state] - _rdoOrdersRank[b.r.state];
    return d !== 0 ? d : a.idx - b.idx;
  });
  var keep = [], cut = [];
  for (i = 0; i < ranked.length; i++) {
    (i < max - 1 ? keep : cut).push(ranked[i].r);
  }
  var cutNames = [], cutStuck = 0;
  for (i = 0; i < cut.length; i++) {
    cutNames.push(_rdoStationName(cut[i].sid) + ' (' + cut[i].state + ')');
    if (cut[i].state === 'stuck') cutStuck++;
  }
  var key = (keep.length ? keep[0].sid : '') + '|' + cutNames.join(',');
  if (_rdoOrdersCapKey !== key) {
    _rdoOrdersCapKey = key;
    console.warn('[render/readout] orders: ' + (edges.length) + ' destinations, ' +
      'the rail has room for ' + (max - 1) + '. Hidden behind "+' + cut.length +
      ' more": ' + cutNames.join(', ') + '.' +
      (cutStuck > 0
        ? '  ' + cutStuck + ' of them NEED THE PLAYER and are not on screen — ' +
          'raise RDO_ORDERS_MAX_LINES.'
        : '  Nothing hidden is stuck.'));
  }
  keep.push({
    sid: null,
    state: 'more',
    text: '+' + cut.length + ' more',
    title: cut.length + ' further destination(s), not shown: ' + cutNames.join(', '),
  });
  return keep;
}

// Does any destination need the player? The row's own state, and the reason the
// summary number cannot carry: a city shipping 30 units a sweep down two lines
// while a third is cut off is a city with a problem, and "30.0 / sweep" says
// the opposite.
function _rdoOrdersAnyStuck(next) {
  var edges = (next && next.edges) || [];
  for (var i = 0; i < edges.length; i++) {
    if (_rdoOrdersEdgeState(edges[i]) === 'stuck') return true;
  }
  return false;
}

// The same pool discipline as _rdoSources — GROW, never shrink, hide the
// surplus — with a `title` and a state class per line, and its own cap. Kept
// separate from _rdoSources rather than bolted onto it: that helper's two-line
// limit is a statement about a WORKING, and quietly widening it for everybody
// would let some other section's collapse-to-a-sentence rule lapse unnoticed.
function _rdoOrdersRender(g, key, lines) {
  var want = lines.length;
  while (g.pool.length < want) {
    var r = el('div', 'rdo-src rdo-ordline');
    g.host.appendChild(r);
    g.pool.push(r);
  }
  for (var i = 0; i < g.pool.length; i++) {
    var node = g.pool[i];
    var on = i < want;
    _rdoStyle(node, key + '@' + i, 'display', on ? '' : 'none');
    if (!on) continue;
    _rdoSet(node, key + '~' + i, lines[i].text);
    _rdoAttr(node, key + '~' + i, 'title', lines[i].title);
    _rdoClass(node, key + '~' + i, 'is-stuck', lines[i].state === 'stuck');
    _rdoClass(node, key + '~' + i, 'is-waiting', lines[i].state === 'waiting');
  }
}

function _rdoOrdersBuild(host) {
  _rdoForget('ord');
  var n = {};
  n.out = _rdoRow(host, 'rdo-mod', 'supplies');
  n.outSrc = _rdoSrcGroup(host);
  n.in = _rdoRow(host, 'rdo-mod', 'fed by');
  n.inSrc = _rdoSrcGroup(host);
  return n;
}

function _rdoOrdersUpdate(state, n) {
  var sid = _rdoFocusOn(state);
  if (!sid) return false;
  // LIVE ONLY. `supplyTo` is a rival's standing logistics — where a power has
  // decided to send its surplus, which is the closest thing this game has to
  // reading somebody's orders. `state.seen` does not record it and must not:
  // fog covers what is in a city, and an intention is not even that.
  //
  // Free, again, for the case that matters: supply lines only run between two
  // cities ONE power holds (stationSuppliedBy scopes to the target's owner), so
  // every station this section fires on is ground its viewer either holds or
  // is looking straight at.
  if (_rdoBelief(state, sid).level !== 2) return false;
  if (typeof stationSupply !== 'function') return false;
  // Neutral is never an actor and takes no sweeps — the same gate
  // standingOrderNext applies before it will plan anything. Without it a
  // neutral city carrying a stale line (a fixture, a console poke) would be
  // described as a supply network that is merely blocked, which is a different
  // and more actionable statement than the truth.
  if (typeof isRealPower === 'function' && !isRealPower(state.stations[sid].owner)) return false;

  var to = stationSupply(state, sid) || [];
  // O(stations), and safe here only because it is asked about ONE station per
  // frame — the one under the cursor. core/state.js says so at the function and
  // deliberately offers no index, because an index would be a second copy of the
  // same fact invalidated by every capture.
  var from = (typeof stationSuppliedBy === 'function') ? stationSuppliedBy(state, sid) : [];
  // `hold` is not merely the common value, it is what ~all 108 stations carry,
  // because it is the default and the off switch. So a station with no lines in
  // either direction hides the WHOLE section, exactly as `supply` hides itself
  // while a station is connected. The section's presence is the reading.
  if (!to.length && !from.length) return false;

  // ── what leaves ──
  //
  // ONE CLAUSE PER DESTINATION. Not one per city: a city's edges disagree in the
  // normal case, and every summary of a disagreement is a lie about the majority
  // of it. See the block over _rdoOrdersLines for the two defects this replaced.
  _rdoShow(n.out, 'ordout', to.length > 0);
  var outLines = [];
  if (to.length) {
    var next = (typeof standingOrderNext === 'function')
      ? standingOrderNext(state, sid)
      : { units: 0, target: null, blocked: 'no-order', edges: [] };
    var ships = next.units > 0;
    // The city TOTAL is still the headline, because "how much leaves here" is a
    // real question with one honest answer. What it may no longer do is stand in
    // for the state of the lines underneath it.
    _rdoSet(n.out.v, 'ordoutv', ships ? _rdoNum(next.units) + ' / sweep' : 'nothing');
    // `is-stalled` keeps its documented meaning — it dims a value that is not
    // real, i.e. a zero — so it stays keyed to the total.
    _rdoClass(n.out.row, 'ordoutrow', 'is-stalled', !ships);
    // DEFECT 1, at the row. A city shipping 30 a sweep down two lines and
    // permanently cut off from a third is a city with a problem, and `!ships`
    // can never see it. This class is a property of the EDGES. It has no rule in
    // style.css yet and is inert until one is written (see the note to the
    // stylesheet's owner in this milestone's report) — the `×` line underneath
    // is what carries the fact today, which is why it is a WORD and a glyph and
    // not a colour.
    _rdoClass(n.out.row, 'ordoutrow', 'is-attention', _rdoOrdersAnyStuck(next));
    outLines = _rdoOrdersLines(next, RDO_ORDERS_MAX_LINES);
  }
  _rdoOrdersRender(n.outSrc, 'ordoutsrc', outLines);

  // ── what arrives ──
  //
  // A COUNT, not a total. Summing what the sources will ship would need
  // standingOrderPlan for the whole power on the hovered frame, and the empire
  // section above already prints that number for the empire, on a tick
  // throttle. Two places computing one sum is how the last two bugs in this
  // file happened.
  _rdoShow(n.in, 'ordin', from.length > 0);
  var inSrc = [];
  if (from.length) {
    _rdoSet(n.in.v, 'ordinv', from.length + ' cit' + (from.length > 1 ? 'ies' : 'y'));
    var fn = [];
    for (var j = 0; j < from.length && j < RDO_MAX_FARMS; j++) fn.push(_rdoStationName(from[j]));
    if (from.length > fn.length) fn.push('+' + (from.length - fn.length) + ' more');
    inSrc.push('← ' + fn.join(', '));
  }
  _rdoSources(n.inSrc, 'ordinsrc', inSrc);
  return true;
}


// ── the build section (04-development.md §8) ─────────────────────────────
//
// WHAT THIS SECTION IS FOR, and it is not "this city is developed".
//
// The boring half is the fact. The half worth rail space is that BUILT TIER AND
// OPERATING TIER CAN DIFFER — a tier-3 fortress held by a skeleton garrison
// fights as tier 1, and noticing that is the entire skill the mechanic creates.
// So the shape of every line here is "what you paid for, what it is doing, and
// how many units close the gap".
//
// EVERY NUMBER COMES FROM sim/development.js. Not one of them is recomputed here
// — not the cost, not the operating tier, not the shortfall, and not whether a
// build is legal. The rail offers a build from developmentPlan(), which is the
// same function applyCommand uses to accept it, so the rail cannot offer
// something the command then refuses (known-issues #9, logged five times, and
// #18 — a readout answering from its own private opinion).
//
// PORT AND FACTORY SAY THEY DO NOTHING YET, in words, from DEV_LIVE. A screen
// that showed "Port 2" beside a fortification's real bonus would be claiming an
// effect the sim does not have, and the player would spend a capacity and a half
// finding out.
function _rdoBuildBuild(host) {
  _rdoForget('bld');
  var n = {};

  // ONE ROW FOR THE STATE, and it is mostly not words.
  //
  // The previous version read: "built Fortification 2 | running 1 of 2 —
  // under-garrisoned | to next 14.4 more to run at 2 | b builds needs 72.0
  // units". Four rows, thirty words, in a 200px column, to say something a row
  // of pips says at a glance. The player's note was "too wordy" and it was right:
  // the rail is glanced at between orders, not read.
  //
  // So: the TYPE is an icon, the TIER is pips filled to what is running, and the
  // only number is the one that is actionable — how many units switch the next
  // tier on. Everything else was decoration on a fact the pips already carry.
  n.state = _rdoRow(host, 'rdo-mod rdo-dev-state', '');
  n.stateIco = _rdoIcon('fort');                 // src swapped per kind below
  n.state.k.appendChild(n.stateIco);
  n.pips = el('span', 'rdo-dev-pips');
  n.state.v.appendChild(n.pips);
  n.pipEls = [];
  for (var t = 0; t < 3; t++) {
    var pip = el('span', 'rdo-dev-pip');
    n.pipEls.push(pip);
    n.pips.appendChild(pip);
  }
  n.need = el('span', 'rdo-dev-need');
  n.state.v.appendChild(n.need);

  // What `b` would buy here. One line, and it is the price — the chooser that `b`
  // opens carries the rest, so repeating it here would be the same words twice.
  n.next = _rdoRow(host, 'rdo-mod', 'b');

  // THE CHOICE, AND IT IS THE FIRST INTERACTIVE THING IN THE RAIL.
  //
  // §8 puts the choice behind `b`, and that is the fast path. These are the same
  // choice for a player who would rather point at it, and they are the reason a
  // station with two options is not a dead end for someone who has not learned
  // the keys yet.
  //
  // Safe in the rail in a way it would not be over the board: the rail is a DOM
  // sibling in normal flow, so these cannot swallow the click that commits an
  // attack (known-issues #5, five occurrences). Nothing here is ever painted over
  // #board.
  //
  // ONE listener on the row, not three on the buttons — the buttons are reused
  // across stations every frame and per-button listeners would have to be
  // rebound. The station is read from `data-sid` AT CLICK TIME, written by the
  // update below, so a button always acts on the city it is currently labelled
  // for even if the rail has moved on.
  n.pickRow = _rdoRow(host, 'rdo-mod rdo-build-pick', '');
  n.picks = {};
  for (var i = 0; i < DEV_KINDS.length; i++) {
    var kind = DEV_KINDS[i];
    var btn = el('button', 'btn rdo-build-btn', { type: 'button', 'data-kind': kind });
    btn.appendChild(_rdoIcon(kind));
    n.picks[kind] = btn;
    n.pickRow.v.appendChild(btn);
  }
  n.pickRow.v.addEventListener('click', _rdoBuildClick);
  return n;
}

// A build button was pressed. Goes through render/select.js's selBuild(), which
// is the SAME function the `b` key calls — see the note there for why there is
// only one place that composes a build command.
function _rdoBuildClick(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('.rdo-build-btn') : null;
  if (!btn) return;
  var sid = btn.getAttribute('data-sid');
  var kind = btn.getAttribute('data-kind');
  if (!sid || !kind) return;
  if (typeof selBuild !== 'function') {
    console.error('[render/readout] no selBuild — render/select.js must load before ' +
      'the rail is clicked. The build buttons do nothing.');
    return;
  }
  selBuild([sid], kind);
  // BLUR, and it is not cosmetic. A focused button keeps keyboard focus, so the
  // next Space would re-fire it instead of pausing the game, and the next Enter
  // likewise. The board's keys are the primary interface; a rail button must hand
  // focus straight back.
  btn.blur();
}

function _rdoBuildUpdate(state, n) {
  var sid = _rdoFocusOn(state);
  if (!sid) return false;
  if (typeof developmentPlan !== 'function') return false;
  // YOUR OWN CITIES ONLY. What may be built somewhere is a decision only its
  // owner can take, and printing an enemy city's options would offer a gesture
  // that cannot fire. The belief gate is checked first, like every other section.
  if (_rdoBelief(state, sid).level !== 2) return false;
  var me = (typeof PLAYER === 'string') ? PLAYER : null;
  if (!me || state.stations[sid].owner !== me) return false;

  // WRITE THROUGH `rec.v`, NOT `rec` — and show/hide through _rdoShow, not the
  // `hidden` attribute. An earlier version of this function did both wrong and it
  // FAILED SILENTLY IN BOTH DIRECTIONS: _rdoSet(rec, …) sets `textContent` on a
  // plain object, which is legal and does nothing, so the rail rendered labels
  // with no values and threw nothing (known-issues #25, and #15 for why `hidden`
  // is the wrong lever).
  var kind = developmentKind(state, sid);
  var built = builtTier(state, sid);

  // ── the state row: icon, pips, and the one actionable number ──
  if (built > 0) {
    // The icon IS the type. Swapped by rewriting the path, so the row keeps one
    // element rather than churning DOM every time the pointer moves.
    _rdoSetIcon(n.stateIco, kind, 'bldico');
    n.state.k.setAttribute('title', DEV_NAMES[kind] +
      (DEV_LIVE[kind] ? '' : ' — no effect implemented yet'));

    var op = operatingTier(state, sid);
    // ONE SLOT PER BUILT TIER, FILLED TO THE OPERATING TIER. The empty slots are
    // the whole reading: two filled of three says "you paid for a fortress and
    // you are not garrisoning it" without a sentence. Same encoding as the pips
    // under the node, deliberately — one idea, one visual language.
    for (var t = 0; t < n.pipEls.length; t++) {
      var show = t < built;
      n.pipEls[t].style.display = show ? '' : 'none';
      n.pipEls[t].classList.toggle('is-on', t < op);
    }
    _rdoStyle(n.pips, 'bldpips', 'display', '');
    n.pips.setAttribute('title', op + ' of ' + built + ' tiers running');

    // The only number, and only when acting on it would change something.
    var short = operatingShortBy(state, sid);
    var needTxt = (short !== null && short > 0) ? ('+' + _rdoNum(short)) : '';
    _rdoSet(n.need, 'bldneed', needTxt);
    n.need.setAttribute('title', needTxt
      ? (_rdoNum(short) + ' more units to run tier ' + (op + 1))
      : 'fully garrisoned');
    _rdoShow(n.state, 'bldstate', true);
  } else {
    _rdoShow(n.state, 'bldstate', false);
  }

  // ── what `b` would buy ──
  var plan = developmentPlan(state, sid, me, null);
  var nextText = null;
  if (plan.ok) {
    nextText = _rdoNum(plan.cost) + ' units → ' + DEV_NAMES[plan.kind] + ' ' + plan.tier;
  } else if (plan.reason === 'choose-kind') {
    nextText = 'choose';
  } else if (plan.reason === 'at-max-tier') {
    nextText = 'maxed';
  } else if (plan.reason === 'too-few-units') {
    nextText = 'needs ' + _rdoNum(developmentCost(sid, built + 1));
  }
  if (nextText !== null) _rdoSet(n.next.v, 'bldnext', nextText);
  _rdoShow(n.next, 'bldnext', nextText !== null);

  // ── the choice ──
  //
  // Buttons only while there IS one: a station can never change kind once
  // something is built (§5), and a single legal option needs no choosing because
  // `b` already builds it. The row's presence is the reading.
  var opts = kind ? [] : developmentOptions(sid);
  var choosing = opts.length > 1;
  for (var i = 0; i < DEV_KINDS.length; i++) {
    var k = DEV_KINDS[i];
    var btn = n.picks[k];
    var legal = choosing && opts.indexOf(k) >= 0;
    btn.style.display = legal ? '' : 'none';
    if (!legal) continue;
    // Rewritten every frame the row is up: the rail follows the pointer, so this
    // button may be labelled for a different city than it was last frame. Read at
    // CLICK time, never captured at build time.
    btn.setAttribute('data-sid', sid);
    // Affordability is the SIM's answer, from the planner that would accept the
    // command. A button offering a build applyCommand then refuses is the rail
    // lying (known-issues #9, #18).
    var p = developmentPlan(state, sid, me, k);
    btn.disabled = !p.ok;
    btn.setAttribute('title', p.ok
      ? (DEV_NAMES[k] + ' ' + p.tier + ' — ' + _rdoNum(p.cost) + ' units' +
         (DEV_LIVE[k] ? '' : ', no effect implemented yet'))
      : (DEV_NAMES[k] + ' — ' + p.reason));
  }
  _rdoShow(n.pickRow, 'bldpick', choosing);

  return true;
}

// Swap an existing icon's path in place. One element per row for the life of the
// rail, rather than tearing down and rebuilding an <svg> every time the pointer
// moves to a city with a different development.
function _rdoSetIcon(svg, name, key) {
  if (!svg) return;
  if (_rdoLast[key] === name) return;
  _rdoLast[key] = name;
  svg.setAttribute('class', 'rdo-ico rdo-ico-' + name);
  var path = svg.firstChild;
  if (path) path.setAttribute('d', RDO_ICONS[name] || '');
}


// ── the selection line (05-command-clarity.md §1) ────────────────────────
//
// THE HIGHEST-VALUE FIX IN THAT DOCUMENT, and the cheapest: "a persistent
// selection line at the top of the right rail, present whenever anything is
// selected. The rail is always on screen; the carets are not. **This alone
// removes the surprise**, and it costs no gesture change."
//
// The problem it answers, in §1's words: the same left-click on the same enemy
// city either opens a readout or launches your army, and the only thing that
// decides which is selection state that may be entirely off-screen. At the 3x
// home zoom you can see 12% of the board.
//
// FIRST IN THE RAIL, above the empire header, because it is the only section
// that is about what the NEXT CLICK WILL DO rather than about what something is.
//
// It reads selectedSources(), NOT the hover focus — every other section here
// hides itself when nothing is hovered, and this one must survive the pointer
// travelling to the rail or to the enemy city being considered. That is the
// entire point of it.
function _rdoSelBuild(host) {
  _rdoForget('sel');
  var n = {};
  n.what = _rdoRow(host, 'rdo-mod rdo-sel-what', '');
  n.hint = _rdoRow(host, 'rdo-mod rdo-sel-hint', '');
  return n;
}

function _rdoSelUpdate(state, n) {
  if (typeof selectedSources !== 'function') return false;
  var sel = selectedSources();
  if (!sel.length) return false;                 // nothing selected: no section

  // Units are summed through totalUnits(), never spelled out — a second way to
  // add up a bundle is the defect logged five times, and this one would print a
  // different number from the one the volley actually sends.
  var units = 0, mine = 0;
  var me = (typeof PLAYER === 'string') ? PLAYER : null;
  for (var i = 0; i < sel.length; i++) {
    var st = state.stations[sel[i]];
    if (!st || (me && st.owner !== me)) continue;
    mine++;
    units += totalUnits(st.units);
  }

  _rdoSet(n.what.v, 'selwhat', mine + (mine === 1 ? ' city' : ' cities') +
    ' · ' + _rdoNum(units) + ' units');
  _rdoShow(n.what, 'selwhat', true);

  // WHAT THE NEXT CLICK DOES, and it changes with the armed state — a line that
  // said "click a target to commit" while a supply order was armed would be
  // describing a gesture that is not the one about to happen.
  var armed = (typeof SEL_STATE !== 'undefined' && SEL_STATE) ? SEL_STATE.armed : null;
  var hint;
  if (armed === 'supply') hint = 'click a city to route · Esc to cancel';
  else if (armed === 'build') hint = '1/2/3 to build · Esc to cancel';
  else hint = 'click a target to commit · Esc to clear';
  _rdoSet(n.hint.v, 'selhint', hint);
  _rdoShow(n.hint, 'selhint', true);
  return true;
}

// ── registration ────────────────────────────────────────────────────────
//
// Every section registers through the same public seam any later one will use —
// there is no privileged path — so if these calls work, so will the next one.
// None of them passes a `title`: see the note in the file header.

railAddSection({
  id: 'selection',
  order: RDO_SELECTION_ORDER,
  build: _rdoSelBuild,
  update: _rdoSelUpdate,
});

railAddSection({
  id: 'empire',
  order: RDO_HEADER_ORDER,
  build: _rdoHeaderBuild,
  update: _rdoHeaderUpdate,
});

railAddSection({
  id: 'station',
  order: RDO_SECTION_ORDER,
  build: _rdoStationBuild,
  update: _rdoStationUpdate,
});

railAddSection({
  id: 'supply',
  order: RDO_SUPPLY_ORDER,
  build: _rdoSupplyBuild,
  update: _rdoSupplyUpdate,
});

railAddSection({
  id: 'fight',
  order: RDO_FIGHT_ORDER,
  build: _rdoFightBuild,
  update: _rdoFightUpdate,
});

railAddSection({
  id: 'orders',
  order: RDO_ORDERS_ORDER,
  build: _rdoOrdersBuild,
  update: _rdoOrdersUpdate,
});

railAddSection({
  id: 'build',
  order: RDO_BUILD_ORDER,
  build: _rdoBuildBuild,
  update: _rdoBuildUpdate,
});

// The per-frame pump, called by app/loop.js behind safeRender. It drives the
// whole rail, not just this file's sections: `renderReadout` is the only
// per-frame hook the loop offers here, so it is what the rail rides on.
function renderReadout(state) {
  return _rdoRailPump(state);
}

// Global exports — no modules anywhere in this project.
window.renderReadout = renderReadout;
window.setReadoutFocus = setReadoutFocus;
window.railAddSection = railAddSection;
