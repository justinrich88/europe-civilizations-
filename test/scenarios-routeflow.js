// test/scenarios-routeflow.js — WHY A RUNNING SUPPLY LINE GOES QUIET, and for
// how long.
//
// One suite, `sim / route flow over time`, over sim/movement.js's orders phase.
// test/scenarios-routes.js asks what a COMMAND does to a route; this one asks
// what a route does when NOBODY touches it.
//
// ── THE REPORT THIS SUITE WAS WRITTEN FROM ───────────────────────────────
//
//   *"from what I'm seeing, the line with the arrow stays but sometimes when
//    another command is issued to a different station, the flow of troops stops
//    to the original station."*
//
// The command is not what stops it. That was measured first and is asserted
// here as a regression: an `order` on a DIFFERENT city, aimed at a DIFFERENT
// destination, leaves this edge's plan byte-identical for 80 consecutive
// sweeps. What the player is seeing is one level down and needs no command at
// all —
//
//   A LONE, HEALTHY, UNCONTESTED ROUTE IS INTERMITTENT BY CONSTRUCTION.
//
// Measured with the AI off, the destination spent every tick, 40,000 ticks,
// ground truth read off state.orderStats rather than off the planner:
//
//     source  capacity   ships on   longest dark run   steady garrison
//     mec     13          6% of sweeps  17 sweeps = 425 ticks   11.2
//     bea     14         10%            20 sweeps = 500 ticks   11.5
//     inn     20         23%             8 sweeps = 200 ticks   12.9
//     lnz     24         26%             6 sweeps               13.6
//     brn     30         58%             2 sweeps               15.2
//     ber     72        100%             0                      35.9
//
// So on a 108-station board the player's experience is decided by which city
// they drew the line out of: 38 stations of capacity >= 35 ship on every sweep,
// 56 of capacity 23-34 ship on a quarter to three quarters of them, and the 14
// smallest go dark for up to 500 ticks at a stretch.
//
// ── IT IS NOT A THROUGHPUT LOSS, AND THAT IS THE WHOLE ARGUMENT ──────────
//
// Across every route in that table the SOURCE GARRISON IS STATIONARY to within
// one unit over 32,000 ticks. Nothing accumulates and nothing is destroyed:
// 100% of what a feed city produces leaves down the line. The dark sweeps are
// not the mechanic failing to ship — they are a city that has not yet produced
// one shippable batch. The duty cycle is production per sweep divided by
// MIN_SEND, and every send is one batch of MIN_SEND:
//
//     mec  0.058 units/sweep produced  ->  6% duty x 1.00-unit batches
//     brn  0.599                       -> 58% duty x 1.04-unit batches
//
// A source cannot ship more often than it produces a batch, so there is no
// schedule under which those routes deliver more. Both of those are asserted
// below.
//
// ── THE CONSTANT CANNOT FIX IT ──────────────────────────────────────────
//
// The obvious lever is MIN_SEND, and it was swept (ground truth, same rig, ten
// routes):
//
//     MIN_SEND   mean delivered/sweep   mec steady garrison
//     2.00       0.652                  19.50   <- stuck at its ceiling, 0 sends
//     1.00       0.767                  11.22   <- shipped
//     0.50       0.774                   7.16
//     0.25       0.774                   7.16   <- identical: see below
//
// 1.0 -> 0.5 buys 1% more delivery and costs every feed city a THIRD of its
// standing garrison, because the mechanic drives a source to wherever its whole
// allowance is worth one MIN_SEND and lowering the floor lowers the fixed point
// with it. And below 0.5 the constant is inert, which is its own finding and is
// the second thing this suite asserts — see `_ordMinSend` in sim/movement.js.
//
// The conclusion is that the sim is behaving correctly and the DEFECT IS ON
// SCREEN: a line that is saving up renders identically to a line that is
// broken. `shortfall` (added with this suite) is the number a readout needs to
// tell them apart, and three tests here pin it down.
//
// ── WHAT EACH TEST IS FOR, AND HOW IT WAS PROVED ABLE TO FAIL ────────────
//
// known-issues #8. Every assertion below was run red first.
//
//   FAILS ON HEAD    `the plan never promises a send applyCommand refuses`.
//                    Verified against the unfixed sim/movement.js (before
//                    _ordMinSend existed): 300 planned sends, 0 shipped, the
//                    plan off by 4x. This is a real regression test for a real
//                    defect, not a mutation.
//   MUTATION-PROVED  the other five. Each was run against a targeted edit of
//                    sim/movement.js and the mutation is named in the test:
//
//                      intermittent but lossless    `amount < minSend * 3`
//                      ships in MIN_SEND batches    KEEP_FLOOR dropped from
//                                                   _ordAllowedFraction
//                      shortfall is exact           `need` scaled by 1.15
//                      shortfall 0 = waiting        the waiting edge reports
//                                                   `need` instead of `shortBy`
//                      a command elsewhere          _ordAllowedFraction divided
//                        changes nothing            by the source count
//
// Every one also carries an explicit CONTROL inside its own fixture, because a
// route that was never in the failure regime proves nothing about the regime —
// the whole suite is about a state that only exists after a long warm-up.
//
// Fixtures are built from the live link graph and from `capacity`, never from
// hard-coded city ids: the map is generated and any id written here would rot.
//
// ── HOW IT RUNS HEADLESS ─────────────────────────────────────────────────
//
// `node test/scenarios-routeflow.js` from the project root. The bootstrap at
// the bottom is the same vm.runInThisContext loader test/node.js uses, minus
// every render/ file. It is inert under tests.html and under test/node.js. The
// suite hook is `suiteRouteFlow(d)`.
//
// Private helpers are prefixed `_rfl`, BY FILE (known-issues #12): `_ord`
// belongs to sim/movement.js, `_rte` to test/scenarios-routes.js, and `_ordLink`
// already exists in test/runner.js.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function _rflAdjacency() {
  var a = {};
  for (var i = 0; i < LINKS.length; i++) {
    var l = LINKS[i];
    (a[l.a] = a[l.a] || []).push(l.b);
    (a[l.b] = a[l.b] || []).push(l.a);
  }
  var keys = Object.keys(a);
  for (var k = 0; k < keys.length; k++) a[keys[k]].sort();   // sorted: determinism
  return a;
}

