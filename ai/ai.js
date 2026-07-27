'use strict';

// ---------------------------------------------------------------------------
// ai/ai.js — cadence, commitment and the only mutation in ai/.
//
// The AI is split in two (01-data-schema.md, "AI API — pinned names"):
// ai/score.js answers "which station is worth taking?" and knows nothing about
// commands or timing; this file answers "can I actually take it, and with
// what?" and owns everything that touches the board.
//
// 00-vision.md §6 names the two failure modes a real-time AI defaults to —
// statue and hydra — and gives three guardrails against them:
//
//   1. ACTION BUDGET. One order every few sim-seconds per power. It cannot
//      out-click you. Implemented as ACTION_INTERVAL_TICKS with seeded
//      +/-ACTION_JITTER_TICKS, so seven powers do not fire on the same tick
//      and produce a visible pulse across the board.
//   2. THINK IN FRONTS. One target station and a commitment budget per
//      decision, never per-stack micromanagement.
//   3. EVERY DECISION LOGGED, with its score. `kind: 'hold'` carrying a reason
//      is a REAL decision, not an absence of one — a power that does nothing
//      for two minutes must be able to say why, or it is indistinguishable
//      from a power whose code never ran. §6: "a passive AI is otherwise
//      undebuggable."
//
// The AI plays the same game the human does. It has no privileged path to the
// board: it builds the same many-to-one volley from §8, hands it to
// applyCommand(), and reads applyCommand's `rejected` array as its only
// feedback channel. If a volley would be illegal for the player it is illegal
// here.
//
// DEFEAT IN DETAIL is the defining mistake of the game (§8) and therefore the
// thing this file exists to avoid. Two mechanisms:
//
//   * Sources are drawn from within SOURCE_MAX_HOPS **of the target**, not of
//     the AI's own territory. Read the constant's comment in data/tuning.js:
//     that distinction is the single most important AI competence constant.
//   * The remaining ETA spread is then measured with routeEtaTicks() — the
//     same helper the player's preview lines use, so the AI sees exactly the
//     information the player sees — and stragglers are dropped. The window is
//     DERIVED, not invented: a square-law fight at odds r resolves in
//     atanh(1/r)/COMBAT_RATE ticks (docs/testing/known-issues.md #5), so a
//     stack arriving later than that arrives after the battle it was meant to
//     join has already been decided. It is not reinforcement, it is a second
//     army fed in piecemeal.
//
// TESTABILITY. aiDecide() must not mutate state (beyond drawing from
// state.rng, which is state and therefore reproducible): a test builds a
// board, calls aiDecide, and inspects what the power WOULD do without it
// happening. aiTick() is the only mutating function here.
//
// ai/score.js MAY BE ABSENT. Every call into it is guarded; with it missing,
// aiTick is a clean no-op and aiDecide returns a hold explaining itself. A
// build without a scorer must still run, or every sim test becomes hostage to
// the AI.
//
// Nothing here touches document, Math.random or Date.now.
//
// NAMING. Every top-level function declaration in a classic script lands on
// window, so a "private helper" is a global claim (known-issues.md #9). `_ai`
// alone is NOT enough of a prefix here: ai/score.js and test/ai-tests.js both
// use it, and three names in this file collided with theirs on the first
// draft — ai/ai.js loads last, so its copies silently won and the scorer began
// running against helpers it had never seen. Everything private to this file
// is therefore `_aiAct…` (this is the half that acts).
// ---------------------------------------------------------------------------

