// Run after `yarn build`: node --test tests/magic-carpets.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Location } = require("../dist/game/model/Location");

const DATA = require("../plugins/world/data/magic-carpets.json");
const Carpets = require("../plugins/world/MagicCarpets.plugin");

const COINS = 995;
const RING_OF_CHAROS_A = 6465;

const tasks = [];
const hooks = {};
const answers = { quests: new Set(), hardDiary: false };
const events = [];
const core = { ...PluginManager.getCoreApi(), TaskManager: { submit: (task) => tasks.push(task) } };
Carpets.register({
  core,
  onNpcInteraction: (_name, actions) => { hooks.travel = actions.Travel; },
  onNpcDialogueCondition: (handler) => { hooks.condition = handler; },
  onCustomEvent: (_name, handler) => { hooks.line = handler; },
  onCanTeleport: (handler) => { hooks.canTeleport = handler; },
  onPlayerLogout: (handler) => { hooks.logout = handler; },
  sendMultiChatboxPrompt: (player, title, ...pairs) => {
    player.prompt = { title, options: pairs.filter((entry) => typeof entry === "string"), pairs };
    return true;
  },
  emitCustomEvent(name, payload) {
    events.push({ name, payload });
    if (name === "quest:is-complete") payload.complete = answers.quests.has(payload.key);
    if (name === "diary:is-complete") payload.complete = answers.hardDiary;
  },
});

function station(key) {
  return DATA.stations.find((entry) => entry.key === key);
}

function merchantAt(key) {
  const [x, y] = station(key).takeoff;
  return { getLocation: () => new Location(x + 2, y + 1, 0) };
}

function rugMerchant() {
  return { getName: () => "Rug Merchant" };
}

function createPlayer({ coins = 0, ring = -1, at = [3310, 3108] } = {}) {
  const log = [];
  const attributes = new Map();
  let location = new Location(at[0], at[1], 0);
  let coinCount = coins;
  const sender = new Proxy({}, {
    get: (_target, name) => (...args) => {
      log.push(`${String(name)} ${args.filter((arg) => typeof arg !== "object").join(" ")}`.trim());
      return sender;
    },
  });
  const player = {
    log,
    forceMoves: [],
    getPacketSender: () => sender,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    sendMessage: (message) => log.push(`message ${message}`),
    getLocation: () => location,
    setLocation: (to) => { location = to; },
    moveTo: (to) => { location = to; },
    setWalkingDirection() {},
    setPositionToFace() {},
    setForceMovement: (move) => { if (move) player.forceMoves.push(move); },
    performAnimation: (animation) => log.push(`anim ${animation.getId()}`),
    setRenderAnimations: (animations) => log.push(`render ${animations ? animations[0] : "reset"}`),
    setDisplayedEquipment: (overrides) => log.push(`shows ${overrides ? JSON.stringify(overrides) : "worn"}`),
    setMobileInteraction: (mobile) => log.push(`interacting ${mobile ?? "none"}`),
    getUpdateFlag: () => ({ flag() {} }),
    getMovementQueue: () => ({ reset() {}, handleRegionChange() {}, setBlockMovement: (blocked) => log.push(blocked ? "lock" : "unlock") }),
    getSpellbook: () => ({ getInterfaceId: () => 218 }),
    getEquipment: () => ({ get: (slot) => (slot === core.Equipment.RING_SLOT && ring > 0 ? { getId: () => ring } : null), refreshItems() {} }),
    getInventory: () => ({
      getAmount: (id) => (id === COINS ? coinCount : 0),
      deleteNumber: (id, amount) => { if (id === COINS) coinCount -= amount; },
      refreshItems() {},
      contains: () => false,
    }),
    getBanks: () => [],
    coins: () => coinCount,
  };
  return player;
}

function runTask(task, limit = 200) {
  task.setRunning?.(true);
  for (let tick = 0; tick < limit && !task.finished; tick++) task.execute();
}

