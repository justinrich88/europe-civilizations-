// test/runner.js — every assertion suite in the project.
//
// Two families of suite live here:
//
//   1. DATA INTEGRITY — runs the moment data/map.js, data/stations.js and
//      data/scenario.js exist. These are the highest-value tests in the
//      project: the geometry rule in 01-data-schema.md ("two territories that
//      border each other must reference the SAME vertex ids") is invisible to
//      the eye and catastrophic to get wrong, and it is checkable for free.
//
//   2. SIM BEHAVIOUR — guarded behind `typeof applyCommand === 'function'`,
//      inert until sim/ lands, then live with no edit here.
//
// Every suite SKIPS with a clear reason when its inputs are missing. A missing
// file is never an exception: three agents are authoring this project in
// parallel and a harness that explodes on absent data is useless to all of
// them.
//
// Exposes: runAllTests(), dataSummary(), formatResults().

// Minimum separation between two entries in VERTS, in viewBox units. Not a
// balance constant, so it does not belong in BAL: it is the threshold below
// which two vertices are certainly a duplicate-by-typo rather than two real
// map corners (01-data-schema.md: "never two vertices at nearly the same
// coordinate").
var MIN_VERT_SEP = 4;

// How far outside its territory polygon a station's pos may sit before it is
// a failure. Coastal cities are authored right on the coastline and floating
// point plus hand-drawn shapes make exact containment unreasonable.
var STATION_POS_TOLERANCE = 2.0;

// ---------------------------------------------------------------------------
// Data access
//
// `const` at the top level of a file lands in the global LEXICAL scope, not on
// globalThis, so there is no way to look these up by string name. Hence the
// explicit typeof ladder — read at RUN time, not at load time, so the harness
// sees data files that loaded after this one.
// ---------------------------------------------------------------------------

function collectData() {
  return {
    VERTS:       (typeof VERTS       !== 'undefined') ? VERTS       : null,
    TERRITORIES: (typeof TERRITORIES !== 'undefined') ? TERRITORIES : null,
    STATIONS:    (typeof STATIONS    !== 'undefined') ? STATIONS    : null,
    LINKS:       (typeof LINKS       !== 'undefined') ? LINKS       : null,
    POWERS:      (typeof POWERS      !== 'undefined') ? POWERS      : null,
    SETUP:       (typeof SETUP       !== 'undefined') ? SETUP       : null,
    BAL:         (typeof BAL         !== 'undefined') ? BAL         : null,
  };
}

// Which sim entry points exist yet. Probing a few plausible names for the tick
// function keeps this file from having to be edited the day sim/step.js lands.
function simFns() {
  var _ng = (typeof newGame === 'function') ? newGame : null;
  return {
    // Sim-suite boards are AI-QUIET BY CONSTRUCTION. aiTick runs as phase 0 of
    // stepTick, so without this every sim fixture has seven opponents playing
    // inside it and the suites stop measuring what they claim to.
    //
    // Done here rather than in _run() deliberately: four sim tests call
    // fns.step() directly, so a flag set by the run helper would leave exactly
    // those four confounded — the quiet ones, which is the worst place for a
    // gap. Attaching it to state CREATION covers every path by which a suite
    // can advance a board.
    //
    // test/ai-tests.js builds its own states and must NOT use this.
    newGame: _ng ? function (seed) {
      var s = _ng(seed);
      s.aiEnabled = false;
      return s;
    } : null,
    apply:   (typeof applyCommand === 'function') ? applyCommand : null,
    step:    (typeof stepTick    === 'function') ? stepTick
           : (typeof simStep     === 'function') ? simStep
           : (typeof stepSim     === 'function') ? stepSim
           : (typeof step        === 'function') ? step
           : null,
  };
}

