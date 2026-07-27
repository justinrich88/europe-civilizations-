#!/usr/bin/env node
// tools/build-stations.js — generates data/stations.js and data/scenario.js.
//
//   node tools/build-stations.js
//
// A BUILD script, like tools/build-map.js. Run by hand; its output ships.
//
// Stations are REAL CITIES, given as lon/lat and pushed through the exact same
// Albers projection and viewBox fit as the borders (tools/lib/project.js +
// tools/lib/fit.json). That is the whole trick: place cities in the world, not
// on the screen, and they land inside the right country by construction. The
// only correction applied is a nudge toward the territory centroid for coastal
// cities that fall just outside the SIMPLIFIED outline — logged, never silent.
//
// Pipeline:
//   city table -> project -> nudge inside polygon -> emit STATIONS
//             -> intra-territory MST + short edges
//             -> inter-territory border links from map.js `neighbors`
//             -> hardcoded sea crossings
//             -> assert one connected graph -> emit LINKS
//             -> homeland-only ownership -> emit POWERS + SETUP

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PROJ = require('./lib/project');

const ROOT = path.join(__dirname, '..');
const OUT_STATIONS = path.join(ROOT, 'data', 'stations.js');
const OUT_SCENARIO = path.join(ROOT, 'data', 'scenario.js');

// ---------------------------------------------------------- load the map ----
// `const` at the top level of a script is lexical, not a global property, so
// the generated file is evaluated with an explicit hand-off at the end.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'data', 'map.js'), 'utf8') +
  '\n;globalThis.__T = TERRITORIES; globalThis.__V = VERTS;\n',
  sandbox, { filename: 'data/map.js' });
const TERRITORIES = sandbox.__T;
const VERTS = sandbox.__V;
const FIT = PROJ.loadFit();

// ================================================================ CITIES ====
// { id, name, lon, lat, terr, type, capacity, rate, produces, defense, multiplier }
//
// Density tracks real 1914 size and industry (00-vision.md §2) — this table IS
// each power's character. Germany dense with producers, Russia sparse over a
// huge area, Italy industrial north and empty south, the Ottomans a handful of
// chokepoints.
//
// Type bands (01-data-schema.md), obeyed exactly:
//   holding    infantry             cap 25-80  rate 0.7-1.1  def 1.0      mult null
//   producer   artillery|armour     cap 15-35  rate 0.4-0.6  def 1.0-1.2  mult null
//   multiplier infantry             cap  8-15  rate 0.3      def 0.8      mult 1.3-1.8
//   defensive  infantry             cap 12-25  rate 0.3-0.5  def 2.0-3.5  mult null
const H = (id, name, lon, lat, terr, cap, rate) =>
  ({ id, name, lon, lat, terr, type: 'holding', capacity: cap, rate, produces: 'infantry', defense: 1.0, multiplier: null });
const P = (id, name, lon, lat, terr, cap, rate, makes, def) =>
  ({ id, name, lon, lat, terr, type: 'producer', capacity: cap, rate, produces: makes, defense: def, multiplier: null });
const M = (id, name, lon, lat, terr, cap, mult) =>
  ({ id, name, lon, lat, terr, type: 'multiplier', capacity: cap, rate: 0.3, produces: 'infantry', defense: 0.8, multiplier: mult });
const F = (id, name, lon, lat, terr, cap, rate, def) =>
  ({ id, name, lon, lat, terr, type: 'defensive', capacity: cap, rate, produces: 'infantry', defense: def, multiplier: null });

