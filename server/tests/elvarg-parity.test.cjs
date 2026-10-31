const assert = require('node:assert/strict');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const core = PluginManager.getCoreApi();
const { setDragonfireProtection } = require('../plugins/combat/DragonfireProtection');
before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
  new (require('../dist/game/definition/loader/impl/NpcDefinitionLoader').NpcDefinitionLoader)().load();
});
let nextIndex = 100;

function setup() {
  const hooks = new Map(), custom = new Map(), spawned = [], removed = [], projectiles = [], persistent = [], areaSounds = [];
  let provider, protectionShield = false, protectionPrayer = false, randomRoll = 0;
  const api = { core: { ...core,
    Misc: { randomInclusive: (min, max) => randomRoll === 'max' ? max : Math.min(max, Math.max(min, randomRoll)) },
    CombatEquipment: { hasDragonProtectionGear: () => protectionShield },
    PrayerHandler: { PROTECT_FROM_MAGIC: 4, isActivated: () => protectionPrayer },
    PendingHit: class {
      constructor(attacker, target, method, config) { Object.assign(this, { attacker, target, method, config, total: 12, bypassed: false }); }
      setTotalDamage(value) { this.total = value; } getTotalDamage() { return this.total; }
      markProtectionBypassed() { this.bypassed = true; }
    },
    Projectile: { createProjectile(...args) { const shot = { args, withAngle(value) { this.angle = value; return this; }, withProgress(value) { this.progress = value; return this; }, sendProjectile() { projectiles.push(this); } }; return shot; } },
  },
    persistAttribute(key, value) { persistent.push([key, value]); },
    onServerStartup(fn) { hooks.set('startup', fn); },
    onCustomEvent(name, fn) { custom.set(name, fn); },
    onNpcDeath(fn) { hooks.set('death', fn); },
    onPlayerLogin(fn) { hooks.set('login', fn); },
    onPlayerLogout(fn) { hooks.set('logout', fn); },
    onPlayerDisconnect(fn) { hooks.set('disconnect', fn); },
    registerNpcCombatMethodProvider(ids, ctor, options) { provider = { ids, ctor, options }; },
    spawnNpc(def) {
      const npc = actor(def.x, def.y, def.z); npc.def = def; npc.getId = () => def.id;
      spawned.push(npc); return npc;
    },
    removeNpc(npc) { removed.push(npc); npc.registered = false; npc.getArea()?.detach(npc); },
  };
  require('../plugins/bosses/Elvarg.plugin').register(api);
  hooks.get('startup')();
  function actor(x, y, z = 0, player = false) {
    const attrs = new Map(), messages = [], graphics = [], animations = [], levels = new Map([[core.Skill.PRAYER, 19]]);
    let area = null, at = new core.Location(x, y, z), target = null, index = nextIndex++;
    const combat = { attack(value) { target = value; }, reset() { target = null; }, getTarget: () => target, getFireImmunityTimer: () => ({ finished: () => true, start() {}, stop() {} }) };
    const actor = { attrs, messages, graphics, animations, levels, hp: 80, registered: true,
      isPlayer: () => player, isNpc: () => !player, getAsPlayer: () => actor, getAsNpc: () => actor,
      getAttribute: key => attrs.get(key), setAttribute: (key, value) => attrs.set(key, value),
      getIndex: () => index, getLocation: () => at, moveTo(value) { at = value; }, getArea: () => area, setArea(value) { area = value; }, getPrivateArea: () => area,
      setForceMovement(value) { actor.forceMovement = value; }, getMovementQueue: () => ({ setBlockMovement(value) { actor.blocked = value; } }), setUntargetable(value) { actor.untargetable = value; },
      getCombat: () => combat, getHitpoints: () => actor.hp, isRegistered: () => actor.registered,
      calculateDistance: () => actor.distance ?? 2,
      performAnimation(value) { animations.push(value); }, performGraphic(value) { graphics.push(value); },
      getPacketSender: () => ({ sendAreaSound(...args) { areaSounds.push(args); } }), sendMessage(value) { messages.push(value); },
      getSkillManager: () => ({ getCurrentLevel: id => levels.get(id), setCurrentLevels(id, value) { levels.set(id, value); } }),
    };
    return actor;
  }
  const emit = (name, player, extra = {}) => { const event = { player, ...extra }; custom.get(name)(event); return event; };
  return { api, hooks, emit, spawned, removed, projectiles, persistent, areaSounds, actor, provider: () => provider,
    protection(shield, prayer, potion = 0) { protectionShield = shield; protectionPrayer = prayer; if (potion) setDragonfireProtection(this.player, { tier: potion, seconds: 60, label: 'antifire potion' }); },
    roll(value) { randomRoll = value; },
    player: actor(2845, 9636, 0, true),
  };
}

