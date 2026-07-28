// render/camera.js — zoom and pan for #board.
//
// 108 stations in a 1000x700 viewBox, and 00-vision.md §8 says "the number is
// the interface". In central Europe those numbers are 2-3 board units tall and
// four cities deep. This file exists so the player can get closer to them.
//
// THE RULE, from 01-data-schema.md ("Camera — pinned names"):
//
//   The camera moves the `viewBox` attribute on #board and NOTHING else.
//   It must never apply a `transform` to a layer group.
//
// render/select.js maps client pixels to board units through
// getScreenCTM().inverse() and hit-tests with closest('[data-station]'). Both
// already account for the viewBox, so moving it is transparent to selection,
// hover, the marquee and the ETA preview lines — zero changes over there. A
// group transform would silently desynchronise hit-testing from what is drawn:
// the marquee would select nodes that are not where you see them, with no
// error anywhere. Do not "optimise" this into a transform.
//
// ── the aspect-ratio trick, which is the load-bearing idea here ──────────
//
// #board carries preserveAspectRatio="xMidYMid meet" and the window resizes.
// With `meet`, a viewBox whose aspect ratio does not match the element's is
// scaled down to fit and letterboxed — so "the viewBox" and "what you can see"
// stop being the same rectangle, and any clamp written against the viewBox
// lets the board drift under the bars.
//
// So the camera never uses a viewBox that disagrees with the element. It works
// in a FIT rectangle: the base 1000x700 content grown on one axis until it has
// the element's exact aspect ratio, centred on the content. Rendering that fit
// rect is pixel-identical to what `meet` does with the base viewBox — the
// letterbox is simply spelled out as board area instead of being implicit.
// From there:
//
//   * every camera viewBox has the element's aspect ratio, so meet is a no-op
//     and screen == viewBox exactly;
//   * "zoomed all the way out" is view == fit, so scale is clamped at >= 1 and
//     you can never reach a blank field;
//   * "panned to the edge" is view contained in fit, one clamp on each axis,
//     so the board can never be lost off-screen.
//
// Getting stuck is worse than having no zoom: recovering needs a reload, and a
// reload restarts the match.
//
// ── ownership ────────────────────────────────────────────────────────────
//
// Read-only with respect to game state. The camera is render-local; it is not
// a field on GAME and never will be. Nothing here is per-frame either — it is
// entirely event driven (wheel / drag / key / resize), so it does not touch
// the loop.
//
// Private helpers are prefixed _cam by FILE, per known-issues #12: a prefix
// shared across a subsystem concentrates collisions rather than preventing
// them. Public names are the three pinned in 01-data-schema.md.

'use strict';

// Zoom range. 1 is the whole board.
//
// The ceiling is 4. It was originally picked when zoom was purely a magnifier
// and 4x was where legibility stopped improving; with the symbol counter-scale
// below it now buys something better — at 4x the geography is four times bigger
// while the nodes and numbers are unchanged, so a cluster genuinely thins out.
// 4x separates the Ruhr and the Danube completely, which is the whole job.
// Beyond that the map is mostly one country and the symbols start to look
// stranded in empty ground.
var CAM_MIN_SCALE = 1;
var CAM_MAX_SCALE = 4;

// Wheel feel. deltaY is normalised to pixels first (deltaMode 1 = lines,
// 2 = pages), then run through exp() so zoom is geometric — one notch does the
// same proportional thing at every scale, which is the only version that feels
// right when the range is 8x.
var CAM_WHEEL_K = 0.0016;
var CAM_WHEEL_MAX_STEP = 4;    // ceiling on one event, in case of a huge delta

// Step for the on-screen +/- buttons and the -/= keys.
var CAM_BUTTON_STEP = 1.5;

// ── arrow-key pan ───────────────────────────────────────────────────────
//
// Arrow panning is a VELOCITY integrated per frame, not a displacement per
// keydown. The first version was one step per event and it was jumpy for a
// reason no amount of step-size tuning could fix: a held key produces the OS
// repeat cadence — a ~500ms dead pause, then a burst of discrete jumps. The
// motion has to be continuous and owned by us, so a held key sets a direction
// flag and a rAF loop integrates it against real elapsed time.
//
// Expressed in VIEW WIDTHS PER SECOND, deliberately. A speed in board units
// per second is the trap: the view is four times narrower at 4x, so the same
// board-units/sec would sweep the screen four times faster exactly when the
// player is trying to be precise. As a fraction of the view it crosses the
// visible pane in the same wall-clock time at every zoom.
var CAM_PAN_SPEED = 0.9;      // view-widths (and view-heights) per second

