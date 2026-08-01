// test/devmark-tests.js — what the BOARD says about a development.
//
// Subject is render/map.js's `_mapDevDraw` and its call site. Cannot run in
// test/node.js: the node harness loads no render/ file except help.js and
// standings.js, so a "green suite" there is not evidence about this code at all
// (CLAUDE.md, the verification bar). It runs from tests-ui.html against the real
// index.html.
//
// ── why this file exists ────────────────────────────────────────────────
//
// Player report, 2026-08: *"the development dots are the same for fortifications
// vs port or factory — should there be any visual difference?"*
//
// They were. There had been a type glyph — a 4.4px F / P / K above the pip row —
// and screenshotting the shipped page at 800x900 measured it at 2 x 3 CSS
// PIXELS, drawn ON TOP of the city name, so Berlin rendered as "Berfin". A shape
// per kind was tried next and measured at deviceScaleFactor 1, where a square, a
// circle and a triangle at four pixels are the same blob — and zoom cannot save
// it, because CAM_SYMBOL_EXP is 1 and every symbol on this board holds a
// constant on-screen size.
//
// So the map now marks only developments that HAVE AN EFFECT — DEV_LIVE, the
// same data the readout and the AI read — which today is forts. That is the rule
// this file defends, and the reason it needs defending is that it is invisible:
// nothing else in the project fails if a port starts drawing pips again.
//
// ── what a DOM test can and cannot show here ────────────────────────────
//
// It can show WHICH nodes carry a pip row, how many pips, and how many are
// filled. It CANNOT show legibility — the two faults above were both found by
// screenshot and neither would have failed an assertion, because both rendered
// exactly the elements they were asked to. Said out loud so nobody reads a green
// here as "the mark is readable" (known-issue #18).
//
// Privates are prefixed `_dmk`, by FILE (known-issue #12).

'use strict';

// BARE GLOBAL NAMES, NOT window.X — known-issue #3, and this suite tripped over
// it on its first run. The test files are injected into the frame and share its
// global scope, so `LINKS` resolves; but `STATIONS` and `LINKS` are top-level
// `const` in data/stations.js and top-level const does NOT land on `window`.
// `window.LINKS` was undefined and the whole harness died with "cannot read
// properties of undefined" before a single assertion ran.
function _dmkWin() {
  return (typeof window !== 'undefined') ? window : null;
}

// The station <g> for one id, or null. `data-station` is the attribute
// render/map.js actually writes (drawStations), not a selector invented here.
function _dmkNode(doc, sid) {
  return doc.querySelector('#g-stations [data-station="' + sid + '"]');
}

function _dmkPips(doc, sid) {
  var g = _dmkNode(doc, sid);
  if (!g) return null;
  var all = g.querySelectorAll('.station-dev-pip');
  var shown = 0, filled = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].style.display === 'none') continue;
    shown++;
    if (all[i].classList.contains('is-on')) filled++;
  }
  var group = g.querySelector('.station-dev');
  var hidden = !group || group.style.display === 'none';
  return { shown: hidden ? 0 : shown, filled: hidden ? 0 : filled, group: !!group };
}

// Give `sid` to the player, fill it, build `kind` up to `tiers` times, then
// leave `keepFrac` x capacity standing so built and operating can differ.
function _dmkBuild(sid, kind, tiers, keepFrac) {
  setStationOwner(GAME, sid, PLAYER);
  for (var t = 0; t < tiers; t++) {
    GAME.stations[sid].units =
      (STATIONS[sid].capacity * 1.5);
    applyCommand(GAME, { type: 'build', owner: PLAYER, stations: [sid], kind: kind });
  }
  GAME.stations[sid].units =
    (STATIONS[sid].capacity * keepFrac);
}

// A station of each shape, found from the data. A hard-coded id is a test that
// breaks when the map is regenerated and does not say why.
function _dmkPick() {
  var sea = {};
  for (var l = 0; l < LINKS.length; l++) {
    if (LINKS[l].sea) { sea[LINKS[l].a] = true; sea[LINKS[l].b] = true; }
  }
  var out = { plain: null, producer: null, coastal: null };
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i], d = STATIONS[sid];
    if (!out.plain && d.type === 'holding' && !sea[sid]) out.plain = sid;
    if (!out.producer && d.type === 'producer' && !sea[sid]) out.producer = sid;
    if (!out.coastal && sea[sid] && d.type !== 'producer') out.coastal = sid;
  }
  return out;
}

