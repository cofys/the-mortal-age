---
quest: Children of the Sun
key: children_of_the_sun
status: passed-with-issues
tested: 2026-10-30
tester: agent
model: grok-4.7
commit: aae31c4bcf84
cache: osrs-241_2026-10-20
start: fresh
travel: travel_to
---

# Children of the Sun

A watched fresh account finished the Wiki route, from Alina through the tail, the four
marked bandits and the palace-roof interrogation. Rewards, a repeat talk and a relog
held. Completion now sets varbit 9652 to 1, checked again after login. Several cutscenes
are still messages and cameras rather than the live scenes, and Alina still offers the
start prompt after the quest is done.

## Findings

- **fixed** Completion left varbit 9652 (`vmq2_first_travel`) at 0. Live completion sets it
  to 1 (Quest Helper capture, 2025-08-05). Login and bootstrap now send 1 when a finished
  save is still at 0, and leave 2 or above alone.
- **open** After completion, Alina (12644) and Noah (12646) still play the quest-start
  dialogue, including "Start the Children of the Sun quest?". The dialogue dump and the
  wiki transcript have no post-quest variant. Choosing No left stage 24. The start hook
  only starts the quest from stage 0.
- **open** The tail fails only by distance: spotted at 1 tile or closer, too far past 14.
  There is no line of sight or look-back, so walking a few tiles behind in the open is
  enough. Those checks are uncaptured, so they were left as they are.
- **open** The delegation, the guard leaving with the bag, and the eavesdrop are camera
  moves plus chat. Scene directions arrive as game messages, and a line whose speaker is
  not an NPC gameval uses the clicked NPC's chathead.
- **open** The escort to the palace roof teleports to (3203, 3473, 2) instead of walking
  the stairs.
- **open** The cell scene stays on the palace roof. Leaving flashes through (10172, 3399, 2)
  for one tick. The existing parity test treats that hop as the captured transition.
- **open** "Children of the Sun", "Plots and Plans" and "The Burning Sun" unlock together
  when the quest completes. The wiki plays them on arriving at the delegation, while
  following the guard, and during the interrogation.

## Runs

### 2026-10-30 · agent · grok-4.7

- **Start:** fresh account Tester. Quest points (varp 101) 0, stage varbit 9632 = 0, varp
  4075 = 0, guard varbits 9633–9644 = 0, 9645 = 0, 9646 = 0, 9650 = 0, 9652 = 0. Empty
  inventory and equipment. Every skill already 99 (13,034,431 XP). Placed at 3223, 3424
  with `::tele` (the only teleport). No items. The user watched in their own client. The
  route was played on upstream/main `f708f22315dd`; the 9652 login check is on `aae31c4bcf84`.
- **Route:** Talk-to Alina (12644). Varbit 9646 → 1. Yes, then "When will this delegation
  arrive?". Stage 6 and the bag guard (12661) spawned. Two follows lost the guard after a
  pause and returned to stage 2 with "You failed to stay close enough to the guard.";
  talking to Alina restarted the tail. The third follow stayed a few tiles behind and
  reached stage 8 at the door. Open on door 50048 at (3259, 3400) played the eavesdrop and
  reached stage 10. `travel_to` Sergeant Tobyn (12648) at (3211, 3437) walked 46 tiles with
  no blocked leg and no note. His briefing reached stage 12. Mark on the four bandit posts
  (3208, 3422), (3221, 3430), (3246, 3429) and (3237, 3427) set varbits 9633–9636 to 2 and
  left the real-guard varbits at 0. Stage 14. `travel_to` back to Tobyn walked 32 tiles,
  again clear. The report teleported to the roof (3203, 3473, 2) at stage 16. Talking to
  Tobyn ran the interrogation: 16 → 18 on the roof, 18 → 20 through (10172, 3399, 2),
  20 → 22 as Itzla left, 22 → 24 complete.
- **Result:** "Congratulations, you've completed a quest: Children of the Sun". Quest points
  0 → 1. No XP change and no items. Varbit 9632 = 24, 9645 = 2, 9646 = 1, 9650 = 0.
  Varbit 9652 was still 0 on that completion. `travel_to` from the roof back to Alina
  walked 75 tiles (two doors, a ladder and a staircase) with no blocked leg and no note.
  A repeat talk replayed the start and offered Yes/No; No left stage 24. The user logged
  out and back in: stage 24, the four marks, 9645 = 2, 9646 = 1 and 1 quest point all
  held, and 9652 was still 0. After the fix, logging in again left stage 24, 9645 = 2,
  quest points 1, and set 9652 to 1 (varp 4076 = 512). Skills, inventory and equipment
  were unchanged.
- **Not checked:** marking or unmarking a real guard in-game (the parity test covers a
  wrong guard), being spotted by standing on the guard, choosing Yes on the post-quest
  start prompt, starting with Noah, the "What can you tell me about Varlamore?" and
  "How come you know so much?" options, the members gate, the first Quetzal trip
  (9652 from 1 through 2, 3 and 4, and varbit 9650), climbing the palace stairs instead
  of the escort teleport, and logging out mid-tail, mid-marking or mid-cell. The three
  music tracks were already unlocked by completion, so their earlier cue points were not
  replayed.