// Ease in and out, in seconds. Instant full speed on press and instant zero on
// release reads as mechanical; a short ramp reads as motion. This is a ramp to
// a STOP, not inertia — nothing glides after release, because a strategy map
// that keeps sliding when you let go is imprecise in the one moment precision
// matters.
var CAM_PAN_RAMP = 0.12;

// Longest frame we will integrate. A stalled or backgrounded tab hands back a
// multi-second timestamp jump, and without this the camera teleports on the
// first frame after it wakes.
var CAM_PAN_MAX_DT = 0.05;    // seconds

// ── symbol counter-scale ────────────────────────────────────────────────
//
// Zooming the viewBox magnifies EVERYTHING uniformly: at 4x the Ruhr is four
// times bigger and exactly as tangled, because the garrison numbers, the node
// circles and the territory labels all grew with the geography. That is a
// magnifier, not a camera.
//
// The fix is to counter-scale the SYMBOL layer by 1/scale about each symbol's
// own anchor, so symbols hold a constant ON-SCREEN size while the geography
// scales underneath them. Then zooming genuinely separates a cluster: the
// distance between two cities quadruples while the circles stay the same size.
//
// 1 = symbols hold a constant on-screen size (map-pin behaviour, maximum
// decluttering). Lower values let symbols grow somewhat with the map. If the
// board reads as too sparse when zoomed, this is the ONE number to change.
var CAM_SYMBOL_EXP = 1;

// Subscribers notified after every camera write. Renderers that cache a
// transform keyed on the symbol scale need to know when it moved, and most of
// them (carets, preview lines) are not redrawn per frame — a zoom while the
// game is paused must still restyle them.
var CAM_LISTENERS = [];

function _camNotify() {
  // Stylesheet-driven sizes can compensate off this without any JS.
  try {
    var root = document.documentElement;
    if (root && root.style) root.style.setProperty('--cam-scale', String(_camNum(_camScale())));
  } catch (e) { /* no document (headless) — the listeners still fire */ }
  for (var i = 0; i < CAM_LISTENERS.length; i++) {
    // One throwing subscriber must not stop the camera or the others.
    try { CAM_LISTENERS[i](_camScale()); } catch (e) {
      console.error('[render/camera] onCameraChange subscriber threw:', e);
    }
  }
}

var CAM = {
  wired: false,
  svg: null,
  base: { x: 0, y: 0, w: 1000, h: 700 },   // read from the authored viewBox
  fit: null,      // base grown to the element's aspect ratio
  rect: null,     // cached element box, refreshed on resize only
  view: null,     // current viewBox {x,y,w,h}
  pan: null,      // { cx, cy } last client point while dragging
  ctxSuppress: false,
  // arrow-key pan: held direction flags, eased velocity, and the rAF handle.
  // vx/vy are a direction in -1..1 that chases the held direction; the speed
  // constant is applied at integration time.
  keys: { left: false, right: false, up: false, down: false },
  vx: 0, vy: 0,
  raf: 0,
  last: 0,        // timestamp of the previous integrated frame, ms
};

// ── geometry ────────────────────────────────────────────────────────────

// Measure the element and rebuild the fit rectangle. Called at init, on
// resize, and never per frame. Preserves the current scale and centre so a
// window resize (or the AI log opening, which changes the board's height
// without a window resize event) does not throw the player's view away.
function _camMeasure() {
  if (!CAM.svg) return;
  var r = CAM.svg.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return;   // not laid out yet
  CAM.rect = { width: r.width, height: r.height };

  var aspect = r.width / r.height;
  var b = CAM.base;
  var w = b.w, h = b.h;
  if (aspect > b.w / b.h) w = b.h * aspect;          // wider element: grow x
  else h = b.w / aspect;                             // taller element: grow y

  var oldFit = CAM.fit;
  var nextFit = {
    x: b.x + b.w / 2 - w / 2,
    y: b.y + b.h / 2 - h / 2,
    w: w, h: h, aspect: aspect,
  };

  // Carry the old scale and centre across the resize.
  var scale = 1, cx = nextFit.x + w / 2, cy = nextFit.y + h / 2;
  if (oldFit && CAM.view) {
    scale = oldFit.w / CAM.view.w;
    cx = CAM.view.x + CAM.view.w / 2;
    cy = CAM.view.y + CAM.view.h / 2;
  }
  CAM.fit = nextFit;

  var vw = nextFit.w / scale;
  _camSet({ x: cx - vw / 2, y: cy - (vw / aspect) / 2, w: vw, h: vw / aspect });
}

