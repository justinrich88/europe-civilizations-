// core/exact.js — the four transcendental functions the sim needs, rebuilt out
// of operations ECMAScript specifies to the last bit.
//
// WHY THIS FILE EXISTS (07-roadmap.md A2)
//
// The sim is deterministic in every way this project has been able to test:
// seeded mulberry32 with its state inside the game state, sorted iteration
// everywhere, no `Date.now`. Two runs of one seed produce the same wave ids in
// the same sequence. And all of that was still not enough for lockstep
// multiplayer, because four call sites used library functions that **the
// standard does not pin down**:
//
//     ES2024 21.3.2 — Math.sin, Math.exp, Math.log, Math.pow, Math.atanh:
//     "implementation-approximated". The spec permits any result within an
//     unspecified tolerance, and explicitly allows engines to differ.
//
// V8, SpiderMonkey and JavaScriptCore each ship their own polynomial for these.
// One last-bit disagreement in a battle multiplier becomes a different number
// of survivors, then a different capture, then two players watching two
// different wars. That is not a bug that gets reported; it is a bug that makes
// the game unplayable and gives no error.
//
// **The existing determinism tests cannot catch this and never could** — they
// compare two runs inside ONE engine, where `Math.sin` is a pure function and
// agrees with itself perfectly. Every one of them passes today and would pass
// on a build that desyncs the moment a Firefox player joins a Chrome player.
// That is the whole reason this landed before `06-movement-and-attrition.md`,
// which adds an attrition model and with it more sim arithmetic to retrofit.
//
// WHAT *IS* EXACT, and why this is not just moving the problem
//
// IEEE 754 double `+ - * /` and `Math.sqrt` are correctly rounded, and
// ECMAScript requires them to be (6.1.6.1). So is `Math.floor` / `Math.round` /
// `Math.abs`. So are the named constants `Math.PI`, `Math.LN2`, `Math.SQRT2` —
// each is defined as the double closest to its value, which is one specific bit
// pattern on every engine. A function built only from those is bit-identical
// everywhere, forever, by the same argument that makes the RNG portable.
//
// So: multiply loops for integer powers, polynomial evaluation after exact
// range reduction for the rest. No lookup tables. A table with interpolation
// was the roadmap's suggestion for the sine and it is strictly worse here — a
// minimax-grade polynomial is the same amount of code and lands ~1e-14 from
// `Math.sin` instead of ~1e-3 from it, which is the difference between "the
// board plays the same" and "the wobble was retuned without telling anyone".
//
// ACCURACY IS A SEPARATE CLAIM FROM DETERMINISM, and only the second one is
// load-bearing. These functions do not need to match `Math.*`; they need to
// match THEMSELVES on every engine. The error bounds below are asserted in
// test/exact-tests.js anyway, because a function that is deterministically
// wrong would sail through every determinism test in the project.
//
// WHAT THIS COST: the balance hashes moved. See test/exact-tests.js and the
// commit message. Bit-for-bit identical was never available — the old numbers
// were whatever V8 happened to return.

'use strict';

// ---------------------------------------------------------------------------
// Reciprocal factorials, built at load time from integer literals.
//
// Every denominator below is under 2^53, so each literal is an exactly
// representable double and each division is correctly rounded. That makes these
// tables identical on every engine — which is the entire point, and is why they
// are written as divisions rather than as decimal expansions somebody would
// have to trust me to have typed correctly.
//
// `const` at the top level of a classic script is NOT a property of `window`
// (docs/testing/known-issues.md #3). These are private to this file and the
// `_exa` prefix says so; the exported names are the four `function`s at the
// bottom, which do hoist onto the global object.
// ---------------------------------------------------------------------------

// sin(r)/r = SUM (-1)^n r^2n / (2n+1)!   — coefficients a[n] = 1/(2n+1)!
const _EXA_SIN_C = [
  1,
  1 / 6,                    //  3!
  1 / 120,                  //  5!
  1 / 5040,                 //  7!
  1 / 362880,               //  9!
  1 / 39916800,             // 11!
  1 / 6227020800,           // 13!
  1 / 1307674368000,        // 15!
  1 / 355687428096000,      // 17!
];

// exp(r) = SUM r^n / n!
const _EXA_EXP_C = [
  1,
  1,
  1 / 2,
  1 / 6,
  1 / 24,
  1 / 120,
  1 / 720,
  1 / 5040,
  1 / 40320,
  1 / 362880,
  1 / 3628800,
  1 / 39916800,
  1 / 479001600,
  1 / 6227020800,
];