const CITIES = [
  // --- Germany (9) — dense, three producers, the strongest industrial base ---
  H('ber', 'Berlin',        13.40, 52.52, 'ger', 72, 1.0),
  H('ham', 'Hamburg',        9.99, 53.55, 'ger', 56, 0.95),
  H('mun', 'Munich',        11.58, 48.14, 'ger', 50, 0.9),
  H('kol', 'Cologne',        6.96, 50.94, 'ger', 46, 0.9),
  H('fra', 'Frankfurt',      8.68, 50.11, 'ger', 42, 0.85),
  H('stu', 'Stuttgart',      9.18, 48.78, 'ger', 38, 0.85),
  P('ruh', 'The Ruhr',       7.47, 51.51, 'ger', 32, 0.55, 'armour',    1.1),
  P('lei', 'Leipzig Works', 12.37, 51.34, 'ger', 28, 0.5,  'artillery', 1.1),
  M('mec', 'Mecklenburg',   12.14, 53.75, 'ger', 13, 1.4),

  // --- France (8) — balanced, fortress belt, the Beauce granary --------------
  H('par', 'Paris',          2.35, 48.86, 'fra', 70, 1.0),
  H('lyo', 'Lyon',           4.84, 45.76, 'fra', 46, 0.9),
  H('mrs', 'Marseille',      5.37, 43.30, 'fra', 44, 0.85),
  H('bdx', 'Bordeaux',      -0.58, 44.84, 'fra', 40, 0.85),
  H('tls', 'Toulouse',       1.44, 43.60, 'fra', 34, 0.8),
  P('lil', 'Lille',          3.06, 50.63, 'fra', 30, 0.55, 'armour',    1.1),
  F('ver', 'Verdun',         5.38, 49.16, 'fra', 20, 0.4, 3.0),
  M('bea', 'The Beauce',     1.90, 47.90, 'fra', 14, 1.5),

  // --- United Kingdom (8) — compact, industrial, behind a sea crossing -------
  H('lon', 'London',        -0.13, 51.51, 'gbr', 74, 1.05),
  H('gla', 'Glasgow',       -4.25, 55.86, 'gbr', 42, 0.9),
  H('abd', 'Aberdeen',      -2.10, 57.15, 'gbr', 30, 0.8),
  H('ncl', 'Newcastle',     -1.61, 54.98, 'gbr', 34, 0.85),
  H('crd', 'Cardiff',       -3.18, 51.48, 'gbr', 32, 0.8),
  H('dov', 'Dover',          1.31, 51.13, 'gbr', 28, 0.75),
  P('bir', 'Birmingham',    -1.90, 52.48, 'gbr', 33, 0.55, 'armour',    1.15),
  P('man', 'Manchester',    -2.24, 53.48, 'gbr', 30, 0.55, 'artillery', 1.1),

  // --- Ireland (2) ----------------------------------------------------------
  H('dub', 'Dublin',        -6.26, 53.35, 'irl', 34, 0.85),
  H('cor', 'Cork',          -8.47, 51.90, 'irl', 26, 0.75),

  // --- Russia (8) — sparse holdings over an enormous area, black earth -------
  H('mos', 'Moscow',        37.62, 55.75, 'rus', 70, 1.0),
  H('stp', 'St Petersburg', 30.31, 59.94, 'rus', 60, 0.95),
  H('niz', 'Nizhny Novgorod', 44.00, 56.33, 'rus', 40, 0.85),
  H('sar', 'Saratov',       46.03, 51.53, 'rus', 36, 0.8),
  H('ros', 'Rostov',        39.72, 47.24, 'rus', 38, 0.85),
  H('tsa', 'Tsaritsyn',     44.52, 48.71, 'rus', 32, 0.8),
  P('tul', 'Tula Arsenal',  37.62, 54.20, 'rus', 26, 0.45, 'artillery', 1.0),
  M('vor', 'Black Earth',   39.20, 51.67, 'rus', 15, 1.6),

  // --- Austria (5) and Hungary (3) — scattered, awkward interior lines -------
  H('vie', 'Vienna',        16.37, 48.21, 'aut', 56, 0.95),
  H('grz', 'Graz',          15.44, 47.07, 'aut', 32, 0.8),
  H('slz', 'Salzburg',      13.05, 47.81, 'aut', 28, 0.75),
  P('lnz', 'Linz Works',    14.29, 48.31, 'aut', 24, 0.45, 'artillery', 1.0),
  F('inn', 'Innsbruck',     11.40, 47.27, 'aut', 20, 0.4, 2.6),
  H('bud', 'Budapest',      19.04, 47.50, 'hun', 50, 0.9),
  H('deb', 'Debrecen',      21.63, 47.53, 'hun', 30, 0.8),
  M('alf', 'Great Plain',   19.80, 46.40, 'hun', 14, 1.5),

  // --- Italy (7) — producer north, Alpine fort, empty south ------------------
  H('rom', 'Rome',          12.50, 41.90, 'ita', 56, 0.95),
  H('nap', 'Naples',        14.27, 40.85, 'ita', 46, 0.9),
  H('bar', 'Bari',          16.87, 41.13, 'ita', 28, 0.75),
  P('mil', 'Milan',          9.19, 45.46, 'ita', 33, 0.55, 'armour',    1.15),
  P('tur', 'Turin',          7.69, 45.07, 'ita', 29, 0.5,  'artillery', 1.1),
  M('pov', 'Po Valley',     10.92, 44.80, 'ita', 14, 1.5),
  F('tre', 'Trento',        11.12, 46.07, 'ita', 20, 0.4, 2.8),

  // --- Ottoman Empire (4) — very sparse, defensive chokepoints ---------------
  H('ist', 'Constantinople', 28.98, 41.01, 'tur', 52, 0.9),
  H('ank', 'Ankara',        32.85, 39.93, 'tur', 32, 0.75),
  H('smy', 'Smyrna',        27.14, 38.42, 'tur', 30, 0.75),
  F('dar', 'The Dardanelles', 26.41, 40.15, 'tur', 22, 0.4, 3.2),

  // --- Spain (5) and Portugal (2) -------------------------------------------
  H('mad', 'Madrid',        -3.70, 40.42, 'esp', 50, 0.9),
  H('sev', 'Seville',       -5.99, 37.39, 'esp', 36, 0.8),
  P('bcn', 'Barcelona',      2.17, 41.39, 'esp', 30, 0.5,  'armour',    1.05),
  P('bil', 'Bilbao',        -2.93, 43.26, 'esp', 25, 0.45, 'artillery', 1.05),
  F('gib', 'Gibraltar',     -5.34, 36.14, 'esp', 18, 0.35, 3.0),
  H('lis', 'Lisbon',        -9.14, 38.72, 'por', 40, 0.85),
  H('opo', 'Porto',         -8.61, 41.15, 'por', 30, 0.8),

  // --- Poland (5) — Łódź and Silesian industry, Przemyśl fortress -----------
  H('war', 'Warsaw',        21.01, 52.23, 'pol', 50, 0.9),
  H('kra', 'Krakow',        19.94, 50.06, 'pol', 34, 0.8),
  P('lod', 'Lodz Mills',    19.46, 51.76, 'pol', 28, 0.5,  'artillery', 1.0),
  P('bre', 'Silesia',       17.03, 51.11, 'pol', 26, 0.5,  'armour',    1.05),
  F('prz', 'Przemysl',      22.78, 49.79, 'pol', 20, 0.4, 3.0),

  // --- Ukraine (4) — the Donbas and the grain ------------------------------
  H('kyi', 'Kyiv',          30.52, 50.45, 'ukr', 46, 0.9),
  H('ode', 'Odessa',        30.73, 46.48, 'ukr', 36, 0.8),
  P('don', 'The Donbas',    37.80, 48.00, 'ukr', 32, 0.55, 'armour',    1.05),
  M('kir', 'Ukrainian Steppe', 32.26, 48.51, 'ukr', 15, 1.7),

  // --- Belarus (2), Baltics (2), Finland (2) --------------------------------
  H('mns', 'Minsk',         27.56, 53.90, 'blr', 34, 0.8),
  H('gom', 'Gomel',         30.99, 52.44, 'blr', 26, 0.75),
  H('rig', 'Riga',          24.11, 56.95, 'bal', 34, 0.8),
  H('vln', 'Vilnius',       25.28, 54.69, 'bal', 28, 0.75),
  H('hel', 'Helsinki',      24.94, 60.17, 'fin', 32, 0.8),
  H('tam', 'Tampere',       23.76, 61.50, 'fin', 25, 0.7),

  // --- Scandinavia (2 + 3 + 2) ---------------------------------------------
  H('osl', 'Oslo',          10.75, 59.91, 'nor', 32, 0.8),
  H('bgn', 'Bergen',         5.32, 60.39, 'nor', 26, 0.7),
  H('sth', 'Stockholm',     18.07, 59.33, 'swe', 38, 0.85),
  H('got', 'Gothenburg',    11.97, 57.71, 'swe', 30, 0.8),
  H('nrk', 'Norrkoping',    16.19, 58.59, 'swe', 25, 0.7),
  // Denmark is Jutland only: Natural Earth's largest ring drops Zealand and
  // Funen, so Copenhagen has no land to stand on. Jutland cities instead.
  H('aar', 'Aarhus',        10.21, 56.16, 'dnk', 36, 0.85),
  H('aal', 'Aalborg',        9.92, 57.05, 'dnk', 26, 0.75),

  // --- Low Countries (2 + 2) and Switzerland (2) ---------------------------
  H('ams', 'Amsterdam',      4.90, 52.37, 'nld', 40, 0.9),
  H('ein', 'Eindhoven',      5.48, 51.44, 'nld', 30, 0.8),
  H('bru', 'Brussels',       4.35, 50.85, 'bel', 38, 0.85),
  P('lie', 'Liege',          5.57, 50.63, 'bel', 25, 0.5,  'artillery', 1.05),
  H('zur', 'Zurich',         8.54, 47.37, 'che', 30, 0.8),
  F('got_h', 'St Gotthard',  8.57, 46.55, 'che', 18, 0.35, 2.5),

  // --- Bohemia (3) and Slovakia (2) ----------------------------------------
  H('pra', 'Prague',        14.44, 50.08, 'cze', 46, 0.9),
  H('brn', 'Brno',          16.61, 49.20, 'cze', 30, 0.8),
  P('pil', 'Skoda Works',   13.38, 49.75, 'cze', 28, 0.55, 'artillery', 1.15),
  H('nit', 'Nitra',         18.09, 48.31, 'svk', 28, 0.75),
  H('kos', 'Kosice',        21.26, 48.72, 'svk', 25, 0.7),

  // --- The Balkans ---------------------------------------------------------
  H('buc', 'Bucharest',     26.10, 44.44, 'rom', 42, 0.85),
  H('clu', 'Cluj',          23.60, 46.77, 'rom', 30, 0.8),
  M('wal', 'Wallachia',     24.60, 44.20, 'rom', 14, 1.5),
  H('sof', 'Sofia',         23.32, 42.70, 'bul', 35, 0.8),
  H('var', 'Varna',         27.91, 43.21, 'bul', 26, 0.75),
  H('bel_g', 'Belgrade',    20.46, 44.79, 'srb', 38, 0.85),
  H('nis', 'Nis',           21.90, 43.32, 'srb', 26, 0.75),
  H('zag', 'Zagreb',        15.98, 45.81, 'hrv', 35, 0.8),
  H('spl', 'Split',         16.44, 43.51, 'hrv', 26, 0.75),
  H('tir', 'Tirana',        19.82, 41.33, 'alb', 26, 0.75),
  H('vlo', 'Vlore',         19.49, 40.47, 'alb', 25, 0.7),
  H('ath', 'Athens',        23.73, 37.98, 'grc', 38, 0.85),
  H('slk', 'Salonika',      22.94, 40.64, 'grc', 30, 0.8),
  H('pat', 'Patras',        21.73, 38.25, 'grc', 25, 0.7),
];

