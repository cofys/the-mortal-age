---
quest: Gertrude's Cat
key: gertrudes_cat
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: fresh
travel:
---

# Gertrude's Cat

Fresh natural house/fence/ladder/crate route with rewards paid once. A post-quest 100-coin kitten purchase worked and persisted.

## Findings

- **open** Varp 181's random-crate selection is an approximation.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q048); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh.
- **Result:** varp 180 = 6; QP +1, Cooking +1,525 XP, kitten, cake, stew.
- **Checked:** post-quest kitten purchase, relog, logout/offline.
- **Not checked:** Full-bag and cancellation branches unchecked; Overlay not certified.
- **PRs:** [#1124](https://github.com/RSPSApp/tsps/pull/1124).