// The single write path to the viewBox. Clamps size, forces the element's
// aspect ratio, then clamps position so the view stays inside the fit rect.
// Everything that moves the camera goes through here, so there is exactly one
// place a clamp can be wrong.
function _camSet(v) {
  var f = CAM.fit;
  if (!f || !CAM.svg) return;

  var minW = f.w / CAM_MAX_SCALE;
  var maxW = f.w / CAM_MIN_SCALE;
  var w = v.w;
  if (!isFinite(w) || w <= 0) w = maxW;
  w = Math.min(maxW, Math.max(minW, w));
  var h = w / f.aspect;

  var x = v.x, y = v.y;
  if (!isFinite(x)) x = f.x;
  if (!isFinite(y)) y = f.y;
  // maxima are >= minima because w <= f.w and h <= f.h by construction.
  x = Math.min(f.x + f.w - w, Math.max(f.x, x));
  y = Math.min(f.y + f.h - h, Math.max(f.y, y));

  CAM.view = { x: x, y: y, w: w, h: h };
  CAM.svg.setAttribute('viewBox',
    _camNum(x) + ' ' + _camNum(y) + ' ' + _camNum(w) + ' ' + _camNum(h));
  _camSyncControls();
  _camNotify();
}

// Trim float noise out of the attribute so the DOM stays readable and diffs of
// a screenshot-driven bug report are not full of 1e-14.
function _camNum(n) {
  return Math.round(n * 1000) / 1000;
}

function _camScale() {
  return (CAM.fit && CAM.view) ? (CAM.fit.w / CAM.view.w) : 1;
}

// Client pixels -> board units. Same conversion select.js uses, for the same
// reason: it already accounts for whatever viewBox we have just set.
function _camPoint(clientX, clientY) {
  var svg = CAM.svg;
  if (!svg || !svg.createSVGPoint) return null;
  var ctm = svg.getScreenCTM();
  if (!ctm) return null;
  var pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  var p = pt.matrixTransform(ctm.inverse());
  return [p.x, p.y];
}

// Cheap self-heal, called at the START of a gesture — never per frame and
// never per pan move. Both `resize` and ResizeObserver are delivered during
// the browser's rendering steps, which are throttled to nothing in a hidden
// document (docs/testing/known-issues.md #10 is the same mechanism eating
// requestAnimationFrame). Anything that resizes the board while notifications
// are asleep would otherwise leave the camera clamping against a stale fit
// rect, and `meet` would quietly letterbox the difference. One
// getBoundingClientRect per wheel event or drag start costs nothing and makes
// the camera correct regardless of whether the notification ever arrives.
function _camCheckSize() {
  if (!CAM.svg || !CAM.rect) { _camMeasure(); return; }
  var r = CAM.svg.getBoundingClientRect();
  if (Math.abs(r.width - CAM.rect.width) > 0.5 ||
      Math.abs(r.height - CAM.rect.height) > 0.5) {
    _camMeasure();
  }
}

// ── zoom ────────────────────────────────────────────────────────────────

// Zoom by `factor` keeping the board point (ax, ay) under the same pixel.
// Anchoring is the whole difference between usable and infuriating: with a
// centre-anchored zoom every step needs a corrective pan, and on a board where
// the interesting part is off-centre that is most of the interaction.
function _camZoomAt(factor, ax, ay) {
  if (!CAM.view || !isFinite(factor) || factor <= 0) return;
  var v = CAM.view;
  var nw = v.w / factor;
  // Ratio AFTER clamping, so the anchor still holds at the ends of the range
  // instead of sliding while the size refuses to change.
  var f = CAM.fit;
  nw = Math.min(f.w / CAM_MIN_SCALE, Math.max(f.w / CAM_MAX_SCALE, nw));
  var k = nw / v.w;
  _camSet({ x: ax - (ax - v.x) * k, y: ay - (ay - v.y) * k, w: nw, h: nw / f.aspect });
}

