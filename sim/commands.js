'use strict';

// ---------------------------------------------------------------------------
// sim/commands.js — the SOLE mutation entry point for player and AI alike.
//
// Everything that changes the board outside of a tick goes through
// applyCommand(). That is what makes headless testing, replay and Monte Carlo
// batches free: a game is a seed plus an ordered list of commands.
//
// The only command today is the many-to-one volley from 00-vision.md §8:
//
//     { type:'send', owner, sources:[stationId,…], target:stationId, fraction,
//       types?:['infantry',…] }
//
// `types` is OPTIONAL and omitting it means "all of them", which is what every
// existing caller — the AI, every test, every replay written before it existed —
// already means. It narrows the SAME per-source proportion to a subset of unit
// kinds; it is not a second fraction. Filtering happens before the
// MIN_SEND_UNITS check, so a source that holds only artillery and is asked for
// infantry is rejected as 'too-few-units' rather than sending an empty wave.
//
// Design properties that are deliberate and must not be "fixed":
//
//   * ONE-SHOT. A send fires a single wave per source and is done. There are no
//     standing supply lines and nothing to cancel. Every attack is a decision
//     about what to spend right now.
//   * STAGGERED ARRIVAL. Each source produces its OWN wave with its own route
//     and its own ETA. They are not synchronised, and equalising them would
//     delete "defeat in detail", the defining mistake of the game (§8).
//   * ALL OR NOTHING PER SOURCE. A source is validated completely — ownership,
//     route, minimum payload — before a single unit is subtracted, so a
//     rejected source never leaves the board half-mutated.
//
// Nothing here touches document, Math.random or Date.now.
// ---------------------------------------------------------------------------

// Adjacency over LINKS, built once and cached. LINKS is static, so this can
// never go stale within a process.
var _CMD_ADJ = null;

function _cmdAdjacency() {
  if (_CMD_ADJ) return _CMD_ADJ;
  _CMD_ADJ = {};
  if (typeof LINKS === 'undefined' || !LINKS) return _CMD_ADJ;
  for (var i = 0; i < LINKS.length; i++) {
    var l = LINKS[i];
    (_CMD_ADJ[l.a] = _CMD_ADJ[l.a] || []).push({ to: l.b, dist: l.dist, sea: !!l.sea });
    (_CMD_ADJ[l.b] = _CMD_ADJ[l.b] || []).push({ to: l.a, dist: l.dist, sea: !!l.sea });
  }
  // Sorted so route ties break identically on every machine and every replay.
  Object.keys(_CMD_ADJ).forEach(function (sid) {
    _CMD_ADJ[sid].sort(function (x, y) { return x.to < y.to ? -1 : x.to > y.to ? 1 : 0; });
  });
  return _CMD_ADJ;
}

// Fallback shortest path, used ONLY while sim/movement.js has not loaded.
// routeBetween()/routeFor() there are the real thing and are authoritative;
// this exists so commands.js is independently testable and so a missing
// movement module produces a wrong ETA rather than a crash inside a validation
// path.
//
// `canPass` mirrors _moveSearch in sim/movement.js: a station that fails it can
// be the END of a path but is never expanded from, so it can never sit in the
// middle of one.
function _cmdFallbackRoute(fromSid, toSid, canPass) {
  if (fromSid === toSid) return [fromSid];
  var adj = _cmdAdjacency();
  if (!adj[fromSid] || !adj[toSid]) return null;
  var prev = {}, seen = {};
  var queue = [fromSid];
  seen[fromSid] = true;
  while (queue.length) {
    var cur = queue.shift();
    if (canPass && cur !== fromSid && !canPass(cur)) continue;
    var nbrs = adj[cur] || [];
    for (var i = 0; i < nbrs.length; i++) {
      var n = nbrs[i].to;
      if (seen[n]) continue;
      seen[n] = true;
      prev[n] = cur;
      if (n === toSid) {
        var path = [toSid], p = toSid;
        while (p !== fromSid) { p = prev[p]; path.push(p); }
        return path.reverse();
      }
      queue.push(n);
    }
  }
  return null;
}

