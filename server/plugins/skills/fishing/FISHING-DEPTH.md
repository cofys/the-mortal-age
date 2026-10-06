# Fishing depth — "every life is a full game"

`Fishing.plugin.js` is the OSRS-faithful base (tools, spots, charts, guild, angler
outfit, minnows). These modules make a fisherman's life a complete game: denser
progression, method/location tradeoffs, risk/reward, changing conditions, a social
rumor layer, economy output, and mastery that changes quality and opportunity.

## Modules (attach order matters)

`Fishing.plugin` attaches them in this order; each enriches the shared events for
the next:

| # | Module | Listens | Sets on the event |
| - | ------ | ------- | ----------------- |
| 1 | `Conditions.Fishing` | `fishing:catch-chance`, `fishing:success` | `event.conditions = { weather, timeOfDay, storm }` |
| 2 | `ShoalRun.Fishing` | both | `event.shoalRun = true` |
| 3 | `Wilderness.Fishing` | both | `event.wilderness`, `event.prime` |
| 4 | `Mastery.Fishing` | both | quality XP, bonus fish, guild rep |
| 5 | `Supply.Fishing` | `cooking:*`, `economy:demand` | `economy:item-sink` emissions |
| - | `Rumors.Fishing` | (shared helper, not attached) | citizen rumor + gossip seeding |

Two seams were added to `Fishing.plugin.js` (additive only):
- `rollCatch(..., context)` emits **`fishing:catch-chance`** per roll:
  `{ player, tool, fish, roll, level, bonus, multiplier, spot: {x,y,npcId} }`.
  Listeners multiply `event.multiplier`; `multiplier <= 0` would block the catch.
- `fishing:success` gained fields: `fishId`, `toolId`, `variantBonus`, `baitId`,
  `fish: { id, experience, name }`. (The aerial-hunter emitter omits them; depth
  modules skip gracefully.)

## Method / location tradeoffs

| Water | Method | Character |
| ----- | ------ | --------- |
| Rivers | fly rod, barbarian rod | safe, common fish; dawn/dusk "the rise" (+25%); active methods train +XP via quality |
| Shore | small net, bait rod, lobster pot | safe, steady; rain helps (+15%) |
| Deep water | harpoon, big net, dark-crab cage | slow, rare, valuable; storms are its season (+40%) but threaten gear |
| Caves | eel rods | night bonus (+15%), never see weather |
| Wilderness | dark crab (Cage-only spots) | +25% always, 8% prime catches (double XP) - and PKers |

## Changing conditions

- **Time of day** (server clock): dawn 5-8, day 8-17, dusk 17-20, night otherwise.
  Dawn/dusk favor river fish; night favors eels and deep water.
- **Weather**: a Markov state machine rolled every ~30 min
  (clear -> overcast -> rain -> storm -> ...). Storms: +40% deep-water bites,
  +50% XP, but 10%/catch bait loss, 3% knockback (session ends), 1% loss of a
  *plain* tool (never dragon/crystal/infernal). Storm arrivals and endings go
  out as citizen rumors.
- **Bait shifts**: storms and shoal runs strip bait faster (extra bait per
  catch), so bait stocking is a real decision.

## The Run (shoal migration)

A great shoal gathers at one of six grounds (River Lum, Barbarian Village,
Shilo Village, Catherby shore, Fishing Guild docks, Piscatoris) for ~30 min,
then vanishes for 15-40 min before appearing elsewhere. At the run: +50% catch
chance, +50% XP, double bait consumption. No global broadcast - the arrival and
departure seed citizen rumors and gossip, so players learn it from the world
and the first finder gets rich.

## Risk / reward

- **Wilderness**: +25% catch chance, prime catches, stacking with storm/night.
  The Wilderness charges its usual price (PK danger + the 35% death-destruction
  sink).
- **Storms**: the best deep-water fishing in the game, paid for in bait, footing
  and cheap tools.

## Mastery

- **Quality grades** per catch: small (<20), standard, large (50+, +25% XP),
  huge (75+, +50% XP, sometimes a bonus fish), trophy (90+, 1%, double XP,
  bonus fish, +10 rep).
- **Guild reputation** (`fishing:guild-reputation`, persisted): earned from big
  catches, storms, wilderness primes and shoal runs. 50 = Angler, 200 = Master
  Angler (storm gear immunity, hidden spots x1.35), 500 = Legendary Angler
  (hidden spots x1.5).
- **Hidden spots**: Ape Atoll, Burgh de Rott, Oo'glog marks that fish better
  for guild-vouched anglers.

## Economy feed

- Cooked or burnt fish emits `economy:item-sink` (consumables) for the raw fish:
  the price feed reacts to real eating, so fishermen's income moves with the
  world's appetite - including war-ration demand.
- Bulk `economy:demand` for fish (100+) becomes a citizen rumor, carrying the
  demand board's signal to the docks.

## Tuning

All rates live in the module headers: `Conditions` (weather transitions, storm
chances), `ShoalRun` (durations, multipliers), `Wilderness` (prime chance),
`Mastery` (grade thresholds, tier rep), `Supply` (`BULK_DEMAND`). Pure helpers
(`getTimeOfDay`, `rollWeather`, `habitatOf`, `isActiveAt`, `gradeCatch`,
`tierFor`, `isInWilderness`) take injectable arguments for testing.
