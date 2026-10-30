---
quest: Hazeel Cult
key: hazeel_cult
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: fresh
travel:
---

# Hazeel Cult

Hazeel-side route from Ceril/Clivet through poisoning, valves, raft and the scroll hand-in completed naturally. Rewards paid once and persisted.

## Findings

- **fixed** Post-quest Alomone and Jones were unavailable; fixed and natively verified.
- **fixed** Upstairs door/wall and chest needed a shared-world ownership fix.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q055); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh: Hazeel side; initial varp 223 = 0 inferred, not read.
- **Result:** varp 223 = 9; QP 0->1, Thieving +1,500 XP, coins +2,000.
- **Checked:** repeat dialogue (Clivet), relog, logout/offline, post-quest Alomone/Jones dialogue after relog.
- **Not checked:** Carnillean side and optional recovery unchecked; Scene visuals and overlay unchecked.
- **PRs:** [#1130](https://github.com/RSPSApp/tsps/pull/1130).
