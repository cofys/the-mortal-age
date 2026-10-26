import JSZip from "jszip";
import { CollisionMap } from "./CollisionMap";
import { packRegionPosition, SplitFlagMap } from "./SplitFlagMap";

/** SplitFlagMap.fromResources: the collision map zip, one "<regionX>_<regionY>" entry per region. */
export async function loadCollisionMap(zipBytes: ArrayBuffer | Uint8Array): Promise<CollisionMap> {
    const zip = await JSZip.loadAsync(zipBytes);
    const regions = new Map<number, Uint8Array>();
    const files = Object.values(zip.files).filter((file) => !file.dir);
    await Promise.all(files.map(async (file) => {
        const [x, y] = file.name.split("_").map((n) => Number.parseInt(n, 10));
        if (Number.isFinite(x) && Number.isFinite(y)) regions.set(packRegionPosition(x, y), await file.async("uint8array"));
    }));
    return new CollisionMap(new SplitFlagMap(regions));
}
