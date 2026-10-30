---
quest: Sheep Shearer
key: sheep_shearer
status: passed-with-issues
tested: 2026-10-29
tester: agent
model: grok-4.7
commit: b6edd9b4ac46
cache: osrs-241_2026-10-20
start: fresh
travel: travel_to
---

# Sheep Shearer

A watched account with the quest unstarted finished the normal route: Fred's start, twenty
sheared sheep, the Lumbridge castle spinning wheel, the hand-in, the reward scroll, a repeat
talk, and a relog. The Thing's escape animation played. `travel_to` still notes a staircase
id mismatch on the way up into the castle.

## Findings

- **open** `travel_to` Climb-up on the Lumbridge castle staircase at 3204, 3207 used object
  56230, found by name. The live transport id is 16671. The hop still arrived. Climb-down
  on 16672 at the same tile had no note.

## Runs

### 2026-10-29 · agent · grok-4.7

- **Start:** quest unstarted (varp 179 = 0, quest points varp 101 = 0, empty inventory and
  equipment). The account was already level 99 in every skill (13,034,431 XP). Placed at
  3190, 3274 with `::tele` (the only teleport). The user watched in their own client.
- **Route:** Fred the Farmer, "I'm looking for a quest.", then "Yes." Varp 179 became 1 and
  Fred gave shears (1735). `travel_to` into the pen opened door 13001, gate 12987 and stile
  12982. Shearing The Thing (NPC 731) played animation 3570 a tick later and, on the third
  tick, "The... whatever it is... manages to get away from you!" Twenty Shear clicks each
  gave "You get some wool." `travel_to` to the castle spinning wheel (14889 at 3209, 3212,
  plane 1) opened gate 12986, climbed the staircase and opened door 1543. Spinning all
  twenty took Crafting from 13,034,431 to 13,034,481. `travel_to` back used staircase 16672.
  "I need to talk to you about shearing these sheep!" handed over "You give Fred 20 balls of
  wool."
- **Result:** varp 179: 1 → 21. Quest points: 0 → 1. Crafting: 13,034,481 → 13,034,631
  (+150). Inventory: twenty balls of wool removed, 60 coins added, shears kept. Scroll:
  "You have completed Sheep Shearer!", "Quest points: 1", "1 Quest Point", "150 Crafting XP",
  "60 Coins". Repeat talk offered the post-quest options, including The Thing; "I'm lost."
  gave Fred's directions and no further reward. After relog, varp 179 stayed 21, quest
  points stayed 1, Crafting stayed 13,034,631, and the shears and 60 coins were still there.
- **Not checked:** handing wool in over several visits, starting while already holding 20
  balls, a full inventory when Fred offers shears, wool regrowth, Zanaris sheep, the quest
  journal, the other pre-start options, and the post-quest Thing conversation. Not checked
  visually.

### 2026-10-25 · community (thehardcorenoobs1234) · model not recorded

- **Source:** community report ([#1257](https://github.com/RSPSApp/tsps/issues/1257)); moved
  here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later
  plugin change is not flagged automatically. That report said the sheep escape animation
  was missing; the 2026-10-29 run did not reproduce it.
- **Not checked:** Single account/run report; no full Quest Helper, recovery, multiplayer,
  dialogue, event or cutscene parity claim.
