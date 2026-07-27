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
