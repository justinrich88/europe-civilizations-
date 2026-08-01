# Concert of Europe

Real-time node conquest on a 1914 map of Europe. Virus Wars' loop — units
accumulate in cities you hold, you throw them at cities you want — with Risk's
map and an emergent balance-of-power AI instead of a diplomacy menu.

**`docs/design/00-vision.md` is the locked spec for what the game IS.**
`docs/design/07-roadmap.md` is the order of what happens next. Neither is a
suggestion: when code and `00-vision.md` disagree, one of them is a bug, and
which one is a decision for the player-facing owner, not for a refactor.

---

## Hard constraints

**Zero build. No npm, no bundler, no framework, no CDN, no webfonts.** Plain
`<script src>` tags in dependency order in `index.html`, shared globals,
`'use strict'` in every file. Adding a dependency is a design change, not an
implementation detail — do not do it to solve a tooling problem.

**Nothing under `sim/` or `ai/` may touch `document` or `window`.** The whole
sim runs headless in `node test/node.js`, and that is the only reason the
balance harness exists.

**Deterministic.** Seeded mulberry32 with its state inside the game state.
`Math.random` and `Date.now` are banned below the sim layer. Iteration order is
sorted, always — `POWER_IDS`, `STATION_IDS`, sorted destination ids. Two runs of
one seed must produce the same wave ids in the same sequence.

**And so are `Math.sin` / `cos` / `exp` / `log` / `pow` / `atanh` and `**`.** They
are *implementation-approximated*: the spec lets V8, SpiderMonkey and
JavaScriptCore each return a different last bit, which is a desync under
lockstep. Use `core/exact.js` — `exactSin`, `exactExp`, `exactLog`, `exactAtanh`,
`exactPowInt`. `+ - * /`, `Math.sqrt`, `Math.floor`/`round`/`abs` and the named
constants `Math.PI` / `Math.LN2` / `Math.SQRT2` ARE exact and are fine.
`test/exact-tests.js` scans `sim/` and `ai/` and goes red if one comes back.

**All input — player and AI — goes through `applyCommand(state, cmd)`.** Nothing
else may build a wave or mutate a station's owner. Command shapes are
`{type:'send', owner, sources:[…], target, fraction, standing?}` and
`{type:'order', owner, stations:[…], target}` and
`{type:'build', owner, stations:[…], kind?}` — note `stations`, not `sources`, on
the last two, and `owner` is required on all three.

**New commands are SCHEDULED, not applied.** `queueCommand(state, cmd, atTick)`
puts a command in `state.queued`; `commandsTick` — **phase 1**, ahead of growth —
drains it through `applyCommand`, which is still the sole mutator. `atTick`
defaults to `state.tick`, and `state.tick` is **the tick about to run**
(`stepTick` increments at the end). Shape is validated at queue time and
everything else at drain time, so a command can be accepted and then legally
rejected — that is not a bug. `send` and `order` from `render/select.js` are still
immediate; see `07-roadmap.md` A3 for why and what it costs.

---

## Running things

```
node test/node.js                  the sim suite — 336 tests, 33 suites, headless
node test/exact-tests.js           the deterministic-maths suite standalone
node test/queue-tests.js           scheduled commands standalone
node test/development-tests.js     development standalone
node test/scenarios-orderswhy.js   one suite standalone (a few do this)
node tools/balance.js 200          Monte Carlo sweep
node tools/verify-stations.js      map/station/link reconciliation
python3 tools/serve.py             dev server on 8761 — SEE #16 BELOW
```

`tests.html` is the browser sim suite. **`tests-ui.html` is the one that
matters for anything under `render/`** — it loads `index.html` itself in an
800×900 iframe and injects the test files, so it tests the shipped page rather
than a copy of its script list. 50 tests, 5 suites, that `node test/node.js`
cannot run. A **SKIP is a FAILURE** on that page, and so is a suite that records zero
tests — **and so is a suite that records FEWER tests than it has**, which is how
#23 hid for weeks. `select / armed supply order` must read 11/11; at 0/1 or 1/1
something is covering the board and the other ten never registered.

Never serve this with `python3 -m http.server` — see #16.

---

## Conventions that bite

**Top-level `function` declarations land on `window`. `const` and `let` do
NOT.** A helper another file needs must be a `function`, or explicitly assigned.

