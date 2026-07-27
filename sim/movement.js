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
// One arrival in two flavours. A LAND final hop resolves instantly and the wave
// is gone; a SEA final hop begins a beachhead — resolution still starts on the
// tick it is seen, but the force comes ashore over BAL.LANDING_TICKS and the
// wave stays on state.waves until it is empty. See the Beachheads block below.
// This does not weaken the convention: a landing wave has already resolved, it
// is just not finished doing so.
//
// path is the full route INCLUDING the origin: path[hop] -> path[hop+1] is the
// link currently being traversed, so a path of length 1 is already home.

'use strict';

// ---------------------------------------------------------------------------
// Two routing functions, and the difference between them is load-bearing.
//
// routeBetween(from, to)          — GEOGRAPHY. Shortest path over LINKS by
//                                   `dist`, ignoring who holds what. Depends
//                                   only on static data, so it is cached per
//                                   source forever. This is the map's opinion:
//                                   the AI's distance heuristics and any test
//                                   that wants map-only distance read it.
//
// routeFor(state, pid, from, to)  — LEGALITY. The route a wave belonging to
//                                   `pid` may actually walk. A wave may pass
//                                   through stations `pid` owns and through
//                                   NEUTRAL stations. It may not pass through
//                                   a station held by any other power. The
//                                   FINAL station is exempt — walking into an
//                                   enemy station is the attack itself.
//
// This file used to route on geography alone, and the comment that stood here
// defended it: making routing ownership-aware "would silently turn every send
// into a pathfinding decision the player cannot see". That was true while
// routes were invisible. The preview now draws the route a send will take, so
// the decision is on screen before the commit and the objection is retired.
// What is left without the rule is worse: a wave marching through an enemy
// capital as though it were open road.
//
// KEYED ON OWNERSHIP, NOT ON WAR. A neutral station is passable; an enemy's is
// not, whether or not the two powers are formally at war. Relations drift
// every tick (sim/relations.js), so gating on war status would open and close
// corridors underneath the player as diplomacy wobbles — a route that changes
// for reasons off screen is worse than one that is merely strict. Ownership is
// drawn on the map, so the rule is readable straight off the board.
// ---------------------------------------------------------------------------

var _linkDist = null;      // "a|b" -> { dist, sea }
var _routeCache = null;    // fromSid -> { prev: {}, dist: {} }   (geography)

// Ownership-aware searches are invalidated by every capture, so they are cached
// against the board they were computed on: the state OBJECT (a Monte Carlo
// batch runs many games and they must not read each other's routes) and
// state.ownerEpoch (bumped by setStationOwner in core/state.js). Either moving
// drops the lot — a partial invalidation would have to know which sources a
// capture could possibly have affected, which is every source that could route
// past it, which is most of them.
var _ownRouteCache = null;   // pid -> fromSid -> { prev: {}, dist: {} }
var _ownRouteState = null;
var _ownRouteEpoch = -1;

function resetRouteCache() {
  _linkDist = null;
  _routeCache = null;
  _ownRouteCache = null;
  _ownRouteState = null;
  _ownRouteEpoch = -1;
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
//
// `canPass` is an optional predicate: a station that fails it may still be
// REACHED (it can be the end of a path) but is never expanded from, so it can
// never appear in the middle of one. That single asymmetry is the whole of the
// traversal rule -- "the final station is exempt" falls out of it rather than
// being special-cased at the end.
function _moveSearch(from, canPass) {
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
    // Settled but impassable: it is a legal END of a path and nothing more.
    // The source is always expanded — a wave standing on a station has already
    // left it, and applyCommand has separately checked the sender owns it.
    if (canPass && best !== from && !canPass(best)) continue;
    var nb = adj[best] || [];
    for (i = 0; i < nb.length; i++) {
      var to = nb[i];
      if (done[to]) continue;
      var l = idx[_linkKey(best, to)];
      var d = dist[best] + (l ? l.dist : 1);
      if (d < dist[to]) { dist[to] = d; prev[to] = best; }
    }
  }

  return { dist: dist, prev: prev };
}

