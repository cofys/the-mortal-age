// Witch's House (q127) source contract and recovery tests.
// From server/: node --test tests/qh728-q127.test.cjs
//
// Fixture start: durable stage 0. The cheese, gloves, diary and starting combat
// level are granted by the test and declared where used; every quest transition
// goes through the plugin's registered handlers. Diary/ball ground spawns are
// cache data (ground-items.json 2408 at 2903,3471 and 2407 at 2935,3460), not
// fixture postconditions: the test grants the item only after the handler allows
// the pickup. Live playthrough and the Quest Helper overlay are not covered.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

require('node:test').before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(
    require('node:path').resolve(__dirname, '..'));
});
const { PluginManager } = require('../dist/plugins/PluginManager');
const runtime = require('../plugins/quests/QuestRuntime');
const core = PluginManager.getCoreApi();

const transcripts = [];
const originalStartTranscript = runtime.startTranscript;
after(() => { runtime.startTranscript = originalStartTranscript; });
runtime.startTranscript = (_api, _player, npcId, page, variant) => {
  transcripts.push({ npcId, page, variant });
  return true;
};

const N = core.NpcIdentifiers;
const I = core.ItemIdentifiers;
const O = core.ObjectIdentifiers;
const BOY = N.BOY;
const MOUSE = N.MOUSE;
const EXPERIMENT_FORMS = [
  N.WITCHS_EXPERIMENT,
  N.WITCHS_EXPERIMENT_SECOND_FORM_,
  N.WITCHS_EXPERIMENT_THIRD_FORM_,
  N.WITCHS_EXPERIMENT_FOURTH_FORM_,
];
const VARP_WITCHS_HOUSE = 226;
const CACHE_COMPLETION_THRESHOLD = 7;
const DOOR_TILE = { x: 2900, y: 3473, z: 0 };
const BACK_DOOR_TILE = { x: 2901, y: 3465, z: 0 };
const SHED_DOOR_TILE = { x: 2934, y: 3463, z: 0 };
const BALL_SPAWN_TILE = { x: 2935, y: 3460, z: 0 };
const EXPERIMENT_TILE = { x: 2935, y: 3462, z: 0 };

