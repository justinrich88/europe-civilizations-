// test/queue-tests.js — tick-scheduled commands (07-roadmap.md A3).
//
// What is actually being defended here is not "the queue works". It is the four
// properties lockstep needs, each of which is a way two clients can end up on
// different boards while every individual function looks right:
//
//   1. A command executes on the tick it NAMES, not on the tick it was issued.
//   2. Two commands due on the same tick apply in ONE order, and that order
//      comes from state (`seq`), not from array position.
//   3. The drain happens at a FIXED point in the tick — phase 1, ahead of
//      growth — so what a command spends is what the player could see.
//   4. A snapshot carries the queue, so restore-and-replay reaches the same
//      board. This is the one a reconnect gets wrong, and it is invisible in a
//      single-client test unless the queue is deliberately non-empty at the
//      moment of the snapshot.
//
// (3) and (4) are the ones worth the file. (1) and (2) would be caught by almost
// any test; (3) fails as a one-tick accounting error nobody notices, and (4)
// fails only for the player who reconnected.
//
// Private helpers are `_qt…` — this file's prefix (known-issues #9, #12).

'use strict';

// A board where `pid` owns `count` linked stations, built off the real scenario
// rather than a hand-made map, so a queued send has somewhere legal to go.
// Deliberately AI-free: an opponent issuing its own commands inside a test of
// command scheduling would make every count here a guess.
function _qtBoard(pid, count) {
  var s = newGame(4242);
  s.aiEnabled = false;
  var mine = [];
  for (var i = 0; i < STATION_IDS.length; i++) {
    if (s.stations[STATION_IDS[i]].owner === pid) mine.push(STATION_IDS[i]);
  }

  // REPEATED PASSES, not one. STATION_IDS is sorted, so a single sweep only
  // finds neighbours that happen to sort after the capital — 'ber' is near the
  // front and grew fine, 'vie' is near the back and the whole group came back as
  // one station. Every send in this file was then aimed at an undefined target
  // and rejected 'unknown-target', which reads exactly like a broken queue.
  var grew = true;
  while (mine.length < count && grew) {
    grew = false;
    for (var j = 0; j < STATION_IDS.length && mine.length < count; j++) {
      var sid = STATION_IDS[j];
      if (mine.indexOf(sid) >= 0) continue;
      var touches = false;
      for (var k = 0; k < LINKS.length; k++) {
        var l = LINKS[k];
        if ((l.a === sid && mine.indexOf(l.b) >= 0) || (l.b === sid && mine.indexOf(l.a) >= 0)) {
          touches = true; break;
        }
      }
      if (!touches) continue;
      setStationOwner(s, sid, pid);
      mine.push(sid);
      grew = true;
    }
  }

  // A fixture that quietly returns fewer stations than asked for makes every
  // assertion below pass for the wrong reason — known-issues #8, and it is how
  // the bug above hid. Loud, here, once.
  if (mine.length < count) {
    throw new Error('_qtBoard could not give ' + pid + ' ' + count +
      ' linked stations — got ' + mine.length + ' [' + mine.join(',') + ']');
  }

  for (var m = 0; m < mine.length; m++) {
    s.stations[mine[m]].units = 40;
  }
  return { s: s, mine: mine, pid: pid };
}

function _qtWaveCount(s, pid) {
  var n = 0;
  for (var i = 0; i < s.waves.length; i++) if (s.waves[i].owner === pid) n++;
  return n;
}

