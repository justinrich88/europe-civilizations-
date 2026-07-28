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

---

## 15. A stylesheet rule beats an SVG presentation attribute, silently

The coverage overlay was correct in the DOM and invisible on screen. Every wash
rect had the right `fill-opacity` — `setAttribute('fill-opacity', 0.18)` had
done exactly what it said — and the elements rendered at zero.

`fill-opacity` on an SVG element is a **presentation attribute**, which sits at
the very bottom of the cascade: below *any* stylesheet declaration, including a
plain class selector with no `!important`. A stub `.coverage-wash {
fill-opacity: 0 }` left in style.css therefore outranked every JS write, and did
so with no error, no warning, and a DOM inspector showing the attribute present
and correct.

Fix: write it as an inline style (`el.style.fillOpacity`), which outranks the
class, or delete the class rule. Inline was chosen — the value is animated per
frame and belongs to the renderer that computes it.

**Rule of thumb: if a renderer computes a visual property per frame, it must
write it as a style, not an attribute.** Attributes are for values the
stylesheet is expected to be able to override — they are defaults, not commands.

### It recurred, in the place hardest to notice

Second occurrence, found while building the beachhead visual. `render/waves.js`
coloured every in-flight stack by owner with `trail.setAttribute('stroke', c)`,
and an early placeholder block — `/* in-flight trails and wave markers (drawn by
later milestones) */`, written before `render/waves.js` existed — still carried
`.wave-trail { stroke: #ffffff }`. **Every trail on the board rendered white**,
so no marching army could be told from any other, on a map whose entire colour
language is ownership.

What makes this worth a second entry is why it survived. The bug is invisible
unless two powers march at once *and* you already know what you are looking at:
one white trail looks like a design choice. The attribute read back correctly,
the DOM inspector showed the right value, and the suite could never see it —
`test/node.js` loads no `render/` file at all.

The diagnostic is two lines, and is worth running against any coloured element
that looks wrong:

```js
el.getAttribute('stroke');            // what the renderer wrote
getComputedStyle(el).stroke;          // what the browser will actually paint
```

If those disagree, a stylesheet rule is winning. Fix applied on both sides:
delete the superseded rule, **and** write the colour as `el.style.stroke`, so
the next stray rule cannot resurrect it.

---

## 16. The preview browser ran the PREVIOUS build while every check passed

A routing change was verified in the browser and came back perfect: zero
disagreements between what the preview would draw and what the command layer
would accept, across 106 targets.

The page had never loaded the routing change.

`python3 -m http.server` sends `Last-Modified` and no `Cache-Control`, so a
client may apply heuristic freshness and keep serving a file that changed
seconds ago. The in-app preview browser does, and it does so in a way that
survives `location.reload()` **and** a forced navigation.

What made it dangerous is that nothing failed. Stale JS is not a broken page —
it is a *working* page running last week's logic, answering every question
confidently and wrongly. The tell was a result that was merely implausible:
Germany held 2 stations and all 106 targets were reachable.

**Diagnose it by asking the network and the page the same question:**

```js
const r = await fetch('/sim/commands.js', { cache: 'no-store' });
/function commandRoute\([^)]*\)/.exec(await r.text())[0];  // what the SERVER has
commandRoute.length;                                        // what the PAGE has
```

A mismatch means stale. Checking a function's arity, or `typeof someNewGlobal`,
is a two-second guard worth running at the top of any browser verification.

**Fixes, in order of preference:**

1. `tools/serve.py` — a dev server that sends `no-store` and strips
   `Last-Modified`/`ETag`. The `concert-fresh` launch config uses it.
2. Serve on a **different port**. A new origin gets a new cache, which is the
   only lever that reliably worked once a stale copy was already held.
3. Never trust a reload alone.

**Verify the verifier.** Any browser check that cannot fail is not a check —
before trusting a clean pass, confirm the page is running the code under test.

---

## 17. "Screen-constant" thresholds that were only constant under zoom

Three separate authors, in three files, wrote a value meant to be a fixed
number of SCREEN PIXELS, authored it in viewBox units, and converted it with
`cameraScale()`. That conversion is half the transform:

