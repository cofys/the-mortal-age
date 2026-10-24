import type { SeqFrameLoader } from "../../rs/model/seq/SeqFrameLoader";
import type { DrawRange } from "../DrawRange";
import type { LocAnimated, LocFrameSoundHandler } from "./LocAnimated";

type AnimationBatch = {
    drawRanges: DrawRange[];
    drawCall?: { offsets: number[] };
};

export type LocAnimationGeometry = {
    drawCall?: AnimationBatch;
    drawCallAlpha?: AnimationBatch;
    drawCallLod?: AnimationBatch;
    drawCallLodAlpha?: AnimationBatch;
};

function applyFrame(batch: AnimationBatch | undefined, index: number, frame: DrawRange | undefined): void {
    if (!batch || index < 0 || !frame) return;
    const range = batch.drawRanges[index];
    if (!range) return;
    // Frames are shared; keep each placement's own bounds and chunk identity.
    range[0] = frame[0]; range[1] = frame[1]; range[2] = frame[2];
    if (batch.drawCall) {
        batch.drawCall.offsets[index] = frame[0];
        (batch.drawCall as { offsets: number[]; numElements: number[] }).numElements[index] = frame[1];
    }
}

/** A pose changes on a client cycle, independently of frame rate and render-pass count. */
export class LocAnimationUpdater {
    private cycle = NaN;
    private locs?: readonly LocAnimated[];
    private geometry?: LocAnimationGeometry;
    private soundsUpdated = false;

    clear(): void {
        this.cycle = NaN;
        this.locs = undefined;
        this.geometry = undefined;
        this.soundsUpdated = false;
    }

    update(locs: readonly LocAnimated[], geometry: LocAnimationGeometry | undefined,
        seqFrameLoader: SeqFrameLoader, cycle: number, onFrameSound?: LocFrameSoundHandler): void {
        const samePose = cycle === this.cycle && locs === this.locs && geometry === this.geometry;
        if (samePose && (!onFrameSound || this.soundsUpdated)) return;
        for (const loc of locs) {
            loc.update(seqFrameLoader, cycle, onFrameSound);
            // A shadow may run before the visible pass, which still needs its frame sounds.
            if (samePose) continue;
            const frame = loc.drawFrame();
            const opaque = loc.anim.frames[frame], alpha = loc.anim.framesAlpha?.[frame];
            applyFrame(geometry?.drawCall, loc.drawRangeIndex, opaque);
            applyFrame(geometry?.drawCallLod, loc.drawRangeLodIndex, opaque);
            applyFrame(geometry?.drawCallAlpha, loc.drawRangeAlphaIndex, alpha);
            applyFrame(geometry?.drawCallLodAlpha, loc.drawRangeLodAlphaIndex, alpha);
        }
        this.soundsUpdated = (samePose && this.soundsUpdated) || !!onFrameSound;
        this.cycle = cycle;
        this.locs = locs;
        this.geometry = geometry;
    }
}
