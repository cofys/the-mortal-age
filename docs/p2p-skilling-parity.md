# Sleeping Giants and A Porcine of Interest

Behaviour is compared with the complete quest sections of RSProx recordings [96](https://rsprox.net/download/96) and [1693](https://rsprox.net/download/1693). Source recordings and transcriptions remain local because they contain account details. Cache ids and morphs were checked against this checkout's active cache.

## A Porcine of Interest

Recording 1693 contains the complete quest at ticks 109–725. Native stage values are 5 (notice), 10 (Sarah), 15 (rope), 20 (rescued), 25 (goggles), 30 (dead sourhog, with the foot tracked by sibling bit 10583), 35 (bounty), and 40 (complete). Saved story stages 1–9 remain compatible and are mapped onto those values; changing the whole parent varp would overwrite the foot and investigation flags.

The map already contains the native morphing hole (40341), produce and damaged-tree/cart morphs (40342–40346), skeleton (40350), and rope pile (40352). The old plugin placed their concrete visible variants globally. Removing those replacements lets the native quest varbit control visibility and remove the trail after completion.

The skeleton now opens native note interface 222 with the captured eleven lines. Closing it starts the private scene. All 21 recorded camera movement/look commands and final reset are represented, including their position, height, ordered rate pairs, and the server-controlled gaps:

| Capture ticks | Camera phase |
| --- | --- |
| 300 | Skeleton reveal: position (3168,9672), height 500, rates 10/10; look (3165,9676), height 50, 232/232 |
| 306–311 | Pig reveal: snap then lift at (3162,9676), followed by the slow look toward (3167,9676) |
| 320 | Acid attack view from (3166,9681) toward (3166,9676) |
| 341 | Unconscious player view at (3162,9698), followed by the vertical drift from 300 to 700 |
| 351 | Pig sniffing view from (3158,9705) toward (3166,9700) |
| 373 | Departing pig: snap and rise from height 375 to 900, lowering the look target from 200 to 1 |
| 381–386 | Spria enters and climbs over the blockage, with both recorded camera cuts |
| 397 | Look follows Spria approaching the player at (3162,9699), rates 2/1 |
| 410 | Camera reset and wake-up at (3095,3267) |

The scene uses real private Pig Thing and Spria actors, acid animation 8770/projectile 1817/impact 1818, collapse, fades, walking, and rescue. Dialogue boundaries remain player-controlled; waiting longer before Continue does not skip scene stages. Fixed scene portions retain the captured tick offsets.

The quest sourhog appears at the captured accessible tile (3162,9699), instead of the old guessed southern chamber tile. Its corpse is private and uses morph 40349. The quest combat provider uses five-tick crush/ranged attacks, melee animation 8769, spit animation 8770, projectile 1817 with heights 43/45, angle 16 and progress 128, and impact graphic 1818. The recorded near and four-tile flights last 58 and 86 cycles respectively. Standard hit rolls and protection prayers still determine damage; the existing canonical monster data supplies 40 Hitpoints and max hit 6. Its location persists so logging out after the kill and before cutting the foot reconstructs it. Cutting sets the foot bit without moving the main stage past 30. Bounty exchange requires the foot and pays 5,000 coins once. Banked replacement goggles are checked across the player's bank containers.

## Sleeping Giants

Recording 96 contains the complete quest at ticks 10034–10856, followed by ordinary foundry play. It is a Leagues V capture, revision 227: account XP modifiers and unrelated League announcements are not copied into the main-game quest.

The introduction and repairs use a private workshop at the captured cache coordinates. The existing foundry plugin supplies its ambient animation through a custom event from the private area. At captured stage 25, the player leaves that workshop for the public foundry at (3366,11495), where canonical Kovac 11560 supplies the sword tutorial. Preform work, passive cooling and storage continue through the existing public foundry area.

The opening uses all twelve recorded camera movement/look commands plus reset: initial view at tick 10060, pans at offsets 1, 6, 14, and 22, then the fixed conversation view at (3371,11493), height 700, looking at (3368,11486), height 400. Exact recorded rate pairs are sent, including the differing 3/3 and 2/2 look rates. The quest distinguishes accepted stage 5, arrival 10, repair briefing 15, repaired briefing 20, and sword tutorial 25 while retaining the existing saved story stage model.

Native repair morphs 44773–44775 show broken tools privately. Repair varbits 13904–13906 show 1 during the work and 2 only when repair finishes. Repair animation/timing follows the captured Yes-to-finish intervals: trip hammer five ticks, polishing wheel eight, grindstone twelve. Logs, nails, and wool are consumed on completion; the chisel and hammer remain tools. Logout cancels pending work without consuming its resources. The tutorial commission is Flat Broad, words 3/4, and tutorial substeps now move with the corresponding briefing lines. The existing minigame's wrong-tool and wrong-temperature damage emits a custom event so Kovac can stop the player and explain the mistake; ordinary post-quest damage remains unchanged. The tutorial pours at the captured fixed alloy difficulty 5, yielding quality 41 with mould parts 8/8/6 and seeds 1/2 for its three stages. Mould setup and its Set button require Kovac's mould briefing first. At hand-in substep 55 the preform, completion, difficulty, and commission clear, while quality remains for the dialogue condition; substep 60 then clears quality, and 65 completes the quest. Tutorial preforms can continue at zero quality, as required by the recorded quest's quality-dependent hand-in branches.

## Verification and remaining work

`server/tests/p2p-skilling-parity.test.cjs` exercises native stage values, note text, camera rates, timed actors/attack/rescue, private corpse recovery, one-time bounty exchange, workshop isolation, chisel retention, repair timing, and cancellation. It passes with the existing quest plugin, quest dialogue, and Giants' Foundry tests (590 total at the final pair integration check).

The integrated native client opened Porcine's native222 note and verified its close starts the skeleton camera with the player and skeleton correctly framed. It also entered the private foundry through the real Hill Giant start action and played its opening camera sequence and Kovac briefing. Complete native playthroughs and a side-by-side OSRS comparison of both quests remain outstanding. The recording does not establish every alternate dialogue, failed interaction, random combat choice, or interruption path. The existing dialogue renderer still presents some Wiki transcript lines separately where OSRS progressively appends them to one chatbox. The private areas reuse the source coordinates instead of allocating OSRS's dynamic instance coordinates; private actors and objects are isolated, and the camera uses the recorded source-coordinate view.

The four captured combat attacks do not prove the sourhog's random style weights; the provider currently chooses equally at melee range and uses ranged when farther away. Intermediate projectile distances interpolate the observed near/four-tile flights. These unrecorded distributions need additional evidence before being described as exact.
