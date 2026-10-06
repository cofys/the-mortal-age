# Woodcutting depth — "every life is a full game"

`Woodcutting.plugin.js` is the OSRS-faithful base (axes, trees, stumps, nests,
the guild, ents, the shrine). These modules make a woodcutter's life a complete
game: denser progression, grove/location tradeoffs, risk/reward, changing
weather, a social rumor layer, timber for the war effort, and mastery that
changes quality and opportunity.

## Modules (attach order matters)

`Woodcutting.plugin` attaches them in this order; each enriches the shared
events for the next:

| # | Module | Listens | Sets on the event |
| - | ------ | ------- | ----------------- |
| 1 | `Groves.Woodcutting` | `woodcutting:cut-chance`, `woodcutting:success` | `event.grove`, `event.drive` |
| 2 | `Weather.Woodcutting` | both, `woodcutting:nest-roll` | `event.conditions = { weather, timeOfDay, storm }` |
| 3 | `Wilderness.Woodcutting` | both | `event.wilderness`, `event.prime` |
| 4 | `Mastery.Woodcutting` | both | quality XP, bonus logs, guild rep |
| 5 | `Supply.Woodcutting` | `firemaking:success`, `economy:demand`, `kingdom:war-demand` | `economy:item-sink`, `kingdom:supply-donated` |
| - | `Rumors.Woodcutting` | (shared helper, not attached) | citizen rumor + gossip seeding |

Three seams were added to `Woodcutting.plugin.js` (additive only):
- `rollLog(..., context)` emits **`woodcutting:cut-chance`** per chop roll:
  `{ player, tree, axe, level, chance, multiplier, location: {x,y,z} }`.
  Listeners multiply `event.multiplier`; `multiplier <= 0` fails the roll.
- `woodcutting:success` gained fields: `treeName`, `axeId`, `xpReward`,
  `location: {x,y,z}` (it already carried `logId`).
- `maybeDropBirdNest(player)` emits **`woodcutting:nest-roll`**
  `{ player, multiplier }` before rolling; the nest chance scales with it.

## Method / location tradeoffs

| Grove | Character |
| ----- | --------- |
| Seers' Village groves (Kandarin) | yews, maples, willows; safe, bank nearby; the steady living |
| Lumbridge pines (Misthalin) | fast young wood, safe; the learner's grove (+5% cut) |
| Woodcutting Guild grounds (Kandarin) | yew/magic/redwood; the guild's +7 invisible boost already applies |
| The Blightwood, Haunted Woods (Morytania) | blisterwood; +20% cut, +10% XP — the woods are haunted |
| The Frozen Copse, near Weiss | arctic pine; +10% cut, far from everything |
| Wilderness (see below) | +25% always, 8% prime logs (double XP) — and PKers |

## The Timber Drive (migrating hotspot)

The crown's timber gangs move around the great groves. Every so often one grove
becomes the drive: ~30 minutes of +50% cut chance and +50% XP, and every log cut
there is hauled straight to the war effort (`kingdom:supply-donated`, timber).
No global broadcast — the arrival and departure seed citizen rumors and gossip,
so woodcutters learn it from the world and the first axe there gets rich.

## Changing conditions

- **Weather**: the world's one weather machine (fishing's `Conditions.Fishing`
  exposes it; woodcutters read the same sky). Rain softens the earth (+10%
  cut), overcast is kind (+5%), storms whip the canopy (−15% cut) but shake
  nests loose (double nest chance) and bring down windfall logs (8% bonus log
  per success). Master Foresters fell straight through storms.
- **Time of day** (server clock): dawn wakes the birds (1.5× nest chance).
- **Kingdom forestry policy**: while a kingdom's quartermaster cries for
  supplies (`kingdom:war-demand` within the last 30 minutes), that kingdom's
  groves work wartime quotas — +15% XP, and citizens talk about it.

## Risk / reward

- **Wilderness**: +25% cut chance, prime logs, stacking with storm/drive.
  The Wilderness charges its usual price (PK danger + the 35% death-destruction
  sink).
- **Storms**: the fastest nest hunting in the game, paid for in missed cuts —
  unless the guild calls you Master.

## Mastery

- **Quality grades** per log: knotty (low level, flavor), straight (50+,
  +25% XP), heartwood (75+, +50% XP, often a bonus log), ancient heartwood
  (90+, 1%, double XP, bonus log, +10 rep).
- **Guild reputation** (`woodcutting:guild-reputation`, persisted): earned from
  fine logs, storms, wilderness primes and timber drives. 50 = Forester,
  200 = Master Forester (storm cut-penalty immunity), 500 = Legendary Forester.
- **Hidden grove**: the Ape Atoll teak/mahogany grove cuts better for
  guild-vouched foresters (×1.15 / ×1.35 / ×1.5).

## Economy feed

- Logs burned emit `economy:item-sink` (consumables, "burned") for the exact
  log, so the price feed feels real consumption — including wartime firewood.
- Timber-drive logs emit `kingdom:supply-donated` (timber): the quartermaster's
  stockpile in the kingdom sim grows from real axes — palisades and siege
  engines, not numbers.
- Bulk `economy:demand` for logs (100+) becomes a citizen rumor, carrying the
  demand board's signal to the groves.
- `kingdom:war-demand` becomes a rumor ("the crown wants timber") and nudges
  the next timber drive toward the hungry kingdom's groves.

## Tuning

All rates live in the module headers: `Groves` (grove rects, drive durations,
multipliers, quota window), `Weather` (storm/rain/overcast/dawn effects),
`Wilderness` (prime chance), `Mastery` (grade thresholds, tier rep, hidden
grove), `Supply` (`BULK_DEMAND`). Pure helpers (`groveAt`, `isActiveAt`,
`driveActiveAt`, `gradeLog`, `tierFor`, `isStormImmune`, `isInWilderness`) take
injectable arguments for testing. Grove rects are drawn on real OSRS geography
(the world comes from the cache; `object-spawns.json` is empty).
