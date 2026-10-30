---
quest: Monk's Friend
key: monks_friend
status: passed
tested:
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: fresh
travel:
---

# Monk's Friend

Fresh natural route to the party and completion with exact rewards once. A later fresh recheck on the revised source (2026-10-22) confirmed the full-bag handover, pickup, repeat and persistence without adding to the count.

## Findings

- **fixed** Normal-rune payment came too late (after the party).
- **fixed** Named Monk dialogue variants were unreachable.

## Runs

### date not recorded · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q074); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh.
- **Result:** varp 30 = 80; QP +1, Woodcutting +2,000 XP, 8 law runes.
- **Checked:** full-bag rune drop and pickup, relog after rune handover, repeat dialogue, logout/offline.
- **Not checked:** A Wiki-marked later dialogue and overlay unchecked; Plank-only branch, interrupted pending-box relog and post-window selector unchecked on the newer revision.
- **PRs:** [#1144](https://github.com/RSPSApp/tsps/pull/1144).
