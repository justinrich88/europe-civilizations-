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
//
// ── the gesture table (player-reported fix, 2026-07) ────────────────────
//
// A plain click used to mean two incompatible things: "add this to the
// selection" and "commit the volley at this". The disambiguator was whether the
// station was already a source, which is invisible mid-gesture — so building a
// multi-source volley regularly fired it at the second city instead. The
// verbs are now split by WHO OWNS the thing you clicked, which is on screen at
// all times:
//
//   left-click a station you OWN        -> toggle it in the selection. NEVER commits.
//   left-click a station you DO NOT own -> attack: every selected source sends.
//   right-click a station you OWN       -> reinforce: every selected source marches.
//   marquee drag / Ctrl+A / shift-click -> unchanged accelerators.
//
// The accident is structurally gone: the gesture that used to send troops to
// one of your own cities no longer sends anything at all.

'use strict';

// Movement under this many viewBox units between mousedown and mouseup counts
// as a click, not a marquee. Generous, because a click on a node is a commit
// and a twitchy mouse must not turn one into an empty marquee that silently
// clears the selection.
//
// The number is calibrated at scale 1, where one viewBox unit is one screen
// pixel-ish. Under the camera it is NOT screen-constant: at 4x the viewBox is
// four times finer, so a raw comparison against 4 units would demand 16 screen
// pixels of travel before a drag counted as a marquee — small marquees at zoom
// would silently commit an attack instead. So the threshold is divided by the
// camera scale where it is COMPARED (selClickSlop), never redefined here: the
// authored value stays "4 units of hand-wobble at 1x" and the conversion to the
// current zoom is one division at the point of use.
const SEL_CLICK_SLOP = 4;

// How far from a click, in viewBox units at scale 1, a station's centre may sit
// and still win the click from whatever node happens to be painted on top.
// Sized to a node silhouette rather than to the whole neighbourhood: large
// enough to cover an occluding neighbour, small enough that it never reaches
// past one. See selStationAt().
const SEL_STATION_PICK_RADIUS = 14;

// Gap in viewBox units between the top of a node's silhouette and the tip of
// its caret.
const SEL_CARET_GAP = 4;
const SEL_CARET_W = 9;
const SEL_CARET_H = 7;

// Transit chevron, hung below a node the route passes THROUGH. Same units and
// the same counter-scaling as the caret, so the two annotations stay the same
// size as each other at every zoom.
const SEL_TRANSIT_GAP = 2.5;
const SEL_TRANSIT_W = 5.5;

