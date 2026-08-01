// test/commitment-tests.js — 07-roadmap.md B3.
//
// TWO BEHAVIOURS, ONE MILESTONE, and they are not related by accident.
//
// B1 gave every power a horizon: armies may now cross ground they do not own,
// so the set of things a power can plausibly attack got much larger. B3 is what
// makes that an improvement rather than a regression, and it has two halves:
//
//   COMMITMENT   A chosen target is KEPT. Without it a wider horizon just means
//                splitting force in more directions — the AI sends its first
//                volley at one city and its second at another because two
//                comparable fronts trade places in the ranking constantly, and
//                neither city falls. That is defeat in detail (00-vision.md §8)
//                committed by a power against itself, and it is what the
//                r = -0.88 correlation between opening neighbours and win rate
//                measures: the powers with the most directions to spread in do
//                WORST.
//
//   BUILDING     04-development.md §10.3 — "it must, or development becomes a
//                player-only advantage and the balance pass measures nothing."
//
// test/ai-tests.js is written BLIND to the implementation, against the schema
// and the tuning file, and that property is worth keeping. These tests are the
// opposite: they know how the mechanism works and are aimed at the specific
// ways it can be broken while still looking right. Kept in a separate file so
// neither kind contaminates the other.
//
// THE ONE THAT MATTERS MOST is 'building never displaces an attack or a staging
// march'. A build placed anywhere but last in aiDecide turns a power that could
// have taken a city into one that fortified a village, and every other test in
// this file would still pass.
//
// Private helpers are `_cmt…` — this file's prefix (known-issues #9, #12).

'use strict';

function _cmtG() {
  return (typeof globalThis !== 'undefined') ? globalThis
       : (typeof window !== 'undefined') ? window : null;
}

// Loud skip, naming exactly what is missing, rather than a silent pass
// (known-issues #8).
function _cmtNeed(name) {
  var g = _cmtG(), missing = [];
  var fns = ['aiDecide', 'aiTick', 'aiDecisions', '_aiActPlanBuild', 'newGame',
             'stepTick', 'applyCommand', 'snapshot', 'setStationOwner',
             'developmentPlan', 'operatingTier'];
  for (var i = 0; i < fns.length; i++) {
    if (!g || typeof g[fns[i]] !== 'function') missing.push(fns[i] + '()');
  }
  if (typeof BAL === 'undefined' || !BAL.AI || typeof BAL.AI.FOCUS_TICKS !== 'number') {
    missing.push('BAL.AI.FOCUS_TICKS [data/tuning.js]');
  }
  if (typeof DEV_LIVE === 'undefined' || typeof DEV_KINDS === 'undefined') {
    missing.push('DEV_LIVE / DEV_KINDS [sim/development.js]');
  }
  if (typeof STATION_IDS === 'undefined' || typeof LINKS === 'undefined' ||
      typeof POWERS === 'undefined') missing.push('map + scenario data');
  if (missing.length) { skipSuite(name, 'waiting on ' + missing.join(', ')); return null; }
  return g;
}

// ---------------------------------------------------------------------------
// TWO FRONTS — `pid` owns the whole map except two rival capitals, and is at
// war with both.
//
// Built this way for one reason: it is the smallest board on which the AI has a
// genuine CHOICE between two legal attacks, which is the only board a
// commitment rule can be measured on. On the real opening the top-scored target
// is usually the only one that clears, so a focus test there would pass whether
// or not the focus did anything.
//
// AI-free (`aiEnabled = false`, and every test here calls aiDecide directly):
// an opponent issuing its own commands mid-test would move every number below.
// ---------------------------------------------------------------------------
function _cmtTwoFronts(pid, foeA, foeB, fill) {
  var keepA = POWERS[foeA].capital, keepB = POWERS[foeB].capital;
  var s = newGame(4242);
  s.aiEnabled = false;
  var f = (fill === undefined) ? 1 : fill;
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    var own = (sid === keepA) ? foeA : (sid === keepB) ? foeB : pid;
    setStationOwner(s, sid, own);
    s.stations[sid].units = STATIONS[sid].capacity * (own === pid ? f : 1);
  }
  // War, and war that STAYS — the same trap ai-tests.js documents: the latch
  // alone is not enough, because relationsTick reseeds its drift from
  // powers[a].relations[b] and would stand the war straight back down.
  var foes = [foeA, foeB];
  for (var p = 0; p < foes.length; p++) {
    var me = s.powers[pid], them = foes[p], o = s.powers[them];
    if (!me.wars) me.wars = {};
    if (!me.relations) me.relations = {};
    if (!o.wars) o.wars = {};
    if (!o.relations) o.relations = {};
    me.wars[them] = true; me.relations[them] = BAL.AI.RELATION_MIN;
    o.wars[pid] = true;  o.relations[pid] = BAL.AI.RELATION_MIN;
  }
  return { s: s, pid: pid, A: keepA, B: keepB };
}

