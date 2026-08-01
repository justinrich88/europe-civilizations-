// sim/combat.js — phase 3 of the tick.
//
// Lanchester square law (00-vision.md §5). Casualties per tick are
// proportional to the ENEMY's Power:
//
//     lossesDef = COMBAT_RATE * powerAtk
//     lossesAtk = COMBAT_RATE * powerDef
//
// which integrates to A0^2 - A^2 = B0^2 - B^2, so overwhelming force wins
// nearly intact and battle length depends only on the ODDS:
//
//     ticks = atanh(1/r) / COMBAT_RATE
//
// *** Battle duration is therefore independent of army size. 10v5 and 400v200
// both take ~25 sim-seconds. That is CORRECT (docs/testing/known-issues.md
// #5). Normalising the rate by total force size inverts the pacing -- it makes
// skirmishes instant and army-scale battles interminable. Do not "fix" it. ***
//
// Two things that are deliberately NOT scale-free and are meant to be: the
// additive fortress block (DEFENSE_BONUS_POWER) and the fort scale-in
// (DEFENSE_BONUS_FULL_AT). A fort is worth a fixed number of troops, so it
// dominates a skirmish and barely registers in an army-scale assault. That is
// the point of additive defense.
//
// Attacking stacks live in state.stations[sid].attackers -- { powerId: units }
// deposited by sim/movement.js on arrival. The defender is always the station
// owner's garrison in state.stations[sid].units.

'use strict';

// The wobble uses exactSin(), not Math.sin(), because Math.sin is
// implementation-approximated and this multiplies EVERY battle on EVERY tick —
// the single largest surface in the sim for a cross-engine desync
// (core/exact.js, 07-roadmap.md A2). That makes core/exact.js a LOAD-ORDER
// dependency of this file. Checked at load, loudly, because the alternative
// failure is a ReferenceError thrown out of _swing() in the middle of a fight
// (known-issue #22).
if (typeof exactSin !== 'function') {
  console.error('[sim/combat] no exactSin at load — core/exact.js must come ' +
    'BEFORE sim/combat.js. Every battle will throw on its first tick.');
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Power ids with live attacking stacks at this station, sorted. Sorted rather
// than in insertion order because the winner of a three-way is picked from
// this list and Object.keys order differs between node and the browser.
function stationAttackers(state, sid) {
  var st = state.stations[sid];
  if (!st || !st.attackers) return [];
  var keys = Object.keys(st.attackers).sort();
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    if (st.attackers[keys[i]] > BAL.ANNIHILATION_EPSILON) out.push(keys[i]);
  }
  return out;
}

// Station defense above the 1.0 baseline, plus terrain, plus whatever
// fortification the owner has BUILT AND IS GARRISONING. Feeds the ADDITIVE power
// block, never a multiplier -- multiplicative defense makes a full fortress
// mathematically untakeable and the map freezes (§5).
//
// `state` IS OPTIONAL, and that is not defensive habit. fortLevel(sid) has
// callers that hold no state -- test fixtures, and the static-data checks in
// test/runner.js -- and silently changing what the one-argument form returns is
// how a shared helper poisons a caller that never asked for the new behaviour
// (the same reasoning as commandRoute's optional state/pid). One argument is
// still "what the MAP says this station is worth"; two is "what it is worth on
// this board, right now".
//
// Everything that decides a real fight must pass state, and _fortBonus below
// does. A development contributes through THIS function rather than beside it, so
// it goes through the existing scale-in path -- an unmanned development is not a
// ghost army, and a built fort is worth exactly what a stone one is worth.
function fortLevel(sid, state) {
  var d = STATIONS[sid];
  var lvl = (d.defense - 1) + terrainOf(sid).defense;
  if (state && typeof developmentFortLevel === 'function') {
    lvl += developmentFortLevel(state, sid);
  }
  return lvl > 0 ? lvl : 0;
}

// Per-unit strength. One profile, so `fort` no longer changes it -- the
// fortification's whole effect is now the additive block in _fortBonus().
//
// TOMBSTONE — C1. `_mix()` and `_matchup()` stood here and resolved the
// attacker's type mix against the defender's. Both are gone with the types;
// see data/tuning.js §5 for what the triangle was worth on the board.
function _strength(defending) {
  return defending ? BAL.UNIT.def : BAL.UNIT.atk;
}

function _bodyPower(units, defending) {
  if (units <= 0) return 0;
  return units * _strength(defending);
}

// The additive fortress block. Scales in over the first few defenders so an
// empty fort is not a ghost army.
//
// `atkUnits` is still taken and still unused. It is the seam the artillery
// strip occupied (C1 tombstone, data/tuning.js §5) and 04-development.md §7's
// stalemate question is live again without it -- something about the ATTACKER
// may well have to reduce a fort again, and when it does it arrives here.
// Dropping the parameter now would mean re-threading it through every caller
// and every test to get it back.
function _fortBonus(sid, defUnits, atkUnits, fort) {
  if (fort <= 0) return 0;
  if (defUnits <= 0) return 0;

  var scale = defUnits / BAL.DEFENSE_BONUS_FULL_AT;
  if (scale > 1) scale = 1;
  return fort * BAL.DEFENSE_BONUS_POWER * scale;
}

