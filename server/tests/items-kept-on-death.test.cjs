// Run after `yarn build`: node --test tests/items-kept-on-death.test.cjs
// Which items a player keeps on death, upgraded Nightmare staffs splitting into their staff and orb
// for a Wilderness killer, and the staffs' special attack graphics (docs/items-kept-on-death.md).
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PlayerDeathTask } = require('../dist/game/task/impl/PlayerDeath');
const { Item } = require('../dist/game/model/Item');
const { Location } = require('../dist/game/model/Location');
const { PlayerRights } = require('../dist/game/model/rights/PlayerRights');
const { ItemIdentifiers: I } = require('../dist/util/ItemIdentifiers');

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  require('../plugins/items/ItemDefinitionLoader.plugin').register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
});

const WILDERNESS = new Location(3090, 3600, 0);
const EDGEVILLE = new Location(3090, 3490, 0);

function fakePlayer({ items, protectItem = false, skulled = false, location = EDGEVILLE }) {
  const prayers = new Array(40).fill(false);
  if (protectItem) prayers.fill(true);
  return {
    getInventory: () => ({ getItems: () => items }),
    getEquipment: () => ({ getItems: () => [] }),
    getSkullTimer: () => (skulled ? 100 : 0),
    getSkullType: () => 0,
    getSkillManager: () => ({ getMaxLevel: () => 99, getCurrentLevel: () => 99 }),
    getPrayerActive: () => prayers,
    getLocation: () => location,
    getRights: () => PlayerRights.NONE,
  };
}

const names = (items) => items.map((item) => item.getDefinition().getName());

test('untradeable items compete for the kept slots by value (Wiki: Items Kept on Death)', () => {
  // Skulled with Protect Item: one item kept. The 4.6m staff beat the 125k ballista only once
  // untradeables were ranked; before, the ballista took the slot.
  const staff = new Item(I.VOLATILE_NIGHTMARE_STAFF, 1);
  const ballista = new Item(I.LIGHT_BALLISTA, 1);
  const player = fakePlayer({ items: [ballista, staff], protectItem: true, skulled: true });
  assert.deepEqual(names(PlayerDeathTask.getItemsToKeep(player)), ['Volatile Nightmare staff']);
  // Unskulled without Protect Item: three, both among them.
  assert.deepEqual(names(PlayerDeathTask.getItemsToKeep(fakePlayer({ items: [ballista, staff] }))).sort(),
    ['Light ballista', 'Volatile Nightmare staff']);
});

test('preset items are never protected', () => {
  const staff = new Item(I.VOLATILE_NIGHTMARE_STAFF, 1);
  staff.setMetaValue(Item.UNTRADEABLE_META, true);
  const ballista = new Item(I.LIGHT_BALLISTA, 1);
  const player = fakePlayer({ items: [staff, ballista], protectItem: true, skulled: true });
  assert.deepEqual(names(PlayerDeathTask.getItemsToKeep(player)), ['Light ballista']);
});

test('an unkept upgraded staff splits into its staff and orb for a Wilderness killer (Wiki)', () => {
  const killer = { isPlayer: () => true };
  const split = (victim, items, kept = [], by = killer) => names(PlayerDeathTask.splitIntoComponents(victim, by, kept, items));
  for (const [staffId, orb] of [[I.VOLATILE_NIGHTMARE_STAFF, 'Volatile orb'], [I.HARMONISED_NIGHTMARE_STAFF, 'Harmonised orb'], [I.ELDRITCH_NIGHTMARE_STAFF, 'Eldritch orb']]) {
    const staff = new Item(staffId, 1);
    const victim = fakePlayer({ items: [staff], location: WILDERNESS });
    assert.deepEqual(split(victim, [staff]), ['Nightmare staff', orb]);
    assert.deepEqual(split(victim, [staff], [staff]).length, 1, 'kept: stays whole');
  }
  const staff = new Item(I.VOLATILE_NIGHTMARE_STAFF, 1);
  assert.deepEqual(split(fakePlayer({ items: [staff], location: EDGEVILLE }), [staff]), ['Volatile Nightmare staff'], 'outside the Wilderness');
  assert.deepEqual(split(fakePlayer({ items: [staff], location: WILDERNESS }), [staff], [], null), ['Volatile Nightmare staff'], 'no player killer');
  const preset = new Item(I.VOLATILE_NIGHTMARE_STAFF, 1);
  preset.setMetaValue(Item.UNTRADEABLE_META, true);
  assert.deepEqual(split(fakePlayer({ items: [preset], location: WILDERNESS }), [preset]), ['Volatile Nightmare staff'],
    'a preset staff is deleted, never split into free components');
});

test('the Volatile and Eldritch specials show their cache graphics', () => {
  const { PluginManager } = require('../dist/plugins/PluginManager');
  const core = { ...PluginManager.getCoreApi(), CombatSpecial: { drain() {} } };
  for (const [file, cast, hit] of [['VolatileNightmareStaff', 1760, 1759], ['EldritchNightmareStaff', 1762, 1761]]) {
    let special = null;
    require(`../plugins/combat/specials/${file}.SpecialAttack`)({ core, registerCombatSpecial: (entry) => { special = entry; } });
    const shown = { animations: [], graphics: [], target: [] };
    const caster = {
      isPlayer: () => false,
      performAnimation: (animation) => shown.animations.push(animation.getId()),
      performGraphic: (graphic) => shown.graphics.push(graphic.getId()),
    };
    const target = { performGraphic: (graphic) => shown.target.push(graphic.getId()) };
    special.combatMethod.start(caster, target);
    special.combatMethod.handleAfterHitEffects({ isAccurate: () => true, getTarget: () => target, getAttacker: () => caster, getTotalDamage: () => 0 });
    special.combatMethod.handleAfterHitEffects({ isAccurate: () => false, getTarget: () => target, getAttacker: () => caster, getTotalDamage: () => 0 });
    assert.deepEqual(shown, { animations: [8532], graphics: [cast], target: [hit, 85] }, file);
  }
  // Ending the special must not play the reset animation over the cast.
  const resets = [];
  let volatile = null;
  require('../plugins/combat/specials/VolatileNightmareStaff.SpecialAttack')({ core, registerCombatSpecial: (entry) => { volatile = entry; } });
  volatile.combatMethod.finished({
    getCombat: () => ({ reset: (...args) => resets.push(args) }),
    setMobileInteraction() {},
    getMovementQueue: () => ({ reset() {} }),
  }, {});
  assert.deepEqual(resets, [[false]]);
});
