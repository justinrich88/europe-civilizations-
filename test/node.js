// test/node.js — headless runner. `node test/node.js` from the project root.
// Works because the project uses globals, not modules: every file is evaluated
// into this one shared context, exactly as <script src> would. Missing files
// are skipped, so the harness runs while the map is still being authored.
// Keep this list in sync with the <script> tags in tests.html.
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');
const SCRIPTS = [
  'core/rng.js', 'core/util.js', 'core/state.js',
  'data/tuning.js',
  // Map geometry: seams declare VERTS/TERRITORIES, regions Object.assign into
  // them. Seams MUST load first. See data/map-seams.js for why it is split.
  'data/map-seams.js',
  'data/map-isles.js', 'data/map-iberia.js', 'data/map-west.js',
  'data/map-north.js', 'data/map-central.js', 'data/map-east.js',
  'data/map-italy.js', 'data/map-balkans.js',
  'data/stations.js', 'data/scenario.js',
  'sim/commands.js', 'sim/growth.js', 'sim/movement.js', 'sim/combat.js',
  'sim/relations.js', 'sim/victory.js', 'sim/step.js', 'ai/ai.js',
  'test/asserts.js', 'test/runner.js',
];
for (const rel of SCRIPTS) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) continue;
  try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: rel }); }
  catch (e) { console.error('LOAD ERROR in ' + rel + ': ' + e.message); process.exit(2); }
}
runAllTests();
process.stdout.write(formatResults() + '\n');
process.exit(summarizeTests().fail === 0 ? 0 : 1);
