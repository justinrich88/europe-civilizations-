// render/waves.js — in-transit stacks: the markers moving along links, and the
// trail each one drags behind it.
//
// Owns #g-waves and nothing else (01-data-schema.md, "Layer ownership").
//
// Two rules from 00-vision.md §8 shape everything here:
//
//   * "Units in transit are visible as markers moving along links, strength
//     legible at a glance." A wave the player cannot see is a wave they cannot
//     plan against, and stacks arriving staggered is the defining mistake of
//     the game — you can only learn to avoid defeat in detail if you can watch
//     it happening.
//   * "Transit lines are in-flight trails, not standing supply." The trail
//     exists while the wave is travelling and vanishes the moment it lands. It
//     is drawn from the station the wave left to where the wave is NOW, so its
//     length reads as progress along the hop.
//
// A send is one-shot (§8) — nothing here is a route the player can manage, it
// is just a thing in the air.
//
// Wave records come from sim/movement.js:
//   { id, owner, path:[sid,…], hop, progress, units:{…} }
// path INCLUDES the origin, so path[hop] -> path[hop+1] is the link currently
// being crossed and `progress` is 0..1 along it.
//
// ── beachheads ───────────────────────────────────────────────────────────
//
// A wave whose FINAL hop is a sea link does not arrive all at once
// (02-visibility-and-sea.md §3b, sim/movement.js). It comes ashore over
// BAL.LANDING_TICKS — 12 sim-seconds — and carries `landing` while it does:
//
//   { ashore, total, per }        and w.units is what is STILL AT SEA.
//
// For the whole of that time the wave sits at hop = path.length-2, progress 1,
// i.e. exactly on the destination. Drawn naively it is a marker parked on a
// station for twelve seconds, which reads as a stuck wave — the most
// interesting thing in the game looking like a bug.
//
// Three changes, no second kind of object:
//
//   1. the marker stands OFF the beach, a fixed on-screen distance back along
//      the sea link, and stays there. It deliberately does not creep inshore as
//      the landing completes: a marker that ends up on the node reads as
//      "arrived", which is the failure being fixed.
//   2. a ring around the chip whose arc is the fraction STILL AT SEA, over a
//      faint track. Full at the first echelon, empty at the last. Same idiom as
//      the fullness and momentum rings on the stations.
//   3. the trail is reversed: instead of a streak dragged back to the station
//      just left, it is a short dashed lane THROUGH the marker aimed at the
//      beach, drifting shoreward and stopping short of the node. Marching is a
//      solid line behind; landing is a moving lane ahead.
//
// The number in the chip needs no special case at all — it is already
// floor(total of w.units), which during a landing IS the at-sea remainder. So
// the arc and the number say the same thing, one at a glance and one exactly.

'use strict';

// wave id -> { g, trail, chip, num, last… }. Nodes are created when a wave
// appears and removed when it lands; in between, only `transform` and the two
// trail endpoints move. Rebuilding a marker every frame would be the same
// mistake renderLive exists to avoid, at 60fps.
const WAVES = { node: Object.create(null), writes: 0 };

const WAVE_R = 7.5;

// How far offshore the marker holds, in board units at scale 1. Multiplied by
// cameraSymbolScale() so it is a constant distance ON SCREEN at every zoom,
// exactly like the marker it offsets.
// It has to clear the node's whole battle readout, not just its circle: the
// beach is almost always contested, so the momentum ring and the attacker's
// number under it are what the marker must not sit on top of. Measured on the
// real board rather than guessed — a contested station is 11 CSS px of radius
// and this marker is another 6, so anything under ~20 px between the two
// centres touches. 46 board units is ~24 px, which is a clear gap.
const WAVE_LAND_STANDOFF = 46;

// …but never past the middle of the crossing, so the marker always belongs to
// the shore it is landing on rather than to the one it sailed from.
//
// This cap BINDS at 1x on this map, and that is worth stating plainly: the sea
// links here are short next to the symbols — Mecklenburg to Norrkoping is the
// longest at 78 board units, about three and a half node diameters, and Dover
// to Lille is 27. At 1x there is only so much open water to stand off into, and
// the answer to that is the same as it is for the four cities stacked on the
// Ruhr: zoom in, which is what the camera and the symbol counter-scale exist
// for. From about 1.2x up the fixed standoff wins and the gap is constant.
const WAVE_LAND_MAX_FRAC = 0.5;

