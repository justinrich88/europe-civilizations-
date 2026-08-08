// render/victory.js — renderVictory(state).
//
// The end screen. `sim/victory.js` sets `state.winner` and app/loop.js stops
// stepping; without this file the game simply freezes and says nothing, which
// reads as a crash rather than as an ending.
//
// Three endings, three different screens (01-data-schema.md, "Render API —
// Milestone 5 additions"):
//
//   conquest   one power owns every station on the board
//   draw       `state.winner === 'draw'` at BAL.MAX_GAME_TICKS — NOT a power
//              id. POWERS['draw'] does not exist and powerName('draw') is not
//              a country. Same class of trap as assuming
//              territoryControl(...).owner is never 'neutral'.
//   defeat     someone else conquered Europe and `state.human` was set.
//              Winning and being conquered must not render identically.
//
// Four rules this file is built around.
//
// 1. **It runs every frame, and almost every frame the game is still running.**
//    The common case is `state.winner === null` and must cost two comparisons.
//    The screen is therefore built EXACTLY ONCE per ending, at the frame the
//    winner first appears, and never touched again — after that the function
//    returns on its third line because the winner it already drew still
//    matches. Nothing here is per-frame work.
//
// 2. **It must not block the board.** The final map is the thing a player most
//    wants to look at. The scrim is `pointer-events: none` so it cannot eat a
//    click even in principle (known issue: an overlay over #g-stations
//    swallows the click that commits an attack, with NO error at all); only
//    the card itself takes pointer events. "View the map" hides the card and
//    leaves a small pill to bring it back.
//
// 3. **Dismissal is render-local.** Nothing in render/ may mutate state, so
//    "dismissed" is a class on a DOM node and a field in VSCR_STATE — never a
//    field on `state`. And because renderVictory early-returns on an
//    already-drawn winner, a dismissed screen cannot be re-shown by the next
//    frame: the code that would show it never runs again.
//
// 4. **Every top-level name is a global claim** (known-issues #9 and #12).
//    sim/victory.js already owns the `_vic` prefix; this file uses `_vscr`,
//    prefixed by FILE rather than by subsystem, which is what #12 says the
//    rule actually is.
//
// Read-only throughout.

'use strict';

// ── view state (never game state) ────────────────────────────────────────

var VSCR_STATE = {
  winner: null,        // the ending currently drawn; null = nothing drawn
  dismissed: false,    // card hidden, pill showing — render-local, not in state
  nodes: null,         // { root, card, pill } built once, reused
};

// ── guarded lookups ──────────────────────────────────────────────────────
//
// Bare `typeof`, never `window.POWERS` — top-level `const` in a classic script
// never lands on the global object (known-issues #3).

function _vscrPowerIds() {
  if (typeof POWER_IDS !== 'undefined' && POWER_IDS.length) return POWER_IDS;
  if (typeof POWERS !== 'undefined' && POWERS) return Object.keys(POWERS).sort();
  return [];
}

// Never called with 'draw' — every caller below screens for it first. Kept
// defensive anyway, because the one place this is forgotten is the one place
// it matters.
function _vscrName(pid) {
  if (!pid || pid === 'draw') return 'Nobody';
  if (typeof powerName === 'function') return powerName(pid);
  if (typeof POWERS !== 'undefined' && POWERS[pid]) return POWERS[pid].name;
  return String(pid);
}

function _vscrColor(pid) {
  if (typeof POWERS !== 'undefined' && POWERS[pid] && POWERS[pid].color) {
    return POWERS[pid].color;
  }
  return null;
}

// Ticks -> days. render/hud.js owns the calendar (one sim-second = one day,
// Day 0 = 28 June 1914); call its helper rather than re-deriving the scale, so
// the end screen and the HUD can never disagree about what day it is.
function _vscrDay(tick) {
  var per = 10;
  if (typeof hudTicksPerDay === 'function') {
    var v = hudTicksPerDay();
    if (isFinite(v) && v > 0) per = v;
  } else if (typeof BAL !== 'undefined' && isFinite(BAL.TICKS_PER_SEC) && BAL.TICKS_PER_SEC > 0) {
    per = BAL.TICKS_PER_SEC;
  }
  return Math.floor((tick || 0) / per);
}

