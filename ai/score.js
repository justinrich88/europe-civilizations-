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
function _aiHopsFromOwn(own, cap) {
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
        if (hops[nb[j]] === undefined) { hops[nb[j]] = h + 1; next.push(nb[j]); }
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
    hops: _aiHopsFromOwn(own, cap),
    leader: stand.leader,
    leaderShare: stand.leaderShare,
    ownForces: powerForces(state, pid),

    // Per-decision memos. Underscored because they are not part of the pinned
    // shape — ai/ai.js may read them but must not depend on them existing.
    // Scoring twelve candidates and then re-scoring the chosen one is the
    // normal path, and the source sweep is the expensive part.
    _srcCache: {},
    _oddsCache: {},
  };
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
        next.push(n);
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
// APPROXIMATION: power is sum(units x UNITS[t].atk), which omits the matchup
// table and armour's fort penalty. Both depend on the COMBINED mix of every
// source in the volley against the defender's mix — a quantity only ai/ai.js
// knows, after it has chosen sources. Since matchup factors sit near 1 and
// apply to every candidate alike, omitting them shifts the absolute odds
// slightly but barely reorders the candidate list. The defender side, which is
// where the fort block lives and where errors are expensive, is exact.
function _aiSendable(state, sid) {
  var st = state.stations[sid];
  var data = STATIONS[sid];
  var total = totalUnits(st.units);
  if (total <= _AI_POWER_EPS) return { units: 0, power: 0 };

  var floorUnits = (data ? data.capacity : 0) * BAL.AI.HOME_GARRISON_FLOOR;
  var byFraction = total * BAL.AI.COMMIT_FRACTION;
  var byFloor = total - floorUnits;
  var send = byFraction < byFloor ? byFraction : byFloor;
  if (send <= 0) return { units: 0, power: 0 };

  var f = send / total;
  var power = 0;
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    power += st.units[t] * f * BAL.UNITS[t].atk;
  }
  return { units: send, power: power };
}

// Estimated attacker:defender POWER ratio. Clamped to _AI_ODDS_CAP so an
// undefended multiplier station logs a finite number; 0 when nothing can be
// sent, which ai/ai.js reads as 'no-sources'.
function _aiOdds(state, pid, sid, ctx) {
  if (ctx._oddsCache && ctx._oddsCache[sid] !== undefined) return ctx._oddsCache[sid];

  var srcs = _aiSources(state, pid, sid, ctx);
  var atk = 0;
  for (var i = 0; i < srcs.length; i++) atk += srcs[i].power;

  var def = stationPower(state, sid, 'defender');

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
function _aiCutsLink(state, sid, owner) {
  if (owner === 'neutral') return 0;   // nothing to disconnect; neutral has no front
  var adj = _aiAdjacency();
  var nb = adj[sid] || [];

  var kin = [];
  for (var i = 0; i < nb.length; i++) {
    if (state.stations[nb[i]].owner === owner) kin.push(nb[i]);
  }
  if (kin.length < 1) return 0;

  var stranded = 0, k, j;
  for (k = 0; k < kin.length; k++) {
    var others = adj[kin[k]] || [];
    var alt = false;
    for (j = 0; j < others.length; j++) {
      if (others[j] !== sid && state.stations[others[j]].owner === owner) { alt = true; break; }
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
        if (state.stations[a[m]].owner !== owner) continue;
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
  if (!st || !data || st.owner === pid) return { score: 0, terms: terms };

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
  var cap = (typeof POWERS !== 'undefined' && POWERS[st.owner]) ? POWERS[st.owner].capital : null;
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
  var cut = _aiCutsLink(state, sid, st.owner);
  if (cut > 0) terms.cutsLink = _aiRound(V.cutsLink * cut);

  // --- relations ----------------------------------------------------------
  var host = _aiHostility(state, pid, st.owner);
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
function aiCandidates(state, pid, ctx) {
  if (!ctx) ctx = aiContext(state, pid);
  var out = [];
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    var h = ctx.hops[sid];
    if (h === undefined || h < 1 || h > BAL.AI.TARGET_MAX_HOPS) continue;
    var st = state.stations[sid];
    if (!st || st.owner === pid) continue;

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
