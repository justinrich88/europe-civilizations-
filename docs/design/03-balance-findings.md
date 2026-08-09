# Balance findings — what to fix, and what not to

Written at the close of Milestone 5.5, as the briefing for Milestone 6. Every
number here is measured, and the measurements are reproducible from the probes
named at the bottom.

**Read the first section before touching a single constant in `data/tuning.js`.**

> ## STOP — every win-rate number below this line is from a tree that had three unit types
>
> **C1 (2026-08) removed the matchup triangle, and it was load-bearing balance.**
> This document is written against a board where artillery beat entrenched
> infantry, armour beat exposed artillery, and infantry beat armour. None of
> that exists. 96 games either side, same rig, same seeds:
>
> | | before C1 | after C1 |
> |---|---|---|
> | dominant power | France 70.8% | **Austria-Hungary 76.0%** |
> | runner-up | Russia 6.3% | France 13.5% |
> | win-rate spread | 70.8 points | **76.0 points** |
> | mean game length | 25,445 ticks | 16,013 ticks |
>
> The board did not get more balanced — it **changed hands** and got 37% faster.
> Any finding here that names France as the problem is now a finding about a
> game that no longer exists, and the triangle turns out to have been what was
> holding Austria-Hungary down.
>
> **What survives unchanged is the METHOD**, and it is the reason this document
> exists: §0's three faults, the sample-size table, and the rule that 12-game
> batches resolve nothing. Re-measure before quoting a number; do not re-derive
> the method.
>
> Two structural changes also land here and are not tuned: nothing but mass
> cracks a fortress now (artillery was the counter), and a sea crossing costs
> 3.2x rather than 5.3x for a force that used to carry guns.

---

## 0. Every balance number produced before this document is void

Three separate faults meant the balance harness was not measuring what it said
it was measuring. All three are fixed; the point of recording them is that each
one produced *confident, plausible, wrong* numbers for weeks.

**(a) Victory was nearly unsatisfiable.** `victoryTick` required a single owner
across all 108 stations, neutrals included. Measured at the tick cap, seed 9:
Russia held 105 of 108, every rival was dead, and no victory fired — three
neutral villages had never been taken by anyone. Seed 7 was the same at 106.

**(b) The draw clause was unreachable.** `MAX_GAME_TICKS` sat *after* the
contested-check's early `return`, so games that could not be won also could not
be drawn. They simply ran to the harness cap.

**(c) `tools/balance.js` awards a capped game to whoever leads on territories.**
Combined with (a) and (b), **73% of every batch was a timeout leaderboard
wearing the word "win"**. A frozen board with one power on 106 stations scored
as a clean victory for that power.

Victory is now "outlast every rival" (`_vicSurvivingPowers`). Neutral holdouts
are exactly the tedious mop-up that capitulation exists to delete (00-vision.md
§7).

### And the sample size was far too small

12-game batches were the working unit. They cannot resolve anything:

| batch | measured win-rate spread |
|---|---|
| 12 games | 41.7, then 50.0 |
| 48 games | 31.3 |

**Removing a single sea link moved the 12-game spread by 17 points.** Use 48
games minimum. Treat any difference under ~15 points at n=48 as unresolved.

---

## 1. The deadlock, and why it was invisible

65% of games ended in a draw because **the AI stopped attacking on a contested
board**. Not slowly — frozen. Lifting the draw clause and running to 400,000
ticks, the board does not move at all after ~20,000:

```
seed 101:  t= 40,000 → 106 of 108 stations, 2 powers alive, 1 neutral
           t=400,000 → 106 of 108 stations, 2 powers alive, 1 neutral
```

Two independent causes, both now fixed:

**The ETA spread window, not `SOURCE_MAX_HOPS`.** France had 22 eligible
sources holding 653 units and kept 2 of them. Constantinople's only quick
approaches were 258–298 ticks away; every other route crossed the Aegean or
Black Sea at 1,500–3,600. The AI correctly dropped those as stragglers — a
stack arriving 1,500 ticks late is not reinforcement, it is a second army fed
in piecemeal. **The AI was playing correctly.** What it lacked was any way to
convert distance into presence: `hold` is inert, and a full station has stopped
paying dividends under logistic growth. Fixed by `kind: 'stage'`.

