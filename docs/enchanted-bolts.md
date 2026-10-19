# Enchanted bolts

The special effects of enchanted bolts (https://oldschool.runescape.wiki/w/Enchanted_bolts) fired from a crossbow, plain and dragon bolts alike. The plugin is `server/plugins/combat/EnchantedBolts.plugin.js` and its data is `server/plugins/combat/data/enchanted-bolts.json`. It replaces the bolt code that used to sit in `RangedData.getSpecialEffectsMultiplier`. That code was a flat 1-in-10 roll with leftover values from a 10x-hitpoints server.

Sources: the OSRS Wiki pages for each bolt and the Wiki DPS calculator (weirdgloop/osrs-dps-calc, `src/lib/dists/bolts.ts`) for the maths, the Wiki's sound file pages for the sound ids, and rsprox captures (https://rsprox.net/database) for when the graphic and sound are sent. The captures cover ruby bolts (recordings 89, 90 and 91) and onyx bolts (550, 1768 and 1862). The other eight bolts have no captures, so their graphics and sounds follow the same pattern.

## How it works

- **Hook:** a new core hook, `api.onCombatHitDamage`, fires once for each hitsplat. It runs after the accuracy and damage rolls and before the damage is capped to the target's hitpoints. A handler may change `damage` (a `HitDamage`) and `accurate`, and the hit keeps both.
- **On the shot:** the effect is rolled with the shot and changes that hitsplat.
- **When the bolt lands:** some effects wait for `onCombatHitResolved`: Blood Forfeit's cost, Life Leech's heal, Magical Poison, the prayer and Magic drains, and the jade knock-down.
- **Which shots:** only weapons whose profile has `boltEffects` (crossbows other than Karil's). The bolt is found from the ammunition actually fired, by item name, so every variant counts.
- **Chance:** a Hard Kandarin Diary multiplies every chance by 1.1 (`diary:is-complete`). The Armadyl crossbow special doubles it (`enchantedBoltEffectChanceMultiplier`). The Zaryte crossbow special makes the effect certain on a successful hit (`guaranteedEnchantedBoltEffect`).
- **Testing:** `::boltproc` (developer) forces the next shot's effect.

## From the captures

- **Timing:** the proc spotanim on the target and its sound reach the shooter on the tick the bolt is fired, not when it lands. Both carry a delay equal to the hit's flight time in ticks: 1 at 1-2 tiles, 2 at 3-8 and 3 at 9 (`1 + floor((3 + distance) / 6)`). Ruby: spotanim `xbows_blood_sacrifice_spot_anim` (754), synth 2911. Onyx: `xbows_life_leach_spot_anim` (753), synth 2917.
- **Ruby cost:** Blood Forfeit's cost to the shooter is a normal hitsplat. It lands on the same tick as the bolt's hit on the target.

## Effects

| Bolt | Effect | Chance (NPC / player) | Ignores accuracy | What it does |
| --- | --- | --- | --- | --- |
| Opal | Lucky Lightning | 5% / 5% | yes | + visible Ranged / 10 (/ 9 with a Zaryte crossbow) |
| Jade | Earth's Fury | - / 6% | yes | Players only: knocked down (stunned) for 8 ticks. Blocked by Protect from Magic. Dodged by Agility: -16% at level 1 to 110% at 99 |
| Pearl | Sea Curse | 6% / 6% | yes | + Ranged / 20, or / 15 against fiery targets (2 less with a Zaryte crossbow). A water staff wielder is immune. A fire staff or fire cape makes a player fiery |
| Topaz | Down to Earth | - / 4% | yes | Players only: Magic -1 |
| Sapphire | Clear Mind | 25% / 5% | no | Monsters: the shooter regains floor(floor(monster Ranged / 10) / 8) prayer. Players: drains floor(shooter Ranged / 20), capped at the target's remaining hitpoints, and the shooter gains half |
| Emerald | Magical Poison | 55% / 54% | no | 5-damage poison (6 with a Zaryte crossbow) |
| Ruby | Blood Forfeit | 6% / 11% | yes | The hit becomes 20% of the target's current hitpoints, at most 100 (22% and 110 with a Zaryte crossbow). Costs the shooter 10% of their hitpoints; not used if that is under 1 |
| Diamond | Armour Piercing | 10% / 5% | yes | A hit between 0 and 115% of the max hit (126% with a Zaryte crossbow) |
| Dragonstone | Dragon's Breath | 6% / 6% | no | + Ranged x 2 / 10 (/ 9 with a Zaryte crossbow). Fiery and dragon monsters are immune, and so are players with antifire, an anti-dragon shield or Protect from Magic |
| Onyx | Life Leech | 11% / 10% | no | A hit between 0 and 120% of the max hit (132% with a Zaryte crossbow); heals the shooter a quarter of the damage dealt. Not on the undead |

The ten sound ids, from the Wiki's sound file pages: opal 2918, jade 2916, pearl 2920, topaz 2914, sapphire 2912, emerald 2919, ruby 2911, diamond 2913, dragonstone 2915, onyx 2917.

## Not done

- **Jade against monsters:** the Wiki's chance table gives jade a 6% chance against monsters, but its Stun page calls Earth's Fury a PvP effect. Jade only procs against players here.
- **Ruby special cases:** Ruby's lower cap on monsters with infinite hitpoints, and the Corporeal Beast taking a ruby proc in full, need those fights to say so.
- **Other players' sounds:** whether bystanders or a PvP target hear the proc sound isn't captured. Only the shooter gets it.