function _camZoomCentre(factor) {
  if (!CAM.view) return;
  _camZoomAt(factor, CAM.view.x + CAM.view.w / 2, CAM.view.y + CAM.view.h / 2);
}

// True while the empire picker owns the board (render/start.js puts
// `is-choosing` on .app). This file self-bootstraps on DOMContentLoaded, long
// before app/main.js's boot() runs, so without this the camera is fully live on
// a screen whose only verb is "pick a country" — and the homeland labels the
// picker draws are not counter-scaled the way map.js's station symbols are, so
// a zoom visibly breaks them. style.css hides the controls during the pick;
// hiding a control while leaving the gesture live is the worse half of the fix,
// which is what this guard is for. startScreenHide() calls cameraReset().
function _camIdle() {
  var app = document.querySelector('.app');
  return !!(app && app.classList.contains('is-choosing'));
}

function _camOnWheel(evt) {
  if (!CAM.view) return;
  if (_camIdle()) return;        // before preventDefault: let the picker scroll
  evt.preventDefault();          // otherwise the page/trackpad scrolls instead
  _camCheckSize();
  var dy = evt.deltaY;
  if (evt.deltaMode === 1) dy *= 16;        // lines
  else if (evt.deltaMode === 2) dy *= 100;  // pages
  var factor = Math.exp(-dy * CAM_WHEEL_K);
  factor = Math.min(CAM_WHEEL_MAX_STEP, Math.max(1 / CAM_WHEEL_MAX_STEP, factor));
  var p = _camPoint(evt.clientX, evt.clientY);
  if (p) _camZoomAt(factor, p[0], p[1]);
  else _camZoomCentre(factor);
}

// ── pan ─────────────────────────────────────────────────────────────────
//
// Left-drag is the marquee (§8: selecting nodes IS the game), so pan takes the
// buttons nobody else wants: middle and right. selOnMouseDown already returns
// on `evt.button !== 0`, so those two are ours by construction and we never
// have to stop an event the marquee needs.
//
// A modifier + LEFT drag was tried and removed. select.js registers its
// mousedown before ours and does not look at modifier keys, so Alt+left starts
// a marquee no matter what we do here — preventDefault does not unregister
// another listener, and stopImmediatePropagation cannot reach a handler that
// has already run. The gesture would pan and marquee at the same time. Two
// buttons that select.js provably ignores is the only version that cannot
// fight it.
//
// Panning works in raw pixel deltas rather than by re-projecting through the
// CTM each move: the CTM changes as we pan, and chasing it produces a slow
// drift away from the grab point. Pixels per board unit is constant during a
// drag (only zoom or a resize changes it), so the delta conversion is exact.

// ── arrow-key pan loop ──────────────────────────────────────────────────
//
// Self-contained rAF rather than a hook into app/loop.js, for two reasons: the
// camera must keep panning while the GAME is paused (loopFrame honours
// GAME.paused and would freeze the view along with the sim), and the camera
// should not acquire a dependency on the sim loop's shape. It costs nothing
// when idle — the loop only exists while a direction is held or the velocity
// is still ramping down, and cancels itself the moment both are zero.

// Is there any motion left to integrate? Held key, or velocity still bleeding
// off after a release.
function _camPanActive() {
  var k = CAM.keys;
  return !!(k.left || k.right || k.up || k.down) ||
         Math.abs(CAM.vx) > 1e-4 || Math.abs(CAM.vy) > 1e-4;
}

// Move the velocity VECTOR toward the target direction by at most `max`.
//
// Vector rather than per-component, which matters for diagonals: ramping each
// axis independently toward 0.707 reaches full speed in 0.707 * RAMP seconds,
// so a diagonal press accelerates faster than a cardinal one and gains ~4% over
// the ramp. Limiting the length of the whole correction makes the ramp take
// exactly CAM_PAN_RAMP in every direction.
//
// Linear rather than exponential so the ramp actually FINISHES instead of
// asymptotically approaching the target and leaving a permanent trickle of
// velocity that never quite stops.
function _camApproachVec(vx, vy, tx, ty, max) {
  var dx = tx - vx;
  var dy = ty - vy;
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len > max && len > 0) {
    var f = max / len;
    dx *= f;
    dy *= f;
  }
  return [vx + dx, vy + dy];
}

