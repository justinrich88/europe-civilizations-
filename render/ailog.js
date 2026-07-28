// render/ailog.js — initAiLog() / renderAiLog(state).
//
// The debugging window onto the AI, demanded by 00-vision.md §6:
//
//   "Every decision logged with its utility score. A passive AI is otherwise
//    undebuggable."
//
// `state.aiLog` already holds the decisions (01-data-schema.md, "AI API —
// pinned names"). Nothing showed them. This is the window.
//
// Three constraints shape every function below.
//
// 1. **Everything AI-related is optional.** `ai/ai.js` may be absent,
//    `aiDecisions` may not exist, `state.aiLog` may be undefined. The panel
//    must then say so in words. A blank box reads as a bug in the panel, which
//    is exactly the confusion the panel exists to remove.
//
// 2. **renderAiLog runs every frame.** Same rule that governs renderLive() and
//    renderHud(): mutate existing DOM nodes, never rebuild them. Rebuilding
//    rows would also destroy the click-to-expand state sixty times a second —
//    the terms breakdown would flicker shut the instant you opened it. When the
//    panel is closed this function returns on its second line.
//
// 3. **The panel must never overlay the board.** Known-issue: anything drawn
//    over `#g-stations` that is not `pointer-events: none` swallows the click
//    that commits an attack, with no error at all. This panel needs pointer
//    events — it has a filter and expandable rows — so it is NOT an overlay. It
//    is a flex sibling of `.board-wrap` inside `.app`, inserted above the
//    bottom bar. Opening it shrinks the board (the SVG has a viewBox and
//    rescales); it cannot cover a single pixel of it.
//
// Read-only. Nothing in render/ may mutate state.
//
// Toggle: the `L` key (log), behind `?ailog=1`. Unclaimed — app/main.js owns
// Space and 1/2/4, render/select.js owns Escape and Cmd+A.
//
// 4. **This panel is not fog-filtered and must not be.** It is the debugging
//    instrument that made fog affordable (02-visibility-and-sea.md §1: fog
//    without the decision log "would still be a bad trade"), so it prints the
//    true board for all seven powers. It is kept away from the player by being
//    off by default rather than by being censored — see ailogEnabled().
//
// Every top-level name here is prefixed `ailog`/`AILOG` except the two pinned
// entry points, because in a globals-only project a function name is a global
// claim (known-issues #9).

'use strict';

// How many rows the list holds. Seven powers at ~1.75 decisions/sec fill this
// in under twenty seconds unfiltered, which is precisely why the power filter
// exists; filtered, it is a couple of minutes of one power's reasoning.
const AILOG_MAX_ROWS = 40;

// ── panel state (view state only — never game state) ─────────────────────

var AILOG_STATE = {
  open: false,
  filter: null,            // null = all powers, else a pid
  wired: false,
  // Expanded rows are keyed by decision IDENTITY, not by index: state.aiLog is
  // a ring buffer that trims from the front, so a given entry's index shifts
  // under us between frames. A key that survives the shift is the only way the
  // terms breakdown stays open while the log keeps moving.
  expanded: Object.create(null),
  expandedRev: 0,          // bumped on every expand/collapse — a repaint signal
};

var _ailogNodes = null;    // { panel, list, empty, filterbar }
var _ailogRows = [];       // pooled row records, index 0 = newest
var _ailogSeen = {         // last-rendered signature, to skip untouched frames
  len: -1,
  tail: null,
  filter: undefined,
  rev: -1,
  empty: undefined,
};

// ── lookups, all guarded ─────────────────────────────────────────────────

function ailogPowerColor(pid) {
  // Bare `typeof`, never `window.POWERS` — top-level `const` in a classic
  // script never lands on the global object (known-issues #3).
  if (typeof POWERS === 'undefined' || !POWERS[pid]) return null;
  return POWERS[pid].color || null;
}

function ailogPowerIds() {
  if (typeof POWER_IDS !== 'undefined' && POWER_IDS.length) return POWER_IDS;
  if (typeof POWERS !== 'undefined') return Object.keys(POWERS).sort();
  return [];
}

// The target's NAME, not its id. `bru` is a lookup task; "Brussels" is a read.
function ailogStationName(sid) {
  if (!sid) return '—';
  if (typeof STATIONS !== 'undefined' && STATIONS[sid] && STATIONS[sid].name) {
    return STATIONS[sid].name;
  }
  return String(sid);
}

function ailogNum(v, digits) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return Number(v).toFixed(digits === undefined ? 2 : digits);
}