// ---------------------------------------------------------------------------
// A DEVELOPMENT BOARD — `pid` owns everything except two neighbours of the
// highest-degree station on the map, and every garrison is drained below the
// build threshold.
//
// Built this way because the three narrowings and the ordering rule are all
// but invisible in ordinary play: measured over five seeds x 6,000 ticks, 158
// builds happened and only EIGHT of them had more than one legal site to choose
// between. A run-based ordering test would have passed with the comparison
// reversed, which is a test that cannot fail (known-issues #8) — and it did,
// under mutation, before this fixture replaced it.
//
// Draining first and refilling exactly what the test wants is the whole point:
// the set of legal builds becomes something the test states rather than
// something it hopes for.
// ---------------------------------------------------------------------------
function _cmtDevBoard(pid, foe) {
  var s = newGame(4242);
  s.aiEnabled = false;

  var adj = {};
  for (var i = 0; i < LINKS.length; i++) {
    (adj[LINKS[i].a] = adj[LINKS[i].a] || []).push(LINKS[i].b);
    (adj[LINKS[i].b] = adj[LINKS[i].b] || []).push(LINKS[i].a);
  }
  var keys = Object.keys(adj).sort();
  for (var q = 0; q < keys.length; q++) adj[keys[q]].sort();

  // Highest degree, ties by sid — deterministic, and it is the station most
  // likely to have a neighbour that is itself well connected.
  var hub = null;
  for (var h = 0; h < STATION_IDS.length; h++) {
    var sid = STATION_IDS[h];
    var deg = (adj[sid] || []).length;
    if (!hub || deg > hub.deg) hub = { sid: sid, deg: deg };
  }

  for (var j = 0; j < STATION_IDS.length; j++) {
    setStationOwner(s, STATION_IDS[j], pid);
    s.stations[STATION_IDS[j]].units = 1;
  }
  // Two of the hub's neighbours go to the foe, so the hub has exposure 2 and
  // their other neighbours have exposure 1 — the spread the ordering test needs.
  var flipped = (adj[hub.sid] || []).slice(0, 2);
  for (var k = 0; k < flipped.length; k++) {
    setStationOwner(s, flipped[k], foe);
    s.stations[flipped[k]].units = (STATIONS[flipped[k]].capacity);
  }
  return { s: s, pid: pid, foe: foe, hub: hub.sid, flipped: flipped,
           exposure: _cmtExposure(s, pid) };
}

// Garrison as a fraction of capacity. Above 1.0 is the overflow band, which
// growth reaches legally (GROWTH_OVERFLOW_CEIL = 1.5) and which is the only
// place a tier-2 development could ever operate at tier 2.
function _cmtFill(s, sid, f) {
  s.stations[sid].units = (STATIONS[sid].capacity * f);
}

// Overwrite the focus memo wholesale, so a test never depends on what a
// previous call left behind.
function _cmtSetFocus(s, pid, sid, since) {
  if (!s.aiMemo) s.aiMemo = { next: {}, orders: {}, focus: {} };
  if (!s.aiMemo.focus) s.aiMemo.focus = {};
  if (sid === null) { delete s.aiMemo.focus[pid]; return; }
  s.aiMemo.focus[pid] = { sid: sid, since: (since === undefined) ? s.tick : since };
}

