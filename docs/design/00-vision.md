# Concert of Europe — design + build plan

*Working title. Virus Wars' node conquest, played across a 1914 map of Europe, where the nodes are real cities and what a city **is** determines what it gives you.*

---

## Context

Over four rounds this design got substantially simpler and substantially better. The two moves that mattered:

**Virus Wars is the model, not Risk.** Units accumulate on their own in the places you hold. You drag from a place you hold to a place you want. A visible blob travels; when it lands it overwhelms or it fails. No build queues, no order dialogs, no resource meters.

**Stations are the map, not a panel.** This is what you said in your very first message — *"the player gives units move over to various points on a country"* — and I'd flattened it into province-level bookkeeping. Reverted. Countries are the political skin; **stations inside them are what you actually own, garrison, grow, and fight over.**

Decisions locked in:

| | |
|---|---|
| Model | Real-time. Units fight the moment they arrive, based on march time. |
| Map | Historical 1914 Europe, territories drawn as real countries |
| Nodes | **Stations at real city locations**, mix per country loosely tracking real size and density |
| Station types | **Holding · Multiplier · Producer · Defensive** |
| Population | **Not a resource** — it *is* the unit count sitting in a station |
| Unit spawning | **Automatic** — control the station, units accumulate |
| Stations | Fixed by the map, never built |
| Combat | Overwhelming force wins decisively — mass and quality compound |
| Diplomacy | **Negotiation cut.** Emergent balance-of-power only. |
| Opponents | 3–5 AI powers |
| Victory | Total conquest |

**Nothing gets written until you've read this and pushed back.**

---

## 1. The core loop

Every station you hold slowly fills with units on its own. Units sitting in a station are simultaneously its **population, its growth engine, and its garrison** — there is no distinction. You drag from one station to another to send a proportion of what's there.

That single fact is the entire tension:

> **Units left at home multiply. Units sent away don't.**
> Every attack sets back the thing that made the attack possible.

No posting UI, no worker assignment, no labor sliders — the tradeoff is expressed purely through where your units physically are. This is what the old "posting" system was reaching for, achieved with none of the machinery.

Time runs continuously: pause, 1x, 2x, 4x. Orders can be issued while paused.

---

## 2. Stations

A station is a node at a real city's position. It has a **type**, a **capacity**, a **garrison** (counts per unit type), and links to other stations.

Growth is logistic — fast when a station is half full, slowing as it approaches capacity:

```
growth = rate × units × room(units)
```

Which produces the Virus Wars feel exactly: an emptied station recovers slowly, a full one has stopped paying dividends. **Full stations should be spent.**

### Capacity is where growth gets slow, not where it stops

`room` was the bare logistic term `(1 − units / capacity)`, which is exactly **zero** at capacity. That made a full city dead ground — the single best thing you owned contributed nothing until you gambled it, and a defensive power could hold a full board and watch its economy stop. On the player's instruction (2026-07): *"rather than making production stop when a city is full, just slow the production speed by 50% until the city has capacity again"*, and, asked where the surplus goes, **over capacity, up to a hard ceiling**.

So `room` now has a **floor** and a **tail**:

```
room = max(1 − units/capacity, FLOOR)                       below capacity
room = FLOOR × (1 − (units − cap) / (ceil − cap))           above it, to zero at the ceiling
```

with `FLOOR = 0.25 × GROWTH_OVERFLOW_RATE` and `ceil = capacity × GROWTH_OVERFLOW_CEIL` (0.5 and 1.5 as shipped). Growth falls as a city fills, **stops falling at the floor**, holds that rate across the capacity line, and only then tapers away — reaching zero at the hard ceiling, which is therefore the highest number growth alone can ever produce. Above the ceiling (reachable only by reinforcement) `OVERSTACK_DECAY` bleeds back down *toward the ceiling*, not toward capacity.

Three things about that shape are load-bearing:

- **The 0.25 is derived, not tuned.** The peak of `units × (1 − units/cap)` is `cap/4`, at half full, so at `units = cap` the same growth needs `room = RATE/4`. That is what makes "50%" mean *50% of this station's own best rate* — the only reading a player can check against the number on the rail.
- **It is monotonic the whole way.** There is no point at which filling a city further makes it grow *faster*, which a naive "half rate once full" rule does produce: at capacity it would be twice the half-full rate, exactly inverting the logistic feel.
- **`RATE 0` with `CEIL 1` is an exact off switch**, reproducing the pre-2026-07 sim, which is how the change was proved not to have perturbed anything else.