// ============================================================ SEA LINKS =====
// Hardcoded, by station id. The isles and Anatolia depend on these entirely.
const SEA = [
  ['dov', 'lil'],   // the Straits of Dover
  ['dub', 'crd'],   // the Irish Sea
  ['aal', 'osl'],   // the Skagerrak
  ['aal', 'got'],   // the Kattegat
  ['mec', 'aar'],   // the Danish straits
  ['mec', 'nrk'],   // the Baltic — Germany to Sweden
  ['bar', 'spl'],   // the Adriatic
  ['bar', 'vlo'],   // the Strait of Otranto
  ['ath', 'smy'],   // the Aegean
  ['ist', 'ank'],   // the Bosporus — the Ottoman chokepoint
];

// ============================================================== POWERS ======
// Each power starts holding exactly ONE territory — its homeland — and nothing
// else. Everything else is neutral. Expansion is the entire game; this is a
// deliberate departure from historical 1914 extents.
// Colours are picked for hue separation on the #0c0f14 board (style.css).
const POWERS = [
  { id: 'ger', name: 'German Empire',    color: '#4f74c8', home: 'ger', capital: 'ber', ai: 'expansionist' },
  { id: 'fra', name: 'French Republic',  color: '#35a9b8', home: 'fra', capital: 'par', ai: 'turtle' },
  { id: 'gbr', name: 'British Empire',   color: '#c9524a', home: 'gbr', capital: 'lon', ai: 'opportunist' },
  { id: 'rus', name: 'Russian Empire',   color: '#8f6fd0', home: 'rus', capital: 'mos', ai: 'expansionist' },
  { id: 'aut', name: 'Austria-Hungary',  color: '#d99a3c', home: 'aut', capital: 'vie', ai: 'turtle' },
  { id: 'ita', name: 'Kingdom of Italy', color: '#4fae62', home: 'ita', capital: 'rom', ai: 'opportunist' },
  { id: 'ott', name: 'Ottoman Empire',   color: '#c95fa0', home: 'tur', capital: 'ist', ai: 'turtle' },
];

