// Interact Highlight on ground items (RuneLite's "Items" section): hover, Use/Cast targets and
// the item clicked. The outline is the stack's ground model, placed as GroundItemMeshBuilder
// draws it: the tile's centre, at the ground height there.
import { ClientState } from "../../../game/ClientState";
import { sampleBridgeHeightForWorldTile } from "../../../game/scene/BridgeHeightSampler";
import { BridgePlaneStrategy, resolveGroundItemStackPlane } from "../../../game/scene/PlaneResolver";
import { MenuTargetType } from "../../../rs/MenuEntry";
import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import type { ItemHighlightTarget } from "../constants";
import type { WebGLOsrsRendererHost } from "../hostInterface";

function findStack(host: WebGLOsrsRendererHost, itemId: number, tileX: number, tileY: number, plane: number) {
    return host.osrsClient.groundItems
        .getStacksAt(tileX, tileY, plane)
        .find((stack) => (stack.itemId | 0) === (itemId | 0));
}

export function resolveItemHighlightTargetFromEntry(
    host: WebGLOsrsRendererHost,
    entry: Pick<SimpleMenuEntry, "targetType" | "targetId" | "mapX" | "mapY"> | undefined,
    fallbackTile?: { tileX: number; tileY: number; plane?: number },
): ItemHighlightTarget | undefined {
    if (!entry || entry.targetType !== MenuTargetType.OBJ) return undefined;
    if (typeof entry.targetId !== "number") return undefined;

    let tileX: number;
    let tileY: number;
    if (typeof entry.mapX === "number" && typeof entry.mapY === "number") {
        tileX = ((ClientState.baseX | 0) + (entry.mapX | 0)) | 0;
        tileY = ((ClientState.baseY | 0) + (entry.mapY | 0)) | 0;
    } else if (fallbackTile) {
        tileX = fallbackTile.tileX | 0;
        tileY = fallbackTile.tileY | 0;
    } else {
        return undefined;
    }

    // Ground items stay indexed by the raw client plane, as the menu built them.
    const plane = resolveGroundItemStackPlane(host.getPlayerRawPlane() | 0);
    const stack = findStack(host, entry.targetId, tileX, tileY, plane);
    if (!stack) return undefined;
    return {
        kind: "item",
        itemId: stack.itemId | 0,
        quantity: stack.quantity | 0,
        tileX,
        tileY,
        plane: stack.tile.level | 0,
    };
}

/** False once the stack is picked up, despawns or the player changes plane. */
export function isItemHighlightTargetStillPresent(
    host: WebGLOsrsRendererHost,
    target: ItemHighlightTarget,
): boolean {
    const plane = resolveGroundItemStackPlane(host.getPlayerRawPlane() | 0);
    if ((plane | 0) !== (target.plane | 0)) return false;
    const stack = findStack(host, target.itemId, target.tileX, target.tileY, plane);
    if (!stack) return false;
    target.quantity = stack.quantity | 0;
    return true;
}

export function buildItemModelHighlightTriangles(
    host: WebGLOsrsRendererHost,
    target: ItemHighlightTarget,
): ReadonlyArray<readonly [number, number, number]> | undefined {
    const model = host.osrsClient.objModelLoader?.getModel(target.itemId | 0, target.quantity | 0);
    if (!model || !model.verticesX || !model.verticesY || !model.verticesZ) return undefined;

    const centerX = (target.tileX << 7) + 64;
    const centerZ = (target.tileY << 7) + 64;
    const baseY = sampleBridgeHeightForWorldTile(
        host.mapManager,
        centerX / 128.0,
        centerZ / 128.0,
        target.plane | 0,
        BridgePlaneStrategy.RENDER,
    ).height;
    return host.buildModelTrianglePoints(model, (i) => ({
        x: (centerX + model.verticesX[i]) / 128.0,
        y: baseY + model.verticesY[i] / 128.0,
        z: (centerZ + model.verticesZ[i]) / 128.0,
    }));
}
