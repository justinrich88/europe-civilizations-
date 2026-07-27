#!/usr/bin/env node
// tools/build-map.js — generates data/map.js from Natural Earth 1:50m TopoJSON.
//
//   node tools/build-map.js
//
// This is a BUILD script. It is run by hand; its output (data/map.js) is what
// ships and is committed. Nothing at runtime loads this file, and it has zero
// npm dependencies — the TopoJSON decoder is right here.
//
// Why TopoJSON and not GeoJSON: arcs are SHARED between adjacent polygons. Two
// countries that border each other reference the same arc index, so if we map
// arcIndex -> [vertex ids] exactly once and assemble every ring out of that
// table, shared borders reference literally the same vertex ids. Gap-free
// borders and exact adjacency fall out for free. Vertices are deduped by ARC
// IDENTITY, never by coordinate proximity.
//
// Pipeline:
//   decode -> per-arc simplify (deg) -> arc->vertex ids -> merge microstates by
//   dropping interior arcs & restitching -> largest ring -> clip -> Albers ->
//   fit to 1000x700 -> topology-preserving prune (px) -> weld <4px vertices ->
//   derive neighbors from shared edges -> emit.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'source', 'countries-50m.json');
const OUT = path.join(ROOT, 'data', 'map.js');

// ---------------------------------------------------------------- knobs -----
const DP_DEG = 0.02;      // Douglas-Peucker tolerance, degrees, per arc
const CLIP = { lonMin: -25, lonMax: 48, latMin: 33, latMax: 72 };
const VIEW = { w: 1000, h: 700, margin: 20 };
const PRUNE_PX = 0.35;     // topology-preserving prune tolerance, viewBox units
const MIN_SEG_PX = 4.05;   // collapse edges shorter than this (> WELD_PX)
const WELD_PX = 4.0;      // verify-map.js near-dup threshold
const MIN_RING = 8;       // never prune a ring below this many vertices

// --------------------------------------------------------------- tables -----
// Explicit name -> territory id so ids never drift between runs.
// Several source countries fold into one territory (microstate merge).
const MEMBERS = {
  alb: ['Albania'],
  aut: ['Austria'],
  bal: ['Estonia', 'Latvia', 'Lithuania'],
  bel: ['Belgium', 'Luxembourg'],
  blr: ['Belarus'],
  bul: ['Bulgaria'],
  che: ['Switzerland'],
  cze: ['Czechia'],
  dnk: ['Denmark'],
  esp: ['Spain'],
  fin: ['Finland'],
  fra: ['France'],
  gbr: ['United Kingdom'],
  ger: ['Germany'],
  grc: ['Greece'],
  hrv: ['Croatia', 'Bosnia and Herz.', 'Slovenia'],
  hun: ['Hungary'],
  irl: ['Ireland'],
  ita: ['Italy'],
  nld: ['Netherlands'],
  nor: ['Norway'],
  pol: ['Poland'],
  por: ['Portugal'],
  rom: ['Romania', 'Moldova'],
  rus: ['Russia'],
  srb: ['Serbia', 'Montenegro', 'Macedonia'],
  svk: ['Slovakia'],
  swe: ['Sweden'],
  tur: ['Turkey'],
  ukr: ['Ukraine'],
};

const NAMES = {
  alb: 'Albania', aut: 'Austria', bal: 'Baltics', bel: 'Belgium',
  blr: 'Belarus', bul: 'Bulgaria', che: 'Switzerland', cze: 'Czechia',
  dnk: 'Denmark', esp: 'Spain', fin: 'Finland', fra: 'France',
  gbr: 'United Kingdom', ger: 'Germany', grc: 'Greece', hrv: 'Croatia',
  hun: 'Hungary', irl: 'Ireland', ita: 'Italy', nld: 'Netherlands',
  nor: 'Norway', pol: 'Poland', por: 'Portugal', rom: 'Romania',
  rus: 'Russia', srb: 'Serbia', svk: 'Slovakia', swe: 'Sweden',
  tur: 'Turkey', ukr: 'Ukraine',
};

