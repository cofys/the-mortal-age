---
quest: The Knight's Sword
key: the_knights_sword    # the plugin's registerQuest key; the folder is this key with - for _
status: passed-with-issues # passed | passed-with-issues | in-progress | failed | untested
tested: 2026-10-30        # date of the latest run
tester: agent             # agent | human | community
model: claude-haiku-5-5   # the model that ran it (agents), else leave empty
commit: cd2eef34da4d70594d51618e0ae9464496c9af9f
cache: osrs-241_2026-10-20
start: checkpoint         # fresh | checkpoint (say from which stage under Runs)
travel: travel_to         # travel_to | walk_to | manual; never ::tele after the start
---

# The Knight's Sword

The latest run proved the full route from the Squire to the completed quest on a
persisted account: each stage change, the Thurgo and Reldo hand-overs, the portrait search,
the blurite mining, the sword hand-in, the rewards (12,725 Smithing XP, 1 quest point), the repeat
talk to the Squire and Thurgo, and a logout/login that kept stage 7. It did not prove an
unconditional `travel_to` route: three shortcut legs (see Findings) were blocked and had to
be walked or routed around by hand.

## Findings

Newest first. One line each, linked to its issue or PR when there is one.

- **open** Rough wall `62419` at (3032, 3388), "Climb": nothing happens on the server, and
  `travel_to` blocks on it. The transport table lists it. Not a quest fault. Agility/travel_to.
- **open** Stepping stone `16533` (Draynor shore, stones at (3150, 3363) and (3153, 3363)):
  `travel_to` clicks x 3151, the server reports "unreachable" and "You can't reach that!". Agility/travel_to.
- **open** `travel_to` calls can exceed a 90-second client timeout while still walking on the
  server; resuming with a smaller `budgetTicks` works. Agent MCP.
- **open** Reldo's location (3209, 3495) is reported in `DogQuestArea`. Not quest code; area
  assignment, not verified.
- **open** Opened cupboard state (`2272`) resets on a server restart. Expected, but the quest
  page's search step needs the cupboard reopened after a restart.
- **open** The Sir Vyvin cupboard search needs a tile where Vyvin is not watching. Searching
  through the object action walks the player to the front tile first, so probing has to use
  exact `walk_to` tiles. Test-tooling note only.

## Runs

### 2026-10-30 · agent · claude-haiku-5-5

- **Start:** an existing max-level test account (all skills 99, empty inventory), quest
  varp 0 and not started. No `::tele`; the account walked to Falador with `travel_to`.
- **Route:** Squire (White Knights' Castle) to start the quest → Reldo (Varrock Palace area)
  → Thurgo (south of Port Sarim) with a redberry pie → Squire for a picture → Sir Vyvin's
  cupboard (portrait) → Thurgo, who wants iron bars and blurite → the trapdoor south of Port
  Sarim into the Asgarnian Ice Dungeon, blurite mined from the rock at (3049, 9566) → Thurgo
  makes the sword → Squire hand-in. Declared setup: one redberry pie, two iron bars and a rune
  pickaxe, spawned with `command`.
- **Result:** stage 1 → 2 (Reldo) → 3 (pie) → 4 (picture request) → 5 (portrait taken) → 6
  (portrait handed to Thurgo) → 7 (sword handed to the Squire). Rewards: 12,725 Smithing
  XP (13,034,431 → 13,047,156) and 1 quest point (`varp 101`: 0 → 1). Repeat talk to the Squire
  and Thurgo gives the after-quest dialogue and no reward. Logout/login kept stage 7 and rewards.
- **Not checked:** the other Reldo id (4243, 12626) and the alternate Thurgo branches (only the
  main route was followed); the death and drop path in the Ice Dungeon; ice giants (not met).
