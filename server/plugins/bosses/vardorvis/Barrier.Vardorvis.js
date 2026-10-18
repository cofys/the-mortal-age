/**
 * The tendril barrier round the arena (rsprox 3285): when the first hit lands on Vardorvis the
 * rocks behind the player are sealed and the 13x13 arena's edge (48 tiles) rises. Every edge tile
 * blocks at once (an invisible blocking loc) while its spike rise plays, starting at the
 * south-east corner and running both ways round, 2 client cycles a tile; once risen (a tick, or
 * two for the far side) the Tendril itself stands there. Each side is the same 13 tendrils, short,
 * tall and medium (data barrier.sidePattern). A tick after the kill opens the rocks the tendrils
 * sink (their fall graphic) and the edge is clear again.
 */
const Common = require("./Common.Vardorvis");

/** Every edge tile, with its tendril's variant and its rise delay in client cycles. */
function edgeTiles() {
  const { west, east, south, north, sidePattern, cyclesPerTile } = Common.data.barrier;
  const width = east - west;
  const height = north - south;
  const perimeter = 2 * (width + height);
  const tiles = new Map();
  const add = (x, y, along, index) => {
    const steps = Math.min(along, perimeter - along);
    tiles.set(`${x},${y}`, { x, y, variant: sidePattern[index], delay: steps * cyclesPerTile });
  };
  // Clockwise from the south-east corner (origin): up the east side, along the north, down the west.
  for (let k = 0; k <= height; k++) add(east, south + k, k, k);
  for (let k = 0; k <= width; k++) add(east - k, north, height + k, width - k);
  for (let k = 0; k <= height; k++) add(west, north - k, height + width + k, height - k);
  for (let k = 0; k <= width; k++) add(west + k, south, 2 * height + width + k, k);
  return [...tiles.values()];
}

function raise(session) {
  if (session.barrier) return;
  const { barrier } = Common.data;
  const { player } = session;
  session.barrier = [];
  session.setExit(true);
  for (const id of barrier.riseSounds) Common.sound(player, id);
  for (const edge of edgeTiles()) {
    const tile = [edge.x, edge.y, 0];
    session.barrier.push(session.placeLoc(barrier.blocking, tile));
    player.getPacketSender().sendGraphic(Common.graphic(barrier.riseSpots[edge.variant], { delay: edge.delay }), session.tile(tile));
    const risen = 1 + Math.floor(edge.delay / Common.CYCLES_PER_TICK);
    Common.later(risen, () => {
      if (session.ended || session.barrier == null) return;
      session.placeLoc(barrier.locs[edge.variant], tile);
    });
  }
}

/** The tendrils sink; the edge is walkable again. */
function fall(session) {
  if (!session.barrier || session.ended) return;
  const { barrier } = Common.data;
  const { player } = session;
  session.barrier = null;
  Common.sound(player, barrier.fallSound);
  for (const edge of edgeTiles()) {
    const tile = [edge.x, edge.y, 0];
    session.placeLoc(barrier.cleared, tile);
    player.getPacketSender().sendGraphic(Common.graphic(barrier.fallSpots[edge.variant]), session.tile(tile));
  }
}

/** True for a tile inside the barrier (the arena floor the boss and his attacks stay on). */
function inArena(x, y) {
  const { west, east, south, north } = Common.data.barrier;
  return x > west && x < east && y > south && y < north;
}

module.exports = { raise, fall, inArena, edgeTiles };