// Reasons a decision can carry. The schema lists the common ones; these are
// the full set this file emits, kept in one place so the log is greppable.
//   no-scoring-module  ai/score.js absent — the AI is not running at all
//   no-candidates      the scorer offered nothing inside TARGET_MAX_HOPS
//   already-held       the scorer offered a station this power already owns
//   not-at-war         only enemy targets on offer and the Concert holds (§6)
//   already-committed  a stack or a wave of this power is already on that
//                      target; a second volley now would arrive after the
//                      fight it was meant to join (§8)
//   no-sources         nothing owned within SOURCE_MAX_HOPS of any candidate
//   garrison-floor     every nearby source is at or under its garrison floor
//   too-few-units      the affordable share is below BAL.MIN_SEND_UNITS
//   odds-too-low       best power ratio found was under MIN_ODDS x personality
//   rate-capped        MAX_ORDERS_PER_MINUTE backstop tripped
//   command-rejected   applyCommand refused the volley — see .rejected
var AI_HOLD_REASONS = [
  'no-scoring-module', 'no-candidates', 'already-held', 'not-at-war',
  'already-committed', 'no-sources', 'garrison-floor', 'too-few-units',
  'odds-too-low', 'rate-capped', 'command-rejected',
];

// ---------------------------------------------------------------------------
// State-resident memory
//
// Cadence and rate-limit bookkeeping live INSIDE state, following the
// _relMemo() pattern in sim/relations.js, so a snapshot still fully determines
// the future. Anything kept in a module-level variable would make a restored
// snapshot diverge from the run it came from.
// ---------------------------------------------------------------------------

function _aiActMemo(state) {
  if (!state.aiMemo) {
    state.aiMemo = {
      next: {},     // pid -> earliest tick this power may act again
      orders: {},   // pid -> [ticks of recent applyCommand calls]
    };
  }
  return state.aiMemo;
}

// Adjacency over LINKS. Built once; LINKS is static so it cannot go stale.
// sim/commands.js keeps its own — this is not a copy of a *rule*, just of a
// graph, and reaching into another module's `_`-private helper is exactly the
// coupling known-issues.md #9 warns about.
var _AI_ACT_ADJ = null;

function _aiActAdjacency() {
  if (_AI_ACT_ADJ) return _AI_ACT_ADJ;
  _AI_ACT_ADJ = {};
  if (typeof LINKS === 'undefined' || !LINKS) return _AI_ACT_ADJ;
  for (var i = 0; i < LINKS.length; i++) {
    var l = LINKS[i];
    (_AI_ACT_ADJ[l.a] = _AI_ACT_ADJ[l.a] || []).push(l.b);
    (_AI_ACT_ADJ[l.b] = _AI_ACT_ADJ[l.b] || []).push(l.a);
  }
  // Sorted so a BFS visits neighbours in the same order everywhere.
  var keys = Object.keys(_AI_ACT_ADJ);
  for (var k = 0; k < keys.length; k++) _AI_ACT_ADJ[keys[k]].sort();
  return _AI_ACT_ADJ;
}

function _aiActPowerIds() {
  if (typeof POWER_IDS !== 'undefined' && POWER_IDS && POWER_IDS.length) return POWER_IDS;
  if (typeof POWERS !== 'undefined' && POWERS) return Object.keys(POWERS).sort();
  return [];
}

// Never null, per the aiContext contract: a power with no declared type (or a
// scenario typo) gets neutral 1s rather than crashing the tick.
function _aiActPersonality(pid, ctx) {
  if (ctx && ctx.personality) return ctx.personality;
  var name = (typeof POWERS !== 'undefined' && POWERS[pid]) ? POWERS[pid].ai : null;
  var P = (BAL.AI.PERSONALITIES || {})[name];
  return P || { aggression: 1, minOddsMul: 1, leaderWeight: 1, borderWeight: 1,
                revengeWeight: 1, expandBias: 1, defenseBias: 1 };
}

// ai/score.js is being written in parallel, so read its candidates
// defensively: a bare station id, {sid}, {target} and {id} all work.
function _aiActCandSid(c) {
  if (typeof c === 'string') return c;
  if (!c || typeof c !== 'object') return null;
  return c.sid || c.target || c.id || null;
}

