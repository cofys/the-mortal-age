// From server/: node --test tests/mining-parity.test.cjs (after yarn build).
// Mining a rock as live OSRS does it: rsprox recordings 3139 and 3182 (iron), 1105/3280 (mithril),
// 73 (no pickaxe), 403 (a gem), and the Wiki rock pages (level, XP, respawn, success chart), Pickaxe
// (ticks between rolls), Skilling success rate and Template:MiningPreGemDropTable.
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

function createPlayer({ pickaxe = ItemIds.RUNE_PICKAXE, level = 99, full = false, amulet = -1 } = {}) {
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
    getEquipment: () => ({ getItems: () => (amulet > 0 ? [null, null, { getId: () => amulet }] : []) }),
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

function harness({ emit = noop } = {}) {
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
    emitCustomEvent: emit,
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
    [ItemIds.INFERNAL_PICKAXE]: 4482, [ItemIds.ECHO_PICKAXE]: 8347,
  };
  for (const pickaxe of Mining.PICKAXES) {
    assert.equal(pickaxe.animation.getId(), expected[pickaxe.id], `pickaxe ${pickaxe.id}`);
  }
});

const itemName = (id) => core.CacheDefinitions.getItem(id).name;

/** Math.random from a list (then `rest`), for one roll at a time: the gem pre-roll comes first. */
function scriptRandom(values, rest = 0.9) {
  const original = Math.random;
  Math.random = () => (values.length ? values.shift() : rest);
  return () => { Math.random = original; };
}

/** A random value on face `face` of the 256-sided roll. */
const face = (n) => (n + 0.5) / 256;

test("quarry sandstone (232/03162): one piece, \"You manage to quarry some sandstone.\", then rocks1 for 9 ticks", () => {
  const h = harness();
  const player = createPlayer();
  const restoreRandom = scriptRandom([], 0);
  const { restore } = mineRock(h, player, "Sandstone rocks", loc("enakh_sandstone_rocks"));
  try {
    h.tick(1);
    assert.deepEqual(player.messages, ["You swing your pick at the rock."]);
    h.tick(1);
    assert.equal(player.messages.at(-1), "You manage to quarry some sandstone.");
    assert.equal(itemName(player.added[0][0]), "Sandstone (10kg)", "the 10kg roll comes first");
    assert.equal(player.added.length, 1);
    assert.equal(player.xp.at(-1)[1], 60);
    assert.deepEqual(player.packets.configs, [[ORE_MINED_VARP, 1]], "sandstone counts as ore mined, as recorded");
    assert.equal(h.registered.at(-1).getId(), loc("rocks1"));
    assert.equal(player.packets.scripts.at(-1)[0], RESPAWN_TIMER_SCRIPT);
    assert.equal(player.packets.scripts.at(-1)[5], 9);
  } finally {
    restoreRandom();
    restore();
  }
});

test("quarry rocks (Wiki): sandstone 35 and granite 45 roll their cascading charts biggest piece first", () => {
  const byName = new Map(Mining.ROCKS.map((rock) => [rock.objectName, rock]));
  const sandstone = byName.get("Sandstone rocks");
  const granite = byName.get("Granite rocks");
  assert.deepEqual([sandstone.level, granite.level], [35, 45]);
  assert.deepEqual([sandstone.petBase, granite.petBase], [741600, 741600], 'Wiki: rock golem and clue geode base for both');
  assert.deepEqual(sandstone.cascade.map((o) => [o.xp, ...o.chance]), [[60, 4, 50], [50, 8, 75], [40, 16, 100], [30, 25, 200]]);
  assert.deepEqual(granite.cascade.map((o) => [o.xp, ...o.chance]), [[75, 6, 64], [60, 8, 75], [50, 16, 100]]);
  assert.equal(sandstone.gems, undefined, "no gem pre-roll on quarry rocks");

  // At 35 the numerators are 21 (10kg), 32 (5kg), 46 (2kg) and 87 (1kg): face 40 fails 10kg and 5kg, hits 2kg.
  const h = harness();
  const player = createPlayer({ pickaxe: ItemIds.MITHRIL_PICKAXE, level: 35 });
  const restoreRandom = scriptRandom([face(40), face(40), face(40)]);
  const { restore } = mineRock(h, player, "Sandstone rocks", loc("enakh_sandstone_rocks"));
  try {
    h.tick(2);
    assert.deepEqual(player.added.map(([id, amount]) => [itemName(id), amount]), [["Sandstone (2kg)", 1]]);
    assert.equal(player.xp.at(-1)[1], 40);
  } finally {
    restoreRandom();
    restore();
  }
  // Every size failed: nothing, and the rock stays.
  const h2 = harness();
  const miss = createPlayer({ pickaxe: ItemIds.MITHRIL_PICKAXE, level: 35 });
  const restoreMiss = scriptRandom([], face(200));
  const mined = mineRock(h2, miss, "Sandstone rocks", loc("enakh_sandstone_rocks"));
  try {
    h2.tick(2);
    assert.deepEqual(miss.added, []);
    assert.deepEqual(h2.registered, []);
  } finally {
    restoreMiss();
    mined.restore();
  }
});

