---
quest: A Ruff Situation
key: a_ruff_situation
status: passed
tested: 2026-10-25
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: fresh
travel:
---

# A Ruff Situation

Fresh route with real dog routes, three puppies and a grizzly fur drop crafted into the stuffed dog. A later check confirmed the Baraek paid-fur branch without changing quest state.

## Findings

- **open** Baraek's paid-fur dialogue gave neither fur nor payment; fix verified live, PR open for review. [#1238](https://github.com/RSPSApp/tsps/pull/1238)

## Runs

### 2026-10-25 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q099); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh.
- **Result:** varbit 15889 = 120; QP +1, Crafting +1,000 XP.
- **Checked:** repeat dialogue (Talia), relog, logout/offline, paid-fur purchase branch.
- **Not checked:** Combat aid after real encounters; Full recovery and overlay unchecked.
- **PRs:** [#1091](https://github.com/RSPSApp/tsps/pull/1091), [#1238](https://github.com/RSPSApp/tsps/pull/1238).
