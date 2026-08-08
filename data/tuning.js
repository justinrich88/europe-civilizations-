// data/tuning.js — every balance constant in the game, and nothing else.
//
// This is the single file balance work happens in. Nothing here may reference
// anything in sim/, render/ or ai/ (01-data-schema.md "Conventions"), and
// nothing outside this file may hard-code a number that a designer would want
// to change. If you find a magic number in sim/, it belongs here.
//
// Convention (matching the 0ad-levers prototype): every constant carries a
// one-line rationale for the value chosen, not just a description of what it
// does. "Why 0.0022 and not 0.05" is the part that is expensive to
// reconstruct six weeks from now.
//
// Units used throughout:
//   tick        one simulation step, BAL.TICK_MS milliseconds of sim time
//   sim-second  ten ticks at TICK_MS=100; wall-clock seconds only at 1x speed
//   unit        one soldier-equivalent; counts are FLOATS (01-data-schema.md)
//   dist        map distance in viewBox units (the map is 1000 x 700)
//   power       the combat currency: units x strength x modifiers

const BAL = {

  // ===================================================================
  // 1. TIME
  // ===================================================================

  // Fixed timestep. 100ms is the coarsest step at which 10 attrition
  // applications per second still look continuous, and it keeps a 20-minute
  // game inside 12k ticks so Monte Carlo batches stay cheap.
  // Speed controls multiply ticks-consumed-per-frame, never this value —
  // physics must be identical at 1x and 4x (00-vision.md §9).
  TICK_MS: 100,

  // Ticks per sim-second. Derived, but referenced often enough that it is
  // worth having a name rather than an open-coded 1000/TICK_MS.
  TICKS_PER_SEC: 10,

  // Catch-up cap: the most ticks one animation frame may consume before the
  // loop gives up and drops sim time. Prevents a death spiral when the tab is
  // backgrounded. 4x speed at 60fps needs ~7, so 40 is ~6x headroom.
  MAX_TICKS_PER_FRAME: 40,

  // Speeds offered by the HUD. Pause is a separate flag, not a 0 here, so
  // that unpausing restores the previous speed.
  //
  // 1x IS GONE, on the player's instruction, and 2x is now the default. Real
  // time here is a fixed 10 ticks/sec (TICKS_PER_SEC) and a march across a
  // border is tens of seconds of it — at 1x the board simply does not move
  // fast enough to reward watching it, and every session spent its whole
  // length at 2x or 4x anyway. Removing it costs nothing: the loop multiplies
  // time CONSUMED, never the timestep, so the physics at 2x is identical to
  // the physics at 1x and no balance constant is expressed in wall-clock.
  // Pause is still the way to stop and read the board.
  SPEEDS: [2, 4],
  SPEED_DEFAULT: 2,


  // ===================================================================
  // 2. GROWTH  (00-vision.md §2)
  //
  //   growth_per_tick = GROWTH_BASE * station.rate * growthMul
  //                     * units * (1 - units / capacity)
  //
  // Logistic, so an emptied station recovers slowly and a full one has
  // stopped paying dividends. "Full stations should be spent."
  // ===================================================================

  // The master growth coefficient. Chosen so a station climbing from 10% to
  // 90% of capacity takes ln(81) / (GROWTH_BASE * rate) ticks — at rate 0.9
  // that is ~1220 ticks, about two sim-minutes. Deliberately slow relative to
  // combat (~20s) and marches (~10-40s): rebuilding must cost real time or
  // the "units sent away don't multiply" tension evaporates.
  // Note the logistic timescale is independent of capacity, so a 25-unit town
  // and an 80-unit metropolis refill in the same wall time — capacity buys
  // volume, not speed. That is intentional and worth keeping.
  GROWTH_BASE: 0.004,

  // Logistic growth is multiplicative in `units`, so a station at exactly 0
  // can never recover. Floor the growth term (not the garrison) at this many
  // units so a scoured city crawls back instead of dying permanently.
  // 1.0 gives a ~10-15s "nothing visible is happening" beat after a wipe,
  // which reads as recovery rather than as a bug.
  GROWTH_SEED: 1.0,

  // Growth is disabled entirely above this fraction of capacity. Pure
  // logistic asymptotes and leaves a station wobbling at 99.7% forever,
  // which makes the HUD's growth readout look broken. Snap it shut.
  //
  // No longer read by sim/growth.js — GROWTH_OVERFLOW_RATE below replaced the
  // dead band it used to open. Kept because test/runner.js still names it and
  // because it documents the asymptote problem the floor now solves properly.
  GROWTH_CAP_EPSILON: 0.995,

  // ── over capacity ──────────────────────────────────────────────────────
  //
  // Added 2026-07 on the player's instruction: "rather than making production
  // stop when a city is full, just slow the production speed by 50% until the
  // city has capacity again."
  //
  // Pure logistic growth is `rate * units * (1 - units/capacity)`, which is
  // exactly zero at capacity. That made a full city dead ground that could only
  // be turned back into an asset by spending it — true to §2's "full stations
  // should be spent", but it meant the single best thing you own contributes
  // nothing until you gamble it, and a defensive power could hold a full board
  // and watch its economy stop.
  //
  // So growth no longer falls to zero. The room factor stops descending at
  // GROWTH_OVERFLOW_RATE of the station's PEAK growth and holds there through
  // capacity, then tapers to nothing at GROWTH_OVERFLOW_CEIL x capacity. The
  // peak of `units * (1 - units/cap)` is `cap/4` at half full, so the floor is
  // `0.25 * RATE` in room terms — that 0.25 is derived, not tuned, and lives in
  // sim/growth.js next to the formula it comes from.
  //
  // Consequences, deliberately accepted: capacity becomes "where it gets slow"
  // rather than "where it stops", the biggest stack on the board can now get
  // bigger, and square-law combat already rewards mass — so this wants a
  // balance pass, not just a green test suite.
  //
  // BOTH CONSTANTS ARE ALSO THE OFF SWITCH. RATE 0 with CEIL 1 reproduces the
  // pre-2026-07 sim exactly, which is how the change was proved not to have
  // perturbed anything else.
  GROWTH_OVERFLOW_RATE: 0.5,
  GROWTH_OVERFLOW_CEIL: 1.5,

  // A station over the HARD CEILING (reinforced past it) bleeds back down at
  // this fraction of the excess per tick. Half-life ~14 sim-seconds — long
  // enough to stage an assault out of an overstuffed border city, short
  // enough that hoarding is not a strategy. The floor it bleeds toward is
  // GROWTH_OVERFLOW_CEIL x capacity, not capacity: growth is legal up to the
  // ceiling now, and a decay that fought it would be two rules pulling on the
  // same number in opposite directions.
  OVERSTACK_DECAY: 0.0005,


  // ===================================================================
  // 3. MULTIPLIER STATIONS  (00-vision.md §2, the most novel mechanic)
  //
  // A multiplier raises `rate` at every station in its OWN territory and in
  // all ADJACENT territories. Several multipliers stack multiplicatively.
  // ===================================================================

  // How far a multiplier's effect travels, in territory hops. 1 = own
  // territory plus direct neighbours, exactly as specced. Flagged in
  // 00-vision.md §12.4 as the first thing to examine in playtesting — this is
  // the constant to change when we do. 0 makes farms local and dull, 2 makes
  // Ukraine boost half of Russia.
  MULTIPLIER_REACH: 1,

  // Multipliers are strongest at home and diluted at range. Own territory
  // gets the station's full `multiplier` value; each hop outward applies this
  // exponent to the bonus above 1.0. 0.6 means a 1.6x farm gives 1.6x at home
  // and ~1.36x next door — clearly worth capturing, not overwhelming.
  MULTIPLIER_FALLOFF: 0.6,

  // Hard ceiling on the product of all multipliers affecting one station.
  // The Ukrainian breadbasket can plausibly stack three farms on one city;
  // uncapped that is 4x+ growth and the game is decided by one province.
  // 3.0 still makes stacked farmland the best real estate on the map.
  GROWTH_MUL_CAP: 3.0,

  // A multiplier only projects while its owner actually holds it. A contested
  // multiplier station (hostile forces present) projects at this fraction —
  // not zero, so the map does not strobe during every skirmish.
  MULTIPLIER_CONTESTED: 0.5,


  // ===================================================================
  // 3b. TERRITORY CONTROL TIERS  (00-vision.md §3)
  // ===================================================================
  //
  // A country is owned by whoever holds a MAJORITY of its stations, not all of
  // them. Three tiers, and these weights scale every territory-scoped benefit
  // (multiplier reach today; anything country-wide added later).
  //
  //   full       every station          benefits at FULL
  //   majority   more than half         benefits at MAJORITY
  //   contested  nobody past half       nothing, for anyone
  //
  // Why the middle tier earns its keep: without it, one stubborn fortress in a
  // corner of France denies the whole country to an occupier holding eight of
  // nine cities, which reads as absurd and makes big countries unflippable.
  // With it, taking a single city is a foothold rather than a conquest, and the
  // last holdout is a nuisance rather than a veto.
  //
  // MAJORITY at 0.5 is the lever to watch. Too high and full control is
  // pointless; too low and partial control feels like nothing was gained.
  CONTROL: {
    FULL: 1.0,
    MAJORITY: 0.5,
    CONTESTED: 0.0,
  },


  // ===================================================================
  // 4. COMBAT  (00-vision.md §5 — "overwhelming force")
  //
  // Lanchester square law. Casualties per tick are proportional to the
  // ENEMY's power, which is what makes a bigger force win nearly intact:
  //
  //   lossesA_per_tick = COMBAT_RATE * powerB
  //   lossesB_per_tick = COMBAT_RATE * powerA
  //
  // Integrating gives A0^2 - A^2 = B0^2 - B^2, so at 2:1 the winner keeps
  // sqrt(4-1)/2 = 86.6% — the ~87% in the design table falls straight out of
  // the square law. Do not "tune" the survival percentages: they are a
  // consequence of the model, and COMBAT_RATE only sets the clock.
  // ===================================================================

  // Casualty scale per tick. Time for a battle at odds r is
  //   atanh(1/r) / COMBAT_RATE ticks
  // and is independent of army size, so this constant alone sets battle
  // length everywhere on the map. At 0.0022 and TICK_MS=100:
  //     3.0 : 1  ->  ~16 sim-seconds   (a formality, 94% survive)
  //     2.0 : 1  ->  ~25 sim-seconds   (decisive, 87% survive)
  //     1.5 : 1  ->  ~37 sim-seconds   (decisive but costly, 75% survive)
  //     1.2 : 1  ->  ~55 sim-seconds   (bloody, 55% survive)
  //    1.05 : 1  ->  ~84 sim-seconds   (a grind, a reinforcement race)
  // That puts every decisive battle in the 15-40 sim-second window the design
  // asks for, while even fights visibly grind. The 0.05 in the schema sketch
  // resolved a 2:1 in 1.1 seconds — far too fast to watch or reinforce.
  COMBAT_RATE: 0.0022,

  // Below this many units a side is considered destroyed and the remainder is
  // dropped. Float attrition asymptotes toward zero and would otherwise leave
  // 1e-9 infantry holding Berlin forever.
  ANNIHILATION_EPSILON: 0.01,

  // Fraction of its garrison a side must fall to before it withdraws.
  // 0 = FIGHT TO ANNIHILATION, which is the shipped behaviour (00-vision.md
  // §5: "a station flips the instant one side has nothing left in it").
  // *** This is the single constant to change to try routing. *** Set it to
  // e.g. 0.25 and sim/combat.js turns the losing side into a retreating wave
  // back down the link it arrived on. Left at 0 because routing adds a
  // second failure mode to every battle and the square law already makes
  // outcomes legible; revisit if playtesting says battles feel merciless.
  ROUT_THRESHOLD: 0,

  // Battle variance, rolled ONCE per engagement and held for its duration —
  // never per tick. A +/-12% band re-rolled every 100ms averages out to ~0.6%
  // across a 300-tick battle and is mathematically meaningless (§5). One roll
  // at engagement start is what makes an attack feel like a gamble.
  // Applied as attackerPower *= 1 + uniform(-BATTLE_VARIANCE, +BATTLE_VARIANCE).
  BATTLE_VARIANCE: 0.12,

  // A slow sine wobble layered on top of the fixed roll so momentum swings
  // are visible in a long battle. Amplitude and period, in fraction and
  // ticks. 60 ticks = 6 sim-seconds: fast enough to see the numbers breathe,
  // slow enough not to be noise. Amplitude is deliberately half the
  // engagement roll — flavour, not a second dice throw.
  BATTLE_WOBBLE: 0.06,
  BATTLE_WOBBLE_PERIOD: 60,

  // Station defense is ADDITIVE, not multiplicative (§5): a fortress adds a
  // FLAT block of power rather than scaling its garrison. Multiplicative
  // defense means a full fortress is mathematically untakeable and the map
  // freezes; additive means enough attackers always crack it.
  // Each +1.0 of `defense` above the 1.0 baseline (plus terrain defense) adds
  // this much power. 6.0 makes a 3.5-defense citadel worth +15 power, about
  // 12 extra infantry — a serious toll on any assault, and still crackable
  // by a 2:1 volley.
  DEFENSE_BONUS_POWER: 6.0,

  // The additive fortress block only applies while the defender still has
  // troops to man it; it scales in over the first few units so an empty fort
  // is not a ghost army. Full bonus at this many defenders.
  DEFENSE_BONUS_FULL_AT: 5.0,

  // Attackers who arrived this tick fight immediately (§8: "units fight the
  // moment they arrive"), but a stack that lands into an ongoing battle
  // inherits the engagement's existing variance roll rather than re-rolling.
  // Expressed here as a flag so sim/combat.js has no policy of its own.
  REINFORCE_INHERITS_VARIANCE: true,

  // TOMBSTONE — the matchup triangle, C1, 2026-08.
  //
  // MATCHUP / MATCHUP_MIN_SHARE / ARMOUR_VS_FORT / FORT_STRIP_CAP / UNIT_ORDER
  // and the three-row UNITS table lived here. Artillery beat entrenched
  // infantry, armour beat exposed artillery, infantry beat armour, and
  // artillery stripped forts. All of it is gone with the unit types
  // (04-development.md §9, 00-vision.md §4).
  //
  // Worth recording because the numbers were not idle: with the triangle
  // neutralised in data and NOTHING ELSE changed, France's 70.8% win rate
  // collapses and Austria-Hungary takes 82-98 of 108 stations on every one of
  // seeds 100-103, with games ending in half the time. The triangle was doing
  // far more balancing work than "a soft flavour rule" implies, and whatever
  // replaces it as Austria's brake is Phase D's problem, not a lost constant.


  // ===================================================================
  // 5. UNITS  (00-vision.md §4)
  //
  // ONE type. `units` is a scalar count of undifferentiated armies; there is
  // no roster to index and no per-type profile to look up.
  //
  //   atk       power multiplier when attacking a station
  //   def       power multiplier when defending a station
  //   speed     multiplier on MOVE_BASE
  //
  // These are the OLD INFANTRY NUMBERS, deliberately and not by default.
  // Infantry was the baseline, was what 92 of 108 stations produced, and is
  // the profile every existing tuning constant in this file was derived
  // against. def > atk (1.2 vs 1.0) is the one that carries weight: it is what
  // makes "arrives in volume, good defending" true and gives the defender a
  // real edge at parity, which is what 00-vision.md §5 rests on.
  // ===================================================================

  UNIT: { atk: 1.0, def: 1.2, speed: 1.0 },


  // ===================================================================
  // 6. MOVEMENT  (00-vision.md §8)
  //
  //   dist_per_tick = MOVE_BASE * UNITS[type].speed * terrainMove * seaMul
  //
  // A wave moves at the speed of its SLOWEST type, so mixed stacks travel
  // together; the stagger the design wants comes from different SOURCES, not
  // from a stack splitting apart mid-march.
  // ===================================================================

  // Map distance covered per tick at speed 1.0. 0.6 dist/tick = 6 dist/sec.
  // A typical intra-country link (dist ~42, Berlin-Leipzig) is 7 sim-seconds
  // for infantry, 4 for armour, 12 for artillery; a six-hop cross-map march
  // is ~45 seconds. That is the ratio the design needs: marching is
  // comparable to fighting (~25s) and much cheaper than regrowing (~120s),
  // so distance genuinely matters instead of being flavour.
  MOVE_BASE: 0.6,

  // Sea crossings are "simply slow and punishing rather than a naval system"
  // (§3).
  //
  // ── THIS IS NOT A 2x PENALTY. READ THE NEXT PARAGRAPH BEFORE TUNING IT. ──
  //
  // The speed multiplier is only HALF the toll, and it is the smaller half.
  // tools/build-stations.js:516 writes a sea link's `dist` as
  //
  //     Math.round(geo * (sea ? 1.6 : 1))
  //
  // so every sea link carries a distance 1.6x its own on-screen length before
  // this constant is applied at all. Audited across all 236 links: dist divided
  // by pixel distance is 1.00 for every land link and 1.60 for every sea one
  // (+-0.02 from the Math.round). March time is dist / speed, so the two
  // penalties COMPOUND, and against a land link of identical on-screen length:
  //
  //     every army      1.6 / 0.5              = 3.2x
  //
  // Measured on the live graph: dov~lil is 27 on-screen pixels and dist 44,
  // and an army crosses it in 147 ticks (14.7 sim-seconds) — long enough that
  // Britain is safe and must plan, short enough that it can still matter, but
  // that is 3.2x doing the work, not 2x.
  //
  // The previous version of this comment read "halving speed turns Dover (dist
  // 55) into an 18-second commitment", which understated the real penalty by
  // 1.6x and quoted a dist no link on the current map has. Anyone balancing sea
  // power off 0.5 alone is tuning against a number that is 3.2x wrong.
  //
  // TOMBSTONE — C1, 2026-08. SEA_ARTILLERY_SPEED_MUL (0.6) and
  // SEA_ARTILLERY_LOSS (0.10) charged a gun-carrying stack a further speed
  // penalty and 10% of its guns per crossing, making the real toll 5.3x rather
  // than 3.2x. Both died with the unit types. The sea therefore got CHEAPER
  // for the one kind of stack that used to find it expensive, and the crossing
  // is now one number for everybody -- which is what 02-visibility-and-sea.md
  // §3 asked for in the first place ("simply slow and punishing rather than a
  // naval system") and what the artillery clause was an exception to.
  SEA_SPEED_MUL: 0.5,

  // Waves that would arrive at a station already flipped to their own side
  // simply merge into the garrison. Waves whose whole path is cut mid-march
  // keep going — a march is a committed one-shot decision (§8), there is
  // nothing to cancel. Flag kept here so the rule is visible to balance work.
  WAVE_REROUTE_ON_LOSS: false,

  // Minimum units a send may carry. Below this the order is dropped rather
  // than spawning a wave of 0.3 infantry that clutters the map.
  MIN_SEND_UNITS: 0.5,

  // BEACHHEADS (02-visibility-and-sea.md §3b). A wave whose FINAL hop is a sea
  // link comes ashore in echelons over this many ticks, 1/N of its ORIGINAL
  // strength per tick, instead of all at once. Units still at sea are not in
  // the battle and cannot be hit. A land final hop is unaffected.
  //
  // This constant only has meaning against COMBAT_RATE, because the mechanic is
  // a race between how fast you can land and how fast the beach kills what has
  // landed — and the beach kills SLOWLY. A battle at odds r runs
  // atanh(1/r)/COMBAT_RATE ticks: 250 at 2:1, 366 at 1.5:1. A landing that
  // finishes in a fraction of that is barely a landing at all, and the sweep
  // says so. Measured on a live sea link (aal->got) against 30 defenders, with
  // the same fight run overland as the control:
  //
  //     N   sim-s   break-even odds   vs overland   2:1 survivors   3:1
  //     1     0.1     1.23 : 1            +0%           79%         91%   <- old
  //    30       3     1.27 : 1            +3%           77%         90%
  //    60       6     1.33 : 1            +8%           74%         88%
  //   120      12     1.40 : 1           +14%           68%         85%   <- ship
  //   180      18     1.50 : 1           +22%           63%         83%
  //   240      24     1.60 : 1           +30%           56%         80%
  //
  // 60 — the value this feature was sketched with — buys +8% odds and five
  // points of survivors. That is inside the BATTLE_VARIANCE band (0.12) and a
  // player would never see it; the feature would exist and do nothing. 120 is
  // the first value where a landing is visibly a worse deal than a march:
  // a 2:1 assault pays 32% of its force instead of 21%, half again as much.
  //
  // Capped below 180 by the other clocks, in both directions:
  //   * 180 ticks is the Dover crossing for infantry (see SEA_SPEED_MUL). A
  //     landing must not take as long as the voyage — the water is supposed to
  //     be the commitment, the beach the consequence.
  //   * 250 ticks is a decisive 2:1 battle. 120 is half of that, so echelons
  //     span the opening of the fight and are done before it is decided, which
  //     is what "chewed piecemeal on the way in" should feel like rather than
  //     "fed in over the whole war".
  //   * 120 is two BATTLE_WOBBLE_PERIODs (60), so a landing covers a full swing
  //     of the momentum wobble in each direction instead of riding one of them.
  //
  // The break-even ratio is very nearly scale-free — the echelon is a fraction
  // of the force, so it scales with it. Measured at N=60: 1.40:1 against 10
  // defenders, 1.33:1 against 30, 1.28:1 against 60, 1.27:1 against 120. Small
  // landings pay slightly more, which is the right way round.
  LANDING_TICKS: 120,

  // Persistent send proportion, per §8: "a persistent 25/50/75/All setting
  // applies to the whole volley".
  //
  // The default is 25%, not §8's original 75%, and the setting is now ONE-SHOT
  // — it reverts here after every volley (render/select.js). The player's
  // reasoning, and it is right: the amount is the part of a volley you get
  // wrong under time pressure, and a *sticky* 75% means one absent-minded
  // click empties a city you meant to hold. A one-shot setting that always
  // relaxes to the timid value makes the expensive choice the deliberate one
  // — you must press 4 every single time you mean to commit everything.
  //
  // SEND_FRACTIONS is the ladder, and its index+1 is the digit that selects it:
  // 1=25 2=50 3=75 4=All. Keep the two in step — render/select.js derives the
  // key bindings from this array rather than repeating the numbers.
  SEND_FRACTION_DEFAULT: 0.25,
  SEND_FRACTIONS: [0.25, 0.5, 0.75, 1.0],

  // What a source ALWAYS keeps back, in units, however large the fraction.
  //
  // "if you 'send all' 1 troop stays so population increases" — the player, and
  // this is a real hole rather than a nicety. Growth is logistic (§2):
  //     growth = rate x units x (1 - units/capacity)
  // which is proportional to `units`, so a station emptied to exactly zero has
  // a growth rate of exactly zero and is dead ground forever — it can never
  // recover on its own, no matter how long you hold it. Before this, "All"
  // permanently destroyed the city that sent it.
  //
  // Applied to EVERY fraction, not just 1.0, because "your own order can never
  // kill a city" is one rule a player can hold in their head, where "except
  // below 1.3 units at 75%" is not. A station at or under this floor simply
  // has nothing spare and is rejected as 'too-few-units', the same refusal it
  // already gets today.
  //
  // 1.0 rather than a fraction of capacity: it is a SEED, not a garrison. It
  // does not defend the place and is not meant to — a city held by one unit
  // still falls to anything, which keeps "I emptied my rear" a real risk.
  SEND_KEEP_UNITS: 1.0,

  // Terrain scopes to the whole territory (§3).
  //   move     multiplier on march speed for links ENTERING this territory
  //   defense  ADDED to the defending station's defense value
  // Mountains at 0.55/+0.9 make the Alps and the Carpathians real walls
  // without needing special-case links; urban is slow-ish and defensible so
  // cities are sticky. Values are deliberately mild: terrain should colour a
  // decision, not decide it — station type carries the bigger spread.
  TERRAIN: {
    plains:    { move: 1.00, defense: 0.0 },
    hills:     { move: 0.80, defense: 0.4 },
    forest:    { move: 0.75, defense: 0.3 },
    urban:     { move: 0.90, defense: 0.6 },
    mountains: { move: 0.55, defense: 0.9 },
  },


  // ===================================================================
  // 7. CONNECTION  (00-vision.md §5, "keeping the snowball honest")
  //
  // A station with no path back to its owner's capital, over stations that
  // owner holds, stops growing and decays. This is the main anti-snowball
  // system and the reason armour exists.
  // ===================================================================

  // Decay per tick as a fraction of the garrison while disconnected.
  // Half-life ln(2)/0.002 = ~347 ticks = ~35 sim-seconds. Deliberately
  // aggressive: cutting a link should feel as decisive as winning a battle
  // (which takes about the same 25-35 seconds), otherwise nobody ever bothers
  // to cut and the square law runs away with the game.
  DISCONNECT_DECAY: 0.002,

  // Disconnected stations get this growth multiplier. 0 = none at all; a
  // pocket must be relieved, not waited out.
  DISCONNECT_GROWTH: 0.0,

  // Grace period before decay starts, in ticks. 50 = 5 sim-seconds, enough
  // that a link flickering during a contested battle does not immediately
  // start melting a province the player is about to relieve.
  DISCONNECT_GRACE: 50,

  // A capital is connected to itself by definition. A power that has LOST its
  // capital has no anchor — rather than melting its whole empire at once, the
  // largest connected component it still holds becomes the anchor. Set false
  // to make capital loss immediately catastrophic.
  FALLBACK_ANCHOR_ON_CAPITAL_LOSS: true,

  // Connectivity is a graph flood over ~100 stations; recomputing it every
  // tick is affordable but wasteful. Recompute every N ticks and on any
  // ownership change. 10 = once per sim-second.
  CONNECTIVITY_INTERVAL: 10,


  // ===================================================================
  // 8. CAPTURE
  // ===================================================================

  // Growth multiplier applied to a freshly captured station for
  // CAPTURE_PENALTY_TICKS. 00-vision.md §5 names this as the NEXT lever to
  // pull if the snowball proves too strong ("making freshly taken stations
  // slow to recover"). Shipped at 1.0 = OFF, so the three primary brakes
  // (connection, balance-of-power AI, logistic growth) get measured on their
  // own first. Try 0.4 / 600 before touching anything else.
  CAPTURE_GROWTH_PENALTY: 1.0,
  CAPTURE_PENALTY_TICKS: 600,

  // Territory control threshold (00-vision.md §12.3). 1.0 = all-or-nothing,
  // hold every station in a territory to control it, which is the shipped
  // rule. 0.5 would make the map flip faster and feel less grindy — the open
  // question is explicitly flagged as "easy to try both", so it lives here as
  // a fraction rather than as an `every()` in the renderer.
  TERRITORY_CONTROL_FRACTION: 1.0,


  // ===================================================================
  // 9. VICTORY  (00-vision.md §7)
  // ===================================================================

  // A power capitulates when it has lost its capital AND holds fewer than
  // this fraction of the territories it started with. All its remaining
  // stations transfer to whoever holds its capital. 0.25 removes the tedious
  // last-20% mop-up while still requiring a real conquest first.
  CAPITULATE_FRACTION: 0.25,

  // Both conditions are required. Set false to let territory collapse alone
  // trigger capitulation — much faster games, much cheaper wins.
  CAPITULATE_REQUIRES_CAPITAL: true,

  // Capitulation is checked on this cadence rather than every tick; it is a
  // whole-board scan and nothing about it is time-critical. 50 = every 5
  // sim-seconds.
  CAPITULATE_CHECK_INTERVAL: 50,

  // ===================================================================
  // HISTORY — the shape of the game, for the end screen
  //
  // sim/victory.js samples every power's territory, forces and development
  // every INTERVAL_TICKS. render/victory.js draws it as a line chart so a
  // player can see how the game actually went rather than only how it ended.
  //
  // IN THE SIM AND NOT IN THE RENDERER, and the reason is rAF. A renderer-side
  // recorder samples on frames, so the series would have holes wherever the
  // player paused, changed speed or backgrounded the tab — and known-issue #10
  // is that rAF does not fire at all in a hidden document. A chart of "how the
  // game went" that depends on whether anyone was watching is worse than none.
  // It also means two lockstep clients draw the same chart of the same game.
  //
  // 120 ticks = 12 sim-seconds. A game runs 16,000-25,000 ticks (03-balance-
  // findings.md), so that is 130-210 points — more than a 320px-wide chart can
  // resolve, and cheap: 7 powers x 3 numbers x 210 samples is ~4,400 floats.
  //
  // MAX_SAMPLES is a hard ceiling, not a hope. tools/balance.js runs hundreds
  // of 36,000-tick games; without it a stuck game would grow this array
  // forever. On overflow the series is DECIMATED — every other sample dropped
  // and the interval doubled — which keeps the whole shape of the game at half
  // the resolution instead of throwing the beginning away.
  // ===================================================================

  HISTORY: {
    INTERVAL_TICKS: 120,
    MAX_SAMPLES: 256,
  },

  // Transferred stations arrive at this fraction of their garrison — the
  // surrendering army is not handed over intact. 0.5 keeps the reward large
  // without making capitulation a bigger prize than the war that caused it.
  CAPITULATE_UNIT_KEEP: 0.5,

  // Hard stop for headless batches so a stalemated Monte Carlo run cannot
  // hang the harness. 36000 ticks = one sim-hour. A game that reaches this
  // is scored as a draw and should be reported as such in balance runs.
  MAX_GAME_TICKS: 36000,


  // ===================================================================
  // 10. AI  (00-vision.md §6)
  //
  // Balance of power WITHOUT diplomacy: relations move on their own, driven
  // by borders, aggression and relative standing. Personalities weight those
  // terms differently on top of very different national maps.
  // ===================================================================

  AI: {

    // --- Action budget (§6: "it cannot out-click you") ---

    // Ticks between one power's orders. 40 = one order per 4 sim-seconds,
    // against a human who can comfortably issue one every 2-3. Seven AI
    // powers at this cadence produce ~1.75 orders/sec across the board, which
    // is a readable amount of activity rather than a swarm.
    ACTION_INTERVAL_TICKS: 40,

    // Random +/- jitter on that interval, so seven powers do not all fire on
    // the same tick and produce a visible pulse.
    ACTION_JITTER_TICKS: 12,

    // Ticks between relation recomputations. Relations move slowly by design;
    // once every 5 sim-seconds is far more often than they meaningfully
    // change and keeps the cost off the hot path.
    RELATION_INTERVAL_TICKS: 50,

    // Hard ceiling on orders per power per minute, as a backstop independent
    // of the interval above. Catches any future code path that tries to fire
    // outside the cadence.
    MAX_ORDERS_PER_MINUTE: 20,

    // --- COMMITMENT: the defeat-in-detail fix (roadmap B3) ---

    // Ticks a power stays committed to a target once it has chosen one.
    //
    // WHY THIS EXISTS. B1 opened the AI's horizon, and 07-roadmap.md B3 warned
    // exactly what that buys on its own: "without it, a wider horizon just means
    // splitting force in more directions." The candidate scores of two comparable
    // fronts drift past each other constantly — a garrison grows, a relation
    // moves, a neighbour is captured — and a power that re-picks the best target
    // every ACTION_INTERVAL_TICKS sends the first wave at one city, the second at
    // another, and takes neither. That is DEFEAT IN DETAIL, which 00-vision.md §8
    // names as the defining mistake of the game, committed by the AI against
    // itself.
    //
    // 600 ticks is 60 sim-seconds, or fifteen action intervals — long enough for
    // several volleys to land at one place, short enough that a power is not stuck
    // on a target that has become hopeless. The focus is ALSO dropped early the
    // moment the target stops being a legal candidate, so this is a ceiling rather
    // than a sentence.
    FOCUS_TICKS: 600,

    // --- Target selection: "think in fronts" ---

    // The AI picks ONE target station and a commitment budget, rather than
    // micromanaging stacks. This is how many candidate targets it scores per
    // decision; beyond ~12 the extra candidates are all bad and the log
    // becomes unreadable.
    CANDIDATES_PER_DECISION: 12,

    // Only stations within this many link-hops of a station the power holds
    // are considered. 2 keeps the AI fighting on its own borders instead of
    // launching quixotic cross-map expeditions.
    TARGET_MAX_HOPS: 2,

    // Sources are drawn from stations within this many hops of the target, so
    // a volley lands together rather than being defeated in detail (§8). This
    // is the single most important AI competence constant — raise it and the
    // AI starts making the defining mistake of the game.
    SOURCE_MAX_HOPS: 3,

    // Cap on stations in one volley. Matches what a human comfortably
    // marquee-selects, and bounds the pathfinding per decision.
    MAX_SOURCES_PER_VOLLEY: 6,

    // Minimum estimated power ratio before the AI commits. 1.4 is above the
    // 1.2 "bloody, close" band and below the 2.0 "decisive" band: the AI
    // attacks when it is genuinely ahead but does not wait for a sure thing,
    // which is the difference between a live opponent and a statue.
    MIN_ODDS: 1.4,

    // A turtle-flavoured floor: never send so much that a source station
    // drops below this fraction of its capacity. Stops the AI from stripping
    // its own interior to feed one front.
    HOME_GARRISON_FLOOR: 0.25,

    // Fraction of eligible units an AI volley sends. Matches the player's
    // default (SEND_FRACTION_DEFAULT) so neither side has a hidden edge.
    COMMIT_FRACTION: 0.75,

    // --- Staging: massing forward when the volley does not yet clear ---
    //
    // Without these the AI has exactly two behaviours, attack and hold, and
    // `hold` is INERT. Measured on seed 101: France held 106 of 108 stations
    // with 3,534 units and stood still forever, because the only two stations
    // that could reach Constantinople inside the ETA window (Smyrna, the
    // Dardanelles) held 52 units between them and everything else on the
    // approach is across a sea crossing at 1,500-3,600 ticks. 22 owned
    // stations with 653 units sat within SOURCE_MAX_HOPS and could not
    // contribute — sending them anyway is defeat in detail (§8), so the AI
    // was right to refuse and had no third option.
    //
    // The third option is what a human does: walk the rear echelons forward
    // into the border city that CAN deliver, eat OVERSTACK_DECAY while they
    // sit there, and attack once the fist is assembled. It needs no new sim
    // rule — a send to a station you already own merges into its garrison
    // (sim/movement.js _moveDeposit), and OVERSTACK_DECAY's own comment
    // already calls this out: "long enough to stage an assault out of an
    // overstuffed border city, short enough that hoarding is not a strategy."

    // How far behind the depot staging feeders are drawn from, in link-hops
    // over the power's OWN ground. This is NOT SOURCE_MAX_HOPS and must not be
    // confused with it: a staging march does not have to arrive together with
    // anything, so distance costs march time rather than risking the volley.
    // 4 was measured against 3 and 6; see the sweep in the AI notes. Bigger
    // mostly drains the deep interior into a queue of waves that are still
    // walking when the war is decided somewhere else.
    STAGE_MAX_HOPS: 4,

    // How much more than the arithmetic deficit to walk forward. The deficit
    // is computed exactly — (minOdds x defenderPower - volleyPower) converted
    // to units at the volley's own power-per-unit — but the mass then bleeds
    // at OVERSTACK_DECAY for the whole of a 1,500-3,000 tick march, so aiming
    // at exactly enough arrives at not enough and the power stages forever.
    // 1.4 clears the bleed over a typical approach with margin to spare.
    STAGE_OVERSHOOT: 1.4,

    // --- Target valuation weights ---
    // Utility = sum of these times normalised terms. Multiplier stations are
    // weighted highest because they are the most valuable and the cheapest to
    // take (barely garrisoned, §5) — an AI that ignores farms looks stupid in
    // exactly the way the design is trying to make interesting.
    VALUE: {
      multiplier:   3.0,  // spills across borders; hurts the enemy everywhere
      producer:     2.2,  // the only source of artillery and armour
      defensive:    1.4,  // gates a chokepoint; worth taking, painful to try
      holding:      1.0,  // the baseline
      capital:      2.5,  // bonus on top of type; capitulation needs it (§7)
      capacityTerm: 0.02, // per unit of capacity — size matters, mildly
      weakness:     1.8,  // per unit of favourable odds above MIN_ODDS
      proximity:    1.2,  // per hop closer; near targets are cheaper to hold
      cutsLink:     1.5,  // taking it disconnects enemy stations (§5)
      relationTerm: 2.0,  // scaled by how hostile the AI is to the owner
    },

    // --- Relations (§6) ---
    // Scale is -100 (total war) to +100 (aligned). Nobody negotiates; these
    // move on their own.
    RELATION_MIN: -100,
    RELATION_MAX: 100,

    // Powers go to war below this and stop attacking above it. The gap
    // between the two is hysteresis — without it, powers oscillate in and out
    // of war every few seconds and the ticker becomes noise.
    WAR_THRESHOLD: -40,
    PEACE_THRESHOLD: -15,

    // Everyone starts here: mildly wary, nobody at war. The Concert holds
    // until somebody moves.
    RELATION_START: 10,

    // Per relation update, relations drift back toward RELATION_START by this
    // fraction. Grudges fade; without decay the board locks into permanent
    // alliances by minute three.
    RELATION_DRIFT: 0.02,

    // --- Relation drivers, per update, before personality weighting ---

    // Shared border pressure: hostility from enemy force massed on a shared
    // frontier. Where you mass is a statement (§6), and this is driver #1.
    //
    // DO THE ARITHMETIC BEFORE CHANGING THIS. The term is
    // BORDER_PRESSURE x borderWeight x pressure, where `pressure` is a SHARE in
    // 0..1 (theirs / (theirs + mine + 1)), not a unit count. So this constant is
    // the most hostility a totally lopsided frontier can generate. Reaching war
    // means moving RELATION_START (+10) to WAR_THRESHOLD (-40) — fifty points.
    //
    // It was 6.0, which is 12% of that. Driver #1 of three was therefore
    // MATHEMATICALLY INCAPABLE of ever causing a war, and only the leader term
    // (45.0) could — a term that fires at whoever is ahead regardless of whether
    // you can reach them. tools/balance.js showed the consequence: powers ate
    // the neutrals, then logged `not-at-war` forever. 0 of 12 games ended.
    //
    // Swept 6 / 25 / 45 / 55 / 65 / 80 / 110 over 6 games each:
    //
    //     BP    games finished   live wars   holds "not-at-war"
    //      6         0/6            0.0            88%
    //     45         0/6            3.3            81%
    //     65         4/6            7.2            37%
    //    110         6/6           10.2             1%
    //
    // 110 finishes every game and is WRONG: at 1% peacetime the Concert is
    // decorative and §6's whole emergent-diplomacy idea is gone. 65 is the knee
    // — games resolve, capitulations happen, and peace is still a real state the
    // board can be in. This is the anti-snowball lever's counterweight; if the
    // board ever freezes again, look here first.
    BORDER_PRESSURE: 65.0,

    // Hostility added when this power's station is attacked, scaled by the
    // fraction of the garrison lost. Recent aggression should dominate the
    // short term — being hit is the loudest signal available.
    AGGRESSION_HIT: 25.0,

    // How fast the memory of an attack fades, per relation update.
    AGGRESSION_MEMORY: 0.9,

    // *** The Concert of Europe in one number. *** Hostility added toward the
    // leader, scaled by how far ahead of the field they are in territory
    // count. Heavy by design (§6: "a heavy term pushing everyone toward
    // hostility with the leader") — this is the entire replacement for
    // diplomacy, and it is what makes running away with the game turn the
    // board against you. If snowballing survives playtesting, raise this
    // before touching combat.
    LEADER_WEIGHT: 45.0,

    // Only powers above this share of the leader's territory count join the
    // pile-on; a power down to two provinces has bigger problems.
    LEADER_PILE_ON_MIN_SHARE: 0.15,

    // --- Personalities (§6) ---
    // Multipliers on the terms above, per 00-vision.md's three archetypes.
    // Each set is deliberately lopsided: a personality that is 1.1x on
    // everything is indistinguishable from the default in play.
    PERSONALITIES: {
      // Attacks early, at worse odds, and cares least who the leader is —
      // frequently BECOMES the leader and gets piled on. Germany's "must win
      // fast" map plays to this.
      expansionist: {
        aggression:   1.4,
        minOddsMul:   0.85,  // commits at ~1.2:1 — bloody, close fights
        leaderWeight: 0.7,
        borderWeight: 1.2,
        revengeWeight: 1.0,
        expandBias:   1.5,
        defenseBias:  0.7,
      },
      // Barely initiates, holds a deep garrison, and reacts hard when hit.
      // Suits France's fortress belt and the Ottoman chokepoints.
      turtle: {
        aggression:   0.6,
        minOddsMul:   1.35,  // needs ~1.9:1 before it moves
        leaderWeight: 1.2,
        borderWeight: 1.4,
        revengeWeight: 1.3,
        expandBias:   0.5,
        defenseBias:  1.6,
      },
      // Ignores relations and hits whatever is weakest right now, including
      // the leader. The board's self-correcting element.
      opportunist: {
        aggression:   1.0,
        minOddsMul:   1.0,
        leaderWeight: 1.5,
        borderWeight: 0.8,
        revengeWeight: 0.7,
        expandBias:   1.0,
        defenseBias:  1.0,
      },
    },

    // --- Debuggability (§6: "a passive AI is otherwise undebuggable") ---

    // Every decision is logged with its utility score. Ring buffer size —
    // large enough to cover a whole game at ~1.75 decisions/sec for several
    // minutes, small enough not to leak memory in a Monte Carlo batch.
    LOG_MAX: 400,

    // Also log the candidates that were REJECTED and why. Off in batch runs
    // (it is 12x the volume), on when a power is behaving like a statue.
    LOG_REJECTED: false,
  },


  // ===================================================================
  // 11. STANDING ORDERS  (00-vision.md §8, scoped amendment)
  //
  // One pipe with two ends and an off switch, set per station:
  //
  //   hold   (default)  accumulate; never auto-sends. Today's behaviour.
  //   rally             a sink; nearby feed stations stream into it.
  //   feed              a source; ships surplus to the nearest rally, or with
  //                     no rally set, to the nearest owned station on the front.
  //
  // §8 says "the board never plays itself". This is the one amendment to that
  // sentence and the SCOPE is the amendment: a standing order moves units only
  // between stations the player already holds. It never targets ground its
  // owner does not hold and never initiates combat — every attack in this game
  // is still a deliberate one-shot click. sim/movement.js enforces it in two
  // places (applyCommand refuses a standing send at unheld ground; a standing
  // wave stands down rather than fighting), and state.orderStats.fights is the
  // tripwire that says so out loud.
  // ===================================================================

  ORDERS: {

    // Ticks between standing-order sweeps. This is the mechanic's clock and it
    // has to sit sensibly among the four that already exist:
    //
    //   CONNECTIVITY_INTERVAL       10   whole-board flood
    //   ORDERS_INTERVAL             25   <- this
    //   AI.ACTION_INTERVAL_TICKS    40   one AI order per power
    //   CAPITULATE_CHECK_INTERVAL   50   whole-board scan
    //
    // A whole-board sweep every tick is waste for the same reason capitulation
    // is not checked every tick — nothing here is time-critical. 25 ticks =
    // 2.5 sim-seconds, so a feeding city ships about 1.6 times per AI order:
    // fast enough that the stream reads as continuous rather than as a convoy
    // schedule, slow enough that a power with twenty feed cities cannot
    // out-click the AI's own budget. It is deliberately NOT a divisor of
    // AI.ACTION_INTERVAL_TICKS, so the two cadences do not phase-lock into one
    // enormous tick every 200.
    INTERVAL: 25,

    // Share of a feeding station's SURPLUS (units above the keep floor) that
    // leaves on each sweep. The designer chose a small constant trickle over
    // batching, so this number is what "small" means.
    //
    // Against SEND_FRACTION_DEFAULT (0.75) — a manual volley — 0.12 per sweep
    // is 1/6 of one click, and at INTERVAL 25 it is ~0.5% of surplus per tick.
    // A feed city bleeds e-folding-slowly toward its floor: after 100 ticks it
    // has shipped 1-(0.88^4) = 40% of its surplus, after 300 ticks 78%. That
    // is the right order of magnitude against LANDING_TICKS (120) and a
    // decisive 2:1 battle (250 ticks): a front fed by three cities gains
    // materially over the span of one battle, but no single sweep is a volley
    // and losing one wave is never losing an army.
    SEND_FRACTION: 0.12,

    // A feeding station never sends below this fraction of its CAPACITY, so it
    // can still defend itself and the rear never empties.
    //
    // Same rule and same number as BAL.AI.HOME_GARRISON_FLOOR (0.25), and
    // enforced the same way — as a cap on how much may leave, never as a gate
    // that can never open (see the block comment in ai/ai.js: growth stops at
    // GROWTH_CAP_EPSILON, so a station is never quite full and a literal "can
    // this source afford the full fraction?" test rejects everything forever).
    // It is a SEPARATE constant because that one is AI personality tuning and
    // this is a player-facing mechanic: tuning how brave the AI is must not
    // silently change what the player's own cities do.
    KEEP_FLOOR: 0.25,

    // Smallest stream worth sending. MIN_SEND_UNITS (0.5) is the floor for a
    // deliberate click; a standing order fires unattended every 25 ticks
    // forever, so its floor is higher — it keeps a nearly-drained feed city
    // from spawning an endless dribble of 0.6-unit waves that clutter the map,
    // cost a route search each, and can never matter. Below it the sweep is a
    // no-op for that station and it simply keeps growing until it can pay.
    //
    // 2.0 -> 1.0, 2026-07. This gate is PER EDGE and it also gates the source,
    // so a city needs `N * MIN_SEND / SEND_FRACTION / (1 - KEEP_FLOOR)` units
    // before N supply lines will run at all. At 2.0 that made the player's own
    // stated goal — "it's difficult to reinforce more than one city from a
    // single city" — arithmetically impossible for most of the board:
    //
    //     destinations      1      2      3      4
    //     min capacity   22.2   44.4   66.7   88.9
    //     cities able    94     18      4      0     (of 108, at capacity)
    //
    // Four lines could never run anywhere: the largest city on the map has
    // capacity 74. Berlin supplying three cities fired ONCE and then reported
    // `below-min-send` forever, which reads as the feature being broken.
    //
    // At 1.0, and with growth now running to GROWTH_OVERFLOW_CEIL so a full
    // city holds 1.5x capacity, it is 108/107/99/76 of 108 — the gesture the
    // player asked for works on essentially the whole board.
    //
    // SEND_FRACTION was the other candidate and was deliberately left alone.
    // Raising it to 0.18 would have reached the same table by making every
    // standing order ship 50% faster, which is a balance change stacked on top
    // of the growth change landing in the same session. One constant, one
    // effect, one thing to blame if the sweep moves.
    MIN_SEND: 1.0,
  },


  // ===================================================================
  // 11b. FOG OF WAR  (02-visibility-and-sea.md §1, milestone 5.7)
  //
  // Visibility itself has no constants: it is derived from ownership,
  // LINKS and the `vision` field on the station record, and none of those
  // three is tunable from here. What IS tunable is how often each power
  // WRITES DOWN what it can see — the memory that mints level 1 (fogged:
  // "the station as of when you last saw it").
  // ===================================================================

  FOG: {

    // Ticks between observation sweeps. observeTick() runs at the top of
    // aiTick for every alive power, so this is the fifth entry in the
    // cadence table that ORDERS.INTERVAL documents:
    //
    //   CONNECTIVITY_INTERVAL       10   whole-board flood
    //   FOG.OBSERVE_INTERVAL        10   <- this, whole-board per power
    //   ORDERS.INTERVAL             25   standing-order sweep
    //   AI.ACTION_INTERVAL_TICKS    40   one AI order per power
    //   CAPITULATE_CHECK_INTERVAL   50   whole-board scan
    //
    // WHY IT IS THROTTLED AT ALL. A sweep is one visibleTo() plus one
    // 108-station write pass per power. Measured on the live board, seed
    // 100 at t=4000 (56 of 108 stations held by somebody):
    //
    //   one sweep, all 7 powers                  142.9us
    //   an off-cadence call (the early return)     0.01us
    //   amortised per tick at INTERVAL 10         14.4us
    //   stepTick, same board                     671.5us
    //
    // So unthrottled it would be 21% of a tick, and at 10 it is 2.1%. A
    // balance batch is 200 games of up to 60,000 ticks, where 19% of a
    // tick is minutes of pure overhead on a run that already takes eight.
    //
    // WHY 10 IS THE RIGHT NUMBER. It costs one sim-second of extra
    // staleness in the worst case, against an AI that only acts every 40
    // ticks and a player reading a number that is already deliberately
    // out of date. Nothing on the board can traverse a link in 10 ticks,
    // so no station can change hands, be seen, and change back inside one
    // observation gap.
    //
    // It is a divisor of nothing else on the list except
    // CONNECTIVITY_INTERVAL, which it may safely phase-lock with: both are
    // whole-board reads and neither draws from state.rng, so sharing a
    // tick costs a slightly lumpier frame and nothing else.
    //
    // MUST BE AN INTEGER >= 1. The throttle is `state.tick % INTERVAL`,
    // read off the sim clock and never off the wall clock, because a
    // wall-clock throttle would make 1x and 4x observe on different ticks
    // and the whole determinism guarantee would go with it.
    OBSERVE_INTERVAL: 10,
  },


  // ===================================================================
  // 12. HEADLESS BALANCE HARNESS  (00-vision.md §11)
  //
  // Three numbers are the dashboard: win-rate spread across the seven
  // powers, mean game length, mean time-to-first-station-flip.
  // ===================================================================

  BATCH: {
    // Games per Monte Carlo batch. 200 puts the standard error on a 1-in-7
    // win rate at about +/-2.5 points — enough to see a broken power, cheap
    // enough to run between edits.
    GAMES: 200,

    // Base seed. Fixed so a balance table is reproducible; bump it to confirm
    // a result is not an artefact of one seed family.
    SEED: 19140628,

    // The pass condition for the win-rate dashboard: no power may win more
    // than this share of games. 1/7 = 14.3%, so 0.25 allows a strong power
    // without allowing a dominant one.
    MAX_WIN_SHARE: 0.25,

    // ...and none may fall below this. A power that never wins is a bug in
    // the map, not a personality.
    MIN_WIN_SHARE: 0.04,

    // Target mean game length in sim-seconds, and the tolerance band. 15
    // minutes is the design's implied session; the band is wide because game
    // length is the least sensitive of the three dashboard numbers.
    TARGET_GAME_SECONDS: 900,
    GAME_SECONDS_TOLERANCE: 300,
  },

  // -------------------------------------------------------------------------
  // 12. Development — 04-development.md
  //
  // "A use for units that only pays if they are standing still." Two halves of
  // one rule: SPEND units once to build a tier, and the tier only OPERATES
  // while a garrison stands in the station. Build is the sink, garrison is the
  // rent.
  //
  // EVERY NUMBER HERE IS A SHAPE, NOT A VALUE (04-development.md §10.1). The
  // cost curve is argued from the growth curve and is meant to survive
  // balancing; FORT_POWER_PER_TIER is a first guess derived below and is the
  // one to move.
  // -------------------------------------------------------------------------
  DEV: {
    // Build cost as a FRACTION OF THE STATION'S OWN CAPACITY, never flat.
    // Capacity runs 13 to 74 on the live map, a 5.7x spread, so a flat cost
    // would make development routine for industrial powers and impossible
    // everywhere else — which sharpens exactly the rich-get-richer problem
    // 04-development.md §7 is worried about.
    //
    // The curve is chosen for three properties, in order of importance:
    //   1. tier 1 paid from a FULL station lands you at cap/2, which is peak
    //      growth. The first investment has to be genuinely affordable or
    //      development is a late-game luxury.
    //   2. tier 3 costs a whole capacity, so it CANNOT be paid without first
    //      pushing into the overflow band (units above 1.0x cap). That gives
    //      the 5.6b overflow mechanic a purpose it currently lacks.
    //   3. 2.25x capacity all in. A tier-3 fortress should be rare.
    COST_FRACTION: [0.50, 0.75, 1.00],

    // Operating tier = floor(garrison / (this * capacity)), capped at the tier
    // actually built. A quarter of capacity per tier: 75% garrisoned operates
    // at 3, 50% at 2, 25% at 1, below that nothing.
    //
    // Legible straight off the number already printed on the node, which
    // matters because 00-vision.md §8 says the number IS the interface.
    OPERATE_FRACTION: 0.25,

    // A build may never take a station below this. A station at zero is
    // capturable by anyone who walks past, and a build command must not be a
    // way to lose a city by accident.
    MIN_REMAINING: 1.0,

    // Highest tier buildable, by kind. Fortification is capped at 2 EVERYWHERE
    // EXCEPT CAPITALS (below), because it is available at all 108 stations
    // while its counter — the factory — is available at 16. Defensive
    // development seven times more available than the thing that answers it is
    // how a board freezes (04-development.md §7).
    MAX_TIER: { fort: 2, port: 3, factory: 3 },

    // Capitals alone may fortify to tier 3. Seven stations on a 108-station
    // board, and capital-ness is a STATIC property of the station rather than
    // of whoever holds it — a captured Berlin is still eligible, and
    // eligibility never moves during a game. A rule that shifted as capitals
    // fell would make the ceiling a moving target the player cannot plan
    // against.
    //
    // WATCH THIS ONE. 00-vision.md §7 makes capitulation the mercy rule, and
    // tier-3 capital defence puts a wall in front of its trigger. If Milestone
    // 6 shows the endgame dragging, FORT_POWER_PER_TIER at capitals is the
    // first constant to cut.
    CAPITAL_FORT_MAX_TIER: 3,

    // Fortification's effect: additive defence power per OPERATING tier, on
    // top of the station's own fortLevel. ADDITIVE, never multiplicative —
    // 00-vision.md §5 is explicit that a multiplicative fortress is
    // mathematically untakeable and freezes the map.
    //
    // Derived rather than picked: it is expressed in the same units as
    // DEFENSE_BONUS_POWER (6.0 per point of fortLevel, which the comment there
    // measures as ~12 infantry for a 3.5-defense citadel). 0.5 per tier means
    // a tier-2 fort adds one full point of fortLevel — the difference between
    // a plain holding city and a light fortress — and a tier-3 capital adds
    // 1.5, which is half a citadel. It goes through the SAME artillery-strip
    // and scale-in path as the existing bonus, so an unmanned development is
    // not a ghost army.
    FORT_POWER_PER_TIER: 0.5,

    // INTERDICTION — losses per tick, per OPERATING tier, on a hostile wave
    // making its final approach to a fortified station.
    //
    // "A fortified location should cause attrition of enemy units when
    // approaching the target to attack." The design already wanted this and
    // already argued for it: 06-movement-and-attrition.md §6 decided that
    // fortification must tax armies rather than only absorb them, because
    // 04-development.md §7's stalemate risk — fortification available at 108
    // stations against a factory counter at 16 — is answered by a fortress that
    // PROJECTS. "A fortress that projects outward is not a turtle." Walls stop
    // being a way to avoid the game and become a way to shape where the enemy
    // can afford to walk.
    //
    // 0.0005 per tick per tier. Compounded over a ~200-tick approach that is
    // ~10% of the assault at tier 1, ~18% at tier 2, ~26% at a tier-3 capital.
    // Worth paying to go around; not enough to make a fortress untakeable, which
    // 00-vision.md §5 forbids outright.
    //
    // OPERATING tier, not built — an ungarrisoned fortification projects nothing,
    // exactly as it adds no defensive power. Manning the wall is what makes it a
    // wall.
    //
    // UNTUNED, and the first number to move if playtesting shows the board
    // freezing. It is one constant and it is isolated.
    FORT_APPROACH_LOSS: 0.0005,
  },

  // -------------------------------------------------------------------------
  // 13. Passage and march attrition — 06-movement-and-attrition.md, roadmap B1
  //
  // THE KEYSTONE. Before this, `_moveCanTraverse` was `st.owner === pid`: a wave
  // could only walk on ground its owner already held, so "multi-hop" was a claim
  // §8 made and the game did not honour. Opening it is what makes the AI's
  // horizon real, makes fog load-bearing (you can march where you cannot see),
  // and makes encirclement reachable for the first time.
  // -------------------------------------------------------------------------
  PASSAGE: {
    // THE TOLL, charged ONCE on ENTERING a station the wave does not own, as a
    // multiple of that station's full defensive power.
    //
    // WRITTEN AS A RELATIONSHIP, NOT A BOOLEAN (§6). `own` and `hostile` are the
    // only cases that exist, `neutral` sits between them, and `ally` is where a
    // future team system plugs in at zero cost. Retrofitting a relationship into
    // an `owner === pid` test is the expensive order, so it is written this way
    // now while it is free.
    //
    // ABSOLUTE, NOT FRACTIONAL, for exactly the reason §2 gives for march
    // attrition: a fractional toll costs every stack the same PERCENTAGE, so mass
    // buys nothing and distance is free to anyone. An absolute toll kills the raid
    // and barely troubles the army. Reach is bought with mass.
    TOLL_OWN: 0,
    TOLL_NEUTRAL: 0.05,
    TOLL_HOSTILE: 0.15,

    // How much a unit of expected toll is worth in ROUTE distance.
    //
    // The router has to price the detour or "pay the toll and go around" is not a
    // choice the player can express — they pick a target, not a path. 6.0 makes
    // crossing a typical held front worth roughly a two-hop detour.
    //
    // COARSE ON PURPOSE, and this is the load-bearing implementation note:
    // routing weight depends on OWNERSHIP ALONE, never on garrison size, because
    // the route cache is keyed by `ownerEpoch` and garrisons change every single
    // tick. A weight that read stationPower() would either be stale on every
    // route or throw the cache away sixty times a second. The toll actually
    // CHARGED does scale with the real garrison; only the router's estimate is
    // blunt.
    TOLL_ROUTE_WEIGHT: 6.0,

    // MARCH ATTRITION — flat units per tick in transit, never a fraction.
    //
    // §2 is emphatic and the reasoning is the whole design: fractional attrition
    // costs a 10-unit raid and a 200-unit army the same 8%, so distance is free
    // to anyone. Flat costs them the same absolute amount — the raid dies, the
    // army arrives at 95%. Deep strikes become a thing armies do, and a long
    // march is a commitment whose size you can see before making it.
    //
    // This is also what deletes the sea as a special system (§3): a sea link is
    // already 3.2x slower, so it already costs 3.2x the attrition, with no sea
    // rule at all.
    //
    // 0.004/tick is ~0.4 units over a 100-tick hop. A 10-unit raid loses 4% on a
    // short hop and cannot cross the map; a 200-unit army will not notice.
    // UNTUNED — §7 says the tell is the mean hops from border to target, and if
    // that is still 1 after this ships the numbers are wrong, not the design.
    MARCH_LOSS_PER_TICK: 0.004,
  },
};
