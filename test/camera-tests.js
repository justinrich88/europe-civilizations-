// test/camera-tests.js — the camera writes nothing when nothing moves.
//
// One suite. Subject is render/camera.js. Like test/select-tests.js it cannot
// run in test/node.js: every assertion here counts DOM ATTRIBUTE WRITES on a
// laid-out #board, which is the only place the defect was ever visible. It runs
// from tests-ui.html, which loads index.html itself in an iframe.
//
// ── why this file exists ────────────────────────────────────────────────
//
// Player report, 2026-07: *"if you attempt to zoom past the full zoom state the
// screen flickers."*
//
// _camSet() is the single write path for the viewBox, and it clamped
// unconditionally and then wrote unconditionally. So a zoom past the ceiling
// produced a perfectly valid result IDENTICAL to the current one — and wrote it
// anyway. Measured on the live board before the fix: eight `+` clicks at 4x
// produced eight viewBox writes whose value never changed once.
//
// Each of those redundant writes re-lays-out the whole SVG and calls
// _camNotify(), which sets a custom property on :root and runs every
// subscriber — render/map.js counter-scales 138 station symbols on each one. A
// wheel delivers dozens of events a second. That storm of identical work is
// what the player saw as flicker.
//
// The same bug lived at the FLOOR and nobody had reported it, which is the
// argument for fixing it at the write path rather than at the zoom-in caller:
// the wheel, the +/- buttons and the keys all arrive through _camSet, and so
// will the next one.
//
// ── how it tests, and why it is this shape ──────────────────────────────
//
// By MutationObserver on #board's viewBox attribute, not by reading the
// attribute before and after. Reading it cannot see this bug at all: the value
// is identical by definition, so a before/after comparison passes against the
// broken code. The defect is the WRITE, not the value — known-issue #8, and the
// version of it that is easiest to get wrong.
//
// MutationObserver is asynchronous. Every count here is taken after an
// `await`-equivalent settle, which is why the suite is promise-shaped while
// every other suite in the project is synchronous.
//
// Privates are prefixed `_camt`, by FILE (known-issue #12) — `_cam` belongs to
// render/camera.js.

'use strict';

// One settle. MutationObserver delivers on the microtask queue, but a zero
// timeout is not enough on its own when the click handler itself schedules
// work, so this is a real macrotask.
function _camtSettle() {
  return new Promise(function (r) { setTimeout(r, 120); });
}

function _camtBtn(label) {
  var all = document.querySelectorAll('.cam-btn');
  for (var i = 0; i < all.length; i++) {
    var t = (all[i].textContent || '').trim();
    // The minus is U+2212, not a hyphen. Accept both rather than depending on
    // which one the markup happens to carry.
    if (t === label || (label === '-' && (t === '−' || t === '-'))) return all[i];
  }
  return null;
}

// Count viewBox writes while `fn` runs. Returns { writes, changed } — `changed`
// counts only the writes whose value actually differed, so a test can assert
// "wrote nothing" and "wrote nothing REDUNDANT" separately.
function _camtCount(fn) {
  var board = document.getElementById('board');
  var writes = 0, changed = 0;
  var obs = new MutationObserver(function (recs) {
    for (var i = 0; i < recs.length; i++) {
      if (recs[i].attributeName !== 'viewBox') continue;
      writes++;
      if (board.getAttribute('viewBox') !== recs[i].oldValue) changed++;
    }
  });
  obs.observe(board, {
    attributes: true, attributeFilter: ['viewBox'], attributeOldValue: true,
  });
  fn();
  return _camtSettle().then(function () {
    obs.disconnect();
    return { writes: writes, changed: changed };
  });
}

function _camtClick(btn, n) {
  for (var i = 0; i < n; i++) btn.click();
}

