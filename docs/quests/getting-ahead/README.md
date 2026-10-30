---
quest: Getting Ahead
key: getting_ahead
status: passed-with-issues
tested: 2026-10-23
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start: checkpoint
travel:
---

# Getting Ahead

The run reached completion with rewards paid once and kept after relog, but it is not counted. Workbench nails and a post-relog varbit difference are still open.

## Findings

- **fixed** Farmhouse door 24369 did not open until the generic reverse-ID door catalog fix.
- **open** Workbench 40364 Search returns "You can't reach that!", so its nails were supplied by a kit.
- **open** Varbit 694 read 1 after completion but 0 after relog.
- **open** Saw and needle ground pickups stayed "walking to interact".

## Runs

### 2026-10-23 · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q049); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Start:** checkpoint: saved checkpoint resumed several times; not a fresh baseline.
- **Result:** varbit 693 = 34; QP 0->1, coins +3,000, Crafting +4,000, Construction +3,200.
- **Checked:** relog, repeat dialogue (Gordon), logout/offline.
- **Not checked:** Not counted as accepted; parked for workbench and varbit-694 review; Ordinary pot and mount kit supplied; Overlay unchecked.
- **PRs:** [#1125](https://github.com/RSPSApp/tsps/pull/1125).
