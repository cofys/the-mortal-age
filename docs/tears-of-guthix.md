# Tears of Guthix

The weekly activity lives in `server/plugins/minigames/tearsofguthix/`; the quest
remains in `server/plugins/quests/quests/TearsOfGuthix.Quest.js`.

Behaviour follows the [OSRS Wiki activity guide](https://oldschool.runescape.wiki/w/Tears_of_Guthix_%28minigame%29),
[quest walkthrough](https://oldschool.runescape.wiki/w/Tears_of_Guthix#The_Light_Creatures)
and [Chasm of Tears](https://oldschool.runescape.wiki/w/Chasm_of_Tears).

- Juna checks the completed quest, two free hands, UTC seven-day cooldown and
  one new QP or 100,000 XP again when the admission dialogue ends. The first visit
  needs no new adventures. The completed quest journal reports both remaining
  days and XP/QP requirements. Opted-in reminders appear once per UTC day on login.
- Each visit gets its own `PrivateArea`, temporary stream decorations, bowl and
  countdown. All visits follow the same world stream sequence. Time is one tick
  per QP. A normal exit awards the lowest eligible skill once, including the hard
  Lumbridge diary bonus and personal best. Logout, disconnect, death before the
  reward, and shutdown discard the visit and remove its temporary state. Death
  cleanup happens before item protection/drop calculations, so the temporary bowl
  cannot become a kept item.
- A lit sapphire lantern attracts the light creatures over the chasm; the south
  rocks return to the path to Juna. Both Attract and item-on-NPC work. The static
  spawns now use the cache's `tog_light_creature_op` (5435), replacing the
  `tog_light_creature_carrying` (5784) form that has no Attract option.
  `npc-spawns.json` is maintained world data, as documented in [npc-spawns.md](npc-spawns.md).
  While Guthix Sleeps retains its separate northern creature and descent.

Cache identifiers were checked with `lookup-gameval.ts`: `tog_light_creature_op`
5435, `tog_player_float_across` 2048, `tog_climb_slope_down` 2050, lit sapphire
lantern 4702, and south rocks 6672. No generated Wiki JSON was changed.

Verification:

```sh
cd server
yarn build
node --test tests/tears-of-guthix.test.cjs tests/loc-teleports.test.cjs tests/quest-plugins.test.cjs
```

The focused tests cover final admission checks, weekly eligibility, journal
status, daily reminders, lantern requirements, private concurrent visits, shared
stream colours, exact QP countdown, diary XP once, logout, disconnect, death and
shutdown cleanup.
All 440 tests passed.

Live MCP checks used slot 18 (`3118` client, `43718` game, `49818` agent MCP).
The crossing account used a supplied lantern and ordinary Attract/Climb/walking:
missing lantern was refused, the crossing landed at 3229,9505,2, the south climb
landed at 3241,9498,2, and walking returned to Juna. The activity account started
from an explicitly prepared quest-complete checkpoint with 44 QP. Story admitted
it to a private cave with the equipped bowl, 44-tick countdown and drifting
streams. A wall click collected tears, teleporting was refused, and timeout
returned it outside with 18 tears, 180 Strength XP and PB 18. The next Story
attempt was refused for seven days.
The same refusal survived a server restart and relog. A second prepared account
disconnected during collection, rejoined outside with no bowl or countdown, and
was immediately eligible to retry.

Limits: exact carry duration/landing visuals and gaps between the six stream
moves still need a live OSRS capture; the code marks those estimates with
`shortcut:` comments. No browser animation/overlay capture was made. The separate
quest-helper branch also touches Tears travel and will need normal merge review.
