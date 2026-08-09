// tools/balance.js — headless Monte Carlo balance harness.
//
//   node tools/balance.js [games] [--seed N] [--ticks N] [--csv]
//
// Milestone 2's preview moment (docs/design/00-vision.md §11): run hundreds of
// games with no rendering and print the three numbers that are the dashboard —
//
//   * win-rate spread across the seven powers
//   * mean game length
//   * mean time-to-first-station-flip
//
// TWO DRIVERS, chosen automatically:
//
//   * ai/ai.js if it loaded. sim/step.js calls aiTick() as phase 0, so this
//     file does nothing but tick — the real AI plays every power and the
//     win-rate column becomes a statement about STRATEGY.
//
//   * `greedyOrder()` below otherwise. Nearest weak target, everything nearby
//     thrown at it. Deliberately stupid; its only job is to keep the board
//     moving so the SIM's numbers can be read while ai/ is unwritten. Against
//     it the win-rate column means "how good is this power's starting position
//     against an opponent with no plan" — still worth knowing, but not balance.
//
// Which one ran is printed in the header of every report. Never read a table
// without checking that line: the two drivers produce completely different
// numbers and confusing them would send a balance pass in the wrong direction.
// Force the placeholder with --greedy to compare the two.

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');

// Same list as test/node.js, minus the test harness itself. Missing files are
// skipped so this runs while later milestones are still being written.
const SCRIPTS = [
  'core/rng.js', 'core/exact.js', 'core/util.js', 'core/state.js', 'core/vision.js',
  'data/tuning.js',
  'data/map.js', 'data/stations.js', 'data/scenario.js',
  'sim/commands.js', 'sim/development.js', 'sim/growth.js', 'sim/movement.js', 'sim/combat.js',
  'sim/relations.js', 'sim/victory.js', 'sim/step.js',
  'ai/score.js', 'ai/ai.js',
];

for (const rel of SCRIPTS) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) continue;
  try {
    vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: rel });
  } catch (e) {
    console.error('LOAD ERROR in ' + rel + ': ' + e.message);
    process.exit(2);
  }
}

if (typeof stepTick !== 'function' || typeof applyCommand !== 'function') {
  console.error('balance: the sim is not loaded — need stepTick() and applyCommand().');
  process.exit(2);
}

// The fog gate, asserted separately and loudly. Forgetting core/vision.js in
// SCRIPTS above is a SILENT failure of exactly the worst kind: visibleTo would
// simply be undefined, the AI would fall back to reading the whole board, every
// game would still run to completion, and this harness would report a clean set
// of numbers for a game nobody is playing. A missing file is skipped by design
// (later milestones are still being written), so nothing else can catch this.
if (typeof visibleTo !== 'function' || typeof stationVision !== 'function') {
  console.error('balance: core/vision.js is not loaded — need visibleTo() and stationVision().');
  console.error('         Without it the AI reads the true board and these numbers are for a different game.');
  process.exit(2);
}

// POWER_IDS / STATION_IDS are empty until this runs. newGame() calls it too,
// but the batch reads POWER_IDS before the first game exists.
indexIds();

// ── args ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt;
}
const GAMES = Number(argv[0]) > 0 ? Number(argv[0]) : 200;
const SEED0 = flag('seed', 1000);
const MAX_TICKS = flag('ticks', 60000);          // 100 sim-minutes; a hard stop
const CSV = argv.includes('--csv');

