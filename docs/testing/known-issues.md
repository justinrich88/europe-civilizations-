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
