# Mining rocks

`plugins/skills/Mining.plugin.js` mines the ore rocks (clay to runite, blurite, barronite, the essence mines).
Pickaxe-specific rules are in `plugins/skills/mining/`.

## What live OSRS does

From rsprox captures (recordings 3139 and 3182, iron rocks, rev 232) unless another source is named.

| Moment | Live response |
| --- | --- |
| Click on a rock | The first swing lands the tick after the click (after arrival, if the player walked): `You swing your pick at the rock.` and the pickaxe animation, both at +1 |
| Ore received | `You manage to mine some iron.` (the ore's word; copper, tin, clay, silver, coal, gold, mithril and adamantite are recorded too, some on Leagues worlds), sound 3600, the rock turns into `rocks1`/`rocks2`, `tracking_ore_mined` goes up by one |
| Depletion | `add_overlaytimer_loc` (cache script 5474) is run for the miner with the depleted loc and the respawn in ticks (recordings 3139 and 3182: 9 for iron) |
| Infernal pickaxe | When the ore combusts: `smokepuff` (height 150), sound 2725, no ore and no `tracking_ore_mined` change; the usual mining message and sound 3600 still come (recording 3139) |
| Click on a depleted rock | `There is currently no ore available in this rock.` as a game message (recording 3139) |
| No usable pickaxe | Message box: `You need a pickaxe to mine this rock. You do not have a pickaxe which you have the Mining level to use.` (recording 73, iron rocks) |
| Level too low | Message box: `You need a Mining level of 55 to mine this rock.` (recording 3280, mithril, a Leagues world; the Wiki gives the same level) |
| Full inventory | Message box, `Your inventory is too full to hold any more <item>.` (recording 70, rune essence, a Leagues world; no recording has the message for an ore rock, so the ore's lowercase item name is the same pattern applied to it) |

Each pickaxe swings its own sequence (`human_mining_<pickaxe>`): dragon 7139, infernal 4482, crystal 8347 and
black 3873 are recorded (recordings 561, 1634, 3276 and 90); mithril 629 and adamant 628 follow the cache names
(mithril is recorded in 1098; the plugin had these two swapped, and gave dragon, crystal and infernal the rune
animation and black the steel one).

The depleted loc is named after the rock's own variant: `ironrock2` becomes `rocks2`,
`ironrock1` becomes `rocks1` (recordings 3139, 3182; copper and mithril rocks in Leagues recordings follow the same pattern). The plugin
reads the digit from the rock's gameval, so every rock with a `...rock<digit>` name follows without a table.

## Levels, experience and respawn

OSRS Wiki rock pages (https://oldschool.runescape.wiki/w/Iron_rocks, `/w/Copper_rocks`, `/w/Tin_rocks`,
`/w/Clay_rocks`, `/w/Silver_rocks`, `/w/Coal_rocks`, `/w/Gold_rocks`, `/w/Mithril_rocks`,
`/w/Adamantite_rocks`, `/w/Runite_rocks`). Respawn is seconds divided by 0.6, rounded to ticks:

| Rock | Level | XP | Respawn |
| --- | ---: | ---: | --- |
| Clay | 1 | 5 | 2 ticks |
| Copper, tin | 1 | 17.5 | 2.4 s (4 ticks) |
| Iron | 15 | 35 | 5.4 s (9 ticks; recordings 3139, 3182 agree) |
| Silver | 20 | 40 | 1 min (100 ticks) |
| Coal | 30 | 50 | 30 s (50 ticks) |
| Gold | 40 | 65 | 1 min (100 ticks) |
| Mithril | 55 | 80 | 2 min (200 ticks) |
| Adamantite | 70 | 95 | 4 min (400 ticks) |
| Runite | 85 | 125 | 12 min (1200 ticks) |

Recording 3280's live message agrees with mithril's level 55.

## Rolls and success chance

The pickaxe decides how often the game rolls, the Mining level decides the chance of each roll
(Wiki https://oldschool.runescape.wiki/w/Pickaxe and https://oldschool.runescape.wiki/w/Mining, quoting Mod Ash:
"Your level affects the chance of getting ore each time the game rolls; your pickaxe affects how often that happens.").

- **First roll:** with the skilling timer clear, the tick after the swing message, so +2 after arrival
  (recordings 3139 and 3182, iron, where a high level succeeds on every roll: the ore came the tick after the
  swing message in 33 of 34 attempts with infernal pickaxes; the one dragon pickaxe attempt, in 3182, two ticks after).
- **Ticks between rolls** (Wiki Pickaxe): bronze 8, iron 7, steel 6, black and mithril 5, adamant 4, rune 3,
  dragon and infernal 3 with a 1/6 chance of 2, crystal 3 with a 1/4 chance of 2. The early roll is members-only
  (Wiki Pickaxe changes, 4 May 2022).
- **The timer carries over:** a roll on the next rock waits for the previous roll's interval to run out
  (Wiki https://oldschool.runescape.wiki/w/Tick_manipulation, skilling timer).
- **Chance per roll** (Wiki https://oldschool.runescape.wiki/w/Skilling_success_rate):
  `(1 + floor(low × (99 − L) / 98 + high × (L − 1) / 98 + 0.5)) / 256`, capped to 0-1. The visible level counts
  up to 99; invisible boosts (the celestial ring's +4) add on top and count past 99 (Wiki Skilling success rate,
  Boosts over 99; https://oldschool.runescape.wiki/w/Mining_Guild).

Low and high values from each rock's Wiki skilling success chart (the rock pages above, plus
https://oldschool.runescape.wiki/w/Blurite_rocks and https://oldschool.runescape.wiki/w/Barronite_rocks):

| Rock | Low | High |
| --- | ---: | ---: |
| Clay | 128 | 400 |
| Copper, tin | 100 | 350 |
| Blurite | 90 | 350 |
| Iron | 96 | 350 |
| Barronite | 80 | 100 |
| Silver | 25 | 200 |
| Coal | 16 | 100 |
| Gold | 7 | 75 |
| Mithril | 4 | 50 |
| Adamantite | 2 | 25 |
| Runite | 1 | 18 |

The Runite rocks page checks the formula: 17/256 at level 85 and 19/256 from 97.

Sandstone and granite charts cascade (Wiki https://oldschool.runescape.wiki/w/Sandstone_rocks,
https://oldschool.runescape.wiki/w/Granite_rocks): the biggest piece is rolled first and each failed roll falls
through to the next size; failing them all gives nothing. Sandstone 10kg 4/50, 5kg 8/75, 2kg 16/100, 1kg 25/200;
granite 5kg 6/64, 2kg 8/75, 500g 16/100.

Rune essence rocks succeed on every roll (Wiki https://oldschool.runescape.wiki/w/Pure_essence, Mod Ash).

## Gems while mining

Before each ore roll on the ore rocks above (not sandstone, granite or essence), a 1/256 gem roll; a charged
amulet of glory (glory(1)-(6), (t1)-(t6), eternal) adds a 3/256 roll when it misses
(Wiki https://oldschool.runescape.wiki/w/Template:MiningPreGemDropTable). A hit gives nothing (70/128), an uncut
sapphire (32), emerald (16), ruby (8) or diamond (2), never the ore, no XP, and the rock stays.

Recording 403 (rev 231): the roll after `You swing your pick at the rock.` gave `You just found a Sapphire!`
and `+uncut_sapphire`, with no mining sound or experience and the mining animation carrying on. Recording 90 (a
Leagues world) has `You just found a Sapphire!` while mining coal rocks, and the Leagues recordings have
`You just found an Emerald!`, `a Ruby!` and `a Diamond!` too.

## Not done

- The Mining Guild halves the respawn of iron, adamantite and runite (Wiki rock pages) and gives an invisible +7
  Mining (Wiki Mining Guild), which needs the guild's members area.
- The skilling timer is Mining's own: other skills' actions (herb tar, food) don't delay it, so tick
  manipulation is not modelled.
- Rune and pure essence rocks keep their own messages; they were not recorded on main-game worlds.
- Other plugins that mine rocks of their own (quests, minigames, stars, Motherlode) keep their wording.
