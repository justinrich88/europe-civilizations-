// render/start.js — the empire picker, shown before there is a game.
//
// The player asked to "load onto a loading screen where they pick their empire
// and… select from the various nations on the map". Both halves of that matter:
// a list of seven cards is not the request. The map IS the picker — the seven
// homelands are painted in their power's colour on the real board and are the
// primary thing you click.
//
// THREE PROPERTIES, all deliberate, and the first two are the same argument the
// rail (`style.css`, `rail:`) and `.ailog` are built on:
//
// 1. **The panel is a flex SIBLING of .board-wrap, never an overlay.** Anything
//    painted over the board that accepts pointer events swallows the click that
//    commits an attack, with no error at all — five separate occurrences on
//    this project. In normal flow the panel displaces the board instead; the
//    SVG has a viewBox and simply rescales, so the whole map stays visible and
//    stays clickable. Safe by construction rather than by a rule someone has to
//    remember.
//
// 2. **Dismissal is a removal, not a fade.** `startScreenHide()` takes the
//    `<g id="g-start">` layer out of #board and the panel out of .stage. An
//    overlay faded to `opacity: 0` still eats clicks; a node that is not in the
//    document cannot. There is deliberately no transition to be half-way
//    through.
//
// 3. **It runs before window.GAME.human exists.** `ai/ai.js` skips
//    `state.human`, so a game started with it unset has the player's own cities
//    launching attacks they never ordered. app/main.js therefore creates GAME,
//    draws the board, and stops — this file names the power, and only then does
//    `bootPlay()` set `human`, wire selection and start the loop. Nothing on
//    the board is live while the picker is up because nothing has been wired:
//    no `initSelection`, no `startLoop`. "Not playable" is the absence of
//    listeners, not a shield over them.
//
// Hit-testing is the browser's, not ours: the homelands are real `<polygon>`
// elements and the events are theirs. That sidesteps known-issue #17 entirely
// (a threshold authored in board units is not a constant number of screen
// pixels) — there is no threshold here to get wrong.
//
// Read-only, like every other file under render/. It never touches state; the
// chosen power leaves through the callback and app/main.js does the mutating.

'use strict';

// _startHome() sums a capital's opening garrison with core/state.js's
// totalUnits(), so core/state.js has to be above this file in index.html.
// Loud on failure per known-issue #22 — the card would otherwise just quietly
// stop mentioning how many units you start with.
if (typeof totalUnits !== 'function') {
  console.error('[render/start] no totalUnits at load — core/state.js must come ' +
    'BEFORE render/start.js in index.html. The power cards will throw on garrison.');
}

// ── content ──────────────────────────────────────────────────────────────
//
// The ONLY thing in this file that is authored rather than derived. Straight
// out of 00-vision.md §2, "Density is the national character" — the table that
// exists precisely because the powers have no trait stats, so the difference
// between them is a property of the map and has to be said in words somewhere.
//
// Keyed by power id rather than listed in order, so the seven cards are still
// built from POWERS (a power added to data/scenario.js appears with no text
// rather than not appearing at all).

var START_PLAYS = {
  ger: 'Best units, compact, encircled — must win fast',
  rus: 'Endless cheap numbers, slow to move, hard to digest',
  gbr: 'Safe and rich, must project power to matter',
  fra: 'Defensive anchor that counterpunches',
  aut: 'Fragile, awkward interior lines',
  ita: 'Hard to invade, hard to expand from',
  ott: 'Nearly untakeable, painfully slow',
};

var START_PROFILE = {
  ger: 'Dense; several producers',
  rus: 'Sparse holdings over an enormous area, big farm multipliers, few producers',
  gbr: 'Compact, industrial, behind a sea crossing',
  fra: 'Balanced, strong fortress belt',
  aut: 'Scattered, mixed, poorly connected',
  ita: 'Producer north, empty south, Alpine forts',
  ott: 'Very sparse, defensive chokepoints',
};

// ── view state (never game state) ────────────────────────────────────────