function setup({ combatLevel = 35 } = {}) {
  const stubs = {
    ObjectManager: { register() {}, deregister() {} },
    GameObject: class {
      constructor(id, location, type, rotation) {
        this.id = id;
        this.location = location;
        this.type = type;
        this.rotation = rotation;
      }
      getId() { return this.id; }
      getLocation() { return this.location; }
    },
    ItemDefinition: { forId: () => ({ getName: () => '', isNoted: () => false }) },
  };
  let ballSpawn = true;
  const worldItems = [{
    getItem: () => ({ getId: () => I.BALL }),
    getPosition: () => new core.Location(BALL_SPAWN_TILE.x, BALL_SPAWN_TILE.y, BALL_SPAWN_TILE.z),
  }];
  const questCore = { ...core, ...stubs, World: { getItems: () => ballSpawn ? worldItems : [] }, CountdownTask: undefined, TaskManager: undefined };

  const custom = new Map();
  const variants = [];
  const conditions = [];
  const objectHandlers = [];
  const npcBeforeDeath = [];
  const loginHandlers = [];
  const logoutHandlers = [];
  const itemOnObject = [];
  const itemOnNpc = [];
  const itemActions = [];
  const groundPickup = [];
  const spawned = [];
  const groundItems = [];
  const areas = [];
  const configs = new Map();
  const varbits = new Map();
  const messages = [];
  const itemAmounts = new Map();
  const xp = new Map();
  let combat = combatLevel;
  let location = new core.Location(0, 0, 0);
  let gloves = null;
  let freeSlots = 28;
  let localNpcs = [];
  let nextSpawn = 0;

  const api = new Proxy({
    core: questCore,
    persistAttribute() {},
    onNpcDialogueVariant(handler) { variants.push(handler); },
    onNpcDialogueCondition(handler) { conditions.push(handler); },
    onItemOnNpc(handler) { itemOnNpc.push(handler); },
    onItemOnObject(handler) { itemOnObject.push(handler); },
    onItemAction(handler) { itemActions.push(handler); },
    onObjectInteraction(handler) { objectHandlers.push(handler); },
    onNpcBeforeDeath(handler) { npcBeforeDeath.push(handler); },
    onGroundItemPickup(handler) { groundPickup.push(handler); },
    onPlayerLogin(handler) { loginHandlers.push(handler); },
    onPlayerLogout(handler) { logoutHandlers.push(handler); },
    registerArea(area) { areas.push(area); },
    onCustomEvent(name, handler) {
      const handlers = custom.get(name) ?? [];
      handlers.push(handler);
      custom.set(name, handlers);
    },
    emitCustomEvent(name, event) {
      for (const handler of custom.get(name) ?? []) handler(event);
    },
    spawnNpc(spec) {
      const npc = {
        id: spec.id,
        index: nextSpawn++,
        owner: spec.owner,
        ownerOnly: spec.ownerOnly,
        getOwner() { return this.owner; },
        getId() { return this.id; },
        getLocation() { return new core.Location(spec.x, spec.y, spec.z); },
        getSpawnLocation() { return new core.Location(spec.x, spec.y, spec.z); },
        isRegistered() { return true; },
        setMaxHitpoints() { return this; },
        setHitpoints() { return this; },
      };
      spawned.push(npc);
      return npc;
    },
    removeNpc(npc) {
      const index = spawned.indexOf(npc);
      if (index !== -1) spawned.splice(index, 1);
    },
    getItemOnGroundManager() {
      return { registerLocation(player, item, location) { groundItems.push({ player, item, location }); } };
    },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });

  require('../plugins/quests/quests/WitchsHouse.Quest')(api);
  const quest = runtime.getRegisteredQuests().findLast((entry) => entry.key === 'witchs_house');

  const inventory = {
    getAmount: (id) => itemAmounts.get(id) ?? 0,
    adds(id, amount = 1) {
      if (freeSlots <= 0) return inventory;
      itemAmounts.set(id, (itemAmounts.get(id) ?? 0) + amount);
      freeSlots -= amount;
      return inventory;
    },
    deleteNumber(id, amount = 1) {
      const taken = Math.min(itemAmounts.get(id) ?? 0, amount);
      itemAmounts.set(id, (itemAmounts.get(id) ?? 0) - taken);
      freeSlots += taken;
      return inventory;
    },
    forceAdd(_player, item) {
      itemAmounts.set(item.getId(), (itemAmounts.get(item.getId()) ?? 0) + item.getAmount());
      return true;
    },
    isFull: () => freeSlots <= 0,
    getFreeSlots: () => freeSlots,
    get: () => null,
  };

  const sender = new Proxy({
    sendVarbit(id, value) { varbits.set(id, value); return sender; },
    sendConfig(id, value) { configs.set(id, value); return sender; },
    sendString(text, uid) { messages.push({ text, uid }); return sender; },
  }, { get(target, key) { return key in target ? target[key] : () => sender; } });

  const attributes = new Map();
  const player = {
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getInventory: () => inventory,
    getPacketSender: () => sender,
    getDialogueManager: () => ({ isActive: () => false, getCurrent: () => null }),
    getSkillManager: () => ({
      getCombatLevel: () => combat,
      getCurrentLevel: () => 99,
      addExperiences(skill, amount) {
        xp.set(skill.getIndex(), (xp.get(skill.getIndex()) ?? 0) + amount);
        return true;
      },
      setCurrentLevel() {},
    }),
    getEquipment: () => ({ get: () => gloves }),
    getLocalNpcs: () => localNpcs,
    getLocation: () => location,
    moveTo(next) { location = next; },
    getUsername: () => 'qh728-q127',
    sendMessage: (message) => messages.push(message),
    isRegistered: () => true,
    isPlayerBot: () => false,
  };

  const variant = (npcId = BOY) => {
    const result = variants.map((handler) => handler({ player, npcId })).find(Boolean);
    return typeof result === 'string' ? { variant: result } : result ?? null;
  };
  const condition = (text) => {
    for (const handler of conditions) {
      const answer = handler({ player, text, stepId: 'ESp3PE' });
      if (answer !== null && answer !== undefined) return answer;
    }
    return null;
  };
  const hook = (name) => {
    for (const handler of custom.get('npc-dialogue:hook') ?? []) {
      handler({ player, npcId: BOY, hook: name });
    }
  };
  const action = (stepId, npcId = BOY) => {
    const event = { player, npcId, stepId, handled: false };
    for (const handler of custom.get('npc-dialogue:action') ?? []) handler(event);
    return event;
  };
  const object = (objectId, { location: tile = location, face = 0, type = 0 } = {}) => {
    const at = new core.Location(
      tile.getX?.() ?? tile.x,
      tile.getY?.() ?? tile.y,
      tile.getZ?.() ?? tile.z,
    );
    const event = {
      player,
      objectId,
      object: { getType: () => type, getFace: () => face, getLocation: () => at },
      location: { x: at.getX(), y: at.getY(), z: at.getZ() },
      clickType: 1,
      handled: false,
    };
    for (const handler of objectHandlers) {
      handler(event);
      if (event.handled) break;
    }
    return event;
  };
  const onObject = (itemId, objectId, extra = {}) => {
    const event = { player, itemId, objectId, handled: false, ...extra };
    for (const handler of itemOnObject) handler(event);
    return event;
  };
  const onNpc = (itemId, npcId, target = spawned.find(npc => npc.id === npcId)) => {
    const event = { player, itemId, npcId, target, handled: false };
    for (const handler of itemOnNpc) handler(event);
    return event;
  };
  const itemAction = (itemId, option = 'Read') => {
    const event = { player, itemId, slot: 0, clickType: 1, option, handled: false };
    for (const handler of itemActions) handler(event);
    return event;
  };
  const pickup = (groundItemId, tile = location) => {
    const event = {
      player,
      groundItemId,
      groundItem: { getId: () => groundItemId },
      location: { x: tile.getX?.() ?? tile.x, y: tile.getY?.() ?? tile.y, z: tile.getZ?.() ?? tile.z },
      handled: false,
    };
    for (const handler of groundPickup) handler(event);
    return event;
  };
  const beforeDeath = (npc) => {
    const event = { npc, preventDeath: false };
    for (const handler of npcBeforeDeath) handler(event);
    return event;
  };
  const processAreas = () => {
    const mobile = { isPlayer: () => true, getAsPlayer: () => player };
    for (const area of areas) area.process(mobile);
  };

  return {
    quest, player, attributes, itemAmounts, configs, varbits, messages, spawned, groundItems, xp, areas,
    variant, condition, hook, action, object, onObject, onNpc, itemAction, pickup, beforeDeath, processAreas,
    setLocation(x, y, z = 0) { location = new core.Location(x, y, z); },
    getLocation: () => location,
    setGloves(item) { gloves = item; },
    setFreeSlots(value) { freeSlots = value; },
    setLocalNpcs(list) { localNpcs = list; },
    setBallSpawnPresent(value) { ballSpawn = value; },
    give(id, amount = 1) { itemAmounts.set(id, (itemAmounts.get(id) ?? 0) + amount); },
    setCombatLevel(value) { combat = value; },
    setStage(value) { attributes.set('quest.witchs_house.stage', value); },
    login() { for (const handler of loginHandlers) handler({ player }); },
    logout() { for (const handler of logoutHandlers) handler({ player }); },
  };
}

