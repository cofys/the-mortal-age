# Shortest Path

A port of [Skretzo's Shortest Path](https://github.com/Skretzo/shortest-path) v1.22.5 (commit
`142e73e2`). It finds the quickest route to a tile, walking and using the transports and teleports
the account can use, and draws it on the scene tiles, the minimap and the world map. It is off by
default, as an unenabled plugin hub plugin is; turn it on in the plugin list.

## Using it

- **Shift + right-click** a tile: **Set Target** sits just under "Walk here", which stays the
  left click. Ctrl + Shift leaves the menu alone, so the dev teleport still works.
- **Right-click the world map** anywhere: **Set Target**.
- Once a path is shown, both menus also offer **Set Target 2** (another target; the search ends at
  whichever is cheapest), **Set Start** (route from that tile instead of the player), and
  **Clear Path** (on the world map, or on a tile of the path). The world map orb's menu has
  **Clear Path** too.
- The path is recalculated when you stray more than `recalculateDistance` tiles from it (or
  cleared, with `cancelInstead`), and ends when you are within `finishDistance` of the target.

The path is red when it reaches the target, blue while it is being calculated, and purple when the
finished path falls short of the target (`unreachableTargetDistanceThreshold`). Where the next step
is a transport, its tile names it: "Varrock Teleport", "Climb-up Staircase", a fairy ring's code.

## Other plugins: `PluginMessage`

