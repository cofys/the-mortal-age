# Sea charting

Sailing's charting tasks: 358 spots around the seas, each charted once into the Captain's log for
Sailing XP, with a bonus for every sea or group fully charted and one per ocean, paid by Chartin'
Charles McAtless. Six kinds: **generic** spots (a loc with Chart), **spyglass** views, **current
ducks**, **drink crates**, **weather trolls** and **mermaid guides**.

Plugin: `server/plugins/skills/sailing/Charting.plugin.js`, with its units in `charting/` and its
data in `data/charting.json`. Tests: `server/tests/sea-charting.test.cjs`.

## Sources

- rsprox captures from https://rsprox.net/database (rev 235). Generic spots: recordings 944, 948,
  1009, 3455 and 3467 (every one of the 94 generic tasks is charted in at least one recording).
  Spyglass views: 907, 938-948, 3455, 3461, 3467 and 3837 (all 57 views, each with its camera
  shots; `view.rec` in the data names the recording each view's shots come from). Hint markers:
  every recording that sails past one. Current ducks: 938, 939, 940, 944, 948 and 3467 (all 54
  currents; `routeRec` in the data names each route's recording). Weather trolls: 939, 940, 941,
  944, 948 and 3467 (all 31 tasks, 695 station readings). Drink crates: 24 recordings (907,
  936, 938-948, 3455, 3461, 3467 and others; 64 of the 65 drinks drunk; `drink.rec` names each).
  Mermaid guides: 939, 940, 944, 948 and others (56 of 57 dives; `mermaid.rec` names each).
  Chartin' Charles's training: 948.
  XP: recordings from 2025-11-26 on (907, 938-948, 1009, 3461, 3837, 4290); the launch-day ones
  (3450, 3455, 3467, 2025-11-19) paid less for every kind of spot.
- The cache:
  - DB table 154 (`sailing_charting_core`): each task's unique id, hint (the task text), sea,
    secondary sea, kind (the kind's table, 155-160) and whether a current duck pays XP again.
    The kinds' tables only link back to it; their other columns are empty in our cache.
  - DB table 201 (`sailing_sea`): seas, oceans and the bonus groups, with their level and
    whether a fully charted sea opens rapids.
  - Varps 5016-5027 (`sailing_charting_completion_0..11`): task n is bit `n & 31` of varp
    `5016 + (n >> 5)`, as script 9004 reads it. Varps 5028-5033: each sea's (bit = its unique id)
    completion and ever-completed bits. Varp 5034: the oceans' owed bonuses (bit = ocean id).
    Varp 5037: the number of tasks charted. Varp 5035 bits 0, 1 and 7: everything charted.
- The OSRS Wiki's [Sea charting](https://oldschool.runescape.wiki/w/Sea_charting) task list (each
  task's location, a current duck's end, a weather station's spot, a mermaid's riddle answer) and
  [Sea charting/By oceans](https://oldschool.runescape.wiki/w/Sea_charting/By_oceans) (the sea and
  ocean bonuses).

## Units

| Unit | Does |
|---|---|
| `Common` | Tasks and seas from the cache joined with `data/charting.json`; the saved `charting:progress` attribute; `complete`, the one way every kind of task is charted; letting go of the helm first. |
| `Progress` | The charts sent to the client at login. |
| `Markers` | The spyglass and current duck hint markers, placed as world locs at startup. |
| `Spyglass` | Look-through: the nearest uncharted view in reach, its captured camera shots, then the charting. |
| `CurrentDuck` | Track-current, the duck's swim along its captured route, its stop, Collect from the deck. |
| `Weather` | Meaty Aura Logist's Collect-data (station, hand-in, refusals), Take-reading's wind and the filled station. |
| `DrinkCrate` | The 65 sealed crates (Pry-open from the deck), the drinks, the drinking warning. |
| `Mermaid` | The five mermaid guides: Talk-to, Dive (gear, level, riddle, item-search answers, the dive). |
| `Tutor` | Chartin' Charles's training: his transcript's conditions and lectures, Get-training, the owed bonuses paid. |
| `Generic` | The 92 Chart locs, the Port Sarim task board and salvaging station, the crab statue's Medallion fragment. |
| `Dev` | `::chart go <task>`, `::chart done <task>`, `::chart reset [task]`, `::chart find <text>` (developers). |

## Core changes

- `api.setUsableFromDeck` takes loc ids as well as names. A loc used from a deck but out of
  reach no longer lets go of the helm: live answers "I can't reach that!" and nothing else
  (rsprox 3455).
- `World` refreshes the active regions when an owned boat sails (or is teleported) into another
  map square. A player on a deck keeps the sea under their boat awake, but their own tile never
  changes there, so the sea a boat sailed into stayed asleep and its NPCs (a released duck) never
  moved.
- Client: a widget model wider or taller than the 2D model renderer's 1024-pixel cap (the
  spyglass overlay's frame, 936:2, as wide as the screen) is cut to its widget around the
  widget's centre, where it is drawn; before, the cap kept its first 1024 pixels from the left
  and the frame showed only its left half (`client/tests/widget-model-oversize.test.ts`).
- `Helm.plugin.js` listens to `sailing:leave-helm` (`{ player }`, answered with `left`) so
  other plugins can let go of the helm the way the helm's own option does.

## Behaviour (rsprox)

Every task, on success (rsprox 1009, 944):

1. The task's own line(s), when it has one.
2. Its varbit (`sailing_charting_<task>_complete`, sent here as its varp word).
3. `Charting complete: <col=0090bc>{hint}</col>`.
4. `{Sea} charting completion: <col=0090bc>n/N</col>`, then the same for its ocean
   (`Miscellaneous` for the bonus groups).
5. A sea or group fully charted: `You have completed charting a sea: {sea}` (or `a group`),
   `Fully charting this sea has unlocked the use of some <col=0090bc>rapids</col> within it.` when
   the sea has rapids, `You are awarded an additional <col=0090bc>{xp}</col> Sailing XP.` and the
   sea's completion varbit.
6. An ocean fully charted: `You have completed charting an ocean: {ocean}`, its ever-completed
   and XP-owed varbits, `For fully charting this ocean, Chartin' Charles McAtless on the
   Pandemonium will provide you with some training when you next speak to him.`, its completion
   varbit.
7. The popup (`notification_display`, "Charting Complete!" with the hint), sound 11166 and the
   XP: the task's and the sea's bonus in one drop.

| Kind | XP |
|---|---|
| Generic | 35 |
| Spyglass | 50 |
| Drink crate | 75 |
| Current duck | 125 |
| Mermaid guide | 175 |
| Weather troll | 250 |

The sea and group bonuses go by the sea's XP level (`xp_level`, else `required_level`): 190 (up
to 5), 270 (12), 510 (22), 590 (24), 1,710 (38), 1,990 (40), 2,880 (45), 4,430 (51), 6,710 (57),
8,750 (61), 12,030 (66), 17,230 (72), 23,910 (78).

**Generic spots** (rsprox 1009, 3455, 3467): Chart is used from the deck. From the helm, the
click lets go of it (`facility_lockedin` 3->0, `player_at_helm` 1->0, `helm_status` 2->1, sound
10793) and the rest comes a tick later; off the helm, all on the click. The writing animation
(13302) plays with the messages.
- Too far: `I can't reach that!`, and the player stays at the helm.
- Charted already: `You have already charted this and can get no further information from it.`
- An item used on it: `Nothing interesting happens.` (core).
- The Port Sarim task board (Inspect) and salvaging station (Sort-salvage) chart their task
  before doing what they do.
- The crab statue on Wintumber Island also adds a Medallion fragment, with its collection log
  line and an object box.

**Spyglass** (rsprox 3455, 3467 and others): Look-through near an uncharted view's hint marker.
From the helm, the click lets go of it and the rest starts a tick later.
- +0: the telescope animation (13301).
- +1: the screen fades out (174, script 948).
- +3: `fov_clamp` 3, `cutscene_status` 1, `minimap_state` 2, `gravestone_tli_hide` 1,
  `draw_distance_max_override` 1, `option_hide_rooftops_override` 1, and the view's first shot
  (`cam_moveto`/`cam_lookat`, rates 232/100).
- +5: the spyglass overlay (936) fades in (script 7059 on 936:4); the view's other shots follow,
  each its own (3-4 shots, 13 to 59 ticks in all).
- The overlay fades out; 3 ticks later the variables go back to 0, `cam_reset` and the screen
  fades in; 2 ticks after that the view is charted (50 XP).
- No view in reach: `There isn't anything nearby worth looking at.`. A charted view counts as
  none (captured: "nothing nearby" 2-5 tiles from views charted earlier).

**Current ducks** (rsprox 3467 and others): Track-current within reach of a duck marker.
- +0: the helm let go of. +1: the placing animation (13305).
- +2: `<col=3366ff>You release your current duck and he begins tracking the currents...</col>`,
  `sailing_charting_current_duck_reset` set, `current_hint_arrow` 5, the duck (15152) spawned at
  the current's start with a hint arrow, the item gone.
- +3: the duck says "Quack!" (area sound 413), then swims its route a tile a tick (`walk`, every
  step captured; routes of 17 to 214 tiles).
- At the end it turns into 15153: `<col=3366ff>Your current duck comes to a stop.</col>`,
  "Quack! Quack! Quack!", area sound 413 twice.
- Collect: +1 the helm let go of and the pick-up animation (13304); +2 the charting, the duck
  back in the inventory, the object box `The duck recognises your boat and climbs aboard. He
  shares the secrets of the currents he travelled on with you.`, the variables back to 0.
- No current near: `You don't spot any currents worth tracking.`
- Every run pays its XP again (the tasks' `give_repeat_xp`).
- Current Affairs charts the Catherby current with this duck: its Arhein lines play over the
  release and the collection (`charting:duck-released`, `charting:duck-collected`).

**Weather trolls** (rsprox 944 and others): Meaty Aura Logist (15154) stands on each task's
island (the Wiki's tile; 29 were missing from `npc-spawns.json` and are added there at their
captured tiles). Collect-data is used from the deck.
- No station: the helm let go of, the object box `The troll hands you a portable weather
  station.` with the station, then her `You take my number getter! Find where windy no do the
  blowing, and it get numbers. Bring numbers back to me! I try myself, but I just follow wind
  round in circles. Make sure you no do that!`
- Holding one: `You already have number getter. Go find where windys stop!`; another troll's:
  `Number getter not for here. Dis one go over there.`; under 57 Sailing: `You no good sail her.
  Windys topple you.`
- Take-reading away from the spot: `The weather station reads that the wind is blowing toward the
  <col=3366ff>{direction}</col>.`, the same tick, from the helm. The winds circle the spot (the
  Wiki; the captured readings fit a circle, each task clockwise or not).
- At the spot: the helm let go of and the filled station in the same slot; +1 the troll
  animation (13303) and the box `You find a spot where the winds have dropped. You fill the
  station's log and your charts with interesting data. You should now return to Meaty Aura
  Logist where she gave you the weather station.`
- Hand-in (Collect-data with the filled station): the charting (250 XP), `You hand over the
  troll's weather station and she promptly consumes the log book full of data.`, then `Numbers so
  tasty. Weather here must be really good!`

**Drink crates** (rsprox, 24 recordings): a sealed crate (59283, sent with the zone, shape 10,
rotation 0) on each drink task's tile, Pry-open from the deck.
- The helm let go of; no crowbar: the box `You require a crowbar to do that.`
- Sound 67 and the drink, with the object box `You pry open the crate and take a bottle of
  {drink} to sample.`; holding that drink already: `The crate contains a bottle of {drink}, but
  you don't take it as you already have one.`
- Drink: the box `This drink has been sealed in a crate for an unknown amount of time. It could
  do anything to you, good or bad. Are you sure you want to drink it?`, then `Are you sure you
  want to drink this?` with `Yes.`, `Yes, and don't ask again.` (varbit 19609, saved) and `No.`
- Drinking: `You drink the bottle of {drink}.` and the drink's own lines, animation 11288,
  graphic 2871 (height 92), sound 2401, the bottle gone, the charting (75 XP).
- Prying Times charts its grog (drink_crate_prying_times) with its own crate (58405) and
  transcript, through `charting:chart`; after the quest the stout is an ordinary drink.

**Mermaid guides** (rsprox 939, 944 and others): Victoria, Marina, Selina, Gloria and Christina
Kebbit-Monkfish (15155-15159), one at each diving task's spot (none were in `npc-spawns.json`;
57 added at their captured tiles), used from the deck.
- Dive without the fishbowl helmet and diving apparatus worn: `You need to be wearing diving
  equipment to dive with me!` (the Wiki says "deep sea diving equipment"; the capture wins).
- Otherwise `I want something in return if you're going to dive with me...`, her riddle (one to
  three lines, each dive's own), then the item search (`meslayer_mode14`): `Submit your answer to
  the mermaid's puzzle:`, or `Submit your first answer ...`, `second`, ... up to `eighth` for a
  riddle of several answers.
- Right (any order): the box `The mermaid, satisfied with your answer, escorts you to the bottom
  of the sea. You take some depth readings from your diving equipment and note down the
  interesting local flora and fauna.`, her dive animation (13191), sounds 10797 and 10798, the
  screen fading out; it fades back in 8 ticks later, and 2 after that the charting (175 XP) and
  `There you go. Hope the dive got you everything you needed!`

**Chartin' Charles McAtless** (rsprox 948): his multinpc (15151) shows Get-training (1554) once
`sailing_charting_tutor_met` is set. "Can you offer me some training?": `Charles takes your
charts and shows them to his parrot.`, `Yes, it looks like I can...`, one of seven lectures (`Charles
deep dives into the known history of mermaids.` ...) over a fade, and `You are awarded
<col=0090bc>213,000</col> Sailing XP for sharing charting information from the entire ocean!`:
every owed bonus at once (5,000-35,000 an ocean, 15,000 for the Miscellaneous groups, 100,000 for
everything; the Wiki), the owed variables back to 0.

**Hint markers**: locs 59281 (spyglass) and 59282 (current duck), shape 10, rotation 0, added
with the zone whether the task is charted or not, at the spots the Wiki lists (the Wiki's
Fremennik Strait view, 2366,3890, is a typo for the marker's 2366,3777).

## Ours (not captured)

- Reach from the deck is the deck's usual 12 tiles from the tile under the player. The captures
  have clicks answered from 2 to 12 tiles and refused from 8.5 on, measured from the boat's
  centre, so the real rule is likely measured from somewhere else on the boat.
- A spyglass view is in reach within 7 tiles of the tile under the player (the captures answer
  0-7 tiles from the boat's centre, counting views charted earlier as nothing).
- The spyglass view doesn't close and reopen the side tabs, hide the menu options (no tsps
  packet for hiding ops yet) or hide the HP bar, as live does: our toplevel's tab slots differ.
- A duck is released within 8 tiles of its marker (the captures: up to 8 from the boat's
  centre), always at the current's captured start; Collect reaches 12 tiles from the deck.
- Other currents need Current Affairs and 22 Sailing; no refusal was captured, so it's the
  "nothing worth tracking" line. Off the boat: `You need to be on your boat to release the duck.`
  (the quest's own line).
- A duck still out when its player logs out goes back to their inventory; live's timer
  (`sailing_charting_current_duck_reset`, "wait # seconds to collect another") isn't modelled.
- Routes seen in pieces (12 of 54: the duck left the player's view) are joined with straight
  steps; one (Sapphire Sea) runs on to the Wiki's end tile.
- The wind: the tangent of the circle turned 25 degrees towards the spot, to the nearest of 8
  directions (the captured readings agree best between 15 and 30 degrees; boat-centre lag and the
  Wiki's spot tiles blur the rest). Nine tasks have no captured readings and circle clockwise.
- A reading fills the station within 5 tiles of the spot (the captures: 0-8 from the boat's
  centre). Trolls are used from the deck within 12 tiles.
- A crate needs Prying Times and 12 Sailing (the skill guide); no refusal was captured, so the
  crowbar line stands in. The Prying Times grog's tile keeps the quest's own crate.
- A mermaid's wrong answer (the Wiki): `I don't think that's right... You should try again.` and
  the riddle again. Under 38 Sailing (the Wiki): `I don't think you are practised enough to dive
  here. I don't want you getting swept away!` and `You need a Sailing level of 38 to dive here.`
  Talk-to follows the Wiki's transcript. The Medallion of the deep (which also lets you dive) isn't
  in our cache. Turtle Belt's riddle (no recording) is Selina's clue from the Wiki in the other
  clues' words. Mermaids are used from the deck within 12 tiles.
- Charles with nothing owed or under an ocean's level: his transcript's lines. Get-training
  plays the same lines without the menu. `sailing_charting_tutor_met` is set once anything is
  charted (live sets it as you meet him).
- Charles's spawn (`npc-spawns.json`) was his Talk-to-only form (288), which never shows
  Get-training: now his multinpc (15151) at his captured tile.
- The crab statue with a full inventory: `You don't have enough inventory space.` and the statue
  stays uncharted, so it hands the fragment over once there's room (not captured).
- The player doesn't turn towards the spot (live sends a face angle; the deck's frame would need
  the boat's heading worked in).

## Not done (captured)

- The drinks' side effects: the NPCs some bring to the deck (a defending troll, the fish
  stoutier's, the monkfish stout's waves, the Sailing cat, a squirrel, a snakeling, a dwarf and
  others: 10 drinks), the fishier stout's blackout with its three trolls and their drinks (varp
  5035 bits 2-4), and the puzzler's poteen reward.
- A current duck asked for at the tools compartment while one is out at sea: `You have a current
  duck out at sea. Either find it or wait # seconds to collect another.` (no duck timer here).
