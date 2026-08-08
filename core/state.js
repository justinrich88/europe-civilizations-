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

// ---------------------------------------------------------------------------
// UNITS ARE A SCALAR.  (C1, 04-development.md §9)
//
// `st.units` and `w.units` are plain numbers -- a count of undifferentiated
// armies. There used to be a `{infantry, artillery, armour}` bag here and five
// helpers to work it (emptyUnits / totalUnits / splitUnits / addUnits /
// subUnits); all five are gone, because with one number `+`, `-` and `*` say
// the same thing more clearly and there is nothing left to sum.
//
// Deleting `totalUnits()` retires a known-issue #9 hazard rather than creating
// one. Three renderers carried load-order guards and comments warning that a
// hand-rolled `u.infantry + u.artillery + u.armour` anywhere else would be a
// second implementation of one rule. There is no derivation left to duplicate:
// the total IS the field.
//
// Unit counts are still FLOATS -- see rule 1 above, it is unchanged and it is
// the reason attrition works at all.
// ---------------------------------------------------------------------------

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
    // 1x no longer exists — BAL.SPEEDS is [2, 4] (see its comment in
    // data/tuning.js). Sourced from BAL rather than written as a literal so the
    // ladder and its default cannot drift apart; defaulted so a state can still
    // be built before data/tuning.js has loaded, which is the same defensive
    // read every other BAL access in this file makes.
    speed: (typeof BAL !== 'undefined' && BAL && BAL.SPEED_DEFAULT) || 2,
    paused: true,
    rng: seed >>> 0,
    winner: null,
    nextWaveId: 1,
    // Bumped by setStationOwner() every time a station changes hands. Routing
    // is ownership-aware (sim/movement.js), so a route cached before a capture
    // is wrong after it -- this integer is what tells the cache to drop. An
    // INTEGER, never a timestamp: it is part of the state, so a snapshot has to
    // reproduce it exactly.
    ownerEpoch: 0,
    powers: {},
    stations: {},
    waves: [],
    battles: {},
    log: [],
    // FOG MEMORY — what each power has SEEN, and when. Written only by
    // observeTick() (core/vision.js), read only by believedStation().
    //
    // This is the one part of fog that is stored, and the distinction is
    // exact. VISIBILITY is derived and never stored: it is a pure function of
    // ownership, LINKS and station vision, and core/vision.js recomputes it
    // per call. MEMORY is a log of PAST observation, and no snapshot of the
    // present can reconstruct it — "France saw Brussels at t=3120" is not a
    // fact about the board today. Something unreconstructable has to be
    // stored, and it lives HERE for the same three reasons state.rng does:
    // the AI must get the same fog the player does (memory in the renderer
    // would give the AI binary fog and the player ternary), tools/balance.js
    // and test/node.js load no render/ file so anything outside state has
    // zero headless coverage, and snapshot() is JSON of this object alone, so
    // a restored game would otherwise diverge from the run it came from.
    //
    // SPARSE, BY POWER: { pid: { sid: { o, u, c, t } } }. An absent power or
    // an absent station means "never seen" — level 0 — so the empty object a
    // fresh game starts with is exactly correct, not a placeholder.
    seen: {},
    // Standing-order accounting (sim/movement.js). Counters, not a log: they
    // live in state so a snapshot still explains itself and so a headless batch
    // can assert on them without instrumenting the sim.
    //
    // `fights` is a TRIPWIRE and must stay 0 forever. A standing order moves
    // units only between stations their owner already holds; if one ever
    // deposited onto ground its owner does not hold it would have started a
    // battle nobody clicked for, which is the one thing this mechanic may not
    // do (00-vision.md §8, and data/tuning.js §11).
    // SCHEDULED COMMANDS (sim/commands.js, 07-roadmap.md A3). Each entry is
    // { tick, seq, cmd } and is applied by commandsTick() on the tick it names.
    //
    // In state, not beside it, for the reason everything else here is: a
    // snapshot has to fully determine the future, and a command that has been
    // issued but not yet executed is part of that future. Under lockstep it is
    // the ONLY part that came from outside — every client must apply the same
    // commands on the same tick or the boards diverge, and a queue the snapshot
    // did not carry would make reconnect-and-replay wrong by exactly the
    // commands in flight.
    queued: [],
    // THE SHAPE OF THE GAME (sim/victory.js `_vicRecordHistory`, drawn by
    // render/victory.js). Sampled every BAL.HISTORY.INTERVAL_TICKS:
    //
    //   { every, t: [tick,…], p: { pid: { terr: [], force: [], dev: [] } } }
    //
    // `every` is the CURRENT interval and is not constant — it doubles each
    // time the series is decimated, so a reader must use it rather than the
    // constant to convert an index back to a tick.
    //
    // In state for the same three reasons state.seen is: it cannot be
    // recomputed from the present (it is a record of the past), a renderer-side
    // copy would have holes wherever rAF did not fire, and snapshot() is JSON
    // of this object alone.
    history: null,
    // Monotonic, never reused, never reset. Two commands scheduled for the same
    // tick need a total order, and it may not come from the array's insertion
    // order alone — a queue that is filtered or re-sorted anywhere would lose
    // it silently. An integer in state, exactly like nextWaveId.
    nextCmdSeq: 1,
    // Drain accounting, same idea as orderStats below: counters rather than a
    // log, so a headless batch can assert on them without instrumenting the sim.
    cmdStats: {
      queued: 0,       // commands accepted into the queue
      applied: 0,      // drained and accepted by applyCommand
      rejected: 0,     // drained and REJECTED by applyCommand — see the note in
                       // commandsTick about why this is expected and not a bug
    },
    orderStats: {
      sweeps: 0,       // standing-order phases that actually ran (throttled)
      sends: 0,        // waves created by a standing order
      unitsSent: 0,    // units those waves carried at launch
      standDowns: 0,   // standing waves that halted instead of fighting
      unitsLost: 0,    // units dissolved with no held station to fall back to
      fights: 0,       // MUST BE ZERO
    },
  };

  POWER_IDS.forEach(function (pid) {
    s.powers[pid] = {
      alive: true,
      relations: {},          // pid -> -100 (war) .. +100, see sim/relations.js
      startTerritories: 0,    // filled below; readouts and AI valuation
      // High-water mark of stations held, and the baseline capitulation is
      // measured against (sim/victory.js). It is NOT startTerritories, and the
      // reason is the opening: every power now begins on its capital alone, so
      // a power holding one city of a nine-city country controls no territory
      // under the majority rule and starts at 0. Measuring collapse against 0
      // is measuring against nothing — the rule reads as alive and does not
      // fire. A high-water mark also states the intent more honestly than a
      // starting count ever did: capitulation exists to end the mop-up when an
      // empire has been broken, and "broken" means fallen from its peak.
      peakStations: 0,        // filled below
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
    s.stations[sid] = {
      owner: setup ? setup.owner : "neutral",
      units: (setup && typeof setup.units === "number") ? setup.units : 0,
      connected: true,   // recomputed each tick from the capital, sim/movement.js
      growthMul: 1,      // recomputed from multiplier stations in range
      // SUPPLY LINES — MUTABLE PLAYER INTENT, which is why they live here and
      // not in data/stations.js (that file is static geometry). The cities this
      // one streams surplus to, sorted. EMPTY IS THE DEFAULT AND THE OFF
      // SWITCH, so a board nobody has touched behaves exactly as it did before
      // this mechanic existed.
      //
      // THE EDGES ARE THE WHOLE SCHEMA. There used to be a verb here as well —
      // hold/rally/feed, then hold/reinforce/defend — and every version of it
      // made the sim decide something the player could not see: which rally a
      // feeder served, or whether a city counted as "threatened". A wrong guess
      // was invisible, which is the failure this design keeps arriving back at.
      // A list of stated destinations cannot guess. It is also the only shape
      // that lets one city supply several, which one target per source made
      // impossible.
      //
      // setStationSupply is the only supported way to write it — see below.
      supplyTo: [],
    };
  });

  POWER_IDS.forEach(function (pid) {
    s.powers[pid].startTerritories = countTerritories(s, pid);
    s.powers[pid].peakStations = powerStations(s, pid).length;
  });

  return s;
}

