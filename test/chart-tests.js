// test/chart-tests.js — the end-screen chart, on the real page.
//
// Subject is render/victory.js's `_vscrChart` / `_vscrChartPaint`. The node
// harness loads no render/ file that draws the victory card, so a green there
// says nothing about this code (CLAUDE.md, the verification bar). Runs from
// tests-ui.html against the real index.html.
//
// ── why this file exists ────────────────────────────────────────────────
//
// Player request, 2026-08: *"show a line graph of development over time
// (toggles from territory and forces) so the user can see how the game
// progressed"*.
//
// Three things can break it and none of them throws:
//
//   1. The chart silently not being there. It returns null for a game with
//      fewer than two samples, which is correct — and would also be what a
//      broken recorder produced.
//   2. The toggle changing the buttons but not the lines. The polylines and the
//      axis label are rewritten by one function; a repaint that updated the
//      chrome and not the data would look completely normal.
//   3. Eating a click. The victory scrim is `pointer-events: none` precisely so
//      the final map stays readable underneath it (known-issue #5, five
//      occurrences). These are the first BUTTONS on that screen after the two
//      it already had, and a rule that widened pointer events to the scrim
//      would take the board back.
//
// Privates are prefixed `_cht`, by FILE (known-issue #12).

'use strict';

function _chtWin() {
  return (typeof window !== 'undefined') ? window : null;
}

// Run the live game to a real ending and draw the card. Deliberately a REAL
// ending rather than a forged `state.winner`: the chart is built from
// state.history, and a hand-set winner on a fresh board would produce a chart
// of nothing and a suite that passed by drawing an empty box.
function _chtEnding(maxTicks) {
  var cap = maxTicks || 40000;
  for (var i = 0; i < cap / 100 && !GAME.winner; i++) stepTicks(GAME, 100);
  renderVictory(GAME);
  return !!GAME.winner;
}

function _chtTabs(doc) {
  return Array.prototype.slice.call(doc.querySelectorAll('.vscr-chart-tab'));
}

function _chtTab(doc, label) {
  var t = _chtTabs(doc);
  for (var i = 0; i < t.length; i++) {
    if ((t[i].textContent || '').trim() === label) return t[i];
  }
  return null;
}

// Every polyline's points, as one string — the cheapest way to ask "did the
// data change" without caring which series moved.
function _chtPoints(doc) {
  var ls = doc.querySelectorAll('.vscr-chart-line');
  var out = [];
  for (var i = 0; i < ls.length; i++) out.push(ls[i].getAttribute('points') || '');
  return out.join('|');
}

