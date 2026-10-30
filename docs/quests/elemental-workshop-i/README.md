---
quest: Elemental Workshop I
key: elemental_workshop_i
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: fresh
travel:
---

# Elemental Workshop I

Fresh natural route through the bookcase, wall, water/air/lava machinery and a real elemental drop to the shield. Quest rewards paid once and persisted.

## Findings

- **fixed** Entered-wall state, slashed-book requirements, valves, recoverable supplies and elemental floor loot were corrected.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q030); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh.
- **Result:** varbit 13718 = 2; QP +1, Crafting +5,000, Smithing +5,000, one shield.
- **Checked:** second legitimate shield craft without repeat reward, relog, logout/offline.
- **Not checked:** Optional recovery, exact skill gates, book interface/visuals, base crafting XP and overlay unchecked; HP1 aid after each elemental was really hit.
- **PRs:** [#1116](https://github.com/RSPSApp/tsps/pull/1116).