// Route lookup with the movement module preferred. Read at CALL time, not load
// time, so script order between sim/commands.js and sim/movement.js is free.
//
// `state` and `pid` are OPTIONAL and they change the question being asked:
//
//   commandRoute(a, b)              -> the geographic shortest path
//   commandRoute(a, b, state, pid)  -> the path a wave of `pid` may legally
//                                      walk on THIS board, routing around
//                                      stations other powers hold
//
// Optional rather than mandatory because the two-argument form already has
// callers (render/select.js's preview, ai/ai.js's ETA estimate) and silently
// changing what it returns is how a shared helper poisons a caller that never
// asked for the new behaviour. Everything that decides whether a send is LEGAL
// must pass state and pid — applyCommand below does, and the preview should
// too, or it will draw a line the commit then rejects.
//
// THE FALLBACK'S PASSABILITY RULE MIRRORS `_moveCanTraverse` IN sim/movement.js,
// and it stopped doing so once. It read `owner === pid || owner === 'neutral'`,
// which was the traversal rule until the capital-only opening made 101 of 108
// stations neutral at turn zero and neutral ground became impassable (the long
// block above `_moveCanTraverse` has the measurement: Britain marched out of
// London and captured Berlin through three unfought garrisons). This copy was
// left behind, still claiming in its own comment to mirror the other one.
//
// Nothing reaches it in a build where sim/movement.js loaded, which is what let
// it rot — and is exactly why it is written down here rather than trusted: a
// validation path that only runs when something else is already broken must
// still give the SAME verdict as the real rule, or the one time it runs it
// accepts a volley that then marches into a garrison it should have fought
// (docs/testing/known-issues.md #9, #20).
function commandRoute(fromSid, toSid, state, pid) {
  var canPass = null;
  if (state && state.stations && pid) {
    if (typeof routeFor === 'function') return routeFor(state, pid, fromSid, toSid);
    canPass = function (sid) {
      var st = state.stations[sid];
      return !!st && st.owner === pid;
    };
  } else if (typeof routeBetween === 'function') {
    return routeBetween(fromSid, toSid);
  }
  return _cmdFallbackRoute(fromSid, toSid, canPass);
}

// ---------------------------------------------------------------------------
// ETA
//
// An ESTIMATE, in ticks, of how long a stack takes to walk a path. It is what
// the preview lines and the AI read (§8: "the preview lines carry ETAs, so the
// spread in a volley is visible before you commit"). sim/movement.js remains
// the authority on where a wave actually is; this must never be used to move
// one.
//
// A wave travels at the speed of its SLOWEST type, so mixed stacks stay
// together and the stagger comes from different SOURCES, not from a stack
// coming apart mid-march (data/tuning.js §6).
// ---------------------------------------------------------------------------

function _cmdSlowestSpeed(units) {
  var order = BAL.UNIT_ORDER, slowest = null;
  for (var i = 0; i < order.length; i++) {
    var t = order[i];
    if (!units[t] || units[t] <= 0) continue;
    var sp = BAL.UNITS[t].speed;
    if (slowest === null || sp < slowest) slowest = sp;
  }
  return slowest === null ? BAL.UNITS.infantry.speed : slowest;
}

function _cmdTerrainMove(sid) {
  if (typeof STATIONS === 'undefined' || !STATIONS[sid]) return 1;
  if (typeof TERRITORIES === 'undefined') return 1;
  var terr = TERRITORIES[STATIONS[sid].territory];
  if (!terr) return 1;
  var row = BAL.TERRAIN[terr.terrain];
  return row ? row.move : 1;
}

function _cmdLinkOf(a, b) {
  var nbrs = _cmdAdjacency()[a] || [];
  for (var i = 0; i < nbrs.length; i++) if (nbrs[i].to === b) return nbrs[i];
  return null;
}