// ============================================================= GEOMETRY =====
const polyOf = tid => TERRITORIES[tid].shape.map(v => VERTS[v]);

function pointInPoly(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
        pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

function distToPoly(pt, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dy)));
  }
  return best;
}

function centroidOf(poly) {
  let A = 0, cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    A += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
  }
  A /= 2;
  if (A) {
    const c = [cx / (6 * A), cy / (6 * A)];
    if (pointInPoly(c, poly)) return c;
  }
  // Concave (Norway, Croatia, Greece): pole of inaccessibility on a grid.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  let best = [(x0 + x1) / 2, (y0 + y1) / 2], bestD = -1;
  const N = 60;
  for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
    const p = [x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N];
    if (!pointInPoly(p, poly)) continue;
    const d = distToPoly(p, poly);
    if (d > bestD) { bestD = d; best = p; }
  }
  return best;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r1 = x => Math.round(x * 10) / 10;

// ------------------------------------------------- project + nudge inside ---
const INSET = 2.5;   // required clearance from the border, viewBox units
const nudged = [];
const STATIONS = {};
const order = [];

const centroids = {};
for (const tid of Object.keys(TERRITORIES)) centroids[tid] = centroidOf(polyOf(tid));

// True projected city position, kept so the relaxation pass below can bound how
// far a station is ever allowed to drift from where the city actually is.
const RAWPOS = {};

