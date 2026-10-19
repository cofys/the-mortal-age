# Desert heat and waterskins

| Plugin | Contents |
|---|---|
| `server/plugins/areas/DesertHeat.plugin.js` | the heat timer, where it applies, what it does when it strikes |
| `server/plugins/areas/data/desert-heat.json` | the heat's boxes, the shaded towns, armour penalties and heat-resistant clothing |
| `server/plugins/items/Waterskins.plugin.js` | cutting a Kharidian cactus, pouring water into a waterskin |
| `server/plugins/items/CircletOfWater.plugin.js` | the circlet's charges: Charge, Check, Uncharge, the heat protection |
| `server/plugins/world/WaterSources.plugin.js` | waterskins filled at fountains, sinks, wells, pumps, taps and barrels |

Humidify (Lunar) already filled waterskins before this; choc-ice is already a food (heals 7).

**Sources:**
- **rsprox captures:** every recording with a heat strike on a normal world (71 recordings, revs 223–238, 103 strikes), the cactus recordings 328, 329, 1437 and 3018, and the circlet recordings 324, 326, 328, 330–333 and 362. Leagues, event and beta worlds are left out: their relics move players about and change the rules;
- **the OSRS Wiki:** "Desert heat", "Waterskin", "Kharidian cactus", "Choc-ice", "Circlet of water", and Mod Ash's posts quoted there (the 150-tick base and the per-slot penalties, the choc-ice order, the cactus success chance);
- **this cache:** the gamevals of the varbits, sequences and locs below, and every item's category (opcode 94), which the server now decodes.

## The timer (captured)
- **It starts** on the tick a player steps into the heat, at the interval below, and the varbit `buff_bar_desert_heat_timer_iteration` (13137) is set to that interval. The value is only sent when it changes.
- **It strikes** when the interval has run out, then starts again from that tick: a player standing still in rune armour takes a strike exactly every 50 ticks.
- **Interfaces and dialogues hold it:** a strike that falls while a dialogue, interface or the XP drops setup is open waits, and lands on the tick it closes (recording 324: due at tick 319, landed at 431 when the modal closed).
- **Leaving the heat** drops the timer, and so does logging out (Wiki); coming back starts a fresh one.

