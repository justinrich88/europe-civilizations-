// app/main.js — bootstrap. The only file that creates game state.
//
// 01-data-schema.md, "Render / app API — pinned names":
//   "The single global game state is window.GAME, created by app/main.js.
//    Nothing else creates a state. sim/ never reads it — the sim only ever
//    receives a state as an argument."
//
// Responsibilities, in order:
//   1. stand down render/map.js's self-bootstrap
//   2. create window.GAME from a reproducible seed
//   3. draw the static board once
//   4. wire selection, chrome and keys
//   5. start the fixed-timestep loop
//
// Nothing here mutates state directly. Player input becomes a command object
// and goes through applyCommand(), the same entry point the AI uses — which is
// what keeps replay and headless testing free (01-data-schema.md).

'use strict';

// The human player. render/select.js reads this to decide which stations are
// selectable, and render/hud.js to decide whose numbers go in the top bar.
// 00-vision.md casts the player as one of the great powers; ger is the one with
// a central position and land borders on every front, which is the version of
// the map where the core skill (massing before committing) actually bites.
//
// ?player=fra overrides it, so one build can be handed to a human testing any
// of aut / fra / gbr / ger / ita / ott / rus without an edit. An unknown code
// falls back rather than throwing, for the same reason readSeed() does: a
// mistyped query string should still give you a game.
window.PLAYER = (function () {
  var m = /[?&]player=([a-z]{3})/.exec(String(location.search));
  var pid = m ? m[1] : 'ger';
  if (typeof POWERS !== 'undefined' && POWERS && !POWERS[pid]) {
    console.warn('[app/main] unknown player "' + pid + '", falling back to ger');
    return 'ger';
  }
  return pid;
})();

// Fixed default seed. NEVER Date.now(): a seed that changes per load makes bug
// reports unreproducible, and the whole determinism argument in 00-vision.md §9
// exists so that "seed 19140628, this happened" is a complete bug report.
// 19140628 = 28 June 1914, Sarajevo.
const DEFAULT_SEED = 19140628;

// ── send fraction ───────────────────────────────────────────────────────
//
// 00-vision.md §8: "A persistent 25 / 50 / 75 / All setting applies to the
// whole volley; default 75%, and it's a tuning constant. Set once, not per
// attack." So this is app-level UI state, not game state — it is a preference
// about how commands are built, and it is deliberately NOT in window.GAME
// (state stays small and diffable, 01-data-schema.md).

var _sendFraction = 0.75;

function sendFraction() {
  return _sendFraction;
}

function setSendFraction(f) {
  var v = Number(f);
  if (!isFinite(v) || v <= 0 || v > 1) return _sendFraction;
  _sendFraction = v;
  syncFractionButtons(v);
  return v;
}

// The fraction above is now a DEFAULT rather than the whole answer. The amount
// can also be decided at the moment of the click — shift = all, alt = half —
// which is per-commit and leaves nothing behind. That override lives entirely in
// render/select.js, beside the click that consumes it, because it is not a
// setting: there is no state here to hold it.
//
// The INF / ART / ARM type filter that used to live here (`_sendTypes`,
// `sendTypes()`, `sendTypeEnabled()`, `toggleSendType()`, `syncTypeButtons()`)
// was deleted 2026-07 on the player's instruction. Choosing sources already
// chooses unit types, so the toggles bought only "send this city's infantry but
// leave its guns" in exchange for a permanent mode the player had to remember.
// `cmd.types` and `_cmdFilterTypes()` remain in sim/commands.js — optional
// plumbing, covered by tests, and nothing in the UI sets it any more.

// ── chrome wiring ───────────────────────────────────────────────────────
//
// Both button groups follow the same rule: the DOM carries the value in a data
// attribute, the handler reads it, and a single sync function owns `is-active`.
// Nothing reads button state back — the JS value is authoritative and the
// classes are a projection of it.

function syncSpeedButtons(speed) {
  const wrap = byId('speed-controls');
  if (!wrap) return;
  const btns = wrap.querySelectorAll('[data-speed]');
  for (const b of btns) {
    const v = Number(b.getAttribute('data-speed'));
    b.classList.toggle('is-active', v === speed);
  }
}

function syncFractionButtons(fraction) {
  const wrap = byId('send-control');
  if (!wrap) return;
  const btns = wrap.querySelectorAll('[data-fraction]');
  for (const b of btns) {
    const v = Number(b.getAttribute('data-fraction'));
    b.classList.toggle('is-active', v === fraction);
  }
}

// One delegated listener per group rather than one per button: the markup in
// index.html is owned by nobody in particular right now and buttons may be
// added, so delegation survives edits that per-button binding would not.
function wireSpeedControls() {
  const wrap = byId('speed-controls');
  if (!wrap) {
    console.warn('[app/main] no #speed-controls in the document');
    return;
  }
  wrap.addEventListener('click', function (ev) {
    const btn = ev.target.closest('[data-speed]');
    if (!btn || !wrap.contains(btn)) return;
    setSpeed(Number(btn.getAttribute('data-speed')));
  });
}

function wireSendControls() {
  const wrap = byId('send-control');
  if (!wrap) {
    console.warn('[app/main] no #send-control in the document');
    return;
  }
  // One delegated listener, matching wireSpeedControls(). The fraction is the
  // only control left in this box — the type toggles it used to share the
  // listener with are gone.
  wrap.addEventListener('click', function (ev) {
    const frac = ev.target.closest('[data-fraction]');
    if (frac && wrap.contains(frac)) {
      setSendFraction(Number(frac.getAttribute('data-fraction')));
    }
  });
}