**The AI held itself to a war rule the player is not held to.** The check lived
only in `aiDecide`; `applyCommand` has none. On a partitioned board where
everything reachable belonged to a power at peace, the AI stood still forever
while a human in the same seat could attack freely. This accounted for 13 of
the 14 remaining draws.

> **The general lesson, worth more than either fix: a gate that lives in the AI
> and not in `applyCommand` is a rule the AI obeys and the player does not.**
> Any future rule of that shape belongs in the command layer or in both.

Result: draws **64.6% → 2.1%**, mean game length 30,877 → 20,063 ticks.

---

## 2. Where the imbalance actually is

With the draws gone, the imbalance they were hiding is measurable for the first
time. 48 games, seed 100:

```
Russia 28   France 11   Britain 5   Austria 3   Germany 0   Italy 0   Ottoman 0
win-rate spread 58.3 points
```

### The obvious explanation is wrong

Free land does not explain it, and is close to inverted. Assigning every
neutral station to whichever capital reaches it first by hops:

| power | uncontested neutral stations | capacity of that land | wins |
|---|---|---|---|
| Britain | **17** | 568 | 5 |
| Germany | 14 | 488 | **0** |
| Ottoman | 12 | 376 | **0** |
| Russia | 12 | 384 | **28** |
| Austria | 11 | 332 | 3 |
| Italy | 8 | 218 | **0** |
| France | **4** | 110 | 11 |

Britain has the most free ground and wins 5. France has the least and wins 11.
**Do not open Milestone 6 by redistributing neutral territory.**

### What does explain it: how many roads lead to your capital

| power | capital | links into capital | mean hops to rivals | wins |
|---|---|---|---|---|
| Russia | Moscow | **3** | 6.83 | **28** |
| France | Paris | 4 | 5.17 | 11 |
| Britain | London | 6 | 5.50 | 5 |
| Austria | Vienna | 6 | 4.33 | 3 |
| Germany | Berlin | 6 | 4.33 | 0 |
| Italy | Rome | 6 | 5.00 | 0 |
| Ottoman | Constantinople | 5 | 5.83 | 0 |

Capital link-degree is the strongest single predictor, and it is **a property
of the map, not of `data/tuning.js`**. It became decisive the moment the
opening changed to capital-only: your capital *is* your empire at turn zero, so
every link into it is simultaneously a direction you must garrison and a
direction an enemy can arrive from. Moscow, with three approaches, is a
fortress by accident of geography. Berlin, with six, is indefensible — which is
also why Germany fell from 2 wins to 0 when the opening changed.

Ottoman is the informative outlier: reasonably isolated (5.83) but the smallest
capital on the board (capacity 52, opening garrison 47) with the sparsest
homeland. Isolation without mass is not enough.

### Recommended order for Milestone 6

1. **Test the degree hypothesis directly** before tuning anything — give Moscow
   a fourth and fifth link, or thin Berlin's to four, and re-run 48 games. If
   the spread moves substantially, the lever is the map.
2. Only then consider constants. `MIN_ODDS`, `SOURCE_MAX_HOPS` and the ETA
   window are all currently *correct* — §1 shows the freeze came from a missing
   action, not from a mis-set threshold. Lowering `MIN_ODDS` makes the AI
   commit defeat in detail, the mistake 00-vision.md §8 names as the defining
   error of the game.
3. Three powers still never win. Expect the fix to be geographic.

---

## 3. Open, not yet solved

- **A last-stand freeze survives.** In an AI-vs-AI endgame at ~45% fill, a tight
  two-station pocket out-reinforces an attacker whose feeders are 2,000 ticks
  away, and the board holds at ~1.57:1 indefinitely. It did not occur in 48
  games, but it is real.
- **Fog of war must land before the balance pass.** Every constant in `BAL.AI`
  describes decisions made against a board the AI can see. Restrict what it
  sees and every one of them changes; a pass run first has to be run again.

---

## Reproducing any of this

Probes are in the session scratchpad and are self-contained — each loads the
game exactly as `test/node.js` does:

| question | probe |
|---|---|
| what does a capped game actually look like | `cap-probe2.js` |
| are drawn games deadlocked or just slow | `stall-probe.js` |
| why does a power holding 106 stations stop | `deadlock-probe.js` |
| who gets the free neutral land | `freeland-probe.js` |

