// test/wavefog-tests.js — the RENDERER's copy of the wave-vision question.
//
// Subject is `mapFogLevels()` in render/map.js, and specifically its memo key.
// Cannot run in test/node.js: the node harness loads no render/ file except
// help.js and standings.js, so a green there is not evidence about this code at
// all (CLAUDE.md, the verification bar). It runs from tests-ui.html against the
// real index.html.
//
// ── why this file exists ────────────────────────────────────────────────
//
// B2 made a WAVE a source of sight (core/vision.js, `_visWaves`). Every
// assertion about that lives in test/fog-tests.js and runs headless. None of it
// can see the bug this file is about, because the bug is not in the rule.
//
// render/map.js does not call visibleTo per frame. It memoises the answer on
// (state, tick, ownerEpoch, pid) — a key that was exact and total while every
// source of sight was a STATION, since nothing can change what a station sees
// without moving a station. A wave breaks it: `send` from render/select.js is
// IMMEDIATE, so a player who marches out of a paused board creates a wave with
// the tick and the epoch both unmoved, and the memo hands back the fog from
// before the army existed. The sim would be right, `visibleTo` would be right,
// and the board would simply not light up.
//
// That failure has the exact shape known-issue #18 describes: a readout
// answering a different question from the one on screen, with nothing anywhere
// going red. So the key grew `nextWaveId` (every creation) and `waves.length`
// (every removal), and this suite is what holds them there.
//
// ── what this suite deliberately does NOT use ───────────────────────────
//
// The live GAME. These tests build their own state with newGame() so the tick
// and the epoch can be held STILL — against a running board the memo would be
// invalidated by the clock every tick and the whole defect would be masked. The
// board being still is the test.
//
// Privates are prefixed `_wfg`, by FILE (known-issue #12).

'use strict';

// BARE GLOBAL NAMES, NOT window.X — known-issue #3. STATION_IDS, LINKS and
// STATIONS do not land on `window`, and test/devmark-tests.js died on exactly
// that before a single assertion ran.

// A link with BOTH ends dark for `pid`, so a wave standing on it is revealing
// something rather than confirming something. Returns [a, b] or null.
function _wfgDarkLink(vis) {
  for (var i = 0; i < LINKS.length; i++) {
    var l = LINKS[i];
    if (vis[l.a] === 0 && vis[l.b] === 0) return [l.a, l.b];
  }
  return null;
}

// A still board seen through `pid`'s eyes. Nothing steps it.
function _wfgBoard(seed, pid) {
  var s = newGame(seed);
  s.human = pid;
  s.aiEnabled = false;
  s.paused = true;
  return s;
}

function _wfgWave(s, pid, a, b) {
  var w = {
    id: s.nextWaveId++, owner: pid, from: a, to: b, path: [a, b], hop: 0,
    progress: 0.5, units: { infantry: 9, artillery: 0, armour: 0 },
    launchTick: s.tick, eta: 40,
  };
  s.waves.push(w);
  return w;
}

function suiteWaveFog() {
  var NAME = 'render / wave fog cache';
  var missing = [];
  if (typeof mapFogLevels !== 'function') missing.push('mapFogLevels() [render/map.js]');
  if (typeof visibleTo !== 'function') missing.push('visibleTo() [core/vision.js]');
  if (typeof newGame !== 'function') missing.push('newGame() [core/state.js]');
  if (typeof LINKS === 'undefined' || typeof STATION_IDS === 'undefined') missing.push('map data');
  if (missing.length) { skipSuite(NAME, 'waiting on ' + missing.join(', ')); return; }

  suite(NAME);

  var pid = null;
  for (var i = 0; i < POWER_IDS.length; i++) {
    if (POWER_IDS[i] !== 'neutral') { pid = POWER_IDS[i]; break; }
  }

  test('the fixture has a road nobody can see down', function () {
    var s = _wfgBoard(7401, pid);
    var link = _wfgDarkLink(visibleTo(s, pid));
    assert(!!link, 'every link on this map has a lit end for ' + pid + ' — there is ' +
      'nothing a column could reveal, and every assertion below would pass with ' +
      'the whole feature deleted');
  });

  test('a wave created with the clock STOPPED still clears the fog', function () {
    // The defect, stated as a board: paused game, player sends, nothing moves
    // except state.waves. Tick and ownerEpoch are asserted unchanged at the end
    // so a future implementation cannot pass this by bumping the clock.
    var s = _wfgBoard(7401, pid);
    var link = _wfgDarkLink(visibleTo(s, pid));
    assert(!!link, 'no dark link');
    if (!link) return;

    var tick0 = s.tick, epoch0 = s.ownerEpoch;
    var before = mapFogLevels(s);                 // warms the memo
    assert(!!before, 'mapFogLevels returned nothing — is state.human set?');
    if (!before) return;
    assertEqual(before[link[1]], 0, link[1] + ' was already lit for ' + pid);

    _wfgWave(s, pid, link[0], link[1]);

    // The control comes FIRST. If the rule itself is broken, the assertion
    // below fails for a reason that has nothing to do with this file, and the
    // message would send the next reader to the wrong subsystem.
    assertEqual(visibleTo(s, pid)[link[1]], 2,
      'core/vision.js is not lighting the hop at all — this is a fog-tests.js ' +
      'failure showing up here, not a cache failure');

    assertEqual(mapFogLevels(s)[link[1]], 2,
      'the renderer is still serving the fog from before the army existed. A ' +
      'send is immediate, so on a paused board the tick and the epoch do not ' +
      'move and the memo key never notices the wave.');
    assertEqual(s.tick, tick0, 'the test moved the clock; it proves nothing');
    assertEqual(s.ownerEpoch, epoch0, 'the test moved a station; it proves nothing');
  });

  test('and the fog closes again when the column is gone', function () {
    // Creation is caught by nextWaveId, which only ever goes up. Removal has to
    // be caught by something else or a destroyed column would light its road
    // forever — on a paused board, permanently.
    var s = _wfgBoard(7401, pid);
    var link = _wfgDarkLink(visibleTo(s, pid));
    assert(!!link, 'no dark link');
    if (!link) return;

    _wfgWave(s, pid, link[0], link[1]);
    assertEqual(mapFogLevels(s)[link[1]], 2, 'fixture: the road was never lit');

    s.waves.length = 0;                           // the column is destroyed
    assertEqual(visibleTo(s, pid)[link[1]], 0, 'core/vision.js still lights it');
    assertEqual(mapFogLevels(s)[link[1]], 0,
      'the road is still lit with nothing on it — the memo key sees creations ' +
      'and not removals, so sight became memory in the one place that must ' +
      'never hold any');
  });

  test('a rival column does not clear the fog the renderer draws', function () {
    // mapFogLevels is keyed on the VIEWER as well, and the wave fields are not.
    // A key that noticed "a wave changed" without noticing whose would repaint
    // correctly here by accident; this asserts the answer, not the repaint.
    var s = _wfgBoard(7401, pid);
    var link = _wfgDarkLink(visibleTo(s, pid));
    assert(!!link, 'no dark link');
    if (!link) return;
    var other = null;
    for (var i = 0; i < POWER_IDS.length; i++) {
      if (POWER_IDS[i] !== 'neutral' && POWER_IDS[i] !== pid) { other = POWER_IDS[i]; break; }
    }
    assert(!!other, 'only one power');
    if (!other) return;

    mapFogLevels(s);
    _wfgWave(s, other, link[0], link[1]);
    assertEqual(mapFogLevels(s)[link[1]], 0,
      other + '\'s column is clearing ' + pid + '\'s fog on screen');
  });
}
