// render/help.js — the guide. "How to play", shown once after the empire is
// picked and reachable forever after from the ? button in the top bar.
//
// The player's request, verbatim: *"wire a basic instruction screen that's
// viewable after you pick your team and can be found again from the top bar.
// opening it should pause the game. should include basic mechanics and be
// visual and easy to read."*
//
// ── 1. Pointer events, and why this one is allowed to eat clicks ─────────
//
// render/start.js's header states the discipline: **dismissal is a REMOVAL, not
// a fade.** Anything painted over the board that accepts pointer events
// swallows the click that commits an attack, with no error at all — five
// separate occurrences on this project — and an overlay at `opacity: 0` still
// eats clicks while a node that is not in the document cannot.
//
// This file deliberately does the OPPOSITE of render/victory.js on one point
// and the SAME on the other, and the difference is worth stating because it
// looks like a violation:
//
//   victory.js  scrim is `pointer-events: none`, so the final map stays
//               clickable underneath a screen that never goes away.
//   help.js     scrim TAKES pointer events, because "click outside to close"
//               is one of the three dismissals the player asked for, and a
//               click that fell through the scrim would land on the board and
//               fire a volley the player never aimed. A modal that leaks its
//               dismissal click into an attack order is worse than no modal.
//
// What makes that safe is that the trap has never been "an overlay exists" — it
// is "an overlay exists AFTER it looks gone". So:
//
//   * `helpHide()` calls removeChild. There is no `display:none` state, no
//     `is-dismissed` class, no opacity transition to be stuck half-way through,
//     and `HELP_STATE.root` is nulled. When the guide is closed it is not in
//     the document at all and cannot be in the document at all.
//   * The card is rebuilt from scratch on every open. Nothing is cached, so
//     there is no hidden node to leak.
//   * The game is paused for the whole time it is up, so there is no frame on
//     which a swallowed click would have been a legal order anyway.
//
// ── 2. Pause, and why closing must not blindly unpause ───────────────────
//
// `helpShow()` snapshots `currentSpeed()` and calls `setSpeed(0)`; `helpHide()`
// restores exactly what it snapshotted. The auto-show case makes this
// load-bearing rather than tidy: app/main.js's `bootPlay()` already calls
// `setSpeed(0)` before the guide appears, so the captured speed is 0 and
// closing must LEAVE the game paused — a `togglePause()` or a `setSpeed(2)` on
// close would start the war while the player is still reading the board.
//
// ── 3. Keys ──────────────────────────────────────────────────────────────
//
// `?` and `/` toggle; `Escape` closes. The handler is registered in the CAPTURE
// phase and, while the guide is open, stops every keydown from reaching
// app/main.js and render/select.js. That is modal behaviour on purpose: Space
// would otherwise call `togglePause()` behind the guide and desynchronise the
// speed this file promised to restore, and Escape would clear the player's
// selection on the way past.
//
// ── 4. The content is derived, not typed ─────────────────────────────────
//
// known-issue #18 — "a readout can answer a different question from the one on
// screen and never look wrong" — applies to a manual with numbers in it exactly
// as it applies to the rail. Every number the guide prints is computed here
// from `BAL` / `STATIONS` / the square law rather than transcribed, and the
// derivations are exported (`helpRatioRows`, `helpSendLadder`,
// `helpStationTypes`, `helpUnitRows`, `helpFacts`) so `test/help-tests.js` can
// assert them headlessly against the same data. A guide that quietly disagrees
// with the sim is the same defect as a rail that does.
//
// Two things this file will NOT say, because they are documented and not built:
// development/building, and allies or teams. Marching through an enemy station
// and march attrition are likewise absent.
//
// Privates are prefixed `_help`, by FILE (known-issues #12). Read-only: nothing
// here touches game state.

'use strict';

// ── view state (never game state) ────────────────────────────────────────

var HELP_STATE = {
  open: false,
  root: null,        // the scrim; null whenever the guide is closed
  prevSpeed: null,   // what the loop was doing before we paused it
  onKey: null,       // the capture-phase keydown handler, kept so it can be removed
};

// Bumped if the guide changes enough that a returning player should see it
// again. Reading and writing are both wrapped: private browsing throws on
// localStorage access rather than returning null.
var HELP_SEEN_KEY = 'coe.help.seen.v1';

function _helpSeen() {
  try { return window.localStorage.getItem(HELP_SEEN_KEY) === '1'; }
  catch (e) { return false; }
}

