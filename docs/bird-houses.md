# Bird houses

The four Fossil Island bird house spaces (multilocs 30565-30568, varps 1626-1629
`birdhouse_transmit_a`-`d`), built from the OSRS Wiki
([Bird house trapping](https://oldschool.runescape.wiki/w/Bird_house_trapping) and its
[seed table](https://oldschool.runescape.wiki/w/Bird_house_trapping/Seeds)) and checked against
rsprox captures (<https://rsprox.net/database>). The code is
`server/plugins/skills/hunter/Birdhouses.Hunter.js`; its test is the bird house part of
`server/tests/skill-max-level.test.cjs`.

Recording 716 (rev 231) is the one main-game recording. The others (rev 227: 545, 549, 550, 551,
552, 553, 554, 559, 566, 571, 572, 1835, 1839, 1843, 1844, 1849, 1851, 1853, 1863, 1875) are
Leagues V; they are used for what Leagues does not change (menus, messages, varps, loot shape),
not for XP.

## What the Wiki says

- Ten low-level seeds or five high-level ones fill a house. Only the herb seeds from ranarr up
  and wildblood seeds are high-level; watermelon, snape grass, whiteberry, poison ivy and white
  lily seeds take ten like the rest.
- Loot: one clockwork, ten raw bird meat ("always dropped to the ground, even if there is space
  in the inventory"), and 30, 40, 50 or 60 feathers. One seed-nest roll (0 to 200 on the skilling
  curve) and five nest-table rolls; the nest-type and clue-nest odds are unchanged by this fix.
- A carried bird house is used first; with none, Build makes one from logs, clockwork, a hammer
  and a chisel on the spot (February 2025 update).
- Reset empties a full house and makes and places a new one reusing its clockwork, one tick
  slower than doing it by hand.

## What the captures show

- Placing a carried house: `human_pickupfloor` (827), synth 2433, the house leaves the
  inventory and the varp changes on the arrival tick, with no message (recordings 571, 1863 and
  the other op1 attempts).
- Building from logs (recording 716): `birdhouse_make` (7057) and synth 2605, the house made two
  ticks later (logs and clockwork out, Crafting XP), then placed a tick after that.
- The seed that fills the house sends the Empty/Reset variant at once (varp 22 -> 24 for a magic
  house, in every attempt), with the messagebox "Your birdhouse trap is now full of seed and will
  start to catch birds."
- Seeds only shows the seed level: "Your birdhouse seed level is: 0/10. It must be full of seed
  before it will start catching birds." (the second sentence in dark red) on an unseeded house
  (recordings 545, 1863, 1875), and "Your birdhouse trap is set and consuming seed. Seed level is: 3/10." on a full one
  (recording 545).
- Interact on a full house opens "Check seed levels." / "Dismantle my trap." / "Dismantle and
  rebuild my trap." / "Do nothing." (recording 716).
- Empty: `human_pickupfloor` and synth 2433 a tick after arrival, ten raw bird meat on the floor
  one tile south of the house, where the player stands facing it (the code drops them under the
  player), the clockwork, feathers and nests in the inventory, the varp back to 0, and
  "You dismantle and discard the trap, retrieving # nests, # dead birds, # feathers and # Hunter
  XP." ("a nest" for one).
- Reset with no logs (recording 716): the house is emptied as above, then two ticks later "You
  need logs to make a birdhouse."
- Build holding only houses above the player's Hunter level: "You do not have a birdhouse with
  the required hunter level to build here." (recordings 1849, 1851).

## Not covered

- Emptying before the 50 minutes are up: the Wiki says a warning is given and only the clockwork
  is kept, but no capture shows the warning, so Empty still refuses until the house is ready.
- Reset with several kinds of logs: the Wiki says a prompt asks which to use; it uses the best
  tier the player can build.
- The seed level while a house is catching counts down one seed per tenth of the 50 minutes;
  only the 3/10 reading is captured.
