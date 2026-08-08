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

### ~~A3. Tick-scheduled commands~~ — MECHANISM SHIPPED 2026-07, RETROFIT COMPLETED 2026-08

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

~~**Still to do, and named rather than glossed:** `render/select.js` continues to
call `applyCommand` directly for `send` and `order`… Until then the game is
**not** lockstep-ready.~~ **DONE 2026-08. Every command in the game is now
scheduled, and nothing outside `sim/` mutates the board.**

The blocker was never the queue; it was that `render/select.js` read
`applyCommand`'s return value to draw its confirmation banner, and a scheduled
command has no return value. Three shapes were considered and the reasoning is
worth keeping, because two of them are the obvious ones:

- **Read the board a tick later instead of the result.** Rejected: the banner
  distinguishes *"that city is not yours"* from *"no city there"*, and
  reconstructing those from the board means a second copy of rules
  `_cmdApplyOrder` already owns — known-issue #9, the defect logged five times.
- **Keep the results in state, keyed by seq.** Rejected: that puts a value in
  `snapshot()` that the sim never reads, and moves every balance hash in the
  project for it.
- **A listener channel out of state — `onCommandResult(fn)`, shipped.**
  `commandsTick` notifies after the *whole* drain with `(cmd, res, {tick, seq})`.
  Not in state, not read by the sim, and the contract is that a listener does not
  mutate. That last one is the only way this can desync — a listener runs on the
  client that has a UI and not on the one that does not — so it is pinned by a
  test that hashes 400 ticks of the same game with and without a listener
  registered and requires the snapshots to be **byte-identical**.

**The eleven gesture tests were touched, and the reason is the interesting
part.** Every one of them read the board on the line after the click. Rewritten
to step one tick first, they still pass — but the dangerous half was the
assertions of the form *"and it marched nothing"*, which now pass **for free** on
a click that merely has not drained yet, and would keep passing against a file
that dropped the click on the floor. Those step the tick *before* they look. Two
new tests were added for what the retrofit itself claims: that the gesture puts a
command in `state.queued` and leaves the board alone, and that the confirmation
arrives on the tick that runs it rather than on the click that issued it. Six
mutations of `render/select.js` and six of `sim/commands.js`, each caught.

**One behaviour genuinely changed, and it is only visible in `?dev=1`:** with the
board paused, a click now does nothing until time moves. Nothing drains while
nothing steps. That is the honest reading of `00-vision.md` §1's *"orders can be
issued while paused"* — issued then, executed when the clock runs — and it is
recorded as known-issue #28 because it will otherwise look exactly like a dead
gesture during the next browser verification.

**The balance hashes did not move, and this is not an appeal to good faith.**
With no listener registered `commandsTick` takes the identical path it took
before (`_cmdListeners.length` is 0, so no notes array is even allocated), which
is why `test/exact-tests.js`'s pinned `snapshot()` hashes at 2,000 ticks on seeds
100 and 101 are unchanged — the case known-issue #27 says the four-seed board
diff *is* valid for, since no float is perturbed at all.

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

### ~~B1. Passage and attrition~~ — SHIPPED 2026-07

`06-movement-and-attrition.md`. **Everything below was blocked on this**, and
several things previously scoped as separate work turned out to *be* this.

What landed: `_moveCanTraverse` opened, a passage toll scaled by
`stationPower(state, sid, 'defender')` and charged once on entering ground the
wave does not own, flat per-tick march attrition, and route weights so the router
can price a detour. **Standing orders keep the closed rule** — passage is for
armies, not logistics; a supply line routed through hostile country is an
unattended trickle that stands down forever.

**Read §7 of that document before tuning anything here.** Its named instrument —
mean hops from border to target — turned out not to discriminate, because its
premise was wrong: that number was never 1, it was already 2.16. The measure that
does work is the share of marches crossing ground the sender does not hold, and it
went 0% → 3.4%. It is low because **B3 has not happened**, not because the
constants are wrong.

> **That last sentence was wrong, and B3 disproved it.** Re-measured at 12,000
> ticks on seeds 100–103 after B3 landed, the share went **4.1% → 2.9%** — down,
> not up. The prediction assumed a choosier AI would reach further; commitment
> does the opposite, because a power that keeps hitting the target it already
> picked stops reaching past it, and an action spent developing is an action not
> spent marching. Passage usage is therefore **not** the instrument for whether
> the AI is using its horizon well, and nothing should be tuned against it.
> Left standing rather than rewritten, because the reasoning that produced the
> wrong prediction is the part worth keeping.