**A check that cannot fail is not a check.** Every fix above was accepted only
after its test was watched failing against the unfixed code — and three times
on this project a test that looked authoritative turned out to assert nothing.

---

# 2026-08 — the second void, and what the instrument found instead

## 0. §2 above is void, for the same reason §0 voided its predecessor

§2 concluded that **capital link-degree** is the dominant predictor and that
Vienna's degree of 6 made Austria weak: it won **3 of 48**. Austria now wins
**74 of 96**. Fog, the passage toll, wave vision, the unit-type collapse, the
AI's target commitment and the AI's fortification sight all landed in between.
Do not act on the table in §2.

## 1. The instrument changed first — `--curve`

Win rate is one bit per game. Its standard error on 96 games is 4.5 points, so
nothing under about ten points is visible, and a sweep is eighteen minutes. C1b
is the worked example: it moved 74.0 → 77.1 and the only honest verdict was
"cannot tell".

`tools/balance.js --curve --at 1000,2000,5000` samples **board share** — the
fraction of the 108 stations held — and reports a mean with a 95% CI, alongside
the validation that licenses using a proxy at all: *how often the leader at tick
T went on to win*. That figure is **75% at tick 2,000** against a 14% chance
baseline, so the opening decides the game far earlier than the 15,700-tick mean
length suggests. Two-thousand ticks is three sim-minutes.

## 2. Position or agent? — BOTH, and differently per power

`--rotate N` rotates the personality assignment around the seven seats; seven
runs cover every assignment. 96 games each, share at tick 2,000:

| rotation | ger | fra | gbr | rus | aut | ita | ott |
|---|---|---|---|---|---|---|---|
| 0 | 5.7 | 4.6 | 3.8 | 6.0 | **6.2** | 4.0 | 0.9 |
| 1 | 5.6 | 6.0 | 3.6 | 6.0 | **6.2** | 4.6 | 0.9 |
| 2 | 4.6 | 5.7 | 3.3 | **6.5** | 3.8 | 4.2 | 0.9 |
| 3 | 6.3 | 5.2 | 3.2 | **6.4** | 3.4 | 5.0 | 0.9 |
| 4 | 4.6 | 4.6 | 4.3 | **5.9** | 3.3 | 4.6 | 0.9 |
| 5 | 4.4 | 5.3 | 3.2 | **6.2** | 6.0 | 3.9 | 0.9 |
| 6 | 5.9 | 3.4 | 3.8 | **6.5** | 3.8 | 4.5 | 0.9 |

CIs are ±0.0–0.3, so these differences are real. Three separate answers:

- **Austria is an AGENT effect, not a map effect.** It reads 6.0–6.2 in
  rotations 0, 1 and 5 and 3.3–3.8 in the other four — and rotations 0, 1 and 5
  are exactly the three in which Austria draws a **turtle**. Perfect separation.
  Austria's dominance is a *turtle × Vienna interaction*, not a positional one.
- **Russia is a MAP effect.** 5.9–6.5 under all seven assignments — invariant.
- **The Ottoman is neither.** 0.9 ± 0.0 in every rotation, which is one station,
  its capital, and nothing else — in **672 games**.

## 3. The Ottoman never moves, and the cause is a defect

The obvious reading is that Istanbul is too weak to break out. **It is not.**
Best available odds against the odds floor that power personally demands, mean
over 8 seeds, measured through the AI's own `aiCandidates`:

| power | floor | t=0 | t=100 | t=250 | t=500 | t=1000 | t=2000 |
|---|---|---|---|---|---|---|---|
| aut | 1.89 | 1.76 | 0.16 | 2.67 | 1.44 | 2.44 | 3.10 |
| ott | 1.89 | 5.00 | 0.42 | 1.12 | 2.30 | 1.67 | **3.64** |

| stations held | t=0 | t=250 | t=500 | t=1000 | t=2000 |
|---|---|---|---|---|---|
| every other power | 1.0 | ~2.0 | 3.0 | ~4.0 | 4.0–6.8 |
| **ott** | 1.0 | **1.0** | **1.0** | **1.0** | **1.0** |

