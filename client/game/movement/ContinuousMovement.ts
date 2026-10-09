import { moveContinuous, WALK_SPEED, MAX_PREDICTION_MS } from "../../../server/plugins/movement/ContinuousMotion.js";
import type { ContinuousMovementInput, ContinuousMovementPosition } from "../../common/movement/ContinuousMovementTypes";
import { CollisionFlag } from "../../common/CollisionFlag";
import { deltaToDirection } from "../../common/Direction";
import type { PlayerEcs } from "../ecs/PlayerEcs";
import type { ResolveTilePlaneFn } from "../scene/PlaneResolver";

const MASKS = [CollisionFlag.BLOCK_SOUTH_WEST, CollisionFlag.BLOCK_SOUTH,
    CollisionFlag.BLOCK_SOUTH_EAST, CollisionFlag.BLOCK_WEST, CollisionFlag.BLOCK_EAST,
    CollisionFlag.BLOCK_NORTH_WEST, CollisionFlag.BLOCK_NORTH, CollisionFlag.BLOCK_NORTH_EAST];

type LocalMovement = {
    serverId: number; x: number; y: number; level: number; correctionX: number; correctionY: number;
    pending: ContinuousMovementInput[]; blocked: boolean; ack: number;
};

export class ContinuousMovement {
    private seq = 0;
    private clockAt = performance.now();
    private credit = 20;
    private local?: LocalMovement;
    private input = { dx: 0, dy: 0, running: false, rotation: 0 };
    private remote = new Map<number, { position: ContinuousMovementPosition; fromX: number; fromY: number; elapsed: number }>();

    constructor(private readonly ecs: PlayerEcs, private readonly getLocalId: () => number,
        private readonly send: (input: ContinuousMovementInput) => void,
        private readonly flags: (level: number, x: number, y: number) => number,
        private readonly resolvePlane?: ResolveTilePlaneFn) {}

    setInput(dx: number, dy: number, running: boolean, rotation: number): void {
        const serverId = this.getLocalId(), index = this.ecs.getIndexForServerId(serverId);
        if (index === undefined || !this.ecs.canContinuousMove(index) || (!this.local && !Math.hypot(dx, dy))) return;
        if (!this.local || this.local.serverId !== serverId) {
            this.clockAt = performance.now();
            this.credit = 20;
            this.local = { serverId, x: this.ecs.getX(index), y: this.ecs.getY(index), level: this.ecs.getLevel(index),
                correctionX: 0, correctionY: 0, pending: [], blocked: false, ack: -1 };
        }
        const length = Math.hypot(dx, dy);
        const next = { dx: length ? Math.round(dx / length * 32767) : 0,
            dy: length ? Math.round(dy / length * 32767) : 0, running, rotation: rotation & 2047 };
        const turned = next.rotation !== this.input.rotation;
        const stopped = !(next.dx || next.dy) && !!(this.input.dx || this.input.dy);
        this.input = next;
        if (stopped || (turned && !(next.dx || next.dy))) {
            this.command(0, true);
            this.applyLocal();
        }
    }

    stop(deactivate = false): void {
        const local = this.local;
        if (!local || (!deactivate && !(this.input.dx || this.input.dy))) return;
        this.input.dx = this.input.dy = 0;
        this.command(0, !deactivate);
        this.applyLocal();
        if (deactivate) {
            const index = this.ecs.getIndexForServerId(local.serverId);
            if (index !== undefined) this.ecs.clearContinuousPosition(index);
            this.local = undefined;
        }
    }

    remove(serverId: number): void {
        this.remote.delete(serverId);
        if (this.local?.serverId === serverId) this.reset();
    }

    reset(): void {
        if (this.local) {
            const index = this.ecs.getIndexForServerId(this.local.serverId);
            if (index !== undefined) this.ecs.clearContinuousPosition(index);
        }
        this.local = undefined;
        this.input.dx = this.input.dy = 0;
        for (const serverId of this.remote.keys()) {
            const index = this.ecs.getIndexForServerId(serverId);
            if (index !== undefined) this.ecs.clearContinuousPosition(index);
        }
        this.remote.clear();
    }

    private move(position: { x: number; y: number }, input: ContinuousMovementInput, level: number) {
        return moveContinuous(position, input.dx, input.dy, WALK_SPEED * input.duration * (input.running ? 2 : 1),
            (ax, ay, bx, by) => {
                const dx = bx - ax, dy = by - ay, direction = deltaToDirection(dx, dy);
                if (direction === undefined) return false;
                const plane = this.resolvePlane?.(bx, by, level) ?? level;
                return !(this.flags(plane, bx, by) & MASKS[direction]) &&
                    !(dx && dy && ((this.flags(plane, bx, ay) & (dx < 0 ? CollisionFlag.BLOCK_WEST : CollisionFlag.BLOCK_EAST)) ||
                        (this.flags(plane, ax, by) & (dy < 0 ? CollisionFlag.BLOCK_SOUTH : CollisionFlag.BLOCK_NORTH))));
            });
    }

    private command(duration: number, active: boolean): void {
        const local = this.local;
        if (!local) return;
        const command = { ...this.input, duration, active, seq: ++this.seq };
        local.pending.push(command);
        if (duration && !local.blocked && local.pending.length <= MAX_PREDICTION_MS / 20) {
            Object.assign(local, this.move(local, command, local.level));
        }
        this.send(command);
    }

