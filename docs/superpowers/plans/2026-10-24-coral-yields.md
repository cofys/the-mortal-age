# Coral yield implementation plan

**Goal:** Replace obsolete coral lives and estimated life-save endpoints with the published post-August-2026 values.

**Architecture:** Update the existing Farming model's canonical gameplay constants. Keep growth, harvest routing, modifiers and save state in the existing modules; no generated cache edits.

**Sources:** [Elkhorn frag](https://oldschool.runescape.wiki/w/Elkhorn_frag), [Pillar frag](https://oldschool.runescape.wiki/w/Pillar_frag), [Umbral frag](https://oldschool.runescape.wiki/w/Umbral_frag), and their linked Farming articles' 19 August 2026 change records. The calculator parameters specify six lives and low/high endpoints 85/182, 25/180 and -50/178 respectively.

- [ ] Reproduce the four-life minimum and incorrect yield chances with cache-backed crops and model/registered-hook regressions.
- [ ] Set coral starting lives to six and use the three published endpoint pairs in the existing life-save formula.
- [ ] Verify modifier order, level bounds, all three species, final harvesting, and online/offline/JSON equivalence. Preserve existing mature patch lives; do not replenish partly harvested crops on load.
- [ ] Build and run focused/full server tests; obtain independent review; publish one isolated PR from upstream main.

Scope: branch `fix/farming-coral-yields`, this chat's existing isolated checkout. No live saves, deployment, other-chat work, core/client changes or generated data. Handler fixtures stub scenery/action decoding and optional rewards; they do not verify live rendering or disk save/relog.

The Farming tracker is not yet eligible for 100%: unpublished watering/disease probabilities, Kronos and barbarian rates, remaining yield endpoints, patch/access coverage and original interfaces remain open. Existing PRs #903–#912 are independent and still awaiting upstream integration; they are not assumed landed by this plan.
