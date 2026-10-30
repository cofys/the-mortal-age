---
quest: Observatory Quest
key: observatory_quest
status: passed-with-issues
tested: 2026-10-25
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: fresh
travel:
---

# Observatory Quest

Fresh natural route through the material hand-ins, kitchen key, gate, mould, lens and telescope to the Taurus reward. Rewards paid once and persisted.

## Findings

- **open** A duplicate guard remained visible after the encounter.

## Runs

### 2026-10-25 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q084); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh.
- **Result:** varp 112 = 7; varbit 3836 = 1; QP 3->5, Crafting +2,250 XP, uncut sapphire, Taurus reward item.
- **Checked:** repeat dialogue (Professor), relog, logout/offline.
- **Not checked:** Guard HP reduced with infhp/set_npc_hitpoints after a real hit; Assistant wine, other constellations, recovery/full-bag and overlay unclaimed.
- **PRs:** [#1148](https://github.com/RSPSApp/tsps/pull/1148).