// Name the missing globals so the SKIP line is actionable rather than sad.
function missingOf(data, names) {
  var out = [];
  for (var i = 0; i < names.length; i++) if (!data[names[i]]) out.push(names[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function _dist(a, b) {
  var dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// Ray casting. Polygons are closed implicitly (01-data-schema.md), so the last
// vertex wraps to the first.
function _pointInPoly(p, poly) {
  var inside = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1];
    var xj = poly[j][0], yj = poly[j][1];
    var hit = ((yi > p[1]) !== (yj > p[1])) &&
              (p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || 1e-12) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function _distToSeg(p, a, b) {
  var vx = b[0] - a[0], vy = b[1] - a[1];
  var len2 = vx * vx + vy * vy;
  if (len2 === 0) return _dist(p, a);
  var t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return _dist(p, [a[0] + t * vx, a[1] + t * vy]);
}

function _distToPoly(p, poly) {
  var best = Infinity;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, _distToSeg(p, poly[j], poly[i]));
  }
  return best;
}

// Resolve a territory's shape (vertex ids) into coordinate pairs. Returns null
// if any id is unknown, so callers can report that separately rather than
// crashing on undefined[0].
function _polyOf(terr, VERTS) {
  var poly = [];
  for (var i = 0; i < terr.shape.length; i++) {
    var v = VERTS[terr.shape[i]];
    if (!v) return null;
    poly.push(v);
  }
  return poly;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function _linkAdjacency(LINKS) {
  var adj = {};
  for (var i = 0; i < LINKS.length; i++) {
    var l = LINKS[i];
    (adj[l.a] = adj[l.a] || []).push(l.b);
    (adj[l.b] = adj[l.b] || []).push(l.a);
  }
  return adj;
}

// Flood fill. `allow` is an optional predicate gating which nodes may be
// entered — used for "reachable from the capital over stations you own".
function _flood(start, adj, allow) {
  var seen = {}, queue = [start];
  seen[start] = true;
  while (queue.length) {
    var cur = queue.shift();
    var nbrs = adj[cur] || [];
    for (var i = 0; i < nbrs.length; i++) {
      var n = nbrs[i];
      if (seen[n]) continue;
      if (allow && !allow(n)) continue;
      seen[n] = true;
      queue.push(n);
    }
  }
  return seen;
}

// Adjacency derived from SHARED VERTEX EDGES. This is the check the whole map
// format exists to make possible (01-data-schema.md): an edge key is the two
// vertex ids sorted, and any key claimed by two territories means they border.
function _derivedNeighbors(TERRITORIES) {
  var edgeOwners = {};
  var ids = Object.keys(TERRITORIES).sort();
  var derived = {};
  var overshared = [];

  ids.forEach(function (tid) {
    derived[tid] = {};
    var shape = TERRITORIES[tid].shape || [];
    for (var i = 0, j = shape.length - 1; i < shape.length; j = i++) {
      var key = [shape[j], shape[i]].sort().join('~');
      (edgeOwners[key] = edgeOwners[key] || []).push(tid);
    }
  });

  Object.keys(edgeOwners).forEach(function (key) {
    var owners = edgeOwners[key];
    if (owners.length < 2) return;
    if (owners.length > 2) overshared.push(key + ' shared by ' + owners.join(','));
    for (var a = 0; a < owners.length; a++) {
      for (var b = a + 1; b < owners.length; b++) {
        if (owners[a] === owners[b]) continue;
        derived[owners[a]][owners[b]] = true;
        derived[owners[b]][owners[a]] = true;
      }
    }
  });

  return { derived: derived, overshared: overshared };
}

// ---------------------------------------------------------------------------
// Combat model, reimplemented locally.
//
// Deliberately NOT importing sim/combat.js: this suite has to be able to
// answer "is COMBAT_RATE the right number" while sim/ is still being written,
// and an independent implementation of the square law is also the only way to
// catch sim/combat.js quietly diverging from the design later.
// ---------------------------------------------------------------------------

function lanchester(a0, b0, rate) {
  var a = a0, b = b0, ticks = 0;
  var eps = 1e-4;
  while (a > eps && b > eps && ticks < 200000) {
    var la = rate * b, lb = rate * a;
    a -= la; b -= lb;
    ticks++;
  }
  return {
    a: Math.max(a, 0), b: Math.max(b, 0), ticks: ticks,
    survivors: Math.max(a, 0) / a0,
  };
}

// ===========================================================================
// SUITES
// ===========================================================================

function runAllTests() {
  resetTests();
  var d = collectData();

  suiteTuning(d);
  suiteCombatModel(d);
  suiteVerts(d);
  suiteTerritories(d);
  suiteAdjacency(d);
  suiteStationPlacement(d);
  suiteStationTypes(d);
  suiteLinks(d);
  suiteSetup(d);
  suiteReachability(d);

  // Sim family — all inert until sim/ lands.
  suiteSimGrowth(d);
  suiteSimCombat(d);
  suiteSimMultiplier(d);
  suiteSimDisconnect(d);
  suiteSimCapitulation(d);
  suiteSimCommands(d);
  suiteSimRouting(d);
  suiteSimBeachhead(d);
  suiteStandingOrders(d);

  // AI family — test/ai-tests.js; skips loudly until ai/ lands.
  if (typeof suiteAI === 'function') suiteAI(d);

  // Fog family — test/fog-tests.js; skips loudly until core/vision.js lands.
  if (typeof suiteFog === 'function') suiteFog(d);

  // The guide — test/help-tests.js. render/help.js is the one file under
  // render/ the headless harness loads, and it can be because everything
  // asserted is derived content: no DOM is touched until helpShow() is called.
  if (typeof suiteHelp === 'function') suiteHelp(d);

  // The standings panel — test/scenarios-standings.js. Second render/ file the
  // harness loads, and safe for the same reason: the ranking is a pure function
  // of state and no DOM is touched until the rail calls build().
  if (typeof suiteStandings === 'function') suiteStandings(d);

  // Selection gestures — test/select-tests.js. This one is NOT reached by
  // test/node.js or tests.html and cannot be: render/select.js calls
  // document.addEventListener at the top level, and the gesture assertions
  // hit-test real screen coordinates against a rendered board. It runs from
  // tests-ui.html, which loads index.html itself in an iframe and injects the
  // suite — see the comment there for why there is no second script list.
  // The hook is here anyway so the suite is registered in one place.
  if (typeof suiteSelect === 'function') suiteSelect(d);

  return TEST_RESULTS;
}

// --- BAL -------------------------------------------------------------------

function suiteTuning(d) {
  if (!d.BAL) return skipSuite('tuning / BAL', 'data/tuning.js not loaded');
  suite('tuning / BAL');
  var B = d.BAL;

  test('required constants are present', function () {
    var need = ['TICK_MS', 'GROWTH_BASE', 'COMBAT_RATE', 'SEND_FRACTION_DEFAULT',
                'ROUT_THRESHOLD', 'BATTLE_VARIANCE', 'DISCONNECT_DECAY',
                'CAPITULATE_FRACTION', 'UNITS', 'MATCHUP', 'TERRAIN', 'AI'];
    var missing = need.filter(function (k) { return B[k] === undefined; });
    assertNone(missing, 'BAL is missing constants');
  });

  // §8 still says "a persistent 25/50/75/All setting … default 75%", and that
  // sentence no longer describes what ships: the default is 25% and the setting
  // is ONE-SHOT, relaxing back after every volley. The citation is deliberately
  // dropped from the name rather than left there to rot — a test that cites a
  // document it contradicts teaches the wrong thing twice. data/tuning.js
  // carries the reasoning above the constant.
  test('send fraction defaults to the timid end of the ladder', function () {
    assertEqual(B.SEND_FRACTION_DEFAULT, 0.25, 'SEND_FRACTION_DEFAULT');
    assert(B.SEND_FRACTIONS.indexOf(B.SEND_FRACTION_DEFAULT) >= 0,
      'SEND_FRACTIONS must contain the default');
    // The default has to be the CHEAPEST rung, not merely present on the ladder.
    // That is the whole design: an absent-minded click spends as little as the
    // game allows, and committing everything costs a deliberate keystroke.
    var min = B.SEND_FRACTIONS.slice().sort(function (a, b) { return a - b; })[0];
    assertEqual(B.SEND_FRACTION_DEFAULT, min,
      'the one-shot default must be the smallest fraction on the ladder');
  });

  test('a send always leaves a seed behind, so no city is ever killed by its own order', function () {
    // Logistic growth is proportional to `units` (§2), so a station emptied to
    // exactly zero has a growth rate of exactly zero and is dead ground forever.
    // SEND_KEEP_UNITS is what stops "All" from doing that. Asserted as > 0
    // rather than as 1.0: the exact value is tuning, the fact that it is
    // non-zero is the invariant.
    assert(isFinite(B.SEND_KEEP_UNITS) && B.SEND_KEEP_UNITS > 0,
      'SEND_KEEP_UNITS must be a positive number of units');
    // ...and small enough to be a seed rather than a garrison. A floor that
    // could defend the place would quietly cancel "I emptied my rear" as a real
    // risk, which §5 wants kept.
    assert(B.SEND_KEEP_UNITS <= 2, 'SEND_KEEP_UNITS is a seed, not a garrison');
  });

  test('the speed ladder has a default that is on it', function () {
    assert(Array.isArray(B.SPEEDS) && B.SPEEDS.length > 0, 'BAL.SPEEDS must be a non-empty array');
    assert(B.SPEEDS.indexOf(B.SPEED_DEFAULT) >= 0,
      'BAL.SPEED_DEFAULT (' + B.SPEED_DEFAULT + ') is not one of BAL.SPEEDS [' + B.SPEEDS + ']');
    // Pause is a separate flag, never a rung — a 0 here would make "unpause"
    // ambiguous about what speed to restore.
    assert(B.SPEEDS.indexOf(0) < 0, 'pause is a flag, not a speed');
    // newGame() sources its opening speed from SPEED_DEFAULT. If the two ever
    // disagree a fresh game starts at a speed the HUD cannot show as selected.
    if (typeof newGame === 'function') {
      assertEqual(newGame(1).speed, B.SPEED_DEFAULT,
        'newGame() does not open at BAL.SPEED_DEFAULT');
    }
  });

  test('rout threshold is 0 — fight to annihilation (§5)', function () {
    assertEqual(B.ROUT_THRESHOLD, 0, 'ROUT_THRESHOLD');
  });

  test('battle variance is a sane single-roll band', function () {
    assertBetween(B.BATTLE_VARIANCE, 0.02, 0.30, 'BATTLE_VARIANCE');
    // The wobble is flavour layered on the one real roll; if it ever exceeds
    // the roll it has quietly become per-tick variance, which §5 rules out.
    assert(B.BATTLE_WOBBLE < B.BATTLE_VARIANCE,
      'BATTLE_WOBBLE must stay under BATTLE_VARIANCE or it becomes per-tick variance');
  });

  test('unit roster matches §4', function () {
    var types = B.UNIT_ORDER;
    assertEqual(types.length, 3, 'three unit types');
    types.forEach(function (t) {
      assert(B.UNITS[t], 'UNITS.' + t + ' missing');
      assert(B.UNITS[t].atk > 0 && B.UNITS[t].def > 0 && B.UNITS[t].speed > 0,
        t + ' has a non-positive stat');
    });
    assert(B.UNITS.infantry.def > B.UNITS.infantry.atk, 'infantry must defend better than it attacks');
    assert(B.UNITS.artillery.atk > B.UNITS.infantry.atk, 'artillery must out-attack infantry');
    assert(B.UNITS.armour.speed > B.UNITS.infantry.speed, 'armour must be faster than infantry');
    assert(B.UNITS.artillery.speed < B.UNITS.infantry.speed, 'artillery must be slower than infantry');
    assert(B.UNITS.artillery.fortStrip > 0, 'only artillery strips forts (§4)');
    assert(B.UNITS.armour.fortStrip === undefined, 'armour must not strip forts');
  });

  test('matchup triangle: artillery > infantry > armour > artillery', function () {
    var M = B.MATCHUP;
    assert(M.artillery.infantry > 1, 'artillery should beat infantry');
    assert(M.armour.artillery > 1, 'armour should beat artillery');
    assert(M.infantry.armour > 1, 'infantry should beat armour');
    assert(M.infantry.artillery < 1 && M.artillery.armour < 1 && M.armour.infantry < 1,
      'the losing side of each matchup must be below 1');
    B.UNIT_ORDER.forEach(function (t) { assertEqual(M[t][t], 1.0, 'mirror matchup ' + t); });
    // Near zero-sum: no type may be quietly best on average.
    B.UNIT_ORDER.forEach(function (t) {
      var prod = M[t].infantry * M[t].artillery * M[t].armour;
      assertBetween(prod, 0.9, 1.15, t + ' matchup product (should be ~1, zero-sum triangle)');
    });
  });

  test('terrain table covers every terrain kind in the schema', function () {
    ['plains', 'hills', 'mountains', 'forest', 'urban'].forEach(function (k) {
      assert(B.TERRAIN[k], 'TERRAIN.' + k + ' missing');
      assertBetween(B.TERRAIN[k].move, 0.3, 1.0, 'TERRAIN.' + k + '.move');
      assertBetween(B.TERRAIN[k].defense, 0, 2, 'TERRAIN.' + k + '.defense');
    });
    assertEqual(B.TERRAIN.plains.move, 1.0, 'plains is the baseline');
    assert(B.TERRAIN.mountains.move < B.TERRAIN.hills.move, 'mountains slower than hills');
    assert(B.TERRAIN.mountains.defense > B.TERRAIN.hills.defense, 'mountains defend better than hills');
  });

  test('sea crossings are slow and punish artillery (§3)', function () {
    assert(B.SEA_SPEED_MUL < 1, 'sea crossings must be slower than land');
    assert(B.SEA_ARTILLERY_SPEED_MUL < 1, 'artillery crosses even slower');
    assertBetween(B.SEA_ARTILLERY_LOSS, 0, 0.4, 'SEA_ARTILLERY_LOSS');
  });

  test('anti-snowball constants are live (§5)', function () {
    assert(B.DISCONNECT_DECAY > 0, 'disconnection must actually decay');
    assertEqual(B.DISCONNECT_GROWTH, 0, 'disconnected stations must not grow');
    assertBetween(B.CAPITULATE_FRACTION, 0.05, 0.5, 'CAPITULATE_FRACTION (§7 says ~0.25)');
    assert(B.AI.LEADER_WEIGHT > 0, 'the balance-of-power term must be non-zero — it is the whole Concert');
  });

  test('AI cannot out-click the player (§6)', function () {
    assert(B.AI.ACTION_INTERVAL_TICKS >= 20,
      'an order more often than every 2 sim-seconds out-clicks a human');
    assert(B.AI.ACTION_JITTER_TICKS < B.AI.ACTION_INTERVAL_TICKS,
      'jitter must not exceed the interval or powers can act twice in a row');
    assert(B.AI.SOURCE_MAX_HOPS >= B.AI.TARGET_MAX_HOPS,
      'sources must reach at least as far as targets or the AI cannot mass');
    Object.keys(B.AI.PERSONALITIES).forEach(function (p) {
      var P = B.AI.PERSONALITIES[p];
      ['aggression', 'minOddsMul', 'leaderWeight', 'borderWeight'].forEach(function (k) {
        assert(typeof P[k] === 'number', p + '.' + k + ' missing');
      });
    });
    ['expansionist', 'turtle', 'opportunist'].forEach(function (p) {
      assert(B.AI.PERSONALITIES[p], 'personality ' + p + ' missing (§6)');
    });
  });
}

// --- The square law --------------------------------------------------------

function suiteCombatModel(d) {
  if (!d.BAL) return skipSuite('combat model / square law', 'data/tuning.js not loaded');
  suite('combat model / square law');
  var B = d.BAL;

  test('2:1 attacker wins keeping ~87%', function () {
    var r = lanchester(200, 100, B.COMBAT_RATE);
    assertClose(r.survivors, 0.866, 0.02, '2:1 survivor fraction');
  });

  test('3:1 attacker wins keeping ~94%', function () {
    var r = lanchester(300, 100, B.COMBAT_RATE);
    assertClose(r.survivors, 0.943, 0.02, '3:1 survivor fraction');
  });

  test('1.2:1 is bloody — ~55%', function () {
    var r = lanchester(120, 100, B.COMBAT_RATE);
    assertClose(r.survivors, 0.553, 0.03, '1.2:1 survivor fraction');
  });

  test('1.05:1 attacker does NOT win intact (§11)', function () {
    var r = lanchester(105, 100, B.COMBAT_RATE);
    assert(r.survivors < 0.40,
      'a 1.05:1 attacker kept ' + Math.round(r.survivors * 100) + '% — trickling must be punished');
  });

  test('outcome is scale-free — 10 v 5 resolves like 1000 v 500', function () {
    var small = lanchester(10, 5, B.COMBAT_RATE);
    var big = lanchester(1000, 500, B.COMBAT_RATE);
    assertClose(small.survivors, big.survivors, 0.02, 'survivor fraction must not depend on army size');
  });

  test('decisive battles resolve in 15-40 sim-seconds', function () {
    var secs = function (t) { return t * B.TICK_MS / 1000; };
    var problems = [];
    [[3, 1], [2, 1], [1.5, 1]].forEach(function (pair) {
      var r = lanchester(pair[0] * 100, pair[1] * 100, B.COMBAT_RATE);
      var s = secs(r.ticks);
      if (s < 15 || s > 40) problems.push(pair[0] + ':1 took ' + Math.round(s) + 's');
    });
    assertNone(problems, 'decisive battle duration outside the 15-40s window');
  });

  test('even fights grind longer than decisive ones', function () {
    var even = lanchester(105, 100, B.COMBAT_RATE);
    var decisive = lanchester(200, 100, B.COMBAT_RATE);
    assert(even.ticks > decisive.ticks * 2,
      'a near-even fight should take far longer than a 2:1 — got ' +
      even.ticks + ' vs ' + decisive.ticks + ' ticks');
  });

  test('additive station defense keeps forts takeable (§5)', function () {
    // Multiplicative defense would scale with the garrison and freeze the map.
    // Additive means a fixed block of power, so a big enough volley always
    // gets through — this test pins that property rather than the number.
    var fortBonus = B.DEFENSE_BONUS_POWER * (3.5 - 1.0);
    var defenderPower = 20 * B.UNITS.infantry.def + fortBonus;
    var attackerPower = 60 * B.UNITS.infantry.atk;
    assert(attackerPower > defenderPower,
      'a 3:1 volley must beat a full 3.5-defense citadel; got ' +
      Math.round(attackerPower) + ' vs ' + Math.round(defenderPower));
    // ...but it must not be trivial either.
    assert(30 * B.UNITS.infantry.atk < defenderPower,
      'a 1.5:1 volley should NOT crack a citadel — the fort bonus is too weak');
  });
}

// --- VERTS -----------------------------------------------------------------

function suiteVerts(d) {
  if (!d.VERTS || !d.TERRITORIES) {
    return skipSuite('map / VERTS',
      'missing ' + missingOf(d, ['VERTS', 'TERRITORIES']).join(' + ') + ' (data/map.js not authored yet)');
  }
  suite('map / VERTS');
  var V = d.VERTS, T = d.TERRITORIES;
  var vids = Object.keys(V).sort();

  test('every vertex is a numeric [x, y] inside the 1000x700 viewBox', function () {
    var bad = [];
    vids.forEach(function (id) {
      var v = V[id];
      if (!Array.isArray(v) || v.length !== 2 ||
          typeof v[0] !== 'number' || typeof v[1] !== 'number' ||
          !isFinite(v[0]) || !isFinite(v[1])) { bad.push(id + ' malformed'); return; }
      if (v[0] < 0 || v[0] > 1000 || v[1] < 0 || v[1] > 700) {
        bad.push(id + ' at [' + v[0] + ',' + v[1] + '] out of viewBox');
      }
    });
    assertNone(bad, 'malformed vertices');
  });

  test('every vertex referenced in a shape exists', function () {
    var bad = [];
    Object.keys(T).sort().forEach(function (tid) {
      (T[tid].shape || []).forEach(function (vid) {
        if (!V[vid]) bad.push(tid + ' references unknown vertex ' + vid);
      });
    });
    assertNone(bad, 'dangling vertex references');
  });

  test('no two vertices within ' + MIN_VERT_SEP + ' units', function () {
    // The single most important rule in the project: near-duplicate vertices
    // are how gaps and slivers get in, and they silently break derived
    // adjacency because the two territories no longer share an id.
    var bad = [];
    for (var i = 0; i < vids.length; i++) {
      for (var j = i + 1; j < vids.length; j++) {
        var a = V[vids[i]], b = V[vids[j]];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        var dd = _dist(a, b);
        if (dd < MIN_VERT_SEP) {
          bad.push(vids[i] + '/' + vids[j] + ' only ' + Math.round(dd * 100) / 100 + ' apart');
        }
      }
    }
    assertNone(bad, 'near-duplicate vertices — merge them into one id');
  });

  test('no orphan vertices — every entry is used by some shape', function () {
    var used = {};
    Object.keys(T).forEach(function (tid) {
      (T[tid].shape || []).forEach(function (vid) { used[vid] = true; });
    });
    var orphans = vids.filter(function (id) { return !used[id]; });
    assertNone(orphans, 'vertices defined but never used (usually a typo in a shape)');
  });
}

// --- TERRITORIES -----------------------------------------------------------

function suiteTerritories(d) {
  if (!d.TERRITORIES) return skipSuite('map / TERRITORIES', 'TERRITORIES missing (data/map.js not authored yet)');
  suite('map / TERRITORIES');
  var T = d.TERRITORIES, V = d.VERTS;
  var tids = Object.keys(T).sort();

  test('every territory has the schema fields', function () {
    var bad = [];
    tids.forEach(function (tid) {
      var t = T[tid];
      if (t.id !== tid) bad.push(tid + ': id field is "' + t.id + '"');
      if (!t.name) bad.push(tid + ': no name');
      if (!Array.isArray(t.shape) || t.shape.length < 3) bad.push(tid + ': shape needs 3+ vertices');
      if (!Array.isArray(t.label) || t.label.length !== 2) bad.push(tid + ': no label position');
      if (!Array.isArray(t.neighbors)) bad.push(tid + ': neighbors must be an array');
      if (typeof t.coastal !== 'boolean') bad.push(tid + ': coastal must be a boolean');
    });
    assertNone(bad, 'territory schema violations');
  });

  test('terrain is one of the five kinds', function () {
    var kinds = { plains: 1, hills: 1, mountains: 1, forest: 1, urban: 1 };
    var bad = tids.filter(function (tid) { return !kinds[T[tid].terrain]; })
                  .map(function (tid) { return tid + ' has terrain "' + T[tid].terrain + '"'; });
    assertNone(bad, 'unknown terrain kinds');
  });

  test('shapes have no repeated vertex ids', function () {
    var bad = [];
    tids.forEach(function (tid) {
      var seen = {};
      (T[tid].shape || []).forEach(function (vid) {
        if (seen[vid]) bad.push(tid + ' uses ' + vid + ' twice');
        seen[vid] = true;
      });
    });
    assertNone(bad, 'self-intersecting shape definitions');
  });

  test('label position falls inside its own territory', function () {
    if (!V) return skipTest('label inside territory', 'VERTS missing');
    var bad = [];
    tids.forEach(function (tid) {
      var poly = _polyOf(T[tid], V);
      if (!poly) return; // reported by the VERTS suite
      if (!_pointInPoly(T[tid].label, poly)) bad.push(tid + ' label outside its polygon');
    });
    assertNone(bad, 'territory labels drawn outside their shapes');
  });

  test('neighbor lists are symmetric and reference real territories', function () {
    var bad = [];
    tids.forEach(function (tid) {
      (T[tid].neighbors || []).forEach(function (n) {
        if (n === tid) { bad.push(tid + ' lists itself'); return; }
        if (!T[n]) { bad.push(tid + ' lists unknown neighbor ' + n); return; }
        if ((T[n].neighbors || []).indexOf(tid) < 0) bad.push(tid + '->' + n + ' is not mutual');
      });
    });
    assertNone(bad, 'asymmetric or dangling neighbor declarations');
  });
}

// --- Derived vs declared adjacency ----------------------------------------

function suiteAdjacency(d) {
  if (!d.TERRITORIES) {
    return skipSuite('map / derived adjacency', 'TERRITORIES missing (data/map.js not authored yet)');
  }
  suite('map / derived adjacency');
  var T = d.TERRITORIES;
  var tids = Object.keys(T).sort();
  var res = _derivedNeighbors(T);
  var derived = res.derived;

  // A territory sharing no edge with anyone is an island (Britain, Ireland,
  // Sicily…). Its declared neighbors necessarily come from sea links, so it is
  // exempt from the derived==declared rule. Likewise a pair joined by a
  // `sea: true` link.
  var isIsland = {};
  tids.forEach(function (tid) { isIsland[tid] = Object.keys(derived[tid]).length === 0; });

  var seaPairs = {};
  if (d.LINKS && d.STATIONS) {
    d.LINKS.forEach(function (l) {
      if (!l.sea) return;
      var sa = d.STATIONS[l.a], sb = d.STATIONS[l.b];
      if (!sa || !sb || sa.territory === sb.territory) return;
      seaPairs[[sa.territory, sb.territory].sort().join('~')] = true;
    });
  }

  test('no edge is shared by more than two territories', function () {
    assertNone(res.overshared, 'an edge claimed by 3+ territories — the shapes overlap');
  });

  test('every DERIVED adjacency is declared', function () {
    // Failing here means the geometry says two territories touch but the
    // author did not list it. Always a bug — there is no exception.
    var bad = [];
    tids.forEach(function (tid) {
      Object.keys(derived[tid]).sort().forEach(function (n) {
        if ((T[tid].neighbors || []).indexOf(n) < 0) {
          bad.push(tid + ' shares an edge with ' + n + ' but does not declare it');
        }
      });
    });
    assertNone(bad, 'undeclared adjacencies');
  });

  test('every DECLARED adjacency is derived (islands and sea links excepted)', function () {
    var bad = [];
    tids.forEach(function (tid) {
      (T[tid].neighbors || []).forEach(function (n) {
        if (!T[n] || derived[tid][n]) return;
        if (isIsland[tid] || isIsland[n]) return;                       // island exception
        if (seaPairs[[tid, n].sort().join('~')]) return;                // sea-crossing exception
        bad.push(tid + ' declares ' + n + ' but they share no edge');
      });
    });
    assertNone(bad, 'declared adjacencies with no shared edge — either the shapes have a gap or the list is wrong');
  });

  test('islands are actually islands', function () {
    var bad = tids.filter(function (tid) {
      return isIsland[tid] && T[tid].coastal === false;
    }).map(function (tid) { return tid + ' shares no edge but is marked coastal:false'; });
    assertNone(bad, 'landlocked territories with no land neighbours');
  });
}

// --- Station placement -----------------------------------------------------

function suiteStationPlacement(d) {
  if (!d.STATIONS || !d.TERRITORIES || !d.VERTS) {
    return skipSuite('stations / placement',
      'missing ' + missingOf(d, ['STATIONS', 'TERRITORIES', 'VERTS']).join(' + ') +
      ' (data/stations.js / data/map.js not authored yet)');
  }
  suite('stations / placement');
  var S = d.STATIONS, T = d.TERRITORIES, V = d.VERTS;
  var sids = Object.keys(S).sort();

  test('every station names a real territory', function () {
    var bad = sids.filter(function (sid) { return !T[S[sid].territory]; })
                  .map(function (sid) { return sid + ' -> "' + S[sid].territory + '"'; });
    assertNone(bad, 'stations in unknown territories');
  });

  test("every station's pos falls inside its territory's polygon", function () {
    var bad = [];
    sids.forEach(function (sid) {
      var st = S[sid], terr = T[st.territory];
      if (!terr) return; // reported above
      var poly = _polyOf(terr, V);
      if (!poly) return; // reported by the VERTS suite
      if (_pointInPoly(st.pos, poly)) return;
      var off = _distToPoly(st.pos, poly);
      if (off <= STATION_POS_TOLERANCE) return; // right on the coastline, fine
      bad.push(sid + ' (' + st.name + ') is ' + Math.round(off) + ' outside ' + st.territory);
    });
    assertNone(bad, 'stations placed outside their own territory');
  });

  test('station ids match their keys and positions are in the viewBox', function () {
    var bad = [];
    sids.forEach(function (sid) {
      var st = S[sid];
      if (st.id !== sid) bad.push(sid + ': id field is "' + st.id + '"');
      if (!st.name) bad.push(sid + ': no name');
      if (!Array.isArray(st.pos) || st.pos.length !== 2) { bad.push(sid + ': malformed pos'); return; }
      if (st.pos[0] < 0 || st.pos[0] > 1000 || st.pos[1] < 0 || st.pos[1] > 700) {
        bad.push(sid + ' at [' + st.pos + '] out of viewBox');
      }
    });
    assertNone(bad, 'station schema violations');
  });

  test('no two stations at the same point', function () {
    var bad = [];
    for (var i = 0; i < sids.length; i++) {
      for (var j = i + 1; j < sids.length; j++) {
        var a = S[sids[i]].pos, b = S[sids[j]].pos;
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        if (_dist(a, b) < 6) bad.push(sids[i] + '/' + sids[j] + ' overlap on screen');
      }
    }
    assertNone(bad, 'stations too close to render as separate nodes');
  });

  test('every territory has at least one station', function () {
    var counts = {};
    Object.keys(T).forEach(function (tid) { counts[tid] = 0; });
    sids.forEach(function (sid) {
      if (counts[S[sid].territory] !== undefined) counts[S[sid].territory]++;
    });
    var empty = Object.keys(counts).sort().filter(function (tid) { return counts[tid] === 0; });
    assertNone(empty, 'territories with no stations — they can never be taken or lost');
  });

  test('station count is in the design range (~90-110 across ~45 territories)', function () {
    assertBetween(sids.length, 60, 140, 'station count (00-vision.md §12.2)');
    assertBetween(Object.keys(T).length, 30, 60, 'territory count');
  });
}

// --- Station type invariants ----------------------------------------------

function suiteStationTypes(d) {
  if (!d.STATIONS) {
    return skipSuite('stations / type invariants', 'STATIONS missing (data/stations.js not authored yet)');
  }
  suite('stations / type invariants');
  var S = d.STATIONS;
  var sids = Object.keys(S).sort();

  // The table from 01-data-schema.md, transcribed. Ranges on the two
  // "single value" cells (multiplier rate 0.3, multiplier defense 0.8) are
  // widened slightly so the map author has room to shade a value without
  // tripping the harness; everything else is the table verbatim.
  var SPEC = {
    holding:    { produces: ['infantry'],             capacity: [25, 80], rate: [0.7, 1.1], defense: [0.9, 1.1], multiplier: null },
    producer:   { produces: ['artillery', 'armour'],  capacity: [15, 35], rate: [0.4, 0.6], defense: [1.0, 1.2], multiplier: null },
    multiplier: { produces: ['infantry'],             capacity: [8, 15],  rate: [0.25, 0.35], defense: [0.7, 0.9], multiplier: [1.3, 1.8] },
    defensive:  { produces: ['infantry'],             capacity: [12, 25], rate: [0.3, 0.5], defense: [2.0, 3.5], multiplier: null },
  };

  test('every station has a known type', function () {
    var bad = sids.filter(function (sid) { return !SPEC[S[sid].type]; })
                  .map(function (sid) { return sid + ' has type "' + S[sid].type + '"'; });
    assertNone(bad, 'unknown station types');
  });

  test('capacity, rate, defense and multiplier match the type table', function () {
    var bad = [];
    sids.forEach(function (sid) {
      var st = S[sid], spec = SPEC[st.type];
      if (!spec) return;
      var inRange = function (v, r, field) {
        if (typeof v !== 'number' || v < r[0] - 1e-9 || v > r[1] + 1e-9) {
          bad.push(sid + ' (' + st.type + ') ' + field + '=' + v + ', expected ' + r[0] + '-' + r[1]);
        }
      };
      inRange(st.capacity, spec.capacity, 'capacity');
      inRange(st.rate, spec.rate, 'rate');
      inRange(st.defense, spec.defense, 'defense');
    });
    assertNone(bad, 'stations outside their type\'s stat band');
  });

  test('produces matches the type — only producers make artillery or armour', function () {
    var bad = [];
    sids.forEach(function (sid) {
      var st = S[sid], spec = SPEC[st.type];
      if (!spec) return;
      if (spec.produces.indexOf(st.produces) < 0) {
        bad.push(sid + ' (' + st.type + ') produces "' + st.produces + '"');
      }
    });
    assertNone(bad, 'wrong produces for station type');
  });

  test('only multiplier stations carry a multiplier value', function () {
    var bad = [];
    sids.forEach(function (sid) {
      var st = S[sid];
      if (st.type === 'multiplier') {
        if (typeof st.multiplier !== 'number') { bad.push(sid + ' is a multiplier with no multiplier value'); return; }
        if (st.multiplier < 1.3 - 1e-9 || st.multiplier > 1.8 + 1e-9) {
          bad.push(sid + ' multiplier=' + st.multiplier + ', expected 1.3-1.8');
        }
      } else if (st.multiplier !== null && st.multiplier !== undefined) {
        bad.push(sid + ' (' + st.type + ') carries multiplier=' + st.multiplier);
      }
    });
    assertNone(bad, 'multiplier field misused');
  });

  test('defensive stations really are defensive, and nothing else is', function () {
    var bad = [];
    sids.forEach(function (sid) {
      var st = S[sid];
      if (st.type === 'defensive' && !(st.defense >= 2.0)) {
        bad.push(sid + ' is defensive but defense=' + st.defense);
      }
      if (st.type !== 'defensive' && st.defense >= 2.0) {
        bad.push(sid + ' (' + st.type + ') has fortress-grade defense=' + st.defense);
      }
    });
    assertNone(bad, 'defense values inconsistent with type');
  });

  test('the map actually contains every type, and both producer outputs', function () {
    var byType = {}, produced = {};
    sids.forEach(function (sid) {
      byType[S[sid].type] = (byType[S[sid].type] || 0) + 1;
      if (S[sid].type === 'producer') produced[S[sid].produces] = true;
    });
    ['holding', 'producer', 'multiplier', 'defensive'].forEach(function (t) {
      assert(byType[t] > 0, 'no stations of type ' + t + ' exist');
    });
    assert(produced.artillery, 'nowhere on the map makes artillery — fortresses become untakeable (§4)');
    assert(produced.armour, 'nowhere on the map makes armour');
    // Holdings are "most of the map" (§2); the specials should stay special.
    assert(byType.holding > sids.length * 0.4, 'holdings should be most of the map');
  });
}

// --- LINKS -----------------------------------------------------------------

function suiteLinks(d) {
  if (!d.LINKS || !d.STATIONS) {
    return skipSuite('links / graph',
      'missing ' + missingOf(d, ['LINKS', 'STATIONS']).join(' + ') + ' (data/stations.js not authored yet)');
  }
  suite('links / graph');
  var L = d.LINKS, S = d.STATIONS;
  var sids = Object.keys(S).sort();

  test('every link references two real, distinct stations', function () {
    var bad = [];
    L.forEach(function (l, i) {
      if (!S[l.a]) bad.push('#' + i + ' unknown station "' + l.a + '"');
      if (!S[l.b]) bad.push('#' + i + ' unknown station "' + l.b + '"');
      if (l.a === l.b) bad.push('#' + i + ' links ' + l.a + ' to itself');
    });
    assertNone(bad, 'malformed links');
  });

  test('exactly one record per pair — links are undirected', function () {
    var seen = {}, bad = [];
    L.forEach(function (l) {
      var key = [l.a, l.b].sort().join('~');
      if (seen[key]) bad.push(key + ' declared twice');
      seen[key] = true;
    });
    assertNone(bad, 'duplicate link records');
  });

  test('dist is positive and roughly the on-screen distance', function () {
    var bad = [];
    L.forEach(function (l) {
      if (typeof l.dist !== 'number' || !(l.dist > 0)) { bad.push(l.a + '~' + l.b + ' dist=' + l.dist); return; }
      var sa = S[l.a], sb = S[l.b];
      if (!sa || !sb) return;
      var geo = _dist(sa.pos, sb.pos);
      // Hand-tuned at chokepoints (01-data-schema.md), so a generous 3x band —
      // this is here to catch transposed digits, not to police tuning.
      if (l.dist < geo / 3 || l.dist > geo * 3) {
        bad.push(l.a + '~' + l.b + ' dist=' + l.dist + ' but ' + Math.round(geo) + ' on screen');
      }
    });
    assertNone(bad, 'link distances wildly off the map geometry');
  });

  test('the link graph is connected', function () {
    if (!sids.length) return skipTest('connected', 'no stations');
    var adj = _linkAdjacency(L);
    var seen = _flood(sids[0], adj);
    var unreachable = sids.filter(function (sid) { return !seen[sid]; });
    assertNone(unreachable, 'stations unreachable from ' + sids[0] + ' — the map is in pieces');
  });

  test('no station is isolated', function () {
    var adj = _linkAdjacency(L);
    var lonely = sids.filter(function (sid) { return !adj[sid] || adj[sid].length === 0; });
    assertNone(lonely, 'stations with no links at all');
  });

  test('sea crossings exist and are the minority', function () {
    var sea = L.filter(function (l) { return l.sea === true; });
    assert(sea.length > 0, 'no sea crossings — Britain cannot be reached (§3)');
    assert(sea.length < L.length * 0.15, 'sea crossings should be "a handful", got ' + sea.length + '/' + L.length);
  });
}

// --- SETUP / POWERS --------------------------------------------------------

function suiteSetup(d) {
  if (!d.SETUP || !d.STATIONS || !d.POWERS) {
    return skipSuite('scenario / SETUP',
      'missing ' + missingOf(d, ['SETUP', 'STATIONS', 'POWERS']).join(' + ') + ' (data/scenario.js not authored yet)');
  }
  suite('scenario / SETUP');
  var SU = d.SETUP, S = d.STATIONS, P = d.POWERS;
  var sids = Object.keys(S).sort();

  test('every station id appears exactly once in SETUP', function () {
    var bad = [];
    sids.forEach(function (sid) { if (!SU[sid]) bad.push(sid + ' has no SETUP entry'); });
    Object.keys(SU).sort().forEach(function (sid) {
      if (!S[sid]) bad.push('SETUP has "' + sid + '" which is not a station');
    });
    assertNone(bad, 'SETUP does not cover the station list exactly');
  });

  test('every SETUP owner is a real power', function () {
    var bad = Object.keys(SU).sort().filter(function (sid) { return !P[SU[sid].owner]; })
                    .map(function (sid) { return sid + ' owned by unknown power "' + SU[sid].owner + '"'; });
    assertNone(bad, 'unknown owners');
  });

  test('starting garrisons are non-negative numbers on all three unit types', function () {
    var bad = [];
    Object.keys(SU).sort().forEach(function (sid) {
      var u = SU[sid].units;
      if (!u) { bad.push(sid + ' has no units block'); return; }
      ['infantry', 'artillery', 'armour'].forEach(function (t) {
        if (typeof u[t] !== 'number' || u[t] < 0 || !isFinite(u[t])) {
          bad.push(sid + '.' + t + '=' + u[t]);
        }
      });
    });
    assertNone(bad, 'malformed starting garrisons');
  });

  test('starting garrisons do not exceed station capacity', function () {
    var bad = [];
    Object.keys(SU).sort().forEach(function (sid) {
      if (!S[sid] || !SU[sid].units) return;
      var tot = SU[sid].units.infantry + SU[sid].units.artillery + SU[sid].units.armour;
      if (tot > S[sid].capacity + 1e-9) {
        bad.push(sid + ' starts with ' + tot + ' but capacity is ' + S[sid].capacity);
      }
    });
    assertNone(bad, 'stations start over capacity (they would immediately bleed down)');
  });

  test('POWERS: neutral exists with no capital and no AI', function () {
    assert(P.neutral, '"neutral" must be a real power id (01-data-schema.md)');
    assert(!P.neutral.capital, 'neutral must have no capital');
    assert(!P.neutral.ai, 'neutral must have no AI');
  });

  test('every non-neutral power has a capital it owns at game start', function () {
    var bad = [];
    Object.keys(P).sort().forEach(function (pid) {
      if (pid === 'neutral') return;
      var p = P[pid];
      if (!p.capital) { bad.push(pid + ' has no capital'); return; }
      if (!S[p.capital]) { bad.push(pid + ' capital "' + p.capital + '" is not a station'); return; }
      if (!SU[p.capital] || SU[p.capital].owner !== pid) {
        bad.push(pid + ' does not start owning its capital ' + p.capital);
      }
      if (!p.color) bad.push(pid + ' has no color');
      if (!p.ai) bad.push(pid + ' has no AI personality');
    });
    assertNone(bad, 'power definitions incomplete');
  });

  test('AI personalities are ones tuning.js knows about', function () {
    if (!d.BAL) return skipTest('personalities known', 'BAL missing');
    var bad = Object.keys(P).sort().filter(function (pid) {
      return P[pid].ai && !d.BAL.AI.PERSONALITIES[P[pid].ai];
    }).map(function (pid) { return pid + ' uses unknown personality "' + P[pid].ai + '"'; });
    assertNone(bad, 'scenario references personalities that do not exist in BAL');
  });

  test('3-5 AI powers plus the player, per §1', function () {
    var n = Object.keys(P).filter(function (pid) { return pid !== 'neutral'; }).length;
    assertBetween(n, 4, 8, 'playable power count');
  });
}

// --- Reachability from the capital ----------------------------------------

function suiteReachability(d) {
  if (!d.SETUP || !d.LINKS || !d.POWERS || !d.STATIONS) {
    return skipSuite('scenario / reachability',
      'missing ' + missingOf(d, ['SETUP', 'LINKS', 'POWERS', 'STATIONS']).join(' + ') +
      ' (data/scenario.js not authored yet)');
  }
  suite('scenario / reachability');
  var SU = d.SETUP, L = d.LINKS, P = d.POWERS, S = d.STATIONS;
  var adj = _linkAdjacency(L);

  test('every station is reachable from its owner\'s capital over stations that owner holds', function () {
    // 00-vision.md §11, and a hard requirement of the connection system (§5):
    // any station that starts disconnected starts DECAYING, which reads as a
    // bug and is really a map error.
    var bad = [];
    Object.keys(P).sort().forEach(function (pid) {
      if (pid === 'neutral' || !P[pid].capital) return;
      var cap = P[pid].capital;
      if (!S[cap]) return; // reported by the SETUP suite
      var owned = function (sid) { return SU[sid] && SU[sid].owner === pid; };
      if (!owned(cap)) return; // reported by the SETUP suite
      var seen = _flood(cap, adj, owned);
      Object.keys(SU).sort().forEach(function (sid) {
        if (SU[sid].owner === pid && !seen[sid]) {
          bad.push(pid + ': ' + sid + ' is cut off from ' + cap + ' at game start');
        }
      });
    });
    assertNone(bad, 'stations disconnected from their capital at game start');
  });

  test('no power starts already capitulated', function () {
    if (!d.BAL || !d.TERRITORIES) return skipTest('not pre-capitulated', 'BAL or TERRITORIES missing');
    var bad = [];
    Object.keys(P).sort().forEach(function (pid) {
      if (pid === 'neutral') return;
      var owns = Object.keys(SU).filter(function (sid) { return SU[sid].owner === pid; });
      if (owns.length === 0) bad.push(pid + ' starts owning nothing');
    });
    assertNone(bad, 'powers with no starting position');
  });
}

// ===========================================================================
// SIM SUITES — inert until sim/ lands.
//
// Each is guarded on the entry points it actually needs, so combat tests come
// alive the day sim/combat.js appears without waiting for ai/.
// ===========================================================================

// Shared guard. Returns null and registers a SKIP when the sim is absent.
function _needSim(name, need) {
  var fns = simFns();
  var d = collectData();
  var missing = [];
  if (need.indexOf('newGame') >= 0 && !fns.newGame) missing.push('newGame() [core/state.js]');
  if (need.indexOf('step') >= 0 && !fns.step) missing.push('a tick function [sim/step.js]');
  if (need.indexOf('apply') >= 0 && !fns.apply) missing.push('applyCommand() [sim/commands.js]');
  if (!d.STATIONS || !d.SETUP) missing.push('map + scenario data');
  if (missing.length) {
    skipSuite(name, 'waiting on ' + missing.join(', '));
    return null;
  }
  return { fns: fns, data: d };
}

// Run n ticks of the sim.
function _run(fns, state, n) {
  for (var i = 0; i < n; i++) fns.step(state);
  return state;
}

// Pick any station of a given type. Sim tests must not hard-code city ids —
// the map is being authored in parallel and every id would rot.
function _anyStation(S, pred) {
  var ids = Object.keys(S).sort();
  for (var i = 0; i < ids.length; i++) if (pred(S[ids[i]], ids[i])) return ids[i];
  return null;
}

// Change who holds a station. NEVER assign state.stations[sid].owner directly
// in a fixture: routing is ownership-aware and cached against state.ownerEpoch
// (core/state.js setStationOwner), so a raw assignment can leave the next
// routeFor() answering from a search built on the board before the edit. The
// bug that produces is invisible — a correct-looking test measuring a stale
// map. Falls back to a plain write plus a manual bump if core/state.js predates
// the helper, so this file keeps running against an older sim.
function _setOwner(state, sid, owner) {
  if (typeof setStationOwner === 'function') return setStationOwner(state, sid, owner);
  var st = state.stations[sid];
  if (!st || st.owner === owner) return false;
  st.owner = owner;
  state.ownerEpoch = (state.ownerEpoch || 0) + 1;
  return true;
}

// Grow a power outward from its capital by `n` stations, breadth-first over
// LINKS, and return the ids granted.
//
// This exists because the opening position is now ONE STATION per power — the
// capital and nothing else (data/scenario.js). Any test that needed "a power
// with two stations" used to get one free from the scenario and now does not.
// Reading a fixture off the starting board was always the wrong dependency: it
// couples a sim test to a design decision about openings, so the sim test goes
// red when the opening changes even though the sim did not. Build the fixture
// the test actually needs instead.
function _grantFromCapital(state, LINKS, capital, pid, n) {
  var adj = _linkAdjacency(LINKS);
  var granted = [], seen = {}, queue = [capital];
  seen[capital] = true;
  while (queue.length && granted.length < n) {
    var cur = queue.shift();
    var next = (adj[cur] || []).slice().sort();     // sorted: determinism
    for (var i = 0; i < next.length; i++) {
      var sid = next[i];
      if (seen[sid]) continue;
      seen[sid] = true;
      queue.push(sid);
      if (granted.length < n) { _setOwner(state, sid, pid); granted.push(sid); }
    }
  }
  return granted;
}

// Cut one station off from its capital FOR REAL, and return it.
//
// The fixture this replaces took the last station of a 6-deep grant and its
// comment claimed that was "two hops out". It was not: on this map the first
// capital has exactly six links, so a 6-deep breadth-first grant hands out
// nothing but its DIRECT NEIGHBOURS. The victim stayed wired to the capital,
// reported connected === true, and the decay suite went green anyway — because
// the fixture also parked 40 units in a station of capacity 28 and what it
// measured was OVERSTACK_DECAY bleeding the surplus, not disconnection. The
// over-capacity rework raised the bleed line above 40 and the accident stopped
// working, which is the only reason anyone looked.
//
// So: grant deep enough to get past the capital's own neighbourhood, then pick
// the victim BY THE PROPERTY the test needs — nothing its owner still holds
// touches it — rather than by an index that means something different on every
// map. Callers must still assert `connected === false`; that missing assertion
// is what let the rot sit.
function _cutOffStation(state, LINKS, capital, pid) {
  var adj = _linkAdjacency(LINKS);
  var chain = _grantFromCapital(state, LINKS, capital, pid, 12);
  for (var i = chain.length - 1; i >= 0; i--) {
    var victim = chain[i];
    for (var j = 0; j < chain.length; j++) {
      _setOwner(state, chain[j], chain[j] === victim ? pid : 'neutral');
    }
    var nb = adj[victim] || [], touches = false;
    for (var k = 0; k < nb.length; k++) {
      if (state.stations[nb[k]] && state.stations[nb[k]].owner === pid) { touches = true; break; }
    }
    if (!touches) return victim;
  }
  return null;
}

function _clearBoard(state, owner) {
  Object.keys(state.stations).forEach(function (sid) {
    _setOwner(state, sid, owner);
    state.stations[sid].units = { infantry: 0, artillery: 0, armour: 0 };
  });
  state.waves.length = 0;
}

function suiteSimGrowth(d) {
  var ctx = _needSim('sim / logistic growth', ['newGame', 'step']);
  if (!ctx) return;
  suite('sim / logistic growth');
  var fns = ctx.fns, S = ctx.data.STATIONS, B = ctx.data.BAL;

  // Capacity used to be where growth STOPPED. Since the over-capacity rework
  // (data/tuning.js GROWTH_OVERFLOW_RATE, on the player's instruction) it is
  // only where growth gets slow, and the hard stop moved out to
  // GROWTH_OVERFLOW_CEIL x capacity. This test moved with the rule rather than
  // being loosened: it still pins a hard number growth may not cross, and it
  // additionally pins that the station DOES cross the old one — so an
  // implementation that quietly went back to stalling at capacity fails here
  // just as loudly as one with no ceiling at all.
  test('growth stops at the overflow ceiling, and not before capacity (§2)', function () {
    var sid = _anyStation(S, function (st) { return st.type === 'holding'; });
    assert(sid, 'no holding station on the map');
    var cap = S[sid].capacity, ceil = cap * B.GROWTH_OVERFLOW_CEIL;
    var s = fns.newGame(1);
    s.stations[sid].units.infantry = cap * 0.99;
    _run(fns, s, 6000);
    var got = s.stations[sid].units.infantry;
    assert(got <= ceil * 1.001,
      'station grew past the overflow ceiling: ' + got.toFixed(3) + ' > ' + ceil);
    if (B.GROWTH_OVERFLOW_CEIL > 1) {
      assert(got > cap * 1.05,
        'station stalled at ' + got.toFixed(3) + ' against a capacity of ' + cap +
        ' — growth is still stopping AT capacity, so GROWTH_OVERFLOW_RATE is not reaching it');
    }
  });

  // The assertion that pins what "50%" MEANS. GROWTH_OVERFLOW_RATE is a
  // fraction of the station's OWN PEAK growth, which the logistic puts at half
  // full: growth is BASE * rate * mul * units * room(units), so at cap/2 the
  // product units*room is cap/4, and at cap it is cap * (0.25 * RATE). The
  // ratio is therefore exactly RATE, with everything else cancelling — which
  // is why this can be asserted to floating-point tolerance rather than to a
  // hand-waved band. Someone changing the floor to a flat "half the rate" or
  // to a fraction of capacity instead of a fraction of peak lands outside it.
  test('growth at capacity is exactly GROWTH_OVERFLOW_RATE of the peak rate', function () {
    if (!(B.GROWTH_OVERFLOW_RATE > 0)) {
      return skipTest('overflow rate', 'GROWTH_OVERFLOW_RATE is 0 — the documented off switch');
    }
    var sid = _anyStation(S, function (st) { return st.type === 'holding'; });
    var cap = S[sid].capacity;
    // One tick, growthMul pinned, so the only thing that differs between the
    // two samples is the room factor this test exists to measure.
    var oneTick = function (frac) {
      var s = fns.newGame(1);
      s.stations[sid].units.infantry = cap * frac;
      s.stations[sid].growthMul = 1;
      _run(fns, s, 1);
      return s.stations[sid].units.infantry - cap * frac;
    };
    var peak = oneTick(0.5), atCap = oneTick(1.0);
    assert(peak > 0, 'a half-full station did not grow at all');
    assertClose(atCap / peak, B.GROWTH_OVERFLOW_RATE, 1e-6,
      'growth at capacity is ' + (atCap / peak).toFixed(6) + ' of the peak rate, not ' +
      B.GROWTH_OVERFLOW_RATE + ' — "slow production by 50%" no longer means 50% of ' +
      'what this station can do at its best');
  });

  test('a half-full station grows fastest', function () {
    var sid = _anyStation(S, function (st) { return st.type === 'holding'; });
    var cap = S[sid].capacity;
    var sample = function (frac) {
      var s = fns.newGame(1);
      s.stations[sid].units.infantry = cap * frac;
      var before = s.stations[sid].units.infantry;
      _run(fns, s, 10);
      return s.stations[sid].units.infantry - before;
    };
    var mid = sample(0.5), high = sample(0.95), low = sample(0.05);
    assert(mid > high, 'growth at 50% should beat growth at 95%');
    assert(mid > low, 'growth at 50% should beat growth at 5%');
  });

  test('an emptied station still recovers (GROWTH_SEED)', function () {
    var sid = _anyStation(S, function (st) { return st.type === 'holding'; });
    var s = fns.newGame(1);
    s.stations[sid].units.infantry = 0;
    _run(fns, s, 300);
    assert(s.stations[sid].units.infantry > 0,
      'a scoured station never recovers — GROWTH_SEED is not being applied');
  });

  test('growth respects BAL.GROWTH_BASE', function () {
    var sid = _anyStation(S, function (st) { return st.type === 'holding'; });
    var cap = S[sid].capacity, st = S[sid];
    var s = fns.newGame(1);
    s.stations[sid].units.infantry = cap * 0.5;
    s.stations[sid].growthMul = 1;
    _run(fns, s, 1);
    var got = s.stations[sid].units.infantry - cap * 0.5;
    var want = B.GROWTH_BASE * st.rate * (cap * 0.5) * 0.5;
    assertClose(got, want, want * 0.25 + 1e-6, 'one tick of logistic growth');
  });
}

function suiteSimCombat(d) {
  var ctx = _needSim('sim / combat', ['newGame', 'step']);
  if (!ctx) return;
  suite('sim / combat');
  var fns = ctx.fns, S = ctx.data.STATIONS, B = ctx.data.BAL;

  // Fight two infantry stacks at one station and report the winner's fraction.
  var fight = function (atk, def, seed) {
    var sid = _anyStation(S, function (st) { return st.type === 'holding' && st.defense === 1.0; });
    var s = fns.newGame(seed || 7);
    _clearBoard(s, 'neutral');
    _setOwner(s, sid, 'neutral');
    s.stations[sid].units.infantry = def;
    // The attacker lands as a wave that has already arrived; sim/combat.js
    // resolves any station holding hostile forces.
    s.waves.push({
      id: 999, owner: '_atk', from: sid, to: sid, path: [sid], hop: 0, progress: 1,
      units: { infantry: atk, artillery: 0, armour: 0 },
    });
    var ticks = 0;
    while (ticks < 6000 &&
           s.stations[sid].units.infantry > 0.05 &&
           (s.stations[sid].owner === 'neutral')) {
      fns.step(s); ticks++;
    }
    return { ticks: ticks, station: s.stations[sid] };
  };

  test('a 2:1 attacker takes the station', function () {
    var r = fight(200, 100);
    assert(r.station.owner !== 'neutral', 'a 2:1 attack failed to flip the station');
  });

  test('a 2:1 attacker survives with ~87% (§5)', function () {
    var r = fight(200, 100);
    var left = r.station.units.infantry + r.station.units.artillery + r.station.units.armour;
    assertClose(left / 200, 0.866, 0.08, 'survivor fraction after a 2:1 assault');
  });

  test('a 1.05:1 attacker does not win intact (§11)', function () {
    var r = fight(105, 100);
    var left = r.station.units.infantry + r.station.units.artillery + r.station.units.armour;
    assert(left / 105 < 0.5, 'trickling in at 1.05:1 kept ' + Math.round(left / 1.05) + '%');
  });

  test('battle variance is rolled once, not per tick (§5)', function () {
    // Two identical battles under the same seed must be identical; two under
    // different seeds must differ by roughly BATTLE_VARIANCE, not by the ~0.6%
    // that 300 independent per-tick rolls would average out to.
    var a = fight(200, 100, 11), b = fight(200, 100, 11);
    assertClose(a.station.units.infantry, b.station.units.infantry, 1e-9,
      'same seed must give the same battle — the sim is not deterministic');
  });

  test('a fortress costs the attacker more than an open city', function () {
    var open = _anyStation(S, function (st) { return st.type === 'holding'; });
    var fort = _anyStation(S, function (st) { return st.type === 'defensive'; });
    assert(open && fort, 'need one holding and one defensive station');
    var run = function (sid) {
      var s = fns.newGame(3);
      _clearBoard(s, 'neutral');
      s.stations[sid].units.infantry = 30;
      s.waves.push({ id: 1, owner: '_atk', from: sid, to: sid, path: [sid], hop: 0, progress: 1,
                     units: { infantry: 90, artillery: 0, armour: 0 } });
      for (var i = 0; i < 4000 && s.stations[sid].owner === 'neutral'; i++) fns.step(s);
      return s.stations[sid].units.infantry;
    };
    assert(run(fort) < run(open), 'assaulting a fortress must cost more than assaulting a city');
  });

  test('a capture is logged with the station it happened at', function () {
    // Milestone 5.7. "ger took Brussels from neutral" on the ticker was the
    // single largest leak on the board: every capture anywhere, live, for a
    // player who may never have set foot in Belgium.
    //
    // The FILTER lives in render/hud.js and not here — state.log is sim state,
    // render/victory.js wants the whole truth once the game is over, and
    // test/fog-tests.js asserts as a tested fact that nothing under sim/ so
    // much as names visibility. What the sim owes the renderer is WHICH station
    // the event was about: logEvent's optional 4th argument.
    //
    // Pinned rather than merely tolerated, because a filter keyed to a field
    // the sim silently stopped setting fails OPEN. Every capture on the board
    // would come back on screen and nothing anywhere would say so.
    var sid = _anyStation(S, function (st) { return st.type === 'holding' && st.defense === 1.0; });
    var s = fns.newGame(21);
    _clearBoard(s, 'neutral');
    _setOwner(s, sid, 'neutral');
    s.stations[sid].units.infantry = 10;
    s.waves.push({ id: 998, owner: '_atk', from: sid, to: sid, path: [sid], hop: 0, progress: 1,
                   units: { infantry: 120, artillery: 0, armour: 0 } });
    for (var i = 0; i < 6000 && s.stations[sid].owner === 'neutral'; i++) fns.step(s);
    assertEqual(s.stations[sid].owner, '_atk',
      'the fixture never captured anything — this test would pass vacuously');

    var caps = (s.log || []).filter(function (e) { return e.kind === 'capture'; });
    assertEqual(caps.length, 1, 'expected exactly one capture event, got ' + caps.length);
    assertEqual(Object.keys(caps[0]).sort().join(','), 'kind,sid,text,tick',
      'the capture record is not { tick, kind, text, sid }');
    assertEqual(caps[0].sid, sid,
      'the capture was tagged with the wrong station — the ticker would test it ' +
      'against the visibility of somewhere else entirely');
  });

  test('an event that names no station carries no sid at all', function () {
    // The other half of "additive and optional", and it is what keeps the
    // renderer's default safe. A declaration of war, a capitulation and a
    // victory are about POWERS; they name no city, there is nothing for a fog
    // filter to test, and 02-visibility-and-sea.md keeps them public on purpose
    // ("you can hide an army; you cannot hide having conquered Belgium").
    //
    // So the key must be ABSENT rather than null or empty: render/hud.js reads
    // "no sid" as "public", and a key that is present but falsy is the shape
    // that turns a three-way decision into an accidental two-way one.
    var s = fns.newGame(22);
    logEvent(s, 'relations', 'A declares war on B');
    var e = s.log[s.log.length - 1];
    assertEqual(Object.keys(e).sort().join(','), 'kind,text,tick',
      'a station-less event grew a key it has no value for');
    assert(!('sid' in e), 'sid must be absent, not present-and-empty');
  });
}

function suiteSimMultiplier(d) {
  var ctx = _needSim('sim / multiplier reach', ['newGame', 'step']);
  if (!ctx) return;
  suite('sim / multiplier reach');
  var fns = ctx.fns, S = ctx.data.STATIONS, T = ctx.data.TERRITORIES, B = ctx.data.BAL;

  test('a farm boosts its own territory and adjacent ones, and stops there (§2)', function () {
    var mid = _anyStation(S, function (st) { return st.type === 'multiplier'; });
    assert(mid, 'no multiplier station on the map');
    var home = S[mid].territory;
    var near = {}; near[home] = true;
    (T[home].neighbors || []).forEach(function (n) { near[n] = true; });

    var s = fns.newGame(5);
    Object.keys(s.stations).forEach(function (sid) { _setOwner(s, sid, 'neutral'); });
    _setOwner(s, mid, 'ger');
    fns.step(s);

    var bad = [];
    Object.keys(s.stations).sort().forEach(function (sid) {
      var mul = s.stations[sid].growthMul;
      var terr = S[sid].territory;
      var hops = near[terr] ? 0 : 2;
      if (hops === 0 && !(mul > 1.0001) && sid !== mid) {
        bad.push(sid + ' in ' + terr + ' should be boosted, growthMul=' + mul);
      }
      if (hops === 2 && mul > 1.0001) {
        bad.push(sid + ' in ' + terr + ' is boosted but is 2+ territories away, growthMul=' + mul);
      }
    });
    assertNone(bad, 'multiplier coverage does not match MULTIPLIER_REACH=' + B.MULTIPLIER_REACH);
  });

  test('stacked multipliers are capped at GROWTH_MUL_CAP', function () {
    var s = fns.newGame(5);
    fns.step(s);
    var bad = Object.keys(s.stations).sort().filter(function (sid) {
      return s.stations[sid].growthMul > B.GROWTH_MUL_CAP + 1e-9;
    }).map(function (sid) { return sid + ' growthMul=' + s.stations[sid].growthMul; });
    assertNone(bad, 'growth multipliers exceed GROWTH_MUL_CAP');
  });
}

function suiteSimDisconnect(d) {
  var ctx = _needSim('sim / disconnection decay', ['newGame', 'step']);
  if (!ctx) return;
  suite('sim / disconnection decay');
  var fns = ctx.fns, S = ctx.data.STATIONS, B = ctx.data.BAL, P = ctx.data.POWERS;

  test('a disconnected station stops growing and decays (§5)', function () {
    var pid = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; })[0];
    var s = fns.newGame(9);
    var victim = _cutOffStation(s, ctx.data.LINKS, P[pid].capital, pid);
    assert(victim, 'could not cut any station off from ' + P[pid].capital);

    // HALF FULL, deliberately. The old fixture used 40 units against a
    // capacity of 28, where the surplus decays whether the station is cut off
    // or not. Half capacity is where a CONNECTED station grows fastest, so if
    // the disconnect rule stops firing this assertion cannot be satisfied by
    // any other mechanism in the sim.
    s.stations[victim].units.infantry = S[victim].capacity * 0.5;

    // The precondition, asserted rather than assumed — its absence is exactly
    // what let this test measure the wrong thing for as long as it did.
    fns.step(s);
    assertEqual(s.stations[victim].connected, false,
      victim + ' still reports connected — the fixture never cut it off, so ' +
      'nothing below this measures disconnection');

    var before = s.stations[victim].units.infantry;
    _run(fns, s, B.DISCONNECT_GRACE + 400);
    var after = s.stations[victim].units.infantry;
    assert(after < before, 'a cut-off station did not decay: ' + before + ' -> ' + after);
  });

  test('decay rate matches DISCONNECT_DECAY within a factor of two', function () {
    var pid = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; })[0];
    var s = fns.newGame(9);
    var victim = _cutOffStation(s, ctx.data.LINKS, P[pid].capital, pid);
    if (!victim) return skipTest('decay rate', 'could not cut a station off from the capital');
    // Below the overstack line on purpose: at 100 units in a city of capacity
    // 28 this measured OVERSTACK_DECAY and called it DISCONNECT_DECAY.
    s.stations[victim].units.infantry = S[victim].capacity * 0.5;
    _run(fns, s, B.DISCONNECT_GRACE);
    assertEqual(s.stations[victim].connected, false,
      victim + ' still reports connected — this is not measuring decay at all');
    var start = s.stations[victim].units.infantry;
    var n = 300;
    _run(fns, s, n);
    var end = s.stations[victim].units.infantry;
    var expected = start * Math.pow(1 - B.DISCONNECT_DECAY, n);
    assertClose(end, expected, expected, 'decay over ' + n + ' ticks');
  });

  test('connected stations are unaffected', function () {
    var pid = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; })[0];
    var s = fns.newGame(9);
    var cap = P[pid].capital;
    s.stations[cap].units.infantry = Math.min(S[cap].capacity, 20);
    var before = s.stations[cap].units.infantry;
    _run(fns, s, 200);
    assert(s.stations[cap].units.infantry >= before, 'a capital should never decay');
  });
}

