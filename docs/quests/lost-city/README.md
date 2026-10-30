---
quest: Lost City
key: lost_city
status: passed
tested: 2026-10-24
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Lost City

Entrana, the zombie axe drop, Tree Spirit, Dramen staff and the shed door into Zanaris were played naturally. Accepted narrowly as combat-assisted.

## Findings

None recorded.

## Runs

### 2026-10-24 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q067); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage-0 baseline; stage-2 prefix preserved across restarts.
- **Result:** varp 147 = 6; QP 0->3; no quest skill XP.
- **Checked:** repeat dialogue (Warrior), relog, save history, logout/offline.
- **Not checked:** Combat-assisted: zombie HP setters, some at full HP without a logged hit; infhp used for the Tree Spirit fight; No branch/recovery or overlay claim.
- **PRs:** [#1138](https://github.com/RSPSApp/tsps/pull/1138).
