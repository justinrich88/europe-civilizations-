// core/rng.js — deterministic PRNG (mulberry32).
//
// Two interfaces over the same generator:
//
//   1. Explicit-state helpers — rngFloat(state) -> { state, value }.
//      The state is a plain uint32, so it can live inside the serializable
//      game state object (00-vision.md §9: "seeded PRNG with its state inside
//      the game state"). A snapshot fully determines the future.
//
//   2. makeRng(seed) -> { next(), state } — a thin stateful wrapper for
//      throwaway uses (map jitter, test fixtures) where threading state by
//      hand is noise.
//
// Math.random is banned project-wide. Nothing here calls it.

'use strict';

// Coerce anything into a uint32 seed. Strings hash via FNV-1a so that
// makeRng('france') is stable and readable in test fixtures.
function rngSeed(seed) {
  if (typeof seed === 'number' && isFinite(seed)) return seed >>> 0;
  const s = String(seed === undefined || seed === null ? 'concert-of-europe' : seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The generator step. Takes a state, returns the next state and a float
// in [0, 1). Pure — no hidden mutation.
function rngFloat(state) {
  const next = (state + 0x6d2b79f5) >>> 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  z = (z ^ (z >>> 14)) >>> 0;
  return { state: next, value: z / 4294967296 };
}

// Float in [lo, hi).
function rngRange(state, lo, hi) {
  const r = rngFloat(state);
  return { state: r.state, value: lo + r.value * (hi - lo) };
}

// Integer in [lo, hi] inclusive.
function rngInt(state, lo, hi) {
  const r = rngFloat(state);
  return { state: r.state, value: lo + Math.floor(r.value * (hi - lo + 1)) };
}

// Uniform pick from an array. Returns value undefined for an empty array,
// and still advances the state so callers stay in lockstep.
function rngPick(state, arr) {
  const r = rngFloat(state);
  if (!arr || arr.length === 0) return { state: r.state, value: undefined };
  return { state: r.state, value: arr[Math.floor(r.value * arr.length)] };
}

// True with probability p.
function rngChance(state, p) {
  const r = rngFloat(state);
  return { state: r.state, value: r.value < p };
}

// Stateful wrapper. `state` is readable and writable so a run can be
// snapshotted or rewound.
function makeRng(seed) {
  let s = rngSeed(seed);
  return {
    next() {
      const r = rngFloat(s);
      s = r.state;
      return r.value;
    },
    get state() { return s; },
    set state(v) { s = rngSeed(v); },
  };
}
