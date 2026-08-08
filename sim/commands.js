'use strict';

// ---------------------------------------------------------------------------
// sim/commands.js — the SOLE mutation entry point for player and AI alike.
//
// Everything that changes the board outside of a tick goes through
// applyCommand(). That is what makes headless testing, replay and Monte Carlo
// batches free: a game is a seed plus an ordered list of commands.
//
// Three commands: the many-to-one volley from 00-vision.md §8, the standing
// supply order, and `build` (04-development.md). The volley first:
//
//     { type:'send', owner, sources:[stationId,…], target:stationId, fraction }
//
// There used to be an optional `types` narrowing the send to a subset of unit
// kinds. It went with the kinds themselves (C1); a send is now a fraction and
// nothing else.
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
// `standingOnly` keeps a supply line on its owner's own ground (B1). Passage is
// for armies, not for logistics — see the note at routeFor() in sim/movement.js
// for why an unattended trickle routed through hostile country is worse than no
// route at all. The fallback below mirrors it, as it always has.
function commandRoute(fromSid, toSid, state, pid, standingOnly) {
  var canPass = null;
  if (state && state.stations && pid) {
    if (typeof routeFor === 'function') return routeFor(state, pid, fromSid, toSid, standingOnly);
    canPass = function (sid) {
      var st = state.stations[sid];
      if (!st) return false;
      return standingOnly ? st.owner === pid : true;
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
// TOMBSTONE — C1. `_cmdSlowestSpeed()` stood here and walked a stack for its
// slowest type, so that mixed stacks stayed together and the stagger in a
// volley came from different SOURCES rather than from a stack coming apart
// mid-march. With one profile every army moves at BAL.UNIT.speed, so the
// stagger now comes from source distance ALONE — which is what §8 always
// claimed it came from, and is now true without qualification.
// ---------------------------------------------------------------------------

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

// TAKES NO STACK. It used to take the units being sent, because a stack's ETA
// depended on what was in it; every army now walks at the same speed, so the
// path is the whole question. The parameter is REMOVED rather than kept and
// ignored — an argument that no longer affects the answer is how a caller comes
// to believe it is asking a question it is not (known-issue #18).
function routeEtaTicks(path) {
  if (!path || path.length < 2) return 0;
  var speed = BAL.UNIT.speed;
  var ticks = 0;
  for (var i = 1; i < path.length; i++) {
    var link = _cmdLinkOf(path[i - 1], path[i]);
    if (!link) return Infinity;                       // path disagrees with LINKS
    var perTick = BAL.MOVE_BASE * speed * _cmdTerrainMove(path[i]);
    if (link.sea) perTick *= BAL.SEA_SPEED_MUL;
    if (!(perTick > 0)) return Infinity;
    ticks += link.dist / perTick;
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// applyCommand
// ---------------------------------------------------------------------------

// TOMBSTONE — C1. `_cmdFilterTypes()` stood here and zeroed every unit kind a
// `send` did not ask for, via a `cmd.types` field. The UI filter that fed it
// was already gone before this; the field is now gone from the command schema
// too (01-data-schema.md), because there is nothing left to filter.
//
// ---------------------------------------------------------------------------
// What a source actually hands over for a given fraction.
//
// THE ONE PLACE THE AMOUNT IS DECIDED. render/select.js draws its preview from
// this same function rather than doing the multiplication itself, because the
// two used to be separate expressions that happened to agree — and known-issue
// #18 is exactly the failure that arrangement produces: a readout that answers
// a different question from the one on screen and never looks wrong. Sharing a
// helper is not sharing a decision; this IS the decision.
//
// STILL TRUE AFTER C1, and worth saying because it looks like it stopped being
// worth a function. `units * fraction` is now the whole body, and writing that
// at the call site is precisely the two-expressions-that-agree arrangement #18
// describes — the clamp below is the part that would go missing.
//
// BAL.SEND_KEEP_UNITS is held back off the top, whatever the fraction. Logistic
// growth is proportional to `units`, so a station emptied to exactly zero is
// dead ground that can never recover — see the constant's own comment.
//
// Returns 0 when there is nothing spare; callers already reject that as
// 'too-few-units' against BAL.MIN_SEND_UNITS.
function sendPayload(units, fraction) {
  var keep = (BAL && isFinite(BAL.SEND_KEEP_UNITS)) ? BAL.SEND_KEEP_UNITS : 0;
  var spare = units - keep;
  if (!(spare > 0)) return 0;
  // min(): the fraction still wins whenever it asks for less than the ceiling,
  // so a 25% send from a full city is untouched by any of this.
  var f = Math.min(fraction, spare / units);
  return units * f;
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
  if (cmd.type === 'build') return _cmdApplyBuild(state, cmd, result);
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

    var take = sendPayload(st.units, fraction);
    if (take < BAL.MIN_SEND_UNITS) { _cmdReject(result, src, 'too-few-units'); continue; }

    // OWNERSHIP-AWARE. A source whose only path to the target runs through
    // ground another power holds has no legal send, and is rejected here rather
    // than being quietly marched through the enemy. Per-source, like every
    // other check in this loop: the rest of the volley still goes.
    var path = commandRoute(src, target, state, owner, !!cmd.standing);
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
    station.units -= plan.units;

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

// ---------------------------------------------------------------------------
// { type:'build', owner, stations:[stationId,…], kind? }   — 04-development.md
//
// Spend units standing in a station to buy the next development tier there.
// `kind` is OPTIONAL: omitted, a station with exactly one legal option builds it
// (57 of 108 stations), and a station with more than one is rejected
// 'choose-kind' so the UI can ask rather than guess.
//
// `stations`, not `sources`, matching the 'order' shape — a build is a thing you
// do TO cities, not a thing you send FROM them.
//
// THE FIRST VERB IN THIS GAME THAT IS NOT SELECT-AND-TARGET, and 00-vision.md §8's
// cut list names build queues explicitly. The cost is accepted with eyes open and
// bounded: one key, one rail section, no queue, no menu tree, nothing to cancel. A
// spend cannot exist without a spend gesture, and this is the smallest one there
// is.
//
// PER-STATION, LIKE 'order' AND UNLIKE 'send'. Marqueeing a front and pressing `b`
// should build in the cities that can afford it, not refuse the whole group
// because one of them is short. Every rejection names its own station.
//
// The decision itself is developmentPlan() in sim/development.js and is NOT
// duplicated here: the rail offers builds from the same function that accepts
// them, or it will eventually offer one this refuses.
function _cmdApplyBuild(state, cmd, result) {
  if (state.winner) return _cmdFail(result, 'game-over');
  if (typeof developmentPlan !== 'function') return _cmdFail(result, 'no-development-module');

  var owner = cmd.owner;
  if (!owner || !state.powers[owner]) return _cmdFail(result, 'unknown-owner');
  if (owner === 'neutral') return _cmdFail(result, 'neutral-cannot-act');
  if (state.powers[owner].alive === false) return _cmdFail(result, 'power-eliminated');
  if (!Array.isArray(cmd.stations) || cmd.stations.length === 0) {
    return _cmdFail(result, 'no-stations');
  }
  if (cmd.kind && DEV_KINDS.indexOf(cmd.kind) < 0) return _cmdFail(result, 'unknown-kind');

  // Deduped and sorted, for the same reason a volley's sources are: the same
  // station listed twice must not be charged twice, and the outcome must not
  // depend on the caller's array order.
  var seen = {}, ids = [];
  for (var i = 0; i < cmd.stations.length; i++) {
    var sid = cmd.stations[i];
    if (typeof sid !== 'string' || seen[sid]) continue;
    seen[sid] = true;
    ids.push(sid);
  }
  ids.sort();

  for (var k = 0; k < ids.length; k++) {
    var id = ids[k];
    var plan = developmentPlan(state, id, owner, cmd.kind);
    if (!plan.ok) { _cmdReject(result, id, plan.reason); continue; }

    var st = state.stations[id];
    // This block used to route through splitUnits() and carried a note saying
    // it was the copy that would go stale when the unit types collapsed
    // (04-development.md §9). The collapse happened, the prediction held, and
    // routing through the shared helper is exactly why the change here was two
    // lines: subtract the cost, floor at zero.
    var held = st.units;
    var f = (held > 0) ? ((held - plan.cost) / held) : 0;
    if (f < 0) f = 0;
    st.units = held * f;

    if (!st.development) st.development = { kind: plan.kind, tier: 0 };
    st.development.tier = plan.tier;

    logEvent(state, 'build', POWERS[owner].name + ' built ' + DEV_NAMES[plan.kind] +
      ' ' + plan.tier + ' at ' + STATIONS[id].name, id);

    result.accepted.push({
      station: id,
      kind: plan.kind,
      tier: plan.tier,
      cost: plan.cost,
      // The operating tier AFTER the spend, and it is usually LOWER than the tier
      // just paid for — that is the intended sequencing, not a bug. Paying tier 3
      // out of the overflow band leaves the station at half capacity, so the
      // thing you just built runs at tier 2 until you regrow it. Reported here so
      // a UI can say so instead of the player discovering it.
      operating: operatingTier(state, id),
    });
  }

  if (!result.accepted.length) {
    result.reason = result.rejected.length ? 'all-stations-rejected' : 'no-stations';
    return result;
  }
  result.ok = true;
  return result;
}

// ===========================================================================
// TICK-SCHEDULED COMMANDS — 07-roadmap.md A3
// ===========================================================================
//
// applyCommand() above executes NOW. That is correct for the AI, which runs
// inside the tick from a state every client shares, and it is wrong for input
// that arrives from outside — a click, and later a packet. Lockstep needs every
// command to carry the tick it executes on, so that two clients applying the
// same commands in the same order reach the same board.
//
// So input is a two-step now:
//
//     queueCommand(state, cmd)     -> puts it in state.queued for a named tick
//     commandsTick(state)          -> phase 1: drains everything now due
//
// applyCommand STAYS THE SOLE MUTATOR and the drain is one of its callers.
// Splitting the mutation across two functions would be the two-implementations
// defect this project has logged five times.
//
// WHY THE DRAIN IS PHASE 1, AHEAD OF growthTick
//
// It is the same argument sim/step.js already makes for putting aiTick at phase
// 0: an order is issued against the numbers currently on screen, and those are
// last tick's. Drain after growth and a queued send spends units the player
// could not see when they clicked. The phase order is part of the contract, and
// test/exact-tests.js's sibling in test/runner.js asserts this specific edge
// rather than trusting the comment.
//
// WHAT IS VALIDATED WHEN, AND WHY THAT SPLIT IS THE WHOLE DESIGN
//
//   queue time   SHAPE ONLY. Is there a command, does it name a type this sim
//                knows, does it name an owner. A typo must not sit in the queue
//                for 400ms and then fail somewhere nobody is looking.
//   drain time   EVERYTHING ELSE, by applyCommand, unchanged.
//
// A command CAN be legal when queued and rejected when drained — the target was
// captured in between, the source garrison was raided below the floor. That is
// not a bug and it must not be prevented: the board at drain time is the only
// board that exists. It is why state.cmdStats.rejected is a counter and not an
// alarm, and why anything wanting to know the outcome of a specific command has
// to wait for the tick rather than read a return value.
//
// ~~The consequence for the UI is real and is not paid here: render/select.js
// still calls applyCommand directly for 'send' and 'order', because it reads the
// result to draw its own confirmation.~~ **PAID 2026-08.** All three verbs now go
// through queueCommand, and the confirmation travels forward in time through the
// listener channel below.

// Command types this sim knows how to drain. Named explicitly rather than
// probed, so a typo'd type is rejected at the point of issue instead of sitting
// in the queue until it is drained and silently dropped.
var CMD_TYPES = ['send', 'order', 'build'];

// Schedule `cmd` for `atTick`, defaulting to the earliest tick that can still
// run it.
//
// READ `state.tick` CAREFULLY: it is incremented at the END of stepTick, so it
// names the tick ABOUT TO RUN, not one that has finished. So the default floor is
// `state.tick` and not `state.tick + 1`:
//
//   the player, between ticks   state.tick = T, tick T has not run. Scheduling
//                               for T means the drain at the head of the very
//                               next stepTick. Minimum latency, one meaning.
//   aiTick, inside phase 0      state.tick = T and tick T is HALF RUN — phase 1
//                               is still ahead. Scheduling for T therefore
//                               executes in the same tick, which is exactly what
//                               the AI does today by calling applyCommand
//                               directly. A caller inside the tick that wants
//                               NEXT tick must say `state.tick + 1`; it is not
//                               guessed here, because the two cases are
//                               indistinguishable from inside this function and
//                               a wrong guess is a one-tick desync.
//
// `+ 1` was tried first and it is wrong: it costs the player an entire extra
// tick of latency for nothing, and it made the "applies on the next tick" test
// need two stepTicks, which is the kind of off-by-one that ends up documented as
// behaviour.
//
// Returns { ok, tick, seq, reason }. `ok` means ACCEPTED INTO THE QUEUE and
// nothing more — see the validation note above. There is deliberately no way to
// ask this function whether the command will succeed.
//
// A tick in the past is clamped FORWARD to the floor rather than dropped or
// drained out of order. Dropping loses a player's click to a race they cannot
// see; clamping is the only option where the same call on two clients produces
// the same schedule.
function queueCommand(state, cmd, atTick) {
  if (!state || !cmd || typeof cmd !== 'object') return { ok: false, reason: 'no-command' };
  if (!Array.isArray(state.queued)) state.queued = [];
  if (typeof state.nextCmdSeq !== 'number') state.nextCmdSeq = 1;

  if (CMD_TYPES.indexOf(cmd.type) < 0) return { ok: false, reason: 'unknown-type' };
  // `owner` is required on every command shape (CLAUDE.md). Checked here as
  // well as in applyCommand because an ownerless command in the queue is a
  // command nobody can attribute when it fails four ticks later.
  if (!cmd.owner || typeof cmd.owner !== 'string') return { ok: false, reason: 'no-owner' };
  if (state.winner) return { ok: false, reason: 'game-over' };

  var floor = state.tick;
  var tick = (typeof atTick === 'number' && isFinite(atTick) && atTick > floor)
    ? Math.floor(atTick) : floor;
  var seq = state.nextCmdSeq++;

  state.queued.push({ tick: tick, seq: seq, cmd: cmd });
  if (state.cmdStats) state.cmdStats.queued++;
  return { ok: true, tick: tick, seq: seq, reason: null };
}

// Everything scheduled for this tick or earlier, in (tick, seq) order.
//
// `tick <= state.tick` rather than `=== state.tick` on purpose: a state restored
// from a snapshot taken before a pause, or advanced by a harness that skipped
// ticks, must still execute what it owes rather than silently strand it.
// Overdue is visible in the sort — earliest tick first — not swallowed.
function _cmdDue(state) {
  var due = [];
  for (var i = 0; i < state.queued.length; i++) {
    if (state.queued[i].tick <= state.tick) due.push(state.queued[i]);
  }
  due.sort(function (a, b) {
    if (a.tick !== b.tick) return a.tick - b.tick;
    return a.seq - b.seq;
  });
  return due;
}

// ---------------------------------------------------------------------------
// WHO HEARS ABOUT A DRAINED COMMAND — the other half of the A3 retrofit
// ---------------------------------------------------------------------------
//
// A command applied immediately hands its result back as a return value, and
// that is what render/select.js used to draw its confirmation banner: *"SUPPLYING
// LEIPZIG — 3 cities"*, or the refusal. A SCHEDULED command has no result at the
// moment it is issued, because the board it will be judged against does not exist
// yet. So the result has to travel forward in time to whoever asked for it.
//
// This is that channel. Three properties, and they are the whole design:
//
//   NOT IN STATE.        A listener is a function, and a function in `state`
//                        cannot survive snapshot() — which is the basis of
//                        replay and of reconnect. Putting the RESULTS in state
//                        instead would move every balance hash in the project
//                        for a value the sim never reads.
//   NOT READ BY THE SIM. Nothing below this line consults a listener. A client
//                        with none — every headless run, every balance sweep —
//                        plays the bit-identical game to a client with one.
//                        That is what makes this safe under lockstep, where one
//                        player has a UI and the server has none.
//   FIRED AFTER THE WHOLE DRAIN, never between two commands. Commands due on
//                        the same tick apply back to back with nothing running
//                        in between, so no listener can observe a half-drained
//                        tick or reorder an applyCommand call by being slow.
//
// THE CONTRACT ON A LISTENER IS THAT IT DOES NOT MUTATE STATE. It is a
// notification, not a phase (known-issue #13 — phases are not added lightly, and
// this deliberately is not one). A listener that mutates state is a desync by
// construction: it runs on the client that has a renderer and not on the one
// that does not.
//
// A throwing listener is caught and logged rather than allowed to abort the
// drain, for exactly the same reason: a renderer that throws must not stop the
// sim on the one client unlucky enough to be rendering. The catch is LOUD
// (known-issue #22) — a silent one here would hide the confirmation banner
// failing and look like a command that never arrived.
var _cmdListeners = [];

// Register `fn(cmd, res, note)`, called once per drained command with the
// command, the result applyCommand returned for it, and `{tick, seq}` — the seq
// queueCommand handed back, which is how a caller matches a result to the click
// that asked for it. Returns an unsubscribe function.
function onCommandResult(fn) {
  if (typeof fn !== 'function') return function () {};
  _cmdListeners.push(fn);
  return function () {
    var at = _cmdListeners.indexOf(fn);
    if (at >= 0) _cmdListeners.splice(at, 1);
  };
}

function _cmdNotify(notes) {
  if (!_cmdListeners.length || !notes.length) return;
  // A copy: a listener that unsubscribes itself while being notified must not
  // shorten the array being walked and skip the listener after it.
  var ls = _cmdListeners.slice();
  for (var i = 0; i < notes.length; i++) {
    for (var j = 0; j < ls.length; j++) {
      try {
        ls[j](notes[i].cmd, notes[i].res, { tick: notes[i].tick, seq: notes[i].seq });
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[sim/commands] a command listener threw; the drain ' +
            'continued without it', e);
        }
      }
    }
  }
}

// Phase 1 of the tick. Drains every due command through applyCommand.
//
// Results are counted, not returned: this is a phase, and phases return nothing
// (sim/step.js calls them in a loop). Anything that needs a specific command's
// outcome either reads the board or listens — see onCommandResult above.
function commandsTick(state) {
  if (!state || !Array.isArray(state.queued) || !state.queued.length) return;

  var due = _cmdDue(state);
  if (!due.length) return;

  // Remove the drained entries BEFORE applying any of them. A command whose
  // application queues another command — nothing does this today, and the build
  // verb makes it plausible — must not have its child drained in the same pass
  // and must not resurrect its parent. Filtering after the loop would do both.
  var keep = [];
  for (var i = 0; i < state.queued.length; i++) {
    if (state.queued[i].tick > state.tick) keep.push(state.queued[i]);
  }
  state.queued = keep;

  var notes = _cmdListeners.length ? [] : null;
  for (var j = 0; j < due.length; j++) {
    var res = applyCommand(state, due[j].cmd);
    if (notes) {
      notes.push({ cmd: due[j].cmd, res: res, tick: due[j].tick, seq: due[j].seq });
    }
    if (!state.cmdStats) continue;
    if (res && res.ok) state.cmdStats.applied++;
    else state.cmdStats.rejected++;
  }
  if (notes) _cmdNotify(notes);
}
