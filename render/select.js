// render/select.js — the entire interaction model of the game.
//
// 00-vision.md §8: "The whole game is played by selecting nodes and clicking
// targets. There is no other verb." Everything in this file exists to serve
// that one sentence:
//
//   select sources  ->  hover a target and read the ETA spread  ->  click once
//
// Three rules that shape every function below:
//
//   1. This file NEVER mutates GAME. The only write path is applyCommand(),
//      the same entry point the AI uses (01-data-schema.md, "Input funnels to
//      applyCommand"). That is what keeps replay and headless testing free.
//   2. This file owns #g-ui and nothing else. Marquee rectangle, selection
//      carets, preview lines and ETA labels all live there. #g-stations,
//      #g-waves and the rest belong to other files and are only ever READ
//      from (hit-testing against data-station / data-owner attributes).
//   3. Every global it depends on — PLAYER, GAME, sendFraction, STATIONS,
//      applyCommand, routeEtaTicks — is read at CALL time with `typeof`, never
//      captured at load time. Top-level `const` in a classic script is not a
//      property of `window` (docs/testing/known-issues.md #3), so `window.X`
//      guards report everything as missing, always. It also means script order
//      between select.js and app/main.js does not matter.
//
// Selection feedback is a small caret ABOVE the node, not a highlight ring —
// read straight off the Virus Wars reference in §8. Cheap to render,
// unambiguous, and it still reads when sixty nodes are selected at once, which
// a ring does not.

'use strict';

// Movement under this many viewBox units between mousedown and mouseup counts
// as a click, not a marquee. Generous, because a click on a node is a commit
// and a twitchy mouse must not turn one into an empty marquee that silently
// clears the selection.
const SEL_CLICK_SLOP = 4;

// Gap in viewBox units between the top of a node's silhouette and the tip of
// its caret.
const SEL_CARET_GAP = 4;
const SEL_CARET_W = 9;
const SEL_CARET_H = 7;

// Currently selected station ids. Never exposed directly — selectedSources()
// returns a sorted copy so no other file can mutate the selection behind our
// back, and so command payloads are deterministic.
const SEL_STATE = {
  selected: new Set(),
  hoverTarget: null,      // station id currently being previewed against
  drag: null,             // { x0, y0, x1, y1, additive, moved }
  wired: false,
  warnedNoPlayer: false,
};

// Cache of each node's silhouette top edge, in the station's local coordinate
// space. Geometry is static once renderBoard() has run, and getBBox() is a
// layout-forcing call, so this is measured once per station and kept.
const SEL_TOP_CACHE = Object.create(null);

// ── globals, all read at call time ──────────────────────────────────────

function selGame() {
  return (typeof GAME !== 'undefined' && GAME) ? GAME : (window.GAME || null);
}

// The power the human is playing. app/main.js sets it; until that file exists
// we fall back to the first non-neutral power so the interaction is drivable in
// the browser during development. The fallback warns once — silently guessing
// the player's identity would be a genuinely confusing bug.
function selPlayer() {
  if (typeof PLAYER !== 'undefined' && PLAYER) return PLAYER;
  if (window.PLAYER) return window.PLAYER;
  if (typeof POWERS !== 'undefined' && POWERS) {
    const ids = Object.keys(POWERS).sort().filter(function (p) { return p !== 'neutral'; });
    if (ids.length) {
      if (!SEL_STATE.warnedNoPlayer) {
        SEL_STATE.warnedNoPlayer = true;
        console.warn('[render/select] PLAYER is not defined — falling back to "' +
          ids[0] + '". app/main.js should set it.');
      }
      return ids[0];
    }
  }
  return null;
}

// Persistent 25/50/75/All setting (§8: "Set once, not per attack"). Owned by
// app/main.js; the tuning default stands in until then.
function selFraction() {
  if (typeof sendFraction === 'function') return sendFraction();
  if (typeof window.sendFraction === 'function') return window.sendFraction();
  return (typeof BAL !== 'undefined' && BAL) ? BAL.SEND_FRACTION_DEFAULT : 0.75;
}

// Live ownership. State is authoritative once a game exists; before that the
// static SETUP is the only truth there is, which is what makes the board
// clickable before app/main.js lands.
function selOwnerOf(sid) {
  const g = selGame();
  if (g && g.stations && g.stations[sid]) return g.stations[sid].owner;
  if (typeof SETUP !== 'undefined' && SETUP && SETUP[sid]) return SETUP[sid].owner;
  return null;
}

