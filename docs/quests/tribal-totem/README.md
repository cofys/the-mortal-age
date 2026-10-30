---
quest: Tribal Totem
key: tribal_totem
status: passed
tested: 2026-10-25
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Tribal Totem

Address-label delivery, Cromperty teleport, the KURT puzzle, stairs and chest were played naturally to the Kangai hand-in. Rewards paid once and persisted.

## Findings

- **open** The real chest needed Tourist Trap's shared object-owner fix (draft PR). [#1250](https://github.com/RSPSApp/tsps/pull/1250)
- **fixed** Combination lock fix merged after a bounded checkpoint. [#1237](https://github.com/RSPSApp/tsps/pull/1237)

## Runs

### 2026-10-25 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q118); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage-0 prefix, continued across two later server restarts.
- **Result:** varp 200 = 5; QP +1, Thieving +1,775 XP, five swordfish.
- **Checked:** repeat dialogue, relog, logout/offline.
- **Not checked:** Not a fresh single replay; Alternate/recovery and overlay unchecked.
- **PRs:** [#1183](https://github.com/RSPSApp/tsps/pull/1183), [#1237](https://github.com/RSPSApp/tsps/pull/1237).
