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
  powers:   { ger: { alive:true, relations:{fra:-40,…}, startTerritories:12 } },
  stations: { ber: { owner:'ger', units:{infantry:0,artillery:0,armour:0},
                     connected:true, growthMul:1.0 } },
  waves:    [ { id, owner, from, to, path:['ber','lei'], hop:0,
                progress:0.0, units:{…} } ],
  battles:  { ber: { startedTick, variance, wobble } },
  log:      [],
}
```

Hard rules:

- **Unit counts are floats.** 100ms attrition rounds to zero otherwise. Floor only at render.
- Static geometry (shape, neighbors, capacity, type) lives in `data/`, **never** in state — state stays small and diffable.
- `rng` is the PRNG state and lives *inside* state, so a snapshot fully determines the future.
- Iterate via precomputed sorted id arrays, never `Object.keys` order.
- `sim/` and `ai/` must never touch `document`.

All mutation flows through one entry point:

```js
applyCommand(state, { type:'send', owner, sources:[…], target, fraction })
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
| 2 | `movementTick(state)` | `sim/movement.js` | Advance waves along links; resolve arrivals |
| 3 | `combatTick(state)` | `sim/combat.js` | Square-law attrition wherever hostile forces share a station; flip stations |
| 4 | `relationsTick(state)` | `sim/relations.js` | Balance-of-power drift (throttled, not every tick) |
| 5 | `victoryTick(state)` | `sim/victory.js` | Capitulation and win detection |

**Why this order.** Growth before movement so a station's send is based on units that already grew this tick. Movement before combat so arrivals fight on the tick they land (`progress >= 1` resolves immediately, never deferred). Combat before victory so a capital captured this tick is seen this tick.

Helper contracts other files may rely on:

| Global | File | Contract |
|---|---|---|
| `stationPower(state, sid, side)` | `sim/combat.js` | Total combat Power for one side at a station, including defense, terrain and matchup |
| `growthMultiplier(state, sid)` | `sim/growth.js` | Product of all multiplier effects reaching this station, capped at `BAL.GROWTH_MUL_CAP` |
| `routeBetween(fromSid, toSid)` | `sim/movement.js` | Shortest path as an array of station ids, `null` if unreachable. Pure — depends only on `LINKS`. |

Nothing in `sim/` may touch `document`, call `Math.random`, or read `Date.now`. Randomness comes only from the seeded PRNG in `core/rng.js` threaded through `state.rng`.

**Wave arrival convention:** a wave is *arrived* when `progress >= 1` on its final hop. Tests drive combat by pushing a wave with `progress: 1` onto `state.waves` and calling `stepTick`. `sim/movement.js` must resolve arrival on the tick it is seen, not defer to the next one.

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
| `renderHud(state)` | `render/hud.js` | Territory count, total forces, day counter, power strip, event ticker. |
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
| `commandRoute(fromSid, toSid)` | `sim/commands.js` | Route a send will take; `null` if unreachable. Prefers `routeBetween` when `sim/movement.js` is loaded. |
| `routeEtaTicks(route, units)` | `sim/commands.js` | Estimated ticks for a stack to walk a route, at the speed of its slowest unit type. |

The preview **must** call these rather than estimating, or the ETAs shown before a commit will not match the waves the commit produces — which makes the preview worse than nothing, since avoiding defeat in detail is exactly what it exists for. A rename here degrades the preview to blank lines without failing any test.

**Input funnels to `applyCommand`.** A commit builds `{ type:'send', owner, sources, target, fraction }` and calls `applyCommand(GAME, cmd)` — the same entry point the AI uses. There is no second path by which the board changes, which is what keeps replay and headless testing free.

Nothing in `render/` or `app/` may mutate state directly. Read freely, write only through `applyCommand`.

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
  hops:     { sid: n },            // link-hops from the NEAREST owned station.
                                   // BFS capped at max(TARGET_MAX_HOPS,
                                   // SOURCE_MAX_HOPS); absent means "further".
  leader:      'rus' | null,       // current territory-count leader
  leaderShare: 0.34,               // leader's share of all owned territories
  ownForces:   1842,               // total units, for commitment sizing
}
```

### The decision object

```js
{
  tick, power,
  kind:    'attack' | 'hold',
  target:  'bru' | null,
  score:   14.2,
  terms:   { multiplier: 3.0, weakness: 2.1, proximity: 1.2, ... },
  odds:    2.4,          // estimated attacker:defender POWER ratio, not units
  minOdds: 1.19,         // BAL.AI.MIN_ODDS x personality.minOddsMul
  sources: ['aal','col'],
  fraction: 0.75,
  reason:  null | 'no-candidates' | 'odds-too-low' | 'no-sources' | 'garrison-floor',
  rejected: []           // populated only when BAL.AI.LOG_REJECTED
}
```

`kind: 'hold'` with a `reason` is a **real, logged decision**, not an absence of
one. A power that does nothing for two minutes must be able to say why it did
nothing, or it is indistinguishable from a power whose code never ran — which
is the single hardest AI bug to see (§6: *"a passive AI is otherwise
undebuggable"*).

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
