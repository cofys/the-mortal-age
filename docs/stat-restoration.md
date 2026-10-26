# Stat restoration

How boosted and lowered stats return to base on their own, and how Hitpoints regenerate.

- Lowered stats and Hitpoints: `Player.processStatRestoration`
  (`server/src/main/typescript/elvarg/game/entity/impl/player/Player.ts`), every turn, on cycle
  deadlines so player bots, which take turns on a stride, catch up.
- Boosts other than Hitpoints: the continuous boost cycle in `processBoostDecay`
  (`server/plugins/items/Potions.plugin.js`), which also holds divine and overload boosts and
  pauses while the player is offline.
- Gear: `stats:hitpoints-regen` (`{ player, fast, amount }`, once per Hitpoints countdown), answered
  by the Hitpoints cape (`skillcapes/Passive.SkillCapes.js`) and the regen bracelet
  (`combat/effects/RegenBracelet.EquipmentEffects.js`).

Tests: `server/tests/stat-restoration.test.cjs`, `server/tests/consumable-edge-cases.test.cjs`.

## Sources

Everything here comes from these OSRS Wiki pages; no rsprox recording was used:

- [Temporary skill boost](https://oldschool.runescape.wiki/w/Temporary_skill_boost): boosts decay
  one level per minute on a continuous cycle that does not start with the boost; Preserve extends
  the cycle from 60 to 90 seconds, and must have been on for 15 seconds before it affects a boost.
- [Hitpoints](https://oldschool.runescape.wiki/w/Hitpoints): 1 Hitpoint per minute; Rapid Heal or a
  Hitpoints cape double it (they do not stack with each other); a regen bracelet doubles it again
  and stacks with either (4 per minute). Hitpoints above base decay one per minute, "identically to
  other temporary boosts", and activating Rapid Heal or logging out restarts that timer.
- [Rapid Heal](https://oldschool.runescape.wiki/w/Rapid_Heal): 1 Hitpoint per 30 seconds; switching
  it on or off resets the countdown (to 30 or 60 seconds).
- [Rapid Restore](https://oldschool.runescape.wiki/w/Rapid_Restore): lowered stats other than
  Hitpoints and Prayer restore at twice the rate, on a timer of its own that restores every 60
  seconds from the moment the prayer is switched on.
- [Regen bracelet](https://oldschool.runescape.wiki/w/Regen_bracelet): doubles the amount of each
  natural regeneration; with Rapid Heal or a Hitpoints cape, 2 Hitpoints every 30 seconds.

## What the server does

- A lowered stat (not Hitpoints or Prayer) gains a point every 100 ticks. Before, the core and the
  potions boost cycle each restored a point a minute, so drains came back twice as fast (three
  times with Rapid Restore).
- Rapid Restore adds a point every 100 ticks counted from when it is switched on.
- Hitpoints heal a point every 100 ticks, every 50 with Rapid Heal or a Hitpoints cape, and a regen
  bracelet doubles each heal. Before, Rapid Heal and the cape healed 2 points a minute and the
  bracelet did nothing.
- Hitpoints above base (anglerfish, Saradomin brew) drop a point every 100 ticks. Before, they
  never dropped. Rapid Heal switched on or off restarts the countdown; the Hitpoints timer is not
  saved, so a relog restarts it too.
- Preserve stretches a boost cycle by 30 seconds when it has been on for 15 seconds as the minute
  ends. Before, Preserve had no effect: the only code that read it never ran.
- Player bots keep their boosts, as before; their lowered stats and Hitpoints restore.

## Not covered

- The Wiki says combat and non-combat skills are on separate boost timers, but not how far apart;
  both run on one cycle here.
- The boost cycle keeps the exact time left over a logout; the Wiki says the 12-second segment is
  kept and restarted.
