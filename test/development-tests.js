// test/development-tests.js — 04-development.md, the sim half.
//
// The mechanic is one rule in two halves, and the tests are grouped that way:
// SPEND once to build a tier, and the OPERATING tier tracks the garrison
// standing in the station. Almost every interesting property is in the GAP
// between built and operating, so that is where the assertions are concentrated.
//
// Three that are worth more than the rest, because each is a design claim that
// could quietly not be true:
//
//   * paying tier 1 from a FULL station lands at cap/2, which is peak growth.
//     This is why the first investment is affordable rather than a late-game
//     luxury, and it is arithmetic, so it can be checked.
//   * tier 3 CANNOT be paid without entering the overflow band. That is what
//     gives the overflow mechanic a purpose it currently lacks. Also arithmetic.
//   * a raid DEGRADES a development and a capture DELETES it. The asymmetry is
//     deliberate and neither half is obvious from the code.
//
// Private helpers are `_devt…`.

'use strict';

// A station of `pid`'s with a known garrison and no AI to spend it.
function _devtBoard(pid, sid, units) {
  var s = newGame(90210);
  s.aiEnabled = false;
  if (s.stations[sid].owner !== pid) setStationOwner(s, sid, pid);
  s.stations[sid].units = { infantry: units, artillery: 0, armour: 0 };
  return s;
}

// A station id of each shape the design distinguishes, found from the data
// rather than hard-coded — a hard-coded id is a test that breaks when the map is
// regenerated and says nothing about why.
function _devtPick() {
  var out = { capital: null, plainHolding: null, producer: null, coastal: null, both: null };
  var caps = {};
  for (var p = 0; p < POWER_IDS.length; p++) {
    var c = POWERS[POWER_IDS[p]].capital;
    if (c) caps[c] = true;
  }
  var sea = {};
  for (var l = 0; l < LINKS.length; l++) {
    if (LINKS[l].sea) { sea[LINKS[l].a] = true; sea[LINKS[l].b] = true; }
  }
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i], d = STATIONS[sid];
    if (!out.capital && caps[sid]) out.capital = sid;
    if (!out.plainHolding && !caps[sid] && d.type === 'holding' && !sea[sid]) out.plainHolding = sid;
    if (!out.producer && d.type === 'producer' && !sea[sid]) out.producer = sid;
    if (!out.coastal && sea[sid] && d.type !== 'producer') out.coastal = sid;
    if (!out.both && sea[sid] && d.type === 'producer') out.both = sid;
  }
  return out;
}