function _dijkstra(from) {
  if (!_routeCache) _routeCache = {};
  if (_routeCache[from]) return _routeCache[from];
  var out = _moveSearch(from, null);
  _routeCache[from] = out;
  return out;
}

// May a wave belonging to `pid` march THROUGH this station? Own ground and
// neutral ground only. Not a war check — see the header.
// Ground a wave may march THROUGH: only ground its owner holds.
//
// Neutral used to count as passable, and while every power opened holding a
// whole homeland that was nearly harmless — most ground between two powers
// belonged to a power, and enemy ground has always intercepted. The
// capital-only opening changed the board underneath this rule: 101 of 108
// stations are neutral at turn zero, so "neutral is passable" meant the entire
// map was an open highway on turn one.
//
// Measured before the fix, seed 19140628, turn zero: Britain sent its opening
// 67-unit garrison from London and CAPTURED BERLIN, marching through Lille (6
// defenders), Cologne (9) and Leipzig (8) without fighting any of them. Every
// power could decapitate every other power on the first move.
//
// That also made the design's own words false. Expansion is supposed to be the
// entire game, and neutral cities are supposed to be fought down one at a time
// — neither is true if you can walk past them. Note the final station of a path
// is exempt by construction in _moveSearch: a station that fails this test can
// still be REACHED, it just cannot be expanded from. So attacking your
// neighbour always works; only marching through them does not.
function _moveCanTraverse(state, pid, sid) {
  var st = state.stations[sid];
  if (!st) return false;
  return st.owner === pid;
}

function _moveOwnSearch(state, pid, from) {
  if (_ownRouteState !== state || _ownRouteEpoch !== (state.ownerEpoch || 0)) {
    _ownRouteCache = {};
    _ownRouteState = state;
    _ownRouteEpoch = state.ownerEpoch || 0;
  }
  if (!_ownRouteCache[pid]) _ownRouteCache[pid] = {};
  var byFrom = _ownRouteCache[pid];
  if (byFrom[from]) return byFrom[from];
  var out = _moveSearch(from, function (sid) { return _moveCanTraverse(state, pid, sid); });
  byFrom[from] = out;
  return out;
}

