// test/scenarios-standings.js — the standings panel tells the truth, in order.
//
// One suite, `standings / rail panel`, over render/standings.js.
//
// ── WHY THIS SUITE EXISTS, AND WHAT IT IS ACTUALLY GUARDING ──────────────
//
// The panel makes two claims a player will act on without checking:
//
//   1. **This is the order.** A scoreboard is read as a ranking, so a broken
//      comparator does not look like a bug — it looks like a different game.
//   2. **These are the numbers.** The panel is deliberately NOT fog-filtered
//      (the argument is in the header of render/standings.js), which means the
//      one thing that can silently undo it is somebody "fixing" it later by
//      routing the counts through believedStation(). That would be a quiet
//      change: every row would still be populated, plausible and stable, and
//      Russia would read 5 while holding 23.
//
// So the load-bearing assertion here is the third one — `counts are TRUE, not
// fog-filtered`. It does not merely check a number; it computes what a
// fog-filtered panel WOULD have shown, from core/vision.js, and asserts the
// panel disagrees with it. An assertion that only checked "rus reports 3" would
// pass on a board with no fog to apply and prove nothing (known-issues #8).
//
// ── HOW IT RUNS HEADLESS ─────────────────────────────────────────────────
//
// `node test/scenarios-standings.js` from the project root. This file carries
// its own bootstrap because test/node.js has a fixed SCRIPTS list that loads
// exactly one render/ file, and it is not this agent's to edit. The bootstrap
// is the same vm.runInThisContext loader test/node.js and tools/balance.js use,
// with render/standings.js added, and it prints through the project's own
// formatResults() — same harness, same output, one extra script.
//
// It also runs in tests.html, where `window` and a real DOM already exist; the
// bootstrap is inert there (no `require`), and the DOM shim below installs
// itself only when there is no `document`. The suite hook for test/runner.js is
// `suiteStandings(d)`, matching suiteFog / suiteHelp.
//
// Private helpers are prefixed `_stdt`, by FILE (known-issues #12) — `_std`
// belongs to render/standings.js and a shared prefix between two files that
// share a domain is how #12 happened in the first place.

// ---------------------------------------------------------------------------
// A DOM small enough to build seven rows in
// ---------------------------------------------------------------------------
//
// Not a general DOM. It implements exactly what core/util.js's el() and
// render/standings.js touch: attributes, textContent, a style bag, classList
// and appendChild with MOVE semantics — that last one is not a detail, it is
// the mechanism the reorder test measures, and a shim whose appendChild
// duplicated instead of moved would report seven rows as fourteen.

function _stdtNode(tag) {
  var node = {
    tagName: String(tag).toUpperCase(),
    attrs: Object.create(null),
    style: {},
    children: [],
    parentNode: null,
    textContent: '',
  };
  node.setAttribute = function (k, v) { node.attrs[k] = String(v); };
  node.getAttribute = function (k) { return (k in node.attrs) ? node.attrs[k] : null; };
  node.appendChild = function (c) {
    if (c.parentNode) {
      var ix = c.parentNode.children.indexOf(c);
      if (ix >= 0) c.parentNode.children.splice(ix, 1);
    }
    c.parentNode = node;
    node.children.push(c);
    return c;
  };
  node.removeChild = function (c) {
    var ix = node.children.indexOf(c);
    if (ix >= 0) { node.children.splice(ix, 1); c.parentNode = null; }
    return c;
  };
  var classes = function () {
    return String(node.attrs['class'] || '').split(/\s+/).filter(function (s) { return !!s; });
  };
  node.classList = {
    contains: function (c) { return classes().indexOf(c) >= 0; },
    toggle: function (c, on) {
      var l = classes();
      var at = l.indexOf(c);
      var want = (on === undefined) ? at < 0 : !!on;
      if (want && at < 0) l.push(c);
      if (!want && at >= 0) l.splice(at, 1);
      node.attrs['class'] = l.join(' ');
      return want;
    },
  };
  return node;
}

