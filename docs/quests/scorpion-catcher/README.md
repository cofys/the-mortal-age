---
quest: Scorpion Catcher
key: scorpion_catcher
status: passed-with-issues
tested: 2026-10-29
tester: agent
model: grok-4.7
commit: 62d662706242
cache: osrs-241_2026-10-20
start: fresh
travel: travel_to
---

# Scorpion Catcher

A fresh account completed the Quest Helper route: Thormac, the Seer, the three Kharid
scorpions, and the hand-in. Rewards, a repeat talk, and a relog all held. Thormac's
battlestaff enchant opened and then closed on the same tick; that is fixed and was
retested. A few shared and travel problems remain.

## Findings

- **fixed** Thormac's enchant screen (interface 332) was removed when the conversation ended, so Enchant did nothing. It now opens on the next tick, and only that screen closing ends the service.
- **fixed** Velrak's cell and the dusty key both work. The jail key opened the door at 2931, 9690, Velrak gave the dusty key, and that key opened the gate at 2924, 9803. [#1204](https://github.com/RSPSApp/tsps/issues/1204) is closed.
- **open** Abbot Langley tells a player with 31 Prayer or more that they are not devout enough, and shows "You need a prayer level of 31 to join the order." Nothing answers the transcript's prayer conditions, so the first branch wins. The ladder at 3057, 3483 still climbs. Shared monastery dialogue, outside this quest.
- **open** `travel_to` reported the large door at 2908, 9698 (loc 1521) blocked ("nothing happened after Open") after the door had opened. Walking through it worked.
- **open** `travel_to` has no route out of the Taverley secret room. The Old wall at 2875, 9799 (loc 2117) is not a planned transport. Search works and crosses it.
- **open** `travel_to` to the Sorcerer's Tower top from west of Seers' Village returned no-route near 2601, 3477. The ground floor, then the ladders, worked.
- **open** Thormac's post-quest line shows the unresolved price "[20,000 / 30,000 / 40,000]" instead of 40,000 coins. That text is generated dialogue. The enchant still charges 40,000.

## Runs

### 2026-10-29 · agent · grok-4.7

- **Start:** fresh account (varp 76 = 0, quest points 0, all skills 1 except Hitpoints 10). Declared setup before the baseline: Prayer set to 31, 10 sharks, two antipoison potions, an anti-dragon shield equipped, and invulnerability acknowledged. Placed at the Sorcerer's Tower ladder (2701, 3408, 0) with `::tele`, the only admin teleport. During the Jailer fight the player ran `::master`; the Strength reward is measured from the snapshot taken just before the hand-in.
- **Route:** three ladders to Thormac. "What do you need assistance with?" then "Yes." gave the empty cage and set varp 76 to 1. Seer in Seers' Village, "I need to locate some scorpions.", set varp 76 to 2. Taverley Dungeon: Jailer drop (jail key), cell door, Velrak ("So... do you know anywhere good to explore?" / "Yes please!") for the dusty key, deeper gate, Search on the Old wall, cage on the scorpion (cage 456 → 457). Edgeville Monastery ladder, door, cage (457 → 459). Barbarian Outpost gate and door, cage (459 → 463, all three). Back to Thormac.
- **Result:** hand-in removed the full cage. Varp 76: 2 → 6. Quest points (varp 101): 0 → 1. Strength XP: 13,034,479 → 13,041,104 (+6,625). Completion message shown. Talking to Thormac again did not repeat the rewards. Enchanting an air battlestaff for 40,000 coins produced a mystic air staff; quest state did not change. Logout and login kept varp 76 = 6, 1 quest point, the Strength XP, and the mystic staff.
- **Not checked:** the Seer's second hint, Peksa, reclaiming a lost cage, the pick-up sting, other battlestaves, diary prices, a full inventory at the cage hand-out, the missing Barcrawl start gate, and the Quest Helper overlay.