// ── reading the log ──────────────────────────────────────────────────────
//
// `aiDecisions(state, pid, n)` is the pinned accessor and is preferred, but
// ai/ai.js may not be loaded at all. Falling back to state.aiLog directly means
// a half-built AI — score.js landed, ai.js did not — still shows something.
// Returns NEWEST FIRST; the pinned accessor returns newest last.

function ailogEntries(state, pid, n) {
  if (!state) return [];
  var out = [];
  var i;
  if (typeof aiDecisions === 'function') {
    try {
      var got = aiDecisions(state, pid || null, n) || [];
      for (i = got.length - 1; i >= 0; i--) out.push(got[i]);
      return out;
    } catch (e) {
      // A throwing accessor must not take the panel down with it; fall through
      // to the raw log, which is the thing we actually want to look at when the
      // accessor is misbehaving.
    }
  }
  var log = state.aiLog;
  if (!log || !log.length) return out;
  for (i = log.length - 1; i >= 0 && out.length < n; i--) {
    var d = log[i];
    if (!d) continue;
    if (pid && d.power !== pid) continue;
    out.push(d);
  }
  return out;
}

// Why the list is empty, in words. `null` means "there is data, draw it".
function ailogEmptyReason(state) {
  if (!state) return 'No game state.';
  var hasLog = !!(state.aiLog && state.aiLog.length);
  if (typeof aiDecisions !== 'function' && typeof aiTick !== 'function' && !hasLog) {
    return 'No AI loaded — ai/ai.js is not present in this build.';
  }
  if (!hasLog) {
    return state.paused
      ? 'No decisions yet — the game is paused.'
      : 'No decisions logged yet.';
  }
  return null;
}

// Identity of a decision, stable across ring-buffer trimming. tick + power is
// very nearly unique on its own (one power decides at most once per tick); kind
// and target are folded in so a hypothetical double-decision still separates.
function ailogKey(d) {
  if (!d) return '';
  return String(d.tick) + '|' + String(d.power) + '|' + String(d.kind) + '|' + String(d.target);
}

// ── DOM: built once ──────────────────────────────────────────────────────
//
// The container is created from JS rather than authored into index.html, so the
// panel is entirely self-contained: deleting this one script tag removes it.

function ailogBuildPanel() {
  var app = document.querySelector('.app');
  if (!app) return null;

  var panel = el('section', 'ailog', { id: 'ailog', 'aria-label': 'AI decision log' });
  panel.hidden = true;

  var head = el('div', 'ailog-head');
  head.appendChild(el('span', 'ailog-title', { text: 'AI decisions' }));

  var bar = el('div', 'ailog-filter', { id: 'ailog-filter' });
  bar.appendChild(el('button', 'ailog-fbtn is-active', {
    type: 'button', 'data-filter': '', text: 'All',
  }));
  var ids = ailogPowerIds();
  for (var i = 0; i < ids.length; i++) {
    var pid = ids[i];
    if (pid === 'neutral') continue;      // neutral takes no decisions
    var b = el('button', 'ailog-fbtn', {
      type: 'button', 'data-filter': pid, text: pid.toUpperCase(),
    });
    var c = ailogPowerColor(pid);
    if (c) b.style.borderBottomColor = c;
    bar.appendChild(b);
  }
  head.appendChild(bar);
  head.appendChild(el('span', 'ailog-hint', { text: 'L to close · click a row for terms' }));
  panel.appendChild(head);

  // The "why is this empty" message goes ABOVE the list: below it, the list's
  // flex:1 pushes it to the floor of the panel where it reads as a footnote
  // rather than as the answer to the question you just asked.
  var empty = el('div', 'ailog-empty', { id: 'ailog-empty' });
  panel.appendChild(empty);

  var list = el('div', 'ailog-list', { id: 'ailog-list' });
  panel.appendChild(list);

  // Below the board, in normal flow, so it displaces the board rather than
  // covering it — anything over the board that takes pointer events silently
  // eats the click that commits an attack. It used to be inserted above
  // .bottombar; the bottom bar is gone and .app's last child IS the bottom of
  // the layout now, so the plain append is the whole rule.
  app.appendChild(panel);

  return panel;
}

