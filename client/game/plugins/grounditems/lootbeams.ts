import {
    JAGEX_LUMINANCE_MAX,
    type ClientSpotAnim,
    packHsl,
    registerClientSpotAnim,
    rgbToHsl,
} from "../../../render/gfx/clientGraphics";
import type { LootbeamStyle } from "./GroundItemsConfig";

/** Plays and removes looping graphics on tiles (the renderer's world graphics). */
export type LootbeamHost = {
    spawn(spotId: number, tile: { x: number; y: number; level: number }): number | undefined;
    kill(id: number): void;
};

/** Model lighting as the spot anim path takes it (it adds 64 and 850 to these). */
const GFX_AMBIENT_BASE = 64;
const GFX_CONTRAST_BASE = 850;

const unpackHue = (hsl: number) => (hsl >> 10) & 63;
const unpackSaturation = (hsl: number) => (hsl >> 7) & 7;
const unpackLuminance = (hsl: number) => hsl & 127;

/** RuneLite's Lootbeam.Style: model, animation, lighting and recolours from the beam colour. */
export function lootbeamSpotAnim(style: LootbeamStyle, argb: number): ClientSpotAnim {
    const hsl = rgbToHsl(argb & 0xffffff, 1);
    if (style === "LIGHT") {
        return {
            modelId: 5809,
            sequenceId: 3101,
            recolorFrom: [6371],
            recolorTo: [hsl],
            ambient: 64 - GFX_AMBIENT_BASE,
            contrast: 768 - GFX_CONTRAST_BASE,
        };
    }
    const hue = unpackHue(hsl);
    const sat = unpackSaturation(hsl);
    const lum = unpackLuminance(hsl);
    return {
        modelId: 43330,
        sequenceId: 9260,
        recolorFrom: [26432, 26584],
        recolorTo: [
            packHsl(hue, sat > 2 ? sat - 1 : sat, lum),
            packHsl(hue, sat, Math.min(lum + 24, JAGEX_LUMINANCE_MAX)),
        ],
        ambient: 139 - GFX_AMBIENT_BASE,
        contrast: 2643 - GFX_CONTRAST_BASE,
    };
}

type Beam = { tile: { x: number; y: number; level: number }; color: number; style: LootbeamStyle; spotId: number; id?: number };

/** The loot beams on tiles (RuneLite's lootbeams map of Lootbeam objects). */
export class Lootbeams {
    private readonly beams = new Map<string, Beam>();
    private host?: LootbeamHost;

    /** Beams draw through this host; a new host (the renderer changed) gets every beam again. */
    setHost(host: LootbeamHost | undefined): void {
        if (host === this.host) return;
        for (const beam of this.beams.values()) {
            if (beam.id !== undefined) this.host?.kill(beam.id);
            beam.id = host?.spawn(beam.spotId, beam.tile);
        }
        this.host = host;
    }

    /** addLootbeam: a beam on the tile, recoloured or restyled when it is already there. */
    set(key: string, tile: { x: number; y: number; level: number }, color: number, style: LootbeamStyle): void {
        const existing = this.beams.get(key);
        if (existing && existing.color === color && existing.style === style) return;
        if (existing?.id !== undefined) this.host?.kill(existing.id);
        const spotId = registerClientSpotAnim(lootbeamSpotAnim(style, color));
        this.beams.set(key, { tile: { ...tile }, color, style, spotId, id: this.host?.spawn(spotId, tile) });
    }

    remove(key: string): void {
        const beam = this.beams.get(key);
        if (!beam) return;
        if (beam.id !== undefined) this.host?.kill(beam.id);
        this.beams.delete(key);
    }

    clear(): void {
        for (const key of [...this.beams.keys()]) this.remove(key);
    }

    keys(): IterableIterator<string> {
        return this.beams.keys();
    }

    get(key: string): { color: number; style: LootbeamStyle } | undefined {
        const beam = this.beams.get(key);
        return beam && { color: beam.color, style: beam.style };
    }
}
