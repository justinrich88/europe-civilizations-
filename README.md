# Concert of Europe

Real-time node conquest across 1914 Europe. Units accumulate on their own in the cities you hold; you select several and throw them at one target. What a city **is** — a factory, a granary, a fortress, a town — determines what holding it gives you.

Virus Wars' interaction model, Risk's map, a Great War that went differently.

## Play

Live, no install: **https://justinrich88.github.io/europe-civilizations-/**
(GitHub Pages serves this repo directly — there is no build step, so the page is
the repo.)

Locally:

```
python3 tools/serve.py            # port 8761, repo root; python3 is the only requirement
```

Then open `http://127.0.0.1:8761/`. It's vanilla JS loaded by script tags — no
npm, no bundler, nothing to install.

**Do not serve this with `python3 -m http.server`.** It sends `Last-Modified` and
no `Cache-Control`, so a browser can hold a stale copy of a file that changed
seconds ago — and `location.reload()` does not clear it. You then test the
PREVIOUS build while every check reports a clean pass. It has already cost one
full verification round here. `tools/serve.py` is the same thing with `no-store`
on every response, and that is the only reason it exists
(`docs/testing/known-issues.md` #16).

Useful while testing:

```
http://127.0.0.1:8761/?player=ger      skip the empire picker, board live immediately
```

| | |
|---|---|
| **click your own city** | add / remove it from the selection — never commits |
| **click an enemy city** | every selected city sends its share |
| **right-click your own city** | march there |
| **1 2 3 4** | send 25 / 50 / 75 / all — persistent, not a modifier |
| **R** then click | set a supply line from the selection to that city |
| **H** | clear the selection's supply lines |
| **b** | build the next development tier in every selected city |
| **space**, **2**, **4** | pause, and speed |
| **?** | the guide |
| **Esc** | back out one step; again to clear |

## Test

```
node test/node.js          # headless: 329 tests, 33 suites. Needs no browser.
```

`tests.html` runs the same suites in a browser. **`tests-ui.html` is the one that
matters for anything under `render/`** — it loads `index.html` itself in an
800×900 iframe and injects the test files, so it tests the shipped page rather
than a copy of its script list. 44 tests there that the headless harness cannot
run. On that page a SKIP is a failure, and so is a suite reporting fewer tests
than it has.

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