var START_STATE = {
  showing: false,
  pid: null,          // the power currently chosen; the confirm button's target
  hot: null,          // the power currently under a cursor, either side
  onPick: null,
  dock: null,         // the panel, a sibling of .board-wrap
  layer: null,        // <g id="g-start"> inside #board
  go: null,           // the confirm button
  cards: null,        // { pid: <button> }
  lands: null,        // { pid: { land, glow, cap } }
  onKey: null,        // the document keydown handler, kept so it can be removed
};

// ── guarded lookups ──────────────────────────────────────────────────────
//
// Bare `typeof`, never `window.POWERS` — a top-level `const` in a classic
// script is not a property of the global object (known-issues #3).

function _startData() {
  return {
    VERTS:       (typeof VERTS       !== 'undefined') ? VERTS       : null,
    TERRITORIES: (typeof TERRITORIES !== 'undefined') ? TERRITORIES : null,
    STATIONS:    (typeof STATIONS    !== 'undefined') ? STATIONS    : null,
    POWERS:      (typeof POWERS      !== 'undefined') ? POWERS      : null,
    SETUP:       (typeof SETUP       !== 'undefined') ? SETUP       : null,
  };
}

// Never a hard-coded list of seven. `neutral` is a real power id with no
// capital and no AI (01-data-schema.md) and is not a thing anyone can play, so
// "has a capital we can find on the map" is the whole filter.
function _startPowerIds(D) {
  var out = [];
  if (!D.POWERS) return out;
  var ids = Object.keys(D.POWERS).sort();
  for (var i = 0; i < ids.length; i++) {
    var pid = ids[i];
    if (pid === 'neutral') continue;
    var p = D.POWERS[pid];
    if (!p || !p.capital) continue;
    if (D.STATIONS && !D.STATIONS[p.capital]) continue;
    out.push(pid);
  }
  return out;
}

// Everything the card shows besides the character line, derived from data/ so
// it cannot drift: a station added to Germany changes the card without anyone
// editing the card. 00-vision.md §6 — every power opens holding exactly one
// city, so "homeland" is the territory its capital sits in and the rest of that
// country is neutral ground it has to take like anyone else.
function _startHome(D, pid) {
  var p = D.POWERS[pid];
  var cap = D.STATIONS ? D.STATIONS[p.capital] : null;
  var tid = cap ? cap.territory : null;
  var terr = (tid && D.TERRITORIES) ? D.TERRITORIES[tid] : null;

  var stations = 0;
  var producers = 0;
  if (tid && D.STATIONS) {
    for (var sid in D.STATIONS) {
      if (D.STATIONS[sid].territory !== tid) continue;
      stations++;
      if (D.STATIONS[sid].type === 'producer') producers++;
    }
  }

  var seed = (D.SETUP && cap) ? D.SETUP[cap.id] : null;
  var units = 0;
  // totalUnits(), not a fourth hand-rolled copy of the same sum. The card's
  // opening-garrison line is the first number a player ever sees, and the
  // per-property `|| 0` guards this used to carry would print a serene "0
  // units" for every power the day the unit bundle changes shape. `seed.units`
  // being absent is still a legitimate zero — a SETUP entry with no garrison —
  // so that guard stays and only the sum moves.
  if (seed && seed.units) units = totalUnits(seed.units);

  return {
    tid: tid,
    terrName: terr ? (terr.name || tid) : '—',
    label: terr && terr.label ? terr.label : null,
    shape: terr ? terr.shape : null,
    capName: cap ? (cap.name || cap.id) : '—',
    capPos: cap ? cap.pos : null,
    capUnits: Math.round(units),
    stations: stations,
    producers: producers,
  };
}

function _startColor(D, pid) {
  var p = D.POWERS && D.POWERS[pid];
  return (p && p.color) ? p.color : '#6c7686';
}

function _startName(D, pid) {
  var p = D.POWERS && D.POWERS[pid];
  return (p && p.name) ? p.name : String(pid);
}

// ── the map layer ────────────────────────────────────────────────────────
//
// A `<g id="g-start">` appended last inside #board, so it paints over every
// other layer including #g-ui. It is the only layer this file owns and it is
// removed wholesale on dismissal — see the header, property 2.

