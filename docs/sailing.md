# Sailing

Design for Sailing in tsps: player-owned boats that sail the main world as world entities. It follows live OSRS as closely as possible; where the OSRS Wiki is silent, behaviour was checked in live OSRS and is marked **(live-checked)**.

**Status:** the first PR (engine, raft and saving) is implemented. What live OSRS sends, from wiki pages and live captures, is recorded in [the OSRS reference](sailing-osrs-reference.md).

## Scope

The first PR delivers a playable raft end to end:

- the engine: world views, boat instances, movement and collision, and world-entity sync to **every nearby player**, not just the owner
- raft content: boarding at a gangplank, the helm and sails, disembarking at a dock
- saving: owned boats, where each boat is, and the rules for leaving a boat (disembark, teleport, Escape, death, logout)

Later PRs: the cargo hold, skiff and sloop, shipbuilding facilities and hull upgrades, boat hitpoints and capsizing, port tasks. Other players **boarding** your boat is out of scope for now; they can see it and you on it.

## OSRS rules

| Topic | Rule | Source |
| --- | --- | --- |
| Boat types | Raft (1x3, 1 facility slot), skiff (2x5, 7 slots), sloop (3x10, 9-11 slots); bought from shipwrights | Wiki: Sailing, Boat |
| Boats owned | 1 at level 1, 2 at 15, 3 at 50, 4 at 78, 5 at 91 | Wiki: Boat |
| Location | A boat is at a single port (or mooring point) at a time. Disembarking there sets it | Wiki: Boat, Mooring point |
| Hitpoints | From hull and keel; no natural regeneration. Repaired by upgrades, a shipwright (50 coins per HP) or repair kits | Wiki: Boat |
| Logging out at sea | You log back in on your boat, at sea | live-checked |
| Teleporting from the boat | The boat disappears (is **sunk**). No gangplank can board it until a shipwright recovers it | live-checked |
| Escape | A helm option for a stuck boat with no teleport. The boat sinks, same as teleporting | live-checked |
| Death at sea | Gravestone at the last gangplank you set sail from; some cargo is lost | Wiki: Sailing |
| Capsizing (0 HP) | You are moved to the last gangplank you set sail from and keep your inventory; some cargo is lost | Wiki: Sailing |
| Return point | Disembarking at a gangplank or mooring point, or clicking a buoy, sets where you are sent after Escape or capsizing | Wiki: Mooring point, Buoy |
| Shipwright | At large ports: buy, destroy, customise, and retrieve a sunk boat or one at another port. The Pandemonium's is Junior Jim | Wiki: Shipwright |
| Recovery fee | Raft 250 gp, skiff 4,125 gp, sloop 50,000 gp; more with damage and built facilities | Wiki: Shipwright |

Cargo lost on death, capsizing and teleporting (courier crates, bounty items, salvage, trawling fish, fish crates) matters once the cargo hold exists; PR 1 has no cargo.

## Concepts

- **Owned boat**: a saved record in the player's save: its type, name, hitpoints, facilities and location. A player owns 1-5.
- **Boat instance**: an owned boat that is out at sea, live in the world. At most one per player. It exists only while its owner is aboard (or logged out aboard, see below).
- **World view**: a separate coordinate space with its own map, collision and entities. The main world is world view -1; each boat instance is a world view keyed by its world-entity index. Players and NPCs belong to exactly one world view.
- **Deck frame vs world frame**: a boat's deck is a 13x13-zone scene placed far outside the real map (tiles 9600+), with the boat's cache template zone copied into its centre. People aboard stand in deck coordinates, on level 0 (OSRS uses level 1, but the tsps client already raises actors on a boat by the deck height). The boat itself has a world-frame position (1/128-tile precision) and angle, and is drawn there. Converting a deck tile to the world tile under it uses the boat's position and angle.
- **Root tile**: for anything measured in the main world (sync range, main-world locs like gangplanks), a player aboard counts as standing on the world tile under their deck tile.

## Data model

A new `sailing` block in `PlayerSave`, owned by core (not a plugin attribute), because the engine's exit rules read and write it:

