# Known issues

Append-only log of environment and engine gotchas. Each entry states the symptom
*as a lesson*, so scanning the headings is enough to recognise a problem you're
currently having. Follows the convention from the `0ad-levers` prototype.

---

## 1. `preview_start` resolves `.claude/launch.json` from the session root, not the project

The session's working directory is `~/Downloads`, so launch configs are read from
`/Users/justinrich/Downloads/.claude/launch.json` — **not** from
`concert-of-europe/.claude/launch.json`.

Both files now exist with a matching `concert-dev` entry
(`python3 -m http.server 8761 --directory .../concert-of-europe`). The
Downloads-level one is the one that actually works; the in-project copy is kept
so the config travels with the repo.

If a preview won't start and the config "obviously exists", check which one the
tool is reading.

---

## 2. The first `http.server` start in a fresh directory can hang without binding

Symptom: the server process spawns (under `Claude.app/Contents/Helpers/…`) but
never binds the port, and the preview hangs rather than erroring.

Cause is almost certainly a macOS TCC permission prompt for Downloads access
that never surfaces to the agent. **Stop the server and start it again** — it
clears and stays stable afterwards. Expect this roughly once per fresh
directory. Do not debug the app; nothing is wrong with it.

---

## 3. Top-level `const` in a classic script is not a property of `window`

Relevant because every data file declares `const VERTS = …`, `const BAL = …` etc.

`window.VERTS` is `undefined` even when `VERTS` is perfectly well defined —
`const`/`let` at top level go into the script scope, not the global object (only
`var` and function declarations land on `window`). A "is the data loaded?" guard
written as `if (!window.TERRITORIES)` therefore reports *everything* as missing,
always.

Guard with bare `typeof` instead:

```js
if (typeof TERRITORIES === "undefined") { … }
```

Caught during the renderer build; `render/map.js` uses the `typeof` form
throughout.

---

## 4. `~/Downloads` files can carry a `com.apple.macl` ACL the preview server cannot read

Inherited lesson from the `0ad-levers` prototype: files written into `~/Downloads`
sometimes pick up a `com.apple.macl` ACL from macOS per-app folder sandboxing,
and the preview helper then 404s on files that plainly exist. It looks exactly
like a path bug and is not one.

**Not currently occurring** in this project — `ls -le@` shows only
`com.apple.provenance`, and every file serves 200. Recorded so that if silent
404s appear later, this is checked before anyone rabbit-holes into the app.

Workaround if it resurfaces: serve a mirrored copy from the session scratchpad
rather than from `~/Downloads` directly.

---

## 5. Battle duration is independent of army size — this is correct, do not "fix" it

The Lanchester square-law system

```
dA/dt = −k·B      dB/dt = −k·A
```

is linear, so scaling both sides by any factor leaves the equations unchanged.
10 v 5 and 400 v 200 both resolve in ~25 sim-seconds. Verified numerically.

This looks like a bug ("shouldn't big battles take longer?") and inviting a fix
is a trap: normalising the rate by total force size — e.g. multiplying by
`REF_SIZE / (A+B)` — makes skirmishes resolve in 3 seconds and army-scale
battles in 2 minutes, which is precisely backwards.

Battle length is set by the *odds*, in closed form:

```
ticks = atanh(1 / r) / COMBAT_RATE
```

so `COMBAT_RATE` alone is the clock for every fight on the map. See the block
comment above `COMBAT_RATE` in `data/tuning.js`.

---

## 6. A subagent can burn its whole output budget on thinking and write nothing

The first attempt at `data/map.js` asked one agent to author all ~48 territories
of the 1914 map in one pass. After 45 minutes it died with:

```
API Error: Claude's response exceeded the 32000 output token maximum
```

The trap is that **thinking tokens count toward the output cap.** The agent
emitted four consecutive reasoning blocks totalling ~111,000 characters while
deriving the shared-vertex topology, then had no budget left to write the file.
The file itself would have been ~20,000 characters — it was never the problem.

Two lessons, both structural:

1. **Size a subagent slice by how much it must *derive*, not how much it must
   write.** Whole-map geometry is a single tightly-coupled constraint problem;
   splitting it into eight regions with the cross-region boundaries pre-authored
   (`data/map-seams.js`) makes each slice's reasoning bounded.
2. **An agent that never calls a tool cannot receive a `SendMessage`.** Messages
   are delivered "at the next tool round". This one made no tool call for 36
   minutes, so a mid-flight correction was structurally impossible to deliver.
   Instruct agents to checkpoint to disk *in the original prompt* — you may get
   no second chance to say it.

