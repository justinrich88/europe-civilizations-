# 01 — Data schema

The contract every file agrees on. Written before the map, renderer and sim so they can be built in parallel. If something here is wrong, change it *here first*, then in code.

Cross-references `00-vision.md`.

---

## Conventions

- Zero-build vanilla JS. Every file assigns to a global `const`; script order is declared in `index.html`.
- IDs are short lowercase strings, unique across their own namespace. Never renamed once authored.
- All coordinates are in a **1000 × 700 viewBox**, x east, y south. Roughly: Ireland `x≈60`, Moscow `x≈700`, north Norway `y≈40`, north Africa `y≈690`.
- Nothing in `data/` may reference anything in `sim/`, `render/` or `ai/`.

---

## `data/map.js` — **generated, do not hand-edit**

Produced by `node tools/build-map.js` from `tools/source/countries-50m.json` (world-atlas v2 / Natural Earth 1:50m, TopoJSON). To change the map, change the build script and re-run it.

Two earlier approaches failed and are recorded so they are not retried:

1. **One agent hand-authoring all of Europe** — exceeded the 32,000-token output cap on reasoning alone and wrote nothing (`known-issues.md #6`).
2. **Eight agents hand-authoring regions against a seam contract** — worked, verified clean, and produced a map that did not read as Europe. Correct by every check and still wrong.

TopoJSON is the fix because **its arcs are shared between adjacent polygons**. Two countries that border each other reference the same arc index, so they necessarily reference the same vertex ids. Gap-free borders and exact `neighbors` fall out of the data rather than being asserted after the fact. The build script dedupes **by arc identity, never by coordinate proximity** — that distinction is the whole reason this works.

The projection (Albers equal-area conic, φ1=43° φ2=62° λ0=15° φ0=52°) and the viewBox fit live in `tools/lib/project.js` and are shared with `tools/build-stations.js`, so stations placed from real city lon/lat land inside their country by construction.

Territories are real countries — 30 of them. The 1914 setting is carried by `data/scenario.js`, not by the shapes.

### `VERTS` — shared vertex table

```js
const VERTS = {
  v001: [412, 268],
  v002: [455, 291],
  // …~90–140 entries
};
```

**The single most important rule in the project:** two territories that border each other must reference the *same vertex ids* along their shared edge. Never two vertices at nearly the same coordinate. This guarantees no gaps or slivers, and lets adjacency be derived and checked against the declared list.

### `TERRITORIES`

```js
const TERRITORIES = {
  bra: {
    id: 'bra',
    name: 'Brandenburg',
    shape: ['v012','v013','v027','v026'],   // ordered vertex ids, closed implicitly
    label: [388, 272],                       // where the name is drawn
    terrain: 'plains',                       // plains | hills | mountains | forest | urban
    neighbors: ['sax','sil','han','pom'],    // declared; asserted against derived
    coastal: false,
  },
  // …
};
```

- `terrain` scopes to the whole territory (`00-vision.md §3`) — it modifies march time along links crossing into it and defense of stations inside it.
- `neighbors` is authored by hand *and* derived from shared vertex edges. `test/asserts.js` fails if they disagree. This is the main correctness check on the geometry.

---

## `data/stations.js`

```js
const STATIONS = {
  ber: {
    id: 'ber',
    name: 'Berlin',
    territory: 'bra',
    pos: [390, 275],          // must fall inside its territory's polygon
    type: 'holding',          // holding | multiplier | producer | defensive
    capacity: 60,             // logistic ceiling, units
    rate: 0.9,                // growth coefficient, ×BAL.GROWTH_BASE
    produces: 'infantry',     // infantry | artillery | armour — producers only
    defense: 1.0,             // additive defense bonus; defensive stations run high
    multiplier: null,         // multiplier stations only, e.g. 1.5
  },
  // …~90–110 entries
};
```

Type rules, per `00-vision.md §2`:

| type | `produces` | `capacity` | `rate` | `defense` | `multiplier` |
|---|---|---|---|---|---|
| `holding` | `infantry` | 25–80 by city size | 0.7–1.1 | 1.0 | `null` |
| `producer` | `artillery` or `armour` | 15–35 (low) | 0.4–0.6 | 1.0–1.2 | `null` |
| `multiplier` | `infantry` | 8–15 (very low) | 0.3 | 0.8 (soft) | 1.3–1.8 |
| `defensive` | `infantry` | 12–25 | 0.3–0.5 | 2.0–3.5 | `null` |

A multiplier station raises `rate` at every station in **its own territory and all adjacent territories**. Multipliers from several sources stack multiplicatively.

### `LINKS`

```js
const LINKS = [
  { a: 'ber', b: 'lei', dist: 42 },
  { a: 'dov', b: 'cal', dist: 55, sea: true },
];
```

- Undirected. Exactly one record per pair.
- `dist` drives march time — roughly the on-screen distance, hand-tuned at chokepoints.
- `sea: true` marks the handful of crossings (Dover, Baltic, Skagerrak, Adriatic, Gibraltar, Aegean). Slow, and punishing for artillery.
- The link graph must be **connected**, and every station reachable from its owner's capital at game start.

---

## `data/scenario.js`

```js
const POWERS = {
  ger: { id:'ger', name:'German Empire', color:'#5b7fbd', capital:'ber', ai:'expansionist' },
  // … gbr fra aut rus ita ott, plus `neutral`
};

const SETUP = {
  ber: { owner:'ger', units:{infantry:40, artillery:0, armour:0} },
  // every station id appears exactly once
};
```

`neutral` is a real power id with no AI and no capital. Unowned stations belong to it.

---

## `data/tuning.js`

Every balance constant, nothing else. One `BAL` object, heavily commented with rationale — matching the `0ad-levers` prototype's convention.

```js
const BAL = {
  TICK_MS: 100,
  GROWTH_BASE: 0.004,        // logistic coefficient per tick
  COMBAT_RATE: 0.05,         // casualty scale per tick
  SEND_FRACTION_DEFAULT: 0.75,
  ROUT_THRESHOLD: 0,         // 0 = fight to annihilation (§5)
  BATTLE_VARIANCE: 0.12,     // rolled once per engagement, not per tick
  DISCONNECT_DECAY: 0.002,
  CAPITULATE_FRACTION: 0.25,
  UNITS: {
    infantry:  { atk:1.0, def:1.2, speed:1.0 },
    artillery: { atk:1.8, def:0.6, speed:0.6, fortStrip:0.5 },
    armour:    { atk:1.5, def:0.9, speed:1.8 },
  },
  MATCHUP: { /* artillery>infantry, armour>artillery, infantry>armour */ },
  AI: { /* personality weights */ },
};
```

