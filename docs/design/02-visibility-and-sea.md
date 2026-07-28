# Round seven — visibility, neutrals, and the sea

Three concepts raised after Milestone 3. This document works out what each one
costs, what it replaces, and when it should land. `00-vision.md` stays the
locked spec; anything accepted here gets folded back into it rather than living
in two places.

---

## 2. Neutral stations — **already built, no work needed**

> *"when the game starts, there will be neutral stations, someone will be owned
> by neutral players that you still need to attack down to capture"*

This is live and has been since Milestone 2. Measured on seed 19140628:

| | |
|---|---|
| Neutral stations at turn zero | **59 of 108** |
| Neutral territories | **23 of 30** |
| Neutral garrison, t=0 | 441 units |
| Neutral garrison, t=3000 | **1804 units** |
| Neutral stations at >90% capacity by t=3000 | **59 of 59** |

`neutral` is a real power id in `POWERS`, holds real garrisons, and has to be
fought down station by station exactly as a rival power does. It simply never
takes decisions — it has no capital, no AI personality, and `growthTick`
connects it by fiat so it can never be cut off from a homeland it does not have.

### The property nobody designed on purpose

Neutral stations **grow to capacity and then sit there**. Mean fill goes from
about 40% to 99% within five sim-minutes. That produces a genuine strategic
clock that no rule states out loud:

> **Neutral ground is cheap early and expensive forever after.**

At t=0 a two-station country falls to one decent volley. By t=3000 the same
country is a wall of full-capacity garrisons, and taking it costs several times
as much. Expansion is therefore front-loaded, which pushes powers into contact
with each other early — precisely the pressure `LEADER_WEIGHT` and the balance
of power exist to respond to.

This is worth keeping and worth making *visible*. A player who does not know
neutrals harden will misread their opening as unhurried. Candidate for the
Milestone 5 readability pass: neutral nodes filling toward capacity should read
as filling, not as static grey.

### The one open decision

Neutral is passive: it defends but never counter-attacks and never reinforces
across links. **Recommendation: leave it passive.** An active neutral is an
eighth AI to tune and debug, and the design already has seven. The hardening
curve above supplies the pressure that an aggressive neutral would supply,
at zero additional machinery.

---

## 1. Fog of war

> *"you should only see troops in areas visible to you. there should be a 'fog
> of war' on spaces not owned by you or if you don't control a station that
> increases visibility"*

This reverses `00-vision.md` open question #5, which parked fog for v1 on the
grounds that it makes AI behaviour much harder to debug. That objection was
correct and is now **substantially cheaper**, because Milestone 4 ships a
decision log: when a power behaves strangely under fog you can read what it
believed and what it scored, instead of inferring from the board. Fog without
that log would still be a bad trade.

### Architecture: the sim keeps knowing everything

**Visibility is derived, never stored, and the sim state stays complete.** A
single function gates what may be *read*:

```
visibleTo(state, pid) -> { sid: level }     // 0 hidden, 1 fogged, 2 visible
```

Two consumers, and only two:

- `render/` masks what it draws.
- `ai/score.js` filters its candidates.

Nothing in `sim/` consults it. This matters more than it looks: the moment fog
lives *inside* the simulation, determinism testing gets much harder (two states
that differ only in what a power has seen are no longer comparable), and every
existing sim test would need a visibility fixture. Keeping the state total and
the *reads* partial preserves every guarantee already paid for — seeded replay,
byte-identical 1x vs 4x, headless testing.

### Three levels, not two

Binary fog hides too much to play against. The standard three:

| Level | What you see | When |
|---|---|---|
| **Hidden** | Territory shape only. No node, no number. | Never seen |
| **Fogged** | The station, its type, and its owner **as of when you last saw it**. Garrison shown stale and marked stale. | Seen before, not seen now |
| **Visible** | Everything live, as today. | In range now |

Fogged-not-hidden is what keeps the game playable: you remember the map, you
just do not know what is on it *now*. That converts the current "read the
number" skill into "decide whether last minute's number is still true", which is
a better skill and costs one extra render state.

### Where vision comes from

The prompt asks for stations that *increase* visibility. **Recommendation: make
`vision` a numeric property on the station record, not a fifth station type.**

- A fifth type means a fifth silhouette, and §8 already spends shape on the four
  existing types. There is no shape budget left.
- As a data property, `tools/build-stations.js` can assign it from facts it
  already has — a naval base or a citadel on a chokepoint sees further — without
  touching the type system or the render legend.

Default vision 1 hop; defensive stations and a handful of authored observation
points get 2. Vision is computed over `LINKS`, so it flows down roads and across
sea crossings the same way armies do, which is both cheap (the BFS already
exists in `aiContext`) and legible.

### The AI gets the same fog

