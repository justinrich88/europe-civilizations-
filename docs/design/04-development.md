# Round eight — development

*Stations become things you invest in, not just numbers you accumulate.*

`00-vision.md` stays the locked spec. This document works out one change to it,
and the parts that are accepted get folded back rather than living in two
places.

---

## 1. The problem, stated precisely

> *"the game feels overly dependent on quickly moving units and doesn't reward
> holding units"*

Correct, and the cause is arithmetic rather than taste. Growth is

```
growth = rate × units × (1 − units / capacity)
```

which peaks at **half capacity** and falls to zero at full. So every unit held
above 50% earns less than the same unit would sitting in a half-empty station
somewhere else. Holding is not merely unrewarded — **past `cap/2` it is
strictly dominated.** The optimal line is to keep every station hovering near
half and ship the surplus forever, which is precisely the "always be moving"
feel being complained about. The game is working as designed and the design was
wrong.

The 5.6b overflow change (units may now reach `1.5 × capacity`, growing at
half rate) softened this without reversing it. Above capacity you still earn
less than you would elsewhere.

**Development is the fix: a use for units that only pays if they are standing
still.**

---

## 2. Two mechanisms, and why it needs both

Two candidates were considered.

**A one-time spend** — pay N units, keep the benefit forever. Real cost: force
total permanently drops. But it does *not* reward holding. Worse, **the growth
curve refunds it**: spending down drops the station toward `cap/2`, which is
exactly where growth peaks, so it regrows fast. You pay force and the curve
hands back rate. Spend-only rewards accumulate-then-dump — the same pump the
game already runs, with a second place to dump.

**A held-unit threshold** — hold N units, get the benefit while you hold them.
This does reward holding. But it has **no real cost**: the units are still your
garrison, still defending, still available to launch tomorrow. You get the port
*and* you keep the army. The only thing given up is attacking this instant,
which is a pause, not a price.

| | fixes "units have one use" | fixes "holding is punished" |
|---|---|---|
| Spend | yes | no |
| Threshold | no | yes, but free |

So: **both, as one rule.**

> **Spend units once to BUILD it. Its OPERATING TIER then tracks the garrison
> currently standing in the station.**

Build is the sink. Garrison is the rent.

### What this buys for free

Two requested behaviours fall out with no new state and no new code:

- **"a cost of it being destroyed"** — an attacker kills garrison, garrison
  drops below a tier line, the development degrades. No damage model, no
  development hit points, no separate destruction rule.
- **"a cost to rebuild"** — regrow the garrison and the tier returns. And
  because the station is now *low*, growth is fast, so recovery feels
  responsive rather than punishing. This is the logistic curve working **for**
  the mechanic instead of against it.

Capture remains the one explicit rule (§6), and it is the same rule
`setStationOwner` already applies to supply lines.

---

## 3. Cost — scaled to capacity, never flat

Measured on the live map: capacity runs **13 → 74**, median **32**. A 5.7×
spread. A flat cost would make development routine for industrial powers and
impossible everywhere else, sharpening exactly the rich-get-richer problem §7
is worried about. Cost is therefore a fraction of the station's own capacity,
so *"about two-thirds full"* means the same thing everywhere on the board.

| tier | build cost | cumulative |
|---|---|---|
| 1 | `0.50 × capacity` | 0.50 |
| 2 | `0.75 × capacity` | 1.25 |
| 3 | `1.00 × capacity` | 2.25 |

Tiers are sequential — tier 2 requires tier 1 built.

Three properties this specific curve was chosen for:

1. **Paying tier 1 from a full station lands you at `cap/2`** — peak growth.
   The first investment is genuinely affordable, so development is not a
   late-game luxury.
2. **Tier 3 cannot be paid without entering the overflow band.** It costs a
   full capacity's worth, so you must have pushed past `1.0 × cap` to pay it
   and still hold anything. This gives the 5.6b overflow mechanic a purpose it
   currently lacks — at present, units above capacity are pure dead weight and
   the fullness ring does not even render them.
3. **Reaching tier 3 costs 2.25 × capacity in total** — several fill-and-spend
   cycles. A tier-3 fortress should be rare and remembered.

