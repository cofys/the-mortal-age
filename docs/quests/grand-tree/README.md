---
quest: The Grand Tree
key: grand_tree
status: passed-with-issues
tested: 2026-10-29
tester: agent
model: claude-haiku-5-5
commit: 62d662706242
cache: osrs-241_2026-10-20
start: fresh
travel: travel_to
---

# The Grand Tree

A fresh account ran the quest from King Narnode to the completion scroll, with the
natural twig, trapdoor and Daconia rock steps. Rewards, the repeat talk and a relog all
checked out. Open: the translation quiz doesn't track wrong answers, and `travel_to` has
several route problems (gate, open doors, a Castle Wars transport) that the run worked around.

## Findings

Newest first. One line each, linked to its issue or PR when there is one.

- **open** Translation quiz (King Narnode, stage 30): `answerCondition` always takes the "correct" branch, so wrong picks in groups 3–5 are never tracked and the "Are you sure you translated correctly?" branch is unreachable.
- **open** Lumber order hint says to take it to King Narnode, but the code only consumes it on Charlie's clue line (stage 100). The wiki order is Narnode (no stage change), then Charlie.
- **open** (travel_to) The planner routes through gate 190 at 2461,3384, which the live world doesn't have: "Object with id 190 does not exist".
- **open** (travel_to) The planner clicks "Open" on tree doors that are already open (1967/1968 at the base); nothing happens and the leg blocks. Walking through by hand works.
- **open** (travel_to) The Castle Wars recruiter transport (8644) to the Castle Wars lobby is blocked on "Join".
- **open** (Monkey Madness I) The shipyard gate guard (`enterShipyard`) refuses anyone opening the gate from inside without the royal seal, so a player who finishes the Karamja shipyard can't leave. Worked around with a Varrock Teleport (runes supplied as setup).
- **fixed** The staircase at 2389,3512 (climb-up) put the player on the tile in front of the stairs, blocking the way to Anita. Its landing is now declared as 2388,3513,1 in `plugins/objects/data/climb-links.json`.
- **fixed** The cave ladder at 2463,9897 didn't climb: its surface end is a trapdoor showing only "Open", so the generic pairing found nothing. Declared with landing 2463,3498,0 in the same file.
- **fixed** The watchtower tree (2447) climb-up landed on 2484,3465,2; it now lands on 2485,3465,2 (`GrandTree.Quest.js`).
- **fixed** Monkey Madness II's tree 28800 Climb-down landed on 2485,3464,1; it now lands on 2484,3463,1 (`MonkeyMadnessII.Quest.js`, the branch split from tree 13).

## Runs

Newest first. A rerun adds an entry; it never rewrites an older one.

### 2026-10-29 · agent · claude-haiku-5-5

- **Start:** fresh account, placed at the quest start (2466,3497,0) with `::tele` (the only teleport). Baseline: quest points 0, quest varp 0, all skills at 99, empty inventory and equipment.
- **Route:** King Narnode (start, stage 10) → Hazelmere on the island east of Yanille (20) → back to Narnode (30, correct translation picks) → Glough's tree house (40) → Narnode (50) → Charlie's cell (60) → Glough's cupboard for the journal (70) → confronting Glough (arrested to the cell, released, 80) → Captain Errdo's glider to Karamja → shipyard gate with the password Ka-Lu-Min → the Foreman's questions (lumber order, 90) → Charlie's clue (100) → Anita's key (ladder at 2389,3512) → Glough's chest for the invasion plans (110) → Narnode (120, four twigs) → pillars 2440–2443 in T-U-Z-O order (130) → trapdoor → black demon (140) → Narnode → Daconia rock from the roots (150) → Narnode completes (160).
- **Result:** stage 160; quest points 0 → 5; XP Attack +18,400, Agility +7,900 (+32 activity), Magic +2,150 (+35 activity); the Daconia rock consumed. The repeat talk with Narnode gave no reward. After a relog, stage, quest points and XP were unchanged, and the saved row held stage 160 and quest points 5.
- **Not checked:** the black demon was killed with `::maxgear melee` by the tester, so it isn't a natural-gear fight. Spirit tree and gnome glider access (the rewards) weren't used. The Quest Helper route wasn't compared step by step. The visual overlay wasn't checked. No recovery cases exist in this quest beyond the twigs and the replacement items, which weren't exercised.
