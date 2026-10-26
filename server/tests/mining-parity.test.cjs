// From server/: node --test tests/mining-parity.test.cjs (after yarn build).
// Mining a rock as live OSRS does it: rsprox recordings 3139 and 3182 (iron), 1105/3280 (mithril),
// 73 (no pickaxe) and the Wiki rock pages (level, XP, respawn).
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { PluginManager } = require("../dist/plugins/PluginManager");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");
const { GameObject } = require("../dist/game/entity/impl/object/GameObject");
const { ItemIds } = require("../dist/util/IdEnums");

const core = PluginManager.getCoreApi();
const MINING_PLUGIN = require.resolve("../plugins/skills/Mining.plugin");
let Mining = require(MINING_PLUGIN);

const MINING_SUCCESS_SOUND = 3600;
const SMELT_SOUND = 2725;
const RESPAWN_TIMER_SCRIPT = 5474;
const ORE_MINED_VARP = 4526; // tracking_ore_mined
const noop = () => {};

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
});

function loc(name) {
  return core.CacheDefinitions.getLocId(name);
}

function createPlayer({ pickaxe = ItemIds.RUNE_PICKAXE, level = 99, full = false } = {}) {
  const attributes = new Map();
  const packets = { sounds: [], configs: [], scripts: [] };
  const added = [];
  const dialogues = [];
  const xp = [];
  const sender = {
    sendSoundEffect: (id) => packets.sounds.push(id),
    sendConfig: (id, value) => packets.configs.push([id, value]),
    sendClientScript: (...args) => packets.scripts.push(args),
  };
  const player = {
    packets, added, dialogues, xp, messages: [], animations: [], graphics: [],
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getPacketSender: () => sender,
    getDialogueManager: () => ({ startDialogues: (chain) => dialogues.push(chain) }),
    getInventory: () => ({
      contains: (id) => id === pickaxe,
      isFull: () => full,
      adds: (id, amount) => added.push([id, amount]),
      getItems: () => [],
    }),
    getEquipment: () => ({ getItems: () => [] }),
    getSkillManager: () => ({
      getCurrentLevel: () => level,
      addExperiences: (skill, amount) => xp.push([skill, amount]),
    }),
    getMovementQueue: () => ({ size: () => 0 }),
    getForceMovement: () => null,
    getHitpoints: () => 10,
    isRegistered: () => true,
    getLocation: () => new core.Location(3285, 3367, 0),
    sendMessage(text) { player.messages.push(text); },
    performAnimation(animation) { player.animations.push(animation.getId()); },
    performGraphic(graphic) { player.graphics.push([graphic.id, graphic.height]); },
  };
  return player;
}

function harness() {
  const interactions = new Map();
  const hooks = {};
  const tasks = [];
  const registered = [];
  const events = {};
  const api = new Proxy({
    core,
    getTaskManager: () => ({ submit(task) { task.setRunning(true); tasks.push(task); } }),
    getObjectManager: () => ({ register: (object) => registered.push(object), deregister: noop }),
    onObjectInteraction: (name, actions) => interactions.set(name, actions),
    onPlayerLogin: (fn) => { hooks.login = fn; },
    onCustomEvent: (key, fn) => { events[key] = fn; },
    emitCustomEvent: noop,
    persistAttribute: noop,
  }, { get: (target, key) => target[key] ?? noop });
  // The plugin keeps its tick counter at module level; each harness is a fresh server.
  delete require.cache[MINING_PLUGIN];
  Mining = require(MINING_PLUGIN);
  Mining.register(api);
  return {
    interactions, hooks, registered,
    tick(count = 1) { while (count-- > 0) [...tasks].forEach((task) => task.tick()); },
  };
}

function mineRock(h, player, name, rockId, x = 3285, y = 3368) {
  const rock = new GameObject(rockId, new core.Location(x, y, 0), 10, 0, null);
  const original = MapObjects.get;
  MapObjects.get = (id) => (id === rock.getId() ? rock : null);
  h.interactions.get(name).Mine({ player, object: rock, definition: { getName: () => name } });
  return { rock, restore: () => { MapObjects.get = original; } };
}

test("rock level, experience and respawn follow the Wiki rock pages", () => {
  const byName = new Map(Mining.ROCKS.map((rock) => [rock.objectName, rock]));
  // Wiki respawn seconds / 0.6 = ticks: iron 5.4 s, silver and gold 1 min, coal 30 s, mithril 2 min,
  // adamantite 4 min, runite 12 min, copper and tin 2.4 s, clay 2 ticks.
  const expected = {
    "Clay rocks": [1, 5, 2], "Copper rocks": [1, 17.5, 4], "Tin rocks": [1, 17.5, 4], "Iron rocks": [15, 35, 9],
    "Silver rocks": [20, 40, 100], "Coal rocks": [30, 50, 50], "Gold rocks": [40, 65, 100],
    "Mithril rocks": [55, 80, 200], "Adamantite rocks": [70, 95, 400], "Runite rocks": [85, 125, 1200],
  };
  for (const [name, [level, xp, respawn]] of Object.entries(expected)) {
    const rock = byName.get(name);
    assert.deepEqual([rock.level, rock.xp, rock.respawnTicks], [level, xp, respawn], name);
  }
});

