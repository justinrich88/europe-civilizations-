'use strict';

// ---------------------------------------------------------------------------
// sim/victory.js — capitulation, elimination and win detection.
//
// 00-vision.md §7: the win condition is TOTAL CONQUEST, made bearable by
// capitulation.
//
//   A power that loses its capital AND falls below BAL.CAPITULATE_FRACTION
//   (~25%) of the territory count it started with capitulates: every station it
//   still holds transfers to whoever holds its capital.
//
// This exists purely to delete the last-20% mop-up. It does not weaken the win
// condition — you still have to take the capital and break the country first.
//
// Territory counting is countTerritories(), which is MAJORITY control, not full
// (00-vision.md §3). A country belongs to whoever holds more than half of its
// stations, so one stubborn fortress in a corner cannot keep a broken power
// technically alive.
//
// Runs last in the tick, after combat, so a capital captured this tick is seen
// this tick (01-data-schema.md, "why this order").
//
// Nothing here touches document, Math.random or Date.now.
// ---------------------------------------------------------------------------

function _vicPowerIds() {
  if (typeof POWER_IDS !== 'undefined' && POWER_IDS && POWER_IDS.length) return POWER_IDS;
  if (typeof POWERS !== 'undefined' && POWERS) return Object.keys(POWERS).sort();
  return [];
}

function _vicStationIds(state) {
  if (typeof STATION_IDS !== 'undefined' && STATION_IDS.length) return STATION_IDS;
  return Object.keys(state.stations).sort();
}

function _vicName(pid) {
  if (typeof powerName === 'function') return powerName(pid);
  return pid;
}

// ---------------------------------------------------------------------------
// Capitulation
// ---------------------------------------------------------------------------

// Both conditions, per BAL.CAPITULATE_REQUIRES_CAPITAL. Returns the power that
// holds the capital (the beneficiary) or null.
function capitulationCheck(state, pid) {
  if (pid === 'neutral') return null;
  var p = state.powers[pid];
  if (!p || p.alive === false) return null;

  var def = (typeof POWERS !== 'undefined') ? POWERS[pid] : null;
  var capital = def && def.capital;
  if (!capital || !state.stations[capital]) return null;

  var holder = state.stations[capital].owner;
  if (BAL.CAPITULATE_REQUIRES_CAPITAL && holder === pid) return null;
  if (holder === pid || holder === 'neutral') return null;   // nobody to surrender to

  // Measured against what this power actually started with, not against a
  // board-wide constant: a power that opened with one homeland territory has a
  // different collapse point from one that opened with six.
  var start = p.startTerritories || 0;
  var now = countTerritories(state, pid);
  if (start > 0 && now >= start * BAL.CAPITULATE_FRACTION) return null;
  if (start === 0 && now > 0) return null;

  return holder;
}

function capitulate(state, pid, holder) {
  var ids = _vicStationIds(state);
  var moved = 0;
  for (var i = 0; i < ids.length; i++) {
    var st = state.stations[ids[i]];
    if (st.owner !== pid) continue;
    st.owner = holder;
    // The surrendering army is not handed over intact (BAL.CAPITULATE_UNIT_KEEP).
    st.units.infantry *= BAL.CAPITULATE_UNIT_KEEP;
    st.units.artillery *= BAL.CAPITULATE_UNIT_KEEP;
    st.units.armour *= BAL.CAPITULATE_UNIT_KEEP;
    moved++;
  }

  // Waves in flight stand down with the country. They are not transferred: a
  // march is a committed one-shot decision by a power that no longer exists,
  // and handing an in-flight assault to the victor produces nonsense like a
  // stack arriving to reinforce the station it was sent to attack.
  var kept = [];
  for (var w = 0; w < state.waves.length; w++) {
    if (state.waves[w].owner !== pid) kept.push(state.waves[w]);
  }
  state.waves.length = 0;
  for (var k = 0; k < kept.length; k++) state.waves.push(kept[k]);

  // ...and so do stacks that have ALREADY LANDED but are still fighting.
  // These live in station.attackers, not in state.waves, so clearing waves
  // alone is not enough. Found by tools/balance.js: a capitulated France went
  // on to capture Turin ~40,000 ticks after surrendering, because a landed
  // French stack was still resolving when the country fell. That left a dead
  // power holding a station forever, which no victory condition could ever
  // clear -- the game could not end.
  //
  // Note this only bites when the fight OUTLIVES the surrender. If the stack
  // lands on an undefended station the capture happens in phase 3 and the
  // capitulation in phase 5 of the same tick sweeps it up correctly. It takes
  // a defended target -- a battle still running when the country falls -- to
  // produce the zombie, which is why a naive test of this misses it.
  for (var a = 0; a < ids.length; a++) {
    var stn = state.stations[ids[a]];
    if (stn.attackers && stn.attackers[pid]) {
      delete stn.attackers[pid];
      // A battle whose only attacker just stood down is over.
      if (state.battles[ids[a]] && !stationAttackers(state, ids[a]).length) {
        delete state.battles[ids[a]];
      }
    }
  }

  state.powers[pid].alive = false;
  logEvent(state, 'capitulation',
    _vicName(pid) + ' capitulates — ' + moved + ' station' + (moved === 1 ? '' : 's') +
    ' pass to ' + _vicName(holder));
}

// ---------------------------------------------------------------------------
// Elimination — distinct from capitulation. A power can simply be scoured off
// the board without its capital ever being the last thing to fall.
// ---------------------------------------------------------------------------

function _vicHoldsAnything(state, pid) {
  var ids = _vicStationIds(state);
  for (var i = 0; i < ids.length; i++) if (state.stations[ids[i]].owner === pid) return true;
  for (var w = 0; w < state.waves.length; w++) if (state.waves[w].owner === pid) return true;
  return false;
}

// ---------------------------------------------------------------------------
// victoryTick — phase 5 of the tick.
// ---------------------------------------------------------------------------

function victoryTick(state) {
  if (state.winner) return;

  var pids = _vicPowerIds();

  // Capitulation is a whole-board scan and nothing about it is time-critical,
  // so it runs on BAL.CAPITULATE_CHECK_INTERVAL (50 ticks = 5 sim-seconds).
  if (state.tick % BAL.CAPITULATE_CHECK_INTERVAL === 0) {
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i];
      if (pid === 'neutral') continue;
      var p = state.powers[pid];
      if (!p || p.alive === false) continue;

      var holder = capitulationCheck(state, pid);
      if (holder) { capitulate(state, pid, holder); continue; }

      if (!_vicHoldsAnything(state, pid)) {
        p.alive = false;
        logEvent(state, 'elimination', _vicName(pid) + ' is eliminated');
      }
    }
  }

  // Win detection runs every tick — it is one pass over the station list, and a
  // victory that shows up five seconds late reads as a bug.
  var ids = _vicStationIds(state);
  var owner = null;
  for (var s = 0; s < ids.length; s++) {
    var o = state.stations[ids[s]].owner;
    if (owner === null) { owner = o; continue; }
    if (o !== owner) return;                      // still contested; nothing to do
  }
  if (owner && owner !== 'neutral') {
    state.winner = owner;
    logEvent(state, 'victory', _vicName(owner) + ' controls all of Europe');
    return;
  }

  // Hard stop so a stalemated Monte Carlo run cannot hang the harness
  // (BAL.MAX_GAME_TICKS). Scored as a draw and reported as such in batches.
  if (state.tick >= BAL.MAX_GAME_TICKS) {
    state.winner = 'draw';
    logEvent(state, 'victory', 'the war grinds to a draw at ' + state.tick + ' ticks');
  }
}
