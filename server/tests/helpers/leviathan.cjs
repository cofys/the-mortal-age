const { Server } = require('../../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../../dist/game/cache/CachePipeline');
const { PluginManager } = require('../../dist/plugins/PluginManager');
const { NpcDefinitionLoader } = require('../../dist/game/definition/loader/impl/NpcDefinitionLoader');
const { Player } = require('../../dist/game/entity/impl/player/Player');
let core;
async function initialize() {
  await CachePipeline.initialize(require('node:path').resolve(__dirname, '../..'));
  new NpcDefinitionLoader().load();
  core = PluginManager.getCoreApi();
  core.RegionManager.init();
}
function harness(t, awakened = false, startingHitpoints = 99) {
  // Encounter tests never read or write the live world's scoreboard records.
  const fs = require('node:fs'), path = require('node:path');
  const readFile = fs.readFileSync, writeFile = fs.writeFileSync;
  const scoreboardFile = file => typeof file === 'string' && path.basename(file) === 'leviathan-scoreboard.json';
  t.mock.method(fs, 'readFileSync', (file, ...args) => scoreboardFile(file) ? '{}' : readFile(file, ...args));
  t.mock.method(fs, 'writeFileSync', (file, ...args) => { if (!scoreboardFile(file)) return writeFile(file, ...args); });
  const Common = require('../../plugins/bosses/leviathan/Common.Leviathan');
  const hooks = new Map(), custom = new Map(), tasks = [], spawned = [], emitted = [], messages = [];
  let cycle = 0;
  const dispatch = (name, event) => { for (const fn of hooks.get(name) || []) fn(event); };
  const on = name => fn => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); };
  const p = new Player(null);
  p.setUsername('leviathan-regression');
  const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' || name === 'getVarp' ? () => 0 : () => sender });
  p.getPacketSender = () => sender;
  p.sendMessage = text => messages.push(text);
  p.isRegistered = () => true;
  p.busy = () => false;
  p.performAnimation = () => {};
  p.performGraphic = () => {};
  p.performGraphicInSlot = () => {};
  p.addTickHit = () => {};
  p.getSkillManager().setCurrentLevel(core.Skill.HITPOINTS, startingHitpoints);
  p.getSkillManager().setMaxLevels(core.Skill.HITPOINTS, 99);
  p.getSkillManager().setCurrentLevel(core.Skill.PRAYER, 99);
  const api = new Proxy({
    core,
    persistAttribute() {}, registerNpcCombatMethodProvider() {},
    spawnNpc(def) {
      const npc = core.NPC.create(def.id, new core.Location(def.x, def.y, def.z || 0));
      npc.isRegistered = () => !npc.__testRemoved;
      if (def.owner) npc.setOwner(def.owner);
      npc.setOwnerOnly(!!def.ownerOnly);
      spawned.push(npc);
      return npc;
    },
    removeNpc(npc) { npc.__testRemoved = true; },
    onCustomEvent(name, fn) { if (!custom.has(name)) custom.set(name, []); custom.get(name).push(fn); },
    emitCustomEvent(name, event) {
      emitted.push([name, event]);
      for (const fn of custom.get(name) || []) fn(event);
    },
    getItemOnGroundManager: () => ({ registerLocation() {} }),
    log() {},
  }, { get: (api, name) => api[name] ?? on(name) });
  t.mock.method(core.World, 'getProcessCycle', () => cycle);
  t.mock.method(core.TaskManager, 'submit', task => { task.setRunning(true); tasks.push(task); });
  t.mock.method(PluginManager, 'emitNpcBeforeDeath', event => { dispatch('onNpcBeforeDeath', event); return event.preventDeath; });
  t.mock.method(PluginManager, 'emitNpcDeath', event => dispatch('onNpcDeath', event));
  t.mock.method(PluginManager, 'emitNpcHitModify', (npc, hit) => { dispatch('onNpcHitModify', { npc, hit }); return hit; });
  t.mock.method(PluginManager, 'emitCombatHitRoll', event => dispatch('onCombatHitRoll', event));
  t.mock.method(PluginManager, 'emitPlayerDealtDamage', event => dispatch('onPlayerDealtDamage', event));
  t.mock.method(PluginManager, 'emitCustomEvent', (name, event) => api.emitCustomEvent(name, event));
  Common.init(api);
  const { width, height, planes, sourceChunkX, sourceChunkY } = Common.data.instance;
  const area = new core.TemplatedInstanceArea(width, height);
  for (const plane of planes) for (let x = 0; x < width; x++) for (let y = 0; y < height; y++)
    area.setChunk(plane, x, y, { sourceChunkX: sourceChunkX + x, sourceChunkY: sourceChunkY + y, sourcePlane: plane, rotation: 0 });
  const session = { player: p, area, awakened, ended: false, perfectKills: 0,
    tile: tile => Common.tile(area, tile), sourceTile: at => Common.sourceTile(area, at),
    spawn(id, tile) {
      const at = this.tile(tile);
      const npc = api.spawnNpc({ id, x: at.getX(), y: at.getY(), z: at.getZ(), owner: p, ownerOnly: true });
      npc.__skipDefaultRespawn = true;
      area.add(npc);
      return npc;
    },
  };
  area.add(p);
  p.setLocation(session.tile(Common.data.site.arenaArrival));
  const FightUnit = require('../../plugins/bosses/leviathan/Fight.Leviathan');
  FightUnit.attach(api);
  const fight = new FightUnit.Fight(session);
  session.fight = fight;
  fight.start();
  const move = tile => p.setLocation(session.tile(tile));
  const prayer = style => {
    p.getPrayerActive().fill(false);
    const key = { magic: 'PROTECT_FROM_MAGIC', ranged: 'PROTECT_FROM_MISSILES', melee: 'PROTECT_FROM_MELEE' }[style];
    if (key) p.getPrayerActive()[core.PrayerHandler[key]] = true;
  };
  const step = (ticks = 1) => {
    for (let n = 0; n < ticks; n++) {
      cycle++;
      p.setNeedsPlacement(false);
      for (const npc of spawned) npc.setNeedsPlacement(false);
      fight.boss.getCombat().getHitQueue().process(cycle);
      fight.process();
      p.getCombat().getHitQueue().process(cycle);
      for (const task of [...tasks]) if (task.isRunning()) task.tick();
    }
  };
  const hit = (amount, type = core.CombatType.RANGED) => ({
    damage: [new core.HitDamage(amount, core.HitMask.RED)],
    getAttacker: () => p, getCombatType: () => type,
    getHits() { return this.damage; }, updateTotalDamage() {},
    getTotalDamage() { return this.damage.reduce((s, h) => s + h.getDamage(), 0); },
  });
  t.after(() => {
    fight.stop();
    area.destroy();
    for (const queue of [core.World.getAddNPCQueue(), core.World.getRemoveNPCQueue()])
      for (let i = queue.length - 1; i >= 0; i--) if (spawned.includes(queue[i])) queue.splice(i, 1);
    for (const task of tasks) task.stop();
  });
  return { core, Common, api, hooks, custom, dispatch, p, fight, session, area, spawned, emitted, messages, step, move, prayer, hit,
    get cycle() { return cycle; },
    kill() { fight.boss.getCombat().addDamage(p, 1); fight.boss.setHitpoints(0); },
    apply() { p.setNeedsPlacement(false); p.getCombat().getHitQueue().process(++cycle); },
    applyBoss(hit) {
      p.setNeedsPlacement(false); fight.boss.setNeedsPlacement(false);
      fight.boss.getCombat().getHitQueue().addPendingDamage(hit.getHits());
      fight.boss.getCombat().getHitQueue().process(++cycle);
    },
  };
}
module.exports = { initialize, harness, get core() { return core; } };