// One integration step. Split out from the rAF callback and reachable by name
// so it can be driven with synthetic timestamps in a hidden document, where
// requestAnimationFrame never fires (docs/testing/known-issues.md #10) — the
// same shape as loopFrame(t).
function _camPanStep(ts) {
  if (!isFinite(ts)) return false;
  if (!CAM.last) { CAM.last = ts; return _camPanActive(); }
  var dt = (ts - CAM.last) / 1000;
  CAM.last = ts;
  if (!(dt > 0)) return _camPanActive();
  if (dt > CAM_PAN_MAX_DT) dt = CAM_PAN_MAX_DT;

  var k = CAM.keys;
  var tx = (k.right ? 1 : 0) - (k.left ? 1 : 0);
  var ty = (k.down ? 1 : 0) - (k.up ? 1 : 0);
  // Normalise the diagonal, or Up+Left travels 1.41x faster than either alone.
  if (tx && ty) { var inv = Math.SQRT1_2; tx *= inv; ty *= inv; }

  var v2 = _camApproachVec(CAM.vx, CAM.vy, tx, ty, dt / CAM_PAN_RAMP);
  CAM.vx = v2[0];
  CAM.vy = v2[1];
  // Snap the tail to zero so a released key ends at rest rather than leaving a
  // sub-pixel drift alive forever.
  if (!tx && Math.abs(CAM.vx) < 1e-4) CAM.vx = 0;
  if (!ty && Math.abs(CAM.vy) < 1e-4) CAM.vy = 0;

  var v = CAM.view;
  if (v && (CAM.vx || CAM.vy)) {
    // Fraction of the CURRENT view per second — zoom-independent by
    // construction. Through _camSet, so clamping to the fit rect is automatic:
    // panning into an edge slides flush and holds there.
    _camSet({
      x: v.x + CAM.vx * CAM_PAN_SPEED * v.w * dt,
      y: v.y + CAM.vy * CAM_PAN_SPEED * v.h * dt,
      w: v.w, h: v.h,
    });
  }
  return _camPanActive();
}

function _camPanTick(ts) {
  CAM.raf = 0;
  if (_camPanStep(ts)) _camPanLoop();
  else CAM.last = 0;
}

function _camPanLoop() {
  if (CAM.raf || typeof requestAnimationFrame !== 'function') return;
  CAM.raf = requestAnimationFrame(_camPanTick);
}