// atanh(s)/s = SUM s^2n / (2n+1)
const _EXA_ATANH_C = [
  1, 1 / 3, 1 / 5, 1 / 7, 1 / 9, 1 / 11, 1 / 13, 1 / 15, 1 / 17, 1 / 19,
];

// The interval on which the ten atanh terms above are converged: |s| <= this
// leaves under 1e-17. It is (SQRT2-1)/(SQRT2+1), which is what exactLog's
// normalisation produces, and exactAtanh reuses the same bound to decide
// whether it can skip the log entirely.
const _EXA_ATANH_DIRECT = (Math.SQRT2 - 1) / (Math.SQRT2 + 1);

// LN2 split into a head with 22 significant bits and an exact tail.
//
// `k * _EXA_LN2_HI` is then an EXACT product for every k the exponent range can
// produce (22 bits of head times 11 bits of k is 33 bits, well inside 53), so
// the reduction x - k*LN2 loses only the one rounding of the `k * lo` term
// instead of rounding the whole product. Without this, exp(-700) came out 8e-14
// off relative; with it, 1e-16.
//
// Derived, not typed: rounding Math.LN2 to a multiple of 2^-22 is exact, and so
// is the subtraction that recovers the tail (the two are within a factor of two
// of each other, so Sterbenz applies). A hand-entered hex constant here would be
// one more thing nobody can check.
const _EXA_LN2_HI = Math.round(Math.LN2 * 4194304) / 4194304;
const _EXA_LN2_LO = Math.LN2 - _EXA_LN2_HI;

// ---------------------------------------------------------------------------
// exactSin(x)
//
// Range-reduce to |r| <= PI/2, then nine Taylor terms. Truncation error is
// bounded by (PI/2)^19 / 19! < 5e-14 absolute, and the test pins that.
//
// Both reductions are subtractions of nearby doubles, so they lose nothing that
// `x` did not already lack. Precision in `x` itself is the caller's problem, and
// sim/combat.js handles it by taking the tick count modulo the wobble period
// before it ever gets here — see the note at _swing().
// ---------------------------------------------------------------------------
function exactSin(x) {
  if (!isFinite(x)) return NaN;

  // Nearest multiple of 2*PI. Math.floor is exact; Math.PI is one fixed double.
  const k = Math.floor(x / (2 * Math.PI) + 0.5);
  let r = x - k * (2 * Math.PI);

  // Fold the outer quarters inward: sin(r) = sin(PI - r) = -sin(-PI - r).
  const half = Math.PI / 2;
  if (r > half) r = Math.PI - r;
  else if (r < -half) r = -Math.PI - r;

  const u = r * r;
  let p = _EXA_SIN_C[8];
  for (let i = 7; i >= 0; i--) p = _EXA_SIN_C[i] - u * p;
  return r * p;
}

// ---------------------------------------------------------------------------
// exactExp(x)
//
// exp(x) = 2^k * exp(x - k*LN2), k = round(x / LN2), so |r| <= LN2/2 < 0.3466.
// Fourteen Taylor terms put the truncation error at r^14/14! < 5e-18 — below
// the rounding noise of the evaluation itself.
//
// The 2^k scaling is a doubling loop rather than Math.pow(2, k): Math.pow is
// implementation-approximated even for exact powers of two, which is precisely
// the class of assumption this file exists to remove. Doubling and halving are
// exact in IEEE 754 until they run out of exponent, and the guards below stop
// the loop before that turns into a slow walk through the subnormals.
// ---------------------------------------------------------------------------
function exactExp(x) {
  if (x !== x) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  if (x > 709.8) return Infinity;      // overflows a double
  if (x < -745.2) return 0;            // underflows to zero

  const k = Math.round(x / Math.LN2);
  const r = (x - k * _EXA_LN2_HI) - k * _EXA_LN2_LO;

  let p = _EXA_EXP_C[13];
  for (let i = 12; i >= 0; i--) p = _EXA_EXP_C[i] + r * p;

  return _exaScale2(p, k);
}

// m * 2^k for integer k, by exact doubling. Bounded by the exponent range, so
// the loop cannot run away even on adversarial input.
function _exaScale2(m, k) {
  let v = m, n = k;
  while (n > 0 && isFinite(v)) { v *= 2; n--; }
  while (n < 0 && v !== 0) { v *= 0.5; n++; }
  return v;
}