---

## 7. Geometry that passes every check can still be the wrong geometry

The eight-region hand-authored map passed `test/verify-map.js` completely: no
dangling refs, no near-duplicate vertices, adjacency derived from shared edges
matching the declared list in both directions, all 31 assertions green.

It still had to be thrown away. Rendered, it did not read as Europe — Italy had
no boot, Sicily sat northwest of the toe, the Gulf of Bothnia looked like a hole
punched in Scandinavia. Every *stated* invariant held; the unstated one — "looks
like the place" — is the one that mattered, and no assertion encoded it.

Two lessons:

1. **Put a rendered screenshot in front of a human before building on generated
   geometry.** The verifier can only check what it was told to check. A visual
   gate catches the class of error that assertions structurally cannot.
2. **Prefer real data over hand-authoring for anything with a ground truth.**
   `tools/build-map.js` derives the map from Natural Earth in one pass and is
   both more accurate and less code than the nine files it replaced. The seam
   contract was an elaborate solution to a problem TopoJSON does not have.

---

## 8. A test that passes with and without the fix is worse than no test

`tools/balance.js` found a real defect: a capitulated France went on capturing
stations ~40,000 ticks after surrendering, leaving a dead power holding ground
no victory condition could clear. The game literally could not end.

Cause: `capitulate()` cleared the power's in-flight `state.waves`, but a stack
that has already LANDED lives in `station.attackers`, which is a different
place. Those kept fighting for a country that no longer existed.

The lesson is not the bug — it is the first test written for it. That test
parked the dead power's stack on an **undefended** station, and it passed
whether or not the fix was present. The tick order is growth → movement →
combat → relations → victory, so against an empty station the capture resolves
in phase 3 and the capitulation in phase 5 of the *same tick* cleans it up. The
zombie only appears when the battle **outlives the surrender**, which needs a
defended target.

Two rules that follow:

1. **Always run a new regression test against the unfixed code.** Removing the
   fix and confirming the test goes red takes thirty seconds and is the only
   evidence the test tests anything. Here it went from "3/3 passed" — identical
   output with and without the fix — to a clean failure naming the station.
2. **Bugs that live in phase ordering need a scenario that spans ticks.**
   Anything resolving inside one tick gets swept up by a later phase and hides
   the defect. The hand-written scenario picked the easy case precisely because
   it was easy to construct.

Also worth noting: no hand-written assertion found this. Hundreds of headless
games did, and only because a stalled batch was investigated rather than
written off as the placeholder AI being bad at its job.

---

## 9. A renderer's private helper silently replaced the sim's function of the same name

`render/map.js` kept its own `territoryControl()` so it could tint the board
from the static `SETUP` before a game state existed. `core/state.js` has a
function of exactly that name implementing the same rule against live state.

Both are top-level **function declarations** in classic scripts, and unlike
`const`/`let` those *do* land on `window` (known-issues #3 is the other half of
this asymmetry). `index.html` loads `render/map.js` after `core/state.js`, so
the renderer's copy overwrote the sim's. Every unqualified
`territoryControl(state, tid)` call in `core/` and `sim/` — including the one
inside `countTerritories()`, which drives capitulation and victory — was
resolving to a function that read the turn-zero snapshot instead of the live
board.

The node harness could not see it: `test/node.js` never loads `render/`, so all
79 assertions passed against the correct function while the browser ran the
wrong one. **A green headless suite says nothing about global collisions that
only exist in the browser's script order.**

Fixed by deleting the renderer's copy outright and having it call core's, with
a state-shaped wrapper around `SETUP` for the pre-game case. Same rule, one
implementation.

Rules that follow:

1. **In a globals-only project, a function name is a global claim.** Before
   adding a top-level `function foo()`, grep the whole tree for `function foo`.
   A "private helper" is not private.
2. **Prefer calling the canonical implementation over copying it**, even across
   layers that are supposed to be independent. `render/` may not *mutate* state,
   but reading a derived value from `core/` is not a layering violation — it is
   the only way to be sure the two agree.

---

## 10. The Browser pane reports `visibilityState: "hidden"`, so `requestAnimationFrame` never fires

Anything driven by rAF appears completely dead when tested through the preview
pane: `setSpeed(1)` returns cleanly, `GAME.paused` goes false, and the tick
counter sits at 0 forever. It looks exactly like a broken game loop.

The page is not broken. Browsers throttle rAF to zero in a hidden document, and
the pane reports itself hidden. In a real browser tab it runs normally.

