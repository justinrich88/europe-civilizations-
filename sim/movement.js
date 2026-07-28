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

// ---------------------------------------------------------------------------
// STANDING WAVES ARE NOT COMMITTED WAVES
//
// WAVE_REROUTE_ON_LOSS is false and that is right for a march: "a march is a
// committed one-shot decision" (00-vision.md §8), so a manual wave whose
// destination flipped keeps going and fights whoever is standing there.
//
// A standing-order wave is not a decision the player made about THIS march. It
// is logistics running unattended, and the rule above stops being a virtue the
// moment nobody chose it: _moveIntercepts halts a wave entering any station its
// owner does not hold, so a steady trickle walking into a city that just fell
// would be fed into that battle 12% of a garrison at a time — DEFEAT IN DETAIL,
// which §8 names as the defining mistake of the game. An automated mechanic
// must not commit that mistake on the player's behalf.
//
// So a standing wave STANDS DOWN instead: it stops at the last station on the
// path its owner still holds and merges into that garrison. Nothing is lost and
// nothing is committed — the units are simply back where automation is allowed
// to put them.
// ---------------------------------------------------------------------------

// The last station in path[0..upto] that this wave's owner still holds. Walked
// backwards from where the wave actually is, so it can never name a station the
// wave has not been to. null when the whole traversed prefix has been lost.
function _ordLastHeld(state, w, upto) {
  if (upto > w.path.length - 1) upto = w.path.length - 1;
  for (var i = upto; i >= 0; i--) {
    var st = state.stations[w.path[i]];
    if (st && st.owner === w.owner) return w.path[i];
  }
  return null;
}