// Which top-level keys of the state changed, ignoring the named ones.
function _cmtChangedKeys(before, after, ignore) {
  var out = [], keys = {}, k;
  for (k in before) if (before.hasOwnProperty(k)) keys[k] = true;
  for (k in after) if (after.hasOwnProperty(k)) keys[k] = true;
  var names = Object.keys(keys).sort();
  for (var i = 0; i < names.length; i++) {
    if (ignore.indexOf(names[i]) >= 0) continue;
    if (JSON.stringify(before[names[i]]) !== JSON.stringify(after[names[i]])) out.push(names[i]);
  }
  return out;
}

// Every build command the AI actually handed to applyCommand over `ticks`,
// with the facts that are only true AT CALL TIME — who owned what, and how
// exposed each station was. A post-hoc read of the final board cannot recover
// any of them.
function _cmtWatchBuilds(state, ticks) {
  var g = _cmtG(), real = g.applyCommand, out = [];
  g.applyCommand = function (st, cmd) {
    var pre = null;
    if (cmd && cmd.type === 'build') {
      pre = { tick: st.tick, owner: cmd.owner, kind: cmd.kind,
              stations: cmd.stations, exposure: _cmtExposure(st, cmd.owner),
              legal: _cmtLegalBuilds(st, cmd.owner) };
    }
    var r = real(st, cmd);
    if (pre) {
      pre.ok = !!(r && r.ok);
      pre.reason = r ? r.reason : null;
      pre.accepted = (r && r.accepted) ? r.accepted : [];
      // AFTER the spend: the whole point of the third narrowing is that the
      // development is running the instant it is paid for.
      pre.operating = pre.ok ? operatingTier(st, cmd.stations[0]) : null;
      out.push(pre);
    }
    return r;
  };
  try {
    for (var t = 0; t < ticks; t++) { if (state.winner) break; stepTick(state); }
  } finally { g.applyCommand = real; }
  return out;
}

// Foreign-neighbour count for every station `pid` owns. "Do I own this?" is the
// one ownership question fog never clouds, so this is the true board on purpose.
function _cmtExposure(state, pid) {
  var adj = {};
  for (var i = 0; i < LINKS.length; i++) {
    (adj[LINKS[i].a] = adj[LINKS[i].a] || []).push(LINKS[i].b);
    (adj[LINKS[i].b] = adj[LINKS[i].b] || []).push(LINKS[i].a);
  }
  var out = {};
  for (var j = 0; j < STATION_IDS.length; j++) {
    var sid = STATION_IDS[j];
    if (state.stations[sid].owner !== pid) continue;
    var ns = adj[sid] || [], n = 0;
    for (var k = 0; k < ns.length; k++) {
      if (state.stations[ns[k]].owner !== pid) n++;
    }
    out[sid] = n;
  }
  return out;
}

// Stations where a build meeting ALL THREE of the AI's narrowings was legal at
// this moment. Deliberately re-derived from sim/development.js rather than
// asked of ai/ai.js: the ordering test below has to compare the choice made
// against the choices available, and asking the chooser what was available
// would make it agree with itself (known-issues #18).
function _cmtLegalBuilds(state, pid) {
  var out = {};
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    if (state.stations[sid].owner !== pid) continue;
    for (var k = 0; k < DEV_KINDS.length; k++) {
      var kind = DEV_KINDS[k];
      if (!DEV_LIVE[kind]) continue;
      var plan = developmentPlan(state, sid, pid, kind);
      if (!plan.ok || plan.tier !== 1) continue;
      if (operatingAfterBuild(state, sid, plan.tier, plan.cost) < plan.tier) continue;
      out[sid] = kind;
      break;
    }
  }
  return out;
}

// ===========================================================================
// The suite
// ===========================================================================