**Every file's private helpers carry that file's own prefix** — `_sel…`
(`render/select.js`), `_map…`, `_ord…` (`sim/movement.js`), `_rdo…`
(`render/readout.js`), `_cam…`, `_vis…`, `_std…`, `_help…`. This is not style.
A renderer's private helper has silently replaced a sim function of the same
name **twice** (#9, #12). Shorter prefixes are not safe; `_ai` was not enough.

**Nothing may be painted over the board that accepts pointer events.** An
overlay with default `pointer-events` swallows the click that commits an attack,
with no error and no console output. Five occurrences. New overlay ⇒
`pointer-events: none` unless it is genuinely interactive.

**One derivation rule, one implementation.** Two files computing the same thing
is the single most-repeated defect here (#9, logged five times). If a renderer
needs a number the sim already derives, the sim exports it — do not recompute.

---

## The verification bar

**A test that passes with and without the fix is worse than no test** (#8). Run
every new assertion against the unfixed code first and watch it go red. For a
bug you cannot revert, mutate the fix and confirm the mutation fails. State in
the commit that you did.

**A green harness that does not load the changed file proves nothing.** The node
suite loads no `render/` file except `help.js` and `standings.js`. Balance hashes
being identical after a `render/` change is not evidence — say so rather than
quoting it as reassurance.

**Balance regressions** are caught by full-state SHA-256 after 12,000 ticks on
seeds 100–103. Any sim change must leave those identical, or explain why not.

**"Or explain why not" means measuring the board, not asserting good faith.**
`core/exact.js` moved all four hashes and could not have avoided it. What made
that reportable was a per-seed diff of the two boards at 12,000 ticks: same
owner for every one of the 108 cities, same territory count for every power,
worst relative drift 1.9e-13 across 324 garrison floats. A changed hash with no
such measurement beside it is an unexplained regression.

---

## Known issues — read `docs/testing/known-issues.md` before debugging

25 numbered entries, five of which recurred after being written down. The ones
that cost the most time:

| # | The trap |
|---|---|
| 3 | Top-level `const` is not on `window` |
| 8 | A test that cannot fail |
| 9 / 12 | Two implementations of one rule; prefixes must be per-file |
| 10 | `rAF` never fires in the preview browser (hidden document) — drive with `stepTicks(GAME, n)` and call renderers directly |
| 15 | A stylesheet rule silently beats an SVG presentation attribute |
| 16 | `python3 -m http.server` serves the PREVIOUS build. Use `tools/serve.py`, which sends `no-store`. This cost a full verification round that reported a clean pass on code the page had never loaded. |
| 17 | The game is played at **800px** (viewport 800×900). Thresholds that look screen-constant are not, under zoom (#21) |
| 18 | A readout can answer a different question from the one on screen and never look wrong |
| 22 | A load-time `railAddSection()` call is a load-order dependency; guard it, but make the else branch loud |
| 23 | `tests-ui.html` result depended on browser localStorage — the guide covered the board on a fresh profile and eleven select tests silently never ran |
| 24 | `var` inside a function body is not a global — `renderBoard()` threw, `app/main.js` caught it, and the board came up EMPTY with 329 tests green |
| 25 | `_rdoSet(rec, …)` instead of `_rdoSet(rec.v, …)` writes to a plain object and does nothing, with no error |

**macOS only:** files under `~/Downloads` pick up a `com.apple.macl` ACL the
preview server cannot read, giving silent 404s that look exactly like code bugs
(#4). The workaround is serving an `rsync`ed mirror from the session scratchpad.
This does not exist off macOS.

---

## Where to read before touching

| Touching | Read first |
|---|---|
| anything | `docs/design/00-vision.md` |
| a data shape, or a sim function's contract | `docs/design/01-data-schema.md` |
| fog, vision, sea crossings | `docs/design/02-visibility-and-sea.md` |
| a tuning constant | `docs/design/03-balance-findings.md` |
| buildings / development | `docs/design/04-development.md` |
| selection, supply lines, the rail | `docs/design/05-command-clarity.md` |
| movement, attrition, passage | `docs/design/06-movement-and-attrition.md` |

Design docs are updated in the same commit as the code that contradicts them,
including the reasoning for the reversal. Several carry tombstone comments
recording what was tried and why it was cut; those are load-bearing.

---

## Working with the owner

Design-led, lighter on code — implement it, then report at a level he can react
to. He iterates by pushing back repeatedly, and **each round of pushback usually
deletes machinery rather than adding it.** When in doubt the simpler version is
the one he wants. He names reference games as complexity ceilings, not as
feature lists.

Report outcomes plainly. If a measurement was contaminated, if a claim in an
earlier briefing was wrong, if a test could not have failed — say so in the
report, first, before the good news. That has caught real defects here more than
once.

Prompt him to `/compact` at each commit.
