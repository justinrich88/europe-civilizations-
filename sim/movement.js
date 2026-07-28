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
// ONE MECHANIC AND NO VERB. A city carries `supplyTo`: a sorted list of the
// cities it streams surplus to. An empty list is the default and the off
// switch, which is why a board nobody has touched is byte-identical to one
// built before this section existed.
//
// Every sweep, a source works out what it may spare (SEND_FRACTION of its
// surplus above the keep floor), SPLITS THAT EVENLY across the destinations
// that still have room, and ships one stream to each.
//
// THE DESIGN ARRIVED HERE BY DELETING THINGS, and the deletions are the point.
//
//   v1  hold / rally / feed. The player labelled the two ENDS and the sim
//       matched them up by nearest-seed search, with a fallback to "the nearest
//       owned station on the front" when no rally was set. A feeder aimed at the
//       wrong rally looked exactly like one aimed at the right rally.
//   v2  hold / reinforce / defend, each naming its destination. The naming was
//       right and survives. `defend` did not: it fired only when the sim judged
//       the target "threatened", off a rule that was nowhere on the board — the
//       same invisible guess in a new place. It was also redundant against the
//       capacity ceiling below, which already makes a quiet front stop pulling.
//   v3  this. A list of edges. Nothing left to guess, and one city can supply
//       several, which one-target-per-source made impossible.
//
// LOGISTICS CAN BE AUTOMATED; COMMITMENT CANNOT. Every destination here is a
// station the sending power already holds, every route is one routeFor() will
// walk over that power's own ground, and applyCommand refuses a standing send at
// anything else. The board still never plays itself: it only carries things.
//
// WHY IT LIVES IN sim/movement.js. It is one phase and every primitive it needs
// — the ownership-aware search, the link index, the wave — is already here. A
// separate sim/orders.js would also need a <script> tag in index.html, which is
// owned by the render workstream; a phase that silently does not load in the
// browser while passing every headless test is precisely the failure mode
// docs/testing/known-issues.md #9 and #16 are about.
//
// Helpers are prefixed _ord (by FILE and by feature, per known-issues #12).
// ---------------------------------------------------------------------------

// What fraction of its garrison a source may ship in TOTAL this sweep, across
// all of its destinations together.
//
// THE GARRISON FLOOR. A source never sends below KEEP_FLOOR x capacity, so it
// can still defend itself and the rear never empties. Applied to the SURPLUS
// rather than as a gate on the whole garrison, for the same reason ai/ai.js
// applies HOME_GARRISON_FLOOR that way: growth tapers rather than stopping, so a
// station is never quite full, and a literal "can this source afford the full
// fraction?" test would reject every station forever.
//
//     amount   = SEND_FRACTION x (units - KEEP_FLOOR x capacity)
//     fraction = amount / units
//
// so the floor is an asymptote the stream approaches and never crosses, and a
// station at or below it ships nothing at all.
//
// PER SOURCE, NOT PER EDGE. A city with four supply lines ships the same total
// as one with a single line, divided four ways — adding a destination spreads
// the stream, it does not multiply it. The alternative (this fraction per edge)
// would make the keep floor meaningless the moment a player drew a second line
// out of a city, which is the shape of bug the floor exists to prevent.
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
// HEADROOM — a destination is a mustering point, not a warehouse.
//
// Capacity is a real ceiling everywhere else in this game. growthTick bleeds
// any station over it at OVERSTACK_DECAY, and 00-vision.md §2 is explicit that
// a full station has stopped paying dividends and should be spent. AUTOMATION
// MUST OBEY THE SAME CEILING THE PLAYER DOES.
//
// Shipped without this rule, and measured on a live board: 7 source cities into
// one 28-capacity destination reached 208 units after 400 ticks and was still
// climbing. The equilibrium is where inflow meets the bleed —
//
//     SEND_FRACTION x surplus / INTERVAL  =  (units - capacity) x OVERSTACK_DECAY
//
// which for ~6.6 units per 25-tick sweep settles at u ~= 556 units in a
// 28-capacity city: a destination holding twenty times its capacity and
// DESTROYING 100% OF EVERYTHING FED TO IT, FOREVER. The mechanic was a net loss
// for the player, and it hid inside a rising empire total — the sources drop off
// the logistic ceiling and regrow, so the books looked good while the units were
// being deleted on arrival. An automation convenience that loses you units is
// worse than no automation.
//
// It is also the reason there is no `defend` order. A front that is quiet is
// full, so it takes nothing and its sources bank their surplus at home by
// themselves; a front that is losing units has headroom and pulls. The ceiling
// already IS the trigger, expressed as a fact about the board rather than as a
// judgement the sim makes off screen.
//
// Two rules, and they are the same rule from two angles:
//
//   1. A destination with no room is SKIPPED for this sweep and its share is
//      redistributed across the source's other destinations. Better in a
//      growing city, or in a sibling that can use it, than in a bleeding one.
//   2. A send is CLAMPED to the destination's remaining headroom, so a stream
//      never overshoots the ceiling it was just checked against.
//
// Rule 2 has to count what is already in the air or the last few sweeps all
// overshoot together, each correctly sized against a headroom the others are
// about to consume. In-flight waves are counted per DESTINATION, and the sweep
// carries its own running total so several sources in ONE sweep — or several
// edges out of one source — cannot collectively bust the ceiling either.
// ---------------------------------------------------------------------------

