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
//     { type:'send', owner, sources:[stationId,…], target:stationId, fraction }
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
// routeBetween() there is the real thing and is authoritative; this exists so
// commands.js is independently testable and so a missing movement module
// produces a wrong ETA rather than a crash inside a validation path.
function _cmdFallbackRoute(fromSid, toSid) {
  if (fromSid === toSid) return [fromSid];
  var adj = _cmdAdjacency();
  if (!adj[fromSid] || !adj[toSid]) return null;
  var prev = {}, seen = {};
  var queue = [fromSid];
  seen[fromSid] = true;
  while (queue.length) {
    var cur = queue.shift();
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
function commandRoute(fromSid, toSid) {
  if (typeof routeBetween === 'function') return routeBetween(fromSid, toSid);
  return _cmdFallbackRoute(fromSid, toSid);
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
  if (cmd.type !== 'send') return _cmdFail(result, 'unknown-type');
  if (state.winner) return _cmdFail(result, 'game-over');

  // --- whole-command validation: any failure here mutates nothing ---

  var owner = cmd.owner;
  if (!owner || !state.powers[owner]) return _cmdFail(result, 'unknown-owner');
  if (owner === 'neutral') return _cmdFail(result, 'neutral-cannot-act');
  if (state.powers[owner].alive === false) return _cmdFail(result, 'power-eliminated');

  var target = cmd.target;
  if (!target || !state.stations[target]) return _cmdFail(result, 'unknown-target');

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

    var take = splitUnits(st.units, fraction);
    if (totalUnits(take) < BAL.MIN_SEND_UNITS) { _cmdReject(result, src, 'too-few-units'); continue; }

    var path = commandRoute(src, target);
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