Fixed by it, as promised:

- Multi-hop movement becomes true, as §8 always claimed.
- **The AI's missing horizon is fixed** — it was never an AI bug, it was the
  traversal rule.
- `TARGET_MAX_HOPS` / `SOURCE_MAX_HOPS` stop being dead config.
- **Fog becomes load-bearing.** Today you can only attack what you can see, so
  a remembered garrison is a curiosity. After passage it is a bet.
- Encirclement becomes reachable, which connection decay has always rewarded
  and no player has ever been able to attempt.

### ~~B2. Wave vision~~ — SHIPPED 2026-08

Requested, and a **provable no-op until B1** — armies never travel anywhere
already dark. Afterwards it enables scouting, which is a genuinely new
strategic action using the existing verb.

`06-movement-and-attrition.md` §5, closed. A wave grants level 2 to both
endpoints of the hop it is on, and to nothing else: not the rest of its route,
not the ground beside it, and not after it has moved on. 11 headless tests, ten
mutations, each caught.

**The half that was not in the spec.** `render/map.js` memoises visibility on
`(state, tick, ownerEpoch, pid)` — an exact key for as long as every source of
sight was a station, and wrong the moment an army is one. Sends are immediate,
so a march ordered on a **paused** board creates a wave with the tick and the
epoch both unmoved; the memo would have kept serving the fog from before the
army existed, with the sim right and nothing going red. `test/wavefog-tests.js`
in `tests-ui.html` now holds the fixed key, and the node suite cannot see any of
it — that file is not loaded there.

**AND IT DOES NOT CHANGE HOW THE AI PLAYS. THAT IS MEASURED, AND IT IS THE
MOST IMPORTANT THING IN THIS ENTRY.**

The prediction above — *"it enables scouting, which is a genuinely new strategic
action"* — is true for the **player** and, today, **false for the AI**. What was
measured, every tick of seeds 100–103 to 12,000 ticks, comparing `visibleTo`
against the same board with `state.waves` emptied:

| | |
|---|---|
| station-ticks a column revealed something a city could not | **8,555** |
| of those, stations the power had **never seen** | **0** |
| cities with a different owner at t=12,000 | **0 of 108**, all four seeds |
| worst relative garrison drift | **0.0** — bit-identical |
| full-state hashes | **all four moved** |

The hashes moved and the game did not. What changed is `state.seen` alone: a
column refreshes the remembered garrison of ground its power already knew, so
the memory record's tick and units are newer and nothing downstream reads a
different number. Byte counts moved 0, −2, +3, 0 — the signature of a value
edit, not a shape change and not a different war.

**Why zero, and why it is structural.** `TARGET_MAX_HOPS` is 2. A two-hop march
has exactly one intermediate station, and that station is adjacent to the source
the power holds — so it is already level 2 by the one-hop rule, before any wave
exists. The AI therefore *cannot* reveal new ground by marching, whatever the
wave rule says. The 8,555 reveals are the sight a power would otherwise have
lost mid-march: the source falls, or a `SOURCE_MAX_HOPS: 3` staging route
detours, and the column is the only thing still looking at that road.

So B2 is complete and correct and its AI-facing payoff is **gated on the
horizon, not on this code**. Two honest options, both for later: raise
`TARGET_MAX_HOPS` (Phase D owns that constant, and it is exactly the sort of
thing that must not be tuned against openings we already know are unequal), or
give the AI an explicit scout action. Neither is in scope here, and neither
should be done to make this entry look better.

**The player half is not conditional on any of that.** A human can send an army
anywhere reachable, including down a road nobody has ever looked at, which is
the request this feature came from. That path is covered by
`a REAL march, routed and stepped, lights the road it is on` and by
`test/wavefog-tests.js`.

**The 96-game sweep is not the instrument here and is not quoted.** The board
diff above is a stronger statement than a win-rate table could be: identical
owners and bit-identical garrisons on four seeds is *the same game*, not a game
that scored the same. A sweep over seeds 100–195 would add coverage of 92 more
openings and nothing else, and it takes an hour; if B2 is ever suspected of
moving play, the cheap check is to re-run the four-seed board diff, which would
have caught it.