// Units of `pid` already on their way to each station, keyed by destination.
//
// Counts EVERY wave the power has in the air, not only standing ones. A manual
// volley merging into the destination fills exactly the same capacity, and
// headroom is a fact about the far end rather than about who is sending — a
// stream that ignored the player's own reinforcements would overshoot for a
// reason the player could see coming and the automation could not.
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

// THE CEILING AUTOMATION OBEYS: the level growth itself stops at, and above
// which OVERSTACK_DECAY starts bleeding. A destination filled by streams then
// sits exactly where a station that filled itself sits, rather than somewhere
// decay nibbles forever.
//
// NOT `capacity` FLAT, and not a constant this file picks. It is whatever
// sim/growth.js currently treats as full, and that has now moved once: it used
// to be capacity x GROWTH_CAP_EPSILON, and since the over-capacity rework
// (data/tuning.js §2, 2026-07 — "rather than making production stop when a city
// is full, just slow the production speed by 50%") it is capacity x
// GROWTH_OVERFLOW_CEIL. Reading the wrong one is not a rounding error: with the
// old constant, every destination that grew past 99.5% of capacity — which is
// now normal rather than the asymptote — would report negative headroom and
// silently refuse every stream aimed at it, forever.
//
// So it is read by INTENT with a fallback, rather than by naming one constant.
// The fallback is what lets this file run against a tuning.js from before the
// rework; the ordering is what makes it track the rework after it.
function _ordCeilingMul() {
  if (typeof BAL === 'undefined') return 1;
  if (isFinite(BAL.GROWTH_OVERFLOW_CEIL) && BAL.GROWTH_OVERFLOW_CEIL > 0) {
    return BAL.GROWTH_OVERFLOW_CEIL;
  }
  return isFinite(BAL.GROWTH_CAP_EPSILON) ? BAL.GROWTH_CAP_EPSILON : 1;
}

// Room left at `sid` once everything already inbound has landed. Negative for a
// station that is already over its ceiling and bleeding.
//
// RESIDUAL, stated because it is real and small: a stream sized against today's
// headroom lands after a march, and the destination GROWS while it is in the
// air, so it can finish a few percent over. Measured on the front fixture: peak
// 1.04x capacity, decaying back under OVERSTACK_DECAY. That is growth's doing,
// not the send's — the SIZING invariant (units + inbound <= ceiling at every
// sweep) is exact and is asserted as such. Reserving for projected growth would
// mean a second copy of growthTick's logistic here, and two implementations of
// one formula is the drift known-issues #9 is about.
function _ordHeadroom(state, sid, inbound) {
  var st = state.stations[sid];
  if (!st) return 0;
  var cap = (typeof STATIONS !== 'undefined' && STATIONS[sid]) ? STATIONS[sid].capacity : 0;
  return cap * _ordCeilingMul() - totalUnits(st.units) - (inbound[sid] || 0);
}

