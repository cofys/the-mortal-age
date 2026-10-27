# Seercull: Soulshot

Soulshot costs 100% special energy and guarantees accuracy. Its maximum hit is
`floor(0.5 + (visible Ranged level + 10) * (arrow Ranged strength + 64) / 640)`.
The +10 is independent of stance. Offensive prayers and all equipment bonuses
other than the ammunition do not increase the roll, including Void, Slayer
and Salve effects. Magic is drained by the damage dealt, only while it has
not already fallen below its base level; another drain is possible after
full restoration.

Source: [OSRS Wiki: Seercull](https://oldschool.runescape.wiki/w/Seercull),
checked 27 October 2026. No Seercull weapon actions were available in the
rsprox capture index. Exact special animation, graphic, sound, packet order
and flight timing remain unverified against live OSRS recordings.

Previously Soulshot inherited the ordinary ranged damage calculation, so
stance, offensive prayers and equipment changed both damage and the resulting
Magic drain. At 99 Ranged with rune arrows, Eagle Eye and an anguish necklace,
the old maximum was 23 on Accurate or 22 on Rapid/Longrange instead of 19.
Soulshot now supplies its ammunition-only roll to the shared hit pipeline
before defensive reductions and the target's launch-time HP cap.

## Verification

Fourteen focused regressions cover visible levels 50/99/112, rune/amethyst
arrows, all three stances with real offensive bonuses, guaranteed accuracy
on zero, HP capping, defensive reductions and non-stacking Magic drain with
reapplication after restoration. Eleven fail against the original special;
all fourteen pass with the fix. With a maximum rune-arrow roll of 19, PvP
Protect from Missiles yields 11, an Elysian activation yields 14, and both
yield 8. Existing NPC stat-drain regressions cover Soulshot's non-stacking
NPC drain. The five focused and related test files pass all 59 tests.

In-game verification used two players in the Wilderness with supplied levels,
items and special energy. With 99 Ranged, rune arrows, Eagle Eye and anguish,
three unprotected shots dealt 15, 3 and 9 damage, awarded 60, 12 and 36 Ranged
XP, consumed one arrow and all special energy each. The first shot lowered
Magic from 99 to 84; the next two left it at 84. These observations check the
actual attack path; deterministic regressions establish the maximum roll.
A separate shot into Protect from Missiles dealt 5 damage and awarded 20
Ranged XP, lowering restored Magic from 99 to 94. Protection was confirmed
active before and after impact. It also consumed one arrow and all energy.