// Install the shim only where there is nothing real. In tests.html this is a
// no-op and the suite exercises the actual browser DOM, which is the point of
// running it in both places.
function _stdtEnsureDom() {
  if (typeof document !== 'undefined' && document && document.createElement) return true;
  if (typeof globalThis === 'undefined') return false;
  globalThis.document = {
    createElement: function (t) { return _stdtNode(t); },
    createElementNS: function (ns, t) { return _stdtNode(t); },
  };
  return true;
}

// A host to build into — a stand-in for the `.rail-body` railAddSection hands
// build(). Never attached to anything, so nothing is ever painted.
function _stdtHost() {
  _stdtEnsureDom();
  return document.createElement('div');
}

// Children as an array, over either the shim or a real element.
function _stdtKids(host) {
  if (host.children && Array.isArray(host.children)) return host.children;
  return Array.prototype.slice.call(host.children || []);
}

function _stdtAttr(node, name) {
  return node.getAttribute ? node.getAttribute(name) : null;
}

function _stdtHasClass(node, cls) {
  if (node.classList && node.classList.contains) return node.classList.contains(cls);
  return String(_stdtAttr(node, 'class') || '').split(/\s+/).indexOf(cls) >= 0;
}

// ---------------------------------------------------------------------------
// window.PLAYER, in a context that may not have a window
// ---------------------------------------------------------------------------
//
// render/standings.js reads `window.PLAYER`, as every other render/ file does.
// The headless harness has no window, so one is borrowed for the duration of a
// test and handed back — installed AFTER every file has loaded, so nothing is
// evaluated in a context it did not expect (known-issues #3 cuts both ways: a
// window that appears mid-run changes what `window.FOO` resolves to).
function _stdtWithPlayer(pid, fn) {
  var madeWindow = false;
  if (typeof window === 'undefined') {
    globalThis.window = globalThis;
    madeWindow = true;
  }
  var had = Object.prototype.hasOwnProperty.call(window, 'PLAYER');
  var prev = window.PLAYER;
  window.PLAYER = pid;
  try {
    return fn();
  } finally {
    if (had) window.PLAYER = prev;
    else { try { delete window.PLAYER; } catch (e) { window.PLAYER = undefined; } }
    if (madeWindow) { try { delete globalThis.window; } catch (e) { /* leave it */ } }
  }
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------
//
// Nothing below hard-codes a station or territory id. data/stations.js and
// data/map.js are GENERATED (tools/build-map.js, tools/build-stations.js), so a
// fixture pinned to "mos" or "russia" is a fixture that dies the next time the
// map is rebuilt — the same rule test/fog-tests.js works under.

function _stdtPowers() {
  return Object.keys(POWERS).sort().filter(function (p) { return p !== 'neutral'; });
}

// Every station to neutral. Through setStationOwner in both directions, never a
// raw `station.owner =`, so state.ownerEpoch tracks — 01-data-schema.md says
// that includes test fixtures, and this suite's memo assertions depend on it.
function _stdtBlank(seed) {
  var s = newGame(seed);
  for (var i = 0; i < STATION_IDS.length; i++) {
    setStationOwner(s, STATION_IDS[i], 'neutral');
  }
  return s;
}

function _stdtTakeTerritory(s, tid, pid) {
  var ids = stationsIn(tid);
  for (var i = 0; i < ids.length; i++) setStationOwner(s, ids[i], pid);
  return ids.length;
}

// Territories with at least two stations, in TERRITORY_IDS order. Two is the
// floor at which "majority" and "one foothold" are different boards.
function _stdtPool(min) {
  var out = [];
  for (var i = 0; i < TERRITORY_IDS.length; i++) {
    if (stationsIn(TERRITORY_IDS[i]).length >= (min || 2)) out.push(TERRITORY_IDS[i]);
  }
  return out;
}

// The main fixture: a board with a strict, known territory ranking.
//
// Counts are handed out so that no two powers tie on territories, which is what
// makes the expected order a single exact string rather than a set of
// acceptable ones. Ties get their own tests below.
function _stdtRankedBoard() {
  var s = _stdtBlank(11);
  var pool = _stdtPool(2);
  var plan = [
    ['rus', 4], ['ger', 3], ['gbr', 2], ['fra', 1], ['aut', 0], ['ita', 0], ['ott', 0],
  ];
  var at = 0;
  for (var i = 0; i < plan.length; i++) {
    for (var k = 0; k < plan[i][1]; k++) _stdtTakeTerritory(s, pool[at++], plan[i][0]);
  }
  return s;
}

// What a FOG-FILTERED panel would have printed for `pid`, computed here from
// core/vision.js. This is the number render/standings.js deliberately does not
// show, and the contrast is the whole assertion — see the file header.
//
// Deliberately the same construction render/hud.js's power strip uses for the
// believed board: believedStation() for every station, then the canonical
// territoryControl() over the proxy. Reproducing it rather than calling it
// means the test is comparing the panel against the ALTERNATIVE DESIGN, not
// against itself.
function _stdtBelievedTerritories(state, viewer, pid) {
  var vis = visibleTo(state, viewer);
  var proxy = { stations: Object.create(null) };
  for (var i = 0; i < STATION_IDS.length; i++) {
    var sid = STATION_IDS[i];
    proxy.stations[sid] = { owner: believedStation(state, viewer, sid, vis).owner };
  }
  var n = 0;
  for (var t = 0; t < TERRITORY_IDS.length; t++) {
    if (territoryControl(proxy, TERRITORY_IDS[t]).owner === pid) n++;
  }
  return n;
}

// Whole-file source, when the filesystem is reachable. Same ladder as
// _fogSourceOf in test/fog-tests.js: under test/node.js every file is evaluated
// with vm.runInThisContext, so bare `require` is NOT in scope and only
// process.mainModule.require is. Returns null in a browser.
function _stdtSource(rel) {
  try {
    var req = null;
    if (typeof require === 'function') req = require;
    else if (typeof process !== 'undefined' && process.mainModule &&
             typeof process.mainModule.require === 'function') {
      req = function (m) { return process.mainModule.require(m); };
    }
    if (!req) return null;
    var fs = req('fs');
    var roots = ['', './'];
    if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
      roots.push(String(process.argv[1]).replace(/test[\/\\][A-Za-z0-9._-]+$/, ''));
    }
    for (var r = 0; r < roots.length; r++) {
      var p = roots[r] + rel;
      try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch (e) { /* next root */ }
    }
  } catch (e) { /* browser */ }
  return null;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

function suiteStandings(d) {
  if (typeof _stdRank !== 'function' || typeof _stdBuild !== 'function' ||
      typeof _stdUpdate !== 'function') {
    return skipSuite('standings / rail panel', 'render/standings.js not loaded');
  }
  if (!d.STATIONS || !d.POWERS || typeof newGame !== 'function') {
    return skipSuite('standings / rail panel', 'map + scenario data or core/state.js not loaded');
  }

  suite('standings / rail panel');

  var POWERS_LIVE = _stdtPowers();

  // --- order ---------------------------------------------------------------

  test('rows are ordered by territories, most first', function () {
    var s = _stdtRankedBoard();
    var rank = _stdRank(s);
    var got = rank.map(function (r) { return r.pid; }).join(',');
    // The plan in _stdtRankedBoard gives 4 / 3 / 2 / 1 / 0 / 0 / 0, and the
    // three zeroes fall to the id tiebreak — so this one string pins the
    // primary key and the last resort at once.
    assertEqual(got, 'rus,ger,gbr,fra,aut,ita,ott', 'ranking by territories held');

    // ...and the counts really are 4/3/2/1, i.e. the order above is not the
    // accidental result of every power reading zero.
    assertEqual(rank[0].terr, 4, 'rus territories');
    assertEqual(rank[1].terr, 3, 'ger territories');
    assertEqual(rank[2].terr, 2, 'gbr territories');
    assertEqual(rank[3].terr, 1, 'fra territories');
    assertEqual(rank[6].terr, 0, 'ott territories');
  });

  test('the ordering invariant holds pairwise, on every adjacent pair', function () {
    var s = _stdtRankedBoard();
    var rank = _stdRank(s);
    var bad = [];
    for (var i = 1; i < rank.length; i++) {
      var a = rank[i - 1], b = rank[i];
      var ok = (a.terr > b.terr) ||
        (a.terr === b.terr && a.cities > b.cities) ||
        (a.terr === b.terr && a.cities === b.cities && a.pid < b.pid);
      if (!ok) {
        bad.push(a.pid + '(' + a.terr + '/' + a.cities + ') before ' +
                 b.pid + '(' + b.terr + '/' + b.cities + ')');
      }
    }
    assertNone(bad, 'ranking is not sorted by territories, then cities, then id');
  });

  test('a tie on territories is broken by cities held', function () {
    // Both powers hold ZERO territories — footholds only, in a territory big
    // enough that neither one is a majority. So territories tie at 0 and only
    // the city count can separate them.
    var s = _stdtBlank(12);
    var big = _stdtPool(5)[0];
    if (!big) return skipTest('a tie on territories is broken by cities held',
      'no territory with 5+ stations in the generated map');
    var ids = stationsIn(big);
    setStationOwner(s, ids[0], 'ita');
    setStationOwner(s, ids[1], 'ott');
    setStationOwner(s, ids[2], 'ott');

    var rank = _stdRank(s);
    var ita = rank.findIndex(function (r) { return r.pid === 'ita'; });
    var ott = rank.findIndex(function (r) { return r.pid === 'ott'; });

    assertEqual(rank[ita].terr, 0, 'ita holds no territory');
    assertEqual(rank[ott].terr, 0, 'ott holds no territory');
    assertEqual(rank[ita].cities, 1, 'ita cities');
    assertEqual(rank[ott].cities, 2, 'ott cities');
    // The direction is the point: 'ita' < 'ott', so the id tiebreak alone would
    // put ita first. Only the cities term can produce this order.
    assert(ott < ita, 'ott holds more cities and must rank above ita');
  });

  // HONEST ABOUT ITS OWN LIMIT. POWER_IDS is already alphabetical, so a stable
  // sort with NO id tiebreak at all produces this same string — this assertion
  // cannot distinguish the explicit comparator from V8's stability
  // (known-issues #8, and the only case in this suite where a mutation does not
  // turn it red). What it does catch is a comparator that actively reorders
  // equal rows. The tiebreak itself is proved by the comparator-shape check in
  // 'the panel names no source of nondeterminism', which is where a removal
  // shows up.
  test('a total tie is broken by power id, deterministically', function () {
    var s = _stdtBlank(13);           // nobody holds anything: 0/0 seven times
    var rank = _stdRank(s);
    var got = rank.map(function (r) { return r.pid; }).join(',');
    assertEqual(got, POWERS_LIVE.join(','), 'a board with no holdings ranks by id');
    var allZero = rank.every(function (r) { return r.terr === 0 && r.cities === 0; });
    assert(allZero, 'the fixture really is a total tie');
  });

  // --- the numbers ---------------------------------------------------------

  test('territories use countTerritories — the same metric as the top bar', function () {
    var s = _stdtRankedBoard();
    var rank = _stdRank(s);
    var bad = [];
    for (var i = 0; i < rank.length; i++) {
      var want = countTerritories(s, rank[i].pid);
      if (rank[i].terr !== want) {
        bad.push(rank[i].pid + ': panel ' + rank[i].terr + ', countTerritories ' + want);
      }
      // Majority, not "every station" — if the panel had quietly used
      // countFullTerritories the two would agree on this board and not on a
      // half-taken one, so assert the metric that is actually claimed.
      var full = countFullTerritories(s, rank[i].pid);
      if (rank[i].terr < full) bad.push(rank[i].pid + ': panel counts fewer than FULL territories');
    }
    assertNone(bad, 'the panel disagrees with the victory metric');
  });

  // Added after a mutation run: swapping countTerritories for
  // countFullTerritories left the test above GREEN, because every territory in
  // _stdtRankedBoard() is fully held and on that board the two functions agree.
  // A metric test whose fixture cannot separate the two metrics is not testing
  // the metric (known-issues #8). This board can.
  test('territories count MAJORITY control, not full control', function () {
    var s = _stdtBlank(15);
    var tid = _stdtPool(3)[0];
    if (!tid) return skipTest('territories count MAJORITY control, not full control',
      'no territory with 3+ stations in the generated map');
    var ids = stationsIn(tid);
    var need = Math.floor(ids.length / 2) + 1;      // a strict majority, never all
    for (var i = 0; i < need; i++) setStationOwner(s, ids[i], 'fra');

    assertEqual(countTerritories(s, 'fra'), 1, 'the fixture is a majority hold');
    assertEqual(countFullTerritories(s, 'fra'), 0, 'the fixture is NOT a full hold');
    assertEqual(territoryControl(s, tid).tier, 'majority', 'the fixture is the middle tier');

    var fra = _stdRank(s).find(function (r) { return r.pid === 'fra'; });
    assertEqual(fra.terr, 1, 'a majority-held country counts on the panel');
    assertEqual(fra.cities, need, 'and its cities are the stations actually held');
  });

  test('cities are stations owned', function () {
    var s = _stdtRankedBoard();
    var rank = _stdRank(s);
    var bad = [];
    for (var i = 0; i < rank.length; i++) {
      var want = powerStations(s, rank[i].pid).length;
      if (rank[i].cities !== want) {
        bad.push(rank[i].pid + ': panel ' + rank[i].cities + ', powerStations ' + want);
      }
    }
    assertNone(bad, 'the panel disagrees with powerStations');
    // A guard against the whole board reading zero, which would make the
    // comparison above true and meaningless.
    assert(rank[0].cities >= 2, 'the leader holds at least two cities');
  });

  // --- THE ONE THAT MATTERS ------------------------------------------------

  test('counts are TRUE, not fog-filtered', function () {
    if (typeof visibleTo !== 'function' || typeof believedStation !== 'function') {
      return skipTest('counts are TRUE, not fog-filtered', 'core/vision.js not loaded');
    }

    // The player is Britain, holding its capital and nothing else. Russia is
    // handed whole territories chosen BECAUSE Britain cannot see a single
    // station in them — measured, not assumed, so this survives the map being
    // regenerated with different geography.
    var s = _stdtBlank(14);
    var cap = POWERS.gbr.capital;
    setStationOwner(s, cap, 'gbr');

    var vis = visibleTo(s, 'gbr');
    var blind = [];
    for (var t = 0; t < TERRITORY_IDS.length && blind.length < 3; t++) {
      var ids = stationsIn(TERRITORY_IDS[t]);
      if (ids.length < 2) continue;
      var unseen = true;
      for (var i = 0; i < ids.length; i++) if (vis[ids[i]]) { unseen = false; break; }
      if (unseen) blind.push(TERRITORY_IDS[t]);
    }
    assertEqual(blind.length, 3, 'found three territories Britain has no eyes in');

    var stations = 0;
    for (var b = 0; b < blind.length; b++) stations += _stdtTakeTerritory(s, blind[b], 'rus');

    // What a fog-filtered panel would have shown Britain. If this is not
    // strictly less than the truth there is no fog on this board and the
    // assertion below proves nothing (known-issues #8).
    var believed = _stdtBelievedTerritories(s, 'gbr', 'rus');
    assertEqual(believed, 0, 'a fog-filtered panel would credit Russia with nothing');

    var rank = _stdRank(s);
    var rus = rank.find(function (r) { return r.pid === 'rus'; });
    assertEqual(rus.terr, 3, 'the panel reports Russia\'s TRUE territory count');
    assertEqual(rus.cities, stations, 'the panel reports Russia\'s TRUE city count');
    assert(rus.terr > believed,
      'the panel must not agree with the believed board — that is the reversal');

    // And the RANKING follows the true board: Russia is ahead of the player
    // despite the player being unable to see any of it.
    assertEqual(rank[0].pid, 'rus', 'the leader is the true leader');
  });

  test('the panel reads the same whoever the player is', function () {
    // A fog-filtered panel would be a function of window.PLAYER. This one must
    // not be — the same board, viewed by two different powers, produces one
    // table.
    //
    // TWO SEPARATE BOARDS, built identically. Asking the same state object
    // twice would hit the ranking memo and return the very same array, so the
    // comparison would be true by construction and could not fail whatever the
    // counts did (known-issues #8). The memo keys on state identity, so two
    // boards mean two real computations.
    var line = function (pid, s) {
      return _stdtWithPlayer(pid, function () {
        return _stdRank(s).map(function (r) {
          return r.pid + ':' + r.terr + '/' + r.cities;
        }).join('|');
      });
    };
    var a = line('fra', _stdtRankedBoard());
    var b = line('ott', _stdtRankedBoard());
    assertEqual(a, b, 'the standings depend on the board, not on who is looking');
  });

  // --- the rows ------------------------------------------------------------

  test('one row per power, neutral excluded', function () {
    var host = _stdtHost();
    var n = _stdBuild(host);
    var kids = _stdtKids(host);
    assertEqual(kids.length, POWERS_LIVE.length, 'row count equals non-neutral power count');

    var pids = kids.map(function (k) { return _stdtAttr(k, 'data-power'); });
    assert(pids.indexOf('neutral') < 0, 'neutral must not get a row');
    assertEqual(pids.slice().sort().join(','), POWERS_LIVE.join(','), 'one row per power, no duplicates');

    var bad = [];
    for (var i = 0; i < kids.length; i++) {
      if (!_stdtHasClass(kids[i], 'standings-row')) bad.push(pids[i] + ': not .standings-row');
      var kk = _stdtKids(kids[i]);
      if (kk.length !== 4) bad.push(pids[i] + ': ' + kk.length + ' cells, expected 4');
      if (!_stdtHasClass(kk[0], 'standings-swatch')) bad.push(pids[i] + ': no swatch');
      if (!_stdtHasClass(kk[1], 'standings-name')) bad.push(pids[i] + ': no name');
      if (!_stdtHasClass(kk[2], 'is-terr')) bad.push(pids[i] + ': territories cell not .is-terr');
      if (!_stdtHasClass(kk[3], 'is-cities')) bad.push(pids[i] + ': cities cell not .is-cities');
      if (kk[0].style.background !== POWERS[pids[i]].color) {
        bad.push(pids[i] + ': swatch is ' + kk[0].style.background + ', map colour is ' + POWERS[pids[i]].color);
      }
      if (_stdtAttr(kids[i], 'title') !== POWERS[pids[i]].name) {
        bad.push(pids[i] + ': title is not the full power name');
      }
      // The rail is 200px. A name that does not fit is the failure this short
      // form exists to prevent, and the title above is what makes it safe.
      var label = String(kk[1].textContent || '');
      if (label.length > 9) bad.push(pids[i] + ': name "' + label + '" is too long for a 200px rail');
      if (!label) bad.push(pids[i] + ': no name text');
    }
    assertNone(bad, 'row structure does not match the stylesheet contract');
    assert(!!n && !!n.rows, 'build() returns a nodes object');
  });

  test('the numbers written into the rows are the ranked numbers', function () {
    var s = _stdtRankedBoard();
    var host = _stdtHost();
    var n = _stdBuild(host);
    assert(_stdUpdate(s, n) !== false, 'update() shows the section');

    var rank = _stdRank(s);
    var by = Object.create(null);
    for (var i = 0; i < rank.length; i++) by[rank[i].pid] = rank[i];

    var bad = [];
    var kids = _stdtKids(host);
    for (var k = 0; k < kids.length; k++) {
      var pid = _stdtAttr(kids[k], 'data-power');
      var cells = _stdtKids(kids[k]);
      if (String(cells[2].textContent) !== String(by[pid].terr)) {
        bad.push(pid + ': territories cell "' + cells[2].textContent + '" vs ' + by[pid].terr);
      }
      if (String(cells[3].textContent) !== String(by[pid].cities)) {
        bad.push(pid + ': cities cell "' + cells[3].textContent + '" vs ' + by[pid].cities);
      }
    }
    assertNone(bad, 'the rows do not carry the ranked numbers');
  });

  test('DOM order follows the ranking, and rebuilds nothing to get there', function () {
    var s = _stdtRankedBoard();
    var host = _stdtHost();
    var n = _stdBuild(host);
    var built = _stdtKids(host).slice();

    _stdUpdate(s, n);
    var order = _stdtKids(host).map(function (k) { return _stdtAttr(k, 'data-power'); });
    assertEqual(order.join(','), 'rus,ger,gbr,fra,aut,ita,ott', 'rows sit in ranked order');

    // The same seven nodes, moved — never seven new ones. A section that
    // rebuilds its rows per frame kills text selection and thrashes layout,
    // which is the rule the whole rail is built on.
    var after = _stdtKids(host);
    assertEqual(after.length, built.length, 'no rows were added');
    var same = built.every(function (b) { return after.indexOf(b) >= 0; });
    assert(same, 'update() replaced row nodes instead of moving them');

    // Now overturn the board: France takes five more territories than Russia
    // has, and the table must follow.
    var pool = _stdtPool(2);
    for (var i = 20; i < 25; i++) _stdtTakeTerritory(s, pool[i], 'fra');
    _stdUpdate(s, n);
    assertEqual(_stdtKids(host)[0].getAttribute('data-power'), 'fra',
      'a new leader takes the top row');
    assertEqual(_stdtKids(host).length, POWERS_LIVE.length, 'still one row per power');
  });

  test('an eliminated power is marked is-dead, and only it', function () {
    var s = _stdtRankedBoard();
    var host = _stdtHost();
    var n = _stdBuild(host);
    _stdUpdate(s, n);

    var kids = _stdtKids(host);
    var anyDead = kids.some(function (k) { return _stdtHasClass(k, 'is-dead'); });
    assert(!anyDead, 'nobody is dead before anybody dies');

    // sim/victory.js's own flag — set by capitulate() and by the elimination
    // branch of victoryTick(). Not re-derived by the panel and not invented
    // here: `alive === false` is the representation.
    s.powers.ita.alive = false;
    _stdUpdate(s, n);

    var bad = [];
    kids = _stdtKids(host);
    for (var i = 0; i < kids.length; i++) {
      var pid = _stdtAttr(kids[i], 'data-power');
      var dead = _stdtHasClass(kids[i], 'is-dead');
      if (pid === 'ita' && !dead) bad.push('ita is eliminated and has no .is-dead');
      if (pid !== 'ita' && dead) bad.push(pid + ' is alive and carries .is-dead');
    }
    assertNone(bad, 'is-dead does not track powers[pid].alive');

    // And it comes back off, so a fixture that is dead forever cannot mask a
    // one-way write.
    s.powers.ita.alive = true;
    _stdUpdate(s, n);
    kids = _stdtKids(host);
    var stillDead = kids.some(function (k) { return _stdtHasClass(k, 'is-dead'); });
    assert(!stillDead, 'is-dead must clear when the power is alive again');
  });

  test('an elimination is seen even when ownership did not move', function () {
    // sim/victory.js flips `alive` on BAL.CAPITULATE_CHECK_INTERVAL, up to 50
    // ticks after the last station changed hands — so state.ownerEpoch is
    // UNCHANGED at the moment the strike-through is due. A ranking memoized on
    // the epoch alone never shows it.
    var s = _stdtRankedBoard();
    var host = _stdtHost();
    var n = _stdBuild(host);
    _stdUpdate(s, n);
    var epoch = s.ownerEpoch;

    s.powers.ger.alive = false;
    _stdUpdate(s, n);
    assertEqual(s.ownerEpoch, epoch, 'the fixture really did not move ownership');

    var row = _stdtKids(host).filter(function (k) { return _stdtAttr(k, 'data-power') === 'ger'; })[0];
    assert(_stdtHasClass(row, 'is-dead'), 'the panel missed an elimination at a still epoch');
  });

  test('the human player\'s row is marked is-me, and follows the player', function () {
    var s = _stdtRankedBoard();
    var host = _stdtHost();
    var n = _stdBuild(host);

    _stdtWithPlayer('fra', function () { _stdUpdate(s, n); });
    var mine = _stdtKids(host).filter(function (k) { return _stdtHasClass(k, 'is-me'); });
    assertEqual(mine.length, 1, 'exactly one row is the player\'s');
    assertEqual(_stdtAttr(mine[0], 'data-power'), 'fra', 'the player\'s row');

    _stdtWithPlayer('ott', function () { _stdUpdate(s, n); });
    mine = _stdtKids(host).filter(function (k) { return _stdtHasClass(k, 'is-me'); });
    assertEqual(mine.length, 1, 'still exactly one row after the player changes');
    assertEqual(_stdtAttr(mine[0], 'data-power'), 'ott', 'is-me moved with the player');
  });

  // --- per-frame cost ------------------------------------------------------

  test('a settled board recomputes nothing', function () {
    var s = _stdtRankedBoard();
    var host = _stdtHost();
    var n = _stdBuild(host);
    _stdUpdate(s, n);

    var real = countTerritories;
    var calls = 0;
    try {
      globalThis.countTerritories = function (st, pid) { calls++; return real(st, pid); };
      if (countTerritories === real) {
        return skipTest('a settled board recomputes nothing',
          'countTerritories is not reassignable in this context');
      }
      for (var f = 0; f < 30; f++) _stdUpdate(s, n);
      assertEqual(calls, 0, 'thirty quiet frames must not re-count the board');

      // ...and the memo is not simply dead: move a station and it recomputes.
      var pool = _stdtPool(2);
      _stdtTakeTerritory(s, pool[25], 'aut');
      _stdUpdate(s, n);
      assert(calls > 0, 'the memo never invalidates — it would freeze the panel');
    } finally {
      globalThis.countTerritories = real;
    }
  });

  test('the panel names no source of nondeterminism', function () {
    var src = _stdtSource('render/standings.js');
    if (src === null) {
      return skipTest('the panel names no source of nondeterminism', 'no filesystem (browser)');
    }
    var bad = [];
    // Comments are stripped first: the file's header discusses timestamps, and
    // a scan that cannot tell prose from code is a scan that has to be
    // disabled the first time somebody explains themselves.
    var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/Math\.random/.test(code)) bad.push('Math.random');
    if (/Date\.now/.test(code)) bad.push('Date.now');
    if (/new Date\b/.test(code)) bad.push('new Date');
    if (/performance\.now/.test(code)) bad.push('performance.now');
    assertNone(bad, 'render/standings.js reads a clock or an RNG; the order would drift');
    // The sort must state its last-resort tiebreak, or two powers on identical
    // numbers depend on the engine's sort stability.
    assert(/a\.pid\s*<\s*b\.pid/.test(code), 'the comparator has no explicit id tiebreak');
  });
}

