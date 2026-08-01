// test/scenarios-routeview.js — does the supply route on the BOARD say what the
// route is actually doing?
//
// One suite, `render / route state`, over render/map.js's `_mapRouteState` and
// `_mapOrderHoldTicks`. Sibling of test/scenarios-routes.js, which asks the same
// question one layer down ("what does a command do to a route that is running")
// and whose fixtures this file reuses rather than copies.
//
// ── THE REPORT THIS SUITE WAS WRITTEN FROM ───────────────────────────────
//
//   *"the reinforcement routes ... they're tough to click and understand if
//    they're actually active"* — and then, later, routes reported as "ending"
//    that had not ended.
//
// The renderer had ONE bit: `standingOrderPlan` says this sweep ships nothing
// down this edge, so add `.is-blocked`, which at 1.8px and 0.30 stroke-opacity
// with the chevrons switched off is indistinguishable from the route not being
// there. That is known-issue #18's shape exactly: a readout answering a
// different question from the one on screen, and never looking wrong doing it.
//
// MEASURED, 12 seeds x 7 powers, one healthy route each, sampled every
// MAP_ORDER_BLOCK_TICKS (5) over 1500 ticks past a 200-tick warm-up — 25,200
// samples, no command interference of any kind:
//
//   the route reads DEAD on            83.2% of samples
//   mean unbroken dark span                118 ticks
//   longest unbroken dark span            1250 ticks
//
// So the most common thing the board said about a perfectly healthy supply line
// was that it was dead. The reasons behind those samples are entirely
// self-recovering — `below-min-send` (the throttle), `destination-full` (the
// headroom ceiling) and `at-keep-floor` (the source is spent, e.g. the player
// just fired a volley out of it). None of them needs the player and none of them
// deserves the treatment reserved for `unreachable`.
//
// ── WHAT THE FIX IS, AND WHAT EACH PART OF IT BOUGHT ─────────────────────
//
// Three mechanisms, ablated on the same 25,200 samples. Each column is the share
// of samples on which the board painted the DEAD treatment on a healthy route:
//
//                      long route (3+ hops)      one-hop route
//   head (as shipped)          83.2%                 86.3%
//   hysteresis only            49.3%                 54.8%
//   in-flight wave only        11.9%                 50.1%
//   waiting/stuck split         0.0%                  0.0%
//   all three                   0.0%                  0.0%
//
// and the share painted as FLOWING, which is the half that says whether the
// remaining non-flowing samples are honest or merely quieter:
//
//   head                       16.8%                 13.7%
//   in-flight wave only        88.1%                 49.9%
//   all three                  88.1%                 53.0%
//
// Read the two tables together and each mechanism has a job the others cannot
// do. The SPLIT is the correctness fix — it is what takes the dead treatment to
// zero on a healthy route, on both fixtures. The IN-FLIGHT WAVE is the strongest
// false-negative killer on a long route, where a convoy is on the wire most of
// the time (16.8% -> 88.1% flowing), and it is worth half that on a one-hop
// route where the wire empties fast. HYSTERESIS is what covers exactly that
// gap: on the one-hop route it lifts flowing from 49.9% to 53.0% on top of the
// in-flight check, and on its own it halves the dark reads. On the long route it
// adds nothing the in-flight check had not already caught, which is stated here
// rather than hidden — it is redundant where the wave is a good signal and
// load-bearing where it is not.
//
// ── WHAT EACH TEST HERE IS FOR, AND WHETHER IT CAN FAIL ──────────────────
//
// known-issue #8: a test that passes with and without the fix is worse than no
// test. Every assertion below was run red first. There is no "unfixed code" to
// run the rule tests against — `_mapRouteState` did not exist before this
// change — so all but one were proved against a targeted mutation of
// render/map.js, named per test:
//
//   FAILS ON HEAD    "a healthy route is never drawn dead" carries the head
//                    rule (`stuck = !(units > 0)`) inside its own loop as the
//                    CONTROL, and asserts it goes dead on most samples while the
//                    new rule never does. Delete the fix and the control and the
//                    subject become the same number and the test fails.
//   MUTATION         every rule test. The mutation is named in the test body.
//
// Each measured test also carries an explicit control, so it cannot go
// vacuously green on a fixture where nothing was ever throttled.
//
// ── DEPENDENCY, STATED OUT LOUD ──────────────────────────────────────────
//
// The board fixtures come from test/scenarios-routes.js (`_rteBoard`,
// `_rteLink`, `_rteRunning`, `_rteLongestOwnPath`). Copying them here would be
// known-issue #9 — one fixture rule with two implementations, drifting — so they
// are reused and guarded on. If that file is not loaded, this suite skips
// LOUDLY rather than reporting a green nothing.
//
// Privates are prefixed `_rvw`, by FILE (known-issue #12): `_rte` belongs to
// test/scenarios-routes.js, `_ord` to sim/movement.js and `_map` to
// render/map.js.
//
// ── HOW IT RUNS HEADLESS ─────────────────────────────────────────────────
//
// `node test/scenarios-routeview.js` from the project root. The bootstrap at the
// bottom is test/node.js's loader plus render/map.js and a four-line DOM shim —
// render/map.js hangs a DOMContentLoaded listener and writes its exports onto
// `window`, and neither exists under node. Nothing else in this file touches
// the DOM: the subject is a pure function of four arguments, deliberately, so
// that the rule the board paints from is assertable without a board.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Every power that actually holds a capital. `POWERS` also carries entries a
// board fixture cannot be built from, and `_rteBoard` reads `.capital`
// unguarded — an unfiltered list produces `own = [undefined]` and a TypeError
// forty lines later that looks like a map bug.
function _rvwPowers(d) {
  var out = [];
  for (var pid in d.POWERS) if (d.POWERS[pid] && d.POWERS[pid].capital) out.push(pid);
  out.sort();
  return out;
}