const TERRAIN = {
  alb: 'mountains', aut: 'mountains', bal: 'forest', bel: 'urban',
  blr: 'forest', bul: 'mountains', che: 'mountains', cze: 'hills',
  dnk: 'plains', esp: 'hills', fin: 'forest', fra: 'plains',
  gbr: 'urban', ger: 'urban', grc: 'mountains', hrv: 'mountains',
  hun: 'plains', irl: 'hills', ita: 'hills', nld: 'urban',
  nor: 'mountains', pol: 'plains', por: 'hills', rom: 'hills',
  rus: 'plains', srb: 'mountains', svk: 'mountains', swe: 'forest',
  tur: 'mountains', ukr: 'plains',
};

const TIDS = Object.keys(MEMBERS).sort();

// ---------------------------------------------------------------- decode ----
const topo = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const { scale, translate } = topo.transform;

// Arcs are quantized + delta encoded. Accumulate, then de-quantize.
// Integer positions are kept too: they are EXACT, so they key arc-endpoint
// nodes without any floating point fuzz.
const arcsInt = topo.arcs.map(arc => {
  let x = 0, y = 0;
  return arc.map(d => { x += d[0]; y += d[1]; return [x, y]; });
});
const arcsLL = arcsInt.map(a =>
  a.map(p => [p[0] * scale[0] + translate[0], p[1] * scale[1] + translate[1]]));

// ------------------------------------------------- per-arc simplification ---
// Douglas-Peucker, run PER ARC before assembly. Doing it on assembled rings
// would tear shared borders apart: each side would keep a different subset.
// Endpoints are always kept, so arcs still meet at their nodes.
function dp(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (bestD > tol) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// ----------------------------------------------- arc index -> vertex ids ----
// Built ONCE. Arc interiors get fresh ids; arc ENDPOINTS are shared nodes and
// are keyed by their exact quantized integer coordinate, so arcs that meet at a
// node meet at one vertex id. `~i` reuses the same ids reversed — never new ones.
const V = new Map();            // vid -> [lon, lat]
const nodeId = new Map();       // "xi,yi" -> vid
let vSeq = 0;
const newVert = (lon, lat) => { const id = 'V' + (++vSeq); V.set(id, [lon, lat]); return id; };

const arcVids = arcsLL.map((ll, ai) => {
  const idx = dp(ll, DP_DEG);
  const ints = arcsInt[ai];
  return idx.map((pi, k) => {
    if (k === 0 || k === idx.length - 1) {          // shared node
      const key = ints[pi][0] + ',' + ints[pi][1];
      let id = nodeId.get(key);
      if (!id) { id = newVert(ll[pi][0], ll[pi][1]); nodeId.set(key, id); }
      return id;
    }
    return newVert(ll[pi][0], ll[pi][1]);
  });
});
const arcNode = arcsInt.map(a => [
  a[0][0] + ',' + a[0][1],
  a[a.length - 1][0] + ',' + a[a.length - 1][1],
]);

// -------------------------------------------------------- country lookup ----
const byName = new Map();
for (const g of topo.objects.countries.geometries) byName.set(g.properties.name, g);

const ringsOf = g => g.type === 'Polygon' ? g.arcs
  : g.type === 'MultiPolygon' ? [].concat(...g.arcs) : [];

// Arc usage across ALL 241 countries: an arc touched by only one country is
// coastline (or a clipped frontier); by two, a land border.
const globalArcUse = new Map();
for (const g of topo.objects.countries.geometries)
  for (const ring of ringsOf(g))
    for (const a of ring) {
      const i = a < 0 ? ~a : a;
      let s = globalArcUse.get(i);
      if (!s) globalArcUse.set(i, s = new Set());
      s.add(g.properties.name);
    }

// ------------------------------------------- merge members, restitch rings --
// Union of a microstate group = drop every arc used in BOTH directions inside
// the group (that is an internal border) and restitch what is left into rings
// by matching endpoint nodes. Pure topology: no geometry, no float compares.
function mergedRings(names) {
  const rings = [];
  for (const nm of names) {
    const g = byName.get(nm);
    if (!g) { console.warn('  !! missing country: ' + nm); continue; }
    for (const r of ringsOf(g)) rings.push(r);
  }
  if (names.length === 1) return rings;

  const fwd = new Set(), rev = new Set();
  for (const r of rings) for (const a of r) (a < 0 ? rev : fwd).add(a < 0 ? ~a : a);
  const interior = new Set([...fwd].filter(i => rev.has(i)));

  const pool = [];
  for (const r of rings) for (const a of r) { const i = a < 0 ? ~a : a; if (!interior.has(i)) pool.push(a); }
  if (!pool.length) return rings;

  const start = a => a < 0 ? arcNode[~a][1] : arcNode[a][0];
  const end = a => a < 0 ? arcNode[~a][0] : arcNode[a][1];
  const from = new Map();
  pool.forEach((a, i) => {
    const k = start(a);
    let l = from.get(k); if (!l) from.set(k, l = []);
    l.push(i);
  });

  const used = new Uint8Array(pool.length);
  const out = [];
  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    const ring = [];
    let cur = i, guard = 0;
    const home = start(pool[i]);
    while (guard++ < pool.length + 2) {
      used[cur] = 1; ring.push(pool[cur]);
      const e = end(pool[cur]);
      if (e === home) break;
      const cand = (from.get(e) || []).filter(j => !used[j]);
      if (!cand.length) { break; }
      cur = cand[0];
    }
    if (ring.length) out.push(ring);
  }
  return out.length ? out : rings;
}