// ── the SHARE curve — Phase D's steering instrument ─────────────────────
//
// WHY THIS EXISTS, AND WHY IT IS NOT A SECOND WIN-RATE TABLE.
//
// A win is a BINARY outcome, so its standard error on N games is
// sqrt(p(1-p)/N) — at p = 0.74 and N = 96 that is 4.5 percentage points, and a
// difference has ~1.4x that. Nothing smaller than about ten points is
// detectable, one sweep costs eighteen minutes, and a tuning loop steered by an
// instrument that cannot see its own step size converges to noise. That is not
// a hypothetical: C1b moved 74.0 -> 77.1 and the honest answer was "cannot
// tell".
//
// Board SHARE at a fixed tick is CONTINUOUS. Every game contributes a number
// between 0 and 1 rather than a single bit, so the same 96 games carry far more
// information about whether a power is ahead. It is the standard move when a
// binary endpoint is too noisy to steer by, and the standard obligation comes
// with it: **a proxy has to be shown to predict the thing you actually care
// about.** `--curve` prints that validation in the same table it prints the
// proxy — see `leader at T eventually wins` below. Read it every time. A
// checkpoint where the leader wins barely more often than chance is a
// checkpoint that is measuring the opening's noise, not its balance.
//
// Win rate stays. It is the acceptance test at the end of a balance pass; it is
// simply the wrong thing to steer WITH.
const CURVE = argv.includes('--curve');
const CHECKPOINTS = (function () {
  const i = argv.indexOf('--at');
  const raw = (i >= 0 && argv[i + 1]) ? argv[i + 1] : '2000,5000,10000';
  return raw.split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
}());

// ── personality rotation — Phase D's position/agent control ─────────────
//
// `data/scenario.js` assigns each power a personality, and three of the seven
// are `turtle`. So the question "is Austria winning because of where it sits or
// because of how it thinks" is answerable without writing any AI code: rotate
// the assignment N places around the sorted power list and re-run. If the same
// power tops the table under every rotation, the map is the cause and only map
// data should be touched.
//
// This matters more than it looks. Tuning a personality until the table flattens
// balances the AI-vs-AI game and breaks the moment a HUMAN sits in that seat,
// because a human brings their own personality — the handicap evaporates and
// the positional advantage is still there, untouched.
const ROTATE = flag('rotate', 0);
if (ROTATE) {
  const ids = POWER_IDS.filter((p) => p !== 'neutral').sort();
  const was = ids.map((p) => POWERS[p].ai);
  ids.forEach((p, i) => { POWERS[p].ai = was[(i + ROTATE) % ids.length]; });
}

// The real AI drives itself from inside stepTick (phase 0), so when it is
// present this harness must NOT also issue orders — doing both would double the
// action budget and quietly invalidate BAL.AI.MAX_ORDERS_PER_MINUTE, which is
// the constant that stops the AI out-clicking the player.
const USE_AI = !argv.includes('--greedy') && typeof aiTick === 'function';

// ── the placeholder driver ──────────────────────────────────────────────

const ADJ = (function buildAdj() {
  const m = Object.create(null);
  for (const sid of Object.keys(STATIONS)) m[sid] = [];
  for (const l of LINKS) {
    if (m[l.a] && m[l.b]) { m[l.a].push(l.b); m[l.b].push(l.a); }
  }
  for (const sid of Object.keys(m)) m[sid].sort();
  return m;
})();

// core/state.js is in SCRIPTS above and every file is evaluated into THIS
// global context, so () is as reachable here as it is in the browser.
// Worth saying out loud because a `require` habit would suggest otherwise, and
// the alternative — a local copy of the sum — is how the placeholder driver
// would end up scoring the board by a different rule from the one the sim plays.
function unitsAt(state, sid) {
  return (state.stations[sid].units);
}