test("every Travel and Talk-to destination has a captured or derived route", () => {
  const routes = new Set(DATA.routes.map((route) => `${route.from}>${route.to}`));
  for (const entry of DATA.stations) {
    for (const to of [...entry.travel, ...Object.values(entry.talk)]) {
      assert.ok(station(to), `${entry.key} flies to unknown station ${to}`);
      assert.ok(routes.has(`${entry.key}>${to}`), `no route ${entry.key} -> ${to}`);
    }
  }
});

// Live glides 3 tiles a tick and runs 2 on diagonals; once (Shantay to Uzer, tick 42) it catches up with 6.
const MAX_TILES_A_TICK = 6;

test("routes start at the take-off tile, move at most 6 tiles a tick and step off east of the landing", () => {
  for (const route of DATA.routes) {
    let previous = station(route.from).takeoff;
    let lastTick = 0;
    for (const [tick, x, y] of route.steps) {
      assert.ok(tick > lastTick, `${route.from} -> ${route.to}: ticks go forwards`);
      assert.ok(Math.max(Math.abs(x - previous[0]), Math.abs(y - previous[1])) <= MAX_TILES_A_TICK, `${route.from} -> ${route.to} jumps at tick ${tick}`);
      previous = [x, y];
      lastTick = tick;
    }
    assert.ok(route.land > lastTick, `${route.from} -> ${route.to} lands after its last move`);
    assert.deepEqual(route.walkOff, [previous[0] + 1, previous[1]], `${route.from} -> ${route.to} steps off east`);
  }
});

test("the Rug Merchant transcript has every station condition and travel answer this plugin keys on", () => {
  const dialogue = JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/npc-dialogues.json"), "utf8"))["Rug Merchant"]);
  for (const entry of DATA.stations) {
    assert.ok(dialogue.includes(JSON.stringify(entry.fromCondition)), entry.fromCondition);
    assert.ok(dialogue.includes(JSON.stringify(entry.atCondition)), entry.atCondition);
    for (const text of Object.keys(entry.talk)) assert.ok(dialogue.includes(`{"player":${JSON.stringify(text)}}`), text);
  }
});

test("conditions pick the merchant's own station and gate the quest destinations", () => {
  const player = createPlayer();
  const ask = (key, text) => hooks.condition({ player, npc: merchantAt(key), definition: rugMerchant(), text });
  assert.equal(ask("nardah", "From Nardah or Menaphos:"), true);
  assert.equal(ask("menaphos", "From Nardah or Menaphos:"), true);
  assert.equal(ask("sophanem", "From Nardah or Menaphos:"), false);
  assert.equal(ask("uzer", "At Uzer:"), true);
  assert.equal(ask("uzer", "At the Shantay Pass:"), false);
  answers.quests.clear();
  assert.equal(ask("shantay-pass", "If the player has completed The Golem:"), false);
  assert.equal(ask("shantay-pass", "If the player hasn't completed The Feud:"), true);
  answers.quests.add("the_golem");
  assert.equal(ask("shantay-pass", "If the player has completed The Golem:"), true);
  assert.equal(hooks.condition({ player, npc: merchantAt("uzer"), definition: { getName: () => "Monkey" }, text: "At Uzer:" }), null);
});

test("the Travel menu lists the reachable destinations with the fare", () => {
  answers.quests.clear();
  answers.hardDiary = false;
  const player = createPlayer();
  hooks.travel({ player, npc: merchantAt("shantay-pass") });
  assert.deepEqual(player.prompt, { ...player.prompt, title: "Carpet rides cost 200 coins.", options: ["Bedabin camp", "Pollnivneach", "Cancel"] });

  answers.quests.add("the_golem");
  const ringed = createPlayer({ ring: RING_OF_CHAROS_A });
  hooks.travel({ player: ringed, npc: merchantAt("shantay-pass") });
  assert.equal(ringed.prompt.title, "Carpet rides cost 100 coins.");
  assert.deepEqual(ringed.prompt.options, ["Uzer", "Bedabin camp", "Pollnivneach", "Cancel"]);

  answers.hardDiary = true;
  answers.quests.add("ictlharins_little_helper");
  const free = createPlayer();
  hooks.travel({ player: free, npc: merchantAt("pollnivneach-south") });
  assert.equal(free.prompt.title, "Carpet rides are free!");
  assert.deepEqual(free.prompt.options, ["Sophanem", "Menaphos", "Nardah", "Cancel"]);
});

