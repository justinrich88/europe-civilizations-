// sim/development.js — 04-development.md, first prototype.
//
// "Stations become things you invest in, not just numbers you accumulate."
//
// THE PROBLEM THIS FIXES IS ARITHMETIC, NOT TASTE. Growth is
// rate * u * (1 - u/cap), which peaks at half capacity and falls to zero at
// full — so every unit held above cap/2 earns less than the same unit would in
// a half-empty station somewhere else. Holding is not merely unrewarded, past
// cap/2 it is STRICTLY DOMINATED, and the optimal line is to keep every city
// near half and ship the surplus forever. That is precisely the "always be
// moving" feel that was reported. The game was working as designed and the
// design was wrong.
//
// ONE RULE, TWO HALVES:
//
//     Spend units once to BUILD a tier.
//     The OPERATING tier then tracks the garrison standing in the station.
//
// Build is the sink; garrison is the rent. A spend alone does not reward
// holding — worse, the growth curve refunds it, because spending down drops you
// toward cap/2 where growth peaks. A held-unit threshold alone rewards holding
// but costs nothing, since the units are still your garrison and still available
// tomorrow. Both together are the only version where holding is paid for.
//
// TWO REQUESTED BEHAVIOURS FALL OUT FOR FREE, with no new state:
//   * "a cost of it being destroyed" — an attacker kills garrison, the garrison
//     drops below a tier line, the development degrades. No damage model, no
//     development hit points.
//   * "a cost to rebuild" — regrow the garrison and the tier returns. Because
//     the station is now LOW, growth is fast, so recovery is responsive. This is
//     the logistic curve working FOR the mechanic instead of against it.
//
// WHAT IS IN THIS PROTOTYPE AND WHAT IS NOT — say it here, because a half-built
// mechanic that reads as finished is worse than an obviously unfinished one:
//
//   built                the full loop. Spend, tier, operating tier tracking
//                        garrison, capital-only tier 3, capture destroys it.
//   fortification        REAL EFFECT, wired into sim/combat.js's additive block.
//   port, factory        buildable and tracked, NO EFFECT YET. The choice
//                        between the three is the design's actual decision
//                        (§5: "one per station, choosing is the decision") so it
//                        is playable now — but nothing on screen may claim an
//                        effect that does not exist, and render/readout.js says
//                        "no effect yet" in words for those two.
//
// Nothing here touches document, Math.random or Date.now. Every function is a
// pure derivation from STATIONS/POWERS plus the station's own state, which is
// what lets the renderer ask rather than recompute (CLAUDE.md: one derivation
// rule, one implementation).
//
// Private helpers are `_dev…`.

'use strict';

if (typeof totalUnits !== 'function') {
  console.error('[sim/development] no totalUnits at load — core/state.js must come ' +
    'BEFORE sim/development.js. Every operating tier will throw.');
}

// The three developments, in a fixed order so any UI listing them is stable.
var DEV_KINDS = ['fort', 'port', 'factory'];

// Human names, here rather than in the renderer: the sim owns what a thing IS.
var DEV_NAMES = { fort: 'Fortification', port: 'Port', factory: 'Factory' };

// Which kinds have an effect wired up. Data rather than a comment, so the
// readout can say "no effect yet" from the same source of truth that decides it
// (known-issues #18 — a readout must not answer from its own private opinion).
var DEV_LIVE = { fort: true, port: false, factory: false };

// Station ids touching at least one sea link, computed once off LINKS. §5 puts
// ports at "the stations touching a sea: true link" and the count is a measured
// property of the map, not a list to maintain by hand.
var _DEV_COASTAL = null;

function _devCoastal() {
  if (_DEV_COASTAL) return _DEV_COASTAL;
  _DEV_COASTAL = {};
  if (typeof LINKS === 'undefined' || !LINKS) return _DEV_COASTAL;
  for (var i = 0; i < LINKS.length; i++) {
    if (!LINKS[i].sea) continue;
    _DEV_COASTAL[LINKS[i].a] = true;
    _DEV_COASTAL[LINKS[i].b] = true;
  }
  return _DEV_COASTAL;
}

