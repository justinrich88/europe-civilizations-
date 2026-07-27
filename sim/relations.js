'use strict';

// ---------------------------------------------------------------------------
// sim/relations.js — the balance of power, WITHOUT diplomacy.
//
// 00-vision.md §6: there is no inbox, no proposal, no deal, no trust score.
// Relations move on their own, driven by three things:
//
//   1. shared borders, and where forces are massed on them
//   2. recent aggression — who took what from whom
//   3. relative standing — a HEAVY term pushing everyone toward hostility with
//      whoever leads (BAL.AI.LEADER_WEIGHT, "the Concert of Europe in one
//      number")
//
// The intended emergent effect: run away with the game and the board turns on
// you. You influence relations by acting — where you mass, who you hit, what
// you leave undefended — never by talking.
//
// THROTTLE: this runs once every BAL.AI.RELATION_INTERVAL_TICKS = 50 ticks
// (5 sim-seconds). Relations move far slower than that by design, and the
// border scan plus a territory count for every power is the most expensive
// thing in the tick. 50 was already the interval tuning.js specified; it is
// used here rather than a second constant so there is one place to change it.
//
// MODEL: a slow structural BASE plus a fast aggression OFFSET.
//
//   structural target(a→b) = RELATION_START
//                          − BORDER_PRESSURE · borderWeight · pressure  (0..1)
//                          − LEADER_WEIGHT   · leaderWeight · lead      (0..1)
//   base += (target − base) · RELATION_DRIFT
//   rel   = clamp(base − AGGRESSION_HIT · revengeWeight · grudge)
//
// Why a target and not a per-update delta for the structural terms: with
// deltas, LEADER_WEIGHT = 45 applied every 50 ticks pins the whole board at
// −100 the moment anybody is one province ahead, and the constants stop meaning
// anything. As a target the numbers read directly — a total runaway leader is
// worth 45 points of hostility, taking a peaceful power from +10 to −35, one
// point short of WAR_THRESHOLD. A shared frontier or a stolen city then tips it
// into war. That is exactly the shape §6 asks for. Borders and standing are
// slow-moving facts, so they belong behind the drift.
//
// Why aggression is NOT behind the drift: at RELATION_DRIFT = 0.02 a relation
// closes 2% of its gap per update while AGGRESSION_MEMORY = 0.9 fades a grudge
// with a 6.6-update half-life. Put through the drift, a stolen city would move
// relations by about two points before the memory of it was gone — and §6 says
// recent aggression should DOMINATE the short term. As an offset it lands in
// full on the update it is detected and fades on its own clock.
//
// RELATION_DRIFT keeps its stated meaning: with no border and no leader, the
// target IS RELATION_START, so once the grudge fades the Concert re-forms.
//
// Nothing here touches document, Math.random or Date.now.
// ---------------------------------------------------------------------------

// Memory lives inside state so a snapshot still fully determines the future.
function _relMemo(state) {
  if (!state.relMemo) {
    state.relMemo = {
      owners: {},        // sid -> owner at the last update; the aggression probe
      grudge: {},        // victim -> { attacker: decayed hit count }
      base: {},          // a -> { b: structural relation, before the grudge offset }
      seeded: false,
    };
  }
  return state.relMemo;
}

function _relPowerIds() {
  if (typeof POWER_IDS !== 'undefined' && POWER_IDS && POWER_IDS.length) return POWER_IDS;
  if (typeof POWERS !== 'undefined' && POWERS) return Object.keys(POWERS).sort();
  return [];
}

function _relPersonality(pid) {
  var name = (typeof POWERS !== 'undefined' && POWERS[pid]) ? POWERS[pid].ai : null;
  var P = BAL.AI.PERSONALITIES[name];
  // A power with no declared personality (or a scenario typo) gets neutral
  // weights rather than crashing the tick.
  return P || { leaderWeight: 1, borderWeight: 1, revengeWeight: 1 };
}

// ---------------------------------------------------------------------------
// Driver 1 — shared borders and where forces are massed
//
// One pass over LINKS. For every link joining two different powers, the units
// standing at each end are pressure on the other. Normalised into 0..1 as
// theirs / (theirs + mine + 1) so that "they have massed and I have not" is
// near 1, parity is near 0.5, and an empty frontier is 0 rather than a divide
// by zero. Where you mass is a statement (§6).
// ---------------------------------------------------------------------------