**Units must be present in the station.** Build is self-funded: you spend what
that city has grown, not what you shipped in. This keeps development a local
decision about a city you have actually built up, and it avoids the strategic
version where interior reserves are pumped into frontier developments — which
would make rear-area safety compound and lean hard into the snowball.

A build may not take a station below **1.0 units**. A station at zero is
capturable by anyone who walks past, and a build command should not be a way to
lose a city by accident.

---

## 4. Operating tier — the rent

```
operating tier = min( built tier, floor( garrison / (0.25 × capacity) ) )
```

Read plainly: **each tier needs a quarter of capacity garrisoned to operate.**

| garrison | operates at |
|---|---|
| ≥ 75% of capacity | tier 3 |
| ≥ 50% | tier 2 |
| ≥ 25% | tier 1 |
| < 25% | nothing |

This is legible directly off the number already printed on the node — no new
readout is required to know where you stand, which matters because §8 says the
number *is* the interface.

It also produces the intended sequencing: paying tier 3 from the overflow band
leaves you at `0.5 × cap`, so the thing you just built **operates at tier 2
until you regrow it.** You build the capability, then you have to garrison it
to use it. That delay is a feature.

**Flicker is not a problem here.** A tier tracking garrison is not flickering,
it is *reporting*. Hysteresis is only needed if a tier boundary sits somewhere
units naturally oscillate, and the boundaries sit at quarter-capacity marks
while growth is smooth. Revisit only if playtesting shows a station drumming on
a line.

---

## 5. The three developments

**One per station.** Choosing is the decision; the exclusivity is what makes it
one. A station's development can never be changed — only lost with the station.

| development | where | effect |
|---|---|---|
| **Fortification** | **every station** | Additive defence bonus. §5 of `00-vision.md` is explicit that station defence is **additive, not multiplicative**, "otherwise attacking is never worth it and the map freezes" — this obeys that and the tier scales the addend. |
| **Port** | the **38** stations touching a `sea: true` link | Reduces the sea toll — units lost crossing water. Does not touch march speed; the 3.2× time penalty is what makes the sea a commitment and should stay. |
| **Factory** | the **16** `producer` stations | Attack bonus against fortified and `defensive` stations. |

Availability, measured: **51 of 108 stations have more than one option** (38
coastal + 16 producer − 3 that are both). The remaining 57 face fortify-or-
don't, which is still a real decision given the cost.

Only **3 stations are both producer and coastal** — those face a genuine
three-way choice and should feel special.

### The factory carries artillery's job

`00-vision.md` §4 justified producer stations like this: *"without artillery you
cannot crack a fortress belt, and only a handful of places on the map make
artillery."* Factories inherit that role exactly, with one improvement — it is
**visible on the map** instead of hidden in a stack's composition.

**The bonus is stamped on the wave at launch**, from the origin station's
factory tier, rather than looked up at impact. Two reasons: a factory captured
mid-march must not retroactively disarm waves already in flight, and combat
should not need to reach back to a station that may no longer exist or may have
changed hands. `wave` already carries `from`; this adds one number beside it.

The consequence is the wanted one: **you crack fortresses with waves launched
from factory cities**, so factories are strategically located assets and the
artillery logistics problem survives the deletion of artillery.

---

## 6. Capture, and what survives

**Capture destroys the development entirely** — the build, not merely the
tier. The new owner starts from nothing.

This is the same rule `setStationOwner` already applies to supply lines, so it
fits the existing grain and lands in the existing chokepoint. It also keeps the
sink honest: development is a permanent cost that a permanent loss can take
away, which is what makes garrisoning it matter.

Note the asymmetry with §4, and that it is deliberate: **being raided degrades
your development; being conquered deletes it.**

---

## 7. Risks

**Stalemate is the real danger, and fortification is where it comes from.**
Development makes held stations stronger, which makes them easier to hold —
a snowball pointed straight at the three systems `00-vision.md` §5 relies on to
prevent one. Fix "moving is over-rewarded" too enthusiastically and the board
freezes.

The ratio is currently wrong for this. Fortification is available at **all 108
stations**; its counter, the factory, at **16**. Defensive development is seven
times more available than the thing that answers it.

