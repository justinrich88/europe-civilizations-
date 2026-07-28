// render/hud.js — renderHud(state).
//
// The chrome around the board: territory count, total forces, day counter,
// power strip, event ticker. 00-vision.md §8 sketches it exactly:
//
//   │  Territories 14/48   Forces 312   ⏸ 1x 2x 4x   │ Day 42  │
//   │  send: 25 · 50 · [75] · All     powers + event ticker    │
//
// This function runs EVERY FRAME, at up to 60fps, alongside renderLive() and
// renderWaves(). So the rule from 01-data-schema.md that governs renderLive
// governs this file too: **mutate existing DOM nodes, never rebuild them**.
// Rebuilding the power strip and the ticker sixty times a second is both
// wasteful and visibly wrong — it kills text selection, and `aria-live` on the
// ticker would re-announce the same events forever.
//
// The pattern used throughout: compute a cheap value, compare it to the last
// one written, and touch the DOM only on a change. Most frames do nothing.
//
// Reads window.PLAYER (set by app/main.js) for whose numbers to show, and
// countTerritories() / powerForces() from core/state.js. Never mutates state.

'use strict';

// ── sim time -> days ────────────────────────────────────────────────────
//
// The sim has no calendar; `state.tick` is the only clock. The scale is a
// presentation choice made here, once.
//
// Chosen: ONE SIM-SECOND = ONE DAY, i.e. BAL.TICKS_PER_SEC (10) ticks per day.
// Rationale from data/tuning.js: a 20-minute game is ~12,000 ticks, which at
// this scale reads as ~1,200 days — a hair over three years, which lands a
// full-length game squarely on the 1914-1918 span the scenario is set in.
// It also makes the numbers legible: a ~20s battle is a two-day engagement,
// a long march is a few days, and rebuilding a gutted city (~1,220 ticks) is
// the better part of a campaign season. Day 0 is 28 June 1914.
const HUD_TICKS_PER_DAY = 10;

function hudTicksPerDay() {
  // Known-issues #3: bare `typeof`, never `window.BAL` — top-level `const` in a
  // classic script never lands on the global object.
  if (typeof BAL !== 'undefined' && isFinite(BAL.TICKS_PER_SEC) && BAL.TICKS_PER_SEC > 0) {
    return BAL.TICKS_PER_SEC;
  }
  if (typeof BAL !== 'undefined' && isFinite(BAL.TICK_MS) && BAL.TICK_MS > 0) {
    return Math.max(1, Math.round(1000 / BAL.TICK_MS));
  }
  return HUD_TICKS_PER_DAY;
}

// ── cached nodes and last-written values ────────────────────────────────
//
// `var` at top level so these are inspectable from the console, matching
// core/state.js. The cache is refreshed if the document changes underneath us
// (which in practice only happens in the test harness).

var _hudNodes = null;

// Last values actually written to the DOM. `undefined` means "never written",
// which is distinct from any legitimate value, so the first frame always paints.
var _hudLast = {
  territories: undefined,
  forces: undefined,
  day: undefined,
};

// Power strip: one chip per power, built once, then only its number and its
// dead/alive class are touched.
var _hudChips = null;          // pid -> { row, count, chip }
var _hudChipLast = null;       // pid -> { n, alive }

// Ticker: the tail of state.log. We reuse <li> nodes and only rewrite text.
var _hudTickerItems = [];      // live <li> nodes, index 0 = newest
var _hudTickerLastLen = -1;
var _hudTickerLastTail = null; // identity of the newest log entry
var _hudTickerKeys = [];       // per-row identity, so we only repaint on change
var _hudTickerTopKey = null;   // identity of row 0, to fire the enter animation

// Five rows, not eight. The ticker is auto-height and spills upward out of the
// 52px bar over the sea, so more rows is not free real estate — it is a taller
// column of grey text sitting on the board. Five is enough to see a burst and
// short enough that the fade-by-age ramp in style.css still separates them.
const HUD_TICKER_MAX = 5;