for (const c of CITIES) {
  if (!TERRITORIES[c.terr]) throw new Error(c.id + ' names unknown territory ' + c.terr);
  const poly = polyOf(c.terr);
  const cen = centroids[c.terr];
  let pos = PROJ.toView(c.lon, c.lat, FIT);
  const raw = pos.slice();

  // Real coastal cities routinely fall a few pixels outside a SIMPLIFIED
  // outline. Walk toward the territory's interior point until the position is
  // strictly inside with clearance. Never silent: every nudge is logged.
  let steps = 0;
  while ((!pointInPoly(pos, poly) || distToPoly(pos, poly) < INSET) && steps < 200) {
    steps++;
    const t = steps / 200;
    pos = [r1(raw[0] + (cen[0] - raw[0]) * t), r1(raw[1] + (cen[1] - raw[1]) * t)];
  }
  if (!pointInPoly(pos, poly)) throw new Error('could not place ' + c.id + ' inside ' + c.terr);
  if (steps) nudged.push({ id: c.id, name: c.name, terr: c.terr, px: r1(dist(raw, pos)) });
  RAWPOS[c.id] = pos.slice();   // post-nudge truth: the anchor drift is measured from

  STATIONS[c.id] = {
    id: c.id, name: c.name, territory: c.terr, pos,
    type: c.type, capacity: c.capacity, rate: c.rate,
    produces: c.produces, defense: c.defense, multiplier: c.multiplier,
  };
  order.push(c.id);
}

// -------------------------------------------- constrained relaxation pass ---
// Real 1914 Europe is not evenly populated: Germany, Bohemia, the Alps and the
// Balkans pile a dozen cities into the space Russia spends on two. Projected
// honestly, those nodes overlap badly enough that the garrison numbers become
// unreadable. So: a few dozen passes of pairwise repulsion, under three hard
// constraints —
//   1. a station may NEVER leave its own territory polygon (verify-stations.js
//      enforces this, and a station outside its country is a lie);
//   2. no station drifts more than MAX_DRIFT px from its true projected spot,
//      so the map stays geographically honest;
//   3. fully deterministic — sorted ids, no rng, no clock. Two runs of this
//      script must produce a byte-identical data/stations.js.
// Anything that would break (1) or (2) is clamped or skipped, never forced.

// Node radii: this MUST mirror stationRadius() in render/map.js (NODE_R_MIN 9,
// NODE_R_MAX 19, sqrt so node AREA tracks capacity). If that formula changes,
// change it here too — these two are the only places the numbers live.
const NODE_R_MIN = 9, NODE_R_MAX = 19;
const NODE_PAD = 6;        // extra breathing room so the garrison label clears
const MAX_DRIFT = 25;      // px a station may move from its true position
const RELAX_PASSES = 150;
const RELAX_RATE = 0.35;   // fraction of the overlap resolved per pass, per node

const relaxed = (() => {
  const ids = order.slice().sort();
  let capMin = Infinity, capMax = -Infinity;
  for (const sid of ids) {
    const c = STATIONS[sid].capacity;
    if (c < capMin) capMin = c;
    if (c > capMax) capMax = c;
  }
  const radiusOf = cap => {
    if (capMax <= capMin) return (NODE_R_MIN + NODE_R_MAX) / 2;
    let t = (cap - capMin) / (capMax - capMin);
    t = Math.sqrt(t < 0 ? 0 : t > 1 ? 1 : t);
    return NODE_R_MIN + (NODE_R_MAX - NODE_R_MIN) * t;
  };

  const R = {}, poly = {}, cur = {};
  for (const sid of ids) {
    R[sid] = radiusOf(STATIONS[sid].capacity);
    poly[sid] = polyOf(STATIONS[sid].territory);
    cur[sid] = STATIONS[sid].pos.slice();
  }
  const want = (a, b) => R[a] + R[b] + NODE_PAD;

  // legal(): inside its own territory, with the same clearance the nudge pass
  // demands, and within MAX_DRIFT of the true projected city.
  const legal = (sid, p) =>
    dist(p, RAWPOS[sid]) <= MAX_DRIFT + 1e-9 &&
    pointInPoly(p, poly[sid]) && distToPoly(p, poly[sid]) >= INSET;

  const countOverlaps = pos => {
    let n = 0;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        if (dist(pos[ids[i]], pos[ids[j]]) < want(ids[i], ids[j])) n++;
    return n;
  };
  const before = countOverlaps(cur);

  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    const push = {};
    for (const sid of ids) push[sid] = [0, 0];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const target = want(a, b);
        let dx = cur[b][0] - cur[a][0], dy = cur[b][1] - cur[a][1];
        let d = Math.hypot(dx, dy);
        if (d >= target) continue;
        if (d < 1e-6) {          // exactly coincident: split along +x, deterministically
          dx = 1; dy = 0; d = 1;
        }
        // Non-linear on purpose. A plain linear spring lets a badly crowded
        // pair (Brussels/Lille) settle at a stable-but-unreadable 8px while a
        // dozen mild overlaps outvote it. Weighting by target/d makes a near
        // collision dominate everything else pushing that node.
        const shove = (target - d) * RELAX_RATE * 0.5 * Math.min(5, target / d);
        const ux = dx / d, uy = dy / d;
        push[a][0] -= ux * shove; push[a][1] -= uy * shove;
        push[b][0] += ux * shove; push[b][1] += uy * shove;
      }
    }
    for (const sid of ids) {
      const [px, py] = push[sid];
      if (px === 0 && py === 0) continue;
      let cand = [cur[sid][0] + px, cur[sid][1] + py];
      // Constraint 2 first: clamp the candidate back onto the drift disc.
      const anchor = RAWPOS[sid];
      const dd = dist(cand, anchor);
      if (dd > MAX_DRIFT) {
        const s = MAX_DRIFT / dd;
        cand = [anchor[0] + (cand[0] - anchor[0]) * s, anchor[1] + (cand[1] - anchor[1]) * s];
      }
      // Constraint 1: if the clamped candidate is outside the territory, retreat
      // along the step until it is legal again; if nothing is, skip this station.
      if (legal(sid, cand)) { cur[sid] = cand; continue; }
      let taken = null;
      for (let k = 3; k >= 1; k--) {
        const t = k / 4;
        const p = [cur[sid][0] + (cand[0] - cur[sid][0]) * t,
                   cur[sid][1] + (cand[1] - cur[sid][1]) * t];
        if (legal(sid, p)) { taken = p; break; }
      }
      if (taken) cur[sid] = taken;
    }
  }

  // Round to 0.1 exactly as the projection does, then re-check: rounding can
  // shave a hundredth of a pixel, and this file's whole promise is that the
  // written coordinate is inside the country.
  let moved = 0, maxMove = 0;
  const final = {};
  for (const sid of ids) {
    const rp = [r1(cur[sid][0]), r1(cur[sid][1])];
    final[sid] = legal(sid, rp) ? rp : STATIONS[sid].pos.slice();
    const m = dist(final[sid], STATIONS[sid].pos);
    if (m > 0.05) { moved++; if (m > maxMove) maxMove = m; }
    STATIONS[sid].pos = final[sid];
  }
  return { moved, maxMove: r1(maxMove), before, after: countOverlaps(final) };
})();

