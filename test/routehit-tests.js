// test/routehit-tests.js — the supply route as a CLICK TARGET.
//
// Subject is render/map.js's `.station-orderhit` stroke and render/select.js's
// `selOrderSourceAt` / `selTerritoryAt`. Cannot run in test/node.js: it is
// entirely about what `document.elementFromPoint` returns on a laid-out board,
// which is the only place this class of defect is ever visible. Runs from
// tests-ui.html against the real index.html.
//
// ── why this file exists ────────────────────────────────────────────────
//
// 05-command-clarity.md §2, on the player's *"tough to click"*: a transparent
// wide stroke behind each route is the standard fix — **and it must be
// `pointer-events` aware**, because a fat invisible click target laid over the
// board is precisely the bug that has bitten this project five times and
// produces no error, only a game that silently stops committing attacks
// (known-issue #5).
//
// §2 also said, in those words, *"to be measured before it is fixed"*. It was,
// on the shipped page at 800x900 with 14 routes drawn:
//
//   a 12px band around a route overlaps a station symbol   28.1% of its area
//   station centres stolen by a 12px hit stroke            0 of 44
//   route length that becomes reachable                    70.7%
//
// The first two numbers only look compatible once you know WHY: routes are
// built into `#g-links`, which sits below `#g-stations`, so every pixel the two
// share resolves to the station. The safety is structural, and this suite
// exists because structure is exactly the kind of thing a later edit moves
// without noticing.
//
// ── the regression this suite caught before it shipped ──────────────────
//
// `selTerritoryAt()` read `evt.target.closest('[data-territory]')`. The hit
// stroke is the first thing over the board that accepts a pointer, so anywhere
// a route crossed a country the event target was the ROUTE and the lookup came
// back null — double-click-to-select-a-country did nothing, silently, on
// exactly the borders a player is most likely to be managing. It now resolves
// through `elementsFromPoint`, which is written against any overlay rather than
// against this one.
//
// Privates are prefixed `_rht`, by FILE (known-issue #12).

'use strict';

function _rhtWin() {
  return (typeof window !== 'undefined') ? window : null;
}

// Build a real supply network: a connected blob for the player, every city
// pointed at an owned neighbour, so routes follow real links over real
// territories. Returns the ids it gave away.
function _rhtNetwork(n) {
  var adj = {};
  for (var i = 0; i < LINKS.length; i++) {
    (adj[LINKS[i].a] = adj[LINKS[i].a] || []).push(LINKS[i].b);
    (adj[LINKS[i].b] = adj[LINKS[i].b] || []).push(LINKS[i].a);
  }
  var own = [POWERS[PLAYER].capital], grew = true, j, sid;
  while (own.length < n && grew) {
    grew = false;
    for (j = 0; j < STATION_IDS.length && own.length < n; j++) {
      sid = STATION_IDS[j];
      if (own.indexOf(sid) >= 0) continue;
      var touches = false;
      var nb = adj[sid] || [];
      for (var k = 0; k < nb.length; k++) if (own.indexOf(nb[k]) >= 0) { touches = true; break; }
      if (!touches) continue;
      own.push(sid);
      grew = true;
    }
  }
  for (j = 0; j < own.length; j++) {
    setStationOwner(GAME, own[j], PLAYER);
    GAME.stations[own[j]].units = STATIONS[own[j]].capacity * 0.9;
  }
  for (j = 0; j < own.length; j++) {
    var t = (adj[own[j]] || []).filter(function (x) { return own.indexOf(x) >= 0; });
    if (t.length) {
      applyCommand(GAME, { type: 'order', owner: PLAYER, stations: [own[j]], target: t[0] });
    }
  }

  // ONE SEA CROSSING, deliberately. render/map.js only re-derives a route's `d`
  // where its arcs BOW to clear the station symbols, and a land hop is straight
  // — so on an all-land network every path is byte-identical at every zoom and
  // the camera-repath test below has nothing to observe. Its vacuity guard
  // caught exactly that and is the reason this block exists.
  for (var L = 0; L < LINKS.length; L++) {
    if (!LINKS[L].sea) continue;
    var a1 = LINKS[L].a, b1 = LINKS[L].b;
    setStationOwner(GAME, a1, PLAYER);
    setStationOwner(GAME, b1, PLAYER);
    GAME.stations[a1].units = STATIONS[a1].capacity * 0.9;
    GAME.stations[b1].units = STATIONS[b1].capacity * 0.9;
    if (own.indexOf(a1) < 0) own.push(a1);
    if (own.indexOf(b1) < 0) own.push(b1);
    applyCommand(GAME, { type: 'order', owner: PLAYER, stations: [a1], target: b1 });
    break;
  }

  stepTicks(GAME, 30);
  renderBoard(GAME);
  return own;
}