```ts
sailing: {
  boats: Array<{
    slot: number;             // 0-4
    type: "raft" | "skiff" | "sloop";
    name: [number, number, number]; // three words from cache db rows 8545-8547 (0 = none)
    hitpoints: number;        // PR 1: stored, not yet used
    facilities: number[];     // per hotspot, the facility's 1-based position in its list; empty = the type's defaults
    location:
      | { kind: "docked"; dock: string }                                // at a port or mooring point
      | { kind: "at_sea"; fineX: number; fineY: number; angle: number } // owner logged out aboard
      | { kind: "sunk" };                                               // needs a shipwright
    cargo: ({ id: number; amount: number } | null)[]; // the cargo hold, by slot
    parts: { hull: number; keel: number; sails: number; helm: number }; // tiers 0-6 into the cache's part lists
  }>;
  activeBoatSlot: number | null; // the boat the player is aboard or last set sail in
  returnPoint: { x: number; y: number; level: number } | null; // last gangplank, mooring point or buoy
  tools: number[]; // tools compartment slots holding their tool, shared by all boats
}
```

What a cargo hold accepts is data (`plugins/skills/sailing/data/sailing-cargo.json`): the tools by item id, and every other storable item by exact name or name prefix, grouped by category. `lostOnRecovery` marks the categories a shipwright's recovery loses.

Docks are every port in the cache (`plugins/skills/sailing/data/sailing-ports.json`): its id, name, docking level, buoy, gangplank, where the player lands on disembarking, and where a boat is placed when it isn't where it was left. What only some docks have, such as a shipwright or the shipyard, is in `plugins/skills/sailing/data/sailing-docks.json`.