// Capital station ids. Static — a captured Berlin is still a capital, because
// eligibility that moved as capitals fell would make the fortification ceiling
// a target the player cannot plan against (§7).
var _DEV_CAPITALS = null;

function _devCapitals() {
  if (_DEV_CAPITALS) return _DEV_CAPITALS;
  _DEV_CAPITALS = {};
  if (typeof POWERS === 'undefined' || !POWERS) return _DEV_CAPITALS;
  var ids = Object.keys(POWERS).sort();
  for (var i = 0; i < ids.length; i++) {
    var cap = POWERS[ids[i]].capital;
    if (cap) _DEV_CAPITALS[cap] = true;
  }
  return _DEV_CAPITALS;
}

// Fixtures that swap data/ out must be able to drop these, same contract as
// resetSimCaches() in sim/growth.js.
function resetDevCaches() {
  _DEV_COASTAL = null;
  _DEV_CAPITALS = null;
}

// Is this station a capital? Exported because the renderer and the readout both
// want to explain the tier-3 rule and neither should re-derive it.
function isCapitalStation(sid) {
  return !!_devCapitals()[sid];
}

// The kinds legal at this station, sorted by DEV_KINDS order.
//
//   fort      every station
//   port      the stations touching a sea link
//   factory   the `producer` stations
//
// Measured on the live map, and the numbers are the design's own argument: 51 of
// 108 stations have more than one option, and only 3 are both producer and
// coastal — those face a genuine three-way choice and should feel special.
function developmentOptions(sid) {
  var d = (typeof STATIONS !== 'undefined' && STATIONS) ? STATIONS[sid] : null;
  if (!d) return [];
  var out = ['fort'];
  if (_devCoastal()[sid]) out.push('port');
  if (d.type === 'producer') out.push('factory');
  return out;
}

// Highest tier this kind may ever reach at this station.
//
// Fortification stops at 2 everywhere but capitals. That is not a balance tweak,
// it is the answer to §7's stalemate risk: fortification is available at all 108
// stations and the factory that counters it at 16, so unbounded fortification
// makes defensive investment seven times more available than its answer.
function developmentMaxTier(sid, kind) {
  if (developmentOptions(sid).indexOf(kind) < 0) return 0;
  var cap = BAL.DEV.MAX_TIER[kind] || 0;
  if (kind === 'fort' && isCapitalStation(sid)) {
    return BAL.DEV.CAPITAL_FORT_MAX_TIER;
  }
  return cap;
}

// Units needed to build `tier` (1-based) at this station. A fraction of the
// station's OWN capacity, so "about two-thirds full" means the same thing on a
// capacity-13 village and a capacity-74 metropolis.
function developmentCost(sid, tier) {
  var d = (typeof STATIONS !== 'undefined' && STATIONS) ? STATIONS[sid] : null;
  if (!d || tier < 1 || tier > BAL.DEV.COST_FRACTION.length) return Infinity;
  return BAL.DEV.COST_FRACTION[tier - 1] * d.capacity;
}

// The tier actually PAID FOR at this station. 0 for nothing built.
function builtTier(state, sid) {
  var st = state && state.stations ? state.stations[sid] : null;
  var dev = st && st.development;
  return (dev && dev.tier) ? dev.tier : 0;
}

// The kind built here, or null.
function developmentKind(state, sid) {
  var st = state && state.stations ? state.stations[sid] : null;
  return (st && st.development) ? st.development.kind : null;
}

