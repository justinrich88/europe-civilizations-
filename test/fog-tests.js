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
  _fogSuiteOwnCountries(d);
  _fogSuiteWaves(d);
  _fogSuiteMemory(d);
  _fogSuiteAiSymmetry(d);
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
// fog / own countries
//
// "You know your own countries": hold AT LEAST ONE station in a territory and
// every station in it is level 2 for you.
//
// WHY THESE FIXTURES ARE SCANNED AND NOT PICKED. The rule is only observable
// where it disagrees with the hop walk — a country whose stations all sit
// within one hop of each other is revealed by vision 1 alone, and a test built
// on one would pass with the rule deleted (known-issues #8 rule 1). So every
// test below is built on a territory that HAS a station out of sight-reach of
// another station in the same territory, found by scanning the live map. On
// today's board 10 of 30 territories qualify; that number is not asserted,
// because it is a fact about the map rather than about the rule, but the
// existence of at least one is, and loudly.
//
// The stakes are higher than the two-to-eight stations this reveals. The veil
// in render/map.js clears the WHOLE POLYGON of a country the viewer stands in,
// and it may only do that because this rule guarantees there are no hidden
// cities inside it. Cleared ground with no cities on it reads as "this country
// is empty" — a confident lie, known-issues #18 in geometry. If these tests go
// red, the map is lying, not merely under-informing.
// ---------------------------------------------------------------------------

// Territories where the presence rule is OBSERVABLE, scanned off the live map:
// { tid, sid, far } — hold `sid` alone and `far` is every station in `tid` that
// the hop walk cannot reach from it. One entry per territory, the first
// qualifying station in sorted order, so the pick is stable across runs.
//
// The hop walk here is the test's own (_fogHops over _fogAdj), never
// core/vision.js's — checking vision.js with vision.js would make the suite
// agree with the code by construction.
function _fogPresenceCandidates() {
  var adj = _fogAdj(true);
  var out = [];
  for (var t = 0; t < TERRITORY_IDS.length; t++) {
    var tid = TERRITORY_IDS[t];
    var inside = stationsIn(tid);
    if (inside.length < 2) continue;
    for (var i = 0; i < inside.length; i++) {
      var sid = inside[i];
      var hops = _fogHops(sid, adj);
      var v = stationVision(sid);
      var far = [];
      for (var j = 0; j < inside.length; j++) {
        var other = inside[j];
        if (other === sid) continue;
        if (hops[other] === undefined || hops[other] > v) far.push(other);
      }
      if (far.length) { out.push({ tid: tid, sid: sid, far: far, hops: hops, vision: v }); break; }
    }
  }
  return out;
}

function _fogSuiteOwnCountries(d) {
  var fns = simFns();
  if (typeof visibleTo !== 'function') {
    return skipSuite('fog / own countries', 'core/vision.js not loaded');
  }
  if (!fns.newGame || typeof setStationOwner !== 'function' ||
      typeof stationsIn !== 'function' || !d.STATIONS || !d.LINKS) {
    return skipSuite('fog / own countries', 'core/state.js or data/ not loaded');
  }
  suite('fog / own countries');

  var cands = _fogPresenceCandidates();
  var pick = cands.length ? cands[0] : null;

  test('holding ONE station in a country reveals every station in it', function () {
    assert(!!pick, 'no territory has a station out of sight-reach of a sibling — ' +
      'the rule is unobservable on this map and nothing below proves anything');
    var pid = _fogPowers()[0];
    var s = _fogOnly(5710, pid, pick.sid);
    var v = visibleTo(s, pid);

    var inside = stationsIn(pick.tid), problems = [];
    for (var i = 0; i < inside.length; i++) {
      if (v[inside[i]] !== 2) {
        problems.push(inside[i] + ' is in ' + pick.tid + ' with ' + pid + ' holding ' +
          pick.sid + ' but reads level ' + v[inside[i]]);
      }
    }
    // THE GUARD THAT MAKES THIS A TEST. Without it, a board where vision alone
    // already lit the whole country would pass with the rule removed.
    assert(pick.far.length > 0, 'fixture is wrong — nothing in ' + pick.tid +
      ' is out of reach of ' + pick.sid);
    assertNone(problems, 'you know your own countries: presence in ' + pick.tid +
      ' must reveal all ' + inside.length + ' of its stations, including ' +
      pick.far.join(', ') + ' — out of the ' + pick.vision + '-hop reach of ' + pick.sid);
  });

  test('a country you hold nothing in is unaffected — presence does not leak', function () {
    assert(!!pick, 'no observable territory — see the test above');
    var pid = _fogPowers()[0];
    var s = _fogOnly(5711, pid, pick.sid);
    var v = visibleTo(s, pid);

    var problems = [], witnesses = 0, i, j;
    for (i = 0; i < TERRITORY_IDS.length; i++) {
      var tid = TERRITORY_IDS[i];
      if (tid === pick.tid) continue;
      var inside = stationsIn(tid);
      var lit = 0, dark = 0;
      for (j = 0; j < inside.length; j++) {
        // The hop walk is the whole expected answer outside the held country.
        var h = pick.hops[inside[j]];
        var reach = (h !== undefined && h <= pick.vision);
        if (reach) lit++; else dark++;
        if (reach && v[inside[j]] !== 2) {
          problems.push(inside[j] + ' is ' + h + ' hop(s) away but reads ' + v[inside[j]]);
        }
        if (!reach && v[inside[j]] !== 0) {
          problems.push(inside[j] + ' is in ' + tid + ', which ' + pid +
            ' holds nothing in, and is out of hop reach — but reads level ' +
            v[inside[j]] + '. Presence leaked across a border.');
        }
      }
      // A country with a lit station AND a dark one is the case that separates
      // "presence, where I stand" from "presence, wherever I can see".
      if (lit && dark) witnesses++;
    }
    assert(witnesses > 0, 'no country outside ' + pick.tid + ' is partly seen and ' +
      'partly not — the leak this test looks for could not have shown up');
    assertNone(problems, 'presence reveals the country you STAND in, and stops at its border');
  });

  test('the rule is per-power — two powers with presence elsewhere see different countries', function () {
    // Two observable territories far enough apart that neither power's hop walk
    // can reach into the other's country. Scanned, so it survives a map rebuild.
    var pair = null;
    for (var i = 0; i < cands.length && !pair; i++) {
      for (var j = i + 1; j < cands.length && !pair; j++) {
        var h = cands[i].hops[cands[j].sid];
        if (h === undefined || h >= 6) pair = [cands[i], cands[j]];
      }
    }
    assert(!!pair, 'no two observable territories at least 6 hops apart — ' +
      'the two powers could not be separated');

    var pids = _fogPowers();
    assert(pids.length >= 2, 'fewer than two real powers on this board');
    var a = pids[0], b = pids[1];

    // One board, both powers on it, so the two answers are read off the same
    // state — a difference cannot be an artifact of two different fixtures.
    var s = _fogOnly(5712, a, pair[0].sid);
    for (var k = 0; k < STATION_IDS.length; k++) {
      if (s.stations[STATION_IDS[k]].owner === b) setStationOwner(s, STATION_IDS[k], 'neutral');
    }
    setStationOwner(s, pair[1].sid, b);

    var va = visibleTo(s, a);
    var vb = visibleTo(s, b);
    var problems = [], m;

    for (m = 0; m < pair[0].far.length; m++) {
      var farA = pair[0].far[m];
      if (va[farA] !== 2) problems.push(a + ' stands in ' + pair[0].tid + ' but cannot see ' + farA);
      if (vb[farA] === 2) {
        problems.push(b + ' stands in ' + pair[1].tid + ' and can see ' + farA +
          ' in ' + pair[0].tid + ' — the reveal is not per-power');
      }
    }
    for (m = 0; m < pair[1].far.length; m++) {
      var farB = pair[1].far[m];
      if (vb[farB] !== 2) problems.push(b + ' stands in ' + pair[1].tid + ' but cannot see ' + farB);
      if (va[farB] === 2) {
        problems.push(a + ' stands in ' + pair[0].tid + ' and can see ' + farB +
          ' in ' + pair[1].tid + ' — the reveal is not per-power');
      }
    }
    assertNone(problems, 'presence is a fact about a power, not about the board: ' +
      a + ' knows ' + pair[0].tid + ', ' + b + ' knows ' + pair[1].tid + ', neither knows both');
  });

  test('visibleTo stays pure with the presence rule running', function () {
    // The existing purity test in fog / visibleTo runs on a turn-zero-shaped
    // board where the rule reveals almost nothing. This one runs it on a board
    // BUILT so the rule fires, because "pure except on the path that does the
    // work" is the shape a purity regression actually takes: the obvious
    // implementation of "reveal the country" is a scratch set hung off the
    // station or the territory.
    assert(!!pick, 'no observable territory — the rule would not have fired');
    var pid = _fogPowers()[0];
    var s = _fogOnly(5713, pid, pick.sid);
    for (var i = 0; i < 40; i++) stepTick(s);

    var before = JSON.stringify(snapshot(s));
    var v = visibleTo(s, pid);
    var after = JSON.stringify(snapshot(s));

    // Vacuity guard: if the presence rule did not actually reveal anything on
    // this board, the test measured the purity of a code path that never ran.
    var revealed = 0, inside = stationsIn(pick.tid);
    for (i = 0; i < pick.far.length; i++) if (v[pick.far[i]] === 2) revealed++;
    assert(revealed > 0, 'the presence rule revealed nothing on this board — ' +
      'purity was measured on a path that did not run');
    assert(inside.length > 1, 'fixture territory has one station');

    assertEqual(after.length, before.length,
      'visibleTo changed the SIZE of the state — the presence rule wrote something');
    assert(after === before,
      'visibleTo mutated the state while revealing ' + pick.tid);
  });
}

