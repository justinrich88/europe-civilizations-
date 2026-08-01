// test/help-tests.js — the guide does not lie.
//
// One suite, registered from test/runner.js. It tests render/help.js, which is
// the only file under render/ the headless harness loads at all — and it can,
// because everything asserted here is DERIVED CONTENT computed from BAL and
// STATIONS, with no DOM touched until somebody calls helpShow().
//
// Why a manual gets a test suite. known-issue #18: *"a readout can answer a
// different question from the one on screen and never look wrong."* A guide is
// the worst instance of that failure mode in the project, because unlike the
// rail it is not recomputed every frame — a number typed into it is correct on
// the afternoon it is typed and silently wrong forever after. So every figure
// the guide prints is derived at build time from the same data the sim reads,
// and this suite is what proves the derivations agree with an INDEPENDENT
// calculation rather than with themselves.
//
// The four things it can catch, all of which are real ways this file rots:
//
//   * a tuning change that moves the send ladder, the capitulation threshold or
//     the disconnect bleed out from under the text
//   * a regenerated data/stations.js that adds a station type, or a factory
//     that starts making something the guide never mentions
//   * a unit added to BAL.UNITS with no character line in the guide
//   * the survival table drifting off the square law it claims to be
//
// Kept out of test/runner.js for the same reason test/fog-tests.js is: a new
// subject gets a new file and one hook. Privates are prefixed `_helpt`, by FILE
// (known-issues #12) — `_help` belongs to render/help.js.

// ---------------------------------------------------------------------------