// Consecutive captures by the same power inside this many ticks collapse into
// one row. BAL.TICKS_PER_SEC is 10, so this is ~12 sim-seconds — the width of a
// single volley landing. Without it, one power taking four cities in ten
// seconds writes four near-identical lines and pushes a capitulation off the
// bottom of the ticker, which is precisely backwards.
const HUD_TICKER_COALESCE_TICKS = 120;

function hudNodes() {
  if (_hudNodes && _hudNodes.territories && _hudNodes.territories.isConnected) {
    return _hudNodes;
  }
  _hudNodes = {
    territories: byId('stat-territories'),
    forces: byId('stat-forces'),
    day: byId('stat-day'),
    strip: byId('powers-strip'),
    ticker: byId('ticker-list'),
  };
  // A re-cache means the DOM was replaced; every memo is now stale.
  _hudLast = { territories: undefined, forces: undefined, day: undefined };
  _hudChips = null;
  _hudChipLast = null;
  _hudTickerItems = [];
  _hudTickerLastLen = -1;
  _hudTickerLastTail = null;
  _hudTickerKeys = [];
  _hudTickerTopKey = null;
  return _hudNodes;
}

// Single write point, so "skip work when nothing changed" is enforced in one
// place rather than remembered at five call sites.
function setTextIfChanged(node, key, value) {
  if (!node || _hudLast[key] === value) return false;
  _hudLast[key] = value;
  node.textContent = value;
  return true;
}

// ── ownership colour ────────────────────────────────────────────────────
//
// Mirrors powerColor() in render/map.js: colour carries ownership and nothing
// else (00-vision.md §8), so the chip swatch must be the exact colour the
// player sees on the map.
function hudPowerColor(pid) {
  if (typeof POWERS === 'undefined' || !POWERS[pid]) return null;
  return POWERS[pid].color || null;
}

function hudPowerName(pid) {
  if (typeof POWERS !== 'undefined' && POWERS[pid] && POWERS[pid].name) {
    return POWERS[pid].name;
  }
  return pid;
}

// ── stat block ──────────────────────────────────────────────────────────

function hudStats(state, nodes) {
  const me = window.PLAYER;

  // Territories counts MAJORITY control, matching countTerritories() and the
  // victory metric — not "stations owned". Holding half a country is worth
  // nothing on this readout, which is the point (00-vision.md §3).
  const total = (typeof TERRITORY_IDS !== 'undefined' && TERRITORY_IDS.length)
    ? TERRITORY_IDS.length
    : (typeof TERRITORIES !== 'undefined' ? Object.keys(TERRITORIES).length : 0);

  let held = 0;
  if (typeof countTerritories === 'function' && me) held = countTerritories(state, me);
  setTextIfChanged(nodes.territories, 'territories', held + '/' + total);

  // Unit counts are floats (01-data-schema.md); floor only at render — here.
  let forces = 0;
  if (typeof powerForces === 'function' && me) forces = powerForces(state, me);
  setTextIfChanged(nodes.forces, 'forces', String(Math.floor(forces)));

  const day = Math.floor((state.tick || 0) / hudTicksPerDay());
  setTextIfChanged(nodes.day, 'day', String(day));
}

// ── power strip ─────────────────────────────────────────────────────────
//
// render/map.js draws a provisional legend into #powers-strip so the colours
// are legible before this file exists; the comment there says hud.js should
// take it over. We do, once, and mark the node so we know not to do it again.

