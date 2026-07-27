// sim/movement.js — phase 2 of the tick.
//
// Waves march along links and resolve the moment they land. Two rules from the
// design carry most of the weight here:
//
//   * A wave moves at the speed of its SLOWEST type (00-vision.md §8), so a
//     mixed stack travels together and artillery drags a volley down.
//   * Stacks are NEVER synchronised. Nothing in this file waits for anything
//     else to arrive. Defeat in detail is the defining mistake of the game and
//     it only exists because arrivals stagger -- do not add an arrival queue.
//
// Arrival convention (01-data-schema.md): a wave is arrived when progress >= 1
// on its FINAL hop, and it is resolved on the tick it is seen, never deferred.
// Tests drive combat by pushing { progress: 1, path: [sid] } and calling
// stepTick once.
//
// path is the full route INCLUDING the origin: path[hop] -> path[hop+1] is the
// link currently being traversed, so a path of length 1 is already home.

'use strict';

// ---------------------------------------------------------------------------
// routeBetween — pure shortest path over LINKS by `dist`.
//
// Depends only on static data, so it is cached per source station. It must not
// read `state`: routing is a property of the map, and making it ownership-
// aware here would silently turn every send into a pathfinding decision the
// player cannot see.
// ---------------------------------------------------------------------------

var _linkDist = null;      // "a|b" -> { dist, sea }
var _routeCache = null;    // fromSid -> { prev: {}, dist: {} }

function resetRouteCache() {
  _linkDist = null;
  _routeCache = null;
}

function _linkKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

function linkIndex() {
  if (_linkDist) return _linkDist;
  _linkDist = {};
  var links = (typeof LINKS !== 'undefined' && LINKS) ? LINKS : [];
  for (var i = 0; i < links.length; i++) {
    var l = links[i];
    _linkDist[_linkKey(l.a, l.b)] = { dist: l.dist, sea: !!l.sea };
  }
  return _linkDist;
}

function linkBetween(a, b) {
  return linkIndex()[_linkKey(a, b)] || null;
}

// Dijkstra from one source over the whole graph. O(n^2) with a linear scan for
// the minimum -- ~110 stations, run once per source and cached, so a heap
// would be more code than it saves. Ties break on the lower station id, which
// is what makes the route deterministic.
function _dijkstra(from) {
  if (!_routeCache) _routeCache = {};
  if (_routeCache[from]) return _routeCache[from];

  var adj = stationAdjacency();
  var idx = linkIndex();
  var dist = {}, prev = {}, done = {};
  var i;
  for (i = 0; i < STATION_IDS.length; i++) dist[STATION_IDS[i]] = Infinity;
  dist[from] = 0;

  for (var n = 0; n < STATION_IDS.length; n++) {
    var best = null;
    for (i = 0; i < STATION_IDS.length; i++) {
      var sid = STATION_IDS[i];
      if (done[sid]) continue;
      if (best === null || dist[sid] < dist[best]) best = sid;
    }
    if (best === null || dist[best] === Infinity) break;
    done[best] = true;
    var nb = adj[best] || [];
    for (i = 0; i < nb.length; i++) {
      var to = nb[i];
      if (done[to]) continue;
      var l = idx[_linkKey(best, to)];
      var d = dist[best] + (l ? l.dist : 1);
      if (d < dist[to]) { dist[to] = d; prev[to] = best; }
    }
  }

  var out = { dist: dist, prev: prev };
  _routeCache[from] = out;
  return out;
}

// Array of station ids from `fromSid` to `toSid` inclusive, or null if there
// is no path. [sid] when from === to.
function routeBetween(fromSid, toSid) {
  if (typeof STATIONS === 'undefined' || !STATIONS[fromSid] || !STATIONS[toSid]) return null;
  if (fromSid === toSid) return [fromSid];
  var r = _dijkstra(fromSid);
  if (!isFinite(r.dist[toSid])) return null;
  var path = [toSid];
  var cur = toSid;
  while (cur !== fromSid) {
    cur = r.prev[cur];
    if (cur === undefined) return null;
    path.push(cur);
  }
  path.reverse();
  return path;
}

// ---------------------------------------------------------------------------
// Marching
// ---------------------------------------------------------------------------

function _presentTypes(units) {
  var out = [];
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    if (units[t] > BAL.ANNIHILATION_EPSILON) out.push(t);
  }
  return out;
}

