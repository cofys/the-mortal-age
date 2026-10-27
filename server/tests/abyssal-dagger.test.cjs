// Run after yarn build: node --test tests/abyssal-dagger.test.cjs
const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const { CombatSpecial } = require("../dist/game/content/combat/CombatSpecial");
const { PendingHit } = require("../dist/game/content/combat/hit/PendingHit");
const { AccuracyFormulasDpsCalc } = require("../dist/game/content/combat/formula/AccuracyFormulasDpsCalc");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const core = PluginManager.getCoreApi();
const I = core.ItemIdentifiers;
require("../plugins/combat/specials/AbyssalDagger.SpecialAttack")({
  core, registerCombatSpecial: CombatSpecial.register,
});
const STANDARD = [I.ABYSSAL_DAGGER, I.ABYSSAL_DAGGER_P_, I.ABYSSAL_DAGGER_P_PLUS_, I.ABYSSAL_DAGGER_P_PLUS_PLUS_];
const IMBUED = [I.ABYSSAL_DAGGER_BH_, I.ABYSSAL_DAGGER_BH_P_, I.ABYSSAL_DAGGER_BH_P_PLUS_, I.ABYSSAL_DAGGER_BH_P_PLUS_PLUS_];
before(async () => CachePipeline.initialize(path.resolve(__dirname, "..")));

function player(id) {
  const p = {
    energy: 100, special: null, activated: false, drains: [],
    isPlayer: () => true, isNpc: () => false, getAsPlayer() { return this; },
    getEquipment: () => ({ get: () => ({ getId: () => id }) }),
    getWeapon: () => ({ getSpecialBar: () => -1, getSpecialMeter: () => -1 }),
    getCombatSpecial() { return this.special; }, setCombatSpecial(s) { this.special = s; },
    isSpecialActivated() { return this.activated; }, setSpecialActivated(on) { this.activated = on; },
    getDueling: () => ({ inDuel: () => false }),
    getSpecialPercentage() { return this.energy; },
    decrementSpecialPercentage(amount) { this.energy -= amount; this.drains.push(amount); },
    isRecoveringSpecialAttack: () => true,
    getPacketSender: () => ({ updateSpecialAttackOrb() {}, sendSpecialAttackState() {} }),
    performAnimation() {}, performGraphic() {}, getAttackSound: () => null,
    getCombat: () => ({ getTarget: () => null }),
  };
  CombatSpecial.assign(p);
  return p;
}

for (const [label, ids, cost, multiplier] of [["standard", STANDARD, 25, 0.85], ["imbued", IMBUED, 35, 0.95]]) {
  for (const id of ids) {
    test(`${label} dagger ${id} equips and activates Abyssal Puncture with its own energy and damage`, () => {
      assert.equal(ItemDefinition.forId(id).isNoted(), false);
      const p = player(id);
      assert.ok(p.special, "equipping this usable variant assigns the special");
      CombatSpecial.activate(p);
      assert.equal(p.activated, true, "the normal special button queues the attack");
      assert.equal(p.special.getDrainAmount(), cost);
      assert.equal(p.special.getStrengthMultiplier(), multiplier);
      p.special.getCombatMethod().start(p, {});
      assert.equal(p.energy, 100 - cost);
      assert.deepEqual(p.drains, [cost], "energy is consumed once per two-hit attack");
    });
  }

  for (const accurate of [true, false]) {
    test(`${label} Puncture ${accurate ? "lands" : "misses"} both hits from one accuracy roll`, (t) => {
      const p = player(ids[0]);
      assert.ok(p.special);
      p.activated = true;
      const rolls = t.mock.method(AccuracyFormulasDpsCalc, "rollAccuracyCount", () => accurate ? 1 : 0);
      const damage = t.mock.method(core.CombatFactory, "getHitDamage", () => new core.HitDamage(10, core.HitMask.RED));
      const target = { isPlayer: () => false, getHitpoints: () => 100 };
      const hit = new PendingHit(p, target, p.special.getCombatMethod());
      assert.equal(rolls.mock.callCount(), 1);
      assert.equal(hit.getHits().length, 2);
      assert.deepEqual(hit.getHits().map(h => h.getDamage()), accurate ? [10, 10] : [0, 0]);
      assert.equal(damage.mock.callCount(), accurate ? 2 : 0);
      assert.equal(p.special.getTraits().accuracyMultiplier, 1.25);
      assert.equal(p.special.getTraits().damageMultiplier, multiplier);
      assert.equal(p.special.getTraits().meleeDefenceBonusIndex, 1);
    });
  }
}

test("notes and bank placeholders do not acquire a special", () => {
  for (const id of [I.ABYSSAL_DAGGER_2, I.ABYSSAL_DAGGER_P__2, I.ABYSSAL_DAGGER_P_PLUS__2, I.ABYSSAL_DAGGER_P_PLUS_PLUS__2,
    I.ABYSSAL_DAGGER_3, I.ABYSSAL_DAGGER_P__3, I.ABYSSAL_DAGGER_P_PLUS__3, I.ABYSSAL_DAGGER_P_PLUS_PLUS__3,
    I.ABYSSAL_DAGGER_BH__2, I.ABYSSAL_DAGGER_BH_P__2, I.ABYSSAL_DAGGER_BH_P_PLUS__2, I.ABYSSAL_DAGGER_BH_P_PLUS_PLUS__2]) {
    assert.equal(player(id).special, null);
  }
});