function buildPowerStrip(strip) {
  while (strip.firstChild) strip.removeChild(strip.firstChild);
  _hudChips = Object.create(null);
  _hudChipLast = Object.create(null);

  const ids = (typeof POWER_IDS !== 'undefined' && POWER_IDS.length)
    ? POWER_IDS
    : (typeof POWERS !== 'undefined' ? Object.keys(POWERS).sort() : []);

  for (const pid of ids) {
    if (pid === 'neutral') continue;      // neutral is empty ground, not a power

    const chip = el('span', 'power-chip', { 'data-power': pid, title: hudPowerName(pid) });

    const sw = el('span', 'power-swatch');
    const color = hudPowerColor(pid);
    if (color) sw.style.background = color;
    chip.appendChild(sw);

    // Short id rather than the full name: seven "German Empire"s do not fit in
    // the bottom bar, and the swatch is already carrying the identity.
    chip.appendChild(el('span', 'power-name', { text: pid.toUpperCase() }));

    const count = el('span', 'power-count', { text: '0' });
    chip.appendChild(count);

    strip.appendChild(chip);
    _hudChips[pid] = { chip: chip, count: count };
    _hudChipLast[pid] = { n: -1, alive: null };
  }

  strip.setAttribute('data-hud-built', '1');
}

function hudPowerStrip(state, nodes) {
  const strip = nodes.strip;
  if (!strip) return;

  // Rebuild only if the strip has never been built, or renderBoard() blew it
  // away and re-seeded it with the provisional legend.
  if (!_hudChips || strip.getAttribute('data-hud-built') !== '1') {
    buildPowerStrip(strip);
  }

  for (const pid in _hudChips) {
    const rec = _hudChips[pid];
    const last = _hudChipLast[pid];

    const p = state.powers && state.powers[pid];
    const alive = p ? !!p.alive : false;
    const n = (typeof countTerritories === 'function') ? countTerritories(state, pid) : 0;

    if (n !== last.n) {
      last.n = n;
      rec.count.textContent = String(n);
    }
    // Dead powers stay on the strip, struck through — .power-chip.is-dead in
    // style.css. Who has been knocked out is as informative as who is winning,
    // and removing the chip would silently reflow every other one.
    if (alive !== last.alive) {
      last.alive = alive;
      rec.chip.classList.toggle('is-dead', !alive);
    }
  }
}

// ── ticker ──────────────────────────────────────────────────────────────
//
// state.log entries are { tick, kind, text } and core/state.js caps the array
// at 400 with a shift(), so length alone is not a change signal once the cap is
// hit. We compare the identity of the newest entry as well — cheap, and exact.
//
// This is PERIPHERAL AWARENESS, not a log viewer — render/ailog.js already owns
// detail. Three things the raw tail of state.log did not do:
//
//   1. Weight. A capitulation, an elimination and a victory are the loudest
//      things that can happen in a match; a routine neutral city changing hands
//      is background. They read identically before. Now `kind` drives a weight
//      class and style.css sizes them accordingly.
//   2. Ownership colour. Every other surface in the game says who by hue, and
//      it is the fastest read available (§8). The sim logs raw power *ids* for
//      captures ("ger took Brussels from neutral") and full *names* elsewhere,
//      so the ticker normalises both to the display name and colours them.
//   3. Repetition. Consecutive captures by one power collapse into one row.
//
// Helpers here are prefixed `hudTick*` — per FILE, not per subsystem
// (known-issues #12). Every top-level `function` in a classic script is a
// global claim.

// Loudness tier for a log kind. Anything unrecognised is background, so a new
// kind added by the sim later degrades to quiet rather than shouting.
//
// 'landing' is deliberately absent: an amphibious assault's tier depends on
// which END of it the player is on, which is a property of the row and not of
// the kind. hudTickLandRow() sets it. See the LANDINGS block below.
function hudTickWeight(kind) {
  if (kind === 'victory' || kind === 'capitulation' || kind === 'elimination') return 'major';
  if (kind === 'relations') return 'mid';
  return 'minor';
}

// One regex over every power id AND every power display name, longest first so
// "Austria-Hungary" is not eaten by a shorter alternative. Built once.
var _hudTickPowerRe = null;
var _hudTickPowerBy = null;    // matched literal (lowercased) -> pid

