# Kronos regrowth acceleration

The Wiki Kronos seed page cites Mod Ash confirming that Kronos accelerates berries, fruit and cactus regrowth. The current model bulk-regrows one item per cycle without applying Kronos.

1. Reproduce fruit/bush/cactus acceleration, shared skip counts with matching initial-growth cycles, caps, anima expiry and later planting, and offline/save equivalence. Four initial regression groups fail against main.
2. Reuse one shared per-timestamp/per-period skip decision for initial growth and produce regrowth. Process partial patches chronologically until full; their small produce caps bound the work. Once full, retain bulk advancement of the next regrowth timestamp.
3. Keep the existing estimated skip probability and disease behavior unchanged; the separate disease-stage PR owns that correction.
4. Build, run focused/model tests and full server suite, request independent review, then open a separate PR from upstream main.

Source: https://oldschool.runescape.wiki/w/Kronos_seed (Mod Ash references on regrowth, compost and fermentation exclusions). No compost-bin or fermenting-vat changes.
