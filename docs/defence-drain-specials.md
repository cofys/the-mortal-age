# Defence-draining special attacks

Smash (dragon warhammer), Pulverize (elder maul) and Warstrike (Bandos godsword), in
`server/plugins/combat/specials/`, and what Tekton changes about them
(`server/plugins/minigames/cox/Tekton.ChambersOfXeric.js`). No packet capture shows these
specials hitting, so everything here is from the OSRS Wiki.

## The specials

- **Smash** lowers the target's current Defence by 30% (rounded down) on a successful hit,
  and for this special the hit has to deal damage: an accurate roll of 0 drains nothing. The
  [Dragon warhammer](https://oldschool.runescape.wiki/w/Dragon_warhammer) page says so and
  cites Mod Ash: specials usually trigger on a successful roll even when the damage comes out
  as 0, but "the DWH blog said this one wouldn't".
- **Pulverize** lowers current Defence by 35% on a successful hit
  ([Elder maul](https://oldschool.runescape.wiki/w/Elder_maul)). The page doesn't say how an
  accurate 0 behaves, so it still drains, as specials usually do.
- **Warstrike** drains levels equal to the damage dealt, in the order Defence, Strength,
  Prayer, Attack, Magic, Ranged
  ([Bandos godsword](https://oldschool.runescape.wiki/w/Bandos_godsword)).

A special that drains nothing (a miss, or Smash dealing 0) emits
`combat-special:missed-drain` with `{ hit, specialId, fraction: 0, levels: 0 }`. A listener
that wants the target to lose something anyway sets `fraction` (of current Defence, Smash and
Pulverize) or `levels` (drained in Warstrike's order), and the special applies it.

## Tekton

From the [Tekton](https://oldschool.runescape.wiki/w/Tekton) page:

- The first elder maul or dragon warhammer special that makes contact with him always lands
  as a damaging successful hit. If several land on the same tick, only one gets it; after it,
  specials act as normal. Each Tekton has his own first special. That special can't roll 0:
  a 0 becomes 1, which is how we read "damaging".
- An elder maul or dragon warhammer special that fails to hit still drains 5% of his Defence.
  The page doesn't say whether that's 5% of his current or his base Defence. We use current,
  as the specials themselves do.
- A Bandos godsword special that fails to land drains 10 levels instead, in Warstrike's order.
