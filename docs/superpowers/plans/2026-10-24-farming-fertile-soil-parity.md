# Fertile Soil XP and mature-crop handling

The OSRS Wiki Fertile Soil page specifies 87 Magic XP and 18 Farming XP, including its ash upgrade, and refuses fully grown crops. The current spell reuses bucket compost XP (26 or 36 Farming) and can increase harvest lives after maturity.

1. Reproduce ordinary/upgraded/fallback XP and mature-crop resource mutations. Four regression groups fail against the original handler.
2. Let the shared fertilizing helper accept an explicit action XP amount, defaulting to its existing bucket-tier XP. Fertile Soil supplies 18, while normal and bottomless applications retain 18/26/36.
3. Refuse mature crops before casting consumes runes, ash, XP or animations. Preserve existing spell level/rune validation and ash fallback.
4. Run focused tests, build, complete server suite, independent review and a separate upstream-main PR.

Source: https://oldschool.runescape.wiki/w/Fertile_Soil . This does not change unrelated compost upgrade rules or original-interface work.
