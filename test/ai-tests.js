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

// ---------------------------------------------------------------------------
// The last-stand board — the shape that froze 65% of games
//
// One power holds every station on the map except a single rival capital, and
// everything it holds is at capacity. This is not a contrived board: it is
// seed 101 at t=60,000, where France held 106 of 108 stations with 3,534 units
// and stood still until the draw limit, because the only two stations that
// could reach Constantinople inside the volley's ETA window held 52 units
// between them and every other approach is a 1,500-3,600 tick sea crossing.
//
// Three properties make it the right fixture and all three are load-bearing:
//
//   * The holdout is the rival's CAPITAL, so capitulation (§7) cannot resolve
//     the board for free — a fixture whose rival surrenders would pass without
//     a single unit moving.
//   * The rival is ALIVE, so victoryTick cannot end the game by last-power-
//     standing before the assault happens.
//   * War is latched both ways, so `not-at-war` cannot be the answer. This
//     fixture is about force, not diplomacy.
//
// No station id is hard-coded. _aiTestWorstHoldout picks whichever capital
// produces the least favourable odds, which is the honest worst case and
// survives the map being regenerated.
// ---------------------------------------------------------------------------

// `fill` is the holder's garrison as a fraction of capacity, default full.
// Below 1.0 it is the lever that makes HOME_GARRISON_FLOOR actually bind: at
// capacity every source's allowance is exactly COMMIT_FRACTION and the floor
// is inert, so a test of the floor run on a full board proves nothing.
function _aiTestLastStand(holder, foe, seed, fill) {
  var keep = POWERS[foe].capital;
  var f = (fill === undefined) ? 1 : fill;
  var s = newGame(seed === undefined ? 4242 : seed);
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    setStationOwner(s, sid, sid === keep ? foe : holder);
    var u = s.stations[sid].units;
    u.infantry = STATIONS[sid].capacity * (sid === keep ? 1 : f);
    u.artillery = 0;
    u.armour = 0;
  }
  // War, and war that STAYS. The latch alone is not enough: relationsTick
  // seeds its drift from powers[a].relations[b], which still reads
  // RELATION_START (+10), and the first relations update therefore stands the
  // war straight back down again — after which every decision in the fixture
  // is 'not-at-war' and the test measures the Concert instead of the deadlock.
  var pair = [holder, foe];
  for (var p = 0; p < pair.length; p++) {
    var me = s.powers[pair[p]], them = pair[1 - p];
    if (!me.wars) me.wars = {};
    me.wars[them] = true;
    if (!me.relations) me.relations = {};
    me.relations[them] = BAL.AI.RELATION_MIN;
  }

  // The foe is PLAYER-controlled, i.e. inert: aiTick skips state.human. Not a
  // hack — it is the seam app/main.js uses — and it is load-bearing. Left
  // AI-driven, the foe sorties out of its own capital, and the holdout then
  // falls to an empty-city walk-in that has nothing to do with staging. The
  // fixture measured the wrong thing and would have gone on passing while the
  // fix rotted (known-issues.md #8: a test that passes for the wrong reason).
  s.human = foe;
  return { state: s, holder: holder, foe: foe, holdout: keep };
}

// The rival whose capital `holder` finds hardest to crack. Deterministic:
// odds ascending, ties by power id.
function _aiTestWorstHoldout(holder) {
  var pids = _aiPids(POWERS);
  var best = null;
  for (var i = 0; i < pids.length; i++) {
    if (pids[i] === holder) continue;
    var b = _aiTestLastStand(holder, pids[i]);
    var d = aiDecide(b.state, holder);
    var odds = (d && typeof d.odds === 'number') ? d.odds : Infinity;
    if (!best || odds < best.odds) best = { foe: pids[i], odds: odds, decision: d };
  }
  return best;
}