Symmetric, without exception. An AI reading the true board while you read a
fogged one is the single most reliably resented thing in a strategy game, and it
is also *undebuggable in the other direction* — you can never tell whether it
outplayed you or peeked.

The lucky part: `aiContext(state, pid)` is already a pinned seam that builds
per-decision cached facts including a hop map. Visibility filtering belongs
there, and adding it later touches one function rather than the whole AI.

> *Struck 2026-07. The last sentence is **false**, and it was measured false
> before a line of fog was written. Tracing every path by which the AI learns
> about a station found **22 reads**, only 4 of them inside `aiContext`.
> Filtering there changes which stations become **candidates** and nothing
> about **what the AI knows once one is a candidate** — and the number that
> decides every attack, the defender's live garrison, is read through three
> call sites (`_aiActDefenderPower`, `_aiActStackPower`,
> `_aiActGrownDefenderPower`) in two files, none of which receives `ctx`.
> `_aiActPlanVolley` and `_aiActPlanStage` have no `ctx` parameter at all.
> Real cost: **~8 functions across 2 files, 5 of them signature changes.***
>
> *The seam that does work is one the AI already built for itself: it
> constructs single-station **proxy states** twice over, purely so it can reuse
> the canonical `stationPower` instead of re-deriving it. A believed board
> rides in on that same machinery.*
>
> *And one hard prohibition, because it costs nothing to state and 1,400× to
> discover: **never hand a proxy or believed state to `routeFor` /
> `commandRoute`.** `_ownRouteCache` (`sim/movement.js`) invalidates on state
> **object identity**, so a fresh proxy per call blows the real state's route
> cache too, and `movementTick` then recomputes its Dijkstras from scratch
> every tick. Measured on the live board: `routeFor` cached **0.115 µs**, with
> a fresh proxy each call **161.1 µs**. It produces no wrong answer — only a
> game that crawls, which is the hardest kind of regression to attribute.*
>
> ***Decision: routing legality stays on the true board.** The AI and the
> player's preview may both route through ground they have never seen. A route
> is a claim about where your own army may walk, and "you find out the road is
> blocked when you march" is legible fog behaviour rather than a bug. This is
> the one place the fog is deliberately incomplete on the map, and the
> sequencing section below names the other one.*

### Cost, honestly

This is the largest of the three. It touches `render/map.js` (masking, stale
values), a new derived-visibility module, `ai/score.js` (candidate filtering),
and the balance harness (which must decide whether to report true or believed
state). Call it a milestone of its own, not a bolt-on.

---

## 3. Sea attacks

> *"there should be sea based attacks that can only originate and end at coastal
> cities. the units that fall there may be partial sea and land afterwards"*

### What exists today

`00-vision.md` §3 deliberately made the sea *"simply slow and punishing rather
than a naval system"*. Concretely: **10 sea links**, touching **17 of 108
stations**, with `SEA_SPEED_MUL` slowing everything and
`SEA_ARTILLERY_SPEED_MUL` punishing artillery specifically.

> *Revised 2026-07. Milestone 5.5 shipped change (a) below: there are now **32
> sea links**, not 10. Everything downstream of that count in this document was
> written against the old board — in particular the fog cost estimate in §1,
> since vision flows over `LINKS` and therefore leaks across three times as much
> water as costed here. Britain at vision 1 sees the continental terminus of
> every crossing it holds. That is wanted, but it is a **decision**, not an
> accident, and it is recorded here because nothing else records it.*

So "sea attacks originate and end at coastal cities" is *already structurally
true* — but it is thin. Ten fixed pairs is a set of bridges, not a sea. Britain
has essentially one way onto the continent, which makes the British opening
nearly scripted.

### Two changes, in order of value

**(a) A real sea graph.** Derive coastal status properly in
`tools/build-stations.js` (a station is coastal if it is within *n* km of the
clipped coastline — the coastline nudge pass already computes this distance) and
allow a sea crossing between any two coastal stations within a range cap.
That turns 10 bridges into a genuine second network, and it is the change that
actually makes amphibious strategy exist. It is also almost entirely a
*build-time* change: `LINKS` gains records, and nothing in `sim/` needs to know.

**(b) The beachhead — "partial sea and land afterwards".** Read as: a landing
does not arrive all at once. Cheapest version that delivers the feeling, reusing
structures that already exist:

> A wave arriving over a **sea** link lands in echelons over
> `BAL.LANDING_TICKS`, committing a fraction of its strength per tick instead of
> the whole stack at once. Units still at sea are **not yet in the battle** and
> **cannot be hit**.

Consequences, all of them wanted:

- Square-law combat does the rest with no new combat code. A defended beach
  chews an amphibious force **piecemeal** — the trickle you are otherwise
  punished for is now forced on you by the water. Amphibious assault becomes
  genuinely hard without a single naval unit being modelled.
