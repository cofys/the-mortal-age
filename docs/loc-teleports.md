# Loc teleports from captures

Ladders, stairs, caves, holes and tunnels that did nothing in tsps (or went the wrong way) now move the player as live OSRS does: the same destination, animation, sound, fade and timing. They come from the [rsprox capture database](https://rsprox.net/database), not from a hand-written list.

- **Data:** `server/data/definitions/loc-teleports.json`, one entry per loc placement and option.
- **Trapdoors:** `server/data/definitions/loc-swaps.json`, trapdoors whose Open and Close swap the loc for its other state.
- **Plugin:** `server/plugins/world/LocTeleports.plugin.js` plays the entries.
- **Sync:** `server/scripts/sync-loc-teleports.cjs` writes the data from the captures. Its rules are in `server/scripts/loc-teleport-matching.cjs`, and its lasting decisions in `server/data/definitions/loc-teleport-sync.json`.

## The captures

The capture index lists every loc option that moved the player, per loc and clicked tile:

```sh
python3 rsprox_index.py loc-teleports --out loc-teleports.json
```

Per loc: the destinations (and the tile the player clicked from, for locs used from either side), the tick of the move, the player's animation, sounds, whether the screen faded, the messages of attempts that didn't move anyone, a dialogue choice on the way, and labels for instances, boats, agility shortcuts and Leagues or event worlds. Ticks count from the player arriving at the loc.

## The sync

```sh
cd server
yarn build
yarn sync:loc-teleports --captures loc-teleports.json            # dry run: what it would add, and why the rest is left out
yarn sync:loc-teleports --captures loc-teleports.json --write    # add them
yarn sync:loc-teleports --captures loc-teleports.json --report report.json   # every loc's outcome
```

**What tsps does now:** each captured loc is clicked in a headless world with every plugin loaded. The player stands on the tile the capture shows they clicked from, has 99 in every skill, and for a multiloc the varbit shows the variant with the option. The sync then compares where they end up with the capture.

**Taken** when all of these hold:
- **The kind:** a ladder, staircase, steps, trapdoor, manhole, rope, cave, hole, tunnel or crevice, by the loc's name in the rev 241 cache.
- **What tsps does:** nothing, or Ladders takes it and goes nowhere or elsewhere.
- **One destination:** or one per side, for a staircase used from either end.
- **No requirement:** no attempt was turned away. Messages that are the player doing something else (a potion, poison, a chat channel, a music unlock) don't count.

**Left out**, with the reason in the dry run:
- **Labelled locs:** instances, boats and agility shortcuts. Leagues and event worlds count as the normal game, apart from `league*` content.
- **Already right:** tsps already goes there.
- **Another plugin's loc:** Agility, quests, the Stronghold of Security, the Werewolf course. Content that claims a ladder through `ladders:climb` counts as its owner.
- **Travel networks:** one loc with far-apart destinations and no dialogue, where an interface picks the destination: spirit trees and the Magic Mushtrees have their own plugins ([spirit-trees.md](spirit-trees.md)); the shipyard portal is Sailing's.
- **Dialogue choices:** "Climb up or down?" where the captures saw only one answer. Ladders keeps asking.
- **Several destinations from one tile:** something other than where the player stands decides.
- **Decisions:**
  - Sailing and the shipyard;
  - minigame, raid and boss areas (Theatre of Blood, Guardians of the Rift, Tempoross, Giants' Foundry and more);
  - holiday events;
  - the Dagannoth Kings' ladder, which picks a boss instance;
  - Fossil Island's underwater caves, which need diving gear;
  - one ladder only seen on a Leagues world.

Nothing is removed, and the plugin's own entries are ignored while probing, so a second run adds nothing.

## The first run (2026-10-09)

From 4,282 recordings: **346 locs** added.
- **By name:** 91 ladders, 67 stairs, 28 caves, 27 cave entrances, 24 staircases, 14 ropes, 12 trapdoors, 11 steps, 11 tunnels and more.
- **Fades:** 63 fade the screen.
- **Two-way:** 4 are used from either side.

Examples:
- **Caves:** the Tlati dragon nest cave, the Haunted Mine, Lithkren, the Wilderness boss caves, Waterbirth and the Dagannoth Kings' dungeon levels, the Hunter Guild's cave and ropes, the Smoke Devil and Stronghold Slayer caves.
- **Ladders and stairs:** Varrock Museum's basement stairs, the Lunar galleon's pier, cellar ladders that led to the wrong floor (the one at 3084,9672 went up a floor underground instead of to the surface), the Arceuus library stairs (Ladders asked "which way?" where the game goes one way).

Every entry was clicked again with the plugin loaded, and all 346 land where live OSRS does (the open trapdoors in their opened state).

## Quest plugins that took every copy of a loc

Two quest plugins handled a loc by id alone, so every placement of it went to the quest's spot:
- **Monk's Friend:** its thieves' cave ladder is the ordinary cellar ladder (17385, `ladder_from_cellar`). Every such ladder without a better handler sent the player to the cave exit in Ardougne, among them the cellar under the trapdoor north of Paterdomus (3405, 9907) and two cellars at (2837, 9927) and (2845, 9925). It now only takes the cave's own ladder (2561, 9622).
- **In Search of the Myreque:** all five Mort Myre cave tunnels (5046) led to one tile. The quest no longer handles them, and each goes where the captures show.

The sync had left these ladders and tunnels alone as another plugin's. With the quests fixed, the captures cover them.

## The Karamja volcano

The Karamja and TzHaar plugins skipped the volcano dungeon: the rocks went straight to the TzHaar city, and the city's exit straight to the surface. Now it goes as in the game:
- **The rocks** (2856, 3168): into the dungeon, below the side the player stands on (captured: from 2855 to (2855, 9568), from 2858 to (2858, 9568)).
- **The dungeon's cave entrance** (2863, 9571): to the TzHaar city at (2480, 5175), the tile the city's exit is used from in the captures. The entrance itself has none.
- **The city's exit** (2479, 5176): back into the dungeon at (2862, 9572), as captured.
- **The climbing rope** (2856, 9569): up beside the rocks, on the side it's climbed from. It has no capture and mirrors the way down; it only goes up, so Ladders no longer asks which way.

Gemstone Crab's cave and the Stronghold of Security's ladders differ from the captures because their plugins handle them, and they work as intended. The Wyvern cave shortcut is left as it is.

## Trapdoors

Many trapdoors have to be opened before they can be climbed down: Open swaps the loc for an open trapdoor with Climb-down, and Close swaps it back. The captures show it for 7 trapdoors, written by hand into `loc-swaps.json` with the captured message, animation, sound and ticks:
- Draynor's (`vampire_trap1`);
- the common trapdoor used in many places (`trapdoor`);
- Port Phasmatys (`ahoy_trapdoor`) and its brewery;
- the Champions' Guild;
- the Myreque hideout;
- the Paterdomus mausoleum.

For Draynor's: "You open the trapdoor." a tick after arriving, the open-chest animation and sound a tick later, the open trapdoor on tick 3. The swap is seen by everyone, as the game sends it to the whole area. Draynor's open trapdoor has no Close in the rev 241 cache, so it stays open.

Plugins that own a trapdoor (Edgeville's, the Werewolf course's) load first and keep it; Varrock's manholes stay with Misthalin. An open trapdoor is only on the map once opened, so the sync opens it while probing its Climb-down.

## Playing an entry

The click is handled the tick after the player arrives, so each captured tick comes one tick earlier from the click:
1. **The animation's tick:** the animation and sound, and the fade out when there is one.
2. **A tick later:** the minimap goes off.
3. **The captured tick:** the move.
4. **After the move:** the fade back in a tick later, and the overlay closed two ticks after that.

Movement is blocked meanwhile. The sequence stops if the player is moved, dies or logs out.

**Stairs without an animation:** live OSRS turns the player towards the stairs a tick after they arrive and moves them later, with no animation. The Arceuus library stairs move them on tick 3 in both recordings, Varrock Museum's on tick 2.

**Taking the click:**
- **Locs nobody else handles:** the plugin's generic object hook takes the click when the clicked tile and option have an entry, or the loc and option have a trapdoor swap.
- **Ladders and stairs Ladders handles:** Ladders asks other plugins first (`ladders:climb`), and an entry answers before Ladders guesses from the map. See [climbing.md](climbing.md).

**Free-to-play worlds:** the plugin isn't members-only, because free-to-play ladders are in the data. FreeToPlay already moves anyone who ends up in a members area back to free land.

## Not done yet

- **Boats, portals, doors, gates and barriers:** fares, quests and requirements; among them the Holy barrier under Paterdomus, which needs Priest in Peril (no capture of the refusal yet).
- **Locs live OSRS turned some players away from:** 175 with a requirement (a quest, a skill total, an item). Each needs its requirement from the Wiki.
- **Climb dialogues:** ladders whose "Climb" asks up or down, with both answers.
- **The Prifddinas agility tree ladder:** the Agility plugin sends the player to the city's coordinates on another part of the map, where the capture goes to (2269, 3393, 2).