test("mining iron: swing a tick after the click, live messages, sound, ore counter, rocks2 and the respawn timer", () => {
  const h = harness();
  const player = createPlayer();
  const originalRandom = Math.random;
  Math.random = () => 0;
  const { rock, restore } = mineRock(h, player, "Iron rocks", loc("ironrock2"));
  try {
    assert.deepEqual(player.messages, [], "nothing on the click's own tick");
    h.tick(1);
    assert.deepEqual(player.messages, ["You swing your pick at the rock."]);
    assert.equal(player.animations.length, 1);
    h.tick(8);
    assert.equal(player.messages.at(-1), "You manage to mine some iron.");
    assert.deepEqual(player.added, [[ItemIds.IRON_ORE, 1]]);
    assert.ok(player.packets.sounds.includes(MINING_SUCCESS_SOUND));
    assert.deepEqual(player.packets.configs, [[ORE_MINED_VARP, 1]]);
    assert.equal(player.xp.at(-1)[1], 35);

    const depleted = h.registered[0];
    assert.equal(depleted.getId(), loc("rocks2"), "ironrock2 is mined out as rocks2");
    const [script, coordinate, locId, shape, timer, ticks, colour, zero] = player.packets.scripts.at(-1);
    assert.equal(script, RESPAWN_TIMER_SCRIPT);
    assert.equal(coordinate, (0 << 28) | (rock.getLocation().getX() << 14) | rock.getLocation().getY());
    assert.deepEqual([locId, shape, timer, ticks, colour, zero], [loc("rocks2"), 10, 1, 9, 16765184, 0]);
  } finally {
    restore();
    Math.random = originalRandom;
  }
});

test("the first rock variant is mined out as rocks1", () => {
  const h = harness();
  const player = createPlayer();
  const originalRandom = Math.random;
  Math.random = () => 0;
  const { restore } = mineRock(h, player, "Copper rocks", loc("copperrock1"));
  try {
    h.tick(10);
    assert.equal(h.registered[0].getId(), loc("rocks1"));
    assert.equal(player.messages.at(-1), "You manage to mine some copper.");
  } finally {
    restore();
    Math.random = originalRandom;
  }
});

test("a mined-out rock says it has no ore", () => {
  const h = harness();
  const player = createPlayer();
  for (const name of ["rocks1", "rocks2"]) {
    const event = { player, object: { getId: () => loc(name) } };
    h.interactions.get("Rocks").Mine(event);
    assert.equal(event.handled, true, name);
  }
  assert.deepEqual(player.messages, Array(2).fill("There is currently no ore available in this rock."));
  const other = { player, object: { getId: () => loc("punishrocks") } };
  h.interactions.get("Rocks").Mine(other);
  assert.equal(other.handled, undefined, "other rocks are left to their own plugins");
});

test("failed starts are message boxes with the live wording", () => {
  const h = harness();
  const noPickaxe = createPlayer({ pickaxe: -1 });
  let mined = mineRock(h, noPickaxe, "Iron rocks", loc("ironrock1"));
  mined.restore();
  assert.equal(noPickaxe.dialogues.length, 1);
  assert.deepEqual(noPickaxe.messages, []);

  const lowLevel = createPlayer({ level: 50 });
  mined = mineRock(h, lowLevel, "Mithril rocks", loc("mithrilrock1"));
  mined.restore();
  assert.equal(lowLevel.dialogues.length, 1);

  const full = createPlayer({ full: true });
  mined = mineRock(h, full, "Iron rocks", loc("ironrock1"));
  mined.restore();
  assert.equal(full.dialogues.length, 1);

  const text = (player) => player.dialogues[0].getDialogues().get(0).getText();
  assert.match(text(noPickaxe), /You need a pickaxe to mine this rock\. You do not have a pickaxe which you have the Mining level to use\./);
  assert.match(text(lowLevel), /You need a Mining level of 55 to mine this rock\./);
  assert.match(text(full), /Your inventory is too full to hold any more iron ore\./);
});

test("an infernal pickaxe's smelted ore shows smoke and plays 2725, with the usual mining message", () => {
  const h = harness();
  const player = createPlayer({ pickaxe: ItemIds.INFERNAL_PICKAXE });
  const item = { getId: () => ItemIds.INFERNAL_PICKAXE, getMetaValue: () => undefined, setMetaValue: noop, setId: noop };
  player.getInventory = () => ({
    contains: (id) => id === ItemIds.INFERNAL_PICKAXE, isFull: () => false, adds: (id, amount) => player.added.push([id, amount]),
    getItems: () => [item], refreshItems: noop,
  });
  const originalRandom = Math.random;
  Math.random = () => 0;
  const { restore } = mineRock(h, player, "Iron rocks", loc("ironrock1"));
  try {
    h.tick(10);
    assert.deepEqual(player.added, [], "the ore is destroyed");
    assert.deepEqual(player.graphics.at(-1), [86, 150], "smokepuff");
    assert.ok(player.packets.sounds.includes(SMELT_SOUND));
    assert.ok(player.packets.sounds.includes(MINING_SUCCESS_SOUND));
    assert.equal(player.messages.at(-1), "You manage to mine some iron.");
    assert.deepEqual(player.packets.configs, [], "a smelted ore is not counted as mined");
  } finally {
    restore();
    Math.random = originalRandom;
  }
});