function suiteQueue() {
  var NAME = 'sim / scheduled commands';

  if (typeof queueCommand !== 'function' || typeof commandsTick !== 'function') {
    return skipSuite(NAME, 'sim/commands.js has no queueCommand/commandsTick');
  }

  suite(NAME);

  // ── the phase is wired in at all ───────────────────────────────────────

  test('commandsTick is phase 1 of the tick, ahead of growth', function () {
    // The whole point of A3 is a FIXED drain point, so the position is the
    // contract and not an implementation detail. Asserted against SIM_PHASES
    // rather than against a comment.
    assertEqual(SIM_PHASES[0], 'commandsTick',
      'the drain is no longer the first phase — a queued command now runs after ' +
      'something else has already moved the board it was issued against');
    assertEqual(SIM_PHASES[1], 'growthTick',
      'growth is no longer immediately after the drain');
    assert(missingSimPhases().indexOf('commandsTick') < 0,
      'commandsTick is not resolvable as a phase function');
  });

  test('a fresh game starts with an empty queue and a live sequence counter', function () {
    var s = newGame(7);
    assertEqual(JSON.stringify(s.queued), '[]', 'state.queued is not an empty array');
    assertEqual(s.nextCmdSeq, 1, 'nextCmdSeq must start at 1');
    assertEqual(s.cmdStats.queued, 0, 'cmdStats.queued');
    assertEqual(s.cmdStats.applied, 0, 'cmdStats.applied');
    assertEqual(s.cmdStats.rejected, 0, 'cmdStats.rejected');
  });

  // ── 1. it executes on the tick it names ────────────────────────────────

  test('a queued send does NOTHING until its tick arrives', function () {
    var b = _qtBoard('ger', 3);
    var s = b.s;
    var before = _qtWaveCount(s, 'ger');
    var q = queueCommand(s, {
      type: 'send', owner: 'ger', sources: [b.mine[0]], target: b.mine[1], fraction: 0.5,
    }, s.tick + 5);
    assert(q.ok, 'the queue refused a legal send: ' + q.reason);
    assertEqual(q.tick, s.tick + 5, 'the command was not scheduled for the tick asked for');

    // FIVE ticks of nothing, then the sixth fires it. The count is `tick + 5`
    // minus the starting tick, because state.tick names the tick about to run: a
    // command due on tick 5 is drained by the stepTick during which state.tick
    // IS 5, and that is the sixth call from tick 0. Written out because getting
    // it wrong made this test fail against working code.
    for (var i = 0; i < 5; i++) {
      stepTick(s);
      assertEqual(_qtWaveCount(s, 'ger'), before,
        'a wave appeared on tick ' + s.tick + ', ' + (q.tick - s.tick) +
        ' ticks before the command was due');
      assertEqual(s.queued.length, 1, 'the command left the queue early');
    }
    stepTick(s);
    assert(_qtWaveCount(s, 'ger') > before, 'the command never fired on its own tick');
    assertEqual(s.queued.length, 0, 'the command stayed in the queue after firing');
    assertEqual(s.cmdStats.applied, 1, 'cmdStats.applied did not count the drain');
  });

  test('the default schedule is the next drain — one stepTick away for the player', function () {
    // state.tick is incremented at the END of stepTick, so it names the tick
    // ABOUT TO RUN. For a caller between ticks — which is every player click —
    // scheduling for state.tick means the drain at the head of the next
    // stepTick. Anything later would cost latency for nothing; see the note at
    // queueCommand for why the AI's case is different and is not guessed.
    var b = _qtBoard('fra', 3);
    var s = b.s;
    var at = s.tick;
    var q = queueCommand(s, { type: 'order', owner: 'fra', stations: [b.mine[0]], target: b.mine[1] });
    assertEqual(q.tick, at, 'the default is not the tick about to run');
    assertEqual((s.stations[b.mine[0]].supplyTo || []).length, 0,
      'queueing alone changed the board');
    stepTick(s);
    assert((s.stations[b.mine[0]].supplyTo || []).indexOf(b.mine[1]) >= 0,
      'the order did not apply on the very next tick');
  });

  test('a tick in the past is clamped forward, not dropped and not run early', function () {
    // Dropping loses a click to a race the player cannot see; running it
    // immediately puts execution back at an unpredictable point in the tick,
    // which is the thing A3 exists to remove.
    var b = _qtBoard('ita', 3);
    var s = b.s;
    stepTicks(s, 10);
    var q = queueCommand(s, { type: 'order', owner: 'ita', stations: [b.mine[0]], target: b.mine[1] },
      s.tick - 5);
    assert(q.ok, 'a past tick was rejected outright: ' + q.reason);
    assertEqual(q.tick, s.tick, 'a past tick was not clamped to the tick about to run');
    assertEqual(s.queued.length, 1, 'it was applied instead of scheduled');
    assertEqual((s.stations[b.mine[0]].supplyTo || []).length, 0,
      'clamping applied it on the spot — the whole point is that execution ' +
      'happens at the drain, never inside queueCommand');
  });

  // ── 2. same-tick order is total, and comes from state ──────────────────

  test('two commands due on the same tick apply in seq order, not array order', function () {
    // THE PAIR HAS TO BE ORDER-SENSITIVE, and the first version of this test was
    // not. It queued two `order` commands adding two different supply targets —
    // which COMMUTE: either sequence leaves the same two lines, so the test
    // passed with the seq tiebreak removed. Found by mutating the sort, not by
    // reading it (known-issues #8).
    //
    // Set-then-clear does not commute. `{ target: null }` empties the list, so
    // set-then-clear ends empty and clear-then-set ends with one line, and the
    // board says which order ran.
    var b = _qtBoard('rus', 4);
    var s = b.s;
    var src = b.mine[0], dst = b.mine[1];

    var q1 = queueCommand(s, { type: 'order', owner: 'rus', stations: [src], target: dst });
    var q2 = queueCommand(s, { type: 'order', owner: 'rus', stations: [src], target: null });
    assert(q1.seq < q2.seq, 'seq is not increasing: ' + q1.seq + ', ' + q2.seq);

    // Reverse the array. If the drain read array position the clear would run
    // first and the line would survive; `seq` must win and leave it empty.
    s.queued.reverse();
    stepTick(s);
    assertEqual((s.stations[src].supplyTo || []).length, 0,
      'the supply line survived, so the CLEAR ran before the SET — the drain is ' +
      'reading array position, and two clients handed the same commands in a ' +
      'different order would diverge');

    // And the reverse pair must reach the opposite board, or the assertion above
    // would also pass on a drain that simply always empties the list.
    var b2 = _qtBoard('rus', 4);
    queueCommand(b2.s, { type: 'order', owner: 'rus', stations: [b2.mine[0]], target: null });
    queueCommand(b2.s, { type: 'order', owner: 'rus', stations: [b2.mine[0]], target: b2.mine[1] });
    stepTick(b2.s);
    assertEqual((b2.s.stations[b2.mine[0]].supplyTo || []).join(','), b2.mine[1],
      'clear-then-set did not leave the line standing — the pair is not actually ' +
      'order-sensitive and this test is measuring nothing');
  });

  test('seq is never reused, even across a long game', function () {
    var b = _qtBoard('gbr', 3);
    var s = b.s;
    var seqs = {};
    for (var i = 0; i < 20; i++) {
      var q = queueCommand(s, { type: 'order', owner: 'gbr', stations: [b.mine[0]], target: b.mine[1] });
      assert(!seqs[q.seq], 'seq ' + q.seq + ' was handed out twice');
      seqs[q.seq] = true;
      stepTick(s);
    }
    assertEqual(s.cmdStats.queued, 20, 'cmdStats.queued did not count every issue');
  });

  // ── 3. the drain is ahead of growth ────────────────────────────────────

  test('a queued send spends PRE-growth units — the numbers the player saw', function () {
    // The load-bearing one. Drain after growthTick and this test still passes in
    // spirit but the arithmetic moves: the send would take its fraction of a
    // garrison that grew after the click. That is a permanent one-tick lie about
    // what a volley costs, and it is invisible unless measured exactly.
    var b = _qtBoard('aut', 3);
    var s = b.s;
    var src = b.mine[0];
    s.stations[src].units = 20;
    var seen = (s.stations[src].units);

    queueCommand(s, {
      type: 'send', owner: 'aut', sources: [src], target: b.mine[1], fraction: 0.5,
    });

    // What is in flight after the tick is the payload, and it must be half of
    // what was on screen — not half of what growth made it.
    var idsBefore = s.waves.map(function (w) { return w.id; });
    stepTick(s);
    var launched = s.waves.filter(function (w) { return idsBefore.indexOf(w.id) < 0; });
    assertEqual(launched.length, 1, 'expected exactly one new wave, got ' + launched.length);

    // The wave has already stepped once, but its payload does not change in
    // flight, so this is the launch amount.
    // MINUS ONE TICK OF MARCH ATTRITION. The wave is read after the stepTick that
    // created it, and since B1 every wave in transit pays BAL.PASSAGE
    // .MARCH_LOSS_PER_TICK per tick — including the one it launched on. Written
    // out rather than absorbed into a loose tolerance, because the quantity this
    // test exists to protect is 0.004-sized itself: the whole point is that a
    // volley is priced against pre-growth units, and growth on a 20-unit garrison
    // is the same order as one tick of attrition.
    var expect = seen * 0.5 - BAL.PASSAGE.MARCH_LOSS_PER_TICK;
    assertClose((launched[0].units), expect, 1e-9,
      'the volley carried ' + (launched[0].units) + ' from a garrison of ' +
      seen + ' at half (expected ' + expect + ' after one tick of march attrition) ' +
      '— so it was priced against a board the player never saw. Check that ' +
      'commandsTick is still ahead of growthTick.');
  });

  // ── 4. snapshot carries the queue ──────────────────────────────────────

  test('a snapshot taken with commands in flight replays identically', function () {
    // The reconnect case. A queue outside state, or a snapshot that dropped it,
    // makes this test the only place the loss is visible — every single-client
    // run is unaffected, which is exactly why it has to be written down.
    var b = _qtBoard('ott', 4);
    var s = b.s;
    stepTicks(s, 5);
    queueCommand(s, {
      type: 'send', owner: 'ott', sources: [b.mine[0]], target: b.mine[1], fraction: 0.25,
    }, s.tick + 3);
    queueCommand(s, { type: 'order', owner: 'ott', stations: [b.mine[2]], target: b.mine[1] }, s.tick + 6);
    assertEqual(s.queued.length, 2, 'the fixture did not queue two commands');

    var restored = snapshot(s);
    assertEqual(restored.queued.length, 2,
      'snapshot() dropped the queue — a reconnecting client would silently miss ' +
      'every command still in flight');
    assertEqual(restored.nextCmdSeq, s.nextCmdSeq, 'snapshot() dropped nextCmdSeq');

    stepTicks(s, 20);
    stepTicks(restored, 20);
    assertEqual(JSON.stringify(restored), JSON.stringify(s),
      'the restored game diverged from the original over 20 ticks with commands ' +
      'in flight at the moment of the snapshot');
  });

  // ── validation split: shape now, board later ───────────────────────────

  test('queue time checks SHAPE only, and says so by accepting a doomed command', function () {
    var b = _qtBoard('ger', 3);
    var s = b.s;
    // Well-formed, and certain to fail: a station this owner does not hold.
    var enemy = null;
    for (var i = 0; i < STATION_IDS.length; i++) {
      if (s.stations[STATION_IDS[i]].owner !== 'ger') { enemy = STATION_IDS[i]; break; }
    }
    var q = queueCommand(s, { type: 'send', owner: 'ger', sources: [enemy], target: b.mine[0] });
    assert(q.ok, 'a well-formed but doomed command was refused at queue time — the ' +
      'board at drain time is the only board that exists, so this decision cannot ' +
      'be made here');
    stepTick(s);
    assertEqual(s.cmdStats.rejected, 1, 'the drain did not count the rejection');
    assertEqual(s.cmdStats.applied, 0, 'the drain counted it as applied');
    assertEqual(s.queued.length, 0, 'a rejected command stayed in the queue');
  });

  test('malformed commands are refused at queue time, not stored', function () {
    var s = newGame(11);
    var cases = [
      [undefined, 'no-command'],
      [{ type: 'send' }, 'no-owner'],
      [{ type: 'nonsense', owner: 'ger' }, 'unknown-type'],
      [{ owner: 'ger' }, 'unknown-type'],
    ];
    for (var i = 0; i < cases.length; i++) {
      var q = queueCommand(s, cases[i][0]);
      assert(!q.ok, 'a malformed command was accepted: ' + JSON.stringify(cases[i][0]));
      assertEqual(q.reason, cases[i][1], 'wrong reason for ' + JSON.stringify(cases[i][0]));
    }
    assertEqual(s.queued.length, 0, 'a malformed command was stored anyway');
    assertEqual(s.cmdStats.queued, 0, 'a malformed command was counted as queued');
  });

  test('nothing queues once the game is over', function () {
    var b = _qtBoard('ger', 3);
    var s = b.s;
    s.winner = 'ger';
    var q = queueCommand(s, { type: 'order', owner: 'ger', stations: [b.mine[0]], target: b.mine[1] });
    assert(!q.ok && q.reason === 'game-over', 'a command queued into a finished game');
  });

  // ── the drain itself ───────────────────────────────────────────────────

  test('an overdue command still runs rather than being stranded', function () {
    // A state advanced past its own schedule — a restored snapshot, a harness
    // that skipped ticks. `tick <= state.tick` is what makes this work, and a
    // strict `===` would silently strand the command forever.
    var b = _qtBoard('fra', 3);
    var s = b.s;
    queueCommand(s, { type: 'order', owner: 'fra', stations: [b.mine[0]], target: b.mine[1] });
    s.tick += 50;                       // skipped past it
    stepTick(s);
    assertEqual(s.queued.length, 0, 'the overdue command was stranded in the queue');
    assert((s.stations[b.mine[0]].supplyTo || []).indexOf(b.mine[1]) >= 0,
      'the overdue command never applied');
  });

  test('the drain removes entries BEFORE applying them', function () {
    // Nothing re-queues from inside applyCommand today. The build verb makes it
    // plausible, and filtering after the loop would drain a child in the same
    // pass and resurrect its parent. Checked by watching the queue from inside
    // an application.
    var b = _qtBoard('ita', 3);
    var s = b.s;
    var real = applyCommand, sawQueued = null;
    globalThis.applyCommand = function (st, cmd) {
      if (sawQueued === null) sawQueued = st.queued.length;
      return real(st, cmd);
    };
    try {
      queueCommand(s, { type: 'order', owner: 'ita', stations: [b.mine[0]], target: b.mine[1] });
      stepTick(s);
    } finally {
      globalThis.applyCommand = real;
    }
    assertEqual(sawQueued, 0,
      'the command was still in state.queued while it was being applied — a ' +
      'command that queues another would have the child drained in the same pass');
  });

  test('the queue is untouched by a tick with nothing due', function () {
    var b = _qtBoard('gbr', 3);
    var s = b.s;
    queueCommand(s, { type: 'order', owner: 'gbr', stations: [b.mine[0]], target: b.mine[1] }, s.tick + 30);
    var before = JSON.stringify(s.queued);
    stepTicks(s, 10);
    assertEqual(JSON.stringify(s.queued), before, 'a tick with nothing due rewrote the queue');
  });

  // ── 5. the result gets back to whoever asked ───────────────────────────
  //
  // The half of A3 that finished the retrofit. Scheduling a command took the
  // result away from the caller — render/select.js drew its confirmation banner
  // out of that return value — so `onCommandResult` carries it forward to the
  // tick that actually ran it.
  //
  // The listener is the ONE piece of this design that could desync a lockstep
  // game, because it is the one thing a client with a UI has and a headless
  // client does not. Everything below is about that.

  test('a drained command reports back, with its result and its seq', function () {
    var b = _qtBoard('ger', 3);
    var s = b.s;
    var heard = [];
    var off = onCommandResult(function (cmd, res, note) {
      heard.push({ type: cmd.type, ok: !!(res && res.ok), seq: note.seq, tick: note.tick });
    });
    try {
      var q = queueCommand(s, {
        type: 'send', owner: 'ger', sources: [b.mine[0]], target: b.mine[1], fraction: 0.5,
      });
      assert(q.ok, 'the queue refused a legal send: ' + q.reason);
      assertEqual(heard.length, 0, 'the listener fired at QUEUE time — the whole ' +
        'point is that the result does not exist yet');
      stepTicks(s, 1);
    } finally { off(); }

    assertEqual(heard.length, 1, 'heard ' + heard.length + ' results for one command');
    assertEqual(heard[0].type, 'send', 'the command handed to the listener is not the one queued');
    assertEqual(heard[0].ok, true, 'a legal send came back as refused');
    assertEqual(heard[0].seq, 1, 'the seq does not match the one queueCommand returned — ' +
      'a caller cannot tell which of its clicks this answers');
  });

  test('a REJECTED command reports back too', function () {
    // The silence this replaces is the exact failure the banner exists for: an
    // order that was refused and one that worked looked identical on screen.
    var b = _qtBoard('ger', 3);
    var s = b.s;
    var heard = [];
    var off = onCommandResult(function (cmd, res) { heard.push(res); });
    try {
      // Legal shape, so it queues; illegal board, so it is refused on the tick.
      queueCommand(s, { type: 'send', owner: 'ger', sources: ['nowhere'], target: b.mine[1] });
      stepTicks(s, 1);
    } finally { off(); }
    assertEqual(heard.length, 1, 'a refused command told nobody');
    assertEqual(heard[0].ok, false, 'a send from a station that does not exist came back ok');
  });

  test('listeners fire AFTER the whole drain, never between two commands', function () {
    // If a listener could run between two commands due on the same tick, it
    // would observe a half-drained board — and a listener that redraws would
    // paint one that never existed. Measured by asking, from inside the
    // listener, how many waves are on the board: both sends have run.
    var b = _qtBoard('ger', 4);
    var s = b.s;
    var sawWaves = [];
    var off = onCommandResult(function () { sawWaves.push(_qtWaveCount(s, 'ger')); });
    try {
      queueCommand(s, {
        type: 'send', owner: 'ger', sources: [b.mine[0]], target: b.mine[2], fraction: 0.5,
      });
      queueCommand(s, {
        type: 'send', owner: 'ger', sources: [b.mine[1]], target: b.mine[2], fraction: 0.5,
      });
      stepTicks(s, 1);
    } finally { off(); }
    assertEqual(sawWaves.length, 2, 'two commands produced ' + sawWaves.length + ' notifications');
    assertEqual(sawWaves[0], 2,
      'the first notification saw ' + sawWaves[0] + ' wave(s) — it ran before the ' +
      'second command, so a renderer would have drawn a half-applied tick');
    assertEqual(sawWaves[1], 2, 'the second notification saw ' + sawWaves[1] + ' waves');
  });

  test('a listener that throws does not take the drain or the tick with it', function () {
    // A renderer that throws must not stop the sim on the one client that has a
    // renderer — that is a desync, and it is the reason the catch exists.
    var b = _qtBoard('ger', 3);
    var s = b.s;
    var second = 0;
    var offA = onCommandResult(function () { throw new Error('deliberate'); });
    var offB = onCommandResult(function () { second++; });
    var before = _qtWaveCount(s, 'ger');
    try {
      queueCommand(s, {
        type: 'send', owner: 'ger', sources: [b.mine[0]], target: b.mine[1], fraction: 0.5,
      });
      stepTicks(s, 2);
    } finally { offA(); offB(); }
    assertEqual(second, 1, 'the listener after the throwing one never heard anything');
    assertEqual(_qtWaveCount(s, 'ger'), before + 1, 'the send did not happen');
    assertEqual(s.tick, 2, 'the tick did not finish');
  });

  test('unsubscribing actually stops the notifications', function () {
    var b = _qtBoard('ger', 3);
    var s = b.s;
    var n = 0;
    var off = onCommandResult(function () { n++; });
    queueCommand(s, {
      type: 'send', owner: 'ger', sources: [b.mine[0]], target: b.mine[1], fraction: 0.4,
    });
    stepTicks(s, 1);
    off();
    queueCommand(s, {
      type: 'send', owner: 'ger', sources: [b.mine[0]], target: b.mine[1], fraction: 0.4,
    });
    stepTicks(s, 1);
    assertEqual(n, 1, 'the listener heard ' + n + ' results after unsubscribing once');
  });

  test('A LISTENER CANNOT CHANGE THE GAME — the whole basis of lockstep safety', function () {
    // The one property that matters. A client with a UI registers a listener; a
    // headless client, a balance sweep and a server do not. If the presence of a
    // listener perturbed anything, those two clients would play different games
    // and the desync would be invisible until the boards visibly disagreed.
    //
    // Two identical seeds, identical queued commands, 400 ticks apiece, and one
    // of them is being listened to by something that reads the board hard.
    function play(withListener) {
      var b = _qtBoard('ger', 4);
      var s = b.s;
      var off = withListener ? onCommandResult(function (cmd, res) {
        // Deliberately nosy: reads state, reads the result, allocates.
        JSON.stringify(res.accepted);
        _qtWaveCount(s, 'ger');
      }) : function () {};
      try {
        queueCommand(s, {
          type: 'send', owner: 'ger', sources: [b.mine[0]], target: b.mine[2], fraction: 0.5,
        }, s.tick + 3);
        queueCommand(s, {
          type: 'order', owner: 'ger', stations: [b.mine[1]], target: b.mine[0],
        }, s.tick + 7);
        stepTicks(s, 400);
      } finally { off(); }
      return JSON.stringify(snapshot(s));
    }
    var quiet = play(false);
    var loud = play(true);
    assertEqual(loud.length, quiet.length, 'the two boards are not even the same size');
    assert(loud === quiet,
      'a registered listener changed the board over 400 ticks — every headless ' +
      'run and every balance sweep is then a different game from the one played ' +
      'in a browser');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/queue-tests.js`
// ---------------------------------------------------------------------------
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  (function () {
    var fs = require('fs'), vm = require('vm'), path = require('path');
    var root = path.join(__dirname, '..');
    var SCRIPTS = [
      'core/rng.js', 'core/exact.js', 'core/util.js', 'core/state.js', 'core/vision.js',
      'data/tuning.js', 'data/map.js', 'data/stations.js', 'data/scenario.js',
      'sim/commands.js', 'sim/development.js', 'sim/growth.js', 'sim/movement.js', 'sim/combat.js',
      'sim/relations.js', 'sim/victory.js', 'sim/step.js',
      'ai/score.js', 'ai/ai.js',
      'test/asserts.js', 'test/runner.js',
    ];
    for (var i = 0; i < SCRIPTS.length; i++) {
      var f = path.join(root, SCRIPTS[i]);
      if (!fs.existsSync(f)) continue;
      try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: SCRIPTS[i] }); }
      catch (e) { console.error('LOAD ERROR in ' + SCRIPTS[i] + ': ' + e.message); process.exit(2); }
    }
    resetTests();
    suiteQueue();
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