function hudTickPowerIndex() {
  if (_hudTickPowerRe) return;
  _hudTickPowerBy = Object.create(null);
  const lits = [];
  if (typeof POWERS !== 'undefined') {
    for (const pid in POWERS) {
      const push = function (s) {
        if (!s) return;
        _hudTickPowerBy[String(s).toLowerCase()] = pid;
        lits.push(String(s));
      };
      push(pid);
      push(POWERS[pid] && POWERS[pid].name);
    }
  }
  lits.sort(function (a, b) { return b.length - a.length; });
  const esc = lits.map(function (s) { return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); });
  _hudTickPowerRe = esc.length
    ? new RegExp('\\b(' + esc.join('|') + ')\\b', 'gi')
    : /(?!)/g;
}

// Split a sentence into [{ pid, s }] runs. `pid` null means plain text.
//
// Powers render as the SHORT CODE ("GER"), not the display name. Expanding
// "ger" to "German Empire" was tried and reverted: the ticker shares one flex
// row with the send buttons and the power strip, so a full name consumed the
// whole line and "French Republic took ..." clipped away the only part that
// carried news — WHICH city, and from whom. The strip an inch to the left
// already labels powers "AUT / FRA / GBR", colour already carries identity, and
// the ticker is peripheral awareness rather than prose. Short wins.
function hudTickTokens(text) {
  hudTickPowerIndex();
  const out = [];
  const s = String(text || '');
  let at = 0;
  _hudTickPowerRe.lastIndex = 0;
  let m;
  while ((m = _hudTickPowerRe.exec(s)) !== null) {
    const pid = _hudTickPowerBy[m[0].toLowerCase()];
    if (!pid) continue;
    if (m.index > at) out.push({ pid: null, s: s.slice(at, m.index) });
    out.push({ pid: pid, s: String(pid).toUpperCase() });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ pid: null, s: s.slice(at) });
  if (!out.length) out.push({ pid: null, s: s });
  return out;
}

// sim/combat.js logs captures as `<pid> took <Place> from <pid>`. Parsing that
// back out is what lets consecutive captures merge; a failed parse simply falls
// through to the un-merged path, so a reworded message degrades gracefully.
function hudTickCapture(e) {
  if (!e || e.kind !== 'capture') return null;
  const m = /^(\S+) took (.+) from (\S+)$/.exec(String(e.text || ''));
  if (!m) return null;
  return { pid: m[1], place: m[2], from: m[3] };
}

// Did the human take this city, or lose it? The board now makes a battle in
// progress legible (the split ring in render/map.js); this is the same event
// after the fact, and a fight the player was actually in must not read exactly
// like two AIs trading a village on the far side of the map. It reuses the
// weight tier the ticker already has — no second notification surface — so a
// capture the player is party to gets the 'mid' treatment style.css already
// defines and everything else stays background.
//
// Only captures are reachable here: a FAILED attack is not logged by the sim at
// all, so an attack that dies on the walls still leaves no trace in the ticker.
// That needs a sim-side change and is written up rather than made.
function hudTickMine(cap) {
  if (!cap || typeof PLAYER !== 'string') return false;
  return cap.pid === PLAYER || cap.from === PLAYER;
}