function _helpMarkSeen() {
  try { window.localStorage.setItem(HELP_SEEN_KEY, '1'); }
  catch (e) { /* private browsing — the guide simply auto-shows again */ }
}

// ── guarded lookups ──────────────────────────────────────────────────────
//
// Bare `typeof`, never `window.BAL` — a top-level `const` in a classic script
// is not a property of the global object (known-issues #3).

function _helpBal() {
  return (typeof BAL !== 'undefined' && BAL) ? BAL : null;
}

function _helpStations() {
  return (typeof STATIONS !== 'undefined' && STATIONS) ? STATIONS : null;
}

// ── derived content (asserted by test/help-tests.js) ─────────────────────

// Lanchester square law: integrating dA/dt = -k·B, dB/dt = -k·A gives
// A0² - A² = B0² - B², so a force at odds r keeps sqrt(r² - 1) / r of itself.
// This is the SAME arithmetic data/tuning.js's COMBAT_RATE comment quotes; it
// is derived here rather than copied so the table cannot drift from the model.
function helpSurvivalPct(ratio) {
  var r = Number(ratio);
  if (!isFinite(r) || r <= 1) return 0;
  return Math.round(100 * Math.sqrt(r * r - 1) / r);
}

// The three odds the design calls out, worst first so the bar chart grows
// downward into "a formality".
function helpRatioRows() {
  return [
    { ratio: 1.2, label: '1.2 : 1', pct: helpSurvivalPct(1.2), note: 'a bloodbath' },
    { ratio: 2,   label: '2 : 1',   pct: helpSurvivalPct(2),   note: 'decisive' },
    { ratio: 3,   label: '3 : 1',   pct: helpSurvivalPct(3),   note: 'a formality' },
  ];
}

// The send ladder, straight off BAL.SEND_FRACTIONS by index — the digit that
// selects a rung is its index + 1, which is the same rule app/main.js's
// wireKeys() uses, so the guide cannot advertise a key that does not work.
function helpSendLadder() {
  var B = _helpBal();
  var fr = (B && B.SEND_FRACTIONS) || [];
  var out = [];
  for (var i = 0; i < fr.length; i++) {
    out.push({
      key: String(i + 1),
      fraction: fr[i],
      label: (fr[i] >= 1) ? 'All' : String(Math.round(fr[i] * 100)),
    });
  }
  return out;
}

// The four silhouettes, with their real counts read off the live map. `count`
// is what makes "7 farms on the whole board" land as scarcity rather than as a
// word, and it is a fact about data/stations.js rather than an authored one.
function helpStationTypes() {
  var S = _helpStations();
  var counts = { holding: 0, multiplier: 0, producer: 0, defensive: 0 };
  var produces = {};
  if (S) {
    for (var sid in S) {
      var st = S[sid];
      if (!st) continue;
      if (counts[st.type] !== undefined) counts[st.type]++;
      if (st.type === 'producer' && st.produces) produces[st.produces] = true;
    }
  }
  var made = Object.keys(produces).sort();
  return [
    {
      type: 'holding', name: 'City', count: counts.holding,
      blurb: 'Plain growth, and most of the board. A bigger city has a higher rate and a higher ceiling.',
    },
    {
      type: 'multiplier', name: 'Farm', count: counts.multiplier,
      blurb: 'Raises growth at every city in its country and in the countries next door. Barely garrisoned, so it falls to one volley — and taking one hurts your enemy everywhere at once.',
    },
    {
      type: 'producer', name: 'Factory', count: counts.producer,
      blurb: 'Grows ' + (made.length ? made.join(' or ') : 'better units') +
             ' instead of infantry. Small numbers, far better units.',
    },
    {
      type: 'defensive', name: 'Fortress', count: counts.defensive,
      blurb: 'Low growth, and a flat block of defence added to whoever holds it. Cheap to keep, expensive to take, and it gates a chokepoint.',
    },
  ];
}

// Unit characters, ordered by BAL.UNIT_ORDER — the same fixed order sim/
// iterates for determinism, so the guide lists what the sim has rather than
// what the design doc remembers.
function helpUnitRows() {
  var B = _helpBal();
  var order = (B && B.UNIT_ORDER) || ['infantry', 'artillery', 'armour'];
  var text = {
    infantry:  'The baseline, and the only thing a plain city makes. Best defending, arrives in volume.',
    artillery: 'Strips a fortress of its defence. Deadly attacking, helpless if caught alone, and slow — guns arrive last.',
    armour:    'Fast and strong in the open, poor against forts. Takes ground and cuts links before a defender can react.',
  };
  var out = [];
  for (var i = 0; i < order.length; i++) {
    var k = order[i];
    var u = (B && B.UNITS && B.UNITS[k]) || null;
    out.push({
      type: k,
      name: k.charAt(0).toUpperCase() + k.slice(1),
      atk: u ? u.atk : null,
      def: u ? u.def : null,
      speed: u ? u.speed : null,
      blurb: text[k] || '',
    });
  }
  return out;
}