// ---------------------------------------------------------------------------
// fog / wave vision  —  B2
//
// 06-movement-and-attrition.md §5: *a wave grants level 2 to both endpoints of
// the hop it is currently on.*
//
// THE REASON THIS SUITE IS HARD TO WRITE HONESTLY is the same reason the
// feature waited for B1. Before passage, every station a wave touched was
// ground its owner already held, so an implementation that revealed nothing
// whatsoever would have passed any test written on an ordinary board — the
// stations would have been level 2 anyway, by the first rule in visibleTo. So
// every assertion here is made on a station the fixture has PROVEN dark first,
// and the fixture itself asserts that it found one.
//
// The fixture is a power reduced to a single city, with a land path leading out
// of it whose stations from index 2 onward are all level 0. Scanned from the
// live map at test time like everything else in this file: no station id is
// written down here.
// ---------------------------------------------------------------------------

// The first BFS-tree path out of `from`, `want` stations long, whose tail
// (index 2 onward — index 1 is adjacent to `from` and is visible by the
// ordinary hop rule) is entirely dark for whoever `vis` belongs to.
//
// Returns null when the map cannot supply one, and every caller asserts on that
// rather than quietly measuring nothing.
function _fogDarkPath(from, adj, vis, want) {
  var prev = {}, seen = {}, q = [from], i, j;
  seen[from] = true;
  while (q.length) {
    var cur = q.shift(), nb = adj[cur] || [];
    for (j = 0; j < nb.length; j++) {
      if (seen[nb[j]]) continue;
      seen[nb[j]] = true;
      prev[nb[j]] = cur;
      q.push(nb[j]);
    }
  }
  for (i = 0; i < STATION_IDS.length; i++) {      // sorted, so this is stable
    var sid = STATION_IDS[i];
    if (!seen[sid] || sid === from) continue;
    var path = [sid], c = sid;
    while (c !== from) { c = prev[c]; path.unshift(c); }
    if (path.length !== want) continue;
    var dark = true;
    for (j = 2; j < path.length; j++) if (vis[path[j]] !== 0) dark = false;
    if (dark) return path;
  }
  return null;
}

// { seed, pid, home, path, adj } or null. NO STATE — see _fogWaveBoard.
//
// Land links only (`_fogAdj(false)`): a sea hop is a different arrival rule
// (the beachhead remainder, 02-visibility-and-sea.md §3b) and mixing it in
// would make a failure here ambiguous between two subsystems.
function _fogWaveFixture(seed) {
  var adj = _fogAdj(false);
  var powers = _fogPowers();
  var base = newGame(seed);
  for (var p = 0; p < powers.length; p++) {
    var pid = powers[p];
    for (var i = 0; i < STATION_IDS.length; i++) {
      var home = STATION_IDS[i];
      if (base.stations[home].owner !== pid) continue;
      var s = _fogOnly(seed, pid, home);
      var path = _fogDarkPath(home, adj, visibleTo(s, pid), 6);
      if (path) return { seed: seed, pid: pid, home: home, path: path, adj: adj };
    }
  }
  return null;
}

