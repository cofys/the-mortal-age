// Run after `yarn build`: node --test tests/volatile-nightmare-autocast.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CombatFactory } = require("../dist/game/content/combat/CombatFactory");
const { CombatSpecial } = require("../dist/game/content/combat/CombatSpecial");
const { CombatType } = require("../dist/game/content/combat/CombatType");
const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { ItemIdentifiers } = require("../dist/util/ItemIdentifiers");

const core = PluginManager.getCoreApi();
require("../plugins/combat/specials/VolatileNightmareStaff.SpecialAttack")({
  core,
  registerCombatSpecial: CombatSpecial.register,
});
require("../plugins/combat/specials/DragonDagger.SpecialAttack")({
  core,
  registerCombatSpecial: CombatSpecial.register,
});

const WEAPON_ID = ItemIdentifiers.VOLATILE_NIGHTMARE_STAFF;
const AUTOCAST = { name: "Fire Strike" };

function player({ autocast = true, activated = true, castSpell = null, weaponId = WEAPON_ID, special } = {}) {
  const weapon = { getId: () => weaponId };
  const items = Array.from({ length: 14 }, () => ({ getId: () => -1 }));
  items[Equipment.WEAPON_SLOT] = weapon;
  const combat = {
    getAmmunition: () => null,
    setAmmunition() {},
    getRangedWeapon: () => null,
    setRangedWeapon() {},
    getCastSpell: () => castSpell,
    getAutocastSpell: () => autocast ? AUTOCAST : null,
    getTarget: () => null,
  };
  const p = {
    isPlayer: () => true,
    isNpc: () => false,
    getAsPlayer: () => p,
    getCombat: () => combat,
    getEquipment: () => ({ hasStaffEquipped: () => true, getItems: () => items, get: () => weapon }),
    getCombatSpecial: () => special === undefined ? CombatSpecial.getForWeaponId(weaponId) : special,
    isSpecialActivated: () => activated,
  };
  return p;
}

test("Volatile Nightmare staff special overrides an active autocast", () => {
  const special = CombatSpecial.getForWeaponId(WEAPON_ID);
  assert.ok(special, "the Volatile special is registered");

  const method = CombatFactory.getMethod(player({ autocast: true, activated: true }));
  assert.equal(method, special.getCombatMethod(), "the activated special owns the swing");
  assert.equal(method.type(), CombatType.MAGIC);
});

test("without the special activated, the same staff still autocasts", () => {
  const method = CombatFactory.getMethod(player({ autocast: true, activated: false }));
  assert.equal(method, CombatFactory.MAGIC_COMBAT, "ordinary autocast keeps using the spell method");
});

test("without autocast, the activated special is still selected", () => {
  const special = CombatSpecial.getForWeaponId(WEAPON_ID);
  const method = CombatFactory.getMethod(player({ autocast: false, activated: true }));
  assert.equal(method, special.getCombatMethod());
});

test("a custom resolver owns the Toxic blowpipe special before its fallback method", () => {
  const fallback = { type: () => CombatType.RANGED };
  const resolved = { type: () => CombatType.RANGED, resolved: true };
  const special = { id: "toxic_blowpipe", getCombatMethod: () => fallback };
  const p = player({
    autocast: false,
    activated: true,
    weaponId: ItemIdentifiers.TOXIC_BLOWPIPE,
    special,
  });
  const original = PluginManager.getCombatMethodResolvers;
  PluginManager.getCombatMethodResolvers = () => [{
    resolve: (attacker) => attacker === p ? resolved : null,
  }];
  try {
    assert.equal(CombatFactory.getMethod(p), resolved, "the blowpipe resolver sees its own special state");
  } finally {
    PluginManager.getCombatMethodResolvers = original;
  }
});

test("an explicit spell click beats an armed dragon dagger special", () => {
  const dagger = CombatSpecial.getForWeaponId(ItemIdentifiers.DRAGON_DAGGER);
  assert.ok(dagger, "the dragon dagger special is registered");
  const method = CombatFactory.getMethod(player({
    autocast: false,
    activated: true,
    weaponId: ItemIdentifiers.DRAGON_DAGGER,
    special: dagger,
    castSpell: { name: "Ice Barrage" },
  }));
  assert.equal(method, CombatFactory.MAGIC_COMBAT, "the requested spell, not the armed special");
});