Deliberately accepted: capacity now reads as *"where it gets slow"* rather than *"where it stops"*, and the biggest stack on the board can get bigger. Two consequences elsewhere in the codebase follow from that and are not optional — the AI sizes a staging march against the defender it will **meet** (a garrison below the ceiling grows for the whole of a thousand-tick march, so measuring the present under-orders every march), and the supply-line phase reads the **ceiling** as a destination's headroom, since a destination past 99.5% of capacity is now routine rather than exceptional.

### The four types

| Type | Examples | What it does |
|---|---|---|
| **Holding** — city, town | Most of the map | Pure population growth. Units accumulate up to capacity. Bigger city = higher rate and higher cap. |
| **Multiplier** — farmland, granary | Ukraine, Po Valley, Prussia, the Beauce | Generates little itself, but **raises growth at every station in its territory and in adjacent territories.** Undefended, high-value, and its effect is visible on the map. |
| **Producer** — factory, arsenal, works | Ruhr, Birmingham, Lombardy, Donbas | Accumulates a **specific unit type** instead of generic infantry — artillery, armour. Lower raw numbers, far better units. |
| **Defensive** — fortress, citadel | Verdun, Przemyśl, Alpine forts, the Dardanelles | Low growth, large defense multiplier. Cheap to hold, expensive to take, gates a chokepoint. |

**Multiplier stations are the most interesting objects on the board.** They're worth almost nothing to garrison and enormous to own, their benefit spills across borders, and taking one hurts your enemy everywhere at once rather than locally. That asymmetry is where the strategy lives.

### Density is the national character

Station mix per country loosely tracks real 1914 size, urbanisation and industry:

| Power | Station profile | Plays like |
|---|---|---|
| **Germany** | Dense; several producers (Ruhr, Saxony, Silesia) | Best units, compact, encircled — must win fast |
| **Russia** | Sparse holdings over enormous area, big farm multipliers, few producers | Endless cheap numbers, slow to move, hard to digest |
| **Britain** | Compact, industrial, behind a sea crossing | Safe and rich, must project power to matter |
| **France** | Balanced, strong fortress belt | Defensive anchor that counterpunches |
| **Austria-Hungary** | Scattered, mixed, poorly connected | Fragile, awkward interior lines |
| **Italy** | Producer north, empty south, Alpine forts | Hard to invade, hard to expand from |
| **Ottoman** | Very sparse, defensive chokepoints | Nearly untakeable, painfully slow |

**No national trait stats are needed.** The differences fall out of the map — which is far better, because you can *see* why Germany is strong instead of reading it in a tooltip.

---

## 3. Territories

**A territory is a real country.** Geometry comes from Natural Earth 1:50m via `tools/build-map.js`, not from hand-authored shapes — an earlier attempt to draw 1914 provinces by hand produced a map that did not read as Europe. Thirty countries, real borders, generated.

Because the source is TopoJSON, adjacent countries share arcs, so borders are gap-free and `neighbors` is exact rather than asserted. The hand-authored vertex-seam machinery that used to guarantee this is gone.

**The 1914 setting lives in the scenario, not the shapes.** Modern outlines carry the period through *who owns what*, which is also what makes the map legible — you recognise the countries.

Countries are still drawn, still coloured by controller, still the thing you're conquering — they're what makes this read as a world-conquest game rather than an abstract node graph.

### Control is a majority, and it comes in tiers

**A country belongs to whoever holds more than half its stations.** Not all of them.

| tier | condition | benefits |
|---|---|---|
| **Full** | you hold every station | full |
| **Majority** | you hold more than half | reduced (`BAL.CONTROL.MAJORITY`, currently ½) |
| **Contested** | nobody holds more than half | none, to anyone |

So taking one city in a country is a **foothold, not a conquest** — you get a garrison and a staging point, and nothing country-wide. And flipping a country doesn't require mopping up every last station: the final holdout is a nuisance rather than a veto.

The middle tier is doing real work. Without it, one stubborn fortress in a corner of France denies the entire country to an occupier holding eight cities of nine — which reads as absurd, and makes large countries effectively unflippable. It also means **contested is a real state with a cost**: while a country is split down the middle, its farms feed nobody, so a stalemate is expensive for both sides rather than merely slow.