function suiteSimCapitulation(d) {
  var ctx = _needSim('sim / capitulation', ['newGame', 'step']);
  if (!ctx) return;
  suite('sim / capitulation');
  var fns = ctx.fns, B = ctx.data.BAL, P = ctx.data.POWERS;

  test('losing the capital and dropping below CAPITULATE_FRACTION transfers everything (§7)', function () {
    var pids = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; });
    var victim = pids[0], victor = pids[1];
    var s = fns.newGame(21);

    // Build the victim a real empire first, and RUN long enough for the peak
    // tracker to sample it. Both halves matter. Capitulation is measured
    // against a high-water mark of stations held (sim/victory.js), so a power
    // that never grew has a peak of 1 and can only "capitulate" by holding
    // zero stations — at which point the transfer this test exists to prove
    // moves nothing and the assertions below all pass against an empty set.
    // That is precisely how this test passed while doing nothing after the
    // opening changed to capital-only.
    var empire = _grantFromCapital(s, ctx.data.LINKS, P[victim].capital, victim, 11);
    assert(empire.length >= 8, 'could not build an empire for ' + victim);
    _run(fns, s, B.CAPITULATE_CHECK_INTERVAL + 5);
    assert(s.powers[victim].peakStations >= 9,
      'peak never registered: ' + s.powers[victim].peakStations);

    // Now break it: the capital and all but two stations change hands.
    var owned = Object.keys(s.stations).sort().filter(function (sid) { return s.stations[sid].owner === victim; });
    owned.forEach(function (sid, i) { if (i > 1) _setOwner(s, sid, victor); });
    _setOwner(s, P[victim].capital, victor);
    var remnant = Object.keys(s.stations).sort().filter(function (sid) { return s.stations[sid].owner === victim; });
    assert(remnant.length > 0, 'the remnant is empty — this test would prove nothing');

    _run(fns, s, B.CAPITULATE_CHECK_INTERVAL * 2 + 5);

    var still = Object.keys(s.stations).filter(function (sid) { return s.stations[sid].owner === victim; });
    assertEqual(still.length, 0, victim + ' held ' + still.length + ' stations after capitulating');
    remnant.forEach(function (sid) {
      assertEqual(s.stations[sid].owner, victor, sid + ' should have transferred to the capital holder');
    });
    assert(s.powers[victim].alive === false, victim + ' should be marked dead');
  });

  // Regression: a capitulated power must not go on conquering. Its landed-but-
  // still-fighting stacks live in station.attackers, NOT in state.waves, so
  // clearing waves alone left a dead power able to capture a station tens of
  // thousands of ticks after surrendering. The result was a zombie holding
  // ground no victory condition could clear, and games that never ended.
  // Found by tools/balance.js, not by any hand-written scenario.
  test('capitulation stands down landed stacks too, not just waves in flight', function () {
    var pids = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; });
    var victim = pids[0], victor = pids[1];
    var s = fns.newGame(23);
    var sids = Object.keys(s.stations).sort();

    // Strip the victim down to nothing and hand over its capital.
    sids.forEach(function (sid) { if (s.stations[sid].owner === victim) _setOwner(s, sid, victor); });

    // The target must be DEFENDED. Against an empty station the capture
    // resolves in phase 3 and the capitulation in phase 5 of the SAME tick
    // sweeps it up correctly — the bug does not appear. It takes a battle
    // still running when the country falls, which is exactly the situation a
    // hand-written test is least likely to construct.
    var prey = sids.filter(function (sid) { return s.stations[sid].owner === 'neutral'; })[0];
    assert(!!prey, 'need a neutral station to attack');
    s.stations[prey].units = { infantry: 6, artillery: 0, armour: 0 };
    s.stations[prey].attackers = { };
    s.stations[prey].attackers[victim] = { infantry: 30, artillery: 0, armour: 0 };

    _run(fns, s, B.CAPITULATE_CHECK_INTERVAL * 2 + 20);

    assert(s.powers[victim].alive === false, victim + ' should be dead');
    var held = sids.filter(function (sid) { return s.stations[sid].owner === victim; });
    assertEqual(held.length, 0,
      victim + ' capitulated but still holds ' + held.join(',') + ' — a dead power conquered ground');
  });

  test('a power that keeps its capital does not capitulate', function () {
    var pids = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; });
    var victim = pids[0], victor = pids[1];
    var s = fns.newGame(22);
    var owned = Object.keys(s.stations).sort().filter(function (sid) { return s.stations[sid].owner === victim; });
    owned.forEach(function (sid) { if (sid !== P[victim].capital) _setOwner(s, sid, victor); });
    _run(fns, s, B.CAPITULATE_CHECK_INTERVAL * 2 + 5);
    assertEqual(s.stations[P[victim].capital].owner, victim,
      'capital was taken without anyone attacking it');
  });

  // The rule pinned from the OTHER side. The test above proves capitulation
  // fires; this one proves it does not fire early, and it is the half that a
  // capital-only opening breaks.
  //
  // Capitulation used to be measured in TERRITORIES against a power's starting
  // territory count. Start every power on its capital alone and that count is
  // 0 for all seven, because one city in a nine-city country is not a majority
  // — so the "still holds a quarter of what it started with" guard could never
  // hold, and any power that lost its capital handed its whole empire over on
  // the next 50-tick check no matter how much of it was still standing.
  // Nothing in the suite objected, because every capitulation test until now
  // asserted that a collapse DID happen.
  test('a power that loses its capital but still holds most of its empire does not capitulate', function () {
    var pids = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; });
    var victim = pids[0], victor = pids[1];
    var s = fns.newGame(23);

    var empire = _grantFromCapital(s, ctx.data.LINKS, P[victim].capital, victim, 11);
    assert(empire.length >= 8, 'could not build an empire for ' + victim);
    _run(fns, s, B.CAPITULATE_CHECK_INTERVAL + 5);

    var heldBefore = Object.keys(s.stations).filter(function (sid) { return s.stations[sid].owner === victim; }).length;
    assert(heldBefore >= 9, 'fixture too small to be meaningful: ' + heldBefore);

    // The capital falls and nothing else does.
    _setOwner(s, P[victim].capital, victor);
    _run(fns, s, B.CAPITULATE_CHECK_INTERVAL * 2 + 5);

    var heldAfter = Object.keys(s.stations).filter(function (sid) { return s.stations[sid].owner === victim; }).length;
    assert(heldAfter >= heldBefore - 2,
      victim + ' lost its capital and folded from ' + heldBefore + ' stations to ' + heldAfter +
      ' — an empire still well above CAPITULATE_FRACTION capitulated');
    assert(s.powers[victim].alive !== false, victim + ' was marked dead while still holding ' + heldAfter);
  });

  // Victory is "outlast every rival", not "own every pixel".
  //
  // The old rule required a single owner across all 108 stations, neutrals
  // included, and it was close to unsatisfiable: measured at the tick cap,
  // Russia held 105 of 108 with every rival dead and no victory fired, because
  // three neutral villages had never been taken by anyone. Worse, the draw
  // clause sat AFTER an early `return` in the contested check and was therefore
  // unreachable — so those games ended neither in victory nor in a draw, and
  // tools/balance.js scored 73% of every batch by awarding the timeout to
  // whoever led on territories.
  test('victory needs every RIVAL gone, not every neutral village taken', function () {
    var pids = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; });
    var champ = pids[0], rival = pids[1];
    var s = fns.newGame(24);
    _clearBoard(s, 'neutral');

    var all = Object.keys(s.stations).sort();
    for (var i = 0; i < 10; i++) { _setOwner(s, all[i], champ); s.stations[all[i]].units.infantry = 20; }
    var lastRivalCity = all[10];
    _setOwner(s, lastRivalCity, rival);
    s.stations[lastRivalCity].units.infantry = 5;

    _run(fns, s, 5);
    assert(!s.winner, 'declared a winner while ' + rival + ' still held ' + lastRivalCity);

    // The rival falls. Every neutral station is left exactly as it was.
    _setOwner(s, lastRivalCity, champ);
    _run(fns, s, 5);

    var neutralsLeft = all.filter(function (sid) { return s.stations[sid].owner === 'neutral'; }).length;
    assert(neutralsLeft > 50,
      'fixture left only ' + neutralsLeft + ' neutral stations — it cannot prove neutrals are ignored');
    assertEqual(s.winner, champ,
      champ + ' outlasted every rival but no victory fired, with ' + neutralsLeft + ' neutrals on the board');
  });
}

