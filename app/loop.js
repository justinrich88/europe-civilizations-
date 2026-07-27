// app/loop.js — the fixed-timestep accumulator.
//
// 00-vision.md §9, and the "Render / app API" table in 01-data-schema.md:
//
//   "Fixed-timestep accumulator, rAF only for render. Speed multiplies *time
//    consumed*, never the timestep — 4x is literally 'run more ticks', physics
//    identical at every speed. Catch-up capped to avoid a death spiral."
//
// The single most important line in this file is that `stepTick(state)` is
// called with no arguments beyond the state. It deliberately takes no `dt`
// (01-data-schema.md, "Sim API — pinned names"), because a variable timestep is
// exactly the thing this accumulator exists to prevent: with a seeded PRNG and
// a fixed step, a given seed produces the same game on a 144Hz monitor, on a
// 30fps laptop, at 1x, at 4x, and in the headless node harness. The moment the
// sim sees wall-clock time, none of that holds and replay/balance runs die.
//
// So: rAF gives us a wall-clock delta, we multiply that delta by the speed
// multiplier to decide HOW MANY whole BAL.TICK_MS ticks to consume, and every
// one of those ticks is bit-identical to every other.
//
// This file never mutates game state itself. It calls stepTick() and the
// renderers; anything else goes through applyCommand() (01-data-schema.md,
// "Input funnels to applyCommand").

'use strict';

// ── tunables, read defensively ──────────────────────────────────────────
//
// Known-issues #3: top-level `const` in a classic script is NOT a property of
// `window`, so `window.BAL` is undefined even when BAL is perfectly well
// defined. Every read of a data/ global in this project is a bare `typeof`.

function loopTickMs() {
  if (typeof BAL !== 'undefined' && isFinite(BAL.TICK_MS) && BAL.TICK_MS > 0) {
    return BAL.TICK_MS;
  }
  return 100;
}

// Catch-up cap. A backgrounded tab hands us a 30-second delta on the frame it
// returns; without a cap that is 300 ticks in one frame at 1x (1200 at 4x),
// which blows the frame budget, which makes the *next* delta larger, which is
// the death spiral. Past the cap we simply drop the surplus sim time — the
// game runs slow for one frame rather than freezing the page.
//
// NOTE ON THE CONTRACT: 01-data-schema.md names this `BAL.MAX_CATCHUP_TICKS`,
// but data/tuning.js as authored calls it `MAX_TICKS_PER_FRAME` (= 40). Both
// names are accepted here, preferring the documented one, so whichever way the
// discrepancy is resolved this file keeps working. Flagged in the report.
function loopMaxCatchupTicks() {
  if (typeof BAL !== 'undefined') {
    if (isFinite(BAL.MAX_CATCHUP_TICKS) && BAL.MAX_CATCHUP_TICKS > 0) {
      return BAL.MAX_CATCHUP_TICKS;
    }
    if (isFinite(BAL.MAX_TICKS_PER_FRAME) && BAL.MAX_TICKS_PER_FRAME > 0) {
      return BAL.MAX_TICKS_PER_FRAME;
    }
  }
  return 8;
}

// ── loop state ──────────────────────────────────────────────────────────
//
// `var` rather than `const`/`let` at top level is deliberate house style here:
// core/state.js does the same, and it means these are inspectable from the
// console during a debugging session.

var _loopRunning = false;    // rAF chain is live
var _loopRafId = 0;
var _loopLastMs = 0;         // performance.now() of the previous frame
var _loopAccumMs = 0;        // unconsumed sim time, in *sim* milliseconds
var _loopSpeed = 1;          // 0 = paused; otherwise a SPEEDS entry
var _loopPrevSpeed = 1;      // what unpausing restores (BAL.SPEEDS comment)

// Diagnostics. Cheap, and the difference between "the loop is wedged" and "the
// sim is wedged" is otherwise invisible from the console.
var LOOP_STATS = {
  frames: 0,
  ticks: 0,
  ticksLastFrame: 0,
  clamped: 0,          // frames where catch-up was capped and time was dropped
  droppedTicks: 0,     // total sim ticks thrown away by the cap
  maxCatchup: 8,       // resolved cap, refreshed each frame; see loopMaxCatchupTicks
};

// ── speed ───────────────────────────────────────────────────────────────

// setSpeed(0) pauses. Anything else is a multiplier on time consumed.
//
// GAME is the single source of truth (01-data-schema.md: "The single global
// game state is window.GAME"), so speed and paused are mirrored onto it rather
// than living only in this module's closure. A snapshot taken from the console
// should say what the player was actually looking at.
function setSpeed(n) {
  var v = Number(n);
  if (!isFinite(v) || v < 0) v = 1;

  if (v > 0) _loopPrevSpeed = v;
  _loopSpeed = v;

  if (window.GAME) {
    window.GAME.paused = (v === 0);
    // Keep `speed` meaning "the speed the game runs at when not paused" so a
    // pause/unpause round-trip is lossless.
    if (v > 0) window.GAME.speed = v;
  }

  // Dropping the accumulator on a speed change stops a stall from being repaid
  // at the new multiplier — otherwise pausing for ten seconds and unpausing at
  // 4x would fire a wall of catch-up ticks on the first frame.
  _loopAccumMs = 0;

  if (typeof syncSpeedButtons === 'function') syncSpeedButtons(v);
  return v;
}