function _startViewBox(svg) {
  var raw = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/);
  if (raw.length !== 4) return [0, 0, 1000, 700];
  var out = [];
  for (var i = 0; i < 4; i++) {
    var n = Number(raw[i]);
    if (!isFinite(n)) return [0, 0, 1000, 700];
    out.push(n);
  }
  return out;
}

// Vertex ids -> a `points` attribute, through render/map.js's own helpers. Not
// reimplemented here: two implementations of one geometry rule is how the
// renderer ended up silently overriding the sim's territoryControl
// (known-issues #9), and the shapes on screen must be the shapes map.js drew or
// the click target does not match the country under it.
function _startShapePoints(D, shape) {
  if (typeof shapePoints !== 'function' || typeof pointsAttr !== 'function') return null;
  var pts = shapePoints({ VERTS: D.VERTS }, shape);
  return pts ? pointsAttr(pts) : null;
}

function _startBuildLayer(D, ids, homes) {
  var svg = byId('board');
  if (!svg) {
    console.error('[render/start] no #board svg — the map cannot be part of the choosing');
    return null;
  }

  var vb = _startViewBox(svg);
  var g = el('g', 'start-layer', { id: 'g-start' });

  // The wash dims the whole board so the seven homelands are the only lit
  // things on it. Drawn INSIDE this layer rather than as an opacity rule on
  // .territory, so undoing it is the same one removal as everything else here
  // and no other file's elements are ever touched.
  g.appendChild(el('rect', 'start-wash', {
    x: vb[0], y: vb[1], width: vb[2], height: vb[3],
  }));

  var glows = el('g', 'start-glows');
  var lands = el('g', 'start-lands');
  var marks = el('g', 'start-marks');

  var out = Object.create(null);

  for (var i = 0; i < ids.length; i++) {
    var pid = ids[i];
    var h = homes[pid];
    var color = _startColor(D, pid);
    var pts = h.shape ? _startShapePoints(D, h.shape) : null;
    if (!pts) {
      console.warn('[render/start] no usable shape for ' + pid + "'s homeland; card only");
      continue;
    }

    // Two polygons per power: a fat soft stroke underneath that carries the
    // "this is selectable" glow, and the real one on top that takes the
    // events. Splitting them means the glow can grow on hover without the hit
    // area moving under the cursor.
    var glow = el('polygon', 'start-land-glow', { points: pts });
    glow.style.stroke = color;
    glows.appendChild(glow);

    var land = el('polygon', 'start-land', { points: pts, 'data-power': pid });
    land.style.fill = color;
    land.style.stroke = color;
    land.appendChild(el('title', null, { text: _startName(D, pid) + ' — ' + h.terrName }));
    lands.appendChild(land);

    // The capital, because it is literally everything the power starts with
    // (00-vision.md §6) and the card's "Berlin · 65" has to be findable.
    if (h.capPos && h.capPos.length >= 2) {
      var ring = el('circle', 'start-cap-ring', { cx: h.capPos[0], cy: h.capPos[1], r: 6.5 });
      ring.style.stroke = color;
      marks.appendChild(ring);
      var dot = el('circle', 'start-cap-dot', { cx: h.capPos[0], cy: h.capPos[1], r: 2.8 });
      dot.style.fill = color;
      marks.appendChild(dot);
    }

    // The country name in the power's colour, with the power's name under it.
    // The country is what you click and what map.js already labels; the power
    // is what you are choosing, and the two are not the same word for five of
    // the seven (Turkey / Ottoman Empire, Austria / Austria-Hungary…).
    if (h.label && h.label.length >= 2) {
      var nm = el('text', 'start-land-name', {
        x: h.label[0], y: h.label[1], text: h.terrName,
      });
      nm.style.fill = color;
      marks.appendChild(nm);
      marks.appendChild(el('text', 'start-land-power', {
        x: h.label[0], y: h.label[1] + 12, text: _startName(D, pid),
      }));
    }

    out[pid] = { land: land, glow: glow };
    _startWireLand(land, pid);
  }

  g.appendChild(glows);
  g.appendChild(lands);
  g.appendChild(marks);
  svg.appendChild(g);

  START_STATE.layer = g;
  return out;
}