function suiteVictoryChart() {
  var NAME = 'render / victory chart';
  var w = _chtWin();
  var missing = [];
  if (!w || typeof GAME === 'undefined' || !GAME) missing.push('a live GAME [index.html]');
  if (typeof renderVictory !== 'function') missing.push('renderVictory() [render/victory.js]');
  if (typeof stepTicks !== 'function') missing.push('stepTicks() [app or sim]');
  if (missing.length) { skipSuite(NAME, 'waiting on ' + missing.join(', ')); return; }

  suite(NAME);
  var doc = w.document;
  var ended = _chtEnding();

  test('the game reached a real ending, with a history to draw', function () {
    assert(ended, 'no winner after 40,000 ticks — every assertion below would be ' +
      'about a card that was never built (known-issue #8)');
    assert(GAME.history && GAME.history.t.length > 2,
      'the game ended with ' + ((GAME.history && GAME.history.t.length) || 0) +
      ' history samples — the recorder is not running');
  });

  test('the card carries a chart, one line per power, in power colours', function () {
    var svg = doc.querySelector('.vscr-chart-svg');
    assert(!!svg, 'no chart on the victory card');
    var lines = doc.querySelectorAll('.vscr-chart-line');
    var pids = Object.keys(GAME.history.p).sort();
    assertEqual(lines.length, pids.length,
      'the chart draws ' + lines.length + ' lines for ' + pids.length + ' powers');
    // Colour is ownership and comes from the power — that is what lets the
    // chart go without a legend. A line with no stroke would be invisible and
    // nothing else here would notice.
    var blank = 0;
    for (var i = 0; i < lines.length; i++) {
      var st = lines[i].style.stroke;
      if (!st || st === 'none') blank++;
    }
    assertEqual(blank, 0, blank + ' lines have no colour of their own');
  });

  test('every line has a point per sample — the whole game, not the end of it', function () {
    var n = GAME.history.t.length;
    var lines = doc.querySelectorAll('.vscr-chart-line');
    var bad = [];
    for (var i = 0; i < lines.length; i++) {
      var pts = (lines[i].getAttribute('points') || '').split(' ').filter(Boolean);
      if (pts.length !== n) bad.push('a line has ' + pts.length + ' points for ' + n + ' samples');
    }
    assertNone(bad, 'a series was truncated on its way to the screen');

    // AND THE LINES MUST DIFFER FROM EACH OTHER. Counting points is satisfied
    // by seven copies of one power's series — a mutation that drew every line
    // from lines[0] survived this test until this assertion existed, and on
    // screen it would look like a chart where every power did the same thing.
    var uniq = {};
    for (var k = 0; k < lines.length; k++) uniq[lines[k].getAttribute('points') || ''] = true;
    assert(Object.keys(uniq).length > 1,
      'all ' + lines.length + ' lines have identical points — every series is ' +
      'being drawn from the same power');
  });

  test('it opens on DEVELOPMENT, which is what was asked for', function () {
    var on = _chtTabs(doc).filter(function (t) { return t.classList.contains('is-on'); });
    assertEqual(on.length, 1, on.length + ' tabs are active at once');
    assertEqual((on[0].textContent || '').trim(), 'Development',
      'the chart opens on ' + on[0].textContent + ' rather than Development');
  });

  test('the toggle repaints the DATA, not just the buttons', function () {
    // The failure this is written against: a repaint that updates the chrome
    // and leaves the polylines alone looks completely correct — the right tab
    // lights up, the axis label changes — and shows the wrong metric.
    var terr = _chtTab(doc, 'Territory');
    var force = _chtTab(doc, 'Forces');
    var dev = _chtTab(doc, 'Development');
    assert(terr && force && dev, 'the three tabs are not all present');

    var beforePts = _chtPoints(doc);
    var beforeUnit = (doc.querySelector('.vscr-chart-unit') || {}).textContent;
    var beforeY = (doc.querySelector('.vscr-chart-y') || {}).textContent;

    terr.click();
    var afterPts = _chtPoints(doc);
    assert(afterPts !== beforePts,
      'switching to Territory left every polyline exactly as it was — the toggle ' +
      'is repainting the buttons and not the chart');
    assert((doc.querySelector('.vscr-chart-unit') || {}).textContent !== beforeUnit,
      'the unit label did not follow the metric');
    assert((doc.querySelector('.vscr-chart-y') || {}).textContent !== beforeY,
      'the y axis did not rescale — territory and development do not share a range');
    assert(terr.classList.contains('is-on') && !dev.classList.contains('is-on'),
      'the active tab did not move');

    // And back, to the same picture: the paint must be a pure function of the
    // metric, not a mutation that accumulates.
    dev.click();
    assertEqual(_chtPoints(doc), beforePts,
      'returning to Development drew a different chart from the one it started on');
  });

  test('the chart does not take the board back — known-issue #5', function () {
    // The victory scrim is pointer-events: none so the final map stays
    // readable. The chart lives inside .vscr-card, which is the one thing on
    // this screen that DOES take pointers; a rule that widened that to the
    // wrapper would put an invisible sheet over the whole board.
    var scrim = doc.getElementById('victory-screen');
    assert(!!scrim, 'no victory screen in the DOM');
    assertEqual(w.getComputedStyle(scrim).pointerEvents, 'none',
      'the victory scrim accepts pointer events — it is over the board');
    var wrap = doc.querySelector('.vscr-chart');
    assert(!!wrap, 'no chart wrapper');
    // The buttons must still be clickable, or the toggle above passed by
    // calling .click() on something a real player could never press.
    var tab = _chtTab(doc, 'Forces');
    var r = tab.getBoundingClientRect();
    assert(r.width > 0 && r.height > 0, 'a chart tab has no size');
    var hit = doc.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    assert(hit && hit.closest && hit.closest('.vscr-chart-tab') === tab,
      'a chart tab is not the thing under its own centre — it cannot be clicked');
  });
}
