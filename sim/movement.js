// sim/movement.js — phase 2 of the tick.
//
// Waves march along links and resolve the moment they land. Two rules from the
// design carry most of the weight here:
//
//   * Every army moves at the same speed (00-vision.md §8). There used to be
//     three unit types and a wave took the speed of its slowest, so that a
//     mixed stack travelled together; with one type there is nothing to
//     reconcile and the stagger in a volley comes from source distance alone.
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
// Extra route distance for entering `sid`, so the router can price a detour.
//
// "Pay the toll and go around, or pay the battle and go through" (§6) is only a
// choice the player can express if the ROUTER makes it — the player picks a
// target, never a path. So the toll has to be in the edge weight.
//
// OWNERSHIP ONLY, NEVER GARRISON SIZE, and this is the load-bearing constraint
// rather than an approximation I settled for. The route cache is keyed on
// `state.ownerEpoch`, which changes on capture; garrisons change every tick. A
// weight that read stationPower() would be stale on every cached route, or would
// throw the cache away sixty times a second. The toll actually CHARGED still
// scales with the real garrison — only the router's estimate is blunt, and it is
// blunt in the direction that matters: own ground free, neutral cheap, hostile
// dear.
function _moveRouteWeight(state, pid, sid) {
  if (!state || typeof pid !== 'string') return 0;
  var rel = movePassageRelation(state, pid, sid);
  if (rel === 'own') return 0;
  var rate = (rel === 'neutral') ? BAL.PASSAGE.TOLL_NEUTRAL : BAL.PASSAGE.TOLL_HOSTILE;
  return rate * BAL.PASSAGE.TOLL_ROUTE_WEIGHT * 100;
}

