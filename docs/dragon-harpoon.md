# Harpoon Fishstabber

Fishstabber is an immediate utility special: it raises visible Fishing to the
base level plus three, costs 100% special energy, and needs no combat target.
Like other [visible skill boosts](https://oldschool.runescape.wiki/w/Temporary_skill_boost#Visible_and_invisible_boosts),
it does not stack with itself or lower an existing stronger boost.

## Evidence

The [dragon harpoon](https://oldschool.runescape.wiki/w/Dragon_harpoon) describes
the +3 boost, 100% cost and wield requirement. The
[infernal harpoon](https://oldschool.runescape.wiki/w/Infernal_harpoon) explicitly
retains the dragon harpoon's special when depleted. The
[crystal harpoon](https://oldschool.runescape.wiki/w/Crystal_harpoon) has the same
special and describes its depleted form as acting like a dragon harpoon.

The [dragon ornament](https://oldschool.runescape.wiki/w/Dragon_harpoon_(or)),
[infernal ornament](https://oldschool.runescape.wiki/w/Infernal_harpoon_(or)) and
[Reloaded infernal ornament](https://oldschool.runescape.wiki/w/Infernal_harpoon_(or)_(Trailblazer_Reloaded))
pages describe appearance changes rather than additional bonuses. The infernal
ornament page explicitly confirms that Fishstabber remains usable on both
charged and uncharged variants despite its generic tooltip.

These pages were checked on 26 October 2026. No applicable normal-world
activation capture was found. Rsprox recordings **3270** and **3271** use the
Grid Master Echo harpoon; their boost and feedback are not evidence for regular
harpoons.

## Supported variants

The revision 241 cache supplies the item identities and Fishstabber sequences.
The sequences share their movement frames and supply different held models.

| Family | Item IDs | Sequence | Graphic |
| --- | --- | --- | --- |
| Dragon | 21028 | 7393 | 246 |
| Infernal, charged/depleted | 21031, 21033 | 7394 | 246 |
| Crystal, active/inactive | 23762, 23764 | 8333 | 1688 |
| Trailblazer dragon/infernal/depleted infernal | 25373, 25059, 25367 | 11823 | 246 |
| Reloaded dragon/infernal/depleted infernal | 30349, 30342, 30343 | 11824 | 246 |

Previously only 21028, 21031 and 23762 were registered. Equipping any of the
other eight items assigned no special, so activating it gave no Fishing boost.
Registration and animation selection now share the variant table. Notes,
placeholders, ordinary harpoons and Gauntlet tools are excluded.

## Verification

The regression tests exercise equipment special assignment and activation:
all eleven variants boost immediately without a target, consume 100% energy,
refuse activation at 99%, and send the forced chat and family animation/graphic.
They also cover refreshing, non-stacking, preserving a larger boost and excluding
bank copies and unrelated tools. Against the previous module, 17 of the 24 tests
fail; with the fix all 24 pass. The existing weapon-special suite also passes
(41 tests combined).

In-game verification equipped each of the eleven items, activated its special
through the combat tab, and checked Fishing 80 to 83, unchanged Fishing XP and
weapon identity, energy 100% to 0%, insufficient-energy refusal and repeat use
without stacking. Ordinary supplies, skill levels and special energy were set
up for these checks; no fish were caught.

The special-orb path also boosted a depleted Reloaded infernal harpoon from 80
to 83. Equipment checks refused a dragon harpoon at 59 Attack, and a crystal
harpoon at 69 Attack, 49 Agility or 70 Fishing. The crystal harpoon equipped at
70 Attack, 50 Agility and 71 Fishing.

Exact regular-world sound, packet timing and the appearance of each variant
remain unverified by live OSRS captures. The fix does not change fishing rolls,
tool charging, degradation or equipment requirements.