Control is **derived, never stored** — computed on read from who holds what. Storing it would mean two sources of truth that drift.

Rendering follows the tiers: full control is a solid tint, majority a lighter wash, contested hatched.

Their remaining mechanical role is deliberately thin:

- **Multiplier effects scope to territories** — a farm boosts its own territory and adjacent ones, so borders matter — and they are **scaled by the control tier**, so a country you only half-hold only half-feeds you.
- **Terrain scopes to territories** — mountains, forest and rivers slow marches and boost defense on links crossing them. Terrain is geography, so it applies regardless of who controls the country.
- **Victory is counted in territories** at majority or better, not stations.

Between stations there are **links** — roads within a territory, border crossings between them, and a handful of **sea crossings** (Dover, the Baltic, Skagerrak, Adriatic, Gibraltar, Aegean) that are simply slow and punishing rather than a naval system.

---

## 4. Units

Three types, each from a different station type. Kept few so a stack reads at a glance.

| Type | Source | Character |
|---|---|---|
| **Infantry** | Holding stations | The baseline. Balanced, good defending, arrives in volume. |
| **Artillery** | Producer stations | **Strips fortress and terrain defense.** Strong attacking, weak if caught alone, slow. The answer to a defensive station. |
| **Armour** | Producer stations | Fast, strong in the open, poor against fortifications. Takes ground quickly and cuts links. |

Soft triangle: **Artillery** beats entrenched Infantry → **Armour** beats exposed Artillery → **Infantry** beats Armour.

This is what makes producer stations worth fighting for: without artillery you cannot crack a fortress belt, and only a handful of places on the map make artillery.

---

## 5. Combat — overwhelming force

Continuous attrition, resolved every sim tick at any station holding hostile forces.

Each side's **Power** = Σ `count × type strength × matchup × station defense × terrain × connection state`.

**Losses scale with the square of the strength ratio** — casualties per tick are proportional to the *enemy's* Power, so a bigger, better force doesn't just win, it wins nearly intact:

| Attacker : Defender | Attacker survives roughly |
|---|---|
| 1.2 : 1 | ~55% — bloody, close |
| 2 : 1 | ~87% |
| 3 : 1 | ~94% — a formality |

This is what you asked for: committing overwhelming force is decisively better than trickling. Decisive battles resolve in seconds; genuinely even ones grind and become reinforcement races.

**Variance is rolled per battle, not per tick.** A ±10% band applied every 100ms is mathematically meaningless — 300 independent rolls average out to ~0.6% of variation. So: one modifier rolled at engagement start, plus a slow wobble every few seconds so momentum swings are visible. Station defense, terrain and matchup carry the real spread.

**Station defense is additive, not multiplicative** — otherwise attacking is never worth it and the map freezes.

A station flips the instant one side has nothing left in it. Multiplier stations, being barely garrisoned, flip fast — as they should.

### Keeping the snowball honest

Square-law combat snowballs. With negotiated diplomacy cut, three systems carry that load:

1. **Connection.** A station with no path back to your capital stops growing and decays. Cutting links is as powerful as taking cities, and armour is built to do it.
2. **Balance-of-power AI** (§6). Every AI weights threat toward whoever leads. They converge on the leader without a single line of negotiation UI.
3. **Growth is logistic, not linear.** A big empire's stations are mostly near capacity and therefore mostly *not growing*. Expansion has diminishing returns built into the curve.

If that proves insufficient in playtesting, the next lever is making freshly taken stations slow to recover.

---

## 6. The powers — balance of power without diplomacy

### Starting position — one country each

**Every power begins holding exactly one territory: its homeland. Everything else on the map starts neutral.**

| power | homeland | capital |
|---|---|---|
| German Empire | Germany | Berlin |
| French Republic | France | Paris |
| British Empire | United Kingdom | London |
| Russian Empire | Russia | Moscow |
| Austria-Hungary | Austria | Vienna |
| Kingdom of Italy | Italy | Rome |
| Ottoman Empire | Turkey | Constantinople |

So the powers are *named* for their 1914 empires but do not begin with them — Austria-Hungary starts as Austria alone and has to take Hungary, Bohemia and Croatia like anyone else. **Expansion is the entire game rather than a starting position to defend.**

Three consequences worth stating, because they shape everything downstream:

