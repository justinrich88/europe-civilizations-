// test/fog-tests.js — fog of war (milestone 5.7, stages 0, 1 and 2).
//
// Four suites, registered from test/runner.js:
//
//   fog / vision data   the `vision` field tools/build-stations.js writes
//   fog / visibleTo     the gate itself, core/vision.js
//   fog / memory        state.seen — observeTick and believedStation (stage 2)
//   fog / layering      "nothing in sim/ consults visibility", as a TESTED FACT
//
// Kept out of test/runner.js deliberately — runner.js is 4,000 lines and is
// being edited by other hands; a new subject gets a new file and one hook.
//
// Private helpers are prefixed `_fog`, by FILE (known-issues #12).
//
// Every fixture derives its station ids by SCANNING the live data at test time.
// Nothing here hard-codes a station id, so the suites survive the map being
// regenerated — which is the whole reason data/stations.js is generated.

// The authored band for how many stations may see 2 hops. Not a balance
// constant, so it does not belong in BAL: it is the range outside which the
// build script has plainly regressed rather than been retuned.
//
// Today it is 12 of 108 — 7 `defensive` stations plus 5 authored observation
// points. The band exists to catch the two failures that produce a CONSTANT
// field and would otherwise pass every other assertion here: a rule handing
// everyone 2 (108) and a rule handing nobody 2 (0).
var FOG_VISION2_MIN = 8;
var FOG_VISION2_MAX = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Adjacency over LINKS, built fresh per call. This is a TEST-SIDE traversal on
// purpose: reusing core/vision.js's own walk to check core/vision.js would make
// the suite agree with the code by construction rather than by fact.
// `seaOK === false` drops every `sea: true` crossing, which is what makes the
// sea test able to tell "reached over water" from "reached anyway by land".
function _fogAdj(seaOK) {
  var adj = {}, i;
  for (i = 0; i < STATION_IDS.length; i++) adj[STATION_IDS[i]] = [];
  for (i = 0; i < LINKS.length; i++) {
    var l = LINKS[i];
    if (!seaOK && l.sea) continue;
    if (adj[l.a]) adj[l.a].push(l.b);
    if (adj[l.b]) adj[l.b].push(l.a);
  }
  return adj;
}

// Plain hop distances from one station, over `adj`. { sid: hops }, absent when
// unreachable.
function _fogHops(from, adj) {
  var dist = {}, frontier = [from], next, i, j;
  dist[from] = 0;
  var d = 0;
  while (frontier.length) {
    next = [];
    d++;
    for (i = 0; i < frontier.length; i++) {
      var nb = adj[frontier[i]] || [];
      for (j = 0; j < nb.length; j++) {
        if (dist[nb[j]] === undefined) { dist[nb[j]] = d; next.push(nb[j]); }
      }
    }
    frontier = next;
  }
  return dist;
}

// A board on which `pid` holds exactly `sid` and nothing else. Everything the
// power held at turn zero is handed to `neutral` first.
//
// Goes through setStationOwner in both directions rather than writing
// `station.owner`: a raw write leaves state.ownerEpoch behind, and 01-data-
// schema.md says that includes test fixtures.
function _fogOnly(seed, pid, sid) {
  var s = newGame(seed);
  for (var i = 0; i < STATION_IDS.length; i++) {
    if (s.stations[STATION_IDS[i]].owner === pid) {
      setStationOwner(s, STATION_IDS[i], 'neutral');
    }
  }
  setStationOwner(s, sid, pid);
  return s;
}

// Real powers, sorted. `neutral` is a power id but never an actor, and at turn
// zero it holds 101 of 108 stations, so it is the one "power" for which nothing
// is hidden — including it would make the level-0 test unsatisfiable.
function _fogPowers() {
  return Object.keys(POWERS).sort().filter(function (p) { return p !== 'neutral'; });
}

// Whole-file source for a list of paths, when the filesystem is reachable
// (node). Same shape and the same root-probing as _aiSourceText in
// test/ai-tests.js — it reads real files off disk, which covers private
// helpers that no toString could reach. Returns null in a browser.
function _fogSourceOf(files) {
  try {
    var req = null;
    if (typeof require === 'function') req = require;
    else if (typeof process !== 'undefined' && process.mainModule &&
             typeof process.mainModule.require === 'function') {
      req = function (m) { return process.mainModule.require(m); };
    }
    if (!req) return null;
    var fs = req('fs');
    var roots = ['', './'];
    if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
      roots.push(String(process.argv[1]).replace(/test[\/\\]node\.js$/, ''));
    }
    for (var r = 0; r < roots.length; r++) {
      var found = [];
      for (var f = 0; f < files.length; f++) {
        var p = roots[r] + files[f];
        try { if (fs.existsSync(p)) found.push({ path: files[f], text: fs.readFileSync(p, 'utf8') }); }
        catch (e) { /* try the next root */ }
      }
      if (found.length) return found;
    }
  } catch (e) { /* no filesystem: browser */ }
  return null;
}

