# Getting Ahead and The Garden of Death parity

The primary evidence is [RSProx capture1692](https://rsprox.net/download/1692), revision226. Both quests start and complete in this recording. Packet positions, ids and script/interface contracts were checked against the current revision241 cache. Raw captures remain local because they contain account data; committed reading data includes only quest text and native component layouts.

## Getting Ahead

The recorded stages are0/2/4/6/8/10/12/14/16/18/20/22/24/26/28/30/32/34 (varbit693, varp2851). Selecting a conversation never advances it. Mary's flour idea, Gordon's refusal, Mary's modelling idea and Gordon's three judgements advance on the corresponding spoken lines. Showing a fake head no longer advances to the next crafting step before Gordon judges it.

The three crafts use their captured confirmation menus, animations8838/8839, sounds and large item models25148–25150. Materials are rechecked when confirming; knives, needles, hammers and saws remain tools. The flour gate uses animation8837, retains the empty pot, fades through the night, changes the trail at2 ticks and finishes the fade at4 ticks, then waits for the player to Continue before the next spoken line. Cave entry has its recorded warning and fade, advances to12 and enters a private lair at the source coordinates. Players and actors are isolated; the beast starts at the recorded1187,10020 with the captured searchable skeleton/exit changes. Leaving/logging out removes the encounter, and logging back in restores a still-unfinished fight.

Mounting hammers one nail at a time while playing construction animation3676 until six nails succeed. Strongest carried nails are selected first; bent nails are consumed without advancing the build, with recovery when nails run out. The bend roll decreases with metal quality and current Construction level; its numeric rates are estimates because the available capture has no failed nails and the existing Construction system has no bend-rate helper. Noted and placeholder saws are rejected; equipped Amy’s saw and Imcando hammer variants work. The head and two planks are removed after the last nail. The reward follows the final private house inspection, rather than firing through the transcript's prose action. Full inventories defer the complete3,000-coin reward for Gordon to reclaim once.

The beast now has an avoidable falling-rock attack: stomp8835, native graphic317 on the original target tile, and12–16 environmental damage only if the owner remains on that tile. Stepping one tile away avoids the hit. Ownership, death, exit and logout cancel pending rocks. Normal melee remains on the shared four-tick combat pipeline. The [Wiki](https://oldschool.runescape.wiki/w/Headless_Beast) establishes the mechanics and damage; selecting the special with probability1/6 and a four-tick impact window are explicitly inferred.

Mary’s post-quest thanks sets the native tanning unlock bit696. Her Trade option and dialogue open native tanner324 through the shared `tanning:open` service. Its eight rows use [Mary’s documented prices](https://oldschool.runescape.wiki/w/Mary_(Getting_Ahead)):1/3 coins for soft/hard leather,15/20 for the two snake hides, and20 for each dragonhide. Native All/X/5/1 buttons perform inventory exchanges with exact fees, no XP and no requirement for spare slots. Amounts are validated; closed/stale inputs and moved-away contexts cannot tan remotely.

### Complete recorded camera sequence

The capture contains one directed camera pair for this quest:

| Relative tick | Recorded operation |
| --- | --- |
| 0 | Fade out over50 client cycles |
| 3 | Enter the copied house; Gordon10501 at1239,3683; Mary10504 at1238,3677 |
| 4 | Move to1238,3677, height420; look at1239,3683, height40; both rate232/rate2=100 |
| 5 | Fade in over50 cycles |
| 6–10 | Mary walks north to1238,3681 and faces Gordon |
| 8/11/15/18 | Gordon alternates animation861/862 |
| 13 | Player animation4275; Mary's4275 delayed12 cycles |
| 16 | Fade out over80 cycles |
| 19 | Return to1249,3684; reset camera and release controls |
| 22 | Fade in over50 cycles |
| 24 | Complete, award XP/quest point/coins and show the native reward scroll |

Private-instance camera coordinates are the exact source coordinates translated into the copied chunks. Logout cancels tasks, restores the farm location and permits the final conversation to restart without an early reward.

## The Garden of Death

The old guessed stages1–7 and automatic word solving are replaced with the recording's stages2–56 on varbit14609/varp3713. Legacy saved stages and learned words migrate once without awarding XP or quest points again.

The captured route is:

- Find journal2; read4; enter first ruin6; find tablet8; read10; take translations12; read translations14; solve first group16.
- Enter Molch Island18/20; find vine note22; cut vines24; find tablet26; read28; solve30.
- Enter Xeric's Shrine32/34; find tablet36; read38; solve40.
- Enter Morra42/44; find tablet46; read48; solve50; reread52; take warning54; close the warning note to complete56.

Native interfaces are journal392, stone tablet748, translations804 and letter625. The journal spreads, warning text and five captured tablet layouts preserve the recording's wording, highlighting and component positions. Reading the translations opens its native Attempt Translation button and real text input. Each accepted English meaning is stored separately, so both `Time = Miki` and `Death = Miki` work. Invalid, undiscovered and repeated answers cannot advance the quest; repeat prompts and the final full-inventory recovery remain available. Lost translations can be recovered from the first tablet at later stages without resetting learned words. A lost warning can be reclaimed from the last tablet at54 or after completion; replacing it cannot award rewards again.

The27 captured answers are5/5/7/10 by ruin: Island/Water/Time/Vessel/North; West/Poison/Body/Food/Earth; Make/Yes/No/Move/Arrive/East/South; Few/Big/Sun/Moon/Life/Death/Mind/Home/Air/Fire. Additional meanings follow the [Wiki translation table](https://oldschool.runescape.wiki/w/Transcript:Word_translations).

The three later surface holes use the cache's existing quest transforms at1364,3637;1314,3617;1450,3511. The previous artificial holes at incorrect coordinates are removed. Searchable clue scenery is player-owned and enabled after reading the corresponding tablet, instead of replacing world scenery for everyone. Teleports are blocked by the ruin area. Native carving diagrams105/791–803 open without automatically teaching their meanings. All three [dirty notes](https://oldschool.runescape.wiki/w/Transcript:Dirty_note) read through native note625 without advancing or completing the quest. The compass and labelled containers use their native item models; the Morra chest reveals its Antil hint after collecting the carving. Optional carving sources follow the [Wiki transcript](https://oldschool.runescape.wiki/w/Transcript:The_Garden_of_Death), including Morra’s table/rubble/vase variants. The capture explicitly sends a mesbox chat-history message alongside each native item/statement dialogue, so those paired outputs are retained.

There are **no directed camera commands** in the recorded Garden of Death route. Its incidental camera resets accompany travel/login and do not constitute a missing cinematic.

## Verification and limits

Run from `server/` after the server build:

```sh
node --test tests/p2p-kourend-parity.test.cjs
```

Twenty-three native dialogue/interaction tests cover the full27-answer Garden route, exact stage boundaries, vine delay, native interfaces, failed/full-inventory recovery, legacy completion migration, Getting Ahead's confirmation materials and item models, overnight timing, owner-only beast credit, mounting, exact camera coordinates/rates, delayed rewards and logout/relog recovery, avoidable/cancelled boulders, nail failures and metal/level effects, native tanning access/fees/amounts/inventory safety, all14 carving views, three dirty notes, clue models, valid equipped tools two-player lair isolation and lost-scroll/warning recovery at later or completed stages without duplicate rewards.

Remaining limits requiring additional evidence or testing:

- The lair uses a logical PrivateArea at the recorded tiles, inferred from the encounter-specific NPC/scenery spawns. The transcriber provides no explicit rebuild commands, and the Wiki does not state its instance transport contract. Decorative ground-item spawns are not yet reproduced.
- Capture1692 starts stomp8835 on the killing hit and then plays death4929; no rock lands. The implemented1/6 special-selection probability, four-tick warning window and uniform12–16 damage roll remain inferred rather than measured from surviving boulder attacks.
- The captured mounting uses six successful nails. Nail bending now exists, but the exact probability curve remains unverified. The implementation follows the [documented quality/level relationship and strongest-first selection](https://oldschool.runescape.wiki/w/Nails), with estimated base chances5–40% at level1 scaled by `(100 - level) / 100`.
- The capture follows the language puzzle's quick route without searching every optional clue. Dirty-note/carving/compass/container reading is implemented and tested from the Wiki transcript and cache; exact optional clue placement and unrecorded layouts still need a full exploration capture. The existing scenery list chooses fixed positions and is not certified as the OSRS search map.
- Recorded tablet layouts are exact for the captured answer combinations. Other valid combinations use visible-character wrapping and dynamically generated highlighting.
- Quest journal summaries and some unrecorded failure/reclaim messages follow Wiki intent rather than a captured packet transcript. Native tanning prices, item exchanges and controls are implemented; its unrecorded wording and layout still need a dedicated capture comparison.
- Integrated native client checks opened translations804, entered Island through its real input and received the learned-word statement. Getting Ahead's final inspection rendered the private house, Gordon/Mary actors and mounted head from the captured camera, then returned to the farm and awarded completion34. Tanning and the remaining routes have automated interaction coverage; complete visual OSRS comparisons remain outstanding.