// THIS SUITE IS ASYNCHRONOUS AND THAT IS A CONTRACT, NOT A DETAIL.
//
// test/asserts.js keeps ONE module-global `_currentSuite`, and only test(name,
// fn) records anything — a bare assert() outside it throws on failure and
// records NOTHING on success. The first version of this file made exactly that
// mistake: it measured correctly, asserted correctly, recorded zero tests, and
// printed a green banner. known-issue #8, self-inflicted.
//
// So every measurement is taken asynchronously and then handed to a SYNCHRONOUS
// test() call. And because `_currentSuite` is module-global, the runner must
// AWAIT the promise this returns before starting another suite, or these
// assertions file under somebody else's name with the totals still adding up.
// tests-ui.html does, and says why.
function suiteCamera(d) {
  suite('camera / no-op moves');

  var board = document.getElementById('board');
  var plus = _camtBtn('+');
  var minus = _camtBtn('-');
  var home = _camtBtn('\u2302');
  var readout = document.getElementById('cam-scale');

  if (!board || !plus || !minus) {
    skipTest('camera', '#board or the zoom controls are not on this page');
    return Promise.resolve();
  }

  if (home) home.click();

  return _camtSettle()
    // Reaching the ceiling must genuinely write. Without this control, every
    // "wrote nothing" assertion below would also pass on a camera that had
    // simply stopped working — which is the failure mode this shape of test
    // invites, and the reason each one is paired with a control.
    .then(function () {
      return _camtCount(function () { _camtClick(plus, 14); });
    })
    .then(function (r) {
      test('zooming in to the ceiling really moves the camera', function () {
        assert(r.changed > 0, 'control: expected real viewBox writes, got ' + r.changed);
      });
      test('the ceiling is 4x, and the readout says so', function () {
        assertEqual(readout ? readout.textContent : null, '4x', 'cam-scale readout');
      });
    })

    // THE BUG AS REPORTED.
    .then(function () {
      return _camtCount(function () { _camtClick(plus, 10); });
    })
    .then(function (r) {
      test('ten zoom-ins PAST the ceiling write the viewBox zero times', function () {
        assertEqual(r.writes, 0,
          'before the fix this was ten identical writes, each re-laying out ' +
          'the board and counter-scaling 138 symbols');
      });
    })

    // The floor had it too, and nobody had reported it. This is the assertion
    // that justifies fixing _camSet rather than the zoom-in caller.
    .then(function () {
      return _camtCount(function () { _camtClick(minus, 20); });
    })
    .then(function (r) {
      test('zooming out to the floor really moves the camera', function () {
        assert(r.changed > 0, 'control: expected real viewBox writes, got ' + r.changed);
      });
    })
    .then(function () {
      return _camtCount(function () { _camtClick(minus, 10); });
    })
    .then(function (r) {
      test('ten zoom-outs PAST the floor write the viewBox zero times', function () {
        assertEqual(r.writes, 0, 'the same defect at the other end of the range');
      });
    })

    // Suppression must not become paralysis. This is what catches "fixed the
    // flicker by breaking the camera".
    .then(function () {
      return _camtCount(function () { _camtClick(plus, 1); });
    })
    .then(function (r) {
      test('the camera still zooms immediately after being pinned at the floor', function () {
        assertEqual(r.changed, 1, 'one click, one real write');
      });
    })

    // The attribute write is only half the cost. _camNotify runs every
    // subscriber, and that is the 138-symbol half.
    .then(function () {
      if (typeof onCameraChange !== 'function') {
        skipTest('subscribers', 'onCameraChange is not exposed on this page');
        return null;
      }
      var fired = 0;
      onCameraChange(function () { fired++; });
      _camtClick(plus, 14);
      return _camtSettle().then(function () {
        var atCeiling = fired;
        _camtClick(plus, 10);
        return _camtSettle().then(function () {
          test('subscribers really are notified while the camera moves', function () {
            assert(atCeiling > 0, 'control: expected notifications, got ' + atCeiling);
          });
          test('a no-op zoom notifies no subscriber', function () {
            assertEqual(fired - atCeiling, 0,
              'render/map.js must not counter-scale 138 symbols for a camera ' +
              'that did not move');
          });
        });
      });
    })

    .then(function () {
      if (home) home.click();
      return _camtSettle();
    });
}

if (typeof window !== 'undefined') window.suiteCamera = suiteCamera;
