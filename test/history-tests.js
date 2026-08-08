// test/history-tests.js — the recording the end-screen chart is drawn from.
//
// Subject is `_vicRecordHistory` in sim/victory.js and `state.history`.
//
// ── why this is in the SIM and not in the renderer ──────────────────────
//
// It would have been half the code to sample on a frame in render/victory.js,
// and it would have been wrong. rAF does not fire in a hidden document
// (known-issue #10) and does not fire while the game is paused, so a
// renderer-side series would have holes wherever the player looked away, and
// the chart would be a picture of when somebody was watching rather than of how
// the game went. Under lockstep it would also differ between two clients
// watching the same game.
//
// The cost of putting it in state is that it is now part of every snapshot and
// therefore part of the pinned balance hashes, which had to move. That was
// measured rather than argued: at 12,000 ticks on seeds 100-103, deleting
// `history` from the new snapshot makes it BYTE-IDENTICAL to the old one on all
// four seeds. A pure shape change with no behavioural component — the one case
// known-issue #27 says the four-seed board diff is still a valid instrument
// for.
//
// Privates are prefixed `_hst`, by FILE (known-issue #12).

'use strict';

function _hstNeed(name) {
  var missing = [];
  if (typeof newGame !== 'function') missing.push('newGame() [core/state.js]');
  if (typeof stepTick !== 'function') missing.push('stepTick() [sim/step.js]');
  if (typeof victoryTick !== 'function') missing.push('victoryTick() [sim/victory.js]');
  if (typeof snapshot !== 'function') missing.push('snapshot() [core/state.js]');
  if (typeof BAL === 'undefined' || !BAL.HISTORY) missing.push('BAL.HISTORY [data/tuning.js]');
  if (typeof POWER_IDS === 'undefined' || typeof STATION_IDS === 'undefined') {
    missing.push('map data');
  }
  if (missing.length) { skipSuite(name, 'waiting on ' + missing.join(', ')); return false; }
  return true;
}

function _hstRun(seed, ticks) {
  var s = newGame(seed);
  for (var i = 0; i < ticks; i++) stepTick(s);
  return s;
}

