---
quest: A Porcine of Interest
key: a_porcine_of_interest
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# A Porcine of Interest

Natural route to completion with rewards and Slayer points paid once and persisted.

## Findings

- **open** The optional Ned-shop rope path failed, so rope was supplied as a declared item.
- **fixed** Foot and Sarah wire values were corrected to match source.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q088); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage-0 prefix continued after a server restart.
- **Result:** varbit 10582 = 40; QP 0->1, Slayer +1,000 XP, coins +5,000, 30 Slayer points.
- **Checked:** post-quest task dialogue (no double points), relog, save history, logout/offline.
- **Not checked:** Helm upgrade, full-bag and cancellation branches unchecked; No overlay proof.
- **PRs:** [#1151](https://github.com/RSPSApp/tsps/pull/1151).
