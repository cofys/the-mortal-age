uniform int u_sceneBorderSize;
const int tileSize = 128;

int getTileHeight(int x, int z, uint plane) {
    return texelFetch(u_heightMap, ivec3(u_sceneBorderSize + x, u_sceneBorderSize + z, plane), 0).r * 8;
}

// Height interpolation that matches the terrain mesh surface.
//
// The terrain is triangulated per-tile along one of two diagonals depending
// on tile shape/rotation. Since that data isn't available in the shader we
// compute the height for BOTH possible diagonal splits and take the maximum.
// This guarantees objects sit at or above the rendered terrain surface
// regardless of the actual diagonal — a small upward bias on mismatched
// tiles is far less noticeable than clipping underground.
float getHeightInterp(vec2 pos, uint plane) {
    vec2 tilePos = pos / float(tileSize);
    ivec2 tile = ivec2(floor(tilePos));
    vec2 offset = fract(tilePos);
    float hSW = float(getTileHeight(tile.x, tile.y, plane));
    float hSE = float(getTileHeight(tile.x + 1, tile.y, plane));
    float hNW = float(getTileHeight(tile.x, tile.y + 1, plane));
    float hNE = float(getTileHeight(tile.x + 1, tile.y + 1, plane));

    // SE-NW diagonal (offset.x + offset.y = 1)
    // Match BridgeHeightSampler without rounding the actor's height to whole units.
    float h0;
    if (offset.x + offset.y <= 1.0) {
        h0 = hSW + (hSE - hSW) * offset.x + (hNW - hSW) * offset.y;
    } else {
        h0 = hNE + (hNW - hNE) * (1.0 - offset.x) + (hSE - hNE) * (1.0 - offset.y);
    }

    // SW-NE diagonal (offset.x = offset.y)
    float h1;
    if (offset.x <= offset.y) {
        h1 = hSW + (hNW - hSW) * offset.y + (hNE - hNW) * offset.x;
    } else {
        h1 = hSW + (hSE - hSW) * offset.x + (hNE - hSE) * offset.y;
    }

    return max(h0, h1);
}
