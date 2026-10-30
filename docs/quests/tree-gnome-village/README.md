---
quest: Tree Gnome Village
key: tree_gnome_village
status: passed
tested: 2026-10-29
tester: agent
model: grok-4.7
commit: 62d662706242
cache: osrs-241_2026-10-20
start: fresh
travel: travel_to
---

# Tree Gnome Village

A fresh run followed the Wiki route from King Bolren through the trackers, ballista, stronghold, warlord and ceremony. Rewards paid once, a repeat talk did not pay again, and a relog kept the stage and rewards.

## Findings

- **open** `travel_to` inside the Khazard stronghold clicks Open on Door 2184 (`khazard_stronghold_door`, 2502, 3250). That door stays closed; the way out is Climb-over on the crumbled wall (2185 at 2509, 3253), from the north side onto 2509, 3252. `travel_to` returns `no-route` or `blocked` and does not take the climb.
- **fixed** Elkoy's guide landing, maze railing and the owned warlord encounter were corrected. [#1182](https://github.com/RSPSApp/tsps/pull/1182)

## Runs

### 2026-10-29 · agent · grok-4.7

- **Start:** fresh, varp 111 = 0 and 0 quest points. Placed beside King Bolren with `::tele` (the only teleport). Declared setup: 6 logs, an abyssal whip, 8 sharks, and `::infhp` (acknowledged on).
- **Route:** Bolren start, escorted to the maze entrance (stage 1). `travel_to` to Commander Montai: offer, hand in the logs, then the tracker task (stages 2, 3, 4). Tracker 2, tracker 1, then tracker 3, whose line was "More than my head, less than my fingers" (ballista varbit 602 = 1, so coordinate 0002). Fired the ballista at 2508, 3210 (stage 5). Climbed the crumbled wall, climbed the ladder, opened the closed chest and took the orb (stage 6). Climbed the wall back out after `travel_to` could not. Elkoy into the village, returned the orb to Bolren (stage 7, varbit 598 = 1), Elkoy back out. Talked to the warlord (7621); the owned fighter (7622) spawned with varbit 3460 set. One whip hit (170 to 167 hitpoints), then hitpoints set to 1. Death gave the orbs (stage 8). Elkoy in, Bolren's ceremony, quest complete.
- **Result:** varp 111 = 9, varbit 598 = 2. Quest points 0 to 2. Attack experience 13,034,447 before the reward, then 13,045,897 (+11,450). Hitpoints experience from the fight (+5) did not change again. Gnome amulet (589) once. Repeat talk with Bolren left quest points, Attack experience and the amulet unchanged. Relog kept stage 9, 2 quest points, the amulet and the Attack experience.
- **Not checked:** wrong ballista coordinate then a retry, killing the Khazard commanders, an unassisted warlord fight, a full inventory or lost orb/amulet reclaim, spirit tree travel, and the quest overlay.

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q117); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh King Bolren start; earned checkpoints linked without reset.
- **Result:** varp 111 = 9; QP 0->2, Attack +11,450 XP, Gnome amulet.
- **Checked:** repeat dialogue, relog, logout/offline.
- **Not checked:** HP1 aids after real damage; Recovery, optional branches, ceremony camera/timing and overlay unchecked; Initial varp 111 = 0 inferred.
- **PRs:** [#1182](https://github.com/RSPSApp/tsps/pull/1182).
