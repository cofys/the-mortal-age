/** Below this (angle units per ms), with no input, the camera has stopped. */
const MIN_VELOCITY = 0.005;

/**
 * Camera rotation easing: the camera's turning speed follows the player's input instead of
 * jumping to it, so a turn speeds up over about `easeIn` ms and slows to a stop over about
 * `easeOut` ms after the player lets go. Each axis is a first-order filter on the speed,
 * v += (input speed - v) * (1 - exp(-dt / tau)), so it eases the same at any frame rate.
 */
export class CameraEasing {
    private yawVelocity = 0;
    private pitchVelocity = 0;

    /**
     * Feeds one frame: how far the player turned the camera this frame. Returns how far it
     * turns with easing instead.
     */
    update(
        yaw: number,
        pitch: number,
        deltaTime: number,
        easeIn: number,
        easeOut: number,
    ): { yaw: number; pitch: number } {
        if (deltaTime <= 0) return { yaw: 0, pitch: 0 };
        this.yawVelocity = ease(this.yawVelocity, yaw / deltaTime, deltaTime, easeIn, easeOut);
        this.pitchVelocity = ease(this.pitchVelocity, pitch / deltaTime, deltaTime, easeIn, easeOut);
        return { yaw: this.yawVelocity * deltaTime, pitch: this.pitchVelocity * deltaTime };
    }

    isTurning(): boolean {
        return this.yawVelocity !== 0 || this.pitchVelocity !== 0;
    }

    stopPitch(): void {
        this.pitchVelocity = 0;
    }

    stop(): void {
        this.yawVelocity = 0;
        this.pitchVelocity = 0;
    }
}

/** One axis: towards `target`, over `easeIn` while speeding up and `easeOut` while slowing. */
function ease(velocity: number, target: number, deltaTime: number, easeIn: number, easeOut: number): number {
    const speedingUp = Math.abs(target) > Math.abs(velocity) && Math.sign(target) !== -Math.sign(velocity);
    const tau = speedingUp ? easeIn : easeOut;
    const next = tau <= 0 ? target : velocity + (target - velocity) * (1 - Math.exp(-deltaTime / tau));
    return target === 0 && Math.abs(next) < MIN_VELOCITY ? 0 : next;
}
