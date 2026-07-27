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

  // AI family — test/ai-tests.js; skips loudly until ai/ lands.
  if (typeof suiteAI === 'function') suiteAI(d);

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

  test('send fraction default is 0.75 (00-vision.md §8)', function () {
    assertEqual(B.SEND_FRACTION_DEFAULT, 0.75, 'SEND_FRACTION_DEFAULT');
    assert(B.SEND_FRACTIONS.indexOf(0.75) >= 0, 'SEND_FRACTIONS must contain the default');
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

  test('growth stalls at capacity (§2)', function () {
    var sid = _anyStation(S, function (st) { return st.type === 'holding'; });
    assert(sid, 'no holding station on the map');
    var s = fns.newGame(1);
    s.stations[sid].units.infantry = S[sid].capacity * 0.99;
    _run(fns, s, 600);
    assert(s.stations[sid].units.infantry <= S[sid].capacity * 1.001,
      'station grew past capacity: ' + s.stations[sid].units.infantry + ' > ' + S[sid].capacity);
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
    // Isolate one owned station by handing every other station of that power
    // to neutral: nothing links it home any more.
    // Two hops out, then the hop in between handed back to neutral: the far
    // station is ours, and nothing we own links it home.
    var chain = _grantFromCapital(s, ctx.data.LINKS, P[pid].capital, pid, 6);
    assert(chain.length >= 2, 'could not grow a chain from ' + P[pid].capital);
    var victim = chain[chain.length - 1];
    chain.forEach(function (sid) { if (sid !== victim) _setOwner(s, sid, 'neutral'); });
    s.stations[victim].units.infantry = 40;

    var before = s.stations[victim].units.infantry;
    _run(fns, s, B.DISCONNECT_GRACE + 400);
    var after = s.stations[victim].units.infantry;
    assert(after < before, 'a cut-off station did not decay: ' + before + ' -> ' + after);
  });

  test('decay rate matches DISCONNECT_DECAY within a factor of two', function () {
    var pid = Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; })[0];
    var s = fns.newGame(9);
    var chain = _grantFromCapital(s, ctx.data.LINKS, P[pid].capital, pid, 6);
    if (chain.length < 2) return skipTest('decay rate', 'could not grow a chain from the capital');
    var victim = chain[chain.length - 1];
    chain.forEach(function (sid) { if (sid !== victim) _setOwner(s, sid, 'neutral'); });
    s.stations[victim].units.infantry = 100;
    _run(fns, s, B.DISCONNECT_GRACE);
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