function _allAttackerUnits(state, sid) {
  var st = state.stations[sid];
  var out = 0;
  var ids = stationAttackers(state, sid);
  for (var i = 0; i < ids.length; i++) out += st.attackers[ids[i]];
  return out;
}

// Total combat Power for one side at a station.
//
//   side === 'defender'      the owner's garrison
//   side === 'attacker'      every hostile stack combined
//   side === <power id>      that power's stack (the garrison if it is owner)
//
// Includes station defense, terrain, and the additive fort block for the
// defender.
function stationPower(state, sid, side) {
  var st = state.stations[sid];
  if (!st) return 0;
  // WITH state: this is the number a real fight is decided by, so a built and
  // garrisoned fortification counts here.
  var fort = fortLevel(sid, state);
  var atkUnits = _allAttackerUnits(state, sid);
  var defUnits = st.units;

  var defending, units;
  if (side === undefined || side === null || side === 'defender' || side === st.owner) {
    defending = true;
    units = defUnits;
  } else if (side === 'attacker' || side === 'attackers') {
    defending = false;
    units = atkUnits;
  } else {
    defending = false;
    units = (st.attackers && st.attackers[side]) ? st.attackers[side] : 0;
  }

  var p = _bodyPower(units, defending);
  if (defending) p += _fortBonus(sid, defUnits, atkUnits, fort);
  return p;
}

// ---------------------------------------------------------------------------
// Engagement bookkeeping
// ---------------------------------------------------------------------------

// Variance is rolled ONCE, here, and held for the whole engagement. A +/-12%
// band re-rolled every 100ms averages to ~0.6% over a 300-tick battle and is
// mathematically meaningless (§5). One roll at engagement start is what makes
// committing feel like a gamble.
function _openBattle(state, sid) {
  var r = rngFloat(state.rng); state.rng = r.state;
  var variance = (r.value * 2 - 1) * BAL.BATTLE_VARIANCE;
  var r2 = rngFloat(state.rng); state.rng = r2.state;

  var b = {
    startedTick: state.tick,
    variance: variance,
    wobble: BAL.BATTLE_WOBBLE,
    phase: r2.value * Math.PI * 2,
    defStart: state.stations[sid].units,
    groups: {},
  };
  var ids = stationAttackers(state, sid);
  for (var i = 0; i < ids.length; i++) {
    b.groups[ids[i]] = state.stations[sid].attackers[ids[i]];
  }
  state.battles[sid] = b;
  return b;
}

// The one fixed roll plus a slow sine so momentum swings are visible in a long
// battle. Deterministic in ticks-since-start, so it does not break the
// scale-invariance of battle duration.
//
// TWO THINGS ABOUT THE ARGUMENT, and both are about precision rather than about
// the mechanic, which is unchanged:
//
//   * `t % PERIOD` before the scaling. The sine is periodic, so this is an
//     identity — but it bounds the argument at 2*PI instead of letting it grow
//     with the age of the battle. Without it a siege still going at tick
//     1,000,000 gets its wobble from an argument near 100,000, where the
//     spacing between representable doubles is itself larger than the phase
//     step between two ticks. `t` is an integer and so is PERIOD, so the modulo
//     is exact.
//   * exactSin, not Math.sin. Same value to ~4e-14; the difference is that
//     every engine agrees on it. See the note at the head of this file.
function _swing(state, b) {
  var t = (state.tick - b.startedTick) % BAL.BATTLE_WOBBLE_PERIOD;
  return 1 + b.variance + b.wobble * exactSin((2 * Math.PI * t) / BAL.BATTLE_WOBBLE_PERIOD + b.phase);
}

// Returns what is LEFT rather than mutating in place -- with a scalar there is
// no bag to reach into, so the caller assigns. Still expressed as a surviving
// FRACTION rather than a subtraction so a loss larger than the force floors at
// exactly 0 instead of going negative.
function _afterLosses(units, amount) {
  if (units <= 0) return units;
  var f = amount >= units ? 0 : (units - amount) / units;
  return units * f;
}

