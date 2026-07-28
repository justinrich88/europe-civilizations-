"use strict";
// core/vision.js — the fog gate. Milestone 5.7, stage 1.
//
// ONE function decides what a power may READ from a complete state:
//
//   stationVision(sid)     -> 1 | 2            static, from the station record
//   visibleTo(state, pid)  -> { sid: 0|1|2 }   0 hidden, 1 fogged, 2 visible
//
// The state stays TOTAL and the reads are made PARTIAL
// (02-visibility-and-sea.md §1). That is the whole architecture: two states
// that differ only in what somebody has seen would no longer be comparable, so
// seeded replay, byte-identical 1x-vs-4x and headless determinism all depend on
// fog living outside the simulation.
//
// Level 1 (fogged — "the station as of when you last saw it") arrives in stage
// 2 with memory. Nothing here remembers anything: today every station is either
// 2 or 0.
//
// ---------------------------------------------------------------------------
// Why this file is in core/ and not anywhere else
// ---------------------------------------------------------------------------
//
//   sim/     Forbidden by the design. The moment fog is inside the sim,
//            determinism testing gets much harder and every existing sim test
//            needs a visibility fixture. `test/fog-tests.js` asserts as a
//            TESTED FACT that no file under sim/ so much as names these
//            functions, because a comment saying "sim must not call this" is
//            not a check.
//   render/  test/node.js loads no render/ file at all, so fog would ship with
//            ZERO headless coverage (known-issues #9, #15, #20 are all this
//            same hole). And ai/score.js loads before every render file, so the
//            AI could not call it.
//   ai/      Declared optional — a build with ai/ deleted must still run — so
//            the renderer's masking would vanish along with the AI.
//   data/    May not reference state (01-data-schema.md).
//
// core/ is what is left, and it is also correct: this is a derived fact about
// state, which is what core/state.js is for.
//
// ---------------------------------------------------------------------------
// Performance — settled. DO NOT ADD A CACHE.
// ---------------------------------------------------------------------------
//
// Measured on the live 108-station / 236-link board, this implementation, seed
// 100 at t=4000, 20,000 calls each:
//
//   visibleTo, mid-game (11 of 108 owned)        24.3us
//   visibleTo, worst case (100 of 108 owned)     38.6us
//   stepTick, same board                        671.5us
//
// So the worst case is 5.8% of one tick and 0.23% of a 16.67ms frame, called
// once per frame per viewer. The cost is dominated by allocating the 108-key
// result — which is the price of being pure, and is not worth removing. A
// per-frame recompute with no stored index is correct, and it honours
// known-issues #9's warning against an index that is a second copy of a fact
// invalidated by every single capture.
//
// If profiling ever genuinely contradicts that, the sanctioned memo key is
// (state object identity, state.ownerEpoch, pid) — the same key
// `_moveOwnSearch`'s `_ownRouteCache` already uses in sim/movement.js, because
// ownerEpoch is the exact and total invalidation signal for visibility. Report
// the measurement first; do not build it unilaterally.
//
// ---------------------------------------------------------------------------
// House rules honoured here
// ---------------------------------------------------------------------------
//
//   * Private helpers are prefixed `_vis`, by FILE and not by subsystem
//     (known-issues #12 — `_ai` was not specific enough and #9 recurred).
//   * Iteration is over the sorted STATION_IDS and over LINKS in array order,
//     never over Object.keys(state.stations): key order is a real determinism
//     hazard and no other test can see it.
//   * Nothing in this file touches the DOM, the wall clock, or unseeded
//     entropy. (core/util.js does reach the DOM, so core/ is not DOM-free as a
//     layer — this file is, and is asserted to be.)
//   * visibleTo is PURE: it reads state and returns a fresh object. It writes
//     nothing, not even a scratch field on a station.

