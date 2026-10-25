/**
 * What the active renderer knows about the 3D scene, for plugins that draw in 2D over it
 * (RuneLite's Perspective + Actor geometry). Set by the WebGL renderer and the WebGPU overlay
 * host; units are tiles, with height negative upwards, as the renderers use them.
 */
export interface SceneGeometry {
    /** Terrain height (tiles, negative up) at a fractional world tile position on a plane. */
    tileHeight(worldX: number, worldY: number, plane: number): number;
    /** Canvas device pixels for a scene point (world x, height, world y), or undefined off-screen. */
    worldToScreen(x: number, height: number, y: number): readonly [number, number] | undefined;
    /** The NPC's posed model triangles in scene units (x, height, y), for hulls and outlines. */
    npcModelPoints(ecsId: number, serverId: number): ReadonlyArray<readonly [number, number, number]> | undefined;
    /** The NPC type's default model height in fine units (RuneLite's logical height). */
    npcHeight(npcTypeId: number): number;
    /**
     * Each of a loc's models as triangles in scene units (x, height, y): one for most locs, two
     * for a wall corner or double diagonal decoration (RuneLite's convex hull and hull 2).
     */
    locModelPoints(loc: SceneLoc): ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> | undefined;
    /** The locs whose origin is this world tile on this plane: base id, shape and rotation. */
    locsAtTile(worldX: number, worldY: number, plane: number): SceneLoc[];
}

/** A loc in the scene: its base (untransformed) id, origin tile, plane, shape and rotation. */
export type SceneLoc = { id: number; tileX: number; tileY: number; plane: number; shape: number; rotation: number };

/** Where the minimap drew this frame (RuneLite's Perspective.localToMinimap). */
export interface MinimapGeometry {
    /** performance.now() when the minimap was last drawn; stale when it is hidden. */
    drawnAt: number;
    plane: number;
    /** Device pixels per minimap pixel. */
    scale: number;
    /** Canvas device pixels for a fractional world tile, or undefined beyond the minimap's reach. */
    worldToMinimap(worldX: number, worldY: number): readonly [number, number] | undefined;
}
