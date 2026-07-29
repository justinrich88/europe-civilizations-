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
//             -> derive the coastline -> sea crossings between coastal cities
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
// The FLOOR, by station id — the crossings the design names out loud
// (00-vision.md §3). Everything else is derived from the coastline further
// down; these are added whether or not the derivation finds them, because they
// encode real chokepoints and the "one connected component" assertion leans on
// them. Seven of the ten come back out of the derivation on their own, which
// is its best self-check; the three that do not are named where the floor is
// applied, each for a reason worth knowing.
const SEA_FLOOR = [
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
// Each power starts holding exactly ONE STATION — its capital — and nothing
// else. Everything else on the board is neutral, including the rest of the
// power's own homeland. Expansion is the entire game.
//
// `home` no longer decides ownership; it survives because it names which
// territory a power is culturally seated in, which the colours and the map
// legend still read as identity.
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
    // A pair the land passes already claimed. Promoting it to sea has to
    // re-cost it too: `ank~ist` and `bar~spl` are floor crossings that the
    // border pass reached first, and for want of this line they shipped as sea
    // links carrying a LAND distance — the Bosporus at road speed.
    const rec = linkMap.get(key);
    if (sea && !rec.sea) {
      rec.sea = true;
      rec.dist = Math.round(dist(STATIONS[a].pos, STATIONS[b].pos) * 1.6);
    }
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

// --- the coastline ----------------------------------------------------------
// Ten hardcoded pairs are a set of bridges, not a sea (02-visibility-and-sea.md
// §3a). The second network is derived from real geometry instead, in three
// steps: work out where the water is, work out which cities are on it, then
// work out which straight lines between them actually cross it.
//
// Step 1 — WHERE THE WATER IS. "Land" is the union of the 30 territory
// polygons. That is not the same as "not sea": Kosovo, the IJsselmeer and the
// far side of the map clip are all holes in the modelled land, and a link drawn
// across one of them would be a road pretending to be a ferry. So the land mask
// is rasterised and open water is FLOOD FILLED inward from the edge of the
// viewBox. Anything unpainted is an enclave — a hole with no way out to a real
// sea — and counts as land. Deterministic: a fixed grid, a fixed fill order,
// no rng, no clock.
const CELL = 1.5;              // raster cell, viewBox units (~8.7 km)
const COAST_EPS = 1.5;         // how far off a polygon edge to sample for water
const GW = Math.ceil(1000 / CELL) + 2, GH = Math.ceil(700 / CELL) + 2;

const TIDS = Object.keys(TERRITORIES).sort();
const POLYS = {}, BBOX = {};
for (const tid of TIDS) {
  POLYS[tid] = polyOf(tid);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of POLYS[tid]) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  BBOX[tid] = [x0, y0, x1, y1];
}
const onLand = p => {
  for (const tid of TIDS) {
    const b = BBOX[tid];
    if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
    if (pointInPoly(p, POLYS[tid])) return true;
  }
  return false;
};

const gLand = new Uint8Array(GW * GH);
for (let j = 0; j < GH; j++)
  for (let i = 0; i < GW; i++)
    if (onLand([(i - 0.5) * CELL, (j - 0.5) * CELL])) gLand[j * GW + i] = 1;

const gOpen = new Uint8Array(GW * GH);
{
  const stack = [];
  for (let i = 0; i < GW; i++) stack.push([i, 0], [i, GH - 1]);
  for (let j = 0; j < GH; j++) stack.push([0, j], [GW - 1, j]);
  while (stack.length) {
    const [i, j] = stack.pop();
    if (i < 0 || j < 0 || i >= GW || j >= GH) continue;
    const k = j * GW + i;
    if (gOpen[k] || gLand[k]) continue;
    gOpen[k] = 1;
    stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
  }
}
// Water = off every territory polygon AND in a cell the open sea reaches.
const isWater = p => {
  if (onLand(p)) return false;
  const i = Math.round(p[0] / CELL + 0.5), j = Math.round(p[1] / CELL + 0.5);
  if (i < 0 || j < 0 || i >= GW || j >= GH) return true;   // outside the frame is sea
  return !!gOpen[j * GW + i];
};

// Step 2 — THE COASTLINE ITSELF. A polygon edge is coast when the side of it
// facing AWAY from its own territory is open water. Border edges fail this by
// construction: map.js assembles neighbours from shared arcs, so the outward
// side of a border edge lands inside the neighbour.
const COASTLINE = [];
for (const tid of TIDS) {
  const P = POLYS[tid];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (!L) continue;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const nx = -dy / L, ny = dx / L;
    const p1 = [mx + nx * COAST_EPS, my + ny * COAST_EPS];
    const p2 = [mx - nx * COAST_EPS, my - ny * COAST_EPS];
    if (isWater(pointInPoly(p1, P) ? p2 : p1)) COASTLINE.push([a, b]);
  }
}
const distToCoast = p => {
  let best = Infinity;
  for (const e of COASTLINE) {
    const a = e[0], b = e[1];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    if (d < best) best = d;
  }
  return best;
};