// Map distance covered this tick, on the link the wave is currently on.
// Terrain is the terrain of the territory being ENTERED (data schema: terrain
// "modifies march time along links crossing into it").
function waveSpeed(w) {
  var from = w.path[w.hop], to = w.path[w.hop + 1];
  var types = _presentTypes(w.units);
  if (!types.length) return 0;

  var slowest = Infinity;
  for (var i = 0; i < types.length; i++) {
    var sp = BAL.UNITS[types[i]].speed;
    if (sp < slowest) slowest = sp;
  }

  var terr = terrainOf(to);
  var v = BAL.MOVE_BASE * slowest * terr.move;

  var l = linkBetween(from, to);
  if (l && l.sea) {
    v *= BAL.SEA_SPEED_MUL;
    if (w.units.artillery > BAL.ANNIHILATION_EPSILON) v *= BAL.SEA_ARTILLERY_SPEED_MUL;
  }
  return v;
}

function waveArrived(w) {
  return w.hop >= w.path.length - 2 && w.progress >= 1;
}

// A sea crossing costs guns outright rather than needing a transport model
// (data schema, LINKS). Charged once, as the hop completes.
function _chargeSeaCrossing(w, from, to) {
  var l = linkBetween(from, to);
  if (l && l.sea) w.units.artillery *= (1 - BAL.SEA_ARTILLERY_LOSS);
}

// Spend one tick of march time. The budget is kept in TICKS, not in map
// distance, because speed changes at every hop -- terrain is the terrain of the
// territory being entered and sea crossings have their own multipliers, so
// leftover distance from one link is worth a different amount on the next.
// Carrying the remainder rather than truncating at the hop is what stops long
// marches from quantising to the tick and drifting slow.
function _advanceWave(w) {
  var lastHop = w.path.length - 2;
  if (w.hop > lastHop) return;

  var timeLeft = 1;
  var guard = 0;
  while (timeLeft > 1e-12 && guard++ < 64) {
    var from = w.path[w.hop], to = w.path[w.hop + 1];
    var l = linkBetween(from, to);
    var d = (l && l.dist > 0) ? l.dist : 1;

    var v = waveSpeed(w);
    if (v <= 0) return;                                  // empty stack

    var need = ((1 - w.progress) * d) / v;               // ticks to finish this hop
    if (need > timeLeft) {
      w.progress += (timeLeft * v) / d;
      return;
    }

    timeLeft -= need;
    // The final hop's sea toll is charged by resolveArrival, so that a wave
    // pushed straight in as already-arrived pays it too. Charging here as well
    // would bill it twice.
    if (w.hop >= lastHop) { w.progress = 1; return; }    // arrived; caller resolves
    _chargeSeaCrossing(w, from, to);
    w.hop++;
    w.progress = 0;
  }
}

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

// Units landing on a station the owner already holds merge into the garrison.
// Anything else is deposited as an attacking stack and sim/combat.js takes it
// from there on this same tick.
function resolveArrival(state, w) {
  var sid = w.path[w.path.length - 1];
  var st = state.stations[sid];
  if (!st) return;

  if (w.path.length >= 2) {
    _chargeSeaCrossing(w, w.path[w.path.length - 2], sid);
  }
  if (totalUnits(w.units) <= BAL.ANNIHILATION_EPSILON) return;

  if (st.owner === w.owner) {
    addUnits(st.units, w.units);
    return;
  }

  if (!st.attackers) st.attackers = {};
  if (!st.attackers[w.owner]) st.attackers[w.owner] = emptyUnits();
  addUnits(st.attackers[w.owner], w.units);
}

function movementTick(state) {
  var kept = [];
  for (var i = 0; i < state.waves.length; i++) {
    var w = state.waves[i];

    // Seen already arrived (a test pushing progress: 1, or a zero-hop send):
    // resolve now, never next tick.
    if (waveArrived(w)) { resolveArrival(state, w); continue; }

    if (totalUnits(w.units) <= BAL.ANNIHILATION_EPSILON) continue;

    _advanceWave(w);

    if (waveArrived(w)) { resolveArrival(state, w); continue; }
    kept.push(w);
  }

  // Mutate the existing array rather than replacing it -- callers and tests
  // hold references to state.waves.
  state.waves.length = 0;
  for (var k = 0; k < kept.length; k++) state.waves.push(kept[k]);
}
