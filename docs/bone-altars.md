# Offering bones on altars

`server/plugins/skills/BoneAltars.plugin.js` lets members offer bones on the Chaos Temple's altar (level 38 Wilderness) for extra Prayer experience. Its data is in `server/plugins/skills/data/bone-altars.json`.

The bones and their burying experience come from the Prayer plugin through `prayer:bone` (docs/prayer-bones.md), so every bone that can be buried can be offered. More altars, such as the player-owned house's, would be another row in the data file.

Sources:
- the OSRS Wiki: Chaos Temple (church), Pay-to-play Prayer training, Zealot's robes;
- rsprox captures (<https://rsprox.net/database>):
  - Pray-at on the Chaos Temple altar: recordings 435, 469, 3243, rev 232-233;
  - bones offered on a house altar (`poh_altar_saradomin_1`): recording 2850, rev 230.

There is no capture of bones on the Chaos Temple altar. Its 7,500 captured uses are all Leagues coin sacrifices.

## The altar (Wiki)

| | |
| --- | --- |
| Loc | 411 `chaosaltar` at 2947, 3820, 0 |
| Experience | 3.5 × the bone's burying experience, rounded up as burying is |
| Bone kept | 50% of offerings, with "The Dark Lord spares your sacrifice but still rewards you for your efforts." |
| Members | Yes (free-to-play players can visit but not use it) |

- **Only this altar.** Loc 411 also stands in other chaos temples, which don't take bones, so the altar is matched by its tile.
- **Zealot's robes:** 1.25% per piece worn. Their roll only happens when the altar's own 50% fails (Mod Ash, quoted on the Wiki), so the full set keeps 52.5% of bones. The Wiki gives no message for a robe save, so none is sent.
- **Bones are taken from the top-left** of the inventory, not from the slot used (Wiki, 22 February 2023).
- **Superior dragon bones** need 70 Prayer. The refusal, "You need a Prayer level of 70 to offer these bones.", is ours.
- Noted bones and other items fall through to "Nothing interesting happens."
- The dragonbone necklace and the Catacombs restore don't apply: the Wiki gives them for burying only.

## An offering (captured on a house altar)

The same sequence repeats every 4 ticks while that kind of bone lasts. The first one plays on the tick the player reaches the altar. Walking or clicking anything else stops it, and so does a level-up pop-up, as for other skilling (docs/settings.md). The offering that levels up still plays its animation: the pop-up resets the player's animation, so the experience is given before the offering animates.

Each offering:
- **Player:** faces the altar, plays `human_bone_sacrifice` (3705).
- **Sound:** synth 958.
- **Graphic:** `poh_bone_sacrifice` (624) on the altar tile nearest the player. The capture shows it on either of the altar's two tiles.
- **Message:** "The gods accept your offering." (spam).
- **Bone:** one removed (or kept, as above).
- **Experience:** given.

The house altar's line is used for normal offerings at the Chaos altar too, because no source gives the Chaos altar's own. Neither the Wiki nor a capture confirms it there.

## Pray-at

"Chaos altar" had no Pray-at handler. It now restores Prayer as other altars do, as captured:
- `human_pray` and synth 2674;
- "You recharge your Prayer points.", or "You already have full Prayer points." when Prayer is full.

The Yanille Agility dungeon's trapdoor altar (412 `trappedchaosaltar`) has the same name and is left alone.

## Not built

- **The bury confirmation in the temple.** The Wiki (11 December 2017 update) says burying bones there asks for confirmation, but its text isn't recorded anywhere.
- **Player-owned house altars.** Construction has no chapel yet.