### ~~B3. AI target selection~~ — SHIPPED 2026-08

B1 hands the AI a horizon; it must then learn to **choose**. This is the fix
for defeat in detail — the failure the r = −0.88 correlation between opening
neighbours and win rate is measuring. Without it, a wider horizon just means
splitting force in more directions.

What landed, in three parts:

**1. Commitment.** A target a power actually got an order accepted against is
KEPT, for at most `BAL.AI.FOCUS_TICKS` (600). Implemented as a REORDER of the
candidate list, not as a special case in the walk — the focus still has to clear
the war gate, the odds floor, the garrison floor and everything else, so
commitment can never make a power do something it would otherwise refuse. It
only changes WHICH legal thing it does. A stage commits to its `stageFor`, never
to the depot: the depot is the power's own ground and can therefore never be a
candidate, so that focus would expire 600 ticks later having done nothing.
Dropped when the target stops being a candidate at all — taken, fogged, out of
reach — because holding on would mean ignoring the board.

**The reorder is read-only.** `aiDecide`'s contract is that a test, or a console
`aiDecisions()` call, may read it with the board untouched; an earlier draft
cleared the stale entry inside the reorder, which would have meant that asking
what Austria would do silently retargeted Austria.

**2. The traversal rule, deduplicated.** `ai/score.js` kept its own copy of "can
a wave enter this station" that still said `owner === pid`. B1 moved that rule
and this copy did not follow — the second implementation of one rule, which is
the defect this project has logged five times. It now delegates.

**3. The AI builds** — `04-development.md` §10.3, closed. See there for the
three narrowings and what was measured.

**Verification.** `test/commitment-tests.js`, 16 tests, separate from
`test/ai-tests.js` so that suite keeps its written-blind-to-the-implementation
property. Every assertion was mutation-tested: eleven mutations of `ai/ai.js`,
each caught. Four of them survived the first draft and forced the tests to be
rewritten — three of the build rules are effectively invisible in ordinary play
(158 builds across five seeds x 6,000 ticks, and only EIGHT had more than one
legal site to choose between), so the run-based ordering test passed with the
comparison reversed. Replaced with built fixtures that state the choice instead
of hoping for one.

`render/ailog.js` rendered anything that was not a hold as *attack*; a build now
renders as a build. Unfixed, the panel showed the fortification of Beauce as one
of eleven assaults — checked against the shipped page, not a copy of it, because
no harness covers that file.

**DID IT FIX DEFEAT IN DETAIL? PARTLY, AND NOWHERE NEAR ENOUGH.** 96 games,
seeds 100–195, run on the B1 commit and again on B3:

| | before (B1) | after (B3) |
|---|---|---|
| French Republic | **84.4%** | **70.8%** |
| Russian Empire | 4.2% | 7.3% |
| Austria-Hungary | 3.1% | 4.2% |
| British / German / Italian | 2.1 / 1.0 / 1.0% | 2.1 / 1.0 / 1.0% |
| Ottoman Empire | 0.0% | 0.0% |
| win-rate spread | 84.4 pts | **70.8 pts** |
| mean game length | 20,839 ticks | **25,308 ticks** (+21%) |

The spread closed by 13.6 points and games got a fifth longer, which is the
right direction and the size of effect a *decision-making* change should have.
It is not a balance fix and must not be read as one: France still wins seven
games in ten, and three powers are still under 2%. **The residue is positional,
not tactical** — B3 changed how well a power fights with what it has, and every
power got the same change. What is left is what the opening deals them, which is
Phase D's problem and is still blocked on the owner's answer to *"is equal win
rate even the target?"*

The +21% game length is fortification working: cities are harder to take. B1's
approach interdiction is the release valve and it is not fully paying for the
walls yet — worth a look when Phase D opens, and NOT worth tuning before then,
because the constants would be tuned against a board whose openings are known to
be unequal.

---

## Phase C — combat and investment

### ~~C1. Collapse the three unit types to one~~ — SHIPPED 2026-08