// How much water the leader leaves between its tip and the beach — enough to
// clear the node and the attacker count under it. Never more than 60% of the
// standoff, so on a crossing too short for the full clearance the leader is
// squeezed rather than inverted.
const WAVE_LAND_CLEAR = 15;

// How far the leader runs BEHIND the marker, out to sea. Without it the line
// starts at the marker's centre, the ring hides the first 10 units of it, and
// what is left between the ring and the clearance is a single dash — measured
// at Norrkoping, where the whole leader rendered as one 3px tick. Running it
// through the marker instead makes it a lane the marker is sitting in, which is
// both more visible and a truer picture: the water behind is where the rest of
// the force still is.
const WAVE_LAND_TAIL = 26;

// Ring radius, outside the chip (r 7.5) with room for its 1.2 halo. Kept tight:
// the ring is the second thing read at a beachhead, after the battle at the
// node itself, and every board unit of it is a board unit of clearance the
// standoff above has to find on a short crossing.
const WAVE_LAND_RING_R = 10;

// 1% steps, same "rewrite only on a visible change" rule as the station rings.
// One echelon is 1/120 of the force, so the arc moves slightly less than one
// bucket per tick and this costs at most one DOM write per tick.
const WAVE_LAND_BUCKETS = 100;

function resetWaveLayer() {
  const layer = byId('g-waves');
  if (layer) while (layer.firstChild) layer.removeChild(layer.firstChild);
  WAVES.node = Object.create(null);
  WAVES.writes = 0;
}

// Station position from the static table. A wave whose path references an
// unknown station is skipped rather than drawn at NaN — one missing marker is
// debuggable, an SVG full of NaN transforms is not.
function stationPos(sid) {
  if (typeof STATIONS === 'undefined' || !STATIONS) return null;
  const st = STATIONS[sid];
  return (st && st.pos && st.pos.length >= 2) ? st.pos : null;
}

function waveColor(ownerId) {
  const P = (typeof POWERS !== 'undefined') ? POWERS : null;
  const p = P && P[ownerId];
  return (p && p.color) ? p.color : '#c6d0dc';
}

function waveTotal(units) {
  if (!units) return 0;
  return (units.infantry || 0) + (units.artillery || 0) + (units.armour || 0);
}

// Build one marker. Called once per wave, ever.
function makeWaveNode(layer, w) {
  const color = waveColor(w.owner);

  // The trail lives in board coordinates and the marker is translated, so they
  // cannot be the same node. Trail first so the marker sits on top of it.
  const trail = el('line', 'wave-trail', { x1: 0, y1: 0, x2: 0, y2: 0 });
  // .style, not setAttribute. A presentation attribute loses to any stylesheet
  // rule, and a stray `.wave-trail { stroke: #ffffff }` did exactly that —
  // every trail on the board painted white while this line looked correct.
  // Known-issue #15: a visual property a renderer computes must be written as
  // a style, never as an attribute.
  trail.style.stroke = color;
  layer.appendChild(trail);

  const g = el('g', 'wave', { 'data-wave': w.id, 'data-owner': w.owner });
  const chip = el('circle', 'wave-chip', { r: WAVE_R });
  chip.style.fill = color;   // style, not attribute — same reason as the trail
  g.appendChild(chip);
  // Strength legible at a glance — the same "number is the interface" rule the
  // stations follow, just smaller because a stack is transient.
  const num = el('text', 'wave-units', { y: 0.5, text: '' });
  g.appendChild(num);
  layer.appendChild(g);

  return {
    g: g, trail: trail, chip: chip, num: num, n: -1, owner: w.owner,
    // Last written strings, so a marker that has not moved costs no DOM write.
    // A marching wave moves every frame and pays exactly what it did before; a
    // landing one is parked for 120 ticks and now pays nothing for it.
    tf: null, tl: null,
    land: null, landing: false,
  };
}

// ---------------------------------------------------------------------------
// Beachhead marker
// ---------------------------------------------------------------------------

