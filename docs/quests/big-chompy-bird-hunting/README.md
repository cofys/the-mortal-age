---
quest: Big Chompy Bird Hunting
key: big_chompy_bird_hunting
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Big Chompy Bird Hunting

Toad inflation, a real Chompy kill, Rantz hunt/cooking and the hand-in completed naturally on one account from a fresh start. Rewards matched the source exactly and survived relog.

## Findings

- **fixed** Item-on-NPC on swamp toads returned "I can't reach that!" until a shared MovementQueue/UseItemPacketListener reach fix.
- **open** Long westward walks beyond the local planner window stayed unresolved during an earlier checkpoint.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q006); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage-0 prefix to stage 20; saved checkpoint resumed after later restarts.
- **Result:** varp 293 = 65; QP 0->2, Cooking +1,470, Ranged +735, Fletching +262.
- **Checked:** repeat dialogue (Rantz), relog (twice), save history, logout/offline.
- **Not checked:** No overlay, all-branch or recovery claim; No separate QP reading at stage 60; Later plugin edits and uncovered recovery need rechecks.
- **PRs:** [#1097](https://github.com/RSPSApp/tsps/pull/1097).