The cache's `sailing_dock` table has 61 rows; 60 are docks here. Ports have a `sailing_gangplank_<port>` in the map; the 26 mooring points have none. Three docks have no land or sea coordinates in the table and take theirs from the map: Red Rock (dock 22) and Wyrmscraig and its cavern (59, 60, wide gangplanks). Their landing is the walkable tile beside the gangplank, and the boat moors on the water side the way every other port's does (4.5 tiles out for a raft, 5.5 for a skiff or sloop, along the gangplank's row). Red Rock's landing (2808, 2509), its dock number and "You dock the boat at Red Rock and disembark." are from an rsprox capture; no capture shows a boat spawned at these docks or anything at Wyrmscraig. Last Light has no gangplank in the map and is left out. The wide proxy gangplank at 2087, 2723 is the shipyard's.

## Lifecycle

One state machine in core owns every transition, so no path can leave a boat half-alive (the trade and bank bugs came from exits that forgot to clean up).

| From | Event | To | Effects |
| --- | --- | --- | --- |
| docked at A | board at A's gangplank | at sea (aboard) | spawn the instance at A; send the deck scene; move the player onto the deck; set `returnPoint` |
| docked elsewhere / sunk | board at A's gangplank | - | refused; the shipwright message |
| at sea | Dock at port B's buoy | at sea, docked at B | the boat's port becomes B; set `returnPoint` |
| at sea | disembark at port B's gangplank | docked at B, where it is | move the player to B's landing tile; dispose the instance; set `returnPoint` |
| at sea | teleport (any source) | sunk | dispose the instance; the teleport proceeds |
| at sea | Escape (helm) | sunk | dispose the instance; move the player to `returnPoint` |
| at sea | death | sunk (to confirm) | dispose the instance; gravestone at `returnPoint` |
| at sea | logout / disconnect | at sea (saved) | save the boat's position and angle; dispose the instance |
| at sea (saved) | login | at sea (aboard) | respawn the instance at the saved position; board the player |
| sunk | shipwright retrieve at port P | docked at P | fee: raft 250 gp (PR 1 has no damage or facilities) |

Teleports are caught in one core hook that every teleport passes through, not in each spell or item.

## Engine (core, TypeScript)

tsps has no world views, but it has `PrivateArea` (used by Construction's house): collision, pathfinding, object lookup and entity visibility are already scoped by the area an actor is in. A boat's deck is a `PrivateArea` at the deck coordinates, so walking and deck objects work without threading a world-view id through the engine.

- **Deck area** (`BoatDeckArea extends PrivateArea`): every tile of its scene is blocked except the boat type's walkable deck tiles; deck objects that block add their flags. Deck coordinates have no cache region, so without this they would read as walkable.
- **BoatManager**: allocates world-entity indices (3000-3999) and deck regions, builds deck collision from the template zone, ticks movement, and disposes instances. Ported from xrsps.
- **Movement and collision**: full sail 192 fine units (1.5 tiles) a tick, the wiki's base speed for a wooden hull; half and reverse 96; turning 128 units of angle a tick without losing speed. A move is checked in half-tile steps, so the boat can't hop over a thin strip of land. A tile is sailable when its level-0 overlay is water (decoded from the cache map) and it has no solid object; only tiles the hull newly covers are checked. Ported from xrsps (`BoatMovement`, `BoatCollision`, `WaterMap`).
- **Sync**:
  - `REBUILD_WORLDENTITY` sends a boat's deck scene (template chunks) to each client that sees it.
  - `WORLDENTITY_INFO` is per viewer: each tick, boats whose world tile is in a viewer's range are added, moved or removed, like NPC sync.
  - Player and NPC sync measure range from root tiles, and a deck area counts as the main world for who-sees-whom. When a player on a deck enters a viewer's list, the encoder writes its world-view id, and a player the viewer already sees who boards or leaves a boat is removed for one frame and added back with the new one. The client places them on the boat.
  - `NPC_INFO` gains the viewer's root tile in its header (server and client), so a player on a deck sees main-world NPCs where they are.
  - While a player is on a deck, the normal map keeps following their root tile, so the sea streams as the boat moves.
- **Deck locs** (helm, sails) are sent per viewer as loc spawns in the deck scene.

## Content (plugins)

- boat types (`plugins/skills/sailing/data/boats.json`): template zone, size, hull bounds, deck centre, walkable deck tiles, deck locs, stats, facility hotspots, part tiers and loc animations. The raft, and the skiff and sloop with camphor hulls.
- gangplanks: Board / Disembark, routed to the lifecycle
- helm: Navigate (walking onto the helm tile first) / Stop-navigating, the sail buttons (move mode from varbit 19175), clicking to set a heading; Escape, after a yes/no confirmation. Asking for more speed at full sail says "The boat is already going as fast as it can."
- helm animations (rsprox: the skiff's and sloop's; boats.json `anims.helm`, each size's set from the cache: `sailing_alpha_helm_raft01_*`, `sailing_alpha_helm_small01_*`, `sailing_helm_3x8_*` and their `human_` versions): taking the helm plays `active01` on the helmsman and the helm loc together; every 10 ticks after, both replay `active01_loop` while they navigate (the trim's own loop replaces it while the sails are trimmed); leaving resets the helmsman and plays the loc's `inactive01`. The raft's are matched by name, not captured. Navigate walks to the boat type's helm stand tile (boats.json `helmStand`, from the wheel), which the helm animations are made for (rsprox): the raft's own helm tile, south of the skiff's wheel, south-east of the sloop's (every recorded sloop navigation). At the helm the helmsman faces the bow, three tiles ahead (rsprox: the skiff's facing, the sloop's face angle 0), not the wheel. Stop-navigating resets the helm animation facing the bow and turns them to the wheel a tick later (live turns them on the same tick: face angle 768 on the sloop, 1024 on the skiff). Clicking any other loc from the helm leaves it and stops the boat (rsprox, salvaging hooks' Deploy from the helm); the sail cloth's options are used from the helm
- sails (rsprox capture of a skiff's sails, tick by tick): a boat's sail is two deck locs, the mast (the sails part) and the sail cloth beside it (`sailing_boat_sail_kandarin_<size>_<linen|canvas|cotton>`, the material the built sails' option names). Every change plays on both on the same tick (the cloth with the `_offset` animation): the transition (`down_to_full`, `full_to_half`, ...) or, when the state doesn't change, the state's own loop; a tick later the new state's loop (`down`, `half` or `full`). Full and half are up; stopped, moored and reversing are down. Each size's animations are in `boats.json` `anims.sail`.
- the sail cloth's options (rsprox): live sends deck locs with op flags (`loc_add_change_v2`), and the cloth shows only "Set" (op2, `0b10`) while the sails aren't set and only "Un-set" (op5, `0b10000`) while they are; reversing counts as set although the sails stay furled. Every sail change re-sends the cloth on the click's tick, before the animations (`setSailClothOps`, straight to the viewers: a loc that arrives after its animation starts over without it). Set raises full sail and Un-set stops, as the side panel's button, for whoever is at the helm; with nobody steering: "You or a crewmate must be navigating at the helm to adjust the sails." A crewmate walks beside the cloth; the helmsman uses it from the helm.
- gusts and Trim (`trim.js`; the user's capture of a trim, tick by tick, and the gusts in about a hundred rsprox.net recordings, rev 235-238): while the sails are set (half or full), a gust comes when the boat's gust timer runs out: "You feel a gust of wind.", sound 10839, the cloth re-sent with Trim (op flags `0b10001`) and the size's gust wind (`vfx_wind_sail_<size>_full01`) on the cloth every tick. Trim catches it within 14 ticks: "You trim the sails, catching the wind for a burst of speed!", the helm's `trim_sails01` on the helm loc and the helmsman, sounds 10842 and 10841, the cloth back to `0b10000`, the boost wind (`_speedboost01`) every tick, and the trim loop every 4 ticks. The wind shows only while the sails are set (rsprox: lowering them stops it at once). The boat sails at its hull's speed cap (table column 25) for the sails' boost duration (column 27: 20 to 36 ticks; 24 in the capture, teak sails); then "The wind dies down and your sails with it." and `trim_sails02`. Left alone, a gust dies down after 14 ticks (271 of 300 recorded) with the same message. The next gust comes 50 ticks after a trim (334 of about 420) or 49 after an untrimmed gust dies down. The timer keeps running while the sails are down, so a gust can come as soon as they go up; a boat's first comes 49 ticks after its sails are first set. Trim with no gust: "The sails are already catching the wind well." Animations per size are `boats.json` `anims.trim`; the sloop's wind effects (`large01`) are matched by size, not seen in a capture. The client draws tile graphics on a deck tile through the deck's overlay map (`GfxManager.listWorldInstancesInView`), as it places NPCs aboard; before, they were only matched against normal map squares and never drawn. Not done: the boost's speed at half sail (half of the cap here) and trimming by a crewmate away from the helm (the helmsman animates) Our `loc_add_change` carries the flags as an optional ninth byte, and the client hides the ops whose bit isn't set
- shipyard: Junior Jim's Customise-boat takes the boat to the shipyard, whose boat schematics (interface 939) swap its hull, keel, sails or helm for any tier, at the cache's levels and materials, for Construction XP; parts, stats and fees come from the cache's sailing tables at runtime. Aboard the boat there (its own gangplank), a facility hotspot's Build builds any facility the hotspot allows (no XP), and a facility's Modify removes or replaces it; hotspots, facilities and materials are the cache's too
- Summon boat tablets (`SummonBoat.plugin.js`; the user's rsprox captures of four breaks, and the Wiki): Break near a dock or mooring point opens the boat selection in its Summon mode (varbit 18553 = 6, table 149 `boat_selection_type_teleport_boat_with_focus`) with varp 5006 (`sailing_boat_selection_teleport_dock`) and 5005 set to the dock's row, and busy (varbit 12393) on; closing it without a choice clears them all. Choosing a boat with a teleport focus (or a greater one) moves it there as a shipwright's recovery does, losing the same cargo, and sets its port varbit; the player breaks the tablet at once (`poh_smash_magic_tablet` 4069 delayed 16, sound 965 delayed 15), and two ticks later "Your boat has been summoned to <the dock>." with `teleport_other_casting` (spotanim 343, seq 1818), area sound 199 and the tablet used up; busy clears two ticks after that. Away from a dock: "You need to be near a dock or mooring point to use this tablet." "Near" is within 16 tiles of the gangplank or landing here (the cache's dock zones are server side; the captured breaks were 6 and 13 tiles away). "Last boat" summons the boat last summoned (attribute `sailing:last-summoned-boat`) without the interface; it isn't captured, and neither are the no-focus, same-dock and nothing-summoned-yet messages, which are ours
- Teleport to boat tablets (`BoatTeleport.plugin.js`; Wiki, not captured): teleport the player to the dock or mooring point where a moored boat with a greater teleport focus is, without boarding it. The boat is picked in the boat selection's Teleport to Boat mode (8).
- teleport foci: each boat's `sailing_boat_N_teleport_focus` varbit (block offset 12: 19270 for slot 1) is 1 with a teleport focus and 2 with a greater one (rsprox). The boat selection greys out boats by it: table 149's Summon mode `requires_teleport_focus` (either focus), Teleport to Boat `requires_greater_teleport_focus`
- shipwright: Junior Jim at The Pandemonium retrieves a sunk raft for 250 gp (PR 1 needs this, or a sunk raft is stuck forever)
- facility facing: on a side hotspot, facilities that work over the side (cannons, hooks, nets, wind catchers) face out and the rest (a range, a keg) face in; chum stations and spreaders face in although they work over the side (rsprox: all 431 recorded placements). The centre line faces 0.
- salvaging: shipwrecks rise and sink at every site the cache places them; a boat's salvaging hook reels salvage in from one nearby for Sailing XP, and a salvaging station (on a boat or at a port) sorts it into loot for more. Data in `plugins/skills/sailing/data/sailing-salvage.json`
- developer commands: `::maxboat [default|salvaging|combat|fishing]` gives the boat being customised in the shipyard (else the active one) every part's best tier and a preset's facilities, replacing what was built (not while aboard it; the shipyard's display is rebuilt); `::raft`, `::skiff` and `::sloop` give a boat docked at The Pandemonium, `::pandemonium` teleports to its gangplank, `::sailingtools` shows every tool in the cargo hold's tools compartment (their quests don't exist yet), and `::boatmats <hull|keel|sails|helm> <tier> [boat]` or `::boatmats facility <name>` spawns a part's or facility's materials for the shipyard. The dock is where xrsps's raft docks (gangplank 59836 at 3070, 2987); the Pandemonium quest and buying boats come later

## Client

The tsps client already decodes `REBUILD_WORLDENTITY`, `WORLDENTITY_INFO` and world-view ids in player and NPC sync. Ported from xrsps: `worldEntityMotion` (placing the deck scene at the boat's position), the `WorldEntityAnimator` fix, `HelmSteering` (click-to-heading on the sea surface), and the picking, camera and minimap changes that follow the player's root tile.

- Steering from the helm (`HelmSteering.ts`): a click on the boat's deck scene, which includes its drawn border just outside the world view (`DECK_SCENE_MARGIN`), aims at where the mouse ray meets the water; any other click is a world tile. Before the margin, a click on that border was taken as a world tile thousands of tiles away and steered the boat off in a fixed wrong direction.
- A boat's deck is its own map square (overlay map 200 + entity index). It is never pruned with the map grid, which it is never in (or every grid move while sailing would drop the deck and rebuild it), and it never fades in like new terrain.
- A boat replaced by a new one (the shipyard respawns it after a build or part swap) gets a new entity index, as live does (970 -> 972 in a capture), so viewers despawn the old and spawn the new in the same update. The client keeps the old deck drawn until the new one's is built (or five seconds pass), so the boat doesn't vanish while its deck loads.

## Testing

Headless tests like `trade.test.cjs` and `bank.test.cjs`, one per lifecycle row: every exit path leaves exactly one consistent saved state and no live instance. Plus movement and collision, and sync range (a viewer gets the boat when it comes into range and loses it when it leaves).

## Open questions

- Death at sea: does the boat sink, or return to its last dock?
- Recovery fee once boats take damage and have facilities (the wiki gives only the base fee).
- The game messages for disembarking and Escape, and the Escape confirmation prompt, are placeholders; the live wording is unconfirmed. "You board your boat." is confirmed by a live capture.
- Logging out at sea when the boat last left from an island mooring point rather than a port (a Dec 2025 fix changed this; unclear if it differs).

## Sources

- [Sailing](https://oldschool.runescape.wiki/w/Sailing), [Boat](https://oldschool.runescape.wiki/w/Boat), [Mooring point](https://oldschool.runescape.wiki/w/Mooring_point), [Buoy](https://oldschool.runescape.wiki/w/Buoy_(Sailing)), [Shipwright](https://oldschool.runescape.wiki/w/Shipwright) — OSRS Wiki
- xrsps (`bank-overhaul` branch) `docs/internals/sailing.md` and its engine code, the starting point for the engine and client work