// Stop MOTION. Deliberately not "disable the camera": wheel, drag, buttons and
// keys all keep working after this — it only drops the held directions and the
// velocity, which is what blur and a hidden tab should do. A key held while the
// player tabs away never produces a keyup, so without this the camera would
// drift forever with no key left to release, and refocusing would resume a
// phantom pan.
function _camPanStop() {
  CAM.keys.left = CAM.keys.right = CAM.keys.up = CAM.keys.down = false;
  CAM.vx = 0;
  CAM.vy = 0;
  CAM.last = 0;
  if (CAM.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(CAM.raf);
  CAM.raf = 0;
}

// Returns the CAM.keys field for an arrow, or null. One table, so keydown and
// keyup can never disagree about which key sets which flag.
function _camArrowFlag(key) {
  if (key === 'ArrowLeft') return 'left';
  if (key === 'ArrowRight') return 'right';
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  return null;
}

function _camOnKeyUp(evt) {
  var flag = _camArrowFlag(evt.key);
  // Cleared unconditionally — no target or modifier guard. If the flag is set,
  // the release must clear it however the keyboard state has changed since the
  // press, or the key sticks down forever.
  if (flag && CAM.keys[flag]) {
    CAM.keys[flag] = false;
    // The loop keeps running until the velocity has ramped to zero.
    _camPanLoop();
  }
}

function _camIsPanButton(evt) {
  return evt.button === 1 || evt.button === 2;               // middle / right
}

function _camOnMouseDown(evt) {
  if (!_camIsPanButton(evt) || !CAM.view || _camIdle()) return;
  // Middle-click otherwise arms autoscroll on some platforms and the drag
  // never arrives. No stopPropagation: select.js must keep seeing every event.
  evt.preventDefault();
  _camCheckSize();               // pan converts pixels with the cached rect
  CAM.pan = { cx: evt.clientX, cy: evt.clientY };
  if (evt.button === 2) CAM.ctxSuppress = true;
  if (CAM.svg) CAM.svg.classList.add('is-panning');
}

function _camOnMouseMove(evt) {
  var p = CAM.pan;
  if (!p || !CAM.view || !CAM.rect) return;
  var perPx = CAM.view.w / CAM.rect.width;    // board units per client pixel
  var dx = (evt.clientX - p.cx) * perPx;
  var dy = (evt.clientY - p.cy) * perPx;
  p.cx = evt.clientX;
  p.cy = evt.clientY;
  // Drag the board, not the camera: content follows the cursor.
  _camSet({ x: CAM.view.x - dx, y: CAM.view.y - dy, w: CAM.view.w, h: CAM.view.h });
}

function _camEndPan() {
  if (!CAM.pan) return;
  CAM.pan = null;
  if (CAM.svg) CAM.svg.classList.remove('is-panning');
  // Released: the context menu belongs to the browser again from the next
  // click on. Scoping the suppression to the button being physically down is
  // what stops one stray right-click from killing the menu for the session.
  CAM.ctxSuppress = false;
}

function _camOnMouseUp(evt) {
  _camEndPan();
}

function _camOnContextMenu(evt) {
  // On macOS this fires at mousedown time, before any movement exists to
  // measure — so the test is "is the right button currently down on the
  // board", not "have we moved yet". CAM.ctxSuppress is cleared on every
  // mouseup and on blur, so it cannot latch.
  if (CAM.ctxSuppress) evt.preventDefault();
}

// ── keys ────────────────────────────────────────────────────────────────
//
// Claimed elsewhere and deliberately untouched: Escape and Cmd/Ctrl+A
// (render/select.js), Space and 1/2/4 (app/main.js), L (render/ailog.js).
// That leaves 0 / - / = / + , which is also the convention every map app uses,
// and the four arrows, which collide with nothing and are what a player
// reaches for when the board is bigger than the window.
//
// Hold-to-repeat is the browser's native key repeat. It arrives as a stream of
// keydown events and each one is a single _camSet, so it is already smooth
// without a second timer — and a timer here would be a per-frame cost in a file
// whose whole design is "event driven, never touches the loop".

function _camOnKeyDown(evt) {
  var t = evt.target;
  var tag = (t && t.tagName) || (document.activeElement && document.activeElement.tagName);
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
  if (evt.metaKey || evt.ctrlKey || evt.altKey) return;      // Cmd+0 is the browser's
  if (_camIdle()) return;   // the picker owns the keyboard; Enter is its confirm

  if (evt.key === '0') { evt.preventDefault(); cameraReset(); return; }
  if (evt.key === '-' || evt.key === '_') {
    evt.preventDefault(); _camZoomCentre(1 / CAM_BUTTON_STEP); return;
  }
  if (evt.key === '=' || evt.key === '+') {
    evt.preventDefault(); _camZoomCentre(CAM_BUTTON_STEP); return;
  }

  // Arrow pan. preventDefault or the page scrolls underneath the board.
  //
  // Shift is excluded HERE rather than in the guard at the top of the function:
  // on a US layout `+` IS Shift+=, so a blanket shiftKey return would kill the
  // zoom-in key. Arrows are the only bindings that need Shift left free, for
  // the browser's own selection idiom and any future Shift-arrow of ours.
  if (evt.shiftKey) return;
  var flag = _camArrowFlag(evt.key);
  if (!flag) return;
  evt.preventDefault();
  // OS key repeat is ignored outright: this is a held-key FLAG, and the motion
  // is integrated per frame by _camPanStep. Letting repeats through would set a
  // flag that is already set and buy nothing but the jitter we removed.
  if (evt.repeat) return;
  CAM.keys[flag] = true;
  _camPanLoop();
}

// ── on-screen controls ──────────────────────────────────────────────────
//
// A player who does not know the wheel zooms will never discover it, and this
// was asked for by someone mid-match. So the gesture gets a visible handle.
//
// The buttons live in .board-wrap, NOT inside the SVG. Anything painted over
// the board that accepts pointer events eats the click that commits an attack
// (01-data-schema.md, and the reason #g-ui and #g-waves are pointer-events:
// none). A DOM sibling in the corner is a fixed, obvious 100px of the board
// rather than an invisible hazard anywhere on it.

function _camBuildControls() {
  var wrap = CAM.svg && CAM.svg.parentNode;
  if (!wrap || wrap.querySelector('.cam-controls')) return;

  var bar = document.createElement('div');
  bar.className = 'cam-controls';
  bar.id = 'cam-controls';

  function btn(label, title, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn cam-btn';
    b.textContent = label;
    b.title = title;
    // Never take focus: a focused button turns Space (pause) into a re-click.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) { e.preventDefault(); fn(); });
    bar.appendChild(b);
    return b;
  }

  btn('+', 'Zoom in  (wheel, or +)', function () { _camZoomCentre(CAM_BUTTON_STEP); });
  btn('−', 'Zoom out  (wheel, or −)', function () { _camZoomCentre(1 / CAM_BUTTON_STEP); });
  btn('⌂', 'Whole board  (0)', function () { cameraReset(); });

  var read = document.createElement('span');
  read.className = 'cam-scale';
  read.id = 'cam-scale';
  read.textContent = '1.0x';
  bar.appendChild(read);

  var hint = document.createElement('div');
  hint.className = 'cam-hint';
  hint.textContent = 'scroll to zoom · right-drag or arrows to pan';
  wrap.appendChild(hint);

  wrap.appendChild(bar);
}

function _camSyncControls() {
  var read = document.getElementById('cam-scale');
  if (read) read.textContent = (Math.round(_camScale() * 10) / 10) + 'x';
  var wrap = CAM.svg && CAM.svg.parentNode;
  if (wrap) wrap.classList.toggle('is-zoomed', _camScale() > 1.001);
}

// ── pinned API (01-data-schema.md, "Camera — pinned names") ─────────────

// Wire zoom/pan on #board. Called once by app/main.js after renderBoard().
// Idempotent, like initSelection().
function initCamera() {
  if (CAM.wired) return true;
  var svg = document.getElementById('board');
  if (!svg) {
    console.error('[render/camera] no #board svg — camera not wired');
    return false;
  }
  CAM.svg = svg;

  // The authored viewBox is the whole board; tools/build-map.js fits the
  // projected geometry to it. Read it rather than hard-coding 1000x700, so the
  // camera stays correct if the map is ever re-projected.
  var vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0) {
    CAM.base = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  }

  _camBuildControls();
  _camMeasure();

  svg.addEventListener('wheel', _camOnWheel, { passive: false });
  svg.addEventListener('mousedown', _camOnMouseDown);
  svg.addEventListener('contextmenu', _camOnContextMenu);
  // move/up on window so a pan that leaves the board keeps tracking and always
  // ends — the same reason select.js does it.
  window.addEventListener('mousemove', _camOnMouseMove);
  window.addEventListener('mouseup', _camOnMouseUp);
  // Two separate blur listeners on purpose. _camEndPan is the MOUSE pan and is
  // also called from every mouseup; _camPanStop is the ARROW pan and must not
  // be, or clicking mid-pan would kill a still-held key and the motion would
  // never resume until it was pressed again.
  window.addEventListener('blur', _camEndPan);
  window.addEventListener('blur', _camPanStop);
  window.addEventListener('keydown', _camOnKeyDown);
  window.addEventListener('keyup', _camOnKeyUp);
  window.addEventListener('resize', _camMeasure);

  // A key held while the player tabs away or switches window never delivers a
  // keyup. Both of these stop MOTION only — every other camera control keeps
  // working, so this can never leave the game un-navigable.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') _camPanStop();
  });

  // The AI log (L) resizes the board without a window resize event, so watch
  // the element itself where the browser allows it.
  if (typeof ResizeObserver === 'function') {
    try { new ResizeObserver(_camMeasure).observe(svg); } catch (e) { /* ignore */ }
  }

  CAM.wired = true;
  _camNotify();     // publish the opening scale before anyone has moved
  console.log('[render/camera] zoom/pan wired on #board (wheel, right/middle-drag, arrows, 0/-/=)');
  return true;
}