test("a ride without the fare is refused and takes nothing", () => {
  answers.hardDiary = false;
  tasks.length = 0;
  const player = createPlayer({ coins: 150 });
  hooks.travel({ player, npc: merchantAt("shantay-pass") });
  player.prompt.pairs[player.prompt.pairs.indexOf("Pollnivneach") + 1](player);
  assert.equal(tasks.length, 0);
  assert.equal(player.coins(), 150);
  assert.ok(player.log.includes("message You need 200 coins to travel on a magic carpet."));
});

test("a ride flies the captured path, lands on the walk-off tile and counts the diary task", () => {
  answers.hardDiary = false;
  tasks.length = 0;
  events.length = 0;
  const player = createPlayer({ coins: 500, at: [3310, 3109] });
  hooks.travel({ player, npc: merchantAt("shantay-pass") });
  player.prompt.pairs[player.prompt.pairs.indexOf("Pollnivneach") + 1](player);
  assert.equal(player.coins(), 300);
  assert.equal(tasks.length, 1);
  const teleport = { player, allow: true };
  hooks.canTeleport(teleport);
  assert.equal(teleport.allow, false);

  runTask(tasks[0]);
  const route = DATA.routes.find((entry) => entry.from === "shantay-pass" && entry.to === "pollnivneach-north");
  assert.equal(player.forceMoves.length, route.steps.length);
  assert.deepEqual([player.getLocation().getX(), player.getLocation().getY()], route.walkOff);
  const anims = player.log.filter((line) => line.startsWith("anim ")).map((line) => Number(line.split(" ")[1]));
  assert.deepEqual(anims.filter((id) => id > 0 && id < 0xffff), [2266, 2262, 2263]);
  assert.deepEqual(player.log.filter((line) => line.startsWith("render ")), ["render 6936", "render reset"]);
  assert.deepEqual(player.log.filter((line) => line.startsWith("shows ")), ['shows {"3":5614,"5":-1}', "shows worn"]);
  assert.ok(player.log.includes("interacting none"), "stops facing the merchant on setting off");
  assert.ok(player.log.includes("sendJingle 132 45909"));
  assert.ok(player.log.includes("unlock"));
  const diary = events.find((event) => event.name === "diary:task");
  assert.equal(diary?.payload.task, "travel-from-the-shantay-pass-to-pollnivneach-by");
});

test("the travel answer starts a ride once the line is continued, and logging out lands the rider", () => {
  answers.hardDiary = true;
  tasks.length = 0;
  const player = createPlayer({ at: [3469, 3112] });
  const request = { player, npc: merchantAt("uzer"), definition: rugMerchant(), step: { player: "That sounds good, take me there." } };
  hooks.line(request);
  assert.equal(typeof request.after, "function");
  request.after();
  assert.equal(tasks.length, 1);
  for (let tick = 0; tick < 20; tick++) tasks[0].execute();
  hooks.logout({ player });
  assert.deepEqual([player.getLocation().getX(), player.getLocation().getY()], [3309, 3110]);
  assert.equal(player.getAttribute("magic-carpets:ride"), null);

  const other = { player, npc: merchantAt("uzer"), definition: rugMerchant(), step: { player: "Take me there." } };
  hooks.line(other);
  assert.equal(other.after, undefined);
});