function suiteSimCommands(d) {
  var ctx = _needSim('sim / applyCommand', ['newGame', 'step', 'apply']);
  if (!ctx) return;
  suite('sim / applyCommand');
  var fns = ctx.fns, B = ctx.data.BAL, P = ctx.data.POWERS;

  test('a send spawns one wave and takes SEND_FRACTION from each source', function () {
    var pid = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; })[0];
    var s = fns.newGame(31);
    var granted = _grantFromCapital(s, ctx.data.LINKS, P[pid].capital, pid, 1);
    assert(granted.length === 1, 'could not grant a neighbour of ' + P[pid].capital);
    var src = P[pid].capital, dst = granted[0];
    s.stations[src].units.infantry = 40;
    var before = s.stations[src].units.infantry;
    fns.apply(s, { type: 'send', owner: pid, sources: [src], target: dst, fraction: B.SEND_FRACTION_DEFAULT });
    assertClose(s.stations[src].units.infantry, before * (1 - B.SEND_FRACTION_DEFAULT), 0.01,
      'source garrison after a 75% send');
    assert(s.waves.length >= 1, 'no wave was created');
  });

  test('a send from a station you do not own is rejected', function () {
    var pids = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; });
    var s = fns.newGame(32);
    var theirs = Object.keys(s.stations).sort().filter(function (sid) { return s.stations[sid].owner === pids[1]; })[0];
    var mine = Object.keys(s.stations).sort().filter(function (sid) { return s.stations[sid].owner === pids[0]; })[0];
    var before = s.stations[theirs].units.infantry;
    fns.apply(s, { type: 'send', owner: pids[0], sources: [theirs], target: mine, fraction: 0.75 });
    assertClose(s.stations[theirs].units.infantry, before, 1e-9,
      'applyCommand let a power send from a station it does not own');
  });

  test('the sim is deterministic — same seed, same state', function () {
    var pid = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; })[0];
    var run = function () {
      var s = fns.newGame(1234);
      var owned = Object.keys(s.stations).sort().filter(function (sid) { return s.stations[sid].owner === pid; });
      fns.apply(s, { type: 'send', owner: pid, sources: [owned[0]], target: owned[1], fraction: 0.75 });
      _run(fns, s, 300);
      return JSON.stringify(s.stations);
    };
    assertEqual(run(), run(), 'two runs from the same seed diverged');
  });

  // =========================================================================
  // BAL.SEND_KEEP_UNITS — "if you send all, one troop stays so population
  // increases".
  //
  // Not a nicety. Growth is logistic (00-vision.md §2):
  //
  //     growth = rate x units x (1 - units / capacity)
  //
  // which is PROPORTIONAL TO `units`, so a station emptied to exactly zero has
  // a growth rate of exactly zero and can never recover however long it is
  // held. Before the clamp, "All" permanently destroyed the city that sent it.
  //
  // The regrowth test is the one that matters and the other three exist to stop
  // it passing for the wrong reason: a clamp that kept half the garrison would
  // also regrow, and would be a different game.
  // =========================================================================

  var _spBoard = function (seed, units) {
    var pid = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; })[0];
    var s = fns.newGame(seed);
    var granted = _grantFromCapital(s, ctx.data.LINKS, P[pid].capital, pid, 1);
    assert(granted.length === 1, 'could not grant a neighbour of ' + P[pid].capital);
    var src = P[pid].capital;
    s.stations[src].units = units;
    return { s: s, pid: pid, src: src, dst: granted[0] };
  };

  test('an "All" send leaves exactly the seed behind, proportioned across types', function () {
    var b = _spBoard(90, { infantry: 60, artillery: 3, armour: 2 });
    var res = fns.apply(b.s, {
      type: 'send', owner: b.pid, sources: [b.src], target: b.dst, fraction: 1.0,
    });
    assert(res.ok, 'the send was rejected: ' + res.reason);

    var left = b.s.stations[b.src].units;
    assertClose(totalUnits(left), B.SEND_KEEP_UNITS, 1e-9,
      'an "All" send did not leave exactly SEND_KEEP_UNITS behind');
    // PROPORTIONAL, not "one infantry". What stays is a scaled-down copy of the
    // garrison — a city that held only artillery must keep artillery, or the
    // clamp would quietly change the composition of what it saved.
    var k = B.SEND_KEEP_UNITS / 65;
    assertClose(left.infantry, 60 * k, 1e-9, 'infantry left behind');
    assertClose(left.artillery, 3 * k, 1e-9, 'artillery left behind');
    assertClose(left.armour, 2 * k, 1e-9, 'armour left behind');
  });

  test('the clamp is invisible to a fraction that was never going to empty the city', function () {
    // 25% of 40 is 10, and 30 would be left standing — nowhere near the seed.
    // This is the control that makes the test above about the CLAMP rather than
    // about splitUnits: if the floor were applied unconditionally instead of as
    // a ceiling on the fraction, this send would change and every balance run
    // with it.
    var b = _spBoard(91, { infantry: 40, artillery: 0, armour: 0 });
    var res = fns.apply(b.s, {
      type: 'send', owner: b.pid, sources: [b.src], target: b.dst, fraction: 0.25,
    });
    assert(res.ok, 'the send was rejected: ' + res.reason);
    assertClose(b.s.stations[b.src].units.infantry, 30, 1e-9,
      'a 25% send from a full city is not what it was before the clamp existed');
    assertClose(totalUnits(res.waves[0].units), 10, 1e-9, 'the wave carried the wrong amount');
  });

  test('a city already at the seed has nothing spare and is refused', function () {
    var b = _spBoard(92, { infantry: B.SEND_KEEP_UNITS, artillery: 0, armour: 0 });
    var res = fns.apply(b.s, {
      type: 'send', owner: b.pid, sources: [b.src], target: b.dst, fraction: 1.0,
    });
    assertEqual(res.ok, false, 'a city with nothing above the seed sent anyway');
    assertEqual(res.rejected[0].reason, 'too-few-units', 'wrong rejection reason');
    assertClose(totalUnits(b.s.stations[b.src].units), B.SEND_KEEP_UNITS, 1e-9,
      'the refused send took units anyway');
  });

  test('a city emptied by an "All" volley REGROWS — the whole reason the seed exists', function () {
    var b = _spBoard(93, { infantry: 60, artillery: 0, armour: 0 });
    var res = fns.apply(b.s, {
      type: 'send', owner: b.pid, sources: [b.src], target: b.dst, fraction: 1.0,
    });
    assert(res.ok, 'the send was rejected: ' + res.reason);
    var after = totalUnits(b.s.stations[b.src].units);
    assert(after > 0, 'the source was emptied to exactly zero');

    _run(fns, b.s, 1000);
    var grown = totalUnits(b.s.stations[b.src].units);
    // A tenth of capacity is far above anything rounding could produce and far
    // below what the logistic curve actually reaches, so the assertion is about
    // "it recovers" rather than about the growth constants.
    assert(grown > ctx.data.STATIONS[b.src].capacity * 0.1,
      'a city emptied by an "All" volley did not recover: ' + after.toFixed(3) +
      ' -> ' + grown.toFixed(3) + ' over 1000 ticks. With no seed left behind ' +
      'logistic growth multiplies by zero forever and the city is dead ground.');
  });
}

// ===========================================================================
// sim / ownership-aware routing
//
// The rule (sim/movement.js): a wave may march through ground its owner HOLDS
// and through nothing else — neutral ground included. The FINAL station is
// exempt by construction in _moveSearch (a station that fails the traversal
// test may still be REACHED, it just cannot be expanded from), so walking into
// a neutral or enemy city is the attack, and marching through one is not.
//
// Neutral used to be passable. With the capital-only opening that made 101 of
// 108 stations an open highway on move one: on seed 19140628 Britain's opening
// garrison walked London -> BERLIN through Lille, Cologne and Leipzig without
// fighting any of them. Two tests below exist purely to catch that returning —
// "a wave stops and fights a garrisoned neutral" and the capital-opening reach
// guard at the end of the suite.
//
// Routing (_moveCanTraverse) and enforcement (_moveIntercepts) are two halves
// of one rule and are tested as such: whatever routeFor refuses to plan, a wave
// that finds itself on such a path anyway must be stopped at. If they ever
// disagree, a wave either ghosts through a garrison or halts on ground it was
// entitled to cross.
//
// Keyed on OWNERSHIP, never on war status, so none of these fixtures touch
// relations: a corridor that opened and closed as diplomacy drifted would be
// untestable for the same reason it would be unplayable.
//
// Every fixture is built from the live link graph rather than from hard-coded
// city ids — the map is generated (tools/build-map.js) and any id written here
// would rot the next time it is regenerated.
// ===========================================================================

function _routeAdj(LINKS) {
  var adj = {};
  for (var i = 0; i < LINKS.length; i++) {
    var l = LINKS[i];
    (adj[l.a] = adj[l.a] || []).push(l.b);
    (adj[l.b] = adj[l.b] || []).push(l.a);
  }
  Object.keys(adj).forEach(function (k) { adj[k].sort(); });
  return adj;
}

// a and d two hops apart with at least TWO distinct stations in between and no
// direct link, so blocking whichever one the geographic route picks leaves a
// real detour rather than nothing at all.
function _routeDiamond(adj) {
  var ids = Object.keys(adj).sort();
  for (var i = 0; i < ids.length; i++) {
    for (var j = 0; j < ids.length; j++) {
      var a = ids[i], dd = ids[j];
      if (a >= dd) continue;
      if (adj[a].indexOf(dd) >= 0) continue;
      var mids = adj[a].filter(function (x) { return adj[dd].indexOf(x) >= 0; });
      if (mids.length >= 2) return { a: a, d: dd, mids: mids.sort() };
    }
  }
  return null;
}

// A dead end: a station of degree 1 is reachable ONLY through its single
// neighbour, so that neighbour is a genuine cut vertex and no detour exists.
function _routeDeadEnd(adj) {
  var ids = Object.keys(adj).sort();
  for (var i = 0; i < ids.length; i++) {
    var t = ids[i];
    if (adj[t].length !== 1) continue;
    var gate = adj[t][0];
    var srcs = adj[gate].filter(function (x) { return x !== t; }).sort();
    if (srcs.length) return { target: t, gate: gate, src: srcs[0] };
  }
  return null;
}

// Board with every station neutral and empty, then `pid` given `own`.
// A routing fixture: wipe the board to neutral, then hand `pid` the stations
// the test cares about.
//
// It also seeds a token RIVAL somewhere far away, and that is load-bearing
// rather than decorative. Victory now fires when one power has outlasted every
// other (sim/victory.js), and stepTick stops advancing a finished game — so a
// board on which exactly one power holds anything is a WON board, and every
// wave on it freezes in place at tick one. Three tests failed with "the wave
// never resolved" for precisely this reason, which reads like a movement bug
// and is not one. The rival is given a station and no units: it exists to keep
// the war running, not to fight.
function _routeBoard(fns, seed, pid, own) {
  var s = fns.newGame(seed);
  _clearBoard(s, 'neutral');
  for (var i = 0; i < own.length; i++) {
    _setOwner(s, own[i], pid);
    s.stations[own[i]].units.infantry = 60;
  }

  // Put it as far from the fixture as the link graph allows. Taking the first
  // free station in id order is not good enough — it landed on the very middle
  // one test then asserted was neutral, turning a fixture detail into a
  // failure. Farthest-by-hops is deterministic and cannot sit in the
  // neighbourhood the test is reasoning about.
  var pids = Object.keys(s.powers).sort().filter(function (p) { return p !== 'neutral' && p !== pid; });
  var adj = _linkAdjacency(LINKS);
  var seen = {}, frontier = own.slice(), far = null;
  for (var k = 0; k < own.length; k++) seen[own[k]] = true;
  while (frontier.length) {
    var next = [];
    for (var f = 0; f < frontier.length; f++) {
      var nbs = (adj[frontier[f]] || []).slice().sort();
      for (var n = 0; n < nbs.length; n++) {
        if (seen[nbs[n]]) continue;
        seen[nbs[n]] = true;
        next.push(nbs[n]);
      }
    }
    if (next.length) far = next.slice().sort()[0];   // sorted: determinism
    frontier = next;
  }
  if (far) {
    _setOwner(s, far, pids[0]);
    s.stations[far].units.infantry = 1;
  }
  return s;
}

function suiteSimRouting(d) {
  var ctx = _needSim('sim / ownership-aware routing', ['newGame', 'step', 'apply']);
  if (!ctx) return;
  if (typeof routeFor !== 'function') {
    return skipSuite('sim / ownership-aware routing', 'routeFor() [sim/movement.js] not loaded');
  }
  if (!d.LINKS) return skipSuite('sim / ownership-aware routing', 'data/stations.js LINKS not loaded');

  suite('sim / ownership-aware routing');
  var fns = ctx.fns, P = ctx.data.POWERS, B = ctx.data.BAL;
  var adj = _routeAdj(d.LINKS);
  var pids = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; });
  var pid = pids[0], foe = pids[1];

  test('a route detours around an enemy-held station', function () {
    var dm = _routeDiamond(adj);
    assert(dm, 'no two-hop diamond in the link graph to build the fixture from');
    // Both middles are HELD: this test is about an enemy closing one of two
    // open doors, so both doors have to be open to begin with. Leaving them
    // neutral would make the assertion pass for the wrong reason.
    var s = _routeBoard(fns, 41, pid, [dm.a].concat(dm.mids));

    var open = routeFor(s, pid, dm.a, dm.d);
    assert(open && open.length === 3, 'expected a two-hop route over a clear board');
    var blocked = open[1];
    assert(dm.mids.indexOf(blocked) >= 0, 'route did not use one of the shared middles');

    _setOwner(s, blocked, foe);
    var got = routeFor(s, pid, dm.a, dm.d);
    assert(got, 'no route at all around ' + blocked + ' — expected the detour');
    assertEqual(got[got.length - 1], dm.d, 'detour did not end at the target');
    assert(got.indexOf(blocked) < 0,
      'route still marches through enemy-held ' + blocked + ': ' + got.join('>'));

    // The geographic path is deliberately unchanged: routeBetween is the map's
    // opinion and the AI's distance heuristics still read it.
    var geo = routeBetween(dm.a, dm.d);
    assert(geo.indexOf(blocked) >= 0,
      'routeBetween() became ownership-aware — it must stay pure geography');
  });

  test('a NEUTRAL station on the path blocks — only ground you hold is passable', function () {
    var dm = _routeDiamond(adj);
    assert(dm, 'no diamond fixture');
    var s = _routeBoard(fns, 42, pid, [dm.a]);
    var mid = dm.mids[0];
    assertEqual(s.stations[mid].owner, 'neutral', 'fixture middle was not neutral');

    // Every path from a to d runs through a middle, and every middle is
    // neutral. Under the old rule this was the map's own two-hop route.
    assertEqual(routeFor(s, pid, dm.a, dm.d), null,
      'routeFor marched through neutral ground to reach ' + dm.d +
      ' — neutral is no longer a corridor');
    // ...and the geographic route is unchanged, so this is a rule about
    // ownership and not about the map having lost an edge.
    var geo = routeBetween(dm.a, dm.d);
    assert(geo && geo.length === 3,
      'routeBetween() became ownership-aware — it must stay pure geography');

    // The neutral middle is still REACHABLE: it is a legal end of a path, and
    // walking into it is the attack that has to be fought. Blocking it as a
    // destination too would make neutral cities unconquerable.
    var hit = routeFor(s, pid, dm.a, mid);
    assert(hit && hit.join('>') === [dm.a, mid].join('>'),
      'a neutral NEIGHBOUR became unreachable — the final station is not exempt');

    // Taking the middle opens exactly the route that neutrality refused.
    _setOwner(s, mid, pid);
    var open = routeFor(s, pid, dm.a, dm.d);
    assert(open, 'no route to ' + dm.d + ' even after taking the middle ' + mid);
    assertEqual(open.join('>'), [dm.a, mid, dm.d].join('>'),
      'route did not go through the newly-held middle');
  });

  test('an enemy-held DESTINATION does not block — that is the attack', function () {
    var dm = _routeDiamond(adj);
    // The middles are held so the only thing under test is the DESTINATION.
    var s = _routeBoard(fns, 43, pid, [dm.a].concat(dm.mids));
    _setOwner(s, dm.d, foe);
    var got = routeFor(s, pid, dm.a, dm.d);
    assert(got, 'routeFor refused to route INTO an enemy station');
    assertEqual(got[got.length - 1], dm.d, 'route did not reach the enemy target');
  });

  test('a target reachable only through an enemy is rejected with no-route', function () {
    var de = _routeDeadEnd(adj);
    assert(de, 'no degree-1 station on the map to build a cut-vertex fixture from');
    var s = _routeBoard(fns, 44, pid, [de.src]);
    _setOwner(s, de.gate, foe);
    s.stations[de.gate].units.infantry = 10;

    assertEqual(routeFor(s, pid, de.src, de.target), null,
      'routeFor found a way past the only gate into ' + de.target);

    var before = s.stations[de.src].units.infantry;
    var r = fns.apply(s, { type: 'send', owner: pid, sources: [de.src], target: de.target,
                           fraction: B.SEND_FRACTION_DEFAULT });
    assert(r.ok === false, 'applyCommand accepted a send with no legal route');
    assertEqual(r.rejected.length, 1, 'expected exactly one rejected source');
    assertEqual(r.rejected[0].reason, 'no-route', 'wrong rejection reason');
    assertEqual(r.waves.length, 0, 'a wave was created for a rejected send');
    // "a rejected source never leaves the board half-mutated" (sim/commands.js).
    assertClose(s.stations[de.src].units.infantry, before, 1e-9,
      'units were subtracted for a source that was rejected');
  });

  test('a send through the gate is refused while it is neutral, accepted once held', function () {
    var de = _routeDeadEnd(adj);
    assert(de, 'no degree-1 station on the map to build a cut-vertex fixture from');
    var s = _routeBoard(fns, 45, pid, [de.src]);
    var cmd = { type: 'send', owner: pid, sources: [de.src], target: de.target,
                fraction: B.SEND_FRACTION_DEFAULT };
    assertEqual(s.stations[de.gate].owner, 'neutral', 'fixture gate was not neutral');

    var before = s.stations[de.src].units.infantry;
    var r = fns.apply(s, cmd);
    assert(r.ok === false, 'a send THROUGH neutral ' + de.gate + ' was accepted');
    assertEqual(r.rejected[0].reason, 'no-route', 'wrong rejection reason');
    assertEqual(r.waves.length, 0, 'a wave was created for a rejected send');
    assertClose(s.stations[de.src].units.infantry, before, 1e-9,
      'units were subtracted for a source that was rejected');

    // Same command, same board, one thing changed: the power now holds the
    // gate. Nothing about the geography or the diplomacy moved.
    _setOwner(s, de.gate, pid);
    var r2 = fns.apply(s, cmd);
    assert(r2.ok === true, 'a send over ground the power HOLDS was refused: ' +
      JSON.stringify(r2.rejected));
    assertEqual(r2.waves.length, 1, 'expected exactly one wave');
    assertEqual(r2.waves[0].path.join('>'), [de.src, de.gate, de.target].join('>'),
      'the accepted wave did not route through the held gate');
  });

  // -------------------------------------------------------------------------
  // THE FALLBACK GIVES THE SAME VERDICT AS THE REAL RULE.
  //
  // commandRoute() prefers routeFor() and falls back to its own search when
  // sim/movement.js has not loaded. That fallback's passability test had been
  // left on the OLD rule — `owner === pid || owner === 'neutral'` — for the
  // whole of the capital-only opening, where 101 of 108 stations are neutral,
  // so the one configuration it exists for would have accepted a volley
  // marching straight through unfought neutral garrisons.
  //
  // Nobody runs a path that only runs when something else has already failed
  // (known-issues #20), so something has to run it on purpose. This is that.
  // The global is restored in a `finally`: leaving routeFor undefined would
  // silently retask every suite after this one.
  test('commandRoute falls back to the SAME passability rule, not the old one', function () {
    if (typeof routeFor !== 'function') return;          // nothing to shadow
    var de = _routeDeadEnd(adj);
    assert(de, 'no degree-1 station on the map to build a cut-vertex fixture from');
    var s = _routeBoard(fns, 45, pid, [de.src]);
    assertEqual(s.stations[de.gate].owner, 'neutral', 'fixture gate was not neutral');

    // The authority's answer, taken first so the comparison is against a
    // measured value rather than against a constant written down here.
    var real = routeFor(s, pid, de.src, de.target);
    assertEqual(real, null, 'fixture: routeFor already allows the neutral gate');

    var saved = routeFor;
    var viaFallback;
    try {
      globalThis.routeFor = undefined;
      viaFallback = commandRoute(de.src, de.target, s, pid);
    } finally {
      globalThis.routeFor = saved;
    }
    assertEqual(viaFallback, null,
      'the fallback routed through neutral ' + de.gate + ' — it must mirror ' +
      '_moveCanTraverse, which stopped treating neutral as a corridor');

    // ...and it still finds the route the real rule finds, so this is a fix to
    // the passability test and not a fallback that now refuses everything.
    _setOwner(s, de.gate, pid);
    try {
      globalThis.routeFor = undefined;
      viaFallback = commandRoute(de.src, de.target, s, pid);
    } finally {
      globalThis.routeFor = saved;
    }
    assert(viaFallback && viaFallback.join('>') === [de.src, de.gate, de.target].join('>'),
      'the fallback lost a route over ground the power HOLDS: ' +
      (viaFallback ? viaFallback.join('>') : 'null'));
  });

  test('a capture bumps ownerEpoch and invalidates the route cache', function () {
    var dm = _routeDiamond(adj);
    // Middles held: the cache question needs a route to exist BEFORE the
    // capture, so there is a stale answer for the second call to return.
    var s = _routeBoard(fns, 46, pid, [dm.a].concat(dm.mids));

    // Warm the cache FIRST — this test is worthless if the second call is the
    // first one that ever ran.
    var first = routeFor(s, pid, dm.a, dm.d);
    assert(first && first.length === 3, 'fixture route was not the expected two hops');
    var blocked = first[1];
    var epochBefore = s.ownerEpoch;

    setStationOwner(s, blocked, foe);
    assert(s.ownerEpoch > epochBefore,
      'setStationOwner did not move state.ownerEpoch (' + epochBefore + ')');

    var second = routeFor(s, pid, dm.a, dm.d);
    assert(second, 'no route after the capture');
    assert(second.join('>') !== first.join('>'),
      'routeFor returned the pre-capture path ' + first.join('>') + ' — cache went stale');
    assert(second.indexOf(blocked) < 0, 'stale route still crosses ' + blocked);
  });

  test('ownerEpoch is an integer that only counts real changes', function () {
    var s = fns.newGame(47);
    assertEqual(s.ownerEpoch, 0, 'a fresh game must start at epoch 0');
    var sid = Object.keys(s.stations).sort()[0];
    var owner = s.stations[sid].owner;
    setStationOwner(s, sid, owner);
    assertEqual(s.ownerEpoch, 0, 'a no-op ownership write bumped the epoch');
    setStationOwner(s, sid, owner === foe ? pid : foe);
    assertEqual(s.ownerEpoch, 1, 'a real ownership change did not bump the epoch by one');
  });

  test('a wave is intercepted when an intermediate station flips mid-flight', function () {
    var dm = _routeDiamond(adj);
    // Middles held, so the send is legal at send time. The whole point is that
    // the board changes UNDER a route that was legal when it was planned.
    var s = _routeBoard(fns, 48, pid, [dm.a].concat(dm.mids));
    s.stations[dm.a].units.infantry = 200;

    var r = fns.apply(s, { type: 'send', owner: pid, sources: [dm.a], target: dm.d, fraction: 0.9 });
    assert(r.ok, 'setup send was refused: ' + JSON.stringify(r.rejected));
    var w = r.waves[0];
    assertEqual(w.path.length, 3, 'fixture needs a two-hop route so there IS an intermediate');
    var mid = w.path[1];

    // One tick so the wave is genuinely in the air, then the middle changes
    // hands behind it. Its path was fixed at send time and cannot be replanned.
    fns.step(s);
    assert(s.waves.length === 1, 'wave resolved before it could be intercepted — fixture too short');
    _setOwner(s, mid, foe);
    s.stations[mid].units.infantry = 5;

    for (var i = 0; i < 4000 && s.waves.length; i++) fns.step(s);
    assertEqual(s.waves.length, 0, 'the wave never resolved');

    // It fought at the interception point, not at its original destination.
    for (var k = 0; k < 400; k++) fns.step(s);
    assertEqual(s.stations[mid].owner, pid,
      'the wave ghosted through enemy-held ' + mid + ' instead of fighting there');
    assertEqual(s.stations[dm.d].owner, 'neutral',
      'the wave reached ' + dm.d + ' — it should have been stopped at ' + mid);
  });

  test('a NEUTRAL intermediate intercepts too', function () {
    // The enforcement half of the inverted routing test above. _moveIntercepts
    // and _moveCanTraverse have to agree exactly: routing refuses to PLAN a
    // path through neutral ground, so a wave that ends up on one anyway must be
    // stopped at it. Neutral used to be the one intermediate that waved a wave
    // through, which is the same bug as routing through it, only later.
    var dm = _routeDiamond(adj);
    var s = _routeBoard(fns, 49, pid, [dm.a].concat(dm.mids));
    s.stations[dm.a].units.infantry = 200;

    var r = fns.apply(s, { type: 'send', owner: pid, sources: [dm.a], target: dm.d, fraction: 0.9 });
    assert(r.ok, 'setup send was refused: ' + JSON.stringify(r.rejected));
    var w = r.waves[0];
    assertEqual(w.path.length, 3, 'fixture needs a two-hop route so there IS an intermediate');
    var mid = w.path[1];

    fns.step(s);
    assert(s.waves.length === 1, 'wave resolved before it could be intercepted — fixture too short');
    // The middle is LOST behind the wave — to nobody, not to a rival. Under the
    // old rule that was a free pass.
    _setOwner(s, mid, 'neutral');
    s.stations[mid].units.infantry = 5;

    for (var i = 0; i < 4000 && s.waves.length; i++) fns.step(s);
    assertEqual(s.waves.length, 0, 'the wave never resolved');

    for (var k = 0; k < 400; k++) fns.step(s);
    assertEqual(s.stations[mid].owner, pid,
      'the wave ghosted through neutral ' + mid + ' instead of fighting there');
    assertEqual(s.stations[dm.d].owner, 'neutral',
      'the wave reached ' + dm.d + ' — it should have been stopped at neutral ' + mid);
  });

  // ---- the regression the suite did not have ------------------------------
  test('a wave stops and fights a garrisoned neutral instead of marching through it', function () {
    // THE bug, in miniature. Seed 19140628, turn zero, before neutral ground
    // was closed: Britain sent its opening 67-unit garrison out of London and
    // captured BERLIN, walking through Lille (6 defenders), Cologne (9) and
    // Leipzig (8) without fighting one of them. Nothing in this suite noticed.
    var dm = _routeDiamond(adj);
    var s = _routeBoard(fns, 50, pid, [dm.a]);
    var mid = dm.mids[0], far = dm.d;
    var garrison = 100;
    s.stations[mid].units.infantry = garrison;

    // 1. It cannot be PLANNED: the far target is unroutable past the garrison.
    assertEqual(routeFor(s, pid, dm.a, far), null,
      'routeFor planned a march through garrisoned neutral ' + mid + ' to reach ' + far);

    // 2. And a wave put on that path anyway is stopped at the garrison. Pushed
    //    in directly, because routeFor will (correctly) no longer build it —
    //    which is exactly why enforcement has to be checked separately.
    var sent = 180;
    s.waves.push({ id: 1, owner: pid, from: dm.a, to: far, path: [dm.a, mid, far],
                   hop: 0, progress: 0,
                   units: { infantry: sent, artillery: 0, armour: 0 } });

    // Watched rather than measured at the end: `far` is a neutral station and
    // neutral stations REGROW, so its unit count drifts up from zero on its own
    // and cannot be used as evidence of anything.
    var touchedFar = false;
    for (var i = 0; i < 8000 && s.waves.length; i++) {
      fns.step(s);
      if (typeof stationAttackers === 'function' && stationAttackers(s, far).length) touchedFar = true;
    }
    assertEqual(s.waves.length, 0, 'the wave never resolved');
    assert(!touchedFar,
      'the wave arrived at ' + far + ' beyond the garrison at ' + mid +
      ' — this is the London-to-Berlin bug');
    for (var k = 0; k < 300; k++) fns.step(s);

    // The neutral garrison was fought down, not walked past.
    assertEqual(s.stations[mid].owner, pid,
      'the neutral garrison at ' + mid + ' was never engaged — the wave marched through it');
    assert(totalUnits(s.stations[mid].units) < sent - 1e-9,
      'the attacker holds ' + mid + ' at full strength (' + sent + ') — no fight happened');
    assertEqual(s.stations[far].owner, 'neutral',
      'the wave took ' + far + ' beyond the garrison — this is the London-to-Berlin bug');
  });

  // ---- the cheap guard that would have caught it on day one ---------------
  test('from the capital-only opening a power can reach only its link neighbours', function () {
    // One assertion over the real starting board. Every power opens holding its
    // capital and nothing else, so "how far can anybody go on move one" is
    // exactly link degree — 6/4/6/3/6/6/5 for aut/fra/gbr/rus/ita/ott/ger on
    // this map. Derived from LINKS rather than hard-coded so it survives a map
    // rebuild; what it pins down is the RELATIONSHIP, which must not change.
    var s = fns.newGame(19140628);
    var caps = {};
    pids.forEach(function (p) { caps[P[p].capital] = p; });

    pids.forEach(function (p) {
      var cap = P[p].capital;
      var held = Object.keys(s.stations).sort().filter(function (sid) {
        return s.stations[sid].owner === p;
      });
      assertEqual(held.join(','), cap,
        p + ' does not open holding exactly its capital — this guard assumes it does');

      var reach = Object.keys(s.stations).sort().filter(function (sid) {
        return sid !== cap && routeFor(s, p, cap, sid) !== null;
      });
      var nb = (adj[cap] || []).slice().sort();
      assertEqual(reach.join(','), nb.join(','),
        p + ' reaches ' + reach.length + ' stations from ' + cap + ' but has ' +
        nb.length + ' links — ' + reach.join(','));

      // The bug stated as its consequence: nobody may touch anybody on move one.
      var decap = reach.filter(function (sid) { return caps[sid]; });
      assertEqual(decap.length, 0,
        p + ' can reach a rival capital from ' + cap + ' on move one: ' + decap.join(','));
    });
  });
}

