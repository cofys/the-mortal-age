# Wyrms

Wyrms (Karuulm Slayer Dungeon, Wyrmscraig Cavern) and wyrmlings (Neypotzli, Wyrmscraig) lie on the ground until attacked, then rise and fight (Wiki: "When encountered, they will be slithering on the ground. However, once attacked, they will levitate off the ground and attack the player.").

| Family | Dormant → awake | Attacks |
| --- | --- | --- |
| Wyrm | 8610 → 8611 | melee (max 10) when beside you, magic (max 13) otherwise |
| Wyrmling | 13031 → 13032 (Neypotzli), 16297 → 16296 (Wyrmscraig) | melee only (max 5) |

## Before

The dormant and awake forms were never switched, and their combat animations were guessed from an unordered list (`npc-animations.json`):
- **Dormant wyrms** attacked with their rise animation and died with the player's death animation.
- **Awake wyrms** attacked with `wyrm_death` and died with `wyrm_walk`.
- **Wyrmlings** punched like a player.
- **Wyrms only meleed:** the engine gives a hybrid NPC one style, melee.

## Waking and sinking

`DormantNpcs.plugin.js` ([dormant-npcs.md](dormant-npcs.md)), family trigger `attacked`:
1. **A player attacks a dormant wyrm:** it becomes its awake form with that form's hitpoints and plays `wyrm_transition_up` (8268, 90 client cycles: 3 ticks). The player's attack goes ahead.
2. **While it rises,** it doesn't move or attack.
3. **Then** it attacks whoever woke it.
4. **Out of combat for 20 ticks,** it walks back to where it lay and sinks with `wyrm_transition_down` (8269, 60 cycles: 2 ticks), dormant again and healed.

## Combat

`server/plugins/npcs/Wyrms.plugin.js`, data in `server/data/definitions/wyrms.json`:
- **The style:** melee when the target touches the wyrm's footprint along an edge, magic otherwise, chosen as each attack starts. Its reach is magic's (10), so a wyrm attacked from a distance casts rather than walking in, and only uses magic (Wiki).
- **Max hits:** the hit is rolled up to the NPC's max hit (13, the magic one) with protection prayers applied, and a melee hit is scaled down to 10.
- **Animations and graphics (cache names):** `wyrm_attack_melee` 8270, `wyrm_attack_magic` 8271, the projectile `wyrm_range_proj` 1634, the impact `wyrm_range_impact` 1635 (a missed cast splashes).
- **Death and block:** `npc-combat-defs.json`: `wyrm_death` 8272 (120 cycles: `deathTicks` 4), no block animation. Wyrmlings share the wyrm's animations: their idle and walk are the same in the cache.
- **Sounds** are in the animations themselves (rise 4127/4114, sink 4073, melee 4085, magic 4070), so the client plays them.

## Estimates (no capture yet)

- **When it sinks:** 20 ticks out of combat, as the crabs.
- **The projectile's timing and start height:** the engine's usual magic values (leaves at cycle 51, 10 cycles a tile, starts at 43).
- **Its end height:** 22, the drake's in the captures (sent as 90; tsps sends heights ×4). The engine's usual 31 ended above the player's head.
- **Wyrmlings' rise, attack and death animations:** the wyrm's, inferred from their shared idle and walk.

A capture would settle these. It should include: attacks on a wyrm from range, then letting it melee, then walking away until it sinks; and the same with a wyrmling.

## Known issue

**The magic projectile jumps off its line a few times in flight.** Its graphic (`wyrm_range_proj` 1634) animates with `verzik_phase2_lightning_spot` (8115, 22 frames looping over all 22). The client's projectile code advances and loops those frames correctly. Either the lightning frames themselves shift the bolt sideways (and live OSRS looks the same), or our client draws this model's frames off the path. A capture or video of a wyrm casting will tell which.

## Not covered

- **Superior wyrms** (`superior_wyrm_transition_up` 8761, `superior_wyrm_range_proj` 1814).