function ailogNodes() {
  if (_ailogNodes && _ailogNodes.panel && _ailogNodes.panel.isConnected) {
    return _ailogNodes;
  }
  var panel = byId('ailog') || ailogBuildPanel();
  if (!panel) return null;
  _ailogNodes = {
    panel: panel,
    list: byId('ailog-list'),
    empty: byId('ailog-empty'),
    filter: byId('ailog-filter'),
  };
  // A re-cache means the DOM was replaced; every memo is stale.
  _ailogRows = [];
  _ailogSeen = { len: -1, tail: null, filter: undefined, rev: -1, empty: undefined };
  return _ailogNodes;
}

// One pooled row. Built once, then only its text nodes and attributes are
// touched — the row element itself outlives thousands of frames, which is what
// keeps a hand-opened terms breakdown open.
function ailogMakeRow() {
  var row = el('div', 'ailog-row');
  var line = el('div', 'ailog-line');

  var rec = {
    row: row,
    tick: el('span', 'ailog-tick'),
    pow: el('span', 'ailog-pow'),
    kind: el('span', 'ailog-kind'),
    target: el('span', 'ailog-target'),
    score: el('span', 'ailog-score'),
    odds: el('span', 'ailog-odds'),
    src: el('span', 'ailog-src'),
    reason: el('span', 'ailog-reason'),
    terms: el('div', 'ailog-terms'),
    key: null,
    termsKey: null,
    expanded: null,
  };

  line.appendChild(rec.tick);
  line.appendChild(rec.pow);
  line.appendChild(rec.kind);
  line.appendChild(rec.target);
  line.appendChild(rec.score);
  line.appendChild(rec.odds);
  line.appendChild(rec.src);
  line.appendChild(rec.reason);
  row.appendChild(line);
  rec.terms.hidden = true;
  row.appendChild(rec.terms);
  return rec;
}

// ── the terms breakdown ──────────────────────────────────────────────────
//
// The actual debugging payload. §6 wants to see WHICH TERM DOMINATED, so the
// terms are sorted by absolute contribution descending — a breakdown in
// declaration order buries the answer somewhere in the middle of the list.
// Built only when a row's identity changes or it is first expanded, never per
// frame.

function ailogFillTerms(rec, d) {
  var box = rec.terms;
  while (box.firstChild) box.removeChild(box.firstChild);

  var terms = d && d.terms;
  var keys = terms ? Object.keys(terms) : [];
  if (!keys.length) {
    box.appendChild(el('div', 'ailog-term-none', {
      text: 'No terms recorded for this decision.',
    }));
  } else {
    keys.sort(function (a, b) {
      return Math.abs(Number(terms[b]) || 0) - Math.abs(Number(terms[a]) || 0);
    });

    var max = Math.abs(Number(terms[keys[0]]) || 0) || 1;
    for (var i = 0; i < keys.length; i++) {
      var v = Number(terms[keys[i]]);
      var t = el('div', 'ailog-term' + (i === 0 ? ' is-dominant' : ''));
      t.appendChild(el('span', 'ailog-term-name', { text: keys[i] }));
      var track = el('span', 'ailog-term-track');
      var fill = el('span', 'ailog-term-bar' + (v < 0 ? ' is-neg' : ''));
      fill.style.width = (Math.min(1, Math.abs(v) / max) * 100).toFixed(1) + '%';
      track.appendChild(fill);
      t.appendChild(track);
      t.appendChild(el('span', 'ailog-term-val', { text: ailogNum(v) }));
      box.appendChild(t);
    }
  }

  // Everything that does not fit on the one-line row.
  var foot = [];
  if (d.sources && d.sources.length) foot.push('sources: ' + d.sources.join(', '));
  if (d.fraction !== undefined && d.fraction !== null) foot.push('fraction: ' + ailogNum(d.fraction, 2));
  if (d.rejected && d.rejected.length) foot.push('rejected: ' + d.rejected.length);
  if (foot.length) box.appendChild(el('div', 'ailog-term-foot', { text: foot.join('  ·  ') }));
}

// ── writing one row ──────────────────────────────────────────────────────
//
// Every write is guarded by a comparison, so a frame where the log did not move
// touches nothing at all even after the early-out above has been passed.

