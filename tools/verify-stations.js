// tools/verify-stations.js — standalone station/link/scenario diagnostic.
//
//   node tools/verify-stations.js
//
// Same spirit as test/verify-map.js: a RECONCILIATION tool, not a test suite.
// It reports EVERY fault at once, grouped by category, so a bad city table can
// be fixed in one pass instead of one error per run. Exits non-zero if
// anything is wrong.

const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');

const FILES = ['data/map.js', 'data/stations.js', 'data/scenario.js'];
const loaded = [], missing = [];
for (const rel of FILES) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) { missing.push(rel); continue; }
  try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: rel }); loaded.push(rel); }
  catch (e) { console.error('LOAD ERROR in ' + rel + ': ' + e.message); process.exit(2); }
}

const problems = [];
const note = (cat, msg) => problems.push(cat + ': ' + msg);

const T = typeof TERRITORIES === 'undefined' ? {} : TERRITORIES;
const V = typeof VERTS === 'undefined' ? {} : VERTS;
const S = typeof STATIONS === 'undefined' ? {} : STATIONS;
const L = typeof LINKS === 'undefined' ? [] : LINKS;
const P = typeof POWERS === 'undefined' ? {} : POWERS;
const SU = typeof SETUP === 'undefined' ? {} : SETUP;

const sids = Object.keys(S).sort();
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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

// --- 1. placement -----------------------------------------------------------
// The whole point of projecting real lon/lat through the map's own fit is that
// a station cannot drift out of its country. If one has, the fit is wrong.
for (const sid of sids) {
  const st = S[sid];
  if (st.id !== sid) note('field', sid + ' has mismatched .id (' + st.id + ')');
  if (!st.name) note('field', sid + ' missing name');
  if (!T[st.territory]) { note('unknown-territory', sid + ' -> "' + st.territory + '"'); continue; }
  if (!Array.isArray(st.pos) || st.pos.length !== 2) { note('field', sid + ' malformed pos'); continue; }
  if (st.pos[0] < 0 || st.pos[0] > 1000 || st.pos[1] < 0 || st.pos[1] > 700)
    note('out-of-view', sid + ' at [' + st.pos + ']');
  const poly = T[st.territory].shape.map(v => V[v]);
  if (poly.some(p => !p)) { note('dangling', st.territory + ' shape references an undefined vertex'); continue; }
  if (!pointInPoly(st.pos, poly))
    note('outside-territory', sid + ' (' + st.name + ') is ' +
      distToPoly(st.pos, poly).toFixed(1) + 'px outside ' + st.territory);
}
for (let i = 0; i < sids.length; i++)
  for (let j = i + 1; j < sids.length; j++)
    if (Array.isArray(S[sids[i]].pos) && Array.isArray(S[sids[j]].pos) &&
        dist(S[sids[i]].pos, S[sids[j]].pos) < 6)
      note('overlap', sids[i] + '/' + sids[j] + ' are ' + dist(S[sids[i]].pos, S[sids[j]].pos).toFixed(1) + 'px apart');
for (const tid of Object.keys(T).sort())
  if (!sids.some(s => S[s].territory === tid))
    note('empty-territory', tid + ' has no stations — it can never be taken or lost');