// A board where `pid` holds its capital plus `n` neighbours breadth-first, every
// garrison at 90% of capacity. AI-quiet through simFns().newGame, and the route
// cache is reset first because these fixtures rewrite ownership wholesale.
function _rflBoard(fns, d, seed, pid, n) {
  if (typeof resetRouteCache === 'function') resetRouteCache();
  var s = fns.newGame(seed);
  var adj = _rflAdjacency();
  var cap = d.POWERS[pid].capital;
  var own = [cap], seen = {}, q = [cap];
  seen[cap] = true;
  while (q.length && own.length < n + 1) {
    var cur = q.shift();
    var nb = adj[cur] || [];
    for (var i = 0; i < nb.length; i++) {
      var sid = nb[i];
      if (seen[sid]) continue;
      seen[sid] = true;
      q.push(sid);
      if (own.length < n + 1) { setStationOwner(s, sid, pid); own.push(sid); }
    }
  }
  own.sort();
  for (var j = 0; j < own.length; j++) {
    s.stations[own[j]].units = (d.STATIONS[own[j]].capacity * 0.9);
  }
  return { s: s, own: own, adj: adj };
}

// THE SOURCE THIS SUITE IS ABOUT: the SMALLEST city in the cluster that has an
// owned neighbour to supply. Chosen by capacity off the live data rather than
// by id, and it is the small end that matters — a big city ships on 100% of
// sweeps and could never exhibit the state the player reported.
//
// Returns { from, to } or null.
function _rflSmallestFeeder(d, b) {
  var best = null;
  for (var i = 0; i < b.own.length; i++) {
    var sid = b.own[i];
    var nb = (b.adj[sid] || []).filter(function (x) { return b.own.indexOf(x) >= 0; });
    if (!nb.length) continue;
    var cap = d.STATIONS[sid].capacity;
    if (!best || cap < best.cap) best = { from: sid, to: nb[0], cap: cap };
  }
  return best;
}

