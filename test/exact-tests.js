// test/exact-tests.js — core/exact.js, and the cross-engine pin.
//
// Three kinds of test here, and they are worth very different amounts. Read the
// distinction before adding to this file, because two of the three would pass on
// the very code this suite exists to have replaced.
//
//   1. ACCURACY vs Math.*. Weak. `Math.sin` passes every one of these
//      trivially. They exist because a function that is deterministically WRONG
//      sails through every determinism test in the project — bit-identical
//      garbage is still bit-identical. Bounds are the MEASURED error plus a
//      little headroom, not aspirations, and they are per-range because the
//      error is not uniform.
//
//   2. PINNED VALUES. The real regression net. Full 17-digit doubles, so a
//      mutated polynomial coefficient goes red on the spot. Every one was
//      mutation-tested: perturbing the last term of each series turns them red.
//
//   3. THE SOURCE SCANS. The only tests here that are red against the code
//      before this change, and the only ones that stay useful in a year. They
//      assert that nothing in `sim/` or `ai/` calls an
//      implementation-approximated Math function, and that core/exact.js does
//      not quietly delegate back to one. Both are the failure that actually
//      threatens this project: not a wrong number, a number that is right on
//      one engine.
//
// WHAT THE PINNED FULL-STATE HASH DOES AND DOES NOT PROVE
//
// 07-roadmap.md A2 asks for "a cross-engine test: hash snapshot() after N ticks
// and pin the value". This is it — and running it under `node test/node.js`
// proves NOTHING about cross-engine agreement, because there is one engine in
// the room. Stated plainly because the temptation to quote a green node run as
// evidence of portability is exactly the trap CLAUDE.md's verification bar is
// about.
//
// What it does prove, in node: the sim's arithmetic has not drifted. What
// establishes the cross-engine claim is (a) core/exact.js being built only from
// operations ECMAScript pins to the bit, which the source scan enforces, and
// (b) opening tests.html in a second browser engine and watching the same
// pinned number pass. The pin is what makes (b) a five-second check instead of
// a research project.
//
// Private helpers here are `_exat…` — this file's own prefix. `_exa` belongs to
// core/exact.js and a collision would replace one of ITS internals from a test
// file, which is known-issues.md #9 and #12, twice logged.

'use strict';

// Source text of a project file, or null in a browser. Same shape as
// test/scenarios-standings.js's version and for the same reason; kept local
// rather than shared because the two suites load independently.
function _exatSource(rel) {
  try {
    var req = null;
    if (typeof require === 'function') req = require;
    else if (typeof process !== 'undefined' && process.mainModule &&
             typeof process.mainModule.require === 'function') {
      req = function (m) { return process.mainModule.require(m); };
    }
    if (!req) return null;
    var fs = req('fs');
    var roots = ['', './'];
    if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
      roots.push(String(process.argv[1]).replace(/test[\/\\][A-Za-z0-9._-]+$/, ''));
    }
    for (var r = 0; r < roots.length; r++) {
      var p = roots[r] + rel;
      try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch (e) { /* next root */ }
    }
  } catch (e) { /* browser */ }
  return null;
}

