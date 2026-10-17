# Venator bow

`server/plugins/items/VenatorBow.plugin.js`: the ricochet, the charges, building the bow from shards and
the bank's Configure-Charges. The bow's ranged data (any arrow, range, projectile) is core weapon data in
`RangedData.ts` and `WeaponProfile.ts`, like the other bows.

## Behaviour (Wiki)

- **Two-handed, 80 Ranged**, fires any arrow. Speed 5 (4 on Rapid, from the cache's param 14), range 6,
  8 on Longrange.
- **Ricochet (charged bow, multicombat only):** after hitting its target the arrow bounces to up to two
  more targets, each within 2 tiles of the one it just hit: measured from any tile of a 1x1 or 2x2
  target, from the centre tile of a larger one, to any tile of the next. The nearest one is chosen, ties at
  random. It never bounces to the target it just hit or one it already bounced to, but the second bounce
  may go back to the first target.
  - Every hit rolls its own accuracy; the bounces' max hit is two-thirds of the bow's, rounded down.
  - Bounces happen even when the first hit misses or kills.
  - Players count as targets too, so in a multicombat part of the Wilderness it bounces between players
    (and NPCs) the attacker could attack.
- **Charges:** one ancient essence is one charge, up to 50,000. Each attack spends one, however many
  targets it hits. You're told the charges left at every 500, and at 100 and 50. The last charge turns it
  into the uncharged bow, which shoots like a normal bow, without ricochets.
- **Uncharge** returns every charge as ancient essence.
- **Venator shards:** five of them make an uncharged bow ("Combine").
- **Configure-Charges (bank):** sets a banked bow's charges, paying with ancient essence from the bank or
  returning it there.

## Captures (rsprox)

From the [rsprox.net capture database](https://rsprox.net/database). Attacks with the bow are only recorded
on Leagues and event worlds (about 1,800 attacks in 11 recordings), so the captures give the bow's own
effects, and the Wiki gives the rules.

| | Captured | tsps |
| --- | --- | --- |
| Animation | `human_weapon_bow_venator01_shoot` (9858) | the item's attack animation, 9858 |
| Launch graphic | `arrow_venator01_launch01` (2289), whatever the arrow | 2289 (`launchGraphic` in the weapon profile) |
| Shot sound | synth 6797 | 6797 (before: none, the bow couldn't shoot) |
| Arrow | `arrow_venator01_travel01` (2291), start 31, end 46 + 2 a tile, angle 255, progress 11, heights 39 → 36 | the same (`projectileId`, `angle`, `progress` in the profile) |
| Bounces | `nex_finale_attack_proj` (2007) from the target just hit, 15 cycles each, starting where the arrow lands (48 → 63, then 63 → 78 at 1 tile), angle 127, progress 0, height 31 | the same |
| Bounce sounds | synth 6672 with one bounce; 6672 and 6735 with two; on the attack tick | the same |
| Arrow's hitsplat on an NPC | 2 ticks after the shot at 1-6 tiles (8,800 of ~10,000 shots at 1 tile; the rest are the previous shot's) | hit delay floor((23 + d) / 15), 1 up to 6 tiles, + the NPC tick (before: the standard 1 + floor((3 + d) / 6), a tick late from 3 tiles) |
| Bounces' hitsplats | the first on the same tick as the arrow's, the second one tick later, at any distance | the same (before: both a tick after the arrow's) |

The rest, from the item recordings:

- **Combine on a shard** (4 recordings): with fewer than five, a mesbox
  `Creating a venator bow requires five venator shards. You need one more.` ("two more" ...). With five:
  a messagebox `Do you wish to use five venator shards to create a venator bow?<br>This process is
  non-reversible.`, then the options "Do you wish to create a venator bow?" with `Yes.` / `No.`, then
  synth 6647 and an objectbox with the uncharged bow: `You use five venator shards to create a venator bow.`
- **Ancient essence on the bow** (2 recordings): the count prompt `How many charges do you wish to add to
  your venator bow? (0 - 16,120)`, the most being what the essence and the room allow, then an objectbox:
  `You use 16,120 ancient essence to charge your venator bow. It now has <col=ff0000>16,120</col>
  charges.`
- **Check:** `Your venator bow has <col=ff0000>16,095 charges</col> remaining.` The charge warnings use
  the same line.
- **Bank op 9 "Configure-Charges"**: the bank's item script (cs2 669) adds it to items with cache param
  2257 while varbit `bank_bankops_toggle_on` (16125) is 1. The client sets that varbit itself, from the
  bank's item-options toggle (cs2 7860/7862), so the server only answers the op.

## Not in the captures

These follow the Wiki, with text of our own:

- **Uncharge:** `You uncharge your venator bow, regaining N ancient essence.` in an objectbox; with no
  room for the essence, `You don't have enough inventory space to uncharge your venator bow.`
- **Running out:** `Your venator bow has run out of charges.`
- **Configure-Charges:** the prompt `How many charges do you want your venator bow to have? (0 - N)`, N
  being its charges plus the essence in the bank; it answers with the Check line. A stack of more than
  one banked bow is refused.

## Simplifications

- The bounces' two-thirds is of the bow's general max hit, without target-specific boosts (slayer
  helmet, salve amulet); the Wiki notes bounces miss some of those bonuses but doesn't list them all.
- Bounce targets are picked as the arrow is fired, not as it lands.
- The arrow's hit delay follows the rule the standard table shares with its projectile, the tick the arrow
  lands (floor(end / 30)); the captures only confirm it up to 6 tiles (one shot at 7 tiles agrees). The
  Wiki's hit delay page doesn't list the bow.
