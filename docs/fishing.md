# Fishing

Fishing spots are `server/plugins/skills/Fishing.plugin.js`: one loop for every spot, with a tool
per spot option (`TOOLS`) and its fish, levels, XP and catch charts (`FISH`). Units with their own
rules sit in `server/plugins/skills/fishing/` (harpoons, the angler's outfit, the Fishing Guild,
minnows, karambwan vessels). Tests: `server/tests/fishing.test.cjs`.

## Sources

- **The OSRS Wiki:** levels, XP and the skilling success charts from each fish's page, the ticks
  between catch rolls from
  [Game tick/Action lengths](https://oldschool.runescape.wiki/w/Game_tick/Action_lengths), and the
  karambwan rules from [Raw karambwan](https://oldschool.runescape.wiki/w/Raw_karambwan),
  [Raw karambwanji](https://oldschool.runescape.wiki/w/Raw_karambwanji),
  [Karambwan vessel](https://oldschool.runescape.wiki/w/Karambwan_vessel),
  [Fishing spot (karambwanji)](https://oldschool.runescape.wiki/w/Fishing_spot_(karambwanji)) and
  [Fishing spot (karambwan)](https://oldschool.runescape.wiki/w/Fishing_spot_(karambwan)), and
  [Fishing](https://oldschool.runescape.wiki/w/Fishing) for the karambwan spots never moving. Heron
  base chances from [Heron](https://oldschool.runescape.wiki/w/Heron).
- **rsprox recordings** ([rsprox.net database](https://rsprox.net/database)): the karambwan and
  karambwanji messages (recordings 75, 83, 96, 792, 1102 and 1779). These are Leagues and Grid Master
  worlds, whose boosts change the speed, so only their messages and item changes are used.

## Catch rolls

- **Ticks per roll (Wiki):** small net (shrimps, anchovies), cage, harpoon and big net spots, and
  the Holy Lake karambwanji, roll every 6 ticks. Rods roll every 5 (fly fishing, bait fishing,
  barbarian fishing, anglerfish); pike takes 6 one time in 5. Karambwan vessels roll every 4,
  minnows every 2. Spots the Wiki's table doesn't list (eels, frog spawn, monkfish, dark crabs)
  keep 5.
- **Chance:** the Wiki's skilling chart, low at level 1 to high at 99, out of 256. A tool's catch
  bonus scales both ends. Several fish on one spot roll highest first, and the first success is
  the catch (a big net rolls each on its own).

## Karambwanji and karambwan

- **Karambwanji (Holy Lake, small net, 5 Fishing):** chart 100/250, then shrimps 48/256 when the
  karambwanji roll fails. A catch lands floor(level / 5) + 1 karambwanji, for 5 XP and one heron
  roll per catch. A full inventory keeps stacking karambwanji, but the shrimps need a free slot.
  Messages (rsprox): "You cast out your net...", "You catch # Karambwanji."
- **Karambwan (vessel, 65 Fishing):** chart 5/160, 50 XP. A baited vessel holds one raw
  karambwanji, and every attempt uses it, caught or not; the vessel then reloads from the
  inventory, and an empty vessel loads itself on the click. Fishing stops when no karambwanji
  are left. The spots never move, so a session runs until the inventory is full.
- **Messages (rsprox):** "You lower the Karambwan vessel." on the click, "You catch a Karambwan!",
  "A Karambwan deftly snatches the Karambwanji from your vessel!" on a miss, and the message box
  "You need a Karambwan vessel to fish here." without a vessel.

## Not covered

- Which quest step unlocks karambwan fishing (Lubufu's apprenticeship in Tai Bwo Wannai Trio) is
  not checked: no recording or Wiki page gives the refusal.
- What live OSRS says when the karambwanji run out mid-session is not recorded; the loop stops
  with the generic "You do not have the required bait."