// A ONE-HOP route: source and destination adjacent, so a convoy is on the wire
// for the shortest time this map allows. The counterpart to _rteRunning, which
// picks the LONGEST path on purpose — and the difference between the two is
// exactly where the in-flight-wave mechanism stops carrying and hysteresis
// starts. A fix measured only on the long fixture would have concluded
// hysteresis was dead weight.
function _rvwAdjacent(fns, d, seed, pid) {
  var b = _rteBoard(fns, d, seed, pid, 12);
  var best = null;
  for (var i = 0; i < b.own.length && !best; i++) {
    for (var j = 0; j < b.own.length && !best; j++) {
      if (i === j) continue;
      // STANDING-ORDER ROUTING (own ground only). routeFor opened up in B1 and now
      // walks through anybody's ground; a supply-line fixture built on the open
      // route cuts corridors the line was never using.
      var p = routeFor(b.s, pid, b.own[i], b.own[j], true);
      if (p && p.length === 2) best = p;
    }
  }
  if (!best) return null;
  b.s.stations[best[1]].units = 1;
  _rteLink(b.s, pid, [best[0]], best[1]);
  for (var t = 0; t < 200; t++) fns.step(b.s);
  return { s: b.s, A: best[0], D: best[1] };
}

// Walk a fixture the way render/map.js walks it — sampled every
// MAP_ORDER_BLOCK_TICKS, because that is the gate `_mapOrdDue` opens and
// therefore the only ticks on which the board's answer can change — and count
// what each rule painted.
//
// `arm` selects which mechanisms are live, so one loop serves both the headline
// test and the ablation. The head rule (`h/w/s` all off) is the code as shipped
// before this change, written out here as the CONTROL: if the fixture is not in
// the failure regime the control goes dark on nothing and the whole comparison
// is vacuous, which is the shape known-issue #8 is about.
function _rvwWalk(fns, f, ticks, arm) {
  var out = { n: 0, flow: 0, wait: 0, dead: 0, headDead: 0, reasons: {} };
  var seen = -Infinity, hold = _mapOrderHoldTicks();
  var gate = 5;                       // MAP_ORDER_BLOCK_TICKS in render/map.js
  for (var t = 0; t < ticks; t++) {
    fns.step(f.s);
    if (f.s.tick % gate !== 0) continue;
    var r = standingOrderNext(f.s, f.A), e = null;
    for (var i = 0; i < r.edges.length; i++) if (r.edges[i].target === f.D) e = r.edges[i];
    if (!e) continue;
    out.n++;
    out.reasons[e.blocked || 'SHIPS'] = (out.reasons[e.blocked || 'SHIPS'] || 0) + 1;
    // The rule as it stood before this change: one bit, instantaneous.
    if (!(e.units > 0)) out.headDead++;

    if (e.units > 0) seen = f.s.tick;
    var inFlight = false;
    for (var w = 0; w < f.s.waves.length; w++) {
      var wv = f.s.waves[w];
      if (wv.standing && wv.from === f.A && wv.to === f.D) { inFlight = true; break; }
    }
    var st = _mapRouteState(e,
      arm.wave ? inFlight : false,
      arm.hyst ? (f.s.tick - seen) : Infinity,
      hold);
    // The split is not a switch inside _mapRouteState — it IS _mapRouteState —
    // so ablating it means folding `waiting` back into `dead`, which is what the
    // head did.
    if (st === 'flowing') out.flow++;
    else if (st === 'waiting' && arm.split) out.wait++;
    else out.dead++;
  }
  return out;
}

