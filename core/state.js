"use strict";

// ---------------------------------------------------------------------------
// Runtime state
//
// The ONLY thing in the project that mutates. Static geometry (shapes,
// neighbors, capacities, station types) stays in data/ and is never copied in
// here -- that keeps a snapshot small, diffable, and printable as one console
// table.
//
// Two rules that are easy to break and expensive to debug:
//
//   1. Unit counts are FLOATS. At 100ms ticks, attrition on an integer count
//      rounds to zero and battles never resolve. Floor only at render.
//   2. The PRNG state lives INSIDE this object. A snapshot therefore fully
//      determines the future, which is what makes replay and headless balance
//      runs work. Nothing below the sim layer may call Math.random or Date.now.
//
// See docs/design/01-data-schema.md -> "Runtime state".
// ---------------------------------------------------------------------------

// Precomputed sorted id arrays. Iterating Object.keys() directly would make the
// sim depend on property insertion order, which differs between the browser and
// the node harness and silently breaks determinism.
var STATION_IDS = [];
var TERRITORY_IDS = [];
var POWER_IDS = [];

function indexIds() {
  STATION_IDS = (typeof STATIONS === "object" && STATIONS) ? Object.keys(STATIONS).sort() : [];
  TERRITORY_IDS = (typeof TERRITORIES === "object" && TERRITORIES) ? Object.keys(TERRITORIES).sort() : [];
  POWER_IDS = (typeof POWERS === "object" && POWERS) ? Object.keys(POWERS).sort() : [];
}

function emptyUnits() {
  return { infantry: 0, artillery: 0, armour: 0 };
}

function totalUnits(units) {
  return units.infantry + units.artillery + units.armour;
}

// Scale a unit bundle by a fraction, returning the taken part. Mutates nothing.
function splitUnits(units, fraction) {
  return {
    infantry: units.infantry * fraction,
    artillery: units.artillery * fraction,
    armour: units.armour * fraction,
  };
}

function addUnits(target, source) {
  target.infantry += source.infantry;
  target.artillery += source.artillery;
  target.armour += source.armour;
  return target;
}

function subUnits(target, source) {
  target.infantry -= source.infantry;
  target.artillery -= source.artillery;
  target.armour -= source.armour;
  return target;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

// Build a fresh game state from the static data files. `seed` is required --
// defaulting it would let a caller accidentally create an unreproducible game.
function newGame(seed) {
  if (typeof seed !== "number") throw new Error("newGame(seed) requires a numeric seed");
  indexIds();

  var s = {
    tick: 0,
    speed: 1,
    paused: true,
    rng: seed >>> 0,
    winner: null,
    nextWaveId: 1,
    powers: {},
    stations: {},
    waves: [],
    battles: {},
    log: [],
  };

  POWER_IDS.forEach(function (pid) {
    s.powers[pid] = {
      alive: true,
      relations: {},          // pid -> -100 (war) .. +100, see sim/relations.js
      startTerritories: 0,    // filled below; capitulation is measured against it
      lastActTick: -9999,     // AI action budget
    };
  });

  // Relations matrix, symmetric, initialised neutral.
  POWER_IDS.forEach(function (a) {
    POWER_IDS.forEach(function (b) {
      if (a !== b) s.powers[a].relations[b] = 0;
    });
  });

  STATION_IDS.forEach(function (sid) {
    var setup = (typeof SETUP === "object" && SETUP) ? SETUP[sid] : null;
    var start = setup && setup.units ? setup.units : emptyUnits();
    s.stations[sid] = {
      owner: setup ? setup.owner : "neutral",
      units: {
        infantry: start.infantry || 0,
        artillery: start.artillery || 0,
        armour: start.armour || 0,
      },
      connected: true,   // recomputed each tick from the capital, sim/movement.js
      growthMul: 1,      // recomputed from multiplier stations in range
    };
  });

  POWER_IDS.forEach(function (pid) {
    s.powers[pid].startTerritories = countTerritories(s, pid);
  });

  return s;
}

// ---------------------------------------------------------------------------
// Derived reads
//
// Control is DERIVED, never stored -- storing it would mean two sources of
// truth that drift. A territory belongs to a power when that power holds every
// station in it; anything else is contested. See 00-vision.md section 3.
// ---------------------------------------------------------------------------

function stationsIn(territoryId) {
  return STATION_IDS.filter(function (sid) {
    return STATIONS[sid].territory === territoryId;
  });
}

function territoryController(state, territoryId) {
  var ids = stationsIn(territoryId);
  if (!ids.length) return null;
  var owner = state.stations[ids[0]].owner;
  for (var i = 1; i < ids.length; i++) {
    if (state.stations[ids[i]].owner !== owner) return null; // contested
  }
  return owner;
}

function countTerritories(state, powerId) {
  var n = 0;
  for (var i = 0; i < TERRITORY_IDS.length; i++) {
    if (territoryController(state, TERRITORY_IDS[i]) === powerId) n++;
  }
  return n;
}

function powerStations(state, powerId) {
  return STATION_IDS.filter(function (sid) {
    return state.stations[sid].owner === powerId;
  });
}

function powerForces(state, powerId) {
  var total = 0;
  STATION_IDS.forEach(function (sid) {
    if (state.stations[sid].owner === powerId) total += totalUnits(state.stations[sid].units);
  });
  state.waves.forEach(function (w) {
    if (w.owner === powerId) total += totalUnits(w.units);
  });
  return total;
}

// ---------------------------------------------------------------------------
// Snapshot / restore
//
// Structured-clone-free deep copy. The state is plain JSON by construction --
// if this ever throws, something non-serializable leaked in, which is a bug.
// ---------------------------------------------------------------------------

function snapshot(state) {
  return JSON.parse(JSON.stringify(state));
}

function logEvent(state, kind, text) {
  state.log.push({ tick: state.tick, kind: kind, text: text });
  if (state.log.length > 400) state.log.shift();
}