// ── LANDINGS ────────────────────────────────────────────────────────────
//
// sim/movement.js logs an OPPOSED landing as
//
//     <pid> puts <n> ashore at <Place> against <pid>
//
// which is the same contract hudTickCapture() has with sim/combat.js: parse it
// back out to merge and to tier, fall through to the generic path if the
// wording ever changes.
//
// THE THROTTLE, AND WHY IT IS A FILTER RATHER THAN A CAP.
//
// Measured over 12 headless games (223,062 ticks): 4,356 landings, of which the
// sim already discards the 2,219 that are sea-borne reinforcement into a port
// the lander already holds. That leaves 178 opposed landings per game — one
// every 104 ticks, ~10 sim-seconds. The ticker is five rows in a 52px bar over
// the sea and the header of this file is explicit that more rows is not free
// real estate, it is a taller bar eating the board. 178 rows a game through a
// five-row window means the ticker is nothing but landings and a capitulation
// never survives long enough to be read.
//
// So landings are filtered by RELEVANCE, not rationed by rate:
//
//   * a landing the player is party to — theirs, or one coming ashore on ground
//     they hold — gets a row;
//   * every other power's amphibious war does not. Italy landing in Tunisia is
//     not peripheral awareness, it is noise, and the player cannot act on it.
//
// A rate cap was the alternative and is worse: it drops events by arrival order
// rather than by whether they matter, so a burst of Ottoman landings in the
// Aegean would silence the one landing on the player's own beach.
//
// Measured after the filter and the merge below, rows per game by chosen power:
// GER 10.3, ITA 10.6, OTT 7.6, AUT 8.1, GBR 33.5, RUS 36.8, FRA 39.3 — against
// a mean game of ~2,000 sim-seconds, i.e. one landing row every one to three
// sim-minutes even for the most amphibious power on the board. That fits in
// five rows alongside captures without the bar growing by a pixel.
//
// THE TIERS. Two, and they are the point of the feature:
//
//   * major — somebody is coming ashore ON GROUND THE PLAYER HOLDS. This is the
//     most actionable event the game produces: the force lands in echelons over
//     BAL.LANDING_TICKS, so there is a real window in which reinforcing the
//     beach still changes the outcome, and it is the only window. style.css
//     gives 'major' an --accent rule and pins opacity at 1, so it stays legible
//     as it ages out of the stack rather than fading to 24% while the landing
//     is still happening.
//   * mid — the player's OWN landing. Confirmation that a committed force is
//     ashore, not an alarm. Same tier a capture the player is party to gets.
//
// No new palette token and no new stylesheet rule: both tiers already exist and
// are already styled, and 00-vision.md §8 keeps colour for ownership only. The
// row also carries data-kind="landing" so the CSS has a hook if it ever wants
// one, but nothing here depends on that hook existing.
function hudTickLanding(e) {
  if (!e || e.kind !== 'landing') return null;
  const m = /^(\S+) puts ([0-9.]+) ashore at (.+) against (\S+)$/.exec(String(e.text || ''));
  if (!m) return null;
  const n = Number(m[2]);
  if (!isFinite(n)) return null;
  return { pid: m[1], units: n, place: m[3], from: m[4] };
}

// Whose landing is worth a row, and how loud. Returns null for "not the
// player's business", which is what makes 178 events a game fit in five rows.
//
// PLAYER unset (the empire picker, a harness) reads as "nobody's business" and
// shows nothing, rather than as "everybody's". That is the safe direction: the
// failure mode of the other choice is a flooded ticker, and the failure mode of
// this one is a ticker that looks exactly like it did before this feature.
function hudTickLandTier(l) {
  if (!l || typeof PLAYER !== 'string') return null;
  if (l.from === PLAYER) return 'major';        // on my beach — the alarm
  if (l.pid === PLAYER) return 'mid';           // mine — confirmation
  return null;
}