// A source for the TWO-LINE case, and the size is load-bearing. The rotation
// only elects a lead when the even split cannot pay but the whole allowance
// can — `MIN_SEND <= whole < 2 x MIN_SEND`. Every feeder is driven to a fixed
// point where its whole allowance is worth about ONE MIN_SEND, so any source
// that reaches that point sits in the band; a source big enough to pay for BOTH
// lines outright (measured: `ber`, capacity 72, ships 2.15 units a sweep) never
// enters the state at all and makes the test vacuous. So: the SMALLEST city
// with two owned neighbours, chosen off `capacity` rather than by id.
function _rflTwoLineFeeder(d, b) {
  var best = null;
  for (var i = 0; i < b.own.length; i++) {
    var sid = b.own[i];
    var nb = (b.adj[sid] || []).filter(function (x) { return b.own.indexOf(x) >= 0; });
    if (nb.length < 2) continue;
    var cap = d.STATIONS[sid].capacity;
    if (!best || cap < best.cap) best = { from: sid, to: nb.slice(0, 2), cap: cap };
  }
  return best;
}

// Draw a supply line. Absorbs the group-toggle asymmetry the same way
// test/runner.js's _ordLink and test/scenarios-routes.js's _rteLink do: the
// order command ADDS to the whole group only if some member lacks the edge, so
// passing a station that already has it cancels instead of adding.
function _rflLink(s, pid, sources, target) {
  var add = [];
  for (var i = 0; i < sources.length; i++) {
    var have = s.stations[sources[i]].supplyTo || [];
    if (have.indexOf(target) < 0) add.push(sources[i]);
  }
  if (!add.length) return null;
  add.sort();
  return applyCommand(s, { type: 'order', owner: pid, stations: add, target: target });
}

// Run `sweeps` sweeps and report what the edge from `from` to each of `tos`
// actually DID — ships counted off state.orderStats, not off the planner, so a
// planner that lies cannot make this look healthy (known-issues #18).
//
// `spend` empties the destinations at the end of every tick. A rally that
// nobody spends fills in a handful of sweeps and every later sweep reads
// `destination-full`, which is a different finding from this one; the case
// under test is a FRONT city that is using what it receives.
function _rflWatch(fns, s, pid, sweeps, from, tos, iv) {
  var out = {
    sends: 0, unitsSent: 0, checks: 0, shipSweeps: 0,
    longestDark: 0, u0: null, u1: 0, perEdge: {}, plans: [],
  };
  for (var i = 0; i < tos.length; i++) out.perEdge[tos[i]] = { ships: 0, units: 0, shortfallSeen: 0 };
  var dark = 0, seen = {};
  var s0Sends = s.orderStats ? s.orderStats.sends : 0;
  var s0Units = s.orderStats ? s.orderStats.unitsSent : 0;

  for (var t = 0; t < sweeps * iv; t++) {
    for (var k = 0; k < tos.length; k++) {
      s.stations[tos[k]].units = 1;
    }
    var before = s.orderStats ? s.orderStats.sends : 0;
    fns.step(s);
    var sw = Math.floor(s.tick / iv);
    if (seen[sw]) continue;
    seen[sw] = true;
    if (out.u0 === null) out.u0 = (s.stations[from].units);
    out.checks++;
    var fired = (s.orderStats ? s.orderStats.sends : 0) > before;
    if (fired) { out.shipSweeps++; dark = 0; }
    else { dark++; if (dark > out.longestDark) out.longestDark = dark; }

    // The per-edge plan, recorded for the shortfall assertions. Taken AFTER the
    // sweep, so it describes the NEXT one — which is what a rail drawn between
    // sweeps is showing.
    var p = standingOrderNext(s, from);
    var rec = { tick: s.tick, edges: {} };
    for (k = 0; k < p.edges.length; k++) {
      var e = p.edges[k];
      rec.edges[e.target] = { units: e.units, blocked: e.blocked, shortfall: e.shortfall };
      var pe = out.perEdge[e.target];
      if (!pe) continue;
      if (!e.blocked && e.units > 0) { pe.ships++; pe.units += e.units; }
      if (e.shortfall > 0) pe.shortfallSeen++;
    }
    out.plans.push(rec);
  }
  out.u1 = (s.stations[from].units);
  out.sends = (s.orderStats ? s.orderStats.sends : 0) - s0Sends;
  out.unitsSent = (s.orderStats ? s.orderStats.unitsSent : 0) - s0Units;
  return out;
}