// --- sea crossings ----------------------------------------------------------
// Step 3 — WHICH LINES CROSS IT. Five constants, all geographic, all stated in
// km through the same km() the land thresholds use.
const COASTAL_KM = 70;         // a port is a city this close to open water. The
                               // nudge pass parks coastal cities exactly INSET
                               // (~15 km) inside a simplified outline, so the
                               // floor of the measured distribution is 15, not
                               // 0; 70 is its first real gap (Tirana 63 -> the
                               // Ruhr 83) and is what admits Lisbon, Oslo and
                               // Bordeaux without admitting Berlin.
const SEA_MAX_KM = 700;        // the longest crossing the design will grant —
                               // roughly the Bay of Biscay. Wider than this and
                               // it stops reading as one amphibious bound and
                               // starts reading as a naval campaign, which
                               // 00-vision.md §3 explicitly does not want.
const MIN_SEA_GAP_KM = 50;     // a crossing must have this much OPEN WATER in
                               // one unbroken stretch. The Straits of Dover are
                               // the tightest crossing the design must admit and
                               // measure 57 km on this board, so the bar sits
                               // just under them. This is what stops two cities
                               // on the same beach acquiring a "crossing".
const MAX_INTERIOR_LAND_KM = 45;  // land BETWEEN the first and last water on the
                               // line. Zero would be right if cities sat on the
                               // shore; they are nudged inland, so Dover ->
                               // Lille clips 40 km of French coast on its way
                               // out. Above this the line is a march with a
                               // puddle in it, not a crossing.
const NEAREST_CROSSINGS = 1;   // how many of its own shortest crossings each
                               // port keeps; the network is the UNION, so a
                               // station ends up with more when several other
                               // ports name it (Aalborg is the nearest partner
                               // of five Scandinavian ports, and that is the
                               // shape of the Skagerrak, not an artefact).
                               // 1 is not timidity: it is the budget. The real
                               // ceiling is external — test/runner.js asserts
                               // sea links are under 15% of all links ("a
                               // handful", 00-vision.md §3), which against 204
                               // land links means at most 35 in total. Raising
                               // this to 2 produces ~40 and fails that
                               // assertion; the assertion, not the geometry, is
                               // what decides how big this network may be.

// Cities the SIMPLIFIED outline misreads as ports.
//
// The coast is derived from `data/map.js`, whose polygons are simplified Natural
// Earth borders. Simplification cuts inland where a coast is intricate, so a few
// cities measure much closer to "open water" than they are on Earth. Distance
// alone cannot separate them: Trento measures 34km, and any threshold that
// excludes it also excludes Bordeaux at 49km and Oslo at 59km, which are real
// ports. So the correction goes here, per city, with the real number stated.
//
// Trento is the one that mattered. It is a DEFENSIVE station — an Alpine
// fortress whose entire design job is to gate a mountain chokepoint (00-vision
// §2). A derived `spl~tre` crossing handed it a Dalmatian port and let an
// attacker skip the mountains altogether, which is the opposite of what the
// station is for. A wrong link is worse than a missing one here: it does not
// look like a bug, it looks like a route.
const NO_SEA = {
  tre: 'Trento — Alpine fortress, ~110km from the Adriatic; the outline eats the Venetian lagoon',
};

const SEA_MAX = km(SEA_MAX_KM);
const coastalIds = order.slice().sort().filter(sid =>
  !NO_SEA[sid] && distToCoast(STATIONS[sid].pos) <= km(COASTAL_KM));

// Walk the segment and measure water. Both endpoints are on land by
// construction, so the water is always interior.
const SAMPLE_PX = 1.0;
function crossing(a, b) {
  const A = STATIONS[a].pos, B = STATIONS[b].pos;
  const L = dist(A, B), n = Math.max(2, Math.ceil(L / SAMPLE_PX));
  const wet = [];
  let run = 0, longest = 0, first = -1, last = -1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = isWater([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]);
    wet.push(w);
    if (w) { if (first < 0) first = i; last = i; run++; if (run > longest) longest = run; }
    else run = 0;
  }
  let inner = 0;
  if (first >= 0) for (let i = first; i <= last; i++) if (!wet[i]) inner++;
  const per = L / n;
  return { len: L, water: longest * per, land: inner * per };
}