    private applyLocal(): void {
        const local = this.local;
        if (!local) return;
        const index = this.ecs.getIndexForServerId(local.serverId);
        if (index === undefined) return;
        const length = Math.hypot(this.input.dx, this.input.dy) || 1;
        this.ecs.setLevel(index, this.resolvePlane?.(Math.floor(local.x / 128), Math.floor(local.y / 128), local.level) ?? local.level);
        this.ecs.setContinuousPosition(index, local.x + local.correctionX, local.y + local.correctionY,
            this.input.dx / length, this.input.dy / length, this.input.running,
            !local.blocked && !!(this.input.dx || this.input.dy) && local.pending.length <= MAX_PREDICTION_MS / 20, this.input.rotation);
    }

    tick(): void {
        const now = performance.now();
        this.credit = Math.min(MAX_PREDICTION_MS, this.credit + Math.max(0, now - this.clockAt));
        this.clockAt = now;
        const local = this.local;
        if (local) {
            const index = this.ecs.getIndexForServerId(local.serverId);
            if (index === undefined) this.reset();
            else if (!this.ecs.canContinuousMove(index)) this.stop(true);
            else {
                // Client-cycle catch-up can run many ticks at one wall-clock instant.
                // Predict only real elapsed time, with the same bound as the server.
                if ((this.input.dx || this.input.dy) && this.credit >= 20 &&
                    local.pending.length < MAX_PREDICTION_MS / 20) {
                    this.credit -= 20;
                    this.command(20, true);
                }
                local.correctionX *= 0.75;
                local.correctionY *= 0.75;
                this.applyLocal();
            }
        }
        for (const [serverId, remote] of this.remote) {
            const index = this.ecs.getIndexForServerId(serverId);
            if (index === undefined) continue;
            if (!this.ecs.canContinuousMove(index)) { this.remote.delete(serverId); continue; }
            remote.elapsed = Math.min(100, remote.elapsed + 20);
            const t = remote.elapsed / 100, position = remote.position;
            const dx = position.x - remote.fromX, dy = position.y - remote.fromY;
            const length = Math.hypot(dx, dy) || 1;
            const current = { x: this.ecs.getX(index), y: this.ecs.getY(index) };
            const targetX = remote.fromX + dx * t, targetY = remote.fromY + dy * t;
            const draw = this.move(current, { dx: targetX - current.x, dy: targetY - current.y,
                duration: Math.hypot(targetX - current.x, targetY - current.y) / WALK_SPEED,
                active: true, running: false, rotation: position.rotation, seq: position.seq }, position.level);
            this.ecs.setLevel(index, this.resolvePlane?.(Math.floor(draw.x / 128), Math.floor(draw.y / 128), position.level) ?? position.level);
            this.ecs.setContinuousPosition(index, draw.x, draw.y,
                dx / length, dy / length, position.running,
                position.moving || (t < 1 && length > 1), position.rotation);
        }
    }

    receive(position: ContinuousMovementPosition): void {
        if (position.index !== this.getLocalId()) {
            const index = this.ecs.getIndexForServerId(position.index);
            if (!position.active) {
                this.remote.delete(position.index);
                if (index !== undefined) this.release(index, position);
            } else {
                const previous = this.remote.get(position.index);
                if (previous && position.seq < previous.position.seq) return;
                this.remote.set(position.index, { position, fromX: index === undefined ? position.x : this.ecs.getX(index),
                    fromY: index === undefined ? position.y : this.ecs.getY(index), elapsed: 0 });
                if (index !== undefined) this.ecs.setContinuousPosition(index, this.ecs.getX(index), this.ecs.getY(index),
                    0, 0, position.running, position.moving, position.rotation);
            }
            return;
        }
        const local = this.local, index = this.ecs.getIndexForServerId(position.index);
        if (index === undefined || (local && position.seq < local.ack)) return;
        if (position.snap) {
            this.local = undefined;
            this.input.dx = this.input.dy = 0;
            this.release(index, position);
            return;
        }
        if (!local) { if (!position.active) this.release(index, position); return; }
        local.ack = position.seq;
        local.pending = local.pending.filter(command => command.seq > position.seq);
        if (!position.active && !position.blocked && !local.pending.some(command => command.active)) {
            this.local = undefined;
            this.release(index, position);
            return;
        }
        const drawX = local.x + local.correctionX, drawY = local.y + local.correctionY;
        let target = { x: position.x, y: position.y };
        local.level = position.level;
        local.blocked = position.blocked;
        if (!position.blocked) for (const command of local.pending.slice(0, MAX_PREDICTION_MS / 20)) {
            target = this.move(target, command, position.level);
        }
        local.x = target.x;
        local.y = target.y;
        local.correctionX = drawX - target.x;
        local.correctionY = drawY - target.y;
        if (Math.hypot(local.correctionX, local.correctionY) > 128 || position.blocked) {
            local.correctionX = local.correctionY = 0;
        }
        this.applyLocal();
    }

    private release(index: number, position: ContinuousMovementPosition): void {
        this.ecs.clearContinuousPosition(index);
        this.ecs.clearServerQueue(index);
        if (position.snap || Math.hypot(this.ecs.getX(index) - position.x, this.ecs.getY(index) - position.y) > 128) {
            this.ecs.teleport(index, Math.floor(position.x / 128), Math.floor(position.y / 128), position.level);
        } else {
            // Keep the real stop position. Tile routes start here rather than
            // granting a free half-tile jump every time the camera mode changes.
            this.ecs.setContinuousPosition(index, position.x, position.y, 0, 0, false, false, position.rotation);
            this.ecs.clearContinuousPosition(index);
        }
    }
}