// Every other number the guide prints, in one place so the test can read them.
function helpFacts() {
  var B = _helpBal();
  return {
    sendKeep:        B ? B.SEND_KEEP_UNITS : null,
    capitulatePct:   B ? Math.round(B.CAPITULATE_FRACTION * 100) : null,
    needsCapital:    B ? !!B.CAPITULATE_REQUIRES_CAPITAL : null,
    disconnectPct:   B ? +(B.DISCONNECT_DECAY * 100).toFixed(2) : null,
    disconnectGrows: B ? (B.DISCONNECT_GROWTH > 0) : null,
    overflowCeil:    B ? B.GROWTH_OVERFLOW_CEIL : null,
    overflowRate:    B ? B.GROWTH_OVERFLOW_RATE : null,
    stationCount:    Object.keys(_helpStations() || {}).length,
  };
}

// The logistic curve as the sim actually computes it (sim/growth.js): growth is
// `rate x units x room`, with room floored at 0.25 x GROWTH_OVERFLOW_RATE below
// capacity and tapering to zero at GROWTH_OVERFLOW_CEIL x capacity. Returned as
// {x, y} in 0..1, x normalised against the ceiling and y against the peak, so
// the drawing below is a projection of the real shape rather than a sketch.
function helpGrowthCurve(steps) {
  var B = _helpBal();
  var rate = (B && isFinite(B.GROWTH_OVERFLOW_RATE)) ? B.GROWTH_OVERFLOW_RATE : 0.5;
  var ceil = (B && isFinite(B.GROWTH_OVERFLOW_CEIL)) ? B.GROWTH_OVERFLOW_CEIL : 1.5;
  var floor = 0.25 * rate;
  var n = steps || 60;
  var pts = [];
  var peak = 0.25;                      // max of u x (1-u) is 0.25, at u = 0.5
  for (var i = 0; i <= n; i++) {
    var u = (i / n) * ceil;             // fullness, in multiples of capacity
    var room;
    if (u <= 1) room = Math.max(1 - u, floor);
    else room = (ceil > 1) ? floor * (1 - (u - 1) / (ceil - 1)) : 0;
    if (room < 0) room = 0;
    pts.push({ x: u / ceil, y: (u * room) / peak });
  }
  return pts;
}

// ── small DOM helpers ────────────────────────────────────────────────────

function _helpSvg(w, h, viewBox) {
  return el('svg', 'help-svg', {
    width: w, height: h, viewBox: viewBox, 'aria-hidden': 'true', focusable: 'false',
  });
}

function _helpKey(label) {
  return el('kbd', 'help-key', { text: label });
}

// A gesture row: the thing you do, then what happens. `keys` is an array of
// strings; anything that is not a single glyph reads as a word chip.
function _helpGesture(keys, what) {
  var row = el('div', 'help-row');
  var g = el('div', 'help-row-keys');
  for (var i = 0; i < keys.length; i++) {
    if (i) g.appendChild(el('span', 'help-plus', { text: '+' }));
    g.appendChild(_helpKey(keys[i]));
  }
  row.appendChild(g);
  row.appendChild(el('div', 'help-row-text', { text: what }));
  return row;
}

function _helpSection(title) {
  var s = el('section', 'help-sec');
  s.appendChild(el('h2', 'help-h', { text: title }));
  return s;
}

// The four silhouettes, drawn by render/map.js's OWN stationShape() rather than
// by a copy of it (known-issues #9: prefer calling the canonical
// implementation). If the board ever changes what a farm looks like, the guide
// changes with it. Colour is deliberately uniform: §8 reserves hue for
// ownership, and nothing in the guide is owned by anybody.
function _helpStationGlyph(type) {
  var svg = _helpSvg(30, 30, '-15 -15 30 30');
  var shape = null;
  if (typeof stationShape === 'function') {
    try { shape = stationShape(type, 9); } catch (e) { shape = null; }
  }
  if (!shape) shape = el('circle', 'station-shape', { r: 9 });
  // Inline STYLES, not presentation attributes — a stylesheet rule silently
  // outranks an attribute and has erased a renderer's colours twice on this
  // project (known-issues #15).
  shape.style.fill = 'rgba(216, 178, 90, 0.18)';
  shape.style.stroke = 'var(--accent)';
  shape.style.strokeWidth = '2';
  svg.appendChild(shape);
  return svg;
}