// ---------------------------------------------------------------------------
// exactLog(v)  — natural log.
//
// Halve or double `v` into [1, 2) counting exponent steps — every one of those
// steps is exact — then normalise once more into [SQRT2/2, SQRT2) so that
// s = (v-1)/(v+1) satisfies |s| <= 0.1716. On that interval
//
//     log(v) = 2 * atanh(s)
//
// converges fast: ten terms leave under 1e-17. The exponent is paid back as
// e * LN2 at the end.
//
// The two normalising loops are O(exponent), i.e. at most ~1080 iterations for
// the extremes of the double range and typically none at all. The only caller
// today (ai/ai.js) passes values under 20001, which is fourteen halvings.
// ---------------------------------------------------------------------------
function exactLog(v) {
  if (v !== v) return NaN;
  if (v < 0) return NaN;
  if (v === 0) return -Infinity;
  if (v === Infinity) return Infinity;

  let m = v, e = 0;
  while (m >= 2) { m *= 0.5; e++; }
  while (m < 1) { m *= 2; e--; }
  if (m > Math.SQRT2) { m *= 0.5; e++; }

  const s = (m - 1) / (m + 1);
  const u = s * s;
  let p = _EXA_ATANH_C[9];
  for (let i = 8; i >= 0; i--) p = _EXA_ATANH_C[i] + u * p;

  return e * Math.LN2 + 2 * s * p;
}

// ---------------------------------------------------------------------------
// exactAtanh(y), |y| < 1.
//
// The identity, not the series: the series in `y` crawls as y approaches 1, and
// the one caller (ai/ai.js, the ETA spread window) evaluates at y = 1/MIN_ODDS
// which is 0.71 today and legitimately reaches 0.9999. exactLog is doing the
// convergence work on a variable that stays small.
//
// This keeps the cancellation in (1 - y) that the Math.atanh version had. It is
// not a regression and not worth removing: the caller clamps its odds floor to
// 1.0001, so 1 - y never drops below 1e-4 and the result is good to ~1e-11.
//
// SMALL |y| TAKES THE SERIES DIRECTLY, and this is not an optimisation. Going
// through the log for y = 1e-4 costs three decimal digits — log(1+e) for tiny e
// is the textbook cancellation, and the general exactLog path cannot dodge it.
// Nothing calls it there today, which is exactly when a wrong answer would sit
// unnoticed until something did. The branch point is the interval the series is
// already converged on, so the two halves agree to ~1e-17 where they meet, and
// the test checks that seam rather than trusting it.
// ---------------------------------------------------------------------------
function exactAtanh(y) {
  if (y !== y) return NaN;
  if (y >= 1) return (y === 1) ? Infinity : NaN;
  if (y <= -1) return (y === -1) ? -Infinity : NaN;

  if (y <= _EXA_ATANH_DIRECT && y >= -_EXA_ATANH_DIRECT) {
    const u = y * y;
    let p = _EXA_ATANH_C[9];
    for (let i = 8; i >= 0; i--) p = _EXA_ATANH_C[i] + u * p;
    return y * p;
  }
  return 0.5 * exactLog((1 + y) / (1 - y));
}

// ---------------------------------------------------------------------------
// exactPowInt(base, n)  — base^n for INTEGER n, by multiplication.
//
// This is the roadmap's own suggestion and it is the easy one: a multiply loop
// is exact by construction and needs no polynomial at all. Every use of
// Math.pow in the sim has an integer exponent (hop counts), so nothing needs
// the general case.
//
// A non-integer `n` is a programming error and gets a NAMED console error plus
// NaN, rather than a silent truncation to `n | 0`. The quiet version is the
// worse failure by a distance: `Math.pow(0.6, 1.5)` and a two-iteration loop
// differ by 23%, which reads as a tuning change nobody made. NaN at least
// propagates somewhere visible, and test/exact-tests.js asserts the guard
// fires — the guard being unreachable today is not a reason to leave it silent
// (docs/testing/known-issues.md #22).
// ---------------------------------------------------------------------------
function exactPowInt(base, n) {
  if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n) {
    console.error('[core/exact] exactPowInt needs an integer exponent, got ' + n);
    return NaN;
  }
  if (n < 0) return 1 / exactPowInt(base, -n);
  let r = 1;
  for (let i = 0; i < n; i++) r *= base;
  return r;
}