**Accepted correction: fortification is capped at tier 2 everywhere except
CAPITALS, which alone may reach tier 3.** Seven stations on a 108-station
board.

Capital-ness is a **static property of the station**, not of whoever currently
holds it — so a captured Berlin is still eligible for tier 3, and eligibility
never moves during a game. That matters: a rule that shifted as capitals fell
would make the fortification ceiling a moving target the player cannot plan
against.

This is a better bound than gating on `defensive` type, which was the earlier
proposal. It is half as many stations, it is unambiguous, and it needs no new
data — `data/scenario.js` already names the seven.

> **Consequence to watch: this makes the endgame harder, deliberately.** §7 of
> `00-vision.md` makes capitulation the mercy rule — a power that loses its
> capital *and* falls below ~25% of its starting territory hands everything to
> whoever took the capital. Tier-3 capital defence puts a wall in front of that
> trigger. A last stand at Vienna should be the hardest fight on the board, but
> the failure mode is games that cannot be closed out. **Milestone 6 must watch
> mean game length and the tick-cap rate specifically**, and if the endgame
> drags, the tier-3 capital addend is the first constant to cut. It is one
> number and it is isolated.

**Secondary risk: development compounds with the leader.** A power that is
ahead has more full stations and can afford more builds. `LEADER_WEIGHT` (45.0)
and the balance-of-power drift are the existing answer and are unchanged by
this, but Milestone 6 should watch the win-rate spread specifically for
development amplifying it.

---

## 8. Interaction

Two paths to the same command, per the brief:

- **The right rail.** The station readout already opens on click for a station
  you own. It gains a build section: what may be built here, the cost in units,
  the current built tier, and the current operating tier with the garrison
  needed for the next one.
- **`b`.** With one or more of your stations selected: if a station already has
  a development, `b` buys the next tier. If it has none and only one type is
  legal there — the case for 57 of 108 stations — `b` builds that. If more than
  one is legal, `b` focuses the rail's build section and the choice is one more
  click.

This is the design's **first verb that is not select-and-target**, and
`00-vision.md` §8's cut list names build queues explicitly. That cost is
accepted here with eyes open, and bounded: one key, one panel section, no
queue, no menu tree, nothing to cancel. A spend cannot exist without a spend
gesture, and this is the smallest one available.

### On the map

The board is deliberately plain and should stay that way. The channels are
already spoken for: **silhouette** carries the four station types, **colour**
carries ownership, and the **centred number** is the interface. Fullness is a
ring. What is left is a small mark, and it has to earn every pixel.

**Show the gap, not the fact.** "This station is developed" is the boring half.
The half worth a mark is that **built tier and operating tier can differ** — a
tier-3 fortress held by a skeleton garrison fights as tier 1, and spotting that
across the board is the entire skill the mechanic creates. A badge that only
said "fortified" would be decoration; one that says "fortified, and currently
running at a third of what you paid for" is information.

Proposed treatment, to be settled against a screenshot at 800px:

- **Pips under the node.** One slot per **built** tier, filled to the
  **operating** tier. Three slots with one filled reads instantly as *"you
  built a fortress and you are not garrisoning it."* Empty slots are the whole
  point and must remain visible.
- **Type is a glyph, not a colour** — one simple mark each for fortification,
  port and factory, since colour cannot be spent here.

**The risk is legibility at 800px, and it is real.** That is the window
known-issues #17 says the game is played at, where the garrison number renders
around 8.8px. Pips at that size are 2–3px and may collapse into mush across 108
stations. If they do, the fallback is to move tier onto the **node outline**
(weight or a doubled stroke, three steps), which costs no extra pixels and
survives being small — accepting that the built-vs-operating gap then has to
live in the readout instead of on the board.

**Decide this by measuring, not by opinion.** Render both at 800px with a full
board and look. Precedent: the sea crossings shipped "working" and were
invisible for a whole milestone, and the ticker was invisible for longer;
neither was caught by a test, because `test/node.js` loads no `render/` file.

Note `00-vision.md` §8 does sanction floating labels — the Virus Wars reference
literally floats *"x2 Reproduction"* beside a node. That works at seven
multiplier stations. It will not work at 108, so labels stay for the hover
readout and the map gets the mark.

---

## 9. Sequencing

