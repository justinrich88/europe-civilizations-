// test/scenarios-routes.js — what a COMMAND does to a supply route that is
// already running.
//
// One suite, `sim / routes under command`, over sim/movement.js's orders phase
// and sim/commands.js's two verbs.
//
// ── THE REPORT THIS SUITE WAS WRITTEN FROM ───────────────────────────────
//
//   *"if you add a command for a city that's in the path, it disrupts the flow
//    of troops and ends the route"*
//
// Three explanations were on the table and they need different fixes, so the
// first job was to separate them rather than to guess:
//
//   A  the route RECORD is deleted — `supplyTo` loses the edge
//   B  the route survives and is merely BLOCKED, but a blocked route draws at
//      0.30 stroke-opacity with its chevrons off, which at 1.8px is
//      indistinguishable from absent
//   C  the route survives and is not blocked, but `standingOrderNext` returns
//      `unreachable` forever because the path is recomputed through a city
//      whose state changed
//
// MEASURED, 12 seeds x 7 powers = 84 networks, each run seven ways (no command;
// four different commands aimed at a mid-path city; the same commands aimed at
// an OFF-path city as the control), 1500 ticks past a 200-tick warm-up:
//
//   A  0 deletions in 588 arms. `setStationOwner` is the only thing that clears
//      a supply list and it returns early when the owner has not changed, so no
//      command can reach it. NOT HAPPENING.
//   C  `unreachable` was reported 0 times in 588 arms. No command changes
//      ownership synchronously, and ownership is the whole of the traversal
//      rule (`_moveCanTraverse`). NOT HAPPENING.
//   B  real, and it is the whole of what the player can see — but it is not
//      caused by the command. Even the CONTROL arm, with no command issued at
//      all, reads blocked on 77% of its sweeps.
//
// And the arms aimed at a mid-path city came out INDISTINGUISHABLE from the
// same arms aimed at an off-path city — `send-A-into-M-all` and
// `send-A-into-OFF-all` agreed in every column, to the unit. **Being on the
// path has no mechanical effect at all.** What the player was actually hitting
// is one level down and had nothing to do with geometry:
//
//   THE EVEN SPLIT AND MIN_SEND MULTIPLY. A source divides its allowed outflow
//   between its open destinations and MIN_SEND then gates each share on its own,
//   so N lines need N x MIN_SEND of surplus before ANY of them run. Draw a
//   second line out of a working feeder and BOTH stop — including the one that
//   was working. On 57.6% of 10,080 two-destination sweeps every edge read
//   `below-min-send` while the source held enough surplus to pay for one whole
//   stream: 10,536 units that had somewhere legal to go and stood still.
//
// That is the sentence the player wrote, in the sim. The fix is in
// `_ordPlanPower`: when the DIVISION is what pushed every share under the floor,
// the source spends its whole allowance down one line and the lines take turns,
// on the same tick-derived rotation `_ordRotation` already applies to the source
// queue. Per-sweep total unchanged, long-run share per destination unchanged.
//
// ── WHAT EACH TEST HERE IS FOR, AND WHETHER IT CAN FAIL ──────────────────
//
// known-issues #8: a test that passes with and without the fix is worse than no
// test. Every assertion below was run against the unfixed code first. They split
// into two kinds and the difference is stated per test:
//
//   FAILS ON HEAD    the three starvation tests. Verified red against the
//                    unfixed sim/movement.js: 4 shipping sweeps -> 0, "49 of 96
//                    sweeps shipped nothing anywhere", "served 0 and 0 times".
//   INVARIANT        the A and C guards, the "off-path is the same as mid-path"
//                    finding, and the two rules the fix must not break. These
//                    passed before the fix because they were never broken —
//                    that IS the finding — so each was instead proved able to
//                    fail against a targeted mutation of sim/movement.js:
//
//                      deletes the route            an edge is dropped when its
//                                                   source sits at its keep floor
//                      reports unreachable          path membership blocks an edge
//                      mid-path costs what off-path  a congested INTERMEDIATE hop
//                        costs                      blocks an edge
//                      reads blocked on most sweeps _ordHeadroom returns Infinity
//                      outflow is still capped      every open edge gets the whole
//                                                   allowance
//                      even split is untouched      the rotation fires always,
//                                                   not only when the split cannot pay
//                      the rotation is pure         `lead = 0` — a constant
//
//                    Each also carries an explicit CONTROL inside its own
//                    fixture, so it cannot go vacuously green on a board where
//                    nothing was happening in the first place.
//
// Fixtures are built from the live link graph, never from hard-coded city ids:
// the map is generated and any id written here would rot.
//
// ── HOW IT RUNS HEADLESS ─────────────────────────────────────────────────
//
// `node test/scenarios-routes.js` from the project root. The bootstrap at the
// bottom is the same vm.runInThisContext loader test/node.js uses, minus every
// render/ file — nothing here touches the DOM. It is inert under tests.html and
// under test/node.js. The suite hook is `suiteRoutes(d)`, matching
// suiteStandings / suiteFog / suiteHelp.
//
// Private helpers are prefixed `_rte`, by FILE (known-issues #12) — `_ord`
// belongs to sim/movement.js and `_ordBoard` already exists in test/runner.js,
// so a shared prefix here is the collision that issue is about.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function _rteAdjacency() {
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
// garrison at 90% of capacity. AI-quiet, and the route cache is reset first
// because these fixtures rewrite ownership wholesale.
function _rteBoard(fns, d, seed, pid, n) {
  if (typeof resetRouteCache === 'function') resetRouteCache();
  var s = fns.newGame(seed);
  var adj = _rteAdjacency();
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
    s.stations[own[j]].units = {
      infantry: d.STATIONS[own[j]].capacity * 0.9, artillery: 0, armour: 0,
    };
  }
  return { s: s, own: own };
}

