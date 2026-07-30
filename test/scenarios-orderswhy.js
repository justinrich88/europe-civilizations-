// test/scenarios-orderswhy.js — does the RAIL say the same thing about a supply
// line that the BOARD does?
//
// One suite, `render / orders why`, over render/readout.js's `_rdoOrdersLines`,
// `_rdoOrdersEdgeState`, `_rdoOrdersStuck` and `_rdoOrdersActionable`. Sibling
// of test/scenarios-routeview.js, which asks the same question about the line
// drawn on the map; this file asks it about the words in the 200px column.
//
// ── THE BUG THIS SUITE WAS WRITTEN FROM, OBSERVED LIVE ───────────────────
//
// Berlin, three supply lines, reproduced on the live board:
//
//   per edge   ank -> unreachable        genuinely dead, needs the player
//              ham -> destination-full   fine, self-recovering
//              lei -> destination-full   fine, self-recovering
//
//   the board  render/map.js drew those three edges in TWO visibly different
//              states — ank struck through, ham/lei dimmed but still moving.
//
//   the rail   supply    nothing leaves
//              1 city supplying, one sweep every 25 ticks
//              1 of them send nothing — no route over ground you hold
//
// One summary, and it was Ankara's reason wearing Hamburg's and Leipzig's names.
// That is known-issues #18 exactly: a readout answering a different question
// from the one on screen, and never looking wrong while it does it.
//
// The cause is one line of sim/movement.js, and it is not a bug there:
//
//   _ordSummarise:  return { units: 0, blocked: edges[0].blocked, ... }
//
// `blocked` is documented as "the reason the FIRST edge gives" and is offered
// for "a panel with room for one line". The rail had room for N and took the
// one. `edges` is the truth and it was on the table the whole time.
//
// ── WHAT EACH TEST HERE IS FOR, AND WHETHER IT CAN FAIL ──────────────────
//
// known-issues #8: a test that passes with and without the fix is worse than no
// test. Every assertion below was run red first, and the METHOD is named per
// test. Two kinds:
//
//   FAILS ON HEAD    the rule as it stood before this change is written out in
//                    this file as `_owyHeadLines` and asserted, on the same
//                    fixture, to give the WRONG answer. So each of these tests
//                    carries its own control: if the fixture is not in the
//                    failure regime, the control assertion goes red and the
//                    comparison cannot be vacuous. `_rdoOrdersActionable` and
//                    `_rdoOrdersEdgeState` are additionally asserted directly
//                    against values HEAD returned.
//   MUTATION         the cap tests and the vocabulary-drift test, whose subject
//                    did not exist at HEAD. The mutation is named in the body.
//
// ── HOW IT RUNS HEADLESS ─────────────────────────────────────────────────
//
// `node test/scenarios-orderswhy.js` from the project root. The bootstrap at the
// bottom is test/node.js's loader plus render/map.js (for MAP_ORDER_STUCK, the
// vocabulary this file asserts the rail borrows) and render/readout.js, with the
// same four-line DOM shim test/scenarios-routeview.js uses.
//
// NO ASSERTION HERE GOES NEAR THE DOM, and that is a property of the fix rather
// than of the test: `_rdoOrdersLines(next, max)` is a pure function of the
// planner's own answer, so the decision that was wrong is assertable without a
// rail. Only `_rdoOrdersRender` touches nodes, and it makes no decisions.
//
// TO WIRE IT INTO test/node.js: add 'render/map.js', 'render/readout.js' and
// 'test/scenarios-orderswhy.js' to its SCRIPTS list (readout.js AFTER map.js,
// and both need `global.window = global` plus a `document.addEventListener`
// stub at the top of that file), add `suiteOrdersWhy(d)` to runAllTests() in
// test/runner.js, and delete the bootstrap block below. Until then this file is
// inert under tests.html and under test/node.js and runs on its own.
//
// Private helpers are prefixed `_owy`, by FILE (known-issues #12) — `_rdo`
// belongs to render/readout.js and `_rvw` to test/scenarios-routeview.js.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Build a planner answer the way sim/movement.js builds one — by handing the
// edges to the sim's OWN `_ordSummarise` rather than by writing `units` and
// `blocked` here. If the summary rule ever changes, these fixtures change with
// it, which is the whole reason the rail is not allowed to keep its own copy of
// that rule either.
function _owyNext(edges) {
  if (typeof _ordSummarise === 'function') return _ordSummarise(edges);
  // Only reachable if sim/movement.js is absent, in which case the suite skips.
  var u = 0;
  for (var i = 0; i < edges.length; i++) u += edges[i].units;
  if (!edges.length) return { units: 0, edges: edges, blocked: 'no-order', target: null };
  if (u > 0) return { units: u, edges: edges, blocked: null, target: null };
  return { units: 0, edges: edges, blocked: edges[0].blocked, target: edges[0].target };
}

