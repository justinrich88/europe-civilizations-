'use strict';

// ---------------------------------------------------------------------------
// ai/score.js — "which station is worth taking?"
//
// This half of the AI answers valuation only. It never mutates, never draws
// from the rng, and knows nothing about commands, cadence or eligibility —
// ai/ai.js owns all of that (01-data-schema.md -> "AI API — pinned names").
// The split exists so the question "why did Germany want Brussels?" can be
// answered, and changed, without touching the question "could Germany take
// it?".
//
// Three globals, all contractual:
//
//   aiContext(state, pid)              per-decision cached facts
//   aiCandidates(state, pid, ctx)      scored targets, best first
//   aiScoreTarget(state, pid, sid, ctx)  { score, terms } for one target
//
// THE TERMS OBJECT IS THE PRODUCT. `terms` maps each BAL.AI.VALUE key to its
// CONTRIBUTION to the score — weight x normalised term, not the bare weight.
// It is what the decision log prints, and 00-vision.md §6 ("a passive AI is
// otherwise undebuggable") is satisfied only if a human can read one line and
// see which term won. Every contribution is rounded to 3dp and `score` is the
// sum of the ROUNDED values, so the printed terms always add up to the printed
// score. A log whose numbers do not reconcile is worse than no log.
//
// NORMALISATION. Every term is pushed into roughly 0..1 before it is weighted,
// except the two whose tuning.js comment explicitly says "per unit". Without
// this, capacityTerm (0.02 x a capacity of 74) would quietly outweigh
// `multiplier` (3.0 x 1) and the AI would chase big cities while ignoring the
// farms §5 makes cheap and §2 makes valuable. Where a term resists honest
// normalisation the compromise is stated at the term, not hidden.
//
// ODDS ARE A POWER RATIO. Infantry defends at 1.2 and attacks at 1.0, so 2:1
// in units is only 1.67:1 in power. Comparing headcounts makes BAL.AI.MIN_ODDS
// mean something other than what its comment claims and the AI walks into
// fights it loses. Defence comes from stationPower(state, sid, 'defender'),
// which already folds in station defense, terrain, the additive fort block and
// matchup (sim/combat.js).
//
// NEUTRAL. `neutral` is a real power id and a legitimate station owner. It is
// never an actor: it has no relations row, atWar() must not be consulted for
// it, and state.powers['neutral'] must never be assumed to have wars/relations.
//
// FOG (milestone 5.7 stage 4). Every read this file makes ABOUT SOMEBODY ELSE'S
// STATION goes through `believedStation()` — owner, garrison and connectivity
// alike. Reads about `pid`'s OWN ground stay on the true board, and that is not
// a leak: a power always knows what it is standing on, and `visibleTo` returns
// 2 for every station its subject holds. The seam is `ctx.vis`, computed once
// per decision by aiContext; see `_aiScoreBelief` below.
//
// Two things deliberately stay on the true board, both recorded in
// 02-visibility-and-sea.md so a later reader does not "fix" them:
//
//   * ctx.leader / ctx.leaderShare — the standings. LEADER_WEIGHT is 45.0 and
//     known-issues #11 established it is the ONLY constant that can actually
//     declare a war, so fogging it would silently disarm the balance of power.
//     In 1914 the standings are newspapers, embassies and attachés: you can
//     hide an army, you cannot hide having conquered Belgium.
//   * routing legality (`commandRoute` / `routeFor`) — see the block above
//     `_aiActPlanVolley` in ai/ai.js. A route is a claim about where your own
//     army may walk, and finding the road blocked when you march is legible
//     fog behaviour. It is also a 1,400x performance trap.
//
// GLOBAL HYGIENE. Top-level function declarations land on `window`
// (known-issues #9 — a renderer's "private" helper silently replaced the sim's
// function of the same name and cost a debugging session while 79 tests stayed
// green). Every private here is prefixed `_ai`; the tree was grepped and no
// `_ai*` name existed before this file.
//
// Nothing here touches document, Math.random or Date.now.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Tuning-adjacent constants that are NOT balance dials.
//
// These exist to keep arithmetic finite and are deliberately not in
// data/tuning.js: changing them changes the shape of the maths, not the
// balance of the game, and tuning.js is for numbers a designer turns.
// ---------------------------------------------------------------------------

// Below this, a power total is treated as zero. Unit counts are floats and a
// "defender" of 1e-13 would otherwise produce odds of 1e13.
var _AI_POWER_EPS = 1e-6;

// Reported odds are clamped here so an undefended station logs `10` rather
// than `Infinity`. Anything past 10:1 is the same decision.
var _AI_ODDS_CAP = 10;

// Where extra odds stop buying anything. 2.0 is tuning.js's "decisive" band;
// 3.0 leaves headroom above it so a walkover still scores above a comfortable
// win. Used only to normalise `weakness`.
var _AI_ODDS_DECISIVE = 3.0;


// ---------------------------------------------------------------------------
// Module-level caches.
//
// tools/balance.js runs hundreds of 36,000-tick games and this code runs for
// 7 powers every 40 ticks, so anything derived purely from LINKS is built once.
// Both caches follow the _stationsInCache pattern in core/state.js:150 — keyed
// on the identity of the object they were derived from, so indexIds() /
// resetSimCaches() invalidate them for free rather than needing a reset hook
// this file would then have to remember to export.
// ---------------------------------------------------------------------------