// --- 2. type invariants (01-data-schema.md, verbatim) -----------------------
const SPEC = {
  holding:    { produces: ['infantry'],            capacity: [25, 80], rate: [0.7, 1.1],   defense: [1.0, 1.0], multiplier: false },
  producer:   { produces: ['artillery', 'armour'], capacity: [15, 35], rate: [0.4, 0.6],   defense: [1.0, 1.2], multiplier: false },
  multiplier: { produces: ['infantry'],            capacity: [8, 15],  rate: [0.3, 0.3],   defense: [0.8, 0.8], multiplier: [1.3, 1.8] },
  defensive:  { produces: ['infantry'],            capacity: [12, 25], rate: [0.3, 0.5],   defense: [2.0, 3.5], multiplier: false },
};
for (const sid of sids) {
  const st = S[sid], spec = SPEC[st.type];
  if (!spec) { note('bad-type', sid + ' has type "' + st.type + '"'); continue; }
  const band = (v, r, field) => {
    if (typeof v !== 'number' || v < r[0] - 1e-9 || v > r[1] + 1e-9)
      note('stat-band', sid + ' (' + st.type + ') ' + field + '=' + v + ', expected ' + r[0] + '-' + r[1]);
  };
  band(st.capacity, spec.capacity, 'capacity');
  band(st.rate, spec.rate, 'rate');
  band(st.defense, spec.defense, 'defense');
  if (spec.produces.indexOf(st.produces) < 0)
    note('produces', sid + ' (' + st.type + ') produces "' + st.produces + '"');
  if (spec.multiplier) {
    if (typeof st.multiplier !== 'number') note('multiplier', sid + ' is a multiplier with no value');
    else if (st.multiplier < 1.3 - 1e-9 || st.multiplier > 1.8 + 1e-9)
      note('multiplier', sid + ' multiplier=' + st.multiplier + ', expected 1.3-1.8');
  } else if (st.multiplier !== null && st.multiplier !== undefined) {
    note('multiplier', sid + ' (' + st.type + ') carries multiplier=' + st.multiplier);
  }
}
{
  const byType = {}, produced = {};
  for (const sid of sids) {
    byType[S[sid].type] = (byType[S[sid].type] || 0) + 1;
    if (S[sid].type === 'producer') produced[S[sid].produces] = true;
  }
  for (const t of ['holding', 'producer', 'multiplier', 'defensive'])
    if (!byType[t]) note('type-mix', 'no stations of type ' + t + ' exist');
  if (!produced.artillery) note('type-mix', 'nowhere makes artillery — fortresses become untakeable');
  if (!produced.armour) note('type-mix', 'nowhere makes armour');
  if (!(byType.holding > sids.length * 0.4)) note('type-mix', 'holdings should be most of the map');
  if (sids.length < 90 || sids.length > 110) note('count', 'station count ' + sids.length + ', design range 90-110');
}

// --- 3. LINKS ---------------------------------------------------------------
const seenPair = new Set();
const adj = {};
for (let i = 0; i < L.length; i++) {
  const l = L[i];
  if (!S[l.a]) note('bad-link', '#' + i + ' unknown station "' + l.a + '"');
  if (!S[l.b]) note('bad-link', '#' + i + ' unknown station "' + l.b + '"');
  if (l.a === l.b) note('bad-link', '#' + i + ' links ' + l.a + ' to itself');
  const key = [l.a, l.b].sort().join('~');
  if (seenPair.has(key)) note('duplicate-link', key + ' declared twice');
  seenPair.add(key);
  if (typeof l.dist !== 'number' || !(l.dist > 0)) note('bad-dist', key + ' dist=' + l.dist);
  else if (S[l.a] && S[l.b]) {
    const geo = dist(S[l.a].pos, S[l.b].pos);
    if (l.dist < geo / 3 || l.dist > geo * 3)
      note('bad-dist', key + ' dist=' + l.dist + ' but ' + Math.round(geo) + ' on screen');
  }
  (adj[l.a] = adj[l.a] || []).push(l.b);
  (adj[l.b] = adj[l.b] || []).push(l.a);
}
function flood(start, allow) {
  const seen = new Set([start]), stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of (adj[cur] || []))
      if (!seen.has(n) && (!allow || allow(n))) { seen.add(n); stack.push(n); }
  }
  return seen;
}
if (sids.length) {
  const seen = flood(sids[0]);
  for (const sid of sids) if (!seen.has(sid)) note('disconnected', sid + ' is unreachable from ' + sids[0]);
  for (const sid of sids) if (!adj[sid] || !adj[sid].length) note('isolated', sid + ' has no links at all');
  const sea = L.filter(l => l.sea === true).length;
  if (!sea) note('sea', 'no sea crossings — Britain cannot be reached');
  if (sea >= L.length * 0.15) note('sea', 'sea crossings should be a handful, got ' + sea + '/' + L.length);
}

