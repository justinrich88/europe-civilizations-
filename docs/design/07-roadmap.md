# Roadmap — from here to shared and multiplayer

`00-vision.md` §10's build order is spent: milestones 0–5 shipped, and the
work discovered since does not fit its shape. This replaces it. `00-vision.md`
remains the locked spec for *what the game is*; this is the order of *what
happens next*.

---

## Three principles

**1. Deploy first, not last.** The game is zero-build vanilla JS. Serving it is
a file copy. There is no reason a shareable link waits behind a milestone, and
every reason it should exist before the next one — playtesters answer "is this
fun" in a way no Monte Carlo sweep can.

**2. Make the sim multiplayer-CAPABLE early; make it multiplayer-CONNECTED
late.** The prerequisites for lockstep — deterministic arithmetic and
tick-scheduled commands — are cheap now and expensive later, because every
new command type and every new sim calculation added before them has to be
retrofitted afterwards. The networking itself can wait until the game is worth
playing together. This is the same reasoning that put a relationship check
rather than an `owner === pid` boolean into the passage toll
(`06-movement-and-attrition.md` §6).

**3. Nothing is balanced until movement is settled.** Five structural changes
now sit between here and Milestone 6. It runs **once**, at the end.

---

## Phase A — live, and multiplayer-capable *(small, independent, do now)*

Everything here is cheap, unblocks something, and gets more expensive the
longer it waits.

### ~~A1. Ship it~~ — DONE. The repo is public and Pages is on.

GitHub Pages serves this repo directly with no build step. ~~The only blocker
is that the repo is private~~ — the decision was taken:
`justinrich88/europe-civilizations-` reports `visibility: public` and
`has_pages: true`, so the zero-build page is served as-is at
`https://justinrich88.github.io/europe-civilizations-/`.

**Verified through the GitHub API, not by loading the page.** The sandbox this
was checked from cannot reach `github.io` (the network policy answers 403 to the
CONNECT), so "Pages is enabled" is confirmed and "the live page boots" is not.
Somebody with a browser should open it once; it is a five-second check and it is
the one thing here nobody has done.

Now that it is live, every later phase gets played by someone other than its
author, which is the only test this project did not have.

### ~~A2. Deterministic arithmetic~~ — SHIPPED 2026-07 as `core/exact.js`

Four call sites in the sim layer used functions **ECMAScript does not specify
to bit precision**:

```
sim/combat.js:220     Math.sin    battle wobble — every battle, every tick
sim/growth.js:229     Math.pow    multiplier falloff
sim/relations.js:157  Math.exp    relations drift
ai/ai.js:213          Math.atanh / Math.log
```

V8, SpiderMonkey and JavaScriptCore may each return different last-bit
results. Under lockstep that is fatal: one bit of divergence in a battle
becomes different survivors, then different captures, then two different
games.

**The existing determinism tests pass and cannot catch this** — they run in one
engine. That is exactly why it had to be fixed before more sim maths was
written, and `06-movement-and-attrition.md` adds a whole attrition model.

All four now go through `core/exact.js`: `exactSin`, `exactExp`, `exactLog`,
`exactAtanh`, `exactPowInt`, built only from `+ - * /`, `Math.sqrt`,
`Math.floor`/`round`, and the exactly-specified constants `Math.PI` / `Math.LN2`
/ `Math.SQRT2`. Those ECMAScript *does* pin to the bit, which is the same
argument that already made the RNG portable.

**Two of the four prescriptions above were followed and two were overruled;
both reversals are recorded at the head of `core/exact.js`.**

- `Math.pow(FALLOFF, hops)` → multiply loop, as prescribed. At
  `MULTIPLIER_REACH = 1` the exponent is 0 or 1, so this call site is
  **bit-identical to what shipped** — it is a no-op today and stops being one
  the moment REACH rises, which is the whole reason to have done it while free.
