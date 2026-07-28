# Round nine — movement, passage, and attrition

*Why the map is a border grind, and the one rule that fixes it.*

`00-vision.md` stays the locked spec. What is accepted here folds back into §3
and §5.

---

## 1. The finding

Measured on the opening board, German Empire:

```
stations ger can SEE:   7
stations ger can REACH: 7
```

The same seven. Nothing further is routable at all — **0 of 6** targets at two
hops, **0 of 6** at three, **0 of 6** at four.

The cause is `_moveCanTraverse` (`sim/movement.js`): a wave may only pass
through ground its owner holds. So every attack lands **exactly one hop past
your own border**, and everything one hop past your border is already lit at
level 2 because every station has `vision >= 1`.

Three consequences, all of which have been mistaken for other problems:

- **`00-vision.md` §8's "Multi-hop is allowed — target a distant station and
  stacks route along links" is false** for anything past your own territory.
  It is true only *inside* your own borders.
- **The AI has no strategic horizon, and this is why.** It was diagnosed as an
  AI limitation (`01-data-schema.md`, `ctx.hops` never exceeds 1). It is not.
  No horizon is possible when nothing beyond one hop can be attacked.
- **Fog is nearly inert as a decision constraint.** You can only attack what
  you can see and you can see everything you can attack. Fog still changes what
  you know about the *wider war*, which is real and worth having, but it never
  changes what you can *do*.

And it explains the balance table. Opening neighbours against wins over 48
games: Russia 3 / 33, France 4 / 9, Ottoman 5 / 0, Austria 6 / 2, Britain 6 / 2,
Italy 6 / 1, Germany 6 / **0**. Correlation **r = −0.88**. If you can only
nibble at your own border, then more borders means more ways to split your
force — which is *defeat in detail*, the mistake `00-vision.md` §8 names as the
defining one of the game. The win table has been measuring which power has the
fewest chances to make it.

---

## 2. The rule

> **A wave may pass through any station. Passage costs strength, and it does
> not capture, engage, or stop.**

The mental model is **fleeing a battle**: you take damage getting out, far less
than standing and fighting. Passing an enemy city is not an assault on it — you
are marching past under fire.

Two independent costs, and the separation matters:

| | what it models | scales with |
|---|---|---|
| **Passage toll** | running the gauntlet past a hostile garrison | *whose* ground, and how strongly held |
| **March attrition** | supply lines, stragglers, exhaustion | *time in transit* |

### Passage toll

Charged once, on entering a station the wave does not own, and never on your
own ground.

| ground | toll |
|---|---|
| your own | **none** |
| **neutral** | light |
| **enemy** | heavier |
| **allied** *(future)* | **none** — see §6 |

**Scaled by the station's full DEFENSIVE POWER — garrison, terrain,
`defensive` station type, and fortification tier — not by the raw unit count
and not by a flat rate.** An empty neutral village is a road. A fortified
enemy citadel is a wall you would rather walk around.

Use the canonical `stationPower(state, sid, 'defender')`. Do **not** derive a
second toll formula from unit counts: `docs/testing/known-issues.md` #9 is
"two implementations of one derivation rule" and this project has logged it
four times, twice inside the combat maths specifically. One power function,
two callers — the battle and the toll.

> **Fortification therefore taxes armies that go PAST a city, not only ones
> that attack it.** *Decided 2026-07.*
>
> This is the most valuable consequence of the whole rule, because it changes
> what fortification *is*. `04-development.md` §7 flagged the risk that
> fortification — available at all 108 stations, against a factory counter
> available at 16 — would freeze the board into a stalemate. Interdiction is
> the answer: **a fortress that projects outward is not a turtle.**
>
> Walls stop being a way to avoid the game and become a way to shape where the
> enemy can afford to walk. A fortress belt does not have to be *taken*, and it
> does not have to be *impregnable* — it has to be expensive to ignore. That is
> the actual historical role of Verdun, Przemyśl and the Dardanelles, and it is
> the one §2 promised those stations would play.
>
> It also gives the player a genuine choice the current game cannot express:
> pay the toll and go around, or pay the battle and go through.

### March attrition

**A wave loses strength for every tick it is in transit.**

This is the historical case cited: the German marches into Russia in both wars
were not lost to battles at the far end, they were lost to the front outrunning
what could sustain it.

**Flat per tick, not fractional — and this is the load-bearing choice.**

- **Fractional** (`units × e^(−λt)`) costs every stack the *same percentage*.
  A 10-unit raid and a 200-unit army both lose 8% on the same march, so mass
  buys nothing and distance is free to anyone.
- **Flat** (`units −= rate` per tick) costs every stack the *same absolute
  amount*. The 10-unit raid dies; the 200-unit army arrives at 95%.

Flat produces the wanted rule: **reach is bought with mass.** Deep strikes are
for armies, not raiding parties, and a long march is a commitment you can see
the size of before you make it. It also gives §5's "overwhelming force"
principle a geographic dimension it currently lacks.