function selIsMine(sid) {
  const me = selPlayer();
  return !!me && selOwnerOf(sid) === me;
}

function selStationPos(sid) {
  if (typeof STATIONS === 'undefined' || !STATIONS || !STATIONS[sid]) return null;
  const p = STATIONS[sid].pos;
  return (p && p.length >= 2) ? p : null;
}

function selAllStationIds() {
  if (typeof STATIONS === 'undefined' || !STATIONS) return [];
  return Object.keys(STATIONS).sort();
}

// ── #g-ui layer plumbing ────────────────────────────────────────────────

// renderBoard() clears #g-ui wholesale, so the containers are re-created on
// demand rather than once at init. Cheap, and it means a board rebuild can
// never leave this file drawing into a detached node.
function selLayer(id, cls) {
  const ui = byId('g-ui');
  if (!ui) return null;
  let g = ui.querySelector('#' + id);
  if (!g || g.parentNode !== ui) {
    g = el('g', cls, { id: id });
    ui.appendChild(g);
  }
  return g;
}

function selClearNode(node) {
  if (node) while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// Top edge of a station's silhouette in its own local space (roughly -radius).
// Measured from the real DOM so the caret sits correctly above every one of the
// four type shapes without this file duplicating map.js's geometry.
function selNodeTop(sid) {
  if (sid in SEL_TOP_CACHE) return SEL_TOP_CACHE[sid];
  let top = -14;
  const shape = document.querySelector(
    '#g-stations [data-station="' + sid + '"] .station-shape');
  if (shape && shape.getBBox) {
    try { top = shape.getBBox().y; } catch (e) { /* not laid out yet */ }
  }
  SEL_TOP_CACHE[sid] = top;
  return top;
}

// ── selection rendering — carets, not rings (§8) ────────────────────────

function selDrawCarets(noRouteSet) {
  const layer = selClearNode(selLayer('sel-carets', 'sel-carets'));
  if (!layer) return;
  for (const sid of selectedSources()) {
    const pos = selStationPos(sid);
    if (!pos) continue;
    const y = pos[1] + selNodeTop(sid) - SEL_CARET_GAP;
    const x = pos[0];
    const half = SEL_CARET_W / 2;
    // Downward-pointing caret: the tip touches the node it is marking, so with
    // dozens selected it still reads as "these ones" and not as noise.
    const cls = 'sel-caret' +
      ((noRouteSet && noRouteSet[sid]) ? ' is-noroute' : '');
    layer.appendChild(el('path', cls, {
      d: 'M' + (x - half) + ',' + (y - SEL_CARET_H) +
         ' L' + (x + half) + ',' + (y - SEL_CARET_H) +
         ' L' + x + ',' + y + ' Z',
      'data-caret': sid,
    }));
  }
}

// ── preview lines — the thing that makes a volley legible ───────────────
//
// §8: "Stacks arrive staggered, not synchronised… this makes defeat in detail
// the defining mistake of the game." The preview is what puts the information
// needed to avoid that mistake on screen before the click, so the ETAs here
// MUST come from the sim's own helper — routeEtaTicks() in sim/commands.js,
// which is also what applyCommand() stamps onto each wave. A preview that
// disagrees with what actually happens is worse than no preview at all.
function selPreviewRows(target) {
  const rows = [];
  const sources = selectedSources();
  if (!sources.length || !target) return rows;

  const frac = selFraction();
  const g = selGame();
  const routeFn = (typeof commandRoute === 'function') ? commandRoute : null;
  const etaFn = (typeof routeEtaTicks === 'function') ? routeEtaTicks : null;

  for (const sid of sources) {
    if (sid === target) continue;
    const from = selStationPos(sid);
    const to = selStationPos(target);
    if (!from || !to) continue;

    // The payload drives the ETA, because a stack travels at the speed of its
    // slowest unit type — artillery in the volley shows up as a longer line.
    let units = null;
    if (g && g.stations && g.stations[sid] && typeof splitUnits === 'function') {
      units = splitUnits(g.stations[sid].units, frac);
    }

    const path = routeFn ? routeFn(sid, target) : null;
    let eta = null;
    if (path && path.length >= 2 && etaFn) {
      const t = etaFn(path, units || { infantry: 1, artillery: 0, armour: 0 });
      eta = isFinite(t) ? t : null;
    }

    rows.push({
      source: sid, from: from, to: to,
      path: path, eta: eta,
      // applyCommand() will reject an unroutable source outright; showing that
      // before the click is the whole point of drawing it greyed rather than
      // letting the player discover it from a missing wave.
      routable: !!(path && path.length >= 2 && eta !== null),
    });
  }
  return rows;
}

function selDrawPreview(target) {
  const layer = selClearNode(selLayer('sel-preview', 'sel-preview'));
  if (!layer) return;
  if (!target) { selDrawCarets(null); return; }

  const rows = selPreviewRows(target);
  if (!rows.length) { selDrawCarets(null); return; }

  // Slowest routable arrival gets its own treatment. A volley whose lines are
  // all one weight looks fine; a volley with one heavy trailing line looks
  // wrong, which is exactly the signal we want to give before the commit.
  let slowest = null;
  let fastest = null;
  const noRoute = Object.create(null);
  for (const r of rows) {
    if (!r.routable) { noRoute[r.source] = true; continue; }
    if (slowest === null || r.eta > slowest) slowest = r.eta;
    if (fastest === null || r.eta < fastest) fastest = r.eta;
  }
  const spread = (slowest !== null && fastest !== null) ? slowest - fastest : 0;

  for (const r of rows) {
    let cls = 'sel-line';
    if (!r.routable) cls += ' is-noroute';
    else if (r.eta === slowest && spread > 0) cls += ' is-slowest';

    layer.appendChild(el('line', cls, {
      x1: r.from[0], y1: r.from[1], x2: r.to[0], y2: r.to[1],
      'data-preview': r.source,
    }));
  }

  // Labels are laid out separately, each one a fixed DISTANCE out from its own
  // source rather than a fixed fraction along its line. Massing near a front is
  // the central skill (§8), so the common case is a dozen sources bunched
  // together firing at one distant target — and a fixed fraction puts every
  // number in the same square inch, unreadable exactly when the volley is
  // biggest. Anchored near its own node instead, each label inherits the
  // spacing the nodes already have. A small ETA-ranked stagger on top of that
  // separates cities that genuinely are neighbours.
  const ranked = rows.slice().sort(function (a, b) {
    const ea = a.routable ? a.eta : Infinity;
    const eb = b.routable ? b.eta : Infinity;
    return ea - eb;
  });
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const len = Math.max(1, dist(r.from, r.to));
    const t = clamp((26 + (i % 3) * 11) / len, 0.08, 0.62);
    let lcls = 'sel-eta';
    if (!r.routable) lcls += ' is-noroute';
    else if (r.eta === slowest && spread > 0) lcls += ' is-slowest';
    layer.appendChild(el('text', lcls, {
      x: lerp(r.from[0], r.to[0], t),
      y: lerp(r.from[1], r.to[1], t) - 3,
      text: r.routable ? (Math.round(r.eta) + 't') : 'no route',
      'data-preview-eta': r.source,
    }));
  }

  selDrawCarets(noRoute);
}

