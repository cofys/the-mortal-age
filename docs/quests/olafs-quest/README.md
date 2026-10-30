---
quest: Olaf's Quest
key: olafs_quest
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: fresh
travel:
---

# Olaf's Quest

Fresh natural route to completion; rewards were not duplicated on repeat or relog.

## Findings

None recorded.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q085); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh.
- **Result:** varbit 3534 = 80; QP 3->4, coins +20,000, four rubies, parchment.
- **Checked:** repeat dialogue, relog, logout/offline.
- **Not checked:** infhp used after the Ulfric encounter began; Full-bag, destroyed-barrel recovery, fall chance and overlay unchecked.
- **PRs:** [#1149](https://github.com/RSPSApp/tsps/pull/1149).