---

## Runtime state — `core/state.js`

Distinct from the static data above. This is the only thing that mutates.

```js
{
  tick: 0, speed: 1, paused: true, rng: <uint32>, winner: null,
  ownerEpoch: 0,
  powers:   { ger: { alive:true, relations:{fra:-40,…}, startTerritories:12 } },
  stations: { ber: { owner:'ger', units:{infantry:0,artillery:0,armour:0},
                     connected:true, growthMul:1.0,
                     supplyTo:[] } },                         // standing orders
  waves:    [ { id, owner, from, to, path:['ber','lei'], hop:0,
                progress:0.0, units:{…},
                standing:true,                                // standing orders only
                landing:{ ashore:0, total:0, per:{…} } } ],   // beachheads only
  battles:  { ber: { startedTick, variance, wobble } },
  orderStats: { sweeps, sends, unitsSent, standDowns, unitsLost, fights },
  seen:     { ger: { bru: { o:'fra', u:{…}, c:true, t:3120 } } },  // fog memory
  log:      [],
}
```

`station.supplyTo` is a **sorted array of destination station ids**, defaulting
to `[]` — see "Standing orders" below. Empty is the off switch; there is no
`'hold'` sentinel and no station "type" of order. It lives here rather than in
`data/stations.js` because it is **mutable player intent**, and `data/` is
static geometry.

> *Revised 2026-07.* This field replaced a two-verb `order: 'hold' | 'rally' |
> 'feed'` scheme. Both earlier designs made the sim decide something the player
> could not see — which rally a given feeder served — so the pairing was
> promoted into the data the player edits directly.

`state.seen` is **fog memory**: per observer, per station, what that power last
*saw* there and when — `o` owner, `u` units, `c` connected, `t` the tick it was
observed. Sparse: absent means never seen. Written by `observeTick(state)` from
the top of `aiTick`, for every alive power **including the human**, throttled to
`BAL.FOG.OBSERVE_INTERVAL`. Read only through `believedStation()`.

