import { Location } from '../model/Location';

export class Region {
    private regionId: number;
    private terrainFile: number;
    private objectFile: number;
    public clips?: Uint32Array;
    public roofTiles?: Uint8Array;
    public waterTiles?: Uint8Array;
    public static readonly TILE_FLAG_UNDER_ROOF = 0x4;
    private loaded: boolean;

    constructor(regionId: number, terrainFile: number, objectFile: number) {
        this.regionId = regionId;
        this.terrainFile = terrainFile;
        this.objectFile = objectFile;
    }
    public getRegionId(): number {
        return this.regionId;
    }

    public getTerrainFile(): number {
        return this.terrainFile;
    }

    public getObjectFile(): number {
        return this.objectFile;
    }

    /** Returns -1 outside this region; masking coordinates would alias adjacent tiles. */
    private clipIndex(x: number, y: number, height: number): number {
        const localX = x - (this.regionId >> 8) * 64;
        const localY = y - (this.regionId & 0xff) * 64;
        if (!Number.isInteger(localX) || !Number.isInteger(localY) ||
            localX < 0 || localX >= 64 || localY < 0 || localY >= 64) return -1;
        if (height < 0 || height >= 4) height = 0;
        if (!Number.isInteger(height)) return -1;
        return (height << 12) | (localX << 6) | localY;
    }

    public getClip(x: number, y: number, height: number): number {
        const index = this.clipIndex(x, y, height);
        // Preserve the signed 32-bit masks returned by the former bitwise grid.
        return index < 0 ? 0 : (this.clips?.[index] ?? 0) | 0;
    }

    public addClip(x: number, y: number, height: number, shift: number): void {
        const index = this.clipIndex(x, y, height);
        if (index < 0) return;
        const clips = this.clips ??= new Uint32Array(4 * 64 * 64);
        clips[index] |= shift;
    }

    public removeClip(x: number, y: number, height: number, shift: number): void {
        const index = this.clipIndex(x, y, height);
        if (index < 0 || !this.clips) return;
        this.clips[index] &= ~shift;
    }

    public isUnderRoof(x: number, y: number, plane: number): boolean {
        if (!Number.isInteger(plane) || plane < 0 || plane > 3) return false;
        const index = (plane << 12) | ((x & 63) << 6) | (y & 63);
        return ((this.roofTiles?.[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
    }

    public isWater(x: number, y: number, plane: number): boolean {
        if (plane !== 0) return false;
        const index = ((x & 63) << 6) | (y & 63);
        return ((this.waterTiles?.[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
    }

    public getLocalPosition(position: Location): number[] {
        let absX: number = position.getX();
        let absY: number = position.getY();
        let regionAbsX: number = (this.regionId >> 8) * 64;
        let regionAbsY: number = (this.regionId & 0xff) * 64;
        let localX: number = absX - regionAbsX;
        let localY: number = absY - regionAbsY;
        return [localX, localY];
    }

    public isLoaded(): boolean {
        return this.loaded;
    }

    public setLoaded(loaded: boolean) {
        this.loaded = loaded;
    }

}
