// render/standings.js — the balance of power, as a scoreboard.
//
// One rail section, registered through railAddSection() at the bottom of this
// file. Seven rows, one per power, sorted by territories held: swatch · name ·
// territories · cities. Nothing else. 05-command-clarity.md §3 asked for
// reinforcement routes and development points beside those two; they are not
// here, because the rail is 200px and a row earns its place by changing what
// the player is about to do (00-vision.md §8). Who is ahead does. How many
// supply edges Italy has drawn does not — and the player's own supply is
// already one row up, in the empire header.
//
// This replaces #powers-strip, which was a row of colour chips in a 52px bar
// over the sea. Same seven numbers, in a column where they can be READ, and
// ranked, which is the part a strip in fixed POWER_IDS order could never do.
//
// ── THIS PANEL IS PUBLIC. IT IS NOT FOG-FILTERED. ────────────────────────
//
// That is a deliberate reversal of docs/design/07-roadmap.md C3 ("the
// standings panel must be fog-filtered") and of the first constraint in
// 05-command-clarity.md §3. Both are being updated; this comment is the
// argument, recorded here because the next reader will find the doc before
// they find the code.
//
// A fog-filtered scoreboard shows Russia holding **5** territories when it
// really holds 23 — a player with no eyes east of Warsaw simply cannot see the
// conquest, so a believed count reports the last thing they looked at. On a
// station readout that lag IS the fog working (render/hud.js says so about the
// old strip, and it was right about the strip). On a SCOREBOARD it is a lie
// with a number on it, and a scoreboard that lies is worse than no scoreboard:
// the player reads "I am second" off a table that has them fourth, and the one
// decision the panel exists to inform is the one it gets wrong.
//
// The standings are the one place the player is entitled to the true board,
// and the design already said so before this file existed:
//
//   02-visibility-and-sea.md, in bold — "who is winning is public knowledge.
//   In 1914 the standings are newspapers, embassies and attachés, not
//   reconnaissance. You can hide an army; you cannot hide having conquered
//   Belgium. Fog covers *what is in a city*, not *who holds the map*."
//
//   05-command-clarity.md §3 carves the same exception one paragraph after
//   demanding the filter: "the panel may rank powers truthfully ... if those
//   two ever disagree visibly, the ranking is right".
//
// And it is load-bearing rather than a nicety. 00-vision.md §6 makes relative
// standing "a heavy term pushing everyone toward hostility with the leader" —
// the mechanism the emergent Concert of Europe runs on. ai/score.js weights
// against the TRUE standing, as it must; LEADER_WEIGHT (45.0) is the only
// constant on the board that can actually declare a war, and it fires at
// whoever is genuinely ahead. If the player is shown a different number from
// the one the AI is reacting to, then six powers turning on the leader looks
// like six powers behaving at random. The Concert becomes invisible at exactly
// the moment it is deciding the game.
//
// So: TRUE counts, TRUE ranking, no visibleTo, no believedStation. The fog
// still owns everything else — what is IN a city stays behind the gate in
// render/readout.js, and the ticker stays filtered in render/hud.js.
//
// ── THE TWO NUMBERS ──────────────────────────────────────────────────────
//
// territories  countTerritories(state, pid) — MAJORITY control (§3), the
//              victory metric, and byte for byte the same call the top bar's
//              "Territories 14/48" makes in hudStats(). Verified, not assumed:
//              core/state.js counts a country for whoever territoryControl()
//              awards it to, which is a strict majority of its stations. Two
//              readouts of one fact must not be two implementations of it
//              (known-issues #9) — if this panel and the top bar ever printed
//              different numbers for the player, both would be unbelievable.
//
// cities       powerStations(state, pid).length. Stations owned, which is what
//              §3 calls a foothold: you can hold six cities in France and no
//              territory at all, and that gap between the two columns is the
//              most legible thing on the panel. Also core's own function
//              rather than a filter written here.
//
// ── PERFORMANCE ──────────────────────────────────────────────────────────
//
// This runs every frame behind safeRender, so it obeys the same rule as
// render/hud.js: build once, then write only what changed. Both metrics are
// pure functions of who owns what, so the whole ranking is memoized on
// state.ownerEpoch — a settled board recomputes never and touches the DOM zero
// times.
//
// The memo key carries an ALIVE BITMASK as well, and that is not belt and
// braces. sim/victory.js flips `alive` on BAL.CAPITULATE_CHECK_INTERVAL (every
// 50 ticks), so a power that lost its last station on tick 1,000 is marked dead
// on tick 1,050 with ownerEpoch unmoved in between. Keyed on the epoch alone,
// the strike-through would never appear.
//
// Rows are created once, in POWER_IDS order, and only re-appended when the sort
// order actually changes — appendChild on an attached node is a move, so a
// reorder is seven moves and a stable board is none.
//
// Every top-level name here is prefixed `_std` / `STD_`, by FILE
// (known-issues #12). In a globals-only project a function name is a global
// claim.

