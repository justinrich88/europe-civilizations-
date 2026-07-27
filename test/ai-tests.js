// test/ai-tests.js — the AI contract suite.
//
// Written BLIND to ai/score.js and ai/ai.js, against the "AI API — pinned
// names" section of docs/design/01-data-schema.md and section 10 of
// data/tuning.js. That is deliberate: a test written from the implementation
// only restates it, while a test written from the contract can catch the
// implementation disagreeing with the contract. Nothing in here may be
// weakened to make a failing implementation pass — a failure is a finding.
//
// Everything is guarded: if ai/ has not landed, the whole suite SKIPS with a
// reason naming the missing globals (never an exception, never a silent pass —
// known-issues.md #8).
//
// Exposes: suiteAI(). Every other top-level name here is _ai-prefixed, because
// in a globals-only project a function name is a global claim
// (known-issues.md #9).

'use strict';

// The six pinned globals. Function declarations DO land on the global object
// (unlike top-level const — known-issues.md #3), so they can be looked up by
// string name; `const BAL` cannot, hence the typeof ladder for data.
var AI_PINNED = ['aiTick', 'aiDecide', 'aiContext', 'aiCandidates',
                 'aiScoreTarget', 'aiDecisions'];

function _aiG() {
  return (typeof globalThis !== 'undefined') ? globalThis
       : (typeof window !== 'undefined') ? window : null;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

// Returns a context, or registers a loud SKIP and returns null. The reason
// names exactly what is missing so a skip is actionable rather than invisible.
function _aiNeed(name) {
  var g = _aiG();
  var missing = [];

  for (var i = 0; i < AI_PINNED.length; i++) {
    if (!g || typeof g[AI_PINNED[i]] !== 'function') missing.push(AI_PINNED[i] + '()');
  }
  if (typeof newGame !== 'function') missing.push('newGame() [core/state.js]');
  if (typeof stepTick !== 'function') missing.push('stepTick() [sim/step.js]');
  if (typeof applyCommand !== 'function') missing.push('applyCommand() [sim/commands.js]');
  if (typeof snapshot !== 'function') missing.push('snapshot() [core/state.js]');
  if (typeof BAL === 'undefined' || !BAL.AI) missing.push('BAL.AI [data/tuning.js]');
  if (typeof STATIONS === 'undefined' || typeof POWERS === 'undefined' ||
      typeof SETUP === 'undefined') missing.push('map + scenario data');
  if (typeof LINKS === 'undefined') missing.push('LINKS [data/map.js]');

  if (missing.length) {
    skipSuite(name, 'waiting on ' + missing.join(', '));
    return null;
  }
  return {
    g: g, B: BAL, AI: BAL.AI, S: STATIONS, P: POWERS, L: LINKS,
    apply: applyCommand, step: stepTick, newGame: newGame, snap: snapshot,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function _aiPids(P) {
  return Object.keys(P).sort().filter(function (p) { return p !== 'neutral'; });
}

function _aiRun(state, n) {
  for (var i = 0; i < n; i++) stepTick(state);
  return state;
}

// The station id carried by a candidate. The candidate OBJECT shape is not
// pinned — only "sorted by score descending" is — so accept the plausible
// spellings rather than guessing one and testing a typo.
function _aiCandSid(c) {
  if (typeof c === 'string') return c;
  if (!c || typeof c !== 'object') return null;
  return c.sid || c.target || c.station || c.id || null;
}

// Any station NOT owned by pid that is one link from a station pid owns. Ids
// are never hard-coded — the map is generated and every id would rot.
function _aiFrontierTarget(state, pid, L) {
  var own = {};
  var sids = Object.keys(state.stations).sort();
  for (var i = 0; i < sids.length; i++) {
    if (state.stations[sids[i]].owner === pid) own[sids[i]] = true;
  }
  var best = null;
  for (var j = 0; j < L.length; j++) {
    var a = L[j].a, b = L[j].b;
    if (own[a] && !own[b]) { if (!best || b < best) best = b; }
    if (own[b] && !own[a]) { if (!best || a < best) best = a; }
  }
  return best;
}

// Wrap the global applyCommand so we can count what the AI actually got
// ACCEPTED, rather than what it intended. Unqualified `applyCommand(...)`
// inside ai/ resolves through the scope chain to this global property at call
// time, so the wrapper is visible to it. Always restored in a finally.
function _aiInstrument(state, ticks) {
  var g = _aiG();
  var real = g.applyCommand;
  var rec = { calls: 0, accepted: {}, wholeFails: [], byTick: {} };
  g.applyCommand = function (st, cmd) {
    var r = real(st, cmd);
    rec.calls++;
    var owner = (cmd && cmd.owner) || '?';
    if (r && r.ok) {
      (rec.accepted[owner] || (rec.accepted[owner] = [])).push(st ? st.tick : -1);
    } else {
      rec.wholeFails.push(owner + '@' + (st ? st.tick : -1) + ':' + (r && r.reason));
    }
    return r;
  };
  try {
    for (var i = 0; i < ticks; i++) stepTick(state);
  } finally {
    g.applyCommand = real;
  }
  return rec;
}

// Strip comments and quoted strings before grepping source text, so a banned
// name mentioned in a comment ("never call Math.random") is not a failure.
function _aiStripText(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

// Whole-file source when we can reach the filesystem (node), otherwise the
// pinned functions' own source via toString (browser). The file read is
// strictly better — it covers private helpers too — so it is tried first.
function _aiSourceText() {
  var texts = [];
  try {
    var req = null;
    if (typeof require === 'function') req = require;
    else if (typeof process !== 'undefined' && process.mainModule &&
             typeof process.mainModule.require === 'function') {
      req = function (m) { return process.mainModule.require(m); };
    }
    if (req) {
      var fs = req('fs');
      var roots = ['', './'];
      if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
        roots.push(String(process.argv[1]).replace(/test[\/\\]node\.js$/, ''));
      }
      var files = ['ai/score.js', 'ai/ai.js'];
      for (var r = 0; r < roots.length && !texts.length; r++) {
        for (var f = 0; f < files.length; f++) {
          var p = roots[r] + files[f];
          try {
            if (fs.existsSync(p)) texts.push(fs.readFileSync(p, 'utf8'));
          } catch (e) { /* try the next root */ }
        }
      }
      if (texts.length) return { text: texts.join('\n'), whole: true };
    }
  } catch (e) { /* fall through to toString */ }

  var g = _aiG();
  for (var i = 0; i < AI_PINNED.length; i++) {
    if (g && typeof g[AI_PINNED[i]] === 'function') {
      texts.push(Function.prototype.toString.call(g[AI_PINNED[i]]));
    }
  }
  return { text: texts.join('\n'), whole: false };
}

// Deep-equal by serialisation. Everything in the state is plain JSON by
// construction (core/state.js), so this is exact, not approximate.
function _aiJson(v) { return JSON.stringify(v); }

// Which TOP-LEVEL keys of the state changed. Naming the key is the difference
// between "aiDecide mutated state" and a message you can act on.
function _aiChangedKeys(before, after, ignore) {
  var keys = {}, out = [], k;
  for (k in before) keys[k] = true;
  for (k in after) keys[k] = true;
  Object.keys(keys).sort().forEach(function (key) {
    if (ignore.indexOf(key) >= 0) return;
    if (_aiJson(before[key]) !== _aiJson(after[key])) out.push(key);
  });
  return out;
}

// ===========================================================================
// The suite
// ===========================================================================

function suiteAI(d) {
  var ctx = _aiNeed('ai / contract');
  if (!ctx) return;
  suite('ai / contract');

  var AI = ctx.AI, B = ctx.B, P = ctx.P, S = ctx.S, L = ctx.L, g = ctx.g;
  var pids = _aiPids(P);
  var TICKS_PER_MIN = B.TICKS_PER_SEC * 60;

  // -------------------------------------------------------------------------
  // Purity — the two properties pinned explicitly, and the two most likely to
  // be violated by accident.
  // -------------------------------------------------------------------------

  test('aiDecide does not mutate state (only state.rng may move)', function () {
    var s = newGame(9001);
    s.tick = 400;
    var changedAll = [];
    for (var i = 0; i < pids.length; i++) {
      var before = snapshot(s);
      g.aiDecide(s, pids[i]);
      var after = snapshot(s);
      var changed = _aiChangedKeys(before, after, ['rng']);
      for (var j = 0; j < changed.length; j++) {
        changedAll.push(pids[i] + ' changed state.' + changed[j]);
      }
    }
    assertNone(changedAll,
      'aiDecide mutated the state it was only supposed to read');
  });

  test('aiScoreTarget is pure — same inputs, same output, twice, and no state touched', function () {
    var pid = pids[0];
    var s = newGame(9002);
    var tgt = _aiFrontierTarget(s, pid, L);
    assert(!!tgt, 'no frontier station found for ' + pid + ' — fixture is wrong');
    var c = g.aiContext(s, pid);
    var before = snapshot(s);
    var a = g.aiScoreTarget(s, pid, tgt, c);
    var b = g.aiScoreTarget(s, pid, tgt, c);
    var after = snapshot(s);
    assert(a && typeof a.score === 'number' && isFinite(a.score),
      'aiScoreTarget must return { score, terms } with a finite score, got ' + _aiJson(a));
    assert(a.terms && typeof a.terms === 'object', 'aiScoreTarget must return a terms object');
    assertEqual(_aiJson(b), _aiJson(a),
      'aiScoreTarget is not pure — two identical calls disagreed');
    assertNone(_aiChangedKeys(before, after, []),
      'aiScoreTarget touched the state (it may not even draw from rng)');
  });

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  test('aiCandidates is sorted by score descending and capped at CANDIDATES_PER_DECISION', function () {
    var problems = [];
    var s = newGame(9003);
    s.tick = 400;
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i];
      var cands = g.aiCandidates(s, pid, g.aiContext(s, pid));
      assert(Array.isArray(cands), 'aiCandidates must return an array, got ' + _aiJson(cands));
      if (cands.length > AI.CANDIDATES_PER_DECISION) {
        problems.push(pid + ' returned ' + cands.length + ' > CANDIDATES_PER_DECISION=' +
                      AI.CANDIDATES_PER_DECISION);
      }
      for (var j = 1; j < cands.length; j++) {
        var prev = cands[j - 1], cur = cands[j];
        if (typeof prev.score !== 'number' || typeof cur.score !== 'number') {
          problems.push(pid + ' candidate ' + j + ' has no numeric score: ' + _aiJson(cur));
          break;
        }
        if (cur.score > prev.score) {
          problems.push(pid + ' not sorted descending at ' + j + ': ' +
                        prev.score + ' then ' + cur.score);
        }
      }
    }
    assertNone(problems, 'aiCandidates broke its ordering / truncation contract');
  });

  test('every candidate names a real station the power does not already hold', function () {
    var problems = [];
    var s = newGame(9004);
    s.tick = 400;
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i];
      var cands = g.aiCandidates(s, pid, g.aiContext(s, pid));
      for (var j = 0; j < cands.length; j++) {
        var sid = _aiCandSid(cands[j]);
        if (!sid || !s.stations[sid]) {
          problems.push(pid + ' candidate ' + j + ' is not a station id: ' + _aiJson(cands[j]));
        } else if (s.stations[sid].owner === pid) {
          problems.push(pid + ' offered ' + sid + ', which it already owns');
        }
      }
    }
    assertNone(problems, 'aiCandidates produced targets that make no sense');
  });

  // -------------------------------------------------------------------------
  // aiContext — the shape both files read, so it is contractual.
  // -------------------------------------------------------------------------

  test('aiContext carries the pinned shape and a personality that is never null', function () {
    var problems = [];
    var s = newGame(9005);
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i], c = g.aiContext(s, pid);
      if (!c || typeof c !== 'object') { problems.push(pid + ': not an object'); continue; }
      if (c.pid !== pid) problems.push(pid + ': ctx.pid is ' + _aiJson(c.pid));
      if (!c.personality || typeof c.personality !== 'object') {
        problems.push(pid + ': personality is ' + _aiJson(c.personality) + ' — must never be null');
      }
      if (!Array.isArray(c.own)) problems.push(pid + ': own is not an array');
      else {
        var sorted = c.own.slice().sort();
        if (_aiJson(sorted) !== _aiJson(c.own)) problems.push(pid + ': own is not sorted');
        for (var j = 0; j < c.own.length; j++) {
          if (s.stations[c.own[j]].owner !== pid) {
            problems.push(pid + ': own includes ' + c.own[j] + ', owned by ' +
                          s.stations[c.own[j]].owner);
          }
        }
      }
      if (!c.hops || typeof c.hops !== 'object') problems.push(pid + ': hops is not an object');
      if (!(c.leader === null || (typeof c.leader === 'string' && P[c.leader]))) {
        problems.push(pid + ': leader is ' + _aiJson(c.leader));
      }
      if (typeof c.leaderShare !== 'number' || !(c.leaderShare >= 0 && c.leaderShare <= 1)) {
        problems.push(pid + ': leaderShare is ' + _aiJson(c.leaderShare) + ', want 0..1');
      }
      if (typeof c.ownForces !== 'number' || !isFinite(c.ownForces) || c.ownForces < 0) {
        problems.push(pid + ': ownForces is ' + _aiJson(c.ownForces));
      }
    }
    assertNone(problems, 'aiContext broke its pinned shape');
  });

  test('an undeclared personality falls back to neutral 1s, never null', function () {
    var pid = pids[0], orig = P[pid].ai, c;
    try {
      P[pid].ai = null;
      c = g.aiContext(newGame(9006), pid);
    } finally { P[pid].ai = orig; }
    assert(c && c.personality && typeof c.personality === 'object',
      'a power with no declared type must still get a personality object');
    assert(typeof c.personality.minOddsMul === 'number' && isFinite(c.personality.minOddsMul),
      'neutral personality has no numeric minOddsMul: ' + _aiJson(c.personality));
    assertClose(c.personality.minOddsMul, 1, 1e-9,
      'an undeclared personality must get neutral 1s (01-data-schema.md)');
  });

  // -------------------------------------------------------------------------
  // The decision object. §6: a passive AI is otherwise undebuggable.
  // -------------------------------------------------------------------------

  test('every logged decision carries the pinned fields; kind is only attack|hold', function () {
    var s = newGame(9007);
    _aiRun(s, 400);
    var log = g.aiDecisions(s, null, AI.LOG_MAX);
    assert(Array.isArray(log), 'aiDecisions must return an array, got ' + _aiJson(log));
    assert(log.length > 0,
      'the AI logged no decisions at all in 400 ticks — a power that never ran and a ' +
      'power that decided to hold must not look the same (§6)');

    var pinned = ['tick', 'power', 'kind', 'target', 'score', 'terms', 'odds',
                  'minOdds', 'sources', 'fraction', 'reason', 'rejected'];
    var problems = [];
    for (var i = 0; i < log.length; i++) {
      var dd = log[i], tag = '#' + i + '(' + dd.power + '@' + dd.tick + ')';
      for (var k = 0; k < pinned.length; k++) {
        if (!(pinned[k] in dd)) problems.push(tag + ' missing field "' + pinned[k] + '"');
      }
      if (dd.kind !== 'attack' && dd.kind !== 'hold') {
        problems.push(tag + ' kind is ' + _aiJson(dd.kind) + ', only attack|hold are legal');
      }
      if (typeof dd.tick !== 'number') problems.push(tag + ' tick is not a number');
      if (!P[dd.power] || dd.power === 'neutral') {
        problems.push(tag + ' power is ' + _aiJson(dd.power) + ' — neutral is never an actor');
      }
      if (!Array.isArray(dd.sources)) problems.push(tag + ' sources is not an array');
      if (!Array.isArray(dd.rejected)) problems.push(tag + ' rejected is not an array');
      if (!dd.terms || typeof dd.terms !== 'object') problems.push(tag + ' terms is not an object');
      if (dd.kind === 'attack') {
        if (typeof dd.target !== 'string' || !s.stations[dd.target]) {
          problems.push(tag + ' attack target is ' + _aiJson(dd.target));
        }
        if (!Array.isArray(dd.sources) || dd.sources.length === 0) {
          problems.push(tag + ' attack with no sources');
        }
        if (Array.isArray(dd.sources) && dd.sources.length > AI.MAX_SOURCES_PER_VOLLEY) {
          problems.push(tag + ' used ' + dd.sources.length + ' sources > MAX_SOURCES_PER_VOLLEY=' +
                        AI.MAX_SOURCES_PER_VOLLEY);
        }
        if (typeof dd.odds !== 'number' || !isFinite(dd.odds)) {
          problems.push(tag + ' attack odds is ' + _aiJson(dd.odds));
        }
        if (typeof dd.minOdds !== 'number' || !(dd.minOdds > 0)) {
          problems.push(tag + ' minOdds is ' + _aiJson(dd.minOdds));
        }
        if (typeof dd.odds === 'number' && typeof dd.minOdds === 'number' && dd.odds < dd.minOdds) {
          problems.push(tag + ' attacked at odds ' + dd.odds + ' below its own minOdds ' + dd.minOdds);
        }
        if (typeof dd.fraction !== 'number' || !(dd.fraction > 0 && dd.fraction <= 1)) {
          problems.push(tag + ' fraction is ' + _aiJson(dd.fraction));
        }
      }
    }
    assertNone(problems, 'decision objects broke the pinned shape', 10);
  });

  test('a hold is never silent — every hold carries a non-null reason', function () {
    var s = newGame(9008);
    _aiRun(s, 400);
    var log = g.aiDecisions(s, null, AI.LOG_MAX);
    var holds = log.filter(function (x) { return x.kind === 'hold'; });
    var problems = holds.filter(function (x) {
      return x.reason === null || x.reason === undefined || x.reason === '';
    }).map(function (x) {
      return x.power + '@' + x.tick + ' held with reason ' + _aiJson(x.reason);
    });
    assertNone(problems,
      'a hold with no reason is indistinguishable from code that never ran (§6)');
  });

  test('aiDecisions filters by power and returns newest last', function () {
    var s = newGame(9009);
    _aiRun(s, 400);
    var problems = [];
    for (var i = 0; i < pids.length; i++) {
      var mine = g.aiDecisions(s, pids[i], 50);
      assert(Array.isArray(mine), 'aiDecisions(state, pid, n) must return an array');
      if (mine.length > 50) problems.push(pids[i] + ' got ' + mine.length + ' entries for n=50');
      for (var j = 0; j < mine.length; j++) {
        if (mine[j].power !== pids[i]) {
          problems.push(pids[i] + ' log leaked an entry for ' + mine[j].power);
        }
        if (j && mine[j].tick < mine[j - 1].tick) {
          problems.push(pids[i] + ' log is not oldest-first at ' + j +
                        ': ' + mine[j - 1].tick + ' then ' + mine[j].tick);
        }
      }
    }
    var all = g.aiDecisions(s, null, 5);
    if (all.length > 5) problems.push('aiDecisions(state, null, 5) returned ' + all.length);
    assertNone(problems, 'aiDecisions broke its contract');
  });

  // -------------------------------------------------------------------------
  // The log is a ring buffer, in the state, capped.
  // -------------------------------------------------------------------------

  test('state.aiLog is a ring buffer capped at LOG_MAX that trims from the front', function () {
    var s = newGame(9010);
    // aiLog is created lazily on the first push, and which tick a power first
    // acts on is seed-dependent — so give the cadence a full ACTION_INTERVAL
    // plus jitter to fire. Asserting on tick 1 would test the lazy init, not
    // the ring buffer.
    var warm = AI.ACTION_INTERVAL_TICKS + AI.ACTION_JITTER_TICKS + 5;
    for (var w = 0; w < warm && !Array.isArray(s.aiLog); w++) stepTick(s);
    assert(Array.isArray(s.aiLog),
      'state.aiLog must be an array on the state after ' + warm + ' ticks — the log ' +
      'lives inside the state so a snapshot still explains itself');

    // Prefill to the cap with recognisable entries. Pushing past a full buffer
    // is the only thing that exercises the trim, and waiting for ~2300 ticks of
    // real play to fill 400 slots would make the suite too slow to run
    // constantly.
    s.aiLog.length = 0;
    for (var i = 0; i < AI.LOG_MAX; i++) {
      s.aiLog.push({ tick: -1, power: pids[0], kind: 'hold', target: null, score: 0,
                     terms: {}, odds: 0, minOdds: 1, sources: [], fraction: 0,
                     reason: 'prefill', rejected: [] });
    }
    _aiRun(s, 300);

    assert(s.aiLog.length <= AI.LOG_MAX,
      'aiLog grew to ' + s.aiLog.length + ' > LOG_MAX=' + AI.LOG_MAX + ' — not a ring buffer');

    var fills = s.aiLog.filter(function (e) { return e.reason === 'prefill'; }).length;
    assert(fills < AI.LOG_MAX,
      'nothing was pushed to aiLog in 300 ticks, so the trim was never exercised');

    // Trimmed from the FRONT means the survivors are a prefix: no prefill entry
    // may appear after a real one.
    var seenReal = false, misordered = 0;
    for (var j = 0; j < s.aiLog.length; j++) {
      if (s.aiLog[j].reason === 'prefill') { if (seenReal) misordered++; }
      else seenReal = true;
    }
    assertEqual(misordered, 0,
      'aiLog trimmed from the back, not the front — ' + misordered +
      ' stale entries survived newer ones');
  });

  // -------------------------------------------------------------------------
  // Determinism. The single strongest test available: it catches Math.random,
  // Date.now and Object.keys iteration order all at once.
  // -------------------------------------------------------------------------

  test('two games from the same seed run identically with the AI active', function () {
    var run = function () {
      var s = newGame(424242);
      _aiRun(s, 250);
      return _aiJson({ stations: s.stations, waves: s.waves, powers: s.powers,
                       rng: s.rng, aiLog: s.aiLog });
    };
    var a = run(), b = run();
    if (a !== b) {
      // Say WHERE they diverged; "two runs differ" over a 200KB string is not
      // a usable failure message.
      var i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      _aiFailAt(a, b, i);
    }
    assertEqual(a.length, b.length, 'same-seed runs produced different-sized states');
  });

  test('different seeds actually diverge (the determinism test is not comparing two frozen boards)', function () {
    var run = function (seed) {
      var s = newGame(seed);
      _aiRun(s, 250);
      return _aiJson(s.stations);
    };
    assert(run(424242) !== run(515151),
      'two different seeds produced identical boards — the AI is not doing anything ' +
      'seed-dependent, which would make the determinism test above vacuous');
  });

  // -------------------------------------------------------------------------
  // The rules the AI inherits from the player.
  // -------------------------------------------------------------------------

  test('the AI actually issues accepted orders — it is not a statue', function () {
    var s = newGame(9011);
    var rec = _aiInstrument(s, 400);
    var total = 0, actingPowers = 0;
    for (var i = 0; i < pids.length; i++) {
      var n = (rec.accepted[pids[i]] || []).length;
      total += n;
      if (n > 0) actingPowers++;
    }
    assert(total > 0,
      'no power got a single order accepted in 400 ticks (applyCommand was called ' +
      rec.calls + ' times)');
    assert(actingPowers >= 2,
      'only ' + actingPowers + ' power(s) acted in 400 ticks — the cadence is not ' +
      'running for everyone');
  });

  test('no power exceeds MAX_ORDERS_PER_MINUTE accepted orders in a sim-minute', function () {
    var s = newGame(9012);
    var rec = _aiInstrument(s, TICKS_PER_MIN);
    var problems = [];
    for (var i = 0; i < pids.length; i++) {
      var n = (rec.accepted[pids[i]] || []).length;
      if (n > AI.MAX_ORDERS_PER_MINUTE) {
        problems.push(pids[i] + ' issued ' + n + ' orders in ' + TICKS_PER_MIN +
                      ' ticks (one sim-minute), cap is ' + AI.MAX_ORDERS_PER_MINUTE);
      }
    }
    assertNone(problems, 'the AI out-clicked the player (§6)');
  });

  test('the AI never issues a command applyCommand rejects wholesale', function () {
    var s = newGame(9013);
    var rec = _aiInstrument(s, 400);
    assertNone(rec.wholeFails,
      'the AI sent orders that were illegal for it — it inherits the player rules');
  });

  test('every attack the AI logs names sources it owned and a target it did not', function () {
    var s = newGame(9014);
    var problems = [];
    var g2 = _aiG(), real = g2.applyCommand;
    g2.applyCommand = function (st, cmd) {
      if (cmd && cmd.type === 'send' && cmd.owner) {
        if (st.stations[cmd.target] && st.stations[cmd.target].owner === cmd.owner &&
            cmd.sources.indexOf(cmd.target) >= 0) {
          problems.push(cmd.owner + '@' + st.tick + ' targeted its own source ' + cmd.target);
        }
        for (var i = 0; i < cmd.sources.length; i++) {
          if (!st.stations[cmd.sources[i]]) {
            problems.push(cmd.owner + '@' + st.tick + ' source ' + cmd.sources[i] + ' is not a station');
          } else if (st.stations[cmd.sources[i]].owner !== cmd.owner) {
            problems.push(cmd.owner + '@' + st.tick + ' sent from ' + cmd.sources[i] +
                          ', owned by ' + st.stations[cmd.sources[i]].owner);
          }
        }
      }
      return real(st, cmd);
    };
    try { _aiRun(s, 400); } finally { g2.applyCommand = real; }
    assertNone(problems, 'the AI built commands it had no right to build');
  });

  test('neutral is never an actor', function () {
    assertEqual(g.aiDecide(newGame(9015), 'neutral'), null,
      'aiDecide returned a decision for neutral — neutral is a real power id but never acts');
    var s = newGame(9016);
    var rec = _aiInstrument(s, 300);
    assertEqual((rec.accepted['neutral'] || []).length, 0, 'neutral issued orders');
    var log = g.aiDecisions(s, null, AI.LOG_MAX).filter(function (e) { return e.power === 'neutral'; });
    assertEqual(log.length, 0, 'neutral logged ' + log.length + ' decisions');
  });

  test('a dead power takes no decisions', function () {
    var s = newGame(9017);
    var victim = pids[0];
    s.powers[victim].alive = false;
    assertEqual(g.aiDecide(s, victim), null,
      'aiDecide returned a decision for an eliminated power');
  });

  // -------------------------------------------------------------------------
  // Personalities are distinguishable. DIRECTION only — an exact number here
  // breaks every time balance is tuned, which teaches everyone to ignore it.
  // -------------------------------------------------------------------------

  test('an expansionist commits at lower odds than a turtle on the same board', function () {
    var pid = pids[0], orig = P[pid].ai;
    var s = newGame(9018);
    s.tick = 500;
    var cE, cT, dE, dT;
    try {
      P[pid].ai = 'expansionist';
      cE = g.aiContext(s, pid);
      s.powers[pid].lastActTick = -99999;
      dE = g.aiDecide(s, pid);
      P[pid].ai = 'turtle';
      cT = g.aiContext(s, pid);
      s.powers[pid].lastActTick = -99999;
      dT = g.aiDecide(s, pid);
    } finally { P[pid].ai = orig; }

    assert(cE.personality.minOddsMul < cT.personality.minOddsMul,
      'expansionist minOddsMul ' + cE.personality.minOddsMul +
      ' should be BELOW turtle ' + cT.personality.minOddsMul);
    assert(dE && dT,
      'aiDecide returned null for an alive, non-neutral power (' +
      _aiJson(dE) + ' / ' + _aiJson(dT) + ')');
    assert(dE.minOdds < dT.minOdds,
      'the same power on the same board demanded minOdds ' + dE.minOdds +
      ' as an expansionist and ' + dT.minOdds + ' as a turtle — personalities are ' +
      'not reaching the decision');
    assertClose(dE.minOdds, AI.MIN_ODDS * cE.personality.minOddsMul, 1e-9,
      'decision.minOdds must be BAL.AI.MIN_ODDS x personality.minOddsMul');
  });

  test('a turtle holds at least as often as an expansionist over the same run', function () {
    var pid = pids[0], orig = P[pid].ai;
    var holdRate = function (kind) {
      var s;
      try {
        P[pid].ai = kind;
        s = newGame(9019);
        _aiRun(s, 500);
      } finally { P[pid].ai = orig; }
      var mine = g.aiDecisions(s, pid, AI.LOG_MAX);
      if (!mine.length) return null;
      var holds = mine.filter(function (e) { return e.kind === 'hold'; }).length;
      return holds / mine.length;
    };
    var e = holdRate('expansionist'), t = holdRate('turtle');
    assert(e !== null && t !== null, 'no decisions logged for ' + pid);
    assert(t >= e,
      'as a turtle ' + pid + ' held ' + Math.round(t * 100) + '% of the time but as an ' +
      'expansionist ' + Math.round(e * 100) + '% — the aggressive personality is the ' +
      'more cautious one');
  });

  // -------------------------------------------------------------------------
  // Odds are a POWER ratio, not a unit ratio.
  //
  // The discriminator: infantry defends at 1.2 and artillery at 0.6, so a
  // garrison of N artillery is far weaker than a garrison of N infantry while
  // being the SAME NUMBER OF UNITS. A scorer that counts units cannot tell the
  // two boards apart; a scorer that uses stationPower must.
  // -------------------------------------------------------------------------

  test('odds are a POWER ratio, not a unit ratio (same unit count, weaker composition scores higher)', function () {
    assert(B.UNITS.artillery.def < B.UNITS.infantry.def,
      'this test assumes artillery defends worse than infantry; UNITS changed');

    var pid = pids[0];
    var probe = newGame(9020);
    var tgt = _aiFrontierTarget(probe, pid, L);
    assert(!!tgt, 'no frontier station for ' + pid);

    var scoreWith = function (units) {
      var s = newGame(9020);
      s.stations[tgt].units = units;
      return g.aiScoreTarget(s, pid, tgt, g.aiContext(s, pid));
    };
    var N = 24;
    var inf = scoreWith({ infantry: N, artillery: 0, armour: 0 });
    var art = scoreWith({ infantry: 0, artillery: N, armour: 0 });

    assert(art.score !== inf.score,
      'a garrison of ' + N + ' artillery and a garrison of ' + N + ' infantry scored ' +
      'identically (' + inf.score + ') at ' + tgt + ' — the same unit count with very ' +
      'different defensive power. That is a UNIT ratio, and MIN_ODDS then means ' +
      'something other than what its comment says. terms: ' + _aiJson(inf.terms));
    assert(art.score > inf.score,
      'the weaker-defending garrison (' + N + ' artillery, def ' + B.UNITS.artillery.def +
      ') scored ' + art.score + ', BELOW the stronger one (' + N + ' infantry, def ' +
      B.UNITS.infantry.def + ') at ' + inf.score + ' — the odds term has the wrong sign');
  });

  test('a fort raises the defender power the AI sees, at unchanged unit count', function () {
    var pid = pids[0];
    var probe = newGame(9021);
    var tgt = _aiFrontierTarget(probe, pid, L);
    assert(!!tgt, 'no frontier station for ' + pid);
    var scoreWith = function (n) {
      var s = newGame(9021);
      s.stations[tgt].units = { infantry: n, artillery: 0, armour: 0 };
      return g.aiScoreTarget(s, pid, tgt, g.aiContext(s, pid)).score;
    };
    assert(scoreWith(6) > scoreWith(60),
      'a barely-garrisoned ' + tgt + ' did not score above a heavily-garrisoned one — ' +
      'the weakness term is not reaching the score');
  });

  // -------------------------------------------------------------------------
  // Source hygiene. Cheap, and it has caught this class of thing before here.
  // -------------------------------------------------------------------------

  test('nothing in ai/ touches document, Math.random or Date.now', function () {
    var src = _aiSourceText();
    assert(src.text && src.text.length > 200,
      'could not read any AI source text to check');
    var clean = _aiStripText(src.text);
    var banned = [
      { re: /\bMath\s*\.\s*random\b/, name: 'Math.random' },
      { re: /\bDate\s*\.\s*now\b/, name: 'Date.now' },
      { re: /\bnew\s+Date\b/, name: 'new Date' },
      { re: /\bdocument\b/, name: 'document' },
      { re: /\bwindow\s*\.\s*(?:document|localStorage)\b/, name: 'window.document/localStorage' },
    ];
    var problems = [];
    for (var i = 0; i < banned.length; i++) {
      if (banned[i].re.test(clean)) {
        problems.push(banned[i].name + ' appears in ' +
                      (src.whole ? 'ai/*.js' : 'the pinned AI functions'));
      }
    }
    assertNone(problems,
      'ai/ reached outside the sim — the state\'s rng is the only sanctioned entropy');
    if (!src.whole) {
      // Say so, loudly, rather than reporting a narrower check as the full one.
      assert(true);
    }
  });
}

// Report a divergence between two long serialisations at the character where
// they first differ, with context. Kept out of the test body so the test reads
// as one assertion.
function _aiFailAt(a, b, i) {
  var lo = Math.max(0, i - 60);
  throw (function () {
    var e = new Error(
      'same-seed runs diverged at char ' + i + '\n  A: ...' + a.slice(lo, i + 60) +
      '\n  B: ...' + b.slice(lo, i + 60));
    e._isAssertion = true;
    return e;
  })();
}