function _moveWalkBack(r, fromSid, toSid) {
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

// Array of station ids from `fromSid` to `toSid` inclusive, or null if there
// is no path. [sid] when from === to. GEOGRAPHY ONLY — see the header.
function routeBetween(fromSid, toSid) {
  if (typeof STATIONS === 'undefined' || !STATIONS[fromSid] || !STATIONS[toSid]) return null;
  if (fromSid === toSid) return [fromSid];
  return _moveWalkBack(_dijkstra(fromSid), fromSid, toSid);
}

// The route a wave of `pid` may legally walk, or null when every path to the
// target runs through ground somebody else holds. Same shape and same tie-break
// as routeBetween; it is the passability rule that differs.
function routeFor(state, pid, fromSid, toSid) {
  if (!state || !state.stations) return routeBetween(fromSid, toSid);
  if (typeof STATIONS === 'undefined' || !STATIONS[fromSid] || !STATIONS[toSid]) return null;
  if (fromSid === toSid) return [fromSid];
  return _moveWalkBack(_moveOwnSearch(state, pid, fromSid), fromSid, toSid);
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

// A wave's path is fixed at send time, but ownership is not. If an enemy takes
// a station ON the path while the wave is in the air, letting the wave walk
// through it is the same bug as routing through it in the first place, just
// later. So an intermediate station in hostile hands INTERCEPTS: the wave stops
// there and resolves as an arrival at that station, fighting whoever holds it.
// Neutral intermediates never intercept.
//
// Implemented by truncating the path at the intercept point rather than by
// adding a second kind of arrival. That keeps ONE arrival convention -- "the
// wave is at path[path.length - 1]" -- so resolveArrival, waveArrived and the
// sea toll on the last traversed link all keep working unchanged, including for
// the tests that push { progress: 1, path: [sid] } straight onto state.waves.
// The enforcement half of _moveCanTraverse, and it must agree with it exactly.
// A wave that finds itself entering ground its owner does not hold stops there
// and fights, whether that ground is a rival's or neutral's. If routing and
// interception ever disagree, a wave either walks through a garrison it should
// have fought (the bug above) or halts on ground it was entitled to cross.
function _moveIntercepts(state, w, sid) {
  var st = state.stations[sid];
  if (!st) return false;
  return st.owner !== w.owner;
}

// Spend one tick of march time. The budget is kept in TICKS, not in map
// distance, because speed changes at every hop -- terrain is the terrain of the
// territory being entered and sea crossings have their own multipliers, so
// leftover distance from one link is worth a different amount on the next.
// Carrying the remainder rather than truncating at the hop is what stops long
// marches from quantising to the tick and drifting slow.
function _advanceWave(state, w) {
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

    // Interception is checked BEFORE the toll for exactly that reason: an
    // intercepted wave becomes an arrival on this link, and resolveArrival
    // will charge it.
    if (_moveIntercepts(state, w, to)) {
      w.path.length = w.hop + 2;                         // ..., from, to
      w.to = to;
      w.progress = 1;
      return;
    }

    _chargeSeaCrossing(w, from, to);
    w.hop++;
    w.progress = 0;
  }
}

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

// Put units on the ground at `sid`. Units landing on a station the owner
// already holds merge into the garrison. Anything else is deposited as an
// attacking stack and sim/combat.js takes it from there on this same tick.
//
// Split out of resolveArrival because a beachhead calls it ONCE PER ECHELON,
// and re-taking the merge-or-fight decision every time is exactly what makes
// the two mid-landing flip rules work without either being special-cased:
// a station that flips TO the landing power mid-landing absorbs the rest of the
// force as reinforcements (the same rule as WAVE_REROUTE_ON_LOSS: false), and a
// station that flips to a THIRD power keeps taking the echelons as attackers,
// because they are still hostile to whoever is standing there.
function _moveDeposit(state, sid, owner, units) {
  var st = state.stations[sid];
  if (!st) return;
  if (totalUnits(units) <= BAL.ANNIHILATION_EPSILON) return;

  if (st.owner === owner) {
    addUnits(st.units, units);
    return;
  }

  if (!st.attackers) st.attackers = {};
  if (!st.attackers[owner]) st.attackers[owner] = emptyUnits();
  addUnits(st.attackers[owner], units);
}

// ---------------------------------------------------------------------------
// Beachheads (02-visibility-and-sea.md §3b)
//
// A wave whose FINAL hop is a sea link does not arrive all at once. It comes
// ashore in echelons over BAL.LANDING_TICKS, committing a fixed fraction of its
// (post-toll) strength per tick. Units still at sea are not in the battle and
// cannot be hit — which needs no code at all, because they are simply not yet
// in station.attackers. Square-law combat then does the rest: a defended beach
// chews an amphibious force piecemeal, and the counters are to land where
// nobody is standing or to bring enough that even echelons overwhelm.
//
// A LAND final hop is untouched: arrival is instant, exactly as before. That
// asymmetry is the whole feature, so it is checked once, here, rather than
// being scattered through the arrival path.
// ---------------------------------------------------------------------------

function _moveIsSeaArrival(w) {
  if (w.path.length < 2) return false;
  var l = linkBetween(w.path[w.path.length - 2], w.path[w.path.length - 1]);
  return !!(l && l.sea);
}

// The at-sea remainder lives in w.units, as it always has — nothing else in the
// sim needs to learn a new place to look for a wave's strength. w.landing is
// the bookkeeping a renderer needs on top of that:
//
//   ashore  units already committed to the beach
//   total   strength at the moment the landing began, AFTER the sea toll
//   per     units of each type committed per tick (total / LANDING_TICKS,
//           split by the force's original composition, so a mixed stack lands
//           mixed rather than landing its infantry first)
//
// Fixing `per` at the start rather than recomputing it from the remainder is
// what makes the echelon a constant fraction of ORIGINAL strength; recomputing
// would give an exponential decay that never finishes.
function _moveBeginLanding(w) {
  var per = emptyUnits();
  var n = BAL.LANDING_TICKS > 1 ? BAL.LANDING_TICKS : 1;
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    per[t] = w.units[t] / n;
  }
  w.landing = { ashore: 0, total: totalUnits(w.units), per: per };
}