- **The neutral map is the real opponent early.** Most of Europe is unclaimed, so the opening is a land grab against garrisons rather than a war between powers. Powers meet each other only once they have grown into contact — which is exactly when the balance-of-power relations below start to matter.
- **Geography is destiny at the start.** Germany opens surrounded by soft neutrals and hard powers; Britain opens behind water and must spend on a sea crossing before it can take anything; Russia opens enormous and nearly alone. No national trait stats are needed to produce this.
- **It rewrites the snowball problem.** A power that takes its neighbours early compounds fastest, so the `§5` brakes — connection, logistic growth, and hostility toward the leader — carry more weight than they would from historical starting extents.

### Relations

You were right that negotiation doesn't fit. There is no inbox, no proposal, no deal, no trust score. Powers are simply at war or not, and **relations move on their own**, driven by:

- shared borders and where forces are massed
- recent aggression (who hit whom)
- **relative standing** — a heavy term pushing everyone toward hostility with the leader

The effect is the historical Concert of Europe as an emergent property rather than a menu: run away with the game and the board turns on you. You influence it by *acting* — where you mass, who you hit, what you leave undefended — not by talking.

AI personalities (**Expansionist / Turtle / Opportunist**) weight those terms differently, layered on top of the very different national maps.

Guardrails, because real-time AI defaults to statue or hydra:

- **Action budget** — at most one order every few seconds per power. It cannot out-click you.
- **Think in fronts** — pick one target station and a commitment budget, not per-stack micromanagement.
- Every decision logged with its utility score. A passive AI is otherwise undebuggable.

---

## 7. Victory

**Total conquest**, made bearable by capitulation:

> A power that loses its capital *and* falls below ~25% of its starting territory **capitulates** — all remaining stations transfer to whoever holds its capital.

Preserves the conquer-everything fantasy, removes the tedious last-20% mop-up.

---

## 8. Interaction

The whole game is played by selecting nodes and clicking targets. There is no other verb.

### Visual language, from the Virus Wars reference

Read directly off your screenshot (`docs/reference/virus-wars.png`), and worth copying wholesale:

- **The number is the interface.** Each node's garrison is rendered large and centred, high contrast, readable at a glance across the whole board. Everything else is secondary.
- **Selection is a marker above the node** — a small caret. Cheap to render, unambiguous, works on many nodes at once. Adopting this over highlight rings.
- **Node shape encodes type.** The reference distinguishes spiky from smooth outlines; our four station types get four silhouettes rather than four colours, since colour is already carrying ownership.
- **Colour carries ownership only.** Two saturated player colours plus grey neutrals. This is why type must be shape.
- **Modifiers are labelled in place** — the reference literally floats *"x2 Reproduction"* next to a node. Multiplier stations (§2) get the same treatment rather than being buried in a panel.
- **Transit lines are drawn between nodes**, thick and white, above the background. These are *in-flight trails*, not standing supply — they exist while a wave is travelling and vanish when it lands.

### Many-to-one attacks — the primary command

The core offensive gesture is **select several of your stations, then click one enemy or neutral station** — every selected station sends simultaneously at that single target. This is how you assemble overwhelming force (§5) out of a scattered empire without micromanaging each stack.

- **Selecting sources** — drag a marquee across your own stations, shift-click to add or remove, double-click a territory to select all its stations. `Ctrl+A` selects everything you own.
- **Committing** — one click on the target. Every selected source sends its proportion at once, and selection clears. `⌘`-click commits and *keeps* the group, so one massed force can be thrown at several targets without reselecting.
- **Proportion** — each source sends a share of the units currently sitting in it. A 25 / 50 / 75 / All setting applies to the whole volley, chosen with `1 2 3 4`, and it is **one-shot**: it relaxes back to 25% after every volley, so a big commitment is always a deliberate one and can never be left switched on by accident. The default is a tuning constant (`BAL.SEND_FRACTION_DEFAULT`).

  *Revised 2026-07 on the player's instruction.* It was a persistent 75% overridden at the click by `⇧` (all) and `⌥` (half). Both modifiers are gone: the digits do the same job with one hand and no timing, and `⇧` was already additive-select on the same pointer. `⌘` survives, because keeping the group is not an amount.

