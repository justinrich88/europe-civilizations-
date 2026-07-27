# Reference — Virus Wars

Source: `silvergames.com/en/virus-wars`. Screenshot supplied by Justin 2026-07-26.
*(Image itself not saved — it was pasted into chat rather than provided as a file. Drop it in this directory as `virus-wars.png` if you want it alongside these notes.)*

This is the interaction model the game is built on. What the screenshot shows, and what we take from it:

## Observed

- **Cells hold a number.** Large, centred, white-on-colour, readable across the whole board at once. Values in frame ranged 30–86.
- **Colour is ownership.** Red vs blue, two saturated player colours. Nothing else is encoded in colour.
- **Shape is type.** Some cells render with a spiky membrane, others smooth — the outline silhouette distinguishes kinds of cell.
- **Selection is a caret above the cell.** A small red triangle sits above each selected node. Several were selected at once.
- **Many-to-one is the core command.** Three separate cells (45, 68, 58) had lines running into a single cell (86), which in turn had a line running to 76.
- **Modifiers are labelled in place.** The text *"x2 Reproduction"* floats next to cell 76, directly on the board rather than in a panel.
- **Transit lines are thick and white**, drawn above the background.

## Decisions taken from it

| Observation | Decision |
|---|---|
| The number is the interface | Garrison count is the primary rendered element on every station |
| Caret marks selection | Adopted over highlight rings — cheap, unambiguous, scales to many selected nodes |
| Shape encodes type | Four station types get four silhouettes: `holding` circle, `producer` square, `multiplier` star, `defensive` shield |
| Colour is ownership only | Which is *why* type must be carried by shape |
| Labelled modifiers on the board | Multiplier stations show their effect in place, not in a panel |
| Many-to-one lines | Confirmed the primary command: marquee-select sources → click one target |

## Clarified with Justin

The white lines initially read as **standing supply flows**. They are not — confirmed as one-shot: a single drag or commit sends a proportion (e.g. 75%) of the source's current population, and the line is the in-flight trail, which vanishes when the wave lands. No persistent flows, nothing to cancel.

## Where we deliberately diverge

- Virus Wars nodes are all essentially the same thing at different sizes. Ours are four functionally distinct types, and **which one a city is** is the point of the map (`00-vision.md §2`).
- Virus Wars has no geography. Ours is 1914 Europe, so territory, terrain, adjacency and chokepoints carry real weight — and multiplier effects spill across borders.
- Ours has unit types with a matchup triangle, so *what* arrives matters, not just how much.