// Client-space points along one path element.
function _rhtWalk(pathEl, step) {
  var out = [];
  var total = pathEl.getTotalLength();
  var m = pathEl.getScreenCTM();
  if (!(total > 0) || !m) return out;
  var n = Math.max(4, Math.round(total / (step || 3)));
  for (var i = 0; i <= n; i++) {
    var p = pathEl.getPointAtLength((total * i) / n);
    var x = m.a * p.x + m.c * p.y + m.e;
    var y = m.b * p.x + m.d * p.y + m.f;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
    out.push([x, y]);
  }
  return out;
}

function suiteRouteHit() {
  var NAME = 'render / route hit target';
  var w = _rhtWin();
  var missing = [];
  if (!w || typeof GAME === 'undefined' || !GAME) missing.push('a live GAME [index.html]');
  if (!w || typeof PLAYER === 'undefined' || !PLAYER) missing.push('PLAYER [app/main.js]');
  if (typeof renderBoard !== 'function') missing.push('renderBoard() [render/map.js]');
  if (typeof selTerritoryAt !== 'function') missing.push('selTerritoryAt() [render/select.js]');
  if (typeof selOrderSourceAt !== 'function') missing.push('selOrderSourceAt() [render/select.js]');
  if (typeof applyCommand !== 'function') missing.push('applyCommand() [sim/commands.js]');
  if (missing.length) { skipSuite(NAME, 'waiting on ' + missing.join(', ')); return; }

  suite(NAME);
  var doc = w.document;
  _rhtNetwork(14);

  // QUERIED FRESH PER TEST, never captured once at suite build. renderBoard()
  // rebuilds the whole station layer, so a node array captured up here is
  // DETACHED the moment any test re-renders — and a detached path returns a
  // null CTM, so every later test silently samples zero points and passes its
  // assertions by having nothing to check. That happened, and the vacuity
  // guards are the only reason it was visible.
  function nowRoutes() {
    return Array.prototype.slice.call(doc.querySelectorAll('.station-orderroute'));
  }
  function nowHits() {
    return Array.prototype.slice.call(doc.querySelectorAll('.station-orderhit'));
  }

  test('the fixture actually drew supply routes', function () {
    var routes = nowRoutes();
    assert(routes.length >= 6,
      'only ' + routes.length + ' routes on the board — every assertion below ' +
      'would be measuring an empty set (known-issue #8)');
  });

  test('every route carries a hit stroke naming its source, on the same path', function () {
    var problems = [], routes = nowRoutes(), hits = nowHits();
    assertEqual(hits.length, routes.length, 'routes and hit strokes disagree in number');
    for (var i = 0; i < routes.length; i++) {
      var hit = routes[i].querySelector('.station-orderhit');
      var line = routes[i].querySelector('.station-orderline');
      if (!hit) { problems.push('route ' + i + ' has no hit stroke'); continue; }
      var from = hit.getAttribute('data-orderfrom');
      if (!from || !STATIONS[from]) {
        problems.push('route ' + i + ' hit stroke names "' + from + '", not a station');
      }
      // The two paths must not be able to drift: a hit target sitting off its
      // own line is invisible until somebody hovers the wrong pixel.
      if (line && hit.getAttribute('d') !== line.getAttribute('d')) {
        problems.push('route ' + i + ' hit stroke is on a different path from its line');
      }
      // FIRST CHILD, so it paints under the line it shadows rather than over it.
      if (routes[i].firstChild !== hit) {
        problems.push('route ' + i + ' hit stroke is not the first child — it will ' +
                      'paint over the line and tint it');
      }
    }
    assertNone(problems, 'the hit stroke does not match the route it belongs to');
  });

  test('the hit stroke takes the STROKE only, never the enclosed area', function () {
    // A route that doubles back encloses a region. `pointer-events: all` would
    // make that whole region swallow pointers — known-issue #5, and the version
    // of it that is hardest to see because it depends on the route's shape.
    var problems = [], hits = nowHits();
    for (var i = 0; i < hits.length; i++) {
      var pe = w.getComputedStyle(hits[i]).pointerEvents;
      if (pe !== 'stroke') problems.push('hit stroke ' + i + ' has pointer-events: ' + pe);
      var fill = w.getComputedStyle(hits[i]).fill;
      if (fill !== 'none') problems.push('hit stroke ' + i + ' has a fill (' + fill + ')');
    }
    assertNone(problems, 'the hit stroke is grabbing more than its own stroke');
  });

  test('NO station centre is stolen by the hit stroke — known-issue #5', function () {
    // THE ONE THAT MATTERS. Routes live in #g-links, below #g-stations, so a
    // station must win every pixel the two share. If this ever goes red the
    // click that commits an attack is being eaten, with no error and no console
    // output, which is the exact failure mode #5 records five times.
    var problems = [], checked = 0;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      var shape = doc.querySelector('#g-stations [data-station="' + sid + '"] .station-shape');
      if (!shape) continue;
      var r = shape.getBoundingClientRect();
      if (!(r.width > 0)) continue;
      var x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (x < 0 || y < 0 || x > w.innerWidth || y > w.innerHeight) continue;
      checked++;
      var el = doc.elementFromPoint(x, y);
      if (el && el.closest && el.closest('.station-orderhit')) {
        problems.push(sid + ' centre resolves to a route hit stroke');
      }
    }
    assert(checked >= 20, 'only ' + checked + ' station centres were reachable — ' +
      'this test asserts nothing');
    assertNone(problems, 'a supply route is eating station clicks');
  });

  test('hovering a route resolves to a city that really owns a supply line', function () {
    // NOT "the source of the stroke I walked". Supply routes SHARE corridors —
    // two cities feeding along the same link draw two lines over each other —
    // so elementFromPoint correctly returns whichever is on top, which may not
    // be the one this loop is walking. The first version of this test asserted
    // otherwise and went red on exactly that: "a point on ber's route resolved
    // to bre". The code was right; the assertion was wrong.
    //
    // What must hold is that the answer names the source of the stroke ACTUALLY
    // under the cursor, and that that city is really running a supply line.
    var problems = [], hovered = 0, seen = {}, hits = nowHits();
    for (var i = 0; i < hits.length; i++) {
      var pts = _rhtWalk(hits[i], 3);
      for (var j = 0; j < pts.length; j++) {
        var el = doc.elementFromPoint(pts[j][0], pts[j][1]);
        var onHit = (el && el.closest) ? el.closest('.station-orderhit') : null;
        if (!onHit) continue;
        hovered++;
        var got = selOrderSourceAt({ target: el, clientX: pts[j][0], clientY: pts[j][1] });
        seen[got] = true;
        if (got !== onHit.getAttribute('data-orderfrom')) {
          problems.push('resolved ' + got + ' for a stroke belonging to ' +
                        onHit.getAttribute('data-orderfrom'));
        } else if (!got || !GAME.stations[got]) {
          problems.push('resolved "' + got + '", which is not a station on the board');
        } else {
          var sup = GAME.stations[got].supplyTo;
          if (!sup || !sup.length) {
            problems.push(got + ' was named by a route hover but supplies nowhere');
          }
        }
        break;
      }
    }
    assert(hovered >= 4, 'only ' + hovered + ' routes were reachable at all — the ' +
      'hit stroke is not catching the pointer anywhere');
    // NON-VACUITY: a function that returned one constant city, or null, would
    // satisfy everything above on a single-route sample.
    assert(Object.keys(seen).length >= 3,
      'every reachable route resolved to the same ' + Object.keys(seen).length +
      ' city/cities — the hover is not distinguishing routes at all');
    assertNone(problems, 'a route hover named the wrong city');
  });

  test('a station under the pointer still beats the route it sits on', function () {
    // The hit stroke may only answer for pixels no station claims. Asserted
    // through selOrderSourceAt's real caller condition rather than by trusting
    // z-order twice.
    var problems = [], checked = 0, hits = nowHits();
    for (var i = 0; i < hits.length; i++) {
      var pts = _rhtWalk(hits[i], 2);
      for (var j = 0; j < pts.length; j++) {
        var el = doc.elementFromPoint(pts[j][0], pts[j][1]);
        if (!el || !el.closest) continue;
        var onStation = !!el.closest('[data-station]');
        var onHit = !!el.closest('.station-orderhit');
        if (onStation && onHit) {
          problems.push('a point resolves to a station AND a hit stroke at once');
        }
        if (onStation) checked++;
      }
    }
    assert(checked > 0, 'no sampled route point landed on a station — the overlap ' +
      'this test is about did not occur in the fixture');
    assertNone(problems, 'a pixel belongs to two click targets');
  });

  test('the hit stroke follows its line through a camera change', function () {
    // MUTATION SURVIVED WITHOUT THIS. Every other assertion here runs at scale
    // 1, so `mapOrderRepath`'s branch — the one that rewrites both paths when a
    // zoom changes where the arcs bow — never executed, and disabling the hit
    // stroke's half of it changed nothing any test could see. A hit target that
    // has drifted off its own line is invisible until somebody hovers the wrong
    // pixel, which is the whole class of defect this file exists for.
    //
    // Driven through cameraFocus(), not the zoom BUTTON: the button is another
    // suite's subject, and a test that silently does nothing because it could
    // not find a control is the failure this file keeps warning about.
    if (typeof cameraFocus !== 'function' || typeof cameraScale !== 'function' ||
        typeof cameraReset !== 'function') {
      return skipTest('camera repath', 'render/camera.js is not loaded');
    }
    var before = {};
    var live = doc.querySelectorAll('.station-orderroute');
    for (var i = 0; i < live.length; i++) {
      var h0 = live[i].querySelector('.station-orderhit');
      if (h0) before[i] = h0.getAttribute('d');
    }

    var scale0 = cameraScale();
    try {
      // A small box forces the biggest zoom the camera allows.
      // NO renderBoard() HERE, and that is the entire point. renderBoard()
      // rebuilds the route layer from scratch, so both paths come out freshly
      // built and identical no matter what mapOrderRepath does — which masked
      // the mutation this test exists to catch. The camera's own
      // onCameraChange subscriber calls mapOrderRepath synchronously; that is
      // the code path under test, so let it be the only one that runs.
      cameraFocus({ x: 380, y: 300, width: 60, height: 60 }, 1, 4);

      assert(cameraScale() > scale0 + 1e-9,
        'cameraFocus did not zoom (scale ' + scale0 + ' -> ' + cameraScale() +
        '), so nothing below was exercised');

      var problems = [], moved = 0;
      var now = doc.querySelectorAll('.station-orderroute');
      for (var j = 0; j < now.length; j++) {
        var h = now[j].querySelector('.station-orderhit');
        var l = now[j].querySelector('.station-orderline');
        if (!h || !l) { problems.push('route ' + j + ' lost a path on zoom'); continue; }
        if (h.getAttribute('d') !== l.getAttribute('d')) {
          problems.push('route ' + j + ' hit stroke drifted off its line after a zoom');
        }
        if (before[j] !== undefined && before[j] !== h.getAttribute('d')) moved++;
      }
      assertNone(problems, 'the hit target and the line it shadows disagree');
      // VACUITY. render/map.js only re-derives `d` where a route's arcs BOW to
      // clear the station symbols, and a straight land hop produces the identical
      // path at every scale — so on an all-land network this test would compare
      // two things nothing had asked to change. The fixture puts one order
      // across a sea link for exactly this reason.
      assert(moved > 0, 'zooming changed no route path at all, so the repath ' +
        'branch this test is about never ran');
    } finally {
      // RESTORED, and the first version of this test did not do it — it left the
      // camera at 4x and the next test found zero routes under the pointer.
      cameraReset();
      renderBoard(GAME);
    }
  });

  test('double-click-to-select-a-country still works where a route crosses it', function () {
    // THE REGRESSION THIS SUITE CAUGHT. selTerritoryAt() read
    // `evt.target.closest('[data-territory]')`, and the hit stroke is the first
    // thing over the board that accepts a pointer — so on every pixel of every
    // route the country lookup came back null and the gesture silently did
    // nothing.
    var problems = [], onRoute = 0, hits = nowHits();
    for (var i = 0; i < hits.length; i++) {
      var pts = _rhtWalk(hits[i], 4);
      for (var j = 0; j < pts.length; j++) {
        var el = doc.elementFromPoint(pts[j][0], pts[j][1]);
        if (!el || !el.closest || !el.closest('.station-orderhit')) continue;
        // Is a country actually THERE, under whatever is on top? A route over
        // open sea correctly resolves to nothing — the fixture deliberately
        // includes one sea crossing, and asserting "every route point has a
        // country" failed on it. The claim is narrower and is the real one: the
        // route must not HIDE a country that is under the cursor.
        var stack = doc.elementsFromPoint(pts[j][0], pts[j][1]) || [];
        var want = null;
        for (var q = 0; q < stack.length; q++) {
          var poly = stack[q] && stack[q].closest ? stack[q].closest('[data-territory]') : null;
          if (poly) { want = poly.getAttribute('data-territory'); break; }
        }
        if (!want) continue;                 // genuinely over water
        onRoute++;
        var terr = selTerritoryAt({ target: el, clientX: pts[j][0], clientY: pts[j][1] });
        if (terr !== want) {
          problems.push('a route over ' + want + ' resolved to ' + terr);
        }
        break;
      }
    }
    assert(onRoute >= 4, 'only ' + onRoute + ' points landed on a hit stroke — the ' +
      'condition that broke the gesture was never reproduced');
    assertNone(problems, 'a supply route is swallowing the country double-click');
  });
}
