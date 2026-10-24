# Treasure Trails: easy to master

Beginner clues are in [beginner-treasure-trails.md](beginner-treasure-trails.md). This page covers
the members tiers, built in `server/plugins/treasuretrails/TreasureTrails.plugin.js`
(`members: true`) and its `trails/` units. Easy is implemented. Medium, hard, elite and master
add their step families to the same engine.

## Where the content comes from

The installed cache (revision 241) holds Jagex's whole clue-helper catalogue: the
`cluehelper_clue_*` DB tables, filtered by their `difficulty` column (1 easy … 5 master).

From easy upwards, every step is its own "Clue scroll (<tier>)" item, and item param 623 names
that step's clue-helper row. `Catalogue.TreasureTrails.js` joins the two, so the item in the
player's hand *is* the step. For each step it resolves:
- the target: an NPC (with its live morphs), a loc or a tile;
- the outfit: one requirement per worn slot, either "any of these items" or "any item with this param";
- the emote slot and the STASH loc;
- the music track (DB table `music`, `midi` column).

Only rows with a "Clue scroll (<tier>)" item are clue steps. Quest scrolls such as the treasure
scroll share the tables.

Easy has 166 steps:

| Family | Target | Steps |
| --- | --- | --- |
| Cryptic | NPC | 41 |
| Cryptic | Loc (search/open) | 71 |
| Cryptic | Dig | 8 |
| Emote | Tile, outfit, Uri | 33 |
| Map | Dig | 7 |
| Music (Cecilia) | NPC | 6 |

## Trail state

A trail's state lives in the scroll's item metadata, under `treasure-trails:<tier>`:
`{version, token, revision, completed, length, row}`.

