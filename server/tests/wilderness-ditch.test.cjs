const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({ x = 3139, y = 3523, active = false, ready = true } = {}) {
  const sounds = [], tasks = [], hooks = new Map();
  class Location {
    constructor(x, y, z = 0) { Object.assign(this, { x, y, z }); }
    getX() { return this.x; }
    getY() { return this.y; }
    clone() { return new Location(this.x, this.y, this.z); }
  }
  class Sound {
    constructor(id, volume, delay, loopType) { Object.assign(this, { id, volume, delay, loopType }); }
    getId() { return this.id; }
  }
  Sound.WILDERNESS_DITCH_JUMP = new Sound(2462, 1, 0, 0);
  const core = {
    Location, Sound,
    Sounds: { sendSound: (_, sound) => sounds.push(sound) },
    ForceMovement: class { constructor(...args) { this.args = args; } },
    ForceMovementTask: class { constructor(player, ticks, movement) { Object.assign(this, { player, ticks, movement }); } },
  };
  const module = { exports: {} };
  // Supply the same core doubles to both the legacy imports and api.core, so
  // this regression can also run against the original plugin without a build.
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/objects/WildernessDitch.plugin.js'), 'utf8'), {
    module, require: () => core,
  });
  module.exports.register({ core, getTaskManager: () => ({ submit: task => tasks.push(task) }),
    onObjectInteraction: (name, handlers) => hooks.set(name, handlers) });
  let resets = 0;
  const player = {
    getLocation: () => new Location(x, y),
    getForceMovement: () => active ? {} : null,
    getClickDelay: () => ({ elapsed: () => 1000, elapsedTime: () => ready, reset: () => resets++ }),
  };
  const cross = (face = 0) => hooks.get('Wilderness Ditch').Cross({ player,
    object: { getFace: () => face }, location: { x: 3139, y: 3521 }, sourceLocation: { x, y } });
  return { cross, sounds, tasks, resets: () => resets };
}

for (const [y, dy] of [[3523, -3], [3520, 3]]) {
  test(`Cross from y=${y} delays the jump sound as in rsprox recording 345`, () => {
    const h = harness({ y });
    h.cross();
    assert.deepEqual(h.sounds.map(s => [s.id, s.delay]), [[2462, 25]]);
    assert.equal(h.tasks.length, 1);
    assert.equal(h.tasks[0].movement.args[1].y, dy);
    assert.equal(h.resets(), 1);
  });
}
for (const options of [{ active: true }, { ready: false }]) {
  test(`a rejected Cross emits neither sound nor movement: ${JSON.stringify(options)}`, () => {
    const h = harness(options);
    h.cross();
    assert.equal(h.sounds.length, 0);
    assert.equal(h.tasks.length, 0);
    assert.equal(h.resets(), 0);
  });
}
