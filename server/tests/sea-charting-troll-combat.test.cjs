// Real arena, actors, prayer, hit queues, collision and task/movement owners; only network/RNG captured.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, arena, nextIndex = 2800;
before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(ROOT);
  PluginManager.loadFromDirectory(path.join(ROOT, 'plugins'));
  core = PluginManager.getCoreApi();
  new (require('../dist/game/definition/loader/impl/NpcDefinitionLoader').NpcDefinitionLoader)().load();
  core.RegionManager.init();
  PluginManager.emitServerStartup({});
  arena = require('../plugins/skills/sailing/charting/FishierStout.Charting');
});
function ticks(n = 1) {
  for (let i = 0; i < n; i++) { core.World.processCycle++; core.TaskManager.process(); }
}
function encounter(t) {
  const player = new Player(null);
  player.setIndex(nextIndex++); player.setRegistered(true); player.setUsername('Troll' + player.getIndex());
  player.setAttribute('bot-skip-persistence', true);
  player.getSession = () => ({ sendClientPacket() { return true; }, write() { return true; }, getChannel() { return null; } });
  player.getSkillManager().setMaxLevel(core.Skill.HITPOINTS, 99);
  player.setHitpoints(99);
  player.getSkillManager().setMaxLevel(core.Skill.PRAYER, 99);
  player.getSkillManager().setCurrentLevel(core.Skill.PRAYER, 99);
  arena.start(player); ticks(8);
  const scene = arena.scenes.get(player);
  player.setNeedsPlacement(false);
  for (const actor of scene.npcs) actor.setNeedsPlacement(false);
  const npc = key => scene.npcs.find(n => n.getId() === core.CacheDefinitions.getNpcId(key));
  const rocks = npc('sailing_charting_drink_troll_ice');
  const dad = npc('sailing_charting_drink_troll_dad');
  t.after(() => { PluginManager.emitPlayerLogout({ player, username: player.getUsername() }); player.setRegistered(false); });
  return { player, scene, rocks, dad };
}
function target(npc, player, x, y) {
  player.moveTo(new core.Location(x, y, 0)); player.setNeedsPlacement(false);
  npc.setNeedsPlacement(false); npc.getCombat().reset(); npc.getCombat().attack(player);
}
function roll(t, result) { t.mock.method(core.Misc, 'randomInclusive', (min, max) => Math.max(min, Math.min(max, result))); }
function impact(npc, player, method, damage = 0) {
  const hit = new core.PendingHit(npc, player, method, { damage, rollAccuracy: false });
  core.CombatFactory.addPendingHit(hit);
  player.getCombat().getHitQueue().process(++core.World.processCycle + 2);
  return hit;
}
test('Rocks accurate magic freezes for estimated three ticks and cancels combat on actual impact', t => {
  const f = encounter(t); roll(t, 2);
  f.player.getCombat().attack(f.rocks);
  const method = core.CombatFactory.getMethod(f.rocks);
  impact(f.rocks, f.player, method);
  assert.equal(f.player.getTimers().has(core.TimerKey.FREEZE), true);
  assert.equal(f.player.getTimers().getTicks(core.TimerKey.FREEZE), 3);
  assert.equal(f.player.getCombat().getTarget(), null);
  assert.equal(f.player.getGraphic().getId(), core.CacheDefinitions.getSpotanimId('ice_barrage_impact'));
});
test('Rocks magic has estimated one-tick delay and a non-fallback maximum through ordinary rolls', t => {
  const f = encounter(t); roll(t, 23);
  const method = core.CombatFactory.getMethod(f.rocks);
  assert.equal(method.hits(f.rocks, f.player)[0].getDelay(), 1);
  assert.equal(core.CombatFactory.rollHitDamage(f.rocks, f.player, core.CombatType.MAGIC).getDamage(), 23);
});
test('Rocks selects estimated random adjacent melee but retains magic at a diagonal', t => {
  const f = encounter(t); roll(t, 0);
  const at = f.rocks.getLocation(); target(f.rocks, f.player, at.getX() + 1, at.getY());
  assert.equal(core.CombatFactory.getMethod(f.rocks).type(), core.CombatType.MELEE);
  target(f.rocks, f.player, at.getX() + 1, at.getY() + 1);
  assert.equal(core.CombatFactory.getMethod(f.rocks).type(), core.CombatType.MAGIC);
});
test('Rocks teleports to a legal adjacent arena tile at range and never teleports from diagonal adjacency', t => {
  const f = encounter(t); roll(t, 0);
  const at = f.rocks.getLocation().clone(); target(f.rocks, f.player, at.getX() + 4, at.getY());
  core.CombatFactory.getMethod(f.rocks).start(f.rocks, f.player);
  assert.ok(f.rocks.getLocation().getDistance(f.player.getLocation()) <= 1);
  assert.ok(f.scene.area.contains(f.rocks.getLocation()));
  assert.equal(core.RegionManager.blocked(f.rocks.getLocation(), f.rocks.getPrivateArea()), false);
  target(f.rocks, f.player, f.rocks.getLocation().getX() + 1, f.rocks.getLocation().getY() + 1);
  const before = f.rocks.getLocation().clone();
  core.CombatFactory.getMethod(f.rocks).start(f.rocks, f.player);
  assert.ok(f.rocks.getLocation().equals(before));
});
test('Daddy special uses captured swing/flyback and estimated stun with clipped forced movement', t => {
  const f = encounter(t); roll(t, 0);
  const at = f.dad.getLocation(); target(f.dad, f.player, at.getX() + 3, at.getY() + 1);
  const method = core.CombatFactory.getMethod(f.dad);
  method.start(f.dad, f.player);
  assert.equal(f.dad.getAnimation().getId(), core.CacheDefinitions.getSeqId('troll_treetrunk_attack'));
  const start = f.player.getLocation().clone(); impact(f.dad, f.player, method);
  assert.equal(f.player.getTimers().has(core.TimerKey.STUN), true);
  assert.equal(f.player.getAnimation().getId(), core.CacheDefinitions.getSeqId('human_troll_flyback'));
  assert.equal(f.player.getAnimation().getDelay(), 20);
  const movement = f.player.getForceMovement(); assert.ok(movement);
  assert.equal(movement.getSpeed(), 20); assert.equal(movement.getReverseSpeed(), 40);
  ticks(2);
  assert.ok(f.player.getLocation().getDistance(start) > 0);
  assert.ok(f.player.getLocation().getDistance(start) <= 5);
  assert.ok(f.scene.area.contains(f.player.getLocation()));
});
test('lethal Daddy hit cannot schedule a post-death knockback', t => {
  const f = encounter(t); roll(t, 0);
  const method = core.CombatFactory.getMethod(f.dad);
  impact(f.dad, f.player, method, 99);
  assert.equal(f.player.getHitpoints(), 0);
  assert.ok(f.player.getForceMovement() == null);
});
test('arena logout cancels a pending Daddy forced move without returning the player to freed tiles', t => {
  const f = encounter(t); roll(t, 0);
  const at = f.dad.getLocation(); target(f.dad, f.player, at.getX() + 3, at.getY() + 1);
  impact(f.dad, f.player, core.CombatFactory.getMethod(f.dad));
  assert.ok(f.player.getForceMovement());
  PluginManager.emitPlayerLogout({ player: f.player, username: f.player.getUsername() });
  const safe = f.player.getLocation().clone(); ticks(3);
  assert.equal(f.player.getForceMovement(), null);
  assert.ok(f.player.getLocation().equals(safe));
});
test('foreign target and removed encounter cannot receive Rocks freeze', t => {
  const f = encounter(t), g = encounter(t); roll(t, 2);
  const method = core.CombatFactory.getMethod(f.rocks);
  impact(f.rocks, g.player, method);
  assert.equal(g.player.getTimers().has(core.TimerKey.FREEZE), false);
  PluginManager.emitPlayerLogout({ player: f.player, username: f.player.getUsername() });
  impact(f.rocks, f.player, method);
  assert.equal(f.player.getTimers().has(core.TimerKey.FREEZE), false);
});
