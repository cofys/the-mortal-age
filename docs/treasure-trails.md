# Treasure Trails: easy to master

Beginner clues are in [beginner-treasure-trails.md](beginner-treasure-trails.md). This page covers
the members tiers, built in `server/plugins/treasuretrails/TreasureTrails.plugin.js`
(`members: true`) and its `trails/` units. Easy, medium and hard are implemented. Elite and master
add their step families to the same engine.

## Where the content comes from

The installed cache (revision 241) holds Jagex's whole clue-helper catalogue: the
`cluehelper_clue_*` DB tables, filtered by their `difficulty` column (1 easy … 5 master).

From easy upwards, every step is its own "Clue scroll (<tier>)" item, and item param 623 names
that step's clue-helper row. `Catalogue.TreasureTrails.js` joins the two, so the item in the
player's hand *is* the step. For each step it resolves:
- the target: an NPC (with its live morphs), a loc, a tile, or a keyed loc with the NPCs that drop
  its key;
- the outfit: one requirement per worn slot. It is either "any of these items", "any item of this
  clue item group" (item param 258: ring of dueling is 18, amulet of glory 6), or "nothing worn
  here". The cache writes the last as its `blankobject` item: "Have nothing equipped at all",
  "… and no boots";
- the challenge, if any: its question and answer come from the same `cluehelper_challenge_question`
  row, and its "Challenge scroll (<tier>)" item points back at the step's row;
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

Medium has 167 steps, 44 of them with a challenge scroll:

| Family | Target | Steps |
| --- | --- | --- |
| Anagram | NPC | 47 |
| Cipher | NPC | 6 |
| Coordinate | Dig | 44 |
| Cryptic | NPC / loc / key | 8 / 8 / 11 |
| Emote | Tile, outfit, two emotes, Uri | 25 |
| Map | Dig / crate | 10 / 2 |
| Music (Cecilia) | NPC | 6 |

Hard has 186 steps:

| Family | Target | Steps | Extra |
| --- | --- | --- | --- |
| Anagram | NPC / loc | 17 / 1 | 13 question challenges, 5 puzzle boxes |
| Cipher | NPC | 11 | 6 questions, 5 puzzle boxes |
| Coordinate | Dig | 54 | 53 summon a wizard named by the row: Saradomin 2955 (32), Zamorak 2954 (21) |
| Cryptic | NPC / loc / dig | 23 / 17 / 18 | 3 question challenges |
| Emote | Tile, outfit, Uri | 17 | the row names a double agent: 1778 (14), 1777 (3) |
| Fairy ring | Dig | 11 | read as "The cryptic reveals where to dig:" then the code, as on the Wiki |
| Map | Dig / crate | 4 / 3 | |
| Music (Cecilia) | NPC | 10 | |

The challenge answers are read from the cache. They agree with the Wiki's challenge-scroll guide
(the osrsreboxed-db `clue-challenges.json` export) on 89 of 90 questions. The exception is the Old
Crone's Slayer Tower question: the cache says 623, the Wiki 619. The game uses the cache.

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

**Trail length:** easy trails are 2–4 steps, medium 3–5 and hard 4–6 (Wiki, "Clue scroll (<tier>)"). The
Wiki publishes no per-length weights, so the length is chosen uniformly; this is an implementation
assumption.

## Steps

- **NPC:** talk to the target NPC; the step completes after the dialogue. The NPC may wander
  during the conversation without invalidating the handover.
  - NPCs speak their own transcript: the `treasure-trails-<tier>` variant in `npc-dialogues.json`,
    read through NpcDialogues' `npc-dialogue:start` with `exact: true` and a `select` that only
    captures the steps. An NPC without that variant gets the fallback line, not its everyday chat.
  - Where the transcript has nothing, a shared fallback line is used.
  - The received item and handover wording appear in the native item dialogue (`objectbox`,
    group 193, item argument 400). The transcript supplies its wording, including Lowe's
    generic "You've found another clue!"; the fallback names the giving NPC.