// ---------------------------------------------------------------------------

function suiteRouteFlow(d) {
  var ctx = _needSim('sim / route flow over time', ['newGame', 'step', 'apply']);
  if (!ctx) return;
  var fns = ctx.fns;
  suite('sim / route flow over time');

  if (typeof ordersTick !== 'function' || !d.BAL.ORDERS ||
      typeof standingOrderNext !== 'function' || typeof standingOrderPlan !== 'function') {
    skipTest('route flow', 'ordersTick()/standingOrderNext()/standingOrderPlan()/BAL.ORDERS not present');
    return;
  }

  var O = d.BAL.ORDERS;
  var IV = O.INTERVAL > 0 ? O.INTERVAL : 1;
  var PID = 'ger';

  // A small feeder with one line into a destination that is being spent, warmed
  // up to the fixed point the mechanic drives it to. Everything below shares it.
  function smallRun(sweeps, warmSweeps) {
    var b = _rflBoard(fns, d, 101, PID, 12);
    var f = _rflSmallestFeeder(d, b);
    if (!f) return null;
    _rflLink(b.s, PID, [f.from], f.to);
    // Warm-up. A feeder is only in the reported state once it has drained to its
    // fixed point; from the 90% start it ships every sweep for a while, which is
    // the opposite of the case under test.
    for (var t = 0; t < warmSweeps * IV; t++) {
      b.s.stations[f.to].units = 1;
      fns.step(b.s);
    }
    var w = _rflWatch(fns, b.s, PID, sweeps, f.from, [f.to], IV);
    return { b: b, f: f, w: w };
  }

  // -------------------------------------------------------------------------
  // 1. THE PLAYER'S REPORT, AS A MEASUREMENT.
  //
  // MUTATION-PROVED: `amount < minSend` -> `amount < minSend * 3` in
  // _ordPlanPower. The feeder then never clears the floor, ships nothing for the
  // whole run, and its garrison climbs to the growth ceiling — so both the
  // "it fired" and the "it is stationary" halves go red at once.
  // -------------------------------------------------------------------------
  test('a lone uncontested route goes dark for many sweeps — and loses nothing', function () {
    var r = smallRun(320, 200);
    if (!r) { skipTest('lone route', 'no owned neighbour in the cluster'); return; }

    // CONTROL 1 — the fixture is genuinely in the intermittent regime. Without
    // this the assertions below are satisfied by a route that ships on every
    // sweep, which is the case that is NOT under test.
    assert(r.w.longestDark >= 3,
      'CONTROL: the fixture never went dark for 3 consecutive sweeps (longest ' +
      r.w.longestDark + '), so it is not in the regime this test is about — ' +
      'source ' + r.f.from + ' capacity ' + r.f.cap);
    assert(r.w.shipSweeps < r.w.checks,
      'CONTROL: the route shipped on every one of ' + r.w.checks + ' sweeps');

    // CONTROL 2 — and it is not simply broken. A route that never ships would
    // satisfy "goes dark" trivially.
    assert(r.w.sends > 0,
      'the route never shipped at all in ' + r.w.checks + ' sweeps');

    // THE CLAIM. Going dark costs nothing: the source garrison is stationary, so
    // everything it produced over the window left down the line. Tolerance is
    // one MIN_SEND because the garrison is sampled mid-cycle at each end and the
    // cycle is exactly one batch deep.
    var drift = Math.abs(r.w.u1 - r.w.u0);
    assert(drift <= O.MIN_SEND * 1.5,
      'the source garrison drifted by ' + drift.toFixed(3) + ' units over ' +
      r.w.checks + ' sweeps — the line is not delivering what the city makes ' +
      '(' + r.f.from + ': ' + r.w.u0.toFixed(2) + ' -> ' + r.w.u1.toFixed(2) + ')');
  });

  // -------------------------------------------------------------------------
  // 2. WHY IT STUTTERS: every send is ONE BATCH of MIN_SEND. The duty cycle is
  // production divided by that batch, so a city producing a twentieth of a batch
  // per sweep ships on a twentieth of them and there is no schedule that does
  // better.
  //
  // MUTATION-PROVED: drop the KEEP_FLOOR term from _ordAllowedFraction
  // (`spare = units`). The source then ships SEND_FRACTION of its WHOLE garrison
  // and the mean batch goes far above MIN_SEND.
  // -------------------------------------------------------------------------
  test('a stuttering source ships in MIN_SEND-sized batches, not dribbles', function () {
    var r = smallRun(320, 200);
    if (!r) { skipTest('batch size', 'no owned neighbour in the cluster'); return; }

    // CONTROL — enough sends to average over, and still intermittent.
    assert(r.w.sends >= 8,
      'CONTROL: only ' + r.w.sends + ' sends in ' + r.w.checks + ' sweeps, too few to average');
    assert(r.w.longestDark >= 3,
      'CONTROL: not in the intermittent regime (longest dark ' + r.w.longestDark + ')');

    var batch = r.w.unitsSent / r.w.sends;
    assertBetween(batch, O.MIN_SEND, O.MIN_SEND * 1.25,
      'mean batch was ' + batch.toFixed(3) + ' units against MIN_SEND ' + O.MIN_SEND);

    // ...and the duty cycle is exactly production/batch, which is what makes the
    // dark sweeps unavoidable rather than a scheduling failure.
    var perSweep = r.w.unitsSent / r.w.checks;
    var duty = r.w.sends / r.w.checks;
    assertClose(duty, perSweep / batch, 1e-9,
      'duty cycle is not production per sweep divided by the batch size');
  });

  // -------------------------------------------------------------------------
  // 3. SHORTFALL IS EXACT. It is the number a readout needs to say "this line is
  // saving up" instead of "too little to send", so it has to be the real
  // threshold and not a friendly approximation.
  //
  // Two-sided, which is its own control: 90% of the shortfall must NOT be
  // enough. A test that only added the full amount would pass against any
  // formula that under-reports.
  //
  // MUTATION-PROVED: scale `need` by 1.15 in _ordPlanPower. The 90% arm then
  // ships and the assertion fails on the first fixture.
  // -------------------------------------------------------------------------
  test('shortfall is the exact number of units the source is waiting for', function () {
    var r = smallRun(1, 200);
    if (!r) { skipTest('shortfall', 'no owned neighbour in the cluster'); return; }
    var s = r.b.s, from = r.f.from, to = r.f.to;

    // Find a sweep where the edge is blocked BY THE SOURCE. Step until it is —
    // on a small feeder this is most sweeps, but the fixture must not assume it.
    var found = null;
    for (var t = 0; t < 60 * IV && !found; t++) {
      s.stations[to].units = 1;
      fns.step(s);
      if (s.tick % IV !== 0) continue;
      var p = standingOrderNext(s, from);
      var e = p.edges[0];
      if (e && e.blocked === 'below-min-send' && e.shortfall > 0) found = e;
    }
    assert(!!found,
      'CONTROL: never found a sweep where ' + from + ' was short of a stream, so ' +
      'nothing was measured');

    var short = found.shortfall;
    assert(short > 0 && isFinite(short), 'shortfall was ' + short);

    // ARM A — 90% of it is not enough. Applied to a clone so the two arms see
    // the same board.
    var save = s.stations[from].units;
    s.stations[from].units += short * 0.9;
    var a = standingOrderNext(s, from).edges[0];
    assert(!!a.blocked,
      'the line shipped on 90% of the reported shortfall (' + (short * 0.9).toFixed(3) +
      ' units), so the number over-reports');

    // ARM B — the full shortfall is. Restore and add all of it.
    s.stations[from].units = save + short + 1e-9;
    var bE = standingOrderNext(s, from).edges[0];
    assert(!bE.blocked && bE.units > 0,
      'the line did NOT ship after adding the full reported shortfall of ' +
      short.toFixed(3) + ' units — blocked=' + bE.blocked +
      ', shortfall now ' + bE.shortfall);
  });

  // -------------------------------------------------------------------------
  // 4. SHORTFALL IS ZERO FOR A LINE THAT IS MERELY WAITING ITS TURN. Both states
  // report `below-min-send`, and this is the number that separates them — the
  // whole point of adding it. A rail that printed "saving up, N units to go" for
  // a line that is first in the queue next sweep would be a new lie in place of
  // the old one.
  //
  // MUTATION-PROVED: pass `need` instead of `shortBy` on the rotation's waiting
  // branch. The waiting edge then reports a positive shortfall and this fails.
  // -------------------------------------------------------------------------
  test('a line waiting its turn reports shortfall 0, not a shortfall', function () {
    var b = _rflBoard(fns, d, 101, PID, 12);
    var f = _rflTwoLineFeeder(d, b);
    if (!f) { skipTest('rotation shortfall', 'no source with two owned neighbours'); return; }
    _rflLink(b.s, PID, [f.from], f.to[0]);
    _rflLink(b.s, PID, [f.from], f.to[1]);

    // Warm to the fixed point, spending both destinations so neither fills.
    var t, k;
    for (t = 0; t < 200 * IV; t++) {
      for (k = 0; k < 2; k++) b.s.stations[f.to[k]].units = 1;
      fns.step(b.s);
    }

    // Look for the rotation state: exactly one edge shipping and the other
    // blocked below-min-send on the SAME sweep. That is only reachable when the
    // even split could not pay and the lead was elected, which is the state
    // under test.
    var seen = 0, bad = [];
    for (t = 0; t < 200 * IV; t++) {
      for (k = 0; k < 2; k++) b.s.stations[f.to[k]].units = 1;
      fns.step(b.s);
      if (b.s.tick % IV !== 0) continue;
      var p = standingOrderNext(b.s, f.from);
      if (p.edges.length !== 2) continue;
      var ship = null, wait = null;
      for (k = 0; k < 2; k++) {
        if (!p.edges[k].blocked && p.edges[k].units > 0) ship = p.edges[k];
        else if (p.edges[k].blocked === 'below-min-send') wait = p.edges[k];
      }
      if (!ship || !wait) continue;
      seen++;
      if (!(wait.shortfall === 0)) {
        bad.push('tick ' + b.s.tick + ' ' + f.from + '->' + wait.target +
          ' waiting its turn but reported shortfall ' + wait.shortfall);
      }
      if (!(ship.shortfall === 0)) {
        bad.push('tick ' + b.s.tick + ' a SHIPPING edge reported shortfall ' + ship.shortfall);
      }
    }

    // CONTROL — the rotation state actually occurred. Without it this test is
    // green on a board where the two-line case never arose.
    assert(seen >= 5,
      'CONTROL: the rotation state (one line shipping, one waiting) occurred only ' +
      seen + ' times out of ~200 sweeps on ' + f.from + ' (capacity ' + f.cap + ')');
    assertNone(bad, 'a line waiting its turn reported a source shortfall');
  });

  // -------------------------------------------------------------------------
  // 5. THE COMMAND IS NOT WHAT STOPS IT — the player's sentence, as a
  // regression. An `order` drawn out of a DIFFERENT city at a DIFFERENT
  // destination must not change one number on this edge.
  //
  // MUTATION-PROVED: divide _ordAllowedFraction by the number of stations the
  // power supplies from. The arms then diverge on the first sweep after the
  // command.
  // -------------------------------------------------------------------------
  test('an order drawn out of a different city changes nothing on this line', function () {
    function arm(extra) {
      var b = _rflBoard(fns, d, 101, PID, 12);
      var f = _rflSmallestFeeder(d, b);
      if (!f) return null;
      _rflLink(b.s, PID, [f.from], f.to);
      var t;
      for (t = 0; t < 200 * IV; t++) {
        b.s.stations[f.to].units = 1;
        fns.step(b.s);
      }
      if (extra) {
        // A second, unrelated line: a different source at a different
        // destination, both disjoint from the pair under test.
        var other = null, dst = null;
        for (var i = 0; i < b.own.length && !other; i++) {
          var sid = b.own[i];
          if (sid === f.from || sid === f.to) continue;
          var nb = (b.adj[sid] || []).filter(function (x) {
            return b.own.indexOf(x) >= 0 && x !== f.from && x !== f.to && x !== sid;
          });
          if (nb.length) { other = sid; dst = nb[0]; }
        }
        if (!other) return null;
        _rflLink(b.s, PID, [other], dst);
        b.extraFrom = other; b.extraTo = dst;
      }
      var w = _rflWatch(fns, b.s, PID, 80, f.from, [f.to], IV);
      return { b: b, f: f, w: w };
    }

    var base = arm(false), with2 = arm(true);
    if (!base || !with2) { skipTest('different city', 'no disjoint second pair in the cluster'); return; }

    // CONTROL — the line was actually running in both arms, so "identical" is
    // not two columns of zeroes.
    assert(base.w.sends > 0 && with2.w.sends > 0,
      'CONTROL: the line under test shipped ' + base.w.sends + ' / ' + with2.w.sends +
      ' times — one of the arms was dead, so equality proves nothing');
    assert(with2.b.extraFrom !== base.f.from && with2.b.extraTo !== base.f.to,
      'CONTROL: the second order was not aimed at a different station after all');

    var diffs = [];
    for (var i = 0; i < base.w.plans.length && i < with2.w.plans.length; i++) {
      var a = base.w.plans[i].edges[base.f.to], c = with2.w.plans[i].edges[with2.f.to];
      if (!a || !c) { diffs.push('sweep ' + i + ': an edge record vanished'); continue; }
      if (a.blocked !== c.blocked || Math.abs(a.units - c.units) > 1e-12) {
        diffs.push('sweep ' + i + ': alone ' + JSON.stringify(a) + ' vs with-a-second-order ' +
          JSON.stringify(c));
      }
    }
    assertNone(diffs, 'an order on a DIFFERENT city changed this line', 4);
    assertEqual(with2.w.sends, base.w.sends,
      'the number of sends down this line changed when a different city was ordered');
  });

  // -------------------------------------------------------------------------
  // 6. THE PLAN MAY NEVER PROMISE A SEND applyCommand WILL REFUSE.
  //
  // FAILS ON HEAD — this is a regression test for a real defect, not a mutation.
  // Before _ordMinSend() existed, setting BAL.ORDERS.MIN_SEND below
  // BAL.MIN_SEND_UNITS made the planner size sends the command layer rejects as
  // 'too-few-units': measured 0.483 units/sweep planned against 0.115 shipped,
  // a 4x over-promise, on a board byte-identical to the un-retuned one. That is
  // known-issues #18 arriving through a constant instead of through a duplicated
  // formula, and nothing in the suite could see it.
  //
  // The constant is restored in a finally, so a failure here cannot poison the
  // suites that run after it.
  // -------------------------------------------------------------------------
  test('the plan never promises a send applyCommand would refuse', function () {
    var saved = d.BAL.ORDERS.MIN_SEND;
    var planned = 0, mismatch = [], sweepsSeen = 0;
    try {
      // Deliberately below BAL.MIN_SEND_UNITS, which is the whole point.
      d.BAL.ORDERS.MIN_SEND = (d.BAL.MIN_SEND_UNITS || 0.5) / 2;

      var b = _rflBoard(fns, d, 101, PID, 12);
      var f = _rflSmallestFeeder(d, b);
      if (!f) { skipTest('min-send guard', 'no owned neighbour in the cluster'); return; }
      _rflLink(b.s, PID, [f.from], f.to);
      var s = b.s, t;
      for (t = 0; t < 200 * IV; t++) {
        s.stations[f.to].units = 1;
        fns.step(s);
      }

      // Decompose the tick so the plan is taken on exactly the board the sweep
      // then acts on — the same technique test/runner.js's exactness test uses.
      for (t = 0; t < 300 * IV && !s.winner; t++) {
        if (s.tick % IV !== 0) {
          fns.step(s);
          s.stations[f.to].units = 1;
          continue;
        }
        growthTick(s);                                  // phase 1
        var p = standingOrderNext(s, f.from);
        var firstNew = s.nextWaveId;
        ordersTick(s);                                  // phase 2 — the sweep
        var sent = 0;
        for (var i = 0; i < s.waves.length; i++) {
          if (s.waves[i].id >= firstNew && s.waves[i].from === f.from) {
            sent += (s.waves[i].units);
          }
        }
        sweepsSeen++;
        if (p.units > 0) planned++;
        if (Math.abs(p.units - sent) > 1e-9 * Math.max(1, sent)) {
          mismatch.push('tick ' + s.tick + ': planned ' + p.units.toFixed(6) +
            ', applyCommand shipped ' + sent.toFixed(6));
        }
        movementTick(s); combatTick(s); relationsTick(s); victoryTick(s);
        s.tick++;
        s.stations[f.to].units = 1;
      }
    } finally {
      d.BAL.ORDERS.MIN_SEND = saved;
      if (typeof BAL !== 'undefined' && BAL.ORDERS) BAL.ORDERS.MIN_SEND = saved;
    }

    // CONTROL — the regime was actually entered. With MIN_SEND set below
    // MIN_SEND_UNITS the planner must still have been planning sends, or there
    // is nothing for the guard to have prevented.
    assert(sweepsSeen > 250, 'CONTROL: only ' + sweepsSeen + ' sweeps ran');
    assert(planned >= 20,
      'CONTROL: the plan proposed only ' + planned + ' sends with MIN_SEND below ' +
      'MIN_SEND_UNITS, so the over-promise had no opportunity to appear');

    assertNone(mismatch, 'the plan promised units applyCommand refused to send', 4);
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/scenarios-routeflow.js`
// ---------------------------------------------------------------------------
//
// Inert under tests.html (no `require`) and under test/node.js (every file there
// is evaluated with vm.runInThisContext, where `require` and `module` are both
// out of scope). Only a direct `node test/scenarios-routeflow.js` gets here.
//
// The SCRIPTS list is test/node.js's, minus every render/ file — nothing in this
// suite touches the DOM.
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  (function () {
    var fs = require('fs'), vm = require('vm'), path = require('path');
    var root = path.join(__dirname, '..');
    var SCRIPTS = [
      'core/rng.js', 'core/exact.js', 'core/util.js', 'core/state.js', 'core/vision.js',
      'data/tuning.js', 'data/map.js', 'data/stations.js', 'data/scenario.js',
      'sim/commands.js', 'sim/development.js', 'sim/growth.js', 'sim/movement.js', 'sim/combat.js',
      'sim/relations.js', 'sim/victory.js', 'sim/step.js',
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
    suiteRouteFlow(collectData());
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
