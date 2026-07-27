// test/verify-map.js — standalone cross-region geometry diagnostic.
//
//   node test/verify-map.js
//
// Distinct from `test/node.js`, which runs the assertion suites. This one is a
// *reconciliation* tool: it reports EVERY geometry fault at once so the whole
// map can be fixed in one pass, rather than failing on the first bad edge.
// Same spirit as `assertNone()` in test/asserts.js.
//
// It exists because map geometry is authored by eight independent agents, one
// per region (see docs/design/01-data-schema.md). Within a region an author can
// see all its own borders; across a seam it cannot. So cross-region faults are
// expected on first assembly and this is the tool that finds them.

const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');

const REGION_FILES = ['data/map.js'];

const loaded = [], missing = [];
for (const rel of REGION_FILES) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) { missing.push(rel); continue; }
  try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: rel }); loaded.push(rel); }
  catch (e) { console.error('LOAD ERROR in ' + rel + ': ' + e.message); process.exit(2); }
}

const problems = [];
const note = (cat, msg) => problems.push(cat + ': ' + msg);

const T = typeof TERRITORIES === 'undefined' ? {} : TERRITORIES;
const V = typeof VERTS === 'undefined' ? {} : VERTS;
const ids = Object.keys(T).sort();

// --- 1. every shape id resolves --------------------------------------------
for (const id of ids)
  for (const v of T[id].shape)
    if (!V[v]) note('dangling', id + ' references undefined vertex ' + v);

// --- 2. vertex id shape -----------------------------------------------------
// Generated ids are v<n>. The old hand-authored per-region prefixes are gone.
for (const v of Object.keys(V))
  if (!/^v\d+$/.test(v)) note('vertex-id', v + ' is not of the form v<number>');

// --- 3. near-duplicate vertices --------------------------------------------
// The cardinal sin: two vertices at almost the same coordinate mean a shared
// edge silently fails to derive, producing a sliver instead of a border.
const vs = Object.entries(V);
for (let i = 0; i < vs.length; i++)
  for (let j = i + 1; j < vs.length; j++) {
    const dx = vs[i][1][0] - vs[j][1][0], dy = vs[i][1][1] - vs[j][1][1];
    const d = Math.hypot(dx, dy);
    if (d < 4) note('near-dup', vs[i][0] + ' and ' + vs[j][0] + ' are ' + d.toFixed(1) + 'px apart');
  }

// --- 4. adjacency: derived from shared edges vs declared --------------------
const edgeOwners = {};
for (const id of ids) {
  const s = T[id].shape;
  for (let i = 0; i < s.length; i++) {
    const key = [s[i], s[(i + 1) % s.length]].sort().join('|');
    (edgeOwners[key] = edgeOwners[key] || []).push(id);
  }
}
for (const [key, owners] of Object.entries(edgeOwners))
  if (owners.length > 2) note('over-shared', 'edge ' + key + ' is used by ' + owners.join(', '));

const derived = {};
ids.forEach(i => derived[i] = new Set());
for (const owners of Object.values(edgeOwners))
  if (owners.length === 2) { derived[owners[0]].add(owners[1]); derived[owners[1]].add(owners[0]); }

for (const id of ids) {
  const dec = new Set(T[id].neighbors || []);
  for (const n of dec) {
    if (!T[n]) { note('unknown-neighbor', id + ' declares neighbor ' + n + ' which does not exist'); continue; }
    if (!derived[id].has(n)) note('declared-not-shared', id + ' declares ' + n + ' but they share no edge');
  }
  for (const n of derived[id])
    if (!dec.has(n)) note('shared-not-declared', id + ' shares an edge with ' + n + ' but does not declare it');
}

// --- 5. symmetry ------------------------------------------------------------
for (const id of ids)
  for (const n of (T[id].neighbors || []))
    if (T[n] && !(T[n].neighbors || []).includes(id))
      note('asymmetric', id + ' lists ' + n + ' but ' + n + ' does not list ' + id);

// --- 6. seam integrity ------------------------------------------------------
// Both regions meeting at a seam must reference its vertices. A seam vertex
// referenced by fewer than two territories means one side ignored it.
if (typeof SEAMS !== 'undefined') {
  const useCount = {};
  for (const id of ids) for (const v of T[id].shape) if (/^s/.test(v)) (useCount[v] = useCount[v] || []).push(id);
  for (const [seam, run] of Object.entries(SEAMS))
    for (const v of run) {
      const users = useCount[v] || [];
      if (users.length === 0) note('seam-unused', v + ' (' + seam + ') is referenced by no territory');
      else if (users.length === 1) note('seam-one-sided', v + ' (' + seam + ') only used by ' + users[0]);
    }
}

// --- 7. required fields + connectivity -------------------------------------
for (const id of ids) {
  const t = T[id];
  if (t.id !== id) note('field', id + ' has mismatched .id (' + t.id + ')');
  if (!t.name) note('field', id + ' missing name');
  if (!Array.isArray(t.shape) || t.shape.length < 3) note('field', id + ' shape must have >= 3 vertices');
  if (!Array.isArray(t.label) || t.label.length !== 2) note('field', id + ' missing/!2 label');
  if (!['plains','hills','mountains','forest','urban'].includes(t.terrain)) note('field', id + ' bad terrain: ' + t.terrain);
  if (typeof t.coastal !== 'boolean') note('field', id + ' coastal must be boolean');
}

// Land-connectivity islands (informational — sea LINKS join these later).
const seen = new Set(), groups = [];
for (const id of ids) {
  if (seen.has(id)) continue;
  const g = [], stack = [id];
  seen.add(id);
  while (stack.length) {
    const cur = stack.pop(); g.push(cur);
    for (const n of derived[cur]) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  }
  groups.push(g.sort());
}

// --- report -----------------------------------------------------------------
console.log('loaded  : ' + loaded.length + '/' + REGION_FILES.length + ' files');
if (missing.length) console.log('MISSING : ' + missing.join(', '));
console.log('geometry: ' + ids.length + ' territories, ' + Object.keys(V).length + ' vertices');
console.log('landmass: ' + groups.length + ' land-connected group(s) — '
  + groups.map(g => g.length).sort((a, b) => b - a).join(', ')
  + '  (islands are expected; sea LINKS join them)');
console.log('');
if (!problems.length) {
  console.log('OK — no geometry problems.');
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