function _vscrInt(n) {
  if (!isFinite(n)) return '—';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ── reading the match out of the log ─────────────────────────────────────
//
// `state.log` is [{ tick, kind, text }], a 400-entry ring buffer. The three
// kinds that describe the shape of the war are capitulation, elimination and
// victory — sim/victory.js writes all three with the power's NAME at the front
// of the text, which is what lets the "when did I fall" lookup below work
// without the sim having to carry a structured field it has no other use for.

function _vscrArc(state) {
  var out = [];
  var log = state.log;
  if (!log || !log.length) return out;
  for (var i = 0; i < log.length; i++) {
    var e = log[i];
    if (!e) continue;
    if (e.kind === 'capitulation' || e.kind === 'elimination' || e.kind === 'victory') {
      out.push(e);
    }
  }
  return out;
}

// The entry describing a given power's fall, or null if it is still standing.
// Matched on the name prefix because that is how sim/victory.js phrases both
// "X capitulates — …" and "X is eliminated".
function _vscrFall(state, pid) {
  var nm = _vscrName(pid);
  var log = state.log;
  if (!log) return null;
  for (var i = 0; i < log.length; i++) {
    var e = log[i];
    if (!e || (e.kind !== 'capitulation' && e.kind !== 'elimination')) continue;
    if (String(e.text).indexOf(nm) === 0) return e;
  }
  return null;
}

// Final standings, strongest first. Territories is the victory metric
// (countTerritories = MAJORITY control, 00-vision.md §3); full control and raw
// force are shown beside it because a power can be broad and hollow.
//
// `neutral` is a real power id and a legitimate owner, so it is counted — but
// it is never an actor, so it sorts last and renders as a footnote rather than
// as a contender.
function _vscrStandings(state) {
  var ids = _vscrPowerIds();
  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    var pid = ids[i];
    if (pid === 'neutral') continue;
    var p = state.powers[pid];
    rows.push({
      pid: pid,
      name: _vscrName(pid),
      color: _vscrColor(pid),
      alive: !(p && p.alive === false),
      terr: countTerritories(state, pid),
      full: countFullTerritories(state, pid),
      stations: powerStations(state, pid).length,
      forces: powerForces(state, pid),
      fall: (p && p.alive === false) ? _vscrFall(state, pid) : null,
    });
  }
  rows.sort(function (a, b) {
    if (b.terr !== a.terr) return b.terr - a.terr;
    if (b.stations !== a.stations) return b.stations - a.stations;
    return b.forces - a.forces;
  });
  return rows;
}

// ── the headline ─────────────────────────────────────────────────────────
//
// Returns { tone, eyebrow, title, blurb }. `tone` drives the colour of the
// card's top rule and nothing else — this is the one place the three endings
// are told apart, so everything downstream can be shape-identical.

function _vscrHeadline(state) {
  var w = state.winner;
  var human = state.human || null;

  // Draw FIRST, before anything can hand 'draw' to a POWERS lookup.
  if (w === 'draw') {
    return {
      tone: 'draw',
      eyebrow: 'Stalemate',
      title: 'The war grinds on',
      blurb: 'No power could break the continent. After ' + _vscrInt(_vscrDay(state.tick)) +
             ' days the front lines are where the armies left them — neither a defeat nor a win.',
      pid: null,
    };
  }

  var nm = _vscrName(w);

  if (human && w === human) {
    return {
      tone: 'win',
      eyebrow: 'Victory',
      title: nm + ' holds all of Europe',
      blurb: 'Every station on the board flies your colour. The Concert is over; ' +
             'there is nobody left to balance against.',
      pid: w,
    };
  }

  if (human && w !== human) {
    var fall = _vscrFall(state, human);
    var yours = _vscrName(human);
    var b = nm + ' holds every station on the board.';
    if (fall) {
      b += ' ' + yours + (fall.kind === 'capitulation' ? ' capitulated' : ' was eliminated') +
           ' on day ' + _vscrInt(_vscrDay(fall.tick)) + '.';
    } else {
      b += ' ' + yours + ' was ground down to nothing.';
    }
    return { tone: 'loss', eyebrow: 'Defeat', title: nm + ' wins the war', blurb: b, pid: w };
  }

  // No human — an observed or headless game.
  return {
    tone: 'win',
    eyebrow: 'Conquest',
    title: nm + ' holds all of Europe',
    blurb: 'Fought out with every power under AI control.',
    pid: w,
  };
}

// ── starting over ────────────────────────────────────────────────────────
//
// app/main.js exposes `boot`, but calling it a second time would re-wire the
// speed, send and key listeners on top of the ones already installed — every
// click would then fire twice. A reload is one line and cannot go wrong, and
// the seed lives in the query string precisely so a game is addressable
// (`?seed=N`, app/main.js). So: "Play again" reloads the same seed, "New game"
// picks another and records it in the URL, which keeps every game reproducible
// from its address — the thing 00-vision.md §9 exists to protect.

