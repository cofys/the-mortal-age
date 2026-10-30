---
quest: Client of Kourend
key: client_of_kourend
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Client of Kourend

All five houses, the Munty door, orb collection and Dark Altar were played naturally and Veos completed the quest. Rewards were paid once and held through relog.

## Findings

- **fixed** The Munty door needed a cache-pair fix before the natural route could pass it.
- **open** Destroyed unused-lamp recovery remains under investigation.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q010); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: linked fresh stage-0 route continued across a server restart.
- **Result:** durable stage 5; varbit 5619 = 9, varp 1566 = 4041; QP 1->2, memoirs x1, two lamps; orb consumed.
- **Checked:** repeat (Veos lost-reward option), relog, logout/offline.
- **Not checked:** Destroyed unused-lamp recovery, other recovery and overlay unchecked; A hung driver was replaced reusing the same actor (no reset).
- **PRs:** [#1101](https://github.com/RSPSApp/tsps/pull/1101).