// Units that would leave `sid` on the next sweep, ignoring whether anywhere it
// supplies can take them. Pure.
//
// THIS IS THE SOURCE'S WILLINGNESS AND NOTHING MORE, and a readout that shows
// it is advertising a promise the sim may not keep. Measured on a live board:
// Berlin reported "5.6 units next sweep" every frame for the whole game while
// its destination sat at 28.5 / 28 and the headroom rule shipped exactly
// nothing, forever. A number that never happens, with nothing on screen saying
// why, is worse than no number at all.
//
// So this is kept — the willingness is a real quantity, it is what "held back
// per sweep" means, and the readout still quotes the FRACTION off it — but
// standingOrderNext() below is what a panel must show. See the block comment
// there, and known-issues #18.
function standingOrderSend(state, sid) {
  var st = state.stations[sid];
  if (!st || !st.supplyTo || !st.supplyTo.length) return 0;
  var amount = totalUnits(st.units) * _ordAllowedFraction(state, sid);
  return amount >= BAL.ORDERS.MIN_SEND ? amount : 0;
}

// ---------------------------------------------------------------------------
// A LOST DESTINATION DROPS THAT EDGE — and only that edge.
//
// A supply line pointing at a city its owner no longer holds is not a weaker
// line; it is an ATTACK ORDER the player scheduled and forgot, and it must never
// become one. Three separate things stop it, and only the third is bookkeeping:
//
//   * _ordPlanPower refuses to plan a send at a destination this power does not
//     hold ('target-lost'), so nothing is ever issued.
//   * applyCommand refuses a standing send at unheld ground outright
//     ('standing-target-not-owned'), so nothing could be issued even if it were.
//   * ...and then this drops the edge, so the board stops drawing a pipe that
//     has no far end.
//
// PER EDGE, NOT PER STATION. A city supplying three others that loses one of
// them keeps the other two. Clearing the whole list would silently cancel work
// the player did, on news they may not even have seen yet.
//
// WHY THE SWEEP AND NOT setStationOwner. Doing it at the moment of capture would
// make "a supply line never points at foreign ground" a hard state invariant,
// which is genuinely attractive — but it costs a scan of every station on every
// capture, in the middle of combat, to catch a case that has no safety
// consequence (the two refusals above already have it covered). It would also
// make 'target-lost' an unreachable state, and therefore a blocked reason no
// fixture could construct — which this suite deletes rather than keeps, so the
// player would lose the one sentence that explains a line disappearing.
//
// The gap is bounded by one sweep (BAL.ORDERS.INTERVAL, 25 ticks = 2.5
// sim-seconds) and it is not a silent gap: for its whole length the planner
// reports the edge as target-lost and the map draws that pipe as closed.
// Cleared BEFORE the plan is taken, so the sweep that drops an edge is also the
// first sweep that does not act on it.
// ---------------------------------------------------------------------------
function _ordClearLost(state, pid) {
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    var st = state.stations[sid];
    if (!st || st.owner !== pid) continue;
    var list = st.supplyTo;
    if (!list || !list.length) continue;

    var keep = null;
    for (var j = 0; j < list.length; j++) {
      var to = state.stations[list[j]];
      var live = !!(to && to.owner === pid);
      // Allocated only when something is actually dropped, so the common case —
      // nothing lost, which is every sweep of a quiet board — allocates nothing
      // and writes nothing.
      if (!live && !keep) keep = list.slice(0, j);
      else if (keep && live) keep.push(list[j]);
    }
    if (!keep) continue;

    // Through core's setter, never by writing the field here: it is the one
    // place the list is validated, deduped and sorted.
    if (typeof setStationSupply === 'function') setStationSupply(state, sid, keep);
    else st.supplyTo = keep;
  }
}