```
pxPerUnit = (boardWidth / 1000) x cameraScale
```

Dividing by scale alone holds a value constant under **zoom** while letting it
scale with the **window**. Every one of them was calibrated on a wide dev
window and silently shrank on the window the game is actually played at.

| where | authored as | intended | actual at an 800px window |
|---|---|---|---|
| `SEL_STATION_PICK_RADIUS` | 14 units | ~16 px | **7.2 px** |
| `SEL_CLICK_SLOP` | 4 units | ~5 px | **2.3 px** |
| order marker glyph | 9.4 units | legible | **4.9 px**, against an 8.8px garrison number |

None of them failed a test. Hit-testing still measured 108/108, because the
sweep clicks the exact centre of every station — a shrunken pick radius only
matters when the player misses, which no automated sweep ever does. The pick
radius had been added specifically to fix a player-reported miss-click, and it
shipped at 45% strength into the complaint it was written to answer.

**The tell is a unit mismatch in the comment.** Any constant whose comment says
"screen pixels" but whose value is in viewBox units is suspect. So is any
divisor that is `cameraScale()` alone.

**The fix is to read the real matrix**, which every hit test in `select.js`
already inverts:

```js
function _selPxPerUnit() {
  const m = byId('board').getScreenCTM();
  return (m && m.a > 0) ? m.a : 1;   // constant under BOTH zoom and window size
}
```

Author the constant in screen pixels, convert at the point of use, and put the
reference board width in the comment so a future reader can check the intent
against the number.

**Measure at the window the game is played at, not the one you develop on.**
Two of these three were found by resizing to 800px and looking; the third was
found only by screenshotting and failing to locate the glyph at all. A sweep
that clicks dead centre cannot find any of them.

---

## 18. A readout can answer a different question from the one on screen and never look wrong

`standingOrderSend(state, sid)` returns a feed city's **willingness** — how much
it wants to ship. When the mechanic shipped, that *was* what left, so the rail
printed it and the empire header summed it. Then the headroom ceiling landed
("a rally is a mustering point, not a warehouse") and a destination gained a
veto over every stream aimed at it. The two
numbers silently stopped being the same number, and nothing in the codebase
noticed, because *neither one had changed*.

Measured live, 7 feeders into Leipzig Works at 28.5 / 28:

```
rail    "next sweep — 5.6 units · 12% of the surplus above the keep floor"
header  "20.1 units leave on the next sweep, one every 25 ticks"
reality  0 sends. 0 units. Forever.
```

It is worse than a wrong number. A wrong number is eventually noticed; this one
is *plausible*, *stable*, and *recomputed every frame*, and the fix it hides —
spend that stack, or set a rally with room — is invisible. The player watches a
promise that never happens.

Three rules, and the third is the one that generalises:

1. **A panel must show what will HAPPEN, not what one side WANTS.** Any quantity
   with two ends needs the far end in it. "Willing to send" is a fine thing to
   compute and a terrible thing to print.
2. **Sharing a helper is not sharing a decision.** Both the sweep and the rail
   called into `sim/movement.js`, which felt like compliance with "never
   reimplement a sim fact" (#9) — but the sweep took the *decision* in its own
   loop and the rail read a *fragment*. The fix is that the decision itself is
   one function (`_ordPlanPower`), the sweep does nothing but execute it and the
   readout does nothing but report it. Then agreement is structural rather than
   a property of two files being edited on the same afternoon.
3. **A number is only proven by being compared against the event it predicts.**
   The new test takes the prediction for every feed station on every sweep tick
   of a 1400-tick run and compares it against what `applyCommand` actually
   shipped, plus what the source actually paid. Nine mutations were then run
   against it (`scratchpad/break_next.py`); the one that matters is *"the sweep
   drifts from the plan by 10%"*, which no assertion in the old suite could see
   and which this one catches on the first sweep.

**Cost, since it decided the shape of the API.** The honest answer needs the
destination's headroom, which needs the multi-source search, which is ~80us on
the 108-station board against 0.2us for the willingness. One call per frame is
0.5% of a frame and free; a *loop* over feed cities is not, so
`standingOrderPlan(state, pid)` answers for a whole power in one search and the
two renderers that want the set call that. Same planner, so still one authority.

