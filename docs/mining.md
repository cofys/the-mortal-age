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

## Not done

- The Mining Guild halves the respawn of iron, adamantite and runite (Wiki rock pages), which needs the guild's area.
- Rock and ore success rates are unchanged.
- Rune and pure essence rocks keep their own messages; they were not recorded on main-game worlds.
- Other plugins that mine rocks of their own (quests, minigames, stars, Motherlode) keep their wording.
