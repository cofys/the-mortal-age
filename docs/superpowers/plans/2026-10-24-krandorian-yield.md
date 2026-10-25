# Krandorian yield correction

The canonical Krandorian life-save low endpoint is 120, but the published [Krandorian seed calculator](https://oldschool.runescape.wiki/w/Krandorian_seed) specifies 121 (with high=180). This changes some intermediate-level and boosted probabilities by one discrete roll outcome.

- [ ] Reproduce source-derived level-1/21/50 examples and level-21 secateurs/Attas results against the cache-backed crop.
- [ ] Correct only the low endpoint. Preserve interpolation, modifier order, high endpoint and compost lives.
- [ ] Build, run focused/full tests, obtain independent review and open a separate PR from upstream main.

Source provenance: the Wiki cites Mod Easty's published DM data via its Farming talk page, and exposes the same 121/180 parameters in the seed article's calculator. This fixes one confirmed endpoint; it does not claim all crop endpoints are verified.

Scope: this chat's isolated `fix/farming-krandorian-yield` branch. No live saves, deployment, generated data or other chats' work. Tests verify the actual model with cache-backed crop data; live harvest rendering and disk persistence are not exercised.
