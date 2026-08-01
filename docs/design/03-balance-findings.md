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