// One landing row, or none. Called with `i` pointing at a 'landing' entry;
// returns the index to carry on the backwards walk from, so the caller does not
// have to know how many entries were consumed.
//
// THE MERGE. §8's primary command is many sources onto one target, so an
// amphibious volley is several waves that cross separately and begin landing
// within a few ticks of each other — several log entries describing ONE
// operation. Consecutive landings by the same power, at the same station,
// against the same defender, inside HUD_TICKER_COALESCE_TICKS become one row
// with the forces SUMMED. Measured, that is a 58% reduction: 79.7 raw
// player-involved events a game for Britain become 33.5 rows.
//
// The window is 120 ticks and BAL.LANDING_TICKS is also 120, which is not a
// coincidence worth relying on but is worth noticing: the merge window is about
// the length of the landing it is merging.
//
// The sum is honest. Each logged number is the strength that BEGAN landing,
// post sea toll, and a non-standing wave always puts all of it ashore —
// echelons cannot be hit while at sea. So "puts 54 ashore at Lille" is the
// count that actually walks up that beach, not a projection
// (docs/testing/known-issues.md #18). Requiring the same station and the same
// defender is what keeps it that way: one place, one garrison, one number.
//
// Landings the player is not party to are stepped over silently rather than
// breaking the merge, because they are not on screen — a Russian landing in the
// Baltic must not split a British volley into two rows.
function hudTickLandRow(log, i, rows) {
  const lead = hudTickLanding(log[i]);
  // An unparseable landing shows NOTHING, where an unparseable capture falls
  // through to the raw sentence. Deliberate asymmetry: the fallback for a
  // capture is one extra row, and the fallback for a landing is 178 of them a
  // game with no player filter left to stop them.
  if (!lead) return i - 1;

  const tier = hudTickLandTier(lead);
  if (!tier) return i - 1;

  const e = log[i];
  let units = lead.units;
  let n = 1;
  let j = i - 1;
  while (j >= 0) {
    const p = hudTickLanding(log[j]);
    if (!p) break;                                  // any other kind ends the run
    if (!hudTickLandTier(p)) { j--; continue; }     // invisible: step over it
    if (p.pid !== lead.pid || p.place !== lead.place || p.from !== lead.from) break;
    if (Math.abs(e.tick - log[j].tick) > HUD_TICKER_COALESCE_TICKS) break;
    units += p.units;
    n++;
    j--;
  }

  const text = lead.pid + ' puts ' + hudTickNum(units) + ' ashore at ' +
    lead.place + ' against ' + lead.from;

  rows.push({
    key: 'landing@' + e.tick + '+' + n + '|' + text,
    kind: 'landing', weight: tier,
    tick: e.tick, tokens: hudTickTokens(text),
  });
  return j;
}