// ---------------------------------------------- ring (arc list) -> vertices --
function ringVids(ring) {
  const ids = [];
  for (const a of ring) {
    let list = a < 0 ? arcVids[~a].slice().reverse() : arcVids[a];
    if (ids.length) list = list.slice(1);
    for (const v of list) ids.push(v);
  }
  while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
  return ids;
}

const areaOf = pts => {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
};

// ------------------------------------------------------------------ clip ----
// Sutherland-Hodgman against the lon/lat window, AFTER arc->vertex assignment.
// New boundary vertices are fine: those edges face outside the country set and
// are exterior by construction. They are registered by rounded coordinate so
// that if two rings ever cross the same boundary edge they get the same id.
const clipId = new Map();
function clipVert(lon, lat) {
  const key = lon.toFixed(6) + ',' + lat.toFixed(6);
  let id = clipId.get(key);
  if (!id) { id = newVert(lon, lat); clipId.set(key, id); }
  return id;
}
const EDGES = [
  { inside: p => p[0] >= CLIP.lonMin, cut: (a, b) => lerpX(a, b, CLIP.lonMin) },
  { inside: p => p[0] <= CLIP.lonMax, cut: (a, b) => lerpX(a, b, CLIP.lonMax) },
  { inside: p => p[1] >= CLIP.latMin, cut: (a, b) => lerpY(a, b, CLIP.latMin) },
  { inside: p => p[1] <= CLIP.latMax, cut: (a, b) => lerpY(a, b, CLIP.latMax) },
];
function lerpX(a, b, x) { const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + t * (b[1] - a[1])]; }
function lerpY(a, b, y) { const t = (y - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y]; }

function clipRing(vids) {
  // Russia's mainland ring wraps the antimeridian: Chukotka is stored at
  // lon -180..-170. Sutherland-Hodgman would drag those points onto the
  // lon=-25 edge and stitch a huge sliver across the Arctic. Splice the
  // western-hemisphere run out first — no selected country reaches lon -90.
  let poly = vids.filter(v => V.get(v)[0] > -90);
  if (poly.length < 3) poly = vids.slice();
  for (const e of EDGES) {
    if (!poly.length) break;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prv = poly[(i - 1 + poly.length) % poly.length];
      const P = V.get(cur), Q = V.get(prv);
      const pin = e.inside(P), qin = e.inside(Q);
      if (pin) {
        if (!qin) { const c = e.cut(Q, P); out.push(clipVert(c[0], c[1])); }
        out.push(cur);
      } else if (qin) { const c = e.cut(Q, P); out.push(clipVert(c[0], c[1])); }
    }
    poly = out;
  }
  // strip consecutive repeats
  const clean = [];
  for (const v of poly) if (clean[clean.length - 1] !== v) clean.push(v);
  while (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
  return clean;
}