// How FAR a candidate got before it was refused. A decision walks candidates
// best-first, so the last one examined is the worst one — reporting its reason
// would mean a power that failed a dozen good targets on odds logs whatever
// the twelfth-best target happened to trip over. The hold carries the
// deepest-reached obstacle instead, because that is the one worth acting on.
var _AI_ACT_REASON_DEPTH = {
  'already-held': 0, 'not-at-war': 1, 'already-committed': 2,
  'no-sources': 3, 'garrison-floor': 4, 'too-few-units': 5, 'odds-too-low': 6,
};

function _aiActReasonDepth(reason) {
  var d = _AI_ACT_REASON_DEPTH[reason];
  return (d === undefined) ? -1 : d;
}

function _aiActAtanh(x) {
  if (typeof Math.atanh === 'function') return Math.atanh(x);
  return 0.5 * Math.log((1 + x) / (1 - x));
}

// ---------------------------------------------------------------------------
// The ETA spread window (§8)
//
// How far apart, in ticks, two stacks may land and still count as one volley.
// Derived from the odds the AI demands rather than invented: the closed form
// for a square-law fight (known-issues.md #5) is
//
//     ticks = atanh(1 / r) / COMBAT_RATE
//
// so at MIN_ODDS = 1.4 a winning fight is over in ~18 ticks. Anything landing
// after that is not reinforcement. A turtle demanding ~1.9:1 gets an even
// tighter window, which is the correct reading of its personality: it only
// moves when the whole fist lands at once.
// ---------------------------------------------------------------------------

function _aiActSpreadWindow(oddsFloor) {
  var r = (oddsFloor > 1.0001) ? oddsFloor : 1.0001;
  var w = _aiActAtanh(1 / r) / BAL.COMBAT_RATE;
  return (isFinite(w) && w > 0) ? w : BAL.AI.ACTION_INTERVAL_TICKS;
}

// ---------------------------------------------------------------------------
// Power estimation
//
// Odds are a POWER ratio, never a unit ratio. Infantry defends at 1.2 and
// attacks at 1.0, so 2:1 in units is only 1.67:1 in power — comparing unit
// counts would make MIN_ODDS mean something different from what its comment
// says and the AI would walk into fights it loses.
//
// The attacking side is measured by handing stationPower() a PROXY state whose
// only station is the target, with the proposed stack parked in `attackers`.
// stationPower reads nothing but state.stations[sid], so this is a pure read
// that reuses the canonical formula — fort strip, terrain, matchup against the
// defender's actual mix — instead of re-deriving it here and drifting from it
// (known-issues.md #9, second rule).
// ---------------------------------------------------------------------------

function _aiActStackPower(state, sid, pid, stack) {
  if (typeof stationPower !== 'function') {
    // sim/combat.js absent: a crude attack-value sum keeps ai/ai.js loadable
    // on its own. Deliberately not tuned — it is a smoke-test path.
    var p = 0, order = BAL.UNIT_ORDER;
    for (var i = 0; i < order.length; i++) p += stack[order[i]] * BAL.UNITS[order[i]].atk;
    return p;
  }
  var real = state.stations[sid];
  var proxy = { stations: {} };
  var atk = {};
  atk[pid] = stack;
  proxy.stations[sid] = { owner: real.owner, units: real.units, attackers: atk };
  return stationPower(proxy, sid, pid);
}

function _aiActDefenderPower(state, sid) {
  if (typeof stationPower !== 'function') {
    return totalUnits(state.stations[sid].units) * BAL.UNITS.infantry.def;
  }
  return stationPower(state, sid, 'defender');
}

// ---------------------------------------------------------------------------
// Source selection — the competence step
//
// BFS outward FROM THE TARGET, at most SOURCE_MAX_HOPS deep, collecting
// stations this power owns. Not "my stations, and are they near anything?" —
// the direction matters, and it is why the volley lands together.
//
// A station currently under attack is never a source: stripping a garrison
// that is presently in a battle loses that station to win somewhere else.
// ---------------------------------------------------------------------------

