const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const core = PluginManager.getCoreApi();
const { Player } = require("../dist/game/entity/impl/player/Player");
require("../plugins/combat/specials/BrineSabre.SpecialAttack")(PluginManager.createApi("BrineSabreTest"));
const special = core.CombatSpecial.getById("brine_sabre");
const method = special.getCombatMethod();

function fighter(x = 2974, y = 9496, z = 1) {
  const player = new Player(null);
  const sender = new Proxy({}, { get: () => () => sender });
  player.getPacketSender = () => sender;
  player.sendMessage = () => {};
  player.getLocation().set(x, y, z);
  player.setSpecialPercentage(100);
  for (const skill of [core.Skill.ATTACK, core.Skill.STRENGTH, core.Skill.DEFENCE]) {
    player.getSkillManager().setMaxLevels(skill, 80, false);
    player.getSkillManager().setCurrentLevel(skill, 80, false);
  }
  return player;
}

function boost(player, damage, accurate = true) {
  method.handleAfterHitEffects({
    isAccurate: () => accurate,
    getTotalDamage: () => damage,
    getAttacker: () => player,
  });
  return [core.Skill.ATTACK, core.Skill.STRENGTH, core.Skill.DEFENCE]
    .map(skill => player.getSkillManager().getCurrentLevel(skill));
}

test("Liquify rejects land, dry basements and the wrong planes without spending energy", () => {
  for (const tile of [[3200, 3200, 0], [2974, 9496, 0], [3732, 10281, 0], [3786, 9254, 0], [3785, 9225, 0]]) {
    const player = fighter(...tile);
    player.setSpecialActivated(true);
    assert.equal(method.canAttack(player, null), false, tile.join(","));
    assert.equal(player.getSpecialPercentage(), 100);
    assert.equal(player.isSpecialActivated(), false, "a rejected special must not retry every tick");
  }
});

test("Liquify works in the Mogre Camp, Harmony tunnel and western/eastern Fossil Island sea floor", () => {
  for (const tile of [[2974, 9496, 1], [3808, 9255, 1], [3732, 10281, 1], [3748, 10308, 1], [3800, 10308, 1]]) {
    assert.equal(method.canAttack(fighter(...tile), null), true, tile.join(","));
  }
});

test("Liquify does not extend to neighbouring map squares or planes", () => {
  for (const tile of [[2943, 9496, 1], [3008, 9496, 1], [2974, 9471, 1], [2974, 9536, 1],
    [3775, 9255, 1], [3840, 9255, 1], [3808, 9280, 1], [3711, 10281, 1],
    [3840, 10281, 1], [3732, 10239, 1], [3732, 10368, 1], [3732, 10281, 2]]) {
    assert.equal(method.canAttack(fighter(...tile), null), false, tile.join(","));
  }
});

test("Liquify adds a quarter of damage, rounded down, to all three combat stats", () => {
  assert.deepEqual(boost(fighter(), 19), [84, 84, 84]);
  assert.deepEqual(boost(fighter(), 3), [80, 80, 80]);
  assert.deepEqual(boost(fighter(), 0), [80, 80, 80]);
  assert.deepEqual(boost(fighter(), 19, false), [80, 80, 80]);
});

test("Liquify stacks up to its cap and restores drained stats by the damage-based amount", () => {
  const player = fighter();
  assert.deepEqual(boost(player, 40), [90, 90, 90]);
  assert.deepEqual(boost(player, 40), [91, 91, 91]);
  player.getSkillManager().setCurrentLevel(core.Skill.ATTACK, 60, false);
  assert.deepEqual(boost(player, 16), [64, 91, 91]);
});

test("Liquify preserves stronger existing potion boosts independently for each skill", () => {
  const player = fighter();
  player.getSkillManager().setCurrentLevel(core.Skill.ATTACK, 97, false);
  player.getSkillManager().setCurrentLevel(core.Skill.DEFENCE, 100, false);
  assert.deepEqual(boost(player, 16), [97, 84, 100]);
});

test("Liquify retains its 75% cost, doubled accuracy and ordinary damage", () => {
  assert.equal(core.CombatSpecial.getForWeaponId(core.ItemIdentifiers.BRINE_SABRE), special);
  assert.equal(special.getDrainAmount(), 75);
  assert.equal(special.getTraits().accuracyMultiplier, 2);
  assert.equal(special.getStrengthMultiplier(), 1);
  assert.equal(method.type(), core.CombatType.MELEE);
});