// ------------------------------------------------------- assemble shapes ----
const shapes = {};   // tid -> [vid]
const usedArcs = {}; // tid -> Set(arcIndex) of the chosen ring
for (const tid of TIDS) {
  const rings = mergedRings(MEMBERS[tid]);
  let best = null, bestA = -1;
  for (const r of rings) {
    const vids = ringVids(r);
    if (vids.length < 3) continue;
    const a = areaOf(vids.map(v => V.get(v)));
    if (a > bestA) { bestA = a; best = { r, vids }; }
  }
  if (!best) throw new Error('no ring for ' + tid);
  shapes[tid] = clipRing(best.vids);
  usedArcs[tid] = new Set(best.r.map(a => a < 0 ? ~a : a));
  if (shapes[tid].length < 3) throw new Error('clipped away: ' + tid);
}

// coastal: any arc of the chosen ring not shared with another selected country.
const SELECTED = new Set([].concat(...Object.values(MEMBERS)));
const coastal = {};
for (const tid of TIDS) {
  coastal[tid] = [...usedArcs[tid]].some(i => {
    const users = globalArcUse.get(i) || new Set();
    let n = 0; for (const u of users) if (SELECTED.has(u)) n++;
    return n < 2;
  });
}

// ------------------------------------------------- project (Albers) + fit ---
// Projection and fit live in tools/lib/project.js so that tools/build-stations.js
// can place cities in EXACTLY this pixel space. The fit computed here is written
// to tools/lib/fit.json and read back there — never recomputed.
const PROJ = require('./lib/project');
const albers = PROJ.albers;

const live = new Set();
for (const tid of TIDS) for (const v of shapes[tid]) live.add(v);

const XY = new Map();
for (const v of live) { const ll = V.get(v); XY.set(v, albers(ll[0], ll[1])); }

const FIT = PROJ.computeFit([...XY.values()]);
PROJ.saveFit(FIT);
// Round to the emitted precision NOW, so the prune/weld passes below see the
// exact same numbers verify-map.js will: a pair 4.02px apart can round to 3.99
// and trip the near-duplicate check if welding works on unrounded values.
const rnd = PROJ.rnd;
for (const [v, p] of XY) XY.set(v, [rnd(p[0] * FIT.k + FIT.offX), rnd(p[1] * FIT.k + FIT.offY)]);

// ------------------------------------ topology-preserving prune (pixels) ----
// Simplifying each ring on its own would tear shared borders. Instead a vertex
// is removed from EVERY ring at once, and only when all rings that hold it see
// the same two neighbours — i.e. it is interior to a shared border, not a
// junction where three territories meet.
function neighbourMap() {
  const m = new Map(); // vid -> { pairs:Set, rings:Set, a, b }
  for (const tid of TIDS) {
    const s = shapes[tid], L = s.length;
    for (let i = 0; i < L; i++) {
      const v = s[i], a = s[(i - 1 + L) % L], b = s[(i + 1) % L];
      let e = m.get(v);
      if (!e) m.set(v, e = { pairs: new Set(), rings: new Set(), a, b });
      e.pairs.add([a, b].sort().join('|'));
      e.rings.add(tid);
    }
  }
  return m;
}
function perp(v, a, b) {
  const P = XY.get(v), A = XY.get(a), B = XY.get(b);
  const dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(P[0] - A[0], P[1] - A[1]);
  let t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(P[0] - (A[0] + t * dx), P[1] - (A[1] + t * dy));
}
for (let pass = 0; pass < 40; pass++) {
  const m = neighbourMap();
  const cand = [];
  for (const [v, e] of m) {
    if (e.pairs.size !== 1) continue;                       // junction — keep
    if ([...e.rings].some(t => shapes[t].length <= MIN_RING)) continue;
    const d = perp(v, e.a, e.b);
    const seg = Math.hypot(XY.get(v)[0] - XY.get(e.a)[0], XY.get(v)[1] - XY.get(e.a)[1]);
    if (d < PRUNE_PX || seg < MIN_SEG_PX) cand.push([v, d, e]);
  }
  if (!cand.length) break;
  cand.sort((x, y) => x[1] - y[1]);
  const kill = new Set(), blocked = new Set();
  for (const [v, , e] of cand) {
    if (blocked.has(v)) continue;
    kill.add(v); blocked.add(e.a); blocked.add(e.b);
  }
  for (const tid of TIDS) shapes[tid] = shapes[tid].filter(v => !kill.has(v));
}