// Cheapest LAND-ONLY route between two stations, or Infinity. Computed on the
// graph as it stands before a single crossing is added, so it is the road the
// crossing would be competing with and nothing else.
const landRoute = (() => {
  const adj = {};
  for (const rec of linkMap.values()) {
    (adj[rec.a] = adj[rec.a] || []).push([rec.b, rec.dist]);
    (adj[rec.b] = adj[rec.b] || []).push([rec.a, rec.dist]);
  }
  const cache = {};
  return (from, to) => {
    if (!cache[from]) {
      const d = {};
      for (const sid of order) d[sid] = Infinity;
      d[from] = 0;
      const left = new Set(order);
      while (left.size) {
        let cur = null, best = Infinity;
        for (const sid of order) if (left.has(sid) && d[sid] < best) { best = d[sid]; cur = sid; }
        if (cur === null) break;
        left.delete(cur);
        for (const [n, w] of (adj[cur] || [])) if (d[cur] + w < d[n]) d[n] = d[cur] + w;
      }
      cache[from] = d;
    }
    return cache[from][to];
  };
})();

const seaReject = { land: 0, gap: 0, inner: 0, road: 0, far: 0, already: 0 };
const seaRejectEg = [];
const seaCands = [];
for (let i = 0; i < coastalIds.length; i++) {
  for (let j = i + 1; j < coastalIds.length; j++) {
    const a = coastalIds[i], b = coastalIds[j];
    if (dist(STATIONS[a].pos, STATIONS[b].pos) > SEA_MAX) continue;
    // Never convert an existing road into a ferry: a pair already joined by
    // land does not need a redundant crossing, and flipping the record would
    // silently make a land march pay the sea toll.
    if (linkMap.has([a, b].sort().join('~'))) { seaReject.already++; continue; }
    const c = crossing(a, b);
    if (c.water === 0) {
      seaReject.land++;
      if (seaRejectEg.length < 6) seaRejectEg.push(a + '~' + b + ' entirely overland');
      continue;
    }
    if (c.water < km(MIN_SEA_GAP_KM)) { seaReject.gap++; continue; }
    if (c.land > km(MAX_INTERIOR_LAND_KM)) {
      seaReject.inner++;
      if (seaRejectEg.length < 6)
        seaRejectEg.push(a + '~' + b + ' ' + Math.round(c.land * EARTH_R_KM / FIT.k) + 'km of land mid-line');
      continue;
    }
    // A crossing that is LONGER than the road between the same two cities is
    // not a new theatre, it is a parallel road. Aalborg->Hamburg (92) beside
    // Aalborg-Aarhus-Hamburg (58); Glasgow->London (161) beside the length of
    // England. Both are real water on this outline and both are useless: no
    // router will ever choose them, and they clutter the hop graph the AI
    // reasons over. Measured against the LAND-ONLY graph, so anything an army
    // genuinely cannot walk to — every island, everything across the Baltic —
    // has an infinite road and is always kept.
    if (Math.round(c.len * 1.6) >= landRoute(a, b)) {
      seaReject.road++;
      if (seaRejectEg.length < 8)
        seaRejectEg.push(a + '~' + b + ' crossing ' + Math.round(c.len * 1.6) +
          ' vs road ' + landRoute(a, b));
      continue;
    }
    seaCands.push({ a, b, len: c.len });
  }
}
// Every valid crossing would be a lot of graph, so each port keeps its
// NEAREST_CROSSINGS shortest and the network is the UNION of those choices.
// Union, not a running degree cap: a cap applied greedily cascades — Dublin,
// Cardiff and Cork fill up on short hops and Glasgow, refused by all three,
// ends up married to its worst remaining option (a 585 km line to London that
// grazes the Irish Sea). Under the union rule a port's own shortlist is never
// taken from it, and a station may still finish with more than
// NEAREST_CROSSINGS links if several other ports name it — Aalborg ends with
// five because it is the nearest partner of half of Scandinavia, which is the
// shape of the Skagerrak rather than an artefact.
const shortlist = {};
for (const sid of coastalIds) shortlist[sid] = [];
for (const c of seaCands) { shortlist[c.a].push(c); shortlist[c.b].push(c); }
const byLen = (x, y) => x.len - y.len || (x.a < y.a ? -1 : x.a > y.a ? 1 : (x.b < y.b ? -1 : 1));
const keep = new Set();
for (const sid of coastalIds)
  for (const c of shortlist[sid].sort(byLen).slice(0, NEAREST_CROSSINGS)) keep.add(c.a + '~' + c.b);
