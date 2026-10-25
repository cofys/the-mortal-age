# Tithe Farm Tangleroot formula

The Wiki Tangleroot table publishes Tithe Farm's base denominator as 7,494,389. The current emitter rounds it to 7,494,000 and supplies a finished chance, bypassing the Pets handler's existing fifteenfold 200m-XP adjustment.

1. Reproduce the exact-base winning interval and 200m perk through actual Tithe planting/watering/harvesting and the actual Pets handler. Preserve base-level handling, fruit capacity and one roll per successful harvest.
2. Emit the published `petBase` through the canonical Pets API instead of duplicating its finished formula.
3. Build, run Tithe/Pets/Farming regressions, independent review and a separate upstream-main PR. Include it in the combined full suite.

Sources: https://oldschool.runescape.wiki/w/Tangleroot and the existing canonical Pets.onSkill implementation. No Pets core or reward-point changes.
