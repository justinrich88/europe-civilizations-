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
function commandRoute(fromSid, toSid, state, pid) {
  var canPass = null;
  if (state && state.stations && pid) {
    if (typeof routeFor === 'function') return routeFor(state, pid, fromSid, toSid);
    canPass = function (sid) {
      var st = state.stations[sid];
      return !!st && (st.owner === pid || st.owner === 'neutral');
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

    var take = _cmdFilterTypes(splitUnits(st.units, fraction), cmd.types);
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
// { type:'order', owner, stations:[stationId,…], order:'hold'|'rally'|'feed' }
//
// Sets a STANDING ORDER on stations the owner holds (00-vision.md §8 as
// amended; sim/movement.js runs them). 'hold' is the default and the off
// switch, so clearing an order is the same command with the same shape.
//
// It goes through applyCommand for the reason everything else does: nothing in
// render/ or app/ may mutate state, and a station's order is state. The
// alternative — a UI writing state.stations[sid].order directly — would be a
// second path by which the board changes, and the whole replay/headless-testing
// property of this project rests on there not being one.
//
// ADDITIVE. Before this existed, any cmd.type other than 'send' failed with
// 'unknown-type' and touched nothing; every pre-existing caller still gets
// byte-identical behaviour, exactly as cmd.types was added.
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

  var order = cmd.order;
  var known = (typeof isStationOrder === 'function')
    ? isStationOrder(order)
    : (order === 'hold' || order === 'rally' || order === 'feed');
  if (!known) return _cmdFail(result, 'unknown-order');

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

  for (var j = 0; j < ids.length; j++) {
    var id = ids[j];
    var st = state.stations[id];
    if (!st) { _cmdReject(result, id, 'unknown-station'); continue; }
    // You may only give orders to your own cities. Setting one on a rival's
    // station would be commanding ground you do not hold, which is the same
    // boundary the send rules draw.
    if (st.owner !== owner) { _cmdReject(result, id, 'not-owned'); continue; }
    if (typeof setStationOrder === 'function') setStationOrder(state, id, order);
    else st.order = order;
    result.accepted.push({ station: id, order: order });
  }

  if (!result.accepted.length) {
    result.reason = result.rejected.length ? 'all-stations-rejected' : 'no-stations';
    return result;
  }
  result.ok = true;
  return result;
}