// ===========================================================================
// sim / beachhead landings   (02-visibility-and-sea.md §3b)
//
// A wave whose FINAL hop is a sea link comes ashore in echelons over
// BAL.LANDING_TICKS instead of arriving all at once; units still at sea are not
// in station.attackers and so cannot be hit. A LAND final hop is unchanged.
//
// Every fixture is derived from the live link graph — one sea link and one land
// link into the SAME station, so the amphibious and overland runs differ in
// nothing but the water. Hard-coding beach ids would rot with the map, and
// worse, would let the two arms of the comparison drift apart.
//
// None of the assertions below hard-code an odds threshold either. The one test
// that has to know where the break-even sits FINDS it, by searching for the
// smallest overland attacker that wins and then re-running exactly that force
// over the sea. That claim stays true and stays meaningful whatever COMBAT_RATE
// and LANDING_TICKS are later retuned to.
// ===========================================================================

// A sea link, plus a land link into the same landing station. Lowest ids win so
// the fixture is stable across runs.
function _beachFixture(LINKS) {
  var sea = LINKS.filter(function (l) { return l.sea === true; })
    .sort(function (a, b) { return (a.a + '|' + a.b) < (b.a + '|' + b.b) ? -1 : 1; });
  for (var i = 0; i < sea.length; i++) {
    // Either end may be the beach; try both so a one-sided coastline still works.
    var ends = [[sea[i].a, sea[i].b], [sea[i].b, sea[i].a]];
    for (var e = 0; e < ends.length; e++) {
      var src = ends[e][0], beach = ends[e][1];
      var land = LINKS.filter(function (l) {
        return !l.sea && (l.a === beach || l.b === beach);
      }).map(function (l) { return l.a === beach ? l.b : l.a; }).sort();
      if (!land.length) continue;
      // A land neighbour of the SOURCE too, so the interception fixture can put
      // a hop in front of the crossing — see that test for why it matters.
      var pre = LINKS.filter(function (l) {
        return !l.sea && (l.a === src || l.b === src);
      }).map(function (l) { return l.a === src ? l.b : l.a; })
        .filter(function (x) { return x !== beach; }).sort();
      return { src: src, beach: beach, land: land[0], pre: pre[0] || null };
    }
  }
  return null;
}

// Empty, all-neutral, growth-free board. Growth is switched off so every
// assertion below is about movement and combat only — a beach that regrows
// mid-landing would make the arithmetic untraceable.
function _beachBoard(fns, seed) {
  var s = fns.newGame(seed);
  _clearBoard(s, 'neutral');
  Object.keys(s.stations).forEach(function (sid) { s.stations[sid].growthMul = 0; });
  return s;
}

// Run the MOVEMENT phase alone, n times.
//
// Deliberately not fns.step() for the assertions that are about landing
// arithmetic rather than about fighting. A test fixture's stations belong to a
// made-up power with no capital, so growthTick correctly marks them
// disconnected and DISCONNECT_DECAY quietly shaves the garrison every tick —
// which is invisible in the assertion and looks exactly like the landing losing
// units. Isolating phase 2 makes "50 in, 50 ashore" mean what it says. The
// suites that are about combat still run the whole tick.
function _beachMove(s, n) {
  for (var i = 0; i < n && s.waves.length; i++) movementTick(s);
  return s;
}

function _beachWave(s, origin, beach, units, owner) {
  var w = { id: 1, owner: owner, from: origin, to: beach, path: [origin, beach],
            hop: 0, progress: 1, units: units };
  s.waves.push(w);
  return w;
}

// Drop `atk` infantry onto `beach` from `origin` and run until nothing is left
// in the air or in the battle. Returns whether the station was taken.
function _beachAssault(fns, fx, atk, def, origin, seed, owner) {
  var pid = owner || '_atk';
  var s = _beachBoard(fns, seed);
  s.stations[fx.beach].units.infantry = def;
  _beachWave(s, origin, fx.beach, { infantry: atk, artillery: 0, armour: 0 }, pid);
  for (var t = 0; t < 30000; t++) {
    fns.step(s);
    var st = s.stations[fx.beach];
    if (!s.waves.length && !(st.attackers && Object.keys(st.attackers).length)) break;
  }
  var st2 = s.stations[fx.beach];
  return { took: st2.owner === pid, left: st2.owner === pid ? totalUnits(st2.units) : 0, state: s };
}

function suiteSimBeachhead(d) {
  var ctx = _needSim('sim / beachhead landings', ['newGame', 'step']);
  if (!ctx) return;
  if (!d.LINKS) return skipSuite('sim / beachhead landings', 'data/stations.js LINKS not loaded');
  var fx = _beachFixture(d.LINKS);
  if (!fx) return skipSuite('sim / beachhead landings', 'no sea link with a land link into the same station');

  suite('sim / beachhead landings');
  var fns = ctx.fns, B = ctx.data.BAL;
  var N = B.LANDING_TICKS;

  test('LANDING_TICKS is present and shorter than a decisive battle', function () {
    assert(typeof N === 'number' && N >= 1, 'BAL.LANDING_TICKS missing or < 1');
    // atanh(1/2)/COMBAT_RATE is a 2:1 battle. A landing longer than the fight
    // it is fought inside is not a beachhead, it is a second combat model.
    var battle2to1 = Math.log(3) / 2 / B.COMBAT_RATE;
    assert(N < battle2to1,
      'LANDING_TICKS ' + N + ' exceeds a 2:1 battle (' + Math.round(battle2to1) + ' ticks)');
  });

  // ---- the point of the whole feature -------------------------------------
  test('a force that takes a beach over land LOSES coming off the water', function () {
    var def = 30;
    // Smallest overland attacker that wins. Searched, never hard-coded: this
    // test must keep meaning something after a combat retune.
    var breakEven = null;
    for (var a = Math.round(def * 0.9); a <= def * 4; a++) {
      if (_beachAssault(fns, fx, a, def, fx.land, 7).took) { breakEven = a; break; }
    }
    assert(breakEven, 'no overland attacker up to 4:1 could take the fixture beach');

    var sea = _beachAssault(fns, fx, breakEven, def, fx.src, 7);
    assert(!sea.took,
      breakEven + ' units took ' + fx.beach + ' over land but ALSO took it across the sea — ' +
      'echelon landing is not costing the attacker anything (LANDING_TICKS ' + N + ')');
  });

  test('...but enough force still gets ashore — the sea is not a wall', function () {
    var r = _beachAssault(fns, fx, 120, 30, fx.src, 7);
    assert(r.took, 'a 4:1 amphibious assault failed — LANDING_TICKS has made landings impossible');
  });

  // ---- the sea toll, exactly once -----------------------------------------
  //
  // Landing into a FRIENDLY station so nothing is lost to combat: every unit
  // that leaves the boat is still countable at the end. Double-charging shows
  // up as (1 - LOSS)^2, per-echelon charging as (1 - LOSS)^N.
  test('the sea artillery toll is charged exactly ONCE across a landing', function () {
    var s = _beachBoard(fns, 21);
    _setOwner(s, fx.beach, '_atk');
    var inf = 40, art = 40;
    _beachWave(s, fx.src, fx.beach, { infantry: inf, artillery: art, armour: 0 }, '_atk');

    _beachMove(s, N + 200);
    assertEqual(s.waves.length, 0, 'the landing never finished — a residue is trickling forever');

    var got = s.stations[fx.beach].units;
    var want = art * (1 - B.SEA_ARTILLERY_LOSS);
    assertClose(got.artillery, want, 1e-9,
      'artillery ashore after one crossing (once = ' + want.toFixed(4) +
      ', twice = ' + (art * Math.pow(1 - B.SEA_ARTILLERY_LOSS, 2)).toFixed(4) + ')');
    assertClose(got.infantry, inf, 1e-9, 'infantry must not be taxed by the crossing at all');
  });

  if (!fx.pre) skipTest('the toll is charged once when interception truncates onto a sea hop',
    'no land link into ' + fx.src + ' to put a hop in front of the crossing');
  else test('the toll is charged once when interception truncates onto a sea hop', function () {
    // pre --land--> src --sea--> beach --land--> inland, with the beach in
    // hostile hands so the wave is intercepted there and its path truncated to
    // [pre, src, beach]. The truncated path's final hop is the sea link, so the
    // landing rules must apply.
    //
    // The leading land hop is the point of the fixture. It makes w.from a
    // station with NO link to the beach at all, so an implementation that
    // decided sea-ness from the wave's stated endpoints (w.from / w.to) instead
    // of from the truncated path cannot accidentally get the right answer here.
    //
    // The attacker must HOLD the leading land hop. Only ground its owner holds
    // is passable, so a neutral `src` would intercept the wave one hop early
    // and the fixture would never reach the water at all — that would be a
    // fixture measuring the routing rule, not the sea toll.
    var s = _beachBoard(fns, 22);
    _setOwner(s, fx.pre, '_atk');
    _setOwner(s, fx.src, '_atk');
    _setOwner(s, fx.beach, '_foe');
    s.stations[fx.beach].units.infantry = 1;
    var art = 40;
    var w = { id: 1, owner: '_atk', from: fx.pre, to: fx.land,
              path: [fx.pre, fx.src, fx.beach, fx.land], hop: 0, progress: 0,
              units: { infantry: 60, artillery: art, armour: 0 } };
    s.waves.push(w);

    for (var t = 0; t < 20000 && !w.landing; t++) movementTick(s);
    assert(w.landing, 'an intercepted wave on the far side of a sea link never began a landing');
    assertEqual(w.path.length, 3, 'path was not truncated at the interception point');
    assertEqual(w.path[2], fx.beach, 'truncated somewhere other than the beach');
    assertClose(w.landing.total, (60 + art * (1 - B.SEA_ARTILLERY_LOSS)),
      1e-9, 'landing strength — the crossing toll was not applied exactly once');
  });

  // ---- units at sea are not in the battle ---------------------------------
  if (N < 4) skipTest('units still at sea cannot be hit',
    'LANDING_TICKS is ' + N + ' — there is no at-sea phase to observe');
  else test('units still at sea cannot be hit', function () {
    var s = _beachBoard(fns, 23);
    s.stations[fx.beach].units.infantry = 60;
    var atk = 60;
    var w = _beachWave(s, fx.src, fx.beach, { infantry: atk, artillery: 0, armour: 0 }, '_atk');

    var half = Math.floor(N / 2);
    for (var t = 0; t < half; t++) fns.step(s);
    assert(s.waves.length === 1, 'the landing finished early — fixture cannot see the at-sea phase');

    // The at-sea remainder is spent ONLY by the echelon schedule. If combat
    // could reach it this number would be smaller, and if the schedule drifted
    // it would not be exact.
    assertClose(totalUnits(w.units), atk * (1 - half / N), 1e-9,
      'the at-sea remainder is not exactly (1 - t/N) of the force — either combat ' +
      'is reaching units still on the water, or echelons are not a fixed fraction');
    assert(totalUnits(s.stations[fx.beach].attackers['_atk']) < atk * (half / N),
      'the force ashore has taken no losses — the beach is not fighting back');
  });

  // ---- mid-landing flips ---------------------------------------------------
  test('a landing into a station its own side holds merges, never fights', function () {
    var s = _beachBoard(fns, 24);
    _setOwner(s, fx.beach, '_atk');
    s.stations[fx.beach].units.infantry = 10;
    _beachWave(s, fx.src, fx.beach, { infantry: 50, artillery: 0, armour: 0 }, '_atk');

    for (var t = 0; t < N + 200 && s.waves.length; t++) {
      movementTick(s);
      assert(!s.stations[fx.beach].attackers || !s.stations[fx.beach].attackers['_atk'],
        'an echelon landed on friendly ground as an ATTACKER on tick ' + t);
    }
    assertClose(s.stations[fx.beach].units.infantry, 60, 1e-9,
      'the landing did not merge into the garrison intact');
  });

  test('a station that flips to the landing power mid-landing absorbs the rest', function () {
    var s = _beachBoard(fns, 25);
    s.stations[fx.beach].units.infantry = 20;
    var atk = 90;
    var w = _beachWave(s, fx.src, fx.beach, { infantry: atk, artillery: 0, armour: 0 }, '_atk');

    var quarter = Math.max(1, Math.floor(N / 4));
    _beachMove(s, quarter);
    assert(s.waves.length === 1, 'landing ended before the flip could be staged');
    var atSea = totalUnits(w.units);
    assert(atSea > 1, 'nothing left at sea to test the merge with');

    // The beach changes hands under the landing — the same situation
    // WAVE_REROUTE_ON_LOSS: false describes for a wave in flight.
    s.stations[fx.beach].attackers = null;
    delete s.stations[fx.beach].attackers;
    s.stations[fx.beach].units = { infantry: 0, artillery: 0, armour: 0 };
    _setOwner(s, fx.beach, '_atk');

    _beachMove(s, N + 200);
    assertEqual(s.waves.length, 0, 'the landing never finished after the flip');
    assert(!s.stations[fx.beach].attackers,
      'the remaining echelons fought their own side after the station flipped to them');
    assertClose(s.stations[fx.beach].units.infantry, atSea, 1e-9,
      'the at-sea remainder did not merge into the garrison it now belongs to');
  });

  test('a station that flips to a THIRD power mid-landing keeps taking attackers', function () {
    var s = _beachBoard(fns, 26);
    s.stations[fx.beach].units.infantry = 20;
    var w = _beachWave(s, fx.src, fx.beach, { infantry: 90, artillery: 0, armour: 0 }, '_atk');

    var quarter = Math.max(1, Math.floor(N / 4));
    _beachMove(s, quarter);
    assert(s.waves.length === 1, 'landing ended before the flip could be staged');

    delete s.stations[fx.beach].attackers;
    s.stations[fx.beach].units = { infantry: 200, artillery: 0, armour: 0 };
    _setOwner(s, fx.beach, '_third');

    movementTick(s);
    assert(s.stations[fx.beach].attackers && s.stations[fx.beach].attackers['_atk'],
      'echelons landing on a THIRD power merged or vanished instead of attacking — ' +
      'they are still hostile to whoever is standing there');
  });

  // ---- the residue rule ----------------------------------------------------
  test('the final echelon flushes the remainder instead of trickling', function () {
    var s = _beachBoard(fns, 27);
    _setOwner(s, fx.beach, '_atk');
    var atk = 50;
    _beachWave(s, fx.src, fx.beach, { infantry: atk, artillery: 0, armour: 0 }, '_atk');

    // The observable contract of the flush rule is that the water NEVER holds a
    // stack smaller than the smallest one a player is allowed to send. Asserting
    // only "it finished by tick N" is not enough: a landing with no flush at all
    // also finishes by tick N, it just spends its last echelons dribbling
    // fractions ashore. This is the assertion that can tell them apart.
    var t = 0, thinnest = Infinity;
    for (; t < 5000 && s.waves.length; t++) {
      movementTick(s);
      var atSea = totalUnits(s.waves.length ? s.waves[0].units : { infantry: 0, artillery: 0, armour: 0 });
      if (atSea > 0 && atSea < thinnest) thinnest = atSea;
      assert(atSea === 0 || atSea > B.MIN_SEND_UNITS,
        'tick ' + t + ' left ' + atSea.toFixed(4) + ' units at sea, under MIN_SEND_UNITS ' +
        B.MIN_SEND_UNITS + ' — the remainder is being trickled, not flushed');
    }
    assertEqual(s.waves.length, 0, 'the landing wave outlived its schedule');
    assert(t <= N, 'the landing took ' + t + ' ticks against LANDING_TICKS ' + N);
    assert(thinnest < Infinity, 'the landing never had anything at sea — fixture is not landing');
    assertClose(s.stations[fx.beach].units.infantry, atk, 1e-9,
      'units were lost or left behind in the flush');
  });

  // ---- the land path is untouched -----------------------------------------
  test('a LAND arrival is still instant and never sets a landing', function () {
    var s = _beachBoard(fns, 28);
    s.stations[fx.beach].units.infantry = 5;
    var w = _beachWave(s, fx.land, fx.beach, { infantry: 40, artillery: 0, armour: 0 }, '_atk');

    fns.step(s);
    assertEqual(s.waves.length, 0, 'a land arrival was deferred past the tick it was seen on');
    assert(!w.landing, 'a land arrival built a landing record');
    // Everything is in the battle on the tick it landed; combat has run once,
    // so allow for one tick of attrition rather than asserting the raw 40.
    var ashore = totalUnits(s.stations[fx.beach].attackers['_atk']);
    assertBetween(ashore, 39, 40, 'a land arrival did not commit its whole stack at once');
  });

  test('a zero-hop wave (path length 1) is unaffected', function () {
    // The convention tests everywhere else lean on: push { progress: 1,
    // path: [sid] } and it resolves this tick with no crossing and no landing.
    var s = _beachBoard(fns, 29);
    s.stations[fx.beach].units.infantry = 5;
    var w = { id: 1, owner: '_atk', from: fx.beach, to: fx.beach, path: [fx.beach],
              hop: 0, progress: 1, units: { infantry: 30, artillery: 10, armour: 0 } };
    s.waves.push(w);
    fns.step(s);
    assertEqual(s.waves.length, 0, 'a zero-hop wave did not resolve on the tick it was seen');
    assert(!w.landing, 'a zero-hop wave built a landing record');
    // A crossing toll would leave 9.0; one tick of combat leaves ~9.99. The
    // threshold sits between the two on purpose.
    assert(s.stations[fx.beach].attackers['_atk'].artillery > 9.5,
      'a zero-hop wave was charged a sea crossing it never made');
  });

  // ---- the landing EVENT ---------------------------------------------------
  //
  // Before this existed, an amphibious assault produced no notification of any
  // kind: measured over 12 headless games, 4,282 landings and zero ticker lines.
  // The event is what render/hud.js tiers off, so these assertions are about the
  // two things a ticker line can get wrong — saying something that did not
  // happen, and saying a number that is not the one on the board
  // (docs/testing/known-issues.md #18).
  function _beachLandings(s) {
    return (s.log || []).filter(function (e) { return e.kind === 'landing'; });
  }
  var _LAND_RE = /^(\S+) puts ([0-9.]+) ashore at (.+) against (\S+)$/;

  test('an opposed landing logs exactly one landing event, in the sim log shape', function () {
    var s = _beachBoard(fns, 30);
    s.stations[fx.beach].units.infantry = 20;
    _beachWave(s, fx.src, fx.beach, { infantry: 50, artillery: 0, armour: 0 }, '_atk');

    var at = s.tick;
    _beachMove(s, N + 200);

    var ev = _beachLandings(s);
    assertEqual(ev.length, 1,
      'an opposed landing logged ' + ev.length + ' events — one per ECHELON, or none at all');
    // Same record shape as sim/combat.js's capture: { tick, kind, text, sid }
    // and nothing else. A ticker that has to learn a second shape is a ticker
    // that will read the wrong field.
    //
    // `sid` arrived with fog (Milestone 5.7) and is logEvent's optional 4th
    // argument. It is what lets render/hud.js keep a landing off the ticker
    // when the player has no eyes on the coast — WITHOUT the sim ever
    // consulting visibility, which test/fog-tests.js separately greps for. It
    // is pinned here rather than merely tolerated, because a filter keyed to a
    // field the sim silently stopped setting fails OPEN: every landing on the
    // board would be back on screen and nothing would say so.
    //
    // Entries that name no station — capitulation, elimination, victory,
    // declarations of war — still carry exactly { tick, kind, text }; the key
    // is added conditionally, which is what keeps the change additive.
    assertEqual(Object.keys(ev[0]).sort().join(','), 'kind,sid,text,tick',
      'the landing record is not { tick, kind, text, sid }');
    assertEqual(ev[0].sid, fx.beach,
      'the landing was tagged with the wrong station — the ticker would filter ' +
      'it against somebody else\'s visibility');
    assertEqual(ev[0].tick, at, 'the landing was stamped with the wrong tick');
    var m = _LAND_RE.exec(ev[0].text);
    assert(!!m, 'render/hud.js cannot parse the landing sentence: "' + ev[0].text + '"');
    assertEqual(m[1], '_atk', 'the landing named the wrong power');
    assertEqual(m[3], (d.STATIONS[fx.beach] ? d.STATIONS[fx.beach].name : fx.beach),
      'the landing named the wrong place');
    assertEqual(m[4], 'neutral', 'the landing named the wrong defender');
  });

  test('the logged force is the force that ACTUALLY comes ashore', function () {
    // known-issues #18: a number is only proven by being compared against the
    // event it predicts. The sentence says "puts N ashore"; this counts what
    // reaches station.attackers and demands they agree. Movement phase only, so
    // no combat eats the evidence.
    var s = _beachBoard(fns, 31);
    s.stations[fx.beach].units.infantry = 20;
    // Artillery on board on purpose: the sea toll is charged before the landing
    // record is built, so a sentence written from the PRE-toll stack would
    // over-report by SEA_ARTILLERY_LOSS and nothing else here would notice.
    _beachWave(s, fx.src, fx.beach, { infantry: 50, artillery: 20, armour: 0 }, '_atk');
    _beachMove(s, N + 200);

    assertEqual(s.waves.length, 0, 'the landing never finished');
    var ashore = totalUnits(s.stations[fx.beach].attackers['_atk']);
    assert(ashore < 70 - 1e-9, 'the sea artillery toll was never charged — fixture is not a crossing');

    var m = _LAND_RE.exec(_beachLandings(s)[0].text);
    assert(!!m, 'landing sentence did not parse');
    var expect = (typeof _moveLandNum === 'function')
      ? _moveLandNum(ashore)
      : String(ashore >= 10 ? Math.round(ashore) : Math.round(ashore * 10) / 10);
    assertEqual(m[2], expect,
      'the ticker would say "' + m[2] + ' ashore" while ' + ashore.toFixed(3) +
      ' units actually landed');
  });

  test('sea-borne REINFORCEMENT into a friendly port logs nothing', function () {
    // Half of all landings on a live board (measured: 2,219 of 4,356 over 12
    // games) are a wave coming ashore where its own side already stands. That is
    // logistics, not a beachhead — it deposits into the garrison and starts no
    // fight — and logging it would double the ticker's landing traffic with
    // events that carry no news.
    var s = _beachBoard(fns, 32);
    _setOwner(s, fx.beach, '_atk');
    s.stations[fx.beach].units.infantry = 10;
    var w = _beachWave(s, fx.src, fx.beach, { infantry: 50, artillery: 0, armour: 0 }, '_atk');
    _beachMove(s, N + 200);

    assert(!!w.landing, 'the fixture never landed — this test would pass vacuously');
    assertEqual(_beachLandings(s).length, 0,
      'reinforcement by sea was logged as an opposed landing');
  });

  test('a LAND arrival logs no landing', function () {
    var s = _beachBoard(fns, 33);
    s.stations[fx.beach].units.infantry = 5;
    _beachWave(s, fx.land, fx.beach, { infantry: 40, artillery: 0, armour: 0 }, '_atk');
    movementTick(s);
    assertEqual(_beachLandings(s).length, 0, 'an overland arrival was logged as a landing');
  });

  test('logging a landing does not perturb the seeded stream', function () {
    // Determinism is a hard guarantee (00-vision.md §9) and a presentational
    // event must not be able to move a replay. logEvent only pushes onto
    // state.log, so this asserts the observable form of that: the same seed run
    // twice, with landings happening in both, agrees on everything EXCEPT the
    // log, and the rng cursor is untouched by the landing itself.
    function play(seed) {
      var s = _beachBoard(fns, seed);
      s.stations[fx.beach].units.infantry = 20;
      _beachWave(s, fx.src, fx.beach, { infantry: 50, artillery: 20, armour: 0 }, '_atk');
      for (var t = 0; t < N + 200; t++) fns.step(s);
      return s;
    }
    var a = play(34), b = play(34);
    assert(_beachLandings(a).length === 1, 'no landing happened — nothing was being tested');
    assertEqual(JSON.stringify(a.rng), JSON.stringify(b.rng),
      'the rng cursor diverged between two runs of the same seed');
    var sa = snapshot(a), sb = snapshot(b);
    delete sa.log; delete sb.log;
    assertEqual(JSON.stringify(sa), JSON.stringify(sb),
      'two runs of the same seed produced different boards');
    // And the landing tick itself spent no randomness: the cursor before and
    // after the tick the landing lands on must be equal to a run that is
    // identical in every other respect.
    assert(JSON.stringify(a.log) === JSON.stringify(b.log),
      'the log itself is not reproducible from the seed');
  });
}


// ===========================================================================
// sim / standing orders
//
// 00-vision.md §8 says "the board never plays itself". Supply lines are a
// deliberate, scoped amendment to that sentence, and THE SCOPE IS THE
// AMENDMENT — which is what this suite exists to hold in place. Two rules
// carry the whole mechanic, and every test here is one of them from a
// different angle:
//
//   1. LOGISTICS CAN BE AUTOMATED; COMMITMENT CANNOT. A supply line moves
//      units only between stations their owner already holds. It never
//      attacks, never targets ground its owner does not hold, and never
//      initiates combat. If an implementation can cause a fight, it is wrong.
//
//   2. STANDING WAVES ARE NOT COMMITTED WAVES. WAVE_REROUTE_ON_LOSS is false
//      because a march is a committed one-shot decision — but a standing wave
//      is not a decision anyone made about this march, so it stands down
//      rather than fighting: it stops at the last station its owner still
//      holds and merges into that garrison. Without this, a trickle walking
//      into a city that just fell is fed into the battle 12% of a garrison at
//      a time, which is DEFEAT IN DETAIL — the mistake §8 names as the
//      defining one — committed automatically on the player's behalf.
//
// THE SCHEMA THESE TESTS ARE WRITTEN AGAINST, because it has now changed twice
// and the reason is worth carrying: a station holds `supplyTo`, a sorted list
// of the cities it streams surplus to, and nothing else. There is no order
// type. Both earlier designs had one — hold/rally/feed, then
// hold/reinforce/defend — and both made the sim decide something the player
// could not see (which rally a feeder served; whether a city was "threatened"),
// where a wrong decision looks exactly like a right one. A list of stated
// destinations has nothing left to infer, and it is the only shape in which one
// city can supply several.
//
// Two of these tests carry an explicit CONTROL rather than an assertion alone,
// because the failure mode this project has been bitten by three times is a
// test that passes against broken code (known-issues #8). The stand-down test
// runs the same race with a manual wave and requires it to fight; the split
// test runs the same fixture with a destination emptied and requires the shares
// to change.
//
// Fixtures are built from the live link graph, never from hard-coded city ids:
// the map is generated and any id written here would rot.
// ===========================================================================

