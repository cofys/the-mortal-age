import { LocModelType } from "../config/loctype/LocModelType";

export type WallDecorationShift = {
    x: number;
    y: number;
};

const CARDINAL_DISPLACEMENT_X = [1, 0, -1, 0] as const;
const CARDINAL_DISPLACEMENT_Y = [0, -1, 0, 1] as const;
const DIAGONAL_DISPLACEMENT_X = [1, -1, -1, 1] as const;
const DIAGONAL_DISPLACEMENT_Y = [-1, -1, 1, 1] as const;

function isDiagonalDecoration(type: LocModelType): boolean {
    return (
        type === LocModelType.WALL_DECORATION_DIAGONAL_OUTSIDE ||
        type === LocModelType.WALL_DECORATION_DIAGONAL_INSIDE ||
        type === LocModelType.WALL_DECORATION_DIAGONAL_DOUBLE
    );
}

export function wallDecorationOffset(
    decorationType: LocModelType,
    rotation: number,
    wallDisplacement: number,
): WallDecorationShift {
    const rot = rotation & 3;

    if (decorationType === LocModelType.WALL_DECORATION_OUTSIDE) {
        return {
            x: wallDisplacement * CARDINAL_DISPLACEMENT_X[rot],
            y: wallDisplacement * CARDINAL_DISPLACEMENT_Y[rot],
        };
    }

    if (
        decorationType === LocModelType.WALL_DECORATION_DIAGONAL_OUTSIDE ||
        decorationType === LocModelType.WALL_DECORATION_DIAGONAL_DOUBLE
    ) {
        const displacement = (wallDisplacement / 2) | 0;
        return {
            x: displacement * DIAGONAL_DISPLACEMENT_X[rot],
            y: displacement * DIAGONAL_DISPLACEMENT_Y[rot],
        };
    }

    return { x: 0, y: 0 };
}

/**
 * The client nudges straight wall decorations one scene unit toward the
 * interior after applying their authored wall displacement.
 */
export function wallDecorationNudge(
    decorationType: LocModelType,
    rotation: number,
): WallDecorationShift {
    if (
        decorationType !== LocModelType.WALL_DECORATION_INSIDE &&
        decorationType !== LocModelType.WALL_DECORATION_OUTSIDE
    ) {
        return { x: 0, y: 0 };
    }

    const rot = rotation & 3;
    return {
        x: CARDINAL_DISPLACEMENT_X[rot],
        y: CARDINAL_DISPLACEMENT_Y[rot],
    };
}

/**
 * Returns the render-time correction for decorations on diagonal host walls.
 *
 * Shape-9 diagonal walls are scene locs. Callers resolve the host and pass its type,
 * rotation, and decorDisplacement here.
 */
export function embeddedWallDecorationShift(
    decorationType: LocModelType,
    decorationRotation: number,
    wallType: LocModelType,
    wallRotation: number,
    wallDisplacement: number,
): WallDecorationShift {
    const decRot = decorationRotation & 3;
    const wallRot = wallRotation & 3;

    if (!isDiagonalDecoration(decorationType) || wallType !== LocModelType.WALL_DIAGONAL) {
        return { x: 0, y: 0 };
    }

    if (wallRot !== ((decRot + 2) & 3)) {
        return { x: 0, y: 0 };
    }

    return wallDecorationOffset(
        LocModelType.WALL_DECORATION_DIAGONAL_OUTSIDE,
        wallRot,
        wallDisplacement,
    );
}
