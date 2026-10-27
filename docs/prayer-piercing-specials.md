# Prayer-piercing melee specials

Favour of the War God (ancient mace) and Wild Stab (dragon sword), in
`server/plugins/combat/specials/`. No packet capture shows either weapon, so everything here is
from the OSRS Wiki.

## Favour of the War God

From the [Ancient mace](https://oldschool.runescape.wiki/w/Ancient_mace) page:

- Costs 100% special energy.
- Hits through Protect from Melee.
- Accuracy uses the attack bonus of the player's current style, rolled against the target's
  **crush** defence. The mace's Spike style is a stab attack, so it still rolls stab attack but
  against crush defence (`meleeDefenceBonusIndex: 2`).
- Drains the target's Prayer points by the damage dealt and restores the user's by the same
  amount. This can take the user above their maximum Prayer, by up to the damage of that hit.
- A target drained to 0 Prayer has its prayers switched off on the next prayer tick, as for
  any other drain (`PrayerHandler.processDrain`).
- The animation and graphic come from the cache gamevals `slice_player_mace_special_attack`
  (seq 6147) and `slice_player_mace_special_attack_spotanim` (spotanim 1052).

## NPC melee prayers

The [22 October 2025 update](https://oldschool.runescape.wiki/w/Update:Grid_Master_Rewards,_Poll_%26_New_Player_Improvements)
says players "can now pierce NPC melee prayers using the Ancient Mace and Dragon Sword
specials", and both weapons' Wiki pages list the change. The
[Dragon hasta](https://oldschool.runescape.wiki/w/Dragon_hasta)'s Unleash only ignores a
player's Protect from Melee, so it keeps the `ignoreProtectionPrayer` trait alone.

The trait covers player prayers. NPC prayers (the demonic gorillas, for example) yield only to
a hit whose roll hook marked it, so each of the two specials registers an `onCombatHitRoll`
handler that sets `bypassProtectionPrayer` on its own melee special hits.

The [Demonic gorilla](https://oldschool.runescape.wiki/w/Demonic_gorilla) page still says its
prayers "cannot be bypassed with special attacks". The update is newer and names these two
specials, so it is followed; every other special still can't get through.

## Not done

- The Wiki says Favour still restores Prayer against targets immune to normal weapons
  (Turoths, Kurasks), but not by how much. The slayer immunity sets the hit to 0 before the
  special's after-hit effect runs, so Favour restores nothing there.
