# Granite hammer: Hammer Blow

The [OSRS Wiki](https://oldschool.runescape.wiki/w/Granite_hammer#Special_attack)
specifies 60% special attack energy, 50% increased accuracy and five additional
damage. A failed accuracy roll still deals five damage, except against targets
immune to the weapon or targets whose Slayer requirement is unmet.

Previously the flat bonus was part of the successful damage roll only. A failed
accuracy roll skipped that calculation and produced zero damage. The weapon's
plugin now calculates the five-damage fallback through the ordinary damage
reduction path, before the existing remaining-HP cap and target immunity hooks.
The failed accuracy result is preserved. Successful rolls retain the existing
five-point bonus; ordinary attacks and missed spells receive no fallback.

The failed accuracy result is preserved, so impact effects that follow damage
rather than accuracy must check the damage dealt. Smite drains a quarter of any
damage dealt, so `CombatFactory.executeHit` now gates it on damage instead of
accuracy; a missed Hammer Blow's five damage drains one Prayer point, the same as
a successful five-damage roll.

## Verification

- The regression tests force failed accuracy rolls through the real hit pipeline.
  Before the fix, the five-damage, low-HP and protection-prayer cases each returned
  zero and failed. All nine focused tests pass after the fix.
- A Smite regression runs real players through `PendingHit` and
  `CombatFactory.executeHit`: before the Smite fix a missed Hammer Blow left the
  target on 99 Prayer while a successful five-damage control drained to 98.
- Tests also cover successful minimum/maximum damage, inactive specials, missed
  spells, the registered energy/accuracy values and Slayer weapon immunity at
  impact for Kurask and Turoth.
- An in-game check used a granite hammer with 50 Attack and 99 Strength against
  a spawned Giant Mole, with administrative invulnerability for the tester. One
  special reduced the target from 178 to 173 HP and awarded 20 Strength XP. A
  separate special reduced it from 200 to 178 HP. Each consumed 60% energy.
  The live check establishes reachable special-attack damage and XP; the forced
  accuracy tests distinguish a miss from a successful minimum roll.

## Evidence limits and adjacent mechanics

No granite hammer weapon actions are indexed in the rsprox captures, so the Wiki
is the gameplay evidence. Exact special-animation, graphic and packet timing
have not been verified against a recording; the existing presentation is retained.
The Wiki's historical animation change does not identify the replacement sequence.

The weapon's passive Golembane bonus is a separate ordinary-attack affinity
mechanic and is outside this Hammer Blow miss fix. This change does not certify
that passive. No generated data is changed.