function _aiActSourcesNear(state, pid, target) {
  var adj = _aiActAdjacency();
  var maxHops = BAL.AI.SOURCE_MAX_HOPS;
  var seen = {}, frontier = [target], out = [];
  seen[target] = true;

  for (var depth = 1; depth <= maxHops; depth++) {
    var next = [];
    for (var i = 0; i < frontier.length; i++) {
      var nbrs = adj[frontier[i]] || [];
      for (var j = 0; j < nbrs.length; j++) {
        var sid = nbrs[j];
        if (seen[sid]) continue;
        seen[sid] = true;
        next.push(sid);
        var st = state.stations[sid];
        if (!st || st.owner !== pid) continue;
        if (_aiActUnderAttack(state, sid, pid)) continue;
        out.push({ sid: sid, hops: depth });
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return out;
}

function _aiActUnderAttack(state, sid, pid) {
  var st = state.stations[sid];
  if (!st || !st.attackers) return false;
  var ids = Object.keys(st.attackers).sort();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] === pid) continue;
    if (totalUnits(st.attackers[ids[i]]) > BAL.ANNIHILATION_EPSILON) return true;
  }
  return false;
}

// Am I already committed to this target? A stack of mine fighting there, or a
// wave of mine still in flight to it, means a second volley launched now would
// arrive after that fight is decided — the piecemeal feed §8 calls the
// defining mistake. Skip the target and spend the tick somewhere else.
// The wave scan is hoisted out of the candidate loop: state.waves is a global
// list and walking it twelve times per decision, for seven powers, for 36,000
// ticks, for hundreds of games is exactly the kind of cost tools/balance.js
// notices.
function _aiActInflightTargets(state, pid) {
  var to = {};
  for (var i = 0; i < state.waves.length; i++) {
    if (state.waves[i].owner === pid) to[state.waves[i].to] = true;
  }
  return to;
}

function _aiActAlreadyCommitted(state, pid, target, inflight) {
  if (inflight[target]) return true;
  var st = state.stations[target];
  return !!(st && st.attackers && st.attackers[pid] &&
            totalUnits(st.attackers[pid]) > BAL.ANNIHILATION_EPSILON);
}

// ---------------------------------------------------------------------------
// The garrison floor and the commitment fraction
//
// HOME_GARRISON_FLOOR says a source must not drop below 25% of its CAPACITY,
// and COMMIT_FRACTION says a volley sends 75% of what is there. Those two are
// consistent only at exactly full capacity — and growth is switched off at
// GROWTH_CAP_EPSILON = 0.995 of capacity (data/tuning.js §2), so a station is
// never quite full. Applied as a literal "may this source afford 75%?" gate,
// the floor rejects EVERY source on EVERY tick of EVERY game and the AI is a
// statue that logs 'garrison-floor' forever.
//
// So the floor is enforced where it does what its comment says — as a cap on
// how much may leave — rather than as a gate that can never open:
//
//     allowed_i = (units_i - FLOOR x capacity_i) / units_i     capped at
//                                                             COMMIT_FRACTION
//
// applyCommand takes ONE fraction for the whole volley, so the volley's
// fraction is the smallest allowance among the sources it keeps. That makes a
// thinly-held source expensive to include, which is exactly right, and the
// prefix search below drops it when it costs more than it brings.
// ---------------------------------------------------------------------------

function _aiActAllowedFraction(state, sid) {
  var st = state.stations[sid];
  var units = totalUnits(st.units);
  if (units <= 0) return 0;
  var cap = (typeof STATIONS !== 'undefined' && STATIONS[sid]) ? STATIONS[sid].capacity : units;
  var spare = units - BAL.AI.HOME_GARRISON_FLOOR * cap;
  if (spare <= 0) return 0;
  var f = spare / units;
  return f > BAL.AI.COMMIT_FRACTION ? BAL.AI.COMMIT_FRACTION : f;
}

function _aiActSumStack(state, sids, fraction) {
  var stack = emptyUnits();
  for (var i = 0; i < sids.length; i++) {
    addUnits(stack, splitUnits(state.stations[sids[i]].units, fraction));
  }
  return stack;
}

