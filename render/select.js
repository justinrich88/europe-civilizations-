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
//   H / R / F (no modifier)             -> standing order on the whole selection,
//                                          which SURVIVES. See _selApplyOrder.
//
// ONE EXCEPTION, and it suspends the first three rows: while a supply order is
// ARMED (R pressed), EITHER button clicking a city you own names the
// destination and nothing marches. See _selCommitArmed, which owns that rule
// for both buttons and explains why the right one is in it.
//
// The accident is structurally gone: the gesture that used to send troops to
// one of your own cities no longer sends anything at all.
//
// ── commit-time modifier (player-reported, 2026-07; amended 2026-07) ────
//
// "It needs to be something that can happen very quickly as the player is making
// many moves in parallel." The persistent 25/50/75/All setting is a DEFAULT the
// player sets with the digits 1-4 (app/main.js) — it stays wherever they leave
// it, across volleys, until they change it again. SHIFT (all) and ALT (half)
// used to exist as commit-time overrides of that setting, decided at the click
// instead of at the corner of the screen. Both are now DELETED: the digits do
// that job with one hand and no key held while aiming, and SHIFT already meant
// additive-selection on the same pointer. See app/main.js, "shift = all / alt =
// half commit-time modifiers are DELETED", for the full reasoning.
//
// What is left:
//
//   plain click        -> the persistent fraction (the common case)
//   CMD/META + click   -> commit and KEEP the selection, to fire the same
//                         massed group at the next target without reselecting
//
// CMD works on the RIGHT button too, so reinforce gets it as well.
//
// CMD was measured arriving intact on this platform: a synthetic cmd-click on
// #board produced mousedown/mouseup with the flag set and no default action.
// CTRL is unusable on macOS: a ctrl-click fires `contextmenu` between
// mousedown and mouseup — it IS the secondary click — so a ctrl+left gesture
// is indistinguishable from a right-click by the time it reaches us.

'use strict';

// Movement under this many viewBox units between mousedown and mouseup counts
// as a click, not a marquee. Generous, because a click on a node is a commit
// and a twitchy mouse must not turn one into an empty marquee that silently
// clears the selection.
//
// It has to be screen-constant, because hand-wobble is: at 4x the viewBox is
// four times finer, so comparing against a raw unit count would demand four
// times the travel before a drag counted as a marquee, and small marquees at
// zoom would silently commit an attack instead. It is therefore authored in
// SCREEN pixels and converted at the point of comparison — see selClickSlop(),
// which also explains why converting by camera scale alone was not enough.
// 5px at the 1156px-wide reference board is the 4 units this shipped as.
// 5px at the 1156px-wide reference board is the 4 units this shipped as.
const SEL_CLICK_SLOP_PX = 5;

// How far from a click, in SCREEN PIXELS, a station's centre may sit and still
// win the click from whatever node happens to be painted on top. Sized to a
// node silhouette on screen, which is the scale the player's aim actually works
// at. 16px at the 1156px-wide reference board is the 14 units this shipped as.
// Over-reach is not a hazard here: the rule picks the NEAREST centre within the
// radius, so a wider reach only widens the candidate set -- it cannot pick a
// node further away than the one it picks today. See selStationAt().
const SEL_STATION_PICK_RADIUS_PX = 16;

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
  armed: null,            // 'reinforce' | 'defend' — a standing order awaiting its
                          // destination click. See _selArmOrder.
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

// The 25/50/75/All send amount, picked with the digits 1-4. Owned by
// app/main.js; the tuning default stands in until then.
//
// PERSISTENT: the amount stays wherever the player last set it until they
// change it again — 25% is only the opening value, not something the game
// resets back to. The player is choosing the amount for a SITUATION, not for
// a single click, and a bar displaying a number the next click would not use
// is known-issue #18 in its purest form. See BAL.SEND_FRACTION_DEFAULT.
function selFraction() {
  if (typeof sendFraction === 'function') return sendFraction();
  if (typeof window.sendFraction === 'function') return window.sendFraction();
  return (typeof BAL !== 'undefined' && BAL) ? BAL.SEND_FRACTION_DEFAULT : 0.75;
}

// ── the commit-time modifier ────────────────────────────────────────────
//
// Live modifier state, refreshed from every mousemove, keydown and keyup and
// read again off the click itself, so the decision that fires is the one the
// click carried and not the one a stale keyup left behind.
//
// ONLY CMD REMAINS. Shift = all and Alt = half are deleted: the digits 1-4 set
// the amount with one hand and no key held while aiming, and shift already
// meant additive-select on the same pointer. `meta` is not an amount — it is
// "the group survives this volley" — so nothing replaces it.
const SEL_MOD = { meta: false };

// Fold an event's modifier flags into SEL_MOD. Returns true if anything changed,
// so callers can skip a redraw on the ~60 no-op mousemoves a second.
function _selSyncMods(evt) {
  const m = !!(evt && evt.metaKey);
  if (m === SEL_MOD.meta) return false;
  SEL_MOD.meta = m;
  return true;
}

// What this volley would actually use. One number, from the button row, and no
// longer overridable at the click — the amount is chosen before you aim.
function selEffectiveFraction() {
  return selFraction();
}

// The payload a source would actually send. Must be the same bundle
// applyCommand() will build from `fraction`, because it drives the preview ETA
// (a stack travels at the speed of its slowest kind), the refusal test, and the
// payload label — a preview that disagrees with the commit is worse than none.
//
// sendPayload() rather than a bare multiplication: sim/commands.js holds a unit back so a
// city can never be emptied to zero and left unable to regrow, and the preview
// must show the number that will actually leave. Multiplying here would
// be the two-expressions-that-happen-to-agree arrangement known-issue #18 is
// about — it agreed for a year, and then it did not.
function _selPayload(units) {
  if (!units) return null;
  if (typeof sendPayload === 'function') return sendPayload(units, selEffectiveFraction());
  return units * selEffectiveFraction();
  return null;
}

// The amount changed under a stationary cursor (app/main.js calls this from
// setSendFraction). Only the preview depends on it, and only when there is one.
function selOnFractionChange() {
  if (SEL_STATE && SEL_STATE.hoverTarget) selRedraw();
}

// ── payload label (00-vision.md §8, "the number is the interface") ──────
//
// The fraction setting is in the corner of the screen and the player is looking
// at the map, so each preview line carries what it will actually send. Compact,
// because it sits beside the ETA on a line that may be one of a dozen.