// One volley for one power. Deliberately shallow: find the cheapest hostile
// station touching anything we own, then throw every neighbouring holding of
// ours at it. No fronts, no threat weighting, no personality — that is §6's
// job and it is not written yet.
function greedyOrder(state, pid) {
  const mine = [];
  for (const sid of STATION_IDS) if (state.stations[sid].owner === pid) mine.push(sid);
  if (!mine.length) return null;

  // Candidate targets: hostile stations adjacent to something we hold.
  let best = null;
  let bestScore = Infinity;
  const seen = Object.create(null);
  for (const sid of mine) {
    for (const nb of ADJ[sid]) {
      if (seen[nb]) continue;
      seen[nb] = 1;
      const o = state.stations[nb].owner;
      if (o === pid) continue;
      // cheapest defender wins; ties broken by id so this stays deterministic
      const score = unitsAt(state, nb);
      if (score < bestScore || (score === bestScore && best !== null && nb < best)) {
        bestScore = score;
        best = nb;
      }
    }
  }
  if (!best) return null;

  // Sources: our stations adjacent to the target, plus their own neighbours,
  // so a volley arrives with some mass instead of trickling.
  const srcSet = Object.create(null);
  for (const nb of ADJ[best]) {
    if (state.stations[nb].owner !== pid) continue;
    srcSet[nb] = 1;
    for (const nn of ADJ[nb]) if (state.stations[nn].owner === pid) srcSet[nn] = 1;
  }
  const sources = Object.keys(srcSet).sort()
    .filter((s) => unitsAt(state, s) >= 2);
  if (!sources.length) return null;

  return {
    type: 'send',
    owner: pid,
    sources: sources,
    target: best,
    fraction: BAL.SEND_FRACTION_DEFAULT,
  };
}

// ── one game ────────────────────────────────────────────────────────────

function playGame(seed) {
  const state = newGame(seed);
  state.paused = false;

  const startOwner = Object.create(null);
  for (const sid of STATION_IDS) startOwner[sid] = state.stations[sid].owner;

  const players = POWER_IDS.filter((p) => p !== 'neutral');
  // Stagger first orders so seven powers do not all fire on tick 0.
  const nextAct = Object.create(null);
  players.forEach((p, i) => { nextAct[p] = i * 7; });

  let firstFlip = null;
  let t = 0;

  // Board share at each checkpoint, per power. STATIONS rather than territories
  // — 108 buckets rather than 30, so the same board resolves five times finer,
  // which is the entire point of moving to a continuous metric. Territory count
  // is what victory is decided on and is reported alongside it, never instead.
  const shares = CURVE ? CHECKPOINTS.map(() => null) : null;
  const sampleShare = () => {
    const held = Object.create(null);
    let owned = 0;
    for (const pid of players) held[pid] = 0;
    for (const sid of STATION_IDS) {
      const o = state.stations[sid].owner;
      if (held[o] !== undefined) { held[o]++; owned++; }
    }
    // Denominator is the WHOLE BOARD, not the claimed part: a power holding 20
    // of 30 claimed stations on tick 500 has not conquered two thirds of
    // Europe, and normalising by the claimed part would say it had.
    const out = Object.create(null);
    for (const pid of players) out[pid] = held[pid] / STATION_IDS.length;
    out._owned = owned / STATION_IDS.length;
    return out;
  };

  for (; t < MAX_TICKS && !state.winner; t++) {
    if (shares) {
      for (let c = 0; c < CHECKPOINTS.length; c++) {
        if (shares[c] === null && t === CHECKPOINTS[c]) shares[c] = sampleShare();
      }
    }
    for (const pid of USE_AI ? [] : players) {
      if (!state.powers[pid].alive) continue;
      if (t < nextAct[pid]) continue;
      const cmd = greedyOrder(state, pid);
      if (cmd) applyCommand(state, cmd);
      // Deterministic jitter off the state PRNG, so the cadence varies but the
      // run still replays exactly from the seed.
      nextAct[pid] = t + BAL.AI.ACTION_INTERVAL_TICKS +
        rngInt(state, -BAL.AI.ACTION_JITTER_TICKS, BAL.AI.ACTION_JITTER_TICKS);
    }

    stepTick(state);

    if (firstFlip === null) {
      for (const sid of STATION_IDS) {
        if (state.stations[sid].owner !== startOwner[sid]) { firstFlip = t; break; }
      }
    }
  }

  // No winner at the cap: award to whoever holds the most territories, and
  // count it as a timeout so the table can show how often that happens.
  let winner = state.winner;
  let timedOut = false;
  if (!winner) {
    timedOut = true;
    let bestN = -1;
    for (const pid of players) {
      const n = countTerritories(state, pid);
      if (n > bestN) { bestN = n; winner = pid; }
    }
  }

  // A game that ended before a checkpoint is FROZEN at its final board rather
  // than dropped. Dropping it would quietly restrict the late checkpoints to the
  // long games, which are exactly the ones nobody ran away with — the sample
  // would be biased toward balance by construction, at the checkpoint where
  // imbalance is largest.
  if (shares) {
    const final = sampleShare();
    for (let c = 0; c < CHECKPOINTS.length; c++) if (shares[c] === null) shares[c] = final;
  }

  return {
    seed: seed,
    winner: winner,
    ticks: t,
    firstFlip: firstFlip,
    timedOut: timedOut,
    shares: shares,
    territories: POWER_IDS.reduce((acc, p) => {
      acc[p] = countTerritories(state, p);
      return acc;
    }, Object.create(null)),
  };
}