// ------------------------------------------------- weld sub-4px vertices ----
// verify-map.js treats two vertices under 4px apart as the cardinal sin. At
// this scale a handful of unrelated coastlines land that close (fjord mouths,
// river deltas). Welding them into ONE id is the topologically right fix — it
// can only strengthen shared-edge identity, never weaken it.
{
  const alive = [...new Set([].concat(...TIDS.map(t => shapes[t])))];
  const rep = new Map();
  const dead = new Set();
  for (let i = 0; i < alive.length; i++) {
    if (dead.has(alive[i])) continue;
    const A = XY.get(alive[i]);
    for (let j = i + 1; j < alive.length; j++) {
      if (dead.has(alive[j])) continue;
      const B = XY.get(alive[j]);
      if (Math.abs(A[0] - B[0]) < WELD_PX && Math.abs(A[1] - B[1]) < WELD_PX &&
          Math.hypot(A[0] - B[0], A[1] - B[1]) < WELD_PX) {
        dead.add(alive[j]); rep.set(alive[j], alive[i]);
      }
    }
  }
  if (rep.size) {
    for (const tid of TIDS) shapes[tid] = shapes[tid].map(v => rep.get(v) || v);
    console.log('welded  : ' + rep.size + ' coincident vertices');
  }
}

// tidy: kill consecutive repeats and a-b-a spikes
for (const tid of TIDS) {
  let s = shapes[tid], changed = true;
  while (changed) {
    changed = false;
    const out = [];
    for (const v of s) {
      if (out.length && out[out.length - 1] === v) { changed = true; continue; }
      if (out.length > 1 && out[out.length - 2] === v) { out.pop(); changed = true; continue; }
      out.push(v);
    }
    while (out.length > 1 && out[0] === out[out.length - 1]) { out.pop(); changed = true; }
    while (out.length > 2 && out[1] === out[out.length - 1]) { out.pop(); out.shift(); changed = true; }
    s = out;
  }
  shapes[tid] = s;
}

// unpinch: welding can make a ring touch itself, so one vertex id appears twice.
// That ring then "shares an edge with itself" and verify-map.js rejects it.
// Split at the repeat and keep the larger lobe.
for (const tid of TIDS) {
  for (let guard = 0; guard < 20; guard++) {
    const s = shapes[tid], seen = new Map();
    let at = -1, from = -1;
    for (let i = 0; i < s.length; i++) {
      if (seen.has(s[i])) { from = seen.get(s[i]); at = i; break; }
      seen.set(s[i], i);
    }
    if (at < 0) break;
    const loopA = s.slice(from, at);                       // the pinched-off lobe
    const loopB = s.slice(0, from).concat(s.slice(at));    // the rest
    const aA = loopA.length > 2 ? areaOf(loopA.map(v => XY.get(v))) : -1;
    const aB = loopB.length > 2 ? areaOf(loopB.map(v => XY.get(v))) : -1;
    shapes[tid] = aA > aB ? loopA : loopB;
  }
}

// ----------------------------------------------- neighbours from shared edges
// Derived from shared arcs by construction (same arc -> same vertex ids), and
// read back off the final shapes with the exact algorithm verify-map.js uses,
// so declared and derived cannot disagree.
const edgeOwners = new Map();
for (const tid of TIDS) {
  const s = shapes[tid];
  for (let i = 0; i < s.length; i++) {
    const key = [s[i], s[(i + 1) % s.length]].sort().join('|');
    let l = edgeOwners.get(key); if (!l) edgeOwners.set(key, l = []);
    if (!l.includes(tid)) l.push(tid);
  }
}
const neighbors = {}; TIDS.forEach(t => neighbors[t] = new Set());
for (const [key, owners] of edgeOwners) {
  if (owners.length === 2) { neighbors[owners[0]].add(owners[1]); neighbors[owners[1]].add(owners[0]); }
  else if (owners.length > 2) console.warn('  !! over-shared edge ' + key + ': ' + owners.join(','));
}

