import type { SdMapData } from "./loader/SdMapData";
import { ACTOR_VERTEX_STRIDE } from "./buffer/ActorNormals";

type GeometrySource = { data: Uint8Array | Int32Array; stride: number; index: boolean };

/** Geometry only: textures and publication still finish together after these copies complete. */
export function mapGeometrySources(data: Partial<SdMapData>, npcs = false): GeometrySource[] {
    const sources: GeometrySource[] = [];
    const add = (vertices: Uint8Array | undefined, indices: Int32Array | undefined, stride = 12) => {
        if (!vertices?.byteLength || !indices?.byteLength) return;
        sources.push({ data: vertices, stride, index: false }, { data: indices, stride: 4, index: true });
    };
    add(data.vertices, data.indices);
    add(data.doorVertices, data.doorIndices);
    add(data.loc?.vertices, data.loc?.indices);
    if (npcs) add(data.npcVertices, data.npcIndices, ACTOR_VERTEX_STRIDE);
    return sources;
}

export class MapGeometryUpload<T> {
    static readonly CHUNK_BYTES = 256 * 1024;
    static readonly FRAME_BYTES = 2 * 1024 * 1024;
    private sourceIndex = 0;
    private offset = 0;
    private readonly buffers = new Map<ArrayBufferView, T>();

    constructor(
        private readonly sources: GeometrySource[],
        private readonly create: (source: GeometrySource) => T,
        private readonly write: (buffer: T, bytes: Uint8Array, offset: number) => void,
        private readonly release: (buffer: T) => void,
    ) {}

    step(): boolean {
        const start = performance.now();
        let copied = 0;
        while (this.sourceIndex < this.sources.length) {
            const remaining = Math.floor((MapGeometryUpload.FRAME_BYTES - copied) / 4) * 4;
            if (remaining === 0) break;
            const source = this.sources[this.sourceIndex];
            let buffer = this.buffers.get(source.data);
            if (!buffer) {
                buffer = this.create(source);
                this.buffers.set(source.data, buffer);
            }
            const size = Math.min(MapGeometryUpload.CHUNK_BYTES, remaining, source.data.byteLength - this.offset);
            this.write(buffer, new Uint8Array(source.data.buffer, source.data.byteOffset + this.offset, size), this.offset);
            this.offset += size;
            copied += size;
            if (this.offset === source.data.byteLength) {
                this.sourceIndex++;
                this.offset = 0;
            }
            if (copied >= MapGeometryUpload.FRAME_BYTES || performance.now() - start >= 2) break;
        }
        return this.sourceIndex === this.sources.length;
    }

    take(): Map<ArrayBufferView, T> {
        if (this.sourceIndex !== this.sources.length) throw new Error("Map geometry upload is incomplete");
        const result = new Map(this.buffers);
        this.buffers.clear();
        this.sources.length = 0;
        return result;
    }

    dispose(): void {
        for (const buffer of this.buffers.values()) this.release(buffer);
        this.buffers.clear();
        this.sources.length = 0;
    }
}