// ── batch ───────────────────────────────────────────────────────────────

function pct(n, d) { return d ? (100 * n / d) : 0; }

function main() {
  const players = POWER_IDS.filter((p) => p !== 'neutral');
  const wins = Object.create(null);
  players.forEach((p) => { wins[p] = 0; });

  let sumTicks = 0;
  let sumFlip = 0;
  let flipN = 0;
  let timeouts = 0;
  const lengths = [];
  // curve[c][pid] = every game's share of the board at checkpoint c, so the
  // spread can be a confidence interval rather than a point estimate.
  const curve = CHECKPOINTS.map(() => {
    const m = Object.create(null);
    players.forEach((p) => { m[p] = []; });
    return m;
  });
  const liveAt = CHECKPOINTS.map(() => 0);        // games not yet decided
  const leaderHit = CHECKPOINTS.map(() => 0);     // leader at T went on to win

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < GAMES; i++) {
    const r = playGame(SEED0 + i);
    if (wins[r.winner] !== undefined) wins[r.winner]++;
    if (r.shares) {
      for (let c = 0; c < CHECKPOINTS.length; c++) {
        const s = r.shares[c];
        for (const p of players) curve[c][p].push(s[p]);
        if (r.ticks > CHECKPOINTS[c]) liveAt[c]++;
        let best = null;
        for (const p of players) if (best === null || s[p] > s[best]) best = p;
        if (best === r.winner) leaderHit[c]++;
      }
    }
    sumTicks += r.ticks;
    lengths.push(r.ticks);
    if (r.firstFlip !== null) { sumFlip += r.firstFlip; flipN++; }
    if (r.timedOut) timeouts++;
    if (!CSV && GAMES > 20 && (i + 1) % Math.ceil(GAMES / 10) === 0) {
      process.stderr.write('  ' + (i + 1) + '/' + GAMES + '\n');
    }
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;

  if (CSV) {
    console.log('power,wins,win_rate');
    for (const p of players) {
      console.log(p + ',' + wins[p] + ',' + (wins[p] / GAMES).toFixed(4));
    }
    return;
  }

  lengths.sort((a, b) => a - b);
  const tickSec = BAL.TICK_MS / 1000;
  const rates = players.map((p) => pct(wins[p], GAMES));
  const spread = Math.max.apply(null, rates) - Math.min.apply(null, rates);
  const even = 100 / players.length;

  const line = '='.repeat(64);
  console.log(line);
  console.log('  BALANCE  —  ' + GAMES + ' games, seeds ' + SEED0 + '..' +
    (SEED0 + GAMES - 1) + ', ' + secs.toFixed(1) + 's');
  console.log('  driver: ' + (USE_AI
    ? 'ai/ai.js — real AI, phase 0 of stepTick'
    : 'greedy placeholder' +
      (typeof aiTick === 'function' ? ' (forced with --greedy)' : ' (ai/ai.js not loaded)')));
  console.log(line);
  console.log('');
  console.log('  power                    wins   win rate   vs even');
  for (const p of players) {
    const name = (POWERS[p] && POWERS[p].name) || p;
    const r = pct(wins[p], GAMES);
    const d = r - even;
    console.log('  ' + name.padEnd(22) + String(wins[p]).padStart(6) +
      (r.toFixed(1) + '%').padStart(11) +
      ((d >= 0 ? '+' : '') + d.toFixed(1)).padStart(10));
  }
  console.log('');
  console.log('  win-rate spread        ' + spread.toFixed(1) +
    ' points   (even would be ' + even.toFixed(1) + '% each)');
  console.log('  mean game length       ' + (sumTicks / GAMES).toFixed(0) +
    ' ticks  =  ' + ((sumTicks / GAMES) * tickSec / 60).toFixed(1) + ' sim-minutes');
  console.log('  median game length     ' + lengths[Math.floor(lengths.length / 2)] +
    ' ticks');
  console.log('  mean time to 1st flip  ' +
    (flipN ? (sumFlip / flipN).toFixed(0) + ' ticks  =  ' +
      ((sumFlip / flipN) * tickSec).toFixed(1) + ' sim-seconds'
      : 'never — nothing ever flipped'));
  console.log('  hit the ' + MAX_TICKS + '-tick cap   ' + timeouts + '/' + GAMES +
    '  (' + pct(timeouts, GAMES).toFixed(0) + '%)');
  console.log('');

  if (CURVE) printCurve(players, curve, liveAt, leaderHit, wins);

  console.log(line);
}

