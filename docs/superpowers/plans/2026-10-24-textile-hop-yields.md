# Textile hops yield endpoints

Flax, hemp and cotton currently fall through to an estimated shared 100/180 life-save range. Their current Wiki yield calculators publish distinct low/high endpoints: [Flax seed](https://oldschool.runescape.wiki/w/Flax_seed) 140/194, [Hemp seed](https://oldschool.runescape.wiki/w/Hemp_seed) 120/178, [Cotton seed](https://oldschool.runescape.wiki/w/Cotton_seed) 82/142. The articles also cite Mod Ash's 20 March 2026 description of their rounded chance ranges.

1. Reproduce incorrect model probabilities and actual harvest outcomes using cache-backed crop data and real registered harvest handlers/inventories.
2. Add the three verified endpoint pairs to the existing model without altering interpolation, modifier order, compost lives or other hops.
3. Build, run focused/full tests, obtain independent review and publish a separate upstream PR.

Scope: this chat's isolated `fix/farming-textile-hop-yields` branch directly from upstream main. No generated data, live saves, deployment or other-chat work. Fixtures stub scenery/action decoding; live rendering and disk save/relog are not tested. Other unpublished endpoints remain documented as estimates.