As upstream ([Cross-plugin communication](https://github.com/Skretzo/shortest-path/blob/v1.22.5/docs/Cross-plugin-communication.md)),
namespace `shortestpath`:

```ts
eventBus.post(new PluginMessage("shortestpath", "path", { start, target }));
eventBus.post(new PluginMessage("shortestpath", "clear", {}));
```

- `path`: `target` is a WorldPoint (`{ x, y, plane }`), a packed point, `{ point }`, or an array or
  Set of them. `start` defaults to the player. No `target` while a path is shown recalculates it
  from `start`. A malformed target is logged and ignored. `config` overrides settings by key until
  `clear`.
- `clear`: removes the path and the overrides.

`PluginMessage` gained RuneLite's `(namespace, name, data)` constructor for this, with `namespace`
and `name` fields. Server plugin messages keep the `(channel, data)` form, with an empty name.

## The collision map

`client/public/shortestpath/collision-map.zip` is made from this server's own cache, not taken from
upstream, so routes follow the walls the server moves players through. It is generated output:
never edit it, rerun the exporter after a cache update or a `data/regions` replacement.

```bash
cd server && yarn build && node scripts/export-collision-map.cjs
```

[`server/scripts/export-collision-map.cjs`](../../../../server/scripts/export-collision-map.cjs)
boots `CachePipeline`, loads every cache region through `RegionManager.loadMapFiles` (so
`data/regions` replacements count), and writes each tile's north and east edges in upstream's format
from `Region.clips`, with `RegionManager.canMove`'s masks. It keeps two of upstream's dumper rules:
doors are passable (a wall loc with actions, except the locked and quest doors upstream excludes),
and a tile with no floor is blocked. The output is deterministic;
`server/tests/export-collision-map.test.cjs` reruns it and checks the committed file is current.
On Lumbridge and Varrock it differs from upstream's own map by a handful of tiles, and the
Lumbridge to Varrock route is identical on both.

## What is ported

| Upstream | Here |
|---|---|
| `Pathfinder` (the default "Legacy" backend), `NodeGraph`, `IntMinHeap`, `IntDeque`, `VisitedTiles`, `TargetGoals`, `WildernessChecker` | `pathfinder/` |
| `CollisionMap`, `SplitFlagMap` | `pathfinder/CollisionMap.ts`, `SplitFlagMap.ts` |
| `PathfinderConfig` (refresh, transport pricing, avoid wilderness) | `PathfinderConfig.ts`, the plugin's `buildRequest` |
| The pathfinding thread | a Web Worker (`ShortestPathWorker.ts`) that runs the search in slices and posts the partial path, as upstream's render thread polls it |
| `Transport`, `TransportType`, `TsvParser` and its field parsers, `ResourceLoader.transports`, `ItemVariations` | `transport/`, `resources.ts` |
| `Requirements` (types, teleport item mode, respawn, unlocks, skills, quests, varbits, varps), `TransportEligibility`, `TransportItems` (OR groups, staffs, offhands, currency threshold) | `requirement/`, `transport/TransportItems.ts` |
| `PathTileOverlay` (Tiles and Lines styles, transport hints, tile counter, unreachable text, the transport and collision map debug views), `PathMinimapOverlay`, `PathMapOverlay` | `ShortestPathOverlays.ts` |
| `MenuVerbs`, `PluginMessageHandler` (`path`, `clear`), `PathScheduler` / `RefreshCoordinator` (restart, set start, off-route recalculation, finish distance) | `ShortestPathPlugin.ts` |
| `ShortestPathConfig`, and the routing settings upstream shows in its sidebar panel (`ConfigKey`, `config-items.tsv`) | `ShortestPathConfig.ts`, same group, keys, names and defaults |

Quest states come from the `QUEST_STATUS_GET` clientscript, as RuneLite's `Quest.getState`; levels,
varbits, varps and items from the client's own state. The bank counts once it has been opened.

## Not ported

- **The A\* backend, sailing, bank pickup routing and target item requirements.** Upstream's A\* is
  opt-in and matches the default backend on legality, so the default is the one ported. Sailing
  routes need the boat state from the Sailing skill. Bank detours (and the `requirements` of a
  plugin-message target, which only add them) are a separate search layer; "Inventory and Bank"
  teleport modes still count banked items, without routing via a bank.
- **The sidebar panel, `query`, `getTarget`, `transports` messages, the debug panel, the hotkey,
  item and spell highlighting, the teleport pulse.** The routing settings are in the plugin's
  config panel instead. Nothing here uses the other messages yet.
- **POH, jewellery boxes and seasonal (Leagues) transports.** The offline world has no player house
  or Leagues; `teleportation_portals_poh.tsv`, `teleportation_boxes.tsv` and
  `seasonal_transports.tsv` are not bundled.
- **Planted spirit trees** (the Port Sarim, Etceteria, Brimhaven, Hosidius and Farming Guild patch
  trees) are never used: upstream reads which are grown from the farming patches, which isn't
  ported, and treats them as unplanted until it knows. **Collection log unlocks** ("Unlocked" teleport mode) are not read: "Unlocked" behaves
  as "All".
- **Path styles** other than Tiles and Lines, and the world map target marker image (a diamond is
  drawn instead).
- "Max" quest point requirements never pass: the client doesn't know the maximum quest points.

## Transports the offline world may lack

The TSVs are upstream's, unchanged. No server code or data in `server/plugins` names these locs
(by id or by gameval name), so they may do nothing offline and a route through them will not work.
Doors and gates are left out of the check: `Doors.plugin.js` opens them from the cache.

- **Agility shortcuts:** Climb Rope 31849, Climb Wall 39541 and 39542, Jump-over Inconspicuous rocks
  29044, Cross Bridge 57715-57718, open Door 255277.
- **Boats:** the Iceberg and Weiss boats (21176), the Fremennik boat (29917), and the rowboats
  58634-58643.
- **Spirit trees:** spirit tree 37329.
- **Portals:** the Clan Cup portal (27094), Portal 6550, Enter Portal 43841.
- **Other transports:** Floor 18124, 18129-18136 and the Trapdoor tunnel 18083, Tunnel entrance
  23609, Statue 22355, Trapdoor 12762, Ice chunks 29869, Strange passage 28918, Passage 26250,
  Ladder 23586, Climb Wall 39541.

Teleport spells, items and minigame teleports have no loc to check; whether a teleport works
offline is up to the server's own spell and item handling.