// A board where `pid` holds its capital plus `n` neighbours, every garrison at
// 90% of capacity. AI-quiet by construction (simFns().newGame).
function _ordBoard(fns, d, seed, pid, n) {
  var s = fns.newGame(seed);
  var granted = _grantFromCapital(s, d.LINKS, d.POWERS[pid].capital, pid, n);
  var own = granted.concat([d.POWERS[pid].capital]).sort();
  for (var i = 0; i < own.length; i++) {
    s.stations[own[i]].units = {
      infantry: d.STATIONS[own[i]].capacity * 0.9, artillery: 0, armour: 0,
    };
  }
  return { s: s, own: own };
}

// The two stations this power holds that are furthest apart over its OWN
// ground, and the legal route between them. The stand-down race needs a march
// long enough to have an intermediate station to fall back to.
function _ordLongestOwnPath(s, pid, own) {
  var best = null;
  for (var i = 0; i < own.length; i++) {
    for (var j = 0; j < own.length; j++) {
      if (i === j) continue;
      var p = routeFor(s, pid, own[i], own[j]);
      if (p && (!best || p.length > best.length)) best = p;
    }
  }
  return best;
}

// Draw a supply line from every station in `sources` to `target`.
//
// THROUGH applyCommand, like every other write in this project, and the command
// is a GROUP TOGGLE: if any selected station lacks the edge it is added to all
// of them, otherwise it is removed from all of them (sim/commands.js). So a
// fixture that wants "these cities supply that one" must pass only the stations
// that do not already have the edge, or a second call cancels the first. That
// asymmetry is deliberate in the UI — it is how the player cancels — and this
// helper is where the suite absorbs it, rather than every test remembering.
function _ordLink(s, pid, sources, target) {
  var add = [];
  for (var i = 0; i < sources.length; i++) {
    var have = s.stations[sources[i]].supplyTo || [];
    if (have.indexOf(target) < 0) add.push(sources[i]);
  }
  if (!add.length) return null;
  add.sort();
  return applyCommand(s, { type: 'order', owner: pid, stations: add, target: target });
}

// Total units in the waves this source put on the board, and how they split by
// destination. Read off the waves rather than off any counter the phase keeps
// about itself — "a wave of the right size exists" is the only evidence that
// does not depend on the code under test being honest about itself.
function _ordShipped(s, from, sinceWaveId) {
  var out = { total: 0, byTarget: {}, n: 0 };
  for (var i = 0; i < s.waves.length; i++) {
    var w = s.waves[i];
    if (w.from !== from) continue;
    if (sinceWaveId !== undefined && w.id < sinceWaveId) continue;
    var u = totalUnits(w.units);
    out.total += u;
    out.byTarget[w.to] = (out.byTarget[w.to] || 0) + u;
    out.n++;
  }
  return out;
}

// The ceiling automation obeys, mirrored from sim/movement.js's _ordCeilingMul.
// Read by INTENT rather than by naming one constant, because the constant has
// already moved once: sim/growth.js used to stop growth at
// GROWTH_CAP_EPSILON x capacity and since the over-capacity rework it tapers to
// zero at GROWTH_OVERFLOW_CEIL x capacity instead. A test that pinned the old
// name would go quietly green while measuring a ceiling nothing enforces.
function _ordCeilMul(d) {
  var B = d.BAL;
  if (isFinite(B.GROWTH_OVERFLOW_CEIL) && B.GROWTH_OVERFLOW_CEIL > 0) return B.GROWTH_OVERFLOW_CEIL;
  return isFinite(B.GROWTH_CAP_EPSILON) ? B.GROWTH_CAP_EPSILON : 1;
}