function ailogSetText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function ailogWriteRow(rec, d) {
  var key = ailogKey(d);
  var isNew = rec.key !== key;
  rec.key = key;

  if (isNew) {
    rec.row.setAttribute('data-key', key);

    ailogSetText(rec.tick, 't' + (d.tick === undefined ? '?' : d.tick));

    var pid = d.power || '?';
    ailogSetText(rec.pow, String(pid).toUpperCase());
    // Ownership colour is the fastest possible read of "who" (00-vision.md §8),
    // and it is the same colour the station wears on the map.
    var c = ailogPowerColor(pid);
    rec.pow.style.color = c || '';

    // Pass the kind through rather than folding everything that is not a hold
    // into "attack". There are three kinds now, not two: a 'stage' decision
    // marches rear garrisons into a border city the power already owns, and
    // rendering that as an ATTACK on a friendly city is not a cosmetic slip —
    // this log is the instrument used to work out why a power is doing nothing,
    // and it would have been reporting an assault on one's own territory.
    var kind = (d.kind === 'hold' || d.kind === 'stage') ? d.kind : 'attack';
    ailogSetText(rec.kind, kind);
    if (rec.row.getAttribute('data-kind') !== kind) rec.row.setAttribute('data-kind', kind);

    ailogSetText(rec.target, d.kind === 'hold' ? '—' : ailogStationName(d.target));
    ailogSetText(rec.score, ailogNum(d.score, 1));

    // Odds against the bar they had to clear. Shown together because either
    // number alone says nothing about whether the attack was allowed.
    if (d.odds === undefined || d.odds === null) {
      ailogSetText(rec.odds, '');
    } else {
      ailogSetText(rec.odds, ailogNum(d.odds) + ' ≥ ' + ailogNum(d.minOdds));
    }
    var shortOdds = (isFinite(d.odds) && isFinite(d.minOdds) && d.odds < d.minOdds);
    rec.odds.classList.toggle('is-short', !!shortOdds);

    var n = (d.sources && d.sources.length) || 0;
    ailogSetText(rec.src, n ? (n + (n === 1 ? ' src' : ' srcs')) : '');

    // The reason a power did nothing is the whole point of the panel, so it is
    // never truncated and never abbreviated — it gets the rest of the line.
    ailogSetText(rec.reason, d.reason ? String(d.reason) : '');

    rec.termsKey = null;         // the breakdown belongs to the old decision
  }

  var want = !!AILOG_STATE.expanded[key];
  if (want && rec.termsKey !== key) {
    ailogFillTerms(rec, d);
    rec.termsKey = key;
  }
  if (rec.expanded !== want) {
    rec.expanded = want;
    rec.terms.hidden = !want;
    rec.row.classList.toggle('is-open', want);
  }
}

// ── events ───────────────────────────────────────────────────────────────

function ailogOnListClick(ev) {
  var row = ev.target && ev.target.closest ? ev.target.closest('.ailog-row') : null;
  if (!row) return;
  var key = row.getAttribute('data-key');
  if (!key) return;
  if (AILOG_STATE.expanded[key]) delete AILOG_STATE.expanded[key];
  else AILOG_STATE.expanded[key] = true;
  AILOG_STATE.expandedRev++;
  ailogRepaint();
}

function ailogOnFilterClick(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('[data-filter]') : null;
  if (!btn) return;
  var v = btn.getAttribute('data-filter');
  AILOG_STATE.filter = v || null;
  var nodes = ailogNodes();
  if (nodes && nodes.filter) {
    var btns = nodes.filter.querySelectorAll('[data-filter]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', btns[i] === btn);
    }
  }
  // A focused button would otherwise eat the space bar, which app/main.js binds
  // to pause — pressing space would re-click the filter instead of pausing.
  if (btn.blur) btn.blur();
  ailogRepaint();
}

function ailogOnKeyDown(ev) {
  var t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'l' || ev.key === 'L') {
    ev.preventDefault();
    toggleAiLog();
  }
}

// Paint outside the loop, for the frames where the user acted but the sim did
// not move — a click-to-expand on a paused game must still open.
function ailogRepaint() {
  if (!AILOG_STATE.open) return false;
  _ailogSeen.rev = -1;
  return renderAiLog(window.GAME);
}

function toggleAiLog(force) {
  var nodes = ailogNodes();
  if (!nodes) return false;
  var open = (force === undefined) ? !AILOG_STATE.open : !!force;
  AILOG_STATE.open = open;
  nodes.panel.hidden = !open;
  if (open) ailogRepaint();
  return open;
}