// ── marquee ─────────────────────────────────────────────────────────────

function selDrawMarquee(d) {
  const layer = selClearNode(selLayer('sel-marquee', 'sel-marquee'));
  if (!layer || !d) return;
  const x = Math.min(d.x0, d.x1);
  const y = Math.min(d.y0, d.y1);
  layer.appendChild(el('rect', 'sel-marquee-rect', {
    x: x, y: y,
    width: Math.abs(d.x1 - d.x0),
    height: Math.abs(d.y1 - d.y0),
  }));
}

function selStationsInRect(d) {
  const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
  const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
  const out = [];
  for (const sid of selAllStationIds()) {
    if (!selIsMine(sid)) continue;                 // only ever your own (§8)
    const p = selStationPos(sid);
    if (!p) continue;
    if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) out.push(sid);
  }
  return out;
}

// ── coordinate conversion ───────────────────────────────────────────────

// Client pixels -> viewBox units. The board scales with the window, so nothing
// in this file may assume 1:1; every hit test goes through here.
function selSvgPoint(evt) {
  const svg = byId('board');
  if (!svg || !svg.createSVGPoint) return null;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return [p.x, p.y];
}

// Station id under the event, or null. Hit-tests the data-station attribute
// map.js stamps on every station <g>. #g-ui is pointer-events:none in CSS, so
// our own carets and preview lines can never swallow a click meant for a node.
function selStationAt(evt) {
  const t = evt.target;
  if (!t || !t.closest) return null;
  const g = t.closest('[data-station]');
  return g ? g.getAttribute('data-station') : null;
}