// The tier currently RUNNING — min(built, garrison / (0.25 * capacity)).
//
// The whole mechanic is in the gap between this and builtTier. A tier-3 fortress
// held by a skeleton garrison fights as tier 1, and spotting that across the
// board is the skill the mechanic creates.
//
// No hysteresis, deliberately (§4). A tier tracking garrison is not flickering,
// it is reporting; hysteresis is only needed if a boundary sits where units
// naturally oscillate, and the boundaries sit at quarter-capacity marks while
// growth is smooth. Revisit only if playtesting shows a station drumming on a
// line.
function operatingTier(state, sid) {
  var built = builtTier(state, sid);
  if (built <= 0) return 0;
  var d = STATIONS[sid];
  var step = BAL.DEV.OPERATE_FRACTION * d.capacity;
  if (!(step > 0)) return built;
  var held = totalUnits(state.stations[sid].units);
  var can = Math.floor(held / step);
  return can < built ? (can < 0 ? 0 : can) : built;
}

// Garrison needed for the next operating step, or null when already at the
// built tier. Exported so the rail can print "8.6 more units" without
// recomputing the rule — the same reason standingOrderNext exports `shortBy`.
function operatingShortBy(state, sid) {
  var built = builtTier(state, sid);
  if (built <= 0) return null;
  var op = operatingTier(state, sid);
  if (op >= built) return null;
  var step = BAL.DEV.OPERATE_FRACTION * STATIONS[sid].capacity;
  var need = (op + 1) * step;
  var held = totalUnits(state.stations[sid].units);
  return need - held;
}

// Additive defence power contributed by this station's development, in the same
// units as BAL.DEFENSE_BONUS_POWER's input — i.e. it is added to fortLevel, and
// therefore goes through the existing scale-in and artillery-strip path rather
// than around it.
//
// Reads the OPERATING tier, not the built one, which is what makes garrisoning a
// fortress matter and what makes a raid degrade it for free.
function developmentFortLevel(state, sid) {
  if (developmentKind(state, sid) !== 'fort') return 0;
  return operatingTier(state, sid) * BAL.DEV.FORT_POWER_PER_TIER;
}

// Can `owner` build the next tier here, and what stops them?
//
// Returns { ok, kind, tier, cost, reason }. ONE function, used by applyCommand to
// decide and by the readout to explain, because two implementations of this rule
// is the defect this project has logged five times — and here it would show up as
// a rail offering a build the command then refuses.
function developmentPlan(state, sid, owner, kind) {
  var out = { ok: false, kind: kind || null, tier: 0, cost: Infinity, reason: null };
  var st = state && state.stations ? state.stations[sid] : null;
  if (!st) { out.reason = 'unknown-station'; return out; }
  if (st.owner !== owner) { out.reason = 'not-owned'; return out; }

  var have = developmentKind(state, sid);
  if (have) {
    // §5: one per station, and it can never be CHANGED — only lost with the
    // station. So an explicit kind that disagrees is a rejection rather than a
    // silent switch, which would be the expensive kind of surprise.
    if (kind && kind !== have) { out.reason = 'already-developed'; out.kind = have; return out; }
    out.kind = have;
  } else if (!kind) {
    var opts = developmentOptions(sid);
    // Exactly one legal option is the case for 57 of 108 stations, and there
    // `b` should just build it (§8). More than one and the player has to choose;
    // this returns the reason so the UI can focus its build section rather than
    // guess on their behalf.
    if (opts.length === 1) out.kind = opts[0];
    else { out.reason = 'choose-kind'; return out; }
  }

  var max = developmentMaxTier(sid, out.kind);
  if (max <= 0) { out.reason = 'not-legal-here'; return out; }

  var next = builtTier(state, sid) + 1;
  if (next > max) { out.reason = 'at-max-tier'; out.tier = max; return out; }
  out.tier = next;
  out.cost = developmentCost(sid, next);

  // Units must be PRESENT in the station. Build is self-funded: you spend what
  // this city grew, not what you shipped in. That keeps development a local
  // decision about a city you actually built up, and it blocks the strategic
  // version where safe interior reserves are pumped into frontier developments —
  // which would make rear-area safety compound and lean hard into the snowball.
  var held = totalUnits(st.units);
  if (held - out.cost < BAL.DEV.MIN_REMAINING) { out.reason = 'too-few-units'; return out; }

  out.ok = true;
  return out;
}