// Two stations closer than 6px cannot be told apart on screen.
{
  const bad = [];
  for (let i = 0; i < order.length; i++)
    for (let j = i + 1; j < order.length; j++)
      if (dist(STATIONS[order[i]].pos, STATIONS[order[j]].pos) < 6)
        bad.push(order[i] + '/' + order[j] + ' ' + r1(dist(STATIONS[order[i]].pos, STATIONS[order[j]].pos)) + 'px');
  if (bad.length) throw new Error('stations overlap on screen: ' + bad.join(', '));
}

// =============================================================== LINKS ======
// Link thresholds are GEOGRAPHIC, not pixel constants. They used to be raw px
// (60 / 120), which meant that widening the map's clip changed the fit scale
// and silently deleted 20 links — the same countries, the same cities, a
// different number of roads. Distances are stated in km and converted through
// the stored fit, so the graph is stable under any reframing of the viewBox.
//
// The Albers projection in tools/lib/project.js works on the unit sphere, so
// one projected unit is one earth radius; fit.k px per unit gives px per km.
const EARTH_R_KM = 6371;
const km = d => d * FIT.k / EARTH_R_KM;

const SHORT_INTRA_KM = 420;   // "these two cities are close enough to be one road"
const SECOND_MAX_KM = 820;    // a second crossing on a wide land border

const linkMap = new Map();   // "a~b" -> { a, b, dist, sea }
function addLink(a, b, sea) {
  if (a === b) return;
  const key = [a, b].sort().join('~');
  if (linkMap.has(key)) {
    if (sea) linkMap.get(key).sea = true;
    return;
  }
  const geo = dist(STATIONS[a].pos, STATIONS[b].pos);
  const rec = { a: [a, b].sort()[0], b: [a, b].sort()[1], dist: Math.round(geo * (sea ? 1.6 : 1)) };
  if (sea) rec.sea = true;
  linkMap.set(key, rec);
}

const byTerr = {};
for (const sid of order) (byTerr[STATIONS[sid].territory] = byTerr[STATIONS[sid].territory] || []).push(sid);

// --- within a territory: minimum spanning tree, plus every edge under 60px --
// The MST guarantees each territory is internally connected (which is what the
// homeland-reachability rule in scenario.js depends on); the short edges stop
// clustered cities from funnelling through one artificial bottleneck.
const SHORT_INTRA = km(SHORT_INTRA_KM);
for (const tid of Object.keys(byTerr)) {
  const ids = byTerr[tid];
  if (ids.length < 2) continue;
  const inTree = new Set([ids[0]]);
  while (inTree.size < ids.length) {
    let best = null, bestD = Infinity;
    for (const a of inTree) for (const b of ids) {
      if (inTree.has(b)) continue;
      const d = dist(STATIONS[a].pos, STATIONS[b].pos);
      if (d < bestD) { bestD = d; best = [a, b]; }
    }
    addLink(best[0], best[1], false);
    inTree.add(best[1]);
  }
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (dist(STATIONS[ids[i]].pos, STATIONS[ids[j]].pos) < SHORT_INTRA) addLink(ids[i], ids[j], false);
}