- The counter is exactly the one that should exist: land somewhere *undefended*
  and walk, or bring enough that even echelons overwhelm.
- It makes Britain's map problem real instead of scripted, and it gives the
  Ottoman and Italian coastlines a reason to be watched.
- It reuses `station.attackers` and the existing wave record. The only new state
  is a per-wave "still at sea" remainder.

**Recommendation: (a) is high value and cheap, (b) is high value and moderate.
Both worth doing. Neither should precede fog** — see below.

---

## Sequencing — the one non-obvious finding

These land *after* Milestone 4 (AI) but there is a hard ordering constraint
against Milestone 6 (the balance pass):

> **Fog must land before the balance pass, not after.**

Balance under full information is not the same game as balance under fog. Every
tuning constant in `BAL.AI` — `MIN_ODDS`, `TARGET_MAX_HOPS`,
`CANDIDATES_PER_DECISION`, the whole `VALUE` table — describes decisions made
against a board the AI can *see*. Restrict what it can see and every one of
those decisions changes. A balance pass run first would have to be thrown away
and run again.

Two things reading the code adds to that argument.

**The standings stay public — the second deliberate hole in the fog.**
`ctx.leader` and `ctx.leaderShare` are built by walking `territoryControl`
across **all 30 territories**: global information, computed every decision.
`LEADER_WEIGHT` is 45.0 and is the only constant on the board that can actually
declare a war — it is the mechanism §5 relies on to keep the square-law
snowball honest. Fogging it would silently disarm the balance of power and
leave the leader unopposed, which is the exact failure the Concert exists to
prevent.

> **Decision: who is winning is public knowledge.** In 1914 the standings are
> newspapers, embassies and attachés, not reconnaissance. You can hide an army;
> you cannot hide having conquered Belgium. Fog covers *what is in a city*, not
> *who holds the map*.

This is a balance-defining choice rather than a detail, and it is written down
because a later reader will otherwise find global reads inside a fogged AI and
"fix" them.

**Milestone 6 is now carrying two un-rebalanced structural changes, not one.**
The note above about a real sea graph changing hop distances — and therefore
`TARGET_MAX_HOPS` and `SOURCE_MAX_HOPS`, the constants deciding whether the AI
defeats itself in detail — was written as a future risk. It has already
happened: 5.5 shipped 32 sea links against the 10 this document was costed on.
Fog is the second. Both must be in before Milestone 6 runs, and Milestone 6
must run **once**.

Sea is the milder case but points the same way: a real sea graph changes hop
distances, which changes `TARGET_MAX_HOPS` and `SOURCE_MAX_HOPS`, which are the
constants that decide whether the AI defeats itself in detail.

Revised order:

| # | Milestone | Status |
|---|---|---|
| 4 | AI powers | **done** |
| 5 | Readability — includes neutrals reading as *hardening* | **done** (5.6, 5.6b) |
| **5.5** | **Sea graph + beachhead landings** | **done** — 32 sea links, echelon landings |
| **5.6c** | **Making the sea *visible*** | **done** — see below |
| **5.7** | **Fog of war** | in progress |
| 6 | Balance pass — run **once**, under fog and sea | blocked on 5.7 |

### 5.6c — the milestone nobody planned

Milestone 5.5 was reported complete and was, in the sim. Instrumenting 12 full
games afterwards found **7,182 sea crossings and 4,282 beachhead landings** —
and a player who had never seen one. Every part of the feature worked and none
of it was on screen:

- Links were drawn centre-to-centre while station symbols have a 12px radius,
  so `dov→lil` — 21px between centres, and **24% of all crossings** with
  `lil→lon` — had **−10.1px** of visible line. Five sea links rendered at
  literally zero.
- The beachhead marker stood off *along* the link, competing for length it did
  not have, and rendered **12.2px inside the destination city's battle ring**.
- 4,282 landings produced **zero** ticker lines. An amphibious assault and a
  road march read identically.

Fixed by bowing sea links into arcs whose sagitta is *derived* from the symbol
radius (so a short crossing bows hard, a long one gently, and the bow melts
away as you zoom in and symbols counter-scale), trimming every link to the
symbol edge, and pushing the landing marker **perpendicular** to the arc rather
than back along it. Minimum visible sea arc is now **12.4px across all 32
links** and holds from 1× to 4×.

> **The lesson, which is the reason this section exists.** A green test suite
> and a working sim proved the feature existed; neither could see that it was
> invisible. `test/node.js` loads no `render/` file **by design**, so every
> render-layer bug this project has logged (known-issues #15 twice, #16, #18,
> #20) lived in a tree that was passing. A feature is not done when the sim
> does it. It is done when a player can see it happen.