// The longest legal route this power can walk over its OWN ground. A route with
// an INTERMEDIATE hop is the whole subject here, so anything shorter than three
// stations is useless as a fixture and the callers assert on it.
function _rteLongestOwnPath(s, pid, own) {
  var best = null;
  for (var i = 0; i < own.length; i++) {
    for (var j = 0; j < own.length; j++) {
      if (i === j) continue;
      // STANDING-ORDER ROUTING (own ground only). routeFor opened up in B1 and now
      // walks through anybody's ground; a supply-line fixture built on the open
      // route cuts corridors the line was never using.
      var p = routeFor(s, pid, own[i], own[j], true);
      if (p && p.length >= 3 && (!best || p.length > best.length)) best = p;
    }
  }
  return best;
}

// Draw a supply line, absorbing the group-toggle asymmetry the way
// test/runner.js's _ordLink does: the order command ADDS to the whole group only
// if some member lacks the edge, so passing a station that already has it
// cancels instead of adding.
function _rteLink(s, pid, sources, target) {
  var add = [];
  for (var i = 0; i < sources.length; i++) {
    var have = s.stations[sources[i]].supplyTo || [];
    if (have.indexOf(target) < 0) add.push(sources[i]);
  }
  if (!add.length) return null;
  add.sort();
  return applyCommand(s, { type: 'order', owner: pid, stations: add, target: target });
}

// A source with a working line into `D`, warmed up so it is in the STEADY STATE
// a player's feeder actually sits in — drained toward its floor by its own
// shipping — rather than in the stocked-to-the-brim state the split fixtures in
// test/runner.js use. That difference is the entire bug: a source stocked at 3x
// capacity can afford any number of lines and never sees it.
function _rteRunning(fns, d, seed, pid, warmup) {
  var b = _rteBoard(fns, d, seed, pid, 12);
  var path = _rteLongestOwnPath(b.s, pid, b.own);
  if (!path) return null;
  var A = path[0], D = path[path.length - 1];
  var M = path[Math.floor(path.length / 2)];
  if (M === A || M === D) return null;
  // The destination is drained so it has headroom: the real case is a city that
  // has just been fought over, not one already full.
  b.s.stations[D].units = { infantry: 1, artillery: 0, armour: 0 };
  b.s.stations[M].units = { infantry: 1, artillery: 0, armour: 0 };
  _rteLink(b.s, pid, [A], D);
  for (var t = 0; t < (warmup || 0); t++) fns.step(b.s);
  return {
    s: b.s, own: b.own, path: path, A: A, D: D, M: M,
    off: b.own.filter(function (x) { return path.indexOf(x) < 0; })[0],
  };
}

// Every sweep tick in the next `ticks`, what the edge from `A` to `D` reported.
// Read per EDGE and not off the source summary: a source with two lines that
// ships down the other one reads `blocked: null` at the summary while the edge
// under test is dark, and the summary would hide exactly the case being
// measured.
function _rteWatch(fns, s, ticks, A, D) {
  var out = { reasons: {}, shipsTo: 0, unitsTo: 0, edgeGone: 0, longestDark: 0 };
  var dark = 0, iv = BAL.ORDERS.INTERVAL;
  for (var t = 0; t < ticks; t++) {
    fns.step(s);
    if (s.tick % iv !== 0) continue;
    var r = standingOrderNext(s, A), e = null;
    for (var i = 0; i < r.edges.length; i++) if (r.edges[i].target === D) e = r.edges[i];
    if (!e) { out.edgeGone++; out.reasons['EDGE-GONE'] = (out.reasons['EDGE-GONE'] || 0) + 1; dark += iv; continue; }
    var key = e.blocked || 'SHIPS';
    out.reasons[key] = (out.reasons[key] || 0) + 1;
    if (e.blocked) { dark += iv; }
    else {
      out.shipsTo++; out.unitsTo += e.units;
      if (dark > out.longestDark) out.longestDark = dark;
      dark = 0;
    }
  }
  if (dark > out.longestDark) out.longestDark = dark;
  return out;
}