function _vscrSeed() {
  if (typeof readSeed === 'function') {
    try { return readSeed(); } catch (e) { /* fall through */ }
  }
  return null;
}

function _vscrNewGame(sameSeed) {
  if (sameSeed) { window.location.reload(); return; }
  var n = (Date.now() % 100000000) >>> 0;
  window.location.search = '?seed=' + n;
}

// ── DOM, built once per ending ───────────────────────────────────────────

function _vscrRow(label, value) {
  var r = el('div', 'vscr-metric');
  r.appendChild(el('span', 'vscr-metric-label', { text: label }));
  r.appendChild(el('span', 'vscr-metric-value', { text: value }));
  return r;
}

function _vscrDismiss(on) {
  VSCR_STATE.dismissed = !!on;
  if (!VSCR_STATE.nodes) return;
  VSCR_STATE.nodes.root.classList.toggle('is-dismissed', VSCR_STATE.dismissed);
}

// Tears the whole thing out. Only called when `state.winner` goes falsy again,
// which in practice means a fresh state was installed on window.GAME from the
// console — a reload takes the DOM with it anyway.
function _vscrTeardown() {
  if (VSCR_STATE.nodes && VSCR_STATE.nodes.root.parentNode) {
    VSCR_STATE.nodes.root.parentNode.removeChild(VSCR_STATE.nodes.root);
  }
  VSCR_STATE.nodes = null;
  VSCR_STATE.winner = null;
  VSCR_STATE.dismissed = false;
}


// ---------------------------------------------------------------------------
// THE ARC OF THE GAME — a line chart of state.history
//
// Player request: *"show a line graph of development over time (toggles from
// territory and forces) so the user can see how the game progressed"*.
//
// One series per living-or-fallen power, three metrics behind a toggle. The
// data is recorded by sim/victory.js on a fixed tick interval, NOT by this
// file on a frame — see BAL.HISTORY for why (rAF does not fire in a hidden
// document, so a renderer-side recorder would draw a chart with holes in it
// wherever the player looked away).
//
// Drawn as ONE <svg> built once, like everything else on this screen: the
// victory card is constructed at the frame the winner appears and never
// touched again.
//
// SVG rather than canvas because the rest of the project is SVG and because a
// polyline of ~200 points per power is nothing. No library — zero-build is a
// hard constraint (CLAUDE.md), so this is about forty lines of arithmetic
// rather than a dependency.
// ---------------------------------------------------------------------------

var VSCR_CHART_W = 520;
var VSCR_CHART_H = 150;
var VSCR_CHART_PAD = { l: 34, r: 8, t: 10, b: 18 };

// The three metrics, in the order they appear as buttons. `key` indexes the
// per-power record sim/victory.js writes; nothing here re-derives a number.
var VSCR_METRICS = [
  { key: 'terr',  label: 'Territory',   unit: 'stations' },
  { key: 'force', label: 'Forces',      unit: 'units' },
  { key: 'dev',   label: 'Development', unit: 'tiers built' },
];

// Largest value across every power for one metric, and the tick span. Both are
// needed before a single point can be placed, and both are pure reads.
function _vscrChartExtent(h, key) {
  var max = 0;
  var pids = Object.keys(h.p).sort();
  for (var i = 0; i < pids.length; i++) {
    var arr = h.p[pids[i]][key] || [];
    for (var j = 0; j < arr.length; j++) if (arr[j] > max) max = arr[j];
  }
  return { max: max, n: h.t.length };
}

// A rounded axis top, so the gridline reads as a number rather than as
// whatever the winner happened to peak at.
function _vscrNiceMax(v) {
  if (!(v > 0)) return 1;
  var mag = 1;
  while (mag * 10 <= v) mag *= 10;
  var steps = [1, 2, 2.5, 5, 10];
  for (var i = 0; i < steps.length; i++) {
    if (mag * steps[i] >= v) return mag * steps[i];
  }
  return mag * 10;
}

