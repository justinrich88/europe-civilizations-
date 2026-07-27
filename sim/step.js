'use strict';

// ---------------------------------------------------------------------------
// sim/step.js — the one and only tick entry point.
//
// stepTick(state) advances the simulation by exactly one BAL.TICK_MS tick.
//
// IT NEVER TAKES A dt. Variable timesteps are precisely what the fixed-timestep
// accumulator in the app loop exists to prevent: at 4x speed the loop consumes
// four times as many ticks, never a tick four times as large, so a battle
// resolves identically at 1x and 4x and a replay of a seed is bit-identical
// regardless of frame rate (00-vision.md §9).
//
// PHASE ORDER IS LOAD-BEARING and is itself part of the contract
// (01-data-schema.md, "Sim internals — phase functions"):
//
//   1. growthTick     logistic growth, multiplier reach, disconnection decay
//   2. movementTick   advance waves; resolve arrivals
//   3. combatTick     square-law attrition; flip stations
//   4. relationsTick  balance-of-power drift (throttled internally)
//   5. victoryTick    capitulation and win detection
//
// Growth before movement so a send is based on units that already grew this
// tick. Movement before combat so arrivals fight on the tick they land
// (progress >= 1 resolves immediately, never deferred). Combat before victory
// so a capital captured this tick is seen this tick.
// ---------------------------------------------------------------------------

// The phases, in order. Resolved by name at CALL time rather than captured at
// load time, so script order between the sim files does not matter.
var SIM_PHASES = ['growthTick', 'movementTick', 'combatTick', 'relationsTick', 'victoryTick'];

// Which phase functions are missing right now. Exported because the app and the
// harness both want to say so out loud rather than run a crippled sim.
function missingSimPhases() {
  var missing = [];
  for (var i = 0; i < SIM_PHASES.length; i++) {
    var fn = _simPhaseFn(SIM_PHASES[i]);
    if (typeof fn !== 'function') missing.push(SIM_PHASES[i]);
  }
  return missing;
}

// Function declarations land on the global object; `const`/`let` do not
// (docs/testing/known-issues.md #3). Look the phase up on globalThis, then fall
// back to a lexical typeof ladder so a phase written as a top-level const is
// still found instead of being silently treated as absent.
function _simPhaseFn(name) {
  var g = (typeof globalThis !== 'undefined') ? globalThis : null;
  if (g && typeof g[name] === 'function') return g[name];
  switch (name) {
    case 'growthTick':    return (typeof growthTick    === 'function') ? growthTick    : null;
    case 'movementTick':  return (typeof movementTick  === 'function') ? movementTick  : null;
    case 'combatTick':    return (typeof combatTick    === 'function') ? combatTick    : null;
    case 'relationsTick': return (typeof relationsTick === 'function') ? relationsTick : null;
    case 'victoryTick':   return (typeof victoryTick   === 'function') ? victoryTick   : null;
  }
  return null;
}

function stepTick(state) {
  // A missing phase must FAIL LOUDLY. A no-op phase that reads as working is
  // the worst possible outcome here: growth that silently does not grow looks
  // exactly like a balance problem and costs an afternoon to find.
  var missing = missingSimPhases();
  if (missing.length) {
    throw new Error(
      'stepTick: missing sim phase function(s): ' + missing.join(', ') +
      '. Check that sim/growth.js, sim/movement.js, sim/combat.js, ' +
      'sim/relations.js and sim/victory.js all loaded.');
  }

  // The game is over. Ticking on would keep decaying garrisons under a result
  // that is already final, so a finished game is frozen and stepTick is a
  // no-op — safe to call from a loop that has not noticed yet.
  if (state.winner) return state;

  for (var i = 0; i < SIM_PHASES.length; i++) {
    _simPhaseFn(SIM_PHASES[i])(state);
  }

  state.tick++;
  return state;
}

// Run n whole ticks. Speed multiplies HOW MANY ticks run, never the tick size —
// this is the only sanctioned way to go faster, and it is why 1x and 4x produce
// identical physics.
function stepTicks(state, n) {
  for (var i = 0; i < n; i++) {
    if (state.winner) break;
    stepTick(state);
  }
  return state;
}