// ---------------------------------------------------------------------------
// Plan one volley against one target. Pure — reads state, mutates nothing.
// Returns { sources, fraction, stack, power, odds } or { reason }.
// ---------------------------------------------------------------------------

function _aiActPlanVolley(state, pid, target, oddsFloor) {
  var near = _aiActSourcesNear(state, pid, target);
  if (!near.length) return { reason: 'no-sources' };

  // Affordability first — it is arithmetic on units already in hand, and it
  // throws away most of the neighbourhood before anything expensive runs.
  var afford = [], floored = 0, tiny = 0, i;
  for (i = 0; i < near.length; i++) {
    var sid = near[i].sid;
    var allowed = _aiActAllowedFraction(state, sid);
    if (allowed <= 0) { floored++; continue; }
    var units = totalUnits(state.stations[sid].units);
    if (units * allowed < BAL.MIN_SEND_UNITS) { tiny++; continue; }
    afford.push({ sid: sid, allowed: allowed, units: units, hops: near[i].hops });
  }
  if (!afford.length) {
    return { reason: floored ? 'garrison-floor' : (tiny ? 'too-few-units' : 'no-sources') };
  }

  // Routing is the expensive part — a graph search per source per candidate,
  // hundreds of times a second across a Monte Carlo batch. Only ever route the
  // nearest, fullest handful: the volley can hold MAX_SOURCES_PER_VOLLEY, and
  // sources beyond twice that, ranked by hops then garrison, are never going
  // to be the ones that land together anyway.
  afford.sort(function (a, b) {
    if (a.hops !== b.hops) return a.hops - b.hops;
    if (b.units !== a.units) return b.units - a.units;
    return a.sid < b.sid ? -1 : 1;
  });
  var considered = afford.length > BAL.AI.MAX_SOURCES_PER_VOLLEY * 2
    ? afford.slice(0, BAL.AI.MAX_SOURCES_PER_VOLLEY * 2) : afford;

  // routeEtaTicks(commandRoute(...)) is pinned precisely so nobody
  // re-estimates travel time; the AI reads the same number the preview lines
  // show the player (§8).
  var elig = [];
  for (i = 0; i < considered.length; i++) {
    var route = commandRoute(considered[i].sid, target);
    if (!route || route.length < 2) continue;
    var eta = routeEtaTicks(route, splitUnits(state.stations[considered[i].sid].units,
                                              considered[i].allowed));
    if (!isFinite(eta)) continue;
    considered[i].eta = eta;
    elig.push(considered[i]);
  }
  if (!elig.length) return { reason: 'no-sources' };

  // Drop stragglers against the earliest arrival. See _aiActSpreadWindow.
  var window = _aiActSpreadWindow(oddsFloor);
  var anchor = Infinity;
  for (i = 0; i < elig.length; i++) if (elig[i].eta < anchor) anchor = elig[i].eta;
  var together = [];
  for (i = 0; i < elig.length; i++) {
    if (elig[i].eta <= anchor + window) together.push(elig[i]);
  }

  // Strongest first, capped at what a human comfortably marquee-selects.
  together.sort(function (a, b) {
    if (b.units !== a.units) return b.units - a.units;
    return a.sid < b.sid ? -1 : 1;          // deterministic tie-break
  });
  if (together.length > BAL.AI.MAX_SOURCES_PER_VOLLEY) {
    together = together.slice(0, BAL.AI.MAX_SOURCES_PER_VOLLEY);
  }

  // Take the PREFIX with the most delivered power. Adding a source adds units
  // but can drag the volley's fraction down to that source's allowance, so
  // more sources is not monotonically more force. Searching prefixes lets the
  // AI decline a thinly-garrisoned neighbour that would cost the whole volley
  // more than it contributes — with no extra constant to tune.
  var best = null;
  for (var k = 1; k <= together.length; k++) {
    var frac = BAL.AI.COMMIT_FRACTION, sids = [];
    for (i = 0; i < k; i++) {
      sids.push(together[i].sid);
      if (together[i].allowed < frac) frac = together[i].allowed;
    }
    // A source whose share at the volley fraction falls under MIN_SEND_UNITS
    // would be rejected by applyCommand, so drop it here rather than let the
    // estimate count units that never ship.
    var kept = [];
    for (i = 0; i < sids.length; i++) {
      if (totalUnits(state.stations[sids[i]].units) * frac >= BAL.MIN_SEND_UNITS) kept.push(sids[i]);
    }
    if (!kept.length) continue;
    var stack = _aiActSumStack(state, kept, frac);
    var power = _aiActStackPower(state, target, pid, stack);
    if (!best || power > best.power) {
      kept.sort();
      best = { sources: kept, fraction: frac, stack: stack, power: power };
    }
  }
  if (!best) return { reason: 'too-few-units' };

  var def = _aiActDefenderPower(state, target);
  best.odds = (def > BAL.ANNIHILATION_EPSILON) ? best.power / def
            : (best.power > 0 ? Infinity : 0);
  return best;
}