Also worth recording: the first version of the map's blocked-feeder bar was
**white on white** — it inherited `fill: var(--garrison)` from `.station-order`
and painted an invisible bar across a white arrow. Found by
`getComputedStyle(bar).fill` returning `rgb(255,255,255)`, i.e. #15's two-line
diagnostic, not by looking at the screen. At 7.8 on-screen pixels, "I can't see
it" and "it isn't there" look identical.

---

## 19. A predictor that models ONE command cannot predict a SEQUENCE of them

Known-issue #18 was a readout answering a different question from the sweep. The
supply-line rewrite produced its sibling, and it is subtler because the readout
and the sweep were by then *the same function*.

A city may now supply several destinations, so one sweep issues several
`applyCommand` calls **from the same source**. Each one is sized as a FRACTION of
that station's garrison, and each one takes units out of it — so the second call
is a fraction of a smaller number than the first. A planner that sized every edge
against the garrison it read once, at the top, over-promises on every edge after
the first, and the error grows with how many lines the player has drawn.

Nothing about it looks wrong. Each edge's arithmetic is individually correct, the
totals are plausible, and with a single destination — which is every fixture
inherited from the previous design — the two are identical.

The fix is that the plan carries the state it is predicting *through* the
sequence: `_ordPlanPower` tracks `factor`, the share of the original garrison
still standing as each successive send is issued, and sizes each edge against
`splitUnits(units, factor)`. It is exact rather than approximate because
`splitUnits` scales all three unit types by one number, so a single scalar
reproduces the bundle.

**The rule that generalises: if a readout predicts N commands, it must simulate N
commands.** Predicting the first one N times is a different calculation and it is always
optimistic. The test that catches it compares the plan's PER-DESTINATION share
against the wave that actually went to that destination — a per-source total
would have hidden it, because the total is right whenever the shares are wrong in
compensating directions.

---

## 20. A bootstrap path only runs when something else has already failed — so nobody runs it

`renderBoard()` draws from `window.GAME` if there is one and from
`setupPseudoState(D)` if there is not, so the board is viewable before
`app/main.js` has made a game. That second path had been dead for some time:
the pseudo-state gave each station an `owner` and nothing else, while
`liveStations()` — which `drawStations()` deliberately calls to paint the
turn-zero snapshot through the same code every later frame uses — reads
`st.units.infantry`.

```
renderBoard()  →  liveStations(D, setupPseudoState(D))
               →  TypeError: Cannot read properties of undefined (reading 'infantry')
```

`renderBoard()` died part-way through and took `drawTerritoryLabels` and
`drawPowerLegend` with it. **No test saw it** (`test/node.js` loads no `render/`
file) and **no session saw it**, because every entry point in the running game
creates `GAME` before it draws.

Two lessons:

1. **"One renderer, no static mode" is the right design and it widens the
   contract.** Handing a state-shaped object to `territoryControl()` needs
   `owner`. Handing the same object to `liveStations()` needs every field the
   live path reads — and that set grows every time the renderer learns a new
   one, silently, in a file that has no reason to mention the pseudo-state.
   The pseudo-state now carries `units`, `connected`, `growthMul` and
   `supplyTo`, and says so.
2. **A fallback that is only reached when the primary is missing is exercised by
   nobody.** If it is worth having, something has to run it on purpose; if
   nothing does, it will be broken by the third unrelated change and the
   discovery will be a stack trace at the worst possible moment. Seeding it from
   `SETUP` rather than with zeroes at least makes a wrong answer visible as a
   wrong board.

---

## 21. An SVG `viewBox` width is a scale factor, not a drawing size, whenever the element is `width: 100%`

A diagram authored at 300 viewBox units inside a 616px-wide card renders every
9px caption at ~18px and every stroke at 2×. The fix is to author the viewBox
close to the real rendered width (600 for this card at the 800px window). Same
failure shape as #17: a number that only means what it says at one width.

**Caught by screenshotting, not by any assertion** — nothing tests it.