function routeEtaTicks(path, units) {
  if (!path || path.length < 2) return 0;
  var speed = _cmdSlowestSpeed(units);
  var hasArtillery = units && units.artillery > 0;
  var ticks = 0;
  for (var i = 1; i < path.length; i++) {
    var link = _cmdLinkOf(path[i - 1], path[i]);
    if (!link) return Infinity;                       // path disagrees with LINKS
    var perTick = BAL.MOVE_BASE * speed * _cmdTerrainMove(path[i]);
    if (link.sea) {
      perTick *= BAL.SEA_SPEED_MUL;
      if (hasArtillery) perTick *= BAL.SEA_ARTILLERY_SPEED_MUL;
    }
    if (!(perTick > 0)) return Infinity;
    ticks += link.dist / perTick;
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// applyCommand
// ---------------------------------------------------------------------------

// Zero every unit kind the command did not ask for. `types` absent, empty or
// not an array means "all kinds" — the pre-existing behaviour, unchanged.
// Returns a NEW bundle; nothing here mutates its argument.
function _cmdFilterTypes(units, types) {
  if (!Array.isArray(types) || !types.length) return units;
  var keep = {};
  for (var i = 0; i < types.length; i++) keep[types[i]] = true;
  var order = BAL.UNIT_ORDER, out = emptyUnits();
  for (var j = 0; j < order.length; j++) {
    var t = order[j];
    if (keep[t]) out[t] = units[t];
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a source actually hands over for a given fraction.
//
// THE ONE PLACE THE AMOUNT IS DECIDED. render/select.js draws its preview from
// this same function rather than calling splitUnits() itself, because the two
// used to be separate expressions that happened to agree — and known-issue #18
// is exactly the failure that arrangement produces: a readout that answers a
// different question from the one on screen and never looks wrong. Sharing a
// helper is not sharing a decision; this IS the decision.
//
// BAL.SEND_KEEP_UNITS is held back off the top, whatever the fraction. Logistic
// growth is proportional to `units`, so a station emptied to exactly zero is
// dead ground that can never recover — see the constant's own comment. The
// clamp is proportional across the three types, so what stays behind is a
// scaled-down copy of the garrison rather than an arbitrary slice of one kind.
//
// Returns a zeroed bundle when there is nothing spare; callers already reject
// that as 'too-few-units' against BAL.MIN_SEND_UNITS.
function sendPayload(units, fraction) {
  var total = totalUnits(units);
  var keep = (BAL && isFinite(BAL.SEND_KEEP_UNITS)) ? BAL.SEND_KEEP_UNITS : 0;
  var spare = total - keep;
  if (!(spare > 0)) return { infantry: 0, artillery: 0, armour: 0 };
  // min(): the fraction still wins whenever it asks for less than the ceiling,
  // so a 25% send from a full city is untouched by any of this.
  var f = Math.min(fraction, spare / total);
  return splitUnits(units, f);
}

// ---------------------------------------------------------------------------
// Supply-line helpers. Small on purpose: `supplyTo` is a plain sorted array of
// station ids, and the only two questions ever asked of it are "is this edge
// present" and "what does the list become". A Set would read better and would
// not survive a JSON snapshot, which is the whole basis of replay here.
// ---------------------------------------------------------------------------

function _cmdSupplyIndex(station, target) {
  var list = station && station.supplyTo;
  return (list && list.indexOf) ? list.indexOf(target) : -1;
}

// The list `station` should end up with. `adding` is the group's single verdict
// (see _cmdApplyOrder), not a per-station decision, and a null target means
// clear everything.
//
// Returns a NEW array always, never a mutated one: `setStationSupply` sorts and
// stores what it is given, and handing it the live array would make "did this
// change anything" unanswerable.
function _cmdNextSupply(station, target, adding) {
  if (target === null) return [];
  var list = (station.supplyTo || []).slice();
  var at = list.indexOf(target);
  if (adding) {
    if (at < 0) list.push(target);
  } else if (at >= 0) {
    list.splice(at, 1);
  }
  list.sort();
  return list;
}

function _cmdReject(result, source, reason) {
  result.rejected.push({ source: source, reason: reason });
  return result;
}

// Whole-command failure: nothing was touched, and the caller is told why.
function _cmdFail(result, reason) {
  result.ok = false;
  result.reason = reason;
  return result;
}

function applyCommand(state, cmd) {
  var result = {
    ok: false,
    type: cmd && cmd.type,
    reason: null,
    accepted: [],      // [{ source, target, units, path, eta, waveId }]
    rejected: [],      // [{ source, reason }]  — source null for whole-command
    waves: [],         // the wave objects created, in creation order
  };

  if (!state || !cmd || typeof cmd !== 'object') return _cmdFail(result, 'no-command');
  if (cmd.type === 'order') return _cmdApplyOrder(state, cmd, result);
  if (cmd.type !== 'send') return _cmdFail(result, 'unknown-type');
  if (state.winner) return _cmdFail(result, 'game-over');

  // --- whole-command validation: any failure here mutates nothing ---

  var owner = cmd.owner;
  if (!owner || !state.powers[owner]) return _cmdFail(result, 'unknown-owner');
  if (owner === 'neutral') return _cmdFail(result, 'neutral-cannot-act');
  if (state.powers[owner].alive === false) return _cmdFail(result, 'power-eliminated');

  var target = cmd.target;
  if (!target || !state.stations[target]) return _cmdFail(result, 'unknown-target');

  // A STANDING SEND MAY ONLY EVER AIM AT GROUND ITS OWNER ALREADY HOLDS.
  //
  // `standing: true` marks a wave created by a standing order (sim/movement.js)
  // rather than by a click. Those are logistics, not commitment: they must never
  // attack, never target ground the sender does not own and never initiate
  // combat (00-vision.md §8 as amended, data/tuning.js §11). Enforced here, at
  // the single mutation entry point, because that is the only place it cannot be
  // routed around — a caller that builds waves some other way does not exist.
  //
  // A whole-command failure rather than a per-source rejection: the target is
  // the part that is wrong, so no source could have saved it.
  if (cmd.standing && state.stations[target].owner !== owner) {
    return _cmdFail(result, 'standing-target-not-owned');
  }

  var fraction = (cmd.fraction === undefined || cmd.fraction === null)
    ? BAL.SEND_FRACTION_DEFAULT : cmd.fraction;
  if (typeof fraction !== 'number' || !isFinite(fraction) || fraction <= 0 || fraction > 1) {
    return _cmdFail(result, 'bad-fraction');
  }

  if (!Array.isArray(cmd.sources) || cmd.sources.length === 0) {
    return _cmdFail(result, 'no-sources');
  }

  // Dedupe and sort: the same source listed twice must not send twice, and the
  // wave ids a volley consumes must not depend on the caller's array order.
  var seen = {}, sources = [];
  for (var i = 0; i < cmd.sources.length; i++) {
    var sid = cmd.sources[i];
    if (typeof sid !== 'string' || seen[sid]) continue;
    seen[sid] = true;
    sources.push(sid);
  }
  sources.sort();

  // --- per-source validation. PLAN first, apply second, so a source that
  // fails validation cannot leave units subtracted with no wave to show for it.

  var plans = [];
  for (var s = 0; s < sources.length; s++) {
    var src = sources[s];
    var st = state.stations[src];
    if (!st) { _cmdReject(result, src, 'unknown-station'); continue; }
    if (st.owner !== owner) { _cmdReject(result, src, 'not-owned'); continue; }
    if (src === target) { _cmdReject(result, src, 'self-target'); continue; }

    var take = _cmdFilterTypes(sendPayload(st.units, fraction), cmd.types);
    if (totalUnits(take) < BAL.MIN_SEND_UNITS) { _cmdReject(result, src, 'too-few-units'); continue; }

    // OWNERSHIP-AWARE. A source whose only path to the target runs through
    // ground another power holds has no legal send, and is rejected here rather
    // than being quietly marched through the enemy. Per-source, like every
    // other check in this loop: the rest of the volley still goes.
    var path = commandRoute(src, target, state, owner);
    if (!path || path.length < 2) { _cmdReject(result, src, 'no-route'); continue; }

    plans.push({ source: src, units: take, path: path });
  }

  if (!plans.length) {
    result.ok = false;
    result.reason = result.rejected.length ? 'all-sources-rejected' : 'no-sources';
    return result;
  }

  // --- apply. Past this point nothing can fail. ---

  for (var p = 0; p < plans.length; p++) {
    var plan = plans[p];
    var station = state.stations[plan.source];
    subUnits(station.units, plan.units);

    // Each source gets its own wave, its own route and its own ETA. They are
    // NOT synchronised — see the header.
    var eta = routeEtaTicks(plan.path, plan.units);
    var wave = {
      id: state.nextWaveId++,
      owner: owner,
      from: plan.source,
      to: target,
      path: plan.path,
      hop: 0,
      progress: 0,
      units: plan.units,
      launchTick: state.tick,
      eta: eta,
    };
    // Set only when true, so a wave from an ordinary send is byte-identical to
    // the one this file produced before standing orders existed — which is what
    // keeps snapshot comparisons and replay determinism honest. Renderers read
    // it to draw a standing stream differently from a committed march.
    if (cmd.standing) wave.standing = true;
    state.waves.push(wave);
    result.waves.push(wave);
    result.accepted.push({
      source: plan.source,
      target: target,
      units: plan.units,
      path: plan.path,
      eta: eta,
      waveId: wave.id,
    });
  }

  result.ok = true;
  return result;
}

// ---------------------------------------------------------------------------
// { type:'order', owner, stations:[stationId,…], target: stationId }  — TOGGLE
// { type:'order', owner, stations:[stationId,…], target: null }       — CLEAR
//
// Edits the SUPPLY LINES of stations the owner holds (00-vision.md §8 as
// amended; sim/movement.js runs them). A station's `supplyTo` is a sorted list
// of cities it streams units to; an empty list is no standing order at all, and
// is the state every station starts and every captured station returns to.
//
// ONE VERB, MANY DESTINATIONS — and it took three passes to get here:
//
//   1. `feed` / `rally` / `hold`: bare labels, with the pipe between a feeder
//      and a sink INFERRED by nearest-seed matching. The sim picked the
//      destination and nothing on the board could tell you which one it picked.
//   2. `reinforce` / `defend` / `hold`, each naming one destination. Better —
//      the player states the pipe — but `defend` only fired when the sim judged
//      the target "threatened", which is the SAME hidden guess wearing a
//      different hat. Cut on the player's instruction: *"it's the same action in
//      the inverse."* The capacity ceiling already does defend's job out of a
//      number that is on screen — a full destination accepts nothing, so a quiet
//      front banks force at home by itself.
//   3. This. One verb, and `supplyTo` is a LIST because one target per source
//      made *"reinforce more than one city from a single city"* impossible.
//
// TOGGLE, AND THE GROUP DECIDES TOGETHER. Not per station: a mixed selection
// where some stations already feed the target would otherwise flip each one and
// leave the group in a state nobody asked for. So it works the way bold works on
// mixed text — if ANY station in the group lacks the edge, the whole group gains
// it; only when every one of them already has it does the group lose it. Which
// makes the gesture idempotent, and makes cancel free: press R and click the
// same city again.
//
// It goes through applyCommand for the reason everything else does: nothing in
// render/ or app/ may mutate state, and a supply line is state. The alternative
// — a UI writing state.stations[sid].supplyTo directly — would be a second path
// by which the board changes, and the whole replay/headless-testing property of
// this project rests on there not being one.
//
// Per-station validation, like a volley's sources: one unowned station in a
// list does not cost the player the other nine.
// ---------------------------------------------------------------------------
function _cmdApplyOrder(state, cmd, result) {
  if (!state.stations || !state.powers) return _cmdFail(result, 'no-command');
  if (state.winner) return _cmdFail(result, 'game-over');

  var owner = cmd.owner;
  if (!owner || !state.powers[owner]) return _cmdFail(result, 'unknown-owner');
  if (owner === 'neutral') return _cmdFail(result, 'neutral-cannot-act');
  if (state.powers[owner].alive === false) return _cmdFail(result, 'power-eliminated');

  // --- the destination ---
  //
  // Whole-command validation, like a volley's target: if the destination is
  // wrong then no source could have saved it, so rejecting the sources one at a
  // time would report the same fact ten times and bury the reason.
  //
  // A null target is not an error — it is CLEAR, the off switch, and it is the
  // same command shape with one argument left out rather than a second command
  // type. An off switch that needs its own message is one that eventually does
  // not get sent.
  var target = (cmd.target === undefined) ? null : cmd.target;
  if (target !== null) {
    if (typeof target !== 'string' || !state.stations[target]) {
      return _cmdFail(result, 'unknown-target');
    }
    // A SUPPLY LINE MAY ONLY EVER POINT AT GROUND ITS OWNER HOLDS. The same
    // boundary the `standing` waves are held to further up, checked here as
    // well because that check happens when the wave is BUILT — by which time the
    // line has been sitting on the station for minutes, and one aimed at an
    // enemy city would be an attack the player scheduled and forgot.
    // sim/movement.js drops a line whose destination changes hands; this stops
    // one being created that way in the first place.
    if (state.stations[target].owner !== owner) {
      return _cmdFail(result, 'target-not-owned');
    }
  }

  if (!Array.isArray(cmd.stations) || cmd.stations.length === 0) {
    return _cmdFail(result, 'no-stations');
  }

  // Deduped and sorted for the same reason a volley's sources are: the caller's
  // array order must not be able to change the outcome or the log.
  var seen = {}, ids = [];
  for (var i = 0; i < cmd.stations.length; i++) {
    var sid = cmd.stations[i];
    if (typeof sid !== 'string' || seen[sid]) continue;
    seen[sid] = true;
    ids.push(sid);
  }
  ids.sort();

  // --- decide the direction ONCE, for the whole group ---
  //
  // Two passes over the same list. The first only reads, so that every station
  // that will actually be written is judged against the same verdict — a single
  // pass that decided as it went would add the edge to the first station and
  // then remove it from the second, which is the incoherent per-station toggle
  // this exists to avoid.
  //
  // Stations that will be rejected below (not ours, unknown, the target itself)
  // are excluded from the vote as well as from the write: a city we do not own
  // has no opinion about what our group is doing.
  var adding = false;
  if (target !== null) {
    for (var v = 0; v < ids.length; v++) {
      var vst = state.stations[ids[v]];
      if (!vst || vst.owner !== owner || ids[v] === target) continue;
      if (_cmdSupplyIndex(vst, target) < 0) { adding = true; break; }
    }
  }

  for (var j = 0; j < ids.length; j++) {
    var id = ids[j];
    var st = state.stations[id];
    if (!st) { _cmdReject(result, id, 'unknown-station'); continue; }
    // You may only order your own cities. Commanding a rival's station is the
    // same boundary the send rules draw.
    if (st.owner !== owner) { _cmdReject(result, id, 'not-owned'); continue; }
    // A city cannot supply itself. Per-station rather than whole-command:
    // marqueeing the front and clicking one of the cities in it is the normal
    // way to say "everyone else feed this one", and dropping the other nine
    // because the destination was caught in the marquee would be maddening.
    if (id === target) { _cmdReject(result, id, 'self-target'); continue; }

    // `changed` is the difference between "this command applied to the station"
    // and "this station is now different", and they are NOT the same. Clearing
    // a group in which nobody had a supply line accepts every station and
    // changes none; a group toggle in which one member already had the line
    // changes the others and not it. A UI that counts `accepted` reports "3
    // cities cleared" when it cleared nothing — which is exactly the false
    // confirmation the banner exists to prevent, so the honest number is
    // produced HERE rather than recovered by the caller diffing state around
    // the call (known-issues #18: a readout must not answer a question of its
    // own by a route the decision did not take).
    var before = (st.supplyTo || []).length;
    var next = _cmdNextSupply(st, target, adding);
    if (typeof setStationSupply === 'function') setStationSupply(state, id, next);
    else st.supplyTo = next;
    result.accepted.push({
      station: id,
      target: target,
      added: target !== null && adding,
      changed: (st.supplyTo || next).length !== before,
    });
  }

  if (!result.accepted.length) {
    result.reason = result.rejected.length ? 'all-stations-rejected' : 'no-stations';
    return result;
  }
  result.ok = true;
  return result;
}