function suiteHistory() {
  var NAME = 'sim / history';
  if (!_hstNeed(NAME)) return;
  suite(NAME);

  var H = BAL.HISTORY;

  test('a sample lands on every INTERVAL_TICKS, starting at tick 0', function () {
    var s = _hstRun(9101, 1000);
    var h = s.history;
    assert(!!h, 'no history was recorded at all');
    assert(h.t.length > 4, 'only ' + h.t.length + ' samples in 1000 ticks — nothing to check');
    var bad = [];
    for (var i = 0; i < h.t.length; i++) {
      if (h.t[i] !== i * h.every) bad.push('sample ' + i + ' is at tick ' + h.t[i]);
    }
    assertNone(bad, 'the samples are not on a fixed interval');
    assertEqual(h.every, H.INTERVAL_TICKS, 'the interval is not the tuned one');
    // The tick a sample lands on must be the tick the board was in, not one
    // either side: victoryTick runs LAST, so the sample is the settled board.
    assertEqual(h.t[0], 0, 'the first sample is not the opening position');
  });

  test('every power has one value per sample, and neutral has none', function () {
    var s = _hstRun(9102, 900);
    var h = s.history;
    var n = h.t.length, problems = [];
    var pids = Object.keys(h.p).sort();
    for (var i = 0; i < pids.length; i++) {
      var r = h.p[pids[i]];
      if (r.terr.length !== n) problems.push(pids[i] + ' terr has ' + r.terr.length + ' of ' + n);
      if (r.force.length !== n) problems.push(pids[i] + ' force has ' + r.force.length + ' of ' + n);
      if (r.dev.length !== n) problems.push(pids[i] + ' dev has ' + r.dev.length + ' of ' + n);
    }
    assertNone(problems, 'a series is out of step with the tick axis');
    assert(!h.p.neutral,
      'neutral has a history series — it is scenery, never a competitor, and a ' +
      'line for it would dominate every chart from tick 0');
    // Every real power is present, including ones that die later: a chart that
    // dropped a power when it fell would erase exactly the story worth seeing.
    var real = POWER_IDS.filter(function (p) { return p !== 'neutral'; });
    var absent = real.filter(function (p) { return !h.p[p]; });
    assertNone(absent, 'a power has no series');
  });

  test('the numbers are the board — territory, forces and BUILT development', function () {
    var s = _hstRun(9103, 720);
    var h = s.history;
    var last = h.t.length - 1;
    assertEqual(h.t[last], last * h.every, 'the last sample is not where it claims');

    // Re-derived from the board rather than trusted — and stepped to h.t[last]
    // PLUS ONE, which is the off-by-one this test was written with and which
    // its own force comparison caught.
    //
    // `state.tick` names the tick ABOUT TO RUN (stepTick increments at the
    // end), and victoryTick is the LAST phase. So the sample labelled tick T is
    // taken after T's growth, movement and combat have all resolved — i.e. at
    // the END of tick T, which is T+1 stepTicks in. Stopping at T leaves the
    // board one growth phase short, which territory and development are far too
    // coarse to notice and forces show immediately.
    var s2 = _hstRun(9103, h.t[last] + 1);
    var problems = [];
    var pids = Object.keys(h.p).sort();
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i], terr = 0, dev = 0;
      for (var j = 0; j < STATION_IDS.length; j++) {
        var st = s2.stations[STATION_IDS[j]];
        if (st.owner !== pid) continue;
        terr++;
        if (st.development && st.development.tier > 0) dev += st.development.tier;
      }
      if (h.p[pid].terr[last] !== terr) {
        problems.push(pid + ' terr recorded ' + h.p[pid].terr[last] + ', board says ' + terr);
      }
      if (h.p[pid].dev[last] !== dev) {
        problems.push(pid + ' dev recorded ' + h.p[pid].dev[last] + ', board says ' + dev);
      }
      var f = powerForces(s2, pid);
      if (Math.abs(h.p[pid].force[last] - f) > 1e-9) {
        problems.push(pid + ' force recorded ' + h.p[pid].force[last] + ', board says ' + f);
      }
    }
    assertNone(problems, 'a recorded number disagrees with the board it came from');
  });

  test('development counts BUILT tiers, not what is currently operating', function () {
    // The distinction is the whole of 04-development.md §4: a tier-3 fortress
    // held by a skeleton garrison OPERATES at 1. The chart is a record of
    // investment and must not dip when a city is temporarily under-garrisoned,
    // or a player reading it would see a fortification they never lost vanish.
    var s = newGame(9104);
    var sid = STATION_IDS[0];
    setStationOwner(s, sid, 'ger');
    s.stations[sid].units = STATIONS[sid].capacity * 1.5;
    var res = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assert(res.ok, 'the fixture could not build: ' + JSON.stringify(res.rejected));
    // Strip the garrison so built and operating disagree — the vacuity guard.
    s.stations[sid].units = 0;
    assert(builtTier(s, sid) > 0, 'nothing was built');
    assertEqual(operatingTier(s, sid), 0, 'the fixture did not separate built from operating');

    s.history = null;
    s.tick = 0;
    victoryTick(s);
    assert(s.history.p.ger.dev[0] >= builtTier(s, sid),
      'the recorded development (' + s.history.p.ger.dev[0] + ') is below the BUILT tier (' +
      builtTier(s, sid) + ') — it is recording the operating tier instead');
  });

  test('the series is capped, and overflow DECIMATES rather than truncating', function () {
    // MAX_SAMPLES is a backstop for tools/balance.js, which runs hundreds of
    // 36,000-tick games. A real game never reaches it (103 samples at 12,336
    // ticks), so it is forced here — otherwise this rule ships untested and the
    // first thing to exercise it is a batch that runs out of memory.
    var saved = H.MAX_SAMPLES;
    try {
      H.MAX_SAMPLES = 8;
      var s = _hstRun(9105, 40 * H.INTERVAL_TICKS);
      var h = s.history;
      assert(h.t.length <= 8, 'the cap did not hold — ' + h.t.length + ' samples');
      assert(h.every > BAL.HISTORY.INTERVAL_TICKS,
        'the interval did not double on decimation (still ' + h.every + ')');
      // THE POINT OF DECIMATING RATHER THAN TRUNCATING: the opening survives.
      assertEqual(h.t[0], 0,
        'the first sample is no longer tick 0 — the beginning of the game was ' +
        'thrown away, which is the part most worth seeing');
      // Still on a fixed interval afterwards, or the x-axis is a lie.
      var bad = [];
      for (var i = 0; i < h.t.length; i++) {
        if (h.t[i] !== i * h.every) bad.push('sample ' + i + ' at ' + h.t[i]);
      }
      assertNone(bad, 'the axis is no longer evenly spaced after decimation');
      // And every series was halved WITH the axis.
      var pids = Object.keys(h.p).sort();
      var off = pids.filter(function (p) { return h.p[p].terr.length !== h.t.length; });
      assertNone(off, 'a series and the tick axis disagree after decimation');
    } finally {
      H.MAX_SAMPLES = saved;
    }
  });

  test('recording changes nothing about the game', function () {
    // The recorder is the only thing in sim/ that nothing reads back, and this
    // is the assertion that keeps it that way — if it ever drew from rng or
    // touched a station, the chart would start deciding games.
    //
    // `_vicRecordHistory` DIRECTLY, not victoryTick. The first version called
    // victoryTick and went red, correctly: on every multiple of
    // CAPITULATE_CHECK_INTERVAL that function also runs the capitulation scan
    // and writes `peakStations`. That is a real and wanted mutation belonging
    // to a different mechanic, and a test aimed at the recorder must not be
    // able to fail for it.
    if (typeof _vicRecordHistory !== 'function') {
      return skipTest('recorder inert', '_vicRecordHistory is not exposed');
    }
    // ON A SAMPLING TICK, and this test was VACUOUS without that. The recorder
    // returns immediately unless `state.tick % every === 0`; at tick 400 with a
    // 120-tick interval it never reached its own body, so a mutation that had
    // it write to a station survived untouched. Stepped to a multiple, and
    // asserted to be on one, so the guard cannot come back silently.
    var every = BAL.HISTORY.INTERVAL_TICKS;
    var s = _hstRun(9106, every * 4);
    assertEqual(s.tick % every, 0,
      'the fixture is not on a sampling tick, so the recorder would return ' +
      'before doing anything and this test would prove nothing');
    var before = snapshot(s);
    delete before.history;
    for (var i = 0; i < 5; i++) _vicRecordHistory(s);
    var after = snapshot(s);
    delete after.history;
    assertEqual(JSON.stringify(after), JSON.stringify(before),
      'the recorder moved the board — it is not inert');
  });

  test('history survives a snapshot round trip', function () {
    // It is in state precisely so a reconnect can redraw the chart
    // (07-roadmap.md Phase E). A field that did not survive JSON would defeat
    // the only reason it is not in the renderer.
    var s = _hstRun(9107, 600);
    var back = snapshot(s);
    assertEqual(JSON.stringify(back.history), JSON.stringify(s.history),
      'the history did not survive snapshot()');
    assert(back.history.t.length > 3, 'the round-tripped history is empty');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/history-tests.js`
// ---------------------------------------------------------------------------
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  (function () {
    var fs = require('fs'), vm = require('vm'), path = require('path');
    var root = path.join(__dirname, '..');
    var SCRIPTS = [
      'core/rng.js', 'core/exact.js', 'core/util.js', 'core/state.js', 'core/vision.js',
      'data/tuning.js', 'data/map.js', 'data/stations.js', 'data/scenario.js',
      'sim/commands.js', 'sim/development.js', 'sim/growth.js', 'sim/movement.js',
      'sim/combat.js', 'sim/relations.js', 'sim/victory.js', 'sim/step.js',
      'ai/score.js', 'ai/ai.js',
      'test/asserts.js', 'test/runner.js',
    ];
    for (var i = 0; i < SCRIPTS.length; i++) {
      var f = path.join(root, SCRIPTS[i]);
      if (!fs.existsSync(f)) continue;
      try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: SCRIPTS[i] }); }
      catch (e) { console.error('LOAD ERROR in ' + SCRIPTS[i] + ': ' + e.message); process.exit(2); }
    }
    resetTests();
    suiteHistory();
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
