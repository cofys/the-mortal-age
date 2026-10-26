# Hunter

`Hunter.plugin.js` attaches hooks only; each activity is a module in this folder and reaches the
server through `api.core`. One shared tick task (`Runtime.Hunter.js`) drives cancellable actions, trap
lifetimes, creature respawns and session timers. Attribute state (birdhouses, crab traps, drift
nets, rumours, pursuit charges) is persisted and restored on login.

## Implemented

- **Trap families** (`Traps.Hunter.js`, `Rabbits.Hunter.js`, `Broavs.Hunter.js`): bird snares, box traps, deadfalls,
  net traps (swamp/orange/red/black/tecu salamanders), magic boxes/imp banking, monkey deadfall,
  rabbit snares flushed by ferret, and pitfalls with teasing (`Pitfalls.Hunter.js`).
- **Bait and scent**: tars, spicy tomato/minced meat, jerboa tail and kebbit baits (3% bonus for
  the matching creature), smoke from a lit/bruma torch or auto-applied anti-odour salt (2%).
  Ownership, per-kind trap limits (extra in the Wilderness), expiry/collapse and preflighted
  inventory transactions are enforced centrally.
- **Tracking** (`Tracking.Hunter.js`): five pursuit species, noose wand catches, ring of pursuit with
  10 persisted charges, trail varbits sent to the client.
- **Catching** (`Catching.Hunter.js`, `LuckyLoot.Hunter.js`): falconry, four butterflies, sunlight/moonlight
  moths with barehand and net curves, twelve impling species with rebuilt Wiki loot tables,
  released-butterfly boosts, and Lucky jars resolved through `hunter:lucky-loot` or the local
  reward-casket tables.
- **Birdhouses** (`Birdhouses.Hunter.js`): nine tiers, crafting, seeding (hop/herb/allotment/flower/
  bush), 50-minute wall-clock growth, nest/ring/egg/clue-nest/scroll-box rewards, reset.
- **Aerial fishing** (`Aerial.Hunter.js`): cormorant hire, king worms/fish offcuts/whole-fish feeding,
  Molch pearls, golden tench, spirit flakes, Rada's blessing, fish cutting and clue bottles.
- **Herbiboar** (`Herbiboar.Hunter.js`): five starts, cache-derived trail graph, fossil/numulite
  inspections, tunnel flush, 1-4 herbs by Herblore level with magic secateurs, Herbi pet.
- **Drift net fishing** (`DriftNets.Hunter.js`): Ceto or the tunnel beside her (daily/permanent numulite;
  the sea floor is reached by the rowboats in `plugins/areas/FossilIslandUnderwater.plugin.js`), two anchors,
  Annette's 2,000-net storage, active chase and passive capture, fish/fossil/clue rewards and
  bank-for-5-numulite, 44 Hunter/47 Fishing level-gated.
- **Crab traps** (`Crabs.Hunter.js`): red/blue/rainbow traps built with Construction, baiting,
  auto-rebait, crab meat/paste cutting.
- **Dungeon** (`Dungeon.Hunter.js`): seven Chambers of Xeric bats and the Neypotzli moss-lizard rope trap.
- **Rumours** (`Rumours.Hunter.js`): six guild hunters, eligibility and consecutive-rumour settings,
  rare-part pity/outfit rates, four loot sacks, quetzal-whistle blueprints and guild armour.
- **Broavs** (`Broavs.Hunter.js`): While Guthix Sleeps pit trapping, wild broav capture, hunting-expert
  training, release and pick-up.
- **Pets**: baby chinchompas, Herbi and Quetzin roll from `hunter:success`; spawns for the
  Varlamore creatures/moths, guild NPCs and tecu salamanders live in `npc-spawns.json`.

## Approximations and known limits

Catch curves use the Wiki's published success-chart low/high values with the 256-roll
interpolation in `Context.probability`. Where the Wiki publishes no numbers, the code carries a
`ponytail:` comment naming the estimate:

- Tatty-fur quality, Herbiboar's 1/100 tracking failure, birdhouse clue-nest pre-rolls
  (1-30/1500, marked approximate on the Wiki), drift-net scare odds/passive timing/fossil
  amounts, aerial pearl and clue rates, and rumour rare-part rates are estimates.
- Drift-net shoals are scared into swimming to the nearest non-full net and caught on arrival;
  they cannot get stuck on rocks, each other or the player.
- Pitfall prey follows the player and attacks on contact; leap graphics are validated against
  rev237 (`dump:spotanim`). Sunlight/moonlight antelopes use the Wiki's flat 255/255 chart.
- Lucky jars only give one clue-table roll; another plugin may answer `hunter:lucky-loot`.
- Wyrmscraig goats, Letvek and Stymphalak have no usable rev237 assets and are excluded. Aerial
  fishing uses king worms/fish offcuts because fish chunks and javelin heads are absent.
- Box traps need Eagles' Peak from stage 6, when Nickolaus teaches them at the camp (the Wiki asks
  for partial completion); quest plugins answer `quest:is-complete`, or the fallback reads
  `quest.<key>.stage >= 2`. Tracking, box traps, Herbiboar and a full drift-net cycle have been
  played through with the agent MCP; most other methods have not.

## Impling catching

From rsprox captures (main game 1342, 1389, 1510, 2520; Leagues 92, 95, 164, 1757, 1823, 1858)
and the Wiki ([Implings](https://oldschool.runescape.wiki/w/Implings),
[Baby impling](https://oldschool.runescape.wiki/w/Baby_impling)):

- A catch resolves on the tick the player reaches the impling (most attempts by a player already
  in reach land on the click's own tick, most others one tick later): the net throw
  (`ii_human_net_throw_oldnet`, 6606) or barehanded grab (`hunting_impling_catch`, 7171), sound
  2623, the message, the jar or loot and the XP arrive together.
- The impling plays `ii_impling_caught` (6615) and is removed two ticks later, in every attempt
  whose window shows the removal (1342; Leagues 92, 95, 1858).
- Messages: "You manage to catch the impling and squeeze it into a jar.", "You manage to catch the
  impling and acquire some loot." (barehanded without a jar, outside Puro-Puro), "You don't have
  an empty impling jar in which to keep an impling.", "You need a Hunter level of at least # to
  catch this impling." (with " barehanded" when no net is wielded), and "You'll need to clear
  some space in your pack to catch this impling without a jar."
- Puro-Puro's fixed spawns return 50 ticks after removal for earth and essence implings and 7
  ticks for the others (Wiki). Puro-Puro needs a jar for every catch; outside it a barehanded
  catch without a jar is looted at once.

Not reproduced: the two main-game barehanded loot catches gave 14 (earth, 1510) and 16 (essence,
2520) Hunter XP, against the Wiki's overworld 27 and 29; no source explains it, so the
Wiki value stays. Puro-Puro's 35 roaming spawn points and overworld impling spawns are not in.

## Sources

Requirements, drop tables and success charts come from the [OSRS Wiki](https://oldschool.runescape.wiki/w/Hunter)
and were checked against the rev237 cache with the `dump:*` scripts. Tracking trail
coordinates/varbits adapt [Void](https://github.com/GregHib/void)'s data (BSD-3, see
`Tracking.LICENSE`); Herbiboar search coordinates adapt RuneLite's herbiboar plugin (BSD-2, see
`Herbiboar.LICENSE`); leap/rabbit spotanims use RuneLite `SpotanimID` ids. Earlier trap work used
Near-Reality as a behaviour sketch; no code from it is used (it has no license).

Check: `yarn build && node --test tests/skill-max-level.test.cjs` from `server/`.