// Mean and the half-width of a 95% confidence interval on that mean.
// 1.96 x SE, the normal approximation — with N in the dozens and a bounded
// quantity that is close enough, and the honest alternative (a t-distribution
// table) would move the last digit and nothing else.
function meanCI(xs) {
  const n = xs.length;
  if (!n) return { mean: 0, ci: 0, n: 0 };
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / n;
  if (n < 2) return { mean: mean, ci: 0, n: n };
  let sq = 0;
  for (const x of xs) sq += (x - mean) * (x - mean);
  return { mean: mean, ci: 1.96 * Math.sqrt(sq / (n - 1)) / Math.sqrt(n), n: n };
}

function printCurve(players, curve, liveAt, leaderHit, wins) {
  const line = '='.repeat(64);
  console.log(line);
  console.log('  BOARD SHARE — the steering metric. % of 108 stations held, mean');
  console.log('  across all ' + GAMES + ' games, +/- a 95% confidence interval.');
  console.log(line);
  console.log('');

  let head = '  power                 ';
  for (const t of CHECKPOINTS) head += ('t=' + t).padStart(16);
  console.log(head + '      wins');
  for (const p of players) {
    const name = ((POWERS[p] && POWERS[p].name) || p);
    let row = '  ' + name.slice(0, 20).padEnd(22);
    for (let c = 0; c < CHECKPOINTS.length; c++) {
      const m = meanCI(curve[c][p]);
      row += ((100 * m.mean).toFixed(1) + '+-' + (100 * m.ci).toFixed(1)).padStart(16);
    }
    console.log(row + String(wins[p]).padStart(10));
  }

  console.log('');
  let spreadRow = '  share spread          ';
  let liveRow   = '  games still live      ';
  let predRow   = '  leader at T wins      ';
  for (let c = 0; c < CHECKPOINTS.length; c++) {
    let hi = -1, lo = 2;
    for (const p of players) {
      const m = meanCI(curve[c][p]).mean;
      if (m > hi) hi = m;
      if (m < lo) lo = m;
    }
    spreadRow += ((100 * (hi - lo)).toFixed(1) + ' pts').padStart(16);
    liveRow += (liveAt[c] + '/' + GAMES).padStart(16);
    predRow += (pct(leaderHit[c], GAMES).toFixed(0) + '%').padStart(16);
  }
  console.log(spreadRow);
  console.log(liveRow);
  console.log(predRow + '     <- VALIDITY');
  console.log('');
  console.log('  READ THE LAST ROW FIRST. It is the only thing that licenses');
  console.log('  steering by share at all: the share of games where whoever led');
  console.log('  at tick T went on to win. Chance is ' +
    (100 / players.length).toFixed(0) + '%. A checkpoint near that');
  console.log('  number is measuring the opening\'s noise, not its balance, and');
  console.log('  tuning against it is tuning against nothing.');
  console.log('');
}

main();