> **Why this is in state at all, when `02-visibility-and-sea.md` §1 says
> visibility is "derived, never stored".** Because those are two different
> objects and the doc names only one. *Visibility* — who can see what right now
> — is a pure function of ownership, `LINKS` and station `vision`; every input
> is a fact about the present, so it is fully reconstructable and storing it
> would be a second copy of a fact every capture invalidates (known-issues #9).
> `visibleTo()` is that function and holds no cache. *Memory* — "France saw
> Brussels at t=3120 holding 14.2 units" — is **not derivable from the board at
> t=3500 by any function whatsoever.** It is information generated by the
> passage of time, and the only thing you can do with information you cannot
> recompute is store it.
>
> It lives in `state` rather than in the renderer for three reasons, each of
> which alone would decide it. The design requires the AI's fog be symmetric
> with the player's; memory in `render/` would give the AI *binary* fog while
> the player got ternary, so the AI could never be baited by a stale number —
> asymmetric on precisely the axis fog exists to create. `test/node.js` and
> `tools/balance.js` load **no** `render/` file, so Milestone 6 would tune
> `BAL.AI` against a memoryless AI, i.e. a different game than ships. And
> `snapshot()` is `JSON.parse(JSON.stringify(state))` — anything outside
> `state` does not survive it, so a restored game would diverge from the run it
> came from. Same reasoning that already put `rng`, `aiMemo` and `aiLog` here.

The three levels are a **composition, not a fourth thing**:
`level = visible(now) ? 2 : remembered(ever) ? 1 : 0`. `believedStation()` is
the only function that can mint a 1; `visibleTo()` returns only 0 and 2 and its
contract is unchanged from before fog memory existed.

`wave.standing` is present **only on a wave created by a standing order**, and
only ever as `true`. An ordinary send produces a wave with no such property, so
a `send` command that predates the mechanic still yields a byte-identical wave.

Hard rules:

- **Unit counts are floats.** 100ms attrition rounds to zero otherwise. Floor only at render.
- Static geometry (shape, neighbors, capacity, type) lives in `data/`, **never** in state — state stays small and diffable.
- `rng` is the PRNG state and lives *inside* state, so a snapshot fully determines the future.
- Iterate via precomputed sorted id arrays, never `Object.keys` order.
- `sim/` and `ai/` must never touch `document`.
- **`ownerEpoch` is an integer counter, never a timestamp.** It counts station ownership changes. Routing is ownership-aware and cached (`routeFor` below), and this is the only thing that tells the cache the board moved. Change a station's owner **only** through `setStationOwner(state, sid, owner)` — a raw write to `state.stations[sid].owner` leaves the epoch behind and the next route may be answered from a search built against the old map. That includes test fixtures.

All mutation flows through one entry point:

```js
applyCommand(state, { type:'send',  owner, sources:[…], target, fraction,
                      types?, standing? })
applyCommand(state, { type:'order', owner, stations:[…], target })
```

which is what makes headless testing and replay free.

---

## Sim API — pinned names

`test/runner.js` probes for these by name. **If the sim exports something else, the six sim suites stay silently SKIPPED instead of failing** — the worst possible outcome, since the suite list still reads green. These names are therefore contractual.

| Global | File | Contract |
|---|---|---|
| `stepTick(state)` | `sim/step.js` | Advance exactly one `BAL.TICK_MS` tick. The only tick entry point. Never takes a `dt` — variable timesteps are what the fixed-timestep accumulator exists to prevent. |
| `applyCommand(state, cmd)` | `sim/commands.js` | The sole mutation entry point for both player and AI input. |

### Sim internals — phase functions

`stepTick` calls these **in this exact order**, once per tick. Each takes `(state)` and mutates it in place. The order is load-bearing and is itself part of the contract:

| # | Global | File | Responsibility |
|---|---|---|---|
| 1 | `growthTick(state)` | `sim/growth.js` | Logistic growth, multiplier reach scaled by control tier, disconnection decay |
| 2 | `ordersTick(state)` | `sim/movement.js` | Standing orders: each station ships surplus to every station in its `supplyTo` list, split evenly (throttled, not every tick) |
| 3 | `movementTick(state)` | `sim/movement.js` | Advance waves along links; resolve arrivals |
| 4 | `combatTick(state)` | `sim/combat.js` | Square-law attrition wherever hostile forces share a station; flip stations |
| 5 | `relationsTick(state)` | `sim/relations.js` | Balance-of-power drift (throttled, not every tick) |
| 6 | `victoryTick(state)` | `sim/victory.js` | Capitulation and win detection |

**Why this order.** Growth before movement so a station's send is based on units that already grew this tick. Movement before combat so arrivals fight on the tick they land (`progress >= 1` resolves immediately, never deferred). Combat before victory so a capital captured this tick is seen this tick.

**Standing orders sit between growth and movement**, and both halves are load-bearing. After growth, so a feeding city ships units it actually has this tick rather than last tick's. Before movement, so a stream created this tick starts marching this tick — placed after movement, every standing wave idles one tick before its first step, which no end-state assertion would notice and which makes `launchTick` a permanent one-tick lie to any renderer drawing an ETA from it.

`ordersTick` lives in `sim/movement.js`, not in a file of its own: every primitive it needs (the ownership-aware search, the link index, `_moveDeposit`) is already there, and a new `sim/orders.js` would also need a `<script>` tag in `index.html` — a phase that silently fails to load in the browser while passing every headless test is the exact shape of known-issues #9 and #16.

Helper contracts other files may rely on:

| Global | File | Contract |
|---|---|---|
| `stationPower(state, sid, side)` | `sim/combat.js` | Total combat Power for one side at a station, including defense, terrain and matchup |
| `growthMultiplier(state, sid)` | `sim/growth.js` | Product of all multiplier effects reaching this station, capped at `BAL.GROWTH_MUL_CAP` |
| `routeBetween(fromSid, toSid)` | `sim/movement.js` | **Geography.** Shortest path as an array of station ids, `null` if unreachable. Pure — depends only on `LINKS`, and must stay that way. Distance heuristics read it. |
| `routeFor(state, pid, fromSid, toSid)` | `sim/movement.js` | **Legality.** The path a wave of `pid` may actually walk on this board, or `null` when there is none. Same shape and tie-break as `routeBetween`. |
| `setStationOwner(state, sid, owner)` | `core/state.js` | Change who holds a station and bump `state.ownerEpoch`. The only supported way. Returns `true` if anything changed. **Also assigns a fresh empty `station.supplyTo`** — supply lines do not survive a capture. A *fresh array*, never `length = 0`, so a caller holding the old one is not emptied underneath it. See "Standing orders". |
| `ordersTick(state)` | `sim/movement.js` | Phase 2. Throttled to `BAL.ORDERS.INTERVAL`. |
| `standingOrderSend(state, sid)` | `sim/movement.js` | The **source's willingness**: units this station wants to ship, before the destination gets a say. Pure. Not what a readout should show — see the row below. |
| `standingOrderNext(state, sid)` | `sim/movement.js` | **What actually leaves** on the next sweep: `{ units, target, blocked, edges }`. `units` is `0` whenever anything blocks it, `target` is the station it is aimed at (kept even when blocked, so a panel can name the rally that is full) and `blocked` is `null` when it ships or one of `no-order` / `unreachable` / `at-keep-floor` / `destination-full` / `below-min-send`. **`edges` is one record per destination** — `{ target, units, blocked, shortfall }` — and it is what a readout must walk: the top-level `blocked` is `edges[0]`'s, chosen by the alphabet, so printing it over a city with three destinations describes the wrong one. **`shortfall`** is how many more units the SOURCE needs before it can pay for one whole stream (`KEEP_FLOOR × capacity + MIN_SEND / SEND_FRACTION − garrison`), and it is the field that separates *a city saving up* from *a line that lost its sweep* — two states `below-min-send` alone cannot tell apart. `0` on both when the reason is a fact about the destination. Pure, uncached, ~80µs on the 108-station board — one call per frame is free. **This is the number a readout shows.** |
| `standingOrderPlan(state, pid)` | `sim/movement.js` | The same answer for **every** feed city one power holds, in one search: `{ sid: { units, target, blocked } }`. Same planner, same ~80µs whether the power feeds one city or forty. Anything wanting the whole set — the empire header, the map's blocked-feeder marks — calls this, never `standingOrderNext` in a loop. |

### The traversal rule

A wave may march **through** stations its owner holds. It may not march through a station held by any other power, and it may not march through **neutral** ground either — neutral is not passable. The **final** station in a path is exempt — walking into an enemy city is the attack itself, whether that city is a rival's or neutral's.

Keyed on **ownership, not on war status**. Relations drift every tick (`sim/relations.js`), so a war-keyed rule would open and close corridors underneath the player for reasons that are off screen; ownership is drawn on the map and can be reasoned about.

> *Revised 2026-07.* Neutral used to count as passable, and it was nearly harmless under the old opening — most ground between two powers already belonged to a power. The capital-only opening changed that: 101 of 108 stations are neutral at turn zero, so "neutral is passable" turned the entire map into an open highway on turn one (measured: Britain marched its opening garrison from London through three unfought garrisons and captured Berlin outright). Expansion is supposed to be the whole game and neutral cities are supposed to be fought down one at a time — neither held while you could walk past them. See `_moveCanTraverse` in `sim/movement.js`, which is `st.owner === pid`: own ground only, no neutral exception.

Two consequences other files must honour:

- `applyCommand` validates each source with `commandRoute(src, target, state, owner)` and rejects a source with no legal path as **`'no-route'`**, per-source, mutating nothing for that source.
- A wave's path is fixed at send time. If an intermediate station on it changes hands while the wave is in the air, the wave is **intercepted**: it stops there and resolves as an arrival at that station, fighting whoever now holds it. Implemented by truncating `w.path`, so the arrival convention below is unchanged — a wave is always at `path[path.length - 1]`. Neutral intermediates never intercept.

Nothing in `sim/` may touch `document`, call `Math.random`, or read `Date.now`. Randomness comes only from the seeded PRNG in `core/rng.js` threaded through `state.rng`.

**Wave arrival convention:** a wave is *arrived* when `progress >= 1` on its final hop. Tests drive combat by pushing a wave with `progress: 1` onto `state.waves` and calling `stepTick`. `sim/movement.js` must resolve arrival on the tick it is seen, not defer to the next one.

**`landing` — the beachhead remainder** (`02-visibility-and-sea.md` §3b). Present on a wave **only** while it is coming ashore, and only when its **final hop is a sea link**; a land arrival never carries one and is committed whole on the tick it lands. A sea arrival resolves on the tick it is seen as usual, but commits `1/BAL.LANDING_TICKS` of its strength per tick and stays on `state.waves` until empty.

| Field | Meaning |
|---|---|
| `ashore` | Units already committed to the station |
| `total` | Strength at the moment the landing began — **after** the sea artillery toll, which is charged once for the whole landing and never per echelon |
| `per` | Units of each type committed per tick, fixed at the start so echelons are a constant fraction of *original* strength and the force lands in its original mix |

`w.units` continues to hold the units **still at sea**, so nothing else in the sim needs a new place to look for a wave's strength. Those units are not in `station.attackers` and therefore cannot be hit — that is the whole mechanic, and it needs no combat code. The merge-or-attack decision is re-taken **per echelon**, so a station that flips to the landing power mid-landing absorbs the remainder as reinforcements (consistent with `WAVE_REROUTE_ON_LOSS: false`), while one that flips to a third power keeps receiving attackers. The final echelon flushes whatever is left rather than trickling a sub-`MIN_SEND_UNITS` residue. Renderers may read `landing` to draw the beachhead; nothing in `sim/` reads it except `sim/movement.js`.

### Standing orders

One pipe with two ends and an off switch, set per station and stored as `state.stations[sid].order`. Constants live in `BAL.ORDERS` (`data/tuning.js` §11).

| order | role | behaviour |
|---|---|---|
| `hold` *(default)* | off | Accumulate. Never auto-sends. Exactly the behaviour the game had before this existed. |
| `rally` | sink | Nearby `feed` stations stream into it. |
| `feed` | source | Ships a small share of its surplus, on a throttle, to the nearest `rally`; with no rally set, to the nearest owned station **on the front**. |

**`00-vision.md` §8 says "the board never plays itself". This is the one amendment to that sentence, and the scope *is* the amendment.**

- **Logistics can be automated; commitment cannot.** A standing order moves units **only between stations their owner already holds**. It never attacks, never targets ground its owner does not hold, and never initiates combat. Every attack in the game remains a deliberate one-shot click. Enforced in two places: `applyCommand` fails a `standing` send whose target is not held by its owner (`'standing-target-not-owned'`), and `_moveDeposit` counts any standing deposit onto unheld ground in `state.orderStats.fights` — **a tripwire that must stay 0 forever** — rather than committing it.
- **Standing waves are not committed waves.** `BAL.WAVE_REROUTE_ON_LOSS` is `false` because a march is a committed decision, but a standing wave is not a decision anyone made about *this* march. If its destination is no longer held by its owner, or its path would take it into ground its owner does not hold, it **stands down**: it stops at the last station on its path its owner still holds and merges into that garrison. Without this, `_moveIntercepts` would feed a steady trickle into a battle a few units at a time — *defeat in detail*, the mistake §8 names as the defining one, committed automatically on the player's behalf. With the whole traversed prefix lost, the stream is dissolved and counted in `orderStats.unitsLost`; marching on would mean fighting and teleporting it elsewhere would be a bigger lie.
- **A rally is a mustering point, not a warehouse.** Capacity is a real ceiling everywhere else in this game — `growthTick` bleeds anything over it at `OVERSTACK_DECAY`, and §2 says a full station has stopped paying dividends — so **automation obeys the same ceiling the player does.** A seed with no headroom is not a valid destination *for that sweep* (so a further rally with room beats a nearer one without); with no seed anywhere having room, the feed station is a no-op and keeps growing; and a send is **clamped to the destination's remaining headroom**, counting everything already in the air to it, so several feeders in one sweep cannot collectively bust the ceiling. Shipped without this rule and measured live: 7 feeders into a 28-capacity rally settle near **556 units — destroying 100% of everything fed to them, forever**, hidden inside a rising empire total because the drained feeders drop off the logistic ceiling and regrow. Residual: a stream sized against today's headroom lands after a march and the destination grows in the meantime, so a rally can finish ~5% over and bleed back down. That is growth's doing, not the send's; the *sizing* invariant is exact and is asserted as such.
- **The front** is an owned station **adjacent to any station its owner does not hold** — neutral *or* hostile. With the capital-only opening 101 of 108 stations are neutral, so an enemy-only definition would be empty for most of a game and the fallback would silently never fire.
- **An unreachable rally is a no-op, not an error.** Routing is ownership-aware and a rally can be cut off between one sweep and the next; a feed station with nowhere legal to ship simply keeps its units.
- **An order does not survive a capture.** `setStationOwner` resets `order` to `'hold'`, so a captured `feed` cannot start draining the front-line city its new owner just paid for. Done inside the setter so no capture path can forget.
- **The phase is throttled** to `BAL.ORDERS.INTERVAL` (25 ticks) for the same reason `CAPITULATE_CHECK_INTERVAL` exists: a whole-board scan every tick is waste and nothing here is time-critical.
- **One planner decides, two callers read it.** `_ordPlanPower(state, pid)` is the whole decision — which seeds are open, which is nearest, the keep floor, the headroom clamp and the running per-sweep total. `_ordSweepPower` does nothing but issue what it says, and `standingOrderNext` does nothing but report it. That is *why* the readout cannot drift from the sweep, and it is asserted rather than assumed: `standingOrderNext predicts every sweep EXACTLY` compares the prediction against what `applyCommand` really shipped, per feed station, on every sweep of a 1400-tick run, with vacuity guards requiring both blocked and unblocked cases to have occurred.
- **A blocked feeder is visible without clicking it.** On the map, the order arrow is struck through with a bar in the halo colour and dimmed (`.station-ordergroup.is-blocked`, `MAP_ORDER_BLOCK_D`). No channel was invented for this: it modulates the order marker itself, which is already the order channel, and a battle still takes the slot outright. The read is throttled on **sim ticks**, so a paused board and a board with no `feed` cities both cost nothing.

`test/runner.js` → `sim / standing orders` holds all of this. Several tests carry an explicit control (a manual wave in the same race *must* fight; a floor that never binds fails the test; the willingness must be non-zero on exactly the stations the new number says ship nothing) because a test that passes against broken code is worse than no test — known-issues #8.

If any of this needs to change, change it *here first*, then update `simFns()` in `test/runner.js`, then the sim.

---

## Render / app API — pinned names

Same contract discipline as the sim above, for the same reason: three agents built `sim/` in parallel without talking to each other and nothing collided, because every name they had to share was written down first.

**The single global game state is `window.GAME`**, created by `app/main.js`. Nothing else creates a state. `sim/` never reads it — the sim only ever receives a state as an argument.

| Global | File | Contract |
|---|---|---|
| `renderBoard()` | `render/map.js` | Full rebuild of the static layers: territories, borders, links, labels. Expensive. Called once at startup and after nothing else. |
| `renderLive(state)` | `render/map.js` | Per-frame update of everything that changes: garrison numbers, station ownership colours, territory tint and control tier. Must **mutate existing DOM nodes, never rebuild them** — rebuilding 108 `<g>` elements every frame kills selection and hover state. |
| `renderWaves(state)` | `render/waves.js` | Draw/update/remove in-transit stack markers into `#g-waves`, positioned by interpolating each wave's current hop. |
| `renderHud(state)` | `render/hud.js` | Territory count, total forces, day counter. The power strip is gone (see `render/standings.js`) and the ticker is now a rail section registered by this file, pumped by the rail rather than by `renderHud`. |
| `initSelection()` | `render/select.js` | Wire up marquee, click and keyboard selection on `#board`. Called once. |
| `selectedSources()` | `render/select.js` | Sorted array of currently selected station ids. The only way other files read the selection. |
| `clearSelection()` | `render/select.js` | Drop all selection and any preview lines. |
| `startLoop()` / `setSpeed(n)` | `app/loop.js` | Fixed-timestep accumulator. `setSpeed(0)` pauses. Speed multiplies **time consumed, never the timestep** — 4x is literally "run more ticks", so physics is identical at every speed. Catch-up capped at `BAL.MAX_TICKS_PER_FRAME` so a backgrounded tab cannot death-spiral. |
| `PLAYER` | `app/loop.js` | Which power the human plays (`'ger'`). Read by selection and the HUD to decide what is selectable and whose numbers are shown. |

`state.speed` means **speed when not paused** — it never becomes 0, so pausing and resuming returns you to the speed you were at. `state.paused` is the separate flag. `index.html` encodes the pause button as `data-speed="0"` purely as a DOM convention.

**Layer ownership.** `#g-territories`, `#g-borders`, `#g-links`, `#g-labels` belong to `render/map.js`. `#g-stations` belongs to `render/map.js` for creation and `renderLive` for updates. `#g-waves` belongs to `render/waves.js`. `#g-ui` belongs to `render/select.js` (marquee rectangle, preview lines, ETA labels). No file touches another's layer.

**`#g-ui` must be `pointer-events: none`.** It is the last `<g>` in `index.html`, so it paints over `#g-stations`. Without that rule the selection carets and preview lines sit on top of the very node you are trying to click and swallow the commit — the game becomes unplayable in a way that produces no error. This is a property of the *layer*, not of whichever file happens to draw into it, so it survives a change of owner or a change of layer order.

Two more helper contracts, both in `sim/commands.js` and both load-bearing for the preview lines:

| Global | File | Contract |
|---|---|---|
| `commandRoute(fromSid, toSid[, state, pid])` | `sim/commands.js` | Route a send will take; `null` if unreachable. With `state` and `pid` it returns the **legal** route (`routeFor`); with two arguments only, the geographic one (`routeBetween`). Falls back to its own BFS while `sim/movement.js` is unloaded. |
| `routeEtaTicks(route, units)` | `sim/commands.js` | Estimated ticks for a stack to walk a route, at the speed of its slowest unit type. |

The preview **must** call these rather than estimating, or the ETAs shown before a commit will not match the waves the commit produces — which makes the preview worse than nothing, since avoiding defeat in detail is exactly what it exists for. A rename here degrades the preview to blank lines without failing any test.

**The preview must pass `state` and `PLAYER`.** `commandRoute(from, to)` still answers with geography, and geography is no longer what a send does: a two-argument preview will draw a line straight through an enemy city and the commit will then reject that source with `'no-route'`. A source for which `commandRoute(src, target, GAME, PLAYER)` returns `null` has no legal send and should be drawn as refused rather than as a route.

**Input funnels to `applyCommand`.** A commit builds `{ type:'send', owner, sources, target, fraction }` and calls `applyCommand(GAME, cmd)` — the same entry point the AI uses. There is no second path by which the board changes, which is what keeps replay and headless testing free.

Nothing in `render/` or `app/` may mutate state directly. Read freely, write only through `applyCommand`.

**What a renderer needs for standing orders.** Four reads and one write, no more:

| | |
|---|---|
| `stationSupply(state, sid)` | Sorted destination ids this station supplies; `[]` when none, never null. **It is the stored array, not a copy — read it, never mutate it.** O(1), safe every frame. Do not read `state.stations[sid].supplyTo` directly: the accessor defaults a snapshot written before the field existed. |
| `stationSuppliedBy(state, sid)` | Sorted source ids shipping *to* this station, scoped to its own owner. **O(stations), deliberately no index** — an index is a second copy of the same fact, invalidated by every capture and every order edit (known-issues #9). Fine for one station per frame (the hovered city); **not safe in a loop over the board.** |
| `wave.standing === true` | This stack is a standing stream, not a committed march. Absent on every other wave. Draw it thinner/dimmer than a volley — the visual difference is the player's only cue that a trail is automatic. |
| `standingOrderNext(state, sid)` | `{ units, edges:[{target,units,blocked}], blocked, target }` — what **actually** leaves on the next sweep, per destination, and why it does not. `units` is the total across all edges, `0` when everything is blocked; `blocked` is `null` when `units > 0`, else the first edge's reason, or `'no-order'` when the city supplies nowhere. The number a panel shows for **one** station. One call per frame is free. |
| `standingOrderPlan(state, pid)` | The same, keyed by source id, for every supplying city a power holds, in **one** pass. **Anything wanting more than one station calls this** — `standingOrderNext` plans the whole power in order to answer about one station, so one call per frame is fine and a loop over the board is not. Both are pure (asserted). |
| `standingOrderSend(state, sid)` | Units this station is **willing** to ship, `0` if none. The source's side only, and **not** what to print: the two stopped being the same number when the headroom ceiling landed, and a panel showing this one advertises a stream a full rally is taking none of. Quote it as the *fraction rule*, never as a forecast. |
| `state.orderStats` | `{ sweeps, sends, unitsSent, standDowns, unitsLost, fights }`. `fights` is a tripwire that must always read 0. |
| `applyCommand(GAME, { type:'order', owner:PLAYER, stations:selectedSources(), target:'lei' })` | The **only** way to set a supply line. `target` is a station id to **toggle**, or `null` to clear every line on the selected stations. The add/remove verdict is decided **once for the whole group** in a read-only first pass — if any selected station lacks the target, the whole group adds it — so a mixed selection resolves one way rather than per station. Per-station validation: an unowned station in the list is rejected on its own (`'not-owned'`) and the rest still apply. |

Each entry in `result.accepted` is `{ station, target, added, changed }`. **`changed` is the one to report to the player** — `accepted` lists every station the command *applied to*, including no-ops, so a confirmation built on `accepted.length` will claim "3 cities cleared" when none of the three had a line (known-issues #18).

A station's supply list is emptied when it changes hands — `setStationOwner` does it, and it is the **only** sanctioned way to transfer a station, because a raw write also leaves `state.ownerEpoch` stale. A panel must therefore read `stationSupply` live rather than caching it, and anything caching route geometry must invalidate on `ownerEpoch` as well as on the list itself.

---

## AI API — pinned names

Milestone 4. Same discipline, same reason. The AI is split across two files so
the *scoring* question ("which station is worth taking?") and the *execution*
question ("can I actually take it, and with what?") can be reasoned about — and
changed — independently. `ai/score.js` loads first and knows nothing about
commands or cadence; `ai/ai.js` loads second and owns everything that mutates.

**The AI is optional.** `test/node.js` and `tools/balance.js` skip missing
files, and `stepTick` calls `aiTick` only if it is defined. A build with no
`ai/` directory must still run, or every sim test becomes hostage to the AI.

| Global | File | Contract |
|---|---|---|
| `aiTick(state)` | `ai/ai.js` | **Phase 0**, before `growthTick`. Runs the cadence for every alive non-neutral power, calls `aiDecide`, and applies the result through `applyCommand`. The only thing in `ai/` that mutates. |
| `aiDecide(state, pid)` | `ai/ai.js` | Returns a **decision object** (below) or `null` if this power is not eligible to act at all. **Must not mutate `state`** apart from drawing from `state.rng`, so a decision can be inspected in a test without playing it. |
| `aiContext(state, pid)` | `ai/score.js` | Per-decision cached facts. Built once per decision and passed to every candidate, so scoring twelve targets does not redo the same BFS twelve times. |
| `aiCandidates(state, pid, ctx)` | `ai/score.js` | Scored candidate targets, **sorted by score descending**, truncated to `BAL.AI.CANDIDATES_PER_DECISION`. |
| `aiScoreTarget(state, pid, sid, ctx)` | `ai/score.js` | Utility of one target. Returns `{ score, terms }`. Pure — no state mutation, no rng. |
| `aiDecisions(state, pid, n)` | `ai/ai.js` | The last `n` log entries, newest last. `pid` `null` means all powers. The debugging surface §6 demands. |

### `aiContext(state, pid)` — the shared shape

Both files read this, so it is contractual rather than an implementation detail:

```js
{
  pid:         'ger',
  personality: { aggression, minOddsMul, leaderWeight, ... },  // never null; a
                                                               // power with no
                                                               // declared type
                                                               // gets neutral 1s
  own:      ['aal', 'ber', ...],   // sorted station ids this power holds
  hops:     { sid: n },            // link-hops from the NEAREST owned station,
                                   // over OWN GROUND ONLY -- see the warning
                                   // below. In practice n is only ever 0 or 1.
  vis:      { sid: 0|2 },          // visibleTo() for this power, one solve per
                                   // decision (fog, Milestone 5.7)
  leader:      'rus' | null,       // current territory-count leader -- TRUE
  leaderShare: 0.34,               // board, deliberately never fogged; see
                                   // 02-visibility-and-sea.md
  ownForces:   1842,               // total units, for commitment sizing
}
```

> **`hops` never exceeds 1, and `TARGET_MAX_HOPS` / `SOURCE_MAX_HOPS` are dead
> config.** *Measured 2026-07*, independently, twice.
>
> The comment this block used to carry said the BFS ran "over PASSABLE ground
> only (own + neutral, the `routeFor` rule)" and was "capped at
> `max(TARGET_MAX_HOPS, SOURCE_MAX_HOPS)`". Both halves are false. The
> predicate underneath (`_aiScoreCanTraverse`, `ai/score.js`) is
> `st.owner === pid` — **neutral is not passable**, changed when Britain
> captured Berlin on turn one (`sim/movement.js:176`) — and the code was
> updated while three separate comment blocks were not.
>
> The consequence is larger than a stale comment. The BFS **seeds every owned
> station at hop 0** and then expands only through own ground, so its frontier
> is empty after a single pass. `hops` therefore contains **0 and 1 and
> nothing else**, no matter what the constants say. Sampled across a 12,000-
> tick game, all seven powers, 24 sample points: hop values present were
> `{0: 1391, 1: 1545}`. Nothing at 2. `TARGET_MAX_HOPS` is 2 and
> `SOURCE_MAX_HOPS` is 3; **neither has any effect on anything.**
>
> **The AI therefore has no strategic horizon.** It only ever considers targets
> directly adjacent to ground it already holds. It cannot plan two moves out,
> cannot mass against a target it does not already border, and cannot be
> baited — because it never looks far enough to be baited.
>
> **This makes fog nearly inert for the AI at the attack gate**, which is why
> Milestone 5.7 moved balance by less than one standard deviation. Every held
> station has `vision >= 1`, so everything one hop out is lit at level 2; and
> a wave may only traverse own ground, so anything legally attackable is
> adjacent to something held. Measured: **1,258 of 1,258 candidates at level
> 2, none fogged, none hidden.** The believed board and the true board are
> provably equal at every point where the AI decides an attack.
>
> The believed-board seam is still correct and still required — it becomes
> load-bearing the instant either fact moves (a wider traversal rule, a real
> multi-hop horizon, or `vision` dropping below 1 anywhere). But **do not tune
> `TARGET_MAX_HOPS` in Milestone 6 expecting it to do something.** Fix the
> horizon first, or delete the constants.

### The decision object

```js
{
  tick, power,
  kind:    'attack' | 'hold' | 'stage',
  target:  'bru' | null,   // on 'stage' this is the DEPOT being reinforced,
                           // a station the power already owns
  stageFor: 'ist' | null,  // 'stage' only: the enemy station the mass is being
                           // assembled against
  score:   14.2,
  terms:   { multiplier: 3.0, weakness: 2.1, proximity: 1.2, ... },
  odds:    2.4,          // estimated attacker:defender POWER ratio, not units
  minOdds: 1.19,         // BAL.AI.MIN_ODDS x personality.minOddsMul
  sources: ['aal','col'],
  fraction: 0.75,
  reason:  null | 'no-candidates' | 'odds-too-low' | 'no-sources' | 'garrison-floor'
                | 'no-route'    // sources could pay, but every path there runs
                                // through another power's ground
                | 'stage-massed' | 'stage-no-feeders'
                | 'staging'          // always, and only, on kind 'stage'
                | 'peace-exhausted', // on an ATTACK: nothing was reachable but
                                     // ground held by a power at peace
  rejected: []           // populated only when BAL.AI.LOG_REJECTED
}
```

`kind: 'hold'` with a `reason` is a **real, logged decision**, not an absence of
one. A power that does nothing for two minutes must be able to say why it did
nothing, or it is indistinguishable from a power whose code never ran — which
is the single hardest AI bug to see (§6: *"a passive AI is otherwise
undebuggable"*).

`kind: 'stage'` is an **order**, not a hold: a many-to-one send whose target is
a station the power already holds, so the wave merges into that garrison rather
than fighting (`_moveDeposit`). It exists because `attack | hold` alone froze
the board — a power whose best target needs more force than its ETA-eligible
sources hold cannot attack, and holding does nothing, so it stands still
forever while its interior sits at capacity not growing. Staging never sends
anything at an enemy; it changes where the power's own units are standing.

`render/ailog.js` renders any non-`hold` kind with the label *attack*, so a
staging decision currently reads as an attack on a friendly city with reason
`staging`. Cosmetic, and the panel is outside the AI's ownership.

### Log storage

`state.aiLog` is a plain array used as a **ring buffer** capped at
`BAL.AI.LOG_MAX`. It lives inside the state so a snapshot still explains
itself, and so a Monte Carlo batch cannot leak memory across hundreds of games.
Trim from the front on push.

### Rules the AI inherits

- **Orders go through `applyCommand` and nowhere else.** The AI has no
  privileged path to the board. If a volley would be illegal for the player it
  is illegal for the AI, and `applyCommand`'s `rejected` array is the AI's
  feedback channel.
- **Odds are a POWER ratio, not a unit ratio.** Infantry defends at 1.2 and
  attacks at 1.0, so 2:1 in units is only 1.67:1 in power. Comparing unit counts
  makes `MIN_ODDS` mean something different from what its comment says and the
  AI attacks into fights it loses. Use `stationPower(state, sid, side)`.
- **`neutral` is a real power id** in `POWERS` and a legitimate return from
  `territoryControl(...).owner`. It is never an actor: it takes no decisions,
  and `atWar` does not gate attacking it.
- Nothing in `ai/` may touch `document`, `Math.random` or `Date.now`.

---

## Render API — Milestone 5 additions

Same pinned-name discipline. Four files written in parallel; these are the
names they had to agree on.

| Global | File | Contract |
|---|---|---|
| `renderCoverage(state)` | `render/coverage.js` | Draw multiplier reach into `#g-coverage`. Called per frame; must no-op cheaply when the highlighted set has not changed. |
| `setCoverageFocus(sid)` | `render/coverage.js` | Show the reach of one multiplier station, or clear with `null`. The only way other files drive the overlay. |
| `renderReadout(state)` | `render/readout.js` | Per-frame pump for the **whole rail**, not just the station panel — it is the only per-frame hook `app/loop.js` offers this file, so every rail section rides on it. Runs each registered section's `update`. |
| `setReadoutFocus(sid)` | `render/readout.js` | Which station the readout describes. `null` no longer hides anything — the rail is permanent, so it drops the station section back to its idle body. |
| `railAddSection(spec)` | `render/readout.js` | Add (or replace, by `id`) a section in the right-hand rail. **The only supported way to put anything in `#rail`.** See below. |
| `renderVictory(state)` | `render/victory.js` | Show the end-of-game screen when `state.winner` is set; no-op otherwise. |

**Layer ownership.** `#g-coverage` belongs to `render/coverage.js` and to
nothing else. Like `#g-ui` and `#g-waves` it is `pointer-events: none` — any
layer over the board that accepts pointer events eats the click that commits an
attack, and the game stops responding with no error.

**`state.winner` can be the string `'draw'`.** `sim/victory.js` sets it when
`BAL.MAX_GAME_TICKS` is reached so a stalemated Monte Carlo run cannot hang. It
is not a power id, and `POWERS['draw']` does not exist. Anything reading
`state.winner` must handle it — this is the same class of mistake as assuming
`territoryControl(...).owner` is never `'neutral'`.

**Hover is shared.** `render/select.js` owns pointer handling on `#board`.
Readout and coverage focus are driven *from* it via `setReadoutFocus` /
`setCoverageFocus`; neither file attaches its own board-wide listener, or two
handlers fight over the same hover.

### The rail — `#rail`, and how to add to it

`index.html` wraps the board and the rail in `.stage`, a **row** flex:

```
.app (column)
  ├── header.hud
  ├── div.stage (row)
  │     ├── main.board-wrap  →  svg#board
  │     └── aside#rail       →  div#send-control.rail-section   (static markup)
  │                             <section class="rail-section"> … (railAddSection)
  └── .ailog                 (render/ailog.js appends here)
```

**There is no bottom bar.** It held the send amount, a gesture hint, a strip of
power chips and the ticker, and it cost 58px of board *height* at the 800×900
window the game is played at (known-issues #17) while the rail beside it was
measured showing 666px of empty column. The send amount moved into the rail as
static markup; the hint was deleted (`render/help.js` documents every gesture);
the chips were replaced by `render/standings.js`; the ticker became a rail
section pinned to the floor.

`#send-control` is **static markup and the rail's first child**, not a section,
because `app/main.js` wires it by id during boot and `railAddSection()` does not
build until the first frame. `railAddSection` appends, so every JS section lands
beneath it.

The rail is a **DOM sibling of the board, never an overlay**, for the same
reason `.ailog` is: a panel over `#board` that accepts pointer events swallows
the click that commits an attack and the game stops responding with no error at
all. In normal flow it displaces the board instead — the SVG has a viewBox and
simply rescales — so it is safe by construction rather than by a rule someone
has to remember. Sections may therefore take pointer events freely.

Narrowing the board is transparent to selection: `render/camera.js` has a
`ResizeObserver` on `#board` and rebuilds its fit rect, so `cameraView()`'s
aspect keeps matching the element's and `getScreenCTM()` keeps mapping client
pixels onto the viewBox exactly. Verified after the change — 60/60 stations at
scale 1 and 18/18 visible stations at scale 4 hit-test to themselves via
`document.elementFromPoint`, and a real marquee drag selects exactly the set
computed independently from station coordinates.

**The rail is a stack of sections and it is always visible.** It is never
allowed to go blank: the station section swaps to an empire-at-a-glance body
when nothing is hovered, because a fixed-width column that empties out reads as
a broken layout rather than as "nothing selected".

**To add a section, call `railAddSection` — do not append to `#rail` by hand,
and do not invent a second convention.** This is the seam; there is no
privileged path, the station readout registers through it too.

```js
railAddSection({
  id:     'supply',                    // unique; a repeat id REPLACES
  title:  'Supply',                    // optional header, omit for none
  order:  20,                          // ascending; station detail is 10
  build:  function (host) { … return nodes; },        // runs ONCE
  update: function (state, nodes) { … return true; }, // runs EVERY FRAME
});
```

| Rule | Why |
|---|---|
| `build` runs once; `update` must **mutate** those nodes, never rebuild them | `renderReadout` runs at 60fps; rebuilding thrashes layout and kills text selection |
| `update` must not mutate state | `render/` reads — same rule as everything else here |
| `update` returns `false` to hide the section this frame, `true`/`undefined` to show it | one `[hidden]` write per change, not per frame |
| A throw is caught; the section is retired after 3 consecutive failures | mirrors `safeRender` in `app/loop.js`, so one bad section cannot take the readout — or the loop — down with it |
| Registration may happen at any time, before or after the first frame | the rail re-sorts when the registry changes, so script order in `index.html` does not matter |

Do not add speculative empty sections. Rail width and the section stack live in
the `rail:` marker block in `style.css`.

### Camera — pinned names

| Global | File | Contract |
|---|---|---|
| `initCamera()` | `render/camera.js` | Wire zoom/pan on `#board`. Called once, after `renderBoard()`. |
| `cameraReset()` | `render/camera.js` | Return to the full-board view. |
| `cameraView()` | `render/camera.js` | Current `{x, y, w, h, scale}` — read-only, for tests and the console. |
| `cameraScale()` | `render/camera.js` | Current zoom, `1..4`. Allocation-free; safe to call every frame. |
| `cameraSymbolScale()` | `render/camera.js` | The factor a symbol must be scaled by to hold a constant on-screen size (`scale ^ -CAM_SYMBOL_EXP`). Returns `1` before `initCamera()`. |
| `onCameraChange(fn)` | `render/camera.js` | Subscribe to camera writes; `fn(scale)` fires after zoom, pan, reset and resize. Returns an unsubscribe function. |
| `mapApplySymbolScale(force)` | `render/map.js` | Rewrite station and territory-label transforms for the current symbol scale. No-op when the scale has not moved. |
| `--cam-scale` (CSS var on `:root`) | `render/camera.js` | Current zoom, republished on every camera write, for stylesheet-driven compensation. |

**The camera moves the `viewBox` and nothing else.** It must never apply a
`transform` to a layer group: `render/select.js` maps client pixels to viewBox
units through `getScreenCTM().inverse()` and hit-tests with
`closest('[data-station]')`, so a viewBox change is transparent to selection
while a group transform would silently desynchronise the marquee from the nodes.

**Symbol counter-scaling is per-symbol, never camera-level.** Because the
viewBox magnifies geography and symbols alike, every renderer that draws a
*symbol* — station groups, territory labels, station names, `×N` annotations,
wave markers, selection carets, preview ETA labels — writes
`transform="translate(x,y) scale(cameraSymbolScale())"` about that symbol's own
anchor. Geography (territory fills, borders, links, coverage washes) is *not*
counter-scaled; link and trail stroke weight is held constant with
`vector-effect: non-scaling-stroke` in `style.css`. This is per-symbol precisely
so rule above still holds: there is no group transform for the camera to
desynchronise hit-testing with. `CAM_SYMBOL_EXP` in `render/camera.js` is the
single knob (`1` = fully constant on-screen size).

Anything comparing a distance in viewBox units against a threshold meant to feel
constant on screen must divide by `cameraScale()` **at the comparison**, not
redefine the constant — see `SEL_CLICK_SLOP` / `selClickSlop()` in
`render/select.js`.

Left-drag belongs to the marquee. `selOnMouseDown` already ignores
`evt.button !== 0`, so pan must use a non-left button (or a modifier).
Pan bindings: right- or middle-drag, and the four **arrow keys**. Arrow pan is a
*velocity* integrated per frame by camera.js's own `requestAnimationFrame` loop
(`CAM_PAN_SPEED`, in **view-widths per second**, so it is zoom-independent), not
a step per keydown — OS key repeat is ignored. The loop starts on the first
keydown and cancels itself once the velocity has ramped to zero, so it costs
nothing when idle, and it is deliberately independent of `app/loop.js` so the
camera still pans while the game is paused. `blur` and a hidden tab stop the
*motion* only; every other camera control keeps working.
Zoom: wheel, the on-screen `+`/`−`, and `-`/`=`; `0` resets.
