---
quest: Murder Mystery
key: murder_mystery
status: passed
tested: 2026-10-25
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Murder Mystery

Anna's alibi was disproved at the real compost heap and the Guard accepted the evidence. Rewards paid once and persisted.

## Findings

- **fixed** Mansion front-door leaves needed a shared door fix before Anna could be questioned.

## Runs

### 2026-10-25 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q080); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage-0 prefix, clues preserved, resumed without reset.
- **Result:** varp 192 = 2; QP +3, Crafting +1,406 XP, coins +2,000; evidence consumed.
- **Checked:** repeat dialogue (Guard), relog, save history, logout/offline.
- **Not checked:** Anna route only; alternate suspects unverified; Recovery and overlay unverified.
- **PRs:** [#1146](https://github.com/RSPSApp/tsps/pull/1146).
