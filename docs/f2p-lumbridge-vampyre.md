# Cook's Assistant, Sheep Shearer and Vampyre Slayer

Issue: https://github.com/RSPSApp/tsps/issues/600

Behaviour references: [Cook's Assistant](https://oldschool.runescape.wiki/w/Cook%27s_Assistant), [Sheep Shearer](https://oldschool.runescape.wiki/w/Sheep_Shearer), [Vampyre Slayer](https://oldschool.runescape.wiki/w/Vampyre_Slayer), [Count Draynor](https://oldschool.runescape.wiki/w/Count_Draynor), [Lumbridge Castle range](https://oldschool.runescape.wiki/w/Cooking_range_(Lumbridge_Castle)). Wiki range and Count mechanics were also accessible through OSRS Index's attributed Wiki mirrors. IDs were checked against this checkout's revision 241 cache, including gamevals and the actual map placements.

## Sanitized recording facts

RSProx recording **1718** supplies both Lumbridge quest fast paths:

- Cook uses NPC 4626, quest varp 29 with stages 0 → 1 → 2. His all-ingredients handover is a two-item statement (group 11), showing flour 1933 and milk 1927. He completes only after continuing past his final response about not holding his breath. The scroll shows cake 1891 as its model and awards 1 quest point and 300 Cooking XP; no cake is given.
- Fred uses quest varp 179, with stages 0 → 1 → 21. Even when carrying all 20 wool balls, the player accepts the quest with Yes before the fast-path dialogue. After handing over 20 balls, the player says that is the last of them and Fred says he had better pay them. Completion follows that final line. Scroll model 1735 is shears, rewards are 1 quest point, 150 Crafting XP and 60 coins.

RSProx recording **3275** supplies the Vampyre route:

- Morgan starts varp 178 at 1. Harlow's initial beer request advances it to 2 before the beer/stake exchange. Giving the beer removes one beer, plays animation 3116 and shows an item statement. The stake handout also uses an item statement. Direct item use on Harlow produces no exchange shortcut.
- Cupboard 2612 at 3096,3269,1 opens to 2613. Search grants garlic; opening and closing grant none. The search message says the cupboard contains garlic and the player takes a clove.
- Basement stairs lead to 3077,9772,0. The coffin is 46237 at 3077,9775,0, shape 10, rotation 3. Clicking it animates loc 11208. Four ticks later NPC 3482 rises with animation 3114; nine ticks after the click, active Count 3481 appears at 3078,9774,0 with animation 3115, alongside open coffin 2615. The coffin returns to its closed appearance four ticks later.
- Garlic's captured message is “The vampyre seems to weaken.” The successful finishing blow plays player animation 806, consumes the stake and advances varp 178 from 2 to 3. The reward is 3 quest points and 4,825 Attack XP. The player stays in the basement.

The captured Cook's Assistant route (1718, cycles 7083–7095), Sheep Shearer route (1718, 7731–7741), and Vampyre Slayer route (3275, 21929–22225) have no scripted camera movement, look-at or shake packets. Their earlier/later camera packets belong to other content in those recordings. No extra quest camera is introduced.

Raw recordings and account names are deliberately excluded.

## Implemented checks

From `server/`, after building:

```sh
node --test tests/lumbridge-vampyre-parity.test.cjs tests/climb-links.test.cjs tests/npc-dialogues.test.cjs tests/cooking-gauntlets.test.cjs
```

The focused tests cover delayed rewards, partial ingredient deliveries and interrupted conversations, duplicate prevention, partial wool deliveries, sheep regrowth, native spinning amount selection, Harlow's beer/stake progression and banked stake checks, tools required to finish the Count, his private coffin sequence, garlic stat reductions, regeneration, reduced combat XP, remaining in the basement, and the special range's quest gate and food-specific burn levels.

## Shearing sheep

[rsprox captures](https://rsprox.net/database) of the Shear option and of shears used on a sheep
(recordings **1619**, **1620** and **1621**, revision 225; **3276**, an event world on revision 234;
Leagues recordings **69**, **96** and **1718** agree) show:

- The shearing animation (893) and sound 761 (delay 10) play at once. "You get some wool.", the
  wool and the sheared sheep (the same colour's `sheepsheered*` npc) follow **two ticks** after the
  animation, in every attempt.
- Shears used on a sheep that has no wool yet: "This sheep has already been shorn." and the sheep
  says "Baa!" (recording 1621). No capture shows shears used on a sheep in the two ticks before
  its wool comes off; here it answers the same way.
- The Thing (`sheep_shearer_the_thing`): animation 893 with sound 760, the Thing's
  `the_thing_shear` animation (3570) with sound 686 a tick later (recordings 1620, 1718), and
  "The... whatever it is... manages to get away from you!" on the third tick (recording 1620,
  the only attempt that shows the message).

The [Sheep](https://oldschool.runescape.wiki/w/Sheep) page gives the regrowth: wool is back after
**50 ticks**, or **100 ticks** for Zanaris' sheep, and shearing elsewhere always succeeds. The
[Zanaris sheep](https://oldschool.runescape.wiki/w/Sheep_(Zanaris)) have no Shear option but take
shears, fail **25%** of the time with "The sheep manages to get away from you!", and both colours
(5843, 5844) turn into the dark-grey sheared sheep 5845. No capture covers Zanaris, so its
failure message uses the two-tick timing of a successful shear.

```sh
node --test tests/qh-f2p-basics-parity.test.cjs tests/lumbridge-vampyre-parity.test.cjs
```

Checked with the agent MCP: shears used from the next tile gave the wool and the sheared sheep two
ticks after the click was processed, and the wool grew back 50 ticks after that (about 100 in Zanaris,
where one of six attempts got away and left the sheep shearable). Shears on a shorn sheep gave the
captured message and "Baa!", and The Thing reared a tick after the click and got away on the third.

## Remaining evidence limits

Recording 3275 predates the current revision 241 Harlow transcript. Current Wiki dialogue wording is retained rather than replacing it with the older speech, while the captured beer-request progression and exchanges are restored. Neither recording exercises every optional dialogue branch or the normal wool-gathering path. The Count's long encounter timeout, and the exact Cooking success curve below the published burn thresholds need further OSRS measurements. Existing gathering plugins still own wheat milling, milk collection and ingredient floor spawns.

## Cowbell amulet follow-up

The Ides of Milk now attaches `ides-of-milk/CowbellAmulet.Quest.js`. [Cowbell amulet](https://oldschool.runescape.wiki/w/Cowbell_amulet) mechanics are implemented for inventory and worn actions. Charges are saved on each individual item under `cowbell-amulet:charges` (absent means zero), with selected/worn charges mirrored to cache varbit 20097. Air runes add chosen amounts up to 1,000; stale amount prompts cannot charge an amulet the player no longer holds. Uncharge refunds runes only with room to hold them. Blocked teleports consume no charge.

Recording **4153**, ticks 815 and 820, confirms the no-air warning uses a plain messagebox, while Ring shows the charged amulet model 33104 in an item statement, plus sound 2192 at delays 0, 8 and 16. Ring emits `ides-of-milk:cowbell-ring` for the boss encounter. Dairy cow milking now takes seven ticks, or six with either cowbell amulet worn; using a bucket directly shares the same interaction.

Additional RSProx searches for item 33104, sequence 13811 and charge/check messages found no charged teleport. The only item-33104 recording was 4153 (reward/Ring model). Animation search results 4222 and 4242 decode to bank-management recordings without the teleport being played. The teleport uses the revision 241 cache's `human_cowboss_teleport` animation 13811 and graphic 3603, but its precise landing tile and timing still need a live OSRS teleport capture. Check/charge wording outside 4153 is also not captured.

```sh
node --test tests/cowbell-amulet-parity.test.cjs
```

## In-game verification

The worktree's own agent MCP (`49802`) was exercised with a fresh test account:

- Cook's fast route completed through the real dialogue manager. The dual-item statement appeared, varp 29 became 2 only after the final Continue, Cooking XP increased by 300, and the consumed ingredients left no cake in inventory.
- Count Draynor's basement began empty. Opening the coffin established a private area, raised coffin-form 3482 and then active Count 3481, and garlic produced the captured weakening message. The real combat kill consumed the stake, added exactly 4,825 Attack XP, set varp 178 to 3 and left the player in the basement with the hammer and garlic intact.
- Fred's fast route showed the Yes prompt and varp 179 stage 1 before the pre-collected-wool dialogue. The plain handover statement and both closing lines played. The final Continue set varp 179 to 21, added exactly 150 Crafting XP, removed the 20 balls and awarded exactly 60 coins.

The live checks do not establish every optional branch, precise client animation rendering, or the uncaptured charged-amulet teleport. Those limits remain as listed above.
