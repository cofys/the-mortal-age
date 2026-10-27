# Offering bones on altars

`server/plugins/skills/BoneAltars.plugin.js` lets members offer bones on the Chaos Temple's altar (level 38 Wilderness) for extra Prayer experience. Its data is in `server/plugins/skills/data/bone-altars.json`. Altars built in a player-owned house offer through the same loop: Construction (`server/plugins/skills/construction/Altars.Construction.js`) asks for it with `bone-altars:offer` and supplies the altar's bonus and message (see "House altars" below).

The bones and their burying experience come from the Prayer plugin through `prayer:bone` (docs/prayer-bones.md), so every bone that can be buried can be offered.

Sources:
- the OSRS Wiki: Chaos Temple (church), Pay-to-play Prayer training, Zealot's robes, [Chapel](https://oldschool.runescape.wiki/w/Chapel), [Gilded altar](https://oldschool.runescape.wiki/w/Gilded_altar), [Incense burner (Oak)](https://oldschool.runescape.wiki/w/Incense_burner_(Oak));
- rsprox captures (<https://rsprox.net/database>):
  - Pray-at on the Chaos Temple altar: recordings 435, 469, 3243, rev 232-233;
  - bones offered on a house altar (`poh_altar_saradomin_1`): recording 2850, rev 230;
  - coins offered on a gilded house altar (`poh_altar_saradomin_7`) on Leagues V: recordings 86 and 572, rev 227.

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

## House altars

Using a bone on an altar built in a house (oak to gilded) starts the offering above. Before this, each use offered one bone after a 3-tick click delay, with no message, sound or graphic and no repeat, and the experience came from a separate table that gave normal bones 5 instead of 4.5 and refused bones it didn't list, superior dragon bones among them.

| | |
| --- | --- |
| Bonus | Oak 100%, teak 110%, cloth 125%, mahogany 150%, limestone 175%, marble 200%, gilded 250% of the burying experience, plus 50% for each lit incense burner in the room (Wiki: Chapel). The Wiki's Gilded altar table gives the exact values (bones 11.25 / 13.5 / 15.75, superior dragon bones 375 / 450 / 525), so the experience isn't rounded up as the Chaos altar's is |
| Message | No burner lit: "The gods accept your offering." (recording 2850). One: "The gods are pleased with your offering."; two: "The gods are very pleased with your offering." (Wiki: Gilded altar; both texts in recordings 86 and 572) |
| Repeat | Every 4 ticks while that kind of bone lasts (recording 2850; the Leagues recordings 86 and 572 show the same 4-tick repeat). The bonus and message are worked out again for each bone, so a burner going out mid-batch counts at once |
| Using a bone again | Offers at once and restarts the loop. Recording 572 has thousands of offerings one tick after the last, one per use, and the Wiki gives 2,550 bones an hour offered by hand against 1,070 left to repeat (Pay-to-play Prayer training) |
| Zealot's robes | 1.25% a piece to keep the bone, as at the Chaos altar (the Wiki lists house altars among the remains they affect). House altars keep no bone of their own |
| Stops | On walking or clicking anything else, on leaving the house, or when the altar is removed |

Incense burners (unchanged, already as the Wiki has them): a tinderbox and a clean marrentill light one for 200 + Firemaking level + a random 0 to level − 1 ticks.

Not checked: a gilded altar's message with no burner lit. Recording 2850's altar is an oak altar (13179), and the Leagues recordings on the gilded altar never show the no-burner message.

## Pray-at

"Chaos altar" had no Pray-at handler. It now restores Prayer as other altars do, as captured:
- `human_pray` and synth 2674;
- "You recharge your Prayer points.", or "You already have full Prayer points." when Prayer is full.

The Yanille Agility dungeon's trapdoor altar (412 `trappedchaosaltar`) has the same name and is left alone.

## Not built

- **The bury confirmation in the temple.** The Wiki (11 December 2017 update) says burying bones there asks for confirmation, but its text isn't recorded anywhere.
