// CitizenTiles unit checks — walkability snap for citizen placement.
// Jon 2026-10-13: Catherby water tiles — citizens must never be placed on
// water/inside walls. Uses a mock RegionManager (no engine needed).
const assert = require("node:assert/strict");

const CitizenTiles = require("./CitizenTiles");

/** Mock RegionManager: blocked set of "x,y" strings. */
function mockRM(blockedSet) {
  return {
    blocked: (loc) => blockedSet.has(`${loc.getX()},${loc.getY()}`),
  };
}

function withRM(rm, fn) {
  CitizenTiles.setRegionManagerProvider(() => rm);
  try {
    fn();
  } finally {
    CitizenTiles.setRegionManagerProvider(() => null);
  }
}

// Walkable tile passes through unchanged.
withRM(mockRM(new Set()), () => {
  assert.equal(CitizenTiles.isBlockedTile(2820, 3440, 0), false);
  assert.deepEqual(CitizenTiles.snapToWalkableTile(2820, 3440, 0), {
    x: 2820,
    y: 3440,
    z: 0,
  });
});

// Blocked center snaps to the nearest walkable ring tile.
withRM(mockRM(new Set(["2848,3427"])), () => {
  assert.equal(CitizenTiles.isBlockedTile(2848, 3427, 0), true);
  const s = CitizenTiles.snapToWalkableTile(2848, 3427, 0);
  const cheby = Math.max(Math.abs(s.x - 2848), Math.abs(s.y - 3427));
  assert.equal(cheby, 1, `expected ring-1 snap, got ${s.x},${s.y}`);
  assert.equal(s.z, 0);
});

// Water pool: center + full ring-1 blocked -> snaps to ring 2.
{
  const blocked = new Set(["100,100"]);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) blocked.add(`${100 + dx},${100 + dy}`);
  withRM(mockRM(blocked), () => {
    const s = CitizenTiles.snapToWalkableTile(100, 100, 0);
    const cheby = Math.max(Math.abs(s.x - 100), Math.abs(s.y - 100));
    assert.equal(cheby, 2, `expected ring-2 snap, got ${s.x},${s.y}`);
  });
}

// No region manager: degrades to pass-through, never throws.
CitizenTiles.setRegionManagerProvider(() => null);
assert.equal(CitizenTiles.isBlockedTile(1, 2, 0), null);
assert.deepEqual(CitizenTiles.snapToWalkableTile(1.6, 2.4, 0), {
  x: 2,
  y: 2,
  z: 0,
});

// Throwing region manager: degrades, never throws.
CitizenTiles.setRegionManagerProvider(() => ({
  blocked: () => {
    throw new Error("boom");
  },
}));
assert.equal(CitizenTiles.isBlockedTile(1, 2, 0), null);
assert.deepEqual(CitizenTiles.snapToWalkableTile(5, 5, 0), { x: 5, y: 5, z: 0 });
// Jon 2026-10-13 (Draynor): open water carries no block flags — the water
// layer must count as blocked, or citizens fish standing in the sea.
/** Mock RegionManager with a water set of "x,y" strings (no block flags). */
function mockRMWater(waterSet) {
  return {
    blocked: () => false,
    isWater: (loc) => waterSet.has(`${loc.getX()},${loc.getY()}`),
  };
}
withRM(mockRMWater(new Set(["3080,3228", "3081,3228"])), () => {
  // Water tile: blocked via the water layer.
  assert.equal(CitizenTiles.isBlockedTile(3080, 3228, 0), true);
  assert.equal(CitizenTiles.isWaterTile(3080, 3228, 0), true);
  // Shore tile: walkable.
  assert.equal(CitizenTiles.isBlockedTile(3085, 3228, 0), false);
  assert.equal(CitizenTiles.isWaterTile(3085, 3228, 0), false);
  // Snap moves off water onto the nearest land (ring 1 here).
  assert.deepEqual(CitizenTiles.snapToWalkableTile(3080, 3228, 0, 12), {
    x: 3079,
    y: 3227,
    z: 0,
  });
});
// No isWater on the provider (old mock): degrades to blocked-only.
withRM(mockRM(new Set(["1,1"])), () => {
  assert.equal(CitizenTiles.isBlockedTile(3080, 3228, 0), false);
  assert.equal(CitizenTiles.isWaterTile(3080, 3228, 0), null);
  assert.equal(CitizenTiles.isBlockedTile(1, 1, 0), true);
});

CitizenTiles.setRegionManagerProvider(() => null);

console.log("CitizenTiles: all checks passed");