function suiteDevelopment() {
  var NAME = 'sim / development';

  if (typeof developmentPlan !== 'function' || typeof operatingTier !== 'function') {
    return skipSuite(NAME, 'sim/development.js is not loaded');
  }

  suite(NAME);

  // STATION_IDS / POWER_IDS are populated by indexIds(), which newGame() calls —
  // and _devtPick() runs before any fixture exists. Under test/node.js the ids
  // are already there because collectData() ran; standalone they are EMPTY, and
  // an empty id list makes _devtPick return nulls and every assertion below fail
  // with "cannot read properties of undefined". Called explicitly so the two
  // entry points behave the same.
  if (typeof indexIds === 'function') indexIds();

  var P = _devtPick();

  // …and the picks are checked, because a null here would make the whole suite
  // fail confusingly rather than saying what is missing.
  var missing = Object.keys(P).filter(function (k) { return !P[k]; });
  assertNone(missing, 'the fixture could not find a station of every shape the ' +
    'design distinguishes; the map data has changed under this suite');

  // ── availability, and the measured numbers §5 argues from ──────────────

  test('every station can fortify; port and factory are where the map says', function () {
    var fort = 0, port = 0, factory = 0, multi = 0, both = 0;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var o = developmentOptions(STATION_IDS[i]);
      if (o.indexOf('fort') >= 0) fort++;
      if (o.indexOf('port') >= 0) port++;
      if (o.indexOf('factory') >= 0) factory++;
      if (o.length > 1) multi++;
      if (o.indexOf('port') >= 0 && o.indexOf('factory') >= 0) both++;
    }
    assertEqual(fort, STATION_IDS.length, 'fortification is not available everywhere');
    // §5's own figures. Pinned because the whole stalemate argument in §7 rests
    // on the RATIO between fortification and the factory that counters it — if
    // the map changes and the factory count drops, that argument needs redoing
    // and this is where it should surface.
    assertEqual(factory, 16, 'the factory count moved off §5\'s 16 producer stations');
    assertBetween(port, 30, 40, 'the coastal count is far off §5\'s 38');
    assert(multi > 40, 'only ' + multi + ' stations have more than one option; §5 measured 51, ' +
      'and below ~40 the "choosing is the decision" claim stops being true');
    assertEqual(both, 3, 'the number of producer-AND-coastal stations moved off §5\'s 3 — ' +
      'those are the only genuine three-way choices on the board');
  });

  test('fortification stops at tier 2, except at the seven capitals', function () {
    // §7's accepted correction, and it is a balance rule rather than a detail:
    // fortification is available at 108 stations and the factory that answers it
    // at 16, so unbounded fortification is seven times more available than its
    // counter. That is how a board freezes.
    assertEqual(developmentMaxTier(P.plainHolding, 'fort'), 2,
      'an ordinary station can fortify past tier 2');
    assertEqual(developmentMaxTier(P.capital, 'fort'), 3,
      'a capital cannot reach tier 3');
    var caps = 0;
    for (var i = 0; i < STATION_IDS.length; i++) {
      if (developmentMaxTier(STATION_IDS[i], 'fort') === 3) caps++;
    }
    assertEqual(caps, 7, 'exactly seven stations should allow tier-3 fortification, got ' + caps);
  });

  test('capital-ness is static — a captured Berlin may still reach tier 3', function () {
    // A rule that shifted as capitals fell would make the ceiling a moving target
    // the player cannot plan against (§7).
    var s = _devtBoard('ger', P.capital, 10);
    var before = developmentMaxTier(P.capital, 'fort');
    setStationOwner(s, P.capital, 'rus');
    assertEqual(developmentMaxTier(P.capital, 'fort'), before,
      'the tier-3 ceiling moved when the capital changed hands');
  });

  // ── cost: a fraction of capacity, never flat ───────────────────────────

  test('cost is a fraction of the station\'s OWN capacity', function () {
    // Capacity runs 13..74 on this map. A flat cost would make development
    // routine for industrial powers and impossible everywhere else, which
    // sharpens exactly the rich-get-richer problem §7 worries about.
    var small = null, large = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var c = STATIONS[STATION_IDS[i]].capacity;
      if (small === null || c < STATIONS[small].capacity) small = STATION_IDS[i];
      if (large === null || c > STATIONS[large].capacity) large = STATION_IDS[i];
    }
    assert(STATIONS[large].capacity > STATIONS[small].capacity * 3,
      'the capacity spread collapsed; this test is measuring nothing');
    assertClose(developmentCost(small, 1), 0.5 * STATIONS[small].capacity, 1e-9, 'small tier 1');
    assertClose(developmentCost(large, 1), 0.5 * STATIONS[large].capacity, 1e-9, 'large tier 1');
    assert(developmentCost(large, 1) > developmentCost(small, 1),
      'cost does not scale with capacity — it is flat');
  });

  test('tier 1 paid from a FULL station lands at peak growth', function () {
    // The design's first stated property: 0.50 x capacity leaves cap/2, which is
    // exactly where the logistic curve peaks. This is why the first investment is
    // affordable rather than a late-game luxury, and it is the reason the cost
    // curve is these three numbers and not three others.
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    var res = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assert(res.ok, 'a full station could not afford tier 1: ' + JSON.stringify(res.rejected));
    assertClose(totalUnits(s.stations[sid].units), cap / 2, 1e-9,
      'tier 1 from full did not land on cap/2 — the peak-growth property is gone');
  });

  test('tier 3 cannot be paid without entering the overflow band', function () {
    // §3's second property, and it is what gives the 5.6b overflow mechanic a
    // purpose it currently lacks. Tier 3 costs a whole capacity, so a station at
    // exactly capacity cannot pay it and keep anything.
    var sid = P.capital, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap * 2.5);
    // Buy 1 and 2 first — tiers are sequential.
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    s.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assertEqual(builtTier(s, sid), 2, 'tier 2 did not build');

    // At exactly capacity, tier 3 is unaffordable.
    s.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
    var no = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid] });
    assert(!no.ok, 'tier 3 was affordable from exactly capacity — the overflow ' +
      'requirement is gone and the overflow band has no purpose again');
    assertEqual(no.rejected[0].reason, 'too-few-units', 'wrong rejection reason');

    // In the overflow band it is affordable, and lands at about half capacity.
    s.stations[sid].units = { infantry: cap * 1.5, artillery: 0, armour: 0 };
    var yes = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid] });
    assert(yes.ok, 'tier 3 was unaffordable even from the overflow band: ' +
      JSON.stringify(yes.rejected));
    assertEqual(builtTier(s, sid), 3, 'tier 3 did not build');
    assertClose(totalUnits(s.stations[sid].units), cap * 0.5, 1e-9,
      'paying tier 3 from 1.5x capacity should leave half capacity');
    // …and therefore it OPERATES at 2, not 3. The delay is the feature.
    assertEqual(operatingTier(s, sid), 2,
      'a tier-3 fort paid out of overflow should run at tier 2 until regarrisoned — ' +
      'that sequencing is the point, not a bug');
    assertEqual(yes.accepted[0].operating, 2,
      'the command result did not report the lower operating tier, so a UI could ' +
      'not tell the player what they just bought is not yet running');
  });

  test('a build may never take a station below MIN_REMAINING', function () {
    // A station at zero is capturable by anyone who walks past, and a build must
    // not be a way to lose a city by accident.
    var sid = P.plainHolding;
    var s = _devtBoard('ger', sid, developmentCost(sid, 1) + BAL.DEV.MIN_REMAINING * 0.5);
    var res = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assert(!res.ok, 'a build emptied the station to below the floor');
    var s2 = _devtBoard('ger', sid, developmentCost(sid, 1) + BAL.DEV.MIN_REMAINING);
    var ok = applyCommand(s2, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assert(ok.ok, 'exactly cost + floor should be affordable: ' + JSON.stringify(ok.rejected));
    assertClose(totalUnits(s2.stations[sid].units), BAL.DEV.MIN_REMAINING, 1e-9,
      'the floor is not what remained');
  });

  test('the spend is proportional across the bundle', function () {
    // Not draining one type, which would let a build launder a stack's
    // composition — and, more importantly, it is what makes this survive the
    // collapse to a single unit type (§9).
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, 0);
    s.stations[sid].units = { infantry: cap * 0.5, artillery: cap * 0.3, armour: cap * 0.2 };
    var before = s.stations[sid].units;
    var ratio = before.artillery / totalUnits(before);
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    var after = s.stations[sid].units;
    assertClose(after.artillery / totalUnits(after), ratio, 1e-9,
      'the mix changed — the spend was not proportional');
  });

  // ── operating tier: the rent ───────────────────────────────────────────

  test('operating tier is garrison / a quarter of capacity, capped at built', function () {
    var sid = P.capital, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap * 3);
    // Build all three tiers, refilling between.
    for (var t = 1; t <= 3; t++) {
      s.stations[sid].units = { infantry: cap * 2, artillery: 0, armour: 0 };
      applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    }
    assertEqual(builtTier(s, sid), 3, 'the fixture did not reach tier 3');

    var cases = [[0.80, 3], [0.75, 3], [0.60, 2], [0.50, 2], [0.30, 1], [0.25, 1], [0.10, 0], [0, 0]];
    for (var i = 0; i < cases.length; i++) {
      s.stations[sid].units = { infantry: cap * cases[i][0], artillery: 0, armour: 0 };
      assertEqual(operatingTier(s, sid), cases[i][1],
        'at ' + (cases[i][0] * 100) + '% of capacity the tier should be ' + cases[i][1]);
    }
  });

  test('operatingShortBy says how many units the next tier needs', function () {
    // The rail prints this, so it has to be the sim's number and not the
    // renderer's guess (known-issues #18).
    var sid = P.capital, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap * 3);
    for (var t = 1; t <= 2; t++) {
      s.stations[sid].units = { infantry: cap * 2, artillery: 0, armour: 0 };
      applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    }
    s.stations[sid].units = { infantry: cap * 0.30, artillery: 0, armour: 0 };
    assertEqual(operatingTier(s, sid), 1, 'the fixture is not at operating tier 1');
    var need = operatingShortBy(s, sid);
    assertClose(need, cap * 0.5 - cap * 0.30, 1e-9, 'the shortfall is wrong');
    // Add exactly that and the tier must step.
    s.stations[sid].units.infantry += need;
    assertEqual(operatingTier(s, sid), 2, 'adding the stated shortfall did not raise the tier');
    // At the built tier there is nothing to be short of.
    s.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
    assertEqual(operatingShortBy(s, sid), null,
      'a fully-operating development still reports a shortfall');
  });

  test('operatingAfterBuild answers the question the chooser has to ask', function () {
    // "Can I afford it" and "will it switch on" are DIFFERENT questions, and the
    // second is the one a player gets wrong. Paying tier 3 out of the overflow
    // band is affordable and still leaves the thing running at 2 (§4). A chooser
    // that only printed the price would let somebody spend most of a city on a
    // development that does not run, and find out afterwards.
    var sid = P.capital, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap * 1.5);

    // Tier 1 costs 0.5x cap out of 1.5x cap, leaving 1.0x — comfortably enough
    // for tier 1 to run, so this one switches on immediately.
    assertEqual(operatingAfterBuild(s, sid, 1, developmentCost(sid, 1)), 1,
      'tier 1 from 1.5x capacity should run at once');

    // The real case. Build 1 and 2 first, then price tier 3 from exactly the
    // overflow band: it costs a whole capacity and leaves half, which operates 2.
    for (var t = 1; t <= 2; t++) {
      s.stations[sid].units = { infantry: cap * 2, artillery: 0, armour: 0 };
      applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    }
    s.stations[sid].units = { infantry: cap * 1.5, artillery: 0, armour: 0 };
    assertEqual(operatingAfterBuild(s, sid, 3, developmentCost(sid, 3)), 2,
      'tier 3 paid from 1.5x capacity should report that it will run at 2, not 3');

    // And it must AGREE with what actually happens, or the warning is a guess.
    var predicted = operatingAfterBuild(s, sid, 3, developmentCost(sid, 3));
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assertEqual(operatingTier(s, sid), predicted,
      'the chooser predicted ' + predicted + ' and the board came out at ' +
      operatingTier(s, sid) + ' — the warning is not derived from the same rule');
  });

  test('operatingAfterBuild never reports a tier the garrison cannot man', function () {
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    // Spend it right down to the floor: nothing left to operate anything.
    var cost = totalUnits(s.stations[sid].units) - BAL.DEV.MIN_REMAINING;
    assertEqual(operatingAfterBuild(s, sid, 1, cost), 0,
      'a build that leaves the floor still claims to be running');
    assert(operatingAfterBuild(s, sid, 1, 1e9) >= 0,
      'an impossible cost produced a negative tier');
  });

  // ── the asymmetry: raid degrades, capture deletes ──────────────────────

  test('a raid DEGRADES the development and it comes back', function () {
    // "a cost of it being destroyed" and "a cost to rebuild", both for free —
    // no damage model, no development hit points, and recovery is fast because
    // the station is now low and the logistic curve is working for the mechanic.
    var sid = P.capital, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap * 3);
    for (var t = 1; t <= 2; t++) {
      s.stations[sid].units = { infantry: cap * 2, artillery: 0, armour: 0 };
      applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    }
    s.stations[sid].units = { infantry: cap * 0.8, artillery: 0, armour: 0 };
    assertEqual(operatingTier(s, sid), 2, 'the fixture is not operating at 2');

    s.stations[sid].units = { infantry: cap * 0.1, artillery: 0, armour: 0 };   // raided
    assertEqual(operatingTier(s, sid), 0, 'a gutted garrison still operates the fort');
    assertEqual(builtTier(s, sid), 2, 'a raid destroyed the BUILD, not just the tier');

    s.stations[sid].units = { infantry: cap * 0.8, artillery: 0, armour: 0 };   // regrown
    assertEqual(operatingTier(s, sid), 2, 'the tier did not come back with the garrison');
  });

  test('a capture DELETES the development entirely', function () {
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assertEqual(builtTier(s, sid), 1, 'the fixture did not build');
    setStationOwner(s, sid, 'fra');
    assertEqual(builtTier(s, sid), 0, 'the new owner inherited the development');
    assertEqual(developmentKind(s, sid), null, 'the kind survived the capture');
    assert(!s.stations[sid].development,
      'the development object survived as a husk — "never developed" and ' +
      '"developed then captured" must be the same state');
  });

  // ── one per station, and it can never change ───────────────────────────

  test('a station gets ONE development and can never change it', function () {
    // §5: "Choosing is the decision; the exclusivity is what makes it one."
    var sid = P.both, cap = STATIONS[sid].capacity;
    assert(sid, 'no producer-and-coastal station found; this test needs one');
    var s = _devtBoard('ger', sid, cap * 3);
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'port' });
    assertEqual(developmentKind(s, sid), 'port', 'the port did not build');

    s.stations[sid].units = { infantry: cap * 2, artillery: 0, armour: 0 };
    var res = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'factory' });
    assert(!res.ok, 'a station switched development kind');
    assertEqual(res.rejected[0].reason, 'already-developed', 'wrong rejection reason');
    assertEqual(developmentKind(s, sid), 'port', 'the kind changed anyway');

    // And the SAME kind, unnamed, buys the next tier.
    var up = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid] });
    assert(up.ok, 'the next tier of the existing development was refused: ' +
      JSON.stringify(up.rejected));
    assertEqual(builtTier(s, sid), 2, 'the tier did not rise');
  });

  test('`b` with no kind builds the only legal option, and asks when there are two', function () {
    // §8: one legal option is the case for 57 of 108 stations, and there the
    // gesture should just work. More than one and the player has to choose — the
    // command says so rather than picking for them.
    var plain = P.plainHolding;
    var s = _devtBoard('ger', plain, STATIONS[plain].capacity);
    var res = applyCommand(s, { type: 'build', owner: 'ger', stations: [plain] });
    assert(res.ok, 'a fortify-or-nothing station did not build without a named kind');
    assertEqual(developmentKind(s, plain), 'fort', 'it built something else');

    var many = P.coastal;
    var s2 = _devtBoard('ger', many, STATIONS[many].capacity);
    var res2 = applyCommand(s2, { type: 'build', owner: 'ger', stations: [many] });
    assert(!res2.ok, 'a station with two options picked one on the player\'s behalf');
    assertEqual(res2.rejected[0].reason, 'choose-kind', 'wrong rejection reason');
    assertEqual(builtTier(s2, many), 0, 'it built anyway');
  });

  test('a build is rejected per station, not per group', function () {
    // Marqueeing a front and pressing `b` should build where it can afford to,
    // the same per-station rule `order` uses.
    var rich = P.plainHolding, poor = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      if (sid !== rich && developmentOptions(sid).length === 1) { poor = sid; break; }
    }
    assert(poor, 'no second fortify-only station found');
    var s = _devtBoard('ger', rich, STATIONS[rich].capacity);
    if (s.stations[poor].owner !== 'ger') setStationOwner(s, poor, 'ger');
    s.stations[poor].units = { infantry: 0.5, artillery: 0, armour: 0 };
    var res = applyCommand(s, { type: 'build', owner: 'ger', stations: [rich, poor] });
    assert(res.ok, 'the whole group was refused because one member was short');
    assertEqual(res.accepted.length, 1, 'expected exactly one build');
    assertEqual(res.accepted[0].station, rich, 'the wrong station built');
    assertEqual(res.rejected.length, 1, 'the short station was not reported');
  });

  test('you cannot build in a city you do not own', function () {
    var sid = P.plainHolding;
    var s = _devtBoard('fra', sid, STATIONS[sid].capacity);
    var res = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assert(!res.ok, 'a build landed in somebody else\'s city');
    assertEqual(res.rejected[0].reason, 'not-owned', 'wrong rejection reason');
  });

  test('an illegal kind for the station is refused', function () {
    var sid = P.plainHolding;   // inland, not a producer
    var s = _devtBoard('ger', sid, STATIONS[sid].capacity * 3);
    var a = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'port' });
    assert(!a.ok && a.rejected[0].reason === 'not-legal-here', 'a port built inland');
    var b = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'factory' });
    assert(!b.ok && b.rejected[0].reason === 'not-legal-here',
      'a factory built in a non-producer');
    var c = applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'nonsense' });
    assert(!c.ok && c.reason === 'unknown-kind', 'an invented kind was accepted');
  });

  // ── the effect ─────────────────────────────────────────────────────────

  test('an operating fortification raises defence; an unmanned one does not', function () {
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    var bare = fortLevel(sid, s);
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    // cap/2 remains, i.e. operating tier 2 — but fort is capped at 1 built.
    assertEqual(operatingTier(s, sid), 1, 'the fixture is not operating at 1');
    var built = fortLevel(sid, s);
    assertClose(built - bare, BAL.DEV.FORT_POWER_PER_TIER, 1e-9,
      'one operating tier did not add FORT_POWER_PER_TIER to the fort level');

    // Gut the garrison: the tier stops operating and the bonus goes with it.
    s.stations[sid].units = { infantry: 0.1, artillery: 0, armour: 0 };
    assertEqual(operatingTier(s, sid), 0, 'the tier still operates on 0.1 units');
    assertClose(fortLevel(sid, s), bare, 1e-9,
      'an unmanned fortification is still adding defence — it is a ghost army');
  });

  test('fortLevel(sid) with no state is unchanged — static callers are not poisoned', function () {
    // The one-argument form answers "what the MAP says this station is worth" and
    // has callers that hold no state. Silently changing it is how a shared helper
    // breaks a caller that never asked for the new behaviour.
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    var staticBefore = fortLevel(sid);
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assertEqual(fortLevel(sid), staticBefore,
      'the one-argument form started reporting board state');
    assert(fortLevel(sid, s) > staticBefore,
      'the two-argument form is not reporting the development at all');
  });

  test('a fortified defender is genuinely harder to take', function () {
    // The end-to-end claim, through stationPower rather than through fortLevel —
    // a bonus that never reaches the combat number would pass every assertion
    // above.
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    s.stations[sid].attackers = { fra: { infantry: 30, artillery: 0, armour: 0 } };
    var plain = stationPower(s, sid, 'defender');

    var s2 = _devtBoard('ger', sid, cap);
    applyCommand(s2, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    // Match the garrison exactly, so the ONLY difference is the development.
    s2.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
    s2.stations[sid].attackers = { fra: { infantry: 30, artillery: 0, armour: 0 } };
    var forted = stationPower(s2, sid, 'defender');

    assert(forted > plain, 'a tier-1 fortification did not raise defensive power at all: ' +
      plain + ' -> ' + forted);
  });

  test('artillery still answers a BUILT fort, exactly as it answers a stone one', function () {
    // The development goes through fortLevel, so it goes through the existing
    // artillery-strip path. If it were added beside the fort block instead, a
    // built fortification would be immune to the one counter the design gives it.
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    function powerVs(kind) {
      var s = _devtBoard('ger', sid, cap);
      applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
      s.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
      s.stations[sid].attackers = { fra: kind };
      return stationPower(s, sid, 'defender');
    }
    var vsInf = powerVs({ infantry: 30, artillery: 0, armour: 0 });
    var vsArt = powerVs({ infantry: 0, artillery: 30, armour: 0 });
    assert(vsArt < vsInf, 'artillery did not strip the built fortification: ' +
      vsInf + ' vs ' + vsArt);
  });

  // ── interdiction: the fort bleeds the assault on its approach ──────────

  test('a hostile wave loses units closing on a garrisoned fortification', function () {
    // 06-movement-and-attrition.md §6: fortification must TAX armies, not only
    // absorb them, or §7's stalemate risk has no answer. This is that tax on the
    // final approach.
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;

    function assault(fortify) {
      var s = _devtBoard('fra', sid, cap);
      if (fortify) applyCommand(s, { type: 'build', owner: 'fra', stations: [sid], kind: 'fort' });
      s.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
      // A neighbour Germany attacks from, so the wave has a real final hop.
      var src = null;
      for (var i = 0; i < LINKS.length && !src; i++) {
        var l = LINKS[i];
        var o = (l.a === sid) ? l.b : (l.b === sid ? l.a : null);
        if (o) src = o;
      }
      setStationOwner(s, src, 'ger');
      s.stations[src].units = { infantry: 60, artillery: 0, armour: 0 };
      var res = applyCommand(s, {
        type: 'send', owner: 'ger', sources: [src], target: sid, fraction: 1,
      });
      assert(res.ok, 'the fixture could not launch: ' + JSON.stringify(res.rejected));
      var w = s.waves[s.waves.length - 1];
      var launched = totalUnits(w.units);
      // March until it lands, then read what actually arrived.
      var guard = 0;
      while (s.waves.indexOf(w) >= 0 && guard++ < 4000) movementTick(s);
      return { launched: launched, landed: totalUnits(w.units), fortified: fortify };
    }

    // AGAINST AN UNFORTIFIED CONTROL, not against what was launched. Since B1
    // every wave pays flat march attrition, so "landed < launched" is true of
    // every march on the board and says nothing about fortification. The control
    // is the same assault over the same link with the fort removed, which is the
    // only comparison that isolates this mechanic.
    var bare = assault(false);
    var walled = assault(true);
    var bareLost = bare.launched - bare.landed;
    var walledLost = walled.launched - walled.landed;
    assert(bareLost > 0, 'the unfortified control lost nothing at all — march ' +
      'attrition is not running, so this comparison has no baseline');
    assert(walledLost > bareLost,
      'a garrisoned fortification cost the assault no more than an open city did: ' +
      walledLost.toFixed(3) + ' vs ' + bareLost.toFixed(3));
  });

  test('an UNGARRISONED fortification projects nothing', function () {
    // The same rule that stops an unmanned fort adding defensive power. It also
    // means a raid that empties a fortress opens the road past it, which is the
    // half of the mechanic that keeps a fortress belt from being a wall you can
    // build once and forget.
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('fra', sid, cap);
    applyCommand(s, { type: 'build', owner: 'fra', stations: [sid], kind: 'fort' });
    assertEqual(builtTier(s, sid), 1, 'the fixture did not build');
    s.stations[sid].units = { infantry: 0.05, artillery: 0, armour: 0 };   // gutted
    assertEqual(operatingTier(s, sid), 0, 'the fixture still operates the fort');

    var src = null;
    for (var i = 0; i < LINKS.length && !src; i++) {
      var l = LINKS[i];
      var o = (l.a === sid) ? l.b : (l.b === sid ? l.a : null);
      if (o) src = o;
    }
    setStationOwner(s, src, 'ger');
    s.stations[src].units = { infantry: 60, artillery: 0, armour: 0 };
    applyCommand(s, { type: 'send', owner: 'ger', sources: [src], target: sid, fraction: 1 });
    var w = s.waves[s.waves.length - 1];
    var launched = totalUnits(w.units);
    var guard = 0;
    while (s.waves.indexOf(w) >= 0 && guard++ < 4000) movementTick(s);
    var lost = launched - totalUnits(w.units);

    // The control: identical assault, no fortification at all. Since B1 both pay
    // march attrition, so the question is whether the EMPTY fort adds anything on
    // top — and it must not.
    var c = _devtBoard('fra', sid, cap);
    c.stations[sid].units = { infantry: 0.05, artillery: 0, armour: 0 };
    setStationOwner(c, src, 'ger');
    c.stations[src].units = { infantry: 60, artillery: 0, armour: 0 };
    applyCommand(c, { type: 'send', owner: 'ger', sources: [src], target: sid, fraction: 1 });
    var cw = c.waves[c.waves.length - 1];
    var cLaunched = totalUnits(cw.units);
    guard = 0;
    while (c.waves.indexOf(cw) >= 0 && guard++ < 4000) movementTick(c);
    var cLost = cLaunched - totalUnits(cw.units);

    assertClose(lost, cLost, 1e-6,
      'an empty fortress cost the assault ' + lost.toFixed(4) + ' where no ' +
      'fortress at all cost ' + cLost.toFixed(4) + ' — the toll is reading the ' +
      'BUILT tier, not the operating one');
  });

  test('the toll scales with the operating tier', function () {
    var sid = P.capital, cap = STATIONS[sid].capacity;

    function assaultAt(tier) {
      var s = _devtBoard('fra', sid, cap * 3);
      for (var t = 0; t < tier; t++) {
        s.stations[sid].units = { infantry: cap * 2, artillery: 0, armour: 0 };
        applyCommand(s, { type: 'build', owner: 'fra', stations: [sid], kind: 'fort' });
      }
      s.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };   // fully manned
      assertEqual(operatingTier(s, sid), tier, 'fixture is not operating at ' + tier);
      var src = null;
      for (var i = 0; i < LINKS.length && !src; i++) {
        var l = LINKS[i];
        var o = (l.a === sid) ? l.b : (l.b === sid ? l.a : null);
        if (o) src = o;
      }
      setStationOwner(s, src, 'ger');
      s.stations[src].units = { infantry: 60, artillery: 0, armour: 0 };
      applyCommand(s, { type: 'send', owner: 'ger', sources: [src], target: sid, fraction: 1 });
      var w = s.waves[s.waves.length - 1];
      var launched = totalUnits(w.units);
      var guard = 0;
      while (s.waves.indexOf(w) >= 0 && guard++ < 4000) movementTick(s);
      return launched - totalUnits(w.units);
    }

    var one = assaultAt(1), three = assaultAt(3);
    assert(one > 0, 'tier 1 took nothing');
    assert(three > one * 2,
      'tier 3 (' + three.toFixed(3) + ') should cost an assault far more than ' +
      'tier 1 (' + one.toFixed(3) + ') — the toll is not scaling with the tier');
  });

  test('the toll is charged once for the approach, not per hop of the route', function () {
    // MUTATION-DRIVEN, AND IT DOES NOT COVER WHAT I FIRST CLAIMED. Read this
    // before trusting it.
    //
    // Every other interdiction test attacks from a direct neighbour, so "final
    // hop" and "every hop" are the same thing there. This one uses a two-hop
    // route so the two differ — and removing the `w.hop >= lastHop` guard in
    // sim/movement.js STILL passes.
    //
    // The reason is not a weak test, it is the traversal rule.
    // _moveCanTraverse is `st.owner === pid`: a wave may only cross its OWN
    // ground, so every intermediate station on every route today belongs to the
    // wave's owner — and _chargeApproach returns early on exactly that. The
    // final-hop guard is therefore CURRENTLY UNOBSERVABLE. It is correct and it
    // is forward-looking, and no test can distinguish it until B1 lets a wave
    // walk past ground it does not hold.
    //
    // WHEN B1 LANDS, come back here: fortify an intermediate the wave does not
    // own and the guard becomes testable in one line. Until then this asserts the
    // half that IS observable — that the loss is a function of TIME ON THE FINAL
    // LINK and not of how long the march before it was.
    //
    // The measurement: two assaults sharing the SAME final link, one launched
    // from the neighbour and one from a city behind it. Same time under the guns,
    // so the same loss.
    var sid = P.capital, cap = STATIONS[sid].capacity;

    // near = a neighbour of the fortress; far = a neighbour of `near` that is not
    // the fortress, so the route far -> near -> sid has two hops.
    var near = null, far = null;
    for (var i = 0; i < LINKS.length && !near; i++) {
      var l = LINKS[i];
      var o = (l.a === sid) ? l.b : (l.b === sid ? l.a : null);
      if (o) near = o;
    }
    for (var j = 0; j < LINKS.length && !far; j++) {
      var m = LINKS[j];
      var q = (m.a === near) ? m.b : (m.b === near ? m.a : null);
      if (q && q !== sid) far = q;
    }
    assert(near && far, 'could not find a two-hop approach to ' + sid);

    // `fortify` is the control switch. Since B1 a two-hop march pays MORE march
    // attrition than a one-hop march simply because it is longer, so comparing
    // raw losses compares route length. Running each distance both with and
    // without the fort and differencing isolates the fort's own contribution,
    // which is the only quantity this test is about.
    function assaultFrom(src, expectHops, fortify) {
      var s = _devtBoard('fra', sid, cap * 2);
      if (fortify) applyCommand(s, { type: 'build', owner: 'fra', stations: [sid], kind: 'fort' });
      s.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
      assert(!fortify || operatingTier(s, sid) > 0, 'the fortress is not operating');
      setStationOwner(s, near, 'ger');
      setStationOwner(s, far, 'ger');
      s.stations[src].units = { infantry: 60, artillery: 0, armour: 0 };
      var res = applyCommand(s, {
        type: 'send', owner: 'ger', sources: [src], target: sid, fraction: 1,
      });
      assert(res.ok, 'launch from ' + src + ' failed: ' + JSON.stringify(res.rejected));
      var w = s.waves[s.waves.length - 1];
      assertEqual(w.path.length - 1, expectHops,
        'the route from ' + src + ' is ' + (w.path.length - 1) + ' hops, not ' +
        expectHops + ' — this test is not measuring what it claims');
      var launched = totalUnits(w.units);
      var guard = 0;
      while (s.waves.indexOf(w) >= 0 && guard++ < 8000) movementTick(s);
      return launched - totalUnits(w.units);
    }

    var oneHop = assaultFrom(near, 1, true) - assaultFrom(near, 1, false);
    var twoHop = assaultFrom(far, 2, true) - assaultFrom(far, 2, false);
    assert(oneHop > 0, 'the one-hop assault paid nothing for the fort; fixture is wrong');

    // THE TOLERANCE IS DERIVED FROM BOTH SIDES, not picked to make this pass.
    //
    // The two are not bit-identical and cannot be: the toll compounds per CHUNK
    // of tick spent on the hop, and a two-hop wave reaches the final link partway
    // through a tick, so the same total time under the guns arrives split
    // differently. (1-kt1)(1-kt2) is not 1-k(t1+t2). Since B1 the differencing
    // above also leaves a little attrition-interaction residue, because a wave
    // that is slightly smaller pays the fort toll on a slightly smaller stack.
    //
    // The failure being guarded against is nothing like that size. Charging every
    // hop DOUBLES the two-hop contribution. 1e-2 sits far above the residue and
    // far below the signal.
    assertClose(twoHop, oneHop, 1e-2,
      'a two-hop approach lost ' + twoHop.toFixed(4) + ' where a one-hop approach ' +
      'over the same final link lost ' + oneHop.toFixed(4) + ' — the toll is being ' +
      'charged on every hop, so the fortress is taxing marches that never come ' +
      'within sight of it');
  });

  test('your own reinforcements are never bled by your own walls', function () {
    var sid = P.capital, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap * 2);
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    s.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
    assert(operatingTier(s, sid) > 0, 'the fixture is not operating');

    var src = null;
    for (var i = 0; i < LINKS.length && !src; i++) {
      var l = LINKS[i];
      var o = (l.a === sid) ? l.b : (l.b === sid ? l.a : null);
      if (o) src = o;
    }
    setStationOwner(s, src, 'ger');
    s.stations[src].units = { infantry: 40, artillery: 0, armour: 0 };
    applyCommand(s, { type: 'send', owner: 'ger', sources: [src], target: sid, fraction: 1 });
    var w = s.waves[s.waves.length - 1];
    var launched = totalUnits(w.units);
    var guard = 0;
    while (s.waves.indexOf(w) >= 0 && guard++ < 4000) movementTick(s);
    var lost = launched - totalUnits(w.units);

    // Control: the same march with no fortification built. Both pay march
    // attrition since B1; only the fort is being tested.
    var c = _devtBoard('ger', sid, cap * 2);
    c.stations[sid].units = { infantry: cap, artillery: 0, armour: 0 };
    setStationOwner(c, src, 'ger');
    c.stations[src].units = { infantry: 40, artillery: 0, armour: 0 };
    applyCommand(c, { type: 'send', owner: 'ger', sources: [src], target: sid, fraction: 1 });
    var cw = c.waves[c.waves.length - 1];
    var cLaunched = totalUnits(cw.units);
    guard = 0;
    while (c.waves.indexOf(cw) >= 0 && guard++ < 4000) movementTick(c);

    assertClose(lost, cLaunched - totalUnits(cw.units), 1e-6,
      'a power marching into its OWN fortress paid more than the same march to an ' +
      'undeveloped city — your walls are shooting at you');
  });

  test('port and factory are tracked and have NO effect yet — and say so', function () {
    // A half-built mechanic that reads as finished is worse than an obviously
    // unfinished one. DEV_LIVE is the single source of truth the readout reads,
    // so the screen cannot claim an effect the sim does not have.
    assertEqual(DEV_LIVE.fort, true, 'fortification should be live');
    assertEqual(DEV_LIVE.port, false, 'DEV_LIVE says the port works; nothing implements it');
    assertEqual(DEV_LIVE.factory, false, 'DEV_LIVE says the factory works; nothing implements it');

    var sid = P.coastal, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    var before = fortLevel(sid, s);
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'port' });
    assertEqual(builtTier(s, sid), 1, 'the port did not build');
    assertClose(fortLevel(sid, s), before, 1e-9,
      'a port raised defence — it should have no effect at all yet');
  });

  // ── scheduled by construction ──────────────────────────────────────────

  test('build goes through the queue, and nothing happens until the drain', function () {
    // 07-roadmap.md A3: "build is the first verb that is scheduled by
    // construction". This is that claim, checked.
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    var q = queueCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assert(q.ok, 'the queue refused a build: ' + q.reason);
    assertEqual(builtTier(s, sid), 0, 'queueing a build applied it immediately');
    stepTick(s);
    assertEqual(builtTier(s, sid), 1, 'the build never drained');
  });

  test('the event log names the build', function () {
    var sid = P.plainHolding, cap = STATIONS[sid].capacity;
    var s = _devtBoard('ger', sid, cap);
    var before = s.log.length;
    applyCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
    assert(s.log.length > before, 'a build wrote nothing to the log');
    var e = s.log[s.log.length - 1];
    assertEqual(e.kind, 'build', 'the log entry is not a build');
    assertEqual(e.sid, sid, 'the log entry does not name the station');
    assert(e.text.indexOf('Fortification') >= 0, 'the log entry does not name what was built');
  });

  test('a build is deterministic and snapshot-safe', function () {
    var sid = P.capital, cap = STATIONS[sid].capacity;
    function run() {
      var s = _devtBoard('ger', sid, cap * 2);
      queueCommand(s, { type: 'build', owner: 'ger', stations: [sid], kind: 'fort' });
      stepTicks(s, 40);
      return JSON.stringify(snapshot(s));
    }
    assertEqual(run(), run(), 'two identical runs with a build diverged');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/development-tests.js`
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
    suiteDevelopment();
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
