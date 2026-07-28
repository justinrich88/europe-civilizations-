// sim/growth.js — phase 1 of the tick (01-data-schema.md "Sim internals").
//
// Three jobs, in this order:
//
//   1. Connectivity. Flood from each power's capital over the stations it
//      actually holds. A station with no path home stops growing and decays
//      (00-vision.md §5, "keeping the snowball honest").
//   2. Growth. Logistic, per station, using the multiplier cached on the
//      station LAST tick.
//   3. Recompute that cached multiplier for next tick.
//
// Why growth is applied with last tick's multiplier and the new one written
// afterwards: growthMul is a *published* field — the renderer draws it and
// tests set it — so it has to be readable and stable for a whole tick rather
// than being a mid-phase temporary. One tick of latency on a value that
// changes only when a station flips is invisible.
//
// Logistic and not linear, per 00-vision.md §1: units left at home multiply,
// units sent away don't, and a station near capacity has stopped paying
// dividends. That is the whole tension of the game and it lives in this file.
//
// No document, no Math.random, no Date.now. Iteration is over the sorted id
// arrays from core/state.js only.

'use strict';

// ---------------------------------------------------------------------------
// Static caches. Everything here depends only on data/, never on state, so it
// is built once. Fixtures that swap the data files out call resetSimCaches().
// ---------------------------------------------------------------------------

var _adjCache = null;          // sid -> [sid, …]
var _terrHopCache = null;      // territoryId -> { territoryId: hops }
var _multiplierIds = null;     // sorted ids of every multiplier station

function resetSimCaches() {
  _adjCache = null;
  _terrHopCache = null;
  _multiplierIds = null;
  if (typeof resetRouteCache === 'function') resetRouteCache();
}

// Undirected station adjacency over LINKS. Neighbour lists are sorted so any
// traversal built on top of this is deterministic without extra care.
function stationAdjacency() {
  if (_adjCache) return _adjCache;
  var adj = {};
  var i;
  for (i = 0; i < STATION_IDS.length; i++) adj[STATION_IDS[i]] = [];
  var links = (typeof LINKS !== 'undefined' && LINKS) ? LINKS : [];
  for (i = 0; i < links.length; i++) {
    var a = links[i].a, b = links[i].b;
    if (!adj[a] || !adj[b]) continue;
    adj[a].push(b);
    adj[b].push(a);
  }
  for (i = 0; i < STATION_IDS.length; i++) adj[STATION_IDS[i]].sort();
  _adjCache = adj;
  return adj;
}

// Territory hop distance, BFS over declared neighbours, capped at
// MULTIPLIER_REACH + 1 so the cache stays small. Territories further than the
// cap simply do not appear in the map.
function territoryHops(fromTerr) {
  if (!_terrHopCache) _terrHopCache = {};
  if (_terrHopCache[fromTerr]) return _terrHopCache[fromTerr];

  var maxHops = BAL.MULTIPLIER_REACH;
  var dist = {};
  dist[fromTerr] = 0;
  var frontier = [fromTerr];
  for (var h = 0; h < maxHops; h++) {
    var next = [];
    for (var i = 0; i < frontier.length; i++) {
      var t = TERRITORIES[frontier[i]];
      if (!t) continue;
      var nb = (t.neighbors || []).slice().sort();
      for (var j = 0; j < nb.length; j++) {
        if (dist[nb[j]] === undefined && TERRITORIES[nb[j]]) {
          dist[nb[j]] = h + 1;
          next.push(nb[j]);
        }
      }
    }
    frontier = next;
  }
  _terrHopCache[fromTerr] = dist;
  return dist;
}

function multiplierStationIds() {
  if (_multiplierIds) return _multiplierIds;
  _multiplierIds = STATION_IDS.filter(function (sid) {
    var d = STATIONS[sid];
    return d && d.type === 'multiplier' && typeof d.multiplier === 'number' && d.multiplier > 1;
  });
  return _multiplierIds;
}

