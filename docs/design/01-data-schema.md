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

## `data/map.js`

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