// ── the diagrams ─────────────────────────────────────────────────────────

// Growth against fullness. The single most important picture in the guide: the
// hump is why a half-full city is the best thing you own and a full one has
// stopped paying.
// NOTE ON THE VIEWBOX WIDTHS BELOW. `.help-svg` is `width: 100%`, so the
// viewBox is scaled to whatever the card is wide — which means the viewBox
// width is not a drawing size, it is a SCALE FACTOR for every stroke and every
// label in the diagram. Authored at 300 they came out at roughly 2x inside a
// 616px card and the 9px captions rendered at 18px. They are therefore authored
// at 600, close to the real width at the 800px window the game is played at
// (known-issue #17: measure at the window the game is played at), so a 10-unit
// caption is about ten screen pixels. Same class of mistake as #17, one layer
// up: a number that only means what it says at one width.
function _helpGrowthDiagram() {
  var W = 600, H = 150, L = 8, R = 8, T = 14, B = 24;
  var svg = _helpSvg('100%', H, '0 0 ' + W + ' ' + H);
  var plotW = W - L - R, plotH = H - T - B;
  var facts = helpFacts();
  var ceil = facts.overflowCeil || 1.5;

  var baseline = el('line', 'help-axis', { x1: L, y1: T + plotH, x2: W - R, y2: T + plotH });
  svg.appendChild(baseline);

  // The capacity line — where "full" is, which on this curve is emphatically
  // not where growth stops.
  var capX = L + plotW * (1 / ceil);
  svg.appendChild(el('line', 'help-guide', { x1: capX, y1: T, x2: capX, y2: T + plotH }));

  var pts = helpGrowthCurve(60);
  var d = '';
  for (var i = 0; i < pts.length; i++) {
    var x = L + pts[i].x * plotW;
    var y = T + plotH - pts[i].y * plotH;
    d += (i ? ' L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
  }
  var fill = el('path', 'help-curve-fill', {
    d: d + ' L' + (L + plotW) + ',' + (T + plotH) + ' L' + L + ',' + (T + plotH) + ' Z',
  });
  svg.appendChild(fill);
  svg.appendChild(el('path', 'help-curve', { d: d }));

  // The peak marker, at half full, computed rather than placed.
  var halfX = L + plotW * (0.5 / ceil);
  svg.appendChild(el('circle', 'help-dot', { cx: halfX, cy: T, r: 3.5 }));

  svg.appendChild(el('text', 'help-tick', { x: halfX, y: H - 9, text: 'half full — fastest' }));
  svg.appendChild(el('text', 'help-tick help-tick-start', {
    x: capX + 5, y: T + 9, text: 'full — still growing, at half rate',
  }));
  svg.appendChild(el('text', 'help-tick help-tick-end', {
    x: W - R, y: H - 9, text: 'hard ceiling',
  }));
  svg.appendChild(el('text', 'help-tick help-tick-start', {
    x: L, y: H - 9, text: 'empty',
  }));
  return svg;
}

// Defeat in detail, as a picture: the same five stacks, thrown from far away
// and from close in. §8 calls this the defining mistake of the game, and it is
// entirely about arrival times.
function _helpStaggerDiagram() {
  var W = 600, H = 104;
  var svg = _helpSvg('100%', H, '0 0 ' + W + ' ' + H);
  var i, x;

  function band(y, offsets, cls, label) {
    svg.appendChild(el('text', 'help-tick help-tick-start', { x: 0, y: y - 14, text: label }));
    svg.appendChild(el('line', 'help-axis', { x1: 0, y1: y, x2: W - 52, y2: y }));
    // the target
    svg.appendChild(el('rect', 'help-target', { x: W - 48, y: y - 10, width: 20, height: 20, rx: 3 }));
    for (i = 0; i < offsets.length; i++) {
      x = 5 + offsets[i] * (W - 70);
      svg.appendChild(el('circle', cls, { cx: x, cy: y, r: 5 }));
    }
  }

  band(32, [0.06, 0.24, 0.42, 0.60, 0.78], 'help-stack is-late',
    'scattered — five arrivals, five defeats');
  band(84, [0.80, 0.845, 0.86, 0.875, 0.9], 'help-stack',
    'massed — one arrival, one battle');
  return svg;
}

// Force ratio: a bar per rung, width = the share of the attacking force still
// standing when it is over.
function _helpRatioTable() {
  var wrap = el('div', 'help-bars');
  var rows = helpRatioRows();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var row = el('div', 'help-bar-row');
    row.appendChild(el('span', 'help-bar-label', { text: r.label }));
    var track = el('span', 'help-bar-track');
    var fillCls = 'help-bar-fill' + (r.pct < 70 ? ' is-costly' : '');
    var f = el('span', fillCls);
    f.style.width = r.pct + '%';
    track.appendChild(f);
    row.appendChild(track);
    row.appendChild(el('span', 'help-bar-num', { text: r.pct + '%' }));
    row.appendChild(el('span', 'help-bar-note', { text: r.note }));
    wrap.appendChild(row);
  }
  return wrap;
}