- **Challenge scroll** (Wiki "Challenge scroll"):
  - The first talk adds the challenge alongside the clue, requiring a free inventory slot.
    The challenge carries the same trail token and revision; it is not a second trail.
  - Reading the challenge scroll shows the question.
  - The next talk shows the NPC's question-request line, then opens the number prompt labelled
    "Enter amount:". A wrong answer costs nothing; the right one consumes both scrolls in one
    inventory refresh and gives the next clue or casket with an item dialogue.
  - Without its matching clue in the inventory, the challenge remains readable but cannot advance
    a trail. Repeated answers and stale dialogue callbacks cannot grant another step.
  - The words come from the NPC's transcript. The "talk again" variant goes under nine names
    (`when-talked-to-again`, `answering-the-clue`, …), and the wrong/correct branches under several
    wordings; any missing part uses the most common transcript wording.
- **Key** (medium cryptic): killing one of the step's NPCs drops its key (`npc-drops:add`) while
  the trail is held and the player has no key. The target loc then opens only with the key, which
  is used up. Contextual drop events also run when the NPC has no base drop table. A search without
  the key is handled as locked and shows the cache clue-helper's hint about the key's source;
  this feedback is functional wording, not a replay of each container's exact locked note.
- **Search:** a new generic core hook, `onBeforeObjectInteraction`, claims an interaction on the
  target loc at its exact tile before ordinary object handlers. It mirrors `onBeforeNpcInteraction`,
  and unclaimed interactions fall through.
- **Dig:** a spade (or Eastfloor spade) on the exact tile and plane.
- **Map:** Read opens the step's map interface; the dig is as above.
- **Emote:**
  - The player performs the step's emote within 3 tiles of its target while wearing the full outfit.
  - That spawns that tier's Uri for the player only; a successful talk advances the inventory on
    his first phrase, even if the player closes the conversation before "What?".
  - Medium steps need a second emote after Uri appears and before he is spoken to.
  - Uri speaks his transcript. With the wrong outfit or a missing emote he says "I do not believe we
    have any business, Comrade."; otherwise a random phrase, the player's "What?", then "You have
    been given a new clue!" (or a casket). The verified medium handover instead says "You've been
    given a clue!" and displays cache item `trail_medium_emote_exp9` (19780), independently of the
    next clue actually in the inventory. Uri remains through the spoken lines and is removed at
    the handover continuation; the recording's additional 3–5 tick transmitted-list delay is not
    reproduced.
  - The cache gives a target tile but no area, so the 3-tile radius follows the beginner runtime's
    usual value. This is an assumption.
- **Puzzle box** (hard; `Puzzle.TreasureTrails.js`, Wiki "Puzzle box" and the puzzle box guide):
  - **Hand-over:** the first talk adds the step's box alongside the held clue, on one of the
    tier's images (hard: castle, tree, troll).
    - The box pairs with its clue by gameval name (`<clue gameval>_puzzlebox`).
    - The image is stored in the trail meta.
  - **The board:**
    - Opening the box shows interface `trail_slidepuzzle`. Its board is inventory `trail_puzzleinv`
      (slots 0–24, an empty slot is the blank), and varp `if1` picks the image.
    - Each image's 24 pieces come from cache enum 1864.
    - The client predicts each slide and plays the sounds.
    - The server owns the board: it accepts only a piece next to the blank and always resends the
      board, so a refused move snaps back.
  - **Scramble:** a box starts 101 random slides from solved (Wiki), which keeps every board
    solvable. The board lasts the session, so a relog gives a new puzzle, as the Wiki says. Each new puzzle step gets a fresh board even within the same trail.
  - **Solving and words:**
    - Solving it marks the trail; talking to the NPC with the solved box gives the next clue.
    - The NPC's words come from its transcript: the "having solved" / "without having solved"
      variants or the "holding the puzzle box" branches.
    - "[player name]" is filled in.