function _relBorderPressure(state) {
  var mass = {};   // "a~b" -> units b has on the a/b frontier
  if (typeof LINKS === 'undefined' || !LINKS) return mass;

  for (var i = 0; i < LINKS.length; i++) {
    var a = state.stations[LINKS[i].a], b = state.stations[LINKS[i].b];
    if (!a || !b) continue;
    var oa = a.owner, ob = b.owner;
    if (oa === ob || oa === 'neutral' || ob === 'neutral') continue;
    var ka = oa + '~' + ob, kb = ob + '~' + oa;
    mass[ka] = (mass[ka] || 0) + totalUnits(b.units);   // what ob has facing oa
    mass[kb] = (mass[kb] || 0) + totalUnits(a.units);
  }
  return mass;
}

// ---------------------------------------------------------------------------
// Driver 2 — recent aggression
//
// Derived from ownership changes since the last update rather than from a hook
// into sim/combat.js. A station changing hands is the loudest and least
// ambiguous signal available, it costs one pass over the station list, and it
// keeps relations independent of the combat module's internals.
//
// Grudges decay by AGGRESSION_MEMORY (0.9) per update — a half-life of about
// 6.6 updates, ~33 sim-seconds. Grudges fade; without decay the board locks
// into permanent alliances by minute three.
// ---------------------------------------------------------------------------

function _relRecordAggression(state, memo) {
  var ids = (typeof STATION_IDS !== 'undefined' && STATION_IDS.length)
    ? STATION_IDS : Object.keys(state.stations).sort();

  // Decay every existing grudge first, so memory fades on the same cadence
  // whether or not anything happened this update.
  var victims = Object.keys(memo.grudge).sort();
  for (var v = 0; v < victims.length; v++) {
    var row = memo.grudge[victims[v]];
    var attackers = Object.keys(row).sort();
    for (var k = 0; k < attackers.length; k++) {
      row[attackers[k]] *= BAL.AI.AGGRESSION_MEMORY;
      if (row[attackers[k]] < 1e-4) delete row[attackers[k]];
    }
  }

  for (var i = 0; i < ids.length; i++) {
    var sid = ids[i];
    var now = state.stations[sid].owner;
    var was = memo.owners[sid];
    memo.owners[sid] = now;
    if (!memo.seeded || was === undefined || was === now) continue;
    // Losing a station to somebody is aggression by them against you. Taking a
    // neutral city angers nobody directly — it only feeds the leader term.
    if (was === 'neutral' || now === 'neutral') continue;
    (memo.grudge[was] = memo.grudge[was] || {});
    memo.grudge[was][now] = (memo.grudge[was][now] || 0) + 1;
  }
  memo.seeded = true;
}

// One flip is already most of a grudge; ten is not ten times worse. Saturating
// so that a long war does not overflow past what LEADER_WEIGHT can express.
function _relGrudgeTerm(memo, victim, attacker) {
  var row = memo.grudge[victim];
  if (!row || !row[attacker]) return 0;
  return 1 - Math.exp(-row[attacker]);
}

// ---------------------------------------------------------------------------
// Driver 3 — relative standing. The Concert in one number.
// ---------------------------------------------------------------------------

function _relStanding(state, pids) {
  var counts = {}, live = [];
  for (var i = 0; i < pids.length; i++) {
    var pid = pids[i];
    if (pid === 'neutral') continue;
    if (state.powers[pid] && state.powers[pid].alive === false) continue;
    counts[pid] = countTerritories(state, pid);
    live.push(pid);
  }
  // Deterministic tie-break: first in sorted POWER_IDS order wins the crown.
  var leader = null, best = -1;
  for (var j = 0; j < live.length; j++) {
    if (counts[live[j]] > best) { best = counts[live[j]]; leader = live[j]; }
  }
  // How far ahead of the FIELD, not of the runner-up: a leader on 10 against
  // six powers on 1 each is further ahead than one on 10 against a 9.
  var others = 0, n = 0;
  for (var m = 0; m < live.length; m++) {
    if (live[m] === leader) continue;
    others += counts[live[m]]; n++;
  }
  var mean = n ? others / n : 0;
  var lead = best > 0 ? (best - mean) / best : 0;
  if (lead < 0) lead = 0;
  if (lead > 1) lead = 1;
  return { counts: counts, live: live, leader: leader, leaderCount: best, lead: lead };
}