function _startWireLand(land, pid) {
  land.addEventListener('mouseenter', function () { _startHot(pid); });
  land.addEventListener('mouseleave', function () { _startHot(null); });
  land.addEventListener('click', function (ev) {
    ev.preventDefault();
    _startChoose(pid, true);
  });
}

// ── the panel ────────────────────────────────────────────────────────────

function _startStat(label, value) {
  var s = el('span', 'start-stat');
  s.appendChild(el('span', 'start-stat-v', { text: String(value) }));
  s.appendChild(el('span', 'start-stat-k', { text: label }));
  return s;
}

function _startCard(D, pid, h) {
  var color = _startColor(D, pid);
  // The accessible name is spelled out rather than left to the concatenated
  // spans, which run together without the punctuation ("French RepublicDefensive
  // anchor that counterpunches63Paris8stations").
  var b = el('button', 'start-card', {
    type: 'button',
    'data-power': pid,
    'aria-label': _startName(D, pid) + ' — ' + (START_PLAYS[pid] || '') +
                  '. Capital ' + h.capName + ', ' + h.capUnits + ' units; ' +
                  h.stations + ' homeland stations, ' + h.producers + ' producers.',
  });

  var bar = el('span', 'start-card-bar');
  bar.style.background = color;
  b.appendChild(bar);

  var head = el('span', 'start-card-head');
  var dot = el('span', 'start-card-dot');
  dot.style.background = color;
  head.appendChild(dot);
  head.appendChild(el('span', 'start-card-name', { text: _startName(D, pid) }));
  b.appendChild(head);

  b.appendChild(el('span', 'start-card-plays', { text: START_PLAYS[pid] || '' }));
  b.appendChild(el('span', 'start-card-profile', { text: START_PROFILE[pid] || '' }));

  // Derived from data/, never typed: the opening garrison and the shape of the
  // homeland are what the character line above is a summary OF, so a station
  // added to Germany has to move both or the card starts lying.
  var stats = el('span', 'start-card-stats');
  stats.appendChild(_startStat(h.capName, h.capUnits));
  stats.appendChild(_startStat(h.stations === 1 ? 'station' : 'stations', h.stations));
  stats.appendChild(_startStat(h.producers === 1 ? 'producer' : 'producers', h.producers));
  b.appendChild(stats);

  b.addEventListener('mouseenter', function () { _startHot(pid); });
  b.addEventListener('mouseleave', function () { _startHot(null); });
  b.addEventListener('focus', function () { _startHot(pid); });
  b.addEventListener('blur', function () { _startHot(null); });
  // `false`: a card selects and never starts. See _startChoose.
  b.addEventListener('click', function () { _startChoose(pid, false); });

  return b;
}

function _startBuildDock(D, ids, homes) {
  var dock = el('aside', 'start-dock', {
    id: 'start-dock', 'aria-label': 'Choose your empire',
  });

  var head = el('header', 'start-head');
  head.appendChild(el('div', 'start-eyebrow', { text: 'Concert of Europe · 1914' }));
  head.appendChild(el('h1', 'start-title', { text: 'Choose your empire' }));
  head.appendChild(el('p', 'start-sub', {
    text: 'Every power opens holding one city — its capital — and nothing else. ' +
          'The rest of Europe is neutral and has to be taken. ' +
          'Click a homeland on the map, or a card below.',
  }));
  dock.appendChild(head);

  var list = el('div', 'start-cards');
  var cards = Object.create(null);
  for (var i = 0; i < ids.length; i++) {
    var pid = ids[i];
    cards[pid] = _startCard(D, pid, homes[pid]);
    list.appendChild(cards[pid]);
  }
  dock.appendChild(list);

  var foot = el('footer', 'start-actions');
  var go = el('button', 'btn start-go', { type: 'button', text: 'Take command' });
  go.addEventListener('click', function () { _startConfirm(); });
  foot.appendChild(go);
  foot.appendChild(el('p', 'start-note', {
    text: 'The game opens paused, so you can read the board before anything moves.',
  }));
  dock.appendChild(foot);

  START_STATE.dock = dock;
  START_STATE.go = go;
  START_STATE.cards = cards;

  // A sibling of the board inside .stage, so the board narrows instead of being
  // covered — the whole reason the map stays clickable. .rail is hidden by
  // `.app.is-choosing` while this is up, so the two never share the row.
  var stage = document.querySelector('.stage');
  (stage || document.querySelector('.app') || document.body).appendChild(dock);
  return dock;
}