// Back to the whole board.
function cameraReset() {
  _camCheckSize();
  if (!CAM.fit) return null;
  _camSet({ x: CAM.fit.x, y: CAM.fit.y, w: CAM.fit.w, h: CAM.fit.h });
  return cameraView();
}

// Frame a rectangle of BOARD units — the units of #board's viewBox, which is
// what SVGGraphicsElement.getBBox() already returns, so the common caller is
// `cameraFocus(someShape.getBBox())` and no coordinate conversion happens
// outside this file.
//
// `pad` is a multiplier on the box, not a pixel margin: the point of framing a
// country is to see the country AND the ring of neutral cities around it, and
// that ring scales with the country. Russia's box is most of the map and comes
// back at ~1x; Austria's is small and zooms hard. That difference is the map
// telling the truth about the two powers, so it is deliberately not normalised
// away — only capped, because past ~3x the labels start colliding.
//
// Everything goes through _camSet, so the size clamp (CAM_MIN/MAX_SCALE) and
// the position clamp (stay inside the fit rect) are the same ones every other
// camera move obeys. Returns the resulting view, or null if unwired.
function cameraFocus(box, pad, maxScale) {
  _camCheckSize();
  var f = CAM.fit;
  if (!f || !box) return null;
  var bw = Number(box.width), bh = Number(box.height);
  var bx = Number(box.x), by = Number(box.y);
  if (!isFinite(bw) || !isFinite(bh) || !isFinite(bx) || !isFinite(by)) return null;
  if (!(bw > 0) || !(bh > 0)) return null;

  var m = (isFinite(pad) && pad > 0) ? pad : 1.6;
  var cap = (isFinite(maxScale) && maxScale > 0) ? maxScale : 3;

  // Fit BOTH axes: take whichever of the padded width and the padded height
  // needs the wider view, or a tall thin country would be cropped top and
  // bottom while its box "fitted" horizontally.
  var wantW = Math.max(bw * m, (bh * m) * f.aspect);
  var minW = f.w / Math.min(cap, CAM_MAX_SCALE);
  if (wantW < minW) wantW = minW;

  var cx = bx + bw / 2, cy = by + bh / 2;
  var h = wantW / f.aspect;
  _camSet({ x: cx - wantW / 2, y: cy - h / 2, w: wantW, h: h });
  return cameraView();
}

