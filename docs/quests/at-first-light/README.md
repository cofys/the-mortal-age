---
quest: At First Light
key: at_first_light
status: passed-with-issues
tested:
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start:
travel:
---

# At First Light

Completion and rewards were observed and persisted, but the route is not accepted because it used a teleport recovery. The affected hammer pickup was proved separately.

## Findings

- **fixed** Missing needle and hammer ground spawns were added.
- **open** Latest peer review found three interruption/recovery defects needing source repair.

## Runs

### date not recorded · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q004); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Result:** varbit 9835 = 12; QP +1, Hunter +4,774, Construction +800, Herblore +500, Crafting +10.
- **Checked:** relog, post-quest history (no duplicate), hammer pickup from south tile + relog.
- **Not checked:** Route used a noncanonical ::teleports recovery; Second post-quest history choice not selected; Not accepted as a full natural route.
- **PRs:** [#1094](https://github.com/RSPSApp/tsps/pull/1094).