// Connection, as three cities and a cut. A picture is the only way to say
// "the link matters as much as the city" in one glance.
function _helpConnectionDiagram() {
  var W = 600, H = 62;
  var svg = _helpSvg('100%', H, '0 0 ' + W + ' ' + H);
  var y = 24;
  var xs = [30, 210, 390, 570];

  svg.appendChild(el('line', 'help-link', { x1: xs[0], y1: y, x2: xs[1], y2: y }));
  svg.appendChild(el('line', 'help-link', { x1: xs[1], y1: y, x2: xs[2], y2: y }));
  svg.appendChild(el('line', 'help-link is-cut', { x1: xs[2], y1: y, x2: xs[3], y2: y }));

  // the scissors mark
  var mx = (xs[2] + xs[3]) / 2;
  svg.appendChild(el('line', 'help-cut-mark', { x1: mx - 7, y1: y - 10, x2: mx + 7, y2: y + 10 }));
  svg.appendChild(el('line', 'help-cut-mark', { x1: mx + 7, y1: y - 10, x2: mx - 7, y2: y + 10 }));

  for (var i = 0; i < xs.length; i++) {
    var cls = 'help-node' + (i === 0 ? ' is-capital' : '') + (i === 3 ? ' is-dead' : '');
    svg.appendChild(el('circle', cls, { cx: xs[i], cy: y, r: i === 0 ? 9 : 8 }));
  }

  // Three captions on two rows. They were on one row and the middle one ran
  // straight through the right-hand one at 800px — the only width that matters
  // (known-issue #17).
  svg.appendChild(el('text', 'help-tick', { x: mx, y: y - 16, text: 'link cut' }));
  svg.appendChild(el('text', 'help-tick help-tick-start', {
    x: 0, y: y + 26, text: 'your capital',
  }));
  svg.appendChild(el('text', 'help-tick help-tick-end', {
    x: W, y: y + 26, text: 'no growth, and bleeding',
  }));
  return svg;
}

// ── the card ─────────────────────────────────────────────────────────────