function assertTranscript(variant) {
  assert.equal(transcripts.at(-1)?.variant, variant);
}

test('fresh stage 0 follows the mandatory route and completes on varp 226 = 7', () => {
  const h = setup();
  const { quest, player } = h;
  const stage = () => quest.getStage(player);

  assert.equal(stage(), 0);
  assert.equal(h.variant()?.variant, 'getting-started');
  assert.equal(h.condition('If the player is below level 10 combat:'), false);

  // The front door refuses before the quest starts and before the key is found.
  h.setLocation(DOOR_TILE.x, DOOR_TILE.y);
  h.object(O.DOOR_102, { location: DOOR_TILE, face: 2 });
  assert.deepEqual([h.getLocation().getX(), h.getLocation().getY()], [DOOR_TILE.x, DOOR_TILE.y]);
  assert.ok(h.messages.some((line) => String(line).includes('rude to break into this house')));

  h.hook('quest:witch-s-house:start');
  assert.equal(stage(), 1);
  assert.equal(h.configs.get(VARP_WITCHS_HOUSE), 1);
  assert.equal(h.variant()?.variant, 'getting-started-talking-to-him-again');

  h.object(O.DOOR_102, { location: DOOR_TILE, face: 2 });
  assertTranscript('the-witch-s-house-attempting-to-open-the-garden-door-without-unlocking-it');

  // Potted plant door key, and the repeat search does not duplicate it.
  h.object(O.POTTED_PLANT_3);
  assert.equal(h.itemAmounts.get(I.DOOR_KEY), 1);
  assertTranscript('the-witch-s-house-searching-the-plant-pot-for-the-key');
  h.object(O.POTTED_PLANT_3);
  assert.equal(h.itemAmounts.get(I.DOOR_KEY), 1);
  assertTranscript('the-witch-s-house-searching-the-plant-pot-for-the-key-searching-the-plant-pot-with-a-key-already');

  h.object(O.DOOR_102, { location: DOOR_TILE, face: 2 });
  assert.deepEqual([h.getLocation().getX(), h.getLocation().getY()], [2901, 3473]);

  // Back door is still locked until the mouse mechanism is used.
  h.setLocation(BACK_DOOR_TILE.x, BACK_DOOR_TILE.y);
  h.object(O.DOOR_103, { location: BACK_DOOR_TILE, face: 1 });
  assert.ok(h.messages.some((line) => line === 'This door is locked.'));

  // Basement ladder round trip, then the electrified gate with and without gloves.
  h.setLocation(2907, 3476);
  h.object(O.LADDER_322);
  assert.deepEqual([h.getLocation().getX(), h.getLocation().getY()], [2907, 9876]);
  h.object(O.LADDER_321);
  assert.deepEqual([h.getLocation().getX(), h.getLocation().getY()], [2907, 3476]);
  h.object(O.LADDER_322);

  h.setLocation(2903, 9874);
  h.object(O.GATE_66, { location: { x: 2902, y: 9874, z: 0 }, face: 2 });
  assertTranscript('the-witch-s-house-attempting-to-open-the-gate-without-correct-gloves');
  assert.deepEqual([h.getLocation().getX(), h.getLocation().getY()], [2903, 9874]);
  h.setGloves({ getId: () => I.LEATHER_GLOVES });
  h.object(O.GATE_66, { location: { x: 2902, y: 9874, z: 0 }, face: 2 });
  assert.deepEqual([h.getLocation().getX(), h.getLocation().getY()], [2901, 9874]);

  // Cupboard magnet advances stage 1 -> 2; open and search variants are the same leg.
  h.setLocation(2898, 9873);
  h.object(O.CUPBOARD_24);
  assert.equal(h.itemAmounts.get(I.MAGNET), 1);
  assert.equal(stage(), 2);
  assertTranscript('the-witch-s-house-searching-the-cupboard-for-the-magnet');
  h.object(O.CUPBOARD_25);
  assert.equal(h.itemAmounts.get(I.MAGNET), 1);
  assertTranscript('the-witch-s-house-searching-the-cupboard-for-the-magnet-searching-the-cupboard-again-with-a-magnet-already');

  h.setLocation(2907, 9876);
  h.object(O.LADDER_321);
  assert.deepEqual([h.getLocation().getX(), h.getLocation().getY()], [2907, 3476]);

  // Cheese on the mouse hole spawns the mouse; magnet on the mouse unlocks the back door.
  h.give(I.CHEESE, 1);
  h.setLocation(2903, 3466);
  h.onObject(I.CHEESE, 2870);
  assert.equal(h.itemAmounts.get(I.CHEESE) ?? 0, 0);
  const mouse = h.spawned.find((npc) => npc.id === MOUSE);
  assert.ok(mouse, 'the mouse hole spawns the quest mouse');
  assertTranscript('the-witch-s-house-after-dropping-cheese-in-front-of-the-mouse-hole');
  h.onNpc(I.MAGNET, MOUSE);
  assert.equal(h.itemAmounts.get(I.MAGNET) ?? 0, 0);
  assert.equal(stage(), 3);
  assert.ok(!h.spawned.includes(mouse), 'the mouse leaves after the magnet is used');
  assertTranscript('the-witch-s-house-using-a-magnet-on-the-mouse');

  // Diary read is the helper checkpoint key 5. The diary itself is cache ground spawn 2408.
  h.give(I.DIARY, 1);
  h.itemAction(I.DIARY, 'Read');
  assert.equal(stage(), 5);

  // Fountain shed key, repeat search keeps a single key.
  h.object(O.FOUNTAIN_4);
  assert.equal(h.itemAmounts.get(I.KEY_9), 1);
  assertTranscript('getting-past-the-witch-searching-the-fountain-in-the-garden');
  h.object(O.FOUNTAIN_4);
  assert.equal(h.itemAmounts.get(I.KEY_9), 1);
  assertTranscript('getting-past-the-witch-searching-the-fountain-in-the-garden-searching-the-fountain-again-whilst-holding-the-key');

  // Shed door: locked without the key, then entry spawns the first experiment form.
  h.setLocation(2933, 3463);
  const shedLocation = { x: SHED_DOOR_TILE.x, y: SHED_DOOR_TILE.y, z: 0 };
  const key = h.itemAmounts.get(I.KEY_9);
  h.itemAmounts.set(I.KEY_9, 0);
  h.object(O.DOOR_104, { location: shedLocation, face: 0 });
  assertTranscript('getting-past-the-witch-attempting-to-open-the-shed-door-without-the-key-or-before-using-the-key-on-it');
  h.itemAmounts.set(I.KEY_9, key);
  h.object(O.DOOR_104, { location: shedLocation, face: 0 });
  assert.deepEqual([h.getLocation().getX(), h.getLocation().getY()], [SHED_DOOR_TILE.x, SHED_DOOR_TILE.y]);
  assert.ok(h.spawned.some((npc) => npc.id === EXPERIMENT_FORMS[0]), 'entering the shed spawns the experiment');

  // All four forms; the first three hand over to the next form without dying.
  for (let index = 0; index < EXPERIMENT_FORMS.length; index++) {
    const npc = h.spawned.find((entry) => entry.id === EXPERIMENT_FORMS[index]);
    assert.ok(npc, `form ${index + 1} is present`);
    const event = h.beforeDeath(npc);
    if (index < EXPERIMENT_FORMS.length - 1) {
      assert.equal(event.preventDeath, true);
      assert.equal(stage(), 5);
      assert.ok(!h.spawned.includes(npc));
    } else {
      assert.equal(event.preventDeath, false);
      assert.equal(stage(), 6);
      assert.equal(h.configs.get(VARP_WITCHS_HOUSE), 6);
    }
  }

  // Ball pickup is allowed once the experiment is dead; the core pickup grants it.
  const pickup = h.pickup(I.BALL, BALL_SPAWN_TILE);
  assert.notEqual(pickup.handled, true);
  h.give(I.BALL, 1);

  assert.equal(h.variant()?.variant, 'finishing-up');
  h.action('uyv8q6');
  assert.equal(stage(), 7);
  assert.equal(h.configs.get(VARP_WITCHS_HOUSE), CACHE_COMPLETION_THRESHOLD);
  assert.equal(h.xp.get(core.Skill.HITPOINTS.getIndex()), 6325);
  assert.equal(h.player.getAttribute('quest.points'), 4);
  assert.equal(h.itemAmounts.get(I.BALL) ?? 0, 0);
  assert.equal(h.itemAmounts.get(I.DIARY) ?? 0, 0);
  assert.equal(h.itemAmounts.get(I.DOOR_KEY) ?? 0, 0);
  assert.equal(h.itemAmounts.get(I.KEY_9) ?? 0, 0);
  assert.ok(h.messages.some((line) => String(line).includes("Congratulations, you've completed a quest")));

  // Repeating the hand-in never duplicates the reward.
  h.give(I.BALL, 1);
  h.action('uyv8q6');
  assert.equal(h.xp.get(core.Skill.HITPOINTS.getIndex()), 6325);
  assert.equal(h.player.getAttribute('quest.points'), 4);

  // Canonical post-quest Boy dialogue, and login resends the durable completion wire.
  assert.equal(h.variant()?.page, 'Boy');
  assert.equal(h.variant()?.variant, 'after-witch-s-house');
  h.configs.clear();
  h.login();
  assert.equal(h.configs.get(VARP_WITCHS_HOUSE), CACHE_COMPLETION_THRESHOLD);
  assert.equal(stage(), 7);
  assert.ok(stage() >= CACHE_COMPLETION_THRESHOLD, 'the transmitted value meets cache DB table 0 column 19');
});

