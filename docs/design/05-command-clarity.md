# Round eight, part two — command clarity and standings

Three reported problems, one of them structural. `00-vision.md` stays the
locked spec; what is accepted here folds back into §8.

---

## 1. Accidental volleys — inspection and attack are the same gesture

> *"It's also difficult to 'unclick' locations — I've accidentally issued
> movement commands"*

The gesture table in `render/select.js` is already careful, and a previous
round already fixed the worst version of this (a five-city volley firing at
city two, because the second left-click read as a commit). What remains:

```
left-click a station you OWN      -> toggle in the selection. NEVER commits.
left-click empty ground           -> clear selection.
left-click enemy/neutral,
    WITH sources selected         -> COMMIT. Every source launches. No confirm.
left-click enemy/neutral,
    with nothing selected         -> clear selection.
right-click your own station      -> reinforce / march.
Escape                            -> back out one step.
```

Look at lines three and four. **The same click on the same city either opens a
readout or launches your army, and the only thing that decides which is state
that may be entirely off-screen.** Selection is marked with carets on the
selected nodes — and at the 3× home zoom you can see 12% of the board, so the
sources you selected two minutes ago are very likely not visible when you click
the enemy city you meant to *look at*.

This is not a missing keybind. **You cannot inspect an enemy city without
attacking it**, and there is no state on screen that warns you which of the two
you are about to do.

### Fix: make the dangerous state impossible to miss, not the gesture slower

Rejected: **two-click arm-then-commit for volleys.** §8 is explicit — *"one
click on the target. Every selected source sends its proportion at once"* — and
doubling the clicks on the game's primary verb to defend against an edge case
is the wrong trade. (Arming already exists for the *order* verb, where it earns
its place because that gesture is rarer and stickier.)

Accepted, in order of value:

1. **A persistent selection line at the top of the right rail**, present
   whenever anything is selected: *"3 cities selected · 47 units · click a
   target to commit · Esc to clear"*. The rail is always on screen; the carets
   are not. This alone removes the surprise, and it costs no gesture change.
2. **The `is-arming` treatment already exists** for orders — reuse the same
   visual language on the board edge so the selected-and-loaded state reads
   peripherally, not just in the rail.
3. **Escape must always fully clear**, and say so in the rail. It currently
   backs out one step at a time, which is correct for the armed-order case and
   surprising for the "get me out of this" case. A second Escape clears
   everything.

### Deselection

`clearSelection()` already fires on a click on empty ground, and a station you
own toggles. Both are right. What is missing is that **nothing tells you these
exist.** The rail line in (1) is also the discoverability fix — it names Escape
at the moment Escape is relevant, which is the only time anyone reads a hint.

---

## 2. Reinforcement routes — are they on?

> *"The reinforcement routes still need more work — they're tough to click and
> understand if they're actually active"*

The data needed to answer "is this route working?" **already exists and is
already computed.** `standingOrderNext(state, sid)` returns:

```
{ units, edges: [{ target, units, blocked }], blocked, target }
```

— what actually leaves on the next sweep, per destination, and *why it does
not*. `blocked` is `null` when units are moving, otherwise the reason, or
`'no-order'` when the city supplies nowhere. None of that reaches the line
drawn on the map. The route renders identically whether it is shipping
30 units a sweep or has been dead for ten minutes.

### Fix: the route line reports its own state

- **Shipping** — chevrons animate along the route in the direction of travel.
  Motion is the one channel not already spent on ownership (colour) or station
  type (shape), and "it is moving" is exactly the question being asked.
- **Idle or blocked** — static and dimmed. Not hidden: a route you set that is
  not running is *the most important thing on the screen*, and hiding it would
  be the same class of bug as the invisible sea crossings.
- **Hover a route** — the reason, from `blocked`, in plain words.

**Use `standingOrderPlan(state, pid)`, not `standingOrderNext`, for anything
drawing more than one route.** `standingOrderNext` plans the whole power in
order to answer about one station; it is free once per frame and quadratic in a
loop over the board. This is written in `01-data-schema.md` and is easy to get
wrong.

### "Tough to click"

To be measured before it is fixed. The likely cause is hit-area: routes are
thin lines and the stations they connect are 12px symbols that were, until
recently, wide enough to swallow the entire link between them. A transparent
wide stroke behind each route is the standard fix — **and it must be
`pointer-events` aware**, because a fat invisible click target laid over the
board is precisely the bug that has bitten this project five times and produces
no error, only a game that silently stops committing attacks.

---

## 3. The standings panel

> *"there should be more persistent stats in the right nav that shows each
> nation, countries and cities owned, reinforcement routes, and development
> points"*

A persistent section in the right rail, always present, not hover-dependent —
distinct from the station readout, which answers *"what is this city"* and goes
idle when nothing is hovered.

Per power: **territories held · cities held · active reinforcement routes ·
development points.**

### Three constraints on it

**It must be fog-filtered.** Milestone 5.7 is landing as this is written. A
panel that lists every power's true city count would hand back, in a table,
exactly what the fog spends its whole existence hiding. Counts show what the
player can *see* — and a number lagging reality is fog working, not a bug.

The exception is deliberate and already decided in `02-visibility-and-sea.md`:
**standings stay public.** Who is *leading* is newspaper knowledge in 1914 and
`LEADER_WEIGHT` depends on it. So the panel may rank powers truthfully while
the per-power counts remain what you have eyes on. If those two ever disagree
visibly, the ranking is right and the counts are honest about their limits.

**"Development points" needs defining, and should not be a new currency.**
There is no resource in this game and §8's cut list keeps it that way. Read it
as **a summary of what a power has built** — the count and tier of
developments, e.g. `4 built · 7 tiers`. Derived from station state, stored
nowhere.

**Rail space is not free.** `render/hud.js` documents the bottom rail as a
52px bar over the sea, and the ticker was just refitted into a fixed 32px slot
because it had been simultaneously invisible at 800px and 109px tall above
1100px. The right rail has more room than the bottom bar, but seven powers ×
four stats is a table, and §8's principle is that the board is the interface.
**Collapse to the essentials at 800px** (known-issues #17 — that is the window
the game is played at) and let it expand when there is room.

---

## 4. Sequencing

| # | step | note |
|---|---|---|
| 5.7 | Fog of war | in progress |
| **5.7b** | **Selection safety + route state + standings panel** | this document. Independent of development, and the selection fix should not wait for it. |
| 5.8 | Collapse the three unit types to one | `04-development.md` §9 |
| 5.9 | Development | `04-development.md` |
| 6 | Balance pass | run **once** |

The selection fix is the only thing here a player is actively losing games to.
It is also the cheapest. It goes first.

The standings panel must be built **after** fog, not alongside it — it is a
consumer of `visibleTo`/`believedStation`, and building it against the true
board would mean writing it twice.