// Every .js file under a directory, relative to the project root.
function _fogFilesIn(dir) {
  try {
    // Under test/node.js every file is evaluated with vm.runInThisContext, so
    // `require` is NOT in scope — only process.mainModule.require is. Same
    // ladder as _aiSourceText; getting it wrong silently SKIPS this suite,
    // which is the one outcome a layering check must never have.
    var req = null;
    if (typeof require === 'function') req = require;
    else if (typeof process !== 'undefined' && process.mainModule &&
             typeof process.mainModule.require === 'function') {
      req = function (m) { return process.mainModule.require(m); };
    }
    if (!req) return null;
    var fs = req('fs');
    var roots = ['', './'];
    if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
      roots.push(String(process.argv[1]).replace(/test[\/\\]node\.js$/, ''));
    }
    for (var r = 0; r < roots.length; r++) {
      try {
        var names = fs.readdirSync(roots[r] + dir);
        var out = [];
        for (var i = 0; i < names.length; i++) {
          if (/\.js$/.test(names[i])) out.push(dir + '/' + names[i]);
        }
        if (out.length) return out.sort();
      } catch (e) { /* try the next root */ }
    }
  } catch (e) { /* no filesystem */ }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point — called from runAllTests()
// ---------------------------------------------------------------------------

function suiteFog(d) {
  _fogSuiteVisionData(d);
  _fogSuiteVisibleTo(d);
  _fogSuiteMemory(d);
  _fogSuiteLayering(d);
}

// ---------------------------------------------------------------------------
// fog / vision data
// ---------------------------------------------------------------------------

function _fogSuiteVisionData(d) {
  if (!d.STATIONS) return skipSuite('fog / vision data', 'data/stations.js not loaded');
  if (typeof stationVision !== 'function') {
    return skipSuite('fog / vision data', 'core/vision.js not loaded');
  }
  suite('fog / vision data');
  var S = d.STATIONS;
  var sids = Object.keys(S).sort();

  test('every station carries a numeric vision of at least 1', function () {
    var problems = [];
    for (var i = 0; i < sids.length; i++) {
      var v = S[sids[i]].vision;
      if (typeof v !== 'number' || !isFinite(v)) {
        problems.push(sids[i] + ' vision=' + JSON.stringify(v) + ', expected a number');
      } else if (v < 1) {
        problems.push(sids[i] + ' vision=' + v + ', expected >= 1');
      }
    }
    assertNone(problems,
      'vision is a field on the station record, written by tools/build-stations.js');
  });

  test('every defensive station sees 2 hops', function () {
    var problems = [], any = 0;
    for (var i = 0; i < sids.length; i++) {
      if (S[sids[i]].type !== 'defensive') continue;
      any++;
      if (stationVision(sids[i]) !== 2) {
        problems.push(sids[i] + ' is defensive but sees ' + stationVision(sids[i]));
      }
    }
    // Vacuity guard: a map with no defensive stations would pass the loop above
    // without asserting anything at all (known-issues #8).
    assert(any > 0, 'no defensive stations on the map — this test proved nothing');
    assertNone(problems, 'a citadel exists to watch ground; defensive => vision 2');
  });

  test('the number of 2-hop stations is inside the authored band', function () {
    var n = 0;
    for (var i = 0; i < sids.length; i++) if (stationVision(sids[i]) === 2) n++;
    assertBetween(n, FOG_VISION2_MIN, FOG_VISION2_MAX,
      'stations with vision 2 (' + n + ' of ' + sids.length + '). Outside this band the ' +
      'build script has regressed — a rule handing everyone 2, or nobody 2, lands here.');
  });

  // CONTROL. Every assertion above is satisfied by a constant field: "all 2"
  // passes #2, and "all 1" passes #1. A suite that cannot tell a real
  // distribution from a constant one is worse than no suite (known-issues #8).
  test('vision actually VARIES — at least one station at 1 and at least one at 2', function () {
    var ones = [], twos = [];
    for (var i = 0; i < sids.length; i++) {
      var v = stationVision(sids[i]);
      if (v === 1) ones.push(sids[i]);
      else if (v === 2) twos.push(sids[i]);
    }
    assert(ones.length > 0, 'no station sees only 1 hop — vision is constant at 2, so fog does nothing');
    assert(twos.length > 0, 'no station sees 2 hops — vision is constant at 1, so observation points do nothing');
  });
}