// ── highlighting, both directions ────────────────────────────────────────
//
// Hovering a card lights its ground; hovering the ground lights its card. One
// function drives both, so they cannot disagree about which power is warm.

function _startPaint() {
  var pid = START_STATE.pid;
  var hot = START_STATE.hot;
  var k;

  if (START_STATE.cards) {
    for (k in START_STATE.cards) {
      var c = START_STATE.cards[k];
      c.classList.toggle('is-chosen', k === pid);
      c.classList.toggle('is-hot', k === hot);
      c.setAttribute('aria-pressed', k === pid ? 'true' : 'false');
    }
  }

  if (START_STATE.lands) {
    for (k in START_STATE.lands) {
      var rec = START_STATE.lands[k];
      rec.land.classList.toggle('is-chosen', k === pid);
      rec.land.classList.toggle('is-hot', k === hot);
      rec.glow.classList.toggle('is-chosen', k === pid);
      rec.glow.classList.toggle('is-hot', k === hot);
    }
  }
}

function _startHot(pid) {
  if (START_STATE.hot === pid) return;
  START_STATE.hot = pid;
  _startPaint();
}

// Clicking the ALREADY-chosen power a second time starts the game, and that is
// true on the MAP only. Two reasons for the split, and it is not arbitrary:
// after a map click the cursor is already out on the board, potentially a whole
// screen away from the button, so "click your country, click it again, you are
// playing" makes the map a complete input on its own; a card, meanwhile, sits
// three centimetres above a button that spells out exactly what it will do, and
// making the densest cluster of click targets on the screen able to start the
// game on a repeated click is how a player ends up in a war they were still
// reading about. `again` is passed false by every card.
function _startChoose(pid, again) {
  if (!pid) return;
  again = !!again && START_STATE.pid === pid;
  START_STATE.pid = pid;
  _startPaint();

  if (START_STATE.go) {
    var D = _startData();
    START_STATE.go.textContent = 'Take command of ' + _startName(D, pid);
  }
  if (again) _startConfirm();
}

function _startConfirm() {
  if (!START_STATE.showing || !START_STATE.pid) return;
  var pid = START_STATE.pid;
  var cb = START_STATE.onPick;

  // Torn down BEFORE the callback: app/main.js's bootPlay() calls initCamera(),
  // which measures #board, and the rail and the HUD come back with the panel.
  // Measuring the picking layout and then changing it would leave the camera's
  // fit rect describing a board that no longer exists.
  startScreenHide();
  // The opening camera is bootPlay()'s job, not ours — it is the one place a
  // game starts, and `?player=fra` reaches it without ever building this
  // screen. See startHomeBox() below, which is what it calls.
  if (typeof cb === 'function') cb(pid);
}

// You open holding exactly one city out of 108, and at 1x that city is a small
// disc somewhere in Europe. Framing the homeland is what makes the first thirty
// seconds legible: your capital, and the neutral cities close enough to be your
// first move. Returns null for a power with no drawable homeland, in which case
// the game opens on the whole board, which is the old behaviour.
//
// Read off render/map.js's OWN polygon in #g-territories, not off the picker's
// copy in #g-start. Two reasons. The picker's layer is gone by the time the
// game boots, so this keeps working after teardown — and `?player=fra` skips
// the picker entirely, so its layer never existed, and a homeland box that came
// from the picker would silently give that path a different opening view.
function startHomeBox(pid) {
  var D = _startData();
  var home = _startHome(D, pid);
  var tid = home && home.tid;
  if (!tid) return null;

  var poly = document.querySelector('#g-territories [data-territory="' + tid + '"]');
  if (!poly || typeof poly.getBBox !== 'function') return null;
  try {
    var b = poly.getBBox();
    return (b && b.width > 0 && b.height > 0)
      ? { x: b.x, y: b.y, width: b.width, height: b.height }
      : null;
  } catch (err) {
    return null;      // getBBox throws on an unrendered element in some engines
  }
}