// One decimal below 10, whole numbers above. A MERGED row prints a SUM of the
// logged values rather than one of them, so the ticker has to format a number
// the sim never formatted — but it must format it by the same rule, or a merge
// of "24" and "0.6" prints as "24.6" on one row and "25" on the next.
//
// So call the sim's own formatter (known-issues #9: prefer the canonical
// implementation over a copy, even across layers — render/readout.js already
// reaches into sim privates for exactly this reason). The inline fallback is for
// a page that somehow loaded hud.js without movement.js; it is the same rule,
// and if the two ever disagree the ticker is the wrong place to find out.
function hudTickNum(n) {
  if (typeof _moveLandNum === 'function') return _moveLandNum(n);
  return String(n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
}

// Newest-first display rows, with capture and landing bursts coalesced. Walks
// the log backwards and stops as soon as it has `max` rows — the other 395
// entries are never touched.
function hudTickRows(log, max) {
  const rows = [];
  let i = log.length - 1;
  while (i >= 0 && rows.length < max) {
    const e = log[i];
    if (!e) { i--; continue; }

    if (e.kind === 'landing') { i = hudTickLandRow(log, i, rows); continue; }

    const cap = hudTickCapture(e);
    if (!cap) {
      rows.push({
        key: e.kind + '@' + e.tick + '|' + e.text,
        kind: e.kind || '', weight: hudTickWeight(e.kind),
        tick: e.tick, tokens: hudTickTokens(e.text),
      });
      i--;
      continue;
    }

    // Absorb every earlier capture by the same power inside the window.
    const places = [cap.place];
    const first = cap;
    let mine = hudTickMine(cap);
    let j = i - 1;
    let last = e;
    while (j >= 0) {
      const p = hudTickCapture(log[j]);
      if (!p || p.pid !== cap.pid) break;
      if (Math.abs(e.tick - log[j].tick) > HUD_TICKER_COALESCE_TICKS) break;
      places.push(p.place);
      if (hudTickMine(p)) mine = true;
      last = log[j];
      j--;
    }

    let text;
    if (places.length === 1) {
      text = cap.pid + ' took ' + first.place + ' from ' + first.from;
    } else if (places.length === 2) {
      text = cap.pid + ' took ' + places[0] + ' and ' + places[1];
    } else {
      text = cap.pid + ' took ' + places[0] + ', ' + places[1] +
        ' and ' + (places.length - 2) + ' more';
    }

    rows.push({
      key: 'capture@' + e.tick + '+' + places.length + '|' + text,
      kind: 'capture', weight: mine ? 'mid' : 'minor',
      tick: e.tick, tokens: hudTickTokens(text),
      // `last` is only read for the tick span; kept named so the merge is
      // obvious to the next reader.
      spanFrom: last.tick,
    });
    i = j;
  }
  return rows;
}

// Repaint one row. Children are rebuilt only when the row's identity changed,
// which on a settled board is never — the same discipline as everything else
// in this file.
function hudTickPaint(li, row) {
  while (li.firstChild) li.removeChild(li.firstChild);

  const day = Math.floor((row.tick || 0) / hudTicksPerDay());
  li.appendChild(el('span', 'tick-day', { text: 'd' + day }));

  const body = el('span', 'tick-body');
  for (const t of row.tokens) {
    if (!t.pid || t.pid === 'neutral') {
      body.appendChild(document.createTextNode(t.s));
      continue;
    }
    const sp = el('span', 'tick-power', { text: t.s });
    const c = hudPowerColor(t.pid);
    if (c) sp.style.color = c;
    body.appendChild(sp);
  }
  li.appendChild(body);

  li.setAttribute('data-kind', row.kind);
  li.setAttribute('data-weight', row.weight);
}

function hudTicker(state, nodes) {
  const list = nodes.ticker;
  if (!list) return;

  const log = state.log || [];
  const len = log.length;
  const tail = len ? log[len - 1] : null;
  if (len === _hudTickerLastLen && tail === _hudTickerLastTail) return;
  _hudTickerLastLen = len;
  _hudTickerLastTail = tail;

  const rows = hudTickRows(log, HUD_TICKER_MAX);
  const show = rows.length;

  // Grow/shrink the pool of <li> nodes to match. The list only ever changes by
  // a few entries, so this is a handful of DOM writes on the frames where
  // anything happened and none on the rest.
  while (_hudTickerItems.length < show) {
    const li = el('li', 'ticker-item');
    list.appendChild(li);
    _hudTickerItems.push(li);
    _hudTickerKeys.push(null);
  }
  while (_hudTickerItems.length > show) {
    const li = _hudTickerItems.pop();
    _hudTickerKeys.pop();
    if (li.parentNode) li.parentNode.removeChild(li);
  }

  // Newest first in DOM order. style.css lays .ticker-list out with
  // flex-direction: column-reverse and fades by nth-child, so index 0 is the
  // newest event and reads at the bottom of the stack, brightest.
  for (let i = 0; i < show; i++) {
    if (_hudTickerKeys[i] === rows[i].key) continue;
    _hudTickerKeys[i] = rows[i].key;
    hudTickPaint(_hudTickerItems[i], rows[i]);
  }

  // Enter animation fires on the NEWEST ROW ONLY. Every row's text shifts down
  // by one when an event arrives, so animating on "this <li> changed" would
  // flash the whole column on every capture — the animation has to key off the
  // event being new, not off the node being rewritten. A coalesced row that
  // absorbs another capture gets a new key and re-fires, which is correct: it
  // is a fresh event.
  const topKey = show ? rows[0].key : null;
  if (topKey !== _hudTickerTopKey) {
    _hudTickerTopKey = topKey;
    if (show) {
      const li = _hudTickerItems[0];
      li.classList.remove('is-new');
      void li.offsetWidth;                 // force reflow so the animation restarts
      li.classList.add('is-new');
    }
  }
}

// ── entry point ─────────────────────────────────────────────────────────

function renderHud(state) {
  if (!state) return false;
  const nodes = hudNodes();
  hudStats(state, nodes);
  hudPowerStrip(state, nodes);
  hudTicker(state, nodes);
  return true;
}

// Global export — no modules anywhere in this project.
window.renderHud = renderHud;