// ---------------------------------------------------------------------------
// fog / visibleTo
// ---------------------------------------------------------------------------

function _fogSuiteVisibleTo(d) {
  var fns = simFns();
  if (typeof visibleTo !== 'function') {
    return skipSuite('fog / visibleTo', 'core/vision.js not loaded');
  }
  if (!fns.newGame || typeof setStationOwner !== 'function' || !d.STATIONS || !d.LINKS) {
    return skipSuite('fog / visibleTo', 'core/state.js or data/ not loaded');
  }
  suite('fog / visibleTo');
  var S = d.STATIONS;

  // A station of vision 1 that has ground two hops away — so "two hops is not
  // visible" is a claim about something that exists.
  var vis1 = _fogPickWithDepth(1, 2);
  // A DEFENSIVE station of vision 2 that has ground exactly two hops away. The
  // type is pinned because the claim under test is "a fort sees further", and
  // the first vision-2 station in id order is an authored observation point
  // (a `holding`), which would prove the field but not the type rule.
  var vis2 = _fogPickWithDepth(2, 2, 'defensive');

  test('a power sees every station it holds at level 2', function () {
    var s = newGame(5701);
    var pids = _fogPowers(), problems = [];
    for (var p = 0; p < pids.length; p++) {
      var v = visibleTo(s, pids[p]);
      for (var i = 0; i < STATION_IDS.length; i++) {
        var sid = STATION_IDS[i];
        if (s.stations[sid].owner === pids[p] && v[sid] !== 2) {
          problems.push(pids[p] + ' holds ' + sid + ' but reads it at level ' + v[sid]);
        }
      }
    }
    assertNone(problems, 'you always see what you are standing on');
  });

  test('a vision-1 station sees one hop and NOT two', function () {
    assert(!!vis1, 'no vision-1 station with ground two hops away — fixture is wrong');
    var pid = _fogPowers()[0];
    var s = _fogOnly(5702, pid, vis1.sid);
    var v = visibleTo(s, pid);
    var hops = _fogHops(vis1.sid, _fogAdj(true));

    var problems = [], seenAtTwo = 0, litAtOne = 0;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      var h = hops[sid];
      if (h === 0 || h === 1) {
        if (h === 1) litAtOne++;
        if (v[sid] !== 2) problems.push(sid + ' is ' + h + ' hop(s) from ' + vis1.sid + ' but reads ' + v[sid]);
      } else if (h === 2) {
        seenAtTwo++;
        if (v[sid] === 2) problems.push(sid + ' is 2 hops from a vision-1 station but reads visible');
      }
    }
    // Both guards are load-bearing: without them a visibleTo that returned 2
    // for everything, or 0 for everything, could satisfy an empty loop.
    assert(litAtOne > 0, 'no station one hop from ' + vis1.sid + ' — nothing was checked as visible');
    assert(seenAtTwo > 0, 'no station two hops from ' + vis1.sid + ' — nothing was checked as hidden');
    assertNone(problems, 'vision 1 means exactly one hop');
  });

  test('a defensive station reaches two hops', function () {
    assert(!!vis2, 'no vision-2 station with ground two hops away — fixture is wrong');
    assertEqual(S[vis2.sid].type, 'defensive',
      'the deepest-sighted fixture station should be a defensive one');
    var pid = _fogPowers()[0];
    var s = _fogOnly(5703, pid, vis2.sid);
    var v = visibleTo(s, pid);
    var hops = _fogHops(vis2.sid, _fogAdj(true));

    var problems = [], atTwo = 0;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      var h = hops[sid];
      if (h === undefined || h > 2) continue;
      if (h === 2) atTwo++;
      if (v[sid] !== 2) {
        problems.push(sid + ' is ' + h + ' hop(s) from the fort ' + vis2.sid + ' but reads ' + v[sid]);
      }
    }
    assert(atTwo > 0, 'no station exactly two hops from ' + vis2.sid + ' — the extra hop was never exercised');
    assertNone(problems, 'vision 2 means two hops, over any link');
  });

  test('vision crosses a sea link', function () {
    // Pick, at test time, a `sea: true` pair whose far end is NOT reachable
    // within the near end's vision by land alone. Without that condition the
    // test would pass against a walk that ignores the water entirely.
    var landAdj = _fogAdj(false);
    var pair = null;
    for (var i = 0; i < LINKS.length && !pair; i++) {
      if (!LINKS[i].sea) continue;
      var ends = [[LINKS[i].a, LINKS[i].b], [LINKS[i].b, LINKS[i].a]];
      for (var e = 0; e < ends.length && !pair; e++) {
        var from = ends[e][0], to = ends[e][1];
        var byLand = _fogHops(from, landAdj)[to];
        if (byLand === undefined || byLand > stationVision(from)) {
          pair = { from: from, to: to, byLand: byLand };
        }
      }
    }
    assert(!!pair, 'no sea crossing whose far shore is out of land reach — nothing to test');

    var pid = _fogPowers()[0];
    var s = _fogOnly(5704, pid, pair.from);
    var v = visibleTo(s, pid);
    assertEqual(v[pair.to], 2,
      pair.from + ' -> ' + pair.to + ' is a sea crossing (by land: ' +
      (pair.byLand === undefined ? 'unreachable' : pair.byLand + ' hops') +
      ') and must be visible across the water');
  });

  test('visibleTo is pure — the state is byte-identical before and after', function () {
    var s = newGame(5705);
    for (var i = 0; i < 40; i++) stepTick(s);          // a board with things on it
    var pids = _fogPowers();
    var before = JSON.stringify(snapshot(s));
    for (var p = 0; p < pids.length; p++) visibleTo(s, pids[p]);
    var after = JSON.stringify(snapshot(s));
    assertEqual(after.length, before.length,
      'visibleTo changed the SIZE of the state — it wrote something (a scratch field?)');
    assert(after === before,
      'visibleTo mutated the state it was only supposed to read');
  });

  test('one power\'s visibility does not depend on a distant third power', function () {
    var pids = _fogPowers();
    var subject = (pids.indexOf('ger') >= 0) ? 'ger' : pids[0];

    var s = newGame(5706);
    var base = JSON.stringify(visibleTo(s, subject));

    // Flip a station that `subject` cannot see, to a power that is not
    // `subject`. Scanning for it keeps the test honest if the map changes:
    // flipping something already visible SHOULD change the answer.
    var v = visibleTo(s, subject);
    var other = null;
    for (var p = 0; p < pids.length && !other; p++) {
      if (pids[p] === subject) continue;
      for (var i = 0; i < STATION_IDS.length; i++) {
        var sid = STATION_IDS[i];
        if (v[sid] === 0 && s.stations[sid].owner !== subject && s.stations[sid].owner !== pids[p]) {
          other = { pid: pids[p], sid: sid };
          break;
        }
      }
    }
    assert(!!other, 'found no hidden station to flip — the test would prove nothing');

    setStationOwner(s, other.sid, other.pid);
    assertEqual(JSON.stringify(visibleTo(s, subject)), base,
      'handing ' + other.sid + ' to ' + other.pid + ' changed what ' + subject +
      ' can see, and ' + subject + ' could not see it either way');
  });

  test('level 0 exists — every power has ground it cannot see on the turn-zero board', function () {
    var s = newGame(5707);
    var pids = _fogPowers(), problems = [];
    for (var p = 0; p < pids.length; p++) {
      var v = visibleTo(s, pids[p]);
      var hidden = 0;
      for (var i = 0; i < STATION_IDS.length; i++) if (v[STATION_IDS[i]] === 0) hidden++;
      if (!hidden) problems.push(pids[p] + ' sees all ' + STATION_IDS.length + ' stations at turn zero');
    }
    // This is the control for the whole suite. A visibleTo that returned 2 for
    // every station satisfies every "must be visible" assertion above; this is
    // the only one it cannot pass.
    assertNone(problems, 'fog that hides nothing is not fog');
  });
}