// ----------------------------------------------------------------- labels ---
function inside(pt, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
        pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function labelFor(vids) {
  const pts = vids.map(v => XY.get(v));
  let A = 0, cx = 0, cy = 0;
  for (let i = 0, N = pts.length; i < N; i++) {
    const p = pts[i], q = pts[(i + 1) % N];
    const f = p[0] * q[1] - q[0] * p[1];
    A += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
  }
  A /= 2;
  if (A) { cx /= 6 * A; cy /= 6 * A; if (inside([cx, cy], pts)) return [cx, cy]; }
  // concave (Norway, Croatia): visual centre — grid point furthest from the edge
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  let best = [(x0 + x1) / 2, (y0 + y1) / 2], bestD = -1;
  const N = 40;
  for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
    const p = [x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N];
    if (!inside(p, pts)) continue;
    let d = Infinity;
    for (let e = 0; e < pts.length; e++) {
      const a = pts[e], b = pts[(e + 1) % pts.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dd = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
      if (dd < d) d = dd;
    }
    if (d > bestD) { bestD = d; best = p; }
  }
  return best;
}

// ------------------------------------------------------------------ emit ----
const order = [];
const outId = new Map();
for (const tid of TIDS) for (const v of shapes[tid])
  if (!outId.has(v)) { order.push(v); outId.set(v, 'v' + order.length); }

const r1 = x => Math.round(x * 10) / 10;

let js = '// data/map.js — GENERATED by tools/build-map.js. Do not edit by hand.\n';
js += '// Source: Natural Earth 1:50m via world-atlas countries-50m.json (TopoJSON).\n';
js += '// Albers equal-area conic, phi1=43 phi2=62 lambda0=15 phi0=52, fitted to a\n';
js += '// 1000x700 viewBox. Shared borders reference identical vertex ids because\n';
js += '// they are assembled from the same TopoJSON arcs.\n\n';

js += 'const VERTS = {\n';
for (const v of order) {
  const p = XY.get(v);
  js += '  ' + outId.get(v) + ': [' + r1(p[0]) + ', ' + r1(p[1]) + '],\n';
}
js += '};\n\n';

js += 'const TERRITORIES = {\n';
for (const tid of TIDS) {
  const lab = labelFor(shapes[tid]);
  js += '  ' + tid + ': {\n';
  js += '    id: ' + JSON.stringify(tid) + ',\n';
  js += '    name: ' + JSON.stringify(NAMES[tid]) + ',\n';
  js += '    shape: [' + shapes[tid].map(v => "'" + outId.get(v) + "'").join(',') + '],\n';
  js += '    label: [' + r1(lab[0]) + ', ' + r1(lab[1]) + '],\n';
  js += '    terrain: ' + JSON.stringify(TERRAIN[tid]) + ',\n';
  js += '    neighbors: [' + [...neighbors[tid]].sort().map(x => "'" + x + "'").join(',') + '],\n';
  js += '    coastal: ' + (coastal[tid] ? 'true' : 'false') + ',\n';
  js += '  },\n';
}
js += '};\n';

fs.writeFileSync(OUT, js);

// ---------------------------------------------------------------- report ----
console.log('wrote   : data/map.js');
console.log('geometry: ' + TIDS.length + ' territories, ' + order.length + ' vertices');
let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
for (const v of order) {
  const p = XY.get(v);
  if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0];
  if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1];
}
console.log('bbox    : x ' + r1(bx0) + '..' + r1(bx1) + '   y ' + r1(by0) + '..' + r1(by1));
console.log('coastal : ' + TIDS.filter(t => coastal[t]).length + '/' + TIDS.length);
const sizes = TIDS.map(t => shapes[t].length);
console.log('ring len: min ' + Math.min(...sizes) + '  max ' + Math.max(...sizes));
