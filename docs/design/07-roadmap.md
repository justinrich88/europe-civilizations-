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

### A1. Ship it

GitHub Pages serves this repo directly with no build step. **The only blocker
is that the repo is private** — Pages on a private repo needs a paid plan;
public is free. That is a decision, not a task.

Once live, every later phase gets played by someone other than its author,
which is the only test this project does not currently have.

### A2. Deterministic arithmetic — the multiplayer prerequisite

Four call sites in the sim layer use functions **ECMAScript does not specify
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
engine. That is exactly why it must be fixed before more sim maths is written,
and `06-movement-and-attrition.md` adds a whole attrition model.

- `Math.pow(FALLOFF, hops)` has an **integer** exponent — a multiply loop is
  exactly deterministic and likely faster.
- `Math.sin` wobble → lookup table with fixed interpolation.
- `Math.exp(-x)` → rational approximation.
- `atanh` is computing a **constant** and should be precomputed outright.

Add a cross-engine test: hash `snapshot()` after N ticks and pin the value.

### A3. Tick-scheduled commands

`applyCommand(state, cmd)` applies immediately. Lockstep needs commands to
carry the tick they execute on, queued and drained at a fixed point in
`stepTick`. Phase order is load-bearing (`sim/step.js`), so where they drain is
part of the contract, not an implementation detail.

**Do this before `04-development.md`**, which adds a `build` command. Written
after, `build` is scheduled by construction; written before, it is a retrofit.

### A4. Pause and speed leave the player UI

*Decided.* They are testing conveniences, not mechanics, and one shared clock
is required for lockstep anyway.

**Keep them behind `?dev=1`, do not delete them.** Browser verification pauses
the board constantly, and losing that slows every future change. The headless
harness is unaffected — it drives `stepTicks` directly.

Note the consequence for the design: `00-vision.md` §1's *"orders can be issued
while paused"* stops being true, and the board must be readable **while
moving**. That raises the stakes on `05-command-clarity.md`.

### A5. Selection safety

`05-command-clarity.md` §1. **You cannot currently inspect an enemy city
without attacking it** — the same click either opens a readout or launches your
army, decided by selection state that is usually off-screen. It is the only
open item a player is actively losing games to, and it is the cheapest thing
here. A4 makes it worse, so it should not land after A4.

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

### C2. Development

`04-development.md`, including the `b` key, the rail section, and the on-map
mark. **Not started** — there is no `station.development`, no build command, no
UI. Its interaction with B1 is the point: fortification taxes armies that go
*past* a city, which is what stops defensive investment freezing the board.

### C3. Route state and the standings panel

`05-command-clarity.md` §2–3. The data to answer *"is this route running"*
already exists in `standingOrderNext` and never reaches the screen. The
standings panel must be fog-filtered, so it lands after fog is settled.

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

## The one thing gating everything

**Is the repo public?** Phase A1 is blocked on it, and A1 is what turns every
later phase from a design argument into a playtest.