// A station with `want` vision — optionally of station type `type` — that has
// at least one station exactly `depth` hops away over all links. Scanned in
// sorted id order, so the pick is stable across runs and across map rebuilds.
function _fogPickWithDepth(want, depth, type) {
  var adj = _fogAdj(true);
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    if (stationVision(sid) !== want) continue;
    if (type && STATIONS[sid].type !== type) continue;
    var hops = _fogHops(sid, adj);
    for (var j = 0; j < STATION_IDS.length; j++) {
      if (hops[STATION_IDS[j]] === depth) return { sid: sid, at: STATION_IDS[j] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// fog / memory  —  stage 2
//
// Level 1 ("the station as of when you last saw it") is the only level that
// cannot be derived from the present board, so it is the only part of fog that
// is STORED. These suites exist to hold three properties that nothing else in
// the tree can see:
//
//   * the remembered number is genuinely STALE. A memory that quietly tracked
//     the live garrison would satisfy every "level 1 works" assertion anyone
//     would think to write, and would delete the entire skill the design says
//     fog creates — "decide whether last minute's number is still true".
//   * memory lives in state, so it survives snapshot() and is byte-identical
//     at 1x and 4x. This is what makes it the AI's memory as well as the
//     player's, and it is the reason it is not in render/.
//   * the human observes. aiTick's decision loop skips state.human on purpose;
//     observeTick sits ABOVE that skip, and a one-line regression that moved
//     it below would be invisible in every other test here.
// ---------------------------------------------------------------------------

// A board on which `pid` holds exactly two stations far enough apart that
// their sight cones cannot overlap, plus the station that going blind at one
// of them costs.
//
//   keep   pid holds it throughout
//   drop   pid holds it now; handing it away is how the test loses vision
//   lost   a station visible ONLY via `drop`, chosen for the most growth
//          headroom so "the live board moves on" is a real movement and not a
//          station already sitting at capacity
//
// Everything is SCANNED rather than hard-coded, and the `after` set is
// computed on a snapshot rather than assumed, so the fixture cannot quietly
// stop selecting anything when the map is regenerated.
//
// AI-quiet by construction (`aiEnabled = false`), which also means observeTick
// never fires on its own here: every observation in these tests is an explicit
// call, at a tick the test chose.
function _fogMemFixture(seed, pid) {
  var adj = _fogAdj(true);
  var keep = STATION_IDS[0];
  var hops = _fogHops(keep, adj);
  var drop = null, i, sid;
  for (i = 0; i < STATION_IDS.length; i++) {
    // 5 hops is comfortably past the deepest sight on the board (2), so no
    // amount of vision at `keep` can cover for `drop`.
    if (hops[STATION_IDS[i]] >= 5) { drop = STATION_IDS[i]; break; }
  }
  if (!drop) return null;

  var s = _fogOnly(seed, pid, keep);
  s.aiEnabled = false;
  setStationOwner(s, drop, pid);

  var before = visibleTo(s, pid);
  var scratch = snapshot(s);
  setStationOwner(scratch, drop, 'neutral');
  var after = visibleTo(scratch, pid);

  var lost = null, bestRoom = -Infinity;
  for (i = 0; i < STATION_IDS.length; i++) {
    sid = STATION_IDS[i];
    if (before[sid] !== 2 || after[sid] !== 0) continue;
    var room = STATIONS[sid].capacity - totalUnits(s.stations[sid].units);
    if (room > bestRoom) { bestRoom = room; lost = sid; }
  }
  if (!lost) return null;

  return { s: s, pid: pid, keep: keep, drop: drop, lost: lost };
}

// Advance a board without observing it. For AI-ON boards this is just the
// game running — aiTick observes on its own. For an AI-quiet fixture it is
// "time passes and nobody looks", which is what the throttle test needs.
function _fogMemStep(s, n) {
  for (var i = 0; i < n; i++) stepTick(s);
  return s;
}

// Advance an AI-QUIET board with observation running, in aiTick's own position
// — observeTick first, then the six phases, exactly as sim/step.js orders them
// (aiTick runs before growthTick and before state.tick++).
//
// THIS IS THE HELPER THE STALENESS TESTS MUST USE. Advancing with no observer
// running would let a mutant that refreshes memory every tick REGARDLESS OF
// VISIBILITY sail through them: with nobody observing, a broken observer and a
// correct one produce the same frozen record. Measured — the first version of
// this suite used _fogMemStep here and that exact mutation went green.
function _fogMemWatch(s, n) {
  for (var i = 0; i < n; i++) { observeTick(s); stepTick(s); }
  return s;
}

function _fogSuiteMemory(d) {
  if (typeof observeTick !== 'function' || typeof believedStation !== 'function') {
    return skipSuite('fog / memory', 'core/vision.js has no observeTick/believedStation');
  }
  if (typeof newGame !== 'function' || typeof stepTick !== 'function' || !d.STATIONS) {
    return skipSuite('fog / memory', 'core/state.js, sim/step.js or data/ not loaded');
  }
  suite('fog / memory');

  var pid = _fogPowers()[0];
  var iv = (typeof BAL !== 'undefined' && BAL.FOG && BAL.FOG.OBSERVE_INTERVAL) || 1;

  // -------------------------------------------------------------------------
  test('a station seen and then lost stays at level 1, with the OLD owner', function () {
    var f = _fogMemFixture(5710, pid);
    assert(!!f, 'no two stations 5+ hops apart with sight to lose — fixture is wrong');

    observeTick(f.s);                                   // tick 0, on cadence
    var live = believedStation(f.s, pid, f.lost);
    assertEqual(live.level, 2, f.lost + ' must be visible before it can be lost');
    var ownerThen = live.owner;

    setStationOwner(f.s, f.drop, 'neutral');            // go blind
    // Hand the remembered station to somebody else on the LIVE board. Without
    // this the test would pass against a believedStation that read live
    // ownership, because nothing would ever have changed it.
    var newOwner = null, pids = _fogPowers();
    for (var i = 0; i < pids.length; i++) if (pids[i] !== ownerThen && pids[i] !== pid) { newOwner = pids[i]; break; }
    assert(!!newOwner, 'no third power to hand the station to');
    setStationOwner(f.s, f.lost, newOwner);

    // The observer keeps running the whole time — it simply cannot see this
    // station any more. That is what makes the record's survival a fact about
    // VISIBILITY rather than about nobody having looked.
    _fogMemWatch(f.s, 100);

    var b = believedStation(f.s, pid, f.lost);
    assertEqual(b.level, 1, f.lost + ' was seen and is no longer visible — that is level 1, not ' + b.level);
    assertEqual(b.owner, ownerThen,
      'believedStation reported the LIVE owner (' + f.s.stations[f.lost].owner +
      ') instead of the remembered one (' + ownerThen + ')');
    assertEqual(f.s.stations[f.lost].owner, newOwner, 'the live board did not actually change');
    assertEqual(b.tick, 0, 'the record should be stamped with when it was observed');
  });

  // -------------------------------------------------------------------------
  test('the remembered garrison is genuinely STALE, not a live read', function () {
    var f = _fogMemFixture(5711, pid);
    assert(!!f, 'fixture is wrong');

    observeTick(f.s);
    var at0 = totalUnits(believedStation(f.s, pid, f.lost).units);
    setStationOwner(f.s, f.drop, 'neutral');            // go blind, then let it grow
    _fogMemWatch(f.s, 400);                             // observer running throughout

    var b = believedStation(f.s, pid, f.lost);
    var liveNow = totalUnits(f.s.stations[f.lost].units);
    assertEqual(b.level, 1, 'the fixture station stopped being fogged');
    assertClose(totalUnits(b.units), at0, 1e-9,
      'the remembered garrison moved while nobody was watching it');
    // The control. Without this a memory that never updated AND a board that
    // never moved would both pass the line above.
    assert(Math.abs(liveNow - totalUnits(b.units)) > 0.5,
      'live ' + liveNow.toFixed(2) + ' vs remembered ' + totalUnits(b.units).toFixed(2) +
      ' — after 400 ticks these must have separated, or nothing was proved stale');
  });

  // -------------------------------------------------------------------------
  test('regaining vision refreshes the record on the next observe tick', function () {
    var f = _fogMemFixture(5712, pid);
    assert(!!f, 'fixture is wrong');

    observeTick(f.s);
    setStationOwner(f.s, f.drop, 'neutral');
    _fogMemWatch(f.s, 200);                             // 200 % iv === 0
    observeTick(f.s);
    assertEqual(f.s.seen[pid][f.lost].t, 0,
      'observeTick refreshed a record for a station this power can no longer see');

    setStationOwner(f.s, f.drop, pid);                  // see it again
    observeTick(f.s);
    var rec = f.s.seen[pid][f.lost];
    assertEqual(rec.t, 200, 'the refreshed record should be stamped with the current tick');
    assertClose(rec.u.infantry + rec.u.artillery + rec.u.armour,
      totalUnits(f.s.stations[f.lost].units), 1e-9,
      'the refreshed record does not match the live garrison it just observed');
  });

  // -------------------------------------------------------------------------
  test('observeTick honours BAL.FOG.OBSERVE_INTERVAL', function () {
    assert(iv > 1, 'BAL.FOG.OBSERVE_INTERVAL is ' + iv + ' — an unthrottled sweep is ' +
      '7 visibleTo calls on every one of 60,000 ticks per game');
    var f = _fogMemFixture(5713, pid);
    assert(!!f, 'fixture is wrong');

    observeTick(f.s);
    assertEqual(f.s.seen[pid][f.keep].t, 0, 'nothing was observed at tick 0');
    _fogMemStep(f.s, 1);                                // tick 1: off cadence
    observeTick(f.s);
    assertEqual(f.s.seen[pid][f.keep].t, 0,
      'observeTick wrote at tick 1, which is not a multiple of ' + iv);
    _fogMemStep(f.s, iv - 1);                           // tick iv: on cadence
    observeTick(f.s);
    assertEqual(f.s.seen[pid][f.keep].t, iv,
      'observeTick did NOT write at tick ' + iv + ', which is on cadence');
  });

  // -------------------------------------------------------------------------
  test('state.seen survives snapshot and the restored game does not diverge', function () {
    var s = newGame(5714);                              // AI ON: observeTick rides aiTick
    _fogMemStep(s, 200);
    assert(!!s.seen && Object.keys(s.seen).length > 0, 'nothing was observed in 200 ticks');

    var snap = snapshot(s);
    assert(!!snap.seen, 'state.seen did not survive snapshot() — it is not in the state');
    assertEqual(JSON.stringify(snap.seen), JSON.stringify(s.seen),
      'the snapshot copy of state.seen differs from the original');

    // Run an unrelated game in between. A memory kept in a module-level var
    // rather than in state would be overwritten here and the restored game
    // would carry the wrong power's recollections forward.
    _fogMemStep(newGame(999), 150);

    _fogMemStep(s, 200);
    _fogMemStep(snap, 200);
    assertEqual(JSON.stringify(snap.seen), JSON.stringify(s.seen),
      'a game restored from a snapshot remembered something different from the run it came from');
    assertEqual(JSON.stringify(snap.stations), JSON.stringify(s.stations),
      'the restored board itself diverged — the snapshot is not complete');
  });

  // -------------------------------------------------------------------------
  test('1x and 4x are byte-identical, state.seen included', function () {
    // Speed multiplies HOW MANY ticks run, never the tick size (sim/step.js),
    // so "4x" here is stepTicks in batches of four over the same 400 ticks.
    var runBy = function (batch) {
      var s = newGame(5715);
      for (var t = 0; t < 400; t += batch) stepTicks(s, batch);
      var records = 0, k = Object.keys(s.seen || {});
      for (var i = 0; i < k.length; i++) records += Object.keys(s.seen[k[i]]).length;
      return {
        records: records,
        json: JSON.stringify({ seen: s.seen, st: s.stations, rng: s.rng, tick: s.tick }),
      };
    };
    var one = runBy(1), four = runBy(4);
    // Vacuity guard: an observeTick that never wrote anything would make the
    // two runs identical for the least interesting possible reason.
    assert(one.records > 0, 'state.seen was empty after 400 ticks — this compared nothing');
    assertEqual(one.json.length, four.json.length, '1x and 4x produced different-sized states');
    assertEqual(one.json === four.json, true,
      '1x and 4x diverged with fog on — a tick-count throttle became a wall-clock one?');
  });

  // -------------------------------------------------------------------------
  test('observeTick never writes a record for a station at level 0', function () {
    var s = newGame(5716);
    observeTick(s);
    var pids = _fogPowers(), problems = [], written = 0, hidden = 0;
    for (var p = 0; p < pids.length; p++) {
      var v = visibleTo(s, pids[p]);
      var mem = (s.seen && s.seen[pids[p]]) || {};
      for (var i = 0; i < STATION_IDS.length; i++) {
        var sid = STATION_IDS[i];
        if (v[sid] === 0) hidden++;
        if (!mem[sid]) continue;
        written++;
        if (v[sid] !== 2) problems.push(pids[p] + ' remembers ' + sid + ' at level ' + v[sid]);
      }
    }
    assert(written > 0, 'no power wrote any record at all — nothing was checked');
    assert(hidden > 0, 'every station was visible to everybody — nothing was checked');
    assertNone(problems, 'a record for ground never seen would delete the difference ' +
      'between hidden and fogged, which is the whole of stage 2');

    // ...and the read side agrees: an unseen station reports level 0 with no
    // numbers on it at all.
    var v0 = visibleTo(s, pids[0]), unseen = null;
    for (var j = 0; j < STATION_IDS.length && !unseen; j++) {
      if (v0[STATION_IDS[j]] === 0) unseen = STATION_IDS[j];
    }
    var b = believedStation(s, pids[0], unseen);
    assertEqual(b.level, 0, unseen + ' has never been seen by ' + pids[0]);
    assertEqual(b.owner, null, 'a hidden station must not report an owner');
    assertEqual(b.units, null, 'a hidden station must not report a garrison');
  });

  // -------------------------------------------------------------------------
  test('memory is PER OBSERVER — two powers remember different boards', function () {
    var s = newGame(5717);
    observeTick(s);
    var pids = _fogPowers();
    var a = (pids.indexOf('ger') >= 0) ? 'ger' : pids[0];
    var b = (pids.indexOf('fra') >= 0) ? 'fra' : pids[1];
    assert(a !== b, 'need two distinct powers');

    var memA = (s.seen && s.seen[a]) || {}, memB = (s.seen && s.seen[b]) || {};
    var onlyA = null, onlyB = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      if (memA[sid] && !memB[sid] && !onlyA) onlyA = sid;
      if (memB[sid] && !memA[sid] && !onlyB) onlyB = sid;
    }
    assert(!!onlyA, a + ' remembers nothing ' + b + ' does not — the store is shared');
    assert(!!onlyB, b + ' remembers nothing ' + a + ' does not — the store is shared');
    assertEqual(believedStation(s, b, onlyA).level, 0,
      onlyA + ' is remembered by ' + a + ' and must be hidden to ' + b);
  });

  // -------------------------------------------------------------------------
  test('the human is observed too, even though aiTick skips their decisions', function () {
    var s = newGame(5718);
    var pids = _fogPowers();
    s.human = (pids.indexOf('ger') >= 0) ? 'ger' : pids[0];
    _fogMemStep(s, 100);

    var mem = (s.seen && s.seen[s.human]) || {};
    assert(Object.keys(mem).length > 0,
      s.human + ' is the human and remembers nothing after 100 ticks — observeTick is ' +
      'below aiTick\'s state.human skip, so the player gets binary fog');

    // The control: prove the skip this test is about is actually in force, or
    // the assertion above would pass for the wrong reason.
    var acted = 0, log = s.aiLog || [];
    for (var i = 0; i < log.length; i++) if (log[i].power === s.human) acted++;
    assertEqual(acted, 0, s.human + ' took ' + acted + ' AI decisions — the human is not ' +
      'being skipped, so this test proved nothing about observeTick\'s position');
  });
}

// ---------------------------------------------------------------------------
// fog / layering
//
// "Nothing in sim/ consults visibility" is the load-bearing sentence of the
// whole design (02-visibility-and-sea.md §1): the sim state stays TOTAL and
// only the reads are partial, which is what preserves seeded replay,
// byte-identical 1x-vs-4x and headless testing. A sentence in a comment is not
// a check. This reads the real files off disk and greps them, reusing
// _aiStripText from test/ai-tests.js so a banned name inside a comment or a
// quoted string is not a false positive.
// ---------------------------------------------------------------------------

function _fogSuiteLayering(d) {
  var simFiles = _fogFilesIn('sim');
  if (!simFiles) return skipSuite('fog / layering', 'no filesystem — run under node');
  if (typeof _aiStripText !== 'function') {
    return skipSuite('fog / layering', 'test/ai-tests.js not loaded (_aiStripText)');
  }
  suite('fog / layering');

  test('nothing in sim/ mentions visibility at all', function () {
    var srcs = _fogSourceOf(simFiles);
    assert(!!srcs && srcs.length >= 5,
      'could not read sim/*.js — read ' + (srcs ? srcs.length : 0) + ' file(s); the check did not run');
    var banned = ['visibleTo', 'believedStation', 'observeTick', 'stationVision', 'state.seen'];
    var problems = [];
    for (var i = 0; i < srcs.length; i++) {
      var clean = _aiStripText(srcs[i].text);
      for (var b = 0; b < banned.length; b++) {
        var re = new RegExp(banned[b].replace('.', '\\s*\\.\\s*'));
        if (re.test(clean)) problems.push(srcs[i].path + ' mentions ' + banned[b]);
      }
    }
    assertNone(problems,
      'fog must never enter the sim — two states differing only in what a power ' +
      'has SEEN would no longer be comparable, and every determinism guarantee ' +
      'in the project rests on that comparison');
  });

  test('core/vision.js reaches for no DOM, no clock and no unseeded entropy', function () {
    var srcs = _fogSourceOf(['core/vision.js']);
    assert(!!srcs && srcs.length === 1 && srcs[0].text.length > 200,
      'could not read core/vision.js — the check did not run');
    var clean = _aiStripText(srcs[0].text);
    var banned = [
      { re: /\bMath\s*\.\s*random\b/, name: 'Math.random' },
      { re: /\bDate\s*\.\s*now\b/, name: 'Date.now' },
      { re: /\bnew\s+Date\b/, name: 'new Date' },
      { re: /\bdocument\b/, name: 'document' },
    ];
    var problems = [];
    for (var i = 0; i < banned.length; i++) {
      if (banned[i].re.test(clean)) problems.push(banned[i].name + ' appears in core/vision.js');
    }
    // core/util.js DOES touch the DOM, so core/ is not a DOM-free layer today.
    // This file has to be, because ai/ and tools/balance.js both load it and
    // neither has a document to reach.
    assertNone(problems, 'core/vision.js is loaded headless by tools/balance.js and test/node.js');
  });
}