// A FRESH board per test, and that is not tidiness.
//
// These tests share a fixture and the first draft shared its STATE, so the
// memory test's observeTick left a level-1 record of the scouted city behind
// and the AI test that ran next found it already a candidate with no column on
// the board — its control failed, which is the only reason it was caught. A
// suite whose tests can see each other's side effects is a suite whose passes
// mean whatever the run order happens to make them mean.
//
// AI-quiet by construction, so nothing moves between an assertion and the board
// it is about, and observeTick only ever runs where a test calls it.
function _fogWaveBoard(f) {
  var s = _fogOnly(f.seed, f.pid, f.home);
  s.aiEnabled = false;
  return s;
}

// One wave, standing on `hop`, pushed straight onto state.waves.
//
// Hand-built rather than routed, and that is deliberate: the router's choice of
// path, the passage toll and march attrition are all B1's subject and all of
// them can change what a wave is standing on. This suite is about what a wave
// SEES, so it states where the wave is. The end-to-end test at the bottom is
// the one that goes through applyCommand and the real movement phase, and it
// exists because a hand-built wave could in principle have a shape the game
// never produces.
//
// The shape is 01-data-schema.md's, field for field, and the schema explicitly
// sanctions tests pushing waves onto state.waves.
function _fogWavePush(f, s, hop, progress) {
  var w = {
    id: s.nextWaveId++,
    owner: f.pid,
    from: f.path[0],
    to: f.path[f.path.length - 1],
    path: f.path.slice(),
    hop: hop,
    progress: progress || 0,
    units: { infantry: 12, artillery: 0, armour: 0 },
    launchTick: s.tick,
    eta: 100,
  };
  s.waves.push(w);
  return w;
}