// Where the marker holds while its force comes ashore: back along the sea link
// from the beach `b` toward the port `a`, a fixed distance on screen.
//
// Fixed, not proportional to what is left at sea. Position here means "these
// are the ones not in the fight yet", and a position that slides inshore as the
// landing finishes would end on the node — indistinguishable from an arrival,
// which is the whole thing this is here to avoid. The RING carries progress.
// Returns [markerX, markerY, leaderTailX, leaderTailY, leaderTipX, leaderTipY]
// — the marker's standoff point, and the two ends of the lane it sits in.
//
// The leader stops SHORT of the beach rather than touching it. A contested
// station carries the attacker's count in a band directly under the node, and
// a line run all the way in draws straight through that number — measured at
// Norrkoping, where the leader crossed the "35" ashore. Ending it a node's
// width out keeps it an arrow pointing at the beach instead of a scribble over
// the readout, and loses nothing: what the line says is "that way", not "this
// far".
function _wavLandGeom(a, b, k) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 0)) return [b[0], b[1], b[0], b[1], b[0], b[1]];
  const cap = len * WAVE_LAND_MAX_FRAC;
  let off = WAVE_LAND_STANDOFF * k;
  if (off > cap) off = cap;
  let clear = WAVE_LAND_CLEAR * k;
  if (clear > off * 0.6) clear = off * 0.6;
  // The tail stops short of the far shore for the same reason the tip stops
  // short of the near one: the port has a node and a number too.
  let tail = off + WAVE_LAND_TAIL * k;
  if (tail > len - clear) tail = len - clear;
  if (tail < off) tail = off;
  const ux = dx / len, uy = dy / len;
  return [
    b[0] + ux * off, b[1] + uy * off,
    b[0] + ux * tail, b[1] + uy * tail,
    b[0] + ux * clear, b[1] + uy * clear,
  ];
}

// Built on a wave's FIRST landing tick, never in makeWaveNode(). A board that
// has only seen land arrivals therefore has exactly the #g-waves DOM it had
// before this feature existed — "a land arrival is unchanged" is structural
// rather than asserted. Same reasoning as mapBattleNodes() in render/map.js.
//
// Inserted before the chip so the ring sits under the chip and its number: the
// count is the thing being read and nothing may cross it.
function _wavLandNodes(rec) {
  if (rec.land) return rec.land;
  const track = el('circle', 'wave-atsea-track', { r: WAVE_LAND_RING_R });
  // Starts at 12 o'clock and sweeps clockwise. A circle's path begins at 3
  // o'clock, so the rotation is what makes "how much is left" read off the top
  // of the marker rather than off its side.
  const arc = el('circle', 'wave-atsea', {
    r: WAVE_LAND_RING_R, pathLength: 100, transform: 'rotate(-90)',
  });
  rec.g.insertBefore(track, rec.chip);
  rec.g.insertBefore(arc, rec.chip);
  rec.land = { track: track, arc: arc, bucket: -1, color: null };
  return rec.land;
}

// The at-sea arc. Both writes are INLINE STYLES, not presentation attributes:
// a stylesheet rule silently outranks an attribute with no error anywhere
// (docs/testing/known-issues.md #15), and these are computed per frame.
function _wavLandArc(rec, w, color) {
  const land = _wavLandNodes(rec);
  const L = w.landing;
  const total = Number(L && L.total);
  const atSea = waveTotal(w.units);
  const frac = (isFinite(total) && total > 0) ? clamp(atSea / total, 0, 1) : 1;

  const bucket = Math.round(frac * WAVE_LAND_BUCKETS);
  if (bucket !== land.bucket) {
    land.bucket = bucket;
    const len = bucket * (100 / WAVE_LAND_BUCKETS);
    land.arc.style.strokeDasharray = len + ' ' + (100 - len);
    WAVES.writes++;
  }
  if (color !== land.color) {
    land.color = color;
    land.arc.style.stroke = color;
    WAVES.writes++;
  }
}

// Landing / not-landing is a class on the marker and on its trail, flipped once
// each way and never per frame. A wave never un-lands in the current sim, but
// the off-branch costs one boolean and means nothing here depends on that.
function _wavLandClass(rec, on) {
  if (on === rec.landing) return;
  rec.landing = on;
  rec.g.classList.toggle('is-landing', on);
  rec.trail.classList.toggle('is-landing', on);
  WAVES.writes += 2;
}