// ---------------------------------------------------------------------------
// Decision construction and the log
// ---------------------------------------------------------------------------

function _aiActDecision(state, pid, fields) {
  var d = {
    tick: state.tick,
    power: pid,
    kind: 'hold',
    target: null,
    score: 0,
    terms: {},        // always an object — a null here makes every reader of
                      // the log write a guard, and one of them will forget
    odds: 0,
    minOdds: 0,
    sources: [],
    fraction: 0,
    reason: null,
    rejected: [],
  };
  if (fields) for (var k in fields) if (fields.hasOwnProperty(k)) d[k] = fields[k];
  return d;
}

// state.aiLog is a ring buffer. Trimmed from the front on push so a Monte
// Carlo batch of hundreds of 36,000-tick games cannot leak.
function _aiActLogPush(state, decision) {
  if (!state.aiLog) state.aiLog = [];
  state.aiLog.push(decision);
  while (state.aiLog.length > BAL.AI.LOG_MAX) state.aiLog.shift();
}

// ---------------------------------------------------------------------------
// aiDecide(state, pid) — what this power WOULD do, right now.
//
// Returns null only when the power cannot act at all (unknown, neutral, dead,
// game over). Everything else returns a decision object, including every way
// of deciding to do nothing. MUST NOT MUTATE STATE — a test calls this,
// inspects the result, and the board is untouched. It does not consult the
// cadence: being due to act is aiTick's question, so a test can ask "what
// would Germany do here?" on any tick.
// ---------------------------------------------------------------------------