// ---------------------------------------------------------------------------
// ONE PLANNER, TWO CALLERS — the sweep and the readout.
//
// _ordPlanPower decides, for every supplying station one power holds, what
// leaves on the next sweep, DOWN WHICH LINE, and — when nothing does — WHY. It
// takes no decisions of its own beyond that: the sweep below is nothing but
// "issue what the plan says".
//
// WHY IT IS ONE FUNCTION AND NOT TWO. The obvious alternative is a second copy
// of this arithmetic living in the renderer, and that is precisely the failure
// docs/testing/known-issues.md #18 is about: the rail advertised "6.4 units next
// sweep" every frame of a game in which orderStats.sends stayed at 0 forever,
// because the panel and the sweep were answering slightly different questions.
// It is not enough for the readout to be *initially* correct; it has to be
// UNABLE to disagree. Sharing the planner makes agreement structural rather
// than a property of two files being edited together, and the exactness test in
// test/runner.js ("standingOrderNext predicts every sweep exactly") is what says
// so out loud.
//
// PURE. Nothing here mutates state — `inbound` is the planner's own scratch
// object. Safe to call every frame.
//
// ORDER MATTERS AND IS PRESERVED, twice over. `sources` is built in STATION_IDS
// order and each source's `supplyTo` is already sorted, so the running headroom
// total is spent down one fixed sequence: the third source aimed at a city sees
// the room the first two just took, and the second edge out of one source sees
// what the first edge spent. A planner that answered for one station in
// isolation would be right about the first and wrong about every one after it.
//
// THE EVEN SPLIT, and why it is even. A source's allowed outflow is divided
// equally between the destinations that currently have room; a destination with
// no room is skipped and its share goes to the others. "Neediest first" was the
// obvious alternative and it is the whole trap this design keeps walking into —
// it is another rule the sim applies off screen, where a wrong ranking looks
// identical to a right one. An even split is a thing the player can state and
// check. Skipping a full destination is not a judgement; it is the ceiling.
//
// NOT REDISTRIBUTED: the remainder when a share is CLAMPED to a destination
// that has some room but less than its share. One pass, no iteration to a fixed
// point. It is a real underspend, it is bounded by one sweep, and the next sweep
// 25 ticks later re-divides against the new numbers — buying exactness here
// would cost a loop whose termination is a thing somebody would have to reason
// about every time this file is touched.
//
// BLOCKED REASONS. Machine-readable, and every one of them is reachable —
// test/runner.js constructs a fixture per reason:
//
//   no-order          this city supplies nowhere. `supplyTo` is empty
//   target-lost       this destination is no longer held by this power. The
//                     edge is dropped by the next sweep; see _ordClearLost
//   unreachable       no route to it over ground this power holds
//   at-keep-floor     the SOURCE is at or below KEEP_FLOOR x capacity, so it
//                     ships nothing anywhere — never itself defenceless
//   destination-full  this destination has less room than the share aimed at
//                     it, possibly because earlier edges took it this sweep
//   below-min-send    the share is real but under MIN_SEND. A source splitting
//                     its surplus four ways reaches this long before a source
//                     with one line does, which is the cost of a wide network
//                     and is worth saying out loud
//
// The reasons are checked in the sweep's own control-flow order, so the one
// reported is the one that actually stopped the send.
// ---------------------------------------------------------------------------

function _ordBlocked(target, why) {
  return { target: target, units: 0, fraction: 0, blocked: why };
}

