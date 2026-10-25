# Harmony Island herb patch parity

The OSRS Wiki Harmony Island and Herb patch pages require the elite Morytania Diary to use the disease-free herb patch. The existing patch currently accepts interactions without this requirement and participates in ordinary herb disease rolls.

1. Reproduce locked object, seed and spell interactions, successful diary-unlocked planting, and deterministic disease rolls using the cache-derived Harmony patch.
2. Ask the existing `diary:is-complete` custom event for the Morytania elite tier before any Farming state or supplies change. Keep other patch restrictions effective and other patches unaffected.
3. Give this specific herb patch its documented disease immunity in the shared growth model, including offline/save-load growth.
4. Run focused regressions, build, the complete server suite and independent review. Publish a separate PR from upstream main.

Sources: https://oldschool.runescape.wiki/w/Harmony_Island and https://oldschool.runescape.wiki/w/Herb_patch . No generated data or quest/diary state schemas change.