// `neutral` is a real power id with no capital and no AI (01-data-schema.md).
// Distinguishing it by the absence of a capital rather than by the literal
// string keeps the rule true for any future unaligned faction.
function isRealPower(pid) {
  var powers = (typeof POWERS !== 'undefined' && POWERS) ? POWERS : {};
  return !!(pid && powers[pid] && powers[pid].capital);
}

function terrainOf(sid) {
  var d = STATIONS[sid];
  var t = d && TERRITORIES ? TERRITORIES[d.territory] : null;
  var key = t ? t.terrain : 'plains';
  return BAL.TERRAIN[key] || BAL.TERRAIN.plains;
}

// ---------------------------------------------------------------------------
// Connectivity
//
// Per power: flood from the capital over stations that power owns. A power
// that has lost its capital falls back to the largest component it still holds
// (BAL.FALLBACK_ANCHOR_ON_CAPITAL_LOSS) so losing Berlin does not melt the
// whole empire in one tick. `neutral` has no capital and is never cut off --
// it is scenery, not a belligerent with a supply line.
// ---------------------------------------------------------------------------

function _floodFrom(state, adj, anchors, owner, seen) {
  var stack = anchors.slice();
  var n = 0;
  while (stack.length) {
    var sid = stack.pop();
    if (seen[sid]) continue;
    if (state.stations[sid].owner !== owner) continue;
    seen[sid] = true;
    n++;
    var nb = adj[sid];
    for (var i = 0; i < nb.length; i++) {
      if (!seen[nb[i]] && state.stations[nb[i]].owner === owner) stack.push(nb[i]);
    }
  }
  return n;
}