function _fogSuiteWaves(d) {
  if (typeof visibleTo !== 'function') {
    return skipSuite('fog / wave vision', 'core/vision.js not loaded');
  }
  if (typeof newGame !== 'function' || typeof setStationOwner !== 'function' || !d.STATIONS) {
    return skipSuite('fog / wave vision', 'core/state.js or data/ not loaded');
  }
  suite('fog / wave vision');

  var f = _fogWaveFixture(5730);

  test('the fixture found a power with a dark road out of it', function () {
    assert(!!f, 'no power on this map has a six-station land path whose far end ' +
      'it cannot already see — every assertion below would be measuring a station ' +
      'that was level 2 anyway, which is exactly the trap that made this feature ' +
      'a no-op before B1');
    if (!f) return;
    var vis = visibleTo(_fogWaveBoard(f), f.pid);
    var lit = [];
    for (var i = 2; i < f.path.length; i++) if (vis[f.path[i]] !== 0) lit.push(f.path[i]);
    assertNone(lit, 'the fixture claims a dark road and the board disagrees');
  });

  test('a wave lights BOTH ends of the hop it is standing on', function () {
    assert(!!f, 'no fixture');
    if (!f) return;
    var s = _fogWaveBoard(f);
    var before = visibleTo(s, f.pid);
    assertEqual(before[f.path[2]], 0, f.path[2] + ' was already visible');
    assertEqual(before[f.path[3]], 0, f.path[3] + ' was already visible');

    _fogWavePush(f, s, 2, 0.4);
    var after = visibleTo(s, f.pid);
    assertEqual(after[f.path[2]], 2,
      'the wave is LEAVING ' + f.path[2] + ' and cannot see it — an army knows ' +
      'the ground it is standing on');
    assertEqual(after[f.path[3]], 2,
      'the wave is walking towards ' + f.path[3] + ' and cannot see it — this is ' +
      'the whole of B2, and without it scouting does not exist');
  });

  test('and lights nothing else on its own path', function () {
    // The lazy implementation — reveal `w.path` — passes the test above and is
    // a different game: a march would light the whole route the instant it left,
    // and scouting would cost nothing because you would already know.
    assert(!!f, 'no fixture');
    if (!f) return;
    var s = _fogWaveBoard(f);
    _fogWavePush(f, s, 2, 0.4);
    var vis = visibleTo(s, f.pid);
    var leaked = [];
    for (var i = 4; i < f.path.length; i++) if (vis[f.path[i]] === 2) leaked.push(f.path[i]);
    assertNone(leaked, 'ground further along the route than the wave has walked is ' +
      'lit — the reveal is following the PATH rather than the army');
  });

  test('the light moves with the army — ground behind it goes dark again', function () {
    assert(!!f, 'no fixture');
    if (!f) return;
    var s = _fogWaveBoard(f);
    var w = _fogWavePush(f, s, 2, 0.4);
    var atTwo = visibleTo(s, f.pid);

    w.hop = 3;
    var atThree = visibleTo(s, f.pid);

    assertEqual(atTwo[f.path[2]], 2, 'fixture: ' + f.path[2] + ' was not lit at hop 2');
    assertEqual(atThree[f.path[4]], 2,
      'the wave moved on and did not light the ground ahead of it');
    assertEqual(atThree[f.path[2]], 0,
      f.path[2] + ' is still lit after the army left it — sight is not memory, ' +
      'and memory is state.seen\'s job. A visibleTo that accumulated would make ' +
      'level 1 unreachable for anywhere a wave has ever been.');
  });

  test('a marching army is not a lookout tower — it lights no third station', function () {
    // Presence has the same rule and the same comment: the endpoints go into
    // `out` and never into `budget`. The obvious "make the wave a vision
    // source" implementation reveals a ring around the column, which would make
    // a cheap scout worth more than a fortress.
    assert(!!f, 'no fixture');
    if (!f) return;
    var s = _fogWaveBoard(f);

    var onPath = {};
    for (var i = 0; i < f.path.length; i++) onPath[f.path[i]] = true;
    var dark0 = visibleTo(s, f.pid);
    var nb = f.adj[f.path[3]] || [], side = null;
    for (i = 0; i < nb.length; i++) {
      if (!onPath[nb[i]] && dark0[nb[i]] === 0) { side = nb[i]; break; }
    }
    assert(!!side, 'no dark neighbour beside ' + f.path[3] + ' — nothing to leak into');
    if (!side) return;

    _fogWavePush(f, s, 2, 0.4);
    var vis = visibleTo(s, f.pid);
    assertEqual(vis[f.path[3]], 2, 'fixture: the hop endpoint is not lit');
    assertEqual(vis[side], 0, side + ' is next to the road and not on it, and the ' +
      'column has revealed it — a wave is projecting sight');
  });

  test('somebody else\'s army lights nothing for you, and everything for them', function () {
    assert(!!f, 'no fixture');
    if (!f) return;
    var s = _fogWaveBoard(f);
    var other = null, powers = _fogPowers();
    for (var i = 0; i < powers.length; i++) if (powers[i] !== f.pid) { other = powers[i]; break; }
    assert(!!other, 'only one power');

    // state.human IS SET, and that is the whole point of this test rather than a
    // detail of the fixture. The first draft left it undefined and a mutation
    // that gated the rule on `pid === state.human` — the exact asymmetry
    // 02-visibility-and-sea.md §1 forbids — SURVIVED the entire suite, because
    // with no human on the board the extra clause is inert. A fog rule can only
    // be shown to be symmetric on a board that has somebody to be asymmetric
    // towards.
    s.human = f.pid;
    var w = _fogWavePush(f, s, 2, 0.4);
    w.owner = other;
    var mine = visibleTo(s, f.pid);
    var theirs = visibleTo(s, other);

    assertEqual(mine[f.path[3]], 0, 'a rival\'s column is lighting MY fog');
    assertEqual(theirs[f.path[3]], 2,
      other + ' owns the column and cannot see the road it is on. ' +
      other + ' is an AI power and ' + f.pid + ' is the human, so the likely ' +
      'cause is a rule that reads state.human — which hands the player a fog ' +
      'the AI never gets, on precisely the axis fog exists to create.');
  });

  test('a power with no cities left still sees the road its last army is on', function () {
    // visibleTo used to `return out` early on "holds nothing: sees nothing",
    // which was exactly right while every source of sight was a station and is
    // wrong the moment an army is one. The board is reachable: a wave outlives
    // the city that sent it, and the ticks between the last capital falling and
    // the column landing are ticks a power is still playing.
    assert(!!f, 'no fixture');
    if (!f) return;
    var s = _fogWaveBoard(f);
    _fogWavePush(f, s, 2, 0.4);
    setStationOwner(s, f.home, 'neutral');           // the last city falls

    var own = 0;
    for (var i = 0; i < STATION_IDS.length; i++) {
      if (s.stations[STATION_IDS[i]].owner === f.pid) own++;
    }
    assertEqual(own, 0, 'fixture: ' + f.pid + ' still holds ground');

    var vis = visibleTo(s, f.pid);
    assertEqual(vis[f.path[3]], 2,
      f.pid + ' holds nothing and therefore sees nothing — but its column is ' +
      'still on the road, and a rule that short-circuits on the station count ' +
      'blinds an army that is standing right there');
    assertEqual(vis[f.home], 0,
      'the city it just lost is still visible — the short-circuit went the other way');
  });

  test('visibleTo stays pure with a wave on the board', function () {
    assert(!!f, 'no fixture');
    if (!f) return;
    var s = _fogWaveBoard(f);
    _fogWavePush(f, s, 2, 0.4);

    var before = JSON.stringify(snapshot(s));
    var v = visibleTo(s, f.pid);
    var after = JSON.stringify(snapshot(s));
    var fired = (v[f.path[3]] === 2);

    assert(fired, 'the wave rule did not fire — purity was measured on a path ' +
      'that did not run');
    assertEqual(after.length, before.length,
      'visibleTo changed the SIZE of the state — the wave rule wrote something, ' +
      'and the likely something is a scratch field on the wave');
    assert(after === before, 'visibleTo mutated the state while a wave was in flight');
  });

  test('what a scout saw is REMEMBERED after it dies', function () {
    // The payoff, and the reason this is worth building at all: a station lit
    // only by a passing column composes with state.seen exactly as one lit by a
    // city does, so the intelligence outlives the army. Without this the scout
    // learns something for as long as it is standing there and then forgets it,
    // which is not a strategic action.
    assert(!!f, 'no fixture');
    if (!f) return;
    if (typeof observeTick !== 'function' || typeof believedStation !== 'function') return;
    var s = _fogWaveBoard(f);

    var target = f.path[3];
    var truth = s.stations[target].owner;
    assertEqual(believedStation(s, f.pid, target).level, 0,
      target + ' is already known before the scout set out');

    _fogWavePush(f, s, 2, 0.4);
    observeTick(s);
    var seen = believedStation(s, f.pid, target);

    s.waves.length = 0;                       // the column is destroyed
    var remembered = believedStation(s, f.pid, target);

    assertEqual(seen.level, 2, 'the scout was standing on the road and saw nothing');
    assertEqual(remembered.level, 1,
      'the scout died and took what it knew with it — a wave-lit station must ' +
      'age into level 1 like any other, or scouting buys nothing');
    assertEqual(remembered.owner, truth,
      'the remembered owner of ' + target + ' is not who was holding it');
  });

  test('a station only a column can see becomes a legal AI target', function () {
    // The other half of the payoff, and the half that is invisible from
    // render/: ai/score.js filters candidates through the same visibleTo, so
    // the AI can scout and can be scouted. If this ever goes red while the
    // tests above stay green, the filter has grown its own copy of the rule.
    assert(!!f, 'no fixture');
    if (!f) return;
    if (typeof aiContext !== 'function' || typeof aiCandidates !== 'function') return;
    var s = _fogWaveBoard(f);
    if (typeof observeTick === 'function') observeTick(s);

    var target = f.path[3];
    function offered() {
      var ctx = aiContext(s, f.pid);
      ctx.hops = {};
      for (var i = 0; i < ctx.own.length; i++) ctx.hops[ctx.own[i]] = 0;
      ctx.hops[target] = 2;                   // reachable; the filter is the subject
      var cands = aiCandidates(s, f.pid, ctx);
      for (i = 0; i < cands.length; i++) if (cands[i].sid === target) return true;
      return false;
    }

    var blind = offered();
    _fogWavePush(f, s, 2, 0.4);
    var scouted = offered();

    assert(!blind, target + ' was already a candidate with no column near it — ' +
      'the control is broken and the assertion below proves nothing');
    assert(scouted, target + ' is lit by this power\'s own column and is still ' +
      'not a candidate — the AI cannot act on what it scouted');
  });

  test('a REAL march, routed and stepped, lights the road it is on', function () {
    // Everything above stands a wave where it wants it. This one sends through
    // applyCommand and lets movementTick move it, because a hand-built wave can
    // have a shape the game never produces — and because the render cache, the
    // AI and the readout all read visibleTo against waves the SIM built.
    assert(!!f, 'no fixture');
    if (!f) return;
    if (typeof applyCommand !== 'function' || typeof stepTick !== 'function') return;

    var s = _fogWaveBoard(f);
    s.stations[f.home].units = { infantry: 6000, artillery: 0, armour: 0 };
    var dark0 = visibleTo(s, f.pid);

    var res = applyCommand(s, {
      type: 'send', owner: f.pid, sources: [f.home],
      target: f.path[f.path.length - 1], fraction: 1,
    });
    assert(res && res.ok, 'the send was rejected: ' + (res && res.reason));
    assert(s.waves.length > 0, 'the send produced no wave');

    // Step until the column is at least two hops out, so what it lights cannot
    // be explained by the home city's own sight cone.
    var deep = null;
    for (var t = 0; t < 4000 && !deep; t++) {
      stepTick(s);
      for (var i = 0; i < s.waves.length; i++) {
        if (s.waves[i].owner === f.pid && s.waves[i].hop >= 2) { deep = s.waves[i]; break; }
      }
    }
    assert(!!deep, 'no wave of ' + f.pid + ' ever reached hop 2 — it was destroyed ' +
      'or arrived first, and this test measured nothing');
    if (!deep) return;

    var ahead = deep.path[deep.hop + 1];
    assert(!!ahead, 'the wave is on its last hop with nothing ahead');
    var vis = visibleTo(s, f.pid);
    assertEqual(vis[ahead], 2, 'a marching column cannot see the city it is ' +
      'walking into: ' + ahead);
    // Vacuity guard. If `ahead` was visible from the start, the assertion above
    // would hold with the whole feature deleted.
    assertEqual(dark0[ahead], 0, ahead + ' was visible before the march began — ' +
      'this run proved nothing about wave vision');
  });
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
    assertClose(totalUnits(rec.u),
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
// fog / ai symmetry  —  stage 4, the AI's believed board
//
// "The AI gets the same fog. Symmetric, without exception."
// (02-visibility-and-sea.md §1.)
//
// ---------------------------------------------------------------------------
// READ THIS BEFORE ADDING A TEST HERE — a measured fact about the board
// ---------------------------------------------------------------------------
//
// The obvious test to write is "aiDecide attacks a fogged station and sizes the
// volley against the remembered garrison". IT CANNOT BE WRITTEN through
// aiDecide, and the reason is structural rather than a gap in the fixtures:
//
//   1. `_aiHopsFromOwn` (ai/score.js) seeds its BFS with every station the
//      power holds — all at hops 0 — and expands only through that same own
//      ground. Its frontier is therefore empty after one pass, so ctx.hops only
//      ever contains 0 and 1 no matter what TARGET_MAX_HOPS says. Candidates
//      are exactly the stations ADJACENT to own ground.
//   2. Every station a power holds has vision >= 1 (core/vision.js), so
//      everything one hop out is lit at level 2.
//   3. `_moveCanTraverse` (sim/movement.js) allows a wave through OWN ground
//      only, so a station you can legally send to is adjacent to something you
//      hold — which is a station you can see.
//
// Measured across three full games sampled every 2,000 ticks: **1,215 of 1,215
// candidates were at level 2.** Under the current traversal rule, any station
// the AI may legally attack is a station it can currently SEE.
//
// So the believed board is, today, provably equal to the true board at every
// point where an attack is decided — with one exception, `_aiCutsLink`, whose
// input is the target's NEIGHBOURS and of whose 5,949 reads only 4,390 were
// live (383 remembered, 1,176 never seen).
//
// That does not make the seam optional and it does not make these tests
// theatre. It means the tests must exercise the seam WHERE IT IS REACHABLE —
// at the believed-read helpers themselves and at aiCandidates' filter — rather
// than staging a scene through aiDecide that the board cannot produce. Every
// assertion below was run against the unfixed code and seen to fail
// (known-issues #8 rule 1). The day either fact above changes — a hop map that
// genuinely reaches two, or a passability rule that lets a wave cross ground it
// does not hold — these become live behavioural tests with no edit required.
// ---------------------------------------------------------------------------

function _fogG() {
  return (typeof globalThis !== 'undefined') ? globalThis
       : (typeof window !== 'undefined') ? window : null;
}

// The odds floor `pid` demands, personality included — the number an attack has
// to clear. Recomputed here rather than imported so this suite does not depend
// on an ai/ private.
function _fogMinOdds(pid) {
  var name = (typeof POWERS !== 'undefined' && POWERS[pid]) ? POWERS[pid].ai : null;
  var P = (BAL.AI.PERSONALITIES || {})[name];
  return BAL.AI.MIN_ODDS * ((P && P.minOddsMul) || 1);
}

// The stage-4 fixture: a station this power SAW, then went blind to, and which
// has since been massively reinforced on the true board.
//
// Built on _fogMemFixture, so the "went blind" step is a real loss of sight
// (handing `drop` away) rather than a hand-edited memory. The reinforcement is
// x`mul` on top of whatever grew there, applied AFTER the last observation, so
// the remembered garrison and the live one are separated by a factor nothing
// in the AI can explain away as rounding.
//
// Returns null when the map cannot supply the shape, and every caller asserts
// on that rather than silently passing.
function _fogAmbush(seed, pid, mul) {
  var f = _fogMemFixture(seed, pid);
  if (!f) return null;

  observeTick(f.s);                                   // tick 0, on cadence
  if (believedStation(f.s, pid, f.lost).level !== 2) return null;

  setStationOwner(f.s, f.drop, 'neutral');            // go blind
  _fogMemWatch(f.s, 200);                             // observer runs throughout

  // The ambush. Everything the defender does from here is invisible to `pid`.
  var u = f.s.stations[f.lost].units;
  u.infantry *= mul;
  u.artillery *= mul;
  u.armour *= mul;

  f.believed = believedStation(f.s, pid, f.lost);
  if (f.believed.level !== 1) return null;
  return f;
}

function _fogSuiteAiSymmetry(d) {
  var g = _fogG();
  if (typeof visibleTo !== 'function' || typeof believedStation !== 'function') {
    return skipSuite('fog / ai symmetry', 'core/vision.js not loaded');
  }
  if (typeof aiContext !== 'function' || typeof aiCandidates !== 'function' ||
      typeof aiScoreTarget !== 'function' || typeof aiDecide !== 'function') {
    return skipSuite('fog / ai symmetry', 'ai/score.js or ai/ai.js not loaded');
  }
  if (typeof stationPower !== 'function' || typeof newGame !== 'function' || !d.STATIONS) {
    return skipSuite('fog / ai symmetry', 'sim/combat.js, core/state.js or data/ not loaded');
  }
  suite('fog / ai symmetry');

  var pid = _fogPowers()[0];

  // -------------------------------------------------------------------------
  // 1. The candidate filter
  // -------------------------------------------------------------------------

  test('a station this power has NEVER SEEN is not a candidate', function () {
    var s = newGame(5720);
    observeTick(s);
    var ctx = aiContext(s, pid);
    var vis = visibleTo(s, pid);

    // Two stations at the SAME injected hop distance, differing only in whether
    // this power can see them. The hops are injected because ctx.hops tops out
    // at 1 today (see the block above this suite) while aiCandidates is written
    // against TARGET_MAX_HOPS = 2 — and ctx is a PARAMETER of aiCandidates, so
    // handing it the two-hop map the function is written for is using the API,
    // not defeating it. Replacing the whole map rather than adding to it keeps
    // the pair out of CANDIDATES_PER_DECISION's truncation.
    var hidden = null, control = null, i, sid;
    for (i = 0; i < STATION_IDS.length; i++) {
      sid = STATION_IDS[i];
      if (s.stations[sid].owner === pid) continue;
      if (vis[sid] === 0 && !hidden && !(s.seen && s.seen[pid] && s.seen[pid][sid])) hidden = sid;
      if (vis[sid] === 2 && !control) control = sid;
    }
    assert(!!hidden, 'no unseen station on the turn-zero board — nothing to filter');
    assert(!!control, 'no visible non-own station — the control would prove nothing');

    ctx.hops = {};
    for (i = 0; i < ctx.own.length; i++) ctx.hops[ctx.own[i]] = 0;
    ctx.hops[hidden] = 2;
    ctx.hops[control] = 2;

    var cands = aiCandidates(s, pid, ctx), got = {};
    for (i = 0; i < cands.length; i++) got[cands[i].sid] = true;

    // The control first: if the visible one were missing too, the assertion
    // below would pass because aiCandidates returned nothing at all.
    assert(got[control], control + ' is visible and two hops out but was not offered — ' +
      'the filter is rejecting everything, so the real assertion proves nothing');
    assert(!got[hidden], hidden + ' has never been seen by ' + pid +
      ' and must not be a candidate: you cannot decide to take a city you do not ' +
      'know is there');
  });

  // -------------------------------------------------------------------------
  // 2. The odds gate — the number that decides every attack
  // -------------------------------------------------------------------------

  test('the odds gate reads the REMEMBERED garrison, not the live one', function () {
    var f = _fogAmbush(5721, pid, 6);
    assert(!!f, 'fixture is wrong — no station seen, lost and reinforced');
    var ctx = aiContext(f.s, pid);

    var believedDef = _aiActDefenderPower(f.s, pid, f.lost, ctx);
    var trueDef = stationPower(f.s, f.lost, 'defender');

    assert(believedDef > 0, 'the believed defence is zero — nothing was measured');
    assert(trueDef > believedDef * 2,
      'the live garrison at ' + f.lost + ' is only ' + trueDef.toFixed(1) +
      ' against a remembered ' + believedDef.toFixed(1) + ' — the fixture did not ' +
      'separate them, so this test cannot tell the two boards apart');

    // The remembered garrison, run through the CANONICAL stationPower on a
    // one-station proxy. Deliberately not a unit-ratio estimate: _fortBonus
    // saturates, so a ratio would disagree with the sim about a full fort.
    var proxy = { stations: {} };
    proxy.stations[f.lost] = {
      owner: f.believed.owner,
      units: f.believed.units,
      attackers: {},
    };
    assertClose(believedDef, stationPower(proxy, f.lost, 'defender'), 1e-9,
      '_aiActDefenderPower did not return the power of the garrison ' + pid +
      ' last SAW at ' + f.lost + ' — it is reading the true board');
  });

  // -------------------------------------------------------------------------
  // 3. The ambush, as arithmetic
  // -------------------------------------------------------------------------

  test('a volley that clears the odds floor on the believed board LOSES on the real one', function () {
    var f = _fogAmbush(5722, pid, 6);
    assert(!!f, 'fixture is wrong');
    var ctx = aiContext(f.s, pid);

    var believedDef = _aiActDefenderPower(f.s, pid, f.lost, ctx);
    var trueDef = stationPower(f.s, f.lost, 'defender');
    var minOdds = _fogMinOdds(pid);

    // This is the whole of level 1 in one line. The AI commits when its stack
    // is worth at least minOdds x the defence it BELIEVES is there; the least
    // such stack is minOdds x believedDef. If that is still short of the TRUE
    // defence, the power marches into a fight it cannot win and finds out on
    // arrival — which is the point of remembering a number instead of knowing
    // one.
    //
    // Against the unfixed code believedDef === trueDef and the inequality reads
    // `minOdds * D < D`, which is false for any floor at or above 1:1. There is
    // no way to make this pass by accident.
    assert(minOdds >= 1, 'MIN_ODDS is below 1:1 — this assertion is meaningless');
    assert(minOdds * believedDef < trueDef,
      'a volley sized to clear ' + minOdds.toFixed(2) + ':1 against the remembered ' +
      believedDef.toFixed(1) + ' would bring ' + (minOdds * believedDef).toFixed(1) +
      ', against a true defence of ' + trueDef.toFixed(1) + ' — the AI is not walking ' +
      'into the ambush, so it is reading the live board');
  });

  // -------------------------------------------------------------------------
  // 4. The scorer
  // -------------------------------------------------------------------------

  test('a station that changes hands behind the fog is still scored as it was last seen', function () {
    var f = _fogMemFixture(5723, pid);
    assert(!!f, 'fixture is wrong');
    observeTick(f.s);
    setStationOwner(f.s, f.drop, 'neutral');
    _fogMemWatch(f.s, 200);

    var b0 = believedStation(f.s, pid, f.lost);
    assertEqual(b0.level, 1, f.lost + ' is not fogged — fixture is wrong');

    var before = aiScoreTarget(f.s, pid, f.lost, aiContext(f.s, pid));

    // Everything the enemy does from here is invisible to `pid`: the station
    // changes hands to a power it is at war with, and the garrison octuples.
    var pids = _fogPowers(), rival = null;
    for (var i = 0; i < pids.length; i++) {
      if (pids[i] !== pid && pids[i] !== b0.owner) { rival = pids[i]; break; }
    }
    assert(!!rival, 'no third power to hand the station to');
    setStationOwner(f.s, f.lost, rival);
    var me = f.s.powers[pid];
    me.wars = me.wars || {}; me.wars[rival] = true;
    me.relations = me.relations || {}; me.relations[rival] = BAL.AI.RELATION_MIN;
    var u = f.s.stations[f.lost].units;
    u.infantry *= 8; u.artillery *= 8; u.armour *= 8;

    var after = aiScoreTarget(f.s, pid, f.lost, aiContext(f.s, pid));
    assertEqual(JSON.stringify(after), JSON.stringify(before),
      'the score of ' + f.lost + ' moved when it changed hands behind the fog: ' +
      JSON.stringify(before) + ' -> ' + JSON.stringify(after) +
      ' — the scorer is reading the live board');

    // THE VACUITY GUARD, and it is the whole reason this test is trustworthy.
    // "The score did not change" is also true of a scorer that ignores the
    // station entirely, or of a fixture where nothing meaningful moved. So:
    // refresh ONLY what `pid` remembers — one record in state.seen, on a
    // snapshot, with every other input identical — and the score must now move.
    // That isolates the single variable this test is about.
    var scratch = snapshot(f.s);
    var live = scratch.stations[f.lost];
    scratch.seen[pid][f.lost] = {
      o: live.owner,
      u: { infantry: live.units.infantry, artillery: live.units.artillery, armour: live.units.armour },
      c: live.connected !== false,
      t: scratch.tick,
    };
    var refreshed = aiScoreTarget(scratch, pid, f.lost, aiContext(scratch, pid));
    assert(JSON.stringify(refreshed) !== JSON.stringify(before),
      'updating what ' + pid + ' REMEMBERS about ' + f.lost + ' did not change its ' +
      'score either (' + JSON.stringify(before) + ') — this fixture cannot tell a ' +
      'fogged scorer from one that is not looking at the station at all');
  });

  // -------------------------------------------------------------------------
  // 5. Connectivity — invisible from outside a power's own network
  // -------------------------------------------------------------------------

  test('a staging march is sized on believed connectivity, not the real flag', function () {
    if (typeof _aiActGrownDefenderPower !== 'function') {
      return skipTest('staging projection', 'ai/ai.js private not reachable');
    }
    var f = _fogMemFixture(5724, pid);
    assert(!!f, 'fixture is wrong');
    observeTick(f.s);                                  // seen, and seen CONNECTED
    setStationOwner(f.s, f.drop, 'neutral');           // go blind
    _fogMemWatch(f.s, 200);

    var b = believedStation(f.s, pid, f.lost);
    assertEqual(b.level, 1, f.lost + ' is not fogged — fixture is wrong');
    assertEqual(b.connected, true, f.lost + ' was not remembered as connected');

    // Cut it off on the LIVE board. `pid` cannot possibly know this: whether a
    // station is joined to its owner's network is a fact about the inside of
    // somebody else's empire.
    f.s.stations[f.lost].connected = false;

    var ctx = aiContext(f.s, pid);
    var def = _aiActDefenderPower(f.s, pid, f.lost, ctx);
    var grown = _aiActGrownDefenderPower(f.s, pid, f.lost, def, ctx);

    // A cut-off station decays instead of growing, so the unfixed code reads
    // real.connected === false and projects the garrison to ITSELF — grown
    // comes back exactly equal to def. Believing it connected projects it
    // forward to the growth ceiling.
    var room = STATIONS[f.lost].capacity * BAL.GROWTH_OVERFLOW_CEIL -
               totalUnits(b.units);
    assert(room > 0, f.lost + ' is already at the growth ceiling — there is no ' +
      'projection to make and this test proves nothing');
    assert(grown > def,
      'the projection came back at ' + grown.toFixed(1) + ' against a present ' +
      def.toFixed(1) + ' — _aiActGrownDefenderPower read the live `connected` flag, ' +
      'which is not visible from outside ' + f.s.stations[f.lost].owner + '\'s network');
  });

  // -------------------------------------------------------------------------
  // 6. Symmetry — nobody gets a bonus
  // -------------------------------------------------------------------------

  test('two powers holding the same ground see exactly the same board', function () {
    var pids = _fogPowers();
    assert(pids.length >= 2, 'need two powers');

    // A mirror image of the 1914 map does not exist, so the claim is put the
    // only way it can be made exactly: visibility is a function of WHICH
    // STATIONS ARE HELD and of nothing else — not of who holds them. Hand two
    // different powers the identical holding and the two sight maps must be
    // byte-identical. A rule that gave any power an extra hop lands here.
    var adj = _fogAdj(true);
    var anchor = STATION_IDS[0];
    var hops = _fogHops(anchor, adj);
    var set = [anchor];
    for (var i = 0; i < STATION_IDS.length && set.length < 3; i++) {
      if (hops[STATION_IDS[i]] >= 4) set.push(STATION_IDS[i]);
    }
    assert(set.length === 3, 'could not find three well-separated stations');

    var boardFor = function (who) {
      var s = newGame(5725);
      for (var j = 0; j < STATION_IDS.length; j++) {
        if (s.stations[STATION_IDS[j]].owner !== 'neutral') {
          setStationOwner(s, STATION_IDS[j], 'neutral');
        }
      }
      for (var k = 0; k < set.length; k++) setStationOwner(s, set[k], who);
      return visibleTo(s, who);
    };

    var problems = [], base = boardFor(pids[0]), baseJson = JSON.stringify(base);

    // Vacuity guards. An all-2 map or an all-0 map would make every comparison
    // below trivially equal.
    var lit = 0, dark = 0;
    for (var m = 0; m < STATION_IDS.length; m++) {
      if (base[STATION_IDS[m]] === 2) lit++; else dark++;
    }
    assert(lit > set.length, 'the holding lights nothing beyond itself');
    assert(dark > 0, 'the holding sees the entire map — there is no fog to be fair about');

    for (var p = 1; p < pids.length; p++) {
      if (JSON.stringify(boardFor(pids[p])) !== baseJson) {
        problems.push(pids[p] + ' sees a different board from ' + pids[0] +
                      ' while holding the identical ' + set.join(', '));
      }
    }
    assertNone(problems, 'the AI gets the same fog — symmetric, without exception');
  });

  // -------------------------------------------------------------------------
  // 7. The human — no penalty and no bonus
  // -------------------------------------------------------------------------

  test('the human observes on exactly the same rule as everyone else', function () {
    var s = newGame(5726);
    var pids = _fogPowers();
    s.human = (pids.indexOf('ger') >= 0) ? 'ger' : pids[0];
    for (var t = 0; t < 200; t++) stepTick(s);

    var mem = (s.seen && s.seen[s.human]) || {};
    var vis = visibleTo(s, s.human);
    var missing = [], invented = [], seenNow = 0, unseen = 0;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      if (vis[sid] === 2) {
        seenNow++;
        // NO PENALTY. observeTick sits ABOVE aiTick's `state.human` skip, so
        // the player remembers everything they can currently see. Moved below
        // it, the human would get BINARY fog and every one of these would fail.
        if (!mem[sid]) missing.push(sid);
      } else {
        unseen++;
        // NO BONUS. The human is not handed records for ground nobody looked
        // at, which is the same rule every AI power is held to.
        if (mem[sid] && mem[sid].t === s.tick) invented.push(sid);
      }
    }
    assert(seenNow > 0 && unseen > 0,
      'the human either sees everything or nothing after 200 ticks — nothing was checked');
    assertNone(missing, s.human + ' is the human and does not remember ground it is ' +
      'standing next to — observeTick has fallen below aiTick\'s human skip');
    assertNone(invented, s.human + ' has a fresh record for ground it cannot see');

    // The control, without which "no penalty" could pass because the human is
    // in fact being played by the AI.
    var acted = 0, log = s.aiLog || [];
    for (var k = 0; k < log.length; k++) if (log[k].power === s.human) acted++;
    assertEqual(acted, 0, s.human + ' took ' + acted + ' AI decisions — the human is ' +
      'not being skipped, so this test proved nothing about observeTick\'s position');
  });

  // -------------------------------------------------------------------------
  // 8. The standings are NOT fogged, and that is on purpose
  // -------------------------------------------------------------------------

  test('who is winning stays public — ctx.leader reads the true board', function () {
    // Deliberate hole #2 in the fog (02-visibility-and-sea.md). LEADER_WEIGHT
    // is 45.0 and known-issues #11 established it is the only constant that can
    // actually declare a war; fogging it would disarm the balance of power and
    // leave the leader unopposed. This test exists so that a later reader who
    // finds a global read inside a fogged AI and "fixes" it goes red instead of
    // shipping a snowball.
    var s = newGame(5727);
    var pids = _fogPowers();
    var blind = pids[0], big = pids[pids.length - 1];
    assert(blind !== big, 'need two distinct powers');

    // Hand almost the whole map to one power, and reduce another to a single
    // station on the far side of it. The small one can see essentially nothing
    // and must still name the leader correctly.
    var keep = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      if (s.stations[STATION_IDS[i]].owner === blind) { keep = STATION_IDS[i]; break; }
    }
    assert(!!keep, blind + ' holds nothing at turn zero');
    for (var j = 0; j < STATION_IDS.length; j++) {
      if (STATION_IDS[j] !== keep) setStationOwner(s, STATION_IDS[j], big);
    }

    var ctx = aiContext(s, blind);
    var vis = visibleTo(s, blind);
    var hidden = 0;
    for (var k = 0; k < STATION_IDS.length; k++) if (vis[STATION_IDS[k]] !== 2) hidden++;
    assert(hidden > STATION_IDS.length / 2,
      blind + ' can see most of the board — the test would prove nothing');

    assertEqual(ctx.leader, big,
      blind + ' cannot see the board and must STILL know ' + big + ' is winning: ' +
      'in 1914 the standings are newspapers, embassies and attachés, not ' +
      'reconnaissance. You can hide an army; you cannot hide having conquered Belgium.');
    assert(ctx.leaderShare > 0.5,
      'leaderShare is ' + ctx.leaderShare + ' with one power holding 107 of 108 stations');
  });

  // -------------------------------------------------------------------------
  // 9 and 10. The route cache — the 1,400x regression that reports nothing
  // -------------------------------------------------------------------------

  test('every commandRoute call in ai/ai.js is handed the REAL state', function () {
    var srcs = _fogSourceOf(['ai/ai.js']);
    if (!srcs || !srcs.length) return skipTest('commandRoute source', 'no filesystem — run under node');
    if (typeof _aiStripText !== 'function') {
      return skipTest('commandRoute source', 'test/ai-tests.js not loaded (_aiStripText)');
    }
    var clean = _aiStripText(srcs[0].text);
    var calls = 0, problems = [], m;
    var re = /commandRoute\s*\(/g;
    while ((m = re.exec(clean)) !== null) {
      calls++;
      // Split the argument list at TOP-LEVEL commas only. A regex cannot do
      // this: the exact regression being guarded against — `commandRoute(a, b,
      // _aiActBelievedAt(state, pid, t, ctx), pid)` — puts parens and commas
      // inside argument three, and a naive `[^()]*` match skips the call
      // entirely, i.e. the mutation would hide from its own test.
      var depth = 1, args = [''], i;
      for (i = re.lastIndex; i < clean.length && depth > 0; i++) {
        var ch = clean.charAt(i);
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) break; }
        if (depth === 1 && ch === ',') { args.push(''); continue; }
        args[args.length - 1] += ch;
      }
      var third = (args[2] || '').trim();
      if (third !== 'state') {
        problems.push('commandRoute(' + args.join(',').replace(/\s+/g, ' ').trim() +
                      ') — 3rd argument is "' + third + '", not the real `state`');
      }
    }
    assert(calls >= 2, 'found ' + calls + ' commandRoute call(s) in ai/ai.js — expected at ' +
      'least the volley one and the staging one; the check did not run');
    assertNone(problems,
      '_ownRouteCache in sim/movement.js invalidates on state OBJECT IDENTITY, so a ' +
      'believed board or a proxy handed to commandRoute drops the REAL state\'s routes ' +
      'too and every Dijkstra in the game is recomputed per tick. Measured: routeFor ' +
      'cached 0.115us, against a fresh proxy each call 161.1us. It produces no wrong ' +
      'answer, only a game that crawls.');
  });

  test('the route cache still holds — _moveSearch is not being re-run per tick', function () {
    if (!g || typeof g._moveSearch !== 'function') {
      return skipTest('route cache', 'sim/movement.js _moveSearch is not reachable');
    }
    // The source check above cannot see a proxy that arrives through a helper,
    // and the failure mode has NO WRONG ANSWER attached — only a slow game. So
    // it is also measured. The board is pinned (seed, warm-up, window) so the
    // count is a property of the build rather than of the run.
    var s = newGame(5728);
    var w;
    for (w = 0; w < 2000; w++) stepTick(s);            // waves in flight, orders standing

    var real = g._moveSearch, n = 0;
    g._moveSearch = function () { n++; return real.apply(null, arguments); };
    try {
      for (w = 0; w < 200; w++) stepTick(s);
    } finally {
      g._moveSearch = real;
    }

    // Measured on this board: 83 searches over 200 ticks with the cache warm,
    // and 1,071 with a believed proxy handed to commandRoute — a 12.9x jump in
    // Dijkstras and 71.9ms -> 149.4ms of wall clock. The ceiling sits between
    // them with room for the AI to change without a false alarm.
    assert(n > 0, 'the wrapper never fired — _moveSearch was not the function being called');
    assertBetween(n, 1, 400,
      n + ' Dijkstra searches over 200 ticks (' + (n / 200).toFixed(2) + '/tick). The ' +
      'cache is warm at ~0.42/tick; a proxy state handed to routeFor/commandRoute ' +
      'invalidates it on every call and takes it to ~5.4/tick.');
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