// ---------------------------------------------------------------------------
// Ownership
//
// The ONLY supported way to change who holds a station. It exists because
// ownership is no longer a leaf fact: sim/movement.js routes waves around
// stations held by other powers, and it caches those searches. A capture
// therefore invalidates routing, and the cheapest honest way to say so is a
// counter that only ever goes up.
//
// Anything that assigns `state.stations[sid].owner` directly -- including a
// test fixture -- must bump `state.ownerEpoch` itself, or the next route it
// asks for may be answered from a cache built against the old board.
// ---------------------------------------------------------------------------
function setStationOwner(state, sid, owner) {
  var st = state && state.stations ? state.stations[sid] : null;
  if (!st) return false;
  if (st.owner === owner) return false;
  st.owner = owner;
  state.ownerEpoch = (state.ownerEpoch || 0) + 1;
  // SUPPLY LINES DO NOT SURVIVE A CAPTURE. They are one player's intent about
  // their own board, and the power that just took the city never expressed it.
  // Left in place, a captured source would immediately start draining the
  // freshly-taken front-line city its new owner most needs to hold — an
  // automated mechanic quietly working against the player, which is the failure
  // mode the whole scoping rule exists to prevent.
  //
  // Reset happens HERE rather than in the capture paths so no caller can
  // forget: setStationOwner is already the only supported way ownership
  // changes, so it is the only place this can leak from.
  //
  // This clears the lines OUT of the captured city. The lines INTO it — held by
  // other cities that were supplying this one — are dropped edge by edge on the
  // next standing-order sweep, because they are somebody else's state and this
  // function does not know who. See the LOST DESTINATION block in
  // sim/movement.js for why the sweep owns that half.
  //
  // A fresh array, never `length = 0`: a caller holding the old one (a snapshot
  // helper, a renderer that cached it) must not have it emptied underneath them.
  st.supplyTo = [];

  // DEVELOPMENT DOES NOT SURVIVE A CAPTURE EITHER — the build, not merely the
  // tier (04-development.md §6). The new owner starts from nothing.
  //
  // Note the asymmetry with the operating tier, and that it is deliberate: being
  // RAIDED degrades your development, because the tier tracks the garrison;
  // being CONQUERED deletes it. That is what keeps the sink honest — development
  // is a permanent cost that a permanent loss can take away, which is what makes
  // garrisoning it matter.
  //
  // Here for the same reason supplyTo is: setStationOwner is the only supported
  // way ownership changes, so it is the only place this can leak from. `delete`
  // rather than a zeroed object, so "never developed" and "developed then
  // captured" are the same state and nothing has to distinguish them.
  if (st.development) delete st.development;
  return true;
}

