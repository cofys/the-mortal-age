// Run after `yarn build`: node --test tests/lightbearer.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { ItemIdentifiers } = require("../dist/util/ItemIdentifiers");
const { CombatSpecial } = require("../dist/game/content/combat/CombatSpecial");
const { TaskManager } = require("../dist/game/task/TaskManager");
const Effects = require("../dist/game/content/combat/EquipmentEffects");
const { RestoreSpecialAttackTask } = require("../dist/game/task/impl/RestoreSpecialAttackTask");
const Lightbearer = require("../plugins/items/Lightbearer.plugin");

Lightbearer.register({
  core: { Equipment, ItemIdentifiers, CombatSpecial },
  registerSpecialEnergyRestoreModifier: Effects.registerSpecialEnergyRestoreModifier,
  onCustomEvent() {},
  onPlayerLogin() {},
});

function createPlayer(ringId = -1) {
  const equipment = new Array(14).fill(null).map(() => ({ getId: () => -1 }));
  const player = {
    isPlayer: () => true,
    isRegistered: () => true,
    getAsPlayer: () => player,
    getEquipment: () => ({ get: (slot) => equipment[slot] }),
    wear(id) { equipment[Equipment.RING_SLOT] = { getId: () => id }; },
    getSpecialPercentage: () => 50,
    setSpecialPercentage() {},
    isRecoveringSpecialAttack: () => true,
    setRecoveringSpecialAttack() {},
    getSpecialAttackRestore: () => ({ start() {}, stop() {} }),
  };
  player.wear(ringId);
  return player;
}

/** A player restoring energy, `elapsed` ticks into the timer (50 ticks, or 25 with the ring on). */
function restoring(t, elapsed, ringId = -1) {
  const tasks = [];
  t.mock.method(TaskManager, "submit", (task) => { task.setRunning(true); tasks.push(task); });
  const player = createPlayer(ringId);
  Lightbearer._test.restartTimerOnSwap({ player });
  TaskManager.submit(new RestoreSpecialAttackTask(player));
  for (let i = 0; i < elapsed; i++) tasks.forEach((task) => task.tick());
  t.after(() => tasks.forEach((task) => task.stop()));
  return player;
}

function swapRing(player, ringId) {
  player.wear(ringId);
  Lightbearer._test.restartTimerOnSwap({ player });
}

test("the lightbearer doubles the special-attack energy restore rate", () => {
  assert.equal(new RestoreSpecialAttackTask(createPlayer()).getDelay(), 50);
  assert.equal(new RestoreSpecialAttackTask(createPlayer(ItemIdentifiers.LIGHTBEARER)).getDelay(), 25);
});

test("a non-player keeps the default delay", () => {
  assert.equal(Lightbearer._test.restoreDelay({ isPlayer: () => false }, 50), 50);
});

test("putting the ring on before half the timer has run restarts it at 25 ticks", (t) => {
  const player = restoring(t, 5);
  assert.equal(CombatSpecial.restoreTicksRemaining(player), 45);
  swapRing(player, ItemIdentifiers.LIGHTBEARER);
  assert.equal(CombatSpecial.restoreTicksRemaining(player), 25);
});

test("putting the ring on with 25 or fewer ticks left keeps the timer", (t) => {
  const player = restoring(t, 40);
  swapRing(player, ItemIdentifiers.LIGHTBEARER);
  assert.equal(CombatSpecial.restoreTicksRemaining(player), 10);
});

test("taking the ring off always restarts the full 50-tick timer", (t) => {
  const player = restoring(t, 20, ItemIdentifiers.LIGHTBEARER);
  assert.equal(CombatSpecial.restoreTicksRemaining(player), 5);
  swapRing(player, -1);
  assert.equal(CombatSpecial.restoreTicksRemaining(player), 50);
});

test("swapping the ring at full energy starts no timer", () => {
  const player = createPlayer();
  Lightbearer._test.restartTimerOnSwap({ player });
  swapRing(player, ItemIdentifiers.LIGHTBEARER);
  swapRing(player, -1);
  assert.equal(RestoreSpecialAttackTask.running(player), null);
});