test("each rock rolls the Wiki skilling success chart", () => {
  const charts = {
    "Clay rocks": [128, 400], "Copper rocks": [100, 350], "Tin rocks": [100, 350], "Blurite rocks": [90, 350],
    "Iron rocks": [96, 350], "Barronite rocks": [80, 100], "Silver rocks": [25, 200], "Coal rocks": [16, 100],
    "Gold rocks": [7, 75], "Mithril rocks": [4, 50], "Adamantite rocks": [2, 25], "Runite rocks": [1, 18],
  };
  for (const rock of Mining.ROCKS.filter((entry) => !entry.cascade)) {
    assert.deepEqual(rock.chance, charts[rock.objectName], rock.objectName);
    assert.equal(rock.gems, true, `${rock.objectName} has the gem pre-roll`);
  }
  // Wiki Runite rocks: 17/256 at level 85; the roll succeeds on faces 0-16 only.
  for (const [value, expected] of [[face(16), 1], [face(17), 0]]) {
    const h = harness();
    const player = createPlayer({ level: 85 });
    const restoreRandom = scriptRandom([0, value]);
    const { restore } = mineRock(h, player, "Runite rocks", loc("runiterock1"));
    try {
      h.tick(2);
      assert.equal(player.added.length, expected, `face ${Math.floor(value * 256)}`);
    } finally {
      restoreRandom();
      restore();
    }
  }
});

test("the pickaxe sets only how often the game rolls: a bronze pickaxe at 99 mines iron on the first roll", () => {
  // Iron at 99 is 351/256 (always): live 3139/3182 get the ore a tick after the swing, whatever the pickaxe's speed.
  const h = harness();
  const player = createPlayer({ pickaxe: ItemIds.BRONZE_PICKAXE });
  const restoreRandom = scriptRandom([], 0.5);
  const { restore } = mineRock(h, player, "Iron rocks", loc("ironrock1"));
  try {
    h.tick(1);
    assert.deepEqual(player.added, []);
    h.tick(1);
    assert.deepEqual(player.added, [[ItemIds.IRON_ORE, 1]]);
  } finally {
    restoreRandom();
    restore();
  }
});

/** The ticks (after the click) on which rolls land, while each one fails and costs one Math.random for the gem pre-roll. */
function rollTicks({ pickaxe, rest = face(100), members = true, ticks = 12 }) {
  const { WorldDefinition } = core;
  const originalMembers = WorldDefinition.isMembersWorld;
  WorldDefinition.isMembersWorld = () => members;
  const h = harness();
  const player = createPlayer({ pickaxe, level: 99 });
  const originalRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return rest; };
  const { restore } = mineRock(h, player, "Runite rocks", loc("runiterock1"));
  const rolls = [];
  try {
    for (let tick = 1; tick <= ticks; tick++) {
      const before = calls;
      h.tick(1);
      if (calls > before) rolls.push(tick);
    }
    assert.deepEqual(player.added, [], "every roll failed");
  } finally {
    Math.random = originalRandom;
    WorldDefinition.isMembersWorld = originalMembers;
    restore();
  }
  return rolls;
}