**Test rAF-driven code by calling the frame function directly** with synthetic
timestamps — the same input rAF would supply:

```js
let t = performance.now();
for (let i = 0; i < 900; i++) { t += 16.67; loopFrame(t); }   // 15s at 60fps
```

This is also *better* than waiting on real time: it is exact, instant, and
reproducible, which is how the 1x-vs-4x tick ratio was measured as precisely
4.00 rather than something jittery.

Two traps inside the workaround:

- `loopFrame` still honours `GAME.paused`, so `setSpeed(1)` must come first.
  Driving frames on a paused game advances nothing and reads as the same
  failure.
- Verify with `document.visibilityState` before concluding a loop is broken.

---

## 11. A tuning constant whose stated job is arithmetically impossible

`BAL.AI.BORDER_PRESSURE` was `6.0`. Its comment called it driver #1 of the
balance of power — *"where you mass is a statement"*. It could never once have
caused a war.

The term is `BORDER_PRESSURE × borderWeight × pressure`, where `pressure` is a
**share in 0..1**, not a unit count. So 6.0 is the *most* hostility a totally
one-sided frontier can generate. Reaching war means moving `RELATION_START`
(+10) to `WAR_THRESHOLD` (−40) — **fifty points**. Driver #1 could contribute
six of them, or 12%.

Only `LEADER_WEIGHT` (45.0) could actually declare a war, and it fires at
whoever is *ahead*, regardless of whether you can reach them. `tools/balance.js`
showed the result: Britain and Italy declared on Russia across the map, could not
touch it, and every power logged `not-at-war` forever. **0 of 12 games ended.**

Nothing failed. All 102 assertions passed. The suite had no opinion about
whether a constant could reach the threshold it existed to reach.

**Before trusting a tuning constant, multiply it out against the thresholds it
has to move.** A weight is only meaningful relative to the gap it must close,
and the arithmetic belongs in the comment next to the number — the tuned value
now carries its own sweep table so this cannot silently regress.

---

## 12. `_ai` was not a specific enough prefix — #9 happened again, live

Two agents wrote `ai/score.js` and `ai/ai.js` in parallel, both told to prefix
private helpers `_ai`. Both independently chose `_aiAdjacency`, `_aiPersonality`
and `_aiCandSid`. `ai/ai.js` loads last, so **its copies silently won and the
scorer ran against helpers it had never seen.**

This is known-issue #9 recurring despite the rule written to prevent it, which
means the rule was wrong: a shared prefix does not prevent collisions between
files that share a *domain* — it concentrates them, because both authors are
naming the same concepts.

**Prefix by FILE, not by subsystem** (`_aiAct*` in ai.js, `_aiScore*` in
score.js). And a duplicate-global sweep is now a standing check, not a habit:

```sh
grep -ho "^function [A-Za-z_][A-Za-z0-9_]*" core/*.js sim/*.js ai/*.js \
  render/*.js app/*.js | sort | uniq -d
```

---

## 13. Adding a phase to the tick silently confounded every existing test

`aiTick` became phase 0 of `stepTick`. Instantly, every sim test was testing
*the sim plus seven AIs playing inside it*.

One test failed: a fixture set a capital's garrison and asserted it never
shrank. It was watching the AI legitimately **spend** those units. The assertion
was a proxy for "no decay" and the proxy broke — the AI was correct throughout
(it stopped at 14.1 units against a `HOME_GARRISON_FLOOR` of 14.0).

The failure was the lucky part. **The other 78 tests kept passing while
measuring something different from what they claimed**, and nothing would have
told us.

Fixed by making sim-suite boards AI-quiet **at state creation**
(`simFns().newGame` sets `state.aiEnabled = false`) rather than in the run
helper — four sim tests call `fns.step()` directly, so a flag set by `_run()`
would have left exactly those four confounded.

**When you add a phase to a shared tick, every existing test of that tick
changed meaning.** Isolate at construction, and verify the isolation is
load-bearing by removing it and watching something fail.

---

## 14. War was stored one-directionally

`atWar(state, a, b)` read `state.powers[a].wars[b]` only. Britain could be at
war with Russia while Russia sat formally at peace with Britain — so Russia
neither retaliated nor expanded, and the deadlock in #11 was deeper than the
tuning alone.

The per-direction *latch* is right (each power decides when it wants a war and
when it will stand down). The *state of war* is not a per-direction fact:
**being attacked is not something you can decline.** `atWar` now ORs both
directions, so a war persists while either side still wants it and ends only
when both have drifted back above `PEACE_THRESHOLD`.