test('the helper grabBall fallback spawns the experiment after a relog inside the shed', () => {
  const h = setup();
  const { quest, player } = h;
  h.setStage(3);
  h.setLocation(EXPERIMENT_TILE.x, EXPERIMENT_TILE.y);
  assert.equal(h.spawned.filter((npc) => EXPERIMENT_FORMS.includes(npc.id)).length, 0);

  const first = h.pickup(I.BALL, BALL_SPAWN_TILE);
  assert.equal(first.handled, true, 'the early ball pickup is still blocked');
  assert.equal(quest.getStage(player), 3, 'the attempt does not advance the durable stage');
  const spawned = h.spawned.filter((npc) => EXPERIMENT_FORMS.includes(npc.id));
  assert.equal(spawned.length, 1, "the helper's grabBall fallback spawns one experiment");
  assert.equal(spawned[0].id, EXPERIMENT_FORMS[0]);
  assert.ok(h.messages.some((line) => String(line).includes('shapeshifter')));

  const second = h.pickup(I.BALL, BALL_SPAWN_TILE);
  assert.equal(second.handled, true);
  assert.equal(h.spawned.filter((npc) => EXPERIMENT_FORMS.includes(npc.id)).length, 1, 'no duplicate experiment');
});

test('the level 10 start warning condition follows the player combat level', () => {
  const h = setup({ combatLevel: 5 });
  assert.equal(h.condition('If the player is below level 10 combat:'), true);
  h.setCombatLevel(10);
  assert.equal(h.condition('If the player is below level 10 combat:'), false);
});

