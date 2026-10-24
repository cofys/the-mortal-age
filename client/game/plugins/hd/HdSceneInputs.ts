import type { HdLightsMap } from "./HdLights";

interface HdInputMap extends HdLightsMap {
    heightMapData?: Int16Array;
    heightMapSize?: number;
    borderSize?: number;
    interactionPlane?: number;
    getLocalTileSpan?(): number;
    locDataChangedListeners?: Set<() => void>;
}

interface HeightView { baseX: number; baseY: number; sizeX: number; sizeY: number }

interface HdInputHost {
    mapManager: { mapSquares?: ReadonlyMap<number, HdInputMap>; worldEntityMapIds?: ReadonlySet<number> };
    sampleHeightAtExactPlane(x: number, z: number, plane: number): number;
    getControlledPlayerWorldViewId?(): number;
    osrsClient: { worldViewManager?: { getWorldView(id: number): HeightView | undefined } };
    instanceActive?: boolean;
    instanceTemplateChunks?: unknown;
}

type MapInputs = {
    seen: number; id: number; order: number; overlay: boolean;
    baseX: number; baseZ: number; span?: number; plane?: number;
    heights?: Int16Array; size?: number; border?: number;
    offsets?: Uint32Array; ids?: Int32Array; rotations?: Uint8Array;
};

/** Terrain samples can read resident squares outside the visible list, including deck overlays. */
export class HdSceneInputs {
    private readonly maps = new Map<HdInputMap, MapInputs>();
    private generation = 0;
    private revision = 0;
    private host?: HdInputHost;
    private plane = -1;
    private environment?: unknown;
    private options?: unknown;
    private instance?: unknown;
    private instanceActive?: boolean;
    private view?: HeightView;
    private viewId?: number;
    private viewX?: number;
    private viewY?: number;
    private viewWidth?: number;
    private viewHeight?: number;
    private readonly invalidate = () => { this.revision++; };
    readonly groundAt = (x: number, z: number): number => this.host!.sampleHeightAtExactPlane(x, z, this.plane);

    update(host: HdInputHost, plane: number, environment: unknown, options: unknown): number {
        const viewId = host.getControlledPlayerWorldViewId?.();
        const view = viewId !== undefined && viewId >= 0 ? host.osrsClient.worldViewManager?.getWorldView(viewId) : undefined;
        if (this.host !== host || this.plane !== plane || this.environment !== environment || this.options !== options ||
            this.instance !== host.instanceTemplateChunks || this.instanceActive !== host.instanceActive ||
            this.viewId !== viewId || this.view !== view || this.viewX !== view?.baseX || this.viewY !== view?.baseY ||
            this.viewWidth !== view?.sizeX || this.viewHeight !== view?.sizeY) this.revision++;
        this.host = host;
        this.plane = plane;
        this.environment = environment;
        this.options = options;
        this.instance = host.instanceTemplateChunks;
        this.instanceActive = host.instanceActive;
        this.viewId = viewId;
        this.view = view;
        this.viewX = view?.baseX;
        this.viewY = view?.baseY;
        this.viewWidth = view?.sizeX;
        this.viewHeight = view?.sizeY;
        const generation = ++this.generation;
        let order = 0;
        for (const [id, map] of host.mapManager.mapSquares ?? []) {
            const previous = this.maps.get(map);
            const baseX = map.getRenderBaseWorldX(), baseZ = map.getRenderBaseWorldY();
            const span = map.getLocalTileSpan?.(), overlay = host.mapManager.worldEntityMapIds?.has(id) ?? false;
            const offsets = map.tileLocOffsetsByLevel?.[plane], ids = map.tileLocIdsByLevel?.[plane];
            const rotations = map.tileLocTypeRotByLevel?.[plane];
            if (!previous || previous.id !== id || previous.order !== order || previous.overlay !== overlay ||
                previous.baseX !== baseX || previous.baseZ !== baseZ || previous.span !== span ||
                previous.plane !== map.interactionPlane || previous.heights !== map.heightMapData ||
                previous.size !== map.heightMapSize || previous.border !== map.borderSize ||
                previous.offsets !== offsets || previous.ids !== ids || previous.rotations !== rotations) {
                if (!previous) map.locDataChangedListeners?.add(this.invalidate);
                this.maps.set(map, { seen: generation, id, order, overlay, baseX, baseZ, span,
                    plane: map.interactionPlane, heights: map.heightMapData, size: map.heightMapSize, border: map.borderSize,
                    offsets, ids, rotations });
                this.revision++;
            } else previous.seen = generation;
            order++;
        }
        for (const [map, input] of this.maps) {
            if (input.seen === generation) continue;
            map.locDataChangedListeners?.delete(this.invalidate);
            this.maps.delete(map);
            this.revision++;
        }
        return this.revision;
    }

    dispose(): void {
        for (const map of this.maps.keys()) map.locDataChangedListeners?.delete(this.invalidate);
        this.maps.clear();
        this.host = undefined;
        this.view = undefined;
        this.instance = undefined;
        this.environment = this.options = undefined;
        this.revision++;
    }
}
