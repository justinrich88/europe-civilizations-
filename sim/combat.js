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
    if (totalUnits(st.attackers[keys[i]]) > BAL.ANNIHILATION_EPSILON) out.push(keys[i]);
  }
  return out;
}

// Station defense above the 1.0 baseline, plus terrain. Feeds the ADDITIVE
// power block, never a multiplier -- multiplicative defense makes a full
// fortress mathematically untakeable and the map freezes (§5).
function fortLevel(sid) {
  var d = STATIONS[sid];
  var lvl = (d.defense - 1) + terrainOf(sid).defense;
  return lvl > 0 ? lvl : 0;
}

// Per-unit strength before matchup.
function _strength(type, defending, fort) {
  var u = BAL.UNITS[type];
  var s = defending ? u.def : u.atk;
  // Armour is poor against fortifications (§4) -- it takes ground, it does not
  // reduce forts. Scaled by how fortified the target is so open-field armour
  // is untouched.
  if (!defending && type === 'armour' && fort > 0) {
    var f = fort > 1 ? 1 : fort;
    s *= (1 - f * (1 - BAL.ARMOUR_VS_FORT));
  }
  return s;
}

// Power-weighted type mix of a force, for matchup resolution. Resolved against
// the whole MIX rather than a single "dominant" type, otherwise a 51/49 split
// flips the entire battle (BAL.MATCHUP_MIN_SHARE).
function _mix(units, defending, fort) {
  var raw = {}, total = 0, i, t;
  for (i = 0; i < BAL.UNIT_ORDER.length; i++) {
    t = BAL.UNIT_ORDER[i];
    var v = units[t] * _strength(t, defending, fort);
    if (v < 0) v = 0;
    raw[t] = v;
    total += v;
  }
  if (total <= 0) return null;

  var kept = 0;
  for (i = 0; i < BAL.UNIT_ORDER.length; i++) {
    t = BAL.UNIT_ORDER[i];
    if (raw[t] / total < BAL.MATCHUP_MIN_SHARE) raw[t] = 0;
    kept += raw[t];
  }
  if (kept <= 0) return null;
  for (i = 0; i < BAL.UNIT_ORDER.length; i++) raw[BAL.UNIT_ORDER[i]] /= kept;
  return raw;
}

function _matchup(type, enemyMix) {
  if (!enemyMix) return 1;
  var row = BAL.MATCHUP[type];
  var f = 0;
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var e = BAL.UNIT_ORDER[i];
    f += enemyMix[e] * row[e];
  }
  return f;
}

function _bodyPower(units, defending, fort, enemyMix) {
  var p = 0;
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    if (units[t] <= 0) continue;
    p += units[t] * _strength(t, defending, fort) * _matchup(t, enemyMix);
  }
  return p;
}

// The additive fortress block. Scales in over the first few defenders so an
// empty fort is not a ghost army, and is stripped by artillery in proportion
// to artillery's share of the attacking power (§4).
function _fortBonus(sid, defUnits, atkUnits, fort) {
  if (fort <= 0) return 0;
  var defenders = totalUnits(defUnits);
  if (defenders <= 0) return 0;

  var scale = defenders / BAL.DEFENSE_BONUS_FULL_AT;
  if (scale > 1) scale = 1;
  var bonus = fort * BAL.DEFENSE_BONUS_POWER * scale;

  var atkTotal = 0, arty = 0;
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    var v = atkUnits[t] * _strength(t, false, fort);
    atkTotal += v;
    if (t === 'artillery') arty = v;
  }
  if (atkTotal > 0) {
    var strip = BAL.UNITS.artillery.fortStrip * (arty / atkTotal);
    if (strip > BAL.FORT_STRIP_CAP) strip = BAL.FORT_STRIP_CAP;
    bonus *= (1 - strip);
  }
  return bonus;
}

function _allAttackerUnits(state, sid) {
  var st = state.stations[sid];
  var out = emptyUnits();
  var ids = stationAttackers(state, sid);
  for (var i = 0; i < ids.length; i++) addUnits(out, st.attackers[ids[i]]);
  return out;
}

// Total combat Power for one side at a station.
//
//   side === 'defender'      the owner's garrison
//   side === 'attacker'      every hostile stack combined
//   side === <power id>      that power's stack (the garrison if it is owner)
//
// Includes station defense, terrain, matchup against the opposing mix, and the
// additive fort block for the defender.
function stationPower(state, sid, side) {
  var st = state.stations[sid];
  if (!st) return 0;
  var fort = fortLevel(sid);
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
    units = (st.attackers && st.attackers[side]) ? st.attackers[side] : emptyUnits();
  }

  var enemyMix = defending ? _mix(atkUnits, false, fort) : _mix(defUnits, true, fort);
  var p = _bodyPower(units, defending, fort, enemyMix);
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
    defStart: totalUnits(state.stations[sid].units),
    groups: {},
  };
  var ids = stationAttackers(state, sid);
  for (var i = 0; i < ids.length; i++) {
    b.groups[ids[i]] = totalUnits(state.stations[sid].attackers[ids[i]]);
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

function _takeLosses(units, amount) {
  var total = totalUnits(units);
  if (total <= 0) return;
  var f = amount >= total ? 0 : (total - amount) / total;
  units.infantry *= f;
  units.artillery *= f;
  units.armour *= f;
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
    if (totalUnits(st.units) <= BAL.ANNIHILATION_EPSILON) {
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
        b.groups[atkIds[g]] = totalUnits(st.attackers[atkIds[g]]);
      }
    }

    var swing = _swing(state, b);
    var pDef = stationPower(state, sid, 'defender');
    var pAtk = stationPower(state, sid, 'attacker') * swing;

    var defLoss = BAL.COMBAT_RATE * pAtk;
    var atkLoss = BAL.COMBAT_RATE * pDef;

    _takeLosses(st.units, defLoss);

    // Attacker losses are shared across the hostile stacks by headcount --
    // every unit standing at the station is equally exposed.
    var atkTotal = 0, k;
    for (k = 0; k < atkIds.length; k++) atkTotal += totalUnits(st.attackers[atkIds[k]]);
    if (atkTotal > 0) {
      for (k = 0; k < atkIds.length; k++) {
        var grp = st.attackers[atkIds[k]];
        _takeLosses(grp, atkLoss * (totalUnits(grp) / atkTotal));
      }
    }

    // Drop annihilated attacking stacks.
    var alive = [];
    for (k = 0; k < atkIds.length; k++) {
      var id = atkIds[k];
      if (totalUnits(st.attackers[id]) <= _beatenAt(b.groups[id] || 0, atkLoss)) {
        delete st.attackers[id];
        delete b.groups[id];
      } else {
        alive.push(id);
      }
    }

    if (totalUnits(st.units) <= _beatenAt(b.defStart, defLoss)) {
      if (alive.length) {
        _capture(state, sid, alive);
      } else {
        // Mutual annihilation: the garrison holds the ruins with nothing left.
        st.units.infantry = 0; st.units.artillery = 0; st.units.armour = 0;
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
  st.units.infantry = won.infantry;
  st.units.artillery = won.artillery;
  st.units.armour = won.armour;
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
