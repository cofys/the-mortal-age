---
quest: Druidic Ritual
key: druidic_ritual
status: passed
tested: 2026-10-22
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Druidic Ritual

Meats were dipped in the cauldron and handed to Sanfew, then Kaqemeex completed the quest, with rewards paid once. The run entered the dungeon through an alternate door; the prison gate was fixed later and checked on its own.

## Findings

- **fixed** Both prison-door leaves (2143/2144) failed to open, so the accepted run used Door 1549 as an alternate entrance. https://github.com/RSPSApp/tsps/issues/1080

## Runs

### 2026-10-22 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q026); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage-0 baseline, continued from saved stage 2.
- **Result:** varp 80 = 4; QP +1 (to 4), Herblore +250 XP.
- **Checked:** repeat dialogue (Kaqemeex), relog, logout/offline, death and grave recovery.
- **Not checked:** Prison-gate step verified only in a later bounded checkpoint, not a full route; Overlay and blanket recovery unchecked.
- **PRs:** [#1113](https://github.com/RSPSApp/tsps/pull/1113).