function position(actor) { const at = actor.getLocation(); return [at.getX(), at.getY(), at.getZ()]; }

test('wall entry creates one owned quest Elvarg and holds aggression until the force crossing ends', () => {
  const h = setup(), player = h.player, first = h.emit('elvarg:enter', player, { aggressive: false });
  const area = player.getArea(), npc = first.npc;
  assert.equal(first.handled, true); assert.equal(npc.def.id, 816); assert.equal(npc.def.owner, player); assert.equal(npc.def.ownerOnly, true);
  assert.deepEqual(position(npc), [2852, 9637, 0]); assert.equal(npc.getCombat().getTarget(), null);
  assert.equal(area.canAttack(player, npc), false);
  player.moveTo(new core.Location(2847, 9636, 0)); h.emit('elvarg:enter', player, { aggressive: true });
  assert.equal(h.spawned.length, 1); assert.equal(npc.getCombat().getTarget(), player); assert.equal(area.canAttack(player, npc), null);
  const stranger = h.actor(2847, 9636, 0, true); assert.equal(area.canAttack(stranger, npc), false); assert.equal(area.canAttack(npc, stranger), false);
  assert.equal(h.provider().options.singleton, false); assert.ok(h.provider().ids.includes(816));
});

test('Elvarg death retains the private room for the quest corpse and never creates a replacement', () => {
  const h = setup(), player = h.player; player.moveTo(new core.Location(2847, 9636));
  const { npc } = h.emit('elvarg:enter', player), area = player.getArea(); npc.hp = 0;
  h.hooks.get('death')({ npc, killer: player }); area.process(player);
  assert.equal(npc.__skipDefaultRespawn, true); assert.equal(player.getArea(), area); assert.equal(area.isDestroyed(), false);
  assert.deepEqual(position(player), [2847, 9636, 0]); assert.equal(area.canAttack(player, npc), false);
  h.emit('elvarg:enter', player); assert.equal(h.spawned.length, 1);
  player.attrs.set('dragon-slayer:elvarg-killed', 1); player.moveTo(new core.Location(2845, 9636)); h.emit('elvarg:leave', player);
  assert.equal(player.getArea(), null); assert.equal(area.isDestroyed(), true); assert.deepEqual(h.removed, [npc]);
  h.emit('elvarg:enter', player); assert.equal(h.spawned.length, 1); assert.deepEqual(position(player), [2845, 9636, 0]);
});

test('wall leave preserves its destination while disconnect/relogin recover outside the lair', () => {
  for (const hook of ['logout', 'disconnect']) {
    const h = setup(); const { npc } = h.emit('elvarg:enter', h.player);
    h.player.moveTo(new core.Location(2855, 9637)); h.hooks.get(hook)({ player: h.player });
    assert.equal(h.player.getArea(), null); assert.deepEqual(position(h.player), [2845, 9636, 0]); assert.deepEqual(h.removed, [npc]);
    assert.equal(h.player.attrs.get('elvarg:inside-lair'), false);
    assert.equal(h.player.forceMovement, null); assert.equal(h.player.blocked, false); assert.equal(h.player.untargetable, false);
  }
  const h = setup(); h.player.attrs.set('elvarg:inside-lair', true); h.player.moveTo(new core.Location(2855, 9637));
  h.hooks.get('login')({ player: h.player }); assert.deepEqual(position(h.player), [2845, 9636, 0]);
  assert.deepEqual(h.persistent, [['elvarg:inside-lair', false]]);
});