var _aiAdjSetCache = null;   // sid -> { sid: true }, for O(1) "are these linked?"
var _aiAdjSetFor = null;     // the stationAdjacency() object it was built from

// Standings memo. Every power that acts on the same tick asks the same
// question, and countTerritories() is O(territories x stations). Keyed on both
// the state object and the tick: aiTick is phase 0, so no ownership changes
// between the seven calls, and any change of tick or state drops the memo.
var _aiStandState = null;
var _aiStandTick = -1;
var _aiStandValue = null;


// Undirected station adjacency. Delegates to sim/growth.js rather than
// rebuilding it — known-issues #9 rule 2: prefer calling the canonical
// implementation over copying it, even across layers. The fallback exists only
// so a build without sim/growth.js degrades to "no candidates" instead of a
// TypeError.
function _aiAdjacency() {
  if (typeof stationAdjacency === 'function') return stationAdjacency();
  return {};
}

function _aiAdjSet() {
  var adj = _aiAdjacency();
  if (_aiAdjSetFor === adj && _aiAdjSetCache) return _aiAdjSetCache;
  var set = {};
  var ids = Object.keys(adj).sort();
  for (var i = 0; i < ids.length; i++) {
    var row = {};
    var nb = adj[ids[i]];
    for (var j = 0; j < nb.length; j++) row[nb[j]] = true;
    set[ids[i]] = row;
  }
  _aiAdjSetCache = set;
  _aiAdjSetFor = adj;
  return set;
}

function _aiLinked(a, b) {
  var s = _aiAdjSet()[a];
  return !!(s && s[b]);
}

// A power with no declared personality — or a scenario typo — gets neutral 1s
// rather than crashing a decision. Same rule and same reasoning as
// _relPersonality() in sim/relations.js; duplicated rather than shared because
// that one is private to relations and this file must work if relations is
// absent.
function _aiPersonality(pid) {
  var name = (typeof POWERS !== 'undefined' && POWERS[pid]) ? POWERS[pid].ai : null;
  var P = BAL.AI.PERSONALITIES[name];
  if (P) return P;
  return {
    aggression: 1, minOddsMul: 1,
    leaderWeight: 1, borderWeight: 1, revengeWeight: 1,
    expandBias: 1, defenseBias: 1,
  };
}

function _aiRound(v) {
  return Math.round(v * 1000) / 1000;
}


// ---------------------------------------------------------------------------
// aiContext — the shared shape, pinned in 01-data-schema.md.
// ---------------------------------------------------------------------------

// ONE multi-source BFS seeded with every station `pid` holds, not one BFS per
// station. With ~30 owned stations and a branching factor of ~4 the per-station
// version would visit the same nodes thirty times over for an identical answer:
// the frontier is a set, so seeding it with all sources costs the same single
// sweep and yields distance-from-the-NEAREST-owned-station directly.
//
// Capped at max(TARGET_MAX_HOPS, SOURCE_MAX_HOPS) because those are the only
// two questions asked of it — "is this a legal target?" (2) and "can this
// station join the volley?" (3). Absent means "further than that", which every
// caller must treat as out of range rather than as zero.
//
// The sweep is REACHABILITY, not geography: it expands only through stations
// `pid` may legally march through — **its OWN ground, and nothing else** — while
// still RECORDING the enemy stations on the far side of that frontier, because
// those are exactly the ones worth attacking. Without this the scorer offers
// targets sitting behind somebody else's cities, every resulting volley comes
// back 'no-route' from applyCommand, and the power sits paralysed with a
// decision log full of holds.
//
// NEUTRAL IS NOT PASSABLE. This comment used to say "own or neutral — the
// routeFor rule", and it had been wrong since sim/movement.js:176 changed the
// rule: with the capital-only opening, 101 of 108 stations are neutral at turn
// zero, so "neutral is passable" made the whole map an open highway and Britain
// captured Berlin on turn one without fighting anything. The CODE below was
// updated then; two comment blocks in this file (here and above _aiSources)
// were not. That is the known-issues #9/#18 shape — a description that stopped
// matching the thing it describes, and stayed plausible.
//
// Must mirror _moveCanTraverse in sim/movement.js exactly. If the AI believes
// it can march through ground the sim will not let it cross, every plan it
// makes beyond its own border is rejected as 'no-route' and the power simply
// stops playing — a failure that looks like a passive AI, not a broken rule.
// Can a wave of `pid` march THROUGH `sid`?
//
// THE ROADMAP CALLED THIS EXACTLY RIGHT: "the AI's missing horizon is fixed — it
// was never an AI bug, it was the traversal rule." This function was a second
// copy of sim/movement.js's `st.owner === pid`, so when B1 opened passage the AI
// went on planning against a board where it could only walk on its own ground,
// and its horizon stayed shut for reasons that had nothing to do with the AI.
//
// Delegated to the sim rather than re-implemented. Two copies of a traversal rule
// is known-issues #9 in its purest form, and this one had already drifted by a
// whole milestone before anyone noticed — because both halves were individually
// correct and only their AGREEMENT was wrong.
//
// `movePassageRelation` is the sim's own answer, and the guard is there because
// ai/ must run with sim/movement.js absent (a build with no movement module still
// has to boot, same rule as ai/score.js being optional to the sim).
function _aiScoreCanTraverse(state, pid, sid) {
  var st = state.stations[sid];
  if (!st) return false;
  if (typeof movePassageRelation !== 'function') return st.owner === pid;
  return true;                    // passage is open; the toll is what it costs
}