**Starting a trail:**
- A scroll with no trail (a drop, box or vessel gives the tier's first cache item, 2677 for easy)
  starts one the first time it is read or used.
- The trail starts on a uniformly random step, and the scroll becomes that step's item.

**Solving a step:**
- Each solved step replaces the scroll in the same slot with the next step's item, carrying the trail.
- The last step leaves a reward casket.
- Stale tokens and revisions cannot advance a trail twice.
- Banking, dropping, death and saves keep the trail, because they keep item metadata. A scroll
  read before a logout resumed at the same step after logging in again.

**Trail length:** easy trails are 2–4 steps (Wiki, "Clue scroll (easy)"). The Wiki publishes no
per-length weights, so the length is chosen uniformly; this is an implementation assumption.

## Steps

- **NPC:** talk to the target NPC; the step completes after the dialogue, within 3 tiles.
- **Search:** a new generic core hook, `onBeforeObjectInteraction`, claims an interaction on the
  target loc at its exact tile before ordinary object handlers. It mirrors `onBeforeNpcInteraction`,
  and unclaimed interactions fall through.
- **Dig:** a spade (or Eastfloor spade) on the exact tile and plane.
- **Map:** Read opens the step's map interface; the dig is as above.
- **Emote:**
  - The player performs the step's emote within 3 tiles of its target while wearing the full outfit.
  - That spawns that tier's Uri for the player only; talking to him completes the step.
  - The cache gives a target tile but no area, so the 3-tile radius follows the beginner runtime's
    usual value. This is an assumption.
- **Music:** from Cecilia's Wiki transcript, the player selects the requested track, then speaks to
  her.
  - "Select the song I asked you to play, and speak to me again."
  - "Thank you, I love that song!" then completes the step.
  - The track is tracked from `audio:play-song`.

### Map interfaces

No cache data links a map step to its map interface, so `trails/data/map-interfaces.json` records
them. Each was matched by opening every candidate interface on an isolated test world, capturing
it with the agent MCP's vision clip, and comparing it with the Wiki's map images.

| Step | Location | Interface |
| --- | --- | --- |
| `cluehelper_map_easy_0` | Al Kharid mine | `trail_map18` |
| `cluehelper_map_easy_1` | West of the Champions' Guild | `trail_map01` |
| `cluehelper_map_easy_2` | South-east Varrock mine | `trail_map02` |
| `cluehelper_map_easy_3` | Falador standing stones | `trail_map06` |
| `cluehelper_map_easy_4` | Galahad's house | `trail_map09` |
| `cluehelper_map_easy_5` | Behind the Wizards' Tower | `trail_map11` |
| `cluehelper_map_easy_6` | Falador statue crossroads | `trail_clue_easy_map006` |

The same captures show that the beginner runtime's `MAP_INTERFACES` gets four of its five maps
wrong:

| Beginner map | Beginner shows | Should show |
| --- | --- | --- |
| South-east Varrock mine | `trail_map06` | `trail_map02` |
| Draynor willows | `trail_map15` | `trail_map03` |
| Falador stones | `trail_map05` | `trail_map06` |
| Wizards' Tower | `trail_map03` | `trail_map11` |

That is a separate fix; this change leaves beginner untouched.

## STASH units

`Stash.TreasureTrails.js` handles the STASH units. Each emote step's `hidey_hole_loc` is a multiloc
on its own `hh_constructed_*` varbit. Easy has 31 units; the Wiki "STASH" page has the rules:

- **Build:** Construction 27 (boostable), a hammer, any saw, 2 planks and 10 nails of one metal
  (not dragon). Building gives 150 Construction XP and sets the unit's varbit.
- **Search a built unit:** it stores the step's complete outfit, or returns it if the inventory has
  room for all of it.
- **Saved state:** built units and their contents are saved per player
  (`treasure-trails:stash-built`, `treasure-trails:stash-stored`), and the varbits are re-sent at
  login.

Not yet implemented:
- the "STASH units take equipped items" setting;
- cosmetic variants, such as (g) or (or) items;
- the S.T.A.S.H chart and Watson's noticeboard.

## Reward caskets

`Caskets.TreasureTrails.js` opens tier caskets with the shared `Rolls.RewardCaskets` roller over
`clue-caskets.json`.

**Before anything is consumed,** it:
- rolls the base rewards;
- rolls chance-based tertiaries using their exact `probability`;
- asks ClueCapacity for milestone rewards (`treasure-trails:milestone-rewards`);
- checks that every reward resolves to an item.

**Then it:**
- consumes the casket once;
- counts the completion;
- feeds the collection log;
- hands over overflow through `forceAdd`;
- shows the reward screen.

**Entrana** (Wiki): armour and weapon rolls are removed, and non-shared clue uniques can't be
obtained. This uses the exporter's section names: easy keeps Food, Runes and Shared treasure trail
items.

**Milestones:**
- ClueCapacity owns the scroll cases (minor at 100, major at 200), including their recovery.
- Any other milestone item, the easy Large spade at 500, comes with the casket whose completion
  reaches it.

**The rewarded 1/50 master clue** obeys clue capacity (`treasure-trails:can-receive`). After X Marks
the Spot it becomes a scroll box (`treasure-trails:clue-item`).

**The table:** `clue-caskets.json` is imported unedited from the `osrsreboxed-db` exporter
(`scripts/drops/clue_caskets.py`, RSPSApp/osrsreboxed-db#13 at `efbf4bbe`, SHA-256
`87d26369d2408d11b19cb4bace5c741d628ac3283d29bcc2f6cc80b4df560c29`; two generations byte-identical).
- It adds the easy, medium and hard pools and structured `milestones` for every tier.
- The elite and master pools are unchanged apart from their new `milestones`.
- Without a tier's table, its casket says "You can't open this casket right now." and is kept.
- Generated JSON is never hand-edited.

## Verification

- `tests/treasure-trails-easy.test.cjs` runs on the real cache and checks:
  - the object-hook contract;
  - all 166 steps resolving to distinct items and targets;
  - trail start and lengths;
  - every NPC, search, dig, map, emote and music step solved from the right place and refused from
    the wrong one;
  - stale advances;
  - STASH build, store and withdraw;
  - the imported easy table: every reward resolves, the casket opens once, and a missing table keeps it;
  - the Entrana filter over 300 seeded caskets;
  - the master clue's capacity and box rules;
  - the Large spade on exactly the 500th casket.
- Clue, casket and Mimic tests pass 128/128 with the imported tables.
- Beginner, beginner-casket and clue-capacity tests still pass unchanged.
- **Natural route:** on the isolated slot-8 world (game 43708, agent MCP 49808), a headless test
  account completed three full easy trails through real packets: 7 NPC, 5 search, 2 dig and 1 emote
  steps. Each ended in a reward casket.
- Two closed chests failed only because the test teleported onto their walled side. Both open
  normally from the open side.
- A clue read before a logout resumed at the same step after logging in again.
- With the table imported, two more trails ended in real casket openings. Each showed the reward
  screen (group 73), new collection-log entries and "You have completed 2 easy Treasure Trails."

Sources:
- [Clue scroll (easy)](https://oldschool.runescape.wiki/w/Clue_scroll_(easy))
- [STASH](https://oldschool.runescape.wiki/w/STASH)
- [Cecilia](https://oldschool.runescape.wiki/w/Cecilia) and [her transcript](https://oldschool.runescape.wiki/w/Transcript:Cecilia)
- [Easy maps](https://oldschool.runescape.wiki/w/Treasure_Trails/Guide/Maps/Easy)
- [Beginner maps](https://oldschool.runescape.wiki/w/Treasure_Trails/Guide/Maps/Beginner)
- installed cache revision 241