test('logout removes the owner-only fight NPCs so a relog cannot leave a hidden duplicate', () => {
  const h = setup();
  h.setStage(3);
  h.setLocation(2933, 3463);
  h.give(I.KEY_9, 1);
  h.object(O.DOOR_104, { location: { x: SHED_DOOR_TILE.x, y: SHED_DOOR_TILE.y, z: 0 }, face: 0 });
  assert.equal(h.spawned.filter((npc) => EXPERIMENT_FORMS.includes(npc.id)).length, 1);
  h.logout();
  assert.equal(h.spawned.filter((npc) => EXPERIMENT_FORMS.includes(npc.id)).length, 0);
});

test('the basement boxes supply leather gloves only in-quest, once, and with inventory space', () => {
  const h = setup();
  const BOXES = 24692;
  const boxes = { x: 2899, y: 9871, z: 0 };
  h.setLocation(2901, 9873);

  // Stage 0 is not in-quest; the boxes are left to default handling.
  const before = h.object(BOXES, { location: boxes });
  assert.equal(before.handled, false);
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES) ?? 0, 0);

  // The player must be in the basement, not just clicking the object id.
  h.setStage(1);
  h.setLocation(2905, 3460);
  h.object(BOXES, { location: boxes });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES) ?? 0, 0);

  // The west room boxes hand out one pair.
  h.setLocation(2901, 9873);
  h.object(BOXES, { location: boxes });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1);
  h.object(BOXES, { location: boxes });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1);
  h.itemAmounts.set(I.LEATHER_GLOVES, 0);
  h.object(BOXES, { location: { x: 2899, y: 9872, z: 0 } });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1);

  // Worn gloves count as already having them; a full inventory blocks the pair.
  h.itemAmounts.set(I.LEATHER_GLOVES, 0);
  h.setGloves({ getId: () => I.LEATHER_GLOVES });
  h.object(BOXES, { location: boxes });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES) ?? 0, 0);
  h.setGloves(null);
  h.setFreeSlots(0);
  h.object(BOXES, { location: boxes });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES) ?? 0, 0);
  assert.ok(h.messages.some((line) => String(line).includes("couldn't hold all those items")));

  // A completed quest no longer hands out the quest gloves.
  h.setFreeSlots(28);
  h.setStage(7);
  h.object(BOXES, { location: boxes });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES) ?? 0, 0);
});