// A source's whole answer: `{ units, edges, blocked, target }`.
//
//   units    total leaving this city on the next sweep, summed over its edges
//   edges    one record per destination, in sorted destination order, each
//            { target, units, fraction, blocked }
//   blocked  null when units > 0; otherwise the reason the FIRST edge gives, or
//            'no-order' when there are no edges at all
//   target   the destination `blocked` is about, so a panel with room for one
//            line can still name a city. null when there are no edges
//
// `blocked`/`target` are the summary a small readout needs; `edges` is the
// truth. They cannot disagree, because the summary is derived from the edges
// here rather than computed alongside them.
function _ordSummarise(edges) {
  var units = 0;
  for (var i = 0; i < edges.length; i++) units += edges[i].units;
  if (!edges.length) return { units: 0, edges: edges, blocked: 'no-order', target: null };
  if (units > 0) return { units: units, edges: edges, blocked: null, target: null };
  return { units: 0, edges: edges, blocked: edges[0].blocked, target: edges[0].target };
}

function _ordPlanPower(state, pid) {
  var sources = [], i, j, sid, st;
  var out = { sources: sources, by: {} };

  for (i = 0; i < STATION_IDS.length; i++) {
    sid = STATION_IDS[i];
    st = state.stations[sid];
    if (!st || st.owner !== pid) continue;
    if (st.supplyTo && st.supplyTo.length) sources.push(sid);
  }
  if (!sources.length) return out;

  var inbound = _ordInbound(state, pid);

  for (i = 0; i < sources.length; i++) {
    var from = sources[i];
    st = state.stations[from];
    var list = st.supplyTo;
    var edges = [];

    // Pass 1 — which edges are live, and how many of them can take units. Every
    // edge gets a record either way: a blocked destination is information the
    // player needs, and dropping it here would leave the map unable to draw the
    // difference between a closed pipe and no pipe.
    var live = [], open = 0;
    for (j = 0; j < list.length; j++) {
      var to = list[j];
      var dst = state.stations[to];
      if (!dst || dst.owner !== pid) { edges.push(_ordBlocked(to, 'target-lost')); live.push(null); continue; }
      // UNREACHABLE IS A NO-OP, NOT AN ERROR. Routing is ownership-aware and a
      // corridor can be cut by a capture between one sweep and the next.
      // routeFor is the same function applyCommand will use to build the wave,
      // and it is cached against state.ownerEpoch, so asking it here costs
      // nothing the send was not going to pay anyway — and there is exactly one
      // authority on whether a path exists rather than a cheaper approximation
      // that can disagree with it.
      if (!routeFor(state, pid, from, to)) { edges.push(_ordBlocked(to, 'unreachable')); live.push(null); continue; }
      edges.push(null);
      live.push(to);
      if (_ordHeadroom(state, to, inbound) >= BAL.ORDERS.MIN_SEND) open++;
    }

    // The source-wide gate. Checked after pass 1 rather than before it so the
    // edge-level reasons above are still computed and drawn: a city sitting at
    // its keep floor still wants to show which of its lines are cut.
    var fraction = _ordAllowedFraction(state, from);
    var have = totalUnits(st.units);
    var share = (open > 0 && fraction > 0) ? (have * fraction) / open : 0;

    // `factor` is the fraction of the ORIGINAL garrison still standing here as
    // each successive edge is issued. Two edges out of one city are two separate
    // applyCommand calls in the same sweep, and the second one is sized against
    // what the first one left behind — so the plan has to model that shrinkage
    // or it over-promises on every edge after the first. splitUnits scales all
    // three unit types by one factor, so a single scalar is exact here.
    var factor = 1;

    for (j = 0; j < list.length; j++) {
      if (edges[j]) continue;                       // already blocked in pass 1
      var t = live[j];
      if (fraction <= 0) { edges[j] = _ordBlocked(t, 'at-keep-floor'); continue; }

      var room = _ordHeadroom(state, t, inbound);
      if (room < BAL.ORDERS.MIN_SEND) { edges[j] = _ordBlocked(t, 'destination-full'); continue; }

      var cur = splitUnits(st.units, factor);
      var curTotal = totalUnits(cur);
      if (!(curTotal > 0)) { edges[j] = _ordBlocked(t, 'at-keep-floor'); continue; }

      var want = share > room ? room : share;
      var f = want / curTotal;
      if (f > 1) f = 1;

      // WHAT APPLYCOMMAND WILL ACTUALLY HAND OVER for that fraction, not what
      // the arithmetic above asked for. sendPayload holds BAL.SEND_KEEP_UNITS
      // back off the top of every send so a city can never be emptied to exactly
      // zero (logistic growth is proportional to `units`, so a zeroed city is
      // dead ground forever). The keep floor is normally the binding constraint
      // and this changes nothing — but "normally" is how known-issues #18
      // happened: two expressions that agreed until one of them was tuned.
      // Asking the command layer's own function makes agreement structural.
      var amount = (typeof sendPayload === 'function')
        ? totalUnits(sendPayload(cur, f))
        : curTotal * f;

      if (amount < BAL.ORDERS.MIN_SEND) {
        // Which end came up short is the whole message. If the destination's
        // remaining room is what cut the stream under the minimum it is the
        // destination that needs attention; otherwise the source is simply not
        // big enough yet — for this many lines — and will ship as it grows.
        edges[j] = _ordBlocked(t, room < share ? 'destination-full' : 'below-min-send');
        continue;
      }

      edges[j] = { target: t, units: amount, fraction: f, blocked: null };
      // Booked immediately, against both ends: the next edge must see the room
      // this one just spent AND the units it just took out of this city.
      inbound[t] = (inbound[t] || 0) + amount;
      factor *= (1 - amount / curTotal);
    }

    out.by[from] = _ordSummarise(edges);
  }
  return out;
}