// ---------------------------------------------------------------------------
// Headless bootstrap — `node test/scenarios-standings.js`
// ---------------------------------------------------------------------------
//
// Inert under tests.html (no `require`) and under test/node.js (every file
// there is evaluated with vm.runInThisContext, where `require` and `module` are
// both out of scope). Only a direct `node test/scenarios-standings.js` gets
// here.
//
// The SCRIPTS list is test/node.js's, plus render/standings.js. It exists
// because test/node.js hard-codes its list and loads exactly one render/ file;
// if this suite is ever hooked into runAllTests(), add 'render/standings.js'
// and this file there and delete the block below.
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  (function () {
    var fs = require('fs'), vm = require('vm'), path = require('path');
    var root = path.join(__dirname, '..');
    var SCRIPTS = [
      'core/rng.js', 'core/util.js', 'core/state.js', 'core/vision.js',
      'data/tuning.js', 'data/map.js', 'data/stations.js', 'data/scenario.js',
      'sim/commands.js', 'sim/growth.js', 'sim/movement.js', 'sim/combat.js',
      'sim/relations.js', 'sim/victory.js', 'sim/step.js',
      'ai/score.js', 'ai/ai.js',
      'render/standings.js',
      'test/asserts.js', 'test/runner.js',
    ];
    for (var i = 0; i < SCRIPTS.length; i++) {
      var f = path.join(root, SCRIPTS[i]);
      if (!fs.existsSync(f)) continue;
      try { vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: SCRIPTS[i] }); }
      catch (e) { console.error('LOAD ERROR in ' + SCRIPTS[i] + ': ' + e.message); process.exit(2); }
    }
    resetTests();
    suiteStandings(collectData());
    process.stdout.write(formatResults() + '\n');
    process.exit(summarizeTests().fail === 0 ? 0 : 1);
  }());
}