function suiteHelp(d) {
  if (typeof helpFacts !== 'function') {
    return skipSuite('help / guide', 'render/help.js not loaded');
  }
  if (!d.BAL) return skipSuite('help / guide', 'data/tuning.js not loaded');

  suite('help / guide');
  var B = d.BAL;

  // --- the square law ------------------------------------------------------
  //
  // Computed here from first principles, NOT copied from render/help.js: two
  // implementations of the same integration is the only way this assertion
  // means anything. A0^2 - A^2 = B0^2 - B^2 with B annihilated leaves the
  // winner sqrt(r^2 - 1) / r of itself.

  test('survival percentages come off the square law', function () {
    var probes = [1.2, 1.5, 2, 3, 5];
    var bad = [];
    for (var i = 0; i < probes.length; i++) {
      var r = probes[i];
      var want = Math.round(100 * Math.sqrt(r * r - 1) / r);
      var got = helpSurvivalPct(r);
      if (got !== want) bad.push(r + ':1 -> guide ' + got + '%, square law ' + want + '%');
    }
    assertNone(bad, 'the guide disagrees with Lanchester');
  });

  // The three rungs the guide actually prints. Pinned as literals because these
  // are the numbers 00-vision.md §5 and data/tuning.js's COMBAT_RATE comment
  // both quote — if the model ever changes, all three should fail together and
  // loudly, rather than the guide quietly agreeing with a new model while the
  // design doc keeps quoting the old one.
  test('the printed rungs are 55 / 87 / 94', function () {
    var rows = helpRatioRows();
    assertEqual(rows.length, 3, 'three rungs');
    assertEqual(rows[0].pct, 55, '1.2:1 survival');
    assertEqual(rows[1].pct, 87, '2:1 survival');
    assertEqual(rows[2].pct, 94, '3:1 survival');
  });

  test('a fight at parity or worse survives nothing', function () {
    assertEqual(helpSurvivalPct(1), 0, 'even odds');
    assertEqual(helpSurvivalPct(0.5), 0, 'losing odds');
  });

  // --- the send ladder -----------------------------------------------------

  test('the send ladder is BAL.SEND_FRACTIONS, digit by digit', function () {
    var lad = helpSendLadder();
    assertEqual(lad.length, B.SEND_FRACTIONS.length, 'one rung per fraction');
    var bad = [];
    for (var i = 0; i < lad.length; i++) {
      if (lad[i].fraction !== B.SEND_FRACTIONS[i]) {
        bad.push('rung ' + i + ' is ' + lad[i].fraction + ', BAL says ' + B.SEND_FRACTIONS[i]);
      }
      // app/main.js's wireKeys() maps `Number(ev.key) - 1` into SEND_FRACTIONS,
      // so the key the guide advertises must be the index + 1 or the guide is
      // teaching a binding that does nothing.
      if (lad[i].key !== String(i + 1)) {
        bad.push('rung ' + i + ' advertises key "' + lad[i].key + '"');
      }
    }
    assertNone(bad, 'the ladder drifted from BAL');
  });

  test('the last rung reads "All" and the rest read percentages', function () {
    var lad = helpSendLadder();
    var last = lad[lad.length - 1];
    assertEqual(last.fraction, 1, 'the top rung is everything');
    assertEqual(last.label, 'All', 'and says so');
    var bad = [];
    for (var i = 0; i < lad.length - 1; i++) {
      if (lad[i].label !== String(Math.round(lad[i].fraction * 100))) {
        bad.push(lad[i].label + ' for ' + lad[i].fraction);
      }
    }
    assertNone(bad, 'a rung label does not match its fraction');
  });

  // --- station types -------------------------------------------------------
  //
  // The guide claims to describe everything on the board. That claim is
  // checkable: the set of types it draws must be exactly the set of types the
  // generated data contains, in both directions. A regenerated
  // data/stations.js that introduces a fifth type should fail here rather than
  // ship a manual that silently omits it.

  test('the four silhouettes are exactly the types on the map', function () {
    if (!d.STATIONS) return skipTest('station types', 'data/stations.js not loaded');
    var inData = {}, sid;
    for (sid in d.STATIONS) {
      if (d.STATIONS[sid] && d.STATIONS[sid].type) inData[d.STATIONS[sid].type] = true;
    }
    var inGuide = {};
    var types = helpStationTypes();
    for (var i = 0; i < types.length; i++) inGuide[types[i].type] = true;

    var missing = Object.keys(inData).filter(function (t) { return !inGuide[t]; });
    var extra = Object.keys(inGuide).filter(function (t) { return !inData[t]; });
    assertNone(missing, 'a station type on the map that the guide never mentions');
    assertNone(extra, 'the guide describes a station type the map does not have');
  });

  test('the counts beside each silhouette are the real counts', function () {
    if (!d.STATIONS) return skipTest('station counts', 'data/stations.js not loaded');
    var real = {}, sid;
    for (sid in d.STATIONS) {
      var st = d.STATIONS[sid];
      if (!st || !st.type) continue;
      real[st.type] = (real[st.type] || 0) + 1;
    }
    var types = helpStationTypes(), bad = [];
    var total = 0;
    for (var i = 0; i < types.length; i++) {
      total += types[i].count;
      if (types[i].count !== (real[types[i].type] || 0)) {
        bad.push(types[i].type + ': guide ' + types[i].count + ', map ' + (real[types[i].type] || 0));
      }
      if (types[i].count <= 0) bad.push(types[i].type + ' is described but never placed');
    }
    assertNone(bad, 'a station count drifted');
    assertEqual(total, Object.keys(d.STATIONS).length, 'the four counts account for every station');
    assertEqual(helpFacts().stationCount, Object.keys(d.STATIONS).length, 'the headline count');
  });

  // WAS 'the factory blurb names every unit a factory actually makes'. Factories
  // no longer make anything (C1), so the check is inverted: the guide must NOT
  // name a unit type, because the one thing worse than an unexplained station
  // type is a guide promising an output the sim stopped producing.
  test('the factory blurb does not promise a unit type factories no longer make', function () {
    var blurb = '';
    var types = helpStationTypes();
    for (var i = 0; i < types.length; i++) {
      if (types[i].type === 'producer') blurb = types[i].blurb;
    }
    assert(blurb.length > 0, 'no producer entry in the guide');
    var named = ['infantry', 'artillery', 'armour'].filter(function (u) {
      return blurb.toLowerCase().indexOf(u) !== -1;
    });
    assertNone(named, 'the guide still promises a unit type that no longer exists');
  });

  // --- units ---------------------------------------------------------------

  // Was two tests: one walked BAL.UNITS checking every type had a line with the
  // right numbers, the other checked the guide listed them in BAL.UNIT_ORDER.
  // There is one unit and no order, so they collapse into the half that still
  // carries weight — the printed stats must be the LIVE ones. A guide that
  // remembers what the sim used to do is known-issue #18 on a page the player
  // opens to resolve exactly that confusion.
  test('the stats beside the unit are the live BAL numbers, not remembered ones', function () {
    var rows = helpUnitRows(), bad = [];
    assertEqual(rows.length, 1, 'the guide lists a number of units other than one');
    assert(!!rows[0].blurb, 'the unit has no character line');
    if (rows[0].atk !== B.UNIT.atk) bad.push('atk ' + rows[0].atk + ' vs ' + B.UNIT.atk);
    if (rows[0].def !== B.UNIT.def) bad.push('def ' + rows[0].def + ' vs ' + B.UNIT.def);
    if (rows[0].speed !== B.UNIT.speed) bad.push('speed ' + rows[0].speed + ' vs ' + B.UNIT.speed);
    assertNone(bad, 'a unit stat drifted');
  });

  // --- everything else the guide prints ------------------------------------

  test('the loose numbers come from BAL', function () {
    var f = helpFacts();
    assertEqual(f.sendKeep, B.SEND_KEEP_UNITS, 'what "All" leaves behind');
    assertEqual(f.capitulatePct, Math.round(B.CAPITULATE_FRACTION * 100), 'capitulation threshold');
    assertEqual(f.needsCapital, !!B.CAPITULATE_REQUIRES_CAPITAL, 'capitulation needs the capital');
    assertClose(f.disconnectPct, B.DISCONNECT_DECAY * 100, 1e-9, 'disconnect bleed');
    assertEqual(f.disconnectGrows, B.DISCONNECT_GROWTH > 0, 'whether a cut-off city still grows');
    assertEqual(f.overflowCeil, B.GROWTH_OVERFLOW_CEIL, 'the hard ceiling');
  });

  // The guide's capitulation sentence says "loses its capital WHILE holding
  // under N%". If CAPITULATE_REQUIRES_CAPITAL were ever turned off that
  // sentence becomes false, and no other assertion in the project would notice.
  test('capitulation is still the two-part rule the guide describes', function () {
    assert(B.CAPITULATE_REQUIRES_CAPITAL === true,
      'the guide says losing the capital is required; BAL no longer agrees');
    assertBetween(B.CAPITULATE_FRACTION, 0.01, 0.99, 'a threshold worth printing');
  });

  // --- the growth curve ----------------------------------------------------
  //
  // The picture at the top of the guide is the argument for the whole game, so
  // its SHAPE is asserted rather than its pixels: rises to a peak at half full,
  // is monotonic on the way up, holds a floor across the capacity line, and
  // reaches zero exactly at the hard ceiling. 00-vision.md §2 calls all four
  // load-bearing.

  test('the growth curve peaks at half full', function () {
    var pts = helpGrowthCurve(60);
    var ceil = B.GROWTH_OVERFLOW_CEIL;
    var best = 0, bestX = 0;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].y > best) { best = pts[i].y; bestX = pts[i].x; }
    }
    assertClose(best, 1, 1e-9, 'the peak is the normalisation point');
    assertClose(bestX * ceil, 0.5, 0.03, 'and it sits at half capacity');
  });

  // ── THE DOC AND THE CODE DISAGREE HERE, AND THE CODE WINS ──────────────
  //
  // 00-vision.md §2 lists three load-bearing properties of this shape, and the
  // second is: *"It is monotonic the whole way. There is no point at which
  // filling a city further makes it grow faster."* That is not what ships.
  //
  // `room` is floored at FLOOR = 0.25 x GROWTH_OVERFLOW_RATE = 0.125
  // (sim/growth.js), and the floor takes over at `1 - units/cap = 0.125`, i.e.
  // at 87.5% full. Past that point `room` is CONSTANT while `units` keeps
  // rising, so `units x room` rises with it:
  //
  //     87.5% full   0.4375 of peak     <- the low point
  //     95%          0.4750
  //     100%         0.5000             <- GROWTH_OVERFLOW_RATE, as promised
  //
  // A 14% rise across the last eighth of the fill. The doc's OTHER two claims
  // hold exactly — the peak is at half full, and growth at capacity is 50% of
  // that peak — so the derivation of 0.25 is fine and only the monotonicity
  // sentence is wrong. The guide draws the real curve, which is why this suite
  // asserts the real curve. Reported rather than "fixed": changing the shipped
  // growth shape is a balance decision, not a documentation one.
  test('the curve never exceeds its peak, and dies at the ceiling', function () {
    var pts = helpGrowthCurve(120);
    var bad = [];
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].y > 1 + 1e-9) bad.push('exceeds the half-full peak at x=' + pts[i].x.toFixed(3));
    }
    assertNone(bad, 'nothing may grow faster than a half-full city');
    assertClose(pts[0].y, 0, 1e-9, 'an empty city grows nothing');
    assertClose(pts[pts.length - 1].y, 0, 1e-9, 'growth is zero at the hard ceiling');
  });

  // Past capacity the tail is strictly decreasing to zero — that half of the
  // shape IS monotonic, and it is what makes the ceiling "the highest number
  // growth alone can ever produce".
  test('past capacity the curve only falls', function () {
    var pts = helpGrowthCurve(120);
    var ceil = B.GROWTH_OVERFLOW_CEIL;
    var capAt = 1 / ceil;
    var bad = [];
    for (var i = 1; i < pts.length; i++) {
      if (pts[i - 1].x < capAt) continue;
      if (pts[i].y > pts[i - 1].y + 1e-9) bad.push('rises at x=' + pts[i].x.toFixed(3));
    }
    assertNone(bad, 'the overflow tail is not monotonic');
  });

  // The "50%" the design promises: growth AT capacity is half of that station's
  // own best rate. It is derived (peak of u(1-u) is cap/4), which is what makes
  // the number checkable against what the player sees on the rail.
  test('growth at capacity is GROWTH_OVERFLOW_RATE of the peak', function () {
    var ceil = B.GROWTH_OVERFLOW_CEIL;
    var pts = helpGrowthCurve(600);
    var target = 1 / ceil, best = null, bestD = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var dd = Math.abs(pts[i].x - target);
      if (dd < bestD) { bestD = dd; best = pts[i]; }
    }
    assertClose(best.y, B.GROWTH_OVERFLOW_RATE, 0.01,
      'the curve at capacity should be ' + B.GROWTH_OVERFLOW_RATE + ' of peak');
  });

  // --- the pause contract --------------------------------------------------
  //
  // Not a DOM test — the harness has no document. It asserts the one piece of
  // state the contract turns on: a freshly loaded guide holds no captured
  // speed, so nothing can be restored by a stray helpHide().

  test('a closed guide holds no captured speed', function () {
    assertEqual(HELP_STATE.open, false, 'closed at load');
    assertEqual(HELP_STATE.root, null, 'and not in any document');
    assertEqual(HELP_STATE.prevSpeed, null, 'with nothing to restore');
  });
}