// --- 4. SETUP coverage ------------------------------------------------------
for (const sid of sids) if (!SU[sid]) note('setup-coverage', sid + ' has no SETUP entry');
for (const sid of Object.keys(SU).sort()) {
  if (!S[sid]) { note('setup-coverage', 'SETUP has "' + sid + '" which is not a station'); continue; }
  if (!P[SU[sid].owner]) note('unknown-owner', sid + ' owned by "' + SU[sid].owner + '"');
  const u = SU[sid].units;
  if (!u) { note('garrison', sid + ' has no units block'); continue; }
  for (const t of ['infantry', 'artillery', 'armour'])
    if (typeof u[t] !== 'number' || u[t] < 0 || !isFinite(u[t])) note('garrison', sid + '.' + t + '=' + u[t]);
  const tot = u.infantry + u.artillery + u.armour;
  if (tot > S[sid].capacity + 1e-9) note('garrison', sid + ' starts with ' + tot + ' but capacity is ' + S[sid].capacity);
}

// --- 5. POWERS: capital owned, everything reachable from it -----------------
if (!P.neutral) note('powers', '"neutral" must be a real power id');
else {
  if (P.neutral.capital) note('powers', 'neutral must have no capital');
  if (P.neutral.ai) note('powers', 'neutral must have no AI');
}
for (const pid of Object.keys(P).sort()) {
  if (pid === 'neutral') continue;
  const p = P[pid];
  if (!p.color) note('powers', pid + ' has no color');
  if (!['expansionist', 'turtle', 'opportunist'].includes(p.ai))
    note('powers', pid + ' has AI personality "' + p.ai + '"');
  if (!p.capital) { note('powers', pid + ' has no capital'); continue; }
  if (!S[p.capital]) { note('powers', pid + ' capital "' + p.capital + '" is not a station'); continue; }
  if (!SU[p.capital] || SU[p.capital].owner !== pid) {
    note('powers', pid + ' does not start owning its capital ' + p.capital);
    continue;
  }
  const owns = sids.filter(s => SU[s] && SU[s].owner === pid);
  if (!owns.length) { note('powers', pid + ' starts owning nothing'); continue; }
  // --- 6. exactly one territory each ---------------------------------------
  const terrs = [...new Set(owns.map(s => S[s].territory))].sort();
  if (terrs.length !== 1)
    note('homeland', pid + ' owns ' + terrs.length + ' territories (' + terrs.join(',') + '), expected exactly 1');
  const all = sids.filter(s => S[s].territory === terrs[0]);
  for (const s of all)
    if (!owns.includes(s)) note('homeland', pid + ' does not own ' + s + ' inside its own homeland ' + terrs[0]);
  const reach = flood(p.capital, s => SU[s] && SU[s].owner === pid);
  for (const s of owns)
    if (!reach.has(s)) note('unreachable', pid + ': ' + s + ' is cut off from ' + p.capital + ' at game start');
}
{
  const n = Object.keys(P).filter(pid => pid !== 'neutral').length;
  if (n < 4 || n > 8) note('powers', 'playable power count is ' + n + ', expected 4-8');
}

// --- report -----------------------------------------------------------------
console.log('loaded  : ' + loaded.length + '/' + FILES.length + ' files');
if (missing.length) console.log('MISSING : ' + missing.join(', '));
const byType = {};
for (const sid of sids) byType[S[sid].type] = (byType[S[sid].type] || 0) + 1;
console.log('stations: ' + sids.length + '  (' + Object.keys(byType).sort().map(t => t + ' ' + byType[t]).join(', ') + ')');
console.log('links   : ' + L.length + '  (' + L.filter(l => l.sea).length + ' sea)');
console.log('owned   : ' + Object.keys(SU).filter(s => SU[s].owner !== 'neutral').length + '/' + sids.length +
  ' stations across ' + Object.keys(P).filter(p => p !== 'neutral').length + ' powers');
console.log('');
if (!problems.length) {
  console.log('OK — no station/link/scenario problems.');
} else {
  const byCat = {};
  for (const p of problems) { const c = p.split(':')[0]; (byCat[c] = byCat[c] || []).push(p); }
  console.log(problems.length + ' PROBLEM(S), by category:\n');
  for (const [c, list] of Object.entries(byCat)) {
    console.log('  ' + c + ' (' + list.length + ')');
    for (const p of list) console.log('    ' + p.slice(c.length + 2));
    console.log('');
  }
}
process.exit(problems.length || missing.length ? 1 : 0);