// `shortfall` is OPTIONAL and defaults to absent rather than to 0, because
// absent and 0 are two different sentences in _rdoOrdersWhy — 0 means "the
// source can pay, this line did not get the sweep" and absent means "nobody
// handed me a number". A default of 0 here would have made every legacy fixture
// silently assert the rotation wording.
function _owyEdge(target, units, blocked, shortfall) {
  var e = { target: target, units: units, fraction: 0, blocked: blocked || null };
  if (isFinite(shortfall)) e.shortfall = shortfall;
  return e;
}

// Two real station ids that are not the same station, taken off the live table
// rather than hard-coded: the map is generated and any id written here would
// rot (test/scenarios-routes.js makes the same choice for the same reason).
// STATIONS rather than STATION_IDS: the latter is filled in by a bootstrap the
// sim runs, and an empty array here reads exactly like "the map failed to load".
function _owySids(n) {
  var ids = (typeof STATIONS !== 'undefined' && STATIONS) ? Object.keys(STATIONS).sort() : [];
  return ids.slice(0, n);
}

// ── THE RULE AS IT STOOD AT HEAD, AS THE CONTROL ────────────────────────
//
// Transcribed from render/readout.js's `_rdoOrdersUpdate` before this change:
// ONE branch on the city total, then either a comma list of destination NAMES
// with no state on any of them, or the single summary reason. RDO_MAX_FARMS (2)
// is the name cap it used.
//
// It is here so that every FAILS-ON-HEAD test can assert, on its own fixture,
// that the old rule really did get it wrong — which is the only thing that makes
// the new assertion beside it mean anything.
function _owyHeadLines(next, to) {
  if (next.units > 0) {
    var names = [];
    for (var i = 0; i < to.length && i < RDO_MAX_FARMS; i++) names.push(_rdoStationName(to[i]));
    if (to.length > names.length) names.push('+' + (to.length - names.length) + ' more');
    return ['→ ' + names.join(', ') + ' · one sweep every ' + BAL.ORDERS.INTERVAL + ' ticks'];
  }
  return [_rdoOrdersWhyShort(next.blocked, next.target)];
}

function _owyTexts(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) out.push(lines[i].text);
  return out;
}

function _owyStates(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) out.push(lines[i].state);
  return out;
}

function _owyFind(lines, sid) {
  for (var i = 0; i < lines.length; i++) if (lines[i].sid === sid) return lines[i];
  return null;
}

// Every per-edge reason sim/movement.js can emit. `no-order` is deliberately
// absent — `_ordSummarise` produces it as a SOURCE summary when there are no
// edges at all and it can never appear on an edge. Same list, same reasoning, as
// test/scenarios-routeview.js.
var _OWY_EDGE_REASONS = ['target-lost', 'unreachable', 'at-keep-floor',
                         'destination-full', 'below-min-send'];

// ---------------------------------------------------------------------------