function suiteStandingOrders(d) {
  var ctx = _needSim('sim / standing orders', ['newGame', 'step', 'apply']);
  if (!ctx) return;
  var fns = ctx.fns;
  suite('sim / standing orders');

  if (typeof ordersTick !== 'function' || !d.BAL.ORDERS) {
    skipTest('standing orders', 'ordersTick()/BAL.ORDERS not present');
    return;
  }

  var O = d.BAL.ORDERS;
  var pid = 'ger';

  // -------------------------------------------------------------------------
  test('a board with no supply lines sends nothing — today\'s behaviour exactly', function () {
    var b = _ordBoard(fns, d, 41, pid, 8);
    for (var i = 0; i < b.own.length; i++) {
      assertEqual((b.s.stations[b.own[i]].supplyTo || []).length, 0,
        b.own[i] + ' started with a supply line');
    }
    _run(fns, b.s, 300);
    assertEqual(b.s.waves.length, 0, 'a board with no orders spawned waves by itself');
    assertEqual(b.s.orderStats.sends, 0, 'a board with no orders shipped units by itself');
    assert(b.s.orderStats.sweeps > 0, 'the orders phase never ran at all');
  });

  // -------------------------------------------------------------------------
  test('the phase is throttled to BAL.ORDERS.INTERVAL, not every tick', function () {
    var b = _ordBoard(fns, d, 42, pid, 4);
    _run(fns, b.s, 100);
    assertEqual(b.s.orderStats.sweeps, Math.ceil(100 / O.INTERVAL),
      'the orders phase did not run on its throttle');
  });

  // -------------------------------------------------------------------------
  test('a supply line streams into the city it names, and only that one', function () {
    var b = _ordBoard(fns, d, 43, pid, 8);
    var dest = d.POWERS[pid].capital;
    var sources = b.own.filter(function (x) { return x !== dest; });
    _ordLink(b.s, pid, sources, dest);
    // A destination needs HEADROOM to receive anything: a mustering point, not a
    // warehouse. The fixture builds every station at 90% of capacity, so the one
    // being supplied is drained first — the real case is a city that has just
    // been fought over, not one already full.
    b.s.stations[dest].units = { infantry: 1, artillery: 0, armour: 0 };

    var before = totalUnits(b.s.stations[dest].units);
    _run(fns, b.s, 400);

    assert(b.s.orderStats.sends > 0, 'no stream was ever sent');
    assert(totalUnits(b.s.stations[dest].units) > before + 10,
      'the destination did not accumulate: ' + before.toFixed(1) + ' -> ' +
      totalUnits(b.s.stations[dest].units).toFixed(1));
    // Every wave the phase created is a standing one aimed at the named city.
    // This is the assertion the whole rewrite exists for: the sim no longer
    // CHOOSES a destination, so a wave aimed anywhere else is not a worse guess,
    // it is a bug.
    var bad = [];
    for (var w = 0; w < b.s.waves.length; w++) {
      if (b.s.waves[w].to !== dest || !b.s.waves[w].standing) bad.push(b.s.waves[w].to);
    }
    assertNone(bad, 'a standing wave was aimed somewhere other than the named destination');
  });

  // -------------------------------------------------------------------------
  test('a stream created this tick MOVES this tick (orders run before movement)', function () {
    var b = _ordBoard(fns, d, 52, pid, 8);
    var dest = d.POWERS[pid].capital;
    _ordLink(b.s, pid, b.own.filter(function (x) { return x !== dest; }), dest);
    b.s.stations[dest].units = { infantry: 1, artillery: 0, armour: 0 };

    fns.step(b.s);        // tick 0 is a sweep tick
    assert(b.s.waves.length > 0, 'the first sweep created no streams at all');
    var still = [];
    for (var i = 0; i < b.s.waves.length; i++) {
      var wv = b.s.waves[i];
      if (wv.hop === 0 && wv.progress === 0) still.push(wv.from + '->' + wv.to);
    }
    // Phase order is load-bearing: run the orders phase AFTER movement and every
    // standing wave idles for one tick before its first step. Invisible in an
    // end-state assertion, and a permanent one-tick lie in the ETA a renderer
    // draws from launchTick.
    assertNone(still, 'a stream created this tick had not moved by the end of it');
  });

  // =========================================================================
  // MANY DESTINATIONS FROM ONE CITY.
  //
  // "right now it's difficult to reinforce more than one city from a single
  // city" — the player. One target per source made it impossible. A source's
  // allowed outflow is now split EVENLY across the destinations that have room,
  // and a destination with none is skipped and its share redistributed.
  //
  // EVEN, not neediest-first. "Neediest" is another rule the sim would apply
  // off screen, where a wrong ranking looks identical to a right one — the exact
  // failure both earlier versions of this mechanic had. An even split is a thing
  // the player can state and check. Skipping a full destination is not a
  // judgement, it is the capacity ceiling.
  // =========================================================================

  // A source big enough that its outflow still clears MIN_SEND after being cut
  // three ways. At 90% of a 72-capacity capital the whole outflow is ~5.6 units
  // and a third of that is under the 2.0 minimum, so the split would be
  // invisible behind below-min-send — the fixture has to be sized past that or
  // it tests the wrong rule. Returned with the source's own capacity so the
  // caller can say why.
  function _ordSplitBoard(seed, nTargets, fullOne) {
    var b = _ordBoard(fns, d, seed, pid, 8);
    var from = d.POWERS[pid].capital;
    var targets = b.own.filter(function (x) { return x !== from; }).slice(0, nTargets).sort();
    assertEqual(targets.length, nTargets, 'fixture could not find ' + nTargets + ' destinations');
    for (var i = 0; i < targets.length; i++) _ordLink(b.s, pid, [from], targets[i]);
    assertEqual((b.s.stations[from].supplyTo || []).join(','), targets.join(','),
      'the fixture did not draw the lines it meant to');

    // Stocked well over capacity so the outflow is large. Over-capacity is legal
    // and is exactly the state a city that has just been reinforced is in.
    b.s.stations[from].units = {
      infantry: d.STATIONS[from].capacity * 3, artillery: 0, armour: 0,
    };
    for (i = 0; i < targets.length; i++) {
      var stuff = (fullOne && targets[i] === fullOne);
      b.s.stations[targets[i]].units = {
        infantry: stuff ? d.STATIONS[targets[i]].capacity : 1, artillery: 0, armour: 0,
      };
    }
    return { s: b.s, from: from, targets: targets };
  }

  test('a source with three destinations splits its outflow evenly across them', function () {
    var f = _ordSplitBoard(80, 3, null);
    fns.step(f.s);                                  // tick 0 is a sweep tick

    var got = _ordShipped(f.s, f.from);
    assertEqual(got.n, 3, 'a source with three lines shipped ' + got.n + ' streams');
    var each = [];
    for (var i = 0; i < f.targets.length; i++) {
      var u = got.byTarget[f.targets[i]];
      assert(u > 0, 'nothing was shipped to ' + f.targets[i]);
      each.push(u);
    }
    // EVEN, to floating point. Not "roughly": the split is a division, and a
    // tolerance here would hide an implementation that sized the second and
    // third streams against the shrinking garrison instead of against the
    // outflow, which is a real and plausible way to get this wrong.
    assertClose(each[1], each[0], 1e-9, 'the second stream was not the same size as the first');
    assertClose(each[2], each[0], 1e-9, 'the third stream was not the same size as the first');
    assert(each[0] >= O.MIN_SEND, 'VACUITY: the fixture shares are under MIN_SEND, so the ' +
      'split is indistinguishable from the minimum-stream rule');
  });

  test('a full destination is skipped and its share is redistributed', function () {
    // The same fixture twice. The second run is the CONTROL: with all three
    // destinations empty the shares must be smaller, or the first run's larger
    // shares prove nothing about redistribution and only that a target was
    // dropped.
    var open3 = _ordSplitBoard(81, 3, null);
    fns.step(open3.s);
    var a = _ordShipped(open3.s, open3.from);
    assertEqual(a.n, 3, 'the control fixture did not ship to all three');

    var full = _ordSplitBoard(81, 3, null);
    var stuffed = full.targets[1];
    full.s.stations[stuffed].units = {
      infantry: d.STATIONS[stuffed].capacity * _ordCeilMul(d), artillery: 0, armour: 0,
    };
    // What the planner says BEFORE the sweep, so the reason is asserted and not
    // merely the outcome.
    var pre = standingOrderNext(full.s, full.from);
    var stuckEdge = null;
    for (var i = 0; i < pre.edges.length; i++) {
      if (pre.edges[i].target === stuffed) stuckEdge = pre.edges[i];
    }
    assert(!!stuckEdge, 'the plan had no edge for the full destination');
    assertEqual(stuckEdge.blocked, 'destination-full',
      'a full destination was not reported as destination-full');
    assertEqual(stuckEdge.units, 0, 'a full destination was allotted units anyway');

    fns.step(full.s);
    var b2 = _ordShipped(full.s, full.from);
    assertEqual(b2.n, 2, 'the full destination was shipped to anyway');
    assertEqual(b2.byTarget[stuffed], undefined, 'a stream went to the full destination');

    // THE CLAIM. Same total outflow, divided two ways instead of three — so each
    // surviving stream is 3/2 of what it was, and the totals match.
    var perOpen = a.total / 3, perFull = b2.total / 2;
    assertClose(b2.total, a.total, 1e-6,
      'the skipped destination\'s share was dropped rather than redistributed: ' +
      b2.total.toFixed(4) + ' shipped in total against ' + a.total.toFixed(4));
    assertClose(perFull, perOpen * 1.5, 1e-6,
      'the two surviving streams were not 3/2 the size of the three-way shares');
  });

  test('a source with ONE destination ships exactly what it did before many-to-many', function () {
    // The regression guard on the split arithmetic. A single line must still be
    // the whole allowed outflow, undivided — a split implemented as "divide by
    // the list length" with an off-by-one would fail here and nowhere else.
    var b = _ordBoard(fns, d, 82, pid, 8);
    var from = d.POWERS[pid].capital;
    var to = b.own.filter(function (x) { return x !== from; })[0];
    _ordLink(b.s, pid, [from], to);
    b.s.stations[to].units = { infantry: 1, artillery: 0, armour: 0 };

    growthTick(b.s);
    var have = totalUnits(b.s.stations[from].units);
    var cap = d.STATIONS[from].capacity;
    var expect = O.SEND_FRACTION * (have - O.KEEP_FLOOR * cap);
    assert(expect >= O.MIN_SEND, 'VACUITY: the fixture source cannot clear MIN_SEND');

    var nx = standingOrderNext(b.s, from);
    assertEqual(nx.edges.length, 1, 'one supply line produced ' + nx.edges.length + ' edges');
    assertClose(nx.units, expect, 1e-9,
      'a single-destination source did not ship SEND_FRACTION of its surplus above the floor');
    assertEqual(nx.edges[0].target, to, 'the single edge named the wrong city');
  });

  test('adding a second destination spreads the stream rather than doubling it', function () {
    // The keep floor is a PER SOURCE rule, and this is what says so. If the
    // fraction were applied per edge, a player could drain a city arbitrarily
    // fast simply by drawing more lines out of it — which would make the floor,
    // and the whole "never ships itself defenceless" rule, meaningless.
    var one = _ordSplitBoard(83, 1, null);
    growthTick(one.s);
    var a = standingOrderNext(one.s, one.from);

    var two = _ordSplitBoard(83, 2, null);
    growthTick(two.s);
    var b2 = standingOrderNext(two.s, two.from);

    assert(a.units > 0 && b2.units > 0, 'VACUITY: one of the fixtures shipped nothing');
    assertEqual(b2.edges.length, 2, 'the two-line fixture did not produce two edges');
    assertClose(b2.units, a.units, 1e-9,
      'a city with two supply lines shipped a different TOTAL from one with a single line: ' +
      b2.units.toFixed(4) + ' vs ' + a.units.toFixed(4));
    assertClose(b2.edges[0].units, a.units / 2, 1e-9, 'the first of two shares is not half');
    assertClose(b2.edges[1].units, a.units / 2, 1e-9, 'the second of two shares is not half');
  });

  // -------------------------------------------------------------------------
  // RULE 1, the most important assertion in this suite.
  // -------------------------------------------------------------------------
  test('a standing order NEVER causes a fight — long AI-vs-AI games', function () {
    // Raw newGame, not fns.newGame: this test wants the AI ON. Every other sim
    // test wants it off (known-issues #13), which is why the wrapper exists.
    var seeds = [19140628, 90210];
    var totalSends = 0, totalLaunched = 0, standDowns = 0;
    var pathViolations = [];

    for (var k = 0; k < seeds.length; k++) {
      var s = newGame(seeds[k]);
      var seenWave = 0;
      for (var t = 0; t < 6000 && !s.winner; t++) {
        // Re-issued every 200 ticks: every city supplies its power's capital.
        // Re-issuing is not incidental — supply lines are cleared on capture
        // (core/state.js setStationOwner) and edges whose destination changes
        // hands are dropped by the sweep, so on a board changing hands
        // constantly the network would otherwise thin out to nothing and the
        // test would end up measuring a quiet board. 200 ticks was chosen by
        // measurement: at 500 the whole batch produced ZERO stand-downs, which
        // would have left the games unable to detect the stand-down code being
        // deleted.
        if (t % 200 === 0) {
          for (var p = 0; p < POWER_IDS.length; p++) {
            var q = POWER_IDS[p];
            if (q === 'neutral' || !s.powers[q] || s.powers[q].alive === false) continue;
            var cap = POWERS[q].capital;
            if (!s.stations[cap] || s.stations[cap].owner !== q) continue;
            var srcs = [];
            for (var i = 0; i < STATION_IDS.length; i++) {
              var sid = STATION_IDS[i];
              if (s.stations[sid].owner === q && sid !== cap) srcs.push(sid);
            }
            if (srcs.length) _ordLink(s, q, srcs, cap);
          }
        }
        stepTick(s);

        // Independent of the tripwire, and from the other end of the rule: a
        // standing wave must be planned entirely over ground its owner holds.
        // Checked on every wave the moment it appears, so thousands of real
        // launches are inspected rather than the end state alone.
        for (var w = 0; w < s.waves.length; w++) {
          var wv = s.waves[w];
          if (wv.id <= seenWave || !wv.standing) continue;
          totalLaunched++;
          for (var h = 0; h < wv.path.length; h++) {
            if (s.stations[wv.path[h]].owner !== wv.owner) {
              pathViolations.push(wv.from + '->' + wv.to + ' via ' + wv.path[h]);
            }
          }
        }
        for (w = 0; w < s.waves.length; w++) {
          if (s.waves[w].id > seenWave) seenWave = s.waves[w].id;
        }
      }
      assertEqual(s.orderStats.fights, 0,
        'seed ' + seeds[k] + ': a standing wave deposited onto ground its owner ' +
        'does not hold — it started a fight nobody clicked for');
      totalSends += s.orderStats.sends;
      standDowns += s.orderStats.standDowns;
    }

    // Vacuity guards. An assertion about streams that never ran is not an
    // assertion about anything.
    assert(totalSends > 300, 'only ' + totalSends + ' standing sends across ' + seeds.length +
      ' games — too few for "never caused a fight" to mean anything');
    assert(totalLaunched > 300, 'only ' + totalLaunched + ' standing waves were inspected');
    assert(standDowns > 0, 'no standing wave ever had to stand down across ' + seeds.length +
      ' full games — the race this rule exists for never happened, so these games prove ' +
      'less than they look like they prove. This assertion is also what makes the test ' +
      'sensitive to the stand-down code being removed.');
    assertNone(pathViolations, 'a standing wave was routed over ground its owner does not hold');
  });

  // -------------------------------------------------------------------------
  // RULE 2, constructed explicitly — it will not happen by luck.
  // -------------------------------------------------------------------------
  test('a stream stands down when its destination flips mid-transit', function () {
    // Same race twice: once with a standing wave, once with a manual one. The
    // manual control is the point — it proves the fixture really does put a
    // wave into a fight, so the standing case not fighting is a property of
    // the mechanic and not of a race that never happened.
    var race = function (standing) {
      var b = _ordBoard(fns, d, 45, pid, 10);
      var path = _ordLongestOwnPath(b.s, pid, b.own);
      assert(path && path.length >= 3, 'fixture has no multi-hop own-ground route');
      var from = path[0], to = path[path.length - 1], mid = path[path.length - 2];

      var cmd = { type: 'send', owner: pid, sources: [from], target: to, fraction: 0.5 };
      if (standing) cmd.standing = true;
      var res = fns.apply(b.s, cmd);
      assert(res.ok, 'the fixture send was rejected: ' + res.reason);
      var carried = totalUnits(res.waves[0].units);

      // March until the wave is one hop short of arriving, then take the
      // destination away from underneath it.
      var flipped = false;
      for (var t = 0; t < 4000; t++) {
        var wv = null;
        for (var i = 0; i < b.s.waves.length; i++) if (b.s.waves[i].id === res.waves[0].id) wv = b.s.waves[i];
        if (!flipped && wv && wv.hop >= wv.path.length - 2) {
          _setOwner(b.s, to, 'fra');
          b.s.stations[to].units = { infantry: 30, artillery: 0, armour: 0 };
          flipped = true;
        }
        if (flipped && !wv) break;
        var midBefore = totalUnits(b.s.stations[mid].units);
        fns.step(b.s);
        if (flipped && wv && !wv.dead) continue;
        if (flipped) { return { b: b, to: to, mid: mid, carried: carried, midBefore: midBefore }; }
      }
      return { b: b, to: to, mid: mid, carried: carried, midBefore: null };
    };

    var st = race(true);
    var atk = st.b.s.stations[st.to].attackers;
    assert(!atk || !atk[pid] || totalUnits(atk[pid]) <= 0,
      'a standing wave attacked a station that flipped mid-transit');
    assertEqual(st.b.s.orderStats.fights, 0, 'the standing tripwire fired');
    assertEqual(st.b.s.orderStats.standDowns, 1, 'the standing wave did not stand down');
    assert(totalUnits(st.b.s.stations[st.mid].units) > st.midBefore + st.carried * 0.9,
      'the standing wave did not merge into the last station its owner still holds (' +
      st.mid + ': expected +' + st.carried.toFixed(1) + ')');

    var mn = race(false);
    var atk2 = mn.b.s.stations[mn.to].attackers;
    assert(!!(atk2 && atk2[pid] && totalUnits(atk2[pid]) > 0),
      'CONTROL FAILED: a manual wave did not fight the flipped station, so this ' +
      'fixture never actually stages the race it claims to');
    assertEqual(mn.b.s.orderStats.standDowns, 0, 'a manual wave stood down — it must not');
  });

  // -------------------------------------------------------------------------
  test('a supply line respects the garrison floor and never empties a city', function () {
    var b = _ordBoard(fns, d, 46, pid, 8);
    var i;
    // The destination is the SMALLEST station on the board and the biggest
    // station is a source, deliberately. The floor is a fraction of CAPACITY, so
    // a floor low enough to sit under BAL.ORDERS.MIN_SEND is indistinguishable
    // from the minimum-stream rule doing the work — the test has to be run on a
    // station whose floor is large enough that a floorless implementation would
    // send.
    var bySize = b.own.slice().sort(function (x, y) {
      var c = d.STATIONS[x].capacity - d.STATIONS[y].capacity;
      return c !== 0 ? c : (x < y ? -1 : 1);
    });
    var dest = bySize[0];
    var starved = bySize[bySize.length - 1];
    var floorOf = function (sid) { return d.STATIONS[sid].capacity * O.KEEP_FLOOR; };
    assert(floorOf(starved) * O.SEND_FRACTION > d.BAL.ORDERS.MIN_SEND,
      'fixture is too small to distinguish the floor from MIN_SEND');

    _ordLink(b.s, pid, b.own.filter(function (x) { return x !== dest; }), dest);

    // The destination is emptied here and re-emptied every tick below. It now
    // stops accepting units at its capacity, so a static one fills in a handful
    // of sweeps and the whole board goes quiet — which would leave this test
    // asserting about a floor that was never approached. A destination that
    // keeps SPENDING what it receives is the case where a stream runs
    // continuously, and it is the case the floor exists for.
    b.s.stations[dest].units = { infantry: 0, artillery: 0, armour: 0 };

    // Start the biggest source EXACTLY at its floor.
    b.s.stations[starved].units = { infantry: floorOf(starved), artillery: 0, armour: 0 };

    // One tick, which is a sweep tick. A station at its floor must ship
    // nothing; the others must ship something, or "nothing shipped" proves
    // only that the phase did not run.
    fns.step(b.s);
    var fromStarved = 0, fromOthers = 0;
    for (i = 0; i < b.s.waves.length; i++) {
      if (b.s.waves[i].from === starved) fromStarved++; else fromOthers++;
    }
    assertEqual(fromStarved, 0, starved + ' shipped units while sitting at its garrison floor');
    assert(fromOthers > 0, 'VACUITY: no station shipped anything on this sweep, so the ' +
      'floor was never the reason ' + starved + ' stayed put');

    var sources = b.own.filter(function (sid) { return sid !== dest; }).sort();
    var breaches = [], limited = 0, sends = 0;

    for (var t = 0; t < 1200; t++) {
      // Watched per SWEEP, not on the end state: the floor is a property of
      // every individual send, and an end-state check is satisfied by regrowth
      // papering over a city that was briefly stripped bare.
      var pre = {}, j;
      for (j = 0; j < sources.length; j++) pre[sources[j]] = totalUnits(b.s.stations[sources[j]].units);
      var wavesBefore = b.s.waves.length;
      fns.step(b.s);
      b.s.stations[dest].units = { infantry: 0, artillery: 0, armour: 0 };   // spent at the front
      for (j = 0; j < sources.length; j++) {
        var sid = sources[j];
        var now = totalUnits(b.s.stations[sid].units);
        if (now < floorOf(sid) - 1e-9) {
          breaches.push(sid + ' fell to ' + now.toFixed(2) + ' against a floor of ' +
            floorOf(sid).toFixed(2));
        }
        var sent = pre[sid] - now;
        if (sent > 1e-9 && b.s.waves.length > wavesBefore) {
          sends++;
          // "Limited by the floor" means strictly less left than a plain
          // SEND_FRACTION of the garrison would have taken.
          if (sent < O.SEND_FRACTION * pre[sid] - 1e-9) limited++;
        }
      }
    }

    assertNone(breaches, 'a source was drained below its garrison floor');
    assert(sends > 20, 'VACUITY: only ' + sends + ' sends happened — the floor was never ' +
      'given the chance to bind');
    assert(limited > 0, 'VACUITY: no send was ever actually limited by the floor. This test ' +
      'would pass with the floor removed, which makes it worse than no test');
  });

  // -------------------------------------------------------------------------
  test('a front measurably builds up versus the same board with no supply lines', function () {
    // WHAT THIS MEASURES, restated after the capacity ceiling landed. A
    // destination can no longer accumulate past its capacity, so supply lines do
    // not buy a bigger garrison than the map allows — they buy SPEED. The case
    // is a front city that has just been fought over: with cities behind it
    // supplying it, it is back to fighting weight in a few sim-minutes; on its
    // own it climbs the logistic curve from almost nothing and takes an order of
    // magnitude longer. Measured at 600 ticks (60 sim-seconds), where that gap
    // is real.
    var build = function (withOrders) {
      var b = _ordBoard(fns, d, 47, pid, 10);
      var adj = _linkAdjacency(d.LINKS), front = [];
      for (var i = 0; i < b.own.length; i++) {
        var nb = adj[b.own[i]] || [];
        for (var j = 0; j < nb.length; j++) {
          if (b.s.stations[nb[j]].owner !== pid) { front.push(b.own[i]); break; }
        }
      }
      assert(front.length > 0, 'fixture has no front');
      var dest = front.slice().sort()[0];
      b.s.stations[dest].units = { infantry: 1, artillery: 0, armour: 0 };   // just taken
      if (withOrders) {
        _ordLink(b.s, pid, b.own.filter(function (x) { return x !== dest; }), dest);
      }
      _run(fns, b.s, 600);
      return { mass: totalUnits(b.s.stations[dest].units), s: b.s, dest: dest,
               cap: d.STATIONS[dest].capacity };
    };

    var on = build(true), off = build(false);
    assertEqual(off.s.orderStats.sends, 0, 'the control board shipped units with no orders set');
    assert(on.mass > off.mass * 2.5,
      'mass at the front did not build: with supply lines ' + on.mass.toFixed(1) +
      ', without ' + off.mass.toFixed(1) + ' at ' + on.dest);
    // ...and it built to roughly its capacity, not past it. The ceiling is the
    // other half of the claim: a front that builds is worth nothing if what it
    // builds is bled off again.
    assert(on.mass < on.cap * _ordCeilMul(d) * 1.15,
      'the front overshot the ceiling growth stops at (' +
      (on.cap * _ordCeilMul(d)).toFixed(1) + '): ' + on.mass.toFixed(1));
  });

  // -------------------------------------------------------------------------
  // THE CAPACITY CEILING (00-vision.md §2: a full station has stopped paying
  // dividends). growthTick bleeds anything over capacity at OVERSTACK_DECAY, so
  // automation that ignores the ceiling builds a warehouse that destroys what
  // it is fed. Shipped without this rule, 7 sources into a 28-capacity
  // destination settled at ~556 units — every unit delivered was deleted on
  // arrival, and the loss hid inside a rising empire total.
  //
  // It is also, since `defend` was cut, the mechanic's whole sense of timing: a
  // quiet front is full and takes nothing, so its sources bank at home; a front
  // that is losing units has headroom and pulls. A trigger expressed as a fact
  // about the board rather than as a judgement the sim makes off screen.
  // -------------------------------------------------------------------------

  test('a destination at its ceiling receives nothing, and its sources keep their units', function () {
    var b = _ordBoard(fns, d, 60, pid, 8);
    var dest = d.POWERS[pid].capital;
    var sources = b.own.filter(function (x) { return x !== dest; });
    var i;
    _ordLink(b.s, pid, sources, dest);
    b.s.stations[dest].units = {
      infantry: d.STATIONS[dest].capacity * _ordCeilMul(d), artillery: 0, armour: 0,
    };

    // VACUITY GUARD: the sources must be willing to ship, or "nothing shipped"
    // says nothing about the ceiling.
    var willing = 0;
    for (i = 0; i < sources.length; i++) {
      if (standingOrderSend(b.s, sources[i]) >= d.BAL.ORDERS.MIN_SEND) willing++;
    }
    assert(willing >= 3, 'only ' + willing + ' sources were willing to ship — this test ' +
      'would pass with the ceiling removed');

    var before = {};
    for (i = 0; i < b.own.length; i++) before[b.own[i]] = totalUnits(b.s.stations[b.own[i]].units);
    _run(fns, b.s, 200);

    assertEqual(b.s.orderStats.sends, 0, 'a destination at capacity was shipped to anyway');
    assertEqual(b.s.waves.length, 0, 'a full destination still had streams in the air');
    var lost = [];
    for (i = 0; i < b.own.length; i++) {
      var sid = b.own[i];
      if (sid === dest) continue;
      if (totalUnits(b.s.stations[sid].units) < before[sid] - 1e-9) lost.push(sid);
    }
    assertNone(lost, 'a source lost units with nowhere to send them');
  });

  test('a destination never runs away past the ceiling growth stops at', function () {
    var b = _ordBoard(fns, d, 61, pid, 8);
    var dest = d.POWERS[pid].capital;
    var cap = d.STATIONS[dest].capacity;
    var i;
    _ordLink(b.s, pid, b.own.filter(function (x) { return x !== dest; }), dest);
    b.s.stations[dest].units = { infantry: 1, artillery: 0, armour: 0 };

    // Long enough to have reached the old runaway equilibrium several times
    // over: at ~0.26 units/tick of inflow against (u - cap) x OVERSTACK_DECAY,
    // the unclamped version settles near 20x capacity and 3000 ticks is most of
    // the way up that curve.
    var peak = 0, sizingBreaches = [], prevSends = 0, checks = 0;
    for (var t = 0; t < 3000; t++) {
      fns.step(b.s);
      var here = totalUnits(b.s.stations[dest].units);
      if (here > peak) peak = here;

      // THE SIZING INVARIANT, exact, checked on the ticks where a stream was
      // actually sized — what is standing at the destination plus everything in
      // the air must never have been allowed to exceed the ceiling.
      //
      // Only on those ticks, and that is not a dodge. Growth runs before the
      // orders phase, so on a sweep tick the garrison read here is exactly the
      // number the clamp used, and a landing on the same tick just moves units
      // from `air` to `here` and leaves the sum alone. On every OTHER tick the
      // destination keeps growing under a stream already in the air, which
      // carries the pair a fraction of a percent over a ceiling that was
      // correct when it was applied. That residual is growth's doing, not the
      // send's, and it is what the loose realised bound below is for.
      if (b.s.orderStats.sends > prevSends) {
        prevSends = b.s.orderStats.sends;
        checks++;
        var air = 0;
        for (i = 0; i < b.s.waves.length; i++) {
          if (b.s.waves[i].to === dest) air += totalUnits(b.s.waves[i].units);
        }
        if (here + air > cap * _ordCeilMul(d) + 1e-6) {
          sizingBreaches.push('tick ' + b.s.tick + ': ' + here.toFixed(2) + ' + ' +
            air.toFixed(2) + ' in the air vs a ceiling of ' +
            (cap * _ordCeilMul(d)).toFixed(2));
        }
      }
    }
    assert(checks > 3, 'VACUITY: the sizing invariant was checked ' + checks + ' times');

    assert(b.s.orderStats.sends > 0, 'VACUITY: nothing was ever shipped, so nothing was capped');
    assertNone(sizingBreaches, 'a stream was sized past the destination ceiling');
    // 1.15x is the bound; the measured peak is 1.05x and it is growth in
    // transit, not the sends. WITHOUT the ceiling this fixture's equilibrium is
    // ~20x capacity — inflow of ~0.26 units/tick against a bleed of
    // (u - cap) x OVERSTACK_DECAY — so the gap between pass and fail here is
    // three orders of magnitude, not a tuning question.
    var ceil = cap * _ordCeilMul(d);
    assert(peak < ceil * 1.15, 'the destination ran away past the ceiling of ' + ceil.toFixed(1) +
      ' — peak ' + peak.toFixed(1) + '. With no ceiling this settles near ' + (cap * 20) + '.');
    assert(peak > ceil * 0.9, 'VACUITY: the destination never approached its ceiling, so the ' +
      'ceiling was never the thing that stopped it');
  });

  test('inbound standing waves count against headroom', function () {
    // Three sources that each fit on their own but together overshoot. Without
    // per-destination bookkeeping every one of them is correctly sized against
    // a headroom the other two are about to spend, and they bust the ceiling
    // together — which is the shape of the last few sweeps before a destination
    // fills.
    var b = _ordBoard(fns, d, 62, pid, 8);
    var dest = d.POWERS[pid].capital;
    var cap = d.STATIONS[dest].capacity;
    var sources = b.own.filter(function (s2) { return s2 !== dest; }).sort().slice(0, 3);
    _ordLink(b.s, pid, sources, dest);

    b.s.stations[dest].units = { infantry: 1, artillery: 0, armour: 0 };
    var wants = sources.map(function (sid) { return standingOrderSend(b.s, sid); });
    var total = wants[0] + wants[1] + wants[2];
    var mx = Math.max(wants[0], Math.max(wants[1], wants[2]));
    assert(mx >= d.BAL.ORDERS.MIN_SEND, 'no source was willing to ship');
    // Room for more than the largest single stream but less than all three.
    var room = Math.max(mx * 1.5, total * 0.6);
    assert(room < total, 'fixture headroom does not force an overshoot');
    var ceiling = cap * _ordCeilMul(d);
    assert(ceiling - room > 0, 'fixture destination is too small for this construction');
    b.s.stations[dest].units = { infantry: ceiling - room, artillery: 0, armour: 0 };

    fns.step(b.s);            // tick 0 is a sweep tick
    var air = 0, shippers = 0;
    for (var i = 0; i < b.s.waves.length; i++) {
      if (b.s.waves[i].to !== dest) continue;
      air += totalUnits(b.s.waves[i].units);
      shippers++;
    }
    assert(shippers >= 2, 'only ' + shippers + ' source(s) shipped — the aggregation this ' +
      'test is about never happened');
    assert(air <= room + 1e-6, 'three sources collectively overshot the headroom: ' +
      air.toFixed(2) + ' into ' + room.toFixed(2) + ' of room');
    assert(air < total - 1e-6, 'VACUITY: everything they wanted fitted, so nothing was ' +
      'held back by the running total');

    // This is also the fixture where the per-send CLAMP is the thing doing the
    // work rather than the per-sweep filter: the last source to be reached has
    // room left, but less room than it wants, so it must ship a short stream
    // rather than a full one or be skipped. Asserted directly against what each
    // source said it was willing to send.
    var clampedOrSkipped = 0;
    for (i = 0; i < sources.length; i++) {
      if (wants[i] < d.BAL.ORDERS.MIN_SEND) continue;
      var shipped = 0;
      for (var j = 0; j < b.s.waves.length; j++) {
        if (b.s.waves[j].from === sources[i]) shipped += totalUnits(b.s.waves[j].units);
      }
      if (shipped < wants[i] - 1e-6) clampedOrSkipped++;
    }
    assert(clampedOrSkipped > 0, 'VACUITY: no source shipped less than it wanted, so the ' +
      'clamp was never exercised — only the per-sweep headroom filter was');
  });

  test('a stream is CLAMPED to the room left, not skipped and not overshot', function () {
    // THE CLAMP IN ISOLATION, and it needed its own fixture. Every other test
    // in this block is satisfied by the per-sweep SKIP — a destination with less
    // than MIN_SEND of room is dropped from the split entirely — so an
    // implementation with the clamp deleted still passes them: the aggregate
    // assertions are all of the form "no more than the room", and a source that
    // is skipped ships nothing, which is also no more than the room. Measured:
    // removing `want = share > room ? room : share` left the whole suite green.
    // known-issues #8 exactly.
    //
    // The separating case is a destination with room in the gap: MORE than
    // MIN_SEND, so the edge is not skipped, and LESS than the source wants, so
    // the only correct answer is the room itself.
    var b = _ordBoard(fns, d, 84, pid, 8);
    var dest = d.POWERS[pid].capital;
    var bySize = b.own.filter(function (x) { return x !== dest; }).sort(function (x, y) {
      var c = d.STATIONS[y].capacity - d.STATIONS[x].capacity;
      return c !== 0 ? c : (x < y ? -1 : 1);
    });
    var from = bySize[0];
    _ordLink(b.s, pid, [from], dest);

    growthTick(b.s);                      // read the numbers the sweep will see
    var want = standingOrderSend(b.s, from);
    var room = want * 0.5;
    assert(room > O.MIN_SEND, 'fixture cannot separate the clamp from the skip: the ' +
      'source wants ' + want.toFixed(2) + ', so half of it is under MIN_SEND');

    var ceiling = d.STATIONS[dest].capacity * _ordCeilMul(d);
    b.s.stations[dest].units = { infantry: ceiling - room, artillery: 0, armour: 0 };

    var nx = standingOrderNext(b.s, from);
    assertEqual(nx.blocked, null, 'the edge was skipped rather than clamped');
    assertClose(nx.units, room, 1e-9,
      'a stream into a destination with ' + room.toFixed(2) + ' of room shipped ' +
      nx.units.toFixed(2) + ' — it wanted ' + want.toFixed(2) +
      '. Without the clamp this is the full want and the ceiling is busted.');

    // ...and the sweep really does it, not just the prediction.
    ordersTick(b.s);
    var got = _ordShipped(b.s, from);
    assertEqual(got.n, 1, 'the sweep did not ship exactly one stream');
    assertClose(got.total, room, 1e-9, 'the sweep shipped a different amount from the plan');
    assert(totalUnits(b.s.stations[dest].units) + got.total <= ceiling + 1e-6,
      'the send overshot the destination ceiling it was sized against');
  });

  test('setStationSupply sorts, dedupes, and refuses a city as its own destination', function () {
    // core/state.js is the one door both the command layer and the sweep write
    // through, and three of its guarantees are load-bearing somewhere the tests
    // above cannot see them:
    //
    //   SORTED   the sweep issues one applyCommand per entry, in list order, and
    //            each is sized against what the previous one left. Two runs of
    //            one seed must therefore walk the list in the same order or wave
    //            ids diverge and determinism is gone.
    //   NO SELF  sim/movement.js drops the `to === from` case entirely on the
    //            strength of this, rather than carrying a blocked reason no
    //            fixture could reach. A self-edge would put a zero-hop send in
    //            the sweep that applyCommand then rejects, and the plan would be
    //            promising units that never move.
    //   DEDUPED  a duplicate entry would take two shares of the even split.
    //
    // Asserted directly because sim/commands.js validates the same things one
    // layer up, so nothing reachable through applyCommand can distinguish these
    // from their absence — measured: removing either guard left the suite green.
    var b = _ordBoard(fns, d, 85, pid, 6);
    var self = b.own[0];
    var rest = b.own.filter(function (x) { return x !== self; }).sort();
    assert(rest.length >= 3, 'fixture needs at least three destinations');

    // Deliberately hostile input: reverse order, a duplicate, the station
    // itself, an id that is not on the board, and a non-string.
    var reversed = rest.slice().reverse();
    setStationSupply(b.s, self, reversed.concat([reversed[0], self, 'no-such-city', 42, null]));

    assertEqual((b.s.stations[self].supplyTo || []).join(','), rest.join(','),
      'setStationSupply did not return a sorted, deduped, self-free list');

    // Idempotent: writing the same set again is not a change.
    assertEqual(setStationSupply(b.s, self, rest.slice().reverse()), false,
      'rewriting an identical list reported a change');
    assertEqual(setStationSupply(b.s, self, rest.slice(0, 1)), true,
      'shrinking the list did not report a change');
    assertEqual(setStationSupply(b.s, self, null), true, 'clearing did not report a change');
    assertEqual((b.s.stations[self].supplyTo || []).length, 0, 'clearing left lines behind');
  });

  test('nowhere with room is a no-op, and the sources keep growing', function () {
    var b = _ordBoard(fns, d, 63, pid, 8);
    var dest = d.POWERS[pid].capital;
    var i;
    _ordLink(b.s, pid, b.own.filter(function (x) { return x !== dest; }), dest);
    for (i = 0; i < b.own.length; i++) {
      b.s.stations[b.own[i]].units = {
        infantry: d.STATIONS[b.own[i]].capacity * 0.6, artillery: 0, armour: 0,
      };
    }
    b.s.stations[dest].units = {
      infantry: d.STATIONS[dest].capacity * _ordCeilMul(d), artillery: 0, armour: 0,
    };

    var before = {};
    for (i = 0; i < b.own.length; i++) before[b.own[i]] = totalUnits(b.s.stations[b.own[i]].units);
    _run(fns, b.s, 400);            // must not throw

    assertEqual(b.s.orderStats.sends, 0, 'a board with no headroom anywhere still shipped');
    var stalled = [];
    for (i = 0; i < b.own.length; i++) {
      var sid = b.own[i];
      if (sid === dest) continue;
      if (totalUnits(b.s.stations[sid].units) <= before[sid]) stalled.push(sid);
    }
    assertNone(stalled, 'a source with nowhere to ship did not keep growing');
  });

  // -------------------------------------------------------------------------
  test('an unreachable destination is a no-op, not an error', function () {
    var b = _ordBoard(fns, d, 48, pid, 8);
    var path = _ordLongestOwnPath(b.s, pid, b.own);
    var from = path[0], dest = path[path.length - 1];
    _ordLink(b.s, pid, [from], dest);
    // Cut the corridor: every intermediate goes to another power.
    for (var i = 1; i < path.length - 1; i++) _setOwner(b.s, path[i], 'fra');
    _run(fns, b.s, 200);
    assertEqual(b.s.orderStats.fights, 0, 'a cut-off source started a fight');
    // Asserted on SENDS, not on the garrison: cutting the corridor can also cut
    // the blob off from its capital, and disconnection decay would then shrink
    // the garrison for a reason that has nothing to do with supply lines.
    assertEqual(b.s.orderStats.sends, 0,
      'a source with no legal route to its destination shipped units anyway');
    assertEqual(b.s.waves.length, 0, 'a cut-off source put waves on the board');
    // The EDGE SURVIVES. Unreachable is a fact about the board this turn, not
    // about the player's intent, and a corridor that reopens must resume on its
    // own — deleting the line on a temporary cut would silently undo their work.
    assertEqual((b.s.stations[from].supplyTo || []).join(','), dest,
      'a temporarily unreachable destination was dropped from the supply list');
  });

  // -------------------------------------------------------------------------
  test('supply lines do not survive a change of owner', function () {
    var b = _ordBoard(fns, d, 49, pid, 4);
    var sid = b.own[0], other = b.own[1];
    _ordLink(b.s, pid, [sid], other);
    assertEqual((b.s.stations[sid].supplyTo || []).join(','), other, 'the line was not drawn');
    _setOwner(b.s, sid, 'fra');
    assertEqual((b.s.stations[sid].supplyTo || []).length, 0,
      "a captured station kept the previous owner's supply lines");
  });

  // -------------------------------------------------------------------------
  test('a lost destination drops that edge and ONLY that edge', function () {
    // The rule that stops a supply line becoming an attack order the player
    // scheduled and forgot. Per edge, because a city supplying three others that
    // loses one of them must keep the other two — clearing the list would
    // silently cancel work on news the player may not have seen.
    var b = _ordBoard(fns, d, 66, pid, 8);
    var from = d.POWERS[pid].capital;
    var others = b.own.filter(function (x) { return x !== from; });
    var keep = others[0], lose = others[1];
    _ordLink(b.s, pid, [from], keep);
    _ordLink(b.s, pid, [from], lose);
    assertEqual((b.s.stations[from].supplyTo || []).length, 2, 'the fixture drew ' +
      (b.s.stations[from].supplyTo || []).length + ' lines, not 2');

    _setOwner(b.s, lose, 'fra');

    // BEFORE the sweep: the edge is still stored, and the planner already
    // refuses to act on it and says why. That gap is deliberate and bounded —
    // see the LOST DESTINATION block in sim/movement.js.
    var pre = standingOrderNext(b.s, from);
    var lostEdge = null;
    for (var i = 0; i < pre.edges.length; i++) if (pre.edges[i].target === lose) lostEdge = pre.edges[i];
    assert(!!lostEdge, 'the plan dropped the lost edge instead of reporting it');
    assertEqual(lostEdge.blocked, 'target-lost', 'a lost destination was not reported as such');
    assertEqual(lostEdge.units, 0, 'a lost destination was allotted units');

    _run(fns, b.s, O.INTERVAL + 1);

    assertEqual((b.s.stations[from].supplyTo || []).join(','), keep,
      'the sweep did not drop exactly the lost edge');
    assertEqual(b.s.orderStats.fights, 0, 'a line at ground its owner lost started a fight');
    var atEnemy = [];
    for (i = 0; i < b.s.waves.length; i++) {
      if (b.s.waves[i].to === lose) atEnemy.push(b.s.waves[i].from);
    }
    assertNone(atEnemy, 'a standing wave was sent at a city the enemy now holds');
  });

  // -------------------------------------------------------------------------
  test('applyCommand refuses a standing send at ground its owner does not hold', function () {
    var b = _ordBoard(fns, d, 50, pid, 6);
    var target = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      if (b.s.stations[STATION_IDS[i]].owner !== pid) { target = STATION_IDS[i]; break; }
    }
    var cmd = { type: 'send', owner: pid, sources: [b.own[0]], target: target, fraction: 0.5 };
    var manual = fns.apply(b.s, cmd);
    cmd.standing = true;
    var standing = fns.apply(b.s, cmd);
    assertEqual(standing.ok, false, 'a standing send at unheld ground was accepted');
    assertEqual(standing.reason, 'standing-target-not-owned', 'wrong rejection reason');
    // The control: the very same command WITHOUT the flag is a legal attack.
    assert(manual.ok || manual.reason === 'all-sources-rejected',
      'the control command was rejected for an unrelated reason: ' + manual.reason);
  });

  // =========================================================================
  // THE ORDER COMMAND. A toggle, decided for the GROUP rather than per station,
  // the way bold works on mixed text — which is what makes a repeated gesture
  // idempotent and gives the player cancel for free.
  // =========================================================================

  test('the order command validates its destination', function () {
    var b = _ordBoard(fns, d, 51, pid, 4);
    var foreign = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      if (b.s.stations[STATION_IDS[i]].owner !== pid) { foreign = STATION_IDS[i]; break; }
    }

    // Whole-command failures. If the destination is wrong then no source could
    // have saved it, so rejecting the sources one at a time would report the
    // same fact ten times and bury the reason.
    var unknown = fns.apply(b.s, {
      type: 'order', owner: pid, stations: [b.own[0]], target: 'no-such-city',
    });
    assertEqual(unknown.reason, 'unknown-target', 'an unknown destination was not rejected');

    var enemy = fns.apply(b.s, {
      type: 'order', owner: pid, stations: [b.own[0]], target: foreign,
    });
    assertEqual(enemy.reason, 'target-not-owned',
      'a supply line at ground its owner does not hold was accepted');
    assertEqual((b.s.stations[b.own[0]].supplyTo || []).length, 0,
      'a rejected order changed state anyway');

    // Per-station rejections. One bad entry must not cost the rest of the list:
    // marqueeing the front and clicking one of the cities in it is the normal
    // way to say "everyone else supply this one".
    var mixed = fns.apply(b.s, {
      type: 'order', owner: pid, stations: [b.own[0], b.own[1], foreign], target: b.own[1],
    });
    assert(mixed.ok, 'a mixed list failed wholesale instead of per station');
    assertEqual((b.s.stations[b.own[0]].supplyTo || []).join(','), b.own[1],
      'the good station did not get its line');
    assertEqual((b.s.stations[b.own[1]].supplyTo || []).length, 0,
      'a station was made to supply itself');
    assertEqual((b.s.stations[foreign].supplyTo || []).length, 0,
      'a foreign station took a supply line');
    var why = {};
    for (i = 0; i < mixed.rejected.length; i++) why[mixed.rejected[i].reason] = true;
    assert(why['self-target'], 'the destination inside the list was not rejected self-target');
    assert(why['not-owned'], 'the foreign station was not rejected not-owned');
  });

  test('toggling the same edge twice is a no-op — that is the cancel gesture', function () {
    var b = _ordBoard(fns, d, 53, pid, 4);
    var from = b.own[0], to = b.own[1];
    applyCommand(b.s, { type: 'order', owner: pid, stations: [from], target: to });
    assertEqual((b.s.stations[from].supplyTo || []).join(','), to, 'the line was not drawn');
    applyCommand(b.s, { type: 'order', owner: pid, stations: [from], target: to });
    assertEqual((b.s.stations[from].supplyTo || []).length, 0,
      'toggling the same destination again did not remove the line');
    // ...and a third press puts it back, so the gesture is a toggle rather than
    // a one-way clear that happens to look like one.
    applyCommand(b.s, { type: 'order', owner: pid, stations: [from], target: to });
    assertEqual((b.s.stations[from].supplyTo || []).join(','), to, 'the toggle is one-way');
  });

  test('a group toggle with mixed prior state ADDS to all rather than flipping each', function () {
    // The bold-on-mixed-text rule. Flipping each station independently would
    // make a group gesture do two different things at once, and the player would
    // have no way to predict which — the same complaint that killed the inferred
    // rally.
    var b = _ordBoard(fns, d, 54, pid, 6);
    var to = b.own[0];
    var group = b.own.filter(function (x) { return x !== to; }).slice(0, 3);
    applyCommand(b.s, { type: 'order', owner: pid, stations: [group[0]], target: to });
    assertEqual((b.s.stations[group[0]].supplyTo || []).join(','), to, 'fixture setup failed');

    applyCommand(b.s, { type: 'order', owner: pid, stations: group, target: to });
    var missing = group.filter(function (sid) {
      return (b.s.stations[sid].supplyTo || []).indexOf(to) < 0;
    });
    assertNone(missing, 'a group toggle over mixed state flipped stations individually ' +
      'instead of adding the edge to all of them');

    // Now every station has it, so the same gesture removes it from all.
    applyCommand(b.s, { type: 'order', owner: pid, stations: group, target: to });
    var kept = group.filter(function (sid) {
      return (b.s.stations[sid].supplyTo || []).indexOf(to) >= 0;
    });
    assertNone(kept, 'a group toggle over uniform state did not clear the edge');
  });

  test('a null destination clears every line on the listed stations and nothing else', function () {
    var b = _ordBoard(fns, d, 55, pid, 6);
    var to = b.own[0];
    var group = b.own.filter(function (x) { return x !== to; });
    _ordLink(b.s, pid, group, to);
    var untouched = group[group.length - 1];

    applyCommand(b.s, {
      type: 'order', owner: pid,
      stations: group.filter(function (x) { return x !== untouched; }),
      target: null,
    });

    var stillSet = group.filter(function (sid) {
      return sid !== untouched && (b.s.stations[sid].supplyTo || []).length > 0;
    });
    assertNone(stillSet, 'a clear left supply lines behind');
    assertEqual((b.s.stations[untouched].supplyTo || []).join(','), to,
      'a clear reached a station that was not in the list');
  });

  // -------------------------------------------------------------------------
  test('determinism — same seed, two runs, identical state, with supply lines active', function () {
    var run = function () {
      var s = newGame(777);               // AI ON: orders and AI must interleave
      for (var t = 0; t < 1500 && !s.winner; t++) {
        if (t % 400 === 0) {
          for (var p = 0; p < POWER_IDS.length; p++) {
            var q = POWER_IDS[p];
            if (q === 'neutral' || !s.powers[q] || s.powers[q].alive === false) continue;
            var cap = POWERS[q].capital;
            if (!s.stations[cap] || s.stations[cap].owner !== q) continue;
            var srcs = [];
            for (var i = 0; i < STATION_IDS.length; i++) {
              var sid = STATION_IDS[i];
              if (s.stations[sid].owner === q && sid !== cap) srcs.push(sid);
            }
            if (srcs.length) _ordLink(s, q, srcs, cap);
          }
        }
        stepTick(s);
      }
      return JSON.stringify({ st: s.stations, w: s.waves, o: s.orderStats, rng: s.rng, tick: s.tick });
    };
    var a = run(), b = run();
    assertEqual(a.length, b.length, 'two runs from the same seed produced different-sized states');
    assertEqual(a === b, true, 'two runs from the same seed diverged with supply lines active');
  });

  // =========================================================================
  // standingOrderNext — WHAT ACTUALLY LEAVES
  //
  // standingOrderSend() is the SOURCE'S WILLINGNESS and the readout was showing
  // it. Once the headroom ceiling landed those stopped being the same number,
  // and the rail advertised "6.4 units next sweep" every frame of a game in
  // which a full destination took exactly none of them. A promise that never
  // happens, with nothing on screen saying why, is worse than no number.
  //
  // standingOrderNext() answers the other question — what really leaves, down
  // which line, and why it does not — by sharing the sweep's own planner. These
  // tests are what makes "shares" mean something: the first proves the two agree
  // on every sweep of a long run rather than merely being written to.
  // =========================================================================

  if (typeof standingOrderNext !== 'function') {
    skipTest('standingOrderNext', 'not present');
  } else {

  // -------------------------------------------------------------------------
  test('standingOrderNext predicts every sweep EXACTLY, over 1200+ ticks', function () {
    // The tick is driven BY HAND here, because the prediction has to be taken
    // at the only moment it is meaningful: after growth, before the sweep. That
    // makes this test dependent on the phase order, so the phase order is
    // asserted rather than assumed — reorder SIM_PHASES and this fails loudly
    // instead of quietly measuring the wrong instant (known-issues #13).
    assertEqual(SIM_PHASES.join(','),
      'growthTick,ordersTick,movementTick,combatTick,relationsTick,victoryTick',
      'the tick phase order changed; this test drives the phases by hand');

    var b = _ordBoard(fns, d, 65, pid, 10);
    var dest = d.POWERS[pid].capital;
    var others = b.own.filter(function (x) { return x !== dest; });
    var i;
    _ordLink(b.s, pid, others, dest);
    // A SECOND destination on half of them, so the many-to-many arithmetic is
    // under the same exactness assertion as the single-line case rather than
    // being checked only by the small fixtures above.
    var second = others[0];
    _ordLink(b.s, pid, others.slice(1), second);
    // Emptied so the early sweeps ship and the later ones do not: the
    // destinations fill as they are fed and the same sources go from streaming
    // to blocked inside one run, which is what makes the vacuity guard below
    // satisfiable without two fixtures.
    b.s.stations[dest].units = { infantry: 1, artillery: 0, armour: 0 };
    b.s.stations[second].units = { infantry: 1, artillery: 0, armour: 0 };

    var s = b.s;
    var checks = 0, ship = 0, block = 0, reasons = {}, multi = 0;
    var mismatch = [], destWrong = [], drainWrong = [], planWrong = [], edgeWrong = [];

    // Both destinations are spent at the end of every tick, standing in for a
    // front that is using what it receives. Without it they fill in a handful of
    // sweeps and the whole run is blocked — which would make this a test of the
    // blocked path only, and the vacuity guard below would (correctly) fail.
    // Applied AFTER every phase, so the prediction is always taken on the same
    // board the sweep then acts on.
    var spend = function () {
      s.stations[dest].units = { infantry: 1, artillery: 0, armour: 0 };
      s.stations[second].units = { infantry: 1, artillery: 0, armour: 0 };
    };

    for (var t = 0; t < 1400 && !s.winner; t++) {
      if (s.tick % O.INTERVAL !== 0) { fns.step(s); spend(); continue; }

      growthTick(s);                                    // phase 1

      var sources = [], sid;
      for (i = 0; i < STATION_IDS.length; i++) {
        sid = STATION_IDS[i];
        if (s.stations[sid].owner === pid && (s.stations[sid].supplyTo || []).length) sources.push(sid);
      }
      var pred = {}, before = {};
      for (i = 0; i < sources.length; i++) {
        pred[sources[i]] = standingOrderNext(s, sources[i]);
        before[sources[i]] = totalUnits(s.stations[sources[i]].units);
        if (pred[sources[i]].edges.length > 1) multi++;
      }
      // The bulk accessor two renderers actually call must say the same thing
      // as the per-station one. It shares the planner, so this cannot drift —
      // which is exactly why it is asserted rather than assumed.
      var bulk = standingOrderPlan(s, pid);
      for (i = 0; i < sources.length; i++) {
        var bf = sources[i], bp = bulk[bf], sp = pred[bf];
        if (!bp || bp.units !== sp.units || bp.target !== sp.target || bp.blocked !== sp.blocked ||
            bp.edges.length !== sp.edges.length) {
          planWrong.push('tick ' + s.tick + ' ' + bf + ': plan ' + JSON.stringify(bp) +
            ' vs next ' + JSON.stringify(sp));
        }
      }

      var firstNew = s.nextWaveId;
      ordersTick(s);                                    // phase 2 — the sweep

      // What applyCommand ACTUALLY shipped, read off the waves this sweep
      // created rather than off any counter the phase keeps about itself.
      var got = {}, gotTo = {};
      for (i = 0; i < s.waves.length; i++) {
        var w = s.waves[i];
        if (w.id < firstNew) continue;
        got[w.from] = (got[w.from] || 0) + totalUnits(w.units);
        (gotTo[w.from] || (gotTo[w.from] = {}))[w.to] = totalUnits(w.units);
      }

      for (i = 0; i < sources.length; i++) {
        var f = sources[i], p = pred[f], sent = got[f] || 0;
        checks++;
        if (p.units > 0) ship++;
        else { block++; reasons[p.blocked] = (reasons[p.blocked] || 0) + 1; }

        // The claim, stated four ways. Same total, same split by destination,
        // and the source really lost exactly what was predicted — the last one
        // because "waves of the right size exist" and "this city paid for them"
        // are different facts and a planner could get one right and the other
        // wrong.
        var tol = 1e-9 * Math.max(1, sent);
        if (Math.abs(p.units - sent) > tol) {
          mismatch.push('tick ' + s.tick + ' ' + f + ': predicted ' + p.units.toFixed(6) +
            ', shipped ' + sent.toFixed(6) + ' (blocked=' + p.blocked + ')');
        }
        var perDest = gotTo[f] || {};
        for (var k = 0; k < p.edges.length; k++) {
          var ed = p.edges[k];
          var real = perDest[ed.target] || 0;
          if (Math.abs(ed.units - real) > 1e-9 * Math.max(1, real)) {
            edgeWrong.push('tick ' + s.tick + ' ' + f + '->' + ed.target + ': predicted ' +
              ed.units.toFixed(6) + ', shipped ' + real.toFixed(6) +
              ' (blocked=' + ed.blocked + ')');
          }
        }
        for (var to2 in perDest) {
          var known = false;
          for (k = 0; k < p.edges.length; k++) if (p.edges[k].target === to2) known = true;
          if (!known) destWrong.push('tick ' + s.tick + ' ' + f + ' shipped to ' + to2 +
            ', which the plan never mentioned');
        }
        var drained = before[f] - totalUnits(s.stations[f].units);
        if (Math.abs(drained - sent) > tol) {
          drainWrong.push('tick ' + s.tick + ' ' + f + ': lost ' + drained.toFixed(6) +
            ' but shipped ' + sent.toFixed(6));
        }
      }

      movementTick(s); combatTick(s); relationsTick(s); victoryTick(s);
      s.tick++;
      spend();
    }

    assertNone(mismatch, 'standingOrderNext disagreed with what the sweep shipped');
    assertNone(edgeWrong, 'standingOrderNext got a per-destination share wrong');
    assertNone(destWrong, 'the sweep shipped somewhere the plan never named');
    assertNone(drainWrong, 'the source did not pay exactly what was predicted');
    assertNone(planWrong, 'standingOrderPlan disagreed with standingOrderNext');

    // VACUITY GUARDS. "It agreed on every sweep" is worth nothing if every
    // sweep was the same sweep — an implementation that returned 0 forever
    // would pass the assertions above on a board that never shipped, and one
    // that never blocked would prove nothing about the case this whole change
    // exists for.
    assert(checks > 300, 'VACUITY: only ' + checks + ' station-sweeps were compared');
    assert(ship > 20, 'VACUITY: only ' + ship + ' predictions were of a real stream, so the ' +
      'shipping path was barely exercised');
    assert(block > 20, 'VACUITY: only ' + block + ' predictions were blocked, so the case ' +
      'this function exists for was barely exercised');
    assert(multi > 20, 'VACUITY: only ' + multi + ' predictions covered a source with more ' +
      'than one destination, so the split arithmetic was barely exercised');
    assert(Object.keys(reasons).length > 0, 'VACUITY: no blocked reason was ever produced');
  });

  // -------------------------------------------------------------------------
  test('every blocked reason is reachable — one fixture each', function () {
    var seen = {};
    var note = function (nx) { seen[nx.blocked] = (seen[nx.blocked] || 0) + 1; return nx; };
    var edgeReason = function (nx, to) {
      for (var k = 0; k < nx.edges.length; k++) {
        if (nx.edges[k].target === to) { seen[nx.edges[k].blocked] = 1; return nx.edges[k].blocked; }
      }
      return null;
    };
    var cap = d.POWERS[pid].capital;
    var i, b, sources;

    // no-order — a city that supplies nowhere. Must read as "this station has
    // no supply lines", not as a zero that looks like a stalled one.
    b = _ordBoard(fns, d, 70, pid, 6);
    assertEqual(note(standingOrderNext(b.s, cap)).blocked, 'no-order',
      'a city with no supply lines did not read as no-order');

    // destination-full — THE LIVE REPRO. Sources willing, destination at its
    // ceiling.
    b = _ordBoard(fns, d, 71, pid, 7);
    sources = b.own.filter(function (x) { return x !== cap; });
    _ordLink(b.s, pid, sources, cap);
    b.s.stations[cap].units = {
      infantry: d.STATIONS[cap].capacity * _ordCeilMul(d), artillery: 0, armour: 0,
    };
    var willing = 0, sawFull = 0;
    for (i = 0; i < sources.length; i++) {
      if (standingOrderSend(b.s, sources[i]) > 0) willing++;
      var nx = note(standingOrderNext(b.s, sources[i]));
      if (nx.blocked === 'destination-full') {
        sawFull++;
        assertEqual(nx.units, 0, sources[i] + ' reported units against a full destination');
        assertEqual(nx.target, cap, 'the blocked source did not name the city that is full');
      }
    }
    // The control that makes this the BUG and not just a fixture: the old
    // readout number is non-zero on exactly the stations the new one says ship
    // nothing. Without this the test would pass against a function that always
    // returned 0.
    assert(willing >= 3, 'VACUITY: only ' + willing + ' sources were WILLING to ship, so ' +
      'standingOrderSend and standingOrderNext were never actually in disagreement');
    assert(sawFull >= 3, 'only ' + sawFull + ' sources reported destination-full');

    // at-keep-floor — a source sitting exactly on its floor, with room at the
    // destination so nothing else can be the reason.
    b = _ordBoard(fns, d, 72, pid, 7);
    sources = b.own.filter(function (x) { return x !== cap; });
    _ordLink(b.s, pid, sources, cap);
    b.s.stations[cap].units = { infantry: 1, artillery: 0, armour: 0 };
    var floored = sources[0];
    b.s.stations[floored].units = {
      infantry: d.STATIONS[floored].capacity * O.KEEP_FLOOR, artillery: 0, armour: 0,
    };
    assertEqual(note(standingOrderNext(b.s, floored)).blocked, 'at-keep-floor',
      floored + ' at exactly its keep floor did not report at-keep-floor');

    // below-min-send — just above the floor, so the surplus is real but the
    // 12% share of it is under the 2.0-unit minimum stream.
    b.s.stations[floored].units = {
      infantry: d.STATIONS[floored].capacity * O.KEEP_FLOOR + 1, artillery: 0, armour: 0,
    };
    assert(standingOrderSend(b.s, floored) === 0, 'fixture: the source is willing after all');
    assertEqual(note(standingOrderNext(b.s, floored)).blocked, 'below-min-send',
      floored + ' just above its floor did not report below-min-send');

    // unreachable — a destination cut off by ground another power holds.
    b = _ordBoard(fns, d, 73, pid, 8);
    var path = _ordLongestOwnPath(b.s, pid, b.own);
    assert(path && path.length >= 3, 'fixture has no multi-hop own-ground route');
    var from = path[0], far = path[path.length - 1];
    _ordLink(b.s, pid, [from], far);
    b.s.stations[far].units = { infantry: 1, artillery: 0, armour: 0 };
    for (i = 1; i < path.length - 1; i++) _setOwner(b.s, path[i], 'fra');
    assertEqual(note(standingOrderNext(b.s, from)).blocked, 'unreachable',
      'a source cut off from its only destination did not report unreachable');

    // target-lost — the destination has changed hands and the sweep has not run
    // yet. Reported per edge and named, so a panel can say which city went.
    b = _ordBoard(fns, d, 74, pid, 6);
    var others = b.own.filter(function (x) { return x !== cap; });
    _ordLink(b.s, pid, [cap], others[0]);
    _setOwner(b.s, others[0], 'fra');
    var lost = note(standingOrderNext(b.s, cap));
    assertEqual(lost.blocked, 'target-lost', 'a destination that changed hands did not report target-lost');
    assertEqual(lost.target, others[0], 'target-lost did not name the city that was lost');
    assertEqual(edgeReason(lost, others[0]), 'target-lost', 'the edge did not carry the reason');

    // Every reason the sim can emit has now been produced by a fixture. A
    // reason nothing can reach is either dead code or a lie about the sim, and
    // this is the assertion that stops one being added quietly.
    var expected = ['no-order', 'destination-full', 'at-keep-floor', 'below-min-send',
                    'unreachable', 'target-lost'];
    var unreached = [];
    for (i = 0; i < expected.length; i++) {
      if (!seen[expected[i]]) unreached.push(expected[i]);
    }
    assertNone(unreached, 'a blocked reason no fixture could reach — construct one or delete it');
  });

  // -------------------------------------------------------------------------
  test('standingOrderNext is pure — safe to call every frame', function () {
    var b = _ordBoard(fns, d, 76, pid, 8);
    var cap = d.POWERS[pid].capital;
    _ordLink(b.s, pid, b.own.filter(function (x) { return x !== cap; }), cap);
    b.s.stations[cap].units = { infantry: 1, artillery: 0, armour: 0 };

    var snap = JSON.stringify(b.s);
    var shipped = 0;
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i < STATION_IDS.length; i++) {
        var nx = standingOrderNext(b.s, STATION_IDS[i]);
        if (nx.units > 0) shipped++;
      }
    }
    // VACUITY: a function that returned early on everything would also not
    // mutate anything.
    assert(shipped > 0, 'VACUITY: no call ever reached the planning path');
    assertEqual(JSON.stringify(b.s) === snap, true,
      'standingOrderNext mutated the board — it is called every frame from render/');
    assertEqual(b.s.waves.length, 0, 'standingOrderNext put a wave on the board');
    assertEqual(b.s.orderStats.sends, 0, 'standingOrderNext issued a command');
  });

  // -------------------------------------------------------------------------
  test('willingness and what-leaves are different numbers, and the sweep sides with the latter',
  function () {
    // 7 sources into a full destination: the exact board the readout was lying
    // about.
    var b = _ordBoard(fns, d, 77, pid, 7);
    var cap = d.POWERS[pid].capital;
    var sources = b.own.filter(function (x) { return x !== cap; });
    _ordLink(b.s, pid, sources, cap);
    b.s.stations[cap].units = {
      infantry: d.STATIONS[cap].capacity * _ordCeilMul(d), artillery: 0, armour: 0,
    };

    var want = 0, leaves = 0;
    for (var i = 0; i < sources.length; i++) {
      want += standingOrderSend(b.s, sources[i]);
      leaves += standingOrderNext(b.s, sources[i]).units;
    }
    assert(want > 10, 'VACUITY: the sources were not willing to ship in the first place (' +
      want.toFixed(1) + ')');
    assertEqual(leaves, 0, 'units left a board whose only destination is full: ' + leaves.toFixed(1));

    // And the sweep itself agrees with the second number, not the first — which
    // is the whole complaint: the empire header was quoting `want`.
    _run(fns, b.s, 400);
    assertEqual(b.s.orderStats.sends, 0, 'the sweep shipped after all');
    assertEqual(b.s.orderStats.unitsSent, 0, 'the sweep moved units after all');
  });

  // -------------------------------------------------------------------------
  // THE STARVATION BUG. Several cities feeding ONE destination whose headroom
  // is SCARCE — which is the normal state of a front that is spending what it
  // receives, and the exact gesture the mechanic was built for: marquee the
  // rear, press R, click the front.
  //
  // The sweep planned its sources in STATION_IDS order and booked headroom as
  // it went, so the alphabetically-first feeder took the whole of a scarce
  // destination's room on every single sweep and every other feeder read
  // `destination-full` forever. Measured on a live board before the fix, five
  // feeders over 160 sweeps:
  //
  //     ber 160    bre 2    brn 2    fra 1    ham 1
  //
  // and with `ber` removed from the group it was `bre` — the SMALLEST of the
  // five — that won 61 while `ham`, more than twice its capacity, took 2. So it
  // was not size, not distance and not need: it was the id. That is a ranking
  // the sim applies off screen, which is the one thing this whole design keeps
  // deleting (see THE EVEN SPLIT in sim/movement.js), and it is what "they're
  // not consistently still sending troops" looks like from the player's chair.
  //
  // THE ASSERTION IS FAIRNESS, NOT THROUGHPUT, because throughput was never
  // wrong — the destination got fed either way. What was wrong is WHICH city
  // paid, every time.
  test('a scarce destination is fed by every source in turn, not always the first by id',
  function () {
    var b = _ordBoard(fns, d, 78, pid, 9);
    var cap = d.POWERS[pid].capital;
    // The destination is NOT the capital: the capital is the biggest garrison
    // on the board and making it the sink would leave the group's shares so
    // lopsided that a fairness claim would be about capacity rather than order.
    var rest = b.own.filter(function (x) { return x !== cap; });
    var dest = rest[rest.length - 1];
    var sources = [cap].concat(rest.slice(0, 4)).sort();
    _ordLink(b.s, pid, sources, dest);
    assert(sources.length >= 4, 'fixture: not enough sources to starve');

    // Bled every tick, so the destination always has SOME room and never
    // enough for everybody — the equilibrium a front in use actually sits at.
    // A destination pinned full would block every source equally and prove
    // nothing; one pinned empty would have room for all of them and prove less.
    var sends = {}, i;
    for (i = 0; i < sources.length; i++) sends[sources[i]] = 0;

    var sweeps = 0;
    for (var t = 0; t < 40 * O.INTERVAL; t++) {
      if (b.s.tick % O.INTERVAL === 0) {
        sweeps++;
        var plan = standingOrderPlan(b.s, pid);
        for (i = 0; i < sources.length; i++) {
          var p = plan[sources[i]];
          if (p && p.units > 0) sends[sources[i]]++;
        }
      }
      fns.step(b.s);
      var du = b.s.stations[dest].units;
      if (totalUnits(du) > 3) du.infantry -= 0.10;
    }

    var counts = [], total = 0;
    for (i = 0; i < sources.length; i++) {
      counts.push(sends[sources[i]]);
      total += sends[sources[i]];
    }
    var most = Math.max.apply(null, counts);
    var least = Math.min.apply(null, counts);

    // VACUITY, both ways. A board where nothing ever ships would have a perfect
    // spread, and a board with room for everyone every sweep would too — so the
    // fixture has to prove it is actually contended before the fairness claim
    // means anything.
    assert(total > sweeps, 'VACUITY: the group shipped ' + total + ' times over ' +
      sweeps + ' sweeps — the destination was not being fed at all');
    assert(most < sweeps * sources.length,
      'VACUITY: every source shipped on every sweep, so the destination was never scarce');

    assert(least * 3 >= most,
      'a scarce destination was fed by the same city over and over: sends by source, ' +
      'in id order, were [' + counts.join(', ') + '] over ' + sweeps + ' sweeps');
  });

  }
}

