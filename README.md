# Concert of Europe

Real-time node conquest across 1914 Europe. Units accumulate on their own in the cities you hold; you select several and throw them at one target. What a city **is** — a factory, a granary, a fortress, a town — determines what holding it gives you.

Virus Wars' interaction model, Risk's map, a Great War that went differently.

## Play

```
python3 -m http.server 8761 --directory .
```

Then open `http://127.0.0.1:8761/`. There is no build step — it's vanilla JS loaded by script tags.

## Test

```
node test/node.js          # headless: data integrity + balance
```

Or open `tests.html` in the browser for the same suites plus a data summary.

## Layout

```
docs/design/00-vision.md     the living design spec — read this first
docs/design/01-data-schema.md  the data contract every file agrees on
docs/reference/              Virus Wars notes, what we took and what we didn't

data/map.js        VERTS (shared vertex table) + TERRITORIES
data/stations.js   STATIONS + LINKS
data/scenario.js   POWERS + SETUP (starting ownership)
data/tuning.js     BAL — every balance constant lives here

core/              rng, util, state
sim/              growth, movement, combat, relations, victory, step
ai/               personality-weighted utility loops
render/           map, stations, hud, input, select
app/              loop, main
test/             asserts, runner, node harness
```

## Rules of the codebase

- **Zero build.** No npm, no bundler, no framework, no CDN, no ES modules. Script tags and globals.
- **`sim/` and `ai/` never touch `document`.** That's what makes the game headlessly testable.
- **Determinism.** Seeded PRNG whose state lives inside the game state. `Math.random` and `Date.now` are banned below the sim layer.
- **Static data never enters runtime state.** Geometry, capacities and types stay in `data/`; only what mutates lives in state.
- **Unit counts are floats.** 100ms attrition rounds to zero otherwise. Floor at render, never in the sim.
- **Shared vertices.** Bordering territories reference the *same* vertex ids. Adjacency is derived from shared edges and asserted against the hand-authored list.
- **All balance lives in `data/tuning.js`.** If you're tuning a number anywhere else, it's in the wrong place.
