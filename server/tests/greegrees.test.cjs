// Run after `yarn build`: node --test tests/greegrees.test.cjs
const assert = require("node:assert/strict");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Location } = require("../dist/game/model/Location");
const Greegrees = require("../plugins/items/Greegrees.plugin");

let core;
let area;
const hooks = { canEquip: null, events: {} };

before(async () => {
  await CachePipeline.initialize();
  core = PluginManager.getCoreApi();
  Greegrees.register({
    core,
    registerArea: (registered) => { area = registered; },
    onCanEquip: (handler) => { hooks.canEquip = handler; },
    onCustomEvent: (name, handler) => { hooks.events[name] = handler; },
  });
});

const KARAMJAN = 4031;
const SMALL_NINJA = 4024;
const LARGE_ZOMBIE = 4030;
const MARIM = [2755, 2785, 0];
const ZOO = [2600, 3280, 0];
const LUMBRIDGE = [3222, 3218, 0];

function createPlayer([x, y, z], { weapon = -1, target = null } = {}) {
  let location = new Location(x, y, z);
  let transmog = -1;
  let running = true;
  const worn = Array.from({ length: 14 }, () => new core.Item(-1, 0));
  worn[core.Equipment.WEAPON_SLOT] = new core.Item(weapon, weapon > 0 ? 1 : 0);
  const attributes = new Map();
  const state = { messages: [], sounds: [], graphics: [], spellbookOpened: 0, spellbookClosed: 0, configs: [] };
  const sender = {
    closeSubInterface: () => { state.spellbookClosed++; return sender; },
    sendInterfaceFlagsRange: () => sender,
    sendClientScript: () => sender,
    sendSoundEffect: (id) => { state.sounds.push(id); return sender; },
    sendTabInterface: () => { state.spellbookOpened++; return sender; },
    sendConfig: (id, value) => { state.configs.push([id, value]); return sender; },
  };
  const player = {
    state,
    worn,
    isPlayer: () => true,
    getLocation: () => location,
    moveTo: (next) => { location = next; },
    getEquipment: () => ({ getItems: () => worn }),
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getNpcTransformationId: () => transmog,
    setNpcTransformationId: (id) => { transmog = id; return player; },
    getUpdateFlag: () => ({ flag() {} }),
    getPacketSender: () => sender,
    performGraphic: (graphic) => state.graphics.push(graphic.getId()),
    getSpellbook: () => ({ getInterfaceId: () => 218 }),
    sendMessage: (message) => state.messages.push(message),
    getCombat: () => ({ getTarget: () => target, getAttacker: () => null }),
    isRunningReturn: () => running,
    setRunning: (value) => { running = value; return player; },
  };
  return player;
}

function login(player) {
  hooks.events["player:bootstrap-complete"]({ player });
}

function wield(player, itemId) {
  const event = { player, item: new core.Item(itemId, 1), slot: core.Equipment.WEAPON_SLOT, allow: null };
  hooks.canEquip(event);
  if (event.allow === false) return false;
  player.worn[core.Equipment.WEAPON_SLOT] = new core.Item(itemId, 1);
  hooks.events["equipment:changed"]({ player });
  return true;
}

function unwield(player) {
  player.worn[core.Equipment.WEAPON_SLOT] = new core.Item(-1, 0);
  hooks.events["equipment:changed"]({ player });
}

function form(player) {
  const request = { player, form: null };
  hooks.events["greegree:form"](request);
  return request.form;
}

test("every greegree turns the player into its own monkey, an NPC the cache has", () => {
  for (const [itemId, entry] of Greegrees._test.FORMS) {
    assert.ok(core.CacheDefinitions.getItem(itemId)?.name?.endsWith("greegree"), `item ${itemId}`);
    assert.ok(core.CacheDefinitions.getNpc(entry.npc)?.name, `npc ${entry.npc}`);
  }
});