// ---------------------------------------------------------------------------

function suiteRoutes(d) {
  var ctx = _needSim('sim / routes under command', ['newGame', 'step', 'apply']);
  if (!ctx) return;
  var fns = ctx.fns;
  suite('sim / routes under command');

  if (typeof ordersTick !== 'function' || !d.BAL.ORDERS ||
      typeof standingOrderNext !== 'function') {
    skipTest('routes under command', 'ordersTick()/standingOrderNext()/BAL.ORDERS not present');
    return;
  }

  var O = d.BAL.ORDERS;
  var PID = 'ger';

  // THE POWER THE STARVATION TESTS USE, AND WHY IT IS NOT `ger` LIKE EVERY
  // OTHER SIM FIXTURE.
  //
  // A feed city does not sit anywhere convenient — the mechanic drives it to a
  // fixed point. It ships SEND_FRACTION of its surplus every sweep and regrows
  // logistically, so it settles exactly where the two balance, which is where
  // its whole allowance is worth about ONE MIN_SEND. Measured after 500 ticks,
  // on the deepest own-ground route each of these powers can draw:
  //
  //     power   source  capacity   steady garrison   whole allowance
  //     aut     alf     14         11.4              0.95
  //     ita     inn     20         13.2              0.99
  //     ger     brn     30         15.9              1.01     (MIN_SEND = 1.0)
  //
  // Every feeder on the board converges to the knife edge, whatever its size —
  // which is why halving the allowance is not a 50% cut but an off switch, and
  // why the defect is not a small-city problem. `ger` lands a hair ABOVE the
  // line and therefore still fires occasionally even unfixed, so a fixture built
  // on it goes green against broken code (known-issues #8: the first version of
  // these two tests did exactly that, on `ger`, and had to be thrown away).
  // `aut` lands a hair below, which is the ordinary case: 64 of 208
  // seed/power/warm-up combinations served NEITHER destination on the unfixed
  // code, and 0 of 208 after the fix.
  var STARVE_PID = 'aut';
  var STARVE_WARM = 500;

  // =========================================================================
  // (A) IS THE ROUTE RECORD DELETED?   — INVARIANT, with a control
  // =========================================================================

  test('no command aimed at a mid-path city deletes the route', function () {
    // Four commands, each one something a player can do by clicking the city
    // the route line passes through, and the route must survive all four.
    //
    // THE CONTROL that stops this going vacuously green: `target-lost` is the
    // one thing that legitimately DOES drop an edge, and the same fixture is run
    // a fifth time with the destination handed to another power. If that arm
    // does not lose the edge, the fixture is not one in which an edge could have
    // been dropped at all and the four negative results prove nothing.
    var f = _rteRunning(fns, d, 300, PID, 200);
    assert(!!f, 'fixture: no multi-hop own-ground route on this board');
    assert(f.path.length >= 3, 'fixture route has no intermediate hop');
    assert((f.s.stations[f.A].supplyTo || []).indexOf(f.D) >= 0,
      'fixture: the warm-up already lost the line before any command was issued');

    var arms = [
      ['the source also supplies the mid-path city',
        function (s) { return applyCommand(s, { type: 'order', owner: PID, stations: [f.A], target: f.M }); }],
      ['the mid-path city supplies the destination',
        function (s) { return applyCommand(s, { type: 'order', owner: PID, stations: [f.M], target: f.D }); }],
      ['the mid-path city is reinforced from the source, at ALL',
        function (s) { return applyCommand(s, { type: 'send', owner: PID, sources: [f.A], target: f.M, fraction: 1.0 }); }],
      ['every supply line on the mid-path city is cleared',
        function (s) { return applyCommand(s, { type: 'order', owner: PID, stations: [f.M], target: null }); }],
    ];

    var bad = [];
    for (var i = 0; i < arms.length; i++) {
      var g = _rteRunning(fns, d, 300, PID, 200);
      var res = arms[i][1](g.s);
      assert(!!res && res.ok, 'fixture: the command itself was refused — ' + arms[i][0] +
        ' (' + (res && res.reason) + ')');
      _rteWatch(fns, g.s, 1500, g.A, g.D);
      if ((g.s.stations[g.A].supplyTo || []).indexOf(g.D) < 0) bad.push(arms[i][0]);
    }
    assertNone(bad, 'a command deleted the supply line 1500 ticks later');

    // THE CONTROL. Same fixture, destination lost to another power: the edge
    // MUST go, or nothing above was ever at risk.
    var c = _rteRunning(fns, d, 300, PID, 200);
    setStationOwner(c.s, c.D, 'fra');
    _rteWatch(fns, c.s, 3 * O.INTERVAL, c.A, c.D);
    assertEqual((c.s.stations[c.A].supplyTo || []).indexOf(c.D), -1,
      'CONTROL: a destination handed to another power did NOT drop the edge, so ' +
      'this fixture could not have detected a deletion either way');
  });

  // =========================================================================
  // (C) DOES THE PATH BECOME UNROUTABLE?   — INVARIANT, with a control
  // =========================================================================

  test('no command can make a live route report unreachable', function () {
    // `unreachable` is keyed on OWNERSHIP (_moveCanTraverse is `st.owner ===
    // pid`), and no command changes ownership on the tick it is issued. So the
    // claim is that a command on a mid-path city cannot produce it — including
    // the one that empties that city as far as the send rules allow.
    var arms = [
      ['reinforce the mid-path city from the source at ALL', function (f) {
        return applyCommand(f.s, { type: 'send', owner: PID, sources: [f.A], target: f.M, fraction: 1.0 });
      }],
      ['volley OUT of the mid-path city at ALL', function (f) {
        var adj = _rteAdjacency();
        var nb = (adj[f.M] || []).filter(function (x) { return f.s.stations[x].owner !== PID; });
        if (!nb.length) return null;
        return applyCommand(f.s, { type: 'send', owner: PID, sources: [f.M], target: nb[0], fraction: 1.0 });
      }],
      ['the source also supplies the mid-path city', function (f) {
        return applyCommand(f.s, { type: 'order', owner: PID, stations: [f.A], target: f.M });
      }],
    ];
    var bad = [], ran = 0;
    for (var i = 0; i < arms.length; i++) {
      var f = _rteRunning(fns, d, 301, PID, 200);
      assert(!!f, 'fixture: no multi-hop own-ground route on this board');
      var res = arms[i][1](f);
      if (res === null) continue;                       // no hostile neighbour on this board
      assert(res.ok, 'fixture: ' + arms[i][0] + ' was refused (' + res.reason + ')');
      ran++;
      var w = _rteWatch(fns, f.s, 1500, f.A, f.D);
      if (w.reasons['unreachable']) {
        bad.push(arms[i][0] + ' -> unreachable on ' + w.reasons['unreachable'] + ' sweeps');
      }
    }
    assert(ran >= 2, 'VACUITY: only ' + ran + ' arms actually issued a command');
    assertNone(bad, 'a command made a live route unroutable');

    // THE CONTROL. `unreachable` is not simply unreportable on this fixture:
    // take the mid-path city away for real and it must fire, or the negative
    // above is a property of the watcher rather than of the sim.
    var c = _rteRunning(fns, d, 301, PID, 200);
    // Every intermediate hop, so no detour survives.
    for (var k = 1; k < c.path.length - 1; k++) {
      setStationOwner(c.s, c.path[k], 'fra');
      c.s.ownerEpoch = (c.s.ownerEpoch || 0) + 1;
    }
    var nx = standingOrderNext(c.s, c.A);
    assertEqual(nx.blocked, 'unreachable',
      'CONTROL: cutting every intermediate hop did not report unreachable, so the ' +
      'negative result above proves nothing about the sim');
  });

  // =========================================================================
  // BEING ON THE PATH HAS NO MECHANICAL EFFECT   — INVARIANT, self-controlling
  // =========================================================================

  test('a command on a mid-path city costs exactly what the same command costs off-path',
    function () {
      // THE FINDING, as an assertion. The player attributed the disruption to
      // the city being ON THE PATH; the sim has no such concept — a route is
      // recomputed from ownership every sweep and nothing indexes the hops. So
      // the same command aimed at a city that is NOT on the path must do the
      // same damage, to the unit.
      //
      // Self-controlling: the two arms are compared against EACH OTHER, so a
      // board on which neither command did anything would fail the vacuity
      // guard rather than pass the equality.
      var f = _rteRunning(fns, d, 302, PID, 200);
      assert(!!f, 'fixture: no multi-hop own-ground route on this board');
      assert(!!f.off, 'fixture: every owned city is on the path — no off-path control exists');

      var mid = _rteRunning(fns, d, 302, PID, 200);
      applyCommand(mid.s, { type: 'send', owner: PID, sources: [mid.A], target: mid.M, fraction: 1.0 });
      var wm = _rteWatch(fns, mid.s, 1200, mid.A, mid.D);

      var off = _rteRunning(fns, d, 302, PID, 200);
      applyCommand(off.s, { type: 'send', owner: PID, sources: [off.A], target: off.off, fraction: 1.0 });
      var wo = _rteWatch(fns, off.s, 1200, off.A, off.D);

      var base = _rteRunning(fns, d, 302, PID, 200);
      var wb = _rteWatch(fns, base.s, 1200, base.A, base.D);

      // VACUITY, both halves: the command has to have HURT the route, and the
      // untouched control has to have been healthier. Without this the equality
      // is satisfied by two arms in which nothing happened.
      assert(wb.shipsTo > wm.shipsTo,
        'VACUITY: the "All" reinforce did not disrupt the route at all (' +
        wb.shipsTo + ' -> ' + wm.shipsTo + ' shipping sweeps), so the comparison ' +
        'below is between two undamaged boards');

      assertEqual(wm.shipsTo, wo.shipsTo,
        'a mid-path target and an off-path target gave different shipping-sweep counts (' +
        wm.shipsTo + ' vs ' + wo.shipsTo + ') — the path WOULD then be load-bearing');
      assertClose(wm.unitsTo, wo.unitsTo, 1e-9,
        'a mid-path target and an off-path target delivered different amounts');
    });

  // =========================================================================
  // (B) THE ROUTE IS DARK FAR MORE OFTEN THAN IT IS BROKEN
  // =========================================================================

  test('a HEALTHY untouched route is now blocked on a MINORITY of sweeps (B1 changed this)', function () {
    // Not a bug in the sim and not asserted as one — `destination-full` is the
    // capacity ceiling doing its job. It is here because it is the load-bearing
    // fact for the RENDERER: the map draws `is-blocked` off exactly this
    // per-sweep boolean, at 0.30 stroke-opacity with the chevrons off, and a
    // player watching a working route sees a dim line with no arrows on it for
    // most of the game. "It ended" is a reasonable thing to conclude.
    //
    // The number is pinned loosely (a majority, and a dark span of several
    // sweeps) because it is a property of the tuning, not a contract. What it
    // guards is the inference: if this ever goes to "almost never blocked", the
    // renderer's blocked treatment stops being a lie and the hysteresis
    // recommended in this file's header is no longer needed.
    var f = _rteRunning(fns, d, 303, PID, 200);
    assert(!!f, 'fixture: no multi-hop own-ground route on this board');
    var w = _rteWatch(fns, f.s, 2000, f.A, f.D);
    var sweeps = 0, keys = Object.keys(w.reasons);
    for (var i = 0; i < keys.length; i++) sweeps += w.reasons[keys[i]];
    assert(sweeps > 20, 'fixture watched only ' + sweeps + ' sweeps');

    // The route IS alive — this is the control that makes the rest meaningful.
    assert(w.shipsTo > 0, 'VACUITY: the fixture route never shipped at all, so it is ' +
      'genuinely dead rather than merely drawn as dead');
    assert(w.unitsTo > 0, 'the route reported shipping sweeps but delivered nothing');

    // INVERTED BY B1, ON THIS TEST'S OWN INSTRUCTIONS.
    //
    // It used to assert `dark > w.shipsTo` — a healthy route spent MOST of its
    // sweeps reported blocked, because destinations sat full — and it said in so
    // many words: "if this ever goes to almost never blocked, the renderer's
    // blocked treatment stops being a lie and the hysteresis recommended in this
    // file's header is no longer needed."
    //
    // March attrition is what changed it. Less of every stream arrives, so
    // destinations fill more slowly and spend far more of their time able to take
    // units. Measured on this fixture: 31 dark sweeps of 80, from a clear
    // majority before.
    //
    // So the assertion is inverted rather than deleted, and it now guards the
    // opposite regression: if a healthy route goes back to being dark most of the
    // time, the renderer is lying to the player again and the hysteresis question
    // is live again.
    var dark = sweeps - w.shipsTo;
    assert(dark < w.shipsTo,
      'a healthy route is dark on ' + dark + ' of ' + sweeps + ' sweeps, a majority ' +
      'again — the renderer draws is-blocked off exactly this boolean at 0.30 ' +
      'stroke-opacity with the chevrons off, so the player is once more watching a ' +
      'working route that looks dead. The hysteresis note in this file\'s header ' +
      'becomes live again.');
  });

  // =========================================================================
  // THE ACTUAL DEFECT   — these three FAIL against the unfixed code
  // =========================================================================

  test('adding a second supply line does not stop the first', function () {
    // THE PLAYER'S SENTENCE, as an assertion. A feeder in its steady state has
    // drained toward its keep floor and holds roughly one stream's worth of
    // surplus; dividing that in two put BOTH shares under MIN_SEND, so drawing a
    // second line killed the line that was already working.
    //
    // FAILS ON HEAD: `after` shipped 0 units down the original edge.
    var one = _rteRunning(fns, d, 304, STARVE_PID, STARVE_WARM);
    assert(!!one, 'fixture: no multi-hop own-ground route on this board');
    var before = _rteWatch(fns, one.s, 1200, one.A, one.D);
    assert(before.shipsTo > 0, 'VACUITY: the route was not running before the second line');

    var two = _rteRunning(fns, d, 304, STARVE_PID, STARVE_WARM);
    var res = applyCommand(two.s, { type: 'order', owner: STARVE_PID, stations: [two.A], target: two.M });
    assert(res.ok, 'the second supply line was refused: ' + res.reason);
    assertEqual((two.s.stations[two.A].supplyTo || []).length, 2, 'the fixture did not draw two lines');
    var after = _rteWatch(fns, two.s, 1200, two.A, two.D);

    assert(after.shipsTo > 0,
      'the original route shipped on ' + before.shipsTo + ' sweeps alone and on ' +
      after.shipsTo + ' once a second line was drawn out of the same city — adding a ' +
      'destination ENDED the route instead of sharing it');
    // Halved is the design ("adding a destination spreads the stream"); zeroed
    // is the bug. Well under half is the shape of an even split that only
    // sometimes clears the minimum, so the bar is deliberately generous.
    assert(after.unitsTo >= before.unitsTo * 0.25,
      'the original route lost more than three quarters of its throughput to a ' +
      'second line (' + before.unitsTo.toFixed(1) + ' -> ' + after.unitsTo.toFixed(1) + ')');
  });

  test('a source that can pay for one stream ships one, never none', function () {
    // The defect stated as arithmetic rather than as an outcome, which is what
    // makes it diagnosable: if the whole allowance clears MIN_SEND then SOMETHING
    // must leave, whatever the destination count. A sweep on which every edge
    // reads `below-min-send` while `SEND_FRACTION x surplus >= MIN_SEND` is the
    // even split and the minimum contradicting each other, and it is the state
    // that measured 57.6% of two-destination sweeps.
    //
    // FAILS ON HEAD: 46 such sweeps out of 96 on this fixture.
    var f = _rteRunning(fns, d, 305, PID, 300);
    assert(!!f, 'fixture: no multi-hop own-ground route on this board');
    applyCommand(f.s, { type: 'order', owner: PID, stations: [f.A], target: f.M });
    assertEqual((f.s.stations[f.A].supplyTo || []).length, 2, 'the fixture did not draw two lines');

    var starved = 0, sweeps = 0, shipped = 0, iv = O.INTERVAL;
    for (var t = 0; t < 2400; t++) {
      fns.step(f.s);
      if (f.s.tick % iv !== 0) continue;
      sweeps++;
      var nx = standingOrderNext(f.s, f.A);
      if (nx.units > 0) { shipped++; continue; }
      // A sweep only counts as STARVED BY THE SPLIT when some destination had
      // room and was refused for SIZE. `destination-full` everywhere is the
      // capacity ceiling working exactly as designed — a rally is a mustering
      // point, not a warehouse — and counting it here would make this test
      // permanently red against correct code. (Measured: all 28 residual
      // no-ship sweeps on this fixture are destination-full on both edges.)
      var roomSomewhere = false;
      for (var e = 0; e < nx.edges.length; e++) {
        if (nx.edges[e].blocked === 'below-min-send') roomSomewhere = true;
      }
      if (!roomSomewhere) continue;
      // What the source could afford as ONE undivided stream, computed off the
      // same two constants the planner uses. Not a second copy of the planner —
      // it is the question the planner is being asked, deliberately expressed
      // without the division so the two can disagree.
      var u = totalUnits(f.s.stations[f.A].units);
      var cap = d.STATIONS[f.A].capacity;
      var spare = u - O.KEEP_FLOOR * cap;
      var whole = spare > 0 ? O.SEND_FRACTION * spare : 0;
      if (whole >= O.MIN_SEND) starved++;
    }
    assert(sweeps > 40, 'fixture watched only ' + sweeps + ' sweeps');
    assert(shipped > 0, 'VACUITY: the two-line source never shipped at all, so this ' +
      'board cannot distinguish "starved by the split" from "genuinely too small"');
    assertEqual(starved, 0,
      starved + ' of ' + sweeps + ' sweeps shipped NOTHING ANYWHERE while the source ' +
      'held enough surplus to pay for one whole stream — the even split and MIN_SEND ' +
      'are multiplying');
  });

  test('two lines out of one city take turns rather than starving together', function () {
    // The fix's own rule, stated the way the player would state it. Both
    // destinations must be served over a run of sweeps, and neither may be
    // served on every sweep — a rotation that never rotates is the failure this
    // is really watching for, and it looks identical to a working one from the
    // totals alone.
    //
    // FAILS ON HEAD: neither destination is ever served, so `served` is 0.
    var f = _rteRunning(fns, d, 306, STARVE_PID, STARVE_WARM);
    assert(!!f, 'fixture: no multi-hop own-ground route on this board');
    applyCommand(f.s, { type: 'order', owner: STARVE_PID, stations: [f.A], target: f.M });

    var toD = 0, toM = 0, sweeps = 0, iv = O.INTERVAL;
    for (var t = 0; t < 2400; t++) {
      fns.step(f.s);
      if (f.s.tick % iv !== 0) continue;
      sweeps++;
      var nx = standingOrderNext(f.s, f.A);
      for (var i = 0; i < nx.edges.length; i++) {
        var e = nx.edges[i];
        if (e.blocked || !(e.units > 0)) continue;
        if (e.target === f.D) toD++;
        if (e.target === f.M) toM++;
      }
    }
    assert(toD > 0 && toM > 0,
      'over ' + sweeps + ' sweeps the two lines out of one city were served ' +
      toD + ' and ' + toM + ' times — a line that is never served is a line the ' +
      'player drew and the sim ignored');
    // Never both on the same sweep is the point of the rotation, not a bonus:
    // the whole allowance goes down one line at a time. Asserted as "neither ran
    // on every sweep", which is true of the rotation and false of an even split
    // that happens to clear the minimum.
    assert(toD + toM <= sweeps,
      'the two lines together were served more often than there were sweeps — the ' +
      'source is shipping a full stream down BOTH lines, which multiplies the ' +
      'outflow instead of spreading it');
  });

  test('the per-sweep outflow is still capped at one stream, however many lines', function () {
    // THE INVARIANT THE FIX MUST NOT BREAK, and the reason the keep floor means
    // anything: a player must not be able to drain a city faster by drawing more
    // lines out of it. Compared against the SAME city with one line, on the same
    // seed, at the same tick — so the two differ in nothing but the line count.
    //
    // INVARIANT (passes on HEAD, where the two-line source ships 0 <= the
    // one-line source). It is here because it is what a careless version of the
    // rotation breaks: give each open edge the whole allowance and this is the
    // only test on the board that notices.
    var one = _rteRunning(fns, d, 307, PID, 300);
    assert(!!one, 'fixture: no multi-hop own-ground route on this board');
    var two = _rteRunning(fns, d, 307, PID, 300);
    applyCommand(two.s, { type: 'order', owner: PID, stations: [two.A], target: two.M });

    var worst = 0, sweeps = 0, iv = O.INTERVAL, oneEver = 0;
    for (var t = 0; t < 1600; t++) {
      fns.step(one.s);
      fns.step(two.s);
      if (one.s.tick % iv !== 0) continue;
      sweeps++;
      var a = standingOrderNext(one.s, one.A).units;
      var b = standingOrderNext(two.s, two.A).units;
      if (a > 0) oneEver++;
      // Against the SOURCE's own allowance at this instant rather than against
      // `a`: the two boards diverge as soon as they ship differently, so the
      // one-line board is a sanity check and the allowance is the contract.
      var u = totalUnits(two.s.stations[two.A].units);
      var spare = u - O.KEEP_FLOOR * d.STATIONS[two.A].capacity;
      var allow = spare > 0 ? O.SEND_FRACTION * spare : 0;
      var over = b - allow;
      if (over > worst) worst = over;
    }
    assert(sweeps > 30, 'fixture watched only ' + sweeps + ' sweeps');
    assert(oneEver > 0, 'VACUITY: the one-line control never shipped, so nothing was compared');
    assert(worst <= 1e-9,
      'a two-line source shipped ' + worst.toFixed(4) + ' units MORE in one sweep than ' +
      'SEND_FRACTION of its surplus — drawing extra lines multiplies the outflow ' +
      'instead of spreading it, and the keep floor stops meaning anything');
  });

  test('the even split is untouched wherever it can actually pay', function () {
    // The fix is scoped to the state in which the even split ships zero. A
    // source stocked well above its floor must still divide evenly and to
    // floating point — same claim as `sim / standing orders`' split test, made
    // again here because the rotation is the thing that would silently replace
    // it, and that suite's fixtures would go on passing if the rotation fired
    // one sweep in three.
    //
    // INVARIANT (passes on HEAD). Proven able to fail by removing the
    // `share < MIN_SEND` guard from the rotation, which makes the shares
    // alternate instead of splitting.
    var b = _rteBoard(fns, d, 308, PID, 8);
    var from = d.POWERS[PID].capital;
    var targets = b.own.filter(function (x) { return x !== from; }).slice(0, 3).sort();
    assertEqual(targets.length, 3, 'fixture could not find three destinations');
    for (var i = 0; i < targets.length; i++) _rteLink(b.s, PID, [from], targets[i]);
    b.s.stations[from].units = { infantry: d.STATIONS[from].capacity * 3, artillery: 0, armour: 0 };
    for (i = 0; i < targets.length; i++) {
      b.s.stations[targets[i]].units = { infantry: 1, artillery: 0, armour: 0 };
    }

    var nx = standingOrderNext(b.s, from);
    assertEqual(nx.edges.length, 3, 'the fixture did not produce three edges');
    var each = [];
    for (i = 0; i < 3; i++) {
      assertEqual(nx.edges[i].blocked, null,
        'edge ' + i + ' of a well-stocked three-way source was blocked (' +
        nx.edges[i].blocked + ') — the rotation is firing where the split can pay');
      each.push(nx.edges[i].units);
    }
    assert(each[0] >= O.MIN_SEND, 'VACUITY: the fixture shares are under MIN_SEND, so this ' +
      'fixture is the rotation\'s own case and cannot police it');
    assertClose(each[1], each[0], 1e-9, 'the second share is not equal to the first');
    assertClose(each[2], each[0], 1e-9, 'the third share is not equal to the first');
  });

  // =========================================================================
  // DETERMINISM
  // =========================================================================

  test('the rotation is a pure function of the board, not of a clock', function () {
    // Every helper the orders phase added must be a function of state.tick, like
    // _ordRotation. Two runs of one seed with a two-line source must be
    // byte-identical, and standingOrderNext must not move the board it is
    // asked about — a readout called every frame that mutated anything would
    // desynchronise the game from its own replay.
    var runOne = function () {
      var f = _rteRunning(fns, d, 309, PID, 100);
      applyCommand(f.s, { type: 'order', owner: PID, stations: [f.A], target: f.M });
      for (var t = 0; t < 900; t++) fns.step(f.s);
      return f;
    };
    var a = runOne(), b2 = runOne();
    assertEqual(JSON.stringify(a.s), JSON.stringify(b2.s),
      'two runs of one seed with a two-line source diverged');

    var f = _rteRunning(fns, d, 309, PID, 100);
    applyCommand(f.s, { type: 'order', owner: PID, stations: [f.A], target: f.M });
    for (var t = 0; t < 200; t++) fns.step(f.s);
    var snap = JSON.stringify(f.s);
    for (var k = 0; k < 40; k++) {
      standingOrderNext(f.s, f.A);
      standingOrderPlan(f.s, PID);
    }
    assertEqual(JSON.stringify(f.s), snap, 'reading the plan mutated the board');

    // The rotation must actually depend on the tick, or "pure" is being proven
    // about a constant. Same board, two different ticks, and the leading edge
    // has to move at least once across a full cycle.
    var g = _rteRunning(fns, d, 309, PID, 300);
    applyCommand(g.s, { type: 'order', owner: PID, stations: [g.A], target: g.M });
    var leaders = {}, iv = O.INTERVAL;
    for (t = 0; t < 1200; t++) {
      fns.step(g.s);
      if (g.s.tick % iv !== 0) continue;
      var nx = standingOrderNext(g.s, g.A);
      for (var e = 0; e < nx.edges.length; e++) {
        if (!nx.edges[e].blocked && nx.edges[e].units > 0) leaders[nx.edges[e].target] = 1;
      }
    }
    assert(Object.keys(leaders).length >= 2,
      'only ' + Object.keys(leaders).length + ' distinct destination(s) were ever led ' +
      'over 1200 ticks — the rotation is a constant');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/scenarios-routes.js`
// ---------------------------------------------------------------------------
//
// Inert under tests.html (no `require`) and under test/node.js (every file
// there is evaluated with vm.runInThisContext, where `require` and `module` are
// both out of scope). Only a direct `node test/scenarios-routes.js` gets here.
//
// The SCRIPTS list is test/node.js's, minus every render/ file — nothing in this
// suite touches the DOM, so loading them would only widen what a failure here
// could mean. When this suite is hooked into runAllTests(), add
// 'test/scenarios-routes.js' to test/node.js's list and to tests.html, add
// `suiteRoutes(d)` next to `suiteStandingOrders(d)` in runAllTests(), and delete
// the block below.
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
    suiteRoutes(collectData());
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