// Current view, for tests and the console. A copy — the camera owns its state
// and nothing outside this file may write it.
function cameraView() {
  if (!CAM.view) return null;
  return {
    x: CAM.view.x, y: CAM.view.y,
    w: CAM.view.w, h: CAM.view.h,
    scale: _camScale(),
  };
}

// Current zoom, 1..CAM_MAX_SCALE. Cheap enough to call every frame — it is one
// division off cached state, no DOM read. cameraView() allocates; this does not.
function cameraScale() {
  return _camScale();
}

// The factor a SYMBOL must be scaled by to hold a constant on-screen size,
// i.e. scale^-CAM_SYMBOL_EXP. Applied about the symbol's OWN anchor:
//
//     transform="translate(x,y) scale(cameraSymbolScale())"
//
// This is the one place the exponent lives. No renderer recomputes it, so
// softening the effect is a one-line change in this file and every layer moves
// together. Returns 1 when the camera is not wired, so a board drawn before
// initCamera() is correct and needs no special case.
function cameraSymbolScale() {
  return Math.pow(_camScale(), -CAM_SYMBOL_EXP);
}

// Subscribe to camera changes. Fires after every viewBox write (zoom, pan,
// reset, resize) with the new scale. Renderers that cache a transform keyed on
// cameraSymbolScale() use this to invalidate; the ones that are not redrawn per
// frame (carets, preview lines) NEED it, because a zoom while paused produces
// no frames. Returns an unsubscribe function.
function onCameraChange(fn) {
  if (typeof fn !== 'function') return function () {};
  CAM_LISTENERS.push(fn);
  return function () {
    var i = CAM_LISTENERS.indexOf(fn);
    if (i >= 0) CAM_LISTENERS.splice(i, 1);
  };
}

window.initCamera = initCamera;
window.cameraReset = cameraReset;
window.cameraFocus = cameraFocus;
window.cameraView = cameraView;
window.cameraScale = cameraScale;
window.cameraSymbolScale = cameraSymbolScale;
window.onCameraChange = onCameraChange;

// Self-bootstrap, matching render/map.js and render/select.js: the board is
// drivable before app/main.js exists. app/main.js sets APP_OWNS_RENDER and
// calls initCamera() itself once the board has been drawn.
document.addEventListener('DOMContentLoaded', function () {
  if (!window.APP_OWNS_RENDER) initCamera();
});