// Record every send the AI actually hands to applyCommand, with the facts that
// are only true AT CALL TIME — who owned the target, what was standing in each
// source — because a post-hoc read of the final state cannot recover them.
function _aiTestSends(state, ticks) {
  var g = _aiG();
  var real = g.applyCommand;
  var sends = [];
  g.applyCommand = function (st, cmd) {
    var rec = null;
    if (cmd && cmd.type === 'send') {
      rec = {
        tick: st.tick, owner: cmd.owner, target: cmd.target,
        fraction: cmd.fraction,
        targetOwner: st.stations[cmd.target] ? st.stations[cmd.target].owner : null,
        sources: [],
      };
      for (var i = 0; i < cmd.sources.length; i++) {
        var sst = st.stations[cmd.sources[i]];
        rec.sources.push({
          sid: cmd.sources[i],
          units: sst ? totalUnits(sst.units) : 0,
          capacity: STATIONS[cmd.sources[i]] ? STATIONS[cmd.sources[i]].capacity : 0,
        });
      }
    }
    var r = real(st, cmd);
    if (rec) {
      rec.ok = !!(r && r.ok);
      rec.etas = [];
      if (r && r.accepted) {
        for (var k = 0; k < r.accepted.length; k++) rec.etas.push(r.accepted[k].eta);
      }
      sends.push(rec);
    }
    return r;
  };
  try {
    for (var t = 0; t < ticks; t++) {
      if (state.winner) break;
      stepTick(state);
    }
  } finally {
    g.applyCommand = real;
  }
  return sends;
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

  test('every logged decision carries the pinned fields; kind is only attack|hold|stage', function () {
    var s = newGame(9007);
    _aiRun(s, 400);
    // The opening is a land grab, so it produces attacks and holds but rarely a
    // stage. Splice in a board that DOES stage, or this test would go on
    // asserting the shape of a kind it never sees.
    var ls = _aiTestLastStand('fra', 'ott');
    _aiRun(ls.state, 400);
    var extra = g.aiDecisions(ls.state, null, AI.LOG_MAX);
    var log = g.aiDecisions(s, null, AI.LOG_MAX);
    assert(Array.isArray(log), 'aiDecisions must return an array, got ' + _aiJson(log));
    assert(log.length > 0,
      'the AI logged no decisions at all in 400 ticks — a power that never ran and a ' +
      'power that decided to hold must not look the same (§6)');

    log = log.concat(extra);
    var staged = 0;
    for (var q = 0; q < log.length; q++) if (log[q].kind === 'stage') staged++;
    assert(staged > 0,
      'no decision of kind "stage" was logged on a board built to require one — ' +
      'this test cannot check the shape of a decision it never sees');

    var pinned = ['tick', 'power', 'kind', 'target', 'score', 'terms', 'odds',
                  'minOdds', 'sources', 'fraction', 'reason', 'rejected'];
    var problems = [];
    for (var i = 0; i < log.length; i++) {
      var dd = log[i], tag = '#' + i + '(' + dd.power + '@' + dd.tick + ')';
      for (var k = 0; k < pinned.length; k++) {
        if (!(pinned[k] in dd)) problems.push(tag + ' missing field "' + pinned[k] + '"');
      }
      if (dd.kind !== 'attack' && dd.kind !== 'hold' && dd.kind !== 'stage') {
        problems.push(tag + ' kind is ' + _aiJson(dd.kind) +
                      ', only attack|hold|stage are legal');
      }
      if (typeof dd.tick !== 'number') problems.push(tag + ' tick is not a number');
      if (!P[dd.power] || dd.power === 'neutral') {
        problems.push(tag + ' power is ' + _aiJson(dd.power) + ' — neutral is never an actor');
      }
      if (dd.kind === 'stage') {
        // A stage is an ORDER, so it must name where the units are going AND
        // what they are being assembled against. Without stageFor the log
        // cannot answer "why is France reinforcing Smyrna?", which is the one
        // question a reader of a staging decision has (§6).
        if (typeof dd.target !== 'string' || !dd.target) {
          problems.push(tag + ' stage target (the depot) is ' + _aiJson(dd.target));
        }
        if (typeof dd.stageFor !== 'string' || !dd.stageFor) {
          problems.push(tag + ' stage has no stageFor — it does not say what it is massing against');
        }
        if (dd.target === dd.stageFor) {
          problems.push(tag + ' staged into its own objective ' + dd.target);
        }
        if (!Array.isArray(dd.sources) || dd.sources.length === 0) {
          problems.push(tag + ' stage with no sources');
        }
        if (Array.isArray(dd.sources) && dd.sources.length > AI.MAX_SOURCES_PER_VOLLEY) {
          problems.push(tag + ' staged from ' + dd.sources.length +
                        ' sources > MAX_SOURCES_PER_VOLLEY=' + AI.MAX_SOURCES_PER_VOLLEY);
        }
        if (dd.reason !== 'staging') {
          problems.push(tag + ' stage reason is ' + _aiJson(dd.reason) + ', expected "staging"');
        }
        if (typeof dd.fraction !== 'number' || !(dd.fraction > 0 && dd.fraction <= 1)) {
          problems.push(tag + ' stage fraction is ' + _aiJson(dd.fraction));
        }
        if (dd.sources && dd.sources.indexOf(dd.target) >= 0) {
          problems.push(tag + ' staged a depot into itself');
        }
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

  // Routing is ownership-aware (sim/movement.js routeFor): a wave may cross
  // ground its owner HOLDS and nothing else — neutral ground is not a corridor,
  // only a destination. The AI inherits that rule through applyCommand (and
  // mirrors it in _aiScoreCanTraverse / _aiActCanTraverse), so if its candidate
  // generation still thinks in
  // straight-line geography it will keep ordering volleys down roads it is not
  // allowed to use. Those come back per-source as 'no-route' — the board goes
  // quiet, and the only evidence is a decision log full of holds.
  //
  // Long enough a run that wars have actually started and there ARE enemy
  // cities in the way; at 400 ticks the Concert is still holding and the check
  // would pass on an empty set.
  test('the AI never orders a send that is rejected for no-route', function () {
    var s = newGame(9113);
    var g3 = _aiG(), real3 = g3.applyCommand;
    var problems = [];
    g3.applyCommand = function (st, cmd) {
      var r = real3(st, cmd);
      if (r && r.rejected) {
        for (var i = 0; i < r.rejected.length; i++) {
          if (r.rejected[i].reason === 'no-route') {
            problems.push(cmd.owner + '@' + st.tick + ' ' + r.rejected[i].source +
                          '->' + cmd.target);
          }
        }
      }
      return r;
    };
    try { _aiRun(s, 3000); } finally { g3.applyCommand = real3; }
    assertNone(problems,
      'the AI planned volleys through ground it may not cross — its candidate ' +
      'generation is still using the geographic route', 5);
  });

  test('the AI does not offer targets it cannot legally reach', function () {
    if (typeof routeFor !== 'function') return skipTest(
      'the AI does not offer targets it cannot legally reach',
      'routeFor() [sim/movement.js] not loaded');
    var s = newGame(9114);
    _aiRun(s, 2500);                       // let the map get tangled first
    var pids = _aiPids(P), problems = [];
    for (var p = 0; p < pids.length; p++) {
      var pid = pids[p];
      if (s.powers[pid].alive === false) continue;
      var own = Object.keys(s.stations).sort().filter(function (sid) {
        return s.stations[sid].owner === pid;
      });
      if (!own.length) continue;
      var cands = g.aiCandidates(s, pid, g.aiContext(s, pid)) || [];
      for (var c = 0; c < cands.length; c++) {
        var sid = _aiCandSid(cands[c]);
        var reachable = false;
        for (var o = 0; o < own.length && !reachable; o++) {
          if (routeFor(s, pid, own[o], sid)) reachable = true;
        }
        if (!reachable) problems.push(pid + ' offered ' + sid + ', unreachable from any of its ' +
                                      own.length + ' stations');
      }
    }
    assertNone(problems,
      'aiCandidates offered targets behind another power\'s ground — every ' +
      'volley at those comes back no-route', 5);
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
  // Staging — the answer to the frozen board (§8, and see _aiTestLastStand)
  // -------------------------------------------------------------------------

  test('a power that cannot afford its best target masses toward it instead of holding', function () {
    var worst = _aiTestWorstHoldout('fra');
    assert(worst && worst.decision,
      'could not build a last-stand board for fra');
    assert(worst.odds < AI.MIN_ODDS,
      'the fixture is not a deadlock: fra can already attack ' + worst.foe +
      "'s capital at odds " + worst.odds + ' — this test would pass without a fix');

    var b = _aiTestLastStand('fra', worst.foe);
    var d = aiDecide(b.state, 'fra');
    assertEqual(d.kind, 'stage',
      'holding 107 of 108 stations at capacity, fra could not afford ' + b.holdout +
      ' (odds ' + worst.odds.toFixed(3) + ' < ' + d.minOdds + ') and decided "' +
      d.kind + '/' + d.reason + '". A power that cannot attack must move force ' +
      'toward the front; `hold` here is the frozen board.');

    assertEqual(b.state.stations[d.target].owner, 'fra',
      'a stage must reinforce a station the power OWNS — target ' + d.target +
      ' belongs to ' + b.state.stations[d.target].owner);
    assertEqual(d.stageFor, b.holdout,
      'fra massed for ' + _aiJson(d.stageFor) + ', but the only target it wants is ' + b.holdout);

    var bad = [];
    for (var i = 0; i < d.sources.length; i++) {
      if (b.state.stations[d.sources[i]].owner !== 'fra') bad.push(d.sources[i]);
    }
    assertNone(bad, 'staged from stations it does not own');

    // The depot has to be able to REACH the objective, or the mass is being
    // walked somewhere it can never be spent from — activity that looks like
    // progress and is not.
    var route = commandRoute(d.target, d.stageFor, b.state, 'fra');
    assert(route && route.length >= 2,
      'the depot ' + d.target + ' has no legal route to the objective ' + d.stageFor);
  });

  test('the frozen board resolves — a staged assault eventually takes the holdout', function () {
    var worst = _aiTestWorstHoldout('fra');
    var b = _aiTestLastStand('fra', worst.foe);
    var s = b.state;

    // Precondition, asserted rather than assumed: the assault must not be
    // affordable on tick one, or "the board moved" proves nothing.
    assert(aiDecide(s, 'fra').kind !== 'attack',
      'the fixture starts with an affordable attack — it is not the frozen board');

    var budget = 20000;                       // 33 sim-minutes; the fix lands ~6,400
    var flipped = -1;
    for (var t = 0; t < budget; t++) {
      stepTick(s);
      if (s.stations[b.holdout].owner === 'fra') { flipped = s.tick; break; }
      if (s.winner) break;
    }
    assert(flipped > 0,
      'after ' + budget + ' ticks the board had not moved: ' + b.holdout + ' is still ' +
      s.stations[b.holdout].owner + '. This is the 65%-draw failure — an empire at ' +
      'capacity, unable to attack, doing nothing about it forever.');

    // And it must have got there by massing, not by the defender withering.
    var staged = g.aiDecisions(s, 'fra', AI.LOG_MAX).filter(function (x) {
      return x.kind === 'stage';
    });
    assert(staged.length > 0,
      'the holdout fell without fra ever staging — the board moved for some other reason ' +
      'and this test is not measuring the fix');
  });

  test('staging never sends at the enemy, and every own-target send is a logged stage', function () {
    var b = _aiTestLastStand('fra', _aiTestWorstHoldout('fra').foe);
    var sends = _aiTestSends(b.state, 4000);
    assert(sends.length > 0, 'the AI issued no sends at all in 4,000 ticks');

    var byTick = {};
    var log = g.aiDecisions(b.state, null, AI.LOG_MAX);
    for (var i = 0; i < log.length; i++) byTick[log[i].power + '@' + log[i].tick] = log[i];

    var problems = [], own = 0;
    for (i = 0; i < sends.length; i++) {
      var sd = sends[i];
      var d = byTick[sd.owner + '@' + sd.tick];
      if (!d) { problems.push(sd.owner + '@' + sd.tick + ' sent with no logged decision'); continue; }
      var isOwn = (sd.targetOwner === sd.owner);
      if (isOwn) own++;
      if (isOwn && d.kind !== 'stage') {
        problems.push(sd.owner + '@' + sd.tick + ' sent to its own ' + sd.target +
                      ' but logged kind "' + d.kind + '" — a reinforcement recorded as an attack');
      }
      if (!isOwn && d.kind === 'stage') {
        problems.push(sd.owner + '@' + sd.tick + ' logged a stage but sent at ' + sd.target +
                      ', owned by ' + sd.targetOwner + ' — staging must never attack');
      }
    }
    assertNone(problems, 'staging and attacking got confused with each other', 8);
    assert(own > 0,
      'not one send in 4,000 ticks reinforced a station the sender owned — staging never fired');
  });

  test('a staging march obeys the garrison floor exactly as a volley does', function () {
    // Deliberately NOT the full board. At capacity every allowance is exactly
    // COMMIT_FRACTION, so the floor never binds and this test passed against
    // an implementation that ignored it outright — caught by removing the
    // clamp and watching nothing go red (known-issues.md #8). At 45% of
    // capacity the allowance is (0.45 - 0.25)/0.45 = 0.444 and the floor is
    // the thing actually choosing the fraction.
    var b = _aiTestLastStand('fra', _aiTestWorstHoldout('fra').foe, 4242, 0.45);
    var sends = _aiTestSends(b.state, 6000);
    var problems = [], bound = 0, staged = 0;
    for (var i = 0; i < sends.length; i++) {
      var sd = sends[i];
      if (sd.targetOwner === sd.owner) {
        staged++;
        if (sd.fraction < AI.COMMIT_FRACTION - 1e-9) bound++;
      }
      for (var j = 0; j < sd.sources.length; j++) {
        var src = sd.sources[j];
        var sent = src.units * sd.fraction;
        var spare = src.units - AI.HOME_GARRISON_FLOOR * src.capacity;
        if (sent > spare + 1e-6) {
          problems.push(sd.owner + '@' + sd.tick + ' sent ' + sent.toFixed(2) + ' from ' +
                        src.sid + ' (' + src.units.toFixed(2) + ' units, capacity ' +
                        src.capacity + '), leaving it under the ' +
                        AI.HOME_GARRISON_FLOOR + ' floor');
        }
        if (sd.fraction > AI.COMMIT_FRACTION + 1e-9) {
          problems.push(sd.owner + '@' + sd.tick + ' fraction ' + sd.fraction +
                        ' exceeds COMMIT_FRACTION ' + AI.COMMIT_FRACTION);
        }
      }
    }
    assertNone(problems,
      'a staging march stripped an interior garrison harder than an attack may', 8);
    assert(staged > 0, 'no staging march was issued, so the floor was never tested');
    assert(bound > 0,
      staged + ' staging marches were issued and not one of them was limited by ' +
      'HOME_GARRISON_FLOOR (every fraction was the full COMMIT_FRACTION ' +
      AI.COMMIT_FRACTION + '). The floor is inert on this board, so this test ' +
      'would pass against an implementation that ignored it — it is not a check.');
  });

  test('an attack the AI launches arrives together — it does not defeat itself in detail', function () {
    // §8: five distant cities thrown at one target are destroyed one at a
    // time. The window a volley is allowed to span is DERIVED from the odds it
    // demands (known-issues.md #5): a square-law fight at r resolves in
    // atanh(1/r)/COMBAT_RATE ticks, so anything landing later than that joins
    // a battle already decided. Measured on what applyCommand ACCEPTED — what
    // was committed and what arrives together are the same question.
    var boards = [newGame(9021), _aiTestLastStand('fra', _aiTestWorstHoldout('fra').foe).state];
    var problems = [], attacks = 0;
    for (var n = 0; n < boards.length; n++) {
      var s = boards[n];
      var sends = _aiTestSends(s, 3000);
      var log = g.aiDecisions(s, null, AI.LOG_MAX);
      var byTick = {};
      for (var i = 0; i < log.length; i++) byTick[log[i].power + '@' + log[i].tick] = log[i];

      for (i = 0; i < sends.length; i++) {
        var sd = sends[i];
        var d = byTick[sd.owner + '@' + sd.tick];
        if (!d || d.kind !== 'attack' || !sd.ok || sd.etas.length < 2) continue;
        attacks++;
        var lo = Infinity, hi = -Infinity;
        for (var k = 0; k < sd.etas.length; k++) {
          if (sd.etas[k] < lo) lo = sd.etas[k];
          if (sd.etas[k] > hi) hi = sd.etas[k];
        }
        var r = d.minOdds > 1.0001 ? d.minOdds : 1.0001;
        var window = (0.5 * Math.log((1 + 1 / r) / (1 - 1 / r))) / B.COMBAT_RATE;
        if (hi - lo > window + 1e-6) {
          problems.push(sd.owner + '@' + sd.tick + ' -> ' + sd.target + ': stacks land ' +
                        (hi - lo).toFixed(1) + ' ticks apart, but the fight it demanded ' +
                        '(' + d.minOdds.toFixed(2) + ':1) is over in ' + window.toFixed(1) +
                        ' — the tail is fed in piecemeal');
        }
      }
    }
    assert(attacks > 0, 'no multi-source attack was launched, so nothing was measured');
    assertNone(problems, 'the AI committed forces that cannot arrive together', 8);
  });

  // -------------------------------------------------------------------------
  // The peace of the partition — the OTHER way the board froze
  // -------------------------------------------------------------------------

  test('a power boxed in by peace with nowhere else to go breaks the peace', function () {
    // Same board as the last stand, but at peace: relations at RELATION_START,
    // no war latched. This was 13 of the 14 draws left after staging landed —
    // two survivors, no neutral ground, and a Concert holding a peace with
    // nothing left to preserve.
    var b = _aiTestLastStand('fra', 'ott');
    delete b.state.powers.fra.wars.ott;
    delete b.state.powers.ott.wars.fra;
    b.state.powers.fra.relations.ott = AI.RELATION_START;
    b.state.powers.ott.relations.fra = AI.RELATION_START;

    assert(!atWar(b.state, 'fra', 'ott'), 'the fixture is at war — it is not the partition');
    var neutrals = 0;
    for (var i = 0; i < STATION_IDS.length; i++) {
      if (b.state.stations[STATION_IDS[i]].owner === 'neutral') neutrals++;
    }
    assertEqual(neutrals, 0, 'the fixture still has unaligned ground to expand into');

    var d = aiDecide(b.state, 'fra');
    assert(d.kind === 'attack' || d.kind === 'stage',
      'fra holds 107 of 108 stations, has no neutral ground left anywhere, and the only ' +
      'station it does not own belongs to a power it is at peace with. It decided "' +
      d.kind + '/' + d.reason + '". applyCommand imposes no war check, so a human here ' +
      'simply attacks — an AI that cannot is shackled, and the game cannot end.');

    // Either verb is right, and which one appears depends only on whether the
    // fist is already assembled. What must be true of both is that the
    // objective is the holdout and the log says which rule let it through.
    if (d.kind === 'attack') {
      assertEqual(d.reason, 'peace-exhausted',
        'the peace was broken without saying so in the log — reason is ' + _aiJson(d.reason));
      assertEqual(d.target, b.holdout, 'attacked ' + d.target + ', expected ' + b.holdout);
    } else {
      assertEqual(d.reason, 'staging',
        'a stage must keep the pinned "staging" reason — got ' + _aiJson(d.reason));
      assertEqual(d.stageFor, b.holdout,
        'massed for ' + _aiJson(d.stageFor) + ', expected ' + b.holdout);
      assertEqual(b.state.stations[d.target].owner, 'fra',
        'staged into ' + d.target + ', which fra does not own');
    }
  });

  test('the peace still holds while there is unaligned ground to take', function () {
    // The guard on the rule above. If breaking the peace were unconditional
    // the Concert (§6) would be decorative, and known-issues.md #11 already
    // recorded what that looks like. One neutral station in reach must be
    // enough to keep a power off its neighbour.
    var b = _aiTestLastStand('fra', 'ott');
    delete b.state.powers.fra.wars.ott;
    delete b.state.powers.ott.wars.fra;
    b.state.powers.fra.relations.ott = AI.RELATION_START;
    b.state.powers.ott.relations.fra = AI.RELATION_START;

    // A lightly held neutral village, chosen without naming an id: the first
    // station that is neither the holdout nor linked to it, so taking it can
    // never be confused with the assault under test.
    var adj = {}, i;
    for (i = 0; i < L.length; i++) {
      if (L[i].a === b.holdout) adj[L[i].b] = true;
      if (L[i].b === b.holdout) adj[L[i].a] = true;
    }
    var village = null;
    for (i = 0; i < STATION_IDS.length && !village; i++) {
      var sid = STATION_IDS[i];
      if (sid !== b.holdout && !adj[sid]) village = sid;
    }
    assert(village, 'could not find a station to leave neutral');
    setStationOwner(b.state, village, 'neutral');
    b.state.stations[village].units.infantry = 1;

    // The holdout is left WEAKLY GARRISONED on purpose. Fully garrisoned it is
    // unaffordable anyway, so the AI would pass it over for reasons that have
    // nothing to do with the war gate — and this test passed against a build
    // with the gate removed entirely. Caught by lifting the gate and watching
    // nothing go red (known-issues.md #8). Weak, it is both affordable AND the
    // highest-scoring candidate on the board, so peace is the only thing that
    // can be keeping the AI off it.
    b.state.stations[b.holdout].units.infantry = 3;

    var cands = g.aiCandidates(b.state, 'fra', g.aiContext(b.state, 'fra'));
    assert(cands.length > 0 && _aiCandSid(cands[0]) === b.holdout,
      'the peer capital is not the top-scoring candidate on this board, so the war gate ' +
      'is not what decides the outcome and this test proves nothing about it');

    var d = aiDecide(b.state, 'fra');
    assert(d.kind !== 'attack' || d.target !== b.holdout,
      'fra broke the peace to attack ' + b.holdout + ' while ' + village +
      ' was still unaligned and undefended — expanding into the unaligned comes first (§6)');
    assertEqual(d.target, village,
      'with a free neutral village on the board fra should have taken it, not ' +
      _aiJson(d.target));
    assert(d.reason !== 'peace-exhausted',
      'logged peace-exhausted with neutral ground still on the board');
    assert(!atWar(b.state, 'fra', 'ott'), 'aiDecide mutated the war state');
  });

  test('a staging game is deterministic — same board, same seed, identical outcome', function () {
    var a = _aiTestLastStand('fra', _aiTestWorstHoldout('fra').foe).state;
    var b = _aiTestLastStand('fra', _aiTestWorstHoldout('fra').foe).state;
    _aiRun(a, 2500);
    _aiRun(b, 2500);
    var ja = _aiJson(snapshot(a)), jb = _aiJson(snapshot(b));
    if (ja !== jb) {
      for (var i = 0; i < Math.max(ja.length, jb.length); i++) {
        if (ja[i] !== jb[i]) _aiFailAt(ja, jb, i);
      }
    }
    assert(true);
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