- ~~`Math.sin` wobble → lookup table with fixed interpolation.~~ **A Taylor
  polynomial after exact range reduction instead.** Same amount of code, and it
  lands 4e-14 from `Math.sin` where a table lands ~1e-3 from it — the difference
  between "the board plays the same" and "the wobble was silently retuned".
- `Math.exp(-x)` → polynomial after an LN2-split reduction, not a rational
  approximation; the argument is always a negative integer at the one call site.
- ~~`atanh` is computing a **constant** and should be precomputed outright.~~
  **It is not a constant** — it is `atanh(1/oddsFloor)`, and `oddsFloor` varies
  per AI personality (turtle demands `MIN_ODDS × 1.35`). Precomputing it would
  have frozen every personality onto the default's spread window.

Cross-engine test: `test/exact-tests.js` pins `snapshot()` hashes at 2,000 ticks
on seeds 100 and 101, and **scans `sim/` and `ai/` for any return of an
implementation-approximated `Math` call.** The scan is the part that keeps
working; read that file's header for what a green node run does and does not
prove.

**The balance hashes moved, and this is the explanation CLAUDE.md asks for.**
Bit-identical was never available — the old numbers were whatever V8 returned.
What was measured instead, at 12,000 ticks on seeds 100–103: **every city is held
by the same power, every power holds the same territory count, worst relative
drift across all 324 garrison floats is 1.9e-13, and 45–56% of them are still
bit-identical.** The hashes changed; the wars did not.

### A3. Tick-scheduled commands — MECHANISM SHIPPED 2026-07; two commands still to convert

`applyCommand(state, cmd)` applied immediately. Lockstep needs commands to
carry the tick they execute on, queued and drained at a fixed point in
`stepTick`. Phase order is load-bearing (`sim/step.js`), so where they drain is
part of the contract, not an implementation detail.

Shipped:

- `queueCommand(state, cmd, atTick)` puts a command in `state.queued` for a
  named tick. `atTick` defaults to `state.tick` — which is **the tick about to
  run**, because `stepTick` increments at the end — so a click between ticks
  executes at the head of the next one. A tick in the past clamps forward; it is
  never dropped and never run out of order.
- **`commandsTick` is now phase 1**, ahead of `growthTick`, for the same reason
  `aiTick` is phase 0: an order is issued against the numbers on screen, and
  those are last tick's. Drain after growth and every volley is priced against a
  board the player never saw — measured, not asserted: it comes out at 10.024
  units where 10.000 was on screen.
- `state.queued` and `nextCmdSeq` live **in state**, so `snapshot()` carries
  commands in flight and reconnect-and-replay is right. Two commands due on the
  same tick are ordered by `seq`, never by array position.
- Validation is **split**: shape at queue time, everything else at drain time. A
  command can be legal when queued and rejected when drained, because the board
  at drain time is the only board there is. `state.cmdStats` counts both.

**`applyCommand` stays the sole mutator** and the drain is one of its callers.

**Still to do, and named rather than glossed:** `render/select.js` continues to
call `applyCommand` directly for `send` and `order`, because it reads the result
to draw its own confirmation and a queued command has no result yet. Converting
those two is the retrofit — it needs the confirmation to come from the board a
tick later, and it touches the eleven gesture tests in `test/select-tests.js`.
Until then the game is **not** lockstep-ready; what has been bought is that no
command written from now on needs retrofitting.

**Do this before `04-development.md`**, which adds a `build` command. Written
after, `build` is scheduled by construction; written before, it is a retrofit.
— done in that order: `build` is the first verb that only ever goes through
`queueCommand`.

### ~~A4. Pause and speed leave the player UI~~ — SHIPPED 2026-07

*Decided.* They are testing conveniences, not mechanics, and one shared clock
is required for lockstep anyway.

**Kept behind `?dev=1`, not deleted.** Browser verification pauses the board
constantly, and losing that slows every future change. The headless harness is
unaffected — it drives `stepTicks` directly, and `tests-ui.html` now passes
`&dev=1` for exactly the reason this clause exists.

