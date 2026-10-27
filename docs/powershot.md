# Powershot

The magic longbow and magic comp bow share Powershot. It guarantees accuracy,
costs 35% special energy, and rolls damage using only the visible Ranged level
and equipped arrow strength. Offensive prayers, Void, armour strength and
Slayer/Salve bonuses do not increase that roll. The comp bow's special takes
one tick longer than its ordinary attack.

Sources: [Magic longbow](https://oldschool.runescape.wiki/w/Magic_longbow) and
[Magic comp bow](https://oldschool.runescape.wiki/w/Magic_comp_bow).

Guaranteed accuracy still allows defensive damage reduction:

- [Protect from Missiles](https://oldschool.runescape.wiki/w/Protect_from_Missiles)
  reduces player-dealt ranged damage by 40% without changing accuracy.
- The [Elysian spirit shield](https://oldschool.runescape.wiki/w/Elysian_spirit_shield)
  has a 70% chance to reduce received combat damage by 25%.

Previously, Powershot replaced the already-mitigated hitsplat with a fresh
unmitigated roll. It now supplies its custom roll before the shared damage
pipeline applies defensive effects. Both bows use the same implementation.

## Regression coverage

The registered special is exercised with actual player objects and the shared
hit calculation. At 99 Ranged with rune arrows, a maximum roll of 19 becomes
11 through Protect from Missiles, 14 through an Elysian activation, or 8 with
both. All five defensive cases failed before the fix. Additional checks cover
the custom maximum at boosted Ranged and an accurate zero-damage roll.

Live checks used two players with supplied levels and equipment in the
Wilderness. Three shots per bow into Protect from Missiles consumed one rune
arrow and 35% energy each, with Ranged XP equal to four times damage. Observed
damage was 0/3/7 for the longbow and 4/3/4 for the comp bow. A second set with
the target wearing an Elysian and prayer off produced 9/11/13 and 3/12/6
respectively. Individual shield activations were not observable in these
checks; the deterministic regressions establish their reduction.

No rsprox recordings of either bow's weapon actions were present in the
capture index when this change was checked. The sources above establish the
gameplay rules; exact special animation, graphic and packet timing have not
been compared against a live recording.