function aiDecide(state, pid) {
  if (!state || !pid) return null;
  if (state.winner) return null;
  var power = state.powers ? state.powers[pid] : null;
  if (!power || power.alive === false) return null;
  if (pid === 'neutral') return null;                 // never an actor (§6)

  // ai/score.js absent: say so out loud in the log rather than sitting there
  // looking like a broken AI. This is the difference between "the scorer is
  // not loaded" and "the scorer found nothing", and they are indistinguishable
  // from the outside otherwise.
  if (typeof aiContext !== 'function' || typeof aiCandidates !== 'function') {
    return _aiActDecision(state, pid, { reason: 'no-scoring-module' });
  }

  var ctx = aiContext(state, pid);
  var person = _aiActPersonality(pid, ctx);
  var minOdds = BAL.AI.MIN_ODDS * (person.minOddsMul || 1);

  var cands = aiCandidates(state, pid, ctx) || [];
  if (!cands.length) {
    return _aiActDecision(state, pid, { reason: 'no-candidates', minOdds: minOdds });
  }

  var inflight = _aiActInflightTargets(state, pid);
  var logRejected = !!BAL.AI.LOG_REJECTED;
  var rejected = [];
  var bestOdds = 0, bestScore = 0, deepReason = 'no-candidates';

  // Candidates arrive sorted by score descending; walk them best-first and
  // take the first that clears. One target, one commitment budget — "think in
  // fronts" (§6), not a per-stack optimum.
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    var sid = _aiActCandSid(c);
    if (!sid || !state.stations[sid]) continue;
    var score = (c && typeof c.score === 'number') ? c.score : 0;
    var terms = (c && c.terms && typeof c.terms === 'object') ? c.terms : {};
    var owner = state.stations[sid].owner;
    var why = null;

    if (owner === pid) {
      why = 'already-held';
    } else if (owner !== 'neutral' && typeof atWar === 'function' && !atWar(state, pid, owner)) {
      // Powers are at war or they are not, and nobody negotiates (§6).
      // Neutral is never gated: taking neutral ground is the whole opening.
      why = 'not-at-war';
    } else if (_aiActAlreadyCommitted(state, pid, sid, inflight)) {
      why = 'already-committed';
    }

    if (!why) {
      var plan = _aiActPlanVolley(state, pid, sid, minOdds);
      if (plan.reason) {
        why = plan.reason;
      } else if (!(plan.odds >= minOdds)) {
        why = 'odds-too-low';
        if (plan.odds > bestOdds) { bestOdds = plan.odds; bestScore = score; }
      } else {
        return _aiActDecision(state, pid, {
          kind: 'attack',
          target: sid,
          score: score,
          terms: terms,
          odds: plan.odds,
          minOdds: minOdds,
          sources: plan.sources,
          fraction: plan.fraction,
          reason: null,
          rejected: logRejected ? rejected : [],
        });
      }
    }

    if (_aiActReasonDepth(why) > _aiActReasonDepth(deepReason)) deepReason = why;
    if (logRejected) rejected.push({ target: sid, score: score, reason: why });
  }

  // Nothing cleared. The reason names the furthest the power got on any
  // candidate — "odds-too-low" if it costed a volley and came up short,
  // "garrison-floor" if it never had the units to cost one, "not-at-war" if
  // the Concert is still holding and there is nothing legal to hit.
  return _aiActDecision(state, pid, {
    reason: deepReason,
    odds: bestOdds,
    score: bestScore,
    minOdds: minOdds,
    rejected: logRejected ? rejected : [],
  });
}

// ---------------------------------------------------------------------------
// Cadence
//
// Two independent throttles, deliberately not one:
//
//   * The INTERVAL is the normal clock — ACTION_INTERVAL_TICKS with seeded
//     jitter, scheduled forward after every action.
//   * MAX_ORDERS_PER_MINUTE is a BACKSTOP, checked separately against a real
//     count of recent orders. Its comment in data/tuning.js says it exists to
//     catch "any future code path that tries to fire outside the cadence" —
//     which it cannot do if it is implemented as an assumption that the
//     interval already satisfies it.
//
// Jitter is drawn from state.rng and the schedule is stored in state, so a
// snapshot resumes the same rhythm it was saved with.
// ---------------------------------------------------------------------------

function _aiActRngInt(state, lo, hi) {
  var r = rngInt(state.rng, lo, hi);
  state.rng = r.state;
  return r.value;
}

function _aiActSchedule(state, memo, pid, first) {
  // First sighting: spread the powers across one whole interval so the opening
  // is not seven simultaneous volleys. Afterwards: interval +/- jitter.
  if (first) {
    memo.next[pid] = state.tick + _aiActRngInt(state, 0, BAL.AI.ACTION_INTERVAL_TICKS - 1);
    return;
  }
  var j = BAL.AI.ACTION_JITTER_TICKS;
  var wait = BAL.AI.ACTION_INTERVAL_TICKS + _aiActRngInt(state, -j, j);
  if (wait < 1) wait = 1;
  memo.next[pid] = state.tick + wait;
}