function suiteOrdersWhy(d) {
  suite('render / orders why');

  if (typeof _rdoOrdersLines !== 'function' || typeof _rdoOrdersEdgeState !== 'function') {
    skipTest('orders why', 'render/readout.js is not loaded in this harness — run ' +
      '`node test/scenarios-orderswhy.js`, or add render/readout.js (with a ' +
      'document/window shim) to test/node.js\'s SCRIPTS list');
    return;
  }
  if (typeof MAP_ORDER_STUCK === 'undefined') {
    skipTest('orders why', 'render/map.js is not loaded — MAP_ORDER_STUCK is the ' +
      'vocabulary this suite asserts the rail borrows, so without it every ' +
      'agreement test would be comparing the rail against itself');
    return;
  }
  if (typeof _ordSummarise !== 'function' || !d.BAL || !d.BAL.ORDERS) {
    skipTest('orders why', 'sim/movement.js is not loaded');
    return;
  }
  var ids = _owySids(3);
  if (ids.length < 3) { skipTest('orders why', 'the station table is not loaded'); return; }
  var A = ids[0], B = ids[1], C = ids[2];

  // ── the two defects ────────────────────────────────────────────────────

  // FAILS ON HEAD. The head rule is carried below as the CONTROL: on this exact
  // fixture it produces one line, that line is a list of NAMES, and nothing in
  // it says the second destination is dead. Verified red against the unfixed
  // render/readout.js by hand as well — the shipping branch never called
  // _rdoOrdersWhyShort at all.
  test('a shipping city does not hide a dead sibling line', function () {
    var next = _owyNext([_owyEdge(A, 12, null), _owyEdge(B, 0, 'unreachable')]);
    assert(next.units > 0, 'fixture is not in the regime this test is about — the ' +
      'city must be SHIPPING for the suppression to be possible');
    assertEqual(next.blocked, null, 'the sim summary already reports a reason, so ' +
      'the head rule would not have taken its shipping branch');

    var lines = _rdoOrdersLines(next, RDO_ORDERS_MAX_LINES);
    assertEqual(lines.length, 2, 'one clause per destination, got ' +
      JSON.stringify(_owyTexts(lines)));
    var dead = _owyFind(lines, B);
    assert(!!dead, B + ' has no line of its own at all');
    assertEqual(dead.state, 'stuck', B + ' is unreachable and the rail called it ' +
      dead.state + ' — a line that needs the player is reported as one that does not');
    assert(dead.text.indexOf(_rdoStationName(B)) >= 0,
      'the dead line does not name its destination: ' + dead.text);
    assert(dead.text.indexOf(_rdoOrdersWhy('unreachable', B).tag) >= 0,
      'the dead line does not say WHY: ' + dead.text);
    assertEqual(_owyFind(lines, A).state, 'flowing',
      'the healthy sibling was dragged down with it');

    // CONTROL: the head rule, same fixture. If this ever passes, the defect is
    // gone from HEAD and the test above is measuring nothing.
    var head = _owyHeadLines(next, [A, B]);
    assertEqual(head.length, 1, 'the head rule no longer collapses to one line — ' +
      'this control is stale and the assertions above are unanchored');
    assert(head[0].indexOf(_rdoOrdersWhy('unreachable', B).tag) < 0 &&
           head[0].indexOf('no route') < 0,
      'the head rule already reported the dead line: ' + head[0]);
  });

  // FAILS ON HEAD. The live Berlin fixture, edge for edge. The head control
  // prints ONE clause and it is edges[0]'s — chosen by the alphabet.
  test('edges that disagree get one clause each, not the first edge\'s reason', function () {
    // Sorted destination order, as _ordPlanPower emits: the unreachable one
    // first, so the head summary picks the scariest reason for all three.
    var next = _owyNext([
      _owyEdge(A, 0, 'unreachable'),
      _owyEdge(B, 0, 'destination-full'),
      _owyEdge(C, 0, 'destination-full'),
    ]);
    assertEqual(next.blocked, 'unreachable',
      'the fixture is not the one this test is about — edges[0] must be the ' +
      'unreachable one for the head summary to be wrong about the other two');

    var lines = _rdoOrdersLines(next, RDO_ORDERS_MAX_LINES);
    assertEqual(lines.length, 3, 'three destinations, ' + lines.length + ' clauses: ' +
      JSON.stringify(_owyTexts(lines)));
    assertEqual(_owyStates(lines).join(','), 'stuck,waiting,waiting',
      'the three lines were classified ' + JSON.stringify(_owyStates(lines)) +
      ' — render/map.js draws them stuck, waiting, waiting');

    var hard = _rdoOrdersWhy('unreachable', A).tag;
    var soft = _rdoOrdersWhy('destination-full', B).tag;
    assert(_owyFind(lines, A).text.indexOf(hard) >= 0,
      A + ' lost its own reason: ' + _owyFind(lines, A).text);
    for (var i = 0; i < 2; i++) {
      var sid = i === 0 ? B : C;
      var t = _owyFind(lines, sid).text;
      assert(t.indexOf(soft) >= 0, sid + ' is full and the rail says: ' + t);
      assert(t.indexOf(hard) < 0, sid + ' was told it has ' + hard +
        ' — that is ' + A + '\'s reason printed over a healthy route');
    }

    // CONTROL: the head rule on the same fixture, which is the text the player
    // actually saw.
    var head = _owyHeadLines(next, [A, B, C]);
    assertEqual(head.length, 1, 'the head control no longer collapses — it is stale');
    assert(head[0].indexOf('no route over ground you hold') >= 0,
      'the head rule did not print the first edge\'s reason for all three: ' + head[0]);
  });

  // ── the vocabulary is the board's ──────────────────────────────────────

  // FAILS ON HEAD, directly and without a control: `_rdoOrdersActionable` at
  // HEAD was `reason === 'destination-full' || 'unreachable' || 'target-lost'`,
  // so the first assertion below returned true and the test went red naming
  // destination-full. That is the disagreement the whole bug rests on — the most
  // common blocked reason on the board, which render/map.js classifies as
  // self-recovering, alarming the rail.
  test('the rail and the board agree, reason for reason, about what needs the player', function () {
    for (var i = 0; i < _OWY_EDGE_REASONS.length; i++) {
      var r = _OWY_EDGE_REASONS[i];
      var board = MAP_ORDER_STUCK[r] === true;
      // Compared as WORDS, not as booleans: assertEqual prints a mismatched
      // pair, and "expected [object Boolean], got [object Boolean]" is a
      // failure message that tells the next reader nothing at all.
      var want = board ? 'needs-the-player' : 'recovers-on-its-own';
      assertEqual(_rdoOrdersStuck(r) ? 'needs-the-player' : 'recovers-on-its-own', want,
        'the rail and render/map.js disagree about ' + r + ' — the column and the ' +
        'board are describing the same lines');
      assertEqual(_rdoOrdersActionable(r) ? 'needs-the-player' : 'recovers-on-its-own', want,
        '_rdoOrdersActionable disagrees with MAP_ORDER_STUCK about ' + r);
      assertEqual(_rdoOrdersEdgeState(_owyEdge(A, 0, r)), board ? 'stuck' : 'waiting',
        r + ' was classified wrongly by _rdoOrdersEdgeState');
    }
    // CONTROL: the two lists really do differ, so the loop is not passing
    // because every reason lands on the same side.
    assert(_rdoOrdersStuck('unreachable') && !_rdoOrdersStuck('destination-full'),
      'every reason is on the same side — this test cannot distinguish anything');
  });

  // MUTATION: `if (edge && edge.units > 0) return 'flowing'` moved BELOW the
  // stuck check, or the units test deleted. Verified red — "a shipping edge was
  // called stuck". Also covers the reverse mutation (dropping the stuck check),
  // which reds the row above.
  test('a shipping edge outranks its own blocked reason', function () {
    assertEqual(_rdoOrdersEdgeState(_owyEdge(A, 4, null)), 'flowing', 'a plain send');
    assertEqual(_rdoOrdersEdgeState(_owyEdge(A, 4, 'unreachable')), 'flowing',
      'an edge that is shipping was called stuck — render/map.js\'s _mapRouteState ' +
      'returns flowing for exactly this case and the two must not disagree');
  });

  // MUTATION: `return 'waiting'` -> `return 'stuck'` on the fall-through in
  // _rdoOrdersEdgeState. Verified red. Same rule render/map.js holds itself to:
  // the treatment that says "you must act" may only ever be painted from a
  // reason the renderer can name.
  test('an unclassified reason degrades to waiting, not to needs-you', function () {
    assertEqual(_rdoOrdersEdgeState(_owyEdge(A, 0, 'some-future-reason')), 'waiting',
      'a reason this file has never been taught was reported as needing the player');
    assertEqual(_rdoOrdersWhy('some-future-reason', A).long, 'nothing is getting through',
      'an unknown reason threw or produced a name it invented');
  });

  // MUTATION: add 'destination-full' to RDO_ORDERS_STUCK_FALLBACK. Verified red.
  // This is the test that makes the load-order guard safe: the fallback exists
  // so a rail with no render/map.js still classifies, and a fallback nobody
  // checks is a second phrasebook waiting to drift (known-issues #9).
  test('the load-order fallback table is exactly MAP_ORDER_STUCK', function () {
    var mine = Object.keys(RDO_ORDERS_STUCK_FALLBACK).sort().join(',');
    var theirs = Object.keys(MAP_ORDER_STUCK).sort().join(',');
    assertEqual(mine, theirs, 'render/readout.js\'s fallback stuck list has drifted ' +
      'from render/map.js\'s — the day render/map.js fails to load, the rail will ' +
      'quietly classify differently from the board it is describing');
    for (var i = 0; i < _OWY_EDGE_REASONS.length; i++) {
      var r = _OWY_EDGE_REASONS[i];
      assertEqual(RDO_ORDERS_STUCK_FALLBACK[r] === true, MAP_ORDER_STUCK[r] === true,
        'the fallback and the board disagree about ' + r);
    }
  });

  // ── saving up is not the same state as broken ──────────────────────────
  //
  // `below-min-send` is the most common dark state on a healthy board — a feed
  // city of capacity 13 ships on 6% of its sweeps and is dark on the other 94%
  // while losing nothing — and it covers two situations the player would act on
  // differently. One word covered both, so the rail printed the same sentence
  // over "this city is accumulating, leave it alone" and over "this line lost
  // its sweep". The number the sim hands over on the edge is what separates
  // them, and these assert that the number is USED rather than merely carried.

  // MUTATION: drop the `edge` argument at the _rdoOrdersWhy call site in
  // _rdoOrdersLines. Verified red — the line falls back to the empire wording
  // and the count disappears with it, which is exactly the regression that
  // reintroduces the original complaint.
  test('a source that is accumulating says how much more it needs', function () {
    var w = _rdoOrdersWhy('below-min-send', B, _owyEdge(B, 0, 'below-min-send', 0.6));
    assert(w.long.indexOf('0.6') >= 0, 'the shortfall the sim measured is not in the ' +
      'sentence: ' + w.long);
    assert(w.long.indexOf('minimum') < 0, 'still describing the arithmetic rather than ' +
      'the city: ' + w.long);

    // Through the real path, not just the phrasebook — this is the string the
    // rail actually paints.
    var lines = _rdoOrdersLines(_owyNext([_owyEdge(B, 0, 'below-min-send', 0.6)]),
      RDO_ORDERS_MAX_LINES);
    assertEqual(lines.length, 1, 'one edge, one line');
    assertEqual(lines[0].state, 'waiting', 'a city saving up was called ' +
      lines[0].state + ' — it needs nothing from the player');
    assert(lines[0].text.indexOf(w.tag) >= 0, 'the line does not carry the tag: ' +
      lines[0].text);
    assert(lines[0].title.indexOf('0.6') >= 0, 'the count is missing from the ' +
      'tooltip: ' + lines[0].title);
  });

  // MUTATION: collapse the two branches to one. Verified red. A source that CAN
  // pay is a different fact from a source that cannot, and printing "0 more
  // units and it ships" at a player would be worse than the sentence it replaced.
  test('a line that merely lost its sweep does not claim the source is short', function () {
    var w = _rdoOrdersWhy('below-min-send', B, _owyEdge(B, 0, 'below-min-send', 0));
    assert(w.long.indexOf('more units') < 0, 'a source that can pay was described as ' +
      'saving up: ' + w.long);
    assert(w.tag !== _rdoOrdersWhy('below-min-send', B, _owyEdge(B, 0, 'below-min-send', 4)).tag,
      'the two shortfall states print the same tag, so the distinction the number ' +
      'exists to draw is invisible on the 200px line');
  });

  // The empire header summarises MANY sources and so has no honest number. It
  // must degrade to a sentence, never to "undefined more units".
  test('the empire summary says no number it does not have', function () {
    var s = _rdoOrdersWhyShort('below-min-send', null);
    assert(s.indexOf('undefined') < 0 && s.indexOf('NaN') < 0, 'edge-less summary: ' + s);
    assert(s.indexOf('more units') < 0, 'the summary invented a per-source count: ' + s);
    assert(s.length > 0, 'the summary produced nothing at all');
  });

  // at-keep-floor carries a true shortfall too, and the keep floor is the one
  // blocked reason whose old wording explained the RULE well. It only gives that
  // up when a real number arrived.
  test('the keep floor keeps its explanation when no number came with it', function () {
    var bare = _rdoOrdersWhy('at-keep-floor', B, _owyEdge(B, 0, 'at-keep-floor'));
    assert(bare.long.indexOf('defenceless') >= 0, 'the rule stopped being explained ' +
      'even with no number to replace it: ' + bare.long);
    var counted = _rdoOrdersWhy('at-keep-floor', B, _owyEdge(B, 0, 'at-keep-floor', 3.2));
    assert(counted.long.indexOf('3.2') >= 0, 'the shortfall was carried and ignored: ' +
      counted.long);
  });

  // ── the cap ────────────────────────────────────────────────────────────

  // MUTATION: delete the priority sort in _rdoOrdersLines and keep the first
  // `max - 1` in sim order. Verified red — "the line that needs the player is
  // the one that was cut". The stuck edge is deliberately LAST in sorted order
  // so the naive slice drops exactly it.
  test('the cap never cuts the line that needs the player', function () {
    var many = [], i;
    var pool = _owySids(9);
    if (pool.length < 9) { assert(true, 'board too small to overflow the cap'); return; }
    for (i = 0; i < pool.length - 1; i++) many.push(_owyEdge(pool[i], 3, null));
    many.push(_owyEdge(pool[pool.length - 1], 0, 'target-lost'));
    var next = _owyNext(many);

    var lines = _rdoOrdersLines(next, RDO_ORDERS_MAX_LINES);
    assertEqual(lines.length, RDO_ORDERS_MAX_LINES, 'the cap did not bind at ' +
      many.length + ' destinations: ' + JSON.stringify(_owyTexts(lines)));
    var dead = _owyFind(lines, pool[pool.length - 1]);
    assert(!!dead && dead.state === 'stuck',
      'the line that needs the player is the one that was cut — the rail is now ' +
      'hiding exactly the fact it exists to report');
    var last = lines[lines.length - 1];
    assertEqual(last.state, 'more', 'the cut was not declared on screen');
    assertEqual(last.text, '+' + (many.length - (RDO_ORDERS_MAX_LINES - 1)) + ' more',
      'the "+N more" count does not match what was actually cut: ' + last.text);
    // Everything not on screen must be named in the title. The kept set is the
    // stuck edge plus the first two in sim order, so pool[2..] is what was cut.
    for (i = 2; i < pool.length - 1; i++) {
      assert(last.title.indexOf(_rdoStationName(pool[i])) >= 0,
        'the "+N more" line does not name ' + pool[i] + ', which it is hiding: ' +
        last.title);
      assert(!_owyFind(lines, pool[i]), pool[i] + ' is both hidden and on screen');
    }
  });

  // MUTATION: `if (out.length <= max) return out` -> `if (out.length < max)`.
  // Verified red — "a list that fits was re-sorted". Sim order is load-bearing
  // in the common case: a list that re-sorts itself every sweep, as edges flip
  // between waiting and flowing, is a list nobody can read.
  test('a list that fits keeps sim order and is never re-sorted', function () {
    // A stuck edge LAST, and only three destinations, so a priority sort would
    // visibly move it to the front.
    var next = _owyNext([
      _owyEdge(A, 5, null), _owyEdge(B, 0, 'below-min-send'), _owyEdge(C, 0, 'unreachable'),
    ]);
    var lines = _rdoOrdersLines(next, RDO_ORDERS_MAX_LINES);
    assertEqual(lines.length, 3, 'the cap bound on three destinations');
    assertEqual(lines[0].sid + ',' + lines[1].sid + ',' + lines[2].sid, A + ',' + B + ',' + C,
      'the rail re-ordered a list that fits — destination order is the sim\'s and ' +
      'should survive to the column');
  });

  // MUTATION: return `out` unchanged when `edges` is empty. Verified red — the
  // section then prints nothing at all for a city whose supply list is set but
  // whose planner has no edges for it, which is the invisible-ticker failure
  // (known-issues #22) in a smaller font.
  test('a city with no edges still gets its one clause', function () {
    var next = _owyNext([]);
    assertEqual(next.blocked, 'no-order', 'the sim summary for no edges has changed');
    var lines = _rdoOrdersLines(next, RDO_ORDERS_MAX_LINES);
    assertEqual(lines.length, 1, 'no clause for a city with no edges');
    assertEqual(lines[0].title, 'no supply line set', 'the clause lost its words');
  });

  // MUTATION: sort `out` in place instead of sorting the `ranked` copy.
  // Verified red — "the planner's edge order was rewritten". render/ reads
  // (01-data-schema.md), and `edges` is handed straight out of the planner: the
  // map draws from the same array on the same frame.
  test('reading the lines does not disturb the planner\'s answer', function () {
    var pool = _owySids(9);
    if (pool.length < 9) { assert(true, 'board too small'); return; }
    var many = [], i;
    for (i = 0; i < pool.length - 1; i++) many.push(_owyEdge(pool[i], 3, null));
    many.push(_owyEdge(pool[pool.length - 1], 0, 'target-lost'));
    var next = _owyNext(many);
    var before = JSON.stringify(next);
    _rdoOrdersLines(next, RDO_ORDERS_MAX_LINES);
    _rdoOrdersLines(next, RDO_ORDERS_MAX_LINES);
    assertEqual(JSON.stringify(next), before,
      'the planner\'s edge list was mutated by being read — render/map.js draws ' +
      'from this same array on this same frame');
  });

  // ── against the live board ─────────────────────────────────────────────

  // FAILS ON HEAD, and it is the measurement the whole fix rests on: on a real
  // board, do a city's edges actually DISAGREE often enough for a single summary
  // to be wrong most of the time? The head rule is run alongside as the CONTROL
  // and its misdescriptions are counted.
  //
  // Verified red against the unfixed rule by pointing `mine` at
  // `_owyHeadLines`: "the head rule misdescribed 0 edges" inverts and the
  // per-edge assertion fails on the first disagreeing sweep.
  test('on a live board a single summary misdescribes edges, and the fix does not', function () {
    var ctx = (typeof _needSim === 'function')
      ? _needSim('render / orders why', ['newGame', 'step', 'apply']) : null;
    if (!ctx) { assert(true, 'sim harness not available'); return; }
    if (typeof _rteBoard !== 'function' || typeof _rteLink !== 'function') {
      assert(true, 'test/scenarios-routes.js fixtures not loaded — skipping the ' +
        'live arm; the pure-rule arms above still carry the suite');
      return;
    }
    var fns = ctx.fns;
    var disagreed = 0, headWrong = 0, sweeps = 0;

    for (var seed = 1; seed <= 6; seed++) {
      var b = _rteBoard(fns, d, seed, 'ger', 14);
      // One source, three destinations: the shape the bug was reported on.
      var src = b.own[0], dests = [b.own[1], b.own[2], b.own[3]];
      if (!src || !dests[2]) continue;
      _rteLink(b.s, 'ger', [src], dests[0]);
      _rteLink(b.s, 'ger', [src], dests[1]);
      _rteLink(b.s, 'ger', [src], dests[2]);
      // Hand the third destination to somebody else: a lost target is a reason
      // that never clears on its own, so this board carries at least one edge
      // that genuinely needs the player alongside two that do not.
      b.s.stations[dests[2]].owner = 'fra';
      b.s.ownerEpoch = (b.s.ownerEpoch || 0) + 1;

      for (var t = 0; t < 600; t++) {
        fns.step(b.s);
        if (b.s.tick % d.BAL.ORDERS.INTERVAL !== 0) continue;
        var next = standingOrderNext(b.s, src);
        if (!next.edges || next.edges.length < 2) continue;
        sweeps++;

        // Do the edges disagree about their state?
        var states = {};
        for (var i = 0; i < next.edges.length; i++) states[_rdoOrdersEdgeState(next.edges[i])] = 1;
        if (Object.keys(states).length < 2) continue;
        disagreed++;

        // THE FIX: every edge keeps its own reason, and every one is named.
        var lines = _rdoOrdersLines(next, 99);
        assertEqual(lines.length, next.edges.length,
          'the rail printed ' + lines.length + ' clauses for ' + next.edges.length +
          ' destinations that do not agree with each other');
        for (i = 0; i < next.edges.length; i++) {
          var e = next.edges[i], rec = _owyFind(lines, e.target);
          assert(!!rec, e.target + ' has no clause of its own');
          assertEqual(rec.state, _rdoOrdersEdgeState(e), e.target + ' was reclassified');
          var want = (e.units > 0) ? _rdoNum(e.units) : _rdoOrdersWhy(e.blocked, e.target).tag;
          assert(rec.text.indexOf(want) >= 0,
            e.target + ' is "' + (e.blocked || 'shipping') + '" and its clause reads "' +
            rec.text + '"');
        }

        // THE CONTROL: the head rule, same sweep. Count the edges it got wrong.
        var head = _owyHeadLines(next, b.s.stations[src].supplyTo || []).join(' | ');
        for (i = 0; i < next.edges.length; i++) {
          var ee = next.edges[i];
          var tag = (ee.units > 0) ? null : _rdoOrdersWhy(ee.blocked, ee.target).tag;
          if (tag === null) continue;                       // shipping: nothing to misstate
          if (head.indexOf(_rdoOrdersWhy(ee.blocked, ee.target).long) < 0) headWrong++;
        }
      }
    }

    assert(sweeps > 0, 'no multi-destination sweep was ever observed — the live arm ' +
      'is vacuous and proves nothing');
    assert(disagreed > 0, 'over ' + sweeps + ' multi-destination sweeps the edges ' +
      'never once disagreed — a single summary would have been fine and this ' +
      'whole suite is measuring a case that does not occur');
    assert(headWrong > 0, 'the head rule misdescribed 0 edges over ' + disagreed +
      ' disagreeing sweeps — the control is not reproducing the reported bug, so ' +
      'the assertions above are unanchored');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/scenarios-orderswhy.js`
// ---------------------------------------------------------------------------
//
// Inert under tests.html (no `require`) and under test/node.js (every file there
// is evaluated with vm.runInThisContext, where `require` and `module` are both
// out of scope). Only a direct `node test/scenarios-orderswhy.js` gets here.
//
// The SCRIPTS list is test/node.js's, plus render/map.js and render/readout.js
// (the two subjects), plus test/scenarios-routes.js for the live board fixtures.
//
// THE SHIM IS THE SAME FOUR LINES test/scenarios-routeview.js uses and it is not
// a mock. render/map.js needs `window` to hang its exports on and
// `document.addEventListener` for its self-bootstrap; render/readout.js needs
// only `window`, because every DOM call it makes is inside a build() or an
// update() and nothing here calls either. `window = global` is what a classic
// script sees in a browser anyway.
//
// ORDER MATTERS AND IS THE POINT: render/readout.js loads BEFORE render/map.js
// in index.html (railAddSection has to exist first — known-issues #22), so it is
// loaded in that order here too. `_rdoOrdersStuck` reads MAP_ORDER_STUCK at CALL
// time rather than at load time for exactly this reason, and this bootstrap is
// where that would break if it ever stopped being true.
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  (function () {
    var fs = require('fs'), vm = require('vm'), path = require('path');
    var root = path.join(__dirname, '..');
    if (typeof global.window === 'undefined') global.window = global;
    if (typeof global.document === 'undefined') {
      global.document = { addEventListener: function () {} };
    }
    var SCRIPTS = [
      'core/rng.js', 'core/exact.js', 'core/util.js', 'core/state.js', 'core/vision.js',
      'data/tuning.js', 'data/map.js', 'data/stations.js', 'data/scenario.js',
      'sim/commands.js', 'sim/development.js', 'sim/growth.js', 'sim/movement.js', 'sim/combat.js',
      'sim/relations.js', 'sim/victory.js', 'sim/step.js',
      'ai/score.js', 'ai/ai.js',
      'render/readout.js', 'render/map.js',
      'test/asserts.js', 'test/scenarios-routes.js', 'test/runner.js',
    ];
    for (var i = 0; i < SCRIPTS.length; i++) {
      var f = path.join(root, SCRIPTS[i]);
      if (!fs.existsSync(f)) continue;
      try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: SCRIPTS[i] }); }
      catch (e) { console.error('LOAD ERROR in ' + SCRIPTS[i] + ': ' + e.message); process.exit(2); }
    }
    resetTests();
    suiteOrdersWhy(collectData());
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