// WHAT ACTUALLY LEAVES `sid` ON THE NEXT SWEEP, down which line, and why it does
// not.
//
//   { units, target, blocked, edges }
//
//   units    what would really be shipped in total, 0 whenever everything is
//            blocked. NOT what the source is willing to part with.
//   edges    [{ target, units, blocked }], in sorted destination order — the
//            per-line answer, which is what a map marker with one arrow per
//            destination draws from.
//   blocked  null when units > 0; otherwise the first edge's reason, or
//            'no-order' when this city supplies nowhere.
//   target   the city `blocked` is about. null when there are no edges.
//
// This, not standingOrderSend(), is the number a readout must show. The two
// differ exactly when a destination cannot take the stream, which is the case
// the player most needs told: a city with a supply line into a full destination
// is willing to ship 5.6 units and actually ships zero, and only this function
// knows that. See known-issues #18.
//
// PURE: no mutation of state, no command issued, no cache. Deliberately
// uncached — the plan depends on every garrison on the board, and a memo keyed
// on anything cheaper than that would go stale inside a tick, which is a subtler
// wrong answer than the one this function exists to fix.
//
// COST. It plans the WHOLE POWER to answer about one station, so it is fine once
// per frame and is not fine in a loop over stations — use standingOrderPlan()
// for that. The work is a walk of the power's supplying stations and one
// routeFor() per edge; those searches are cached per (state, ownerEpoch, power,
// source) in this file, so the steady-state cost is the walk and the worst case
// is one cached search per edge on the first plan after a capture.
function standingOrderNext(state, sid) {
  var none = { units: 0, target: null, blocked: 'no-order', edges: [] };
  if (!state || !state.stations || typeof BAL === 'undefined' || !BAL.ORDERS) return none;
  var st = state.stations[sid];
  if (!st || !st.supplyTo || !st.supplyTo.length) return none;
  // Neutral is never an actor and a dead power takes no sweeps — the same two
  // gates ordersTick applies, so this cannot describe a sweep that will not run.
  var pid = st.owner;
  if (!pid || pid === 'neutral') return none;
  var pow = state.powers && state.powers[pid];
  if (!pow || pow.alive === false) return none;

  var p = _ordPlanPower(state, pid).by[sid];
  if (!p) return none;
  return { units: p.units, target: p.target, blocked: p.blocked, edges: p.edges };
}

