# Dragonfire

Regular dragonfire (chromatic, brutal and metallic dragons) is resolved by
`resolveChromaticDragonfireDamage` in `server/plugins/combat/DragonfireProtection.js`, called from
`server/plugins/npcs/Dragons.plugin.js`. The same module holds the antifire potion state and its
expiry messages; `CombatEquipment.hasDragonProtectionGear` decides which shields count. Tests:
`server/tests/dragonfire.test.cjs`.

## Sources

- **The OSRS Wiki, [Dragonfire](https://oldschool.runescape.wiki/w/Dragonfire):** the damage
  reduction tables for chromatic and metallic dragons, and the mechanics notes: a shield or
  Protect from Magic sets a lower damage range before the roll, while a (super) antifire potion is
  subtracted from the rolled damage. Metallic dragonfire ignores Protect from Magic. Every shield
  in the Methods table (anti-dragon shield, dragonfire shield, dragonfire ward, ancient wyvern
  shield) protects; [Anti-dragon shield (nz)](https://oldschool.runescape.wiki/w/Anti-dragon_shield_(nz))
  shares the anti-dragon shield's stats.
- **rsprox recordings** ([rsprox.net database](https://rsprox.net/database)): the messages below.
  Recordings 362, 722, 3023 and 3072 (main worlds) show the resist/burnt messages; 1740 (Leagues,
  rune dragons) shows the antifire message after either; 91, 1149 and 4053 (Leagues) the shield
  message, followed by the antifire message when one was drunk; 3316 and 3318 (event worlds,
  Kourend black dragons) the super antifire message and, right after one expired, the prayer
  message.

## What the server does

| Protection | Damage | Messages |
| --- | --- | --- |
| None | Magic accuracy roll: 0-30 when won, 0-50 when lost | "You manage to resist some of the dragon fire!" / "You're horribly burnt by the dragon fire!" |
| Anti-dragon shield (any variant above) | 0-5, no accuracy roll | "Your shield absorbs most of the dragon fire!" |
| Protect from Magic, no shield (not metallic) | 0-10, no accuracy roll | "Your prayers resist some of the dragon fire!" |
| Antifire potion | the roll above minus 15 (never below 0) | the message above, then "Your antifire potion helps to protect you from the dragon's breath!" |
| Super antifire potion | 0 | "Your super antifire potion completely protects you from the dragon fire!" only |

The resist and burnt lines are ordinary game messages; the others are filterable (spam) messages,
as recorded. Before, a shield alone rolled 0-10, Protect from Magic alone did nothing, antifire
drew 0-35 or 0-15 instead of subtracting 15 (so the shield or prayer with antifire only reached 0
through a special case), and every full block sent "You are completely protected from the dragon
fire." The shield check only knew the anti-dragon shield, the two dragonfire shield ids and the
charged dragonfire ward; it now matches the cache names, so the uncharged ward, the ancient
wyvern shield (both states), the Nightmare Zone shield and any other wearable copy count too.

Potion expiry, from the recordings: "<col=7f007f>Your antifire potion is about to expire.</col>"
30 ticks before an antifire potion ends (1149, 1740, 3279, 4053) and "<col=7f007f>Your super
antifire potion is about to expire.</col>" 20 ticks before a super antifire potion ends (355,
3316, 3318), then "<col=7f007f>Your ... has expired.</col>". Before, the warning came 30 seconds
early for both, uncoloured, and the "has expired" message was never sent: the expired state was
dropped before the per-tick check could see it.

## Not covered

- Protect from Magic together with an antifire potion sends both layer messages by analogy with
  the recorded shield + antifire breaths; no recording shows that combination.
- The Wiki says every method except Protect from Magic needs Dragon Slayer I started. That gate is
  not applied here; it would cover every dragonfire source (King Black Dragon, Vorkath, Elvarg,
  Cerberus lava), not just these dragons.
- King Black Dragon, Vorkath and Elvarg resolve their own dragonfire in their boss plugins and are
  unchanged.