'use strict';

// Between the empire header (5) and the station sections (10): who is winning
// belongs directly under who you are, and above whatever city the cursor
// happens to be over.
var STD_ORDER = 7;

// ── names ───────────────────────────────────────────────────────────────
//
// The rail is 200px and the row already spends width on a swatch and two
// numbers, so the name column is roughly seven characters. "Austria-Hungary"
// and "Kingdom of Italy" do not fit and would either clip or wrap the row to
// two lines; the strip solved that with "AUT / ITA" and this panel cannot,
// because a ranked table is read by name and a three-letter code has to be
// decoded before it can be compared.
//
// So: the short form everyone actually says, with the full style-and-title name
// on the row's `title`. Anything not listed falls back to POWERS[pid].name and
// then to the id, so a power added to data/scenario.js still renders.
var STD_SHORT = {
  ger: 'Germany',
  fra: 'France',
  gbr: 'Britain',
  rus: 'Russia',
  aut: 'Austria',
  ita: 'Italy',
  ott: 'Ottomans',
};

function _stdPowerIds() {
  // known-issues #3: bare typeof. POWER_IDS is a `var` and would survive
  // window.POWER_IDS, but POWERS is a top-level const and would not, so the
  // whole ladder is written the one way that is always correct.
  var ids = (typeof POWER_IDS !== 'undefined' && POWER_IDS.length)
    ? POWER_IDS
    : (typeof POWERS !== 'undefined' ? Object.keys(POWERS).sort() : []);
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    // Neutral is empty ground, not a power. It holds 101 of 108 stations at
    // turn zero and would top the table forever.
    if (ids[i] === 'neutral') continue;
    out.push(ids[i]);
  }
  return out;
}

// Mirrors hudPowerColor() in render/hud.js and powerColor() in render/map.js:
// colour carries ownership and nothing else (00-vision.md §8), so a swatch here
// must be the exact colour the same power is painted on the board.
function _stdColor(pid) {
  if (typeof POWERS === 'undefined' || !POWERS[pid]) return null;
  return POWERS[pid].color || null;
}

function _stdName(pid) {
  if (STD_SHORT[pid]) return STD_SHORT[pid];
  if (typeof POWERS !== 'undefined' && POWERS[pid] && POWERS[pid].name) return POWERS[pid].name;
  return String(pid).toUpperCase();
}

function _stdFullName(pid) {
  if (typeof POWERS !== 'undefined' && POWERS[pid] && POWERS[pid].name) return POWERS[pid].name;
  return String(pid);
}

// ── the ranking ─────────────────────────────────────────────────────────

// `state` is part of the key, not just the epoch. A fresh board — a restart, a
// restored snapshot, a second fixture in the harness — opens at ownerEpoch 0
// and climbs through integers this memo has already seen, so an epoch-only key
// can answer a new game with the old game's table and be confidently wrong for
// as long as the two happen to agree. Object identity costs one compare.
var _stdMemo = { state: null, epoch: -1, mask: -1, list: null };

// One bit per power, in _stdPowerIds() order. Seven property reads a frame,
// which is cheaper than the string it replaces and exact.
function _stdAliveMask(state, ids) {
  var mask = 0;
  for (var i = 0; i < ids.length; i++) {
    var p = state.powers && state.powers[ids[i]];
    if (p && p.alive !== false) mask |= (1 << i);
  }
  return mask;
}

// [{ pid, terr, cities, alive }], best first. TRUE counts — see the header.
//
// Sorted by territories descending, ties broken by cities descending and then
// by power id ascending. The last term is what makes the order DETERMINISTIC:
// two powers on the same two numbers must land the same way every frame, or the
// table shuffles while nothing on the board has changed. Nothing in this file
// reads Date.now() or Math.random().
function _stdRank(state) {
  var ids = _stdPowerIds();
  if (!state || !state.stations) return [];

  var epoch = state.ownerEpoch | 0;
  var mask = _stdAliveMask(state, ids);
  if (_stdMemo.list && _stdMemo.state === state &&
      _stdMemo.epoch === epoch && _stdMemo.mask === mask) {
    return _stdMemo.list;
  }

  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    var pid = ids[i];
    var p = state.powers && state.powers[pid];
    rows.push({
      pid: pid,
      terr: (typeof countTerritories === 'function') ? countTerritories(state, pid) : 0,
      cities: (typeof powerStations === 'function') ? powerStations(state, pid).length : 0,
      alive: p ? p.alive !== false : false,
    });
  }

  rows.sort(function (a, b) {
    if (a.terr !== b.terr) return b.terr - a.terr;
    if (a.cities !== b.cities) return b.cities - a.cities;
    return a.pid < b.pid ? -1 : (a.pid > b.pid ? 1 : 0);
  });

  _stdMemo = { state: state, epoch: epoch, mask: mask, list: rows };
  return rows;
}

