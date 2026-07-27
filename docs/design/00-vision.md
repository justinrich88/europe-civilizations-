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

Growth is logistic — fast when a station is half full, stalling as it approaches capacity:

```
growth = rate × units × (1 − units / capacity)
```

Which produces the Virus Wars feel exactly: an emptied station recovers slowly, a full one is a fortress of numbers that has stopped paying dividends. **Full stations should be spent.**

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

Countries and provinces are still drawn, still coloured by controller, still the thing you're conquering — they're what makes this read as a world-conquest game rather than an abstract node graph.

Their mechanical role is deliberately thin:

- **Control is derived** — you control a territory when you hold every station in it. Contested territories render hatched.
- **Multiplier effects scope to territories** — a farm boosts its own territory and adjacent ones, so borders matter.
- **Terrain scopes to territories** — mountains, forest and rivers slow marches and boost defense on links crossing them.
- **Victory is counted in territories**, not stations.

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
- **Committing** — one click on the target. Every selected source sends its proportion at once, and selection clears.
- **Proportion** — each source sends a share of the units currently sitting in it. A persistent 25 / 50 / 75 / All setting applies to the whole volley; default 75%, and it's a tuning constant. Set once, not per attack.
- Selected stations and the target are joined by preview lines while you hover, so a volley is legible *before* you commit it.
- **One-shot.** A command fires a single wave and is done — no standing supply lines, nothing to cancel. Every attack is a deliberate decision about what to spend right now, and the board never plays itself.

**Stacks arrive staggered, not synchronised.** Each travels at its own speed and fights on arrival. Combined with square-law combat (§5), this makes *defeat in detail* the defining mistake of the game: throw five distant cities at one target and they'll be destroyed one at a time, while five nearby cities landing together will overwhelm it. Massing near a front before committing becomes the central skill, and distance genuinely matters rather than being flavour.

The preview lines carry ETAs, so the spread in a volley is visible before you commit — the information needed to avoid the mistake is on screen, but the discipline is yours.

Single-station orders are the same gesture with one source selected, and **drag station → station** remains as a shortcut for that case.

### Everything else

- Multi-hop is allowed — target a distant station and stacks route along links.
- **Units in transit are visible** as markers moving along links, strength and ETA legible at a glance.
- **Click a station** for a small readout: type, garrison by unit type, capacity, growth rate and what's modifying it.
- Multiplier coverage is **shown on the map** — hold a farm and see the territories it's boosting light up.

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
