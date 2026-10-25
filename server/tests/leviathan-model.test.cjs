const assert = require('node:assert/strict');
const { test } = require('node:test');
const model = () => require('../plugins/bosses/leviathan/Model.Leviathan');

test('Leviathan has the seven documented volley speeds, styles and late flight times', () => {
    const M = model();
    assert.deepEqual(Array.from({ length: 7 }, (_, n) => M.volley(n).interval), [3, 2, 2, 1, 1, 1, 1]);
    assert.deepEqual(M.volley(0).styles, ['magic', 'ranged']);
    assert.deepEqual(M.volley(2).styles, ['magic', 'ranged', 'melee']);
    assert.deepEqual(M.volley(3).styles, ['magic', 'ranged']);
    assert.equal(M.volley(5).flight, 2);
    assert.equal(M.volley(6).flight, 1);
    assert.deepEqual(M.volley(99), M.volley(6));
    assert.equal(M.resetTier(1), 1);
    assert.equal(M.resetTier(2), 2);
    assert.equal(M.resetTier(99), 6);
});

test('the pathfinder aura is 5x5 normally and 7x7 awakened, centered rather than circular', () => {
    const M = model();
    assert.equal(M.inAura([10, 10], [12, 12], false), true);
    assert.equal(M.inAura([10, 10], [13, 10], false), false);
    assert.equal(M.inAura([10, 10], [13, 13], true), true);
    assert.equal(M.inAura([10, 10], [14, 10], true), false);
});

test('rear punishment uses the side opposite the facing frozen at the stun', () => {
    const M = model();
    assert.equal(M.behind([10, 10], [-1, 0], [18, 10]), true);
    assert.equal(M.behind([10, 10], [-1, 0], [2, 10]), false);
    assert.equal(M.behind([10, 10], [0, 1], [10, 2]), true);
    assert.equal(M.behind([10, 10], [0, 1], [18, 10]), false);
});

test('smoke cover requires a blocker on the ray between boss and player', () => {
    const M = model();
    assert.equal(M.covered([0, 0], [8, 0], new Set(['4,0'])), true);
    assert.equal(M.covered([0, 0], [8, 0], new Set(['9,0'])), false);
    assert.equal(M.covered([0, 0], [8, 0], new Set(['4,1'])), false);
    assert.equal(M.covered([0, 0], [8, 8], new Set(['4,4'])), true);
});