function selTerritoryAt(evt) {
  const sid = selStationAt(evt);
  if (sid && typeof STATIONS !== 'undefined' && STATIONS[sid]) {
    return STATIONS[sid].territory;
  }
  const t = evt.target;
  if (!t || !t.closest) return null;
  const poly = t.closest('[data-territory]');
  return poly ? poly.getAttribute('data-territory') : null;
}

// ── selection mutation ──────────────────────────────────────────────────

// Drop anything we no longer own. Stations flip mid-selection all the time;
// carrying a lost city in `sources` would just produce a 'not-owned' rejection
// from applyCommand() and a caret over an enemy node. Returns true if the
// selection changed, so callers can skip a redraw when nothing did.
function selPrune() {
  let changed = false;
  for (const sid of Array.from(SEL_STATE.selected)) {
    if (!selIsMine(sid)) { SEL_STATE.selected.delete(sid); changed = true; }
  }
  return changed;
}

function selSet(ids) {
  SEL_STATE.selected = new Set(ids.filter(selIsMine));
  selRedraw();
}

function selToggle(sid) {
  if (SEL_STATE.selected.has(sid)) SEL_STATE.selected.delete(sid);
  else if (selIsMine(sid)) SEL_STATE.selected.add(sid);
  selRedraw();
}

function selRedraw() {
  if (!SEL_STATE.selected.size) SEL_STATE.hoverTarget = null;
  selDrawPreview(SEL_STATE.hoverTarget);
  if (!SEL_STATE.hoverTarget) selDrawCarets(null);
}

// ── the commit ──────────────────────────────────────────────────────────
//
// One click on any station that is not already a source fires the whole volley
// at it. This is the only place in render/ or app/ that changes the game, and
// it does it by handing a command to the sim — never by touching GAME.
function selCommit(target) {
  const g = selGame();
  const me = selPlayer();
  const sources = selectedSources();
  if (!g || !me || !sources.length || !target) return null;
  if (typeof applyCommand !== 'function') {
    console.warn('[render/select] applyCommand is not loaded — commit dropped');
    return null;
  }

  const cmd = {
    type: 'send',
    owner: me,
    sources: sources,
    target: target,
    fraction: selFraction(),
  };
  const res = applyCommand(g, cmd);

  if (!res || !res.ok) {
    console.warn('[render/select] send rejected:', res && res.reason, res && res.rejected);
  } else if (res.rejected && res.rejected.length) {
    // Partial success is normal — an unroutable source is greyed in the
    // preview, so this is a confirmation rather than a surprise.
    console.log('[render/select] volley sent, ' + res.accepted.length +
      ' of ' + sources.length + ' sources; rejected:', res.rejected);
  }

  // §8: "Every selected source sends its proportion at once, and selection
  // clears." One-shot. Nothing lingers, nothing is standing.
  clearSelection();
  return res;
}

// ── event handlers ──────────────────────────────────────────────────────

function selOnMouseDown(evt) {
  if (evt.button !== 0) return;
  const p = selSvgPoint(evt);
  if (!p) return;
  SEL_STATE.drag = {
    x0: p[0], y0: p[1], x1: p[0], y1: p[1],
    additive: evt.shiftKey,
    station: selStationAt(evt),
    moved: false,
  };
}

function selOnMouseMove(evt) {
  const d = SEL_STATE.drag;
  if (d) {
    const p = selSvgPoint(evt);
    if (!p) return;
    d.x1 = p[0];
    d.y1 = p[1];
    if (Math.abs(d.x1 - d.x0) > SEL_CLICK_SLOP || Math.abs(d.y1 - d.y0) > SEL_CLICK_SLOP) {
      d.moved = true;
    }
    if (d.moved) {
      selDrawMarquee(d);
      // Live feedback: carets appear as the rectangle sweeps over nodes, so you
      // can see what you are about to get without releasing.
      const preview = selStationsInRect(d);
      const base = d.additive ? Array.from(SEL_STATE.selected) : [];
      SEL_STATE.selected = new Set(base.concat(preview).filter(selIsMine));
      SEL_STATE.hoverTarget = null;
      selDrawCarets(null);
    }
    return;
  }

  // Not dragging: hovering. Preview lines only make sense against a station
  // that is not already a source — you cannot volley at yourself.
  if (selPrune()) selRedraw();
  const sid = selStationAt(evt);
  const target = (sid && SEL_STATE.selected.size && !SEL_STATE.selected.has(sid)) ? sid : null;
  if (target !== SEL_STATE.hoverTarget) {
    SEL_STATE.hoverTarget = target;
    selRedraw();
  }
}