A wave reduced to zero in transit is **destroyed en route** and logged as such.
That is a real and legible failure — you overreached — and it must appear in
the ticker, not vanish silently.

---

## 3. What this deletes

**The sea stops being a special system.** Sea crossings are currently three
separate mechanisms: `SEA_SPEED_MUL 0.5`, a 1.6× inflation of `dist` baked into
the generated data, and a distinct sea toll applied at beachhead landings.

Under per-tick attrition, **a sea crossing is simply a slow link**. It already
takes 3.2× as long as a land link of the same on-screen length (5.3× with
artillery) — so it already costs 3.2× the attrition, automatically, with no sea
rule at all. The punishment emerges from the speed multiplier that already
exists.

That is one general rule replacing three specific ones, and it is the direction
this design has gone every time it has improved. Beachhead echelons stay: those
are about *arrival*, not cost, and they are the reason amphibious assault feels
different.

---

## 4. What this fixes

- **Multi-hop becomes true**, as §8 always claimed it was.
- **The AI gets a horizon it can actually use.** `TARGET_MAX_HOPS` and
  `SOURCE_MAX_HOPS` stop being dead config. The AI must then learn to *choose*
  among reachable targets rather than taking whatever it borders — which is
  the fix for defeat in detail, and it is real work.
- **Fog becomes load-bearing.** Once you can march somewhere you cannot see,
  the remembered garrison is a bet rather than a curiosity, and `visibleTo`'s
  level 1 finally does the job it was built for. **Wave vision (§5) then also
  becomes worth building** — it is worthless today, because armies never go
  anywhere already dark.
- **Encirclement becomes possible.** Bypassing a fortress to cut the ground
  behind it is currently impossible; connection decay already exists to reward
  it and has never been reachable as a deliberate tactic.

---

## 5. Wave vision — build it *after*, not before

> *"When your army approaches a station it should remove the fog."*

Correct, and currently a no-op: `core/vision.js` never mentions waves, and
adding it would change nothing, because every station a wave passes through is
one the owner already sees. Verified — see §1.

Once passage exists, the rule is: **a wave grants level 2 to both endpoints of
the hop it is currently on.** Your army is on that road; it can see both ends.
Symmetric for the AI, without exception.

The emergent behaviour is **scouting**, which becomes possible for the first
time: send a small force down a road to see what is there, at the cost of the
force. That is a real strategic action, using the existing verb, with no new
machinery — and it is exactly what flat march attrition prices correctly, since
a scout is cheap to send and unlikely to come home.

*"Anything tied by a direct path if you own the tied station"* is **already the
behaviour** and needs no change: measured, Berlin has six links and exactly
seven stations sit at level 2 — itself and all six neighbours.

---

## 6. Allies

Noted for a future version: with explicit teams, passage through an ally's
ground costs **nothing** — it is your own ground for movement purposes.

This is cheap to build *if the toll is written as a function of the relationship
between the wave's owner and the station's owner* rather than as an
`owner === pid` test. **Write it that way now**, with `own` and `hostile` as
the only two cases that exist yet. Retrofitting a relationship check into a
boolean is the more expensive order.

Note the interaction with `00-vision.md` §6: relations already move on their
own and powers are already at war or not. "Ally" is not a new system so much as
the far end of a scale that exists.

---

## 7. Risks

**This could deepen the grind instead of fixing it.** If tolls and attrition
are set high, nobody ever leaves their border and the game is exactly what it
is today, with more arithmetic. The tell is the **mean number of hops from
border to target** in AI decisions — if it stays at 1 after this ships, the
numbers are wrong, not the design. Instrument that before tuning anything.

**It could also invert into chaos.** If passage is cheap, front lines stop
meaning anything and the board becomes raids crossing through each other. The
counter is that the toll scales with garrison, so a real front is expensive to
cross — but that only holds if garrisons are large enough to matter, which
couples this directly to `04-development.md` and to the growth curve.

**It changes every balance constant.** Milestone 6 is already carrying the sea
graph, fog, the unit-type collapse and development. This is the fifth and the
largest. It strengthens rather than weakens the standing rule: **the balance
pass runs once, at the end.**

---

## 8. Open

1. **Does passage let you bypass a capital?** Encirclement says yes.
   Capitulation (§7) says a capital falling is decisive, and letting armies
   stream past one may make the endgame incoherent. Probably yes with a heavy
   toll, but it should be decided rather than discovered.
2. ~~Does a passing wave take fire from the garrison, or from full defensive
   power?~~ **Settled: full defensive power**, including fortification tier and
   terrain. See §2.
3. **Do standing orders / supply routes pay march attrition?** They should —
   sustaining a distant front is exactly the thing being modelled — but it may
   make long supply lines useless, which would be a regression. Needs
   measurement, not a decision.
4. **Numbers.** Every rate here is a shape. They belong in `data/tuning.js` and
   should be derived against the existing combat maths, not guessed.