The Ottoman sits on targets at 3.6× the odds it demands and takes none of them.
`aiDecide` returns `hold: stage-no-feeders` on **400 of 400** consecutive calls.

`_aiActPlanVolley` names it. At tick 600, seed 100:

```
ank  odds=0.76  route=ist>ank      -> sources ["ist"]
kir  odds=2.37  route=ist>ode>kir  -> reason "no-sources"     <-- the only
var  odds=0.88  route=ist>var      -> sources ["ist"]             one over
dar  odds=0.69  route=ist>dar      -> sources ["ist"]             the floor
smy  odds=0.98  route=ist>smy      -> sources ["ist"]
ode  odds=0.75  route=ist>ode      -> sources ["ist"]
```

Every adjacent option is under the 1.89 floor; the one that clears it is two
hops away and comes back **`no-sources`** — from a power holding a city with a
perfectly good route to it. See known-issue #9's 2026-08 entry for the cause:
`ai/ai.js`'s traversal rule is still the pre-B1 `st.owner === pid` while the sim
and `ai/score.js` both open passage to everything. **The scorer offers targets
the planner cannot plan.**

## 4. What this means for the order of work

**D2 must not run until §3 is fixed.** The AI can only attack ground adjacent to
what it already holds, so any map tuned to give seven powers equal outcomes today
is tuned to compensate for a planner that cannot march through a neutral city —
and that compensation gets baked into the map and stays there after the fix.

The same argument applies to the Austria finding. A turtle in Vienna beats a
non-turtle in Vienna by nearly two to one on early share; until that is
understood, "Austria is too strong" is not yet a statement about the map.

## 5. D1.5 measured — and the two instruments disagree, which is the point

96 games, seeds 100–195, before and after the traversal fix.

**Win rate says "cannot tell".** Spread 77.1 → 71.9 points. On 96 games the
standard error on a ~74% rate is 4.5 points, so a 5.2-point move is inside the
noise, exactly as it was for C1b. Read alone, this change is unmeasurable.

**Board share says the opening got substantially fairer, and says it loudly.**

| share spread | t=1000 | t=2000 | t=5000 | t=10000 |
|---|---|---|---|---|
| before | 2.8 pts | 5.3 pts | 15.3 pts | 45.5 pts |
| **after** | **1.2 pts** | **3.9 pts** | **10.8 pts** | **34.9 pts** |

Every checkpoint narrowed, and the CIs on those means are ±0.0–0.3. The t=1000
move is roughly sixteen standard errors. **This is the case D0 exists for**: the
binary endpoint could not resolve a real and large effect that the continuous one
resolves without ambiguity.

Per power, share at t=1000 → t=2000, and wins:

| power | before | after | wins before → after |
|---|---|---|---|
| aut | 3.7 → 6.2 | 3.6 → 6.1 | 74 → 69 |
| fra | 3.5 → 4.6 | 3.5 → 4.8 | 9 → 12 |
| gbr | 3.1 → 3.8 | 3.2 → 3.8 | **3 → 12** |
| ger | 3.7 → 5.7 | 3.6 → 5.8 | 4 → 2 |
| ita | 3.3 → 4.0 | 3.4 → 4.0 | 1 → 0 |
| **ott** | **0.9 → 0.9** | **2.4 → 2.2** | 0 → 0 |
| rus | 3.7 → 6.0 | **2.8 → 4.3** | 4 → 1 |

Three things follow, and only the first is unambiguous:

- **The Ottoman is alive.** 0.9 → 2.4 at t=1000 is the fix doing its job. It
  still wins nothing, so it is now a normal balance problem rather than a frozen
  one.
- **Russia lost its opening.** 6.0 → 4.3 share at t=2000 with CIs of ±0.1, and 4
  wins → 1. Russia was the one power §2 identified as genuinely positional, and
  the most likely reading is that its isolation was worth less once *everyone
  else* could reach past a neutral city. Worth confirming before relying on it.
- **Austria is untouched and still dominant** — 6.1 share at t=2000, 71.9% of
  games. Whatever Austria has, the planner was not it.

**§2's rotation table is now stale.** It was measured against the crippled
planner, so the "Austria is a turtle × Vienna interaction" finding has to be
re-run before D2 acts on it. So does the reference curve in §1.