test('captured breath launches six fireblasts, delayed impact, shield message and Prayer drain', () => {
  const h = setup(); h.protection(true, false); h.roll('max');
  const npc = h.actor(2852, 9637), Method = h.provider().ctor, method = new Method();
  assert.equal(method.type(), core.CombatType.MAGIC); method.start(npc, h.player);
  const [hit] = method.hits(npc, h.player);
  assert.equal(npc.animations[0].id, 81); assert.equal(method.attackSpeed(), 4); assert.equal(method.attackDistance(), 8);
  assert.equal(hit.config.delay, 3); assert.equal(hit.config.rollAccuracy, false); assert.equal(hit.total, 10);
  assert.equal(h.player.messages[0], 'Your shield absorbs most of the dragon fire.'); assert.equal(h.player.levels.get(core.Skill.PRAYER), 18);
  assert.equal(h.projectiles.length, 6);
  assert.deepEqual(h.projectiles.map(p => p.args.slice(2, 7)), [[130, 51, 80, 70, 109], [130, 56, 85, 70, 109], [130, 61, 90, 70, 109], [130, 66, 95, 70, 109], [130, 71, 100, 70, 109], [130, 75, 105, 70, 109]]);
  assert.ok(h.projectiles.every(p => p.progress === 200 && p.angle === 23));
  assert.deepEqual([h.player.graphics[0].id, h.player.graphics[0].delay, h.player.graphics[0].height], [131, 80, 90]);
  assert.deepEqual(h.areaSounds.map(sound => [sound[0], sound[5]]), [[3750, 0], [156, 80]]);
});

test('dragonfire protection matrix and floor Prayer drain match the quest dragon', () => {
  for (const [shield, prayer, potion, maximum] of [[false,false,0,70],[true,false,0,10],[false,true,0,55],[false,false,1,55],[false,true,1,40],[true,true,0,7],[true,false,1,7],[true,true,1,4],[false,false,2,0]]) {
    const h = setup(); h.protection(shield, prayer, potion); h.roll('max'); h.player.levels.set(core.Skill.PRAYER, 9);
    const method = new (h.provider().ctor)(); method.start(h.actor(2852, 9637), h.player);
    assert.equal(method.hits(h.actor(2852, 9637), h.player)[0].total, maximum, JSON.stringify([shield, prayer, potion]));
    assert.equal(h.player.levels.get(core.Skill.PRAYER), 9);
  }
});

test('melee is capped at eight and does not inherit another encounter breath selection', () => {
  const h = setup(), npc = h.actor(2852, 9637); npc.distance = 1; h.roll(1);
  const melee = new (h.provider().ctor)(), breath = new (h.provider().ctor)();
  melee.start(npc, h.player); assert.equal(melee.type(), core.CombatType.MELEE);
  assert.equal(melee.hits(npc, h.player)[0].total, 8); assert.equal(melee.hits(npc, h.player)[0].config.delay, 1);
  assert.equal(npc.animations.at(-1).id, 80); assert.equal(breath.type(), core.CombatType.MAGIC); assert.equal(h.projectiles.length, 0);
});

test('canonical quest NPC definitions retain the eighty hitpoint dragon and captured death', () => {
  for (const id of [816, 8033]) {
    const definition = core.NpcDefinition.forId(id);
    assert.equal(definition.getHitpoints(), 80);
    if (id === 816) { assert.equal(definition.getSize(), 4); assert.equal(definition.isAggressive(), false); }
    assert.equal(definition.getAttackSpeed(), 4); assert.equal(definition.getDeathAnim(), 4642);
  }
});