seaReject.far = seaCands.length - keep.size;
const seaDerived = seaCands.slice().sort(byLen).filter(c => keep.has(c.a + '~' + c.b));
for (const c of seaDerived) addLink(c.a, c.b, true);

// The floor last, so a named chokepoint is never lost to a shortlist. Three of
// the ten do not come back out of the derivation, and each says something true
// about the board rather than about the rules:
//   ist~ank  Natural Earth's largest ring for Turkey is Anatolia, so
//            Constantinople was nudged across the Bosporus onto the Asian
//            shore. The strait does not exist as water here at all.
//   bar~spl  the ita/hrv border pass already claimed the pair as a road, so it
//            is promoted rather than derived (and re-costed by addLink).
//   mec~aar  the Danish straits are 75 by sea against 70 by road through
//            Hamburg, so the parallel-road rule declines them. Kept because
//            00-vision.md §3 names them and because a Denmark reachable only
//            through Hamburg is a worse map.
const floorOnly = [];
for (const [a, b] of SEA_FLOOR) {
  if (!STATIONS[a] || !STATIONS[b]) throw new Error('sea link names unknown station: ' + a + '~' + b);
  if (!seaDerived.some(c => c.a === [a, b].sort()[0] && c.b === [a, b].sort()[1])) floorOnly.push(a + '~' + b);
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
// numbers.
//
// A power owns its CAPITAL and nothing else. Everything else — including the
// other cities of its own homeland — is neutral and has to be taken.
//
// That makes the capital's starting garrison the whole of a power's opening
// budget, so it is filled near capacity rather than the 40-60% a homeland used
// to start at. The arithmetic that matters: at GROWTH_BASE 0.004 and rate ~0.9
// a station climbs from half to 90% of capacity in roughly 1200 ticks (two
// sim-minutes), while neutral garrisons harden from ~20% to ~99% of capacity
// within 3000 ticks. Open at 50% and the neutrals nearest you harden faster
// than you can regrow to afford them, and the first move of the game is to
// wait — which is the one opening the design cannot have. Open near full and
// you have exactly one real volley in hand on turn zero.
const CAPITAL_FILL = 0.90;   // of capacity; the entire opening budget

function hashFrac(sid) {
  let h = 2166136261;
  for (let i = 0; i < sid.length; i++) { h ^= sid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}
const capitalOf = {};
for (const p of POWERS) capitalOf[p.capital] = p.id;

const SETUP = {};
for (const sid of order) {
  const st = STATIONS[sid];
  const owner = capitalOf[sid] || 'neutral';
  const f = hashFrac(sid);
  let frac;
  if (owner !== 'neutral') frac = CAPITAL_FILL;
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
    // Exactly one station, and it is the capital. This replaces the old
    // "exactly one territory" assertion, which a capital-only opening would
    // pass for the wrong reason: a power holding one city in a nine-city
    // country controls no territory at all under the majority rule, so the
    // territory count is 0 and an assertion written against territories has
    // nothing left to catch.
    const mine = order.filter(s => SETUP[s].owner === p.id);
    if (mine.length !== 1) problems.push(p.id + ' owns ' + mine.length + ' stations, expected exactly 1');
    else if (mine[0] !== p.capital) problems.push(p.id + ' owns ' + mine[0] + ', not its capital ' + p.capital);
  }
  for (const sid of Object.keys(SETUP)) {
    const u = SETUP[sid].units;
    const tot = u.infantry + u.artillery + u.armour;
    // core/state.js's totalUnits() is the canonical way to add a bundle up and
    // it is NOT reachable here: this script loads data/map.js into a sandbox
    // and nothing else, deliberately — a generator that had to boot the sim to
    // check its own output would be circular. So the sum stays spelled out, and
    // the isFinite gate is what pays for that.
    //
    // It is not decoration. `NaN > capacity` is FALSE, like every comparison
    // against NaN, so the moment the unit bundle changes shape this assertion
    // stops firing rather than starting to — it would wave through a whole
    // generated scenario of garrisons that add up to nothing. An unguarded sum
    // is only loud where its result gets PRINTED; inside an `if`, it is silent.
    if (!isFinite(tot)) {
      problems.push(sid + ' garrison sums to ' + tot + ' — SETUP units are not the ' +
        '{infantry, artillery, armour} shape this script emits, so the capacity ' +
        'check below cannot run');
    } else if (tot > STATIONS[sid].capacity) {
      problems.push(sid + ' starts over capacity');
    }
  }
  if (problems.length) throw new Error('SETUP problems:\n  ' + problems.join('\n  '));
}

// ============================================================== VISION ======
// `vision` is how many link-hops a station sees for its owner (fog of war,
// 02-visibility-and-sea.md §1). It is a NUMERIC PROPERTY on the station record,
// deliberately NOT a fifth station type: 00-vision.md §8 already spends the
// silhouette budget on holding/multiplier/producer/defensive and there is no
// shape left to spend. As data it costs one field and no render legend.
//
// The rule, in full:
//
//   1. every station sees 1 hop;
//   2. every `defensive` station sees 2 — a citadel exists to watch ground, and
//      it is the one type whose whole purpose is already "this square is being
//      held and observed";
//   3. plus the explicitly authored table below.
//
// Rule 3 is an ID LIST ON PURPOSE, not a heuristic. A heuristic ("any station
// with >= 3 sea links", "any port on a chokepoint") re-derives itself every
// time this script runs, so a coastline nudge or a new sea crossing silently
// re-rolls who can see — a balance change nobody wrote and no diff explains.
// An id list drifts only when a human edits it.
//
// The four intended observation points from the design are Gibraltar, the
// Dardanelles, Dover and Kiel. Two of those (gib, dar) are already `defensive`
// and get their 2 from rule 2, so they are NOT repeated here — listing them
// twice would make the table lie about how many stations it is responsible for.
// `mec` (Mecklenburg) is the German Baltic coast, i.e. the Kiel station of this
// map. `ist` is the Bosphorus, the other half of the Straits with `dar`. `aal`
// (Aalborg) is the Skagerrak narrows, five sea links wide. `vlo` (Vlore) is the
// Strait of Otranto, the mouth of the Adriatic.
const VISION_DEFAULT = 1;
const VISION_OBSERVATION = [
  'aal',    // Aalborg — the Skagerrak / Kattegat narrows into the Baltic
  'dov',    // Dover — the Straits of Dover
  'ist',    // Constantinople — the Bosphorus
  'mec',    // Mecklenburg — the German Baltic shore (the map's Kiel)
  'vlo',    // Vlore — the Strait of Otranto, mouth of the Adriatic
];
{
  const problems = [];
  for (const sid of VISION_OBSERVATION) {
    if (!STATIONS[sid]) { problems.push('observation point ' + sid + ' is not a station'); continue; }
    if (STATIONS[sid].type === 'defensive')
      problems.push(sid + ' is defensive and already sees 2 — remove it from VISION_OBSERVATION');
  }
  if (problems.length) throw new Error('VISION problems:\n  ' + problems.join('\n  '));

  const obs = new Set(VISION_OBSERVATION);
  for (const sid of order) {
    const st = STATIONS[sid];
    st.vision = (st.type === 'defensive' || obs.has(sid)) ? 2 : VISION_DEFAULT;
  }
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
        ', multiplier: ' + (s.multiplier === null ? 'null' : s.multiplier) +
        ', vision: ' + s.vision + ' },\n';
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
sc += '// Every power starts holding exactly ONE STATION — its capital — and nothing\n';
sc += '// else. The rest of its own homeland is neutral and must be taken like any\n';
sc += '// other ground. Expansion is the entire game; this is a deliberate departure\n';
sc += '// from historical 1914 extents (00-vision.md §6).\n\n';
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
console.log('vision  : ' + order.filter(s => STATIONS[s].vision === 2).length + '/' + order.length +
  ' stations see 2 hops  (' + order.filter(s => STATIONS[s].type === 'defensive').length +
  ' defensive + ' + VISION_OBSERVATION.length + ' authored: ' + VISION_OBSERVATION.join(', ') + ')');
console.log('coast   : ' + COASTLINE.length + ' coastal edges of ' +
  TIDS.reduce((n, t) => n + POLYS[t].length, 0) + ';  ' + coastalIds.length + '/' + order.length +
  ' stations within ' + COASTAL_KM + 'km of open water');
console.log('sea     : ' + seaDerived.length + ' derived + ' + floorOnly.length + ' floor-only (' +
  (floorOnly.join(', ') || 'none') + ')');
console.log('          rejected: ' + seaReject.land + ' never left land, ' + seaReject.gap +
  ' water gap <' + MIN_SEA_GAP_KM + 'km, ' + seaReject.inner + ' >' + MAX_INTERIOR_LAND_KM +
  'km land mid-line, ' + seaReject.road + ' parallel to a shorter road, ' + seaReject.already +
  ' already a road, ' + seaReject.far + ' outside every port\'s nearest ' + NEAREST_CROSSINGS);
for (const e of seaRejectEg) console.log('          e.g. ' + e);
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
