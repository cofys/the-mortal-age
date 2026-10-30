---
quest: The Depths of Despair
key: the_depths_of_despair
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# The Depths of Despair

Library book, cave crossing, Artur, Sand Snake and the Accord were played naturally to the Lord Kandur hand-in. Rewards were paid once and persisted.

## Findings

- **fixed** Stepping-stone approach was fixed to use cache-backed movement.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q019); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage 0, saved checkpoint continued after later restarts.
- **Result:** durable stage 9; varbit 6027 = 11, varbit 6028 = 1; QP 1->2, Agility +1,500 XP, coins +4,000, lunch book.
- **Checked:** repeat dialogue (Lord Kandur), relog, logout/offline.
- **Not checked:** Alternate branches, recovery and overlay unchecked; Invulnerability/HP1 aids after real crab hits.
- **PRs:** [#1109](https://github.com/RSPSApp/tsps/pull/1109).
