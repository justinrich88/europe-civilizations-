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
// STAGING is the third kind of decision, and it exists because those two
// mechanisms, working correctly, produced a frozen board. A power whose best
// target needs more force than its ETA-eligible sources hold has, with only
// attack and hold available, no move at all: it cannot attack (the odds are
// not there) and holding does nothing (its interior is at capacity, and
// logistic growth means a full station has stopped paying dividends, §2). It
// stands still forever while holding most of Europe.
//
// A human in that position marches the rear forward. So does this: a decision
// of kind 'stage' sends rear garrisons INTO the border station that anchors
// the volley — the one already inside the ETA window — until the arithmetic
// deficit is covered. Same applyCommand, same many-to-one gesture, same
// garrison floor. The cost is real and already in the sim: mass parked above a
// station's capacity bleeds at OVERSTACK_DECAY, so hoarding is not free and
// the AI attacks as soon as the odds clear rather than piling forever.
//
// Staging is NOT a way around the odds floor. It never sends anything at the
// enemy; it changes where the AI's own units are standing, which is the only
// honest way to make an unaffordable attack affordable.
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
//   peace-exhausted    carried by an ATTACK, not a hold: nothing was reachable
//                      except ground held by a power at peace, so the AI broke
//                      the peace rather than stand still on a partitioned board
//   already-committed  a stack or a wave of this power is already on that
//                      target; a second volley now would arrive after the
//                      fight it was meant to join (§8)
//   no-sources         nothing owned within SOURCE_MAX_HOPS of any candidate
//   garrison-floor     every nearby source is at or under its garrison floor
//   too-few-units      the affordable share is below BAL.MIN_SEND_UNITS
//   no-route           sources were in reach and could pay, but every path to
//                      the target runs through ground another power holds, so
//                      applyCommand would refuse the send (sim/movement.js)
//   odds-too-low       best power ratio found was under MIN_ODDS x personality
//                      AND no staging march could be built either
//   stage-massed       the deficit is already standing in, or walking to, the
//                      depot; the fist is assembling and there is nothing to
//                      add this tick
//   stage-no-feeders   nothing in the rear within STAGE_MAX_HOPS of the depot
//                      can spare units — the power is genuinely spent, not idle
//   rate-capped        MAX_ORDERS_PER_MINUTE backstop tripped
//   command-rejected   applyCommand refused the volley — see .rejected
//
// `staging` is not a hold reason: it is the reason carried by a decision of
// kind 'stage', which is an ORDER, not an absence of one. It is listed here so
// the log stays greppable from one place.
var AI_HOLD_REASONS = [
  'no-scoring-module', 'no-candidates', 'already-held', 'not-at-war',
  'already-committed', 'no-sources', 'garrison-floor', 'too-few-units',
  'no-route', 'odds-too-low', 'stage-massed', 'stage-no-feeders',
  'rate-capped', 'command-rejected', 'staging', 'peace-exhausted',
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
// Ordered by how far into _aiActPlanVolley the candidate got: neighbourhood,
// then affordability, then routing, then odds. 'no-route' sits above
// 'too-few-units' because routing is only attempted once a source can pay.
// 'stage-massed' and 'stage-no-feeders' sit above 'odds-too-low' because they
// are only reachable by first failing on odds and THEN failing to mass — they
// are strictly further into the decision than the odds check that produced them.
var _AI_ACT_REASON_DEPTH = {
  'already-held': 0, 'not-at-war': 1, 'already-committed': 2,
  'no-sources': 3, 'garrison-floor': 4, 'too-few-units': 5, 'no-route': 6,
  'odds-too-low': 7, 'stage-no-feeders': 8, 'stage-massed': 9,
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
// Anything landing after that is not reinforcement. A turtle demanding ~1.9:1
// gets a tighter window, which is the correct reading of its personality: it
// only moves when the whole fist lands at once.
//
// DERIVE THE NUMBER, DO NOT QUOTE ONE. This comment used to read "~18 ticks at
// MIN_ODDS = 1.4". It was wrong by a factor of 22 and had been for as long as
// BAL.COMBAT_RATE has been 0.0022 — the figure predates that constant and
// nothing recomputed it when the constant moved. The window is a FUNCTION of
// two tuning values and it must be read as one:
//
//     window(r) = atanh(1 / r) / BAL.COMBAT_RATE
//
//     r      COMBAT_RATE   ticks   sim-seconds
//     1.4      0.0022       407        41        <- MIN_ODDS, the default
//     1.5      0.0022       366        37
//     1.89     0.0022       266        27        <- turtle (MIN_ODDS x 1.35)
//     2.0      0.0022       250        25
//
// Recompute the column, do not edit it in place, if either constant changes:
//
//     node -e 'a=x=>0.5*Math.log((1+x)/(1-x)); console.log(a(1/1.4)/0.0022)'
//
// The check that would have caught it is the one from known-issues.md #11 —
// multiply a constant out against the thing it has to move. 18 ticks is 1.8
// sim-seconds, less than half of BAL.AI.ACTION_INTERVAL_TICKS (40) and a
// fraction of any real march; a window that tight would have called almost
// every genuine volley "defeat in detail" and stood the AI still. The behaviour
// was always right, because the CODE computes the window from the constants.
// Only the comment was quoting a number the code stopped producing.
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

// ---------------------------------------------------------------------------
// THE BELIEVED BOARD (milestone 5.7 stage 4)
//
// Every number below that describes SOMEBODY ELSE'S station — the garrison, the
// owner, the connectivity — is read through believedStation() rather than off
// state.stations. Reads about this power's OWN ground stay on the true board,
// which is not a leak: visibleTo returns 2 for every station its subject holds,
// so there is nothing to hide from yourself.
//
// The seam is the proxy state this file already built twice for the attacker
// side. It generalises for free, because sim/combat.js's stationPower reads
// nothing but state.stations[sid] — so a one-station proxy carrying believed
// numbers reuses the canonical formula (fort strip, terrain, matchup) instead
// of a unit-ratio multiply. That distinction is not cosmetic: _fortBonus
// SATURATES, so scaling a power figure by a unit ratio over-counts a full fort.
// _aiActGrownDefenderPower already re-ran the canonical formula for exactly
// that reason; this follows its precedent.
//
// #########################################################################
// #  NEVER HAND A PROXY OR A BELIEVED STATE TO routeFor() / commandRoute() #
// #########################################################################
//
// `_ownRouteCache` in sim/movement.js invalidates on state OBJECT IDENTITY (or
// state.ownerEpoch). A fresh proxy per call therefore blows the REAL state's
// route cache as well, and movementTick/ordersTick then recompute their O(n^2)
// Dijkstras from scratch every tick, for every wave, forever. Measured on the
// live board:
//
//   routeFor, cached                        0.115 us
//   routeFor, fresh proxy state each call   161.1 us      <- 1,400x
//
// It produces NO WRONG ANSWER, only a game that crawls, which is the hardest
// kind of regression to attribute. Both commandRoute() call sites in this file
// (in _aiActPlanVolley and _aiActPlanStage) are commented at the call and both
// pass the real `state`. test/fog-tests.js asserts this against the source
// text AND against a tick-count ceiling, because a comment is not a check.
//
// Routing legality staying on the true board is also a DESIGN DECISION, not an
// oversight: the AI and the player's preview may both route through ground they
// have never seen. A route is a claim about where your own army may walk, and
// "you find out the road is blocked when you march" is legible fog behaviour.
// 02-visibility-and-sea.md records it as the one deliberate hole on the map.
// ---------------------------------------------------------------------------

// What `pid` believes is at `sid`, memoised for the life of one ctx.
//
// DUPLICATED from `_aiScoreBelief` in ai/score.js, deliberately: privates are
// prefixed by FILE and never shared across the two halves (known-issues #12 —
// a shared `_ai` prefix made three helpers collide and the scorer silently ran
// against ai.js's copies). ai/ai.js must also load with ai/score.js absent.
// The canonical implementation both adapt is believedStation() in core/vision.js.
//
// The fallback when core/vision.js is missing is the TRUE station, so a build
// with core/ stripped plays the unfogged game rather than throwing.
function _aiActBelief(state, pid, sid, ctx) {
  var memo = ctx ? ctx._belief : null;
  if (memo && memo[sid]) return memo[sid];

  var b;
  if (typeof believedStation === 'function') {
    b = believedStation(state, pid, sid, ctx ? ctx.vis : null);
  } else {
    var st = state.stations ? state.stations[sid] : null;
    b = st
      ? { owner: st.owner, units: st.units, connected: st.connected !== false,
          tick: state.tick, level: 2 }
      : { owner: null, units: null, connected: null, tick: -1, level: 0 };
  }
  if (memo) memo[sid] = b;
  return b;
}

// The garrison to PLAN AGAINST. Levels 1 and 2 hand back what was seen; level 0
// has never been observed and believedStation reports null, which is right for
// a renderer and useless for a decision. The prior is A FULL GARRISON, because
// station capacity is public authored data — the map is known in 1914, only
// what stands on it is not — and because it fails SAFE: an empty-garrison prior
// would read unseen ground as a walk-in and send the AI charging at odds it
// invented. aiCandidates refuses level-0 targets outright, so this is defence
// in depth rather than a live path.
function _aiActBelievedUnits(sid, bel) {
  if (bel && bel.units) return bel.units;
  var data = (typeof STATIONS !== 'undefined') ? STATIONS[sid] : null;
  var u = emptyUnits();
  if (data && data.capacity > 0) u.infantry = data.capacity;
  return u;
}

// A one-station proxy state carrying the believed garrison. `attackers` is
// believed too: live at level 2, empty at level 1, because memory records a
// garrison and never records who was besieging it — and stationPower folds the
// attackers' MIX into the defender's matchup. `override` replaces the units
// (used by the two callers that ask "what if this stack were here instead").
//
// READ THE BANNER ABOVE BEFORE PASSING THIS ANYWHERE NEW.
function _aiActBelievedAt(state, pid, sid, ctx, override) {
  var bel = _aiActBelief(state, pid, sid, ctx);
  var real = state.stations ? state.stations[sid] : null;
  var proxy = { stations: {} };
  proxy.stations[sid] = {
    owner: bel.owner,
    units: override || _aiActBelievedUnits(sid, bel),
    attackers: (bel.level === 2 && real && real.attackers) ? real.attackers : {},
    connected: bel.connected !== false,
  };
  return proxy;
}

function _aiActStackPower(state, sid, pid, stack, ctx) {
  if (typeof stationPower !== 'function') {
    // sim/combat.js absent: a crude attack-value sum keeps ai/ai.js loadable
    // on its own. Deliberately not tuned — it is a smoke-test path.
    var p = 0, order = BAL.UNIT_ORDER;
    for (var i = 0; i < order.length; i++) p += stack[order[i]] * BAL.UNITS[order[i]].atk;
    return p;
  }
  // The matchup is computed against the BELIEVED defending mix, not the real
  // one. Overwriting `attackers` with just this stack is the original
  // behaviour and is kept: the question is "what would MY volley be worth
  // here", not "what is the current battle worth".
  var proxy = _aiActBelievedAt(state, pid, sid, ctx);
  var atk = {};
  atk[pid] = stack;
  proxy.stations[sid].attackers = atk;
  return stationPower(proxy, sid, pid);
}

// THE ODDS GATE. This one number decides every attack in the game, and before
// stage 4 it was read straight off the true board — the single largest leak in
// the AI, and the one that made fog cosmetic on the player's side only.
function _aiActDefenderPower(state, pid, sid, ctx) {
  if (typeof stationPower !== 'function') {
    return totalUnits(_aiActBelievedUnits(sid, _aiActBelief(state, pid, sid, ctx)))
      * BAL.UNITS.infantry.def;
  }
  return stationPower(_aiActBelievedAt(state, pid, sid, ctx), sid, 'defender');
}

// The defender power `sid` will have once its garrison has finished growing —
// used ONLY when sizing a staging march, never when deciding to attack. See
// the block above the deficit in _aiActPlanStage for why the two questions
// need different numbers.
//
// A garrison below BAL.GROWTH_OVERFLOW_CEIL x capacity is still growing, and
// since the over-capacity rework (data/tuning.js) that ceiling is 1.5, not 1.
// So this scales the stack up to the ceiling and re-runs the CANONICAL
// formula — power is linear in the body but the fort block saturates
// (sim/combat.js _fortBonus scales in over DEFENSE_BONUS_FULL_AT defenders),
// so multiplying `def` by the unit ratio would over-count a fort that is
// already full. Same proxy-state trick as _aiActStackPower, and for the same
// reason: reuse stationPower rather than re-derive it (known-issues.md #9).
//
// Two stations project to themselves: one that is cut off (it is decaying,
// not growing — sim/growth.js DISCONNECT_GROWTH = 0) and one already at or
// past the ceiling (growth there is zero by construction).
//
// FOGGED, and CONNECTIVITY IS THE POINT. This function used to read
// `real.connected` — whether an enemy station is joined to its own capital's
// network — which is not visible from outside that network by any means the
// game models, and was the least ambiguous leak in the file. It now reads the
// BELIEVED connectivity, so a power that watched a city get cut off goes on
// believing it is cut off until it looks again, and a city it has never seen
// is assumed connected (and therefore assumed to be growing), which is the
// pessimistic reading and the right one for sizing a march.
function _aiActGrownDefenderPower(state, pid, sid, def, ctx) {
  var d = (typeof STATIONS !== 'undefined') ? STATIONS[sid] : null;
  var real = state.stations ? state.stations[sid] : null;
  var ceil = BAL.GROWTH_OVERFLOW_CEIL;
  if (!d || !real || !(d.capacity > 0) || !(ceil > 1)) return def;

  var bel = _aiActBelief(state, pid, sid, ctx);
  if (bel.connected === false) return def;
  var units = _aiActBelievedUnits(sid, bel);
  var now = totalUnits(units);
  var full = d.capacity * ceil;
  if (!(now > BAL.ANNIHILATION_EPSILON) || now >= full) return def;

  var ratio = full / now;
  if (typeof stationPower !== 'function') return def * ratio;
  var proxy = _aiActBelievedAt(state, pid, sid, ctx, splitUnits(units, ratio));
  var grown = stationPower(proxy, sid, 'defender');
  return grown > def ? grown : def;
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
//
// The sweep runs outward through PASSABLE ground only (own or neutral — the
// routeFor rule in sim/movement.js, read backwards from the target). A station
// two hops away on the far side of a rival's city cannot deliver, and counting
// it produces a volley that applyCommand rejects source by source. The target
// itself is always expanded: attacking INTO enemy ground is the point.
// ---------------------------------------------------------------------------

// Mirrors _moveCanTraverse in sim/movement.js — see the note on
// _aiScoreCanTraverse. Only ground this power holds may be marched through.
function _aiActCanTraverse(state, pid, sid) {
  var st = state.stations[sid];
  return !!st && st.owner === pid;
}

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
        if (_aiActCanTraverse(state, pid, sid)) next.push(sid);
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
//
// `ctx` is the decision context from aiContext(); it carries ctx.vis, which is
// what makes every read of the TARGET a believed read rather than a true one.
// It is optional so a caller with no scorer loaded still gets a plan (against
// the true board, which is the correct degradation: no scorer, no fog).
// ---------------------------------------------------------------------------

function _aiActPlanVolley(state, pid, target, oddsFloor, ctx) {
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
  //
  // state and pid are passed so this is the OWNERSHIP-AWARE route — the exact
  // route applyCommand will validate against. Estimating on the geographic path
  // would mean planning a volley down a road the sender is not allowed to use,
  // and every such order comes straight back as 'no-route'.
  //
  // THE THIRD ARGUMENT IS THE REAL `state`, AND MUST STAY THE REAL `state`.
  // Not a believed board, not a proxy. sim/movement.js's _ownRouteCache keys on
  // state object identity, so a proxy here drops the real state's routes too
  // and every Dijkstra in the game is recomputed per tick — 0.115us becomes
  // 161.1us, 1,400x, with no wrong answer to point at. See the banner above
  // _aiActBelievedAt, and 02-visibility-and-sea.md, which records routing on
  // the true board as a deliberate and accepted hole in the fog.
  var elig = [];
  for (i = 0; i < considered.length; i++) {
    var route = commandRoute(considered[i].sid, target, state, pid);
    if (!route || route.length < 2) continue;
    var eta = routeEtaTicks(route, splitUnits(state.stations[considered[i].sid].units,
                                              considered[i].allowed));
    if (!isFinite(eta)) continue;
    considered[i].eta = eta;
    elig.push(considered[i]);
  }
  // Sources existed and could afford the send, but not one of them has a legal
  // road to the target. That is a different fact from 'no-sources' and the log
  // has to be able to tell them apart, or "why is Austria doing nothing?"
  // becomes unanswerable.
  if (!elig.length) return { reason: 'no-route' };

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
    var power = _aiActStackPower(state, target, pid, stack, ctx);
    if (!best || power > best.power) {
      kept.sort();
      best = { sources: kept, fraction: frac, stack: stack, power: power };
    }
  }
  if (!best) return { reason: 'too-few-units' };

  // BELIEVED defence. `best.odds` is therefore the odds this power THINKS it
  // has, which is what it decides on and what the decision log prints — and on
  // a fogged target it is not the odds it will actually meet. That divergence
  // is the feature, not a rounding error: it is how an ambush happens.
  var def = _aiActDefenderPower(state, pid, target, ctx);
  best.odds = (def > BAL.ANNIHILATION_EPSILON) ? best.power / def
            : (best.power > 0 ? Infinity : 0);

  // Handed out so a failed volley can be STAGED for rather than merely
  // regretted. `window` is the set that can actually arrive together — the
  // only stations worth reinforcing, because anything outside it gets dropped
  // as a straggler no matter how full it is. `def` saves _aiActPlanStage
  // recomputing the defender it would otherwise have to guess at.
  best.window = together;
  best.def = def;
  return best;
}

// ---------------------------------------------------------------------------
// Staging — moving force toward a target the power cannot yet afford
//
// Everything here is PURE. It plans a march; aiTick issues it, through the
// same applyCommand the player uses.
// ---------------------------------------------------------------------------

// Units of this power already walking to `sid`. Without this the AI reorders
// the same march every ACTION_INTERVAL_TICKS for the whole of a 2,000-tick
// approach and strips its interior twenty times over for one assault — the
// staging equivalent of feeding a battle piecemeal.
function _aiActInflightUnitsTo(state, pid, sid) {
  var n = 0;
  for (var i = 0; i < state.waves.length; i++) {
    var w = state.waves[i];
    if (w.owner === pid && w.to === sid) n += totalUnits(w.units);
  }
  return n;
}

// The depot is chosen from the volley's ETA WINDOW, never from the wider
// neighbourhood. A station outside the window cannot deliver to this target no
// matter how much is standing in it, so reinforcing one would move units to a
// place they can never be spent from — activity that looks like progress and
// is not. Largest capacity wins: the same mass parked in a bigger city sits
// less far above capacity and therefore bleeds less to OVERSTACK_DECAY.
// Ties break on id so the choice cannot depend on iteration order.
function _aiActStageDepot(plan) {
  var w = plan.window || [];
  var best = null, bestCap = -1;
  for (var i = 0; i < w.length; i++) {
    var sid = w[i].sid;
    var cap = (typeof STATIONS !== 'undefined' && STATIONS[sid]) ? STATIONS[sid].capacity : 0;
    if (cap > bestCap || (cap === bestCap && best !== null && sid < best)) {
      bestCap = cap;
      best = sid;
    }
  }
  return best;
}

// Own stations within `maxHops` of the depot, over the power's OWN ground.
// `exclude` holds the volley's window: those stations can already deliver, and
// draining one to fill another member of the same fist is pure churn.
function _aiActStageFeeders(state, pid, depot, exclude, maxHops) {
  var adj = _aiActAdjacency();
  var seen = {}, frontier = [depot], out = [];
  seen[depot] = true;

  for (var depth = 1; depth <= maxHops; depth++) {
    var next = [];
    for (var i = 0; i < frontier.length; i++) {
      var nbrs = adj[frontier[i]] || [];
      for (var j = 0; j < nbrs.length; j++) {
        var sid = nbrs[j];
        if (seen[sid]) continue;
        seen[sid] = true;
        // Own ground only, both to march through and to draw from: a staging
        // march is an interior movement and must never plan a road through
        // somebody else's city (the same _moveCanTraverse rule as everywhere).
        if (!_aiActCanTraverse(state, pid, sid)) continue;
        next.push(sid);
        if (exclude[sid]) continue;
        if (_aiActUnderAttack(state, sid, pid)) continue;
        out.push({ sid: sid, hops: depth });
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return out;
}

// Plan one staging march for `target`, given the volley that came up short.
// Returns { depot, sources, fraction, need, sent } or { reason }.
//
// THE DEFICIT IS ARITHMETIC, NOT A GUESS. The volley delivers `plan.power`
// from `totalUnits(plan.stack)` units, so it is worth plan.power/units per
// unit sent; clearing `minOdds` needs minOdds x defenderPower. The shortfall
// in power therefore converts to a shortfall in units standing at the depot,
// divided by the fraction a volley actually ships. That is the number this
// walks forward — and it is why staging cannot become a way of attacking at
// bad odds: it stops the moment the odds clear, because the attack branch in
// aiDecide is tried first on every candidate, every decision.
function _aiActPlanStage(state, pid, target, plan, minOdds, ctx) {
  if (!plan || !plan.window || !plan.window.length) return { reason: 'no-sources' };

  var depot = _aiActStageDepot(plan);
  if (!depot) return { reason: 'no-sources' };

  var stackUnits = totalUnits(plan.stack);
  var perUnit = (stackUnits > BAL.ANNIHILATION_EPSILON && plan.power > 0)
    ? plan.power / stackUnits : 0;
  if (!(perUnit > 0)) return { reason: 'stage-no-feeders' };

  // THE DEFENDER THE MASS WILL MEET, not the one standing there now. A staging
  // march is hundreds to thousands of ticks long, and since the over-capacity
  // rework a garrison below its hard ceiling grows for the whole of that march
  // — deterministically, and by up to (GROWTH_OVERFLOW_CEIL - 1) x capacity.
  // Sizing the deficit against the defender's power RIGHT NOW therefore
  // under-orders every march by exactly the amount the target will grow in
  // transit; the AI then reads its own in-flight units as covering the gap,
  // reports 'stage-massed', and holds. That is the 65%-draw frozen board
  // coming back through a different door — on the last-stand fixture the odds
  // plateaued at 1.69 against a floor of 1.89 and the board never moved in
  // 100,000 ticks, where before the rework it fell at tick 1,941.
  //
  // A FORECAST, not pessimism: below the ceiling growth is monotonic and the
  // ceiling is exactly where it reaches zero, so cap x CEIL is where that
  // garrison is going, not merely where it could go.
  //
  // Only the defender is projected. The attacker's own interior also grows,
  // but that is slack STAGE_OVERSHOOT already carries, and projecting both
  // would cancel the asymmetry this exists to correct: the defender's extra
  // units are free, ours have to be marched, and the marching is what takes
  // the time the defender grows in. The ATTACK gate in _aiActWalk is
  // deliberately left reading the present — an attack launched now meets a
  // defender only one volley-ETA older, and projecting there would make the
  // AI refuse fights it can win.
  //
  // Projected from the BELIEVED garrison, not the true one. A march sized
  // against a defender this power cannot see would be sized against
  // intelligence it does not have; sizing against what it last saw, grown
  // forward, is what a staff actually does.
  var deficit = minOdds * _aiActGrownDefenderPower(state, pid, target, plan.def, ctx) - plan.power;
  if (!(deficit > 0)) return { reason: 'stage-massed' };

  var frac = (plan.fraction > 0) ? plan.fraction : BAL.AI.COMMIT_FRACTION;
  var need = (deficit / (perUnit * frac)) * BAL.AI.STAGE_OVERSHOOT
           - _aiActInflightUnitsTo(state, pid, depot);
  if (!(need >= BAL.MIN_SEND_UNITS)) return { reason: 'stage-massed' };

  var exclude = {}, i;
  for (i = 0; i < plan.window.length; i++) exclude[plan.window[i].sid] = true;

  var feeders = _aiActStageFeeders(state, pid, depot, exclude, BAL.AI.STAGE_MAX_HOPS);
  if (!feeders.length) return { reason: 'stage-no-feeders' };

  // Same garrison-floor arithmetic as an attack: a staging march is not
  // allowed to strip the interior any harder than a volley is.
  var afford = [];
  for (i = 0; i < feeders.length; i++) {
    var sid = feeders[i].sid;
    var allowed = _aiActAllowedFraction(state, sid);
    if (allowed <= 0) continue;
    var units = totalUnits(state.stations[sid].units);
    if (units * allowed < BAL.MIN_SEND_UNITS) continue;
    // REAL `state`, for the same reason as in _aiActPlanVolley: a proxy here
    // costs 1,400x on every route in the game and reports nothing wrong.
    // Feeders and depot are both this power's own ground anyway, so there is
    // no fog to apply — an interior march is planned on facts it owns.
    var route = commandRoute(sid, depot, state, pid);
    if (!route || route.length < 2) continue;
    afford.push({ sid: sid, allowed: allowed, units: units, hops: feeders[i].hops });
  }
  if (!afford.length) return { reason: 'stage-no-feeders' };

  // FULLEST FIRST, then nearest. Not nearest-first, and the difference is not
  // cosmetic — it was measured. applyCommand takes ONE fraction for the whole
  // volley and the volley's fraction is the smallest allowance among its
  // sources, so a single half-drained neighbour drags every other source down
  // to its own allowance. Ordering by proximity put exactly those stations
  // first: the front cities that the last staging march already emptied. The
  // AI then re-drained the same four exhausted towns at a fraction of 0.08
  // while three thousand units stood at capacity behind them, and the depot
  // stalled at odds 1.57 against a floor of 1.89 forever. Fullest first is the
  // same ordering _aiActPlanVolley uses, and for the same reason.
  afford.sort(function (a, b) {
    if (b.units !== a.units) return b.units - a.units;
    if (a.hops !== b.hops) return a.hops - b.hops;
    return a.sid < b.sid ? -1 : 1;
  });

  // Prefix search, exactly as in _aiActPlanVolley: adding a source adds units
  // but can drag the shared fraction down to that source's allowance, so more
  // sources is not monotonically more force. Take the prefix that DELIVERS
  // most, and stop as soon as one covers the deficit — reinforcing a front is
  // not the same act as emptying the country into it.
  var limit = afford.length < BAL.AI.MAX_SOURCES_PER_VOLLEY
    ? afford.length : BAL.AI.MAX_SOURCES_PER_VOLLEY;
  var best = null, k, m;
  for (k = 1; k <= limit; k++) {
    var frac2 = BAL.AI.COMMIT_FRACTION;
    for (m = 0; m < k; m++) if (afford[m].allowed < frac2) frac2 = afford[m].allowed;

    // A source whose share at that fraction falls under MIN_SEND_UNITS would
    // be rejected by applyCommand, so drop it here rather than let the
    // estimate count units that never ship.
    var kept = [], sent = 0;
    for (m = 0; m < k; m++) {
      if (afford[m].units * frac2 < BAL.MIN_SEND_UNITS) continue;
      kept.push(afford[m].sid);
      sent += afford[m].units * frac2;
    }
    if (!kept.length) continue;
    if (!best || sent > best.sent) {
      kept.sort();
      best = { sources: kept, fraction: frac2, sent: sent };
    }
    if (best.sent >= need) break;
  }
  if (!best) return { reason: 'stage-no-feeders' };

  return { depot: depot, sources: best.sources, fraction: best.fraction,
           need: need, sent: best.sent };
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

    // Only meaningful on kind 'stage': `target` is then the DEPOT being
    // reinforced and `stageFor` is the enemy station the mass is being
    // assembled against. Declared here rather than only on stage decisions so
    // every entry in the log has the same shape and no reader needs a guard.
    stageFor: null,
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

  var d = _aiActWalk(state, pid, cands, minOdds, true, ctx);

  // THE PEACE OF THE PARTITION. `not-at-war` as the DEEPEST reason means no
  // candidate got past the war gate at all: there is no neutral ground in
  // reach and every station this power could take belongs to somebody it is
  // formally at peace with. Measured over 48 games, that state accounted for
  // 13 of the 14 remaining draws — two survivors, the board carved between
  // them, the Concert holding a peace with nothing left to preserve, and
  // neither able to end the game.
  //
  // The gate is ours alone: applyCommand imposes no war check, so a HUMAN in
  // this position simply attacks (§8 — "there is no other verb"). An AI that
  // cannot is not being diplomatic, it is being shackled. So when peace is the
  // only thing left standing between a power and any move at all, it moves,
  // and takes the consequence through the existing machinery — AGGRESSION_HIT
  // hands the victim 25 points of hostility and sim/relations.js latches a
  // real war on the next update.
  //
  // Deliberately NOT a general relaxation: it fires only when the first pass
  // reached the gate and nothing else, so every power with a neutral village
  // or an existing war in reach still prefers those, and the Concert still
  // holds everywhere the board is not already partitioned.
  if (d.reason === 'not-at-war') {
    var forced = _aiActWalk(state, pid, cands, minOdds, false, ctx);
    if (forced.kind === 'attack') {
      forced.reason = 'peace-exhausted';       // the peace was broken, and says so
      return forced;
    }
    if (forced.kind === 'stage') {
      // The peace ran out but the fist is not assembled yet, so the power
      // marches instead of declaring. Its reason stays 'staging' — the pinned
      // reason for that kind — and `stageFor` naming a station held by a power
      // it is NOT at war with is what marks this as the partition case in the
      // log. Overwriting the reason here would have made every stage decision
      // in the game ambiguous to satisfy one of them.
      return forced;
    }
  }
  return d;
}

// The candidate walk. `warGate` false means "the peace has run out" — see the
// block above aiDecide's call. Split out of aiDecide only so it can be run
// twice; nothing else calls it and nothing else should.
function _aiActWalk(state, pid, cands, minOdds, warGate, ctx) {
  var logRejected = !!BAL.AI.LOG_REJECTED;
  var inflight = _aiActInflightTargets(state, pid);
  var rejected = [];
  var bestOdds = 0, bestScore = 0, deepReason = 'no-candidates';

  // The best-scoring target that was refused ON ODDS — the front this power
  // wants and cannot yet pay for, and therefore the one worth massing toward.
  // Candidates arrive score-sorted, so the FIRST such candidate is the best
  // such candidate and nothing later can displace it.
  var wantSid = null, wantPlan = null, wantScore = 0, wantTerms = null;

  // Candidates arrive sorted by score descending; walk them best-first and
  // take the first that clears. One target, one commitment budget — "think in
  // fronts" (§6), not a per-stack optimum.
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    var sid = _aiActCandSid(c);
    if (!sid || !state.stations[sid]) continue;
    var score = (c && typeof c.score === 'number') ? c.score : 0;
    var terms = (c && c.terms && typeof c.terms === 'object') ? c.terms : {};
    // TWO OWNERS, and the difference matters. `owner` is the true one and is
    // used only to answer "is this mine?", which is never fogged — a power
    // always knows what it holds. `seen` is the BELIEVED owner and is what the
    // war gate consults, so a power that declares on France attacks the city it
    // last saw France holding, whoever is actually standing in it now.
    var owner = state.stations[sid].owner;
    var seen = _aiActBelief(state, pid, sid, ctx).owner;
    var why = null;

    if (owner === pid) {
      why = 'already-held';
    } else if (warGate && seen !== null && seen !== 'neutral' &&
               typeof atWar === 'function' && !atWar(state, pid, seen)) {
      // Powers are at war or they are not, and nobody negotiates (§6).
      // Neutral is never gated: taking neutral ground is the whole opening.
      // Neither is ground whose owner is unknown (`seen === null`): there is
      // nobody to be at peace WITH. aiCandidates refuses level-0 targets, so
      // that arm is unreachable today; it is written out rather than left to
      // fall through to a true-board read, which would be a leak.
      why = 'not-at-war';
    } else if (_aiActAlreadyCommitted(state, pid, sid, inflight)) {
      // Our OWN stack, on the true board: you always know where your army is.
      why = 'already-committed';
    }

    if (!why) {
      var plan = _aiActPlanVolley(state, pid, sid, minOdds, ctx);
      if (plan.reason) {
        why = plan.reason;
      } else if (!(plan.odds >= minOdds)) {
        why = 'odds-too-low';
        if (plan.odds > bestOdds) { bestOdds = plan.odds; bestScore = score; }
        if (!wantPlan) {
          wantSid = sid; wantPlan = plan; wantScore = score; wantTerms = terms;
        }
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

  // No attack cleared. Before settling for a hold: if the power WANTS a target
  // and merely cannot pay for it, march the rear forward instead of standing
  // still. This is the branch that unfreezes a board — an empire whose
  // interior is at capacity has nothing to gain by waiting, because logistic
  // growth has already stopped paying it (§2).
  if (wantPlan) {
    var stage = _aiActPlanStage(state, pid, wantSid, wantPlan, minOdds, ctx);
    if (stage.reason) {
      deepReason = stage.reason;
    } else {
      return _aiActDecision(state, pid, {
        kind: 'stage',
        target: stage.depot,          // where the units are going
        stageFor: wantSid,            // what they are being assembled against
        score: wantScore,
        terms: wantTerms || {},
        odds: wantPlan.odds,
        minOdds: minOdds,
        sources: stage.sources,
        fraction: stage.fraction,
        reason: 'staging',
        rejected: logRejected ? rejected : [],
      });
    }
  }

  // Nothing cleared. The reason names the furthest the power got on any
  // candidate — "odds-too-low" if it costed a volley and came up short,
  // "garrison-floor" if it never had the units to cost one, "not-at-war" if
  // the Concert is still holding and there is nothing legal to hit,
  // "stage-massed"/"stage-no-feeders" if it also tried to mass and could not.
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

  // FOG MEMORY, before anything else and for EVERY alive power — the human's
  // included, which is why it sits above the decision loop and above that
  // loop's `state.human` skip. observeTick writes state.seen and nothing else;
  // it draws nothing from state.rng and takes no decision, so it cannot move
  // the balance (core/vision.js).
  //
  // It rides aiTick rather than becoming a seventh sim phase because a new
  // phase in the shared tick silently changes the meaning of every existing
  // test of that tick — known-issues #13, where 78 of 79 tests kept passing
  // while measuring something else. aiTick is already outside the six pinned
  // phases and already runs every tick, so fog costs no new machinery.
  //
  // Guarded, because ai/ is declared optional and core/ must be allowed to be
  // absent from a stripped build the same way ai/score.js is.
  if (typeof observeTick === 'function') observeTick(state);

  // No scorer, no AI. A clean no-op, not a crash and not a log full of noise.
  // Deliberately AFTER the observation sweep: a build with no scorer still has
  // a board a player is looking at, and fog is a property of the board rather
  // than of the AI.
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

    // 'stage' is issued exactly like 'attack' — same command, same entry
    // point, same feedback channel. The ONLY difference is that its target is
    // a station this power already holds, so the wave merges into that
    // garrison instead of fighting (sim/movement.js _moveDeposit). Sharing the
    // branch is deliberate: a staging march that applyCommand refuses must
    // show up as 'command-rejected' in the log exactly like a refused volley.
    if (decision.kind === 'attack' || decision.kind === 'stage') {
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
