---
quest: Cook's Assistant
key: cooks_assistant
status: passed
tested: 2026-10-29
tester: agent
model: claude-opus-5-5
commit: 15e0e9b82ee1
cache: osrs-241_2026-10-20
start: fresh
travel: travel_to
---

# Cook's Assistant

A fresh account completed the quest by the normal route, travelling only with `travel_to`
after being placed in the kitchen. Start, ingredient gathering, hand-in and rewards match
live OSRS. Repeat dialogue, relog and the other Cook dialogue branches were not checked.

## Findings

None.

## Runs

### 2026-10-29 · agent · claude-opus-5-5

- **Start:** fresh account (quest varp 29 = 0, no quest points, Cooking 1) placed in
  Lumbridge Castle's kitchen with `::tele` (the only teleport). Run on
  [#1511](https://github.com/RSPSApp/tsps/pull/1511)'s `travel_to`, over the quest code
  of `15e0e9b82`; the user watched it in a client.
- **Route:** Cook > "What's wrong?" > "Yes." started the quest (varp 29: 0 → 1). Pot from the
  kitchen floor; bucket from the castle cellar (kitchen trapdoor down, ladder up); egg from
  the chicken pen north of the castle (gate); milk from the Dairy cow in the cow field east
  of the farm (gate, "You milk the cow."); grain from the wheat field by Mill Lane Mill
  (gate, "You pick some grain."); mill large door, ladders to the top floor, grain in the
  hopper, Operate on the controls, ladders down, Empty on the flour bin ("You fill a pot
  with the last of the flour in the bin.").
- **Result:** the hand-in dialogue took all three ingredients; varp 29: 1 → 2, quest points
  (varp 101): 0 → 1, Cooking XP: 0 → 300 (level 1 → 4). All match the OSRS Wiki.
- **Not checked:** repeat Cook dialogue after completion, relog, handing in ingredients
  over several visits, the "Where do I find..." help branches.

### 2026-10-25 · community (thehardcorenoobs1234) · model not recorded

- **Source:** community report ([#1257](https://github.com/RSPSApp/tsps/issues/1257)); moved
  here from its ledger on 2026-10-29. No issue reported.
- **Not checked:** single account/run report; no full Quest Helper, recovery, multiplayer,
  dialogue, event or cutscene parity claim.
