# Farming levels, XP and success formulas

**Goal:** Make the Farming growth schedule, level gates, XP and success rates
explicit and sourced, instead of scattering estimated probabilities through the
model.

**Architecture:** `Data.Farming.js` owns the crop rows and a new `FORMULAS`
table. `Model.Farming.js` still runs growth on the one-tick Farming task, but
reads stage lengths and rates from that table. No generated cache data changes.

**Sources:** [Farming#Growth timing](https://oldschool.runescape.wiki/w/Farming#Growth_timing),
[Seeds](https://oldschool.runescape.wiki/w/Seeds) and each crop page,
[Disease (Farming)](https://oldschool.runescape.wiki/w/Disease_(Farming)),
[Kronos seed](https://oldschool.runescape.wiki/w/Kronos_seed),
[Barbarian Training](https://oldschool.runescape.wiki/w/Barbarian_Training),
[Redwood tree (Farming)](https://oldschool.runescape.wiki/w/Redwood_tree_(Farming)),
[Amulet of bounty](https://oldschool.runescape.wiki/w/Amulet_of_bounty) and
[Belladonna](https://oldschool.runescape.wiki/w/Belladonna).

## Steps

- [x] Audit the crop rows against the Wiki: levels, planting/harvest/check XP,
      seed counts and growth-cycle lengths already match.
- [x] Move disease, compost, watering, yield, Kronos, barbarian, pruning,
      bounty and belladonna values into `Data.FORMULAS`; mark the genuinely
      unpublished values with `ponytail:`.
- [x] Store `plantedTick` on a newly planted crop and add the pure
      `Model.stageAt` calculation over the Wiki's fixed cycle table.
- [x] Fix the two documented timing exceptions: a yew's first stage is five
      minutes, and a diseased crop waits for the next slower cycle (a
      640-minute crop stays at 640 because there is no slower tier).
- [x] Add regressions for each crop cycle at its exact stage times, the
      published and estimated disease rates, the diseased pause, and refusal
      of below-level planting with the exact message.

## Verification

- `node --test tests/farming-model.test.cjs`
- `node --test tests/farming-capture-lines.test.cjs`
- Focused Farming, Kronos, Cure Plant, Fertile Soil, Resurrect Crops and
  redwood tests: 86/86.
- All `tests/farming*.test.cjs`: 358/360. The two failures are the pre-existing
  `farming-bottomless-selection` checks, which fail identically on the base
  checkout and do not touch the model.
- Server TypeScript build and a clean server boot on the worktree's own port
  (cache revision 241, 404 plugins active).
- No in-game plant/growth run was performed. The remaining estimates are
deliberate: the Wiki publishes no watering formula, no disease rate for crops
outside its short table, no Kronos skip chance and no barbarian training
failure chance. They are data entries, not bare numbers, so a later
measurement replaces one value.