test("rolls land the tick after the swing, then every pickaxe interval (Wiki Pickaxe)", () => {
  assert.deepEqual(rollTicks({ pickaxe: ItemIds.BRONZE_PICKAXE, ticks: 20 }), [2, 10, 18]);
  assert.deepEqual(rollTicks({ pickaxe: ItemIds.ADAMANT_PICKAXE }), [2, 6, 10]);
  assert.deepEqual(rollTicks({ pickaxe: ItemIds.RUNE_PICKAXE }), [2, 5, 8, 11]);
});

test("dragon, infernal and crystal pickaxes sometimes roll a tick early on members worlds only", () => {
  // Face 40 (0.158): under the dragon's 1/6 and the crystal's 1/4, so every interval is 2 ticks.
  for (const pickaxe of [ItemIds.DRAGON_PICKAXE, ItemIds.INFERNAL_PICKAXE, ItemIds.CRYSTAL_PICKAXE]) {
    assert.deepEqual(rollTicks({ pickaxe, rest: face(40) }), [2, 4, 6, 8, 10, 12], `pickaxe ${pickaxe}`);
    assert.deepEqual(rollTicks({ pickaxe, rest: face(40), members: false }), [2, 5, 8, 11], `pickaxe ${pickaxe} on F2P`);
  }
  // Face 50 (0.197): past the dragon's 1/6, still under the crystal's 1/4.
  assert.deepEqual(rollTicks({ pickaxe: ItemIds.DRAGON_PICKAXE, rest: face(50) }), [2, 5, 8, 11]);
  assert.deepEqual(rollTicks({ pickaxe: ItemIds.CRYSTAL_PICKAXE, rest: face(50) }), [2, 4, 6, 8, 10, 12]);
});

test("the skilling timer carries over to the next rock: no fresh roll before the last interval ends", () => {
  const h = harness();
  const player = createPlayer({ pickaxe: ItemIds.BRONZE_PICKAXE });
  const restoreRandom = scriptRandom([], 0.5);
  let mined = mineRock(h, player, "Iron rocks", loc("ironrock1"));
  try {
    h.tick(2);
    assert.equal(player.added.length, 1, "first ore at +2");
    mined.restore();
    mined = mineRock(h, player, "Iron rocks", loc("ironrock2"), 3286, 3368);
    h.tick(7);
    assert.equal(player.added.length, 1, "the bronze pickaxe's 8 ticks have not passed");
    h.tick(1);
    assert.equal(player.added.length, 2, "the next roll comes 8 ticks after the last");
  } finally {
    restoreRandom();
    mined.restore();
  }
});

test("invisible boosts count past 99, a visible boost does not (Wiki Skilling success rate)", () => {
  // Runite: 19/256 at 99; a visible 105 still rolls as 99, an invisible +4 on 99 gives 20/256.
  const cases = [[105, 0, 0], [99, 4, 1]];
  for (const [level, boost, expected] of cases) {
    const h = harness({ emit: (key, request) => { if (key === "mining:level-boost") request.boost += boost; } });
    const player = createPlayer({ level });
    const restoreRandom = scriptRandom([0, face(19)]);
    const { restore } = mineRock(h, player, "Runite rocks", loc("runiterock1"));
    try {
      h.tick(2);
      assert.equal(player.added.length, expected, `level ${level} + ${boost}`);
    } finally {
      restoreRandom();
      restore();
    }
  }
});