function _moveSearch(from, canPass, weight) {
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
      var d = dist[best] + (l ? l.dist : 1) + (weight ? weight(to) : 0);
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
// ---------------------------------------------------------------------------
// PASSAGE — 06-movement-and-attrition.md, roadmap B1
//
// This function used to be `st.owner === pid`, and that one line was the reason
// "multi-hop movement" was a claim 00-vision.md §8 made and the game did not
// honour. Opening it is what makes the AI's horizon real, makes fog
// load-bearing (you can now march somewhere you cannot see), and makes
// encirclement reachable — bypassing a fortress to cut the ground behind it,
// which connection decay has always rewarded and no player has ever been able
// to attempt.
// ---------------------------------------------------------------------------

// The RELATIONSHIP between a wave's owner and the ground it is entering, as a
// string rather than a boolean.
//
// §6 asks for exactly this and gives the reason: with explicit teams, passage
// through an ally's ground must cost nothing, and "retrofitting a relationship
// check into a boolean is the more expensive order". `own` and `hostile` are the
// only cases that exist today; `neutral` sits between them; `ally` is a case
// statement away and needs no other change.
function movePassageRelation(state, pid, sid) {
  var st = state.stations[sid];
  if (!st) return 'hostile';
  if (st.owner === pid) return 'own';
  if (st.owner === 'neutral') return 'neutral';
  return 'hostile';
}

// Units a wave of `pid` loses ENTERING `sid`, charged once.
//
// Scaled by the station's FULL defensive power — garrison, terrain, `defensive`
// type and fortification tier — through the canonical
// stationPower(state, sid, 'defender'). §6 is explicit that this must not derive
// a second toll formula from unit counts: that is known-issues #9, logged five
// times and twice inside the combat maths specifically. One power function, two
// callers — the battle and the toll.
//
// An empty neutral village is a road. A fortified enemy citadel is a wall you
// would rather walk around.
function movePassageToll(state, pid, sid) {
  var rel = movePassageRelation(state, pid, sid);
  var rate = (rel === 'own') ? BAL.PASSAGE.TOLL_OWN
    : (rel === 'neutral') ? BAL.PASSAGE.TOLL_NEUTRAL
    : BAL.PASSAGE.TOLL_HOSTILE;
  if (!(rate > 0)) return 0;
  if (typeof stationPower !== 'function') return 0;
  var p = stationPower(state, sid, 'defender');
  return (p > 0) ? rate * p : 0;
}

// Everything is passable now. Kept as a function rather than deleted because it
// is the seam a future rule goes through — impassable ground (a blockade, a
// closed strait) has somewhere to live, and every caller already asks.
function _moveCanTraverse(state, pid, sid) {
  return !!state.stations[sid];
}

// The CLOSED search — own ground only. What _moveOwnSearch used to be, kept for
// standing orders (see routeFor). No route weight: on ground you hold there is
// no toll to price.
var _heldRouteCache = null, _heldRouteState = null, _heldRouteEpoch = -1;

function _moveHeldSearch(state, pid, from) {
  if (_heldRouteState !== state || _heldRouteEpoch !== (state.ownerEpoch || 0)) {
    _heldRouteCache = {};
    _heldRouteState = state;
    _heldRouteEpoch = state.ownerEpoch || 0;
  }
  if (!_heldRouteCache[pid]) _heldRouteCache[pid] = {};
  var byFrom = _heldRouteCache[pid];
  if (byFrom[from]) return byFrom[from];
  var out = _moveSearch(from, function (sid) {
    return state.stations[sid] && state.stations[sid].owner === pid;
  });
  byFrom[from] = out;
  return out;
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
  var out = _moveSearch(from,
    function (sid) { return _moveCanTraverse(state, pid, sid); },
    function (sid) { return _moveRouteWeight(state, pid, sid); });
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
// `standingOnly` keeps the CLOSED rule: own ground and nothing else.
//
// PASSAGE IS FOR ARMIES, NOT FOR LOGISTICS, and this distinction is the one thing
// B1 must not blur. A standing order is a supply line between two cities one
// power holds; routing it through hostile ground would send an unattended trickle
// into somebody else's country, where _moveIntercepts halts it and it stands down
// — over and over, forever, with the player never having asked for any of it.
//
// Found by test/runner.js's standing-order tripwire the moment traversal opened:
// "a standing wave was routed over ground its owner does not hold — bil->par via
// bdx". The suite was right and the first version of this change was wrong.
//
// A separate cache, because the two searches answer different questions from the
// same (state, epoch, power) key and sharing one would hand a standing order the
// army's route or the reverse.
function routeFor(state, pid, fromSid, toSid, standingOnly) {
  if (!state || !state.stations) return routeBetween(fromSid, toSid);
  if (typeof STATIONS === 'undefined' || !STATIONS[fromSid] || !STATIONS[toSid]) return null;
  if (fromSid === toSid) return [fromSid];
  var search = standingOnly
    ? _moveHeldSearch(state, pid, fromSid)
    : _moveOwnSearch(state, pid, fromSid);
  return _moveWalkBack(search, fromSid, toSid);
}

// ---------------------------------------------------------------------------
// Marching
// ---------------------------------------------------------------------------

// Map distance covered this tick, on the link the wave is currently on.
// Terrain is the terrain of the territory being ENTERED (data schema: terrain
// "modifies march time along links crossing into it").
function waveSpeed(w) {
  var from = w.path[w.hop], to = w.path[w.hop + 1];
  // An empty wave does not move. Kept as an explicit zero rather than letting
  // it drift at full speed: an annihilated stack still sits on state.waves for
  // the rest of the tick, and a moving corpse walks into the next station.
  if (!(w.units > BAL.ANNIHILATION_EPSILON)) return 0;

  var terr = terrainOf(to);
  var v = BAL.MOVE_BASE * BAL.UNIT.speed * terr.move;

  var l = linkBetween(from, to);
  if (l && l.sea) v *= BAL.SEA_SPEED_MUL;
  return v;
}

function waveArrived(w) {
  return w.hop >= w.path.length - 2 && w.progress >= 1;
}

// TOMBSTONE — C1. _chargeSeaCrossing() took BAL.SEA_ARTILLERY_LOSS off a
// wave's guns as each sea hop completed, so that shipping artillery cost
// something without needing a transport model. There are no guns to charge.
// A sea crossing is now purely the speed penalty (SEA_SPEED_MUL, compounded
// with the 1.6x sea dist inflation), which is the same toll for everybody.

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
// Does entering `sid` STOP this wave short of its destination?
//
// THIS USED TO BE "ANY GROUND YOU DO NOT OWN", AND THAT WAS THE OTHER HALF OF
// THE CLOSED TRAVERSAL RULE. With passage open, a manual wave walking through
// hostile ground is the whole point — it pays the toll and keeps going. Stopping
// it would make encirclement impossible again through a different door.
//
// A STANDING wave still halts, and the reasoning below is unchanged: it is not a
// decision the player made about this march. Feeding logistics into a battle
// nobody clicked for, 12% of a garrison at a time, is defeat in detail committed
// by an automated mechanic on the player's behalf — which 00-vision.md §8 names
// as the defining mistake of the game.
function _moveIntercepts(state, w, sid) {
  var st = state.stations[sid];
  if (!st) return false;
  if (!w.standing) return false;
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
    stats.unitsLost += w.units;
  }
  w.units = 0;
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

    // INTERDICTION: a fortified target bleeds the assault on its final approach.
    // Charged for the portion of THIS tick actually spent on the last hop, so it
    // is a function of time under the guns rather than of how the tick boundaries
    // happened to fall — otherwise a wave that finishes a hop early in a tick
    // pays the same as one that spends the whole tick closing.
    if (w.hop >= lastHop) _chargeApproach(state, w, to, (need > timeLeft) ? timeLeft : need);

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

    // THE PASSAGE TOLL, charged ONCE on entering ground the wave does not own
    // (§6). This is the mid-path case only: the destination is not tolled,
    // because entering the destination IS the battle and charging both would
    // bill one arrival twice.
    _chargePassage(state, w, to);
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
  if (units <= BAL.ANNIHILATION_EPSILON) return;

  if (st.owner === owner) {
    st.units += units;
    return;
  }

  if (standing) {
    if (state.orderStats) {
      state.orderStats.fights++;
      state.orderStats.unitsLost += units;
    }
    return;
  }

  if (!st.attackers) st.attackers = {};
  if (!st.attackers[owner]) st.attackers[owner] = 0;
  st.attackers[owner] += units;
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

// Ticker-legible unit count. One decimal below 10, whole numbers above — the
// ticker is peripheral awareness and "puts 23.7 ashore" is noise, but a 0.6-unit
// landing rounding to "0" would be a lie about an event that happened.
function _moveLandNum(n) {
  return String(n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
}

// The at-sea remainder lives in w.units, as it always has — nothing else in the
// sim needs to learn a new place to look for a wave's strength. w.landing is
// the bookkeeping a renderer needs on top of that:
//
//   ashore  units already committed to the beach
//   total   strength at the moment the landing began, AFTER the sea toll
//   per     units committed per tick (total / LANDING_TICKS)
//
// Fixing `per` at the start rather than recomputing it from the remainder is
// what makes the echelon a constant fraction of ORIGINAL strength; recomputing
// would give an exponential decay that never finishes.
//
// ── THE LANDING EVENT ──────────────────────────────────────────────────────
//
// This is the only moment an amphibious assault is a discrete, nameable thing:
// after it the wave is a trickle of echelons and then it is just a battle.
// Before this event existed the only surface a landing had was the station
// readout (render/readout.js), which required hovering that exact station
// inside the ~12 sim-second landing window — measured across 12 headless games,
// 7,182 sea crossings and 4,282 beachhead landings produced ZERO ticker lines.
//
// Three properties, all deliberate:
//
//   * ONLY OPPOSED LANDINGS ARE LOGGED. A wave coming ashore at a port its own
//     side already holds merges into the garrison and starts no fight; it is
//     sea-borne reinforcement, not a beachhead, and it is HALF of all landings
//     (measured: 2,219 of 4,356 over 12 games). A standing-order wave is never
//     an assault by construction (see the STANDING WAVES block above), so it is
//     excluded on the same test rather than on a second one. What is left —
//     ~178 per game, one per 104 ticks — is exactly the set of events where
//     units go into station.attackers off a boat.
//
//   * THE NUMBER IS THE ONE THAT LANDS. `L.total` is read back out of the
//     record this function just built, POST sea toll, which is the same number
//     _moveLandEchelon divides into echelons and the same one the readout
//     prints. It is not recomputed from w.units and not derived from anything
//     (docs/testing/known-issues.md #18).
//
//   * THE DEFENDER IS NAMED AT LANDING TIME. The beach can change hands twice
//     before the last echelon is ashore, so "who was standing there" cannot be
//     looked up later from the station — it has to be recorded now, which is
//     also why render/hud.js tiers off the logged text rather than off the live
//     board.
//
// logEvent lives in core/state.js and only pushes onto state.log — no document,
// no rng (sim/combat.js already calls it from _capture for the same reason).
// Adding it here therefore cannot move a seeded replay: verified by running
// `node tools/balance.js 48 --seed 100` before and after, byte-identical.
function _moveBeginLanding(state, w) {
  var n = BAL.LANDING_TICKS > 1 ? BAL.LANDING_TICKS : 1;
  w.landing = { ashore: 0, total: w.units, per: w.units / n };

  var sid = w.path[w.path.length - 1];
  var st = state && state.stations ? state.stations[sid] : null;
  if (!st || st.owner === w.owner) return;              // reinforcement, not a beachhead
  if (typeof logEvent !== 'function') return;
  // 4th argument: the beach. Stated, never consulted — this file may not know
  // who can see it (test/fog-tests.js greps sim/ for exactly that). It is what
  // lets render/hud.js keep a landing off the ticker when the player has no
  // eyes on the coast it happened on.
  logEvent(state, 'landing',
    w.owner + ' puts ' + _moveLandNum(w.landing.total) + ' ashore at ' +
    (typeof STATIONS !== 'undefined' && STATIONS[sid] ? STATIONS[sid].name : sid) +
    ' against ' + st.owner, sid);
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
  var atSea = w.units;
  if (atSea <= BAL.ANNIHILATION_EPSILON) return false;

  // Flush the remainder on the final echelon rather than trickling a residue
  // forever: once one more echelon would leave behind less than the smallest
  // stack a player is allowed to send, the rest comes ashore now. Same
  // reasoning as BAL.MIN_SEND_UNITS, and the same threshold.
  var share = L.total / (BAL.LANDING_TICKS > 1 ? BAL.LANDING_TICKS : 1);
  var last = (atSea - share) <= BAL.MIN_SEND_UNITS;

  var go = last ? w.units : Math.min(w.units, L.per);
  if (!(go > 0)) go = 0;
  w.units -= go;

  L.ashore += go;
  _moveDeposit(state, sid, w.owner, go, w.standing);
  return !last && w.units > BAL.ANNIHILATION_EPSILON;
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

  if (w.units <= BAL.ANNIHILATION_EPSILON) return false;

  if (!_moveIsSeaArrival(w)) {
    _moveDeposit(state, sid, w.owner, w.units, w.standing);
    return false;
  }

  _moveBeginLanding(state, w);
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

    if (w.units <= BAL.ANNIHILATION_EPSILON) continue;

    // MARCH ATTRITION — 06-movement-and-attrition.md §2. Charged once per wave
    // per tick, BEFORE advancing, so a wave that dies this tick never moves on
    // strength it no longer has.
    if (_chargeMarch(state, w)) continue;                // destroyed en route

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

// Charge the passage toll for entering `sid`. Nothing on your own ground.
//
// The wave may die here, and that is correct: running the gauntlet past a
// fortress with a raiding party should lose the raiding party.
function _chargePassage(state, w, sid) {
  var toll = movePassageToll(state, w.owner, sid);
  if (!(toll > 0)) return;
  var held = w.units;
  if (held <= 0) return;
  if (held - toll <= (BAL.ANNIHILATION_EPSILON || 0)) {
    w.units = 0;
    w.dead = true;
    if (typeof logEvent === 'function') {
      logEvent(state, 'lost', POWERS[w.owner].name + ' lost a column forcing passage at ' +
        STATIONS[sid].name, sid);
    }
    if (state.orderStats) state.orderStats.unitsLost += held;
    return;
  }
  w.units = held * ((held - toll) / held);
}

// A wave loses strength for every tick it is in transit. Returns true if this
// tick destroyed it.
//
// FLAT UNITS PER TICK, NEVER A FRACTION, and §2 is emphatic about why. A
// fractional rate costs a 10-unit raid and a 200-unit army the same PERCENTAGE,
// so mass buys nothing and distance is free to anyone. A flat rate costs them
// the same ABSOLUTE amount: the raid dies, the army arrives at 95%.
//
// That produces the rule the design wants — REACH IS BOUGHT WITH MASS. Deep
// strikes become something armies do rather than something anyone can do, and a
// long march is a commitment whose size you can see before you make it. It also
// gives 00-vision.md §5's "overwhelming force" principle a geographic dimension
// it has never had.
//
// The historical case §2 cites: the German marches into Russia in both wars were
// not lost to battles at the far end, they were lost to the front outrunning what
// could sustain it.
//
// DESTROYED EN ROUTE IS A REAL AND LEGIBLE FAILURE — you overreached — so it is
// logged. §2: "it must appear in the ticker, not vanish silently."
//
// Expressed as a surviving fraction rather than a subtraction, so the arithmetic is
// unchanged when the three unit types collapse to one (04-development.md §9).
function _chargeMarch(state, w) {
  var rate = BAL.PASSAGE ? BAL.PASSAGE.MARCH_LOSS_PER_TICK : 0;
  if (!(rate > 0)) return false;
  var held = w.units;
  if (held <= 0) return false;

  // DEATH IS "WOULD FALL TO THE ANNIHILATION FLOOR", NOT "WOULD FALL TO ZERO".
  //
  // The first version tested `held <= rate` and that branch was UNREACHABLE:
  // MARCH_LOSS_PER_TICK is 0.004 and ANNIHILATION_EPSILON is 0.01, so a wave
  // whittled below the floor was silently discarded by movementTick's epsilon
  // check on the NEXT tick — no log, no ticker line, no unitsLost. §2 is explicit
  // that a column destroyed en route "is a real and legible failure — you
  // overreached — and it must appear in the ticker, not vanish silently."
  //
  // Found by a test asserting the log entry, not by reading the code: the numbers
  // that make it unreachable live in a different file from the branch.
  var floor = BAL.ANNIHILATION_EPSILON || 0;
  if (held - rate <= floor) {
    w.units = 0;
    w.dead = true;
    if (typeof logEvent === 'function') {
      logEvent(state, 'lost', POWERS[w.owner].name + ' lost a column marching on ' +
        STATIONS[w.to].name + ' — it never arrived', w.to);
    }
    if (state.orderStats) state.orderStats.unitsLost += held;
    return true;
  }
  w.units = held * ((held - rate) / held);
  return false;
}

// A fortified station bleeds a hostile assault while it closes.
//
// "In addition to being stronger, a fortified location should cause attrition of
// enemy units when approaching the target to attack." The design had already
// argued for this and already decided it: 06-movement-and-attrition.md §6 makes
// fortification TAX armies rather than only absorb them, because
// 04-development.md §7's stalemate risk — fortification available at all 108
// stations against a factory counter at 16 — is answered by a fortress that
// PROJECTS. "A fortress that projects outward is not a turtle."
//
// WHY THE FINAL HOP ONLY, and not the whole march: this is the approach, the
// ground in front of the walls. Attrition over a whole route is
// 06-movement-and-attrition.md §7 and belongs to B1; charging it here would be
// implementing half of B1 under a constant named for forts, and the balance pass
// would not know which mechanic it was measuring.
//
// WHY OPERATING TIER: an ungarrisoned fortification projects nothing, exactly as
// it adds no defensive power. Manning the wall is what makes it a wall — and it
// means a raid that empties a fortress also opens the road past it.
//
// WHY NOT stationPower(): §6 says a PASSAGE toll must scale with the station's
// FULL defensive power and must not derive a second formula — and it is right,
// for passage. This is deliberately narrower: the DEVELOPMENT's effect, scaled by
// the development alone. Scaling by total defensive power would make every
// garrison on the board bleed every attacker, which is B1's whole combat model
// arriving unannounced. When B1 lands this becomes the fortification TERM of that
// rule rather than a rule of its own.
//
// Expressed as a surviving FRACTION rather than a subtraction, so it
// needs no change when the three unit types collapse to one (§9).
function _chargeApproach(state, w, to, ticks) {
  if (!(ticks > 0)) return;
  if (typeof developmentFortLevel !== 'function') return;
  var st = state.stations[to];
  if (!st || st.owner === w.owner) return;               // never your own ground
  // A standing order only ever moves between cities one power holds, so it can
  // never be an assault. The owner check above already covers it; this says so
  // rather than leaving the next reader to re-derive it.
  if (w.standing) return;
  if (developmentKind(state, to) !== 'fort') return;
  var tier = operatingTier(state, to);
  if (tier <= 0) return;

  var f = 1 - BAL.DEV.FORT_APPROACH_LOSS * tier * ticks;
  if (f >= 1) return;
  if (f < 0) f = 0;
  w.units *= f;
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
  var units = st.units;
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
    out[w.to] = (out[w.to] || 0) + w.units;
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
  return cap * _ordCeilingMul() - st.units - (inbound[sid] || 0);
}

// ---------------------------------------------------------------------------
// THE FLOOR THE PLANNER GATES ON — and why it is not BAL.ORDERS.MIN_SEND flat.
//
// The plan is executed through applyCommand, which has its OWN floor:
// BAL.MIN_SEND_UNITS (0.5), the smallest stack anybody may put on the map. A
// send under it is rejected as 'too-few-units' and nothing moves. So the two
// numbers are not independent — if ORDERS.MIN_SEND is ever set below
// MIN_SEND_UNITS, the planner promises streams the command layer refuses, and
// the readout that shares this planner promises them to the player. That is
// exactly the failure known-issues #18 is about, arriving through a constant
// rather than through a duplicated formula.
//
// MEASURED, on `mec` (capacity 13) with one supply line into a drained
// destination, AI off, 40,000 ticks:
//
//     ORDERS.MIN_SEND   plan says      applyCommand ships
//     1.00              0.058/sweep    0.058/sweep     agree
//     0.50              0.109/sweep    0.115/sweep     agree
//     0.25              0.483/sweep    0.115/sweep     OFF BY 4x
//
// At 0.25 every sweep planned a 0.48-unit send, every one of them was rejected,
// and the board was byte-identical to the 0.50 run while the rail would have
// advertised four times the traffic. Nothing failed; nothing could.
//
// The block comment in _ordSweepPower asserts this invariant in prose ("MIN_SEND
// (2.0) is above MIN_SEND_UNITS (0.5)") and that prose is already stale by one
// retune. Taking the max makes it structural instead: the plan is now incapable
// of promising a send applyCommand will refuse, whatever the two constants are
// set to. INERT at today's values (1.0 > 0.5), so no board moves.
// ---------------------------------------------------------------------------
function _ordMinSend() {
  var m = (BAL.ORDERS && isFinite(BAL.ORDERS.MIN_SEND)) ? BAL.ORDERS.MIN_SEND : 0;
  var floor = isFinite(BAL.MIN_SEND_UNITS) ? BAL.MIN_SEND_UNITS : 0;
  return m > floor ? m : floor;
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
  var amount = st.units * _ordAllowedFraction(state, sid);
  return amount >= _ordMinSend() ? amount : 0;
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
//
// ── SHORTFALL — "it is saving up", as a number ─────────────────────────────
//
// `below-min-send` is by far the most common dark state on a healthy board and
// it covers TWO situations a player would act on differently. The word does not
// separate them and the number does:
//
//   shortfall > 0   the SOURCE cannot yet pay for a single stream. It is
//                   accumulating, and this is how many more units it needs
//                   before ANY of its lines run.
//   shortfall == 0  the source can pay; this particular line is WAITING ITS
//                   TURN in the rotation (see TAKE TURNS below), or its share
//                   was trimmed under the floor by the destination's room.
//
// WHY THE SIM OWNS THIS NUMBER RATHER THAN THE RAIL. It is the inverse of
// _ordAllowedFraction — the garrison at which `have x fraction` first reaches
// the floor:
//
//     need = KEEP_FLOOR x capacity + MIN_SEND / SEND_FRACTION
//
// A renderer computing that for itself would be a second implementation of the
// keep-floor rule living in another file, which is precisely known-issues #9,
// and it would drift the first time either constant moved. It is one
// subtraction inside the loop that already has both numbers.
//
// WHY IT IS NOT A COUNTDOWN IN TICKS. An ETA needs the source's growth rate,
// which is sim/growth.js's logistic — a second copy of THAT is the same issue
// one file over, and this file has no honest access to it. Units are also the
// better readout: the garrison is drawn on the station, so "4.1 more units" is
// a claim the player can check against the board, and it stays true when the
// source is being spent (the shortfall grows) where a countdown would lie.
//
// MEASURED, so the readout knows what it is describing. A lone uncontested
// route ships on `production per sweep / MIN_SEND` of its sweeps and is dark on
// the rest — AI off, destination drained, 40,000 ticks, ground truth from
// orderStats:
//
//     source  capacity   ships on   longest dark run
//     mec     13          6% of sweeps   17 sweeps = 425 ticks
//     bea     14         10%             20 sweeps = 500 ticks
//     inn     20         23%              8 sweeps = 200 ticks
//     brn     30         58%              2 sweeps
//     ber     72        100%              0
//
// and across every one of those the source garrison is STATIONARY to within a
// unit over 32,000 ticks: 100% of what a feed city produces leaves down the
// line. The dark sweeps are not lost throughput, they are a city that has not
// yet produced one shippable batch. That is the sentence the shortfall exists
// to let the board say.
// ---------------------------------------------------------------------------

// `shortfall` defaults to 0 — the reasons raised in pass 1 are facts about the
// DESTINATION and say nothing about what the source can afford.
function _ordBlocked(target, why, shortfall) {
  return {
    target: target, units: 0, fraction: 0, blocked: why,
    shortfall: (shortfall > 0) ? shortfall : 0,
  };
}

// ---------------------------------------------------------------------------
// WHO GOES FIRST — and why it must not always be the same city.
//
// The plan books headroom as it goes, so when several sources feed ONE
// destination the sources at the front of the list get the room and the ones
// behind them read `destination-full`. That is correct arithmetic and it was
// the wrong QUEUE: the list was STATION_IDS order, which is alphabetical, which
// is a ranking the sim applies off screen — exactly the thing THE EVEN SPLIT
// above refuses to do one paragraph earlier, arriving through the back door.
//
// Measured on a live board, five cities feeding one front city that was
// spending what it received, over 160 sweeps:
//
//     ber 160    bre 2    brn 2    fra 1    ham 1
//
// and with `ber` dropped from the group it was `bre` — the smallest of the five
// — that won 61 sweeps while `ham`, more than twice its capacity, took 2. Not
// size, not distance, not need: the id. Four of the player's five feeders sat
// dark forever, which is what "they're not consistently still sending troops"
// looks like from the outside, and the map drew four dimmed pipes with no
// arrows on them to say so.
//
// So the sweep starts at a different feeder each time and wraps. One line, and
// it is the whole fix: throughput is unchanged (the same total room is spent by
// the same total of sources), and over N sweeps each of N feeders leads once.
// "They take turns" is a rule the player can state and check off the board,
// which is the bar the even split was held to.
//
// TIED TO THE SWEEP NUMBER, NOT TO A COUNTER IN STATE. `state.tick` is already
// what decides whether a sweep happens at all, so deriving the rotation from it
// keeps the phase a pure function of the board — a counter would be a second
// piece of sim state to snapshot, replay and get wrong.
//
// CEIL, NOT FLOOR, because this predicts the NEXT sweep and the readout asks
// between sweeps. On a sweep tick the two agree exactly (tick % INTERVAL === 0),
// which is the only moment the exactness test compares them. For the ONE tick
// immediately after a sweep the answer names the sweep that just ran rather than
// the one 25 ticks out; every other tick in the window is exact.
function _ordRotation(state, n) {
  if (!(n > 1)) return 0;
  var iv = (BAL.ORDERS.INTERVAL > 0) ? BAL.ORDERS.INTERVAL : 1;
  var tick = (state && isFinite(state.tick)) ? state.tick : 0;
  var r = Math.ceil(tick / iv) % n;
  return r < 0 ? r + n : r;
}

// A source's whole answer: `{ units, edges, blocked, target }`.
//
//   units    total leaving this city on the next sweep, summed over its edges
//   edges    one record per destination, in sorted destination order, each
//            { target, units, fraction, blocked, shortfall }
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

  // Rotate the queue so a scarce destination is not fed by the same city every
  // sweep — see _ordRotation. In place, because `sources` IS `out.sources` and
  // _ordSweepPower issues the commands in exactly this order: the plan sizes
  // each send against what the previous one left, so the two must walk the same
  // sequence or the prediction stops being exact.
  var off = _ordRotation(state, sources.length);
  if (off) {
    var head = sources.splice(0, off);
    for (i = 0; i < head.length; i++) sources.push(head[i]);
  }

  var inbound = _ordInbound(state, pid);
  var minSend = _ordMinSend();

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
      if (!routeFor(state, pid, from, to, true)) { edges.push(_ordBlocked(to, 'unreachable')); live.push(null); continue; }
      edges.push(null);
      live.push(to);
      if (_ordHeadroom(state, to, inbound) >= minSend) open++;
    }

    // The source-wide gate. Checked after pass 1 rather than before it so the
    // edge-level reasons above are still computed and drawn: a city sitting at
    // its keep floor still wants to show which of its lines are cut.
    var fraction = _ordAllowedFraction(state, from);
    var have = st.units;
    var share = (open > 0 && fraction > 0) ? (have * fraction) / open : 0;

    // How far this SOURCE is from being able to pay for one whole stream — the
    // inverse of _ordAllowedFraction, and exactly the condition under which the
    // whole city goes dark. `have x fraction` is SEND_FRACTION x (have -
    // KEEP_FLOOR x cap) whenever the fraction is positive, so
    //
    //     have x fraction >= minSend   <=>   have >= need
    //
    // holds identically rather than approximately, and the same number is
    // correct below the keep floor (where the fraction is 0 and the reason is
    // `at-keep-floor`). See the SHORTFALL block above _ordBlocked.
    var srcCap = (typeof STATIONS !== 'undefined' && STATIONS[from]) ? STATIONS[from].capacity : 0;
    var need = BAL.ORDERS.KEEP_FLOOR * srcCap + minSend / BAL.ORDERS.SEND_FRACTION;
    var shortBy = need - have;
    if (!(shortBy > 0)) shortBy = 0;

    // -----------------------------------------------------------------------
    // TAKE TURNS RATHER THAN STARVE EVERY LINE AT ONCE.
    //
    // THE EVEN SPLIT above divides one source's allowed outflow between its open
    // destinations, and MIN_SEND then gates each share on its own. Those two
    // rules multiply: N lines out of one city need N x MIN_SEND of surplus
    // before ANY of them run, so a source that could comfortably pay for one
    // stream pays for NONE the moment a second line is drawn out of it. Not a
    // smaller stream — zero, to every destination, including the one that was
    // working a second earlier.
    //
    // Which is exactly what the player reported: *"if you add a command for a
    // city that's in the path, it disrupts the flow of troops and ends the
    // route."* The new line is not what ends it; DIVIDING BY TWO is, and the old
    // line dies with the new one. Measured over 84 two-destination networks on
    // 12 seeds x 7 powers, 10,080 sweeps: on 57.6% of them every edge read
    // `below-min-send` while the source held enough surplus to pay for one whole
    // stream. 10,536 units sat still that had somewhere legal to go.
    //
    // BAL.ORDERS.MIN_SEND was already cut 2.0 -> 1.0 for this ("it's difficult
    // to reinforce more than one city from a single city", data/tuning.js §11)
    // and it only halved the wall — the constant cannot fix a rule that
    // multiplies, it can only move where it bites.
    //
    // AND IT BITES EVERY FEEDER, not only the small ones, because this mechanic
    // drives a source to a fixed point: it ships SEND_FRACTION of its surplus
    // and regrows logistically, so it settles exactly where the two balance —
    // which is where its whole allowance is worth about ONE MIN_SEND. Measured
    // after 500 ticks on the deepest own-ground route each power can draw:
    //
    //     power   source  capacity   steady garrison   whole allowance
    //     aut     alf     14         11.4              0.95
    //     ita     inn     20         13.2              0.99
    //     ger     brn     30         15.9              1.01    (MIN_SEND = 1.0)
    //
    // A 30-capacity city converges to the same knife edge a 14-capacity one
    // does. Halving that is not a 50% cut, it is an off switch, and no value of
    // MIN_SEND moves the equilibrium away from itself.
    //
    // So when the division is what pushed every share under the floor, the
    // source spends its WHOLE allowance down ONE line this sweep and the lines
    // take turns, chosen by the same tick-derived rotation the SOURCE queue
    // already uses (_ordRotation — see the block above it for why the queue may
    // not be a fixed ranking, which is the identical argument one level down).
    //
    // WHAT IS PRESERVED, because the even split is a deliberate rule and not an
    // accident:
    //
    //   * the per-sweep total is unchanged — `have x fraction`, exactly what a
    //     single-line source ships. Drawing more lines still spreads the stream
    //     rather than multiplying it, which is what makes the keep floor mean
    //     anything.
    //   * over N sweeps each of N lines leads once, so the long-run share per
    //     destination is still 1/N. Batched, not reweighted.
    //   * nothing changes while the even split can actually pay: this fires ONLY
    //     when `share < MIN_SEND`, a state in which the current code ships zero.
    //     It cannot make any board worse than it is.
    //
    // "Each line gets the whole stream in turn" is a rule the player can state
    // and check off the board, which is the bar THE EVEN SPLIT set for itself.
    //
    // The lines that are waiting still report `below-min-send`, which is the
    // truth about them on this sweep and is why they are waiting — no new
    // blocked reason, so the vocabulary in 01-data-schema.md and the words the
    // rail prints are untouched.
    // -----------------------------------------------------------------------
    var whole = (fraction > 0) ? have * fraction : 0;
    var lead = -1;                    // index AMONG THE OPEN EDGES that leads
    if (open > 1 && share < minSend && whole >= minSend) {
      share = whole;
      lead = _ordRotation(state, open);
    }
    var openSeen = -1;

    // `factor` is the fraction of the ORIGINAL garrison still standing here as
    // each successive edge is issued. Two edges out of one city are two separate
    // applyCommand calls in the same sweep, and the second one is sized against
    // what the first one left behind — so the plan has to model that shrinkage
    // or it over-promises on every edge after the first.
    var factor = 1;

    for (j = 0; j < list.length; j++) {
      if (edges[j]) continue;                       // already blocked in pass 1
      var t = live[j];
      if (fraction <= 0) { edges[j] = _ordBlocked(t, 'at-keep-floor', shortBy); continue; }

      var room = _ordHeadroom(state, t, inbound);
      if (room < minSend) { edges[j] = _ordBlocked(t, 'destination-full'); continue; }

      // Counted on exactly the edges pass 1 counted in `open`: same predicate,
      // same order, and `inbound` cannot have moved for THIS destination in
      // between (supplyTo is deduped, so no earlier edge of this source booked
      // against it). That equality is what makes `lead` index the set it was
      // computed against — if the two ever drift, the rotation silently skips a
      // line instead of alternating and no total would look wrong.
      openSeen++;
      if (lead >= 0 && openSeen !== lead) { edges[j] = _ordBlocked(t, 'below-min-send', shortBy); continue; }

      var cur = st.units * factor;
      var curTotal = cur;
      if (!(curTotal > 0)) { edges[j] = _ordBlocked(t, 'at-keep-floor', shortBy); continue; }

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
        ? sendPayload(cur, f)
        : curTotal * f;

      if (amount < minSend) {
        // Which end came up short is the whole message. If the destination's
        // remaining room is what cut the stream under the minimum it is the
        // destination that needs attention; otherwise the source is simply not
        // big enough yet — for this many lines — and will ship as it grows.
        edges[j] = _ordBlocked(t, room < share ? 'destination-full' : 'below-min-send', shortBy);
        continue;
      }

      edges[j] = { target: t, units: amount, fraction: f, blocked: null, shortfall: 0 };
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
//   edges    [{ target, units, blocked, shortfall }], in sorted destination
//            order — the per-line answer, which is what a map marker with one
//            arrow per destination draws from. `shortfall` is units the SOURCE
//            still needs before any of its lines run, 0 when it is not the
//            source that is short; see the SHORTFALL block above _ordBlocked.
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
// nowhere. Edge records carry `shortfall` alongside `blocked`, so a map that
// draws one pipe per edge can say "saving up, 4.1 units to go" without
// reimplementing the keep-floor rule (known-issues #9).
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
      edges.push({ target: e.target, units: e.units, blocked: e.blocked, shortfall: e.shortfall });
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
      // the target is ground `pid` holds (checked in the plan), the send clears
      // MIN_SEND_UNITS because _ordMinSend() gates on the MAX of the two floors
      // rather than trusting ORDERS.MIN_SEND to stay above it (it did not, at
      // one point, and nothing said so — see that function), the route exists
      // because the plan asked
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
          if (state.orderStats) state.orderStats.unitsSent += res.waves[k].units;
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
