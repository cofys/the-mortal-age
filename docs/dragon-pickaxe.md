# Rock Knocker

Rock Knocker immediately raises Mining to at least the base level plus 3, spending
100% special attack energy without a combat target. The
[OSRS Wiki special attack table](https://oldschool.runescape.wiki/w/Special)
identifies the dragon, infernal, 3rd Age and crystal pickaxes as users of this special.
The [infernal pickaxe page](https://oldschool.runescape.wiki/w/Infernal_pickaxe)
explicitly retains the special when depleted; the
[crystal pickaxe page](https://oldschool.runescape.wiki/w/Crystal_pickaxe)
provides the same special and describes the inactive tool's continued use.
The [pickaxe list](https://oldschool.runescape.wiki/w/Pickaxe) and
[dragon equipment page](https://oldschool.runescape.wiki/w/Dragon_equipment)
identify the ornamental counterparts. These Wiki pages were consulted on 26 October 2026.

Previously the special registered only four item ids. Depleted infernal, inactive
crystal, upgraded dragon and the ornamental dragon/infernal variants lost access to
the Mining boost. The registration now covers all 14 applicable wieldable variants.
Notes, bank placeholders, broken pickaxes and Gauntlet tools remain excluded.

## Activation evidence

Rsprox capture **553** (revision 227, Leagues V) shows the ordinary dragon pickaxe
playing `rockknocker` (7138), with area sound **2655**, one loop, range 1, on the
activation tick. Its special energy changes from 1000 to 0 on that tick. No
Rock Knocker spot animation appears in the inspected activation. This recording
establishes the presentation; the Wiki establishes the ordinary-world energy cost
and Mining boost. The
[dragon pickaxe page](https://oldschool.runescape.wiki/w/Dragon_pickaxe)
also documents the overhead exclamation **Smashing!** and that insufficient energy
must not play the animation.

The revision 241 cache supplies the variant sequences:

| Variant | Sequence | Cache name |
| --- | --- | --- |
| Dragon | 7138 | rockknocker |
| Upgraded dragon | 334 | rockknocker_pretty |
| Infernal, charged or depleted | 3410 | rockknocker_infernal |
| 3rd Age | 7267 | rockknocker_3a |
| Crystal, active or inactive | 8329 | rockknocker_crystal |
| Zalcano ornament | 8330 | rockknocker_zalcano |
| Trailblazer dragon/infernal, charged or depleted | 11821 | rockknocker_trailblazer |
| Reloaded dragon/infernal, charged or depleted | 11822 | rockknocker_trailblazer_reloaded |

## Verification

The depleted infernal pickaxe equipped normally before the fix, but activating the
special left Mining and special energy unchanged. Regression coverage dispatches the
real special registry and activation path for every variant, checks the +3 boost,
100% cost, overhead text, sequence and area sound, rejects insufficient energy without
feedback, preserves stronger boosts, and excludes bank copies and unrelated tools.
The new suite failed 25 of 30 tests before the fix and passes all 30 after it.
The four related special-attack suites pass all 94 tests. The server build also passed.

Live gameplay verification equipped each of the 14 variants normally and activated
the special without a target: Mining 80 became 83, energy 100% became 0%, Mining XP
and inventory/equipment stayed unchanged, and another activation produced the
insufficient-energy message. Items, skill levels and energy were supplied as test
setup. Natural boost decay can occur between observations. Animation rendering and
audio playback were not checked visually; their server calls are regression-tested.

No generated data changes are required. No confirmed related finding was deferred.
