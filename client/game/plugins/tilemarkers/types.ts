/**
 * What the renderers draw as in-scene destination and true tiles, from a plugin's
 * `tileMarkersConfig()`. Tile Indicators draws its tiles as an overlay and does not answer it,
 * so this is the disabled config unless another plugin does.
 */
export interface TileMarkersPluginConfig {
    enabled: boolean;
    showDestinationTile: boolean;
    showCurrentTile: boolean;
    destinationTileColor: number;
    currentTileColor: number;
}

/** What the renderer draws with no plugin answering tileMarkersConfig(). */
export const DISABLED_TILE_MARKERS_CONFIG: TileMarkersPluginConfig = {
    enabled: false,
    showDestinationTile: false,
    showCurrentTile: false,
    destinationTileColor: 0xa9a753,
    currentTileColor: 0x808080,
};