// --- across land borders: closest pair, plus a second for bigger pairs ------
// `neighbors` in data/map.js is derived from shared TopoJSON arcs, so it is
// exact — no adjacency guesswork here.
const SECOND_MAX = km(SECOND_MAX_KM);
const seenPair = new Set();
for (const tid of Object.keys(TERRITORIES).sort()) {
  for (const n of (TERRITORIES[tid].neighbors || [])) {
    const key = [tid, n].sort().join('~');
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    const A = byTerr[tid] || [], B = byTerr[n] || [];
    if (!A.length || !B.length) continue;
    const pairs = [];
    for (const a of A) for (const b of B) pairs.push([a, b, dist(STATIONS[a].pos, STATIONS[b].pos)]);
    pairs.sort((x, y) => x[2] - y[2]);
    addLink(pairs[0][0], pairs[0][1], false);
    if (A.length >= 3 && B.length >= 3) {
      const second = pairs.find(p => p[0] !== pairs[0][0] && p[1] !== pairs[0][1]);
      if (second && second[2] < SECOND_MAX) addLink(second[0], second[1], false);
    }
  }
}

// --- sea crossings ----------------------------------------------------------
for (const [a, b] of SEA) {
  if (!STATIONS[a] || !STATIONS[b]) throw new Error('sea link names unknown station: ' + a + '~' + b);
  addLink(a, b, true);
}

const LINKS = [...linkMap.values()].sort((x, y) => x.a < y.a ? -1 : x.a > y.a ? 1 : (x.b < y.b ? -1 : 1));

// --- assert one connected component ----------------------------------------
{
  const adj = {};
  for (const l of LINKS) { (adj[l.a] = adj[l.a] || []).push(l.b); (adj[l.b] = adj[l.b] || []).push(l.a); }
  const seen = new Set([order[0]]), stack = [order[0]];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of (adj[cur] || [])) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  }
  const lost = order.filter(s => !seen.has(s));
  if (lost.length) {
    // Report by territory: a whole missing territory means a missing sea link.
    const terrs = [...new Set(lost.map(s => STATIONS[s].territory))].sort();
    throw new Error('LINK GRAPH IS IN PIECES — ' + lost.length + ' station(s) unreachable from ' +
      order[0] + '. Territories cut off: ' + terrs.join(', ') + '. Add a sea crossing.');
  }
}