function _aiActOrderRateOk(state, memo, pid) {
  var minute = 60 * (BAL.TICKS_PER_SEC || Math.round(1000 / BAL.TICK_MS));
  var recent = memo.orders[pid] || (memo.orders[pid] = []);
  // Drop everything older than a minute first, so the array cannot grow with
  // game length — this runs for 36,000 ticks a game, hundreds of games.
  while (recent.length && recent[0] <= state.tick - minute) recent.shift();
  return recent.length < BAL.AI.MAX_ORDERS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// aiTick(state) — PHASE 0, before growthTick. The only mutation in ai/.
// ---------------------------------------------------------------------------

function aiTick(state) {
  if (!state || state.winner) return;
  // No scorer, no AI. A clean no-op, not a crash and not a log full of noise.
  if (typeof aiContext !== 'function' || typeof aiCandidates !== 'function') return;

  var memo = _aiActMemo(state);
  // Created up front, not lazily on the first push: an absent aiLog and an
  // empty one mean different things to anyone reading the state, and "the AI
  // has run but decided nothing yet" must be visible as [].
  if (!state.aiLog) state.aiLog = [];
  var pids = _aiActPowerIds();

  // Sorted ids only. Object.keys order differs between node and the browser
  // and would make the AI — and therefore the whole game — non-deterministic.
  for (var i = 0; i < pids.length; i++) {
    var pid = pids[i];
    if (pid === 'neutral') continue;
    var power = state.powers[pid];
    if (!power || power.alive === false) continue;

    // The human's own power is never AI-driven. state.human is set by
    // app/main.js from PLAYER; absent — headless tests, tools/balance.js —
    // means every power is AI-driven, which is exactly what a batch wants.
    // Without this the live game has Germany playing itself while the player
    // watches their own cities empty.
    if (state.human && pid === state.human) continue;

    // CHEAP ELIGIBILITY FIRST. Building a context costs a BFS and a scan of
    // every station; doing it before asking "is this power even due?" is the
    // difference between a balance batch that runs in seconds and one that
    // runs in minutes.
    if (memo.next[pid] === undefined) { _aiActSchedule(state, memo, pid, true); continue; }
    if (state.tick < memo.next[pid]) continue;

    if (!_aiActOrderRateOk(state, memo, pid)) {
      _aiActLogPush(state, _aiActDecision(state, pid, { reason: 'rate-capped' }));
      _aiActSchedule(state, memo, pid, false);
      continue;
    }

    var decision = aiDecide(state, pid);
    _aiActSchedule(state, memo, pid, false);
    if (!decision) continue;

    if (decision.kind === 'attack') {
      // The same many-to-one volley the player commits (§8), through the same
      // entry point. applyCommand's `rejected` array is the only feedback
      // channel the AI gets, so it is recorded whether or not LOG_REJECTED is
      // on: a refused order is an error signal, not candidate noise.
      memo.orders[pid].push(state.tick);
      var res = applyCommand(state, {
        type: 'send',
        owner: pid,
        sources: decision.sources,
        target: decision.target,
        fraction: decision.fraction,
      });
      if (res.rejected && res.rejected.length) {
        decision.rejected = decision.rejected.concat(res.rejected);
      }
      if (!res.ok) {
        decision.kind = 'hold';
        decision.reason = 'command-rejected';
      } else {
        var accepted = [];
        for (var a = 0; a < res.accepted.length; a++) accepted.push(res.accepted[a].source);
        decision.sources = accepted.sort();
        power.lastActTick = state.tick;
      }
    }

    _aiActLogPush(state, decision);
  }
}

// ---------------------------------------------------------------------------
// aiDecisions(state, pid, n) — the debugging surface §6 demands.
//
// The last n entries, newest last. pid null (or omitted) means all powers.
// In the console: aiDecisions(GAME, 'aut', 20) answers "why has Austria not
// moved in two minutes?" directly, which is the only way that question is
// answerable at all.
// ---------------------------------------------------------------------------

function aiDecisions(state, pid, n) {
  var log = (state && state.aiLog) ? state.aiLog : [];
  var out = [];
  for (var i = 0; i < log.length; i++) {
    if (pid === null || pid === undefined || log[i].power === pid) out.push(log[i]);
  }
  if (typeof n === 'number' && n >= 0 && out.length > n) out = out.slice(out.length - n);
  return out;
}
