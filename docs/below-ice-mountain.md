# Below Ice Mountain

Quest behavior comes from the [OSRS Wiki quest guide](https://oldschool.runescape.wiki/w/Below_Ice_Mountain), its [transcript](https://oldschool.runescape.wiki/w/Transcript:Below_Ice_Mountain), the [structural pillar page](https://oldschool.runescape.wiki/w/Structural_pillar), and RSProx recording **1636** linked by issue #600. IDs were checked against this repository's revision 241 cache. Raw recordings and account details are not included.

## Captured state

The existing save's story stages 0–5 stay compatible. The client receives OSRS's main varbit 12063 and separate recruitment varbits, preserving cache NPC and entrance morphs.

| Main varbit | Recorded milestone |
| --- | --- |
| 5 | Accept Willow's offer, cycle 222 |
| 7 | Ask about the falling out, 227 |
| 10 | Finish the crew instructions, 238 |
| 15 | Recruit the first crew member, 606 |
| 20 | Recruit all three, 961 |
| 25 | Willow asks whether the player is ready, 1391 |
| 30 | Marley clears the entrance, 2051 |
| 35 | Guardian awakens, 2160 |
| 40 | Guardian defeated, 2197 |
| 120 | Completion after Ramarno's first line, 2253 |

Recruitment uses 12064 (Marley), 12065 (Checkal), and 12066 (Burntof). Checkal progresses 0→5 referral→10 Atlas offer→15 workout→20 Flex prompt→40 recruited. Marley uses 5 sandwich errand→10 recipe learned→35 sandwich handed over→40 recruited. Burntof uses 5 drink request→10 drink received→15 rock-paper-scissors→40 recruited. All three become 45 inside and 50 after the Guardian awakens. Reward claimed is varbit12067; Flex is 12062; repeat workouts use 12131; Ramarno's workshop move is 12068.

The nameless NPC IDs 10638–10649 are valid cache morph bases, not missing NPCs. World spawns already supply both the original and entrance crew. The plugin no longer creates permanent duplicate NPCs or a second entrance.

## Interactions and scenes

The quest requires 16 Quest points. Checkal recruits the player only after an actual nearby Flex emote; recording 1636 clicks emote slot40 at cycle597 and resumes Checkal's conversation three cycles later.

The workout runs in a private template scene, using the recorded 206-cycle span from the initial teleport at 345 to the unlock at 551. Its sanitized timeline includes every captured camera cue, black/white fade, NPC appearance/removal and walk, Atlas's counts and boxing, the barbarian crowd, the dog, and the tomato throw at 393 (projectile 29, actor graphic 30 and delayed impact 31). Player movement uses key running segments, pushups and block animations. The free workout is excluded from the paid-session counter. Repeat sessions cost 25,000 coins and replay the workout. Completion is saved at the unlock, so logging out before continuing its message preserves it.

Burntof accepts regular beer, Asgarnian ale, dwarven stout and wizard's mind bomb. Using a drink directly on him works, as does the dialogue hand-in. His upstairs scene plays the hand animations, five-cycle round reveals, third-round cheat and Tina's arrival. The cheat beats the sign actually displayed in the third round. Each of the player's three choices leads to recruitment.

The sandwich recipe unlocks when the cook explains the bread/meat combination. Knife-on-bread opens the cache creation menu with breadcrumbs and steak sandwich; knife-on-meat can make the sandwich directly. It consumes one bread and one cooked meat, retains the knife, plays sequence8938 and works after completion. Using a sandwich on Marley starts the hand-in dialogue.

The entrance scene creates a private crew, explosion and rubble replacements, the Marley disguise/tripwires, indoor crew, earthquake and awakening. The combat Guardian and its four mineable pillars occupy a separate private instance. Pillars require a usable pickaxe and boosted Mining10, award10 MiningXP each and damage the40HP Guardian by10. A broken pillar cannot be mined repeatedly. The Guardian attacks after the cutscene and on re-entry. Its death starts the finishing dialogue automatically.

The finishing sequence shows Willow's bag and coins before opening the doors and meeting Ramarno. The ending resets the camera five ticks after the resumed "Bless my beard..." line, before completion at eight ticks. Completion follows that recorded transition, grants 2,000 coins and one Quest point once, uses a steak sandwich on the scroll and jingle 152, and automatically starts the Ramarno introduction when the scroll closes. Ramarno's departure updates the cache morph variable.

The workout retains all 54 captured camera packets (including its reset), with exact source tiles, heights, both movement-rate fields and cycle offsets. Rock-paper-scissors, the exterior escape/explosion, Marley's two trap pans, the entrance rise, Willow's room sweep, the earthquake/awakening, and the final bag/door shots also retain their captured targets and rates. Transition cameras change at the recorded fade boundaries; dialogue-driven shots start with the matching line or Continue, without replaying the recording player's reading delays.

Recorded transition spans are also applied to RPS entry (900 out, 904 in, 905 dialogue), RPS exit (976 departure, 979 out, 984 in/dialogue), the entrance gathering (1940 out, 1944 in, 1946 dialogue), Marley entering (2029 out, 2032 in, 2034 dialogue), the crew entering (2052 out, 2057 in, 2059 dialogue), and Guardian defeat (2197 death, 2198 out, 2204 in, 2206 dialogue).

The fuse uses the 1959/1967 fade pair, explosion aftermath 1988/1993, rubble clearing 2016/2023, and Ramarno's workshop departure 2283/2286. The crew's escape fades out at 2167 and shows the player's line at 2169. Continuing that line removes the crew immediately, resets the camera two cycles later and reveals the combat Guardian five cycles later (2171/2173/2176 in the recording).

## Verification and remaining fidelity limits

`node --test tests/below-ice-mountain-parity.test.cjs` (from `server/`) covers the captured states, legacy saves, interrupted conversations, actual Flex requirement, recipe/menu/postquest use, every RPS choice, workout timing and cleanup, all 54 workout camera packets and scene camera transitions, private crew/Guardian transition, distinct pillar mining and single reward.

Live agent MCP on this worktree's port49802 verified the16-point refusal, main35/sides50, cache entrance interaction, a private Guardian arena with one40HP Guardian, all four pillars and the mapped exit.

Recording 1636 uses combat rather than pillar mining. The eight-cycle mining delay is based on the Wiki speedrun description and needs a mining-route recording to confirm its timer interaction. Player running uses key segments rather than every captured step; actor facing microsteps, the crew's complete trap/disarm choreography (2035–2051), lighting/environment scripts and temporary HUD/sidebar suppression are not fully reproduced. Quest journal prose is the existing implementation because this recording does not open its journal. These limits prevent claiming full visual or packet-for-packet parity.