**Unit types should be cut first, as their own step.**

`00-vision.md` §4 defines infantry / artillery / armour with a soft triangle.
Development replaces what that triangle was for — and does it better, because
the triangle was never visible: the number on the node is the interface and it
never said what a stack was made of. Development moves the differentiation from
the *stack* (mobile, unreadable) onto the *station* (fixed, on the map).

Building development against three unit types and then collapsing to one means
doing the work twice. Cutting first shrinks the surface development has to
touch: `units:{infantry,artillery,armour}` becomes a scalar, and the matchup
term leaves the combat power calculation.

| # | step | why this order |
|---|---|---|
| 5.7 | Fog of war | in progress; must precede Milestone 6 |
| **5.8** | **Collapse the three unit types to one** | mechanical, large surface, shrinks everything after it |
| **5.9** | **Development** | as specified above |
| 6 | Balance pass | run **once**, under fog, sea, and development |

Milestone 6 is already carrying two un-rebalanced structural changes (the 32-
link sea graph, and fog). Development is the third and largest. All three must
land before it, and it must run once.

---

## 9b. WHAT SHIPPED — first prototype, 2026-07

`sim/development.js`, a `build` command, the `b` key, a rail section and pips on
the board. **Out of order on purpose**, and the reason is worth recording: §9 says
collapse the unit types first, and that is still right — but a prototype that can
be *played* answers "is this fun" in a way the sequencing argument cannot, and the
spend is written through `splitUnits()` so the collapse costs it nothing.

Built, and tested in `test/development-tests.js` (25 tests):

- the whole loop — spend, tier, operating tier tracking garrison, capital-only
  tier 3, one development per station that can never be changed
- **capture deletes the build, a raid only degrades the tier.** The asymmetry §6
  asks for, and it needed no damage model
- the two arithmetic claims §3 rests on, checked rather than asserted: tier 1 from
  a full station lands exactly on `cap/2`, and tier 3 **cannot** be paid at
  capacity — only out of the overflow band, which leaves it operating at tier 2
  until regarrisoned
- **fortification has a real effect**, through `fortLevel(sid, state)` so it goes
  through the existing scale-in and artillery-strip path. An unmanned fortification
  adds nothing, and artillery still answers a built fort. Both tested.
- **fortification INTERDICTS.** A hostile wave loses units on its final approach
  to a garrisoned fortification (`BAL.DEV.FORT_APPROACH_LOSS`, scaled by the
  operating tier). This is `06-movement-and-attrition.md` §6's "fortification taxes
  armies" arriving early, on the player's instruction, and it is **§7's own answer
  to the stalemate risk**: a fortress that projects outward is not a turtle. See
  that document for the two ways this is deliberately narrower than the full
  passage toll.
- **the gesture is `b` → a numbered chooser → 1/2/3.** It arms rather than firing,
  because a spend has to say what it buys, what it costs, and **whether the thing
  will actually switch on afterwards** — `operatingAfterBuild()` answers the last
  one, and it is the surprise this mechanic can otherwise spring (§4). The first
  version fired immediately with no kind and was a **dead end at 51 of 108
  stations**: the command correctly rejected `choose-kind` and there was nothing to
  choose with.

**Port and factory are buildable and INERT.** Tracked, tiered, capture-deleted —
and they do nothing, because nothing implements them. `DEV_LIVE` in
`sim/development.js` is the single source of truth for that, and the rail prints
"no effect yet" / "(inert)" from it, so no screen claims an effect the sim does not
have. The *choice* is what is worth playtesting now; the effects can follow.

### The rail, after "too wordy"

The first version read: *"built Fortification 2 | running 1 of 2 —
under-garrisoned | to next 14.4 more to run at 2 | b builds needs 72.0 units"* —
four rows and thirty words in a 200px column, to say what a row of pips says at a
glance. The rail is **glanced at between orders, not read**.

Now: the **type is an icon**, the **tier is pips filled to what is running**, and
the only number is the actionable one — how many units switch the next tier on.
Same pip encoding as the map, deliberately: one idea should not have two visual
languages.

### §8's map question, measured rather than argued

§8 said "decide this by measuring, not by opinion. Render both at 800px with a
full board and look." Done, with pips:

| | |
|---|---|
| pip diameter at 800px | **1.8 CSS px** |
| type glyph | **2 × 3 px** |
| encoding | one slot per BUILT tier, filled to OPERATING |
| does it eat clicks | **no** — checked with `elementFromPoint`, and the mutation without `pointer-events: none` puts the pip on top, i.e. it would |

**The encoding works and the size is the problem — exactly as §8 predicted.**
Magnified 4× from the same 800px render, Berlin reads ●●● (3/3), Silesia ●○ (1/2,
under-garrisoned) and Hamburg ○ (0/1) instantly. At true 800px they are a faint
smudge under the node: you can tell something is there, not how many or whether
filled. The glyph is worse and is close to invisible.

So the fallback §8 names — **tier on the node outline** (weight or a doubled
stroke, three steps), with the built-vs-operating gap moving into the readout — is
now a live option rather than a hypothetical, and it is the player-facing owner's
call. One mitigation found by accident: **fog cuts the density hard.** On a
mid-game board with 42 developments, Germany could see 3 of them, because the pips
are gated at belief level 2. The 108-stations-of-mush case does not arise.

### Still open from this section's own list

- **§10.1 effect magnitudes.** `FORT_POWER_PER_TIER` is 0.5, derived against
  `DEFENSE_BONUS_POWER` (6.0) rather than picked — a tier-2 fort adds one full
  point of fort level, a tier-3 capital 1.5, half a citadel. Untuned.
- **§10.3 does the AI build? NO, AND THIS MATTERS MORE THAN IT LOOKS.** `aiTick`
  is untouched, so development is currently a player-only mechanic. The visible
  consequence: the balance hashes did not move at all, because nothing in a
  headless run ever builds. Milestone 6 would measure a game the player is not
  playing.

---

## 10. Open

1. **Effect magnitudes.** Every number in §5 is a shape, not a value. These are
   `data/tuning.js` constants and should be derived against the existing combat
   maths — particularly the additive-defence rule — rather than guessed here.
2. **Multiplier stations get nothing.** The 7 farm stations can only fortify.
   A fourth development boosting their reach is the obvious idea and is
   deliberately **not** proposed: `00-vision.md` §12 already flags multiplier
   reach as the mechanic most likely to prove too strong or too invisible, and
   amplifying it before it is understood is the wrong order.
3. ~~**Does the AI build?**~~ **It does, as of B3.** `aiTick` was the seam, as
   expected. `ai/ai.js` `_aiActPlanBuild()` — considered LAST in `aiDecide`,
   after attack and after staging, so building can never displace an order that
   moves units; it fills in the actions a power was already spending on nothing.
   Narrowed three ways:

   * **Live kinds only**, read off `DEV_LIVE` rather than hard-coded. Today that
     means forts. A power that spent half a city on a port would be paying a
     real cost for nothing, and the balance pass would then be measuring the AI
     handicapping itself instead of measuring development. The day a port does
     something, this starts weighing ports and §5's "choosing is the decision"
     becomes the AI's problem too.
   * **Tier 1 only.** A tier 2 costs 0.75 x capacity and needs 0.5 x capacity
     left standing to run, so it wants 1.25 x capacity — reachable in the
     overflow band, and it means paying a second tier's price for the first
     tier's effect and waiting out the regrowth to collect. That is a bet on the
     future this AI has no machinery to reason about, and breadth is the better
     instinct for a chooser that cannot plan: two forted cities beat one
     twice-forted.
   * **It must switch on immediately** — `operatingAfterBuild()` must return the
     tier just paid for. A power builds precisely when it is stuck, which is the
     worst moment to be carrying a defence it has not finished paying for.

   It builds on the most exposed frontier: the owned station with the most
   neighbours it does not own. *Do I own this?* is the one ownership question
   fog never clouds, so this needs no belief layer and leaks nothing.

   **Measured at 12,000 ticks on seeds 100–103**: 75–88 builds per game, of
   which 34–58 forts were still standing at the end — the rest were destroyed by
   capture, which is §5's "a cost of it being destroyed" working with no damage
   model. Every one of them operating at the tier paid for. Both halves of the
   loop are live in AI play, not just in the player's hands.