- **Fights** (hard; Wiki coordinates guide, "Saradomin wizard", "Double agent"):
  - **Coordinate digs:** the first correct dig summons the step's wizard, owned by the player,
    seen only by them and attacking at once. Digging again does nothing while it lives. Its death
    marks the trail, and the next dig gives the clue.
  - **Emotes:** the emote summons the double agent first; its death brings Uri. There's no agent
    when the emote is the trail's first step (Wiki "Double agent"). The outfit must be worn again
    to speak to Uri.
  - **A wizard that is gone** (logout, death, despawn) is summoned again by the next dig. The
    Wiki notes that hiding and digging again summons another.
  - **Drops:** the fights keep their own Wiki drop tables.
  - **Data gaps, outside clue code:**
    - The Saradomin wizard only melees, because the NPC loader picks one combat style.
    - The Zamorak wizard lacks the Flames of Zamorak graphic.
    - Their shouts are missing.
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
| `cluehelper_map_medium_0` | Draynor willows | `trail_map03` |
| `cluehelper_map_medium_1` | West of the Crafting Guild (hobgoblin peninsula) | `trail_map07` |
| `cluehelper_map_medium_2` | McGrubor's Wood crate | `trail_map10` |
| `cluehelper_map_medium_3` | North of the Tower of Life | `trail_map15` |
| `cluehelper_map_medium_4` | Crate west of the Clock Tower | `trail_map16` |
| `cluehelper_map_medium_5` | Chemist's house, Rimmington | `trail_map17` |
| `cluehelper_map_medium_6` | Miscellania | `trail_clue_medium_map008` |
| `cluehelper_map_medium_7` | Mort Myre Swamp | `trail_clue_medium_map009` |
| `cluehelper_map_medium_8` | Ourania Cave entrance | `trail_clue_medium_map010` |
| `cluehelper_map_medium_9` | South-east of the Lighthouse | `trail_clue_medium_map011` |
| `cluehelper_map_medium_10` | Between Seers' Village and Rellekka | `trail_clue_medium_map012` |
| `cluehelper_map_medium_11` | East of the Ranging Guild | `trail_map04` |
| `cluehelper_map_hard_0` | Lumber Yard crate | `trail_map05` |
| `cluehelper_map_hard_1` | Yanille anvils | `trail_map08` |
| `cluehelper_map_hard_2` | West Ardougne | `trail_map12` |
| `cluehelper_map_hard_3` | Observatory crate | `trail_map13` |
| `cluehelper_map_hard_4` | Dark Warriors' Fortress crate | `trail_map14` |
| `cluehelper_map_hard_5` | South-east of the Wilderness Agility Course (volcanoes) | `trail_clue_hard_map006` |
| `cluehelper_map_hard_6` | South of the Legends' Guild (picnic tables) | `trail_clue_hard_map007` |

The named `trail_clue_medium_map008`–`012` interfaces were rendered too, not assumed from their
names. `trail_map19` looks like the Lighthouse map but belongs to another tier.

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
on its own `hh_constructed_*` varbit. Easy has 31 units and medium 25; the Wiki "STASH" page has the
rules:

- **Build:** a hammer, any saw and 10 nails of one metal (not dragon), plus:
  - easy: Construction 27 (boostable) and 2 planks, for 150 Construction XP;
  - medium: Construction 42 and 2 oak planks, for 250 XP;
  - hard: Construction 55 and 2 teak planks, for 400 XP.

  Building sets the unit's varbit.
- **Search a built unit:** it stores the step's complete outfit, or returns it if the inventory has
  room for all of it. Item-group slots take any item of the group; "nothing worn" slots store
  nothing.
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