// How many link-hops a station sees for whoever holds it.
//
// The value lives on the station record in data/stations.js and is assigned by
// tools/build-stations.js: 1 by default, 2 for every `defensive` station and
// for a short authored table of observation points (the Straits of Dover, the
// Bosphorus, the Skagerrak, the German Baltic shore, the Strait of Otranto).
// It is a NUMERIC PROPERTY rather than a fifth station type because 00-vision.md
// §8 already spends the silhouette budget on the four types that exist.
//
// Defaults to 1 for an unknown id or a station record written before the field
// existed, so a stale snapshot degrades to minimum vision rather than throwing.
function stationVision(sid) {
  if (typeof STATIONS !== "object" || !STATIONS) return 1;
  var st = STATIONS[sid];
  if (!st) return 1;
  var v = st.vision;
  return (typeof v === "number" && isFinite(v) && v >= 1) ? v : 1;
}

// What `pid` may read on this board, as { stationId: level }.
//
//   2  visible — held by pid, or within stationVision() hops of a station it
//                holds, counted over LINKS
//   1  fogged  — not produced yet; stage 2 (memory) is the only thing that can
//                mint a 1, and it is deliberately not built here
//   0  hidden  — everything else
//
// Vision traverses ALL links regardless of who holds the ground in between,
// including `sea: true` crossings. Sight is not a march: an army may not walk
// through a rival's city, but a lookout on the far shore still sees it.
//
// Every station id gets an entry, so a caller never has to distinguish "hidden"
// from "absent" — a missing key is the shape that produces an accidental
// `undefined` in a renderer.
function visibleTo(state, pid) {
  var out = {};
  if (typeof STATION_IDS === "undefined" || !STATION_IDS.length) return out;

  var ids = STATION_IDS;
  var i, sid;

  // `budget` is hops of sight REMAINING at a station: -1 means unreached, 0
  // means seen but with nothing left to pass on. Seeding it with the owner's
  // own vision and decrementing per hop is what lets a 2-hop citadel and a
  // 1-hop city share one traversal.
  var budget = {};
  for (i = 0; i < ids.length; i++) {
    sid = ids[i];
    out[sid] = 0;
    budget[sid] = -1;
  }

  var stations = (state && state.stations) ? state.stations : null;
  if (!stations) return out;

  var reach = 0;
  for (i = 0; i < ids.length; i++) {
    sid = ids[i];
    var st = stations[sid];
    if (!st || st.owner !== pid) continue;
    out[sid] = 2;
    var v = stationVision(sid);
    if (v > budget[sid]) budget[sid] = v;
    if (v > reach) reach = v;
  }
  if (!reach) return out;                 // holds nothing: sees nothing

  if (typeof LINKS === "undefined" || !LINKS) return out;
  _visRelax(out, budget, reach);
  return out;
}

// Spread `budget` outward over LINKS until it is exhausted.
//
// One pass per hop of the deepest sight on the board (`reach`, at most 2 today)
// is sufficient: each pass can only ever move sight forward, so `reach` passes
// reach everything reachable. A pass may in fact carry sight further than one
// hop when link order happens to favour it, which is harmless — a budget is
// only ever written as `neighbour's budget - 1`, so every value it holds is one
// a real path could have delivered.
//
// Deterministic without depending on link order: the result is the fixpoint of
// a max, so no ordering can change it. LINKS is walked in array order anyway.
function _visRelax(out, budget, reach) {
  for (var hop = 0; hop < reach; hop++) {
    var changed = false;
    for (var j = 0; j < LINKS.length; j++) {
      var l = LINKS[j];
      // Sea crossings are traversed exactly like roads. `l.sea` is deliberately
      // not read here; a lookout does not care what is between.
      if (budget[l.a] - 1 > budget[l.b]) {
        budget[l.b] = budget[l.a] - 1;
        out[l.b] = 2;
        changed = true;
      }
      if (budget[l.b] - 1 > budget[l.a]) {
        budget[l.a] = budget[l.b] - 1;
        out[l.a] = 2;
        changed = true;
      }
    }
    if (!changed) return;
  }
}
