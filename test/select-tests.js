// test/select-tests.js — the armed supply gesture, driven by real mouse events.
//
// One suite. Subject is render/select.js, and unlike every other suite in this
// project it CANNOT run in test/node.js: select.js hit-tests through
// `getScreenCTM()` and `evt.target.closest('[data-station]')`, so it needs a
// laid-out SVG board and a live GAME. It skips cleanly everywhere else.
//
// ── why this file exists ────────────────────────────────────────────────
//
// Player report, 2026-07: *"if you right click while setting, it just a normal
// send and doesn't go through."* While a supply order was armed, the right
// button skipped _selCommitArmed entirely and fell through to selReinforce — so
// the army marched, no route was created, and clearSelection() inside selCommit
// then disarmed and emptied the group on the way out. The banner therefore
// vanished exactly as it does on success. Nothing errored, nothing logged.
//
// ── how it tests, and why it is this expensive ──────────────────────────
//
// Every gesture here is a synthetic mousedown/mouseup pair dispatched at a
// station's REAL screen position, on the REAL station node. Calling
// _selCommitArmed() directly would have been ten lines and would have passed on
// the unfixed code, because the bug was never inside that function — it was that
// one of the two buttons never reached it. known-issue #8: a test that cannot
// fail is worse than no test, and the only version of this test that can fail is
// one that enters through the same door the player does.
//
// ── isolation ───────────────────────────────────────────────────────────
//
// The suite swaps `window.GAME` for a scratch board for the duration and puts
// the player's game back afterwards, because these tests fire real commands that
// really do spend garrisons. It also restores the selection, the armed state and
// the send fraction.
//
// ── EVERY GESTURE NOW NEEDS A TICK — the A3 retrofit, 2026-08 ───────────
//
// ~~Nothing here steps a tick, so no AI ever runs~~ — every gesture below is
// followed by _seltStep(), and this is the change that rewrote the file rather
// than a tidy-up.
//
// render/select.js used to call applyCommand() directly, so a click had done its
// work by the time the handler returned and every assertion could read the board
// on the next line. All three verbs now go through queueCommand(): the click
// SCHEDULES, and the board does not move until the drain at the head of the next
// tick. An assertion written the old way reads the board a tick early and fails
// on correct code — which is the good failure. The dangerous one is the mirror
// image, an assertion of the form "nothing happened" that now passes because
// nothing has happened YET, and it would pass against a file that never queued
// the command at all. So the ones that assert absence step the tick FIRST and
// then look.
//
// Stepping is safe here for the reason the old comment gave for not stepping:
// the scratch board is marked AI-quiet at creation (known-issue #13), so no
// opponent moves between the setup and the assertion.
//
// Privates are prefixed `_selt`, by FILE (known-issue #12): `_sel` belongs to
// render/select.js and `_help` to the guide.

// ---------------------------------------------------------------------------
// Driving the board
// ---------------------------------------------------------------------------

// A station's centre in CLIENT PIXELS, through the same matrix selSvgPoint()
// inverts. Recomputed per call rather than cached: the camera pan test really
// does move the board, and a cached point would aim the next test at where the
// city used to be.
function _seltAt(sid) {
  var svg = document.getElementById('board');
  var m = svg.getScreenCTM();
  var p = svg.createSVGPoint();
  p.x = STATIONS[sid].pos[0];
  p.y = STATIONS[sid].pos[1];
  var q = p.matrixTransform(m);
  return [q.x, q.y];
}

// The element a real press at this point would land on. NOT the station's own
// <g> looked up by id, which is the tempting version and the useless one:
// selStationAt() starts from `evt.target.closest('[data-station]')`, so a test
// that hands it the right node has already answered the question. Anything
// painted over the board that accepts pointer events silently eats the click
// that commits an order, with no error at all — five occurrences on this
// project — and elementFromPoint is the only way a synthetic gesture can see
// one. If an overlay is there, it becomes the target, `closest` finds no
// station, and these tests go red the way the player's click goes dead.
function _seltTargetAt(x, y) {
  return (typeof document.elementFromPoint === 'function')
    ? document.elementFromPoint(x, y) : null;
}