// ── ?ailog=1 — the panel is a DEBUG INSTRUMENT, not a game surface ───────
//
// **This panel is deliberately NOT fog-filtered, and it must never become
// fog-filtered.** Every other reader in render/ now goes through
// believedStation(); this one prints what each AI actually saw, scored and
// decided, on the true board, for all seven powers.
//
// That is not an oversight in the fog work — it is the reason the fog work was
// affordable at all. 00-vision.md §5 parked fog for v1 precisely because it
// makes AI behaviour much harder to debug, and 02-visibility-and-sea.md §1
// reverses that on one condition: *"when a power behaves strangely under fog
// you can read what it believed and what it scored, instead of inferring from
// the board. Fog without that log would still be a bad trade."* A debugger with
// the fog applied to it answers the question you already had and is worth
// nothing. Filtering it would not make the game fairer; it would make the one
// tool that can tell you whether the AI peeked incapable of telling you.
//
// So the panel is hidden from the PLAYER instead — which is a different fix for
// a different problem, and the honest one. Behind `?ailog=1`, matching the
// `?player=` convention in app/main.js: absent, nothing is built and the `L`
// key is not bound, so a player cannot reach it by accident and a build handed
// to a tester turns it on with six characters in the URL. `toggleAiLog()` stays
// callable from the console either way — a debug instrument you cannot open
// while debugging is the same mistake in a smaller font.
function ailogEnabled() {
  try {
    return /[?&]ailog=1\b/.test(String(location.search));
  } catch (e) {
    return false;                      // no location (a harness): stay closed
  }
}

// ── entry points (pinned names, same convention as renderHud) ────────────

function initAiLog() {
  if (AILOG_STATE.wired) return true;
  if (!ailogEnabled()) return false;   // not built, not wired, not reachable
  var nodes = ailogNodes();
  if (!nodes) {
    console.warn('[render/ailog] no .app container; AI log not installed');
    return false;
  }
  if (nodes.list) nodes.list.addEventListener('click', ailogOnListClick);
  if (nodes.filter) nodes.filter.addEventListener('click', ailogOnFilterClick);
  window.addEventListener('keydown', ailogOnKeyDown);
  AILOG_STATE.wired = true;
  return true;
}

function renderAiLog(state) {
  // Called every frame. Closed is the common case and costs one property read.
  if (!AILOG_STATE.open) return false;
  var nodes = ailogNodes();
  if (!nodes || !nodes.list) return false;
  if (!state) return false;

  // Change signal. The ring buffer trims from the front, so length alone stops
  // being a signal once the cap is hit — the identity of the newest entry is
  // compared as well. Cheap, and exact.
  var log = state.aiLog || [];
  var len = log.length;
  var tail = len ? log[len - 1] : null;
  var reason = ailogEmptyReason(state);
  if (len === _ailogSeen.len && tail === _ailogSeen.tail &&
      AILOG_STATE.filter === _ailogSeen.filter &&
      AILOG_STATE.expandedRev === _ailogSeen.rev &&
      reason === _ailogSeen.empty) {
    return true;
  }
  _ailogSeen.len = len;
  _ailogSeen.tail = tail;
  _ailogSeen.filter = AILOG_STATE.filter;
  _ailogSeen.rev = AILOG_STATE.expandedRev;
  _ailogSeen.empty = reason;

  var entries = reason ? [] : ailogEntries(state, AILOG_STATE.filter, AILOG_MAX_ROWS);

  // Missing AI, an empty log, or a filter with nothing behind it each say so in
  // words. A blank box would read as a broken panel.
  var msg = reason;
  if (!msg && !entries.length && AILOG_STATE.filter) {
    msg = 'No decisions logged for ' + AILOG_STATE.filter.toUpperCase() + ' yet.';
  }
  if (nodes.empty) {
    if (msg) ailogSetText(nodes.empty, msg);
    nodes.empty.hidden = !msg;
  }

  // Grow/shrink the pool to match, then rewrite in place. The list only ever
  // changes by a row or two, so this is a handful of DOM writes on the frames
  // where the AI decided anything and none on the rest.
  while (_ailogRows.length < entries.length) {
    var rec = ailogMakeRow();
    nodes.list.appendChild(rec.row);
    _ailogRows.push(rec);
  }
  while (_ailogRows.length > entries.length) {
    var gone = _ailogRows.pop();
    if (gone.row.parentNode) gone.row.parentNode.removeChild(gone.row);
  }

  // Newest first in DOM order: the freshest decision is at the top, where the
  // eye already is.
  for (var i = 0; i < entries.length; i++) ailogWriteRow(_ailogRows[i], entries[i]);
  return true;
}

// Global exports — no modules anywhere in this project.
window.initAiLog = initAiLog;
window.renderAiLog = renderAiLog;
window.toggleAiLog = toggleAiLog;
window.ailogEnabled = ailogEnabled;
window.AILOG_STATE = AILOG_STATE;
