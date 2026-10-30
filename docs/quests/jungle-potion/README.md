---
quest: Jungle Potion
key: jungle_potion
status: passed
tested:
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Jungle Potion

All herbs including the Rogue's Purse from Pothole Cave were gathered and handed to Trufitus naturally. Rewards paid once; lost-herb recovery gave no extra progress.

## Findings

None recorded.

## Runs

### date not recorded · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q063); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: fresh stage-0 prefix to varp 175 = 9, resumed after a server restart.
- **Result:** varp 175 = 12; QP 4->5, Herblore +775 quest XP (+10 cleaning XP).
- **Checked:** repeat dialogue, relog, save history, logout/offline, lost-herb re-search recovery.
- **Not checked:** Full-bag, interrupted hand-in and pre-start/stale-slot recovery unchecked; Overlay unchecked.
- **PRs:** [#1135](https://github.com/RSPSApp/tsps/pull/1135).
