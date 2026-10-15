const test = require('node:test');
const assert = require('node:assert/strict');
const { handleDrakanDodgeRoll } = require('../plugins/quests/bmr/DrakanDodgeRoll.TheBloodMoonRises');

class Location {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
}

function setup(overrides = {}, blocked = () => false) {
  const area = {};
  const moved = [];
  const player = {
    getArea: () => area,
    getLocation: () => ({ getX: () => 2502, getY: () => 7838, getZ: () => 3 }),
    moveTo: (location) => moved.push(location),
  };
  const fight = {
    player, area, phase: 3, special: 'lunges', warning: 'lunge', impactAt: 42,
    lungeDirection: 'north', markedX: 2502, markedY: 7838,
    ...overrides,
  };
  const core = { Location, RegionManager: { blocked } };
  return { area, moved, player, fight, core };
}

function click(f, destination) {
  const event = { player: f.player, destination, handled: false };
  const result = handleDrakanDodgeRoll(event, f.fight, f.core);
  return { event, result };
}

test('final Drakan lunge accepts a 2–5 tile perpendicular roll through blocked intermediate tiles', () => {
  const f = setup({}, (tile) => tile.x === 2504);
  const { event, result } = click(f, { x: 2506, y: 7838, z: 3 });
  assert.equal(result, true);
  assert.equal(event.handled, true);
  assert.deepEqual(f.moved, [new Location(2506, 7838, 3)]);
  assert.equal(f.fight.lungeRolled, true);
});

test('final Drakan roll rejects outside area, inactive cue, and phase-two waves', () => {
  const f = setup();
  f.player.getArea = () => ({});
  assert.equal(click(f, { x: 2506, y: 7838, z: 3 }).result, false);
  f.player.getArea = () => f.area;
  for (const override of [
    { warning: null }, { impactAt: 0 }, { special: 'waves' }, { phase: 2 },
  ]) {
    const inactive = { ...f.fight, ...override };
    assert.equal(handleDrakanDodgeRoll({ player: f.player, destination: { x: 2506, y: 7838, z: 3 } }, inactive, f.core), false);
  }
  assert.deepEqual(f.moved, []);
});

test('final Drakan lunge rejects an obstructed roll destination', () => {
  const f = setup({}, (tile) => tile.x === 2506 && tile.y === 7838);
  const { event, result } = click(f, { x: 2506, y: 7838, z: 3 });
  assert.equal(result, false);
  assert.equal(event.handled, false);
  assert.deepEqual(f.moved, []);
});

test('final Drakan roll rejects parallel, short, oversized, wrong-plane, and outside-arena clicks', () => {
  const f = setup();
  for (const destination of [
    { x: 2502, y: 7840, z: 3 }, // parallel to a north-facing attack
    { x: 2503, y: 7838, z: 3 }, // only one tile
    { x: 2508, y: 7838, z: 3 }, // six tiles
    { x: 2506, y: 7838, z: 2 },
    { x: 2494, y: 7838, z: 3 },
  ]) {
    const { event, result } = click(f, destination);
    assert.equal(result, false);
    assert.equal(event.handled, false);
  }
  assert.deepEqual(f.moved, []);
});

test('final Drakan can roll on the first appearance using the eventual attack axis only once', () => {
  const f = setup({ warning: 'lunge-appearances', lungeCueIndex: 0, lungeIndex: 1, lungeCycles: 0 });
  // The sequence turns from east through south to west, so north/south is safe.
  const { event, result } = click(f, { x: 2502, y: 7841, z: 3 });
  assert.equal(result, true);
  assert.equal(event.handled, true);
  assert.equal(f.fight.lungeRolled, true);
  assert.equal(click(f, { x: 2502, y: 7838, z: 3 }).result, false);
});