function _vscrChartPoints(h, pid, key, max) {
  var arr = (h.p[pid] || {})[key] || [];
  var n = h.t.length;
  if (n < 2 || !(max > 0)) return '';
  var W = VSCR_CHART_W - VSCR_CHART_PAD.l - VSCR_CHART_PAD.r;
  var H = VSCR_CHART_H - VSCR_CHART_PAD.t - VSCR_CHART_PAD.b;
  var out = [];
  for (var i = 0; i < arr.length && i < n; i++) {
    var x = VSCR_CHART_PAD.l + (W * i) / (n - 1);
    var y = VSCR_CHART_PAD.t + H - (H * arr[i]) / max;
    out.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  return out.join(' ');
}

// Repaint for one metric. Only the polylines and the two axis labels change,
// so the SVG is built once and this rewrites points — the same diffing
// discipline render/map.js uses, for the same reason.
function _vscrChartPaint(nodes, h, key) {
  var metric = VSCR_METRICS[0];
  for (var m = 0; m < VSCR_METRICS.length; m++) {
    if (VSCR_METRICS[m].key === key) metric = VSCR_METRICS[m];
  }
  var ext = _vscrChartExtent(h, key);
  var max = _vscrNiceMax(ext.max);

  for (var i = 0; i < nodes.lines.length; i++) {
    var rec = nodes.lines[i];
    rec.node.setAttribute('points', _vscrChartPoints(h, rec.pid, key, max));
  }
  nodes.yTop.textContent = _vscrInt(max);
  nodes.unit.textContent = metric.unit;

  for (var b = 0; b < nodes.buttons.length; b++) {
    nodes.buttons[b].classList.toggle('is-on', nodes.buttons[b].dataset.metric === key);
  }
}

// Returns the finished element, or null when there is nothing to draw. Null is
// a real answer: a game that ended before the first sample has no arc, and a
// chart with one point is a dot pretending to be a story.
function _vscrChart(state) {
  var h = state.history;
  if (!h || !h.t || h.t.length < 2) return null;
  var pids = Object.keys(h.p).sort();
  if (!pids.length) return null;

  var wrap = el('div', 'vscr-chart');

  var bar = el('div', 'vscr-chart-tabs');
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'vscr-chart-svg');
  svg.setAttribute('viewBox', '0 0 ' + VSCR_CHART_W + ' ' + VSCR_CHART_H);
  svg.setAttribute('preserveAspectRatio', 'none');

  var mk = function (tag, cls, attrs) {
    var n = document.createElementNS(svgNS, tag);
    if (cls) n.setAttribute('class', cls);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  };

  // Frame: a baseline and a top gridline. Two lines, because a chart of seven
  // overlapping series does not need a grid — it needs a floor and a ceiling.
  var y0 = VSCR_CHART_H - VSCR_CHART_PAD.b;
  var y1 = VSCR_CHART_PAD.t;
  svg.appendChild(mk('line', 'vscr-axis', {
    x1: VSCR_CHART_PAD.l, y1: y0, x2: VSCR_CHART_W - VSCR_CHART_PAD.r, y2: y0,
  }));
  svg.appendChild(mk('line', 'vscr-grid', {
    x1: VSCR_CHART_PAD.l, y1: y1, x2: VSCR_CHART_W - VSCR_CHART_PAD.r, y2: y1,
  }));

  var yTop = mk('text', 'vscr-chart-y', { x: VSCR_CHART_PAD.l - 5, y: y1 + 4, 'text-anchor': 'end' });
  var yZero = mk('text', 'vscr-chart-y', { x: VSCR_CHART_PAD.l - 5, y: y0 + 3, 'text-anchor': 'end' });
  yZero.textContent = '0';
  svg.appendChild(yTop);
  svg.appendChild(yZero);

  // x axis: first and last day, so the span is readable without a tick every
  // 12 sim-seconds.
  var xa = mk('text', 'vscr-chart-x', { x: VSCR_CHART_PAD.l, y: VSCR_CHART_H - 5 });
  xa.textContent = 'day ' + _vscrInt(_vscrDay(h.t[0]));
  var xb = mk('text', 'vscr-chart-x', {
    x: VSCR_CHART_W - VSCR_CHART_PAD.r, y: VSCR_CHART_H - 5, 'text-anchor': 'end',
  });
  xb.textContent = 'day ' + _vscrInt(_vscrDay(h.t[h.t.length - 1]));
  svg.appendChild(xa);
  svg.appendChild(xb);

  // One polyline per power, in the power's own colour — the same colour it
  // wears on the map and in the standings, so no legend has to teach it.
  var lines = [];
  for (var i = 0; i < pids.length; i++) {
    var pid = pids[i];
    var pl = mk('polyline', 'vscr-chart-line', { points: '' });
    var c = _vscrColor(pid);
    if (c) pl.style.stroke = c;
    if (state.human && pid === state.human) pl.classList.add('is-you');
    svg.appendChild(pl);
    lines.push({ pid: pid, node: pl });
  }

  var unit = el('span', 'vscr-chart-unit');
  var nodes = { lines: lines, yTop: yTop, unit: unit, buttons: [] };

  for (var b = 0; b < VSCR_METRICS.length; b++) {
    var met = VSCR_METRICS[b];
    var btn = el('button', 'vscr-chart-tab', { type: 'button', text: met.label });
    btn.dataset.metric = met.key;
    btn.addEventListener('click', (function (key) {
      return function () { _vscrChartPaint(nodes, h, key); };
    }(met.key)));
    bar.appendChild(btn);
    nodes.buttons.push(btn);
  }
  bar.appendChild(unit);

  wrap.appendChild(bar);
  wrap.appendChild(svg);

  // DEVELOPMENT FIRST, because it is what was asked for. The toggle is right
  // there for the other two.
  _vscrChartPaint(nodes, h, 'dev');
  return wrap;
}

