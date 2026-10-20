// Run after `yarn build`: node --test tests/shantay-pass.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Location } = require("../dist/game/model/Location");

const Common = require("../plugins/areas/shantaypass/Common.ShantayPass");
const attachGate = require("../plugins/areas/shantaypass/Gate.ShantayPass");
const Shantay = require("../plugins/areas/shantaypass/Shantay.ShantayPass");
const Jail = require("../plugins/areas/shantaypass/Jail.ShantayPass");

const SHANTAY_PASS = 1854;
const COINS = 995;
const WARNING = 565;

const tasks = [];
const hooks = {};
const answers = { quests: new Set(), diaries: new Set(), ultimate: false };
const events = [];
const core = { ...PluginManager.getCoreApi(), TaskManager: { submit: (task) => tasks.push(task) } };
const api = {
  core,
  persistAttribute() {},
  onObjectInteraction: (_name, actions) => { hooks.gate = actions; },
  onNpcInteraction: (name, actions) => { hooks[name] = actions; },
  onInterfaceActionClick: (handler) => { hooks.click = handler; },
  onPlayerLogin() {},
  emitCustomEvent(name, payload) {
    events.push({ name, payload });
    if (name === "quest:is-complete") payload.complete = answers.quests.has(payload.key);
    if (name === "quest:is-started") payload.started = answers.quests.has(payload.key);
    if (name === "diary:is-complete") payload.complete = answers.diaries.has(payload.tier);
    if (name === "ironman:mode") payload.mode = answers.ultimate ? "ultimate" : "none";
  },
};
Common.init(api);
attachGate(api);

function runTasks() {
  for (let guard = 0; guard < 50 && tasks.length; guard++) {
    const due = tasks.splice(0);
    for (const task of due) task.execute();
  }
}

function createPlayer({ at = [3303, 3117], items = {}, bank = 0 } = {}) {
  const log = [];
  const attributes = new Map();
  let location = new Location(at[0], at[1], 0);
  const inventory = new Map(Object.entries(items).map(([id, amount]) => [Number(id), amount]));
  const sender = new Proxy({}, {
    get: (_target, name) => (...args) => {
      log.push(`${String(name)} ${args.filter((arg) => typeof arg !== "object").join(" ")}`.trim());
      return sender;
    },
  });
  return {
    log,
    getPacketSender: () => sender,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    sendMessage: (message) => log.push(`message ${message}`),
    getLocation: () => location,
    setLocation: (to) => { location = to; },
    setWalkingDirection() {},
    setPositionToFace() {},
    getMovementQueue: () => ({ reset() {}, handleRegionChange() {}, setBlockMovement() {} }),
    getDialogueManager: () => ({ startDialogues: () => log.push("dialogue") }),
    getEquipment: () => ({ get: () => null }),
    getInventory: () => ({
      getAmount: (id) => inventory.get(id) ?? 0,
      deleteNumber: (id, amount) => inventory.set(id, (inventory.get(id) ?? 0) - amount),
      getFreeSlots: () => 27,
      refreshItems() {},
    }),
    getBanks: () => [{ getAmount: (id) => (id === COINS ? bank : 0) }],
    getAppearance: () => ({ isMale: () => true }),
    amount: (id) => inventory.get(id) ?? 0,
  };
}

const proceed = (player) => hooks.click({ player, groupId: WARNING, childId: 17 });

test("the gate guard turns back a player without a pass", () => {
  const player = createPlayer();
  hooks.gate["Go-through"]({ player });
  runTasks();
  assert.ok(player.log.includes("dialogue"));
  assert.deepEqual([player.getLocation().getX(), player.getLocation().getY()], [3303, 3117]);
});

