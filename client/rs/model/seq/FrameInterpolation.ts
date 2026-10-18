import type { SeqType } from "../../config/seqtype/SeqType";
import type { Model } from "../Model";
import type { SeqFrame } from "./SeqFrame";
import type { SeqFrameLoader } from "./SeqFrameLoader";

export type SequencePlayback = "movement" | "action" | "object";

/** The controller's next frame, including its loop limit. Actions must not invent a loop. */
export function nextSequenceFrame(
    seq: SeqType,
    frame: number,
    playback: SequencePlayback,
    loopCounter = 0,
): number | undefined {
    const count = seq.frameIds?.length ?? 0;
    if (frame < 0 || frame >= count) return undefined;
    if (frame + 1 < count) return frame + 1;
    const next = count - seq.frameStep;
    const valid = seq.frameStep > 0 && next >= 0 && next < count;
    if (playback === "movement") {
        return valid && !(seq.looping && loopCounter + 1 >= seq.maxLoops) ? next : 0;
    }
    if (!valid || (playback === "action" && loopCounter + 1 >= seq.maxLoops)) return undefined;
    return next;
}

export interface FrameInterpolation {
    next: number | undefined;
    alpha: number;
}

export interface ActorInterpolation {
    base?: FrameInterpolation;
    overlay?: FrameInterpolation;
}

export function sequenceInterpolation(
    seq: SeqType,
    frame: number,
    cycle: number,
    loader: SeqFrameLoader,
    playback: SequencePlayback,
    loopCounter = 0,
): FrameInterpolation | undefined {
    if (seq.isSkeletalSeq() || !seq.frameIds?.length) return undefined;
    const next = nextSequenceFrame(seq, frame, playback, loopCounter);
    return {
        next,
        alpha: next === undefined ? 0
            : Math.max(0, Math.min(1, cycle / Math.max(1, seq.getFrameLength(loader, frame)))),
    };
}

export function interpolationKey(interpolation?: ActorInterpolation): string {
    if (!interpolation) return "";
    const key = (blend?: FrameInterpolation) =>
        blend ? `${blend.next ?? "end"}:${blend.alpha}` : "off";
    return `~${key(interpolation.base)}~${key(interpolation.overlay)}`;
}

export function interpolationFrame(
    seq: SeqType,
    blend: FrameInterpolation | undefined,
    loader: SeqFrameLoader,
): SeqFrame | undefined {
    return blend?.next === undefined ? undefined : loader.load(seq.frameIds[blend.next]);
}

/** A shared keyframe path for both renderers, including independently timed masked layers. */
export function applyInterpolatedFrames(
    model: Model,
    loader: SeqFrameLoader,
    seq: SeqType,
    frame: number,
    interpolation: ActorInterpolation,
    overlay?: SeqType,
    overlayFrame = 0,
): boolean {
    const current = loader.load(seq.frameIds[frame]);
    if (!current) return false;
    const blend = interpolation.base;
    const next = interpolationFrame(seq, blend, loader);
    const other = overlay?.frameIds?.length
        ? loader.load(overlay.frameIds[overlayFrame]) : undefined;
    if (overlay && other && seq.masks?.length) {
        model.animateInterleavedFramesInterpolated(
            current, next, blend?.alpha ?? 0, !!seq.op14,
            other, interpolationFrame(overlay, interpolation.overlay, loader),
            interpolation.overlay?.alpha ?? 0, !!overlay.op14, seq.masks,
        );
    } else if (blend) {
        model.animateInterpolated(current, next, blend.alpha, !!seq.op14);
    } else {
        model.animate(current, undefined, !!seq.op14);
    }
    return true;
}