// Dispatch at a station's centre. Bubbling carries the event to the #board
// listener (mousedown) and on to window (mouseup, mousemove), which is the same
// path a real press takes.
function _seltFire(type, sid, button, dx, dy, mods) {
  var pt = _seltAt(sid);
  var el = _seltTargetAt(pt[0] + (dx || 0), pt[1] + (dy || 0)) ||
           document.getElementById('board');
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window,
    clientX: pt[0] + (dx || 0), clientY: pt[1] + (dy || 0),
    button: button, buttons: button === 2 ? 2 : 1,
    metaKey: !!(mods && mods.meta), shiftKey: !!(mods && mods.shift),
  }));
}

function _seltClick(sid, button, mods) {
  _seltFire('mousedown', sid, button, 0, 0, mods);
  _seltFire('mouseup', sid, button, 0, 0, mods);
}

// A press that travels past SEL_RCLICK_SLOP_PX — i.e. a camera pan. The move
// goes on window because that is where selOnMouseMove is wired, and the whole
// gesture is measured from ONE base point: render/camera.js is really panning
// underneath it, so re-reading the station's position mid-drag would chase the
// board and never accumulate any travel.
function _seltRightDrag(sid, dist) {
  var base = _seltAt(sid);
  var el = _seltTargetAt(base[0], base[1]) || document.getElementById('board');
  el.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true, cancelable: true, view: window,
    clientX: base[0], clientY: base[1], button: 2, buttons: 2,
  }));
  window.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, clientX: base[0] + dist, clientY: base[1] + dist,
    button: 2, buttons: 2,
  }));
  window.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true, clientX: base[0] + dist, clientY: base[1] + dist,
    button: 2, buttons: 2,
  }));
}