test("the desert warning counts up to 6, then offers to stop; off at 7", () => {
  const player = createPlayer({ items: { [SHANTAY_PASS]: 10 } });
  for (let shown = 1; shown <= 6; shown++) {
    player.log.length = 0;
    player.setLocation(new Location(3303, 3117, 0));
    hooks.gate["Go-through"]({ player });
    runTasks();
    assert.ok(player.log.includes(`sendVarbit 3860 ${shown}`), `showing ${shown}`);
    assert.ok(player.log.includes(`sendInterface ${WARNING}`));
    proceed(player);
    runTasks();
  }
  assert.equal(player.amount(SHANTAY_PASS), 4);
  player.log.length = 0;
  player.setLocation(new Location(3303, 3117, 0));
  hooks.gate["Go-through"]({ player });
  runTasks();
  assert.ok(player.log.includes(`sendInterfaceDisplayState ${(WARNING << 16) | 21} false`), "offers Don't ask me this again");
  hooks.click({ player, groupId: WARNING, childId: 20 });
  assert.ok(player.log.includes("sendVarbit 3860 7"));
  proceed(player);
  runTasks();
  assert.deepEqual([player.getLocation().getX(), player.getLocation().getY()], [3303, 3115]);

  player.log.length = 0;
  player.setLocation(new Location(3303, 3117, 0));
  hooks.gate["Go-through"]({ player });
  runTasks();
  assert.ok(!player.log.includes(`sendInterface ${WARNING}`), "no warning once toggled off");
  assert.ok(player.log.includes("message The guard takes your Shantay Pass as you go through the gate."));
  assert.deepEqual([player.getLocation().getX(), player.getLocation().getY()], [3303, 3115]);
});

test("going north is free, and the elite Desert Diary needs no pass", () => {
  const north = createPlayer({ at: [3304, 3115] });
  hooks.gate["Go-through"]({ player: north });
  runTasks();
  assert.deepEqual([north.getLocation().getX(), north.getLocation().getY()], [3304, 3117]);
  assert.ok(!north.log.some((line) => line.startsWith("message")));

  answers.diaries.add("elite");
  const elite = createPlayer();
  elite.setAttribute("shantay-pass:warnings", 7);
  hooks.gate["Go-through"]({ player: elite });
  runTasks();
  assert.deepEqual([elite.getLocation().getX(), elite.getLocation().getY()], [3303, 3115]);
  answers.diaries.delete("elite");
});

test("Shantay's conditions follow the player's coins, bank, visits and escapes", () => {
  const player = createPlayer({ items: { [COINS]: 3 }, bank: 100 });
  let answered = Shantay.conditions(player);
  assert.equal(answered["The first time talking to Shantay:"], true);
  assert.equal(answered["If the player does not have 5 coins in their inventory:"], true);
  assert.equal(answered["If the player has 5 coins in their bank:"], true);
  assert.equal(answered["If the player is not in trouble with Shantay:"], true);
  answers.ultimate = true;
  answered = Shantay.conditions(player);
  assert.equal(answered["If the player has 5 coins in their bank:"], false);
  assert.equal(answered["If the player does not have 5 coins in their bank, or they are an Ultimate Ironman:"], true);
  answers.ultimate = false;
  player.setAttribute(Common.MET_ATTRIBUTE, true);
  player.setAttribute(Common.ESCAPED_ATTRIBUTE, true);
  answered = Shantay.conditions(player);
  assert.equal(answered["Subsequent times talking to Shantay:"], true);
  assert.equal(answered["If the player has escaped from the \"Maximum security prison\" or from the Shantay Pass jail:"], true);
});

test("every condition and action in Shantay's transcript is one this plugin knows", () => {
  const dialogue = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/definitions/npc-dialogues.json"), "utf8")).Shantay;
  const known = Object.keys(Shantay.conditions(createPlayer()));
  const texts = [...JSON.stringify(dialogue).matchAll(/"(?:text|condition)":"((?:If|The first|Subsequent|In Leagues)[^"\\]*(?:\\.[^"\\]*)*:)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`));
  assert.ok(texts.length > 10);
  for (const text of texts) assert.ok(known.includes(text), text);
  for (const variant of ["arrested", "buy-pass-dialogue", "interacting-with-the-prison-door-while-locked-in-the-shantay-pass-jail"]) {
    assert.ok(dialogue.variants[variant], variant);
  }
  assert.ok(!JSON.stringify(dialogue).includes('"reference":"above"'), "no jumps left to resolve");
});

test("the Port Sarim lock gets easier with each failure and with a lockpick", () => {
  const withLevel = (level, items = {}) => ({
    ...createPlayer({ items }),
    getSkillManager: () => ({ getCurrentLevel: () => level }),
  });
  assert.equal(Jail.pickChance(withLevel(1), 0), 0);
  assert.ok(Math.abs(Jail.pickChance(withLevel(99), 0) - 0.39) < 1e-9);
  assert.ok(Math.abs(Jail.pickChance(withLevel(1), 4) - 0.82) < 1e-9);
  assert.ok(Math.abs(Jail.pickChance(withLevel(1, { 1523: 1 }), 0) - 0.23) < 1e-9);
});