// ---------------------------------------------------------------------------
// Supply lines — the other half of the same discipline.
//
// The only supported way to change where a station streams its surplus. Player
// and AI reach it through applyCommand({type:'order', ...}); nothing in render/
// or app/ may call it directly, for the same reason nothing there may write
// units — a second path by which the board changes would cost the whole
// replay/headless-testing property this project rests on.
//
// ONE VERB, N DESTINATIONS. There is no order type any more. A city either has
// supply lines or it does not, and each line is a stated destination. Every
// version of this mechanic that carried a verb also carried an inference the
// player could not see — which rally a feeder served, or whether a city counted
// as "threatened" — and an inference that is wrong is invisible. A list of
// destinations has nothing left to infer.
//
// SORTED AND DEDUPED HERE, once, so nothing downstream has to remember to. The
// orders phase iterates this array and issues a command per entry, so its order
// is part of the sim's determinism: two runs of one seed must produce the same
// commands in the same sequence or wave ids diverge.
// ---------------------------------------------------------------------------

// Returns true when the stored list actually changed.
//
// `targets` is whatever the caller has: an array, or null/undefined to clear.
// Entries that cannot be supplied are dropped rather than refusing the whole
// list, because a caller assembling a group edit should not lose nine good
// edges to one stale id:
//
//   not a string / unknown station   there is nothing at the far end
//   the station itself               a city cannot supply itself, and letting
//                                    it would put a zero-hop send in the sweep
//
// NOT CHECKED HERE: whether each target is still owned by this station's owner.
// That is a fact about the board rather than about the intent, it can stop
// being true seconds after a perfectly legal line was drawn, and something has
// to describe the gap rather than silently swallowing it. Lost edges are
// dropped one at a time by the next standing-order sweep — see the LOST
// DESTINATION block in sim/movement.js for why the sweep owns it and not this
// function.
function setStationSupply(state, sid, targets) {
  var st = state && state.stations ? state.stations[sid] : null;
  if (!st) return false;

  var seen = {}, out = [];
  var list = Array.isArray(targets) ? targets : [];
  for (var i = 0; i < list.length; i++) {
    var to = list[i];
    if (typeof to !== 'string' || to === sid || seen[to]) continue;
    if (!state.stations[to]) continue;
    seen[to] = true;
    out.push(to);
  }
  out.sort();

  var was = st.supplyTo || [];
  if (was.length === out.length) {
    var same = true;
    for (var j = 0; j < out.length; j++) if (was[j] !== out[j]) { same = false; break; }
    if (same) return false;
  }
  st.supplyTo = out;
  return true;
}

