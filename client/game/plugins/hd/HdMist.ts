/**
 * 117 HD low-lying mist, shared by the WebGL (hd-lighting.glsl) and WebGPU (hd-lighting.wgsl.ts)
 * shaders: fog that pools in ground lower than the surrounding land and drifts in slow banks
 * with the wind.
 *
 * The mist level is the average ground height over a wide area around the player, eased slowly,
 * not the ground under the player: running down into a valley must not lower the mist with you.
 */
const MIST_STRENGTH = 0.8;
/** Drift of the noise field per second (noise units: one unit is about 14 tiles). */
const MIST_WIND = [0.025, 0.012];
/** The level averages a SAMPLES x SAMPLES grid, SPACING tiles apart, centred on the player. */
const SAMPLES = 9;
const SPACING = 6;
/** How quickly the level follows the area's average (per second); slow, so it never jumps. */
const LEVEL_EASE = 0.4;

/** Average ground height (tiles, Y down) of the land around a point, ignoring unloaded ground. */
export function hdMistLevel(x: number, z: number, groundAt: (x: number, z: number) => number): number | undefined {
    let sum = 0, count = 0;
    const half = (SAMPLES - 1) / 2;
    for (let i = 0; i < SAMPLES; i++) {
        for (let j = 0; j < SAMPLES; j++) {
            const height = groundAt(x + (i - half) * SPACING, z + (j - half) * SPACING);
            // Unloaded map squares sample as exactly 0.
            if (height === 0 || !Number.isFinite(height)) continue;
            sum += height;
            count++;
        }
    }
    return count > 0 ? sum / count : undefined;
}

/** Tracks the eased mist level for one renderer and builds its u_hdMist uniform. */
export class HdMist {
    private level?: number;
    private updatedAt = 0;

    /** u_hdMist: mist level (tiles, Y down), strength, wind x, wind z. */
    uniform(x: number, z: number, groundAt: (x: number, z: number) => number, now: number,
        enabled = true): [number, number, number, number] {
        const target = hdMistLevel(x, z, groundAt);
        if (target !== undefined) {
            const dt = Math.min(1, Math.max(0, (now - this.updatedAt) / 1000));
            // Teleports and the first frame snap; walking eases.
            this.level = this.level === undefined || Math.abs(target - this.level) > 8
                ? target : this.level + (target - this.level) * (1 - Math.exp(-dt * LEVEL_EASE));
        }
        this.updatedAt = now;
        return [this.level ?? 0, this.level === undefined || !enabled ? 0 : MIST_STRENGTH, MIST_WIND[0], MIST_WIND[1]];
    }
}