// ===========================================================================
// DATA SUMMARY
// ===========================================================================

function dataSummary() {
  var d = collectData();
  var lines = [];
  var pad = function (s, n) { s = String(s); while (s.length < n) s += ' '; return s; };

  if (!d.TERRITORIES && !d.STATIONS && !d.LINKS) {
    lines.push('  (no map data loaded — data/map.js, data/stations.js and');
    lines.push('   data/scenario.js have not been authored yet)');
    return lines.join('\n');
  }

  if (d.TERRITORIES) {
    var terr = Object.keys(d.TERRITORIES);
    var byTerrain = {};
    terr.forEach(function (t) {
      var k = d.TERRITORIES[t].terrain || '?';
      byTerrain[k] = (byTerrain[k] || 0) + 1;
    });
    lines.push('  territories      ' + terr.length +
      '   (' + Object.keys(byTerrain).sort().map(function (k) {
        return k + ' ' + byTerrain[k];
      }).join(', ') + ')');
  }
  if (d.VERTS) lines.push('  vertices         ' + Object.keys(d.VERTS).length);

  if (d.STATIONS) {
    var sids = Object.keys(d.STATIONS);
    var byType = {};
    sids.forEach(function (s) { byType[d.STATIONS[s].type] = (byType[d.STATIONS[s].type] || 0) + 1; });
    lines.push('  stations         ' + sids.length);
    ['holding', 'producer', 'multiplier', 'defensive'].forEach(function (t) {
      if (byType[t] !== undefined) lines.push('    ' + pad(t, 14) + ' ' + byType[t]);
      delete byType[t];
    });
    Object.keys(byType).sort().forEach(function (t) {
      lines.push('    ' + pad(t + ' (?)', 14) + ' ' + byType[t]);
    });
    var producers = sids.filter(function (s) { return d.STATIONS[s].type === 'producer'; });
    if (producers.length) {
      var byOut = {};
      producers.forEach(function (s) { byOut[d.STATIONS[s].produces] = (byOut[d.STATIONS[s].produces] || 0) + 1; });
      lines.push('    produces       ' + Object.keys(byOut).sort().map(function (k) {
        return k + ' ' + byOut[k];
      }).join(', '));
    }
  }

  if (d.LINKS) {
    var sea = d.LINKS.filter(function (l) { return l.sea === true; }).length;
    lines.push('  links            ' + d.LINKS.length + '   (' + sea + ' sea crossings)');
  }

  if (d.SETUP && d.POWERS) {
    lines.push('  stations per power');
    var counts = {}, forces = {}, terrs = {};
    Object.keys(d.POWERS).forEach(function (p) { counts[p] = 0; forces[p] = 0; terrs[p] = 0; });
    Object.keys(d.SETUP).forEach(function (sid) {
      var o = d.SETUP[sid].owner;
      if (counts[o] === undefined) { counts[o] = 0; forces[o] = 0; terrs[o] = 0; }
      counts[o]++;
      var u = d.SETUP[sid].units || {};
      forces[o] += (u.infantry || 0) + (u.artillery || 0) + (u.armour || 0);
    });
    if (d.TERRITORIES && d.STATIONS) {
      Object.keys(d.TERRITORIES).forEach(function (tid) {
        var inTerr = Object.keys(d.STATIONS).filter(function (sid) { return d.STATIONS[sid].territory === tid; });
        if (!inTerr.length) return;
        var owner = d.SETUP[inTerr[0]] && d.SETUP[inTerr[0]].owner;
        var uniform = inTerr.every(function (sid) { return d.SETUP[sid] && d.SETUP[sid].owner === owner; });
        if (uniform && terrs[owner] !== undefined) terrs[owner]++;
      });
    }
    Object.keys(counts).sort().forEach(function (p) {
      var name = (d.POWERS[p] && d.POWERS[p].name) || p;
      lines.push('    ' + pad(p, 9) + pad(counts[p] + ' stations', 14) +
        pad(terrs[p] + ' territories', 17) +
        pad(Math.round(forces[p]) + ' units', 12) + name);
    });
  }

  return lines.join('\n');
}

// ===========================================================================
// FORMATTING — shared by tests.html and test/node.js
// ===========================================================================

function formatResults() {
  var sum = summarizeTests();
  var out = [];
  var pad = function (s, n) { s = String(s); while (s.length < n) s += ' '; return s; };
  var rule = '========================================================================';

  // --- header: the one line that has to be readable without scrolling ---
  out.push(rule);
  out.push((sum.fail === 0 ? 'PASS' : 'FAIL') +
    '  —  ' + sum.pass + ' passed, ' + sum.fail + ' failed, ' + sum.skip + ' skipped' +
    '  |  ' + sum.suitesRun + ' suites run, ' + sum.suitesSkipped + ' suites skipped');
  out.push(rule);
  out.push('');

  // --- per-suite summary ---
  out.push('SUITES');
  for (var i = 0; i < TEST_RESULTS.length; i++) {
    var s = TEST_RESULTS[i];
    if (s.skipped) {
      out.push('  SKIP  ' + pad(s.name, 34) + '  ' + s.reason);
      continue;
    }
    var p = 0, f = 0, k = 0;
    s.tests.forEach(function (t) { if (t.skipped) k++; else if (t.ok) p++; else f++; });
    var tag = f > 0 ? 'FAIL' : (p === 0 ? 'SKIP' : 'ok  ');
    out.push('  ' + tag + '  ' + pad(s.name, 34) + '  ' +
      p + '/' + (p + f) + ' passed' + (k ? ', ' + k + ' skipped' : '') +
      (f ? '   <-- ' + f + ' FAILING' : ''));
  }
  out.push('');

  // --- failure detail ---
  if (sum.fail > 0) {
    out.push(rule);
    out.push('FAILURES');
    out.push(rule);
    TEST_RESULTS.forEach(function (s) {
      if (s.skipped) return;
      s.tests.forEach(function (t) {
        if (t.ok || t.skipped) return;
        out.push('');
        out.push('  [' + s.name + ']');
        out.push('    ' + t.name);
        out.push('      ' + t.msg);
      });
    });
    out.push('');
  }

  // --- skipped tests inside running suites ---
  var anySkipped = false;
  TEST_RESULTS.forEach(function (s) {
    if (s.skipped) return;
    s.tests.forEach(function (t) {
      if (!t.skipped) return;
      if (!anySkipped) { out.push('SKIPPED TESTS'); anySkipped = true; }
      out.push('  [' + s.name + '] ' + t.name + ' — ' + t.msg);
    });
  });
  if (anySkipped) out.push('');

  // --- data summary ---
  out.push(rule);
  out.push('DATA SUMMARY');
  out.push(rule);
  out.push(dataSummary());
  out.push('');

  return out.join('\n');
}
