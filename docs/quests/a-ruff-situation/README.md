---
quest: A Ruff Situation
key: a_ruff_situation
status: passed
tested: 2026-10-30
tester: agent
model: claude-haiku-5-5
commit: f4d1ea6cb372953c5175b0ec281ca38251c4fc38
cache: osrs-241_2026-10-20
start: fresh
travel: Talia to Gertrude's house (Varrock); stray dog route to the den and the cook scene; goblin camp; third-puppy search; outlaw camp; Baraek for the paid-fur check
---

# A Ruff Situation

Fresh route with real dog routes, three puppies and a stuffed dog crafted from declared bear fur. The 2026-10-30 run also covered Baraek's paid-fur purchase and a relog after completion.

## Findings

- **fixed** Baraek's paid-fur dialogue gave neither fur nor payment; the fix is merged and verified live (100 → 80 coins, +1 fur). [#1238](https://github.com/RSPSApp/tsps/pull/1238)
- **open (unconfirmed)** After the den route ended, the stray dog walked off her den tile while the player waited. She was reachable again, and her Interact then started the cook route. Not confirmed as a bug; check the den end state if a rerun shows her missing from the den.

## Runs

### 2026-10-30 · agent · claude-haiku-5-5

- **Source:** full start-to-finish run on the `Tester` account from `upstream/main` `f4d1ea6cb`, after the 2026-10-25 pass. The quest's own file had not changed since that pass; this run was made because shared transcript and chatbox code changed on 2026-10-30.
- **Start:** fresh (varbit 15889 = 0, varp 5742 = 0, empty inventory).
- **Setup declared:** coins (100), grain, needle, thread and bear fur for the stuffed dog. Bear fur was supplied rather than taken from a grizzly drop.
- **Stages:** 0 → 5 (Talia) → 10 (Gertrude's "Gertrude.") → 15 (Gertrude's lost dogs) → 20 (dog leads) → 25 (den) → 30–35 (three den inspections) → 40 (cook scene) → 50 (first puppy) → 55 → 60 (goblin plan) → 65 (stuffed dog) → 75 (goblin trade, second puppy) → 80 (third search) → 85 (outlaw scene) → 90 (both outlaws killed) → 95 (rescue) → 120 (shelter handover).
- **Result:** varbit 15889 = 120; quest points varp 101 = 1; Crafting +1,000 XP (13,034,431 → 13,035,431).
- **Checked:** repeat dialogue with Talia before and after the relog; relog kept stage 120, quest points, Crafting XP and inventory; Baraek paid-fur purchase (100 → 80 coins, +1 fur, no quest-state change).
- **Not checked:** the grizzly bear fur drop itself; logout/offline after completion; Full recovery and overlay; the quest-points baseline (not recorded before start, account was fresh).
- **PRs:** [#1091](https://github.com/RSPSApp/tsps/pull/1091), [#1238](https://github.com/RSPSApp/tsps/pull/1238).

### 2026-10-25 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q099); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** fresh.
- **Result:** varbit 15889 = 120; QP +1, Crafting +1,000 XP.
- **Checked:** repeat dialogue (Talia), relog, logout/offline, paid-fur purchase branch.
- **Not checked:** Combat aid after real encounters; Full recovery and overlay unchecked.
- **PRs:** [#1091](https://github.com/RSPSApp/tsps/pull/1091), [#1238](https://github.com/RSPSApp/tsps/pull/1238).