// ── the section ─────────────────────────────────────────────────────────

// Class names are fixed by the stylesheet contract and this file adds none of
// its own; layout belongs to style.css, so nothing here writes a width, a gap
// or a display. The one inline style is the swatch's background, which is a
// value the renderer COMPUTES per power and therefore must write as a style
// rather than as an attribute (known-issues #15).
function _stdBuild(host) {
  var n = { host: host, rows: Object.create(null), last: Object.create(null), order: '', me: undefined };
  var ids = _stdPowerIds();

  for (var i = 0; i < ids.length; i++) {
    var pid = ids[i];
    var row = el('div', 'standings-row', {
      'data-power': pid,
      // The full name lives here because the visible one is abbreviated. A
      // short name with no way back to the long one is a puzzle, not a label.
      title: _stdFullName(pid),
    });

    var sw = el('span', 'standings-swatch');
    var color = _stdColor(pid);
    if (color) sw.style.background = color;
    row.appendChild(sw);

    row.appendChild(el('span', 'standings-name', { text: _stdName(pid) }));

    var terr = el('span', 'standings-num is-terr', { text: '0' });
    var cities = el('span', 'standings-num is-cities', { text: '0' });
    row.appendChild(terr);
    row.appendChild(cities);

    host.appendChild(row);
    n.rows[pid] = { row: row, terr: terr, cities: cities };
    // -1 / null mean "never written", which no legitimate value can be, so the
    // first update always paints. Same device as _hudChipLast.
    n.last[pid] = { terr: -1, cities: -1, alive: null, me: null };
  }
  return n;
}

function _stdUpdate(state, n) {
  if (!state || !state.stations || !state.powers) return false;
  if (!n || !n.host) return false;

  var rank = _stdRank(state);
  if (!rank.length) return false;

  var me = (typeof window !== 'undefined' && window.PLAYER) ? window.PLAYER : null;

  // The whole-panel early out. `rank` is memoized on (ownerEpoch, aliveMask),
  // so an unchanged list is the SAME ARRAY as last frame — identity is exact
  // here and costs one compare. With the player unchanged too there is nothing
  // any row could need, and the frame touches no DOM at all.
  if (rank === n.lastRank && me === n.me) return true;
  n.lastRank = rank;
  n.me = me;

  var i, r, rec, last;

  for (i = 0; i < rank.length; i++) {
    r = rank[i];
    rec = n.rows[r.pid];
    if (!rec) continue;                       // a power with no row: nothing to say
    last = n.last[r.pid];

    if (r.terr !== last.terr) {
      last.terr = r.terr;
      rec.terr.textContent = String(r.terr);
    }
    if (r.cities !== last.cities) {
      last.cities = r.cities;
      rec.cities.textContent = String(r.cities);
    }
    // Dead powers STAY on the panel, struck through — the same decision the
    // power strip made and for the same reason: who has been knocked out is as
    // informative as who is winning, and removing the row would reflow every
    // other one. `alive` is sim/victory.js's flag, set by both capitulate() and
    // the elimination branch; it is not re-derived here.
    if (r.alive !== last.alive) {
      last.alive = r.alive;
      rec.row.classList.toggle('is-dead', !r.alive);
    }
    var mine = (r.pid === me);
    if (mine !== last.me) {
      last.me = mine;
      rec.row.classList.toggle('is-me', mine);
    }
  }

  // Reorder only when the order actually moved. appendChild on an attached node
  // is a move, so this is seven DOM operations on the frame a power overtakes
  // another and zero on every other frame — the alternative, re-appending every
  // frame, would kill text selection in the panel and thrash layout for nothing.
  var key = '';
  for (i = 0; i < rank.length; i++) key += rank[i].pid + ',';
  if (key !== n.order) {
    n.order = key;
    for (i = 0; i < rank.length; i++) {
      rec = n.rows[rank[i].pid];
      if (rec) n.host.appendChild(rec.row);
    }
  }

  return true;
}

// ── registration ────────────────────────────────────────────────────────
//
// Guarded so this file evaluates cleanly in the headless harness, which loads
// no render/readout.js and has no DOM at all. Nothing above touches the
// document until build() is called, which is what lets test/ exercise the
// ranking and the rows without a browser.
if (typeof railAddSection === 'function') {
  railAddSection({ id: 'standings', order: STD_ORDER, build: _stdBuild, update: _stdUpdate });
}

// Exports for the test suite. Everything else stays a bare global, as the rest
// of the project does; these are named so test/scenarios-standings.js can reach
// them in a context where `window` exists.
if (typeof window !== 'undefined') {
  window._stdRank = _stdRank;
  window._stdBuild = _stdBuild;
  window._stdUpdate = _stdUpdate;
}