// The cities a station supplies, sorted. Always an array, never null — a state
// built before this field existed (a saved snapshot, or a hand-built test
// fixture) reads as "no supply lines" rather than throwing.
//
// The returned array IS the stored one, not a copy: it is read every frame by
// two renderers and copying it per station per frame would be pure waste. Do
// not mutate it; go through setStationSupply.
function stationSupply(state, sid) {
  var st = state && state.stations ? state.stations[sid] : null;
  return (st && st.supplyTo) || [];
}

// THE REVERSE LOOKUP: which of `sid`'s owner's cities supply it, sorted.
//
// O(stations) — there is no index, and there deliberately is not one. An index
// would be a second copy of the same fact, invalidated by every capture and
// every order edit, which is exactly the drift docs/testing/known-issues.md #9
// is about. 108 array lookups is microseconds; the honest cost is stated here
// so a caller can decide, rather than hidden behind a cache that can be wrong.
//
// SAFE FOR ONE STATION PER FRAME (the hovered city). NOT safe in a loop over
// the board — that is O(n^2) and there is no accessor that makes it cheaper.
//
// Scoped to the target's OWN owner: a line only ever runs between two cities
// one power holds, so a source under another flag is a stale edge the next
// sweep will drop and must not be reported as live.
function stationSuppliedBy(state, sid) {
  var st = state && state.stations ? state.stations[sid] : null;
  if (!st) return [];
  var out = [];
  for (var i = 0; i < STATION_IDS.length; i++) {
    var from = state.stations[STATION_IDS[i]];
    if (!from || from.owner !== st.owner) continue;
    var to = from.supplyTo;
    if (to && to.indexOf(sid) >= 0) out.push(STATION_IDS[i]);
  }
  return out;                       // sorted: STATION_IDS is
}

// ---------------------------------------------------------------------------
// Derived reads
//
// Control is DERIVED, never stored -- storing it would mean two sources of
// truth that drift.
//
// Control has THREE tiers (00-vision.md section 3):
//
//   full       holds every station in the country    -> full benefits
//   majority   holds more than half, but not all     -> reduced benefits
//   contested  nobody holds more than half           -> no benefits to anyone
//
// So taking one city in a country does not flip it, and flipping a country
// does not require mopping up every last station. The middle tier is the whole
// point: a country can be meaningfully yours while still being fought over.
// ---------------------------------------------------------------------------

// Which stations sit in which territory never changes -- it is static map
// data. Rebuilding the list on every call made territoryControl() O(stations)
// and victoryTick() O(territories x stations) EVERY TICK, which dominated the
// Monte Carlo harness. Cached against the id list it was built from, so
// indexIds() invalidates it for free.
var _stationsInCache = null;
var _stationsInFor = null;

function stationsIn(territoryId) {
  if (_stationsInFor !== STATION_IDS) {
    _stationsInCache = {};
    for (var i = 0; i < STATION_IDS.length; i++) {
      var t = STATIONS[STATION_IDS[i]].territory;
      (_stationsInCache[t] || (_stationsInCache[t] = [])).push(STATION_IDS[i]);
    }
    _stationsInFor = STATION_IDS;
  }
  return _stationsInCache[territoryId] || [];
}

