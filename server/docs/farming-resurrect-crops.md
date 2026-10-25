# Resurrect Crops correction

The Farming spell uses the explicit integer formula on the OSRS Wiki
[Resurrect Crops page](https://oldschool.runescape.wiki/w/Resurrect_Crops):

`successes = floor(64 * (min(99, visibleMagic) - 36) / 21 + 0.5) + 1`

The roll is an integer from 0 through 255, succeeding below `successes`.
The endpoints are 129/256 at level 78 and 193/256 at level 99, rather than
the former floating 50%/75% interpolation. Boosts to 99 count; higher boosts
do not improve the chance. This implements the page's explicit equation;
its embedded chart currently differs by one numerator at levels 87 and 88.
Those chart discrepancies have not been resolved through live captures, so
capture-exact parity is not claimed.

Invalid targets are rejected before shared spell validation spends runes or
the Farming spell awards XP/plays an animation. Redwoods cannot be resurrected
([Redwood tree (Farming)](https://oldschool.runescape.wiki/w/Redwood_tree_%28Farming%29));
Hespori is excluded by the Resurrect Crops page. Existing anima, compost,
living-crop and one-attempt restrictions remain in place. Cure Plant and
Fertile Soil are unaffected.

Regressions use real Player/cache spell IDs, the actual cast handler and shared
Spell validation, real rune inventory and XP, and a controlled random roll.
Scenery lookup, packets and animations are mocked. Tests cover roll boundaries,
boost capping, excluded crops without resource loss, successful/failed cast
lifecycle, repeat attempts, low level/missing runes and the other Farming spells.
Live client presentation and packet-capture validation are not claimed.