- **All never means all.** `4` leaves `BAL.SEND_KEEP_UNITS` behind — one unit. Growth is `rate × units × (1 − units/capacity)`, which is *proportional to units*, so a station emptied to exactly zero is dead ground forever and can only be repopulated by marching men back into it. Leaving one turns that into a slow recovery: a Berlin stripped to 1 climbs back past 38 over a thousand ticks. Nothing else in the game depends on the difference between 0 and 1, so this costs nothing and removes a trap the player cannot see coming.
- Selected stations and the target are joined by preview lines while you hover, carrying **both an ETA and the payload** (`54 inf`, `1.5 inf · 11 art`), so a volley is legible *before* you commit it.
- **One-shot.** An *attack* fires a single wave and is done — nothing to cancel. Every attack is a deliberate decision about what to spend right now.

> **Amendment (Milestone 5.6): logistics can be automated; commitment cannot.**
>
> This section originally said there are no standing supply lines and the board never plays itself. That is now true of *attacks only*. A city carries **supply lines**: a list of the cities it streams its surplus to. Select sources, press `R`, click a destination and the line is drawn to all of them; press `R` and click the same city again and it is gone. `H` clears the lines on the selection. There is no order *type* — a city either supplies somewhere or it does not.
>
> Every sweep (25 ticks) a source ships a small share of its surplus above a keep floor, **split evenly** across the destinations that still have room. A destination at capacity is skipped and its share goes to the others.
>
> The line the amendment does not cross: **a standing wave never attacks and never fights.** It may only move between stations its owner already holds, and a stream whose destination flips mid-transit *stands down* at the last held city on its path rather than arriving into a battle. Automating a trickle into a contested city would be committing defeat in detail (§5, §8) on the player's behalf — the exact mistake this game is built to punish. So the automation carries units to the front and stops there; what to spend, and when, stays a decision.
>
> **Nothing here is inferred.** This is the amendment's second rule and it is what the design cost two rewrites to learn. The first version had the player label the two *ends* — Rally and Feed — and let the sim match them up by nearest-seed search; the second replaced that with a named destination but added a **Defend** order that fired only when the sim judged the target "threatened". Both put a decision inside the sim that was nowhere on the board, and a decision the player cannot see is one they cannot tell is wrong. A list of stated destinations has nothing left to guess, and — the thing one target per source made impossible — it lets one city supply several.
>
> **Defend was cut and not replaced, because the capacity ceiling already is the trigger.** A quiet front is full, so it takes nothing and the cities behind it bank their surplus at home; a front that is losing units has headroom and pulls. That is the same behaviour, expressed as a fact about the board rather than as a judgement made off screen.
>
> Two consequences worth stating. Supply lines **do not survive a capture**, since a captured source would drain the front its new owner just paid for, and an edge whose *destination* changes hands is dropped on the next sweep — an order pointing at a city the enemy now holds must never become a way to send troops at the enemy. And a source dropping off the logistic ceiling starts growing again — §2's "full stations should be spent" falling out of the mechanic for free.

**Stacks arrive staggered, not synchronised.** Each travels at its own speed and fights on arrival. Combined with square-law combat (§5), this makes *defeat in detail* the defining mistake of the game: throw five distant cities at one target and they'll be destroyed one at a time, while five nearby cities landing together will overwhelm it. Massing near a front before committing becomes the central skill, and distance genuinely matters rather than being flavour.

The preview lines carry ETAs, so the spread in a volley is visible before you commit — the information needed to avoid the mistake is on screen, but the discipline is yours.

Single-station orders are the same gesture with one source selected, and **drag station → station** remains as a shortcut for that case.

### Everything else

- Multi-hop is allowed — target a distant station and stacks route along links.
- **Units in transit are visible** as markers moving along links, strength and ETA legible at a glance.
- **Click a station** for a small readout: type, garrison by unit type, capacity, growth rate and what's modifying it — plus the two numbers a fight is decided by, defending power and what the same troops are worth attacking out.
- Multiplier coverage is **shown on the map** — hold a farm and see the territories it's boosting light up.