// Does a press at this station's centre actually RESOLVE to this station?
// selStationAt() overrides the DOM hit with a nearest-centre search, and this
// map has 77 overlapping pairs — so a fixture that assumed its neighbour was
// clickable could be silently aiming at the city on top of it, and every
// assertion below would then be about the wrong city.
//
// Probed with a complete right-click and an EMPTY selection, which selReinforce
// treats as a no-op: a half-finished press would leave render/camera.js holding
// a live pan that the next test's mousemove would drag the board with.
function _seltResolves(sid) {
  clearSelection();
  _seltFire('mousedown', sid, 2);
  var got = SEL_STATE.rdrag && SEL_STATE.rdrag.station;
  _seltFire('mouseup', sid, 2);
  return got === sid;
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

// A scratch board on which the player owns a source and a directly-linked
// destination. Linked rather than merely near, so the reinforce march the
// unfixed code produced is one that genuinely routes — a fixture whose two
// cities had no path would make "no wave was created" pass for the wrong
// reason, which is the shape of the false pass known-issue #8 is about.
//
// Returns the fixture, or `{ why, fatal }`. The distinction is load-bearing:
// "there is no player power" is a page this suite has no business running on
// and skips, but "no city on the board answers a press at its own centre" is a
// FAILURE, and the difference was measured. Painting a transparent
// pointer-accepting div over the board — the exact bug this project has hit
// five times — makes every probe miss, and the first version of this function
// answered that by returning null, so the suite reported SKIP and the run came
// back green. A board that has stopped accepting clicks must be able to turn
// something red, or this suite is decoration on top of the failure it is most
// likely to meet.
function _seltFixture() {
  var me = selPlayer();
  if (!me) return { why: 'no player power', fatal: false };

  var g = newGame(12345);
  g.aiEnabled = false;

  var src = null, sid;
  for (sid in g.stations) {
    if (g.stations[sid].owner === me) { src = sid; break; }
  }
  if (!src) return { why: me + ' owns no station on a fresh board', fatal: false };

  var prevGame = window.GAME;
  window.GAME = g;

  // Every neighbour of the source, nearest first, and take the first that the
  // hit test agrees is itself.
  var nbrs = [];
  for (var i = 0; i < LINKS.length; i++) {
    if (LINKS[i].a === src) nbrs.push(LINKS[i].b);
    else if (LINKS[i].b === src) nbrs.push(LINKS[i].a);
  }
  nbrs.sort(function (a, b) { return STATIONS[a].pos[1] - STATIONS[b].pos[1]; });
  if (!nbrs.length) {
    window.GAME = prevGame;
    return { why: src + ' has no links in data/stations.js', fatal: false };
  }

  var dst = null;
  for (var j = 0; j < nbrs.length; j++) {
    g.stations[nbrs[j]].owner = me;
    if (_seltResolves(nbrs[j])) { dst = nbrs[j]; break; }
    g.stations[nbrs[j]].owner = 'neutral';
  }
  if (!dst) {
    window.GAME = prevGame;
    return {
      why: 'not one of ' + src + '\'s ' + nbrs.length + ' neighbours answers a press ' +
           'at its own centre — the hit test is broken, or something over the board ' +
           'is eating the press',
      fatal: true,
    };
  }

  // A foreign city to MISS with — and it has to be one the source can actually
  // reach. The first version of this fixture took the first non-player station
  // in `g.stations`, which is somewhere across the map: a volley at it is
  // rejected for want of a route, so "no wave was created" was true no matter
  // what the click did, and the two design-pinning tests below passed against a
  // mutation that broke them. That is known-issue #8 exactly — the assertion was
  // measuring reachability, not the gesture. A LINK-neighbour of the source is
  // the one target the volley provably routes to.
  var foe = null;
  for (var k = 0; k < nbrs.length; k++) {
    if (g.stations[nbrs[k]].owner === me) continue;
    if (_seltResolves(nbrs[k])) { foe = nbrs[k]; break; }
  }

  return { me: me, src: src, dst: dst, foe: foe, game: g, prevGame: prevGame };
}

// ONE TICK, which is exactly what a scheduled command needs and no more.
//
// queueCommand defaults to `state.tick` — the tick ABOUT TO RUN — so a command
// issued between ticks is drained by the very next stepTick, at phase 1, before
// growth. Two ticks would be a slower test that also lets a wave move; one is
// the contract.
//
// Loud if stepTicks is missing rather than quietly doing nothing: a no-op here
// makes every "the line was set" assertion below fail in a way that looks like a
// broken gesture.
function _seltStep(fx) {
  if (typeof stepTicks !== 'function') {
    throw new Error('stepTicks is not loaded — a scheduled command can never drain, ' +
      'so every gesture in this suite is unobservable');
  }
  stepTicks(fx.game, 1);
}

// Put every gesture back to a known start: scratch board clean of orders and
// waves, one source selected, order armed.
function _seltArm(fx) {
  clearSelection();
  // ANYTHING THE PREVIOUS TEST LEFT IN FLIGHT, DROPPED. This is new with A3 and
  // it cost a real failure to find: a test that fires a gesture and does NOT
  // step — 'and leaves the group selected' is one, because what it checks is
  // pure UI — leaves a live command in state.queued. The next test's tick then
  // drains two orders against the same group, and since `order` is a TOGGLE the
  // second one REMOVES the line the first just added. The symptom was
  // 'cmd+right-click while armed set no supply line', which reads exactly like a
  // broken gesture and is not one.
  fx.game.queued.length = 0;
  fx.game.stations[fx.src].supplyTo = [];
  fx.game.waves.length = 0;
  selSet([fx.src]);
  _selArmOrder();
}

// Through core/state.js, not spelled out. These suites run INSIDE the iframe's
// index.html, so () is the same function the renderer under test is
// using — which is the point: a helper that sums the bundle its own way can
// agree with a broken renderer and pass. The `|| 0` guards this used to carry
// would have made every assertion here read 0 against a rendered 0.
function _seltUnits(fx, sid) {
  return (fx.game.stations[sid].units);
}

function _seltBanner() {
  var el = document.getElementById('send-armed');
  return el ? { text: el.textContent, hidden: !!el.hidden } : null;
}

// ---------------------------------------------------------------------------

function suiteSelect(d) {
  var NAME = 'select / armed supply order';

  if (typeof SEL_STATE === 'undefined' || typeof selOnMouseUp !== 'function') {
    return skipSuite(NAME, 'render/select.js not loaded');
  }
  if (typeof document === 'undefined' || !document.getElementById('board')) {
    return skipSuite(NAME, 'no #board — this suite needs the live game page');
  }
  if (typeof newGame !== 'function' || typeof queueCommand !== 'function' ||
      typeof stepTicks !== 'function') {
    return skipSuite(NAME, 'core/state.js, sim/commands.js or sim/step.js not loaded');
  }
  if (typeof LINKS === 'undefined' || typeof STATIONS === 'undefined') {
    return skipSuite(NAME, 'data/stations.js not loaded');
  }
  if (!document.querySelector('[data-station]')) {
    return skipSuite(NAME, 'the board has not been rendered — no station nodes');
  }

  var fx = _seltFixture();
  if (fx.why && !fx.fatal) return skipSuite(NAME, fx.why);

  var prevFraction = (typeof sendFraction === 'function') ? sendFraction() : null;

  suite(NAME);

  // The board stopped accepting presses, so every gesture below would be
  // measuring nothing. One loud failure, and stop — see _seltFixture for why
  // this is not a skip.
  if (fx.why) {
    test('the board answers a press at a station centre', function () {
      assert(false, fx.why);
    });
    return;
  }

  // --- the reported bug ----------------------------------------------------
  //
  // These four are the ones that go red on the unfixed file. All four are one
  // gesture: arm, then right-click the destination.

  test('a right-click while armed sets the supply line', function () {
    _seltArm(fx);
    assertEqual(SEL_STATE.armed, 'supply', 'R did not arm — the fixture is wrong, not the code');
    _seltClick(fx.dst, 2);
    _seltStep(fx);
    var supply = fx.game.stations[fx.src].supplyTo || [];
    assert(supply.indexOf(fx.dst) >= 0,
      'right-clicking ' + fx.dst + ' while armed left ' + fx.src +
      ' supplying [' + supply.join(',') + ']');
  });

  // A3, and it is the reason every test in this file grew a _seltStep. The
  // gesture must produce a COMMAND, not a mutation — that is what makes the
  // board reproducible from a seed and a command log, which is what lockstep
  // multiplayer is.
  //
  // Both halves matter. "The queue got one" alone would pass for a file that
  // queued AND applied; "the board did not move" alone would pass for a file
  // that dropped the click on the floor.
  test('the gesture SCHEDULES the order — the board does not move until the tick', function () {
    _seltArm(fx);
    fx.game.stations[fx.src].supplyTo = [];
    var queuedBefore = fx.game.queued.length;
    _seltClick(fx.dst, 2);
    assertEqual(fx.game.queued.length, queuedBefore + 1,
      'the click put ' + (fx.game.queued.length - queuedBefore) + ' commands in the queue');
    assertEqual((fx.game.stations[fx.src].supplyTo || []).length, 0,
      'the supply line was written the instant the button went up — render/select.js ' +
      'is still mutating the board directly, and a second client would never see it');
    _seltStep(fx);
    assert((fx.game.stations[fx.src].supplyTo || []).indexOf(fx.dst) >= 0,
      'one tick later the order still has not been applied');
    assertEqual(fx.game.queued.length, queuedBefore,
      'the command is still in the queue after the tick that should have drained it');
  });

  // THE CONFIRMATION SURVIVED THE CONVERSION. The banner is the only thing this
  // gesture says out loud, and it used to be drawn from applyCommand's return
  // value — which a queued command does not have. It now arrives through
  // sim/commands.js's listener channel, one tick later, and this is the test
  // that the channel is actually wired up on the shipped page.
  test('the confirmation arrives when the command RUNS, not when it is issued', function () {
    _seltArm(fx);
    fx.game.stations[fx.src].supplyTo = [];
    _seltClick(fx.dst, 2);
    var b = _seltBanner();
    if (!b) return skipTest('the banner', '#send-armed is not in the document');
    assert(!/SUPPLYING/.test(b.text),
      'the banner confirmed an order that has not run yet: "' + b.text + '"');
    _seltStep(fx);
    var after = _seltBanner();
    assert(/SUPPLYING/.test(after.text),
      'the tick drained the order and nothing confirmed it — the listener is not ' +
      'wired, so every supply order now lands in silence: "' + after.text + '"');
    assertEqual(after.hidden, false, 'the confirmation was written to a hidden banner');
  });

  test('and marches nothing while doing it', function () {
    _seltArm(fx);
    var before = _seltUnits(fx, fx.src);
    _seltClick(fx.dst, 2);
    _seltStep(fx);
    assertEqual(fx.game.waves.length, 0,
      'a supply order created ' + fx.game.waves.length + ' wave(s)');
    // NOT assertClose to `before` any more: the tick that drains the order also
    // runs growth, so the garrison legitimately moves. What must not happen is
    // that it went DOWN — a volley takes a quarter of the city at the smallest
    // fraction the UI offers, and growth adds a fraction of a percent.
    assert(_seltUnits(fx, fx.src) >= before,
      'the source went from ' + before + ' to ' + _seltUnits(fx, fx.src) +
      ' units — it paid for a volley it never ordered');
  });

  // Not a nicety. The banner is the only confirmation this gesture has, and the
  // unfixed path took it away — selCommit -> clearSelection -> _selDisarm — so
  // the failure looked exactly like the success.
  test('and leaves the group selected, like the left button does', function () {
    _seltArm(fx);
    _seltClick(fx.dst, 2);
    assertEqual(selectedSources().join(','), fx.src,
      'the group was cleared, so the next R has nothing to arm');
  });

  // The strictly worse variant, and the one nothing on screen could have
  // caught. CMD means "the group survives this volley", so on the unfixed file
  // clearSelection() never ran, the arming was never incidentally cancelled,
  // and the banner went on promising SUPPLY while the march was already in the
  // air — known-issue #18, live.
  test('CMD+right-click sets the line and does not leave the banner lying', function () {
    _seltArm(fx);
    _seltClick(fx.dst, 2, { meta: true });
    _seltStep(fx);
    var supply = fx.game.stations[fx.src].supplyTo || [];
    assert(supply.indexOf(fx.dst) >= 0, 'cmd+right-click while armed set no supply line');
    assertEqual(fx.game.waves.length, 0, 'cmd+right-click marched an army instead');
    var b = _seltBanner();
    if (!b) return skipTest('the banner', '#send-armed is not in the document');
    assert(b.text !== SEL_ARMED_TEXT,
      'the banner still reads "' + b.text + '" after the click that consumed it');
    assertEqual(SEL_STATE.armed, null, 'still armed after the destination was named');
  });

  // --- the pan collision ---------------------------------------------------
  //
  // HONEST LABEL: this one passes with and without the fix, because the
  // unfixed right button committed nothing while armed either. It is a
  // regression guard on WHERE the fix was placed, not evidence that it works —
  // and it earns its place by failing against the obvious wrong placement
  // (hoisting _selCommitArmed above the `!rd.moved` gate), which was tried and
  // does turn it red.
  test('a right-DRAG is a camera pan: it commits nothing and stays armed', function () {
    _seltArm(fx);
    _seltRightDrag(fx.dst, 40);
    // Stepped BEFORE the assertions, not after: "nothing was set" is exactly the
    // shape that now passes for free on a click that merely has not drained yet.
    _seltStep(fx);
    assertEqual((fx.game.stations[fx.src].supplyTo || []).length, 0,
      'panning the board to find the destination set the line by itself');
    assertEqual(fx.game.waves.length, 0, 'a pan launched a wave');
    assertEqual(SEL_STATE.armed, 'supply',
      'panning to look for the destination cancelled the order');
  });

  // --- the design decision, pinned -----------------------------------------
  //
  // Both of these pass before and after the fix as well; each pins one half of
  // the `cancelOnMiss` argument in _selCommitArmed, and each was proved to fail
  // by flipping that argument at its call site.

  test('a right-press that is not on your own city does NOT cancel the arming', function () {
    if (!fx.foe) return skipTest('a foreign city', 'no reachable foreign station on this board');
    _seltArm(fx);
    _seltClick(fx.foe, 2);
    assertEqual(SEL_STATE.armed, 'supply',
      'a mis-aimed right press (the button that also pans) cancelled the order');
    _seltStep(fx);       // see the pan test: absence needs the tick to mean anything
    assertEqual(fx.game.waves.length, 0, 'and attacked ' + fx.foe + ' with it');
  });

  test('a LEFT-click that is not on your own city still cancels the arming', function () {
    if (!fx.foe) return skipTest('a foreign city', 'no reachable foreign station on this board');
    _seltArm(fx);
    _seltClick(fx.foe, 0);
    assertEqual(SEL_STATE.armed, null, 'the left button no longer backs out of an armed order');
    _seltStep(fx);
    assertEqual(fx.game.waves.length, 0,
      'the cancelling click ALSO fired the volley at ' + fx.foe +
      ' — the click was not consumed');
  });

  // The banner names no button, which is what makes "either button commits"
  // true without an edit. Under either of the two rejected designs (ignore the
  // right button / cancel on it) this string would have to grow one, so this is
  // the assertion that goes red if the design is ever quietly reversed.
  test('the armed banner promises a click, not a button', function () {
    _seltArm(fx);
    var b = _seltBanner();
    if (!b) return skipTest('the banner', '#send-armed is not in the document');
    assertEqual(b.hidden, false, 'armed, and the banner is hidden');
    assertEqual(b.text, SEL_ARMED_TEXT, 'the banner is not showing the armed text');
    assert(!/\bleft\b|\bright\b/i.test(b.text),
      'the banner names a mouse button: "' + b.text + '"');
  });

  // --- the canaries --------------------------------------------------------
  //
  // HONEST LABEL: both pass before and after the fix. Neither is evidence that
  // the fix works; they are here because a green armed-order suite must not be
  // able to sit on top of a board that no longer accepts clicks at all.

  // The overlay check, stated directly rather than only implied by _seltFire.
  // It is the two-line diagnostic from known-issue #15's family, applied to
  // pointer events instead of paint: ask the browser what is on top, and
  // compare it against what the renderer thinks is there.
  test('nothing is painted over the two cities these gestures aim at', function () {
    var bad = [];
    [fx.src, fx.dst].forEach(function (sid) {
      var pt = _seltAt(sid);
      var el = _seltTargetAt(pt[0], pt[1]);
      var g = el && el.closest ? el.closest('[data-station]') : null;
      var got = g && g.getAttribute('data-station');
      if (got !== sid) {
        bad.push(sid + '\'s centre belongs to ' +
          (got || (el ? '<' + el.tagName.toLowerCase() + ' class="' +
                          (el.getAttribute('class') || '') + '">' : 'nothing')));
      }
    });
    assertNone(bad, 'something over the board is eating clicks meant for a station');
  });
  test('an ordinary volley still commits and still costs the garrison', function () {
    clearSelection();
    fx.game.waves.length = 0;
    selSet([fx.src]);
    if (typeof setSendFraction === 'function') setSendFraction(0.5);
    var before = _seltUnits(fx, fx.src);
    // `res` is now the RECEIPT, not the outcome: ok means accepted into the
    // queue. The outcome is on the board a tick later, which is what the rest of
    // this test reads.
    var res = selCommit(fx.dst);
    assert(res && res.ok, 'selCommit was refused: ' + (res && res.reason));
    assertEqual(fx.game.waves.length, 0,
      'the volley left the city before the tick that was supposed to run it');
    _seltStep(fx);
    assertEqual(fx.game.waves.length, 1, 'no wave left the city');
    // Growth runs in the same tick, on the HALF that stayed home, so the
    // tolerance is not there to hide a rounding error — it is a real and small
    // number of units the city earned after paying.
    assertClose(_seltUnits(fx, fx.src), before * 0.5, before * 0.02,
      'a 50% send did not take half the garrison');
  });

  // --- teardown ------------------------------------------------------------
  //
  // A test, not an afterthought: a suite that leaves the player's board swapped
  // out is a worse bug than the one it was written for, and putting it in
  // test() means a throw in here is reported rather than lost.
  test('the player\'s own game is put back', function () {
    clearSelection();
    if (prevFraction !== null && typeof setSendFraction === 'function') {
      setSendFraction(prevFraction);
    }
    window.GAME = fx.prevGame;
    _selPaintArmed();
    assert(window.GAME === fx.prevGame, 'the scratch board is still installed');
    assertEqual(SEL_STATE.armed, null, 'left armed');
  });
}

// Run the suite on its own, from the live game page's console. The shared
// runner (test/runner.js) has no hook for it yet and cannot get one from here:
// this file owns only itself.
function selectTestsRun() {
  resetTests();
  suiteSelect(typeof collectData === 'function' ? collectData() : {});
  return { summary: summarizeTests(), results: TEST_RESULTS };
}

// ═══════════════════════════════════════════════════════════════════════
// SELECTION SAFETY — 05-command-clarity.md §1, roadmap A5
// ═══════════════════════════════════════════════════════════════════════
//
// The problem, in §1's words: "the same click on the same city either opens a
// readout or launches your army, and the only thing that decides which is state
// that may be entirely off-screen." At the 3x home zoom you can see 12% of the
// board, so the sources you selected two minutes ago are very likely not visible
// when you click the enemy city you meant to LOOK at.
//
// §1 rejected the obvious fix — two-click arm-then-commit for volleys — because
// 00-vision.md §8 is explicit that a volley is ONE click, and doubling the clicks
// on the game's primary verb to defend against an edge case is the wrong trade.
// What it accepted instead was to make the dangerous state impossible to miss.
// These test that, not the gesture.
//
// A SEPARATE SUITE from the armed-supply one above, because its fixture arms an
// order and these must observe the UNARMED state. Sharing a fixture would have
// meant every assertion here ran against a board that was already armed.
//
// Private helpers are `_sfy…`.

function _sfySelected() {
  return (typeof selectedSources === 'function') ? selectedSources() : [];
}

function _sfyRailLine() {
  var s = document.querySelector('[data-rail-section="selection"]');
  // offsetParent is null for a display:none ancestor, which is how _rdoShow
  // hides a row — so this distinguishes "section present but empty" from "the
  // player can actually read it", and only the second one counts.
  if (!s || s.offsetParent === null) return null;
  return s.innerText.replace(/\s+/g, ' ').trim();
}

function _sfyPump() {
  if (typeof renderReadout === 'function' && typeof GAME !== 'undefined') renderReadout(GAME);
}

function suiteSelectSafety(d) {
  var NAME = 'select / selection safety';

  if (typeof SEL_STATE === 'undefined' || typeof selSet !== 'function') {
    return skipSuite(NAME, 'render/select.js not loaded');
  }
  if (typeof document === 'undefined' || !document.getElementById('board')) {
    return skipSuite(NAME, 'no #board — this suite needs the live game page');
  }
  if (typeof renderReadout !== 'function') {
    return skipSuite(NAME, 'render/readout.js not loaded');
  }

  var me = selPlayer();
  if (!me) return skipSuite(NAME, 'no player power');

  var mine = [];
  for (var i = 0; i < STATION_IDS.length && mine.length < 2; i++) {
    if (GAME.stations[STATION_IDS[i]].owner === me) mine.push(STATION_IDS[i]);
  }
  if (!mine.length) return skipSuite(NAME, me + ' owns nothing on this board');

  suite(NAME);

  var prev = _sfySelected();

  test('with nothing selected the rail says nothing', function () {
    clearSelection();
    _sfyPump();
    assertEqual(_sfyRailLine(), null,
      'the selection line is on screen with an empty selection — it would be ' +
      'permanent chrome rather than a warning, and a warning that is always ' +
      'there is not read');
    assert(!document.querySelector('.app').classList.contains('is-loaded'),
      'the board reads as loaded with nothing selected');
  });

  test('selecting a city puts the count, the units and the verb in the rail', function () {
    // §1: "3 cities selected · 47 units · click a target to commit · Esc to
    // clear". The rail is always on screen; the carets are not. This is the fix
    // §1 says removes the surprise on its own.
    selSet([mine[0]]);
    _sfyPump();
    var line = _sfyRailLine();
    assert(line, 'nothing appeared in the rail after selecting a city');
    assert(/1 city/.test(line), 'the line does not say how many cities: ' + line);
    assert(/units/.test(line), 'the line does not say how many units: ' + line);
    assert(/commit/.test(line),
      'the line does not say what the next click DOES, which is the entire ' +
      'point of it: ' + line);
    assert(/Esc/.test(line),
      'the line does not name Escape — §1 calls this the discoverability fix, ' +
      'because it names Escape at the moment Escape is relevant: ' + line);
  });

  test('the count is the sim\'s unit total, not a second way of adding up', function () {
    // A rail that printed a different number from the one the volley sends is
    // known-issues #18, and summing a bundle by hand is #9.
    selSet([mine[0]]);
    _sfyPump();
    var line = _sfyRailLine();
    var shown = Number((line.match(/·\s*([0-9.]+)\s*units/) || [])[1]);
    var real = (GAME.stations[mine[0]].units);
    assert(isFinite(shown), 'no unit count could be read out of: ' + line);
    // The rail rounds for display; a whole unit of slack is the format, not drift.
    assert(Math.abs(shown - real) < 1,
      'the rail says ' + shown + ' units where the station holds ' + real);
  });

  test('the board itself reads as loaded, and it is not an overlay', function () {
    // §1's accepted fix (2): reuse the is-arming visual language on the board
    // edge so the state reads peripherally, not only in the rail.
    //
    // AND IT MUST NOT BE AN ELEMENT. Anything painted over the board that accepts
    // pointer events silently eats the click that commits an attack — five
    // occurrences (known-issues #5). The treatment is an inset box-shadow on
    // .board-wrap, so this asserts BOTH that the signal exists and that the thing
    // carrying it cannot be hit-tested.
    clearSelection();
    _sfyPump();
    var wrap = document.querySelector('.board-wrap');
    var off = getComputedStyle(wrap).boxShadow;

    selSet([mine[0]]);
    _sfyPump();
    var app = document.querySelector('.app');
    assert(app.classList.contains('is-loaded'), 'the board does not read as loaded');
    var on = getComputedStyle(wrap).boxShadow;
    assert(on !== off, 'the board edge looks identical loaded and unloaded');
    assert(/inset/.test(on),
      'the loaded treatment is not an inset shadow — if it became an overlay ' +
      'element it can swallow the click that commits an attack: ' + on);
  });

  test('the hint changes to match what the next key or click actually does', function () {
    // A line that said "click a target to commit" while a supply order was armed
    // would be describing a gesture that is not the one about to happen — the
    // same class of lie the whole section exists to remove.
    selSet([mine[0]]);
    _sfyPump();
    assert(/commit/.test(_sfyRailLine()), 'unarmed hint is wrong');

    _selArmOrder();
    _sfyPump();
    var armed = _sfyRailLine();
    assert(/route|city/.test(armed) && !/commit/.test(armed),
      'the hint still advertises the volley while a supply order is armed: ' + armed);

    _selDisarm();
    _sfyPump();
    assert(/commit/.test(_sfyRailLine()), 'the hint did not come back after disarming');
  });

  test('Escape backs out one step, then clears everything', function () {
    // §1's accepted fix (3). It was already true before A5 — asserted here
    // because nothing pinned it, and it is the "get me out of this" case.
    selSet([mine[0]]);
    _selArmOrder();
    assertEqual(SEL_STATE.armed, 'supply', 'the fixture did not arm');

    selOnKeyDown({ key: 'Escape', preventDefault: function () {} });
    assertEqual(SEL_STATE.armed, null, 'the first Escape did not disarm');
    assertEqual(_sfySelected().length, 1,
      'the first Escape also cleared the group — you almost certainly want to ' +
      'give the same group a different order rather than rebuild it');

    selOnKeyDown({ key: 'Escape', preventDefault: function () {} });
    assertEqual(_sfySelected().length, 0, 'the second Escape did not clear the selection');
    _sfyPump();
    assertEqual(_sfyRailLine(), null, 'the rail still shows a selection after clearing');
  });

  // Leave the page as it was found: this suite runs alongside others on the same
  // live board, and a selection left behind changes what they measure.
  clearSelection();
  if (prev.length) selSet(prev);
  _sfyPump();
}
