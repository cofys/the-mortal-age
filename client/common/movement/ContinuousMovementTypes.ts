export interface ContinuousMovementInput {
    seq: number;
    dx: number;
    dy: number;
    rotation: number;
    duration: number;
    running: boolean;
    active: boolean;
}

export interface ContinuousMovementPosition {
    index: number;
    seq: number;
    x: number;
    y: number;
    rotation: number;
    level: number;
    active: boolean;
    moving: boolean;
    running: boolean;
    blocked: boolean;
    snap: boolean;
}