// ── keys ─────────────────────────────────────────────────────────────────
//
// Enter confirms — but only when focus is NOT on one of our buttons, because a
// button already turns Enter into a click and handling it here as well would
// confirm the old choice a moment before the click selected the new one.

function _startOnKey(ev) {
  if (!START_STATE.showing) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key !== 'Enter') return;
  var a = document.activeElement;
  if (a && START_STATE.dock && START_STATE.dock.contains(a)) return;
  ev.preventDefault();
  _startConfirm();
}

// ── the pinned entry points ──────────────────────────────────────────────

// Returns true if the screen took over, false if it could not build — in which
// case app/main.js boots straight into the default power rather than leaving
// the player looking at a board that never starts.
function startScreenShow(onPick) {
  if (START_STATE.showing) return true;

  var D = _startData();
  var ids = _startPowerIds(D);
  if (!ids.length || !D.TERRITORIES) {
    console.warn('[render/start] no playable powers in POWERS — skipping the picker');
    return false;
  }

  var homes = Object.create(null);
  for (var i = 0; i < ids.length; i++) homes[ids[i]] = _startHome(D, ids[i]);

  var app = document.querySelector('.app');
  if (app) app.classList.add('is-choosing');

  START_STATE.showing = true;
  START_STATE.onPick = onPick;
  START_STATE.lands = _startBuildLayer(D, ids, homes) || Object.create(null);
  _startBuildDock(D, ids, homes);

  // Open on whatever app/main.js had already resolved PLAYER to, so the confirm
  // button always has a target and the default is the one the game has always
  // shipped with.
  var opening = (typeof PLAYER === 'string' && homes[PLAYER]) ? PLAYER : ids[0];
  _startChoose(opening, false);

  START_STATE.onKey = _startOnKey;
  document.addEventListener('keydown', START_STATE.onKey);

  console.log('[render/start] picker up — ' + ids.length + ' powers, opening on ' + opening);
  return true;
}

// Removal, not concealment. See the header, property 2.
function startScreenHide() {
  if (START_STATE.layer && START_STATE.layer.parentNode) {
    START_STATE.layer.parentNode.removeChild(START_STATE.layer);
  }
  if (START_STATE.dock && START_STATE.dock.parentNode) {
    START_STATE.dock.parentNode.removeChild(START_STATE.dock);
  }
  if (START_STATE.onKey) document.removeEventListener('keydown', START_STATE.onKey);

  // The camera is live during the pick — render/camera.js self-bootstraps on
  // DOMContentLoaded, long before boot() runs — and its controls are hidden by
  // the `.is-choosing` rules in style.css. Hiding a control does not undo a
  // zoom, though, so anyone who scrolled over the picker board would start the
  // game already zoomed, on a view they did not choose and cannot see the
  // controls for until the panel is gone. Reset before the class comes off.
  if (typeof cameraReset === 'function') cameraReset();

  var app = document.querySelector('.app');
  if (app) app.classList.remove('is-choosing');

  START_STATE.showing = false;
  START_STATE.layer = null;
  START_STATE.dock = null;
  START_STATE.go = null;
  START_STATE.cards = null;
  START_STATE.lands = null;
  START_STATE.onKey = null;
  START_STATE.hot = null;
}

// Global exports — no modules anywhere in this project.
window.startScreenShow = startScreenShow;
window.startScreenHide = startScreenHide;
window.startHomeBox = startHomeBox;
window.START_STATE = START_STATE;
