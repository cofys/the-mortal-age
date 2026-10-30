---
quest: Clock Tower
key: clock_tower
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Clock Tower

From a saved stage-3 checkpoint the black and white cogs were placed naturally and Kojo completed the quest. Rewards were not duplicated on repeat or relog.

## Findings

- **fixed** An earlier attempt stopped at stage 3; cog handling, shared lever, trough scope and white-ladder surface exit were then fixed.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q011); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: resumed preserved stage-3 checkpoint (red/blue cogs placed).
- **Result:** varp 10 = 8; QP +1, coins +500; no skill XP.
- **Checked:** repeat dialogue (Kojo), relog, logout/offline.
- **Not checked:** Checkpoint continuation, not a fresh stage-0 route; Overlay not visually checked.
- **PRs:** [#1102](https://github.com/RSPSApp/tsps/pull/1102).
