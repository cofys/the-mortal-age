# Agility courses added from the Wiki

Courses live in `server/plugins/skills/agility/courses/`, one file each, run by
`Agility.plugin.js`. Levels, XP, pet rates and requirements come from the OSRS Wiki; object ids and
tiles from the rev-241 cache (`yarn dump:loc`); movement from rsprox captures where they exist
(`rsprox_index.py trace`), otherwise it is a guess and says so below.

## Shared obstacles

Some courses share obstacles. A course with `sharesWith: { course, through }` continues a lap that
the other course began, through that obstacle index; when a clicked object belongs to more than
one course, the entry that continues the player's lap is used. A full lap's bonus counts the shared
obstacles' XP once.

## Shayzien Agility Course (basic and advanced)

- **Shared start:** the ladder, monkeybars and first tightrope belong to the basic course
  (`ShayzienBasic.js`); the advanced course (`ShayzienAdvanced.js`) shares them through obstacle 3.
- **Levels and XP:** the Wiki since the 2024 rebalance: basic 1 (153.5 a lap), advanced 45 (507.5),
  and no obstacle fails. Both laps add up from the obstacles alone, with no lap bonus.
- **Captured** (rsprox 1632, rev 226; the only recording): the ladder (reach up, on the platform a
  tick later), the monkeybars (on, about 12 tiles along, off, dropping to 1541,3633 on plane 2,
  with sounds 2474, 2470 and 2473) and the first tightrope (sound 2495).
- **From the cache's platform decking** (`shayzien_agility_decking01` and the tightrope and
  monkeybar pieces), not captured: the bar, both basic tightropes, the beams and the edges.
- **Guesses, to check in game:**
  - the beam swing (the cache has no Shayzien swing; `dorgesh_grapple_swing` is used);
  - where the gap's jump lands (1554,3639) and where the zipline lands (1522,3626);
  - the mark of grace tiles.
- **Not sent:** the course's progress varbits (`shayzien_agility_low_progress`) and the agility
  helper highlight; no other course sends them either.
- The start ladder is named "Ladder", so the Agility plugin claims it from the Ladders plugin
  (`ladders:climb`).

## Colossal Wyrm Agility Course (basic and advanced)

- **Files:** `ColossalWyrmBasic.js` and `ColossalWyrmAdvanced.js`, with their shared steps in
  `ColossalWyrmSteps.js`. The advanced course shares the start ladder and first tightrope
  (`sharesWith`, through obstacle 2), and both end on the same zipline.
- **Levels and XP:** 50 and 62, never failed. Per obstacle, the course page's tables since the 2026
  rework: basic 601.6 a lap, advanced 1053.6. (The page's text says 633 for basic, which its own
  table doesn't add up to; the obstacle pages still show the older values.)
- **Obstacles that need no click** (the edges after the first tightrope, the edge after the basic
  rope, the rope after the advanced tightrope) run as part of the obstacle before them, and their
  XP goes with it.
- **Tiles:** each obstacle ends on its termite marker (`varlamore_wyrm_agility_*_termites`), which
  sits where the obstacle drops the player.
- **Captured** (rsprox 1106 and 1108, rev 237, a Leagues world, before the August 2026 rework that
  made the basic course about 25% and the advanced about 40% slower): the start ladder, the edge
  jumps after the first tightrope (a run-up, then six hurdles three ticks apart), the advanced edge
  (a step back, a run-up, three long hurdles), the ropes (`wyrm_agility_ledge_*`), the basic rope's
  long jumps and the zipline (2 tiles a tick, the jump off, the fall and getting up). Timing is
  therefore the pre-rework one.
- **Wiki:** the lines said at the pauses on the last rope (one pause on basic, two on advanced).
- **Guesses:** where the tightropes wobble and the ropes pause, and the advanced ladder's top tile
  (1648,2908; the next recorded step starts beside it).
- **Not given yet:** termites, blessed bone shards and Worm Tongue's rewards; the giant squirrel
  rate is unknown on the Wiki since its 2026 change, so these courses don't roll it.

## Werewolf Agility Course

- **Files:** the course is `Werewolf.js`; the trapdoor, the stick throw, the trainers' lines and
  the Talk-To variants are `plugins/areas/WerewolfAgility.plugin.js`, which reacts to the Agility
  plugin's `agility:obstacle-start` event.
- **Access:** the trapdoor east of Canifis opens and is climbed down only with a ring of Charos
  worn (Wiki); otherwise its werewolf guard refuses. Inside, the obstacles don't need the ring,
  but the trainers call you "human" without it (Wiki transcripts).
- **A lap:** five stepping stones (10 XP each), three rows of hurdles (20 each), a pipe (15), the
  skull slope (25) and the deathslide (200), then the stick handed to the Agility Trainer at the
  bottom ("Give-Stick", 380, and the lap count): 730, the Wiki's lap. All sticks carried go when
  one is handed in (Wiki). The hand-in is a course obstacle done on an NPC (`npc` in the course
  data), so the lap, its message and the pet roll work as on any course.
- **The stick:** the Agility Boss throws it when the first stone is jumped onto ("FETCH!!!!!"), or
  asks "Why didn't you hand the stick over?!!?" if one is already carried (Wiki). The projectile is
  captured (338, `waa_stick_travel`); where it lands, beyond the pipes, is a guess.
- **Captured** (rsprox 366, 1849, 1858; rev 227-231, mostly Leagues): the trapdoor (sound 91,
  "The trapdoor opens..."), the guard's two lines on climbing down, the stepping-stone jump
  (`human_jump_stones`), the hurdles, the deathslide (by the teeth, 5 tiles a tick, its two
  messages and sounds) and the hand-in message.
- **From the map, not captured:** the pipe crawl, the skull slope climb, and the tiles either side
  of the trapdoor and the exit ladder.
- **The deathslide's failure is a guess:** the Wiki says Agility, Strength and carried weight all
  count, with no formula; it fails on Agility alone here (never from 80), partway down onto the
  spikes for 10-30 damage and 160 XP. A helmet is refused with the trainer's line (Wiki), as a
  message rather than his dialogue.
- **Not done:** marks of grace (no tiles known), the Skullball course, and putting a logged-out
  player back at the entrance.