// A side is beaten at ROUT_THRESHOLD of the force it started the engagement
// with. Shipped at 0 = fight to annihilation (§5); the constant is read rather
// than hardcoded so raising it is a one-line experiment. Note that at a
// non-zero threshold the beaten side is currently destroyed rather than turned
// into a retreating wave -- the retreat half of routing is not built.
//
// `lossRate` is the casualties that side is taking per tick. A remnant smaller
// than one tick of losses is already gone -- without this the exponential tail
// leaves a defender sitting at 0.02 units for several ticks, "holding" a
// station it has plainly lost. Folding it in also makes the cutoff scale with
// the size of the battle instead of being an absolute 0.01, which is what
// keeps 10v5 and 400v200 the same length (known-issues #5).
function _beatenAt(startTotal, lossRate) {
  var t = BAL.ROUT_THRESHOLD * startTotal;
  if (t < BAL.ANNIHILATION_EPSILON) t = BAL.ANNIHILATION_EPSILON;
  if (lossRate && lossRate > t) t = lossRate;
  return t;
}

function _clearAttackers(st) {
  if (st.attackers) delete st.attackers;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

function combatTick(state) {
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    var st = state.stations[sid];
    var atkIds = stationAttackers(state, sid);

    if (!atkIds.length) {
      if (st.attackers) _clearAttackers(st);
      if (state.battles[sid]) delete state.battles[sid];
      continue;
    }

    // An undefended station changes hands with no fight at all. Multiplier
    // stations, being barely garrisoned, flip fast -- as they should (§5).
    if (st.units <= BAL.ANNIHILATION_EPSILON) {
      _capture(state, sid, atkIds);
      continue;
    }

    var b = state.battles[sid];
    if (!b) b = _openBattle(state, sid);
    // A stack landing into an ongoing battle inherits the engagement's roll
    // rather than re-rolling (BAL.REINFORCE_INHERITS_VARIANCE); it only needs
    // a starting size recorded for the rout threshold.
    for (var g = 0; g < atkIds.length; g++) {
      if (b.groups[atkIds[g]] === undefined) {
        b.groups[atkIds[g]] = st.attackers[atkIds[g]];
      }
    }

    var swing = _swing(state, b);
    var pDef = stationPower(state, sid, 'defender');
    var pAtk = stationPower(state, sid, 'attacker') * swing;

    var defLoss = BAL.COMBAT_RATE * pAtk;
    var atkLoss = BAL.COMBAT_RATE * pDef;

    st.units = _afterLosses(st.units, defLoss);

    // Attacker losses are shared across the hostile stacks by headcount --
    // every unit standing at the station is equally exposed.
    var atkTotal = 0, k;
    for (k = 0; k < atkIds.length; k++) atkTotal += st.attackers[atkIds[k]];
    if (atkTotal > 0) {
      for (k = 0; k < atkIds.length; k++) {
        var grp = st.attackers[atkIds[k]];
        st.attackers[atkIds[k]] = _afterLosses(grp, atkLoss * (grp / atkTotal));
      }
    }

    // Drop annihilated attacking stacks.
    var alive = [];
    for (k = 0; k < atkIds.length; k++) {
      var id = atkIds[k];
      if (st.attackers[id] <= _beatenAt(b.groups[id] || 0, atkLoss)) {
        delete st.attackers[id];
        delete b.groups[id];
      } else {
        alive.push(id);
      }
    }

    if (st.units <= _beatenAt(b.defStart, defLoss)) {
      if (alive.length) {
        _capture(state, sid, alive);
      } else {
        // Mutual annihilation: the garrison holds the ruins with nothing left.
        st.units = 0;
        _clearAttackers(st);
        delete state.battles[sid];
      }
      continue;
    }

    if (!alive.length) {
      _clearAttackers(st);
      delete state.battles[sid];
    }
  }
}

// The station flips to the strongest surviving attacker. Any other hostile
// stack stays put and immediately becomes an attacker against the new owner --
// the engagement record is dropped so next tick rolls a fresh one, because a
// new defender is a new battle.
function _capture(state, sid, atkIds) {
  var st = state.stations[sid];
  var winner = atkIds[0], bestP = -Infinity;
  for (var i = 0; i < atkIds.length; i++) {
    var p = stationPower(state, sid, atkIds[i]);
    if (p > bestP) { bestP = p; winner = atkIds[i]; }
  }

  var won = st.attackers[winner];
  var prev = st.owner;
  st.units = won;
  // Through setStationOwner so state.ownerEpoch moves: a capture invalidates
  // every ownership-aware route cached against this board (sim/movement.js).
  setStationOwner(state, sid, winner);
  st.capturedTick = state.tick;
  delete st.attackers[winner];

  if (!stationAttackers(state, sid).length) _clearAttackers(st);
  delete state.battles[sid];

  // The station id rides along as logEvent's optional 4th argument. It is a
  // FACT ABOUT THE EVENT, not a consultation of anything: this file neither
  // knows nor may know who can see `sid` (02-visibility-and-sea.md §1, and
  // test/fog-tests.js greps for it). render/hud.js is the file that decides
  // whether the player is told, because a capture in the dark is the single
  // largest thing the ticker used to give away.
  if (typeof logEvent === 'function') {
    logEvent(state, 'capture', winner + ' took ' + (STATIONS[sid] ? STATIONS[sid].name : sid) +
      ' from ' + prev, sid);
  }
}
