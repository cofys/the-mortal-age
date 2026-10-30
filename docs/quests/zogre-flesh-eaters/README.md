---
quest: Zogre Flesh Eaters
key: zogre_flesh_eaters
status: failed
tested:
tester: agent
model:
commit:
cache: osrs-241_2026-10-20
start:
travel:
---

# Zogre Flesh Eaters

Native run stopped at stage 3 on a core reach problem with the Dragon Inn bartender, not a quest-plugin fault.

## Findings

- **open** Using the tankard on the Dragon Inn bartender (NPC 1320) returned "I can't reach that!" 25 times: default wander radius 5 and isolated counter tiles block reach.

## Runs

### date not recorded · agent · model not recorded

- **Source:** issue [#728](https://github.com/RSPSApp/tsps/issues/728) active (q128); moved here from its ledger on 2026-10-29. Proven against plugin hashes, not a commit, so a later plugin change is not flagged automatically.
- **Result:** stage 3.
- **Not checked:** Tankard step proven only by dispatch/cache repro; Natural completion pending.
- **PRs:** [#1191](https://github.com/RSPSApp/tsps/pull/1191).