function suiteDevMark() {
  var NAME = 'render / development mark';
  var w = _dmkWin();
  var missing = [];
  if (!w || typeof GAME === 'undefined' || !GAME) missing.push('a live GAME [index.html]');
  if (!w || typeof PLAYER === 'undefined' || !PLAYER) missing.push('PLAYER [app/main.js]');
  if (typeof renderBoard !== 'function') missing.push('renderBoard() [render/map.js]');
  if (typeof DEV_LIVE === 'undefined') missing.push('DEV_LIVE [sim/development.js]');
  if (typeof applyCommand !== 'function') missing.push('applyCommand() [sim/commands.js]');
  if (typeof LINKS === 'undefined' || typeof STATIONS === 'undefined' ||
      typeof STATION_IDS === 'undefined') missing.push('map data');
  if (missing.length) { skipSuite(NAME, 'waiting on ' + missing.join(', ')); return; }

  suite(NAME);
  var doc = w.document;
  var P = _dmkPick();

  test('the fixture found a station of each shape', function () {
    var gaps = Object.keys(P).filter(function (k) { return !P[k]; });
    assertNone(gaps, 'the map data has changed under this suite');
  });

  test('a fortification draws one pip per BUILT tier, filled to the OPERATING tier', function () {
    var sid = P.plain;
    _dmkBuild(sid, 'fort', 3, 0.3);        // fort caps at 2 off a capital
    renderBoard(GAME);
    var built = builtTier(GAME, sid), op = operatingTier(GAME, sid);
    assert(built >= 2, 'the fixture only reached built tier ' + built +
      ' at ' + sid + ' — with fewer than two pips the filled/hollow contrast ' +
      'this test is about cannot appear');
    assert(op < built, 'the fixture left operating (' + op + ') equal to built (' +
      built + ') at ' + sid + ', so every pip is filled and the GAP — which is the ' +
      'whole point of the mark — is not on screen to be checked');
    var pips = _dmkPips(doc, sid);
    assert(!!pips, 'no station node for ' + sid);
    assertEqual(pips.shown, built, 'pips shown at ' + sid + ' do not match the built tier');
    assertEqual(pips.filled, op, 'pips FILLED at ' + sid + ' do not match the operating tier');
  });

  test('a port and a factory draw nothing at all', function () {
    // The rule the player report produced: the board marks only developments
    // that have an effect, so an attacker reading a pip row is always reading a
    // fortification. Both kinds are checked, and both are asserted to be
    // genuinely BUILT first — a test that passes because the build failed would
    // be measuring nothing (known-issue #8).
    var problems = [];
    var cases = [{ sid: P.coastal, kind: 'port' }, { sid: P.producer, kind: 'factory' }];
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      _dmkBuild(c.sid, c.kind, 1, 1.0);
      renderBoard(GAME);
      if (developmentKind(GAME, c.sid) !== c.kind) {
        problems.push('the fixture failed to build a ' + c.kind + ' at ' + c.sid +
          ', so "it drew nothing" proves nothing');
        continue;
      }
      if (DEV_LIVE[c.kind]) {
        problems.push(c.kind + ' is now live in DEV_LIVE — it SHOULD draw, and this ' +
          'test needs rewriting rather than the renderer');
        continue;
      }
      var pips = _dmkPips(doc, c.sid);
      if (pips && pips.shown !== 0) {
        problems.push(c.kind + ' at ' + c.sid + ' drew ' + pips.shown +
          ' pips; a mark with no effect behind it tells an attacker a city is ' +
          'defended when it is not');
      }
    }
    assertNone(problems, 'the board marked a development that does nothing');
  });

  test('nothing on the board is still drawing a type glyph', function () {
    // The 2 x 3 pixel F / P / K, which also overprinted the city name. Asserted
    // as an ABSENCE because that is the only shape this defect has: it rendered
    // exactly the element it was asked to, and every other assertion passed.
    assertEqual(doc.querySelectorAll('.station-dev-glyph').length, 0,
      'a .station-dev-glyph is back on the board — it measures 2x3 CSS pixels at ' +
      '800px and lands on top of the station name');
  });

  test('the mark is not drawn over the board in a way that can eat a click', function () {
    // known-issue #5, five occurrences. The pip group sits above the node, so a
    // default pointer-events would swallow the click that commits an attack —
    // silently, with no error and no console output.
    var sid = P.plain;
    var g = _dmkNode(doc, sid);
    var group = g ? g.querySelector('.station-dev') : null;
    assert(!!group, 'no .station-dev group at ' + sid + ' to check');
    assertEqual(getComputedStyle(group).pointerEvents, 'none',
      'the development mark accepts pointer events');
  });
}
