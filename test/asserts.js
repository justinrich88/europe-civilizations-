// test/asserts.js — a ~zero-dependency assertion kit.
//
// No test library, no npm, no modules (00-vision.md §9). Everything is a
// global, exactly like the rest of the project.
//
// Results are COLLECTED into TEST_RESULTS rather than printed, so the browser
// runner (tests.html) and the node runner (test/node.js) can format the same
// data their own way.
//
// Shape of TEST_RESULTS:
//   [ { name, skipped, reason, tests: [ { name, ok, skipped, msg, ms } ] } ]

var TEST_RESULTS = [];

// The suite subsequent test() calls attach to. Kept module-private by
// convention (leading underscores); nothing outside this file should touch it.
var _currentSuite = null;

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

// Open a suite. Every following test() lands here until the next suite().
function suite(name) {
  _currentSuite = { name: name, skipped: false, reason: '', tests: [] };
  TEST_RESULTS.push(_currentSuite);
  return _currentSuite;
}

// Declare a suite that cannot run yet — data not authored, sim not landed.
// This is the mechanism that keeps the harness useful while the rest of the
// project is still being written in parallel: a missing file is a SKIP with a
// clear reason, never a thrown exception.
function skipSuite(name, reason) {
  var s = suite(name);
  s.skipped = true;
  s.reason = reason || 'not available yet';
  return s;
}

// Skip a single test inside an otherwise-running suite.
function skipTest(name, reason) {
  if (!_currentSuite) suite('(ungrouped)');
  _currentSuite.tests.push({
    name: name, ok: true, skipped: true, msg: reason || 'skipped', ms: 0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Run one test. Any throw — an assertion or an ordinary TypeError from half
// written data — is caught and recorded as a failure. A test never takes the
// runner down with it.
function test(name, fn) {
  if (!_currentSuite) suite('(ungrouped)');
  var rec = { name: name, ok: true, skipped: false, msg: '', ms: 0 };
  var t0 = _now();
  try {
    fn();
  } catch (e) {
    rec.ok = false;
    rec.msg = (e && e.message) ? e.message : String(e);
    // Non-assertion throws are bugs in the test or the data — say so, since
    // "Cannot read property 'shape' of undefined" is otherwise mystifying.
    if (!e || !e._isAssertion) rec.msg = 'THREW ' + rec.msg;
  }
  rec.ms = _now() - t0;
  _currentSuite.tests.push(rec);
  return rec;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function _fail(msg) {
  var e = new Error(msg || 'assertion failed');
  e._isAssertion = true;
  throw e;
}

function assert(cond, msg) {
  if (!cond) _fail(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    _fail((msg || 'not equal') + ' — expected ' + _show(expected) +
          ', got ' + _show(actual));
  }
}

// Float comparison. Everything in this game is a float (unit counts, power,
// growth), so exact equality is almost never the right check.
function assertClose(a, b, tol, msg) {
  if (typeof tol !== 'number') tol = 1e-6;
  if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) {
    _fail((msg || 'assertClose') + ' — non-finite: ' + _show(a) + ' vs ' + _show(b));
  }
  if (Math.abs(a - b) > tol) {
    _fail((msg || 'not close') + ' — expected ' + _fmt(b) + ' +/- ' + _fmt(tol) +
          ', got ' + _fmt(a) + ' (off by ' + _fmt(Math.abs(a - b)) + ')');
  }
}

function assertBetween(v, lo, hi, msg) {
  if (typeof v !== 'number' || !(v >= lo && v <= hi)) {
    _fail((msg || 'out of range') + ' — expected ' + _fmt(lo) + '..' + _fmt(hi) +
          ', got ' + _show(v));
  }
}

function assertThrows(fn, msg) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) _fail(msg || 'expected a throw, none happened');
}

// The workhorse for data-integrity checks: gather every problem, then report
// them together. One failing vertex out of 140 should tell you about all the
// other 12 too, not just the first — otherwise fixing map data is a
// one-at-a-time slog through the runner.
function assertNone(problems, msg, sampleCount) {
  if (!problems || problems.length === 0) return;
  var n = sampleCount || 8;
  var sample = problems.slice(0, n).join(' | ');
  var more = problems.length > n ? ' (+' + (problems.length - n) + ' more)' : '';
  _fail((msg || 'problems found') + ' — ' + problems.length + ': ' + sample + more);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function _now() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

function _fmt(n) {
  if (typeof n !== 'number') return String(n);
  if (n === Math.round(n)) return String(n);
  return String(Math.round(n * 10000) / 10000);
}

function _show(v) {
  if (typeof v === 'string') return '"' + v + '"';
  if (typeof v === 'number') return _fmt(v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return '[' + v.slice(0, 6).map(_show).join(',') + ']';
  return Object.prototype.toString.call(v);
}

// Reset between batches. The Monte Carlo harness re-runs suites, and nobody
// wants the second run appended to the first.
function resetTests() {
  TEST_RESULTS.length = 0;
  _currentSuite = null;
}

// Roll the collected results up into the counts both runners print.
function summarizeTests() {
  var pass = 0, fail = 0, skip = 0, suitesRun = 0, suitesSkipped = 0;
  for (var i = 0; i < TEST_RESULTS.length; i++) {
    var s = TEST_RESULTS[i];
    if (s.skipped) { suitesSkipped++; continue; }
    suitesRun++;
    for (var j = 0; j < s.tests.length; j++) {
      var t = s.tests[j];
      if (t.skipped) skip++;
      else if (t.ok) pass++;
      else fail++;
    }
  }
  return {
    pass: pass, fail: fail, skip: skip,
    suitesRun: suitesRun, suitesSkipped: suitesSkipped,
    total: pass + fail + skip,
    ok: fail === 0,
  };
}