function _aiHopsFromOwn(state, pid, own, cap) {
  var adj = _aiAdjacency();
  var hops = {};
  var frontier = [];
  var i, j;
  for (i = 0; i < own.length; i++) {
    if (hops[own[i]] === undefined) { hops[own[i]] = 0; frontier.push(own[i]); }
  }
  for (var h = 0; h < cap; h++) {
    var next = [];
    for (i = 0; i < frontier.length; i++) {
      var nb = adj[frontier[i]] || [];
      for (j = 0; j < nb.length; j++) {
        if (hops[nb[j]] !== undefined) continue;
        hops[nb[j]] = h + 1;
        // Recorded either way; only marched through if it is passable.
        if (_aiScoreCanTraverse(state, pid, nb[j])) next.push(nb[j]);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return hops;
}

// Territory standings. `leaderShare` is the leader's share of every territory
// that has an owner at all (contested ones are nobody's), which is the number
// §6's pile-on reads as "how far ahead is the front-runner".
function _aiStandings(state) {
  if (_aiStandState === state && _aiStandTick === state.tick && _aiStandValue) {
    return _aiStandValue;
  }
  var counts = {}, owned = 0;
  for (var t = 0; t < TERRITORY_IDS.length; t++) {
    var o = territoryControl(state, TERRITORY_IDS[t]).owner;
    if (!o) continue;
    counts[o] = (counts[o] || 0) + 1;
    owned++;
  }
  // Deterministic tie-break: first in sorted POWER_IDS order takes the crown,
  // matching _relStanding() in sim/relations.js so the two never disagree
  // about who the board is piling onto.
  var leader = null, best = 0;
  for (var p = 0; p < POWER_IDS.length; p++) {
    var pid = POWER_IDS[p];
    if (pid === 'neutral') continue;
    var n = counts[pid] || 0;
    if (n > best) { best = n; leader = pid; }
  }
  _aiStandValue = {
    counts: counts,
    leader: leader,
    leaderShare: owned > 0 ? best / owned : 0,
  };
  _aiStandState = state;
  _aiStandTick = state.tick;
  return _aiStandValue;
}

function aiContext(state, pid) {
  var own = powerStations(state, pid);          // already sorted: STATION_IDS.filter
  var cap = Math.max(BAL.AI.TARGET_MAX_HOPS, BAL.AI.SOURCE_MAX_HOPS);
  var stand = _aiStandings(state);
  return {
    pid: pid,
    personality: _aiPersonality(pid),
    own: own,
    hops: _aiHopsFromOwn(state, pid, own, cap),

    // THE STANDINGS ARE NOT FOGGED, and that is a decision rather than an
    // oversight. These two walk territoryControl across all 30 territories —
    // global information, computed every decision. LEADER_WEIGHT is 45.0 and
    // known-issues #11 established it is the only constant on the board that
    // can actually declare a war, so fogging it would disarm the balance of
    // power and leave the leader unopposed. 02-visibility-and-sea.md records
    // this in full: "who is winning is public knowledge" — newspapers,
    // embassies and attachés, not reconnaissance. DO NOT "FIX" THIS.
    leader: stand.leader,
    leaderShare: stand.leaderShare,
    ownForces: powerForces(state, pid),

    // THE FOG SEAM (milestone 5.7 stage 4). Live visibility for this power,
    // { sid: 0|2 }, computed ONCE per decision and handed to believedStation as
    // its optional 4th argument by every read below. Without it believedStation
    // recomputes visibleTo per station and the scorer becomes O(n^2) in the
    // board — the honest warning core/vision.js carries above it.
    //
    // Null when core/vision.js is absent, which every consumer must read as
    // "no fog": ai/ must stay loadable on its own (a build with core/vision.js
    // stripped plays the unfogged game rather than crashing).
    vis: (typeof visibleTo === 'function') ? visibleTo(state, pid) : null,

    // Per-decision memos. Underscored because they are not part of the pinned
    // shape — ai/ai.js may read them but must not depend on them existing.
    // Scoring twelve candidates and then re-scoring the chosen one is the
    // normal path, and the source sweep is the expensive part.
    _srcCache: {},
    _oddsCache: {},

    // Believed station records, keyed by sid. READ-ONLY BY CONTRACT: the
    // record is shared between every caller in this decision, so a caller that
    // edited `units` in place would silently rewrite what the power thinks it
    // saw. Both halves of the AI populate it (ai/ai.js `_aiActBelief`).
    _belief: {},
  };
}


// ---------------------------------------------------------------------------
// The believed board
//
// One helper and one proxy builder, and both are DUPLICATED in ai/ai.js as
// `_aiActBelief` / `_aiActBelievedAt`. That is deliberate and it is the rule
// from known-issues #12: privates are prefixed by FILE, not by subsystem,
// because two files that share a domain name the same concepts and collide.
// Neither half may call the other's private — ai/ai.js must load with
// ai/score.js absent, and ai/score.js loads first. The canonical
// implementation both call is believedStation() in core/vision.js; what is
// duplicated here is only the four-line adapter onto it.
// ---------------------------------------------------------------------------

// What `pid` believes is at `sid`. Memoised for the life of one ctx.
//
// The fallback when core/vision.js is absent is the TRUE station, which makes
// a stripped build play the unfogged game rather than throw. It hands back the
// live `units` object, so the read-only contract on `ctx._belief` is what keeps
// that safe.
function _aiScoreBelief(state, pid, sid, ctx) {
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

// The garrison `pid` should PLAN AGAINST at `sid`, as a units bundle.
//
// Levels 1 and 2 hand back what was seen. Level 0 is the interesting one: the
// station has never been observed, so `believedStation` reports null units —
// correct for a renderer, useless for a decision, because a decision has to
// produce some number and null is not one.
//
// The prior is A FULL GARRISON. Station capacity is public, static, authored
// data (data/stations.js): the map is known in 1914, only what is standing on
// it is not. So "assume the ground you have never looked at is held in
// strength" is exactly the information a staff officer has, and it fails SAFE —
// an empty-garrison prior would read every unseen station as a walk-in and send
// the AI charging blind at 10:1 odds it invented. aiCandidates below refuses
// level-0 targets outright, so this is defence in depth rather than a live
// path; it exists so that loosening the filter cannot turn into recklessness.
// `typeof === 'number'`, NOT a truth test. Since C1 a believed garrison is a
// number, and a believed garrison of exactly ZERO is a real and common board
// state — a city scoured by the fight that took it. Under `if (bel.units)`
// that station would fall through to the pessimistic capacity guess below and
// the AI would refuse to walk into an empty city.
function _aiScoreBelievedUnits(state, sid, bel) {
  if (bel && typeof bel.units === 'number') return bel.units;
  var data = (typeof STATIONS !== 'undefined') ? STATIONS[sid] : null;
  return (data && data.capacity > 0) ? data.capacity : 0;
}

// A ONE-STATION PROXY STATE carrying the believed garrison, so the canonical
// stationPower() can be reused rather than re-derived (known-issues #9 rule 2).
// This is the same trick ai/ai.js already used twice for the attacker side, and
// it is the seam the whole of stage 4 rides on: stationPower reads nothing but
// state.stations[sid] (sim/combat.js), so a proxy is a pure read.
//
// NEVER HAND THIS TO routeFor() OR commandRoute(). `_ownRouteCache` in
// sim/movement.js invalidates on state OBJECT IDENTITY, so a fresh proxy per
// call drops the real state's routes too and movementTick recomputes its
// O(n^2) Dijkstras every tick. Measured on the live board: routeFor cached
// 0.115us, against a fresh proxy each call 161.1us — 1,400x, with no wrong
// answer, only a game that crawls.
//
// `attackers` is believed too: at level 2 it is the live set, and at level 1 it
// is empty, because memory records a garrison and never records who was
// besieging it. That matters because stationPower folds the attackers' MIX into
// the defender's matchup.
//
// AND SO IS `development` — C1b, and it was MISSING, which is known-issue #26.
// Every field this proxy omits is a field the sim reads as absent, silently:
// fortLevel(sid, state) asks developmentFortLevel, which asks
// developmentKind(state, sid), which reads state.stations[sid].development off
// THIS object. With it left out, a tier-3 fortress moved aiScoreTarget by
// exactly 0.000, and the AI has been blind to every fort on the board — including
// the ones it has been building itself since B3.
//
// LEVEL 2 ONLY, and that is the design rather than a shortcut. state.seen
// records `{o,u,c,t}` and no development (01-data-schema.md), so a remembered
// station carries no fort to copy — and inventing one would be worse than
// omitting it. This makes the AI's information EXACTLY the player's:
// render/map.js draws the development pips at level 2 and not at level 1, so
// both sides forget a wall the moment they stop looking at it.
//
// The `units` here are the BELIEVED garrison, which is what makes this right
// rather than merely present: operatingTier divides the built tier by the
// garrison, so a fortress the AI believes is skeleton-held is planned against as
// the lower tier it would actually fight at.
function _aiScoreBelievedAt(state, pid, sid, ctx) {
  var bel = _aiScoreBelief(state, pid, sid, ctx);
  var real = state.stations ? state.stations[sid] : null;
  var proxy = { stations: {} };
  proxy.stations[sid] = {
    owner: bel.owner,
    units: _aiScoreBelievedUnits(state, sid, bel),
    attackers: (bel.level === 2 && real && real.attackers) ? real.attackers : {},
    connected: bel.connected !== false,
    development: (bel.level === 2 && real) ? real.development : null,
  };
  return proxy;
}


// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

// Own stations within SOURCE_MAX_HOPS of the target, strongest first, capped at
// MAX_SOURCES_PER_VOLLEY. Bounded BFS FROM THE TARGET — ctx.hops answers
// distance-from-my-territory, which is a different question and cannot be
// reused here. Depth 3 at branching ~4 visits ~60 nodes, x12 candidates x7
// powers per 40 ticks, which is cheap next to a per-candidate connectivity
// recompute.
//
// The cap matters: estimating odds from every station in reach when only six
// can be sent is exactly the optimism that produces attacks the AI cannot
// actually deliver (§8, defeat in detail).
function _aiSources(state, pid, sid, ctx) {
  if (ctx._srcCache && ctx._srcCache[sid]) return ctx._srcCache[sid];

  var adj = _aiAdjacency();
  var seen = {};
  seen[sid] = true;
  var frontier = [sid];
  var found = [];
  for (var h = 0; h < BAL.AI.SOURCE_MAX_HOPS; h++) {
    var next = [];
    for (var i = 0; i < frontier.length; i++) {
      var nb = adj[frontier[i]] || [];
      for (var j = 0; j < nb.length; j++) {
        var n = nb[j];
        if (seen[n]) continue;
        seen[n] = true;
        // Run OUTWARD from the target through passable ground only. This is the
        // routeFor rule read backwards: a source can only join the volley if
        // the ground between it and the target is ITS OWN — neutral is NOT
        // passable (sim/movement.js:176) — so a station on the far side of a
        // rival's, or a neutral's, city must not be counted into the odds for
        // an attack it can never deliver. The predicate is _aiScoreCanTraverse;
        // see the block above it for why this comment said "own or neutral" for
        // as long as it did.
        if (_aiScoreCanTraverse(state, pid, n)) next.push(n);
        if (state.stations[n].owner === pid) {
          var send = _aiSendable(state, n);
          if (send.power > 0) found.push({ sid: n, hops: h + 1, power: send.power });
        }
      }
    }
    if (!next.length) break;
    frontier = next;
  }

  // Strongest first; ties by id so the estimate is reproducible.
  found.sort(function (a, b) {
    if (b.power !== a.power) return b.power - a.power;
    return a.sid < b.sid ? -1 : 1;
  });
  if (found.length > BAL.AI.MAX_SOURCES_PER_VOLLEY) {
    found.length = BAL.AI.MAX_SOURCES_PER_VOLLEY;
  }
  if (ctx._srcCache) ctx._srcCache[sid] = found;
  return found;
}

// What one station could contribute to a volley, as ATTACK power.
//
// Two limits, both from tuning.js: COMMIT_FRACTION is what a volley sends, and
// HOME_GARRISON_FLOOR is the turtle floor that stops a power stripping its
// interior to feed one front. The binding one is whichever sends less.
//
// NO LONGER AN APPROXIMATION. This used to read sum(units x UNITS[t].atk) and
// carry a paragraph excusing the matchup table and armour's fort penalty, both
// of which depended on the combined mix of a volley that had not been chosen
// yet. C1 deleted both, so `send x BAL.UNIT.atk` is now the exact attacking
// body power for this stack, and the defender side always was exact.
function _aiSendable(state, sid) {
  var st = state.stations[sid];
  var data = STATIONS[sid];
  var total = st.units;
  if (total <= _AI_POWER_EPS) return { units: 0, power: 0 };

  var floorUnits = (data ? data.capacity : 0) * BAL.AI.HOME_GARRISON_FLOOR;
  var byFraction = total * BAL.AI.COMMIT_FRACTION;
  var byFloor = total - floorUnits;
  var send = byFraction < byFloor ? byFraction : byFloor;
  if (send <= 0) return { units: 0, power: 0 };

  return { units: send, power: send * BAL.UNIT.atk };
}

// Estimated attacker:defender POWER ratio. Clamped to _AI_ODDS_CAP so an
// undefended multiplier station logs a finite number; 0 when nothing can be
// sent, which ai/ai.js reads as 'no-sources'.
function _aiOdds(state, pid, sid, ctx) {
  if (ctx._oddsCache && ctx._oddsCache[sid] !== undefined) return ctx._oddsCache[sid];

  var srcs = _aiSources(state, pid, sid, ctx);
  var atk = 0;
  for (var i = 0; i < srcs.length; i++) atk += srcs[i].power;

  // FOGGED. The attacker side is `pid`'s own stations and stays on the true
  // board; the defender is read off the BELIEVED station, so a garrison that
  // has doubled since this power last looked does not show up in the odds it
  // scores with. Same canonical stationPower, handed a one-station proxy.
  var def = stationPower(_aiScoreBelievedAt(state, pid, sid, ctx), sid, 'defender');

  var odds;
  if (atk <= _AI_POWER_EPS) odds = 0;
  else if (def <= _AI_POWER_EPS) odds = _AI_ODDS_CAP;   // walk-in; §5 says farms flip fast
  else odds = atk / def;
  if (odds > _AI_ODDS_CAP) odds = _AI_ODDS_CAP;

  if (ctx._oddsCache) ctx._oddsCache[sid] = odds;
  return odds;
}


// ---------------------------------------------------------------------------
// cutsLink — "taking it disconnects enemy stations" (§5)
// ---------------------------------------------------------------------------

// APPROXIMATION, stated plainly. This is a DEPTH-1 articulation test over the
// target's immediate neighbourhood, not a real connectivity computation.
//
// It returns:
//   1.0 x (stranded / same-owner neighbours) — neighbours whose ONLY same-owner
//        link is through the target. Taking it leaves them islanded. This case
//        is EXACT: a station with one same-owner edge loses it, full stop.
//   0.5 when no neighbour is stranded but two same-owner neighbours are neither
//        linked to each other nor share another same-owner neighbour. Locally
//        the target is the only thing joining two lobes; globally they may
//        still meet three or more hops away, so it scores half credit.
//
// What it misses: cuts whose two sides only reconnect further out (false
// negatives), and it over-credits when a long way round exists (false
// positives). Both were accepted deliberately. The exact question — "is this an
// articulation point of the owner's subgraph, or does it carry their path to
// their capital?" — is a full traversal per candidate: 12 traversals per
// decision, x7 powers, every 40 ticks, over hundreds of 36,000-tick games in
// tools/balance.js. The heuristic is O(degree^2) on a graph whose mean degree
// is 4, and it fires on precisely the shapes a human would call a chokepoint.
// FOGGED, and this is the ONE term in the file whose answer actually moves
// under fog today. The target itself is always visible (see the note above
// aiCandidates), but its NEIGHBOURS sit up to two hops from `pid`'s own ground
// and need not be. Measured over three full games sampled every 2,000 ticks:
// of 5,949 neighbour reads, 4,390 were live, 383 were remembered and 1,176 had
// never been seen at all — 26% of this heuristic's input was ground the AI had
// no right to know the ownership of.
//
// An unseen neighbour is simply NOT KIN. Unknown is not "known to be the same
// owner", so it neither counts toward `kin` nor supplies an alternative link.
// A power therefore over-credits a cut it cannot fully see, which is the right
// direction to be wrong in: it is the same mistake a general makes with a map
// and no reconnaissance.
function _aiCutsLink(state, pid, sid, owner, ctx) {
  if (!owner || owner === 'neutral') return 0;   // nothing to disconnect; neutral has no front
  var adj = _aiAdjacency();
  var nb = adj[sid] || [];
  var believedOwner = function (n) { return _aiScoreBelief(state, pid, n, ctx).owner; };

  var kin = [];
  for (var i = 0; i < nb.length; i++) {
    if (believedOwner(nb[i]) === owner) kin.push(nb[i]);
  }
  if (kin.length < 1) return 0;

  var stranded = 0, k, j;
  for (k = 0; k < kin.length; k++) {
    var others = adj[kin[k]] || [];
    var alt = false;
    for (j = 0; j < others.length; j++) {
      if (others[j] !== sid && believedOwner(others[j]) === owner) { alt = true; break; }
    }
    if (!alt) stranded++;
  }
  if (stranded > 0) return stranded / kin.length;

  // Two-lobe case: any pair of same-owner neighbours with no local bridge.
  for (k = 0; k < kin.length; k++) {
    for (j = k + 1; j < kin.length; j++) {
      if (_aiLinked(kin[k], kin[j])) continue;
      var shared = false;
      var a = adj[kin[k]] || [];
      for (var m = 0; m < a.length; m++) {
        if (a[m] === sid) continue;
        if (believedOwner(a[m]) !== owner) continue;
        if (_aiLinked(a[m], kin[j])) { shared = true; break; }
      }
      if (!shared) return 0.5;
    }
  }
  return 0;
}


// ---------------------------------------------------------------------------
// relationTerm — how hostile is `pid` toward this station's owner
// ---------------------------------------------------------------------------

// Centred on PEACE_THRESHOLD, the line tuning.js defines as "stop attacking
// above it", and running to RELATION_MIN at 1. Signed on purpose: a friendly
// neighbour scores NEGATIVE hostility and is therefore actively deprioritised
// against an equally soft neutral city. That is what keeps the Concert holding
// until somebody moves (§6) without score.js needing a hard war gate —
// eligibility belongs to ai/ai.js, which owns `reason`.
//
// Neutral gets exactly 0: it has no relations row, it is never an actor, and
// atWar() must not be consulted for it (01-data-schema.md). Zero also puts
// neutral above any power at peace, which is the right instinct — expand into
// the unaligned before you break the peace.
//
// leaderWeight / borderWeight / revengeWeight are NOT applied here. They are
// already consumed by sim/relations.js in producing the relation value this
// term reads; applying them again would square them.
function _aiHostility(state, pid, owner) {
  if (!owner || owner === pid || owner === 'neutral') return 0;
  var me = state.powers[pid];
  if (!me || !me.relations) return 0;

  var rel = me.relations[owner];
  if (rel === undefined) rel = BAL.AI.RELATION_START;

  var span = BAL.AI.PEACE_THRESHOLD - BAL.AI.RELATION_MIN;   // 85
  var h = span > 0 ? (BAL.AI.PEACE_THRESHOLD - rel) / span : 0;
  if (h > 1) h = 1;
  if (h < -1) h = -1;

  // War is a LATCH with hysteresis, so a power can still be at war at rel =
  // -20, above the line that declared it. Floor the term at the hostility
  // WAR_THRESHOLD itself represents, so "we are at war" never reads as
  // friendlier than "we just declared war".
  if (typeof atWar === 'function' && atWar(state, pid, owner)) {
    var warFloor = span > 0 ? (BAL.AI.PEACE_THRESHOLD - BAL.AI.WAR_THRESHOLD) / span : 0;
    if (h < warFloor) h = warFloor;
  }
  return h;
}


// ---------------------------------------------------------------------------
// aiScoreTarget — the utility of one target. Pure.
// ---------------------------------------------------------------------------

function aiScoreTarget(state, pid, sid, ctx) {
  if (!ctx) ctx = aiContext(state, pid);
  var V = BAL.AI.VALUE;
  var st = state.stations[sid];
  var data = STATIONS[sid];
  var terms = {};
  // `st.owner === pid` is read off the TRUE board on purpose: a power always
  // knows what it is standing on, and visibleTo returns 2 for every station its
  // subject holds, so there is no fog to apply to your own ground.
  if (!st || !data || st.owner === pid) return { score: 0, terms: terms };

  // Everything below that concerns WHOSE station this is reads the BELIEVED
  // owner, which for a fogged station is whoever held it when this power last
  // looked. `null` means never seen: the map is public, so `type` and
  // `capacity` still score, but the capital bonus, the hostility term and the
  // cut heuristic all need an owner and correctly contribute nothing without
  // one. Inventing an owner for ground nobody has visited would be inventing
  // intelligence (core/vision.js, believedStation).
  var bel = _aiScoreBelief(state, pid, sid, ctx);
  var owner = bel.owner;

  var person = ctx.personality;
  var expand = person.expandBias === undefined ? 1 : person.expandBias;
  var defend = person.defenseBias === undefined ? 1 : person.defenseBias;

  // --- acquisition group: what owning this is worth -----------------------
  //
  // Scaled by expandBias. These four weights are the value of HOLDING MORE
  // GROUND, which is exactly the appetite expandBias describes: an
  // expansionist (1.5) pays more for a city than the fight costs, a turtle
  // (0.5) barely values one at all and needs the other terms to justify
  // moving. expandBias and defenseBias are used here and only here — nothing
  // else in the codebase reads them.

  // Type is an indicator in {0,1}, so the contribution IS the weight. That is
  // the reference scale every other term is normalised against: a farm is
  // worth 3.0, a plain town 1.0 (§2, and §5 on farms being cheap to take).
  var typeKey = data.type === 'multiplier' ? 'multiplier'
              : data.type === 'producer' ? 'producer'
              : data.type === 'defensive' ? 'defensive'
              : 'holding';
  terms[typeKey] = _aiRound(V[typeKey] * expand);

  // Capital bonus stacks on top of type — capitulation needs capitals (§7).
  var cap = (typeof POWERS !== 'undefined' && POWERS[owner]) ? POWERS[owner].capital : null;
  if (cap === sid) terms.capital = _aiRound(V.capital * expand);

  // PER-UNIT BY DESIGN — tuning.js says "per unit of capacity", and left raw it
  // already lands in range: capacities run 13..74, so 0.02 x capacity gives
  // 0.26..1.48, straddling the `holding` baseline of 1.0. Normalising it to
  // 0..1 would have thrown away the one thing it is for, which is that a
  // 74-capacity Berlin outweighs a 26-capacity Cork by more than a point.
  terms.capacityTerm = _aiRound(V.capacityTerm * data.capacity * expand);

  // --- weakness: how favourable the fight is ------------------------------
  //
  // COMPROMISE, stated rather than fudged. tuning.js says "per unit of
  // favourable odds above MIN_ODDS", but odds against an empty garrison are
  // literally infinite, so a pure per-unit reading makes weakness the only
  // term that ever matters. It is read here as linear in excess odds up to a
  // decisive ceiling: full weight (1.8) at _AI_ODDS_DECISIVE or better, zero
  // at the power's own minimum, negative never. That preserves the intent —
  // more favourable is monotonically better — inside a bounded range.
  var minOdds = BAL.AI.MIN_ODDS * (person.minOddsMul === undefined ? 1 : person.minOddsMul);
  var odds = _aiOdds(state, pid, sid, ctx);
  var headroom = _AI_ODDS_DECISIVE - minOdds;
  var weak = headroom > 0 ? (odds - minOdds) / headroom : (odds >= minOdds ? 1 : 0);
  if (weak < 0) weak = 0;
  if (weak > 1) weak = 1;
  if (weak > 0) terms.weakness = _aiRound(V.weakness * weak);

  // --- proximity: how cheaply this can be held once taken -----------------
  //
  // Two halves of one question, both 0..1. Hop proximity: 1.0 on my doorstep,
  // falling to 1/TARGET_MAX_HOPS at the edge of reach. Backing: the fraction
  // of the target's neighbours I already hold — a station ringed by my own is
  // trivial to reinforce, a salient poking into enemy ground is not.
  //
  // Scaled by defenseBias, which is the other half of the personality pair. A
  // turtle (1.6) weights holdability heavily and so fights on its own
  // doorstep and straightens its line, matching "holds a deep garrison"; an
  // expansionist (0.7) discounts it and reaches further, matching "attacks
  // early, at worse odds". The two biases therefore pull in opposite
  // directions on the same decision rather than both just inflating scores.
  var hops = ctx.hops[sid];
  if (hops === undefined) hops = BAL.AI.TARGET_MAX_HOPS + 1;
  var hopProx = (BAL.AI.TARGET_MAX_HOPS - (hops - 1)) / BAL.AI.TARGET_MAX_HOPS;
  if (hopProx < 0) hopProx = 0;

  var nb = _aiAdjacency()[sid] || [];
  var mine = 0;
  for (var i = 0; i < nb.length; i++) if (state.stations[nb[i]].owner === pid) mine++;
  var backing = nb.length ? mine / nb.length : 0;

  var prox = 0.5 * hopProx + 0.5 * backing;
  if (prox > 0) terms.proximity = _aiRound(V.proximity * prox * defend);

  // --- cutsLink: severing the enemy's own network (§5) --------------------
  var cut = _aiCutsLink(state, pid, sid, owner, ctx);
  if (cut > 0) terms.cutsLink = _aiRound(V.cutsLink * cut);

  // --- relations ----------------------------------------------------------
  var host = _aiHostility(state, pid, owner);
  if (host !== 0) terms.relationTerm = _aiRound(V.relationTerm * host);

  // Sum the ROUNDED contributions so the logged terms reconcile with the
  // logged score exactly. Iterated over a sorted key list, not Object.keys
  // order, for the same determinism reason as everywhere else.
  var keys = Object.keys(terms).sort();
  var score = 0;
  for (var k = 0; k < keys.length; k++) score += terms[keys[k]];

  return { score: _aiRound(score), terms: terms };
}


// ---------------------------------------------------------------------------
// aiCandidates — scored targets, best first
// ---------------------------------------------------------------------------

// Stations NOT owned by `pid`, within TARGET_MAX_HOPS. The hop cap is what §6
// means by "think in fronts": 2 keeps a power fighting on its own borders
// instead of launching quixotic cross-map expeditions.
//
// Iterates STATION_IDS rather than the keys of ctx.hops. Both would work today,
// but ctx.hops is built by insertion during a BFS and its key order is not
// something this file should be entitled to rely on.
//
// ---------------------------------------------------------------------------
// THE FOG FILTER — and a measurement that says it never fires today
// ---------------------------------------------------------------------------
//
// A station this power has NEVER SEEN is not a target. You cannot decide to
// take a city you do not know is there, and level 0 is exactly that claim.
//
// Measured, so that nobody mistakes this for a load-bearing line: across three
// full games sampled every 2,000 ticks, **1,215 of 1,215 candidates were at
// level 2** — live, right now. Not one was fogged, and not one was hidden.
// That is structural rather than lucky, and it is worth stating because it
// bounds what fog can do to this AI:
//
//   * `_aiHopsFromOwn` above seeds its BFS with every station `pid` holds and
//     expands only through `pid`'s own ground — which is already at hops 0. Its
//     frontier is therefore empty after one pass, so ctx.hops only ever
//     contains 0 and 1, whatever TARGET_MAX_HOPS says.
//   * every station a power holds has vision >= 1 (core/vision.js), so
//     everything one hop out is lit at level 2.
//
// Candidates ⊆ one hop from own ground ⊆ visible. And the same rule runs the
// other way through sim/movement.js: `_moveCanTraverse` allows only own ground,
// so a station you can legally send a wave to is adjacent to something you
// hold, which is a station you can see. **Under the current traversal rule, any
// station the AI may legally attack is a station it can currently see.**
//
// ~~So this filter is a guard, not a behaviour change~~ — **B1 MOVED BOTH FACTS,
// exactly as the sentence below predicted, and this is now a real behaviour
// rule.** Passage lets a wave cross ground its owner does not hold, so the AI can
// legally attack stations it cannot see, and this filter is what stops it doing
// so.
//
// That is the right behaviour and it is what makes fog load-bearing
// (06-movement-and-attrition.md §4): the AI attacks what it KNOWS about, a
// remembered garrison is a bet rather than a curiosity, and the player is under
// exactly the same rule. Kept deliberately, no longer incidentally.
function aiCandidates(state, pid, ctx) {
  if (!ctx) ctx = aiContext(state, pid);
  var out = [];
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    var h = ctx.hops[sid];
    if (h === undefined || h < 1 || h > BAL.AI.TARGET_MAX_HOPS) continue;
    var st = state.stations[sid];
    if (!st || st.owner === pid) continue;
    if (_aiScoreBelief(state, pid, sid, ctx).level === 0) continue;

    var r = aiScoreTarget(state, pid, sid, ctx);
    out.push({
      sid: sid,
      score: r.score,
      terms: r.terms,
      odds: _aiOdds(state, pid, sid, ctx),
    });
  }

  // Score descending, then id ascending. The tie-break is not cosmetic: two
  // identical towns tie constantly, and without it the chosen target would
  // depend on sort stability and the board would diverge between engines.
  out.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.sid < b.sid ? -1 : 1;
  });
  if (out.length > BAL.AI.CANDIDATES_PER_DECISION) {
    out.length = BAL.AI.CANDIDATES_PER_DECISION;
  }
  return out;
}