test('every cache box placement in the basement hands out the gloves, the east room before the gate', () => {
  // Cache Boxes (24692) placements, with the room the player has to stand in.
  const placements = [
    { x: 2899, y: 9871, room: 'west' },
    { x: 2899, y: 9872, room: 'west' },
    { x: 2900, y: 9872, room: 'west' },
    { x: 2905, y: 9872, room: 'east' },
    { x: 2906, y: 9872, room: 'east' },
    { x: 2908, y: 9873, room: 'east' },
  ];
  const stand = { west: [2898, 9872], east: [2907, 9873] };

  for (const box of placements) {
    const h = setup();
    h.setStage(1);
    h.setLocation(...stand[box.room]);
    const event = h.object(24692, { location: { x: box.x, y: box.y, z: 0 } });
    assert.equal(event.handled, true, `the box at ${box.x},${box.y} is handled`);
    assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1, `the box at ${box.x},${box.y} hands out a pair`);
    assert.ok(h.messages.some((line) => String(line).includes('leather gloves')));
  }
});

test('the east room boxes are reachable before the electric gate and the west room cannot search them', () => {
  const h = setup();
  h.setStage(1);

  // The player came down the ladder into the east room: the boxes there serve the
  // gloves, which is what the helper's gate step needs before the gate is opened.
  h.setLocation(2907, 9876);
  const east = h.object(24692, { location: { x: 2905, y: 9872, z: 0 } });
  assert.equal(east.handled, true);
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1);

  // Behind the gate the west room is a different room: its boxes are not the
  // source, the east room is.
  const other = setup();
  other.setStage(1);
  other.setLocation(2898, 9872);
  const cross = other.object(24692, { location: { x: 2905, y: 9872, z: 0 } });
  assert.equal(cross.handled, false, 'the west room cannot search the east room box');
  assert.equal(other.itemAmounts.get(I.LEATHER_GLOVES) ?? 0, 0);
});

