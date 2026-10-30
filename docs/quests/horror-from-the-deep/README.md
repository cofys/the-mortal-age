---
quest: Horror from the Deep
key: horror_from_the_deep
status: in-progress
tested:
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start:
travel:
---

# Horror from the Deep

Bounded checkpoint of the gates, bridge and lighthouse entry only; the account is preserved at stage 1.

## Findings

- **fixed** Lighthouse entry fix merged after a bounded native checkpoint. [#1242](https://github.com/RSPSApp/tsps/pull/1242)

## Runs

### date not recorded · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q059); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Result:** stage 1.
- **Checked:** key/bridge gates, lighthouse entry/exit and repeat access after relog (bounded).
- **Not checked:** Full natural completion pending.
- **PRs:** [#1132](https://github.com/RSPSApp/tsps/pull/1132), [#1242](https://github.com/RSPSApp/tsps/pull/1242).