// Commit one echelon. Returns true while units are still at sea, i.e. while the
// wave must stay on state.waves.
function _moveLandEchelon(state, w) {
  var sid = w.path[w.path.length - 1];
  if (!state.stations[sid]) return false;

  var L = w.landing;
  var atSea = totalUnits(w.units);
  if (atSea <= BAL.ANNIHILATION_EPSILON) return false;

  // Flush the remainder on the final echelon rather than trickling a residue
  // forever: once one more echelon would leave behind less than the smallest
  // stack a player is allowed to send, the rest comes ashore now. Same
  // reasoning as BAL.MIN_SEND_UNITS, and the same threshold.
  var share = L.total / (BAL.LANDING_TICKS > 1 ? BAL.LANDING_TICKS : 1);
  var last = (atSea - share) <= BAL.MIN_SEND_UNITS;

  var go = emptyUnits();
  for (var i = 0; i < BAL.UNIT_ORDER.length; i++) {
    var t = BAL.UNIT_ORDER[i];
    var take = last ? w.units[t] : Math.min(w.units[t], L.per[t]);
    if (!(take > 0)) take = 0;
    go[t] = take;
    w.units[t] -= take;
  }

  L.ashore += totalUnits(go);
  _moveDeposit(state, sid, w.owner, go);
  return !last && totalUnits(w.units) > BAL.ANNIHILATION_EPSILON;
}

// The station a wave arrives at is ALWAYS the last entry in its path — that is
// the one invariant this function has, and _advanceWave keeps it true for an
// intercepted wave by shortening the path rather than by arriving somewhere
// else. w.to is the wave's stated destination and may lag; do not read it here.
//
// A truncated path therefore gets beachheads for free: if interception cut the
// wave short on the far side of a sea link, path[len-2] -> path[len-1] IS that
// sea link and the landing rules apply, which is the behaviour we want — being
// intercepted on the beach is not a reason to arrive all at once.
//
// Returns true when the wave is NOT finished with (a landing still in progress)
// and must be kept on state.waves. Land arrivals always return false.
function resolveArrival(state, w) {
  var sid = w.path[w.path.length - 1];
  var st = state.stations[sid];
  if (!st) return false;

  // Charged here, once, for the whole landing — not per echelon. Charging it
  // before the landing record is built is what makes "exactly once" structural:
  // echelons run through _moveLandEchelon, which never touches the toll.
  if (w.path.length >= 2) {
    _chargeSeaCrossing(w, w.path[w.path.length - 2], sid);
  }
  if (totalUnits(w.units) <= BAL.ANNIHILATION_EPSILON) return false;

  if (!_moveIsSeaArrival(w)) {
    _moveDeposit(state, sid, w.owner, w.units);
    return false;
  }

  _moveBeginLanding(w);
  return _moveLandEchelon(state, w);
}

function movementTick(state) {
  var kept = [];
  for (var i = 0; i < state.waves.length; i++) {
    var w = state.waves[i];

    // Already coming ashore: no marching, no second sea toll, just the next
    // echelon. Checked first so a landing wave can never re-enter the arrival
    // path, which is what would bill the crossing twice.
    if (w.landing) {
      if (_moveLandEchelon(state, w)) kept.push(w);
      continue;
    }

    // Seen already arrived (a test pushing progress: 1, or a zero-hop send):
    // resolve now, never next tick.
    if (waveArrived(w)) { if (resolveArrival(state, w)) kept.push(w); continue; }

    if (totalUnits(w.units) <= BAL.ANNIHILATION_EPSILON) continue;

    _advanceWave(state, w);

    if (waveArrived(w)) { if (resolveArrival(state, w)) kept.push(w); continue; }
    kept.push(w);
  }

  // Mutate the existing array rather than replacing it -- callers and tests
  // hold references to state.waves.
  state.waves.length = 0;
  for (var k = 0; k < kept.length; k++) state.waves.push(kept[k]);
}
