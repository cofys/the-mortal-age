# Dragon battleaxe — Rampage

[Dragon battleaxe](https://oldschool.runescape.wiki/w/Dragon_battleaxe) specifies an
instant special costing 100% energy. It drains 10% of visible Attack, Defence,
Ranged and Magic, flooring each drain, and gives a Strength boost of
10 + floor(total drained / 4). The boost is relative to base Strength:
[visible boosts do not stack](https://oldschool.runescape.wiki/w/Temporary_skill_boost).
A stronger existing Strength boost is preserved.

Previously the special added its boost to current Strength. With base combat
levels of 99, two activations could give 99 → 118 → 137 Strength instead of
refreshing 118. The same stacking happened after a super strength potion.

## Activation feedback

Rsprox captures, recording **1023** (revision 235), show Rampage animation 1056,
red special-attack graphic 246 and sound 2538 on the activation tick, with
special energy falling from 1000 to 0. The animation and graphic already matched;
the activation sound was missing. These IDs exist in the current cache.
The Wiki supplies the overhead shout, which is retained.

Recording 1023 does not expose a stat change in the indexed attempt. The stat
formula and non-stacking rule above are supported by the Wiki, not that recording.

## Regression checks

The existing melee weapon specials tests exercise the real special activation:
repeated use, weaker/equal/stronger existing boosts, visible boosted combat
levels and per-skill flooring, the original 90-level example, activation feedback,
energy consumption and insufficient energy.

In-game verification with an equipped dragon battleaxe confirmed 99 → 118 → 118
Strength across two activations, other combat levels 99 → 90 → 81, unchanged
Strength XP, and no stat changes without energy. A super strength dose followed
by Rampage remained at 118 Strength. Energy was replenished between activations
as test setup. Sound packet parameters are covered by the regression test;
audible playback was not checked.