// Currently selected station ids. Never exposed directly — selectedSources()
// returns a sorted copy so no other file can mutate the selection behind our
// back, and so command payloads are deterministic.
const SEL_STATE = {
  selected: new Set(),
  hoverTarget: null,      // station id currently being previewed against
  drag: null,             // { x0, y0, x1, y1, additive, moved }
  rdrag: null,            // { cx, cy, station, moved } — right button, in client px
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

// Which unit kinds the volley may include, or null for all of them. Owned by
// app/main.js beside sendFraction() and read the same way — at call time, with
// typeof, so this file works whether or not that control exists.
function _selTypes() {
  if (typeof sendTypes === 'function') return sendTypes();
  if (typeof window.sendTypes === 'function') return window.sendTypes();
  return null;
}

// The payload a source would actually send: its proportion, narrowed to the
// enabled kinds. Used for the preview ETA and mirrored by applyCommand — a
// preview that ignored the type filter would show an infantry-speed ETA for a
// volley the player has restricted to artillery.
function _selPayload(units) {
  const frac = selFraction();
  if (!units || typeof splitUnits !== 'function') return null;
  const take = splitUnits(units, frac);
  const types = _selTypes();
  if (!Array.isArray(types) || !types.length) return take;
  const keep = Object.create(null);
  for (const t of types) keep[t] = true;
  return {
    infantry: keep.infantry ? take.infantry : 0,
    artillery: keep.artillery ? take.artillery : 0,
    armour: keep.armour ? take.armour : 0,
  };
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

// ── camera ──────────────────────────────────────────────────────────────
//
// Everything this file draws is a SYMBOL — carets and ETA labels annotate the
// board, they are not part of it — so all of it is counter-scaled by
// cameraSymbolScale() about its own anchor and holds a constant on-screen size
// at every zoom. Preview LINES are geometry between two stations and are left
// alone; their stroke is held constant by vector-effect in style.css.
//
// Both helpers are typeof-guarded at call time, like every other global here:
// render/camera.js is optional and loads after this file.

function selSymbolScale() {
  return (typeof cameraSymbolScale === 'function') ? cameraSymbolScale() : 1;
}

function selCamScale() {
  return (typeof cameraScale === 'function') ? cameraScale() : 1;
}

// SEL_CLICK_SLOP is authored in viewBox units at scale 1; dividing by the
// current scale is what makes it a constant number of SCREEN pixels.
function selClickSlop() {
  const s = selCamScale();
  return (isFinite(s) && s > 0) ? SEL_CLICK_SLOP / s : SEL_CLICK_SLOP;
}

// translate(x,y) scale(k) — the counter-scale is applied about (x,y), so the
// symbol shrinks toward its anchor rather than sliding toward the origin.
function selSymbolTransform(x, y) {
  const k = selSymbolScale();
  const t = 'translate(' + x + ',' + y + ')';
  return (k === 1) ? t : t + ' scale(' + (Math.round(k * 100000) / 100000) + ')';
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

// Bottom edge of a station's silhouette in its own local space. Same
// measurement and same cache discipline as selNodeTop(), used to hang the
// transit marker UNDER a node: a marker on the node's centre covers the
// garrison number, and §8 is explicit that the number is the interface. The
// selection caret owns the space above; transit gets the space below, so the
// two annotations never collide on a city that is both.
const SEL_BOT_CACHE = Object.create(null);

function _selNodeBottom(sid) {
  if (sid in SEL_BOT_CACHE) return SEL_BOT_CACHE[sid];
  let bot = 14;
  const shape = document.querySelector(
    '#g-stations [data-station="' + sid + '"] .station-shape');
  if (shape && shape.getBBox) {
    try { const b = shape.getBBox(); bot = b.y + b.height; } catch (e) { /* not laid out */ }
  }
  SEL_BOT_CACHE[sid] = bot;
  return bot;
}

// ── selection rendering — carets, not rings (§8) ────────────────────────

function selDrawCarets(noRouteSet) {
  const layer = selClearNode(selLayer('sel-carets', 'sel-carets'));
  if (!layer) return;
  for (const sid of selectedSources()) {
    const pos = selStationPos(sid);
    if (!pos) continue;
    // Drawn in the STATION's local space and anchored at the station with
    // translate+scale, rather than in absolute board coordinates. selNodeTop()
    // is a local measurement (roughly -radius) and the station itself is now
    // counter-scaled by the same factor, so the caret tip tracks the shrinking
    // silhouette instead of floating away from it as the camera zooms.
    const y = selNodeTop(sid) - SEL_CARET_GAP;
    const half = SEL_CARET_W / 2;
    // Downward-pointing caret: the tip touches the node it is marking, so with
    // dozens selected it still reads as "these ones" and not as noise.
    const cls = 'sel-caret' +
      ((noRouteSet && noRouteSet[sid]) ? ' is-noroute' : '');
    layer.appendChild(el('path', cls, {
      d: 'M' + (-half) + ',' + (y - SEL_CARET_H) +
         ' L' + half + ',' + (y - SEL_CARET_H) +
         ' L0,' + y + ' Z',
      transform: selSymbolTransform(pos[0], pos[1]),
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

// ── intent and colour ───────────────────────────────────────────────────
//
// The verb is decided by who owns the hovered station, exactly as the gesture
// table decides which button commits it. Attack is red; reinforce wears the
// player's own ownership colour. That is the whole colour vocabulary of the
// preview — the ETA spread, which used to be carried by colour, is now carried
// by stroke weight and opacity so the two signals stop competing.

function _selIntentFor(target) {
  return (target && selIsMine(target)) ? 'reinforce' : 'attack';
}

// The friendly line colour, read from POWERS at call time. render/map.js has a
// powerColor() but it takes an opaque data bundle as its first argument; the
// scenario table is the shared source both of them read, so this file reads it
// directly rather than depending on another renderer's signature.
function _selFriendlyColor() {
  const me = selPlayer();
  if (me && typeof POWERS !== 'undefined' && POWERS && POWERS[me] && POWERS[me].color) {
    return POWERS[me].color;
  }
  return null;
}

// ── routing for the preview ─────────────────────────────────────────────
//
// OWNERSHIP-AWARE, always. routeBetween()/commandRoute() with two arguments is
// the geography-only answer: it will happily trace a line straight through an
// enemy city that applyCommand() then rejects as 'no-route', and a preview that
// promises a march the commit refuses is worse than no preview at all.
//
// routeFor() is preferred directly; commandRoute(a, b, state, pid) is the same
// answer one indirection away and is the fallback for load orders where
// sim/movement.js has not arrived.
function _selRoutePath(sid, target) {
  const g = selGame();
  const me = selPlayer();
  if (!g || !me || !sid || !target || sid === target) return null;
  if (typeof routeFor === 'function') return routeFor(g, me, sid, target);
  if (typeof commandRoute === 'function') return commandRoute(sid, target, g, me);
  return null;
}

// A route is a list of station ids; this is the same list as board points. Any
// station missing a position kills the polyline rather than producing a bent
// line with a phantom corner at the origin.
function _selPathPoints(path) {
  if (!path || path.length < 2) return null;
  const pts = [];
  for (let i = 0; i < path.length; i++) {
    const p = selStationPos(path[i]);
    if (!p) return null;
    pts.push(p);
  }
  return pts;
}

function _selPolyPoints(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) out.push(pts[i][0] + ',' + pts[i][1]);
  return out.join(' ');
}

// Point at arc-length `d` from the start of the polyline, so an ETA label sits
// ON the route it annotates rather than on the straight line between the
// endpoints — which, on a bent route, is somewhere the wave never goes.
function _selPointAlong(pts, d) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  if (!(total > 0)) return pts[0];
  const want = clamp(d, total * 0.06, total * 0.62);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (acc + seg >= want) {
      const t = seg > 0 ? (want - acc) / seg : 0;
      return [lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)];
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}

function selPreviewRows(target) {
  const rows = [];
  const sources = selectedSources();
  if (!sources.length || !target) return rows;

  const g = selGame();
  const etaFn = (typeof routeEtaTicks === 'function') ? routeEtaTicks : null;

  for (const sid of sources) {
    if (sid === target) continue;
    const from = selStationPos(sid);
    const to = selStationPos(target);
    if (!from || !to) continue;

    // The payload drives the ETA, because a stack travels at the speed of its
    // slowest unit type — artillery in the volley shows up as a longer line.
    // The payload drives the ETA AND the refusal test, so it must be the same
    // bundle applyCommand() will build: the fraction narrowed to the unit kinds
    // the INF/ART/ARM toggles have left on.
    let units = null;
    if (g && g.stations && g.stations[sid]) units = _selPayload(g.stations[sid].units);

    const path = _selRoutePath(sid, target);
    const pts = _selPathPoints(path);
    let eta = null;
    if (pts && etaFn) {
      const t = etaFn(path, units || { infantry: 1, artillery: 0, armour: 0 });
      eta = isFinite(t) ? t : null;
    }

    // The refusal REASON is computed here rather than left as a bare "no", and
    // it mirrors applyCommand()'s own per-source checks in the same order. A
    // source the commit will drop must say so before the click; discovering it
    // from a wave that never appeared is the failure this whole row exists to
    // prevent.
    let refusal = null;
    if (!path || path.length < 2) refusal = 'no route';
    else if (eta === null) refusal = 'no route';
    else if (units && typeof totalUnits === 'function' &&
             typeof BAL !== 'undefined' && BAL &&
             totalUnits(units) < BAL.MIN_SEND_UNITS) {
      refusal = 'too few';
    }

    rows.push({
      source: sid, from: from, to: to,
      path: path, points: pts, eta: eta,
      refusal: refusal,
      routable: !refusal,
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

  const intent = _selIntentFor(target);
  const friendly = (intent === 'reinforce') ? _selFriendlyColor() : null;

  // Slowest routable arrival gets its own treatment. A volley whose lines are
  // all one weight looks fine; a volley with one heavy trailing line looks
  // wrong, which is exactly the signal we want to give before the commit.
  // WEIGHT, not colour — colour now says attack-or-reinforce.
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
    if (!r.routable) {
      // A refused source is DRAWN, not omitted. Silence would read as "that one
      // is fine", and the player would only learn otherwise from a missing
      // wave. Straight and dashed, because there is no route to trace.
      layer.appendChild(el('line', 'sel-line is-refused', {
        x1: r.from[0], y1: r.from[1], x2: r.to[0], y2: r.to[1],
        'data-preview': r.source,
        'data-refused': r.source,
        'data-refused-reason': r.refusal,
      }));
      // ✕ over the source itself, counter-scaled like every other symbol, so a
      // refusal is visible at the node you are looking at and not only at the
      // far end of a faint line.
      const k = 4;
      layer.appendChild(el('path', 'sel-refused-mark', {
        d: 'M' + (-k) + ',' + (-k) + ' L' + k + ',' + k +
           ' M' + (-k) + ',' + k + ' L' + k + ',' + (-k),
        transform: selSymbolTransform(r.from[0], r.from[1]),
        'data-refused-mark': r.source,
      }));
      continue;
    }

    // ONE SEGMENT PER HOP. The wave walks the link graph, so the preview walks
    // it too — if the only legal way from Berlin to Paris is through Cologne,
    // the line bends at Cologne and the player can see the transit before
    // committing to it. This is the whole of task 2.
    let cls = 'sel-path is-' + intent;
    if (r.eta === slowest && spread > 0) cls += ' is-slowest';
    const poly = el('polyline', cls, {
      points: _selPolyPoints(r.points),
      'data-preview': r.source,
      'data-hops': r.points.length,
    });
    // Inline, not a class: the friendly colour is per-power data, computed at
    // draw time. known-issues #15 — a stylesheet class beats a presentation
    // attribute, so anything a renderer computes goes in .style.
    if (friendly) poly.style.stroke = friendly;
    layer.appendChild(poly);

    // Intermediate cities get an explicit mark. A bend alone is ambiguous —
    // it could be map geometry — and §8's "multi-hop is allowed" only helps if
    // you can see WHICH cities you are marching through.
    //
    // Hung BELOW the silhouette rather than on the node's centre: the garrison
    // number is the interface (§8) and a marker sitting over it costs more than
    // the marker gains. Caret above, transit below, number untouched.
    for (let h = 1; h < r.points.length - 1; h++) {
      const tp = r.points[h];
      const y = _selNodeBottom(r.path[h]) + SEL_TRANSIT_GAP;
      const w = SEL_TRANSIT_W;
      // Upward chevron: it points back at the city it belongs to, and several
      // routes converging on one transit hub stack into a readable pile of
      // chevrons rather than one smeared blob.
      const dot = el('path', 'sel-transit is-' + intent, {
        d: 'M' + (-w) + ',' + (y + w) + ' L0,' + y + ' L' + w + ',' + (y + w),
        transform: selSymbolTransform(tp[0], tp[1]),
        'data-transit': r.source + '>' + r.path[h],
      });
      if (friendly) dot.style.stroke = friendly;
      layer.appendChild(dot);
    }
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
    const off = 26 + (i % 3) * 11;
    // Along the ROUTE for a routable source, along the straight line for a
    // refused one — a refused source has no route to walk.
    const anchor = r.routable
      ? _selPointAlong(r.points, off)
      : (function () {
          const len = Math.max(1, dist(r.from, r.to));
          const t = clamp(off / len, 0.08, 0.62);
          return [lerp(r.from[0], r.to[0], t), lerp(r.from[1], r.to[1], t)];
        })();

    let lcls = 'sel-eta';
    if (!r.routable) lcls += ' is-refused';
    else {
      lcls += ' is-' + intent;
      if (r.eta === slowest && spread > 0) lcls += ' is-slowest';
    }
    // Same treatment as the carets: the position goes in the transform and the
    // text sits at the local origin, so the label counter-scales about the
    // point on the route it is annotating. The -3 lift is inside the scaled
    // space so it stays 3 screen units clear of the line at every zoom.
    const label = el('text', lcls, {
      x: 0, y: -3,
      transform: selSymbolTransform(anchor[0], anchor[1]),
      text: r.routable ? (Math.round(r.eta) + 't') : r.refusal,
      'data-preview-eta': r.source,
    });
    if (r.routable && friendly) label.style.fill = friendly;
    layer.appendChild(label);
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
// Resolve ties by NEAREST CENTRE, not by paint order.
//
// SVG has no z-index, so the station drawn last wins `elementFromPoint`, and on
// this map that is decided by nothing more meaningful than id order. Two
// measured casualties at scale 1: Aalborg's centre is covered by Aarhus (22.9px
// apart) and Aberdeen's by Newcastle. Clicking either one targeted its
// neighbour — so those cities could not be attacked at all without zooming in
// first, and the failure is silent and looks exactly like a misclick. The
// station relaxation pass in tools/build-stations.js still leaves 77
// overlapping pairs, so this is a property of the map, not of two bad cities.
//
// The override only fires when the DOM hit already found a station, so clicking
// empty territory still returns null and the marquee still starts where it did.
function selStationAt(evt) {
  const t = evt.target;
  if (!t || !t.closest) return null;
  const g = t.closest('[data-station]');
  if (!g) return null;
  const domSid = g.getAttribute('data-station');

  const p = selSvgPoint(evt);
  if (!p) return domSid;

  // Node silhouettes are a few units across, so a centre within this radius of
  // the click is a genuine rival for it rather than a distant station stolen
  // from across the map.
  const reach = SEL_STATION_PICK_RADIUS / (selCamScale() || 1);
  let best = domSid;
  let bestD = Infinity;
  const home = selStationPos(domSid);
  if (home) bestD = Math.hypot(p[0] - home[0], p[1] - home[1]);

  const ids = selAllStationIds();
  for (let i = 0; i < ids.length; i++) {
    const pos = selStationPos(ids[i]);
    if (!pos) continue;
    const d = Math.hypot(p[0] - pos[0], p[1] - pos[1]);
    // Strictly nearer, and ties break on the id already under the cursor, so
    // the result never flickers between two equidistant nodes.
    if (d < bestD - 1e-9 && d <= reach) { bestD = d; best = ids[i]; }
  }
  return best;
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
  // Omitted entirely when every kind is on: "no filter" and "every filter" are
  // the same volley, and leaving the field off keeps the command object
  // byte-identical to the ones every existing replay and test already contains.
  const types = _selTypes();
  if (Array.isArray(types) && types.length) cmd.types = types;
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

// Right-button travel, in CLIENT PIXELS, past which the press was a camera pan
// and not a reinforce order. Pixels rather than viewBox units on purpose: a
// right-drag pan MOVES THE VIEWBOX under the cursor, so a board-unit
// measurement of that gesture is taken against a ruler that is itself sliding.
const SEL_RCLICK_SLOP_PX = 4;

function selOnMouseDown(evt) {
  // Right button. render/camera.js pans with it, and on macOS `contextmenu`
  // fires at MOUSEDOWN time — before any movement exists to measure — so a
  // reinforce wired to contextmenu would fire a volley at whatever node the pan
  // happened to start on. That is the exact accident this whole change exists
  // to remove, reintroduced by the fix for it. So the order is decided at
  // MOUSEUP, once we know whether the press turned into a drag.
  if (evt.button === 2) {
    SEL_STATE.rdrag = {
      cx: evt.clientX, cy: evt.clientY,
      station: selStationAt(evt),
      moved: false,
    };
    return;
  }
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
  const rd = SEL_STATE.rdrag;
  if (rd && !rd.moved) {
    if (Math.abs(evt.clientX - rd.cx) > SEL_RCLICK_SLOP_PX ||
        Math.abs(evt.clientY - rd.cy) > SEL_RCLICK_SLOP_PX) {
      rd.moved = true;              // this is a camera pan; it will not commit
    }
  }

  const d = SEL_STATE.drag;
  if (d) {
    const p = selSvgPoint(evt);
    if (!p) return;
    d.x1 = p[0];
    d.y1 = p[1];
    // Screen-constant threshold, not viewBox-constant — see SEL_CLICK_SLOP.
    const slop = selClickSlop();
    if (Math.abs(d.x1 - d.x0) > slop || Math.abs(d.y1 - d.y0) > slop) {
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
  selSetFocus(sid);
  const target = (sid && SEL_STATE.selected.size && !SEL_STATE.selected.has(sid)) ? sid : null;
  if (target !== SEL_STATE.hoverTarget) {
    SEL_STATE.hoverTarget = target;
    selRedraw();
  }
}

// ---------------------------------------------------------------------------
// Hover focus — the one place that decides what the readout and the coverage
// overlay are describing.
//
// 01-data-schema.md: "render/select.js owns pointer handling on #board.
// Readout and coverage focus are driven FROM it; neither file attaches its own
// board-wide listener, or two handlers fight over the same hover." So this
// function exists, rather than each panel listening for itself.
//
// Both calls are typeof-guarded: render/coverage.js and render/readout.js are
// optional, and the board must work with either absent.
let SEL_FOCUS = null;

function selSetFocus(sid) {
  if (sid === SEL_FOCUS) return;          // hover fires constantly; do nothing
  SEL_FOCUS = sid;

  if (typeof setReadoutFocus === 'function') setReadoutFocus(sid);

  // Coverage is filtered HERE rather than inside coverage.js. Its pinned
  // contract is "the reach of one multiplier station", so handing it a city id
  // and relying on it to ignore that would be reading an obligation into the
  // contract that is not written down.
  if (typeof setCoverageFocus === 'function') {
    const isMul = sid && typeof STATIONS !== 'undefined' &&
                  STATIONS[sid] && STATIONS[sid].type === 'multiplier';
    setCoverageFocus(isMul ? sid : null);
  }
}

function selOnMouseUp(evt) {
  if (evt.button === 2) {
    const rd = SEL_STATE.rdrag;
    SEL_STATE.rdrag = null;
    if (rd && !rd.moved) selReinforce(rd.station);
    return;
  }

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

  // THE GESTURE TABLE. Ownership decides the verb, and ownership is the one
  // thing that is on screen throughout the gesture.
  //
  // A station you own: TOGGLE, and nothing else, ever. This is the fix for the
  // reported bug — building a five-city volley used to fire it at city two,
  // because the second left-click was read as a commit the moment city one was
  // a source. There is now no left-click anywhere that sends troops to your own
  // ground, so the accident has nowhere to happen.
  if (selIsMine(sid)) { selToggle(sid); return; }

  // A station you do not own: ATTACK. Every selected source commits at it.
  if (SEL_STATE.selected.size) { selCommit(sid); return; }

  // Nothing selected and it is not yours — a plain deselecting click.
  clearSelection();
}

// Right-click = REINFORCE / move, and only onto ground you own. Split off from
// the left button precisely because the left button must never send troops to
// your own cities again; the friendly march is a real order and needs a verb of
// its own rather than a mode.
//
// Called from mouseup, not from contextmenu — see selOnMouseDown.
function selReinforce(sid) {
  if (!sid) return;
  if (!SEL_STATE.selected.size) return;
  // Only onto your own ground. Right-clicking an enemy is a mis-aimed
  // reinforcement, not a sneaky second way to attack — one verb, one gesture.
  if (!selIsMine(sid)) return;
  // The only selected source IS the destination: there is nothing to march.
  if (SEL_STATE.selected.has(sid) && SEL_STATE.selected.size === 1) return;
  selCommit(sid);
}

// preventDefault() unconditionally on the board: a context menu appearing
// mid-order is worse than useless, and it appears whether or not the press
// landed on a station. This handler does nothing else — the order is decided in
// selOnMouseUp, which is the only place that knows the press was not a pan.
function selOnContextMenu(evt) {
  evt.preventDefault();
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
  // Reinforce. On the svg, not the window, so the rest of the page keeps its
  // native menu; preventDefault lives inside the handler and fires for every
  // right-click on the board, station or not.
  svg.addEventListener('contextmenu', selOnContextMenu);
  // move/up on window, not the svg: a marquee that leaves the board must keep
  // tracking, and releasing outside it must still finish the drag rather than
  // leaving a rectangle stuck on screen.
  window.addEventListener('mousemove', selOnMouseMove);
  window.addEventListener('mouseup', selOnMouseUp);
  window.addEventListener('keydown', selOnKeyDown);
  // Dragging on an SVG otherwise starts a native image drag halfway through
  // the marquee and the mouseup never arrives.
  svg.addEventListener('dragstart', function (e) { e.preventDefault(); });

  // Carets and ETA labels are drawn on demand, not per frame, so a zoom would
  // otherwise leave them at the old scale until the next hover — and with the
  // game paused, forever.
  //
  // Keyed on the SYMBOL SCALE, not on "the camera moved": an arrow-key pan
  // fires this ~60 times a second at an unchanged zoom, and rebuilding the
  // carets and every preview line on each of those frames is pure waste. Only a
  // zoom invalidates what is drawn; a pan does not.
  if (typeof onCameraChange === 'function') {
    let lastK = selSymbolScale();
    onCameraChange(function () {
      const k = selSymbolScale();
      if (k === lastK) return;
      lastK = k;
      if (SEL_STATE.selected.size) selRedraw();
    });
  }

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