function suiteCommitment() {
  var g = _cmtNeed('ai / commitment and building');
  if (!g) return;
  suite('ai / commitment and building');

  // -------------------------------------------------------------------------
  // Commitment
  // -------------------------------------------------------------------------

  test('the fixture really does offer two attackable fronts', function () {
    // Without this the focus tests below are meaningless: if the second capital
    // could never be attacked on its own merits, "the AI attacked it when
    // focused" would be measuring nothing. Proven by REMOVING the preferred
    // target and watching the walk fall through to the other one.
    var f = _cmtTwoFronts('ger', 'fra', 'ott');
    var d = aiDecide(f.s, f.pid);
    assertEqual(d.kind, 'attack',
      'the two-fronts board produced ' + d.kind + '/' + d.reason + ', not an attack');
    var other = (d.target === f.A) ? f.B : f.A;
    assert(d.target === f.A || d.target === f.B,
      'attacked ' + d.target + ', which is neither rival capital');
    setStationOwner(f.s, d.target, f.pid);
    var d2 = aiDecide(f.s, f.pid);
    assertEqual(d2.target, other,
      'with ' + d.target + ' removed the AI still did not attack ' + other +
      ' (' + d2.kind + '/' + d2.reason + ') — the second front is not attackable, ' +
      'so the focus tests below would prove nothing');
  });

  test('a focus makes the AI attack what it committed to, not the top score', function () {
    var f = _cmtTwoFronts('ger', 'fra', 'ott');
    var unfocused = aiDecide(f.s, f.pid).target;
    var other = (unfocused === f.A) ? f.B : f.A;
    _cmtSetFocus(f.s, f.pid, other);
    var d = aiDecide(f.s, f.pid);
    assertEqual(d.kind, 'attack', 'focused decision came back as ' + d.kind + '/' + d.reason);
    assertEqual(d.target, other,
      'committed to ' + other + ' and attacked ' + d.target + ' instead — the ' +
      'candidate reorder is not reaching the walk');
    // And the control: no focus, and it goes back to preferring the top score.
    _cmtSetFocus(f.s, f.pid, null);
    assertEqual(aiDecide(f.s, f.pid).target, unfocused,
      'clearing the focus did not restore the unfocused choice');
  });

  test('the focus expires exactly at FOCUS_TICKS, not a tick later', function () {
    var f = _cmtTwoFronts('ger', 'fra', 'ott');
    var unfocused = aiDecide(f.s, f.pid).target;
    var other = (unfocused === f.A) ? f.B : f.A;

    _cmtSetFocus(f.s, f.pid, other, f.s.tick - BAL.AI.FOCUS_TICKS);
    assertEqual(aiDecide(f.s, f.pid).target, other,
      'a focus exactly FOCUS_TICKS old was already discarded — the ceiling is ' +
      'inclusive, and an off-by-one here silently shortens every commitment');

    _cmtSetFocus(f.s, f.pid, other, f.s.tick - BAL.AI.FOCUS_TICKS - 1);
    assertEqual(aiDecide(f.s, f.pid).target, unfocused,
      'a focus one tick PAST FOCUS_TICKS still held — the ceiling is not a ' +
      'ceiling, and a power can be locked onto a dead front forever');
  });

  test('a focus can never make the AI attack something it would refuse', function () {
    // Commitment reorders the candidate list; it does not bypass the walk. A
    // focus on a target the power cannot beat must therefore lose to the gates,
    // not to the ranking. This is the property that makes the whole mechanism
    // safe, and an implementation that special-cased the focused target instead
    // of reordering would fail here and nowhere else.
    var f = _cmtTwoFronts('ger', 'fra', 'ott');
    var unfocused = aiDecide(f.s, f.pid).target;
    var other = (unfocused === f.A) ? f.B : f.A;
    f.s.stations[other].units = 100000;      // unbeatable, by a mile
    _cmtSetFocus(f.s, f.pid, other);
    var d = aiDecide(f.s, f.pid);
    assert(!(d.kind === 'attack' && d.target === other),
      'attacked its focus ' + other + ' at odds ' + d.odds + ' against a minOdds of ' +
      d.minOdds + ' — the focus is bypassing the odds floor');
  });

  test('a focus that is no longer a candidate is ignored, not obeyed', function () {
    var f = _cmtTwoFronts('ger', 'fra', 'ott');
    var unfocused = aiDecide(f.s, f.pid).target;
    // Ground this power already holds is never a candidate (rejected
    // 'already-held'), which is the cheapest way to name a station the reorder
    // cannot find.
    var mine = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      if (f.s.stations[STATION_IDS[i]].owner === f.pid) { mine = STATION_IDS[i]; break; }
    }
    assert(!!mine, 'fixture gave ' + f.pid + ' no stations at all');
    _cmtSetFocus(f.s, f.pid, mine);
    var d = aiDecide(f.s, f.pid);
    assertEqual(d.target, unfocused,
      'a focus on ' + mine + ', which is not a candidate, changed the decision to ' +
      d.target);
  });

  test('aiDecide does not clear a stale focus — reading must not change the board', function () {
    // aiDecide's contract is that a test may call it and inspect the result with
    // the board untouched. An earlier draft of the reorder DELETED the stale
    // entry here, which would have meant that merely asking what Austria would
    // do changed what Austria did next — an aiDecisions() call from the console
    // would have silently retargeted a power mid-game.
    var f = _cmtTwoFronts('ger', 'fra', 'ott');
    var problems = [];
    var cases = [
      { what: 'expired', sid: f.A, since: f.s.tick - BAL.AI.FOCUS_TICKS - 50 },
      { what: 'not a candidate', sid: POWERS[f.pid].capital, since: f.s.tick },
      { what: 'live', sid: f.B, since: f.s.tick },
    ];
    for (var i = 0; i < cases.length; i++) {
      _cmtSetFocus(f.s, f.pid, cases[i].sid, cases[i].since);
      var before = snapshot(f.s);
      aiDecide(f.s, f.pid);
      var after = snapshot(f.s);
      var changed = _cmtChangedKeys(before, after, ['rng']);
      for (var k = 0; k < changed.length; k++) {
        problems.push('a ' + cases[i].what + ' focus made aiDecide write state.' + changed[k]);
      }
    }
    assertNone(problems, 'aiDecide mutated the state it was only supposed to read');
  });

  test('an accepted order records the focus, and a stage records what it masses FOR', function () {
    // Driven tick by tick so the focus can be read at the moment it is set. A
    // post-hoc read cannot do this: by the end of the run every power has moved
    // on to a later target.
    // Board 1 is the FROZEN two-fronts board, not the plain one: with both
    // rival capitals beatable the AI simply attacks, and the stageFor arm of
    // this test would never run.
    var frozen = _cmtTwoFronts('ger', 'fra', 'ott');
    frozen.s.stations[frozen.A].units = 100000;
    frozen.s.stations[frozen.B].units = 100000;
    frozen.s.aiEnabled = true;
    var boards = [newGame(9007), frozen.s];
    var problems = [], attacks = 0, stages = 0;

    for (var b = 0; b < boards.length; b++) {
      var s = boards[b];
      var seen = s.aiLog ? s.aiLog.length : 0;
      for (var t = 0; t < 600 && !s.winner; t++) {
        stepTick(s);
        var log = s.aiLog || [];
        // The ring buffer trims from the front, so index arithmetic is only
        // safe while it has not wrapped. 600 ticks cannot fill LOG_MAX.
        for (var i = seen; i < log.length; i++) {
          var d = log[i];
          var want = null;
          if (d.kind === 'attack') { want = d.target; attacks++; }
          else if (d.kind === 'stage') { want = d.stageFor; stages++; }
          if (!want) continue;
          var f = (s.aiMemo && s.aiMemo.focus) ? s.aiMemo.focus[d.power] : null;
          if (!f) {
            problems.push('board ' + b + ' ' + d.power + '@' + d.tick + ' ' + d.kind +
                          ' on ' + want + ' recorded no focus at all');
          } else if (f.sid !== want) {
            problems.push('board ' + b + ' ' + d.power + '@' + d.tick + ' ' + d.kind +
                          ' committed to ' + f.sid + ', expected ' + want +
                          (d.kind === 'stage' ? ' (a stage must focus its OBJECTIVE, ' +
                           'not the depot — the depot is its own ground and can never ' +
                           'be a candidate, so that focus would expire having done nothing)' : ''));
          }
        }
        seen = log.length;
      }
    }
    assert(attacks > 0, 'no accepted attack was logged in 1200 ticks across two boards — ' +
      'this test asserts nothing about a decision it never sees (known-issues #8)');
    assert(stages > 0, 'no accepted stage was logged in 1200 ticks across two boards — ' +
      'the stageFor arm of this test never ran');
    assertNone(problems, 'the commitment was not recorded from an accepted order');
  });

  // -------------------------------------------------------------------------
  // Building — 04-development.md §10.3
  // -------------------------------------------------------------------------

  test('the AI builds, in an ordinary game, through applyCommand', function () {
    var s = newGame(9007);
    var builds = _cmtWatchBuilds(s, 1200);
    assert(builds.length > 0,
      'no power built anything in 1200 ticks of a normal game — development is a ' +
      'player-only advantage and the balance pass measures nothing (04-development.md §10.3)');
    var problems = [];
    for (var i = 0; i < builds.length; i++) {
      var b = builds[i];
      if (!b.ok) problems.push(b.owner + '@' + b.tick + ' build refused: ' + b.reason);
      if (!Array.isArray(b.stations) || b.stations.length !== 1) {
        problems.push(b.owner + '@' + b.tick + ' build named ' + JSON.stringify(b.stations) +
          ' — the command takes `stations`, and a `sources` typo is a silent no-stations reject');
      }
    }
    assertNone(problems, 'the AI issued build commands the sim would not take');
  });

  test('building never displaces an attack or a staging march', function () {
    // THE ONE THAT MATTERS. A build considered before the walk turns a power
    // that could have taken a city into one that fortified a village, and every
    // other test in this file still passes.
    //
    // Both boards below have a legal, affordable, immediately-operating build
    // available — asserted, not assumed — and on both the AI must still choose
    // the order that moves units.
    var problems = [];

    var f = _cmtTwoFronts('ger', 'fra', 'ott');
    assert(!!_aiActPlanBuild(f.s, f.pid),
      'the attack board had no build available, so it cannot show that an attack ' +
      'was preferred to one');
    var d = aiDecide(f.s, f.pid);
    if (d.kind !== 'attack') {
      problems.push('with an attack available the AI chose ' + d.kind + '/' + d.reason);
    }

    // Frozen: both rival capitals unbeatable, so the walk falls through to a
    // staging march. The build is still available and must still lose.
    var z = _cmtTwoFronts('ger', 'fra', 'ott');
    z.s.stations[z.A].units = 100000;
    z.s.stations[z.B].units = 100000;
    assert(!!_aiActPlanBuild(z.s, z.pid),
      'the frozen board had no build available, so it cannot show that staging ' +
      'was preferred to one');
    var dz = aiDecide(z.s, z.pid);
    if (dz.kind !== 'stage') {
      problems.push('with a staging march available the AI chose ' + dz.kind + '/' + dz.reason);
    }

    assertNone(problems, 'a build displaced an order that moves units');
  });

  test('every development the AI builds switches on the moment it is paid for', function () {
    // Narrowing 3. Without it a power spends half a city on a development that
    // does nothing until it regrows — and it is building precisely because it is
    // stuck, which is the worst moment to carry an unpaid-for defence.
    var s = newGame(9007);
    var builds = _cmtWatchBuilds(s, 1200);
    assert(builds.length > 0, 'no builds observed — this test asserts nothing');
    var problems = [];
    for (var i = 0; i < builds.length; i++) {
      var b = builds[i];
      if (!b.ok) continue;
      if (!(b.operating >= b.accepted[0].tier)) {
        problems.push(b.owner + '@' + b.tick + ' built ' + b.kind + ' ' + b.accepted[0].tier +
          ' at ' + b.stations[0] + ' and it came up operating at ' + b.operating);
      }
    }
    assertNone(problems, 'the AI paid for developments that were not running');
  });

  test('the AI only builds kinds that do something, and only tier 1', function () {
    var s = newGame(9007);
    var builds = _cmtWatchBuilds(s, 1200);
    assert(builds.length > 0, 'no builds observed — this test asserts nothing');
    var problems = [];
    for (var i = 0; i < builds.length; i++) {
      var b = builds[i];
      if (!DEV_LIVE[b.kind]) {
        problems.push(b.owner + '@' + b.tick + ' built ' + b.kind + ', which has no effect ' +
          'wired up (DEV_LIVE) — a real cost for nothing, and the balance pass would be ' +
          'measuring the AI handicapping itself');
      }
      if (b.ok && b.accepted[0].tier !== 1) {
        problems.push(b.owner + '@' + b.tick + ' built tier ' + b.accepted[0].tier +
          '; tier 2 costs 0.75 x capacity and can never operate above 1 at the moment ' +
          'it is paid for');
      }
    }
    assertNone(problems, 'the AI bought developments it should not have');
  });

  test('the AI builds on its most exposed frontier, given a choice', function () {
    var b = _cmtDevBoard('ger', 'fra');
    // Two owned stations, both buildable, DIFFERENT exposure. The fixture
    // asserts the spread rather than assuming it: on a map edit that changed
    // the hub's degree this would otherwise quietly become a one-candidate
    // test that passes with the comparison reversed.
    var less = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      if (sid === b.hub) continue;
      if (b.s.stations[sid].owner !== b.pid) continue;
      if (b.exposure[sid] === 1) { less = sid; break; }
    }
    assert(!!less, 'no owned station with exposure 1 — the fixture offers no comparison');
    assert(b.exposure[b.hub] > b.exposure[less],
      'hub ' + b.hub + ' exposure ' + b.exposure[b.hub] + ' is not above ' + less +
      ' exposure ' + b.exposure[less] + ' — nothing to order');

    // Each ALONE is a legal build, so the choice below is between two real
    // options rather than between one option and nothing.
    _cmtFill(b.s, less, 1);
    var only = _aiActPlanBuild(b.s, b.pid);
    assert(only && only.sid === less, 'the less exposed station ' + less +
      ' was not buildable on its own (' + JSON.stringify(only) + '), so preferring ' +
      'the hub over it proves nothing');
    _cmtFill(b.s, less, 0.02);
    _cmtFill(b.s, b.hub, 1);
    var hubOnly = _aiActPlanBuild(b.s, b.pid);
    assert(hubOnly && hubOnly.sid === b.hub, 'the hub ' + b.hub + ' was not buildable on ' +
      'its own (' + JSON.stringify(hubOnly) + ')');

    _cmtFill(b.s, less, 1);
    var pick = _aiActPlanBuild(b.s, b.pid);
    assert(!!pick, 'with two buildable stations the AI planned no build at all');
    assertEqual(pick.sid, b.hub,
      'chose ' + pick.sid + ' (exposure ' + b.exposure[pick.sid] + ') over ' + b.hub +
      ' (exposure ' + b.exposure[b.hub] + ') — the frontier ordering is inverted');
  });

  test('the AI does not develop its interior', function () {
    // An interior city cannot be attacked until the frontier falls, so forting
    // one is spending against a threat that does not exist yet. Invisible in
    // ordinary play — the exposed-first ordering already keeps interior sites
    // last — so it is measured on a board where the interior is the ONLY thing
    // that can afford a build.
    var b = _cmtDevBoard('ger', 'fra');
    var interior = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      if (b.s.stations[sid].owner !== b.pid) continue;
      if (b.exposure[sid] === 0) { interior = sid; break; }
    }
    assert(!!interior, 'no interior station on the fixture board');
    _cmtFill(b.s, interior, 1);
    var plan = developmentPlan(b.s, interior, b.pid, 'fort');
    assert(plan.ok && plan.tier === 1 &&
           operatingAfterBuild(b.s, interior, plan.tier, plan.cost) >= plan.tier,
      'the interior station ' + interior + ' could not have been built anyway (' +
      plan.reason + ') — this test would pass for the wrong reason');
    assertEqual(_aiActPlanBuild(b.s, b.pid), null,
      'the AI planned to develop ' + interior + ', which has no foreign neighbour');

    // Control: the same board, one frontier station filled, and it builds.
    _cmtFill(b.s, b.hub, 1);
    var pick = _aiActPlanBuild(b.s, b.pid);
    assert(pick && pick.sid === b.hub,
      'the control failed — with a frontier site available the AI still planned ' +
      JSON.stringify(pick) + ', so the null above may mean nothing');
  });

  test('the AI will not buy a tier 2, even where one would operate', function () {
    // Narrowing 2, and it is NOT implied by narrowing 3. A tier 2 costs
    // 0.75 x capacity and needs 0.5 x capacity left behind to run, so it wants
    // 1.25 x capacity standing — which the overflow band reaches
    // (GROWTH_OVERFLOW_CEIL = 1.5). Measured: across five seeds x 6,000 ticks
    // there were nine such moments, and the AI happened never to be choosing at
    // one of them, so only a built fixture can show this.
    var b = _cmtDevBoard('ger', 'fra');
    _cmtFill(b.s, b.hub, 1.5);
    b.s.stations[b.hub].development = { kind: 'fort', tier: 1 };
    var plan = developmentPlan(b.s, b.hub, b.pid, 'fort');
    assert(plan.ok && plan.tier === 2,
      'the fixture did not offer a tier 2 at ' + b.hub + ' (' + plan.reason + '/' +
      plan.tier + ') — this test would pass for the wrong reason');
    assert(operatingAfterBuild(b.s, b.hub, plan.tier, plan.cost) >= plan.tier,
      'the tier 2 at ' + b.hub + ' would not have operated anyway, so narrowing 3 ' +
      'already blocks it and this test proves nothing about narrowing 2');
    assertEqual(_aiActPlanBuild(b.s, b.pid), null,
      'the AI planned a tier 2 — breadth beats depth for a chooser that cannot ' +
      'reason about regrowth, and two forted cities beat one twice-forted');
  });

  test('the AI builds nothing when no development has an effect', function () {
    // Narrowing 1, read off DEV_LIVE rather than hard-coded, so the day a port
    // does something the AI starts weighing ports. Flipping DEV_LIVE is the only
    // way to see the filter at all: fort is legal at all 108 stations and sorts
    // first in DEV_KINDS, so port and factory are never reached in play.
    var b = _cmtDevBoard('ger', 'fra');
    _cmtFill(b.s, b.hub, 1);
    assert(!!_aiActPlanBuild(b.s, b.pid),
      'the board offered no build with DEV_LIVE untouched — nothing to suppress');
    var saved = {};
    for (var i = 0; i < DEV_KINDS.length; i++) {
      saved[DEV_KINDS[i]] = DEV_LIVE[DEV_KINDS[i]];
      DEV_LIVE[DEV_KINDS[i]] = false;
    }
    var plan;
    try { plan = _aiActPlanBuild(b.s, b.pid); }
    finally {
      for (var k = 0; k < DEV_KINDS.length; k++) DEV_LIVE[DEV_KINDS[k]] = saved[DEV_KINDS[k]];
    }
    assertEqual(plan, null,
      'with every development marked inert the AI still planned ' + JSON.stringify(plan) +
      ' — it would be paying a real cost for nothing, and the balance pass would be ' +
      'measuring the AI handicapping itself');
  });

  test('in ordinary play the AI never develops an interior city', function () {
    // The end-to-end companion to the fixture tests above: the rule holding on a
    // built board is not evidence it holds in a game.
    var s = newGame(9007);
    var builds = _cmtWatchBuilds(s, 1200);
    assert(builds.length > 0, 'no builds observed — this test asserts nothing');
    var problems = [];
    for (var i = 0; i < builds.length; i++) {
      var b = builds[i], sid = b.stations[0];
      if (!(b.exposure[sid] > 0)) {
        problems.push(b.owner + '@' + b.tick + ' forted ' + sid + ', which had ' +
          b.exposure[sid] + ' foreign neighbours');
      }
      var better = [], ids = Object.keys(b.legal).sort();
      for (var k = 0; k < ids.length; k++) {
        if (b.exposure[ids[k]] > b.exposure[sid]) {
          better.push(ids[k] + '(' + b.exposure[ids[k]] + ')');
        }
      }
      if (better.length) {
        problems.push(b.owner + '@' + b.tick + ' forted ' + sid + ' at exposure ' +
          b.exposure[sid] + ' while it could have forted ' + better.join(', '));
      }
    }
    assertNone(problems, 'the AI developed somewhere other than its most exposed frontier');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/commitment-tests.js`
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
      var fpath = path.join(root, SCRIPTS[i]);
      if (!fs.existsSync(fpath)) continue;
      try { vm.runInThisContext(fs.readFileSync(fpath, 'utf8'), { filename: SCRIPTS[i] }); }
      catch (e) { console.error('LOAD ERROR in ' + SCRIPTS[i] + ': ' + e.message); process.exit(2); }
    }
    resetTests();
    suiteCommitment();
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
