---
quest: Death Plateau
key: death_plateau
status: passed
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Death Plateau

Harold's IOU, stone balls, Saba's cave, Tenzing/Dunstan chain and the secret trail were played naturally to Denulth. Rewards paid once and persisted.

## Findings

- **fixed** Shared dialogue runner now continues explicitly true linear sibling conditions.

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q017); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage 0, linked across three server runs.
- **Result:** varp 314 = 80; QP 0->1, Attack +3,000 XP, steel claws x1.
- **Checked:** repeat dialogue (Denulth), relog, logout/offline, full-bag certificate recovery.
- **Not checked:** Other recovery, alternate dialogue and overlay unchecked; Invulnerability used during optional troll encounters.
- **PRs:** [#1107](https://github.com/RSPSApp/tsps/pull/1107).
