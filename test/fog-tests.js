// test/fog-tests.js — fog of war (milestone 5.7, stages 0 and 1).
//
// Three suites, registered from test/runner.js:
//
//   fog / vision data   the `vision` field tools/build-stations.js writes
//   fog / visibleTo     the gate itself, core/vision.js
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
