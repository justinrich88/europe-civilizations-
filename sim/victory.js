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

// Powers still in the war: alive AND actually holding ground. Sorted, because
// the id array feeds a win declaration and determinism runs all the way up
// (00-vision.md §9). A power marked alive with nothing left is a bookkeeping
// state, not a combatant — victoryTick flips that flag on its own throttle, so
// without the station check a winner would be announced up to 50 ticks late.
function _vicSurvivingPowers(state) {
  var pids = _vicPowerIds();
  var out = [];
  for (var i = 0; i < pids.length; i++) {
    var pid = pids[i];
    if (pid === 'neutral') continue;
    var p = state.powers[pid];
    if (!p || p.alive === false) continue;
    if (!_vicHoldsAnything(state, pid)) continue;
    out.push(pid);
  }
  return out.sort();
}

// Raise a power's high-water mark of stations held. Monotonic by construction:
// it only ever moves up, so retaking ground does not lower the bar a power has
// to fall back through to capitulate.
function _vicTrackPeak(state, pid) {
  var p = state.powers[pid];
  if (!p) return 0;
  var now = powerStations(state, pid).length;
  if (now > (p.peakStations || 0)) p.peakStations = now;
  return p.peakStations || 0;
}

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

  // Measured in STATIONS against this power's own high-water mark, not in
  // territories against its starting count.
  //
  // Two reasons, and the first is fatal on its own. Every power now opens on
  // its capital alone (data/scenario.js), and one city inside a nine-city
  // country is not a majority, so `startTerritories` is 0 for all seven. A
  // threshold of `0 * 0.25` is a threshold of nothing: the rule would sit here
  // reading as alive and never fire, and no test would notice because no test
  // asserts that a rule DOES fire.
  //
  // The second is that the peak states the design intent better than the start
  // ever did. Capitulation exists to remove the tedious last-20% mop-up
  // (00-vision.md §7), and what makes a mop-up tedious is an empire that WAS
  // big. A power that conquered half of Europe and has been driven back to two
  // cities should fold; a power that never grew past its capital has no mop-up
  // to skip and should be taken the hard way.
  // The mark itself is maintained by _vicTrackPeak below, NOT here. This
  // function is only reached once a power has already lost its capital, so a
  // peak updated in this branch would be frozen at whatever the power held on
  // turn zero — which is 1 — and `now >= 1 * 0.25` is true for any surviving
  // power. The rule would then only ever fire at exactly zero stations, i.e.
  // it would be elimination wearing capitulation's name.
  var peak = p.peakStations || 0;
  var now = powerStations(state, pid).length;
  if (peak > 0 && now >= peak * BAL.CAPITULATE_FRACTION) return null;

  return holder;
}

function capitulate(state, pid, holder) {
  var ids = _vicStationIds(state);
  var moved = 0;
  for (var i = 0; i < ids.length; i++) {
    var st = state.stations[ids[i]];
    if (st.owner !== pid) continue;
    // A capitulation transfers a whole empire at once. Same reason as
    // sim/combat.js's _capture: it must move state.ownerEpoch, or routes
    // cached against the old map of Europe survive the country that drew them.
    setStationOwner(state, ids[i], holder);
    // The surrendering army is not handed over intact (BAL.CAPITULATE_UNIT_KEEP).
    st.units *= BAL.CAPITULATE_UNIT_KEEP;
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
  // NO STATION ID, deliberately — logEvent's 4th argument is omitted here and
  // at every other call in this file. A capitulation is not about a city; it
  // is about a power, and the several dozen stations that just changed hands
  // are the consequence rather than the subject. There is nothing for the
  // ticker's fog filter to test, and there must not be: 02-visibility-and-sea.md
  // is explicit that **who is winning is public knowledge** — "you can hide an
  // army; you cannot hide having conquered Belgium". An untagged entry is
  // therefore shown to everyone, which is the correct default for all three
  // kinds this file writes (capitulation, elimination, victory).
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

      // Before the check, not inside it: capitulationCheck() returns early
      // while a power still holds its capital, so that is the one place the
      // mark can never be raised. Sampling every 50 ticks is deliberate — the
      // peak only has to be right to within a few stations, and this is
      // already the whole-board scan.
      _vicTrackPeak(state, pid);

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
  // You win by outlasting every RIVAL, not by owning every pixel.
  //
  // This used to require a single owner across all 108 stations, neutrals
  // included, and that condition turned out to be nearly unsatisfiable.
  // Measured, seed 9 at the 60,000-tick cap: Russia held 105 of 108 stations
  // and every other power was dead — and no victory fired, because three
  // neutral villages had never been taken by anybody. Seed 7 was the same
  // story at 106 of 108. Those games were not close; they were over, and the
  // sim would not say so.
  //
  // The cost of that was not only cosmetic. tools/balance.js awards a capped
  // game to whoever leads on territories, so 73% of every batch we have
  // measured was a timeout leaderboard wearing the word "win" — the balance
  // instrument was reading the mop-up, not the war.
  //
  // Neutral holdouts are exactly the "tedious last-20%" that 00-vision.md §7
  // invented capitulation to delete. A power that has outlived every rival has
  // won Europe; a handful of ungarrisoned villages in the Pyrenees does not
  // make that a draw.
  var alive = _vicSurvivingPowers(state);
  if (alive.length === 1) {
    state.winner = alive[0];
    logEvent(state, 'victory', _vicName(alive[0]) + ' outlasts every rival power');
    return;
  }

  // Hard stop so a stalemated Monte Carlo run cannot hang the harness
  // (BAL.MAX_GAME_TICKS). Scored as a draw and reported as such in batches.
  if (state.tick >= BAL.MAX_GAME_TICKS) {
    state.winner = 'draw';
    logEvent(state, 'victory', 'the war grinds to a draw at ' + state.tick + ' ticks');
  }
}