// Comments stripped. Every file in this project explains itself at length and
// several of the headers NAME the functions being banned; a scan that cannot
// tell prose from code is a scan somebody switches off the first week.
function _exatCode(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// Worst error of `f` against `g` over `n` samples of [lo, hi].
function _exatWorst(f, g, lo, hi, n, relative) {
  var worst = 0, at = lo;
  for (var i = 0; i <= n; i++) {
    var x = lo + ((hi - lo) * i) / n;
    var a = f(x), b = g(x);
    if (!isFinite(b)) continue;
    var d = relative ? Math.abs(a - b) / Math.abs(b) : Math.abs(a - b);
    if (relative && Math.abs(b) < 1e-12) continue;
    if (d > worst) { worst = d; at = x; }
  }
  return { err: worst, at: at };
}

// A pinned double, compared with a message that shows every digit.
//
// assertEqual() would do the comparison correctly and then print the difference
// through _fmt(), which rounds to four decimals — so a pinned 17-digit value
// fails with "expected 0.8415, got 0.8415" and tells you nothing about which
// term moved. That was found by mutation-testing this file rather than by
// reading it, and it is exactly known-issues.md #18: a readout answering a
// different question from the one on screen. Fixed HERE rather than in
// test/asserts.js because _fmt's rounding is right for the 289 assertions about
// unit counts and wrong only for a bit-exactness pin.
function _exatPin(actual, expected, label) {
  if (actual === expected) return;
  _fail(label + ' — pinned ' + _exatDigits(expected) + ', got ' + _exatDigits(actual) +
    ' (off by ' + Math.abs(actual - expected).toExponential(3) + ')');
}

// 17 significant digits round-trips any double exactly. JSON.stringify gives the
// shortest such form, which is what should be pasted back into the pin.
function _exatDigits(v) {
  return (typeof v === 'number' && isFinite(v)) ? JSON.stringify(v) : String(v);
}

// Full-state hash. FNV-1a via rngSeed() — core/rng.js already implements exactly
// this and a second copy would be the one-rule-two-implementations defect
// (known-issues.md #9). JSON is the right input: ECMAScript specifies
// Number::toString to the digit, so the text is a faithful and portable
// rendering of every double in the state.
function _exatStateHash(state) {
  var json = JSON.stringify(snapshot(state));
  return { hash: rngSeed(json), bytes: json.length };
}

function suiteExact() {
  suite('exact / deterministic transcendentals');

  // ── the functions exist at all ─────────────────────────────────────────
  test('all five exports are present as globals', function () {
    assertEqual(typeof exactSin, 'function', 'exactSin missing');
    assertEqual(typeof exactExp, 'function', 'exactExp missing');
    assertEqual(typeof exactLog, 'function', 'exactLog missing');
    assertEqual(typeof exactAtanh, 'function', 'exactAtanh missing');
    assertEqual(typeof exactPowInt, 'function', 'exactPowInt missing');
  });

  // ── 1. accuracy (weak; see the header) ─────────────────────────────────

  test('exactSin tracks Math.sin to 5e-14 absolute across [-200, 200]', function () {
    var w = _exatWorst(exactSin, Math.sin, -200, 200, 40001, false);
    assert(w.err < 5e-14, 'sine is off by ' + w.err.toExponential(3) + ' at x=' + w.at +
      ' — the Taylor bound at |r| <= PI/2 is 4.4e-14, so this is a lost term or a lost fold');
  });

  test('exactSin holds its accuracy at a huge argument — the reduction works', function () {
    // Not a hypothetical: a battle that has run for a million ticks feeds a
    // large argument, and sim/combat.js's own modulo is the first line of
    // defence rather than the only one.
    assertClose(exactSin(1e6), Math.sin(1e6), 1e-9, 'sine of 1e6 lost the reduction');
    assertClose(exactSin(-987654.321), Math.sin(-987654.321), 1e-9, 'sine of -987654.321');
  });

  test('exactExp tracks Math.exp to 2e-15 relative on [-30, 30]', function () {
    // The range the sim actually uses is much narrower — negative integers — but
    // this is the band where a broken LN2 split still looks fine on the
    // integers and is already visibly wrong in between.
    var w = _exatWorst(exactExp, Math.exp, -30, 30, 40001, true);
    assert(w.err < 2e-15, 'exp is off by ' + w.err.toExponential(3) + ' relative at x=' + w.at);
  });

  test('exactExp stays within 3e-14 relative over the whole double range', function () {
    // Looser deliberately, and it is the honest number: at |x| near 709 the
    // reduction has ~1000 * LN2 of magnitude to cancel. Nothing in the sim goes
    // near here; the bound is pinned so that "I made exp faster" cannot quietly
    // cost three digits at the edges.
    var w = _exatWorst(exactExp, Math.exp, -745, 709, 40001, true);
    assert(w.err < 3e-14, 'exp is off by ' + w.err.toExponential(3) + ' relative at x=' + w.at);
  });

  test('exactLog tracks Math.log to 1e-15 relative across nine decades', function () {
    var near = _exatWorst(exactLog, Math.log, 0.5, 2, 40001, true);
    assert(near.err < 1e-15, 'log near 1 is off by ' + near.err.toExponential(3) +
      ' at v=' + near.at);
    var wide = _exatWorst(exactLog, Math.log, 1e-9, 1e9, 40001, true);
    assert(wide.err < 1e-15, 'log is off by ' + wide.err.toExponential(3) + ' at v=' + wide.at);
  });

  test('exactAtanh tracks Math.atanh to 2e-15 relative, including where it switches branch', function () {
    var wide = _exatWorst(exactAtanh, Math.atanh, -0.9999, 0.9999, 40001, true);
    assert(wide.err < 2e-15, 'atanh is off by ' + wide.err.toExponential(3) + ' at y=' + wide.at);
    // The small-|y| branch is the one nothing in the sim exercises, which is why
    // it is checked hardest. Through the log it would be ~3e-13 here.
    var small = _exatWorst(exactAtanh, Math.atanh, -1e-3, 1e-3, 40001, true);
    assert(small.err < 2e-15, 'atanh near zero is off by ' + small.err.toExponential(3) +
      ' at y=' + small.at + ' — the direct-series branch is gone or misplaced');
  });

  test('the two atanh branches agree where they meet', function () {
    // The seam is the interval bound the series is converged on. Straddling it
    // by one part in 1e9 must not move the answer by more than the series error,
    // or the function has a step discontinuity in the middle of its domain.
    var d = (Math.SQRT2 - 1) / (Math.SQRT2 + 1);
    var below = exactAtanh(d * (1 - 1e-9));
    var above = exactAtanh(d * (1 + 1e-9));
    assertClose(above - below, Math.atanh(d * (1 + 1e-9)) - Math.atanh(d * (1 - 1e-9)),
      1e-15, 'the branch point is a step, not a seam');
  });

  // ── edge cases ─────────────────────────────────────────────────────────

  test('the edges behave: 0, 1, infinities, NaN', function () {
    assertEqual(exactSin(0), 0, 'sin 0');
    assertEqual(exactExp(0), 1, 'exp 0');
    assertEqual(exactLog(1), 0, 'log 1');
    assertEqual(exactAtanh(0), 0, 'atanh 0');
    assertEqual(exactExp(-Infinity), 0, 'exp -inf');
    assertEqual(exactExp(Infinity), Infinity, 'exp +inf');
    assertEqual(exactLog(0), -Infinity, 'log 0');
    assertEqual(exactLog(Infinity), Infinity, 'log +inf');
    assertEqual(exactAtanh(1), Infinity, 'atanh 1');
    assertEqual(exactAtanh(-1), -Infinity, 'atanh -1');
    assert(isNaN(exactSin(Infinity)), 'sin of infinity must be NaN, not a number');
    assert(isNaN(exactLog(-1)), 'log of a negative must be NaN');
    assert(isNaN(exactAtanh(2)), 'atanh past 1 must be NaN');
    assert(isNaN(exactExp(NaN)) && isNaN(exactLog(NaN)) && isNaN(exactAtanh(NaN)),
      'NaN must survive as NaN');
  });

  test('exactExp does not overflow or underflow early', function () {
    assert(isFinite(exactExp(709)), 'exp(709) is representable and came back infinite');
    assertEqual(exactExp(710), Infinity, 'exp(710) overflows a double');
    assert(exactExp(-745) >= 0, 'exp(-745) went negative');
    assertEqual(exactExp(-746), 0, 'exp(-746) underflows to zero');
  });

  // ── exactPowInt ────────────────────────────────────────────────────────

  test('exactPowInt is exact on the integer exponents the sim uses', function () {
    // At MULTIPLIER_REACH the exponent is 0 or 1, and both are bit-identical to
    // Math.pow — which is why sim/growth.js does not move today.
    assertEqual(exactPowInt(BAL.MULTIPLIER_FALLOFF, 0), 1, 'anything^0');
    assertEqual(exactPowInt(BAL.MULTIPLIER_FALLOFF, 1), BAL.MULTIPLIER_FALLOFF, 'anything^1');
    assertEqual(exactPowInt(BAL.MULTIPLIER_FALLOFF, 0), Math.pow(BAL.MULTIPLIER_FALLOFF, 0),
      'exponent 0 must match Math.pow bit for bit');
    assertEqual(exactPowInt(BAL.MULTIPLIER_FALLOFF, 1), Math.pow(BAL.MULTIPLIER_FALLOFF, 1),
      'exponent 1 must match Math.pow bit for bit');
    assertEqual(exactPowInt(0.6, 2), 0.6 * 0.6, 'the loop is not a loop');
    assertEqual(exactPowInt(0.6, 3), 0.6 * 0.6 * 0.6, 'three factors');
    assertEqual(exactPowInt(2, 10), 1024, 'exact powers of two must be exact');
    assertEqual(exactPowInt(2, -2), 0.25, 'negative exponents reciprocate');
  });

  test('exactPowInt refuses a fractional exponent loudly', function () {
    // A silent truncation to `n | 0` would be a 23% tuning change nobody made.
    // The console line IS the deliverable here; the return value only has to be
    // something that cannot be mistaken for an answer.
    var real = console.error, said = [];
    console.error = function (m) { said.push(String(m)); };
    try {
      var out = exactPowInt(0.6, 1.5);
      assert(isNaN(out), 'a fractional exponent returned ' + out + ' instead of NaN');
      assertEqual(said.length, 1, 'the guard printed ' + said.length + ' lines, expected 1');
      assert(/core\/exact/.test(said[0]),
        'the error does not name the file: ' + said[0]);
    } finally {
      console.error = real;
    }
  });

  // ── 2. pinned values ───────────────────────────────────────────────────

  test('pinned values — any coefficient change goes red here', function () {
    // Seventeen significant digits, i.e. the shortest round-tripping form of the
    // exact double. Regenerate ONLY on a deliberate change to core/exact.js, and
    // say in the commit which term moved.
    _exatPin(exactSin(1), 0.8414709848078965, 'exactSin(1)');
    _exatPin(exactSin(-2.5), -0.5984721441039563, 'exactSin(-2.5)');
    _exatPin(exactSin(100), -0.5063656411097553, 'exactSin(100)');
    _exatPin(exactExp(1), 2.7182818284590455, 'exactExp(1)');
    _exatPin(exactExp(-3), 0.04978706836786394, 'exactExp(-3)');
    _exatPin(exactExp(12.5), 268337.2865208746, 'exactExp(12.5)');
    _exatPin(exactLog(2), 0.6931471805599453, 'exactLog(2)');
    _exatPin(exactLog(1234.5), 7.118421308785234, 'exactLog(1234.5)');
    _exatPin(exactAtanh(0.5), 0.5493061443340548, 'exactAtanh(0.5)');
    _exatPin(exactAtanh(1 / 1.4), 0.8958797346140275, 'exactAtanh(1/1.4) — the AI window');
  });

  test('the ETA spread window still lands where ai/ai.js documents it', function () {
    // The table in ai/ai.js quotes 407 ticks at MIN_ODDS = 1.4 and
    // COMBAT_RATE = 0.0022. That comment has been wrong once already, by a
    // factor of 22 (see the note there), so the number is checked rather than
    // read. This is also the whole observable consequence of swapping Math.atanh
    // for exactAtanh in that file.
    var ticks = exactAtanh(1 / 1.4) / 0.0022;
    assertBetween(ticks, 406, 408, 'the spread window moved off the documented 407 ticks');
  });

  // ── 3. the source scans — the only tests here red against the old code ──

  test('nothing in sim/ or ai/ calls an implementation-approximated Math function', function () {
    var files = ['sim/combat.js', 'sim/growth.js', 'sim/relations.js', 'sim/movement.js',
      'sim/step.js', 'sim/commands.js', 'sim/victory.js', 'ai/ai.js', 'ai/score.js'];
    var first = _exatSource(files[0]);
    if (first === null) {
      return skipTest('nothing in sim/ or ai/ calls an implementation-approximated ' +
        'Math function', 'no filesystem (browser)');
    }
    // ES2024 21.3.2: these are all "implementation-approximated". sqrt, floor,
    // round, abs, min, max, imul and the named constants are NOT, and are fine.
    var banned = /Math\.(sin|cos|tan|asin|acos|atan2?|atanh|asinh|acosh|sinh|cosh|tanh|exp|expm1|log|log2|log10|log1p|pow|cbrt|hypot|fround)\b/g;
    var bad = [];
    for (var i = 0; i < files.length; i++) {
      var src = _exatSource(files[i]);
      if (src === null) continue;
      var code = _exatCode(src);
      var m = code.match(banned);
      if (m) bad.push(files[i] + ': ' + m.join(', '));
      // `**` is Math.pow spelled shorter and is approximated identically.
      if (/[^*\s][ \t]*\*\*[ \t]*[^*\s]/.test(code)) bad.push(files[i] + ': ** operator');
    }
    assertNone(bad, 'an implementation-approximated Math call is back in the sim — ' +
      'V8, SpiderMonkey and JavaScriptCore may each return a different last bit, ' +
      'and under lockstep that is a desync (07-roadmap.md A2)');
  });

  test('core/exact.js does not delegate back to the functions it replaces', function () {
    var src = _exatSource('core/exact.js');
    if (src === null) {
      return skipTest('core/exact.js does not delegate back to the functions it replaces',
        'no filesystem (browser)');
    }
    var code = _exatCode(src);
    var banned = /Math\.(sin|cos|tan|asin|acos|atan2?|atanh|asinh|acosh|sinh|cosh|tanh|exp|expm1|log10|log1p|log2|log\b|pow|cbrt|hypot|fround)\b/g;
    var m = code.match(banned);
    assertNone(m ? m.slice() : [], 'core/exact.js calls the very functions it exists to ' +
      'replace — the whole file is then decoration');
    // Math.LN2, Math.PI, Math.SQRT2 are exactly specified doubles and expected.
    assert(/Math\.LN2/.test(code), 'the exp reduction lost its LN2');
    assert(/Math\.PI/.test(code), 'the sine reduction lost its PI');
  });

  test('the exact functions are pure — no RNG, no clock, no DOM', function () {
    var src = _exatSource('core/exact.js');
    if (src === null) {
      return skipTest('the exact functions are pure — no RNG, no clock, no DOM',
        'no filesystem (browser)');
    }
    var code = _exatCode(src);
    var bad = [];
    if (/Math\.random/.test(code)) bad.push('Math.random');
    if (/Date\.now|new Date\b/.test(code)) bad.push('a clock');
    if (/\bdocument\b|\bwindow\b/.test(code)) bad.push('the DOM');
    assertNone(bad, 'core/exact.js is not a pure function of its argument');
  });

  // ── the cross-engine pin ───────────────────────────────────────────────

  test('full-state hash after 2000 ticks is pinned — seeds 100 and 101', function () {
    // 2000 ticks is enough for the AI to have fought several battles on both
    // seeds, so the wobble, the grudge term and the spread window have all run
    // hundreds of times. It is NOT the 12,000-tick balance run: that lives in
    // the commit record because it takes twenty seconds, and this has to be
    // cheap enough that nobody is tempted to skip the suite.
    //
    // Read the header before treating a green here as portability evidence.
    var s100 = newGame(100);
    for (var i = 0; i < 2000; i++) stepTick(s100);
    var h100 = _exatStateHash(s100);
    assertEqual(h100.hash, 728090591, 'seed 100 diverged after 2000 ticks — state is now ' +
      h100.bytes + ' bytes of JSON against a pinned 132440. READ THE BYTE COUNT CAREFULLY: ' +
      'it moves for BOTH kinds of change and cannot tell them apart on its own. A new field ' +
      'on the state moves it by a fixed amount on every seed (A3 moved it +76 on all four); ' +
      'different arithmetic moves it by a different amount on each seed, because a different ' +
      'war writes a different number of log entries. Same amount everywhere means look at ' +
      'the shape; different amounts mean look at the maths');

    var s101 = newGame(101);
    for (var j = 0; j < 2000; j++) stepTick(s101);
    var h101 = _exatStateHash(s101);
    assertEqual(h101.hash, 3595343226, 'seed 101 diverged after 2000 ticks — state is now ' +
      h101.bytes + ' bytes of JSON against a pinned 130732');
  });

  test('the pin would notice a one-bit change — it is not hashing a constant', function () {
    // known-issues.md #8. A pinned hash of something that never varies is a test
    // that cannot fail, and this project has shipped one of those before. Perturb
    // a single garrison by one part in 1e12 and the hash must move.
    var a = newGame(100);
    for (var i = 0; i < 50; i++) stepTick(a);
    var before = _exatStateHash(a).hash;
    a.stations[STATION_IDS[0]].units.infantry += 1e-12;
    var after = _exatStateHash(a).hash;
    assert(before !== after, 'the state hash ignored a perturbation — it is not reading ' +
      'the numbers, and the pin above proves nothing');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/exact-tests.js`
//
// Inert under tests.html and under test/node.js, which registers this suite in
// its own list. Same shape as the other standalone suites.
// ---------------------------------------------------------------------------
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  (function () {
    var fs = require('fs'), vm = require('vm'), path = require('path');
    var root = path.join(__dirname, '..');
    var SCRIPTS = [
      'core/rng.js', 'core/exact.js', 'core/util.js', 'core/state.js', 'core/vision.js',
      'data/tuning.js', 'data/map.js', 'data/stations.js', 'data/scenario.js',
      'sim/commands.js', 'sim/growth.js', 'sim/movement.js', 'sim/combat.js',
      'sim/relations.js', 'sim/victory.js', 'sim/step.js',
      'ai/score.js', 'ai/ai.js',
      // runner.js for formatResults()/summarizeTests(), which live there rather
      // than in asserts.js. Nothing else of it is used; it only declares.
      'test/asserts.js', 'test/runner.js',
    ];
    for (var i = 0; i < SCRIPTS.length; i++) {
      var f = path.join(root, SCRIPTS[i]);
      if (!fs.existsSync(f)) continue;
      try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: SCRIPTS[i] }); }
      catch (e) { console.error('LOAD ERROR in ' + SCRIPTS[i] + ': ' + e.message); process.exit(2); }
    }
    resetTests();
    suiteExact();
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