> **Amendment (rail rewrite): the readout is not a second copy of the map.**
>
> That bullet grew into a 284px column of ~35 rows of labelled text — a five-row growth breakdown, four farm rows, an eight-row strength block, a six-row march block. Every number in it was true. Most of them did not change a decision, and several were a thing already *drawn* rendered again as words: the logistic term is the capacity bar, the base rate is the station's type, farm coverage is the overlay two bullets down, the control tier is the territory's own tint.
>
> The rail is now **200px and icon-led**, which is not a cosmetic change — the player's window is 800px, so it hands the board back 84px it should never have taken. The rule that shrank it: **a row earns its place by changing what the player is about to do.** Everything else belongs on the map, where it is seen rather than read.
>
> Two invariants survive the cut, both bought with real bugs and neither negotiable:
>
> - **Station defense is additive and must never be drawn as a multiplier.** It is flat power added to the defence (`DEFENSE_BONUS_POWER`), so it is written `+12.0 power` with its working in `lvl`, never `×3.2`. A `×` anywhere in that block is a lie about the one number an assault turns on.
> - **A readout answers the question on screen, or it says nothing.** Any predicted quantity comes from the function that makes the decision — never from a parallel calculation that happens to agree today (`docs/testing/known-issues.md` #18).

```
┌──────────────────────────────────────────────────────────┐
│  Territories 14/48   Forces 312   ⏸ 1x 2x 4x   │ Day 42  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│      1914 Europe — territories tinted by controller      │
│      stations as nodes sized by capacity,                │
│      shaped by type (◉ city  ▲ fort  ■ factory  ✦ farm)  │
│      transit trails while waves are in flight            │
│                                                          │
│      marquee-select your nodes → click one target        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  send: 25 · 50 · [75] · All     powers + event ticker    │
└──────────────────────────────────────────────────────────┘
```

Deliberately **not** present: build queue, resource bar, posting sliders, production menu, diplomacy inbox. All cut.

### Choosing a power — the one screen before the board

The game opens on an empire picker (`render/start.js`), because which power you are is the single largest decision in a match and it used to be a query string. **The map is the picker**: the seven homelands are painted in their colours on the real board, everything else is washed back, and clicking a country chooses it — clicking it a second time starts the game. A panel beside the board carries the same seven as cards, each with the §2 character line ("must win fast", "hard to digest") and the numbers that produce it — opening garrison, homeland stations, producers — read out of `data/` rather than typed. Hovering either side lights the other.

Two properties are load-bearing rather than cosmetic. The panel is a **flex sibling of the board, not an overlay**, for the same reason the rail is (§8's whole gesture dies silently under a layer that accepts pointer events), and it is **removed from the document** on confirm rather than faded. And the pick happens **before `GAME.human` is set** — the board is drawn but nothing is wired, so "not playable yet" is the absence of listeners rather than a shield over them. `?player=fra` skips the screen, which is what that parameter is now for.

---

## 9. Technical approach

Matching your two existing prototypes exactly: **zero-build vanilla JS**, plain `<script src>` tags in order, shared globals, served by `python3 -m http.server`. No npm, no bundler, no framework, no CDN. `:root` custom-property palette, flat lowercase-hyphen class names, one fixed dark theme.

**State is aggregate counts.** A station holds `{infantry, artillery, armour}` as floats — 100ms attrition rounds to zero otherwise, floored only at render. Marching stacks are separate records, since in-transit position is the only thing with real identity. The whole game state prints as one console table.

**Fixed-timestep accumulator**, rAF only for render. Speed multiplies *time consumed*, never the timestep — 4x is literally "run more ticks", physics identical at every speed. Catch-up capped to avoid a death spiral.

**Deterministic.** Seeded PRNG with its state inside the game state; `Math.random` and `Date.now` banned below the sim layer. Fixed sorted iteration order. All player *and* AI input funnels through one `applyCommand(state, cmd)` — which makes headless testing and replay free.

**Map data.** Territories use a shared vertex table (~90 vertices in a 1000×700 viewBox) so neighbours share the *same* vertices — zero gaps, and adjacency is derived from shared edges and asserted against the declared list. Stations are then placed at real city coordinates within them. Hand-authored; real GeoJSON is a trap at this territory count.

Nothing under `sim/` or `ai/` may touch `document`.

### Everything in one folder

The entire project — design docs, reference images, code, tests — lives under a single directory, `~/Downloads/concert-of-europe/`. Nothing scattered into Downloads itself, which is a personal-file dump. This document gets committed as `docs/design/00-vision.md` and is the living design spec from that point on; your Virus Wars reference image lands in `docs/reference/`. I'll `git init` it so design changes are traceable.

```
concert-of-europe/
  index.html          tests.html
  docs/design/00-vision.md      ← this document, the living spec
  docs/reference/               ← Virus Wars screenshots, notes
  data/map.js         VERTS, TERRITORIES (shape, terrain, neighbors)
  data/stations.js    stations (type, capacity, rate, position, links)
  data/scenario.js    powers, starting control
  data/tuning.js      BAL — every balance constant, AI personalities
  core/     rng.js  util.js  state.js
  sim/      commands.js  growth.js  movement.js  combat.js
            relations.js  victory.js  step.js
  ai/       ai.js
  render/   map.js  stations.js  hud.js  input.js  select.js
  app/      loop.js  main.js
  test/     asserts.js  scenarios.js  runner.js
```

---

## 10. Build order — fan-out and preview gates

Every milestone ends in a **preview moment**: I run it in the browser, drive it myself, and show you a screenshot or a live URL before continuing. You react, I adjust. Milestones are sequential; the work inside each fans out across parallel subagents, since the file layout is designed so the seams don't collide.

| # | Milestone | Parallel workstreams | Preview moment |
|---|---|---|---|
| 0 | **Design doc** | — | This document into `docs/design/00-vision.md` |
| 1 | **Map + stations** | (a) territory vertex table + shapes · (b) terrain + adjacency · (c) station placement, types, capacities · (d) links + sea crossings | **Screenshot of the board** — 1914 Europe tinted by power, stations shaped by type, links drawn. The first thing you can look at and react to. |
| 2 | **Sim core, headless** | (a) logistic growth + multipliers · (b) movement + routing · (c) combat · (d) connection decay + capitulation | **Balance readout** — hundreds of simulated games, win-rate spread and mean length in a table |
| 3 | **Play** | (a) **multi-select + many-to-one commit** · (b) stacks in transit · (c) live garrison badges + tinting · (d) time controls | **Playable.** Live URL — you marquee-select cities and throw them at a target. |
| 4 | **AI powers** | (a) balance-of-power relations · (b) target selection + fronts · (c) personalities · (d) decision logging | **First real game.** Screenshots of a full match plus the AI decision log. |
| 5 | **Readability** | Multiplier coverage overlay, station readout, event ticker, victory screen | **Live URL** — the complete loop |
| 6 | **Balance pass** | Monte Carlo sweeps across tuning constants | **Before/after balance tables** |

I stop at every gate rather than running end to end.

---

## 11. Verification

**Headless balance harness.** `tests.html` loads the same scripts plus a runner, executes assertion scenarios and Monte Carlo batches (hundreds of games, no rendering), printing to a `<pre>` I read directly through browser tools. Three numbers are the dashboard: **win-rate spread across the seven powers, mean game length, mean time-to-first-station-flip.**

**Assertion scenarios** — logistic growth stalls at capacity; a farm's multiplier reaches adjacent territories and stops there; a disconnected station decays; capitulation transfers everything; a 2:1 attacker wins keeping ~87%, a 1.05:1 attacker does not; derived territory adjacency matches the declared list; every station is reachable from its owner's capital at game start.

**Live play.** A `.claude/launch.json` entry on an unused port, driven through browser tools — I click, drag, read the DOM and screenshot rather than asking you to check things.

**Known environment gotcha** (hit on the 0 A.D. prototype): files written into `~/Downloads` pick up a `com.apple.macl` ACL the preview server can't read, giving silent 404s that look like code bugs. If it resurfaces the fix is serving a mirrored copy from the session scratchpad — not debugging the app.

---

## 12. Open questions — for you, not for me

1. **Era strictness.** You mentioned tanks, which barely existed in 1914. I've written it as a Great War that went differently — real 1914 borders and cities, a slightly loose unit roster. Say the word if you'd rather it snap to strict historicity (cavalry instead of armour) or drift later (1930s).
2. **Station count.** I'd aim for **~90–110 stations across ~45 territories** — dense enough that Germany feels industrial and Russia feels empty, sparse enough to read at screen size. This is the number most likely to need adjusting after you see Milestone 1.
3. **Territory control threshold.** Currently all-or-nothing: hold every station to control the territory. A majority rule would make the map flip faster and feel less grindy. Easy to try both.
4. **Multiplier reach.** Farms boosting adjacent territories is the most novel mechanic here and the one I'm least sure of — it may prove too strong or too invisible. Flagged as the first thing to examine in playtesting.
5. **Fog of war.** Off for v1. Interesting later, but it makes AI behaviour much harder to debug.