test("a gem pre-roll hit gives a gem instead of the ore: no XP, no sound, the rock stays (403)", () => {
  const h = harness();
  const player = createPlayer();
  // Gem roll on face 255, then the gem table (70 nothing, 32 sapphire, 16 emerald, 8 ruby, 2 diamond of 128): 0.6 -> sapphire.
  const restoreRandom = scriptRandom([face(255), 0.6], 0.99);
  const { restore } = mineRock(h, player, "Iron rocks", loc("ironrock1"));
  try {
    h.tick(2);
    assert.deepEqual(player.added, [[ItemIds.UNCUT_SAPPHIRE, 1]]);
    assert.equal(player.messages.at(-1), "You just found a Sapphire!");
    assert.deepEqual(player.xp, []);
    assert.deepEqual(player.packets.sounds, []);
    assert.deepEqual(h.registered, [], "the rock is not mined out");
    assert.equal(Mining.isMiningActive(player), true, "mining goes on");
  } finally {
    restoreRandom();
    restore();
  }
  const table = [[0.1, null], [0.85, ItemIds.UNCUT_EMERALD, "You just found an Emerald!"], [0.95, ItemIds.UNCUT_RUBY, "You just found a Ruby!"], [0.995, ItemIds.UNCUT_DIAMOND, "You just found a Diamond!"]];
  for (const [roll, itemId, message] of table) {
    const h2 = harness();
    const miner = createPlayer();
    const restoreGem = scriptRandom([face(255), roll], 0.99);
    const mined = mineRock(h2, miner, "Iron rocks", loc("ironrock1"));
    try {
      h2.tick(2);
      assert.deepEqual(miner.added, itemId ? [[itemId, 1]] : [], `table roll ${roll}`);
      if (message) assert.equal(miner.messages.at(-1), message);
      assert.deepEqual(h2.registered, [], "no ore either way");
    } finally {
      restoreGem();
      mined.restore();
    }
  }
});

test("a gem going into an open gem bag: the find line first, then the bag's (Wiki Transcript:Gem bag)", () => {
  const GemBag = require("../plugins/items/storage/GemBag.StorageItems");
  const player = createPlayer();
  // An open gem bag answering "storage:gather" as StorageItems does: it takes the gem and says so.
  const h = harness({
    emit: (key, request) => {
      if (key !== "storage:gather") return;
      request.stored = request.amount;
      request.player.sendMessage(GemBag.STRAIGHT_IN);
    },
  });
  const restoreRandom = scriptRandom([face(255), 0.6], 0.99);
  const { restore } = mineRock(h, player, "Iron rocks", loc("ironrock1"));
  try {
    h.tick(2);
    assert.deepEqual(player.messages.slice(-2), ["You just found a Sapphire!", GemBag.STRAIGHT_IN]);
    assert.deepEqual(player.added, [], "the bag took it");
  } finally {
    restoreRandom();
    restore();
  }
});

test("a charged amulet of glory adds a 3/256 gem roll when the first one misses", () => {
  const { ItemIdentifiers } = core;
  for (const [amulet, expected] of [[ItemIdentifiers.AMULET_OF_GLORY_4_, ItemIds.UNCUT_SAPPHIRE], [ItemIdentifiers.AMULET_OF_ETERNAL_GLORY, ItemIds.UNCUT_SAPPHIRE], [ItemIdentifiers.AMULET_OF_GLORY, ItemIds.IRON_ORE], [-1, ItemIds.IRON_ORE]]) {
    const h = harness();
    const player = createPlayer({ amulet });
    // First gem roll misses (face 100), the glory's roll hits on face 253, then 0.6 -> sapphire. Without a charged glory
    // the 253 is the ore roll instead, which iron at 99 always passes.
    const restoreRandom = scriptRandom([face(100), face(253), 0.6], 0.99);
    const { restore } = mineRock(h, player, "Iron rocks", loc("ironrock1"));
    try {
      h.tick(2);
      assert.deepEqual(player.added, [[expected, 1]], `amulet ${amulet}`);
    } finally {
      restoreRandom();
      restore();
    }
  }
});

test("rune essence: every roll gives essence and there is no gem pre-roll (Wiki Pure essence)", () => {
  const h = harness();
  const player = createPlayer({ pickaxe: ItemIds.BRONZE_PICKAXE, level: 1 });
  const restoreRandom = scriptRandom([], 0.999);
  const { restore } = mineRock(h, player, "Rune essence", core.ObjectIdentifiers.RUNE_ESSENCE);
  try {
    h.tick(10);
    assert.deepEqual(player.added, [[ItemIds.PURE_ESSENCE, 1], [ItemIds.PURE_ESSENCE, 1]], "rolls at +2 and +10");
  } finally {
    restoreRandom();
    restore();
  }
});