// Returns { owner, tier, held, total }.
// `owner` is null when contested; `tier` is 'full' | 'majority' | 'contested'.
function territoryControl(state, territoryId) {
  var ids = stationsIn(territoryId);
  var out = { owner: null, tier: "contested", held: 0, total: ids.length };
  if (!ids.length) return out;

  var counts = {};
  for (var i = 0; i < ids.length; i++) {
    var o = state.stations[ids[i]].owner;
    counts[o] = (counts[o] || 0) + 1;
  }

  // Deterministic: iterate POWER_IDS in fixed order, never Object.keys.
  var best = null, bestN = 0;
  for (var p = 0; p < POWER_IDS.length; p++) {
    var n = counts[POWER_IDS[p]] || 0;
    if (n > bestN) { bestN = n; best = POWER_IDS[p]; }
  }

  if (bestN * 2 <= ids.length) return out;          // no strict majority
  out.owner = best;
  out.held = bestN;
  out.tier = bestN === ids.length ? "full" : "majority";
  return out;
}

// Benefit weight for territory-scoped effects -- multiplier reach, and any
// other per-country bonus. Sourced from BAL so it stays tunable in one place.
function controlWeight(tier) {
  var c = (typeof BAL !== "undefined" && BAL.CONTROL) || null;
  if (!c) return tier === "full" ? 1 : tier === "majority" ? 0.5 : 0;
  return tier === "full" ? c.FULL : tier === "majority" ? c.MAJORITY : c.CONTESTED;
}

// Back-compat shim: the owner alone, or null when contested. Callers that need
// the tier must use territoryControl().
function territoryController(state, territoryId) {
  return territoryControl(state, territoryId).owner;
}

// Counts territories at majority or better -- the victory metric.
function countTerritories(state, powerId) {
  var n = 0;
  for (var i = 0; i < TERRITORY_IDS.length; i++) {
    if (territoryControl(state, TERRITORY_IDS[i]).owner === powerId) n++;
  }
  return n;
}

// Counts only fully-held territories -- used for readouts and AI valuation.
function countFullTerritories(state, powerId) {
  var n = 0;
  for (var i = 0; i < TERRITORY_IDS.length; i++) {
    var c = territoryControl(state, TERRITORY_IDS[i]);
    if (c.owner === powerId && c.tier === "full") n++;
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
    if (state.stations[sid].owner === powerId) total += state.stations[sid].units;
  });
  state.waves.forEach(function (w) {
    if (w.owner === powerId) total += w.units;
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

// The event log. `sid` is OPTIONAL and ADDITIVE: an entry that names a station
// carries its id, an entry that does not simply omits the key.
//
// WHY THE ID IS HERE AND THE FILTERING IS NOT.
//
// The ticker (render/hud.js) may not print "ger took Brussels from neutral"
// for a city the player has no eyes on — that single line leaked the whole
// board every time anything changed hands. But the FILTER cannot live here:
//
//   * the log is SIM STATE. Two states that differ in what a power has seen
//     are no longer comparable, and every determinism guarantee in the project
//     rests on that comparison (02-visibility-and-sea.md §1). A log written
//     through a visibility gate would be a different log per observer.
//   * `render/victory.js` wants the truth. The game is over; a fogged
//     post-mortem is user-hostile.
//   * `test/fog-tests.js` asserts as a tested fact that nothing under sim/ so
//     much as NAMES visibility. Passing an id is not consulting one.
//
// So the sim states WHICH station an event is about, and each renderer decides
// on its own whether it may say so. A renderer that does not care ignores the
// field, and a call site that has no meaningful station omits the argument —
// which is why every pre-existing three-argument call still works unmodified.
//
// This cannot move a seeded replay: it draws nothing from state.rng, reads no
// clock, and pushes one more key onto an array nothing in sim/ reads back.
// Verified rather than asserted — `node tools/balance.js 48 --seed 100`
// reproduces the same 48 games, winner for winner and tick for tick.
function logEvent(state, kind, text, sid) {
  var e = { tick: state.tick, kind: kind, text: text };
  // Added CONDITIONALLY, so an entry with no station keeps the exact shape it
  // has always had — including through snapshot()'s JSON round trip.
  if (typeof sid === 'string' && sid) e.sid = sid;
  state.log.push(e);
  if (state.log.length > 400) state.log.shift();
}
