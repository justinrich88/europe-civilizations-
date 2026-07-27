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

'use strict';

// wave id -> { g, trail, chip, num, last… }. Nodes are created when a wave
// appears and removed when it lands; in between, only `transform` and the two
// trail endpoints move. Rebuilding a marker every frame would be the same
// mistake renderLive exists to avoid, at 60fps.
const WAVES = { node: Object.create(null), writes: 0 };

const WAVE_R = 7.5;

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
  trail.setAttribute('stroke', color);
  layer.appendChild(trail);

  const g = el('g', 'wave', { 'data-wave': w.id, 'data-owner': w.owner });
  const chip = el('circle', 'wave-chip', { r: WAVE_R });
  chip.setAttribute('fill', color);
  g.appendChild(chip);
  // Strength legible at a glance — the same "number is the interface" rule the
  // stations follow, just smaller because a stack is transient.
  const num = el('text', 'wave-units', { y: 0.5, text: '' });
  g.appendChild(num);
  layer.appendChild(g);

  return { g: g, trail: trail, chip: chip, num: num, n: -1, owner: w.owner };
}

// renderWaves(state) — the pinned per-frame entry point (01-data-schema.md).
function renderWaves(state) {
  const layer = byId('g-waves');
  if (!layer || !state || !Array.isArray(state.waves)) return 0;
  const before = WAVES.writes;

  const seen = Object.create(null);

  for (let i = 0; i < state.waves.length; i++) {
    const w = state.waves[i];
    if (!w || !Array.isArray(w.path) || w.path.length < 2) continue;

    const hop = Math.min(w.hop | 0, w.path.length - 2);
    const a = stationPos(w.path[hop]);
    const b = stationPos(w.path[hop + 1]);
    if (!a || !b) continue;

    const t = clamp(Number(w.progress) || 0, 0, 1);
    const x = lerp(a[0], b[0], t);
    const y = lerp(a[1], b[1], t);

    const key = String(w.id);
    seen[key] = true;
    let rec = WAVES.node[key];
    if (!rec) {
      rec = makeWaveNode(layer, w);
      WAVES.node[key] = rec;
    }

    // Move — one transform write, no reflow of the marker's contents.
    rec.g.setAttribute('transform', 'translate(' + x.toFixed(2) + ',' + y.toFixed(2) + ')');
    // The trail is anchored at the station just left, so it grows across the
    // hop and resets at each one: an in-flight streak, not a supply line.
    rec.trail.setAttribute('x1', a[0]);
    rec.trail.setAttribute('y1', a[1]);
    rec.trail.setAttribute('x2', x.toFixed(2));
    rec.trail.setAttribute('y2', y.toFixed(2));
    WAVES.writes += 5;

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
      rec.chip.setAttribute('fill', c);
      rec.trail.setAttribute('stroke', c);
      rec.g.setAttribute('data-owner', w.owner);
      WAVES.writes += 3;
    }
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