// Keyboard: space toggles pause, 1/2/4 set speed. Deliberately tiny — 00-vision
// §8 says selecting nodes and clicking targets is the only verb, so keys here
// cover the clock and nothing else. Selection keys (Ctrl+A, shift) belong to
// render/select.js and are not touched.
function wireKeys() {
  document.addEventListener('keydown', function (ev) {
    // Never steal keys from a text field, if one ever appears.
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    if (ev.code === 'Space' || ev.key === ' ') {
      ev.preventDefault();          // space would otherwise scroll / re-click
      togglePause();
      return;
    }
    if (ev.key === '1' || ev.key === '2' || ev.key === '4') {
      ev.preventDefault();
      setSpeed(Number(ev.key));
    }
  });
}

// ── seed ────────────────────────────────────────────────────────────────

// ?seed=N overrides the default so a specific game can be re-opened from a URL.
// Anything unparseable falls back rather than throwing — a mistyped query
// string should still give you a game.
function readSeed() {
  try {
    const raw = new URLSearchParams(window.location.search).get('seed');
    if (raw === null) return DEFAULT_SEED;
    const n = Number(raw);
    if (!isFinite(n)) {
      console.warn('[app/main] ?seed=' + raw + ' is not a number; using default');
      return DEFAULT_SEED;
    }
    return Math.floor(n) >>> 0;
  } catch (e) {
    return DEFAULT_SEED;
  }
}

// ── boot ────────────────────────────────────────────────────────────────

// Run one bootstrap step, reporting rather than propagating a throw. Boot is a
// sequence of independent steps and there is no step whose failure should
// cancel the ones after it.
function tryStep(name, fn) {
  try {
    fn();
    return true;
  } catch (e) {
    console.error('[app/main] ' + name + '() threw during boot; continuing:', e);
    return false;
  }
}

function boot() {
  // Stands down the self-bootstrap at the bottom of render/map.js, so the board
  // is drawn exactly once, by us, after GAME exists.
  window.APP_OWNS_RENDER = true;

  if (typeof newGame !== 'function') {
    console.error('[app/main] core/state.js has not loaded — no newGame()');
    return false;
  }

  const seed = readSeed();
  window.GAME = newGame(seed);

  // Hand the AI the one power it must NOT drive. ai/ai.js skips state.human;
  // absent (headless tests, tools/balance.js) means every power is AI-driven,
  // which is what a batch wants. Without this the player watches their own
  // cities launch attacks they never ordered.
  window.GAME.human = window.PLAYER;
  console.log('[app/main] new game, seed ' + seed + ', player ' + window.PLAYER);

  // Static layers first: renderBoard() is the expensive full rebuild and is
  // called once and only once (01-data-schema.md).
  //
  // Wrapped, and so is initSelection(), because render/ and app/ are being
  // written by different hands at the same time. A renderer that throws
  // half-way through must not take the speed buttons, the keyboard and the
  // loop down with it — that turns "the map looks wrong" into "the page is
  // dead", which is a much worse thing to debug.
  if (typeof renderBoard === 'function') tryStep('renderBoard', renderBoard);
  else console.error('[app/main] render/map.js has not loaded — no renderBoard()');

  // Written by another agent in parallel; may not exist yet.
  if (typeof initSelection === 'function') tryStep('initSelection', initSelection);

  // Zoom/pan (render/camera.js). After renderBoard() — it measures the board.
  if (typeof initCamera === 'function') tryStep('initCamera', initCamera);

  // AI decision log (render/ailog.js) — hidden until `L`. Optional like the AI
  // it inspects, so it is guarded the same way.
  if (typeof initAiLog === 'function') tryStep('initAiLog', initAiLog);

  wireSpeedControls();
  wireSendControls();
  wireKeys();
  syncFractionButtons(_sendFraction);

  // The game opens paused (core/state.js sets paused:true) so the player can
  // read the board before anything moves. setSpeed(0) makes the loop, the state
  // and the buttons all agree on that.
  setSpeed(0);

  // First HUD paint before the loop's first frame, so the bar is never blank.
  if (typeof renderHud === 'function') renderHud(window.GAME);

  // Same for the rail, and for the same reason. Without this the rail is built
  // by its first frame from app/loop.js, which is normally 16ms away and
  // invisible — but not always: requestAnimationFrame is throttled hard in a
  // background tab and in the in-app preview pane, where the rail was measured
  // sitting empty at 284px wide with the game already loaded and paused.
  // The game opens paused on purpose so the board can be read before anything
  // moves (setSpeed(0) below), and a 284px column of nothing is a poor thing to
  // read. The HUD has always been painted here; the rail was simply newer.
  if (typeof renderReadout === 'function') renderReadout(window.GAME);

  if (typeof startLoop === 'function') startLoop();
  else console.error('[app/main] app/loop.js has not loaded — no startLoop()');

  return true;
}

// Global exports — no modules anywhere in this project.
window.sendFraction = sendFraction;
window.setSendFraction = setSendFraction;
window.syncSpeedButtons = syncSpeedButtons;
window.syncFractionButtons = syncFractionButtons;
window.boot = boot;

document.addEventListener('DOMContentLoaded', boot);
