# Abyssal Sire

The Abyssal Sire in the Abyssal Nexus, built from the [OSRS Wiki](https://oldschool.runescape.wiki/w/Abyssal_Sire) ([Strategies](https://oldschool.runescape.wiki/w/Abyssal_Sire/Strategies)) and checked against live rsprox captures (<https://rsprox.net/database>). The fights are recordings 572 and 1762 (148 kills between them, rev 227), with 2188 (rev 228) and 100, 241, 2121-2136 for single actions and the Nexus. All are Leagues V worlds, and all are older than Poll 84 (30 April 2025), which reworked the fight. Animations, graphics, sounds, messages and timings come from the captures. The numbers Poll 84 changed come from the Wiki: walking speed, the 50% transition reduction, the phase floors, lung minimum hits, and spawn and scion defence.

The plugin is `server/plugins/bosses/AbyssalSire.plugin.js`, its data `server/plugins/bosses/data/abyssal-sire.json`, and one unit per part in `server/plugins/bosses/abyssalsire/`.

| File | What it owns |
| --- | --- |
| `Common.AbyssalSire.js` | The data, tick timing, sounds and graphics for the chamber's players, typeless damage, saved attributes. |
| `Lair.AbyssalSire.js` | The four chambers (one `Area` each), their own spawns, the task and solo rules, waking, resets. |
| `Fight.AbyssalSire.js` | The phases, the Sire's attacks, stuns, the pull and the explosion. |
| `Lungs.AbyssalSire.js` | The respiratory systems' damage rules and deaths. |
| `Tentacles.AbyssalSire.js` | The tentacles striking. |
| `Minions.AbyssalSire.js` | Spawns and scions. |
| `Miasma.AbyssalSire.js` | The pools. |
| `Kills.AbyssalSire.js` | The death: kill count, Slayer experience, the chamber's reset. |
| `CombatAchievements.AbyssalSire.js` | The kill count for Combat Achievements and the fight's six other tasks. |
| `Font.AbyssalSire.js` | The Font of Consumption. |
| `Overseer.AbyssalSire.js` | The Overseer, the first bludgeon and his book. |
| `Nexus.AbyssalSire.js` | The passage in from the Abyss, the appendage to Lumbridge, the eyes. |
| `Commands.AbyssalSire.js` | `::sire [sw\|nw\|ne\|se\|reset\|lungs\|hp <n>]` (developer). |

`::slayertask <amount> <task>` (developer, `Dev.Slayer.js`) gives the task the Sire needs.

Ticks below count from the action named. Captured gamevals are in brackets.

## The chambers

| Chamber | Sire (sleeping, south-west tile) | Eye |
| --- | --- | --- |
| South-west | (2967, 4791) | (3024, 4770) |
| North-west | (2977, 4855) | (3027, 4786) |
| North-east | (3102, 4855) | (3051, 4790) |
| South-east | (3107, 4791) | (3051, 4771) |

- Each chamber spawns its own Sire, four lungs (5914) and six tentacles. The world file's copies of them are left out (`onCanSpawnNpc`).
- The lungs and tentacles are at the Wiki's tiles. Tentacles in the 4762/4826 rows start as 5909 (north), in 4780/4844 as 5910 (south), and in 4771/4835 as 5911 (upright).
- **Vents:** the cache map has every vent as the dead one (26954). Live OSRS puts the wheezing vent (26953, shape 10, the map's rotation) on each living lung's tile.
- **Offsets from the Sire's sleeping tile, the same in every chamber:**

  | Tile | Offset |
  | --- | --- |
  | Phase 2 | (0, -10) |
  | Phase 3 | (0, -18) |
  | Where the explosion pulls the player | (2, -19) |

- **Waking:**
  - Only a player on an abyssal demon (or Sire) task wakes it. Anyone else gets "The Sire takes no interest in you." (captured).
  - Until it wakes, the lungs can't be attacked. Live OSRS walls them off from projectiles with an invisible wall (`inviswall_blockrange`) and removes it as it wakes.
- **Solo:** one player fights a chamber's Sire at a time (Wiki), in a multi-combat area. Everyone else gets "Someone else is fighting that.", the engine's single-combat line.
- **Leaving:** a teleport, death or logout ends the fight. Neither player nor Sire hitting for 100 ticks ends it too (Wiki: about a minute). The chamber is then put back as it was.

## Phase 1

| Tick | Captured |
| --- | --- |
| +0 | The first hit: 5886 → 5887 (`abyssalsire_sire_stasis_awake`), 4528 (`sire_waking`), facing the player. |
| +2 | The tentacles wake (5912): 7111 (`abyssal_tentacle_waking_reversed`) north, 7108 (`abyssal_tentacle_waking`) south, 7114 (`abyssal_tentacle_unstunned`) upright. |

- **Its attacks while awake, every 7 ticks (Wiki: attack speed 7):**
  - Spawns: 4530 (`sire_attack_spawns`).
  - A pool under the player: 4531 (`sire_attack_miasma`), the pool a tick later.
- **Stun:** 75 ranged or magic damage, or a shadow spell (Wiki: Rush 25%, Burst 50%, Blitz 75%, Barrage always, even on a splash).
  - A shadow spell that wakes it stuns it 10 ticks on (Wiki), not with the waking hit.
  - What it does: "The Sire has been disorientated temporarily.", 5887 → 5888 (`abyssalsire_sire_stasis_stunned`), sequence -1, sound 2727.
  - The tentacles go to 5913 with 7112 (`abyssal_tentacle_stunned`) 3-4 ticks later.
  - It lasts **46 ticks** (Wiki: about 27 seconds). Then the Sire and tentacles are awake again (7114).
  - A shadow spell can re-stun it while stunned (Wiki). Hits on it while stunned get "The Sire is disoriented. Maybe you can do something useful while it's unable to control the tentacles."
- **Its hitpoints:** damage to it only counts towards the stun. It can't drop below 1, and it is whole again when the phase ends (Wiki).
- **Lungs (Wiki, Poll 84):**
  - With the tentacles awake, a hit does 0-3 and "You can't deal much damage with those tentacles getting in the way." (captured).
  - With the Sire stunned, a hit does at least half the player's maximum hit. A demonbane hit that lands (holy water aside) destroys one outright.
  - They regain 1 hitpoint every 5 seconds (8 ticks).
- **A lung dies:**

  | Tick | Captured |
  | --- | --- |
  | +0 | 50 Slayer experience (Wiki); the lung NPC goes. |
  | +1 | The dying vent NPC (5915) with 7102 (`nexus_lung_death`), and the invisible blocker 26209 on the tile. |
  | +7 | The dead vent (26954). |

## Into phase 2

| Tick | |
| --- | --- |
| +0 | The last lung dies: 5889 (`abyssalsire_sire_puppet`), 4532 (`sire_mobilising`); its hitpoints are full again. |
| +7 | It walks to its phase 2 tile. Captured at 1 tile a tick; 2 here, the player's running pace (Wiki, Poll 84). |
| arrival +1 | 5890 (`abyssalsire_sire_wandering`); it attacks at once. |

- It starts phase 2 with at least 40% of its hitpoints (Wiki, June 2025).
- Hits on it while it walks are halved (Wiki, Poll 84), and can't kill it.

## Phase 2

- **Melee within 2 tiles of its body (Wiki), every 7 ticks (captured), in the captured mix:**

  | Attack | Sequence | Weight | Max | Through Protect from Melee |
  | --- | --- | --- | --- | --- |
  | Arm swipe | 5366 (`sire_right_hook`) | 197 | 15 | 6 |
  | Tendril flick | 5369 (`sire_attack_right_whip`) | 31 | 15 | 6 |
  | Both tendrils | 5755 (`sire_attack_double_whips`) | 39 | 66 | 26 |

  - The prayed maxima are the Wiki's; captured hits never went over them.
  - The 66 is the Wiki's.
  - The 15s are an assumption: no source gives the swipe's and flick's unprayed maxima. They are the prayed 6 scaled by the double flick's 66/26.
  - Hits land a tick after the swing (captured).
- **Further off,** it throws spawns (7095, `sire_attack_spawns_two`) or a pool (5367, `sire_attack_miasma_two`), 1 to 3.
- **Pull:** attacked with ranged or magic from more than 2 tiles away, it pulls the player in.

  | Tick | Captured |
  | --- | --- |
  | +0 | 5368 (`sire_attack_teleport_player`), its puppet form; the player plays 1816 (`human_teleport_other_impact`) with spotanim 342 at height 92 and sound 200, busy (varbit 12393). |
  | +3 | The player is on the tile south of the middle of its body. |
  | +6 | Its double hook (5751, `sire_attack_double_hook`), up to 60 (Wiki). Up to 26 through Protect from Melee, as its double flick; captured prayed hits were 3-16. |

  Arrows already in the air when it pulls don't pull again.
- **Below half its hitpoints (Wiki: 212):** it walks to its phase 3 tile (puppet form, 2 tiles a tick).

## Phase 3

| Tick | |
| --- | --- |
| arrival +1 | 7096 (`sire_panic_mode`) (captured). |
| +7 | 5891 (`abyssalsire_sire_panicking`), four spawns (Wiki), its tentacles awake. It has at least 20% of its hitpoints (Wiki, June 2025). |

- It no longer melees. It pools the player every 6-11 ticks (captured), starting a tick later.
- **Below 35% (Wiki: about 148), the explosion:**

  | Tick | Captured, all 93 kills that reached it |
  | --- | --- |
  | +0 | 7098 (`sire_apocalypse`); the player plays 1816 / spotanim 342 / sound 200 and is busy. |
  | +3 | The player is moved to the explosion tile. |
  | +6 | 5908 (`abyssalsire_sire_apocalypse`), sound 2720 (delay 15, radius 10); the hit, up to 96 (Wiki), on a player within 4 tiles of its body. Captured hits landed 1-4 tiles away, never 5 or more. |

  - The explosion is a hit from the Sire through the hit queue, so Vengeance reflects it.
  - A multi-hit weapon's first hit triggers it, and the rest of that attack still lands (Wiki).
- **After it:** a flood of spawns on and around it, then more every 4-7 ticks until 15 minions are up. It pools at least 3 more times, then stops while 15 are up (Wiki).
- It can't die before the explosion: a hit leaves it at 1 at least (Wiki).

## The pools (captured, 477 pools)

- `abyssal_miasma_spotanim` (1275) on the tile, sound 1930 (delay 15, radius 4).
- Damage on the pool's 3rd, 4th and 5th ticks:

  | Pool tick | Its own tile | The 8 around it |
  | --- | --- | --- |
  | 3rd | 8-26 | 2-9 |
  | 4th | 6-17 | 1-8 |
  | 5th | 3-9 | 1-5 |

  The Wiki gives 10-30 and 2-8.
- Its first hit poisons, starting at 8 (Wiki).
- No damage once the Sire is dead (Wiki).

## Tentacles

- Awake, each strikes a player within a tile of its 9x9 footprint every 4 ticks (Wiki), with 7109 (`abyssal_tentacle_attack`).
- The hit lands a tick later. Captured attacks were on the footprint's edges, as here.
- Up to 30 (Wiki: Strategies), rolled with the tentacle's own stats: about half the captured ones missed.
- Protect from Melee takes a little off (Wiki). A fifth here: the Wiki doesn't say how much.

## Spawns and scions

| Event | Captured |
| --- | --- |
| Thrown | `abyssal_spawn_projanim` (1274, cycles 108-180, angle 5, height 91 → 0) with sound 232 (delay 108). It lands near the player 6 ticks later and attacks. |
| Attack | 4522 for a spawn; 7126 melee / 7127 ranged for a scion. Every 4 ticks, melee beside the player, ranged otherwise (Wiki). |
| Ranged attack | `dwarf_stone_throw_travel` (32, cycles 20-60, progress 64 for a spawn, 128 for a scion), sound 2693 (delay 18). |
| Matures | After 20 ticks (Wiki: 12 seconds): 5918 with 7123 (`abyssal_scion_spawn`), at a scion's own hitpoints. |
| Dies with the Sire | 5917 / 6177 with 4521 / 7129 and sound 237, gone 2 ticks later, no drop. |

- Max hits are the Wiki's: spawn 4 melee / 9 ranged, scion 10 / 16.
- A minion that hasn't attacked for 50 ticks dies off (Wiki: about 30 seconds).
- Killed by the player, they drop their fiendish ashes.

## The kill

| Tick | Captured |
| --- | --- |
| +0 | 7100 (`sire_death`); its minions die, its tentacles fall asleep, its pools stop. |
| +2 | "Your Abyssal Sire kill count is: N." (varp 1526, through Combat Achievements), the loot (NpcDrops), the Sire gone. |
| +3 | The chamber is back: the sleeping Sire, fresh lungs on wheezing vents, sleeping tentacles. |

- On task, the kill is worth 478 Slayer experience (Wiki), set through `slayer:task-kill`.
- **Combat Achievements:**
  - The kill-count tasks finish from the count. "Abyssal Sire" is counted by event, like the other bosses with plugins.
  - Judged here:
    - They Grow Up Too Fast: no scion matured.
    - Don't Stop Moving: no pool damage.
    - Don't Whip Me: no tentacle damage.
    - Respiratory Runner: one stun.
    - Perfect Sire: no tentacle, pool or explosion damage, and no hit from the Sire taken without Protect from Melee.
    - Demonic Rebound: Vengeance reflecting the explosion.

## The Font of Consumption

The player stands south of it. An unsired used on it:

| Tick | Captured (9 attempts) |
| --- | --- |
| +0 | Object box with the unsired: "You place the Unsired into the Font of Consumption...". |
| +1 | Busy; 827 (`human_pickupfloor`, delay 15). |
| +2 | `abyssal_font_splash` (1276) and sound 2496 on the font. |
| +4 | The unsired gone, the reward in the pack, object box "The Font consumes the Unsired and returns you a<br>reward." with the reward. |

The roll (Wiki: Unsired):

| Out of 128 | Reward |
| --- | --- |
| 62 | A bludgeon piece |
| 26 | Abyssal dagger |
| 12 | Abyssal whip |
| 13 | Jar of Miasma |
| 10 | Abyssal head |
| 5 | Abyssal orphan |

- For a player who owns the orphan, the roll is out of 123 without it. Pets answers `pets:owns`.
- No bludgeon piece comes twice until all three have.
- The reward goes through `npc-drops:roll`, so the collection log counts it ("New item added to your collection log", captured) and Pets takes the orphan.

## The Overseer

- **Dialogue:**
  - His lines are the Wiki's transcript. No capture has him.
  - His chathead is his own loc model (29518) with 7117 (`overseer_talk_1`).
  - "What can I do here?" sets him wanting a spine, a claw and an axon.
- **Parts:**
  - Carried components are handed over once he has asked. Before that: "I did not ask you to bring me anything, human."
  - He keeps them in varbit 3262 (`abyssalsire_parts_stored`: spine 1, claw 2, axon 4).
- **With all three:**
  - He makes the first abyssal bludgeon, says his farewell and leaves.
  - Varbit 3261 (`abyssalsire_lore`) then turns his multiloc (27057) into the slimy residue. It also turns the boils beside it (27058) into his book, "Take".
  - The lore values are this plugin's, as nothing captured them: 0 not met, 1 met, 2 asked for parts, 3 parts all given, 4 gone. The cache only fixes 0-3 as present and 4-7 as departed.
- **The book:** the three components used on the book fuse into another bludgeon: "The book's power allows you to fuse the components into an Abyssal Bludgeon." (Wiki).

## The rest of the Nexus

- **In from the Abyss:** the one-way passage in the south of the outer ring (27054, `rcu_abyss_to_overseer`) leads to (3039, 4800).
- **Its other side** (27055, `rcu_overseer_to_abyss`), captured:

  | Tick | Captured |
  | --- | --- |
  | +2 | The player kneels: 1332 (`viking_drop_to_knee_and_backtoready`). |
  | +3 | Message box: "You can't get through from this side.<br>You'll have to find another way out." |

- **Fairy ring DIP:** works through the fairy ring table, untouched.
- **The appendage** (27027) teleports to Lumbridge (Wiki), with the lever teleport.
- **The eyes (6479, 6480), Peek:**
  - Captured with nobody inside: "There are no adventurers in this chamber." Once it has been empty a while, also "The area feels like it's been empty for a while now."
  - Otherwise "The area has been empty for: m:ss." (Wiki).
  - The line for an occupied chamber ("There is an adventurer in this chamber.") and the 500-tick "a while" are ours.

## Not done

- The Sire stays on its phase 2 tile. The captures show it shuffling a tile now and then to stay in reach.
- Melee on the lungs with a halberd (Wiki) isn't special-cased. They are attacked like any NPC in reach.
- The Unsired pre-roll in `npc-drops.json` has no `out_of`, so NpcDrops never rolls it. 113 other pre-roll entries share the problem; that fix belongs in NpcDrops, in its own PR.