Three consequences, all of them real:

- `00-vision.md` §1's *"orders can be issued while paused"* **stops being true**,
  and the board must be readable **while moving**. That is what raised the stakes
  on `05-command-clarity.md`, and it is why **A5 landed first**.
- **The opening pause went with it.** The game opened paused so the board could be
  read before anything moved; handing that to a player who can no longer unpause
  is a board that never starts. In dev mode the old contract is untouched.
- `hidden` alone did **not** hide the controls — `.hud-group` sets
  `display: flex`, and any author rule outranks the UA stylesheet's `hidden`.
  Needed `.hud-group.speed[hidden] { display: none; }`, the same fix
  `.send-armed[hidden]` already carried. Known-issue #15's shape; caught by
  asserting `offsetParent !== null` in a real browser rather than by checking the
  attribute was set.

### ~~A5. Selection safety~~ — SHIPPED 2026-07, all three accepted fixes

`05-command-clarity.md` §1. ~~**You cannot currently inspect an enemy city
without attacking it**~~ — the same click either opened a readout or launched
your army, decided by selection state that is usually off-screen. It was the only
open item a player was actively losing games to, and it was the cheapest thing
here.

§1's three accepted fixes, in its own order of value:

1. **The rail's selection line**, first section in the rail, present whenever
   anything is selected: *"3 cities · 90.0 units · click a target to commit · Esc
   to clear"*. §1 said this alone removes the surprise, and it costs no gesture
   change. The hint tracks the armed state, so it never advertises the volley
   while a supply order or the build chooser is live.
2. **The board edge reads as loaded** — an inset ring on `.board-wrap`, sharing
   the `is-arming` language and intensifying when armed. **Not an overlay
   element**: a box-shadow creates nothing to hit-test, which is the only version
   of this that cannot become the sixth occurrence of known-issue #5.
3. **Escape backs out one step, then clears** — already true, now pinned by a
   test.

Six tests in `test/select-tests.js`'s new `select / selection safety` suite, which
is separate from the armed-supply one because that fixture arms an order and these
must observe the unarmed state.

**A4 makes this worse, so it did not land after A4** — the ordering held.

---

## Phase B — the keystone

### B1. Passage and attrition

`06-movement-and-attrition.md`. **Everything below is blocked on this**, and
several things previously scoped as separate work turn out to *be* this:

- Multi-hop movement becomes true, as §8 always claimed.
- **The AI's missing horizon is fixed** — it was never an AI bug, it was the
  traversal rule.
- `TARGET_MAX_HOPS` / `SOURCE_MAX_HOPS` stop being dead config.
- **Fog becomes load-bearing.** Today you can only attack what you can see, so
  a remembered garrison is a curiosity. After passage it is a bet.
- Encirclement becomes reachable, which connection decay has always rewarded
  and no player has ever been able to attempt.

### B2. Wave vision

Requested, and a **provable no-op until B1** — armies never travel anywhere
already dark. Afterwards it enables scouting, which is a genuinely new
strategic action using the existing verb.

### B3. AI target selection

B1 hands the AI a horizon; it must then learn to **choose**. This is the fix
for defeat in detail — the failure the r = −0.88 correlation between opening
neighbours and win rate is measuring. Without it, a wider horizon just means
splitting force in more directions.

---

## Phase C — combat and investment

### C1. Collapse the three unit types to one

`04-development.md` §9. Mechanical, large surface, and it **shrinks everything
after it**. Development replaces what the infantry/artillery/armour triangle
was for, and does it better — the triangle was never visible, because the
number on a node never said what a stack was made of.

### C2. Development — FIRST PROTOTYPE SHIPPED 2026-07, out of order, on request

`04-development.md`, including the `b` key, the rail section, and the on-map
mark. ~~**Not started** — there is no `station.development`, no build command, no
UI.~~ All three exist. See `04-development.md` §9b for what is in it, what is
inert, and the 800px measurement of the pips.

