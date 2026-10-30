// Independent PR1559 adversarial review: real lifecycle owners, controlled RNG/network only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
require('../dist/Server').Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, arena, effects, index = 2920;
const deaths = [];
before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(ROOT);
  PluginManager.loadFromDirectory(path.join(ROOT, 'plugins'));
  core = PluginManager.getCoreApi();
  new (require('../dist/game/definition/loader/impl/NpcDefinitionLoader').NpcDefinitionLoader)().load();
  core.RegionManager.init(); PluginManager.emitServerStartup({});
  arena = require('../plugins/skills/sailing/charting/FishierStout.Charting');
  effects = require('../plugins/skills/sailing/charting/DrinkEffects.Charting');
  PluginManager.createApi('IndependentChartingReview').onNpcDeath(e => deaths.push(e));
});
function tick(n = 1) { while (n--) { ++core.World.processCycle; core.TaskManager.process(); } }
function player(t) {
  const p = new Player(null); p.setIndex(index++); p.setUsername('Review' + p.getIndex()); p.setRegistered(true);
  p.setAttribute('bot-skip-persistence', true);
  p.getSession = () => ({ sendClientPacket() { return true; }, write() { return true; }, getChannel() { return null; } });
  for (const skill of [core.Skill.HITPOINTS, core.Skill.PRAYER, core.Skill.SAILING]) {
    p.getSkillManager().setMaxLevel(skill, 99); p.getSkillManager().setCurrentLevel(skill, 99);
  }
  t.after(() => {
    PluginManager.emitPlayerLogout({ player: p, username: p.getUsername() });
    // Real World registration owns the slot until removal; marking it false first leaks it.
    if (core.World.getPlayers().get(p.getIndex()) === p) core.World.getPlayers().remove(p);
    else p.setRegistered(false);
  });
  return p;
}
function fight(t) {
  const p = player(t); arena.start(p); tick(8);
  const scene = arena.scenes.get(p); p.setNeedsPlacement(false);
  for (const npc of scene.npcs) npc.setNeedsPlacement(false);
  const dad = scene.npcs.find(n => n.getId() === core.CacheDefinitions.getNpcId('sailing_charting_drink_troll_dad'));
  const rocks = scene.npcs.find(n => n.getId() === core.CacheDefinitions.getNpcId('sailing_charting_drink_troll_ice'));
  return { p, scene, dad, rocks };
}
function knock(t, f) {
  t.mock.method(core.Misc, 'randomInclusive', (min, max) => min);
  f.p.moveTo(f.dad.getLocation().transform(3, 1)); f.p.setNeedsPlacement(false);
  f.dad.getCombat().attack(f.p);
  const method = core.CombatFactory.getMethod(f.dad);
  const hit = new core.PendingHit(f.dad, f.p, method, { damage: 1, rollAccuracy: false });
  core.CombatFactory.addPendingHit(hit); f.p.getCombat().getHitQueue().process(++core.World.processCycle);
  assert.ok(f.p.getForceMovement(), 'normal special must schedule the real movement task');
}
function registerForWorld(f) {
  const session = { processPackets() {}, flush() {}, sendClientPacket() { return true; }, write() { return true; },
    isTileInScene() { return false; }, getChannel() { return { connected: true, disconnect() {} }; } };
  f.p.getSession = () => session;
  f.p.setRegistered(false);
  assert.equal(core.World.getPlayers().add(f.p), true);
  f.p.setRights(core.PlayerRights.DEVELOPER);
  for (const npc of f.scene.npcs) if (npc !== f.dad) PluginManager.removeNpc(npc);
}
test('review: eastward flyback emits a cardinal client angle rather than an eight-way movement enum', t => {
  const f = fight(t); knock(t, f);
  const movement = f.p.getForceMovement();
  assert.ok(movement.getEnd().getX() > 0); assert.equal(movement.getEnd().getY(), 0);
  const { PlayerSession } = require('../dist/net/PlayerSession');
  const session = new PlayerSession(null); session.setPlayer(f.p);
  const view = session.createPlayerView(f.p);
  // RSProx235/948 flyback faces Dad; east displacement must face west (512).
  assert.equal(view.forcedMovement.direction, 512,
    `eastward flyback emitted angle ${view.forcedMovement.direction}; it must face Dad west`);
});
test('review: real accuracy miss causes no freeze while an accurate zero still freezes', t => {
  const f = fight(t);
  t.mock.method(core.Misc, 'randomInclusive', min => min);
  const method = core.CombatFactory.getMethod(f.rocks);
  assert.equal(method.type(), core.CombatType.MAGIC);
  const miss = method.hits(f.rocks, f.p)[0]; assert.equal(miss.isAccurate(), false);
  core.CombatFactory.addPendingHit(miss); f.p.getCombat().getHitQueue().process(++core.World.processCycle + 2);
  assert.equal(f.p.getTimers().has(core.TimerKey.FREEZE), false);
  const zero = new core.PendingHit(f.rocks, f.p, method, { damage: 0, rollAccuracy: false });
  assert.equal(zero.isAccurate(), true);
  core.CombatFactory.addPendingHit(zero); f.p.getCombat().getHitQueue().process(++core.World.processCycle + 2);
  assert.equal(f.p.getTimers().has(core.TimerKey.FREEZE), true);
});
test('review: launched Rocks magic keeps its style when prayer switches, next method selects melee', t => {
  const f = fight(t); t.mock.method(core.Misc, 'randomInclusive', min => min);
  const method = core.CombatFactory.getMethod(f.rocks); assert.equal(method.type(), core.CombatType.MAGIC);
  core.PrayerHandler.activatePrayerPrayerId(f.p, core.PrayerHandler.PROTECT_FROM_MAGIC);
  const protectedHit = new core.PendingHit(f.rocks, f.p, method, { damage: 20, rollAccuracy: false });
  assert.equal(protectedHit.getCombatType(), core.CombatType.MAGIC);
  assert.equal(protectedHit.getTotalDamage(), 0);
  assert.equal(core.CombatFactory.getMethod(f.rocks).type(), core.CombatType.MELEE);
  core.CombatFactory.addPendingHit(protectedHit); f.p.getCombat().getHitQueue().process(++core.World.processCycle);
  assert.equal(f.p.getTimers().has(core.TimerKey.FREEZE), true);
});
for (const transition of ['teleport', 'death', 'arena-replacement']) test('review: queued Daddy movement survives no ' + transition, t => {
  const f = fight(t); knock(t, f);
  if (transition === 'teleport') f.p.moveTo(new core.Location(2659, 3674, 0));
  if (transition === 'death') f.p.setHitpoints(0);
  if (transition === 'arena-replacement') arena.start(f.p);
  const after = f.p.getLocation().clone(); tick(2);
  assert.equal(f.p.getForceMovement(), null);
  assert.ok(f.p.getLocation().equals(after), 'old force task must not place player back into old scene');
});
test('review: destination occupied after special launch cancels placement, normal later special still moves', t => {
  const f = fight(t); knock(t, f);
  const movement = f.p.getForceMovement(), start = f.p.getLocation().clone();
  const end = movement.getStart().transform(movement.getEnd().getX(), movement.getEnd().getY());
  f.rocks.moveTo(end); f.rocks.setNeedsPlacement(false);
  tick(2); assert.ok(f.p.getLocation().equals(start)); assert.equal(f.p.getForceMovement(), null);
  f.rocks.moveTo(f.scene.area.tile(26, 28, 0));
  knock(t, f); tick(2); assert.ok(!f.p.getLocation().equals(start));
});
test('review: full World cycles retain Daddy engagement after his own forced movement completes', t => {
  const f = fight(t);
  registerForWorld(f);
  knock(t, f);
  assert.equal(f.dad.getCombat().getTarget(), f.p);
  const start = f.p.getLocation().clone();
  core.World.process(); core.World.process();
  assert.equal(f.p.getForceMovement(), null);
  assert.ok(!f.p.getLocation().equals(start));
  core.World.process(); // The completed placement flag clears before re-engagement.
  assert.ok(f.dad.getCombat().getTarget() === f.p, 'own knockback placement must not permanently abandon the encounter');
});
for (const transition of ['teleport', 'arena-replacement']) test('review: completed knockback does not resume old Dad after ' + transition, t => {
  const f = fight(t); registerForWorld(f); knock(t, f);
  const start = f.p.getLocation().clone();
  core.World.process(); core.World.process();
  assert.equal(f.p.getForceMovement(), null);
  assert.ok(!f.p.getLocation().equals(start), 'transition must occur after forced placement completes');
  assert.equal(f.dad.getCombat().getTarget(), null, 're-engagement must still be pending');
  if (transition === 'teleport') f.p.moveTo(new core.Location(2659, 3674, 0));
  else arena.start(f.p);
  const after = f.p.getLocation().clone();
  core.World.process();
  assert.equal(f.dad.getCombat().getTarget(), null, 'old delayed callback must not restart the discarded fight');
  assert.ok(f.p.getLocation().equals(after), 'old scene must not undo the legitimate transition');
  if (transition === 'teleport') assert.equal(arena.scenes.has(f.p), false);
  else assert.notEqual(arena.scenes.get(f.p), f.scene);
});
test('review: two queued actual PendingHits spend one life then award only one death', t => {
  t.mock.method(core.Misc, 'randomInclusive', (min, max) => min === 0 && max === 9 ? 1 : max);
  const p = player(t); core.Sailing.giveBoat(p, 'skiff', 'the_pandemonium');
  assert.equal(core.Sailing.board(p, 'the_pandemonium'), null);
  const boat = core.Sailing.instanceAboard(p); t.after(() => core.BoatManager.dispose(boat));
  const id = core.CacheDefinitions.getObjId('sailing_charting_drink_crate_corpse_reviver');
  p.setAttribute('charting:drink-no-warning', true); p.getInventory().add(new core.Item(id));
  require('../dist/net/NetworkBuilder').ClientConnection.prototype.inventoryAction.call({ player: p }, {
    type: 'inventory_action', widgetId: core.CacheDefinitions.getComponentId('inventory:items'),
    slot: p.getInventory().getSlotForItemId(id), itemId: id, option: 'Drink',
  });
  tick(2); const npc = [...effects.effects.get(p).get('drink_crate_corpse_reviver').npcs][0];
  npc.setNeedsPlacement(false); p.setNeedsPlacement(false);
  const queue = npc.getCombat().getHitQueue(), applied = [], method = core.CombatFactory.getMethod(p);
  for (let i = 0; i < 3; i++) {
    const hit = new core.PendingHit(p, npc, method, { damage: 90, rollAccuracy: false, experience: false });
    hit.getHits()[0].onApplied(amount => applied.push(amount)); queue.addPendingHit(hit, core.World.processCycle + 1);
  }
  queue.process(++core.World.processCycle); assert.deepEqual(applied, [90, 90, 0]);
  tick(20); const own = deaths.filter(e => e.npc === npc);
  assert.equal(own.length, 1); assert.equal(own[0].killer, p); tick(20);
  assert.equal(deaths.filter(e => e.npc === npc).length, 1);
});