// ============================================================== SETUP =======
// Deterministic per-station fraction, so re-running the build never churns the
// numbers. Homelands start at 40-60% of capacity — a real base, with immediate
// pressure to expand. Neutrals start at 15-30%; neutral fortresses higher,
// because gating a chokepoint is their entire job.
function hashFrac(sid) {
  let h = 2166136261;
  for (let i = 0; i < sid.length; i++) { h ^= sid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}
const homeOf = {};
for (const p of POWERS) homeOf[p.home] = p.id;

const SETUP = {};
for (const sid of order) {
  const st = STATIONS[sid];
  const owner = homeOf[st.territory] || 'neutral';
  const f = hashFrac(sid);
  let frac;
  if (owner !== 'neutral') frac = 0.40 + f * 0.20;
  else if (st.type === 'defensive') frac = 0.35 + f * 0.15;
  else frac = 0.15 + f * 0.15;

  const total = Math.max(1, Math.round(st.capacity * frac));
  const u = { infantry: 0, artillery: 0, armour: 0 };
  if (st.type === 'producer') {
    // A producer's stock is what it makes; a little infantry holds the gate.
    const made = Math.round(total * 0.7);
    u[st.produces] = made;
    u.infantry = total - made;
  } else {
    u.infantry = total;
  }
  SETUP[sid] = { owner, units: u };
}

// Assertions the schema demands.
{
  const problems = [];
  for (const sid of order) if (!SETUP[sid]) problems.push(sid + ' has no SETUP entry');
  for (const sid of Object.keys(SETUP)) if (!STATIONS[sid]) problems.push('SETUP has non-station ' + sid);
  for (const p of POWERS) {
    if (!STATIONS[p.capital]) problems.push(p.id + ' capital ' + p.capital + ' is not a station');
    else if (SETUP[p.capital].owner !== p.id) problems.push(p.id + ' does not own its capital');
    const terrs = new Set(order.filter(s => SETUP[s].owner === p.id).map(s => STATIONS[s].territory));
    if (terrs.size !== 1) problems.push(p.id + ' owns ' + terrs.size + ' territories, expected exactly 1');
  }
  for (const sid of Object.keys(SETUP)) {
    const u = SETUP[sid].units;
    if (u.infantry + u.artillery + u.armour > STATIONS[sid].capacity)
      problems.push(sid + ' starts over capacity');
  }
  if (problems.length) throw new Error('SETUP problems:\n  ' + problems.join('\n  '));
}

// =============================================================== EMIT =======
let js = '// data/stations.js — GENERATED by tools/build-stations.js. Do not edit by hand.\n';
js += '// Positions are real city lon/lat pushed through the same Albers projection and\n';
js += '// viewBox fit as data/map.js (tools/lib/project.js + tools/lib/fit.json), so every\n';
js += '// station lands inside its own country by construction.\n\n';
js += 'const STATIONS = {\n';
for (const sid of order) {
  const s = STATIONS[sid];
  js += '  ' + sid + ': { id: ' + JSON.stringify(sid) + ', name: ' + JSON.stringify(s.name) +
        ', territory: ' + JSON.stringify(s.territory) + ', pos: [' + s.pos[0] + ', ' + s.pos[1] + '],\n' +
        '    type: ' + JSON.stringify(s.type) + ', capacity: ' + s.capacity + ', rate: ' + s.rate +
        ', produces: ' + JSON.stringify(s.produces) + ', defense: ' + s.defense +
        ', multiplier: ' + (s.multiplier === null ? 'null' : s.multiplier) + ' },\n';
}
js += '};\n\n';
js += '// Undirected; exactly one record per pair. `dist` is on-screen distance; sea\n';
js += '// crossings carry 1.6x so they are slow (01-data-schema.md).\n';
js += 'const LINKS = [\n';
for (const l of LINKS) {
  js += '  { a: ' + JSON.stringify(l.a) + ', b: ' + JSON.stringify(l.b) + ', dist: ' + l.dist +
        (l.sea ? ', sea: true' : '') + ' },\n';
}
js += '];\n';
fs.writeFileSync(OUT_STATIONS, js);

let sc = '// data/scenario.js — GENERATED by tools/build-stations.js. Do not edit by hand.\n';
sc += '// Every power starts holding exactly ONE territory — its homeland — and nothing\n';
sc += '// else. All other stations are neutral. Expansion is the entire game; this is a\n';
sc += '// deliberate departure from historical 1914 extents (00-vision.md §6).\n\n';
sc += 'const POWERS = {\n';
for (const p of POWERS) {
  sc += '  ' + p.id + ': { id: ' + JSON.stringify(p.id) + ', name: ' + JSON.stringify(p.name) +
        ', color: ' + JSON.stringify(p.color) + ', capital: ' + JSON.stringify(p.capital) +
        ', ai: ' + JSON.stringify(p.ai) + ' },\n';
}
sc += '  neutral: { id: "neutral", name: "Neutral", color: "#4a5261" },\n';
sc += '};\n\n';
sc += 'const SETUP = {\n';
for (const sid of order) {
  const s = SETUP[sid];
  sc += '  ' + sid + ': { owner: ' + JSON.stringify(s.owner) + ', units: { infantry: ' + s.units.infantry +
        ', artillery: ' + s.units.artillery + ', armour: ' + s.units.armour + ' } },\n';
}
sc += '};\n';
fs.writeFileSync(OUT_SCENARIO, sc);

// ============================================================== REPORT ======
const byType = {};
for (const sid of order) byType[STATIONS[sid].type] = (byType[STATIONS[sid].type] || 0) + 1;
console.log('wrote   : data/stations.js, data/scenario.js');
console.log('stations: ' + order.length + '  (' +
  Object.keys(byType).sort().map(t => t + ' ' + byType[t]).join(', ') + ')');
console.log('links   : ' + LINKS.length + '  (' + LINKS.filter(l => l.sea).length + ' sea crossings)');
console.log('powers  : ' + POWERS.length + ' + neutral;  owned stations ' +
  order.filter(s => SETUP[s].owner !== 'neutral').length + '/' + order.length);
console.log('density : ' + Object.keys(byTerr).sort()
  .map(t => t + ':' + byTerr[t].length).join(' '));
if (nudged.length) {
  console.log('nudged  : ' + nudged.length + ' city/cities moved inward off a simplified coastline');
  for (const n of nudged) console.log('          ' + n.id + ' ' + n.name + ' (' + n.terr + ') by ' + n.px + 'px');
} else {
  console.log('nudged  : none');
}
console.log('relaxed : ' + relaxed.moved + ' station(s) moved to unclog central Europe, ' +
  'largest displacement ' + relaxed.maxMove + 'px (cap ' + MAX_DRIFT + 'px)');
console.log('          overlapping pairs ' + relaxed.before + ' -> ' + relaxed.after +
  ' (target separation = both render radii + ' + NODE_PAD + 'px)');