## Where it applies (captured)
The heat boxes and town boxes in `desert-heat.json` were drawn from the captures: every one of the 103 strikes lies inside the heat, and every stay of a full interval or longer in one small spot with no strike (and no Desert amulet 4) lies outside it.
- **The desert:** x 3136–3519, y 2688–3115, plus y 3116 east of x 3330 and the strip up to y 3132 west of x 3231 (past the Lumbridge desert shortcut, where a captured timer started on arrival at 3214,3132). The Shantay Pass building itself (y 3116 and up at the gate) is outside.
- **Shaded towns:** Nardah, Pollnivneach, Sophanem, Menaphos, the Ruins of Unkah and the Bedabin Camp. The Necropolis is not shaded: strikes were captured in it (the Wiki's trivia agrees, naming the tile in front of the Jaltevas pyramid).
- **Upstairs:** the Agility Pyramid's floors (planes 1–3) and its top at 3036–3052, 4690–4702.
- **Ours:** Pollnivneach and Menaphos have no capture of a long stay; their boxes keep clear of every captured strike. The Desert Mining Camp is left hot: there is no capture either way.

## The interval (captured)
150 ticks, less 10 for a hat, 40 for a torso, 30 for legs, 10 for gloves, 10 for a shield and 10 for boots (Mod Ash). What counts is the item's **cache category**:

| Slot | Category | Counts | Doesn't |
|---|---|---|---|
| Head | 2 | helmets, coifs, slayer helmets | mystic and ancestral hats (10), wizard hats, the max hood |
| Body / legs | 7 / 8 | platebodies, d'hide, masori, leather body and chaps | robes (10), vyre noble clothes |
| Hands | 16 | gauntlets, ferocious and damned gloves, d'hide vambraces | mystic gloves (10), bracelets, leather gloves (0) |
| Shield | 18 | shields, the Elidinis' ward | defenders and the parrying dagger (494), books |
| Feet | 17 | boots, fancy and fighting boots | eternal boots (10), climbing boots, graceful |

The rule matches all 59 distinct gear sets captured with the varbit, from 40 (full crystal with a shield) to 180.

Heat-resistant clothing adds instead, and never counts as armour (Wiki, in ticks): desert outfit, desert clothing and Menaphite clothing 20 a piece (desert boots 10), the desert disguise 20, slave robes 10 (boots 5), the robes of Elidinis 20, the prospector kit 10/20/20/10, and the circlet of water 20 (captured: 170 with the circlet alone). The longest interval is 220 ticks.

**Ours:** the Wiki says gloves count while vambraces don't; leather gloves have no category (0), so they don't count here. No capture has them.

## When it strikes
In this order:
1. **Desert amulet 4** worn: nothing happens (Wiki).
2. **A charged circlet of water** worn: one charge goes, "Your circlet protects you from the desert heat." (spam), `buff_water_circlet_charges` drops by one. Captured even with waterskins in the pack.
3. **A waterskin:** the emptiest one that still holds water loses a dose (captured: the (1) before a (4), then the (3) the (4) became), "You take a drink of water." (spam), human_eat (829), synth 2401.
4. **A choc-ice** (Mod Ash: waterskins come first): one is eaten, healing 7, "You eat a choc ice." (spam), human_eat.
5. **Nothing:** "You should get a waterskin for any travelling in the desert.", then "You start dying of thirst while you're in the desert." (spam), and a hit of 1–10 that shows the next tick with the usual hurt sound. It can kill.

**Not done:** the Wiki says water in bowls, buckets, jugs and vials evaporates on the same timer, but no capture shows it or its message. Choc-ice also melts now and then ("Your choc ice evaporates in the desert heat.", Wiki) with no known rate.

## Kharidian cactus (captured)
"Cut" on a healthy cactus (2670, or 44029):
- **No knife or slashing weapon:** "You need a knife or other slashing weapon to cut the cactus..." A knife in the pack wins over a wielded weapon.
- **A tick after arrival:** human_knife_chop (911) with a knife, human_axe_hack (395) with a weapon, synth 2500, and the cactus turns dry (2671 / 44030) whatever the outcome; it is healthy again after 100 ticks (Wiki: 1 minute).
- **Success** (Wiki: about 12% at level 1 to 99% at 99 Woodcutting): 10 Woodcutting xp, then the emptiest waterskin that isn't full gains a dose, synth 2401, "You top up your skin with water from the cactus." (spam). With none to fill: "You have no empty waterskins to put the water in."
- **Failure:** "You fail to cut the cactus correctly and it gives no water this time." (spam), 0.4 xp (Wiki).

## Filling waterskins (Wiki)
- **Water sources:** a waterskin that isn't full is filled to (4), one per tick, the same way the WaterSources plugin fills other containers ("You fill the waterskin from the fountain.").
- **Other containers:** a bucket (4 doses), bowl (3), jug (2) or vial (1) of water used on a waterskin that isn't full pours into it ("You fill the waterskin."), leaving the empty container. Extra doses are lost.
- **Not captured:** both messages follow the existing water-source wording; no recording shows a waterskin being filled either way.

## Circlet of water (captured)
Five water runes per charge, up to 500,000 (Wiki). The charges are kept on the item (`circlet-of-water:charges`).
- **Charge, or a water rune on it:** "How many charges would you like to add? (0 - N)", N being what the runes pay for. Then an objectbox with the charged circlet: "You add 190 charges to your circlet." on an uncharged one, "You add 90 charges to your circlet. It now has 190 charges." on a charged one. With no runes: "You need some water runes to charge your circlet."
- **Check:** "Your circlet has 190 charges left."
- **Uncharge:** "Are you sure you want to fully uncharge your circlet?" with "Yes." / "No.", then an objectbox: "You fully uncharge your circlet.<br>You regain 950 water runes in the process." With no room for the runes, at once: "You don't have enough room to uncharge your circlet."
- **Worn:** `buff_water_circlet_charges` (14191) holds its charges, 0 when it's taken off.
- **Ours:** a circlet that spends its last charge turns uncharged with no message; the bank's Configure-Charges isn't done.