**It landed before C1 and before B1, deliberately.** C1 first is still the right
sequencing and the spend is written through `splitUnits()` so the collapse costs it
nothing. B1 is the more interesting omission: its interaction with development is
the point — fortification taxes armies that go *past* a city, which is what stops
defensive investment freezing the board — and **that half does not exist yet**, so
what is playable now is the investment without its release valve. Read any
stalemate seen in playtesting with that in mind.

**The AI does not build** (`04-development.md` §10.3), so development is a
player-only mechanic today and the balance hashes did not move at all.

### C3. Route state and the standings panel

`05-command-clarity.md` §2. The data to answer *"is this route running"*
already exists in `standingOrderNext` and never reaches the screen. **This is
now the whole of C3** — and it is more urgent than it was, because the send
amount became persistent: firing **All** from a routed city knocks its own
supply line into the blocked state for ~775 ticks, where it renders at 30%
opacity with its chevrons hidden and is indistinguishable from deleted.

~~The standings panel must be fog-filtered, so it lands after fog is settled.~~
**Both halves of that sentence were wrong, and it shipped 2026-07 as
`render/standings.js`.** It is fully PUBLIC, restoring
`02-visibility-and-sea.md`:254; the reasoning is in `05-command-clarity.md` §3
and at the head of `render/standings.js`. Being public is also what made it
independent of fog, so it did not have to wait at all.

---

## Phase D — balance, once

Milestone 6. It is now carrying **five** structural changes: the 32-link sea
graph, fog, passage and attrition, the unit-type collapse, and development.
Running it earlier means running it twice.

**And what it measures has to change.** The current headline — win-rate spread
across seven powers — is measuring an AI failure mode, not map balance. Two
questions must be settled first:

1. **Is equal win rate even the target?** `00-vision.md` §2 designed the powers
   to be *unequal* — Germany "must win fast", the Ottomans "nearly untakeable,
   painfully slow". If that is real, balanced means *every power has a viable
   path*, not *every power wins 14%*.
2. **Instrument mean hops from border to target.** If it is still 1 after B1,
   the passage numbers are wrong and no amount of constant-tuning will show it.

---

## Phase E — multiplayer

With A2 and A3 done, what remains is only the network:

| | |
|---|---|
| **Tick barrier** | no client advances past tick N until every player's commands for N have arrived. This is the whole protocol. |
| **Transport** | ~50-line WebSocket relay. The client stays zero-build; only the server needs Node. |
| **Desync detection** | hash `snapshot()` every N ticks and compare. Without it a desync is invisible until the boards visibly disagree. |
| **Lobby** | seed agreement, power assignment, start sync. |
| **Reconnect** | `snapshot()` plus command replay from that tick. Mostly free. |

**The known limitation, stated plainly:** in lockstep every client holds the
true board and fog is enforced client-side only. A modified client can see
through it — the classic RTS maphack. Fine among friends, not fine in public.

The upgrade path exists and the fog architecture already built the seam:
because *"the sim keeps knowing everything, only reads are gated"*,
`visibleTo` / `believedStation` already define exactly what each player may
know. A server-authoritative version computes per-player views with functions
that exist today.

**Cheaper intermediate, if two people should play sooner:** hot-seat needs
almost none of this — only letting the human power switch.

---

## ~~The one thing gating everything~~ — it is not gating anything any more

~~**Is the repo public?**~~ It is, and Pages is on. What A1 was protecting —
"every later phase gets played by somebody other than its author" — is now
available and simply has to be used: the next thing anyone changes in `render/`
should be handed to a tester rather than reasoned about.

~~**What gates the rest of Phase A now is A5**~~ — **Phase A is complete.** A1
through A5 have all shipped. What gates everything now is **B1**, which is what
`06-movement-and-attrition.md` said from the start: "everything below is blocked
on this".
