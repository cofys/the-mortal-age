const NORMAL_TIERS = [
  { interval: 3, shots: 6, styles: ["magic", "ranged"], flight: 5 },
  { interval: 2, shots: 8, styles: ["magic", "ranged"], flight: 5 },
  { interval: 2, shots: 8, styles: ["magic", "ranged", "melee"], flight: 4 },
  { interval: 1, shots: 12, styles: ["magic", "ranged"], flight: 3 },
  { interval: 1, shots: 10, styles: ["magic", "ranged", "melee"], flight: 3 },
  { interval: 1, shots: 10, styles: ["magic", "ranged", "melee"], flight: 2 },
  { interval: 1, shots: 10, styles: ["magic", "ranged", "melee"], flight: 1 },
].map((tier, index) => ({ ...tier, recoveryTicks: index >= 3 ? 6 : 5 }));
// Recovery is additional to the regular attack interval: one-tick normal
// volleys leave seven ticks between their last shot and the next first shot.
// Awakened is inaccessible; retain its previous provisional schedule.
const AWAKENED_TIERS = NORMAL_TIERS.map((tier, index) => ({
  ...tier, shots: index >= 3 ? 12 : tier.shots, recoveryTicks: 5,
}));
const volley = (tier, awakened = false) => (awakened ? AWAKENED_TIERS : NORMAL_TIERS)[Math.max(0, Math.min(6, tier))];
const resetTier = stuns => Math.min(6, Math.max(1, stuns));
const key = ([x, y]) => `${x},${y}`;
const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const inAura = (centre, tile, awakened) => distance(centre, tile) <= (awakened ? 3 : 2);

function facing(centre, tile) {
  const dx = tile[0] - centre[0], dy = tile[1] - centre[1];
  return Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
}
function behind(centre, face, tile) {
  const dx = tile[0] - centre[0], dy = tile[1] - centre[1];
  return dx * face[0] + dy * face[1] <= -4 && Math.abs(dx * face[1] - dy * face[0]) <= 4;
}
/** Tile centres on a ray, without its origin or endpoint. */
function ray(from, to) {
  let [x, y] = from;
  const [tx, ty] = to, dx = Math.abs(tx - x), dy = Math.abs(ty - y);
  const sx = x < tx ? 1 : -1, sy = y < ty ? 1 : -1;
  let error = dx - dy;
  const out = [];
  while (x !== tx || y !== ty) {
    const e = error * 2;
    if (e > -dy) { error -= dy; x += sx; }
    if (e < dx) { error += dx; y += sy; }
    if (x !== tx || y !== ty) out.push([x, y]);
  }
  return out;
}
const covered = (from, to, blockers) => ray(from, to).some(tile => blockers.has(key(tile)));
module.exports = { volley, resetTier, key, distance, inAura, facing, behind, ray, covered };