// Space-bar behaviour: pause, or resume at whatever speed was last chosen.
function togglePause() {
  return setSpeed(_loopSpeed === 0 ? (_loopPrevSpeed || 1) : 0);
}

function currentSpeed() {
  return _loopSpeed;
}

// ── render guards ───────────────────────────────────────────────────────
//
// The three renderers are written by three different agents and edited while
// the page is open. A renderer that throws does so 60 times a second, and the
// resulting console flood buries the one stack trace you actually needed.
//
// So: catch, log the first few, then retire that renderer for the session. The
// other two keep painting, the loop keeps stepping, and the failure is legible.
// The try/catch itself is free on the happy path in every modern engine.

const RENDER_FAIL_LIMIT = 3;
var _renderFails = Object.create(null);

function safeRender(name, fn, state) {
  if (_renderFails[name] >= RENDER_FAIL_LIMIT) return false;
  try {
    fn(state);
    return true;
  } catch (e) {
    _renderFails[name] = (_renderFails[name] || 0) + 1;
    console.error('[app/loop] ' + name + '() threw (' + _renderFails[name] + '/' +
      RENDER_FAIL_LIMIT + ')', e);
    if (_renderFails[name] >= RENDER_FAIL_LIMIT) {
      console.error('[app/loop] disabling ' + name + '() for this session — ' +
        'reload once it is fixed');
    }
    return false;
  }
}

// ── the frame ───────────────────────────────────────────────────────────

function loopFrame(nowMs) {
  if (!_loopRunning) return;
  // Cancel before scheduling so there is only ever ONE live rAF chain, however
  // this function was entered. Two chains would double the effective frame rate
  // and make every measurement of the loop wrong.
  if (_loopRafId) cancelAnimationFrame(_loopRafId);
  _loopRafId = requestAnimationFrame(loopFrame);

  var state = window.GAME;
  var tickMs = loopTickMs();
  var maxTicks = loopMaxCatchupTicks();
  LOOP_STATS.maxCatchup = maxTicks;

  // Wall-clock delta since the last frame. Deliberately NOT clamped here —
  // there is exactly one catch-up limiter in this loop and it is the tick cap
  // below. A second, tighter clamp on `dt` would make BAL.MAX_TICKS_PER_FRAME
  // unreachable dead code and hide the fact that sim time was dropped.
  var dt = nowMs - _loopLastMs;
  _loopLastMs = nowMs;
  if (!isFinite(dt) || dt < 0) dt = 0;

  var ticks = 0;

  if (state && !state.winner && _loopSpeed > 0 && typeof stepTick === 'function') {
    // THE WHOLE POINT: speed scales the time we consume, not the step size.
    // 4x means four times as much sim time arrives per real second, which
    // means four times as many identical BAL.TICK_MS ticks.
    _loopAccumMs += dt * _loopSpeed;

    var want = Math.floor(_loopAccumMs / tickMs);

    if (want > maxTicks) {
      // Catch-up cap. Drop the surplus rather than carrying it: carrying it
      // guarantees the next frame is over budget too.
      LOOP_STATS.clamped++;
      LOOP_STATS.droppedTicks += (want - maxTicks);
      want = maxTicks;
      _loopAccumMs = 0;
    } else {
      _loopAccumMs -= want * tickMs;
    }

    for (var i = 0; i < want; i++) {
      stepTick(state);
      ticks++;
      // A win ends the sim mid-frame rather than at the next frame boundary,
      // so the tick that decided it is the last one that runs.
      if (state.winner) break;
    }
  } else {
    // Paused, or the sim has not loaded yet. Do not let sim time bank up.
    _loopAccumMs = 0;
  }

  LOOP_STATS.frames++;
  LOOP_STATS.ticks += ticks;
  LOOP_STATS.ticksLastFrame = ticks;

  // Render every frame regardless of whether the sim moved — hover, selection
  // and the pause overlay all still need to repaint while paused.
  //
  // These three are written by other agents in parallel and may genuinely not
  // exist yet, so each is guarded independently: a missing render/waves.js must
  // not take the HUD down with it.
  if (state) {
    if (typeof renderLive === 'function') safeRender('renderLive', renderLive, state);
    if (typeof renderWaves === 'function') safeRender('renderWaves', renderWaves, state);
    if (typeof renderHud === 'function') safeRender('renderHud', renderHud, state);
    if (typeof renderAiLog === 'function') safeRender('renderAiLog', renderAiLog, state);
  }
}

// ── entry point ─────────────────────────────────────────────────────────

function startLoop() {
  if (_loopRunning) return false;
  _loopRunning = true;
  _loopLastMs = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
  _loopAccumMs = 0;
  _loopRafId = requestAnimationFrame(loopFrame);
  console.log('[app/loop] started — tick ' + loopTickMs() + 'ms, catch-up cap ' +
    loopMaxCatchupTicks() + ' ticks/frame');
  return true;
}

function stopLoop() {
  _loopRunning = false;
  if (_loopRafId) cancelAnimationFrame(_loopRafId);
  _loopRafId = 0;
  return true;
}

// Global exports — no modules anywhere in this project.
window.startLoop = startLoop;
window.stopLoop = stopLoop;
window.setSpeed = setSpeed;
window.togglePause = togglePause;
window.currentSpeed = currentSpeed;
window.LOOP_STATS = LOOP_STATS;
