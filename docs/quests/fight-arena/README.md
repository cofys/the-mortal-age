---
quest: Fight Arena
key: fight_arena
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Fight Arena

Checkpoint-linked natural route including the real Khazard encounter and jail action. Rewards and saves were independently checked.

## Findings

None recorded.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q040); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint.
- **Result:** varp 17 = 14; QP 0->2, coins +1,000, Attack +12,175, Thieving +2,175.
- **Checked:** repeat dialogue, relog, logout/offline.
- **Not checked:** Combat aid used after the Khazard encounter began; No full-branch or overlay claim.
- **PRs:** [#1121](https://github.com/RSPSApp/tsps/pull/1121).