function computeConnectivity(state) {
  var adj = stationAdjacency();
  var powers = (typeof POWERS !== 'undefined' && POWERS) ? POWERS : {};
  var reached = {};

  for (var p = 0; p < POWER_IDS.length; p++) {
    var pid = POWER_IDS[p];
    var def = powers[pid] || {};
    var owned = STATION_IDS.filter(function (sid) { return state.stations[sid].owner === pid; });
    if (!owned.length) continue;

    // A power with no capital in the scenario (neutral) is connected by fiat.
    if (!def.capital) {
      for (var i = 0; i < owned.length; i++) reached[owned[i]] = true;
      continue;
    }

    var seen = {};
    if (state.stations[def.capital] && state.stations[def.capital].owner === pid) {
      _floodFrom(state, adj, [def.capital], pid, seen);
    } else if (BAL.FALLBACK_ANCHOR_ON_CAPITAL_LOSS) {
      // Largest surviving component becomes the anchor. Ties break on the
      // lowest station id, which is why `owned` is iterated sorted.
      var best = null, bestN = 0;
      for (var k = 0; k < owned.length; k++) {
        var probe = {};
        var n = _floodFrom(state, adj, [owned[k]], pid, probe);
        if (n > bestN) { bestN = n; best = probe; }
      }
      if (best) seen = best;
    }
    for (var s = 0; s < owned.length; s++) if (seen[owned[s]]) reached[owned[s]] = true;
  }

  for (var q = 0; q < STATION_IDS.length; q++) {
    var sid2 = STATION_IDS[q];
    var st = state.stations[sid2];
    var conn = !!reached[sid2];
    if (conn) {
      st.connected = true;
      st.discSince = -1;
    } else {
      if (st.connected !== false || st.discSince === undefined || st.discSince < 0) {
        st.discSince = state.tick;
      }
      st.connected = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Multiplier reach  (00-vision.md §2, the most novel mechanic)
// ---------------------------------------------------------------------------

// Product of every multiplier reaching this station, capped at GROWTH_MUL_CAP.
// Each contribution is scaled by the CONTROL TIER of the multiplier's own
// territory (core/state.js controlWeight): a country you only half-hold only
// half-feeds you, and a contested one feeds nobody.
function growthMultiplier(state, sid) {
  var mids = multiplierStationIds();
  if (!mids.length) return 1;
  var homeTerr = STATIONS[sid].territory;
  var product = 1;

  for (var i = 0; i < mids.length; i++) {
    var mid = mids[i];
    // An unclaimed farm is fallow. A multiplier only projects while a real
    // power holds it -- otherwise every neutral farm on the board is feeding
    // its neighbours from turn one, capturing one gains you nothing you did
    // not already have, and the "hold a farm and watch the territories it
    // boosts light up" readout (00-vision.md §8) has nothing to show.
    if (!isRealPower(state.stations[mid].owner)) continue;

    var mTerr = STATIONS[mid].territory;
    var hops = territoryHops(mTerr)[homeTerr];
    if (hops === undefined || hops > BAL.MULTIPLIER_REACH) continue;

    var weight = controlWeight(territoryControl(state, mTerr).tier);
    // A farm with hostile troops standing in it projects at a reduced rate
    // rather than snapping to zero -- otherwise the map strobes during every
    // skirmish (BAL.MULTIPLIER_CONTESTED).
    if (typeof stationAttackers === 'function' && stationAttackers(state, mid).length) {
      weight *= BAL.MULTIPLIER_CONTESTED;
    }
    if (weight <= 0) continue;

    var bonus = (STATIONS[mid].multiplier - 1) * Math.pow(BAL.MULTIPLIER_FALLOFF, hops) * weight;
    product *= (1 + bonus);
  }

  return product > BAL.GROWTH_MUL_CAP ? BAL.GROWTH_MUL_CAP : product;
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

function _scaleUnits(units, f) {
  units.infantry *= f;
  units.artillery *= f;
  units.armour *= f;
}

// Which unit type a station's growth lands in. Producers make their own thing;
// everything else makes infantry (00-vision.md §4 -- infantry is the only
// thing holding stations produce).
function growthType(sid) {
  var d = STATIONS[sid];
  if (d.type === 'producer' && d.produces) return d.produces;
  return 'infantry';
}

function growthTick(state) {
  computeConnectivity(state);

  // BAL.GROWTH_CAP_EPSILON used to gate growth here, opening a dead band just
  // below capacity so the logistic asymptote could not leave a station
  // wobbling at 99.7% forever. The room floor solves that properly — growth
  // near full is now a real rate rather than a vanishing one — so the gate is
  // gone and the constant is no longer read by this file.

  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    var st = state.stations[sid];
    var d = STATIONS[sid];
    var units = st.units;

    var total = totalUnits(units);

    // A station with hostile forces standing in it is not recruiting. Skipping
    // growth here is also what keeps battle duration independent of army size
    // (known-issues #5): regrowth mid-battle would be an absolute term in an
    // otherwise scale-free system.
    var contested = (typeof stationAttackers === 'function') && stationAttackers(state, sid).length > 0;

    if (!contested) {
      if (st.connected === false) {
        // Cut off. No growth at all (DISCONNECT_GROWTH = 0, "a pocket must be
        // relieved, not waited out"), and decay once the grace period lapses.
        var since = (st.discSince === undefined || st.discSince < 0) ? state.tick : st.discSince;
        if (state.tick - since >= BAL.DISCONNECT_GRACE && total > 0) {
          _scaleUnits(units, 1 - BAL.DISCONNECT_DECAY);
          // Exponential decay asymptotes; sweep the dust so a pocket actually
          // dies rather than holding on with 1e-9 infantry. Deliberately only
          // here: sweeping every station every tick would also erase the
          // sub-epsilon GROWTH_SEED trickle that lets a scoured city recover,
          // which looks like "emptied stations never come back".
          if (units.infantry < BAL.ANNIHILATION_EPSILON) units.infantry = 0;
          if (units.artillery < BAL.ANNIHILATION_EPSILON) units.artillery = 0;
          if (units.armour < BAL.ANNIHILATION_EPSILON) units.armour = 0;
        }
        if (BAL.DISCONNECT_GROWTH > 0) {
          _applyGrowth(state, sid, st, d, total, BAL.DISCONNECT_GROWTH);
        }
      } else if (total > d.capacity * BAL.GROWTH_OVERFLOW_CEIL) {
        // Past the HARD ceiling — only reinforcement can put a station here,
        // since growth tapers to zero exactly at it. Bleed the excess back
        // down toward the ceiling, which is the highest number growth itself
        // is allowed to reach; bleeding toward `capacity` instead would leave
        // decay and growth pulling on the same units in opposite directions
        // for the whole band between the two.
        var excess = total - d.capacity * BAL.GROWTH_OVERFLOW_CEIL;
        _scaleUnits(units, (total - excess * BAL.OVERSTACK_DECAY) / total);
      } else {
        // Everything below the hard ceiling grows, including a station at or
        // over capacity. The rate is decided inside _applyGrowth by the room
        // factor, which no longer reaches zero at capacity — see the header
        // there and BAL.GROWTH_OVERFLOW_RATE.
        _applyGrowth(state, sid, st, d, total, 1);
      }
    }
  }

  // Recompute the published multiplier for next tick. Done after growth so the
  // value a caller reads (or sets) is the one that was actually used.
  for (var j = 0; j < STATION_IDS.length; j++) {
    state.stations[STATION_IDS[j]].growthMul = growthMultiplier(state, STATION_IDS[j]);
  }
}

// growth = GROWTH_BASE * rate * growthMul * capturePenalty * units * room(units)
//
// `units` is floored at GROWTH_SEED so a scoured station crawls back instead
// of being multiplicatively dead at exactly zero.
//
// `room` used to be the bare logistic term `(1 - units/capacity)`, which is
// zero at capacity — a full city produced nothing at all. It now has a FLOOR
// and a TAIL (BAL.GROWTH_OVERFLOW_RATE / _CEIL, 2026-07, on the player's
// instruction):
//
//     room = max(1 - units/cap, FLOOR)              below capacity
//     room = FLOOR * (1 - (units-cap)/(ceil-cap))   above it, to zero at ceil
//
// so growth falls as a city fills, stops falling at FLOOR, holds that rate
// across the capacity line, and only then tapers away. Monotonic the whole
// way: there is no point at which filling a city further makes it grow FASTER,
// which a naive "half rate once full" rule does produce — at capacity it would
// have been twice the half-full rate, exactly inverting the logistic feel.
//
// FLOOR is 0.25 * RATE, and the 0.25 is derived rather than tuned: the peak of
// `units * (1 - units/cap)` is `cap/4`, at half full. At `units = cap` the same
// growth therefore needs `room = RATE/4`. That is what makes "50%" mean 50% of
// this station's own best rate, which is the only reading a player can check
// against the number on the rail.
function _growthRoom(total, cap) {
  var rate = BAL.GROWTH_OVERFLOW_RATE;
  if (!(rate > 0)) {                       // OFF: the pre-2026-07 sim, exactly
    var bare = 1 - total / cap;
    return bare > 0 ? bare : 0;
  }

  var floor = 0.25 * rate;
  if (total <= cap) {
    var room = 1 - total / cap;
    return room > floor ? room : floor;
  }

  var span = cap * (BAL.GROWTH_OVERFLOW_CEIL - 1);
  if (!(span > 0)) return 0;               // CEIL 1 = no overflow band at all
  var tail = floor * (1 - (total - cap) / span);
  return tail > 0 ? tail : 0;
}

function _applyGrowth(state, sid, st, d, total, extraMul) {
  var cap = d.capacity;
  if (cap <= 0) return;

  var mul = (typeof st.growthMul === 'number' && isFinite(st.growthMul)) ? st.growthMul : 1;
  if (mul > BAL.GROWTH_MUL_CAP) mul = BAL.GROWTH_MUL_CAP;

  // Freshly captured stations recover slowly. Shipped at 1.0 = OFF; this is
  // wired so that turning the constant on is a one-line balance change
  // (00-vision.md §5, "the next lever").
  var capture = 1;
  if (typeof st.capturedTick === 'number' &&
      state.tick - st.capturedTick < BAL.CAPTURE_PENALTY_TICKS) {
    capture = BAL.CAPTURE_GROWTH_PENALTY;
  }

  var seed = total < BAL.GROWTH_SEED ? BAL.GROWTH_SEED : total;
  var g = BAL.GROWTH_BASE * d.rate * mul * capture * extraMul * seed * _growthRoom(total, cap);
  if (g <= 0) return;
  st.units[growthType(sid)] += g;
}