// renderWaves(state) — the pinned per-frame entry point (01-data-schema.md).
function renderWaves(state) {
  const layer = byId('g-waves');
  if (!layer || !state || !Array.isArray(state.waves)) return 0;
  const before = WAVES.writes;

  // Symbol counter-scale, read once per frame rather than once per wave.
  // Rounded so the transform string is stable and the DOM stays readable.
  const k = (typeof cameraSymbolScale === 'function')
    ? Math.round(cameraSymbolScale() * 100000) / 100000
    : 1;

  const seen = Object.create(null);

  for (let i = 0; i < state.waves.length; i++) {
    const w = state.waves[i];
    if (!w || !Array.isArray(w.path) || w.path.length < 2) continue;

    const hop = Math.min(w.hop | 0, w.path.length - 2);
    const a = stationPos(w.path[hop]);
    const b = stationPos(w.path[hop + 1]);
    if (!a || !b) continue;

    const key = String(w.id);
    seen[key] = true;
    let rec = WAVES.node[key];
    if (!rec) {
      rec = makeWaveNode(layer, w);
      WAVES.node[key] = rec;
    }

    // Two geometries, one marker. A wave in transit is at `progress` along the
    // hop and drags its trail behind it from the station it left. A wave coming
    // ashore stands off the beach and points its trail forward at it.
    const isLanding = !!w.landing;
    let x, y, x1, y1, x2, y2;
    if (isLanding) {
      const p = _wavLandGeom(a, b, k);
      x = p[0];
      y = p[1];
      x1 = p[2].toFixed(2); y1 = p[3].toFixed(2);
      x2 = p[4].toFixed(2); y2 = p[5].toFixed(2);
    } else {
      const t = clamp(Number(w.progress) || 0, 0, 1);
      x = lerp(a[0], b[0], t);
      y = lerp(a[1], b[1], t);
      x1 = String(a[0]); y1 = String(a[1]);
      x2 = x.toFixed(2); y2 = y.toFixed(2);
    }

    // Move — one transform write, no reflow of the marker's contents.
    //
    // The scale factor counter-scales the marker so a stack in transit stays
    // the same size on screen at every zoom, exactly like the stations it is
    // travelling between (render/camera.js, CAM_SYMBOL_EXP). Folded into the
    // transform that was already being written every frame.
    //
    // Diffed against the last string written rather than written blind. A
    // marching wave moves every frame and pays exactly what it always did; a
    // beachhead is parked for 120 ticks and now costs nothing per frame for it,
    // which is the difference between "cheap" and "cheap unless the most
    // interesting thing on the board is happening".
    const tf = 'translate(' + x.toFixed(2) + ',' + y.toFixed(2) + ') scale(' + k + ')';
    if (tf !== rec.tf) {
      rec.tf = tf;
      rec.g.setAttribute('transform', tf);
      WAVES.writes++;
    }
    // Marching: anchored at the station just left, so it grows across the hop
    // and resets at each one — an in-flight streak, not a supply line.
    // Landing: a lane THROUGH the marker aimed at the beach, stopping short of
    // it, so it reads as the direction the echelons are going rather than where
    // they came from — and so the ring does not swallow the whole line.
    const tl = x1 + ' ' + y1 + ' ' + x2 + ' ' + y2;
    if (tl !== rec.tl) {
      rec.tl = tl;
      rec.trail.setAttribute('x1', x1);
      rec.trail.setAttribute('y1', y1);
      rec.trail.setAttribute('x2', x2);
      rec.trail.setAttribute('y2', y2);
      WAVES.writes += 4;
    }

    // Units are floats in state; floored here, and only written when the
    // integer actually moved. Mid-march that is almost never — a stack only
    // loses strength on a sea crossing.
    const n = Math.floor(waveTotal(w.units));
    if (n !== rec.n) {
      rec.n = n;
      rec.num.textContent = formatNum(n);
      WAVES.writes++;
    }

    // Capitulation can hand a wave to nobody, and a stack can in principle be
    // re-owned; cheap to check, cheaper than a wrong colour.
    if (w.owner !== rec.owner) {
      rec.owner = w.owner;
      const c = waveColor(w.owner);
      rec.chip.style.fill = c;
      rec.trail.style.stroke = c;
      rec.g.setAttribute('data-owner', w.owner);
      WAVES.writes += 3;
    }

    // Beachhead. Nothing above this line knows about landings except which two
    // points the marker and its trail run between, so a land arrival goes
    // through this loop having touched no new code and created no new nodes.
    _wavLandClass(rec, isLanding);
    if (isLanding) _wavLandArc(rec, w, waveColor(w.owner));
  }

  // Landed or annihilated: sim/movement.js drops the record, so the marker and
  // its trail go with it. This is the whole reason trails are not standing
  // supply lines — there is nothing left to draw.
  for (const key in WAVES.node) {
    if (seen[key]) continue;
    const rec = WAVES.node[key];
    if (rec.g.parentNode) rec.g.parentNode.removeChild(rec.g);
    if (rec.trail.parentNode) rec.trail.parentNode.removeChild(rec.trail);
    delete WAVES.node[key];
  }

  return WAVES.writes - before;
}

// Global exports — no modules anywhere in this project.
window.renderWaves = renderWaves;
window.resetWaveLayer = resetWaveLayer;