// ---------------------------------------------------------------------------
// relationsTick — phase 4 of the tick. Throttled.
// ---------------------------------------------------------------------------

function relationsTick(state) {
  var interval = BAL.AI.RELATION_INTERVAL_TICKS;
  if (state.tick % interval !== 0) return;
  if (state.winner) return;

  var pids = _relPowerIds();
  if (!pids.length) return;

  var memo = _relMemo(state);
  _relRecordAggression(state, memo);

  var mass = _relBorderPressure(state);
  var standing = _relStanding(state, pids);

  var MIN = BAL.AI.RELATION_MIN, MAX = BAL.AI.RELATION_MAX;
  var START = BAL.AI.RELATION_START;

  for (var i = 0; i < pids.length; i++) {
    var a = pids[i];
    if (a === 'neutral') continue;
    var pa = state.powers[a];
    if (!pa || pa.alive === false) continue;
    var person = _relPersonality(a);

    for (var j = 0; j < pids.length; j++) {
      var b = pids[j];
      if (b === a || b === 'neutral') continue;
      if (!state.powers[b]) continue;
      if (pa.relations[b] === undefined) pa.relations[b] = START;

      // --- border pressure ---
      var theirs = mass[a + '~' + b] || 0;
      var mine = mass[b + '~' + a] || 0;
      var pressure = (theirs > 0) ? theirs / (theirs + mine + 1) : 0;

      // --- recent aggression ---
      var grudge = _relGrudgeTerm(memo, a, b);

      // --- relative standing ---
      var lead = 0;
      if (b === standing.leader && a !== standing.leader && standing.leaderCount > 0) {
        var share = (standing.counts[a] || 0) / standing.leaderCount;
        // A power down to two provinces has bigger problems than the leader.
        if (share >= BAL.AI.LEADER_PILE_ON_MIN_SHARE) lead = standing.lead;
      }

      // --- the slow structural base ---
      var target = START
        - BAL.AI.BORDER_PRESSURE * (person.borderWeight || 1) * pressure
        - BAL.AI.LEADER_WEIGHT * (person.leaderWeight || 1) * lead;
      if (target < MIN) target = MIN;
      if (target > MAX) target = MAX;

      if (!memo.base[a]) memo.base[a] = {};
      if (memo.base[a][b] === undefined) memo.base[a][b] = pa.relations[b];
      var base = memo.base[a][b];
      base += (target - base) * BAL.AI.RELATION_DRIFT;
      memo.base[a][b] = base;

      // --- plus the fast aggression offset ---
      var rel = base - BAL.AI.AGGRESSION_HIT * (person.revengeWeight || 1) * grudge;
      if (rel < MIN) rel = MIN;
      if (rel > MAX) rel = MAX;
      pa.relations[b] = rel;

      // Hysteresis (§6 / BAL.AI.WAR_THRESHOLD vs PEACE_THRESHOLD). Stored as a
      // latch rather than recomputed from a single threshold, because a bare
      // comparison makes powers oscillate in and out of war every few seconds
      // and turns the event ticker into noise.
      if (!pa.wars) pa.wars = {};
      if (pa.wars[b]) {
        if (rel > BAL.AI.PEACE_THRESHOLD) {
          delete pa.wars[b];
          logEvent(state, 'relations', powerName(a) + ' and ' + powerName(b) + ' stand down');
        }
      } else if (rel <= BAL.AI.WAR_THRESHOLD) {
        pa.wars[b] = true;
        logEvent(state, 'relations', powerName(a) + ' declares war on ' + powerName(b));
      }
    }
  }
}

// Convenience read for the AI and the HUD, so the hysteresis rule (§6) lives in
// exactly one place instead of being re-derived at every call site.
function atWar(state, a, b) {
  var p = state.powers[a];
  return !!(p && p.wars && p.wars[b]);
}

// Display name, falling back to the id so the log never prints "undefined"
// while data/scenario.js is being regenerated.
function powerName(pid) {
  if (typeof POWERS !== 'undefined' && POWERS[pid] && POWERS[pid].name) return POWERS[pid].name;
  return pid;
}
