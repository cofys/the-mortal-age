// Run after `yarn build`: node --test tests/bot-climbing.test.cjs
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const path = require('node:path');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { findStairs } = require('../plugins/bots/brain/Climbing');

before(async () => {
    await CachePipeline.initialize(path.resolve(__dirname, '..'));
    RegionManager.init();
});

const at = (object) => object && [object.getId(), object.getLocation().getX(), object.getLocation().getY()];

test('bots go up to Lumbridge castle bank by the staircase, not the tower ladder to a separate room', () => {
    // From the castle's east courtyard the tower ladder (3229,3224) is nearer, but its
    // top room does not reach the bank floor.
    const bank = { x: 3208, y: 3220, z: 2 };
    assert.deepEqual(at(findStairs({ x: 3228, y: 3224, z: 0 }, bank, 1, 0)), [56230, 3204, 3229]);
    assert.deepEqual(at(findStairs({ x: 3205, y: 3228, z: 1 }, bank, 1, 0)), [16672, 3204, 3229]);
});

test('a bot stranded in a tower top room climbs back down its ladder', () => {
    assert.deepEqual(at(findStairs({ x: 3228, y: 3224, z: 2 }, { x: 3222, y: 3218, z: 0 }, -1, 0)), [16679, 3229, 3224]);
});

test('from the bank floor down to a far mine: the bank room\'s own staircase', () => {
    const stairs = findStairs({ x: 3208, y: 3220, z: 2 }, { x: 3230, y: 3150, z: 0 }, -1, 0);
    assert.equal(stairs?.getId(), 56231);
});

test('from a castle upper floor the way down is the castle\'s own stairs, never stairs near a far goal', () => {
    // Varrock bots that banked at Lumbridge castle chose Varrock's first-floor stairs (3205,3396)
    // as the way down from the castle's middle floor, and walked at them forever.
    const down = findStairs({ x: 3206, y: 3229, z: 1 }, { x: 3212, y: 3424, z: 0 }, -1, 0);
    assert.ok(down, 'found a way down');
    const at = down.getLocation();
    assert.ok(Math.abs(at.getX() - 3206) <= 10 && Math.abs(at.getY() - 3229) <= 30, `castle stairs, got ${at.getX()},${at.getY()}`);
});