function _helpBuild() {
  var facts = helpFacts();

  var root = el('div', 'help', { id: 'help-screen' });
  var card = el('section', 'help-card', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How to play',
  });

  // — masthead —
  var head = el('header', 'help-head');
  head.appendChild(el('div', 'help-eyebrow', { text: 'How to play' }));
  head.appendChild(el('h1', 'help-title', { text: 'Concert of Europe' }));
  head.appendChild(el('p', 'help-lede', {
    text: 'Every city you hold grows its own army, on its own, forever. ' +
          'Everything else in the game is a consequence of that one fact.',
  }));
  card.appendChild(head);

  var close = el('button', 'help-close', {
    type: 'button', 'aria-label': 'Close the guide', text: '×',
  });
  close.addEventListener('click', function () { helpHide(); });
  card.appendChild(close);

  // — 1. the core tension —
  var s1 = _helpSection('The one idea');
  var pull = el('p', 'help-pull', {
    text: 'Units left at home multiply. Units sent away don’t.',
  });
  s1.appendChild(pull);
  s1.appendChild(_helpGrowthDiagram());
  s1.appendChild(el('p', 'help-p', {
    text: 'Growth is fastest when a city is about half full and slows as it fills — ' +
          'so a full city has stopped paying dividends and a stripped one takes a long ' +
          'time to come back. Full cities are the ones to spend. Every attack sets back ' +
          'the thing that made the attack possible.',
  }));
  card.appendChild(s1);

  // — 2. commands —
  var s2 = _helpSection('Giving orders');
  s2.appendChild(el('p', 'help-p', {
    text: 'There is one verb: pick the cities that send, then click the place they send to.',
  }));
  var rows = el('div', 'help-rows');
  rows.appendChild(_helpGesture(['click'], 'A city you hold — select it.'));
  rows.appendChild(_helpGesture(['drag'], 'A box across the map — select every city of yours inside it.'));
  rows.appendChild(_helpGesture(['double-click'], 'A country — select every city you hold in it.'));
  rows.appendChild(_helpGesture(['⌘', 'A'], 'Select your entire empire.'));
  rows.appendChild(_helpGesture(['click'], 'An enemy or neutral city — every selected city attacks it at once.'));
  rows.appendChild(_helpGesture(['right-click'], 'One of your own cities — march there instead. No fight.'));
  rows.appendChild(_helpGesture(['⌘', 'click'], 'Commit and keep the group, to throw it at the next target too.'));
  rows.appendChild(_helpGesture(['Esc'], 'Drop the selection.'));
  rows.appendChild(_helpGesture(['Space'], 'Pause and unpause. Orders can be given while paused.'));
  s2.appendChild(rows);
  s2.appendChild(el('p', 'help-note', {
    text: 'Hovering a target draws a line from every selected city carrying what it will send ' +
          'and when it will arrive — so a volley is legible before you commit it.',
  }));
  card.appendChild(s2);

  // — 3. how much —
  var s3 = _helpSection('How much you send');
  var ladder = el('div', 'help-ladder');
  var lad = helpSendLadder();
  for (var i = 0; i < lad.length; i++) {
    var chip = el('div', 'help-send');
    chip.appendChild(_helpKey(lad[i].key));
    chip.appendChild(el('span', 'help-send-label', { text: lad[i].label }));
    ladder.appendChild(chip);
  }
  s3.appendChild(ladder);
  s3.appendChild(el('p', 'help-p', {
    text: 'A share of whatever is sitting in each selected city. The setting is persistent — ' +
          'it stays exactly where you put it until you move it again, volley after volley.',
  }));
  s3.appendChild(el('p', 'help-note', {
    text: '"All" never quite means all: it leaves ' + (facts.sendKeep === 1 ? 'one unit' :
          facts.sendKeep + ' units') + ' behind, because growth is proportional to what is ' +
          'there and a city emptied to nothing can never grow again.',
  }));
  card.appendChild(s3);

  // — 4. overwhelming force —
  var s4 = _helpSection('Overwhelming force');
  s4.appendChild(el('p', 'help-p', {
    text: 'Losses scale with the square of the strength ratio, so a bigger force does not ' +
          'just win — it wins nearly intact. How much of the attacking force is still ' +
          'standing afterwards:',
  }));
  s4.appendChild(_helpRatioTable());
  s4.appendChild(el('p', 'help-p help-warn', {
    text: 'This is the mistake that loses games. Stacks arrive one by one, at their own ' +
          'speed, and fight the moment they land — so five distant cities are destroyed one ' +
          'at a time by a garrison that all five together would have overwhelmed.',
  }));
  s4.appendChild(_helpStaggerDiagram());
  s4.appendChild(el('p', 'help-note', {
    text: 'Mass near a front first, then commit. Distance is the whole reason it matters.',
  }));
  card.appendChild(s4);

  // — 5. stations —
  var s5 = _helpSection('What is on the map');
  s5.appendChild(el('p', 'help-p', {
    text: 'Colour says who owns a place. Shape says what it is. There are ' +
          facts.stationCount + ' of them, and they are never built — the map is fixed.',
  }));
  var grid = el('div', 'help-grid');
  var types = helpStationTypes();
  for (var t = 0; t < types.length; t++) {
    var ty = types[t];
    var cell = el('div', 'help-card-sm');
    var ch = el('div', 'help-card-head');
    ch.appendChild(_helpStationGlyph(ty.type));
    var cht = el('div', 'help-card-title');
    cht.appendChild(el('span', 'help-card-name', { text: ty.name }));
    cht.appendChild(el('span', 'help-card-count', { text: ty.count + ' on the board' }));
    ch.appendChild(cht);
    cell.appendChild(ch);
    cell.appendChild(el('p', 'help-card-text', { text: ty.blurb }));
    grid.appendChild(cell);
  }
  s5.appendChild(grid);
  card.appendChild(s5);

  // — 6. units —
  var s6 = _helpSection('The three units');
  var urows = el('div', 'help-rows');
  var us = helpUnitRows();
  for (var u = 0; u < us.length; u++) {
    var ur = el('div', 'help-row is-unit');
    ur.appendChild(el('div', 'help-row-keys', { text: us[u].name }));
    var box = el('div', 'help-row-text');
    box.appendChild(el('span', 'help-unit-text', { text: us[u].blurb }));
    if (us[u].atk !== null) {
      box.appendChild(el('span', 'help-unit-stats', {
        text: 'atk ' + us[u].atk + ' · def ' + us[u].def + ' · speed ' + us[u].speed,
      }));
    }
    ur.appendChild(box);
    urows.appendChild(ur);
  }
  s6.appendChild(urows);
  s6.appendChild(el('p', 'help-note', {
    text: 'A soft triangle: artillery beats dug-in infantry, armour beats exposed artillery, ' +
          'infantry beats armour. Only factories make guns and tanks, which is why they are ' +
          'worth a war.',
  }));
  card.appendChild(s6);

  // — 7. supply lines —
  var s7 = _helpSection('Supply lines');
  var srows = el('div', 'help-rows');
  srows.appendChild(_helpGesture(['R', 'click'],
    'Select cities, press R, then click one of your own cities: every selected city ' +
    'streams its surplus there from now on. Press it again on the same city to remove the line.'));
  srows.appendChild(_helpGesture(['H'], 'Clear the supply lines on the selected cities.'));
  s7.appendChild(srows);
  s7.appendChild(el('p', 'help-note', {
    text: 'A supply stream never attacks and never fights — it carries units to the front and ' +
          'stops there. What to spend, and when, stays your decision.',
  }));
  card.appendChild(s7);

  // — 8. connection —
  var s8 = _helpSection('Stay connected');
  s8.appendChild(_helpConnectionDiagram());
  s8.appendChild(el('p', 'help-p', {
    text: 'A city with no path back to your capital stops growing ' +
          (facts.disconnectGrows ? '' : 'completely') + ' and bleeds ' +
          facts.disconnectPct + '% of its garrison every tick until the path is restored. ' +
          'Cutting a link is worth as much as taking a city — and armour is the thing that does it.',
  }));
  card.appendChild(s8);

  // — 9. fog —
  var s9 = _helpSection('What you can see');
  var fog = el('div', 'help-fog');
  var fogRows = [
    ['is-now', 'Now', 'Cities you hold, and everything bordering them. Live numbers.'],
    ['is-seen', 'Remembered', 'Somewhere you saw once. It shows what was there then, and it ages.'],
    ['is-dark', 'Dark', 'Never seen. The country is drawn; what is in it is not.'],
  ];
  for (var f = 0; f < fogRows.length; f++) {
    var fr = el('div', 'help-fog-row');
    fr.appendChild(el('span', 'help-swatch ' + fogRows[f][0]));
    fr.appendChild(el('span', 'help-fog-name', { text: fogRows[f][1] }));
    fr.appendChild(el('span', 'help-fog-text', { text: fogRows[f][2] }));
    fog.appendChild(fr);
  }
  s9.appendChild(fog);
  card.appendChild(s9);

  // — 10. winning —
  var s10 = _helpSection('Winning');
  s10.appendChild(el('p', 'help-p', {
    text: 'Total conquest — but you rarely have to finish the job by hand. A power that loses ' +
          'its capital while holding under ' + facts.capitulatePct + '% of the territory it ' +
          'started with capitulates, and everything it still owns transfers to whoever holds ' +
          'its capital.',
  }));
  card.appendChild(s10);

  // — 11. relations —
  var s11 = _helpSection('Everyone hates a winner');
  s11.appendChild(el('p', 'help-p', {
    text: 'There is no diplomacy menu and nothing to negotiate. The powers drift toward ' +
          'hostility with whoever is winning, and toward whoever masses on their border. ' +
          'Run away with the game and the board turns on you.',
  }));
  card.appendChild(s11);

  // — footer —
  var foot = el('footer', 'help-actions');
  foot.appendChild(el('span', 'help-foot-note', {
    text: 'Reopen any time with ? or the Guide button in the top bar.',
  }));
  var go = el('button', 'btn help-btn-go is-active', { type: 'button', text: 'Got it' });
  go.addEventListener('click', function () { helpHide(); });
  foot.appendChild(go);
  card.appendChild(foot);

  // The scrim closes on a click that is not on the card. It TAKES pointer
  // events, unlike victory.js's — see the header. That is only safe because
  // helpHide() removes this node from the document outright.
  root.addEventListener('mousedown', function (ev) {
    if (ev.target === root) { ev.preventDefault(); ev.stopPropagation(); helpHide(); }
  });

  root.appendChild(card);
  return { root: root, card: card, go: go };
}