function _vscrBuild(state) {
  var head = _vscrHeadline(state);

  var root = el('div', 'vscr vscr-' + head.tone, { id: 'victory-screen' });
  var card = el('section', 'vscr-card', {
    role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Result',
  });

  // — headline —
  var top = el('header', 'vscr-head');
  var eyebrow = el('div', 'vscr-eyebrow', { text: head.eyebrow });
  if (head.pid) {
    var dot = el('span', 'vscr-dot');
    var c = _vscrColor(head.pid);
    if (c) dot.style.background = c;
    eyebrow.insertBefore(dot, eyebrow.firstChild);
  }
  top.appendChild(eyebrow);
  top.appendChild(el('h1', 'vscr-title', { text: head.title }));
  top.appendChild(el('p', 'vscr-blurb', { text: head.blurb }));
  card.appendChild(top);

  // — the clock —
  var metrics = el('div', 'vscr-metrics');
  metrics.appendChild(_vscrRow('Day', _vscrInt(_vscrDay(state.tick))));
  metrics.appendChild(_vscrRow('Ticks', _vscrInt(state.tick)));
  var seed = _vscrSeed();
  if (seed !== null) metrics.appendChild(_vscrRow('Seed', String(seed)));
  card.appendChild(metrics);

  // — how the war went —
  //
  // A bare "X wins" throws away a whole match. These are the moments the sim
  // already bothered to log: who fell, in what order, on what day.
  var arc = _vscrArc(state);
  card.appendChild(el('h2', 'vscr-sub', { text: 'How the war went' }));
  if (!arc.length) {
    card.appendChild(el('p', 'vscr-none', {
      text: 'No power ever fell. The map never broke.',
    }));
  } else {
    var ol = el('ol', 'vscr-arc');
    for (var i = 0; i < arc.length; i++) {
      var e = arc[i];
      var li = el('li', 'vscr-arc-row vscr-arc-' + e.kind);
      li.appendChild(el('span', 'vscr-arc-day', { text: 'Day ' + _vscrInt(_vscrDay(e.tick)) }));
      li.appendChild(el('span', 'vscr-arc-text', { text: e.text }));
      ol.appendChild(li);
    }
    card.appendChild(ol);
  }

  // — final standings —
  card.appendChild(el('h2', 'vscr-sub', { text: 'Final standings' }));
  var table = el('div', 'vscr-table');
  var hrow = el('div', 'vscr-trow vscr-thead');
  hrow.appendChild(el('span', 'vscr-tname', { text: 'Power' }));
  hrow.appendChild(el('span', 'vscr-tnum', { text: 'Terr' }));
  hrow.appendChild(el('span', 'vscr-tnum', { text: 'Full' }));
  hrow.appendChild(el('span', 'vscr-tnum', { text: 'Stns' }));
  hrow.appendChild(el('span', 'vscr-tnum', { text: 'Forces' }));
  table.appendChild(hrow);

  var rows = _vscrStandings(state);
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var cls = 'vscr-trow';
    if (!row.alive) cls += ' is-fallen';
    if (row.pid === state.winner) cls += ' is-winner';
    if (state.human && row.pid === state.human) cls += ' is-human';
    var tr = el('div', cls);

    var nameCell = el('span', 'vscr-tname');
    var d = el('span', 'vscr-dot');
    if (row.color) d.style.background = row.color;
    nameCell.appendChild(d);
    nameCell.appendChild(el('span', 'vscr-tlabel', { text: row.name }));
    if (state.human && row.pid === state.human) {
      nameCell.appendChild(el('span', 'vscr-tag', { text: 'you' }));
    }
    if (!row.alive) {
      nameCell.appendChild(el('span', 'vscr-tfell', {
        text: row.fall
          ? (row.fall.kind === 'capitulation' ? 'capitulated' : 'eliminated') +
            ' day ' + _vscrInt(_vscrDay(row.fall.tick))
          : 'fallen',
      }));
    }
    tr.appendChild(nameCell);
    tr.appendChild(el('span', 'vscr-tnum', { text: _vscrInt(row.terr) }));
    tr.appendChild(el('span', 'vscr-tnum', { text: _vscrInt(row.full) }));
    tr.appendChild(el('span', 'vscr-tnum', { text: _vscrInt(row.stations) }));
    tr.appendChild(el('span', 'vscr-tnum', { text: _vscrInt(row.forces) }));
    table.appendChild(tr);
  }

  // Neutral is a real owner, not a power — a footnote, never a contender.
  var neutralTerr = countTerritories(state, 'neutral');
  if (neutralTerr > 0) {
    var nr = el('div', 'vscr-trow is-neutral');
    var nc = el('span', 'vscr-tname');
    var nd = el('span', 'vscr-dot');
    var ncol = _vscrColor('neutral');
    if (ncol) nd.style.background = ncol;
    nc.appendChild(nd);
    nc.appendChild(el('span', 'vscr-tlabel', { text: 'Unclaimed' }));
    nr.appendChild(nc);
    nr.appendChild(el('span', 'vscr-tnum', { text: _vscrInt(neutralTerr) }));
    nr.appendChild(el('span', 'vscr-tnum', { text: '—' }));
    nr.appendChild(el('span', 'vscr-tnum', {
      text: _vscrInt(powerStations(state, 'neutral').length),
    }));
    nr.appendChild(el('span', 'vscr-tnum', { text: _vscrInt(powerForces(state, 'neutral')) }));
    table.appendChild(nr);
  }
  card.appendChild(table);

  // — the arc of the game —
  var chart = _vscrChart(state);
  if (chart) card.appendChild(chart);

  // — actions —
  var foot = el('footer', 'vscr-actions');
  var bView = el('button', 'btn vscr-btn', { type: 'button', text: 'View the map' });
  bView.addEventListener('click', function () { _vscrDismiss(true); });
  var bAgain = el('button', 'btn vscr-btn', { type: 'button', text: 'Play again' });
  bAgain.addEventListener('click', function () { _vscrNewGame(true); });
  var bNew = el('button', 'btn vscr-btn is-primary', { type: 'button', text: 'New game' });
  bNew.addEventListener('click', function () { _vscrNewGame(false); });
  foot.appendChild(bView);
  foot.appendChild(bAgain);
  foot.appendChild(bNew);
  card.appendChild(foot);

  var close = el('button', 'vscr-close', {
    type: 'button', 'aria-label': 'Hide the result and look at the map', text: '×',
  });
  close.addEventListener('click', function () { _vscrDismiss(true); });
  card.appendChild(close);

  root.appendChild(card);

  // The way back. Without it, "View the map" would throw the summary away for
  // good and the only way to read it again would be to replay the war.
  var pill = el('button', 'vscr-pill', { type: 'button', text: 'Result' });
  pill.addEventListener('click', function () { _vscrDismiss(false); });
  root.appendChild(pill);

  (document.querySelector('.app') || document.body).appendChild(root);

  VSCR_STATE.nodes = { root: root, card: card, pill: pill };
  VSCR_STATE.dismissed = false;
}

// ── the pinned entry point ───────────────────────────────────────────────
//
// Called every frame by app/loop.js. While the game is running this is two
// comparisons and a return; once the screen is up it is one comparison and a
// return. There is no frame on which this function builds anything twice, and
// no frame on which a dismissed screen can come back — the branch that would
// show it is unreachable while `VSCR_STATE.winner` still matches.

function renderVictory(state) {
  if (!state || !state.winner) {
    if (VSCR_STATE.winner !== null) _vscrTeardown();
    return;
  }
  if (state.winner === VSCR_STATE.winner) return;

  // A different ending than the one on screen (a new game, or a value poked in
  // from the console): start clean rather than layering a second card.
  if (VSCR_STATE.winner !== null) _vscrTeardown();

  VSCR_STATE.winner = state.winner;
  _vscrBuild(state);
}

// Global exports — no modules anywhere in this project.
window.renderVictory = renderVictory;
window.VSCR_STATE = VSCR_STATE;