`units` is a scalar. Five helpers, `BAL.UNITS`, `BAL.MATCHUP`, `BAL.UNIT_ORDER`,
`ARMOUR_VS_FORT`, `FORT_STRIP_CAP`, both `SEA_ARTILLERY_*` constants, the
`produces` field on all 108 stations and the `types?` narrowing on a `send` are
all gone. 34 files. Full write-up in `04-development.md` §9c; `00-vision.md` §4
carries the reversal.

**The headline is not "it shrank the surface".** The triangle was load-bearing
balance, and removing it moved the board a long way — 96 games either side, same
rig:

| | before | after |
|---|---|---|
| dominant power | France 70.8% | **Austria-Hungary 76.0%** |
| runner-up | Russia 6.3% | France 13.5% |
| win-rate spread | 70.8 points | **76.0 points** |
| mean game length | 25,445 ticks | 16,013 ticks |

The board did not get more balanced. It **changed hands and got 37% faster**,
and Phase D now knows the triangle was what was holding Austria-Hungary down.

**The refactor half is separately proven to have moved nothing**, which is the
method worth reusing: the rule deletion was staged in `data/tuning.js` alone,
then the same tree was folded into one bucket so no float association could
differ, and the real scalar refactor reproduces that board **bit for bit** —
same owner for all 108 cities, all 432 garrison floats identical, seeds 100–103
at 12,000 ticks. A ~700-site rewrite with an exact acceptance test.

**Two gaps are open and named rather than papered over:**

- **A producer station has no reason to exist** (16 of 108; cap 28.7 / rate 0.51
  against a holding's 37.65 / 0.83, strictly worse at everything). Its designed
  replacement is the **factory**, which `DEV_LIVE` says does nothing. That is now
  the strongest argument for making it live.
- **Nothing cracks a fortress but mass.** `04-development.md` §7's stalemate
  question is live again.

### ~~C1b. The AI cannot see a fortification~~ — SHIPPED 2026-08

`ai/score.js`'s one-station proxy (`_aiScoreBelievedAt`, and its twin
`_aiActBelievedAt` in `ai/ai.js`) copies `owner`, `units`, `attackers` and
`connected` — and **not `development`**. `fortLevel()` therefore sees no
fortification, so the AI's odds gate and target scorer are blind to every fort
on the board, **including the ones it has built itself since B3**. Measured: a
tier-3 fort moves `aiScoreTarget` by exactly 0.000, on this tree and on the
pre-C1 tree alike.

**It predates C1 and was deliberately not fixed there**, because fixing it
changes how the AI plays and would have landed inside a commit whose balance
numbers were already moving for another reason. It matters much more now than it
did: before C1 a defender's unit *mix* also varied its power, and the fort is
now the only thing that makes two equal-sized garrisons different.

The fix is small and has one real decision in it — memory (`state.seen`) records
`{o,u,c,t}` and no development, so the proxy can only carry a fort at belief
level 2, which is what `render/map.js` already does with the pips. Do it as its
own change, with its own before/after sweep.

**Done exactly that way.** Both proxies carry `development` at level 2 and
nothing at level 1, so the AI forgets a wall the moment it stops looking at it —
the same rule the pips give the player. The believed `units` do the rest:
`operatingTier` divides the built tier by the garrison, so a fortress the AI
believes is skeleton-held is planned against as the lower tier it would really
fight at.

| | before | after |
|---|---|---|
| believed defender power against a tier-3 fort | 31.500 | **40.500** — the true board |
| `aiScoreTarget` on that city | **0.0000** | **−0.378** |
| the same fort, only *remembered* | invisible | still invisible |

**THE BALANCE SWEEP DID NOT IMPROVE ANYTHING, AND THAT IS THE HEADLINE.** 96
games, seeds 100–195, on this tree and on `0fbdb11`:

| | before | after |
|---|---|---|
| Austria-Hungary | 74.0% | **77.1%** |
| French Republic | 17.7% | **9.4%** |
| German Empire | 0.0% | 4.2% |
| Russian Empire | 2.1% | 4.2% |
| British / Italian / Ottoman | 3.1 / 1.0 / 0.0% | 3.1 / 1.0 / 0.0% |
| win-rate spread | 74.0 pts | **77.1 pts** |
| mean game length | 15,706 ticks | 15,568 ticks |

The spread went the wrong way by 3.1 points and games did not get longer. **On
96 games neither movement clears the noise** — the standard error on a 74% rate
is 4.5 points — so the honest reading is *"no measurable effect on who wins"*,
not *"it made things worse"*. France losing eight points to Germany and Russia is
the largest single move and is about 1.7σ; suggestive, not established.