test('the gloves are handed out once, and a lost pair can be searched for again', () => {
  const h = setup();
  h.setStage(1);
  h.setLocation(2907, 9873);

  h.object(24692, { location: { x: 2905, y: 9872, z: 0 } });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1);

  // A second box does not hand out a second pair.
  h.object(24692, { location: { x: 2906, y: 9872, z: 0 } });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1);
  assert.ok(h.messages.some((line) => String(line).includes('already have a pair of leather gloves')));

  // Losing the pair leaves the boxes able to give it back.
  h.itemAmounts.set(I.LEATHER_GLOVES, 0);
  h.object(24692, { location: { x: 2908, y: 9873, z: 0 } });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1);
});

test('a full inventory blocks the boxes and the cupboard without persisting progress', () => {
  const h = setup();
  h.setStage(1);

  // The boxes yield nothing while the bag is full.
  h.setLocation(2907, 9873);
  h.setFreeSlots(0);
  h.object(24692, { location: { x: 2905, y: 9872, z: 0 } });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES) ?? 0, 0);
  assert.ok(h.messages.some((line) => String(line).includes("couldn't hold all those items")));

  // The cupboard neither gives the magnet nor advances the stage while it is full.
  h.setLocation(2898, 9873);
  const before = transcripts.length;
  h.object(O.CUPBOARD_24);
  assert.equal(h.itemAmounts.get(I.MAGNET) ?? 0, 0);
  assert.equal(h.quest.getStage(h.player), 1, 'the stage stays at the started value');
  assert.equal(transcripts.length, before, 'the magnet transcript does not play');

  // Making room lets both searches succeed.
  h.setFreeSlots(28);
  h.object(O.CUPBOARD_24);
  assert.equal(h.itemAmounts.get(I.MAGNET), 1);
  assert.equal(h.quest.getStage(h.player), 2);
  assertTranscript('the-witch-s-house-searching-the-cupboard-for-the-magnet');

  h.itemAmounts.set(I.LEATHER_GLOVES, 0);
  h.setLocation(2907, 9873);
  h.object(24692, { location: { x: 2905, y: 9872, z: 0 } });
  assert.equal(h.itemAmounts.get(I.LEATHER_GLOVES), 1);
});