// One significant decimal below 10, whole numbers above it. Garrisons are
// continuous (logistic growth), so "8" for 8.4 units is a lie the player can
// check against the readout; "34" for 34.2 is not worth the extra glyph.
function _selFmtQty(v) {
  if (!(v > 0)) return '0';
  return String(v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
}

// The preview label under a route line. It used to spell out the volley's
// COMPOSITION ("12 inf · 4 art"); with one unit type there is nothing to spell,
// so it is the count and the word.
//
// 0.05 rather than 0: a payload that rounds to "0" adds a glyph and no
// information. Anything omitted here is below a twentieth of a unit.
function _selPayloadLabel(units) {
  if (!(units > 0.05)) return '';
  return _selFmtQty(units) + ' units';
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

// ── fog and the hit test ────────────────────────────────────────────────
//
// Fog masks the board by SUBTRACTING: render/map.js sets display:none on a
// hidden station's <g>, so `evt.target.closest('[data-station]')` structurally
// cannot land on one — a display:none element is not hit-tested by the browser
// and never becomes an event target. That half is free and was verified with
// elementFromPoint on the live board rather than assumed.
//
// THE OTHER HALF IS NOT FREE, and this is the whole reason this helper exists.
// selStationAt() does not stop at the DOM hit: it then runs a NEAREST-CENTRE
// override over `STATIONS`, the static data table, to fix the 77 overlapping
// pairs on this map. That loop has never looked at the DOM and cannot see
// display:none, so a click on a visible city with a hidden one 12px behind it
// would silently retarget to the hidden one — the player attacking a city that
// is not on their screen, from a rejection they can neither see nor explain.
// So the override skips level 0, and only level 0.
//
// LEVEL 1 STAYS TARGETABLE, deliberately. You remember the city is there and
// committing a volley against a number that was true a minute ago is the exact
// decision fog was added to create (02-visibility-and-sea.md §1: "decide
// whether last minute's number is still true"). Routing legality is also
// unfogged by decision — a route may run through ground you have never seen,
// and you find out the road is blocked when you march.
function _selFogHidden(sid) {
  const g = selGame();
  if (!g || !g.stations) return false;
  if (typeof mapFogLevels !== 'function' || typeof believedStation !== 'function') return false;
  const vis = mapFogLevels(g);
  if (!vis) return false;                       // no viewer: nothing is masked
  if (vis[sid] === 2) return false;
  return believedStation(g, g.human, sid, vis).level === 0;
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

// Both thresholds below are authored in SCREEN PIXELS and converted here, per
// use, into the viewBox units the hit tests compare in.
//
// They used to divide by cameraScale(), which is only half the conversion:
//   pxPerUnit = (boardWidth / 1000) x cameraScale
// so dividing by scale alone holds them constant under ZOOM but lets them
// scale with the WINDOW. On an 800px window the board is 516px, making every
// "screen-constant" threshold worth 0.516x what it read as -- the pick radius
// sat at ~52% of its intended reach on exactly the window this game is played
// at, which is the same complaint that motivated nearest-centre picking in the
// first place. _selPxPerUnit() reads the real matrix and is constant under
// both. See also _selLabelHalfPx, which hit this trap and uses the same helper.
function selClickSlop() {
  const ppu = _selPxPerUnit();
  return (isFinite(ppu) && ppu > 0) ? SEL_CLICK_SLOP_PX / ppu : SEL_CLICK_SLOP_PX;
}

// Reach of the nearest-centre rule, in viewBox units for the current window.
function selStationPickRadius() {
  const ppu = _selPxPerUnit();
  return (isFinite(ppu) && ppu > 0) ? SEL_STATION_PICK_RADIUS_PX / ppu : SEL_STATION_PICK_RADIUS_PX;
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

// ── the preview follows the LINK, not the chord ─────────────────────────
//
// Sea links are drawn BOWED. Five crossings on this map — Dover to Lille among
// them — are shorter between centres than the two station symbols are wide, so
// the arc is the only geometry with any visible length at all, and it is the
// curve render/waves.js walks the wave down once the volley is committed.
//
// A preview drawn as a straight chord therefore promised a march across open
// water the units would not take, next to an ETA computed for the route they
// would — a readout answering a different question from the one on screen,
// which is known-issues #18. §8's whole case for the preview is that "a volley
// is legible BEFORE you commit it"; a line that is not the route is not legible,
// it is wrong.
//
// So the shape comes out of render/map.js's route seam and NOTHING here derives
// it. That file paints the links, waves.js rides them, and this draws the
// preview along them, out of one function — known-issues #9/#12 is "two
// implementations of one geometry rule" and this project has paid for it three
// times. On a land hop the seam's sagitta is 0, where the quadratic IS the
// straight segment, so no land preview moved by so much as a rounding error.
//
// The fallback below is the old straight chain, and it is for ONE case: a load
// order where render/map.js is not there yet. This file may draw a worse line
// than the seam would; it may not answer the same question a second way.
function _selRouteD(row) {
  if (row.geoms && typeof linkRouteD === 'function') return linkRouteD(row.geoms);
  const pts = row.points;
  let d = 'M' + pts[0][0] + ',' + pts[0][1];
  for (let i = 1; i < pts.length; i++) d += ' L' + pts[i][0] + ',' + pts[i][1];
  return d;
}

// §8: "the number is the interface." A preview annotation that lands on a
// garrison number costs more than it gains, and the payload label doubled the
// height of every annotation, so what used to graze now covers.
//
// Two false starts, both measured, both recorded because the reasoning is the
// useful part:
//
//   1. Walk the label FURTHER ALONG its route until it clears. Every source's
//      route converges on the same target, so this walks all of them into the
//      same square inch: 6 payload-on-garrison collisions became 22
//      label-on-label ones.
//   2. Nudge sideways by a RADIAL clearance of `K / cameraScale()` board units.
//      Screen-constant under zoom — but `pxPerUnit = (boardWidth/1000) ×
//      cameraScale`, so that expression is a constant K × boardWidth/1000 screen
//      pixels and shrinks with the WINDOW. At the player's 800px it came to
//      12.4px against a label pair 24px tall and 70px wide, and six payload
//      labels sat on garrison numbers.
//
// So: convert through the real screen CTM, and test the label's actual BOX
// against the number's box rather than a radius. A radius cannot express "40px
// wide and 14px tall", which is the shape of the thing being placed.

// Screen pixels per viewBox unit, straight off the matrix every hit test in this
// file already inverts. The only expression that is genuinely screen-constant
// across BOTH zoom and window size.
function _selPxPerUnit() {
  const svg = byId('board');
  const m = (svg && svg.getScreenCTM) ? svg.getScreenCTM() : null;
  return (m && m.a > 0) ? m.a : 1;
}

// Half-extent of a garrison number about its station centre, in screen px.
const SEL_GARRISON_HALF_PX = { w: 13, h: 10 };
// Breathing room so "clear" means visibly clear, not touching.
const SEL_LABEL_PAD_PX = 5;

// Predicted screen half-extents of the {ETA above, payload below} pair. The
// widths are estimated from character counts against the numeric font rather
// than measured, because the box has to be known BEFORE the text is placed.
function _selLabelHalfPx(etaText, payText) {
  const w = Math.max(String(etaText || '').length * 6.2, String(payText || '').length * 5.2);
  return { w: w / 2 + SEL_LABEL_PAD_PX, h: 15 + SEL_LABEL_PAD_PX };
}

// Does a label centred at `p` miss every garrison number on the board?
function _selAnchorIsClear(p, half, ppu) {
  const hw = (half.w + SEL_GARRISON_HALF_PX.w) / ppu;
  const hh = (half.h + SEL_GARRISON_HALF_PX.h) / ppu;
  const ids = selAllStationIds();
  for (let i = 0; i < ids.length; i++) {
    const q = selStationPos(ids[i]);
    if (!q) continue;
    if (Math.abs(p[0] - q[0]) < hw && Math.abs(p[1] - q[1]) < hh) return false;
  }
  return true;
}

// Push the label sideways off its own line until it clears, alternating sides so
// two parallel routes do not both shove their labels the same way. Sideways
// rather than forwards keeps the per-source spacing the anchor was chosen for
// (see the note at the label loop) and keeps the label on the line that says
// which source it belongs to.
//
// If the whole neighbourhood is crowded the least-bad candidate is returned
// rather than nothing: a label that overlaps is still information, a missing one
// is not.
function _selLabelAnchor(p, dir, half) {
  const ppu = _selPxPerUnit();
  if (_selAnchorIsClear(p, half, ppu)) return p;
  const len = Math.hypot(dir[0], dir[1]);
  if (!(len > 0)) return p;
  const nx = -dir[1] / len, ny = dir[0] / len;
  const stepU = (half.h + SEL_GARRISON_HALF_PX.h) / ppu;
  const steps = [1, -1, 1.7, -1.7, 2.4, -2.4, 3.2, -3.2];
  let best = p, bestScore = -Infinity;
  for (let i = 0; i < steps.length; i++) {
    const q = [p[0] + nx * steps[i] * stepU, p[1] + ny * steps[i] * stepU];
    if (_selAnchorIsClear(q, half, ppu)) return q;
    // Least-bad = furthest from the nearest station centre, tie-broken toward
    // the smaller displacement so a hopeless case does not fling the label away.
    let near = Infinity;
    const ids = selAllStationIds();
    for (let j = 0; j < ids.length; j++) {
      const s = selStationPos(ids[j]);
      if (s) near = Math.min(near, Math.hypot(q[0] - s[0], q[1] - s[1]));
    }
    const score = near - Math.abs(steps[i]) * stepU * 0.15;
    if (score > bestScore) { bestScore = score; best = q; }
  }
  return best;
}

// Local direction of the polyline at arc-length `d`, for the perpendicular above.
function _selDirAlong(pts, d) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  const want = (total > 0) ? clamp(d, total * 0.06, total * 0.62) : 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (acc + seg >= want || i === pts.length - 1) {
      return [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    }
    acc += seg;
  }
  return [1, 0];
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

    // The payload no longer drives the ETA — every army walks at one speed
    // since C1, so routeEtaTicks() takes the path alone. It still drives the
    // refusal test AND the label, so it must be the same number applyCommand()
    // will build from the effective fraction, modifier included.
    let units = null;
    if (g && g.stations && g.stations[sid]) units = _selPayload(g.stations[sid].units);

    const path = _selRoutePath(sid, target);
    const pts = _selPathPoints(path);
    // The route's SHAPE, hop by hop, off render/map.js's link seam — see
    // _selRouteD. `trace` is the same curve as a polyline, because the ETA
    // label is placed a fixed DISTANCE along the route and a chord is the wrong
    // ruler on exactly the crossings where the bow is the whole visible line.
    const geoms = (pts && typeof linkRouteGeoms === 'function')
      ? linkRouteGeoms(path) : null;
    const trace = (geoms && typeof linkRoutePoints === 'function')
      ? (linkRoutePoints(geoms) || pts) : pts;
    let eta = null;
    if (pts && etaFn) {
      const t = etaFn(path);
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
    else if (typeof units === 'number' &&
             typeof BAL !== 'undefined' && BAL &&
             units < BAL.MIN_SEND_UNITS) {
      refusal = 'too few';
    }

    rows.push({
      source: sid, from: from, to: to,
      path: path, points: pts, geoms: geoms, trace: trace, eta: eta,
      // The exact bundle the commit will subtract from this source. Exposed on
      // the row so the label and any check can read the same numbers the ETA
      // and the refusal test were computed from.
      units: units,
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

    // ONE SEGMENT PER HOP, and each segment is the link's own arc. The wave
    // walks the link graph, so the preview walks it too — if the only legal way
    // from Berlin to Paris is through Cologne, the line bends at Cologne and the
    // player can see the transit before committing to it; and if a hop is a sea
    // crossing, the line bows exactly where the wave will (see _selRouteD).
    //
    // A <path>, not a <polyline>: a land hop is the sagitta-0 case of the same
    // quadratic, so there is one element type and one geometry rule rather than
    // a straight branch and a curved branch that could drift apart.
    let cls = 'sel-path is-' + intent;
    if (r.eta === slowest && spread > 0) cls += ' is-slowest';
    const poly = el('path', cls, {
      d: _selRouteD(r),
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
    // Four stagger lanes rather than three: the label is now two lines tall, so
    // the old three-lane spread put twice as much ink into the same band. Six
    // lanes was tried and measured worse — the extra lanes push labels far enough
    // down their routes to land in the convergence zone near the target.
    const off = 26 + (i % 4) * 13;
    // Along the ROUTE for a routable source, along the straight line for a
    // refused one — a refused source has no route to walk. Then nudged sideways
    // until it is clear of every garrison number (§8: the number is the
    // interface, and this file may not sit on one).
    let base, dir;
    if (r.routable) {
      // Walked along `trace` — the route's arcs sampled as a polyline — rather
      // than along the hop corners, so a label 26 units out from a source on the
      // French coast sits on the Channel arc it annotates instead of in the
      // water beside it. Falls back to the corners when the seam is absent.
      const walk = r.trace || r.points;
      base = _selPointAlong(walk, off);
      dir = _selDirAlong(walk, off);
    } else {
      const len = Math.max(1, dist(r.from, r.to));
      const t = clamp(off / len, 0.08, 0.62);
      base = [lerp(r.from[0], r.to[0], t), lerp(r.from[1], r.to[1], t)];
      dir = [r.to[0] - r.from[0], r.to[1] - r.from[1]];
    }
    const etaText = r.routable ? (Math.round(r.eta) + 't') : r.refusal;
    const payload = _selPayloadLabel(r.units);
    const anchor = _selLabelAnchor(base, dir, _selLabelHalfPx(etaText, payload));

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
      text: etaText,
      'data-preview-eta': r.source,
    });
    if (r.routable && friendly) label.style.fill = friendly;
    layer.appendChild(label);

    // WHAT it sends, under WHEN it arrives. The persistent fraction lives in
    // the corner of the screen and the player is looking at the map, so the
    // number that matters travels with the line — and it moves the instant a
    // modifier is held, which is the whole point of the override.
    //
    // Below the anchor while the ETA is above it, both inside the SAME
    // counter-scaled transform, so the pair holds a constant on-screen size and
    // a constant on-screen gap at every zoom — and so _selLabelAnchor only has
    // one box to keep clear of the garrison numbers rather than two.
    //
    // Drawn for refused rows too: "too few" is a statement ABOUT the payload,
    // and the payload is the evidence for it.
    if (payload) {
      const pcls = 'sel-payload' + (r.routable ? ' is-' + intent : ' is-refused');
      const plabel = el('text', pcls, {
        x: 0, y: 8,
        transform: selSymbolTransform(anchor[0], anchor[1]),
        text: payload,
        'data-preview-payload': r.source,
      });
      // Inline, not a class — per-power data computed at draw time
      // (known-issues #15).
      if (r.routable && friendly) plabel.style.fill = friendly;
      layer.appendChild(plabel);
    }
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
  const reach = selStationPickRadius();
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
    // A station that is not on the board cannot win a click for it: this loop
    // reads the static STATIONS table and has no idea display:none exists.
    if (d < bestD - 1e-9 && d <= reach && !_selFogHidden(ids[i])) {
      bestD = d;
      best = ids[i];
    }
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
  _selPaintLoaded();
}

// THE BOARD SAYS IT IS LOADED — 05-command-clarity.md §1, accepted fix (2).
//
// The dangerous state is "sources are selected, so the next click on anything I
// do not own launches an army". Carets mark the selected nodes, and at the 3x
// home zoom you can see 12% of the board — so the sources you picked two minutes
// ago are very likely off-screen when you click the enemy city you meant to
// LOOK at. §1 is blunt about it: "you cannot inspect an enemy city without
// attacking it, and there is no state on screen that warns you which of the two
// you are about to do."
//
// A class on `.app`, exactly like `is-arming`, and the treatment is an INSET RING
// on the board wrapper — not an overlay element. That is deliberate and it is the
// whole reason this is safe: an overlay over the board with default
// pointer-events silently eats the click that commits an attack, with no error
// and no console output, and this project has hit that five times
// (known-issues #5). A box-shadow creates no element and cannot be hit-tested.
//
// Called from selRedraw(), which is the one function every selection change
// already funnels through — thirteen call sites, so hooking anywhere else would
// have meant finding all of them.
function _selPaintLoaded() {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('is-loaded', SEL_STATE.selected.size > 0);
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

  // Snapshot BOTH decisions before applyCommand touches anything: the amount
  // this volley uses, and whether the group survives it. Reading SEL_MOD after
  // the send would be reading it a frame later, and the player may already have
  // let the key go.
  const fraction = selEffectiveFraction();
  const keep = SEL_MOD.meta;

  const cmd = {
    type: 'send',
    owner: me,
    sources: sources,
    target: target,
    fraction: fraction,
  };
  // No `cmd.types`. The INF/ART/ARM filter is gone from the UI, and omitting the
  // field keeps the command object byte-identical to the ones every existing
  // replay and test already contains.
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
  // clears." One-shot, and still the default — a volley normally comes from a
  // group assembled for it.
  //
  // CMD held is the exception, and it is an exception rather than a mode
  // precisely because it is decided by the click and not by a setting: there is
  // no state anywhere that says "keep clearing off", so a group can never
  // outlive the gesture that asked for it. Firing one massed army at four
  // targets in sequence is then four clicks, not four clicks plus three
  // reselections.

  if (!keep) {
    clearSelection();
    return res;
  }
  // Drop anything that changed hands in the volley, then redraw against the
  // target still under the cursor — so the payload labels immediately show the
  // SMALLER second salvo rather than the one that just left.
  selPrune();
  SEL_STATE.hoverTarget = SEL_STATE.selected.has(target) ? null : target;
  selRedraw();
  return res;
}

// ── event handlers ──────────────────────────────────────────────────────

// Right-button travel, in CLIENT PIXELS, past which the press was a camera pan
// and not a reinforce order. Pixels rather than viewBox units on purpose: a
// right-drag pan MOVES THE VIEWBOX under the cursor, so a board-unit
// measurement of that gesture is taken against a ruler that is itself sliding.
const SEL_RCLICK_SLOP_PX = 4;

function selOnMouseDown(evt) {
  _selSyncMods(evt);
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
  // Every mousemove carries the live modifier flags, which makes this the
  // cheapest correct place to notice a key held down while the pointer moved —
  // including the case where the key went down while the window was unfocused
  // and no keydown ever arrived. Redraw only on an actual change.
  const modsChanged = _selSyncMods(evt);

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
    // Screen-constant threshold, not viewBox-constant — see selClickSlop().
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
  } else if (modsChanged && SEL_STATE.hoverTarget) {
    // Same target, different amount: the payload labels and the ETAs both move
    // when shift or alt goes down, so the override is legible before the click.
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
  // Before anything commits. selCommit() reads SEL_MOD, and THIS event is the
  // authority on what the player was holding when they released — a keyup that
  // beat the mouseup by a frame must not decide the size of the volley.
  _selSyncMods(evt);

  if (evt.button === 2) {
    const rd = SEL_STATE.rdrag;
    SEL_STATE.rdrag = null;
    if (!rd || rd.moved) return;
    // AN ARMED ORDER EATS THIS CLICK TOO — see the left button below, and the
    // block above _selCommitArmed for why the right button gets the same rule.
    // It is inside the `!rd.moved` gate on purpose: a right-DRAG is how
    // render/camera.js pans, and panning to FIND the destination must neither
    // commit the order nor cancel the arming. Measured on the live board — a
    // 40px right-drag while armed leaves `armed` standing and creates nothing.
    if (_selCommitArmed(rd.station, false)) return;
    selReinforce(rd.station);
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

  // AN ARMED ORDER EATS THE CLICK, before the gesture table below runs. It has
  // to be first: every branch under it either changes the selection or launches
  // troops, and the whole point of arming is that this one click means neither.
  if (_selCommitArmed(sid, true)) return;

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

// Shift / Alt / Cmd going down or up with the pointer perfectly still still has
// to move the preview — the player aims first and decides the amount second.
// One handler for both edges; the event's own flags are the truth on each.
function selOnModKey(evt) {
  if (!_selSyncMods(evt)) return;
  if (SEL_STATE.hoverTarget) selRedraw();
}

function selOnKeyDown(evt) {
  selOnModKey(evt);

  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (evt.key === 'Escape') {
    // Escape backs out one step at a time. An armed order is the more recent
    // and more surprising state to be in, so it is what Escape reaches first —
    // and the group survives, because you almost certainly want to give it a
    // different order rather than rebuild it.
    if (_selDisarm()) return;
    clearSelection();
    return;
  }
  if ((evt.ctrlKey || evt.metaKey) && (evt.key === 'a' || evt.key === 'A')) {
    // Select the whole empire. Deliberately not filtered by "has enough units"
    // — applyCommand() rejects the empty ones, and hiding them here would make
    // the count on screen disagree with the empire you actually hold.
    evt.preventDefault();
    selSet(selAllStationIds().filter(selIsMine));
    return;
  }

  // R / H — the supply lines of every selected station.
  //
  // BARE KEYS ONLY. Every modifier on this board already means something at the
  // moment of a click (cmd = keep the group, shift = add to the selection,
  // ctrl+A = select everything), and a key that fired while one of them was held
  // would fire in the middle of somebody aiming a volley. The guard is all four
  // rather than only the ones that currently collide, because the next modifier
  // to acquire a meaning should not silently break this.
  if (!evt.shiftKey && !evt.altKey && !evt.metaKey && !evt.ctrlKey) {
    const verb = SEL_ORDER_KEYS[evt.key];
    if (verb) {
      evt.preventDefault();
      // R names a city, so it only ARMS — the click that follows is the order.
      // H needs no destination and fires now.
      //
      // H WITH NOTHING SELECTED DOES NOTHING, deliberately. The obvious
      // alternative — make it clear the whole empire — puts "delete every supply
      // line I have built, with no undo" one stray keystroke away from a board
      // where H is pressed constantly. Ctrl+A then H is the same thing in two
      // keys and cannot be done by accident, and it is visible in the selection
      // before it happens.
      if (verb === 'supply') _selArmOrder();
      else { _selDisarm(); _selApplyOrder(null); }
      return;
    }

    // `b` — OPEN THE BUILD CHOOSER over the selection (04-development.md §8).
    //
    // It ARMS rather than firing, and the reason is the player's: a spend needs to
    // say what it is buying, how much it costs, and whether the thing will
    // actually switch on afterwards — none of which fits on a keycap. So `b` puts
    // a numbered list on screen and 1/2/3 commits.
    //
    // The first version fired immediately with no kind, and it was a DEAD END at
    // every station with more than one legal development — 51 of the 108. The
    // command correctly rejected 'choose-kind' and there was no way to choose.
    //
    // WITH NOTHING SELECTED IT DOES NOTHING, same rule as H and for the stronger
    // version of the same reason: "spend half of every city I own" must not be one
    // keystroke away on a board where `b` is pressed often.
    if (evt.key === 'b' || evt.key === 'B') {
      evt.preventDefault();
      if (SEL_STATE.armed === 'build') _selDisarm();
      else _selArmBuild();
    }

    // 1/2/3 PICK FROM THE CHOOSER — and only while it is open.
    //
    // These are the send-amount keys the rest of the time, which is exactly why
    // this branch is inside `armed === 'build'` and nowhere else. Arming is not a
    // mode you can forget you are in (see _selArmOrder): the chooser is on screen
    // the whole time it is live, one key consumes it, and Escape or a click on the
    // board cancels it. app/main.js's digit handler is left alone — it checks the
    // same armed flag rather than being reordered, so the two cannot disagree.
    if (SEL_STATE.armed === 'build') {
      var pick = SEL_BUILD_KEYS[evt.key];
      if (pick !== undefined) {
        evt.preventDefault();
        var opts = _selBuildOptions();
        if (opts[pick]) {
          _selBuild(_selBuildTargets(), opts[pick].kind);
          _selDisarm();
        }
      }
    }
  }
}

// ── the build chooser ───────────────────────────────────────────────────

// Digit -> index into the option list. 1-based on the keycap, 0-based in the
// array, which is the only reason this table exists rather than a parseInt.
const SEL_BUILD_KEYS = { 1: 0, 2: 1, 3: 2 };

// The cities `b` would act on: every SELECTED city the player owns.
function _selBuildTargets() {
  return selectedSources().filter(selIsMine);
}

// The kinds offered, with everything the player needs to decide, computed ONCE
// per repaint rather than per row.
//
// Every number comes from sim/development.js. The renderer decides nothing here —
// not what is legal, not the cost, not whether the result would run — because the
// rail already learned that lesson: a chooser that offers a build applyCommand
// then refuses is the same defect as a rail that does (known-issues #9, #18).
function _selBuildOptions() {
  const g = selGame();
  const me = selPlayer();
  const targets = _selBuildTargets();
  if (!g || !me || !targets.length || typeof developmentPlan !== 'function') return [];

  // Union of what is legal across the selection, in DEV_KINDS order so the digit
  // for a given development does not move between two cities.
  const out = [];
  for (let i = 0; i < DEV_KINDS.length; i++) {
    const kind = DEV_KINDS[i];
    let can = 0, cost = null, tier = null, runsAt = null, blocked = null;
    for (let j = 0; j < targets.length; j++) {
      const plan = developmentPlan(g, targets[j], me, kind);
      if (plan.ok) {
        can++;
        if (cost === null) {
          cost = plan.cost;
          tier = plan.tier;
          runsAt = (typeof operatingAfterBuild === 'function')
            ? operatingAfterBuild(g, targets[j], plan.tier, plan.cost) : null;
        }
      } else if (blocked === null && plan.reason !== 'not-legal-here') {
        blocked = plan.reason;
      }
    }
    // 'not-legal-here' everywhere means this development simply does not belong
    // at these cities, and listing it would be offering a choice that is not one.
    if (!can && blocked === null) continue;
    out.push({ kind: kind, can: can, of: targets.length, cost: cost, tier: tier,
               runsAt: runsAt, blocked: blocked });
  }
  return out;
}

function _selArmBuild() {
  if (!_selBuildTargets().length) return null;
  if (!_selBuildOptions().length) return null;
  SEL_STATE.armed = 'build';
  _selPaintArmed();
  return 'build';
}

// Paint the chooser. Keyboard-only and `pointer-events: none`, so it can float
// over the board without any risk of eating a click (index.html says why).
function _selPaintBuildChooser() {
  const host = (typeof byId === 'function') ? byId('build-chooser') : null;
  if (!host) return;
  if (SEL_STATE.armed !== 'build') { host.hidden = true; host.textContent = ''; return; }

  const opts = _selBuildOptions();
  const targets = _selBuildTargets();
  host.textContent = '';

  const head = document.createElement('div');
  head.className = 'bc-head';
  head.textContent = targets.length === 1
    ? ('Build in ' + STATIONS[targets[0]].name)
    : ('Build in ' + targets.length + ' cities');
  host.appendChild(head);

  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    const row = document.createElement('div');
    row.className = 'bc-row' + (o.can ? '' : ' is-blocked');

    const key = document.createElement('span');
    key.className = 'bc-key';
    key.textContent = String(i + 1);
    row.appendChild(key);

    const name = document.createElement('span');
    name.className = 'bc-name';
    name.textContent = DEV_NAMES[o.kind] + (o.tier ? ' ' + o.tier : '');
    row.appendChild(name);

    const cost = document.createElement('span');
    cost.className = 'bc-cost';
    // ONE city: the exact price. SEVERAL: how many can pay it, because an
    // average would be a number that is true of none of them.
    cost.textContent = !o.can
      ? _selBuildWhy(o.blocked)
      : (targets.length === 1
        ? (Math.round(o.cost * 10) / 10) + ' units'
        : o.can + ' of ' + o.of + ' can pay');
    row.appendChild(cost);

    // WILL IT ACTUALLY RUN. The point of the whole chooser: paying for a tier and
    // discovering afterwards that the garrison left cannot operate it is the one
    // surprise this mechanic can spring (§4), and it is worst on the expensive
    // tiers, which are exactly the ones worth warning about.
    if (o.can && targets.length === 1 && o.runsAt !== null) {
      const run = document.createElement('span');
      const live = o.runsAt >= o.tier;
      run.className = 'bc-run' + (live ? ' is-on' : '');
      run.textContent = live ? 'runs at once' : ('runs at ' + o.runsAt + ' until regarrisoned');
      row.appendChild(run);
    }
    if (o.can && !DEV_LIVE[o.kind]) {
      const inert = document.createElement('span');
      inert.className = 'bc-inert';
      inert.textContent = 'no effect yet';
      row.appendChild(inert);
    }
    host.appendChild(row);
  }

  const foot = document.createElement('div');
  foot.className = 'bc-foot';
  foot.textContent = 'Esc to cancel';
  host.appendChild(foot);
  host.hidden = false;
}

// Plain words for a refusal. The two that are not failures matter most: at max
// tier means finished here, and too few units names the thing to fix.
function _selBuildWhy(reason) {
  return {
    'at-max-tier': 'nothing left to build',
    'too-few-units': 'not enough units',
    'already-developed': 'already developed',
    'not-owned': 'not yours',
  }[reason] || (reason || 'unavailable');
}

// Build the next tier in every selected city. Goes through queueCommand, not
// applyCommand — `build` is the first verb in this game that is scheduled by
// construction (07-roadmap.md A3), and it can be because unlike a volley there is
// no immediate confirmation to draw: the tier appears on the node and in the rail
// on the next tick, which is the same tick the player sees anyway.
//
// The selection SURVIVES. A build is something you do repeatedly to the same
// group as it regrows — clearing it would make every second tier a reselection.
// ONE COMMAND BUILDER FOR BOTH ROUTES. The `b` key and the rail's build buttons
// are the same verb reached two ways (04-development.md §8), and two places
// composing a `{type:'build'}` object is how the key and the button end up
// disagreeing about what they do — known-issues #9, logged five times here.
//
//   _selBuild()               the key: every selected city, no kind named
//   _selBuild([sid], 'port')  the rail: one city, one named kind
//
// `stations` defaults to the selection and `kind` to nothing, so the key's call
// is the bare one and the rail passes what it knows.
function _selBuild(stations, kind) {
  const g = selGame();
  const me = selPlayer();
  const mine = (stations && stations.length ? stations : selectedSources()).filter(selIsMine);
  if (!g || !me || !mine.length) return null;
  if (typeof queueCommand !== 'function') {
    console.warn('[render/select] queueCommand is not loaded — build dropped');
    return null;
  }
  // Omitting `kind` is meaningful, not lazy: a city with ONE legal option builds
  // it, and a city with several is rejected 'choose-kind' so the rail can ask.
  // Deciding that here would be a second implementation of a rule
  // sim/development.js already owns.
  const cmd = { type: 'build', owner: me, stations: mine };
  if (kind) cmd.kind = kind;
  const res = queueCommand(g, cmd);
  if (!res.ok) console.warn('[render/select] build not queued:', res.reason);
  return res;
}

// ── standing orders (01-data-schema.md, "Standing orders") ──────────────
//
// A SUPPLY LINE: sources, and a named destination.
//
//     select the rear cities  →  press R  →  click the city they feed
//
// TWO VERBS BECAME ONE. The shape before this was `reinforce` / `defend`, and
// the player cut the second: *"it's the same action in the inverse."* The reason
// that is right, and the reason it matters more here than it looks: `defend`
// only shipped when the SIM judged the destination "threatened", which is the
// same hidden guess that `feed`/`rally` made when it matched each feeder to its
// nearest sink, and getting rid of that guess is the entire point of this
// rewrite. The capacity ceiling already does defend's job out of a number the
// player can see — a full destination accepts nothing, so a quiet front banks
// force at home by itself.
//
// R arms; the next click on your own ground names the city. H needs no
// destination — it is the off switch and applies the moment it is pressed.
//
// R IS A TOGGLE, which is where cancel comes from. Press R and click a city the
// whole group already feeds and the line is removed. No second key, no mode, and
// the same gesture reads both ways.
//
// WHY KEYS AND NOT BUTTONS. Word for word the complaint that produced the digit
// keys: *"it needs to be something that can happen very quickly as the player is
// making many moves in parallel."* A line is set on a GROUP — marquee the rear
// provinces, press R, click the front — and a per-station panel control would
// make that twenty round trips to the rail.
//
// Lowercase and uppercase both, because caps lock is not a mode anyone here
// opted into. Shift+R is NOT this key — see the modifier guard above.
const SEL_ORDER_KEYS = {
  h: 'clear', H: 'clear',
  r: 'supply', R: 'supply',
};

// Arm a directed order. The verb is chosen now; the destination is the next
// left-click on ground the player holds.
//
// ARMING IS NOT A MODE, and the difference matters. It is consumed by exactly
// one click, cancelled by Escape, by H, by a click on anything that is not your
// own city, and by the selection going empty — there is no state anywhere that
// keeps it alive past the gesture that asked for it, which is the same rule the
// Cmd-held volley follows. A mode you can forget you are in, on a board where
// the next click otherwise launches an attack, is exactly the accident the
// left-click gesture table was rewritten to remove.
function _selArmOrder() {
  // Nothing selected: silently do nothing rather than arm an order that has no
  // sources, which would leave the player's next click mysteriously inert.
  if (!selectedSources().filter(selIsMine).length) return null;
  SEL_STATE.armed = 'supply';
  _selPaintArmed();
  return 'supply';
}

function _selDisarm() {
  if (!SEL_STATE.armed) return false;
  SEL_STATE.armed = null;
  _selPaintArmed();
  return true;
}

// The armed state is the one piece of UI in this file that lives outside the
// SVG, because it is a statement about what the NEXT click will do and it has to
// be visible while the cursor is anywhere on the board — including over the
// rail, over the HUD, and over empty sea. A caret on the nodes could not say it.
//
// Written to #send-armed in index.html; absent element is not an error, since
// the board has to work with any chrome missing (the same rule renderBoard
// follows).
// One armed state, so one string — and it names the toggle rather than only the
// add, because the same gesture is how a line is removed and a banner that only
// said "click the city to supply" would make cancelling feel like a bug.
//
// UNCHANGED by the both-buttons fix, and deliberately so. "click a city" names
// no button, which was already the promise the banner was making and is now
// literally true of either one — that the text needed no edit is part of the
// argument for the design chosen in _selCommitArmed. Spelling out "either
// button" was considered and dropped: it spends the line on a distinction that
// only exists for someone who knows a narrower rule was possible, and the
// player who reported this reached for the right button without being told to.
const SEL_ARMED_TEXT = 'SUPPLY — click a city to add or remove it';

// ── the confirmation ────────────────────────────────────────────────────
//
// Added 2026-07 on the player's instruction: "the confirmation on
// reinforcements being sent is unclear. there needs to be a better visible
// confirmation that the click went through".
//
// The failure was real and specific. Arming put a banner on screen; committing
// took it away and put NOTHING in its place. The only evidence the click had
// landed was a small marker appearing on a station somewhere on a 108-node
// board — quite possibly not the node under the cursor, and quite possibly
// scrolled off. A gesture whose success and whose failure look identical is a
// gesture the player stops trusting, and then stops using.
//
// It reuses #send-armed rather than adding an element. That is not laziness:
// that banner is already `position: fixed` with `pointer-events: none`, and
// both properties were paid for. Fixed because putting it in the bottom bar's
// FLOW grew the bar by 14px and shifted the whole board up 15px under a cursor
// that was one click from naming a city. And pointer-events:none because
// anything over the board that accepts them silently eats the click that
// commits an attack, with no error at all — this project has been bitten by
// that five times. A second banner would have to re-earn both.
const SEL_CONFIRM_MS = 2200;
let SEL_CONFIRM_TIMER = null;

function _selStationName(sid) {
  return (typeof STATIONS !== 'undefined' && STATIONS[sid] && STATIONS[sid].name) || sid;
}

// ── IS THE LINE I JUST DREW ACTUALLY RUNNING? ──────────────────────────
//
// 05-command-clarity.md §2, in the player's words: the routes are *"tough to
// click and understand if they're actually active"*. The banner said
// "SUPPLYING LEIPZIG — 3 cities" whether the stream was moving 6 units a sweep
// or was going to move nothing for the next ten minutes, and those two boards
// look identical at the moment of the click — the sweep is 25 ticks away, so
// there is nothing on screen yet either way.
//
// It matters most in the case that produced the bug report. A city that has
// just spent its garrison on a volley is below its keep floor, so a line drawn
// out of it ships NOTHING for as long as it takes to regrow — measured on a
// live board, 63 ticks after a 50% volley and 775 ticks after a 100% one. The
// map draws that as a dimmed line with its chevrons removed, which is very
// close to how it draws no line at all, and the player reasonably reads it as
// *"the command I issued removed my route"*.
//
// THE BINARY ONLY, AND A POINTER TO THE REASON. `standingOrderNext` computes a
// machine-readable reason and render/readout.js already turns each one into a
// sentence on hover; writing a second copy of that vocabulary here is
// known-issues #9 in its purest form — two files spelling one sim fact, drifting
// the first time a reason is added. So this says whether anything moves and
// where to look for why, and nothing more.
//
// ONE standingOrderPlan CALL, on a click. It plans the whole power (~80µs) and
// is the sanctioned bulk accessor — standingOrderNext in a loop over the group
// would re-plan the power once per city (01-data-schema.md).
//
// Returns true (moving), false (nothing moves), or null (unknowable — no plan
// function, no game, or the group's edges are not in the plan), and null prints
// nothing rather than guessing.
function _selOrderMoving(stations, target) {
  const g = selGame();
  const me = selPlayer();
  if (!g || !me || !target || !stations.length) return null;
  if (typeof standingOrderPlan !== 'function') return null;

  const plan = standingOrderPlan(g, me);
  let known = false;
  for (let i = 0; i < stations.length; i++) {
    const p = plan[stations[i]];
    if (!p || !p.edges) continue;
    for (let j = 0; j < p.edges.length; j++) {
      const e = p.edges[j];
      if (e.target !== target) continue;
      known = true;
      // ANY of them moving is "the route is running". The group is one gesture
      // and the banner is one line; per-city detail is the readout's job.
      if (e.units > 0) return true;
    }
  }
  return known ? false : null;
}

// Names the DESTINATION and counts the SOURCES, because those are the two
// things the player cannot verify by looking. Which cities were selected has
// just scrolled out of their head; which city they clicked is under the cursor
// but the click is what is in doubt.
function _selConfirmText(res, target) {
  if (!res) return '';

  if (!res.ok) {
    const why = res.reason === 'target-not-owned' ? 'that city is not yours'
              : res.reason === 'unknown-target'   ? 'no city there'
              : 'order refused';
    return 'CANNOT SUPPLY — ' + why;
  }

  const acc = res.accepted || [];
  const sources = [];
  const moved = [];
  for (let i = 0; i < acc.length; i++) {
    if (sources.indexOf(acc[i].station) < 0) sources.push(acc[i].station);
    if (acc[i].changed && moved.indexOf(acc[i].station) < 0) moved.push(acc[i].station);
  }
  const count = (list) => (list.length === 1
    ? _selStationName(list[0])
    : list.length + ' cities');

  // CLEAR counts what actually changed. "Cleared 3 cities" when none of the
  // three had a line is the false confirmation this banner exists to stop.
  if (target === null) {
    return moved.length
      ? 'SUPPLY LINES CLEARED — ' + count(moved)
      : 'NO SUPPLY LINES TO CLEAR';
  }

  // A TOGGLE counts the whole group, deliberately. "Supplying Leipzig — 3
  // cities" is a statement about the state the board is now in, and all three
  // do supply Leipzig, including the one that already did before the click.
  if (!sources.length) return 'NOTHING CHANGED';
  const many = count(sources);

  // `added` is decided ONCE for the whole group in _cmdApplyOrder, so reading
  // it off the first entry is reading the group's verdict, not one station's.
  const head = (acc[0].added ? 'SUPPLYING ' : 'NO LONGER SUPPLYING ') +
               String(_selStationName(target)).toUpperCase() + ' — ' + many;
  // Only on the ADD. "No longer supplying X" is a statement about a line that
  // no longer exists, and reporting the flow of something that is gone would be
  // the same class of nonsense as "cleared 3 cities" when none had a line.
  if (!acc[0].added) return head;
  const moving = _selOrderMoving(sources, target);
  if (moving === false) return head + ' · NOTHING MOVING YET — hover a city for why';
  if (moving === true) return head + ' · moving on the next sweep';
  return head;
}

function _selClearConfirm() {
  if (SEL_CONFIRM_TIMER === null) return;
  clearTimeout(SEL_CONFIRM_TIMER);
  SEL_CONFIRM_TIMER = null;
}

function _selConfirm(res, target) {
  const el = (typeof byId === 'function') ? byId('send-armed') : null;
  if (!el) return;
  const text = _selConfirmText(res, target);
  if (!text) return;

  _selClearConfirm();
  el.textContent = text;
  el.hidden = false;

  const refused = !(res && res.ok);
  el.classList.toggle('is-refused', refused);
  el.classList.toggle('is-confirm', !refused);

  // The power colour as an inline style, not a class: there are seven of them
  // and they live in data/scenario.js, not the palette. A stylesheet rule
  // silently outranks an SVG presentation attribute (known-issues #15), which
  // is why every per-instance colour on this project is written as a style.
  const me = selPlayer();
  const power = (typeof POWERS !== 'undefined' && me) ? POWERS[me] : null;
  el.style.background = (!refused && power && power.color) ? power.color : '';

  SEL_CONFIRM_TIMER = setTimeout(function () {
    SEL_CONFIRM_TIMER = null;
    // Re-read the armed state rather than blanking unconditionally: the player
    // may well have pressed R again inside the two seconds, and a timer from
    // the previous order must never wipe the banner for the current one.
    _selPaintArmed();
  }, SEL_CONFIRM_MS);
}

function _selPaintArmed() {
  const el = (typeof byId === 'function') ? byId('send-armed') : null;
  if (!el) return;
  const verb = SEL_STATE.armed;
  // Arming supersedes a confirmation still on screen — "what the next click
  // will do" always outranks "what the last click did".
  _selClearConfirm();
  el.classList.remove('is-confirm');
  el.classList.remove('is-refused');
  el.style.background = '';
  // TWO ARMED VERBS NOW, and they need different chrome. `supply` is a one-line
  // instruction about the next CLICK; `build` is a numbered list answered by the
  // KEYBOARD. One banner cannot be both, so the build verb paints the chooser and
  // leaves this banner empty rather than showing a sentence nobody acts on.
  const banner = verb && verb !== 'build';
  el.textContent = banner ? SEL_ARMED_TEXT : '';
  el.hidden = !banner;
  _selPaintBuildChooser();
  // A class rather than inline style so style.css owns the look — and on the
  // board wrapper, not the element, because the cursor is the other half of the
  // signal and it has to change over the map.
  const app = document.querySelector('.app');
  if (app) app.classList.toggle('is-arming', !!verb);
}

// The destination click. Returns true if the click was CONSUMED, which is what
// stops it also being read as a selection toggle or a volley.
//
// ── BOTH BUTTONS NAME THE DESTINATION (player-reported, 2026-07) ────────
//
// Word for word: *"if you right click while setting, it just a normal send and
// doesn't go through."* This ran only from the LEFT button's branch of
// selOnMouseUp; the right button's branch returned before it and went straight
// to selReinforce. So while armed, a right-click on your own city marched the
// army there and created no route — and then clearSelection() inside selCommit
// disarmed and emptied the group on the way out, so the banner vanished exactly
// as it does on success. Measured on the live board: Berlin 65 -> 48.75, one
// wave created, `supplyTo` still empty, banner blank. With CMD held it is worse
// still — the group survives, so the banner keeps reading "SUPPLY — click a
// city" while the volley it just fired is already in the air.
//
// Three designs were available and the choice is not obvious, so it is written
// down:
//
//   1. right-click names the destination, same as left     <- CHOSEN
//   2. right-click is ignored while armed, and the banner says so
//   3. right-click cancels the arming, left commits
//
// (1), for three reasons in ascending order of weight. The player reached for
// the right button because it is ALREADY the button that means "send to my own
// city", so it is the button the gesture trains you to use. The banner says
// "click a city to add or remove it" and names no button — under (2) or (3) it
// would have to grow one, and a banner that has to disambiguate the pointing
// device is a mode confessing to itself. And decisively: arming exists so that
// the next click on your own ground means something DIFFERENT, so a button that
// quietly falls through to the old meaning is known-issue #18 in its purest
// form — an interaction answering a different question from the one on screen,
// and never looking wrong doing it. (2) is that same failure with a disclaimer.
// (3) gives one gesture two opposite meanings decided by which finger you used.
//
// The pan collision is real and is handled by POSITION, not by design choice:
// render/camera.js pans with the right button, so the call site sits inside the
// `!rd.moved` gate that selReinforce already sits inside. A right press that
// travelled is a pan and reaches neither.
//
// ── `cancelOnMiss` — the one place the two buttons still differ ─────────
//
// A left-click on anything that is not your own city CANCELS the arming: an
// enemy node, empty sea, a station lost since R was pressed. Consumed either
// way, because a click that both cancelled the arming AND fired a volley at the
// enemy under the cursor would be the worst possible reading of an ambiguous
// gesture.
//
// The right button does NOT cancel, and that is not a new asymmetry — it is the
// right button's existing house rule, left alone. selReinforce already treats a
// right press that is not on your own city as a MISS rather than an
// instruction ("right-clicking an enemy is a mis-aimed reinforcement, not a
// sneaky second way to attack"), and it has to: the right button is also the pan
// button, so a press that fell under SEL_RCLICK_SLOP_PX is far more often a pan
// that did not take than a considered statement. Cancelling on it would delete
// the armed state for no visible reason, and the player's next click on their
// own city would toggle the selection instead of drawing the route — which is
// the same silent-wrong-verb bug this whole change removes, reintroduced from
// the other side. Returning false lets the press fall through to selReinforce,
// which no-ops on exactly these targets.
function _selCommitArmed(sid, cancelOnMiss) {
  if (!SEL_STATE.armed) return false;

  // A BUILD NAMES NO DESTINATION — it happens in the cities already selected, so
  // there is nothing for a click to point at. Any press on the board cancels it,
  // which is the same escape hatch the supply verb has and means the chooser can
  // never be a state the player is stuck in. Returning false lets the press go on
  // to do whatever it would normally have done, so cancelling costs no click.
  if (SEL_STATE.armed === 'build') {
    _selDisarm();
    return false;
  }

  if (!sid || !selIsMine(sid)) {
    if (!cancelOnMiss) return false;
    _selDisarm();
    return true;
  }

  _selDisarm();
  _selApplyOrder(sid);
  return true;
}

// THE SELECTION SURVIVES. This is the one deliberate difference from selCommit,
// and it is not an oversight:
//
//   * A volley is SPENT. Its sources have just emptied themselves at a target,
//     so keeping them selected would offer up a group that no longer exists in
//     any useful form — hence §8's "selection clears".
//   * A supply line costs nothing and CHANGES nothing about the group. Setting
//     one is almost always followed by setting another — the same rear cities
//     feeding two or three points of the front is now the normal case, and it is
//     three presses of R with the same group still selected. Clearing here would
//     mean re-marqueeing those cities between every one of them.
//
// ONE applyCommand FOR THE WHOLE GROUP, not one per station. `{type:'order'}`
// already takes a list and already validates per station — an unowned entry is
// rejected on its own and the rest still apply (01-data-schema.md) — so a loop
// here would be N commands doing what one does, and would report N results the
// caller then has to merge. It also matters for correctness now and not just
// tidiness: the add-or-remove verdict is decided ONCE for the whole list (see
// _cmdApplyOrder), and N separate commands would each decide it alone and flip
// half the group the wrong way.
function _selApplyOrder(target) {
  const g = selGame();
  const me = selPlayer();
  if (!g || !me) return null;

  // Filtered here as well as validated in applyCommand. Not belt-and-braces:
  // "nothing selected" and "nothing selected is still mine" must both be silent
  // no-ops, and without the filter the second case would fire a command whose
  // every station comes back 'not-owned' and log a warning at the player for
  // pressing a key over a group that changed hands while they were looking.
  const stations = selectedSources().filter(selIsMine);
  if (!stations.length) return null;

  if (typeof applyCommand !== 'function') {
    console.warn('[render/select] applyCommand is not loaded — order dropped');
    return null;
  }

  const res = applyCommand(g, {
    type: 'order',
    owner: me,
    stations: stations,
    // A station id TOGGLES that supply line for the group; null CLEARS every
    // line the group has. Two meanings, one field, because they are the same
    // question — "which destinations do these cities serve" — answered with
    // one entry or with none.
    target: target || null,
  });

  if (!res || !res.ok) {
    console.warn('[render/select] order rejected:', res && res.reason, res && res.rejected);
  }

  // Say what happened, every time, including when nothing happened. See
  // _selConfirm — the old silence made a refused order and a successful one
  // look exactly alike.
  _selConfirm(res, target || null);
  // No selRedraw(). Nothing this file DRAWS depends on an order — the marker is
  // render/map.js's, on the station node, repainted by renderLive every frame
  // (which runs while paused, see app/loop.js), and the rail reads the order
  // live. Redrawing the carets and every preview line here would be work for a
  // picture that is already correct.
  return res;
}

// ── pinned API (01-data-schema.md, "Render / app API") ──────────────────

// Sorted array of currently selected station ids. Sorted because applyCommand()
// dedupes and sorts anyway, so matching it here keeps the ids a volley consumes
// independent of the order the player happened to click in.
function selectedSources() {
  return Array.from(SEL_STATE.selected).sort();
}

function clearSelection() {
  // An armed order with no sources is an order that cannot be given, so it goes
  // with the group rather than lying in wait to eat the next click.
  _selDisarm();
  SEL_STATE.selected.clear();
  SEL_STATE.hoverTarget = null;
  _selPaintLoaded();
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
  window.addEventListener('keyup', selOnModKey);
  // Cmd+Tab away with shift held and the flags would be frozen on forever;
  // a blur is the one moment we know for certain that nothing is held.
  window.addEventListener('blur', function () {
    if (!_selSyncMods(null)) return;
    if (SEL_STATE.hoverTarget) selRedraw();
  });
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
// The amount the next click would actually use — the persistent setting or the
// modifier override. Exported so the payload label, the preview and any check
// read one function rather than three copies of the same precedence rule.
window.selEffectiveFraction = selEffectiveFraction;
// The build verb, exported so the rail's build section fires the SAME code path
// the `b` key does rather than composing its own command — a second command
// builder is how the button and the key end up disagreeing (known-issues #9).
window.selBuild = _selBuild;

// Self-bootstrap, matching render/map.js: the board is drivable before
// app/main.js exists. Once the app layer lands it sets APP_OWNS_RENDER and
// calls initSelection() itself; initSelection() is idempotent either way.
document.addEventListener('DOMContentLoaded', function () {
  if (!window.APP_OWNS_RENDER) initSelection();
});