var _RVW_ALL = { hyst: true, wave: true, split: true };

// ---------------------------------------------------------------------------

function suiteRouteView(d) {
  suite('render / route state');

  if (typeof _mapRouteState !== 'function' || typeof _mapOrderHoldTicks !== 'function') {
    skipTest('route state', 'render/map.js is not loaded in this harness — run ' +
      '`node test/scenarios-routeview.js`, or add render/map.js (with a document/' +
      'window shim) to test/node.js\'s SCRIPTS list');
    return;
  }
  if (typeof _rteRunning !== 'function' || typeof _rteBoard !== 'function') {
    skipTest('route state', 'test/scenarios-routes.js is not loaded — this suite ' +
      'reuses its board fixtures rather than copying them');
    return;
  }
  var ctx = (typeof _needSim === 'function')
    ? _needSim('render / route state', ['newGame', 'step', 'apply']) : null;
  if (!ctx) { skipTest('route state', 'sim not available'); return; }
  var fns = ctx.fns;
  if (typeof standingOrderNext !== 'function' || !d.BAL || !d.BAL.ORDERS) {
    skipTest('route state', 'standingOrderNext()/BAL.ORDERS not present');
    return;
  }

  // ── the rule, as a table ───────────────────────────────────────────────

  // MUTATION: swap MAP_ORDER_STUCK and MAP_ORDER_WAITING's contents in
  // render/map.js. Verified red — "at-keep-floor was drawn dead" on the first
  // row, and the two `unreachable` rows below flip with it.
  test('a self-recovering reason is never drawn dead', function () {
    var hold = _mapOrderHoldTicks();
    var soft = ['below-min-send', 'destination-full', 'at-keep-floor'];
    for (var i = 0; i < soft.length; i++) {
      var got = _mapRouteState({ target: 'x', units: 0, blocked: soft[i] },
        false, Infinity, hold);
      assertEqual(got, 'waiting', soft[i] + ' was drawn ' +
        (got === 'stuck' ? 'dead' : got) + ' — it clears itself with no player input');
    }
    // CONTROL: the same call shape really can produce 'stuck', so the three
    // above are not all landing in a branch that returns 'waiting' regardless.
    assertEqual(_mapRouteState({ target: 'x', units: 0, blocked: 'unreachable' },
      false, Infinity, hold), 'stuck', 'nothing at all reaches the dead branch');
  });

  // MUTATION: move `if (inFlight) return 'flowing'` above the MAP_ORDER_STUCK
  // check in _mapRouteState. Verified red on both rows — "unreachable was drawn
  // flowing".
  test('a reason that needs the player beats both rescues', function () {
    var hold = _mapOrderHoldTicks();
    var hard = ['unreachable', 'target-lost'];
    for (var i = 0; i < hard.length; i++) {
      var e = { target: 'x', units: 0, blocked: hard[i] };
      assertEqual(_mapRouteState(e, true, Infinity, hold), 'stuck',
        hard[i] + ' was rescued by a wave still on the wire — that convoy is the ' +
        'LAST one and this is exactly when the player has to be told');
      assertEqual(_mapRouteState(e, false, 0, hold), 'stuck',
        hard[i] + ' was rescued by hysteresis');
    }
  });

  // MUTATION: `if (edge && MAP_ORDER_STUCK[edge.blocked] === true)` ->
  // `if (edge && !MAP_ORDER_WAITING[edge.blocked])`, i.e. default-to-dead.
  // Verified red: "an unclassified reason was drawn dead".
  test('an unclassified reason degrades to waiting, not to dead', function () {
    assertEqual(_mapRouteState({ target: 'x', units: 0, blocked: 'some-future-reason' },
      false, Infinity, _mapOrderHoldTicks()), 'waiting',
      'an unclassified reason was drawn dead — the dead treatment must only ever ' +
      'be painted from a reason this renderer can name');
  });

  // MUTATION: delete 'at-keep-floor' from MAP_ORDER_WAITING. Verified red —
  // "at-keep-floor is in neither list". This is the test that makes the
  // degrade-to-waiting rule above safe: a sixth reason in sim/movement.js that
  // nobody classified here fails HERE rather than rendering quietly wrong.
  test('every per-edge reason the sim can emit is classified exactly once', function () {
    // The five reasons _ordBlocked() is called with in sim/movement.js.
    // 'no-order' is deliberately absent: _ordSummarise produces it as a SOURCE
    // summary when there are no edges at all, and it can never appear on an edge.
    var reasons = ['target-lost', 'unreachable', 'at-keep-floor',
                   'destination-full', 'below-min-send'];
    for (var i = 0; i < reasons.length; i++) {
      var w = MAP_ORDER_WAITING[reasons[i]] === true;
      var s = MAP_ORDER_STUCK[reasons[i]] === true;
      assert(w !== s, reasons[i] + ' is in ' + (w ? 'both lists' : 'neither list') +
        ' — render/map.js and sim/movement.js disagree about the vocabulary');
    }
  });

  // MUTATION: `return MAP_ORDER_HOLD_SWEEPS * iv` -> `return 100`. Verified red:
  // "the hysteresis window did not move with BAL.ORDERS.INTERVAL".
  test('the hysteresis window is derived from BAL, not a hard-coded tick count', function () {
    var iv = d.BAL.ORDERS.INTERVAL;
    assertEqual(_mapOrderHoldTicks(), 4 * iv,
      'the window is not 4 sweeps at the live BAL.ORDERS.INTERVAL of ' + iv);
    // Move the clock and it must follow. Restored in a finally so a failure
    // here cannot leave the whole run on a bent tuning constant.
    try {
      d.BAL.ORDERS.INTERVAL = iv * 3;
      assertEqual(_mapOrderHoldTicks(), 4 * iv * 3,
        'the hysteresis window did not move with BAL.ORDERS.INTERVAL');
    } finally {
      d.BAL.ORDERS.INTERVAL = iv;
    }
    assertEqual(d.BAL.ORDERS.INTERVAL, iv, 'the sweep clock was left bent');
  });

  // MUTATION: delete the `if (sinceShip <= hold)` clause. Verified red — "a
  // route that shipped 100 ticks ago was drawn waiting".
  test('hysteresis holds for exactly four sweeps and then lets go', function () {
    var hold = _mapOrderHoldTicks();
    var e = { target: 'x', units: 0, blocked: 'below-min-send' };
    assertEqual(_mapRouteState(e, false, hold, hold), 'flowing',
      'a route that shipped ' + hold + ' ticks ago was drawn waiting — that is ' +
      'inside the window and the window is meant to be inclusive');
    assertEqual(_mapRouteState(e, false, hold + 1, hold), 'waiting',
      'a route that last shipped ' + (hold + 1) + ' ticks ago is still claiming ' +
      'to flow — the window never closes');
    assertEqual(_mapRouteState(e, false, Infinity, hold), 'waiting',
      'a route that has never shipped is claiming to flow');
  });

  // MUTATION: delete the `if (inFlight)` clause. Verified red — "a standing
  // wave on the wire did not rescue the edge".
  test('a standing wave on the wire is proof the edge flows', function () {
    var hold = _mapOrderHoldTicks();
    assertEqual(_mapRouteState({ target: 'x', units: 0, blocked: 'below-min-send' },
      true, Infinity, hold), 'flowing',
      'a standing wave on the wire did not rescue the edge — it is walking down ' +
      'this line right now, whatever the NEXT sweep plans');
    // CONTROL: without the wave the same edge is not flowing, so the assertion
    // above is about the wave and not about the reason.
    assertEqual(_mapRouteState({ target: 'x', units: 0, blocked: 'below-min-send' },
      false, Infinity, hold), 'waiting', 'that edge was flowing without any wave');
  });

  // ── the same rule, against a live board ────────────────────────────────

  // FAILS ON HEAD. The head rule is computed in the same loop as the CONTROL
  // (`out.headDead`), so this test contains its own before-and-after: revert
  // render/map.js and the subject IS the control, `dead` equals `headDead`, and
  // the second assertion fails naming the count.
  test('a healthy route is never drawn dead, and the old rule drew it dead constantly', function () {
    var powers = _rvwPowers(d), tot = { n: 0, dead: 0, head: 0, wait: 0, flow: 0 };
    var soft = 0;
    for (var s = 0; s < 3; s++) {
      for (var p = 0; p < powers.length; p++) {
        var f = _rteRunning(fns, d, (s + 1) * 17, powers[p], 200);
        if (!f) continue;
        var r = _rvwWalk(fns, f, 600, _RVW_ALL);
        tot.n += r.n; tot.dead += r.dead; tot.head += r.headDead;
        tot.wait += r.wait; tot.flow += r.flow;
        soft += (r.reasons['below-min-send'] || 0) + (r.reasons['destination-full'] || 0) +
                (r.reasons['at-keep-floor'] || 0);
      }
    }
    assert(tot.n > 500, 'only ' + tot.n + ' samples — the fixture never ran');
    // CONTROL 1: the fixture really is in the regime the bug lives in. Without
    // this the two assertions below are true of a board on which nothing ever
    // happened.
    assert(soft > tot.n * 0.4, 'only ' + soft + ' of ' + tot.n + ' samples reported a ' +
      'self-recovering reason — this fixture is not throttled and proves nothing');
    // CONTROL 2: and the rule as shipped really did paint those dead.
    assert(tot.head > tot.n * 0.5, 'the old instantaneous rule drew this route dead ' +
      'on only ' + tot.head + ' of ' + tot.n + ' samples — nothing to fix');
    assertEqual(tot.dead, 0, tot.dead + ' of ' + tot.n + ' samples drew the DEAD ' +
      'treatment on a route with no unreachable or lost destination anywhere in it');
    assert(tot.flow > tot.n * 0.5, 'only ' + (100 * tot.flow / tot.n).toFixed(1) +
      '% of samples read as flowing — "waiting" is quieter than dead but it is ' +
      'still not "your route is working"');
  });

  // FAILS ON HEAD by construction — there is no head arm that produces a
  // non-zero `wave` column. Proved able to fail by a targeted mutation as well:
  // making `_mapRouteState` ignore its `inFlight` argument drops the wave arm
  // onto the hysteresis arm and the first assertion goes red naming both
  // numbers.
  test('each of the three mechanisms carries weight on some route', function () {
    var powers = _rvwPowers(d);
    var arms = {
      head: { hyst: false, wave: false, split: false },
      hyst: { hyst: true, wave: false, split: false },
      wave: { hyst: false, wave: true, split: false },
      all: _RVW_ALL,
    };
    // The ONE-HOP fixture, deliberately: it is the case where a convoy clears
    // the wire fastest and therefore the only one on which hysteresis can be
    // shown to add anything the in-flight check had not already caught.
    var got = { head: 0, hyst: 0, wave: 0, all: 0 }, n = 0;
    for (var p = 0; p < powers.length; p++) {
      var base = _rvwAdjacent(fns, d, 41, powers[p]);
      if (!base) continue;
      for (var k in arms) {
        var f = _rvwAdjacent(fns, d, 41, powers[p]);
        var r = _rvwWalk(fns, f, 600, arms[k]);
        got[k] += r.flow;
        if (k === 'head') n += r.n;
      }
    }
    assert(n > 500, 'only ' + n + ' samples — the one-hop fixture never ran');
    assert(got.hyst > got.head,
      'hysteresis alone read flowing on ' + got.hyst + ' samples against the head ' +
      'rule\'s ' + got.head + ' — it is inert');
    assert(got.wave > got.head,
      'the in-flight wave check read flowing on ' + got.wave + ' samples against ' +
      'the head rule\'s ' + got.head + ' — it is inert');
    // The one that justifies keeping BOTH rescues rather than only the stronger.
    assert(got.all > got.wave,
      'all three together read flowing on ' + got.all + ' samples and the in-flight ' +
      'check alone on ' + got.wave + ' — hysteresis adds nothing even on a one-hop ' +
      'route, so it is dead weight and should be deleted');
  });

  // The memo is render-side and must stay that way: a per-edge clock inside sim
  // state would perturb every full-state hash the balance work compares.
  // MUTATION: none needed — this reads the sim's own snapshot. Proved able to
  // fail by adding `state.stations[A].ordSeen = 1` to the fixture, which makes
  // the two snapshots differ and the assertion names the station.
  test('classifying a route mutates no sim state', function () {
    var f = _rteRunning(fns, d, 71, _rvwPowers(d)[0], 200);
    assert(!!f, 'no fixture');
    var before = JSON.stringify(f.s);
    _rvwWalk(fns, { s: f.s, A: f.A, D: f.D }, 0, _RVW_ALL);
    var plan = standingOrderPlan(f.s, f.s.stations[f.A].owner);
    var edges = (plan[f.A] && plan[f.A].edges) || [];
    for (var i = 0; i < edges.length; i++) {
      _mapRouteState(edges[i], true, 0, _mapOrderHoldTicks());
    }
    assertEqual(JSON.stringify(f.s), before,
      'reading the route state changed the board — the hysteresis memo has leaked ' +
      'out of render/map.js and into sim state, and every balance snapshot with it');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/scenarios-routeview.js`
// ---------------------------------------------------------------------------
//
// Inert under tests.html (no `require`) and under test/node.js (every file there
// is evaluated with vm.runInThisContext, where `require` and `module` are both
// out of scope). Only a direct `node test/scenarios-routeview.js` gets here.
//
// The SCRIPTS list is test/node.js's, plus render/map.js and
// test/scenarios-routes.js, which this suite's subject and fixtures come from.
//
// THE SHIM IS FOUR LINES AND IT IS NOT A MOCK. render/map.js needs exactly two
// things from a browser at LOAD time — `window`, to hang its exports on, and
// `document.addEventListener`, for the self-bootstrap that draws the board
// before app/main.js exists. Everything this suite calls is a pure function of
// its arguments; no assertion here goes anywhere near the DOM, which is why the
// state rule was written as `_mapRouteState(edge, inFlight, sinceShip, hold)`
// rather than as something that reads a <g>. `window = global` is what a classic
// script sees in a browser anyway.
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  (function () {
    var fs = require('fs'), vm = require('vm'), path = require('path');
    var root = path.join(__dirname, '..');
    if (typeof global.window === 'undefined') global.window = global;
    if (typeof global.document === 'undefined') {
      global.document = { addEventListener: function () {} };
    }
    var SCRIPTS = [
      'core/rng.js', 'core/exact.js', 'core/util.js', 'core/state.js', 'core/vision.js',
      'data/tuning.js', 'data/map.js', 'data/stations.js', 'data/scenario.js',
      'sim/commands.js', 'sim/development.js', 'sim/growth.js', 'sim/movement.js', 'sim/combat.js',
      'sim/relations.js', 'sim/victory.js', 'sim/step.js',
      'ai/score.js', 'ai/ai.js',
      'render/map.js',
      'test/asserts.js', 'test/scenarios-routes.js', 'test/runner.js',
    ];
    for (var i = 0; i < SCRIPTS.length; i++) {
      var f = path.join(root, SCRIPTS[i]);
      if (!fs.existsSync(f)) continue;
      try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: SCRIPTS[i] }); }
      catch (e) { console.error('LOAD ERROR in ' + SCRIPTS[i] + ': ' + e.message); process.exit(2); }
    }
    resetTests();
    suiteRouteView(collectData());
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
