---
quest: Misthalin Mystery
key: misthalin_mystery
status: passed
tested: 2026-10-29
tester: agent
model: grok-4.7
commit: b6edd9b4ac46
cache: osrs-241_2026-10-20
start: fresh
travel: walk_to
---

# Misthalin Mystery

A fresh account ran the quest from Abigale in Lumbridge Swamp through the manor puzzles, the mirror fight and Mandy's reward. Rewards, the repeat talk and a relog all held, including after the server restart that loaded the two dialogue fixes. The coloured-door unlock line now names the key used, and talking to Hewey or Abigale after the reveal no longer replays the unmasking.

## Findings

Newest first. One line each, linked to its issue or PR when there is one.

- **fixed** Coloured doors (30116 ruby, 30117 emerald, 30119 sapphire) said "You use the [ruby/emerald/sapphire] key to unlock the door." The message now names the key that was consumed.
- **fixed** Talk-to on Hewey or Abigale after the reveal (stage 120) replayed the unmasking. That variant is no longer selected, and the click is consumed so the quest-start default does not play either. This is the defeated-villain half of [#1257](https://github.com/RSPSApp/tsps/issues/1257).
- **open** [#1257](https://github.com/RSPSApp/tsps/issues/1257) also reported scene and table-prop problems. This run did not see them: the knife table, notes, painting and fireplace all worked.

## Runs

Newest first. A rerun adds an entry; it never rewrites an older one.

### 2026-10-29 · agent · grok-4.7

- **Start:** fresh account, placed at 3235,3153,0 with `::tele` (the only teleport). Baseline: varbit 3468 = 0, quest points 0, Crafting experience 13,034,431, candle varbits 4039–4042 = 0, empty inventory and equipment.
- **Route:** Abigale, "Yes." (stage 10) → rowboat to the manor island → bucket (15) → Sid's scene (20) → fill the barrel and take the manor key (25) → front door (30) → knife → Tayten (35) → note 1 (40) → slash the library-side painting and take the ruby key (45) → ruby door (50) → tinderbox, four candles (55) → fuse (60) → leave and explode the wall (65) → climb out → Lacey, "Say nothing" (70) → note 2 (75) → piano D-E-A-D (80) → emerald door (85) → Mandy (90) → note 3 (95) → fireplace panel (100) → gem order sapphire, diamond, zenyte, emerald, onyx, ruby (105) → sapphire door (110) → three real mirror reflections (115) → reveal (120) → pick up and wield the killer's knife, Fight Abigale (125) → leave for Mandy's rescue (130) → Mandy outside completes (135). The island is a private area, so movement inside it was `walk_to` and object clicks, not `travel_to`.
- **Result:** varbit 3468 = 135, quest points 0 → 1, Crafting experience 13,034,431 → 13,035,031 (+600), uncut ruby, emerald and sapphire. Mandy's repeat talk gave no second reward. A relog, and a later login after the dialogue fix restarted the server, kept stage 135, the quest point, the experience, the gems, the notes and candle varbits 4039–4042.
- **Not checked:** Lacey's other answers, a full inventory at the reward, wrong keys and the wrong piano or gem order, the Quest Helper overlay, and clicking Fight on Abigale after the rescue.

### 2026-10-25 · community (thehardcorenoobs1234) · model not recorded

- **Source:** community report ([#1257](https://github.com/RSPSApp/tsps/issues/1257)); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Not checked:** Single account/run report; no full Quest Helper, recovery, multiplayer, dialogue, event or cutscene parity claim.