PR #890 review verification independently decoded RSProx recordings
[559](https://rsprox.net/download/559), [1063](https://rsprox.net/download/1063),
[1064](https://rsprox.net/download/1064) and [1067](https://rsprox.net/download/1067):

- 559 is **revision 227, Leagues V**. Its medium Baraek (12057/12058), Karim (2849/2850) and
  Charlie (19750/19751) windows retain the clue when adding the challenge, then remove both on a
  correct answer. Karim and Charlie receive another clue; Baraek receives a medium casket.
  All handovers use objectbox 193:1 with integer argument 400. The NPC's answer-request line
  precedes count-prompt script 108 with "Enter amount:". These are narrow inventory/UI facts;
  no trail lengths, reward rates or gameplay timing are derived from Leagues.
- 1063/1064/1067 are **revision 235, ordinary members worlds**. Each replaces the medium clue in
  the same tick as Uri's first phrase, before "What?" and the handover. The handover displays
  item 19780; Uri leaves the transmitted NPC list 3–5 ticks later.
- No ordinary-world challenge handout sample was found in the database's challenge-text search.
  The selected windows do not establish the full-inventory case; refusing the handout without
  a free slot is the tested implementation policy.
- The imported Baraek answer-request line names Dunstan because the cached Wiki source itself
  (`Transcript:Baraek`, revision 15315303) names Dunstan. This is not a parser defect. Generated
  data remains unchanged pending an upstream Wiki correction and regeneration. The dialogue
  adapter preserves player lines and rejects unrelated named NPC speakers, using the common
  question-request fallback here.
- Loaded drop tables cover Hill Giant 7261 already. NPCs 11195, 10498, 10499, 3063 and 3266 have
  no base table; their kills now reach the same contextual-drop lifecycle. All six variants are
  covered through the real NPC death callback, including no duplicate key when one is carried.

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
- `tests/treasure-trails-medium.test.cjs` covers all 167 medium steps and every one of the 44
  challenge NPCs: hand-over, the question on Read, a wrong answer kept, and the cache's answer
  accepted. It also covers:
  - the transcript words, including Ali's differently named variant;
  - an NPC with no transcript lines;
  - all 11 keyed steps (key drop only during the trail, locked without the key, key used up);
  - crate maps, coordinate and map digs;
  - all 25 double emotes with item groups and Uri's transcript;
  - "no boots";
  - challenge coexistence, full inventories, orphan challenges and repeated answers;
  - native item dialogue packets and prompt wording;
  - Uri's immediate inventory advancement and early dialogue closure;
  - player versus NPC transcript speakers and actual death-drop dispatch without base tables;
  - the medium casket and medium STASH units.
- Original implementation baseline: clue, casket and Mimic tests passed 128/128 with the
  imported tables; beginner, beginner-casket and clue-capacity tests passed unchanged.
- Review-fix verification: server TypeScript build passed; the easy, medium, NPC drop override
  and looting-bag drop tests passed 42/42, followed by a fresh medium-file run including the
  additional final-challenge atomic-refresh/casket regression (19/19). The final full server
  suite, 366 files at concurrency 4, passed **4,938/4,938**, with no failures, cancellations or
  skips (248 seconds); its log includes that additional regression.
- **Original implementation live checks, before the review fixes:** the following natural-route
  results are historical; the review follow-up uses recordings and automated tests, without a
  fresh live-account walkthrough.
- **Natural route:** on the isolated slot-8 world (game 43708, agent MCP 49808), a headless test
  account completed three full easy trails through real packets: 7 NPC, 5 search, 2 dig and 1 emote
  steps. Each ended in a reward casket.
- Two closed chests failed only because the test teleported onto their walled side. Both open
  normally from the open side.
- A clue read before a logout resumed at the same step after logging in again.
- With the table imported, two more trails ended in real casket openings. Each showed the reward
  screen (group 73), new collection-log entries and "You have completed 2 easy Treasure Trails."
- **Medium natural route** on the isolated slot-10 world (game 43710, agent MCP 49810): a headless
  account finished nine medium trails through real packets. Along the way it:
  - answered 13 challenge scrolls through the number prompt (Teicuh, Nicholas, Zoo keeper,
    Captain Tobias, Aretha, Hickton, Cook, Dunstan, Nieve, Marisi …);
  - performed double emotes with Uri's transcript phrases;
  - solved coordinate, map and crate steps.
  - Each trail opened a real medium casket.
- Live checks found three bugs the fixture-based tests had missed, all now fixed and covered by tests:
  - an empty dialogue never ran its action;
  - the "nothing worn" `blankobject` outfits were treated as an item to wear;
  - a wandering NPC could walk out of range before the challenge hand-over.
- Elder Torgan's anagram step first looked as though Torgan wasn't spawned, but he is. He has no
  Treasure Trails transcript, and two things went wrong:
  - `npc-dialogue:start` fell back to his everyday chat for the missing variant;
  - the step then demanded he still be within 3 tiles after that long talk, though he wanders.

  The clue transcripts now ask with the new `exact: true` flag. Without that flag, a missing variant
  still plays the default transcript, so other callers are unchanged. NPC steps no longer re-check
  range after the dialogue. Both fixes are tested, and Torgan's step completes live.
- Keyed steps were left to the unit tests in the walk, because they need a kill.

- `tests/treasure-trails-hard.test.cjs` covers all 186 hard steps, with every fight, puzzle box and
  challenge. It checks:
  - the 24 cache pieces of each hard image;
  - that scrambles are real, solvable boards (even inversions) and that only adjacent slides count;
  - all 10 puzzle steps (hand-over, the board sent to the client, refusal unsolved, the next clue
    solved), with Brambickle's transcript words;
  - wizards (summon, no second while one lives, death, then the dig), a wizard summoned again after
    it vanished, and double agents before Uri (none on a first step);
  - fairy-ring digs, the hard casket and hard STASH units.
- **Joint casket outcomes:** the hard table's mega-rare Super attack, strength and defence entry is a
  joint outcome (`items`). The shared casket roller rejected it, which would have kept every hard
  casket shut; it now grants all of its items (`tests/casket-reward-rolls.test.cjs`).
- **Hard natural route** on the isolated slot-13 world (game 43713, agent MCP 49813), through real
  packets:
  - Saradomin and Zamorak wizards fought and the dig repeated, including in the Wilderness.
  - A double agent fought, the outfit worn again, and Uri's phrase.
  - Challenge scrolls answered.
  - Fairy-ring digs.
  - Puzzle boxes handed over with their image varp set, refused unsolved, and rendered in the real
    client (vision clip).
  - Hard caskets opened.
- An unarmed walker was killed by a wizard once. The clue survived, and the next dig summoned a fresh
  wizard, as the Wiki describes.

Sources:
- [Clue scroll (easy)](https://oldschool.runescape.wiki/w/Clue_scroll_(easy))
- [STASH](https://oldschool.runescape.wiki/w/STASH)
- [Cecilia](https://oldschool.runescape.wiki/w/Cecilia) and [her transcript](https://oldschool.runescape.wiki/w/Transcript:Cecilia)
- [Easy maps](https://oldschool.runescape.wiki/w/Treasure_Trails/Guide/Maps/Easy)
- [Beginner maps](https://oldschool.runescape.wiki/w/Treasure_Trails/Guide/Maps/Beginner)
- [Clue scroll (medium)](https://oldschool.runescape.wiki/w/Clue_scroll_(medium))
- [Challenge scroll](https://oldschool.runescape.wiki/w/Challenge_scroll)
- [Coordinate clues](https://oldschool.runescape.wiki/w/Treasure_Trails/Guide/Coordinates)
- [Emote clues](https://oldschool.runescape.wiki/w/Treasure_Trails/Guide/Emote_clues)
- [Uri's transcript](https://oldschool.runescape.wiki/w/Transcript:Uri)
- [Medium maps](https://oldschool.runescape.wiki/w/Treasure_Trails/Guide/Maps/Medium)
- [Clue scroll (hard)](https://oldschool.runescape.wiki/w/Clue_scroll_(hard))
- [Puzzle box](https://oldschool.runescape.wiki/w/Puzzle_box)
- [Double agent](https://oldschool.runescape.wiki/w/Double_agent)
- [Saradomin wizard](https://oldschool.runescape.wiki/w/Saradomin_wizard)
- [Hard maps](https://oldschool.runescape.wiki/w/Treasure_Trails/Guide/Maps/Hard)
- installed cache revision 241

## Inventory and repeat-step regressions

Question challenges and puzzle boxes are linked to the original held clue by token and
revision. Both require a free inventory slot, cannot duplicate on repeated dialogue, and
are consumed in the same refresh as clue advancement. Orphan auxiliary items cannot
initialize another trail. Removal uses the container's empty Item rather than null.

Real Player/Inventory/Equipment regressions cover middle and final challenge answers,
stale callbacks, full bags, active clue capacity, two puzzles within one trail, reopening
a box, and changing from combat gear before the required repeat emote. Existing medium
Uri timing, transcript/item-box behavior, key drops and all cache-backed tier tests remain.
No new live capture is claimed by these regression tests.

Isolated own-server verification (revision241, slot2/MCP49802): a naturally rolled
hard cipher for Otto Godblessed retained clue19900 alongside challenge19901.
Answering3 and continuing the success dialogue replaced the clue with2739,
removed the challenge and displayed the NPC's next-clue item box. Adding a coin
then reused the freed slot without an inventory error. This is local runtime
validation, not a new OSRS capture or a full visual replay of every puzzle.
