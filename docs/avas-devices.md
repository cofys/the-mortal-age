# Ava's devices: ammunition recovery

`server/plugins/items/AvasAccumulator.plugin.js` answers core's ranged ammo recovery for every
cape-slot item that saves ammunition. Core breaks 20% of each shot and drops what is not
recovered where the target stood (`CombatFactory.decrementAmmo`).

| Worn in the cape slot | Recovered | Source |
| --- | --- | --- |
| Ava's attractor | 60% | [Ava's device](https://oldschool.runescape.wiki/w/Ava%27s_device) |
| Ava's accumulator, accumulator max cape | 72% | [Ava's accumulator](https://oldschool.runescape.wiki/w/Ava%27s_accumulator) |
| Ava's assembler and its Masori/max cape forms | 80% | [Ava's assembler](https://oldschool.runescape.wiki/w/Ava%27s_assembler) |
| Ranging cape, max cape (Skillcapes plugin, `skillcape:ammo-recovery`) | 72%, 80% after Vorkath's head | [Ranging cape](https://oldschool.runescape.wiki/w/Ranging_cape), [Max cape](https://oldschool.runescape.wiki/w/Max_cape) |
| Dizana's quiver with Ava's effect (its own plugin) | the device it took | [Dizana's quiver](https://oldschool.runescape.wiki/w/Dizana%27s_quiver) |

## Metallic interference

None of the devices, the Ranging cape or the max cape recovers anything while the player wears
a metal torso: every shot then breaks or lands as if no device were worn. The torsos are the
rows marked "Interferes" in the Wiki's
[Metallic interference](https://oldschool.runescape.wiki/w/Ava%27s_device#Metallic_interference)
table (34 rows, among them most metal platebodies and chainbodies, the Barrows melee bodies
and Ahrim's robetop). Many torsos that look metal are marked compatible and keep recovering,
for example bronze, the heraldic (h1-h5) platebodies, the (g) iron/steel/mithril platebodies,
Dragon platebody (g), Bandos chestplate and Torva. The Ranging cape and max cape pages say they
are affected the same way; the Dizana's quiver page says the quiver is not.

- `server/plugins/items/data/avas-metallic-interference.json` lists the rows by name with their
  cache obj gamevals. The table tests one version of a Barrows body (100) and of the gold
  decorative platebody (Normal); their other wearable versions are the same piece and are
  listed with them. Rows marked Unknown are left out, so they keep recovering.
- Neither page gives a message for the interference, and none is sent.
- Tests: `server/tests/ranged-ammunition.test.cjs`.
