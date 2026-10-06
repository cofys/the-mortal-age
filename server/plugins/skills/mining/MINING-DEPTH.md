# Mining depth — "every life is a full game"

`Mining.plugin.js` is the OSRS-faithful base (pickaxes, rocks, cycles,
depletion, essence). These modules make a miner's life a complete game: denser
progression, mine/location tradeoffs, risk/reward, underground hazards, a
social rumor layer, ore for the war effort, and mastery that changes quality
and opportunity.

## Modules (attach order matters)

`Mining.plugin` attaches them in this order; each enriches the shared events
for the next:

| # | Module | Listens | Sets on the event |
| - | ------ | ------- | ----------------- |
| 1 | `Mines.Mining` | `mining:ore-yield`, `mining:success` | `event.mine`, `event.vein` |
| 2 | `Hazards.Mining` | both | `event.stop` (cave-in) |
| 3 | `Wilderness.Mining` | both | `event.wilderness`, `event.prime` |
| 4 | `Mastery.Mining` | both | quality XP, bonus ore, guild rep |
| 5 | `Supply.Mining` | `smelting:success`, `economy:demand` | `economy:item-sink`, `kingdom:supply-donated` |
| - | `Rumors.Mining` | (shared helper, not attached) | citizen rumor + gossip seeding |

Three seams were added to `Mining.plugin.js` (additive only):
- `awardOre(player, state)` emits **`mining:ore-yield`** before the ore lands:
  `{ player, rock, pickaxe, multiplier, bonusOre, location: {x,y,z} }`.
  Listeners add `bonusOre` (rich veins, prime strikes) or scale the XP via
  `multiplier`; both are honored.
- `mining:success` gained fields: `oreId`, `rockName`, `bonusOre`,
  `location: {x,y,z}`, and `stop` (false) — a listener may set `event.stop`
  to end the session after the yield (cave-ins).
- `awardOre` is exported for tests, mirroring fishing's `rollCatch`.

## Method / location tradeoffs

| Mine | Character |
| ---- | --------- |
| Dwarven Mine, under Falador (Asgarnia) | iron/coal/tin/copper; safe, crowded; the steady living |
| Mining Guild, under Falador (Asgarnia) | coal; guild-kept (+5% XP), bank nearby |
| Al Kharid mine (Misthalin marches) | copper/tin/iron/silver; safe, hot, far from a bank |
| Keldagrim mines (Keldagrim) | coal/iron/mithril; +10% XP, the city that never sees the sun |
| The Deep Delve, Living Rock Caverns (Keldagrim roads) | mithril/adamantite; +15% XP, rich seams — cave-ins and living rock |
| Wilderness (see below) | +25% XP always, 8% prime ore — and PKers |

## The Rich Vein (migrating hotspot)

A rich vein surfaces in one mine at a time for ~30 minutes: every yield there
lands a bonus ore and +50% XP. Nobody is told directly — arrival and departure
seed citizen rumors and gossip, so the first pick there gets rich, and every
load feeds the war effort (`kingdom:supply-donated`, ore).

## Changing conditions

- **Cave-ins**: the Deep Delve (and the hidden deep workings) are dug too deep
  and too fast. Each yield there risks a cave-in — damage and the session ends.
  Master Prospectors read the rock and never get caught.
- **Gas pockets**: deep yields sometimes vent gas — a warning crack, then damage
  if you keep swinging. (Same immunity.)
- **Kingdom mining policy**: while a kingdom's quartermaster cries for supplies
  (`kingdom:war-demand` within the last 30 minutes), that kingdom's mines work
  wartime quotas — +15% XP, but the quotas push men deeper and cave-in risk
  doubles. Citizens talk about it.
- Weather never reaches underground: the mines are exempt from the sky, the way
  fishing's cave spots are.

## Risk / reward

- **Wilderness**: +25% ore XP, prime ore (double XP + bonus ore), stacking with
  vein and quotas. The Wilderness charges its usual price (PK danger + the 35%
  death-destruction sink).
- **The Deep Delve**: the richest mining in the game, paid for in rock falls
  and living rock — unless the guild calls you Master.

## Mastery

- **Quality grades** per ore: flawed (low level, flavor), pure (50+, +25% XP),
  pristine (75+, +50% XP, often a bonus ore), perfect (90+, 1%, double XP,
  bonus ore, +10 rep).
- **Guild reputation** (`mining:guild-reputation`, persisted): earned from fine
  ore, cave-ins survived, wilderness primes and rich veins. 50 = Prospector,
  200 = Master Prospector (cave-in and gas immunity), 500 = Legendary
  Prospector.
- **Hidden delves**: the old deep workings under the Dwarven Mine yield better
  for miners the guild vouches for (bonus-ore chance ×1.15 / ×1.35 / ×1.5).

## Economy feed

- Ore smelted emits `economy:item-sink` (industry, "smelted") per ingredient
  ore, so the price feed feels real consumption — every steel bar ate iron and
  coal the world must replace.
- Rich-vein loads emit `kingdom:supply-donated` (ore): the quartermaster's
  stockpile in the kingdom sim grows from real picks.
- Bulk `economy:demand` for ore (100+) becomes a citizen rumor, carrying the
  demand board's signal down the shafts.

## Tuning

All rates live in the module headers: `Mines` (mine rects, vein durations,
multipliers, quota window), `Hazards` (cave-in/gas chances, damage),
`Wilderness` (prime chance), `Mastery` (grade thresholds, tier rep, hidden
delves), `Supply` (`BULK_DEMAND`, bar→ore map). Pure helpers (`mineAt`,
`isActiveAt`, `veinActiveAt`, `gradeOre`, `tierFor`, `isCaveInImmune`,
`isInWilderness`) take injectable arguments for testing. Mine rects are drawn
on real OSRS geography (the world comes from the cache).
