# Procedural World Plugins

This folder contains the server-side procedural region tooling used by the web client.

## Scope

The current system supports:
- Generating and streaming procedural terrain/buildings per region.
- Dumping real cache houses to JSON examples.
- Rebuilding exact dumped houses.
- Generating style/type-driven houses (for example `VARROCK SHOP`).
- Generating a simple street scene with houses on both sides.
- Learning preset/style hints from nearby cache regions.

This is plugin-based and developer-only (commands require developer/owner rights).

## Main Files

- `ProceduralRegionStream.plugin.js`
  - Command entrypoints.
  - Procedural payload creation (`heights`, `overlays`, `underlays`, `flags`).
  - Chunked streaming to client over opcode `12`.
- `procedural/BuildingUtil.ProceduralRegionStream.js`
  - Core procedural building/house generation.
  - House replay helpers and style/type resolution.
  - Interior, roof, windows, doors, ladders.
- `procedural/TownUtil.ProceduralRegionStream.js`
  - Street-level generation (houses on both sides of a road gap).
  - Street overlays and doorway connectors.
- `procedural/RegionBuildingAnalysisUtil.ProceduralRegionStream.js`
  - House boundary detection.
  - `::dumphouse`, `::checkhouse`, structure scan + preset learning.
- `procedural/ObjectType.ProceduralRegionStream.js`
  - Shared object type enum values.
- `procedural/LadderUtil.ProceduralRegionStream.js`
  - Ladder chain parsing/placement logic for multi-floor houses.
- `procedural/ProceduralDataPaths.ProceduralRegionStream.js`
  - Shared data output paths.
- `ReplaceMapRegions.plugin.js`
  - Startup hook for runtime region replacement via plugin API.
  - Startup hook auto-loads all numeric `*.pack` files from `plugins/world/data` and replaces those regions.

## Runtime Region Replacement Hook

Use the plugin API hook:

```js
api.replaceMapRegion(regionId, source);
```

Supported `source` formats:
- `"/absolute/or/relative/path/to/12343.pack"`
- `["/path/to/terrain.dat|.gz", "/path/to/object.dat|.gz"]`

Behavior:
- Replaces server clipping/runtime map decode for that region.
- Streams the replacement through the native binary client protocol so connected players see the same map edits.
- Re-streams active replacements on player login.

## Data Files

All procedural data is stored in this plugin folder:

- `plugins/world/data/house-examples/*.json`
  - House dumps used by `::buildhouse` and `::genhouse`.
- `plugins/world/data/proc-building-presets.json`
  - Learned generation presets from `::procreglearn`.
- `plugins/world/data/analysis-reports/*.json`
  - Region scans from `::procregscan`.
- `plugins/world/data/terrain-biomes/*.json`
  - Terrain biome samples merged by `::dumpterrain <biome>`.

## Command Reference

All commands are in `ProceduralRegionStream.plugin.js`.

```text
::procregion <regionX> <regionY> [seed]
::procregionhere [seed]
::cleargen

::procregscan [radius]
::procreglearn [radius]
::dumpterrain <biome>
::genterrain <biome> [seed]

::dumphouse <tag> [type]
::checkhouse
::buildhouse <style> [index]
::genhouse <style> [type] [seed]

::genstreet [style] [type] [seed]
```

### Important Notes

- `::cleargen` clears all streamed procedural overrides on the client for that player and forces cache map behavior again.
- `::dumphouse` writes examples into `plugins/world/data/house-examples/<tag>.json`.
- `::dumpterrain` writes biome terrain samples into `plugins/world/data/terrain-biomes/<biome>.json`.
- `::genterrain` generates a full region from a dumped biome profile.
- `::buildhouse` replays a dumped house example exactly (by index or random).
- `::genhouse` generates a similar house using dump-derived profile data when available.
- `::genstreet` currently defaults to:
  - style: `varrock`
  - type: `SHOP`
  - center street gap width: `4`

## Payload Pipeline

1. A command builds placements/floor patches/flags.
2. `generateRegionPayload(...)` creates tile and object payload fields:
   - `heightsB64`
   - `overlaysB64`
   - `underlaysB64`
   - `flagsB64`
   - `buildingPlacements`
3. Payload is JSON-chunked and sent via opcode `12`:
   - `META`
   - `CHUNK`
   - `END`
4. Client reconstructs and applies procedural region override.

## Typical Workflows

### Dump and Replay Real Houses

1. Stand inside a target house.
2. `::checkhouse` to verify bounds.
3. `::dumphouse varrock SHOP` (or another tag/type).
4. `::buildhouse varrock` to replay random example.
5. `::buildhouse varrock 0` to replay a specific example.

### Generate Similar Houses

1. Collect several examples with `::dumphouse <tag> <type>`.
2. Generate using `::genhouse <tag> <type>`.
3. Iterate by adding more examples for better style/type coverage.

### Generate a Street

1. `::genstreet varrock SHOP`
2. Optional deterministic seed: `::genstreet varrock SHOP 12345`

Current street behavior:
- Houses on both sides of a 4-tile gap.
- Doors face inward toward the street.
- Middle 2 tiles get a road/path overlay.
- Doorway connectors are drawn from each door to the center path.
- Side bands are flattened for consistent house ground levels.

## Constraints and Current Behavior

- Generation is region-local (`64x64`, up to 4 planes).
- Commands are developer-only.
- Roof behavior is sensitive to style roof IDs and object-type pairing.
- House boundary detection is local-first and tuned for practical dumping.
- Dump profiles are style/type specific; `type` helps avoid mixing incompatible layouts.

## Next Steps

Recommended next tasks:

1. Add a street-layout preset system in `TownUtil` (T-junctions, crossroads, market squares).
2. Add deterministic road overlay palettes by theme (varrock/falador/etc).
3. Add placement validation pass for roof continuity (diagnostic mode before stream).
4. Add a `::gentown <style> <type> [seed]` command that composes multiple streets.
5. Add object-role inference from dumps without hand-tuned assumptions.
6. Add regression snapshot tests for:
   - roof continuity
   - doorway orientation
   - street connectors
   - flattening consistency
7. Add a compact debug command to print generated house/street summary stats.

## Quick Debug Checklist

- If procedural map does not show: verify client receives procedural packets and run `::procregionhere`.
- If cache map should return: run `::cleargen`.
- If house dump fails: verify position with `::checkhouse`.
- If generation quality is poor: add more `::dumphouse <tag> <type>` examples and rerun `::genhouse`.

`codex resume 019ca379-af07-7ea0-a53b-e4694197cf43`
