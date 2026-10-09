// Pure movement math shared with the server; positions are in 128 units per tile.
const RADIUS = 18;
const WALK_SPEED = 128 / 600;
// Unacknowledged input the client may run ahead, and the server's credit cap.
// One game tick: covers internet round trips; a cheat gains at most a tick of steps.
const MAX_PREDICTION_MS = 600;

/**
 * @param {{x: number, y: number}} from
 * @param {number} dx
 * @param {number} dy
 * @param {number} distance
 * @param {(fromX: number, fromY: number, toX: number, toY: number) => boolean} canCross
 */
function moveContinuous(from, dx, dy, distance, canCross) {
    const length = Math.hypot(dx, dy);
    if (!length || !distance) return { ...from };
    const steps = Math.ceil(distance / 8);
    const sx = dx / length * distance / steps;
    const sy = dy / length * distance / steps;
    let { x, y } = from;
    const allowed = (nx, ny) => {
        if (nx < RADIUS || ny < RADIUS || nx >= 16384 * 128 - RADIUS || ny >= 16384 * 128 - RADIUS) return false;
        // Sweep each corner of the footprint, including diagonal wall crossings.
        for (const ox of [-RADIUS, RADIUS]) for (const oy of [-RADIUS, RADIUS]) {
            const ax = Math.floor((x + ox) / 128), ay = Math.floor((y + oy) / 128);
            const bx = Math.floor((nx + ox) / 128), by = Math.floor((ny + oy) / 128);
            if ((ax !== bx || ay !== by) && !canCross(ax, ay, bx, by)) return false;
        }
        return true;
    };
    for (let i = 0; i < steps; i++) {
        if (allowed(x + sx, y + sy)) { x += sx; y += sy; }
        else {
            if (sx && allowed(x + sx, y)) x += sx;
            if (sy && allowed(x, y + sy)) y += sy;
        }
    }
    return { x, y };
}

module.exports = { moveContinuous, WALK_SPEED, RADIUS, MAX_PREDICTION_MS };