// Halt a standing wave and put its units down. Returns true always; the caller
// stops touching the wave, which movementTick drops via `w.dead`.
//
// With no held station left in the prefix the wave is cut off behind ground
// that is no longer its owner's, and the units are DISSOLVED. That is a real
// cost and it is counted (orderStats.unitsLost) rather than hidden — but the
// alternatives are worse: marching on means fighting, which rule 1 forbids, and
// teleporting the stack to the nearest friendly city elsewhere on the map is a
// bigger lie than losing a trickle. It takes both ends of a link flipping while
// a stream is on it, so it is rare by construction; the counter is there so
// "rare" stays a measurement instead of an assumption.
function _ordStandDown(state, w, upto) {
  var sid = _ordLastHeld(state, w, upto);
  var stats = state.orderStats;
  if (stats) stats.standDowns++;
  if (sid) {
    _moveDeposit(state, sid, w.owner, w.units, true);
  } else if (stats) {
    stats.unitsLost += totalUnits(w.units);
  }
  w.units = emptyUnits();
  w.dead = true;
  return true;
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
      // A manual wave is intercepted and fights. A standing one stands down at
      // `from` — the station it is leaving, which is index w.hop on the path.
      if (w.standing) { _ordStandDown(state, w, w.hop); return; }
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
//
// `standing` marks units belonging to a STANDING-ORDER wave, and it is the last
// line of the rule that a standing order may never start a fight. Every path by
// which units reach the ground funnels through here — land arrival, beachhead
// echelon, interception, stand-down — and every one of them passes the flag, so
// this is the one place where "a standing wave never becomes an attacker" is
// structural rather than a property of four separate call sites all remembering
// to check. Passing it from the ORDINARY arrival path as well as from the
// stand-down path is what makes that true: with the flag only on the stand-down
// call, deleting the stand-down hooks would send standing waves down the normal
// arrival path and straight into station.attackers with the tripwire none the
// wiser — measured, and it is exactly what happened the first time. If it ever fires, the
// units are dissolved rather than committed and state.orderStats.fights says so
// out loud; a counter that is supposed to be permanently zero is worth more than
// a comment claiming it is.
function _moveDeposit(state, sid, owner, units, standing) {
  var st = state.stations[sid];
  if (!st) return;
  if (totalUnits(units) <= BAL.ANNIHILATION_EPSILON) return;

  if (st.owner === owner) {
    addUnits(st.units, units);
    return;
  }

  if (standing) {
    if (state.orderStats) {
      state.orderStats.fights++;
      state.orderStats.unitsLost += totalUnits(units);
    }
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

  // The destination flipped part-way through a standing landing: the rest of
  // the force turns around rather than wading into a battle nobody ordered. The
  // sea toll has already been charged on the whole crossing and the echelons
  // already ashore are already ashore — this is only about what is still at sea.
  if (w.standing && state.stations[sid].owner !== w.owner) {
    _ordStandDown(state, w, w.path.length - 2);
    return false;
  }

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
  _moveDeposit(state, sid, w.owner, go, w.standing);
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

  // The destination is no longer held by this wave's owner. A manual wave lands
  // and fights; a standing one turns back (see the STANDING WAVES block above).
  // Checked BEFORE the sea toll deliberately — a wave that stands down never
  // completes the crossing, so it must not be billed for one.
  if (w.standing && st.owner !== w.owner) {
    _ordStandDown(state, w, w.path.length - 2);
    return false;
  }

  // Charged here, once, for the whole landing — not per echelon. Charging it
  // before the landing record is built is what makes "exactly once" structural:
  // echelons run through _moveLandEchelon, which never touches the toll.
  if (w.path.length >= 2) {
    _chargeSeaCrossing(w, w.path[w.path.length - 2], sid);
  }
  if (totalUnits(w.units) <= BAL.ANNIHILATION_EPSILON) return false;

  if (!_moveIsSeaArrival(w)) {
    _moveDeposit(state, sid, w.owner, w.units, w.standing);
    return false;
  }

  _moveBeginLanding(w);
  return _moveLandEchelon(state, w);
}

function movementTick(state) {
  var kept = [];
  for (var i = 0; i < state.waves.length; i++) {
    var w = state.waves[i];

    // A wave that stood down has already put its units on the ground. Dropped
    // explicitly rather than left to fall out of the empty-stack check next
    // tick, so it never lingers a frame as a ghost marker on the map.
    if (w.dead) continue;

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

    if (w.dead) continue;                                // stood down mid-march
    if (waveArrived(w)) { if (resolveArrival(state, w)) kept.push(w); continue; }
    kept.push(w);
  }

  // Mutate the existing array rather than replacing it -- callers and tests
  // hold references to state.waves.
  state.waves.length = 0;
  for (var k = 0; k < kept.length; k++) state.waves.push(kept[k]);
}

// ---------------------------------------------------------------------------
// STANDING ORDERS — phase 2 of the tick, between growth and movement.
// (00-vision.md §8 as amended; data/tuning.js §11; 01-data-schema.md.)
//
// Three orders, one pipe with two ends and an off switch:
//
//   hold   default, and the off switch. Accumulate; never auto-send. Exactly
//          the behaviour the game had before this file grew this section, which
//          is why a board nobody has touched is byte-identical to today's.
//   rally  a SINK. Feed stations stream into the nearest one.
//   feed   a SOURCE. Ships a small share of its surplus, on a throttle, to the
//          nearest rally its owner can legally reach — or, if the player has set
//          no rally at all, to the nearest owned station ON THE FRONT.
//
// LOGISTICS CAN BE AUTOMATED; COMMITMENT CANNOT. Every target chosen here is a
// station the sending power already holds, every route is one routeFor() will
// walk over that power's own ground, and applyCommand refuses a standing send at
// anything else. The board still never plays itself: it only carries things.
//
// WHY IT LIVES IN sim/movement.js. It is one phase, ~150 lines, and every
// primitive it needs — the ownership-aware search, the link index, the wave — is
// already here. A separate sim/orders.js would also need a <script> tag in
// index.html, which is owned by the render workstream; a phase that silently
// does not load in the browser while passing every headless test is precisely
// the failure mode docs/testing/known-issues.md #9 and #16 are about.
//
// Helpers are prefixed _ord (by FILE and by feature, per known-issues #12).
// ---------------------------------------------------------------------------

// Owned stations that touch ground their owner does not hold.
//
// "The front" needs defining because with the capital-only opening most of the
// board is NEUTRAL, not enemy: 101 of 108 stations at turn zero. Defining the
// front as "adjacent to an ENEMY station" would leave it empty for most of a
// game and the no-rally fallback would never fire — the mechanic would exist and
// do nothing, which is known-issues #11's mistake in a new place.
//
// So the front is where your ground stops: adjacent to any station its owner
// does not hold, neutral or hostile alike. That is also the honest reading of
// the design — expansion against neutrals IS the early war (§6), a neutral
// border is exactly where you want mass, and it is the same test _moveCanTraverse
// uses to decide where a wave may walk, so "the front" and "the edge of the
// board you own" are one concept rather than two that can drift apart.
function _ordFront(state, pid, own) {
  var adj = stationAdjacency();
  var out = [];
  for (var i = 0; i < own.length; i++) {
    var nb = adj[own[i]] || [];
    for (var j = 0; j < nb.length; j++) {
      var st = state.stations[nb[j]];
      if (st && st.owner !== pid) { out.push(own[i]); break; }
    }
  }
  return out;                                  // sorted: `own` is sorted
}

// Multi-source Dijkstra from every seed at once, over ground `pid` holds.
// Returns { stationId: nearestSeedId } for every station the power can reach.
//
// One search per power per sweep, not one per feeding city: the seeds are the
// destinations, and shortest paths are symmetric here because passability is
// (both endpoints are owned by pid, and every intermediate must be). Choosing
// the destination is therefore O(n^2) once, and the per-source route each wave
// actually walks is computed by applyCommand -> routeFor as usual, so there is
// exactly one authority on the path.
//
// Ties break on the lower station id, twice over — the settle scan walks
// STATION_IDS in sorted order, and equal-distance seeds are compared by id — so
// two runs of one seed pick the same rally.
function _ordNearestSeed(state, pid, seeds) {
  var adj = stationAdjacency();
  var idx = linkIndex();
  var dist = {}, best = {}, done = {};
  var i, sid;

  for (i = 0; i < STATION_IDS.length; i++) dist[STATION_IDS[i]] = Infinity;
  for (i = 0; i < seeds.length; i++) { dist[seeds[i]] = 0; best[seeds[i]] = seeds[i]; }

  for (var n = 0; n < STATION_IDS.length; n++) {
    var cur = null;
    for (i = 0; i < STATION_IDS.length; i++) {
      sid = STATION_IDS[i];
      if (done[sid]) continue;
      if (cur === null || dist[sid] < dist[cur]) cur = sid;
    }
    if (cur === null || dist[cur] === Infinity) break;
    done[cur] = true;
    // Ground this power does not hold is never expanded from. Unlike
    // _moveSearch there is no "final station is exempt" case to preserve: both
    // ends of a standing send are stations the power holds, by construction.
    if (state.stations[cur].owner !== pid) continue;
    var nb = adj[cur] || [];
    for (i = 0; i < nb.length; i++) {
      var to = nb[i];
      if (done[to]) continue;
      var l = idx[_linkKey(cur, to)];
      var d = dist[cur] + (l ? l.dist : 1);
      if (d < dist[to] || (d === dist[to] && best[cur] < best[to])) {
        dist[to] = d;
        best[to] = best[cur];
      }
    }
  }
  return best;
}

// What fraction of its garrison a feeding station may ship right now.
//
// THE GARRISON FLOOR. A feed station never sends below KEEP_FLOOR x capacity,
// so it can still defend itself and the rear never empties. Applied to the
// SURPLUS rather than as a gate on the whole garrison, for the same reason
// ai/ai.js applies HOME_GARRISON_FLOOR that way: growth stops at
// GROWTH_CAP_EPSILON so a station is never quite full, and a literal "can this
// source afford the full fraction?" test would reject every station forever.
//
//     amount   = SEND_FRACTION x (units - KEEP_FLOOR x capacity)
//     fraction = amount / units
//
// so the floor is an asymptote the stream approaches and never crosses, and a
// station at or below it ships nothing at all.
function _ordAllowedFraction(state, sid) {
  var st = state.stations[sid];
  if (!st) return 0;
  var units = totalUnits(st.units);
  if (units <= 0) return 0;
  var cap = (typeof STATIONS !== 'undefined' && STATIONS[sid]) ? STATIONS[sid].capacity : units;
  var spare = units - BAL.ORDERS.KEEP_FLOOR * cap;
  if (spare <= 0) return 0;
  return (BAL.ORDERS.SEND_FRACTION * spare) / units;
}

// ---------------------------------------------------------------------------
// HEADROOM — a rally is a mustering point, not a warehouse.
//
// Capacity is a real ceiling everywhere else in this game. growthTick bleeds
// any station over it at OVERSTACK_DECAY, and 00-vision.md §2 is explicit that
// a full station has stopped paying dividends and should be spent. AUTOMATION
// MUST OBEY THE SAME CEILING THE PLAYER DOES.
//
// Shipped without this rule, and measured on a live board: 7 feed cities into
// one 28-capacity rally reached 208 units after 400 ticks and was still
// climbing. The equilibrium is where inflow meets the bleed —
//
//     SEND_FRACTION x surplus / INTERVAL  =  (units - capacity) x OVERSTACK_DECAY
//
// which for ~6.6 units per 25-tick sweep settles at u ~= 556 units in a
// 28-capacity city: a rally holding twenty times its capacity and DESTROYING
// 100% OF EVERYTHING FED TO IT, FOREVER. The mechanic was a net loss for the
// player, and it hid inside a rising empire total — the feeders drop off the
// logistic ceiling and regrow, so the books looked good while the units were
// being deleted on arrival. An automation convenience that loses you units is
// worse than no automation.
//
// Three rules, and they are the same rule from three angles:
//
//   1. A seed with no headroom is NOT A VALID DESTINATION this sweep, so a
//      further rally with room beats a nearer one without.
//   2. No seed has room -> the feed city is a no-op and keeps its units. Same
//      reasoning as the unreachable case: better in a growing city than in a
//      bleeding one.
//   3. A send is CLAMPED to the destination's remaining headroom, so a stream
//      never overshoots the ceiling it was just checked against.
//
// Rule 3 has to count what is already in the air or the last few sweeps all
// overshoot together, each correctly sized against a headroom the others are
// about to consume. In-flight waves are counted per DESTINATION, and the sweep
// carries its own running total so several feeders in ONE sweep cannot
// collectively bust the ceiling either.
// ---------------------------------------------------------------------------

// Units of `pid` already on their way to each station, keyed by destination.
//
// Counts EVERY wave the power has in the air, not only standing ones. A manual
// volley merging into a rally fills exactly the same capacity, and headroom is
// a fact about the destination rather than about who is sending — a stream that
// ignored the player's own reinforcements would overshoot for a reason the
// player could see coming and the automation could not.
//
// Read from w.to rather than the end of w.path: interception rewrites both, but
// a STANDING wave stands down instead of being intercepted, so for the waves
// this rule is sizing against the two are always the same station.
function _ordInbound(state, pid) {
  var out = {};
  for (var i = 0; i < state.waves.length; i++) {
    var w = state.waves[i];
    if (w.owner !== pid || w.dead) continue;
    out[w.to] = (out[w.to] || 0) + totalUnits(w.units);
  }
  return out;
}

// Room left at `sid` once everything already inbound has landed. Negative for a
// station that is already over its ceiling and bleeding.
//
// The ceiling is capacity x GROWTH_CAP_EPSILON — the level growth itself stops
// at (data/tuning.js §2) — not capacity flat. A rally filled by streams then
// sits exactly where a station that filled itself sits, rather than a fraction
// of a percent above it where OVERSTACK_DECAY nibbles forever. Half a percent
// of capacity, and it costs nothing.
//
// RESIDUAL, stated because it is real and small: a stream sized against today's
// headroom lands after a march, and the destination GROWS while it is in the
// air, so a rally can finish a few percent over. Measured on the front fixture:
// peak 1.04x capacity, decaying back under OVERSTACK_DECAY. That is growth's
// doing, not the send's — the SIZING invariant (units + inbound <= ceiling at
// every sweep) is exact and is asserted as such. Reserving for projected growth
// would mean a second copy of growthTick's logistic here, and two
// implementations of one formula is the drift known-issues #9 is about.
function _ordHeadroom(state, sid, inbound) {
  var st = state.stations[sid];
  if (!st) return 0;
  var cap = (typeof STATIONS !== 'undefined' && STATIONS[sid]) ? STATIONS[sid].capacity : 0;
  return cap * BAL.GROWTH_CAP_EPSILON - totalUnits(st.units) - (inbound[sid] || 0);
}

// A destination is only worth routing to if it can take a stream worth sending.
// Gated on MIN_SEND rather than on "> 0" so rules 1 and 3 agree: a rally with
// 0.3 units of room would otherwise be chosen as nearest and then produce
// nothing, while a rally with real room sat further away unused.
function _ordHasRoom(state, sid, inbound) {
  return _ordHeadroom(state, sid, inbound) >= BAL.ORDERS.MIN_SEND;
}

// Units that would leave `sid` on the next sweep, ignoring whether it has
// anywhere to PUT them. Pure.
//
// THIS IS THE SOURCE'S WILLINGNESS AND NOTHING MORE, and a readout that shows
// it is advertising a promise the sim may not keep. Measured on a live board:
// Berlin on `feed` reported "5.6 units next sweep" every frame for the whole
// game while its only rally sat at 28.5 / 28 and the headroom rule shipped
// exactly nothing, forever. A number that never happens, with nothing on screen
// saying why, is worse than no number at all.
//
// So this is kept — the willingness is a real quantity and the readout still
// quotes the FRACTION off it — but standingOrderNext() below is what a panel
// must show. See the block comment there.
function standingOrderSend(state, sid) {
  var st = state.stations[sid];
  if (!st || st.order !== 'feed') return 0;
  var amount = totalUnits(st.units) * _ordAllowedFraction(state, sid);
  return amount >= BAL.ORDERS.MIN_SEND ? amount : 0;
}

// ---------------------------------------------------------------------------
// ONE PLANNER, TWO CALLERS — the sweep and the readout.
//
// _ordPlanPower decides, for every feed station one power holds, what leaves on
// the next sweep and — when nothing does — WHY. It takes no decisions of its
// own: it is the body the sweep used to have, lifted out whole, and the sweep
// below is now nothing but "issue what the plan says".
//
// WHY IT IS ONE FUNCTION AND NOT TWO. The obvious alternative is a second copy
// of this arithmetic living in the renderer, and that is precisely the failure
// docs/testing/known-issues.md #9 is about: two implementations of one rule
// drift the first time the sim is tuned, and then the panel is confidently
// wrong. It is not enough for the readout to be *initially* correct; it has to
// be UNABLE to disagree. Sharing the planner makes agreement structural rather
// than a property of two files being edited together, and the exactness test in
// test/runner.js ("standingOrderNext predicts every sweep exactly") is what says
// so out loud.
//
// PURE. Nothing here mutates state — `inbound` is the planner's own scratch
// object, exactly as it was when it lived in the sweep. Safe to call every
// frame; the whole thing is one O(n^2) multi-source search plus a walk of the
// power's feed stations.
//
// ORDER MATTERS AND IS PRESERVED. `feeds` is built in STATION_IDS order and the
// running headroom total is spent down that list, so the third feeder in a
// sweep sees the room the first two just took. A planner that answered for one
// station in isolation would be right about the first feeder and wrong about
// every one after it, which is the same class of lie in a new place.
//
// BLOCKED REASONS. Machine-readable, and every one of them is reachable —
// test/runner.js constructs a fixture per reason:
//
//   no-order          not a feed station (hold, or a rally, which is a sink)
//   no-seed           no rally set AND no front to fall back to
//   destination-full  every seed is at its ceiling, or the one this city is
//                     aimed at has less room left than MIN_SEND after the
//                     feeders ahead of it in this sweep took theirs
//   unreachable       no route to any open seed over ground this power holds
//   already-there     this city IS the nearest seed (the no-rally fallback,
//                     where a front-line city is already where units are wanted)
//   at-keep-floor     at or below KEEP_FLOOR x capacity — never ships itself
//                     defenceless
//   below-min-send    surplus is real but under MIN_SEND; it ships once grown
//
// The reasons are checked in the sweep's own control-flow order, so the one
// reported is the one that actually stopped the send. That means a city both at
// its floor AND aimed at a full rally reports the rally: rule 2 returns before
// the floor is ever looked at. Matching the sweep beats picking the "nicer"
// message — the whole point is that this cannot say something the sweep does
// not do.
// ---------------------------------------------------------------------------

function _ordBlocked(target, why) {
  return { units: 0, target: target || null, blocked: why, fraction: 0 };
}

function _ordPlanPower(state, pid) {
  var own = [], feeds = [], rallies = [], i, sid, st;
  var out = { feeds: feeds, by: {} };

  for (i = 0; i < STATION_IDS.length; i++) {
    sid = STATION_IDS[i];
    st = state.stations[sid];
    if (!st || st.owner !== pid) continue;
    own.push(sid);
    if (st.order === 'feed') feeds.push(sid);
    else if (st.order === 'rally') rallies.push(sid);
  }
  if (!feeds.length) return out;

  // No rally set by the player: fall back to the front. Still their own ground.
  var seeds = rallies.length ? rallies : _ordFront(state, pid, own);
  if (!seeds.length) {
    for (i = 0; i < feeds.length; i++) out.by[feeds[i]] = _ordBlocked(null, 'no-seed');
    return out;
  }

  // RULE 1. A seed with no headroom is not a destination this sweep. Filtered
  // BEFORE the search, so the nearest-seed answer is the nearest seed that can
  // actually take the units — a further rally with room beats a nearer one
  // without, which is the whole point and cannot be done by rejecting after.
  var inbound = _ordInbound(state, pid);
  var open = [];
  for (i = 0; i < seeds.length; i++) {
    if (_ordHasRoom(state, seeds[i], inbound)) open.push(seeds[i]);
  }

  // RULE 2. Nowhere with room: every feed city is a no-op and keeps growing.
  //
  // The second search here is FOR THE READOUT ONLY and runs on the blocked path
  // exclusively, so the sweep pays for it only on sweeps that ship nothing. It
  // answers the question the player actually has — "which city is full?" — which
  // the shipping path cannot, because it has already discarded every seed
  // without room. "Nothing ships, Leipzig Works is full" tells you to spend that
  // stack or set another rally; "nothing ships" alone tells you nothing.
  if (!open.length) {
    var stuck = _ordNearestSeed(state, pid, seeds);
    for (i = 0; i < feeds.length; i++) {
      out.by[feeds[i]] = _ordBlocked(stuck[feeds[i]] || null, 'destination-full');
    }
    return out;
  }

  var nearest = _ordNearestSeed(state, pid, open);

  for (i = 0; i < feeds.length; i++) {
    var from = feeds[i];
    var to = nearest[from];
    // UNREACHABLE IS A NO-OP, NOT AN ERROR. Routing is ownership-aware and a
    // rally can be cut off by a capture between one sweep and the next; a feed
    // city with nowhere legal to ship simply keeps its units and grows.
    // `to === from` is the no-rally case where this station is itself on the
    // front — it is already where the units are wanted.
    if (!to) { out.by[from] = _ordBlocked(null, 'unreachable'); continue; }
    if (to === from) { out.by[from] = _ordBlocked(from, 'already-there'); continue; }

    var fraction = _ordAllowedFraction(state, from);
    if (fraction <= 0) { out.by[from] = _ordBlocked(to, 'at-keep-floor'); continue; }

    // RULE 3. Clamp to what the destination can still hold. `inbound` is
    // updated after every planned send below, so three feeders that each fit
    // on their own cannot collectively bust the ceiling inside one sweep.
    var have = totalUnits(state.stations[from].units);
    var room = _ordHeadroom(state, to, inbound);
    var want = have * fraction;
    var amount = want > room ? room : want;
    if (amount < BAL.ORDERS.MIN_SEND) {
      // Which of the two ends came up short is the whole message. If the
      // destination's remaining room is what cut the stream under the minimum
      // it is the rally that needs attention; otherwise the source is simply
      // not big enough yet and will ship as it grows.
      out.by[from] = _ordBlocked(to, room < want ? 'destination-full' : 'below-min-send');
      continue;
    }

    out.by[from] = { units: amount, target: to, blocked: null, fraction: amount / have };
    // Booked against the destination immediately: the next feeder in THIS sweep
    // must see the room this one just spent.
    inbound[to] = (inbound[to] || 0) + amount;
  }
  return out;
}

// WHAT ACTUALLY LEAVES `sid` ON THE NEXT SWEEP, and why it does not.
//
//   { units, target, blocked }
//
//   units    what would really be shipped, 0 whenever anything blocks it.
//   target   the station this city is AIMED at — kept even when blocked, so a
//            panel can name the rally that is full. null when there is none.
//   blocked  null when units > 0, otherwise one of the reasons listed above
//            _ordPlanPower.
//
// This, not standingOrderSend(), is the number a readout must show. The two
// differ exactly when the destination cannot take the stream, which is the case
// the player most needs told: a feed city pointed at a full rally is willing to
// ship 5.6 units and actually ships zero, and only this function knows that.
//
// PURE: no mutation of state, no command issued, no cache. Deliberately
// uncached — the plan depends on every garrison on the board, and a memo keyed
// on anything cheaper than that would go stale inside a tick, which is a subtler
// wrong answer than the one this function exists to fix.
//
// COST, MEASURED, because it decides how renderers may call it: ~80 microseconds
// on the live 108-station board (Chrome, warmed, mean of three 1000-call runs:
// 88.1 / 76.8 / 76.7us). standingOrderSend by comparison is 0.2us — the whole
// difference is _ordNearestSeed's O(n^2) search, and it is the price of the
// answer being the destination's as well as the source's.
//
// 80us is 0.5% of a 16.6ms frame, so ONE call per frame is free and a
// per-station loop is not — which is what standingOrderPlan() below exists for.
function standingOrderNext(state, sid) {
  var none = { units: 0, target: null, blocked: 'no-order' };
  if (!state || !state.stations || typeof BAL === 'undefined' || !BAL.ORDERS) return none;
  var st = state.stations[sid];
  if (!st || st.order !== 'feed') return none;
  // Neutral is never an actor and a dead power takes no sweeps — the same two
  // gates ordersTick applies, so this cannot describe a sweep that will not run.
  var pid = st.owner;
  if (!pid || pid === 'neutral') return none;
  var pow = state.powers && state.powers[pid];
  if (!pow || pow.alive === false) return none;

  var p = _ordPlanPower(state, pid).by[sid];
  if (!p) return none;
  return { units: p.units, target: p.target, blocked: p.blocked };
}

// THE SAME ANSWER FOR EVERY FEED CITY ONE POWER HOLDS, in one call:
// `{ sid: { units, target, blocked } }`, empty when the power feeds nowhere.
//
// Not a convenience. standingOrderNext() plans the whole power's sweep to answer
// about one station, so asking it about seven stations does the same 80us search
// seven times — 560us, which is 3% of a frame spent recomputing an identical
// answer, and it scales with how many cities the player has put on `feed`. Two
// renderers need the whole set at once (the empire header sums it; the map marks
// every blocked feeder), and this is what they call. Measured at the same ~80us
// as one standingOrderNext, for any number of feeders.
//
// It is the SAME planner, so there is still exactly one implementation and
// nothing here can disagree with the sweep. Fresh objects are returned rather
// than the planner's own records, so a caller cannot reach in and edit the
// plan the sweep would have used — the `fraction` field is the sweep's business.
function standingOrderPlan(state, pid) {
  var out = {};
  if (!state || !state.stations || typeof BAL === 'undefined' || !BAL.ORDERS) return out;
  if (!pid || pid === 'neutral') return out;
  var pow = state.powers && state.powers[pid];
  if (!pow || pow.alive === false) return out;

  var plan = _ordPlanPower(state, pid);
  for (var i = 0; i < plan.feeds.length; i++) {
    var sid = plan.feeds[i], p = plan.by[sid];
    if (!p) continue;
    out[sid] = { units: p.units, target: p.target, blocked: p.blocked };
  }
  return out;
}

// One power's sweep: issue what the plan says, and nothing else. Every decision
// above this line lives in _ordPlanPower, which is also what the readout reads.
// Returns the number of streams launched.
function _ordSweepPower(state, pid) {
  var plan = _ordPlanPower(state, pid);
  var sent = 0;

  for (var i = 0; i < plan.feeds.length; i++) {
    var from = plan.feeds[i];
    var p = plan.by[from];
    if (!p || p.blocked || !(p.units > 0)) continue;

    // Through applyCommand, exactly as the player and the AI do. Nothing here
    // builds a wave: if a volley would be illegal for them it is illegal here,
    // and `rejected` is this phase's feedback channel just as it is the AI's.
    //
    // The plan is sized so that none of applyCommand's rejections can fire:
    // the target is ground `pid` holds (every seed is), MIN_SEND (2.0) is above
    // MIN_SEND_UNITS (0.5), the route exists because _ordNearestSeed only walks
    // ground this power holds, and 0 < fraction <= 1 by construction. The guard
    // stays anyway — a plan that is silently not executed must not be counted.
    var res = applyCommand(state, {
      type: 'send',
      owner: pid,
      sources: [from],
      target: p.target,
      fraction: p.fraction,
      standing: true,
    });

    if (res && res.ok) {
      sent += res.waves.length;
      for (var k = 0; k < res.waves.length; k++) {
        if (state.orderStats) state.orderStats.unitsSent += totalUnits(res.waves[k].units);
      }
      if (state.orderStats) state.orderStats.sends += res.waves.length;
    }
  }
  return sent;
}

// The phase. AFTER growth, so a city ships units it actually has this tick;
// BEFORE movement, so a stream created this tick starts moving this tick rather
// than sitting still for one.
//
// THROTTLED, for the reason CAPITULATE_CHECK_INTERVAL is: this is a whole-board
// scan plus a search per power, nothing about it is time-critical, and running
// it every tick would be pure waste. See BAL.ORDERS.INTERVAL for how 25 was
// chosen against the other clocks.
function ordersTick(state) {
  if (!state || state.winner) return;
  if (typeof BAL === 'undefined' || !BAL.ORDERS) return;
  if (typeof applyCommand !== 'function') return;

  var iv = BAL.ORDERS.INTERVAL > 0 ? BAL.ORDERS.INTERVAL : 1;
  if (state.tick % iv !== 0) return;

  if (state.orderStats) state.orderStats.sweeps++;

  // POWER_IDS, always in sorted order: two runs of one seed must issue the same
  // commands in the same sequence or wave ids diverge and determinism is gone.
  for (var p = 0; p < POWER_IDS.length; p++) {
    var pid = POWER_IDS[p];
    if (pid === 'neutral') continue;                 // never an actor
    var pow = state.powers[pid];
    if (!pow || pow.alive === false) continue;
    _ordSweepPower(state, pid);
  }
}