// THE SAME ANSWER FOR EVERY SUPPLYING CITY ONE POWER HOLDS, in one call:
// `{ sid: { units, target, blocked, edges } }`, empty when the power supplies
// nowhere.
//
// Not a convenience. standingOrderNext() plans the whole power's sweep to answer
// about one station, so asking it about seven stations repeats the entire plan
// seven times, and it scales with how many cities the player has automated. Two
// renderers need the whole set at once (the map marks every pipe on every
// ordered node; a header sums them), and this is what they call.
//
// It is the SAME planner, so there is still exactly one implementation and
// nothing here can disagree with the sweep. Fresh objects are returned rather
// than the planner's own records, so a caller cannot reach in and edit the plan
// the sweep would have used — the `fraction` field is the sweep's business.
function standingOrderPlan(state, pid) {
  var out = {};
  if (!state || !state.stations || typeof BAL === 'undefined' || !BAL.ORDERS) return out;
  if (!pid || pid === 'neutral') return out;
  var pow = state.powers && state.powers[pid];
  if (!pow || pow.alive === false) return out;

  var plan = _ordPlanPower(state, pid);
  for (var i = 0; i < plan.sources.length; i++) {
    var sid = plan.sources[i], p = plan.by[sid];
    if (!p) continue;
    var edges = [];
    for (var j = 0; j < p.edges.length; j++) {
      var e = p.edges[j];
      edges.push({ target: e.target, units: e.units, blocked: e.blocked });
    }
    out[sid] = { units: p.units, target: p.target, blocked: p.blocked, edges: edges };
  }
  return out;
}

// One power's sweep: drop what is dead, issue what the plan says, and nothing
// else. Every decision above this line lives in _ordPlanPower, which is also
// what the readout reads. Returns the number of streams launched.
function _ordSweepPower(state, pid) {
  // BEFORE the plan, so an edge whose destination has been lost is dropped on
  // the same sweep the plan refuses to act on it. See the LOST DESTINATION
  // block above; this is the only mutation in the phase that is not a command.
  _ordClearLost(state, pid);

  var plan = _ordPlanPower(state, pid);
  var sent = 0;

  for (var i = 0; i < plan.sources.length; i++) {
    var from = plan.sources[i];
    var p = plan.by[from];
    if (!p) continue;

    // Edges in the plan's own order, which is the sorted destination order the
    // plan sized them in. Issuing them in any other order would ship different
    // amounts, because each send is sized against what the previous one left.
    for (var j = 0; j < p.edges.length; j++) {
      var e = p.edges[j];
      if (e.blocked || !(e.units > 0)) continue;

      // Through applyCommand, exactly as the player and the AI do. Nothing here
      // builds a wave: if a volley would be illegal for them it is illegal here,
      // and `rejected` is this phase's feedback channel just as it is the AI's.
      //
      // The plan is sized so that none of applyCommand's rejections can fire:
      // the target is ground `pid` holds (checked in the plan), MIN_SEND (2.0)
      // is above MIN_SEND_UNITS (0.5), the route exists because the plan asked
      // routeFor for it, source and target differ because core/state.js will not
      // store an edge otherwise, and 0 < fraction <= 1 by construction. The
      // guard stays anyway — a plan that is silently not executed must not be
      // counted.
      var res = applyCommand(state, {
        type: 'send',
        owner: pid,
        sources: [from],
        target: e.target,
        fraction: e.fraction,
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
  }
  return sent;
}

// The phase. AFTER growth, so a city ships units it actually has this tick;
// BEFORE movement, so a stream created this tick starts moving this tick rather
// than sitting still for one.
//
// THROTTLED, for the reason CAPITULATE_CHECK_INTERVAL is: this is a whole-board
// scan plus a route lookup per supply line, nothing about it is time-critical,
// and running it every tick would be pure waste. See BAL.ORDERS.INTERVAL for
// how 25 was chosen against the other clocks.
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