function selOnMouseUp(evt) {
  const d = SEL_STATE.drag;
  SEL_STATE.drag = null;
  if (!d) return;
  selClearNode(selLayer('sel-marquee', 'sel-marquee'));

  if (d.moved) {
    // Marquee already applied live in mousemove; just settle the display.
    selRedraw();
    return;
  }

  // --- a click ---
  const sid = selStationAt(evt);

  if (!sid) {
    // Empty ground. Shift-click on nothing is a miss, not a clear.
    if (!evt.shiftKey) clearSelection();
    return;
  }

  if (evt.shiftKey) { selToggle(sid); return; }

  // A click on a station that is NOT a current source commits the volley —
  // enemy, neutral or one of your own cities used as a reinforcement target.
  if (SEL_STATE.selected.size && !SEL_STATE.selected.has(sid)) {
    selCommit(sid);
    return;
  }

  // Otherwise it is a plain single-station selection.
  if (selIsMine(sid)) selSet([sid]);
  else clearSelection();
}

// Double-click a territory selects every station you own in it (§8). The
// preceding single clicks have already run, so this is additive-by-replacement
// rather than a special mode.
function selOnDblClick(evt) {
  const tid = selTerritoryAt(evt);
  if (!tid || typeof STATIONS === 'undefined') return;
  const ids = selAllStationIds().filter(function (sid) {
    return STATIONS[sid] && STATIONS[sid].territory === tid && selIsMine(sid);
  });
  if (!ids.length) return;
  if (evt.shiftKey) selSet(Array.from(SEL_STATE.selected).concat(ids));
  else selSet(ids);
}

function selOnKeyDown(evt) {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (evt.key === 'Escape') {
    clearSelection();
    return;
  }
  if ((evt.ctrlKey || evt.metaKey) && (evt.key === 'a' || evt.key === 'A')) {
    // Select the whole empire. Deliberately not filtered by "has enough units"
    // — applyCommand() rejects the empty ones, and hiding them here would make
    // the count on screen disagree with the empire you actually hold.
    evt.preventDefault();
    selSet(selAllStationIds().filter(selIsMine));
  }
}

// ── pinned API (01-data-schema.md, "Render / app API") ──────────────────

// Sorted array of currently selected station ids. Sorted because applyCommand()
// dedupes and sorts anyway, so matching it here keeps the ids a volley consumes
// independent of the order the player happened to click in.
function selectedSources() {
  return Array.from(SEL_STATE.selected).sort();
}

function clearSelection() {
  SEL_STATE.selected.clear();
  SEL_STATE.hoverTarget = null;
  selClearNode(selLayer('sel-carets', 'sel-carets'));
  selClearNode(selLayer('sel-preview', 'sel-preview'));
  selClearNode(selLayer('sel-marquee', 'sel-marquee'));
}

function initSelection() {
  if (SEL_STATE.wired) return true;
  const svg = byId('board');
  if (!svg) {
    console.error('[render/select] no #board svg — selection not wired');
    return false;
  }

  svg.addEventListener('mousedown', selOnMouseDown);
  svg.addEventListener('dblclick', selOnDblClick);
  // move/up on window, not the svg: a marquee that leaves the board must keep
  // tracking, and releasing outside it must still finish the drag rather than
  // leaving a rectangle stuck on screen.
  window.addEventListener('mousemove', selOnMouseMove);
  window.addEventListener('mouseup', selOnMouseUp);
  window.addEventListener('keydown', selOnKeyDown);
  // Dragging on an SVG otherwise starts a native image drag halfway through
  // the marquee and the mouseup never arrives.
  svg.addEventListener('dragstart', function (e) { e.preventDefault(); });

  SEL_STATE.wired = true;
  console.log('[render/select] selection wired on #board');
  return true;
}

window.initSelection = initSelection;
window.selectedSources = selectedSources;
window.clearSelection = clearSelection;

// Self-bootstrap, matching render/map.js: the board is drivable before
// app/main.js exists. Once the app layer lands it sets APP_OWNS_RENDER and
// calls initSelection() itself; initSelection() is idempotent either way.
document.addEventListener('DOMContentLoaded', function () {
  if (!window.APP_OWNS_RENDER) initSelection();
});