test("the ore counter is sent again on login", () => {
  const h = harness();
  const player = createPlayer();
  player.setAttribute("mining:ores-mined", 7);
  h.hooks.login({ player });
  assert.deepEqual(player.packets.configs, [[ORE_MINED_VARP, 7]]);
});

test("each pickaxe swings its own animation", () => {
  // human_mining_<pickaxe> sequences, as recorded (black 90, crystal 3276, dragon 561, infernal 1634, steel 69, mithril 1098).
  const expected = {
    [ItemIds.BRONZE_PICKAXE]: 625, [ItemIds.IRON_PICKAXE]: 626, [ItemIds.STEEL_PICKAXE]: 627,
    [ItemIds.BLACK_PICKAXE]: 3873, [ItemIds.MITHRIL_PICKAXE]: 629, [ItemIds.ADAMANT_PICKAXE]: 628,
    [ItemIds.RUNE_PICKAXE]: 624, [ItemIds.DRAGON_PICKAXE]: 7139, [ItemIds.CRYSTAL_PICKAXE]: 8347,
    [ItemIds.INFERNAL_PICKAXE]: 4482,
  };
  for (const pickaxe of Mining.PICKAXES) {
    assert.equal(pickaxe.animation.getId(), expected[pickaxe.id], `pickaxe ${pickaxe.id}`);
  }
});

test("quarry sandstone (232/03162): one piece, \"You manage to quarry some sandstone.\", then rocks1 for 9 ticks", () => {
  const h = harness();
  const player = createPlayer();
  const originalRandom = Math.random;
  Math.random = () => 0;
  const { restore } = mineRock(h, player, "Sandstone rocks", loc("enakh_sandstone_rocks"));
  try {
    h.tick(1);
    assert.deepEqual(player.messages, ["You swing your pick at the rock."]);
    h.tick(3);
    assert.equal(player.messages.at(-1), "You manage to quarry some sandstone.");
    assert.deepEqual(player.added, [[core.CacheDefinitions.getObjId("enakh_sandstone_tiny"), 1]]);
    assert.equal(player.xp.at(-1)[1], 30);
    assert.deepEqual(player.packets.configs, [[ORE_MINED_VARP, 1]], "sandstone counts as ore mined, as recorded");
    assert.equal(h.registered.at(-1).getId(), loc("rocks1"));
    assert.equal(player.packets.scripts.at(-1)[0], RESPAWN_TIMER_SCRIPT);
    assert.equal(player.packets.scripts.at(-1)[5], 9);
  } finally {
    Math.random = originalRandom;
    restore();
  }
});

test("quarry rocks (Wiki): sandstone 35 and granite 45; bigger pieces get likelier towards level 99", () => {
  const byName = new Map(Mining.ROCKS.map((rock) => [rock.objectName, rock]));
  const sandstone = byName.get("Sandstone rocks");
  const granite = byName.get("Granite rocks");
  assert.deepEqual([sandstone.level, granite.level], [35, 45]);
  assert.deepEqual([sandstone.petBase, granite.petBase], [741600, 741600], 'Wiki: rock golem and clue geode base for both');
  assert.deepEqual(sandstone.outcomes.map((o) => o.xp), [30, 40, 50, 60]);
  assert.deepEqual(granite.outcomes.map((o) => o.xp), [50, 60, 75]);
  // The 256 roll at the Wiki's chart points: 56.5% at 35 and 92.7% at 99; granite 42.0% at 45, 68.2% at 99.
  const chance = (rock, level) => Math.floor(rock.successLow + (rock.successHigh - rock.successLow) * (level - 1) / 98) / 256;
  assert.ok(Math.abs(chance(sandstone, 35) - 0.565) < 0.01 && Math.abs(chance(sandstone, 99) - 0.927) < 0.01);
  assert.ok(Math.abs(chance(granite, 45) - 0.42) < 0.01 && Math.abs(chance(granite, 99) - 0.682) < 0.01);
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.999;
    assert.equal(Mining.rollOutcome(sandstone, 35).xp, 60, "the top of the roll is the 10kg piece");
    Math.random = () => 0.7;
    assert.equal(Mining.rollOutcome(sandstone, 35).xp, 50, "at 35, 0.7 falls in the 5kg share");
    Math.random = () => 0.55;
    assert.equal(Mining.rollOutcome(sandstone, 35).xp, 40, "at 35, 0.55 is still a 2kg piece");
    assert.equal(Mining.rollOutcome(sandstone, 99).xp, 50, "at 99 the smaller shares have shrunk, so it is 5kg");
  } finally {
    Math.random = originalRandom;
  }
});
