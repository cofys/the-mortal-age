---
quest: The Queen of Thieves
key: the_queen_of_thieves
status: passed-with-issues
tested: 2026-10-25
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: fresh
travel:
---

# The Queen of Thieves

Fresh natural route through the manhole, Devan, Hughes and Lady Shauna to completion. A later revision restored the reward flag after relog on the same completed account.

## Findings

- **fixed** Reward flag varbit 6038 reset to 0 after relog; fixed by bootstrap replay.
- **open** Memoir charges/teleports, graceful recolour and letter-reading are not implemented.
- **open** Veos/Magoro transport attempts did nothing.

## Runs

### 2026-10-25 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q090); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh: fresh at the canonical Tomas start.
- **Result:** varbit 6037 = 13; varbit 6038 = 1; QP 2->3, Thieving +2,000 XP, coins +2,000, Flute, Antique lamp.
- **Checked:** repeat dialogue, relog, logout/offline, reward-flag replay after relog.
- **Not checked:** Memoir use, other branches, recovery and overlay unclaimed.
- **PRs:** [#1154](https://github.com/RSPSApp/tsps/pull/1154).