test("wielding on Ape Atoll transforms with the captured graphic and form sound, and closes the spellbook", () => {
  const player = createPlayer(MARIM);
  login(player);
  assert.equal(wield(player, KARAMJAN), true);
  assert.equal(player.getNpcTransformationId(), 1469);
  assert.deepEqual(player.state.graphics, [160]);
  assert.deepEqual(player.state.sounds, [1677]);
  assert.equal(player.state.spellbookClosed, 1);
  assert.deepEqual(player.state.messages, [], "no chat message (rsprox 1440)");
  assert.equal(form(player), "karamjan-monkey");

  unwield(player);
  assert.equal(player.getNpcTransformationId(), -1);
  assert.equal(player.state.spellbookOpened, 1, "the spellbook comes back");
  assert.equal(form(player), null);
});

test("swapping one greegree for another changes form; the Ardougne Zoo works too (Wiki)", () => {
  const player = createPlayer(ZOO);
  login(player);
  wield(player, KARAMJAN);
  wield(player, SMALL_NINJA);
  assert.equal(player.getNpcTransformationId(), 1462);
  assert.equal(form(player), "small-ninja-monkey");
});

test("a greegree can't be wielded off the island or in combat (rsprox 3342)", () => {
  const away = createPlayer(LUMBRIDGE);
  login(away);
  assert.equal(wield(away, KARAMJAN), false);
  assert.equal(away.getNpcTransformationId(), -1);

  const fighting = createPlayer(MARIM, { target: {} });
  login(fighting);
  assert.equal(wield(fighting, KARAMJAN), false);
  assert.deepEqual(fighting.state.messages, ["You cannot use this whilst in combat."]);
});

test("logging in on the island wearing one is a monkey again, without the effects", () => {
  const player = createPlayer(MARIM, { weapon: SMALL_NINJA });
  hooks.events["equipment:changed"]({ player });
  assert.equal(player.getNpcTransformationId(), -1, "equipment changes during login are ignored");
  login(player);
  assert.equal(player.getNpcTransformationId(), 1462);
  assert.deepEqual(player.state.sounds, []);
});

test("monkeys on the island leave a transformed player alone; zombie forms can only walk", () => {
  const player = createPlayer(MARIM);
  login(player);
  assert.equal(area.npcAggression(player, {}), null);
  wield(player, LARGE_ZOMBIE);
  assert.deepEqual(player.state.sounds, [1680], "rsprox 3342");
  assert.equal(area.npcAggression(player, {}), false);
  area.process(player);
  assert.equal(player.isRunningReturn(), false);
  assert.deepEqual(player.state.configs, [[173, 0]]);
});

test("a monkey can't attack", () => {
  const player = createPlayer(MARIM);
  login(player);
  assert.equal(area.canAttack(player, {}), null);
  wield(player, SMALL_NINJA);
  assert.equal(area.canAttack(player, {}), false);
  assert.deepEqual(player.state.messages, ["You can't attack while you're a monkey."]);
  const npc = { isPlayer: () => false };
  assert.equal(area.canAttack(npc, player), null, "monkeys can still be attacked");
});

test("leaving by logging out keeps the greegree on", () => {
  const player = createPlayer(MARIM);
  login(player);
  wield(player, KARAMJAN);
  area.postLeave(player, true);
  assert.equal(player.worn[core.Equipment.WEAPON_SLOT].getId(), KARAMJAN);
});

test("the island, its dungeons and the zoo pen are the places it works", () => {
  const { canTransformAt } = Greegrees._test;
  for (const tile of [MARIM, [2798, 2798, 1], [2808, 9200, 0], ZOO]) {
    assert.equal(canTransformAt(new Location(...tile)), true, tile.join(","));
  }
  for (const tile of [LUMBRIDGE, [2600, 3280, 1], [2900, 3150, 0]]) {
    assert.equal(canTransformAt(new Location(...tile)), false, tile.join(","));
  }
});