**Why a correct fix can be balance-neutral, and why it was still worth making.**
The AI now prices a wall correctly *and everyone's walls are priced correctly*,
so on a board where every power builds, the change is close to symmetric. What
it removes is a class of decision that was simply wrong — marching into a
fortress the attacker could see and had no way to account for — and that matters
for the **player**, who now faces an opponent that respects the thing the player
just spent half a city on. A fix whose justification is "the AI was reading a
field that does not exist" does not need a win-rate improvement to be right; what
it needed was proof that it did not make the board *worse*, and that is what the
table above is.

**It also tells Phase D something.** Austria-Hungary sits at 74–77% whether or
not the AI can see forts, which is another instrument saying the residue is
positional rather than tactical — the same conclusion B3 reached from the other
direction.

### C2. Development — FIRST PROTOTYPE SHIPPED 2026-07, out of order, on request

`04-development.md`, including the `b` key, the rail section, and the on-map
mark. ~~**Not started** — there is no `station.development`, no build command, no
UI.~~ All three exist. See `04-development.md` §9b for what is in it, what is
inert, and the 800px measurement of the pips.

**It landed before C1 and before B1, deliberately.** C1 first is still the right
sequencing and the spend is written through `splitUnits()` so the collapse costs it
nothing. ~~B1 is the more interesting omission: its interaction with development is
the point — fortification taxes armies that go *past* a city, which is what stops
defensive investment freezing the board — and **that half does not exist yet**, so
what is playable now is the investment without its release valve.~~ **B1 shipped,
and the release valve with it**: fortification interdicts armies closing on a
forted city, so a wall is a tax on the ground around it rather than only on the
assault that reaches it.

~~**The AI does not build** (`04-development.md` §10.3), so development is a
player-only mechanic today and the balance hashes did not move at all.~~ **It
builds, as of B3** — 75–88 builds a game across seeds 100–103, and the hashes
moved a very long way. See `04-development.md` §10.3 for the three narrowings and
what was measured.

### ~~C3. Route state and the standings panel~~ — SHIPPED 2026-08

Two halves, and the first had already landed under another name.

**"Understand if they're actually active"** shipped 2026-07 as the
flowing / waiting / stuck treatment (commit `2c26f46`) — the entry below still
describes it as unfixed and is now the stale half of this section. The
`blocked` reason also already reaches the player in words, per destination, in
the rail's supply section (`render/readout.js`, pinned by
`test/scenarios-orderswhy.js`). So §2's *"hover a route → the reason in plain
words"* did not need a second vocabulary; hovering a route now focuses the city
that owns it, and the existing explanation answers.

**"Tough to click"** is what actually remained, and §2 required it be *measured
before it is fixed*. It was, on the shipped page at 800x900 with 14 routes:

| | |
|---|---|
| a 12px band around a route overlaps a station symbol | **28.1%** of its area |
| station centres stolen by a 12px hit stroke | **0 of 44** |
| route length that becomes reachable | **70.7%** |

Those first two numbers only look compatible once you know why: routes are built
into `#g-links`, **below** `#g-stations`, so every pixel the two share resolves
to the station. The safety is structural, not lucky — and if that group is ever
moved above the stations the hit stroke starts eating the click that commits an
attack, with no error and no console output.

**The regression this nearly shipped with.** `selTerritoryAt()` read
`evt.target.closest('[data-territory]')`. The hit stroke is the first thing over
the board that accepts a pointer, so anywhere a route crossed a country the
event target was the route and the lookup came back null —
double-click-to-select-a-country did nothing, silently, on exactly the borders a
player is most likely to be managing. It now resolves through
`elementsFromPoint`, written against any overlay rather than against this one.

`test/routehit-tests.js`, 8 tests in `tests-ui.html`, five mutations each
caught. Two of those tests were written wrong first and their own vacuity guards
said so: one assumed routes never share a corridor (they do, and
`elementFromPoint` correctly returns the topmost), and one asserted every route
point sits over a country (a sea crossing does not).

### ~~C3, as originally written~~ — the stale statement of the problem

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

With A2 and A3 done — **and A3 is now genuinely done, not just mechanically
available** — what remains is only the network:

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