// ── open / close ─────────────────────────────────────────────────────────

// Modal keys. Capture phase, and while the guide is up NOTHING else on the page
// sees a keydown — app/main.js's Space would call togglePause() behind the card
// and desynchronise the speed we promised to restore, and render/select.js's
// Escape would clear the selection on the way past.
function _helpOnKey(ev) {
  if (!HELP_STATE.open) return;
  var t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  ev.stopPropagation();
  if (ev.key === 'Escape' || ev.key === '?' || ev.key === '/') {
    ev.preventDefault();
    helpHide();
  }
}

// The toggle, for a page with no guide on it. Registered once by helpInit() and
// deliberately separate from _helpOnKey: this one must not fire while a text
// field has focus and must not eat modified keystrokes.
function _helpOnGlobalKey(ev) {
  if (HELP_STATE.open) return;
  var t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;   // shift is required for `?`
  if (ev.key === '?' || ev.key === '/') {
    ev.preventDefault();
    helpShow();
  }
}

function helpShow() {
  if (HELP_STATE.open) return false;

  // Snapshot BEFORE pausing. On the auto-show this is already 0, because
  // bootPlay() pauses the opening board — so closing must leave it paused.
  HELP_STATE.prevSpeed = (typeof currentSpeed === 'function') ? currentSpeed() : null;
  if (typeof setSpeed === 'function') setSpeed(0);

  var built = _helpBuild();
  HELP_STATE.root = built.root;
  HELP_STATE.open = true;
  (document.querySelector('.app') || document.body).appendChild(built.root);

  HELP_STATE.onKey = _helpOnKey;
  document.addEventListener('keydown', HELP_STATE.onKey, true);

  // Focus the card so Tab stays inside something sensible and the dialog is
  // announced. Not the close button — "Got it" is the action.
  try { built.go.focus({ preventScroll: true }); } catch (e) { /* older engines */ }

  var btn = byId('help-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  return true;
}

// REMOVAL, not a fade. There is no hidden state for this screen to be in: the
// node leaves the document and HELP_STATE.root goes null, so it cannot be
// sitting invisibly over #g-stations eating the click that commits an attack.
function helpHide() {
  if (!HELP_STATE.open) return false;

  if (HELP_STATE.onKey) {
    document.removeEventListener('keydown', HELP_STATE.onKey, true);
    HELP_STATE.onKey = null;
  }
  if (HELP_STATE.root && HELP_STATE.root.parentNode) {
    HELP_STATE.root.parentNode.removeChild(HELP_STATE.root);
  }
  HELP_STATE.root = null;
  HELP_STATE.open = false;

  // Restore exactly what was captured. A speed of 0 means the game was ALREADY
  // paused when the guide opened, and it must stay paused — never togglePause(),
  // never a default speed.
  var prev = HELP_STATE.prevSpeed;
  HELP_STATE.prevSpeed = null;
  if (typeof setSpeed === 'function' && isFinite(prev) && prev > 0) setSpeed(prev);

  var btn = byId('help-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    try { btn.blur(); } catch (e) { /* ignore */ }
  }
  return true;
}

function helpToggle() {
  return HELP_STATE.open ? helpHide() : helpShow();
}

// Auto-show, once per browser. Marked seen on OPEN rather than on close, so a
// reload with the guide up does not show it a second time.
function helpAutoShow() {
  if (_helpSeen()) return false;
  _helpMarkSeen();
  return helpShow();
}

// Called once from app/main.js's bootPlay(). The button is `hidden` in
// index.html and revealed here, so it does not exist as a clickable thing while
// the empire picker is up — same reasoning as bootPlay() wiring selection only
// once a power has been named.
function helpInit() {
  var btn = byId('help-btn');
  if (btn) {
    btn.hidden = false;
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function () { helpToggle(); });
  } else {
    console.warn('[render/help] no #help-btn in the document');
  }
  document.addEventListener('keydown', _helpOnGlobalKey);
  return true;
}

// Global exports — no modules anywhere in this project. Guarded because
// test/node.js evaluates this file into a context with no `window`: the derived
// content above is asserted headlessly by test/help-tests.js, and a bare
// `window.helpShow = …` at the top level would make the whole harness fail to
// load (known-issues #3 is the other half of this asymmetry — `const` never
// lands on `window`, and here `window` is not there to land on).
if (typeof window !== 'undefined') {
  window.helpShow = helpShow;
  window.helpHide = helpHide;
  window.helpToggle = helpToggle;
  window.helpAutoShow = helpAutoShow;
  window.helpInit = helpInit;
  window.HELP_STATE = HELP_STATE;
}