test('full-bag plant and fountain searches cannot promise absent keys and can retry', () => {
  const h = setup(); h.setStage(5); h.setFreeSlots(0);
  const count = transcripts.length;
  h.object(O.POTTED_PLANT_3); h.object(O.FOUNTAIN_4);
  assert.equal(h.itemAmounts.get(I.DOOR_KEY) ?? 0, 0);
  assert.equal(h.itemAmounts.get(I.KEY_9) ?? 0, 0);
  assert.equal(transcripts.length, count, 'no key-found transcript before an actual grant');
  h.setFreeSlots(2); h.object(O.POTTED_PLANT_3); h.object(O.FOUNTAIN_4);
  assert.equal(h.itemAmounts.get(I.DOOR_KEY), 1);
  assert.equal(h.itemAmounts.get(I.KEY_9), 1);
});

test('the shed key item-use route opens the shed and a foreign mouse cannot unlock the back door', () => {
  const h = setup(); h.setStage(5); h.give(I.KEY_9); h.setLocation(2933, 3463);
  const at = new core.Location(2934, 3463, 0);
  const used = h.onObject(I.KEY_9, O.DOOR_104, {
    object: { getType: () => 0, getFace: () => 0, getLocation: () => at },
    location: { x: 2934, y: 3463, z: 0 },
  });
  assert.equal(used.handled, true);
  assert.deepEqual([h.getLocation().x, h.getLocation().y], [2934, 3463]);
  assert.ok(h.spawned.some(npc => npc.id === EXPERIMENT_FORMS[0]));

  const m = setup(); m.setStage(2); m.give(I.MAGNET); m.give(I.CHEESE);
  m.onObject(I.CHEESE, 2870);
  m.onNpc(I.MAGNET, MOUSE, { getId: () => MOUSE });
  assert.equal(m.quest.getStage(m.player), 2);
  assert.equal(m.itemAmounts.get(I.MAGNET), 1);
  m.onNpc(I.MAGNET, MOUSE);
  assert.equal(m.quest.getStage(m.player), 3);
});
