// Run after `yarn build`: node --test tests/charter-ships.test.cjs
const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const path = require("node:path");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { ItemIdentifiers } = require("../dist/util/ItemIdentifiers");
const { Location } = require("../dist/game/model/Location");
const CharterShips = require("../plugins/world/CharterShips.plugin");

const varbitId = (name) => CacheDefinitions.getVarbitId(name);
const varpId = (name) => CacheDefinitions.getVarpId(name);

let completeQuests = new Set();
const dialogueStarts = [];
const tasks = [];
const hooks = { npcs: [], generic: [], clicks: [], events: new Map(), conditions: [], persisted: new Map(), teleports: [] };
let prompt = null;

class Task {
  constructor(delay, key) {
    this.delay = delay;
    this.key = key;
    this.running = true;
  }

  stop() {
    this.running = false;
  }
}

function emitCustomEvent(name, request) {
  if (name === "quest:is-complete") request.complete = completeQuests.has(request.key);
  if (name === "npc-dialogue:start") {
    dialogueStarts.push(request);
    request.handled = true;
  }
}

const api = {
  core: {
    CacheDefinitions,
    Location,
    ItemIdentifiers,
    Equipment,
    ChatType: { SPAM: "spam" },
    Mobile: { onBeforeTeleport: (listener) => hooks.teleports.push(listener) },
    Task,
    TaskManager: { submit: (task) => tasks.push(task) },
    ShopManager: { open: () => true },
  },
  persistAttribute: (key, value) => hooks.persisted.set(key, value),
  onPlayerLogin: () => {},
  onNpcsInteraction: (names, actions) => hooks.npcs.push({ names, actions }),
  onNpcInteraction: (handler) => hooks.generic.push(handler),
  onInterfaceActionClick: (handler) => hooks.clicks.push(handler),
  onCustomEvent: (name, handler) => hooks.events.set(name, handler),
  onNpcDialogueCondition: (handler) => hooks.conditions.push(handler),
  sendMultiChatboxPrompt: (player, title, ...options) => {
    prompt = { title, labels: options.filter((o) => typeof o === "string"), options };
    return true;
  },
  emitCustomEvent,
  log() {},
};

/** Runs every queued task one tick; returns how many ticks until none is left. */
function runTasks() {
  let ticks = 0;
  while (tasks.some((task) => task.running) && ticks < 50) {
    ticks++;
    for (const task of [...tasks]) if (task.running) task.execute();
  }
  tasks.length = 0;
  return ticks;
}

function choosePrompt(label) {
  prompt.options[prompt.options.indexOf(label) + 1]();
}

function createPlayer({ at, coins = 10000, ring = 0, items = [], varbits = {}, varps = {} } = {}) {
  const equipment = new Array(14).fill(null).map(() => ({ getId: () => 0 }));
  if (ring) equipment[Equipment.RING_SLOT] = { getId: () => ring };
  const varbitValues = new Map(Object.entries(varbits).map(([name, value]) => [varbitId(name), value]));
  const varpValues = new Map(Object.entries(varps).map(([name, value]) => [varpId(name), value]));
  const attributes = new Map();
  const sent = { varbits: [], interfaces: [], subs: [], closed: [], flags: [], scripts: [], typed: [], jingles: [], removals: 0 };
  let balance = coins;
  let location = at;
  let interfaceId = -1;
  let blocked = false;
  let dying = false;
  const moves = [];
  const sender = {
    getVarbit: (id) => varbitValues.get(id) ?? 0,
    getVarp: (id) => varpValues.get(id) ?? 0,
    sendVarbit: (id, value) => { varbitValues.set(id, value); sent.varbits.push([id, value]); return sender; },
    sendClientScript: (id, ...args) => { sent.scripts.push([id, ...args]); return sender; },
    sendInterface: (id) => { interfaceId = id; sent.interfaces.push(id); return sender; },
    sendSubInterface: (uid, id, type, options) => { sent.subs.push({ uid, id, type, options }); return sender; },
    closeSubInterface: (uid) => { sent.closed.push(uid); return sender; },
    sendInterfaceRemoval: () => { interfaceId = -1; sent.removals++; return sender; },
    sendInterfaceFlagsRange: (uid, from, to, flags) => { sent.flags.push({ uid, from, to, flags }); return sender; },
    sendTypedMessage: (type, text) => { sent.typed.push({ type, text }); return sender; },
    sendJingle: (id, delay) => { sent.jingles.push([id, delay]); return sender; },
  };
  const movement = {
    setBlockMovement: (value) => { blocked = value; return movement; },
    reset: () => movement,
  };
  return {
    sent,
    moves,
    get balance() { return balance; },
    get blocked() { return blocked; },
    /** What PlayerDeath does as hitpoints reach zero: dying, and movement locked. */
    die() { dying = true; blocked = true; },
    varbit: (name) => varbitValues.get(varbitId(name)) ?? 0,
    getPacketSender: () => sender,
    getEquipment: () => ({ get: (slot) => equipment[slot] }),
    getInventory: () => ({
      getAmount: (id) => (id === ItemIdentifiers.COINS ? balance : 0),
      contains: (id) => items.includes(id),
      deleteNumber: (id, amount) => { balance = Math.max(0, balance - amount); },
      refreshItems: () => {},
    }),
    getLocation: () => location,
    getMovementQueue: () => movement,
    // Mobile.moveTo tells the teleport listeners first, as every teleport source does.
    moveTo(target) { for (const listener of hooks.teleports) listener(this, target); location = target; moves.push(target); },
    isPlayer: () => true,
    isDyingReturn: () => dying,
    getInterfaceId: () => interfaceId,
    isRegistered: () => true,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
  };
}

const row = (slug) => CharterShips._test.destinations().find((entry) => entry.slug === slug);
const tile = (x, y, z = 0) => new Location(x, y, z);
const SARIM_DOCK = tile(3039, 3193);
const CATHERBY_DOCK = tile(2796, 3414);
const MAP_COMPONENT = () => CacheDefinitions.getComponentId("sailing_menu:content");
const LIST_COMPONENT = () => CacheDefinitions.getComponentId("chartering_menu_side:list_content");

function click(player, component, slot) {
  const event = { player, buttonId: component, groupId: component >>> 16, childId: component & 0xffff, slot, handled: false };
  hooks.clicks[0](event);
  return event;
}

function trader(name, slug, options) {
  const ops = ["Talk-to", null, "Trade", "Charter", slug ? `Charter-to ${slug}` : null];
  return {
    npc: { getId: () => 1334, getLocation: () => tile(3039, 3193) },
    definition: { getName: () => name, getId: () => 9379, getActions: () => ops },
    ...options,
  };
}

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  CharterShips.register(api);
});

test("the destinations are the cache's chartering_destinations rows, decks on plane 1", () => {
  const rows = CharterShips._test.destinations();
  assert.equal(rows.length, 24);
  assert.deepEqual(rows.slice(0, 3).map((entry) => entry.name), ["Port Sarim", "Brimhaven", "Catherby"]);
  // Captured landings: the Pandemonium (rsprox 235/3834) and Port Tyras (237/1103).
  assert.deepEqual(row("pandemonium").deck, { x: 3060, y: 3000, z: 1 });
  assert.deepEqual(row("porttyras").deck, { x: 2142, y: 3125, z: 1 });
  assert.equal(row("pandemonium").inlineName, "the Pandemonium");
  assert.equal(row("brimhaven").inlineName, "Brimhaven");
  assert.equal(CharterShips._test.portAt(SARIM_DOCK).slug, "portsarim");
  assert.equal(CharterShips._test.portAt(tile(3039, 3193, 1)), null, "the deck is not in the port's zone");
});

test("captured clicks resolve sub 2k+1 on the map and 2k on the list to table row k", () => {
  // rsprox: Brimhaven 3, Port Tyras 17, Civitas illa Fortis 27, Aldarin 29, the Pandemonium 37.
  const rows = CharterShips._test.destinations();
  const bySub = (sub) => rows[Math.floor(sub / 2)].slug;
  assert.deepEqual([3, 17, 27, 29, 37].map(bySub), ["brimhaven", "porttyras", "fortis", "aldarin", "pandemonium"]);
});

test("availability follows client script 9104: quest varps, visits and excluded routes", () => {
  const { available } = CharterShips._test;
  const sarim = row("portsarim");
  const bare = createPlayer({ at: SARIM_DOCK });
  assert.equal(available(bare, sarim, row("catherby")), true);
  assert.equal(available(bare, sarim, row("porttyras")), false, "Regicide not done");
  assert.equal(available(createPlayer({ varps: { regicide_quest: 15 } }), sarim, row("porttyras")), true);
  assert.equal(available(bare, sarim, row("musapoint")), false, "no Sarim-Musa route");
  assert.equal(available(bare, row("catherby"), row("musapoint")), true);
  assert.equal(available(createPlayer({ varps: { priestperil: 61 } }), row("mosleharmless"), row("portphasmatys")), false);
  assert.equal(available(createPlayer({ varps: { priestperil: 61 } }), sarim, row("portphasmatys")), true);
  assert.equal(available(createPlayer({ varps: { fever_quest: 140 } }), sarim, row("mosleharmless")), false, "Mos needs Priest in Peril too");
  assert.equal(available(bare, sarim, row("tempestus")), false);
  assert.equal(available(bare, sarim, row("crandor")), false);
  assert.equal(available(createPlayer({ varps: { dragonquest: 5 } }), sarim, row("crandor")), true);
  const sailingOn = { content_restrict_sailing_serverside: 1, sailing_intro: 16 };
  assert.equal(available(createPlayer({ varbits: { sailing_intro: 16 } }), row("catherby"), row("pandemonium")), false, "Sailing content");
  assert.equal(available(createPlayer({ varbits: sailingOn }), row("catherby"), row("pandemonium")), true);
  assert.equal(available(createPlayer({ varbits: sailingOn }), sarim, row("pandemonium")), false);
  assert.equal(available(createPlayer({ varbits: { varlamore_visited: 1 } }), row("aldarin"), row("sunsetcoast")), false);
  assert.equal(available(createPlayer({ varbits: { varlamore_visited: 1 } }), row("fortis"), row("aldarin")), true);
});

test("fares are the Wiki's directed table, halved by a ring of charos(a) and by Cabin Fever", () => {
  const { fareBetween, fareFor } = CharterShips._test;
  completeQuests = new Set();
  assert.equal(fareBetween("Corsair Cove", "The Pandemonium"), 800);
  assert.equal(fareBetween("Red Rock", "Corsair Cove"), 1500);
  assert.equal(fareBetween("Port Sarim", "Musa Point"), null);
  const player = createPlayer();
  assert.equal(fareFor(player, row("catherby"), row("portsarim")), 1000);
  // rsprox with one halving: Catherby to Corsair Cove 500, to Port Tyras 1,600, to the Pandemonium 600.
  const ringed = createPlayer({ ring: ItemIdentifiers.RING_OF_CHAROS_A_ });
  assert.equal(fareFor(ringed, row("catherby"), row("corsaircove")), 500);
  assert.equal(fareFor(ringed, row("catherby"), row("porttyras")), 1600);
  assert.equal(fareFor(ringed, row("catherby"), row("pandemonium")), 600);
  completeQuests = new Set(["cabin_fever"]);
  assert.equal(fareFor(ringed, row("brimhaven"), row("catherby")), 120);
  // Mos fares already include Cabin Fever: only the ring halves them.
  assert.equal(fareFor(player, row("catherby"), row("mosleharmless")), 1250);
  assert.equal(fareFor(ringed, row("catherby"), row("mosleharmless")), 625);
  completeQuests = new Set();
});

test("Charter opens the map and its list with op1 on every marker and row", () => {
  const player = createPlayer({ at: SARIM_DOCK });
  const event = trader("Trader Stan", null, { player, clickType: 4, handled: false });
  const charter = hooks.npcs.find((hook) => hook.names.includes("Trader Stan")).actions.Charter;
  assert.equal(charter(event), true);
  assert.equal(player.varbit("content_restrict_sailing_serverside"), 1);
  assert.deepEqual(player.sent.scripts[0], [917, -1, -1]);
  assert.deepEqual(player.sent.interfaces, [CacheDefinitions.getInterfaceId("sailing_menu")]);
  assert.deepEqual(player.sent.subs[0], { uid: (161 << 16) | 74, id: CacheDefinitions.getInterfaceId("chartering_menu_side"), type: 3, options: undefined });
  assert.deepEqual(player.sent.flags.map((flag) => [flag.uid, flag.from, flag.to, flag.flags]), [
    [MAP_COMPONENT(), 0, 47, 2],
    [LIST_COMPONENT(), 0, 47, 2],
  ]);
  runTasks();
  assert.equal(player.varbit("busy"), 1);
});

test("a picked port asks first, then pays and lands on the deck on the captured ticks", () => {
  completeQuests = new Set();
  prompt = null;
  const player = createPlayer({ at: SARIM_DOCK });
  CharterShips._test.openMap(player);
  runTasks();
  click(player, MAP_COMPONENT(), row("catherby").index * 2 + 1);
  assert.equal(prompt.title, "Sail to Catherby for 1,000 coins?");
  assert.deepEqual(prompt.labels, ["Yes.", "Choose again.", "Yes, and don't ask again.", "Cancel."]);
  assert.equal(player.balance, 10000, "nothing paid before Yes");

  choosePrompt("Cancel.");
  assert.equal(player.balance, 10000);
  assert.equal(player.varbit("busy"), 0);

  CharterShips._test.openMap(player);
  runTasks();
  click(player, LIST_COMPONENT(), row("catherby").index * 2);
  choosePrompt("Yes, and don't ask again.");
  assert.equal(player.balance, 9000);
  assert.equal(player.varbit("settings_warning_confirmation_charter_ships"), 1);
  assert.equal(player.varbit("chartering_previous_destination"), row("catherby").id);
  assert.deepEqual(player.sent.typed.at(-1), { type: "spam", text: "You pay 1,000 coins and sail to Catherby." });
  assert.deepEqual(player.sent.jingles.at(-1), [171, 0]);
  assert.equal(player.blocked, true);
  const fadeOut = player.sent.subs.at(-1);
  assert.equal(fadeOut.id, 174);
  assert.deepEqual(fadeOut.options.postScripts[0], { scriptId: 948, args: [0, 255, 0, 0, 50] });

  // Tick by tick: minimap off on 1, land on 3, fade in on 4, overlay closed on 6.
  assert.equal(tasks.length, 1);
  const [task] = tasks;
  const timeline = [];
  for (let tick = 1; tick <= 6; tick++) {
    const before = { moves: player.moves.length, subs: player.sent.subs.length };
    task.execute();
    timeline.push({
      tick,
      minimap: player.varbit("minimap_state"),
      moved: player.moves.length > before.moves,
      fadeIn: player.sent.subs.length > before.subs,
    });
  }
  assert.deepEqual(timeline.map((entry) => entry.minimap), [2, 2, 2, 0, 0, 0]);
  assert.deepEqual(timeline.map((entry) => entry.moved), [false, false, true, false, false, false]);
  assert.deepEqual(timeline.map((entry) => entry.fadeIn), [false, false, false, true, false, false]);
  assert.equal(task.running, false);
  assert.equal(player.blocked, false);
  assert.equal(player.getLocation().getX(), 2792);
  assert.equal(player.getLocation().getY(), 3417);
  assert.equal(player.getLocation().getZ(), 1);
  tasks.length = 0;
});

test("without the fare the crew say what it costs and offer only Choose again / Cancel", () => {
  prompt = null;
  const player = createPlayer({ at: CATHERBY_DOCK, coins: 499 });
  CharterShips._test.openMap(player);
  click(player, MAP_COMPONENT(), row("corsaircove").index * 2 + 1);
  assert.equal(prompt.title, "Sailing to Corsair Cove costs 1,000 coins.");
  assert.deepEqual(prompt.labels, ["Choose again", "Cancel"]);
  choosePrompt("Choose again");
  assert.equal(player.getInterfaceId(), CacheDefinitions.getInterfaceId("sailing_menu"));
  assert.equal(player.balance, 499);
  tasks.length = 0;
});

test("the current port and locked ports cannot be picked", () => {
  prompt = null;
  const player = createPlayer({ at: SARIM_DOCK });
  CharterShips._test.openMap(player);
  click(player, MAP_COMPONENT(), row("portsarim").index * 2 + 1);
  click(player, MAP_COMPONENT(), row("porttyras").index * 2 + 1);
  assert.equal(prompt, null);
  assert.equal(player.balance, 10000);
  tasks.length = 0;
});

test("with the warning off a click sails at once, and Charter-to goes to the last destination", () => {
  const player = createPlayer({ at: CATHERBY_DOCK, varps: { regicide_quest: 15 } });
  player.setAttribute(CharterShips._test.SKIP_CONFIRMATION_ATTRIBUTE, true);
  player.setAttribute(CharterShips._test.PREVIOUS_DESTINATION_ATTRIBUTE, row("porttyras").id);
  const event = trader("Trader Crewmember", "Port Tyras", { player, clickType: 5, handled: false });
  hooks.generic[0](event);
  assert.equal(event.handled, true);
  assert.equal(player.balance, 6800);
  assert.deepEqual(player.sent.typed.at(-1), { type: "spam", text: "You pay 3,200 coins and sail to Port Tyras." });
  runTasks();
  assert.deepEqual([player.getLocation().getX(), player.getLocation().getY(), player.getLocation().getZ()], [2142, 3125, 1]);
});

test("Charter-to at the last destination itself plays the crew's question", () => {
  dialogueStarts.length = 0;
  const player = createPlayer({ at: SARIM_DOCK });
  player.setAttribute(CharterShips._test.PREVIOUS_DESTINATION_ATTRIBUTE, row("portsarim").id);
  const event = trader("Trader Crewmember", "Port Sarim", { player, clickType: 5, handled: false });
  hooks.generic[0](event);
  assert.equal(dialogueStarts.at(-1).variant, "right-click-charter-to-current-location");
  assert.equal(dialogueStarts.at(-1).npcId, 9379, "the transcript is the transformed crewmember's");
  assert.equal(player.balance, 10000);
});

test("rum or a bedsheet stops Charter with the transcript's own refusal", () => {
  dialogueStarts.length = 0;
  const rum = CacheDefinitions.getObjId("karamja_rum");
  const player = createPlayer({ at: SARIM_DOCK, items: [rum] });
  const event = trader("Trader Crewmember", null, { player, clickType: 4, handled: false });
  hooks.npcs.find((hook) => hook.names.includes("Trader Crewmember")).actions.Charter(event);
  assert.equal(player.sent.interfaces.length, 0, "no map");
  const steps = [{ type: "condition", text: "If the player has the bedsheet in their inventory:", steps: [{ npc: "laundry" }] },
    { type: "condition", text: "If the player has Karamjan rum in their inventory:", steps: [{ npc: "rum" }] }];
  assert.deepEqual(dialogueStarts.at(-1).select(steps), [{ npc: "rum" }]);
});

test("Talk-to's transcript opens the map and answers its item conditions", () => {
  const player = createPlayer({ at: SARIM_DOCK, items: [CacheDefinitions.getObjId("ahoy_bedsheet")] });
  const definition = { getName: () => "Trader Crewmember" };
  const answer = (text) => hooks.conditions[0]({ player, definition, text });
  assert.equal(answer("If the player does not have the bedsheet in their inventory:"), false);
  assert.equal(answer("If the player has the bedsheet in their inventory:"), true);
  assert.equal(answer("If the player has the ectoplasm covered bedsheet in their inventory:"), false);
  assert.equal(answer("If the player has Karamjan rum in their inventory:"), false);
  assert.equal(answer("If the player chooses Crandor during Dragon Slayer I:"), false);

  const clean = createPlayer({ at: SARIM_DOCK });
  const action = { player: clean, definition, action: "open_interface", target: "Charter ship", handled: false };
  hooks.events.get("npc-dialogue:action")(action);
  assert.equal(action.handled, true);
  assert.equal(action.end, true);
  runTasks();
  assert.deepEqual(clean.sent.interfaces, [CacheDefinitions.getInterfaceId("sailing_menu")]);
  const stan = { player: clean, definition: { getName: () => "Trader Stan" }, text: "The player chooses from :File:Trade charter map.png", handled: false };
  hooks.events.get("npc-dialogue:action")(stan);
  assert.equal(stan.handled, true);
  tasks.length = 0;
});

test("a passenger who dies before arrival stays where they died, still locked", () => {
  tasks.length = 0;
  const player = createPlayer({ at: CATHERBY_DOCK });
  CharterShips._test.sail(player, row("brimhaven"), 480);
  const [task] = tasks;
  task.execute();
  task.execute();
  player.die();
  for (let tick = 3; tick <= 6; tick++) task.execute();
  assert.deepEqual(player.moves, [], "never put on the deck");
  assert.equal(player.getLocation(), CATHERBY_DOCK);
  assert.equal(player.blocked, true, "the death keeps its movement lock");
  assert.equal(task.running, false);
  assert.equal(player.varbit("minimap_state"), 0);
  assert.equal(player.varbit("busy"), 0);
  assert.ok(player.sent.closed.includes((161 << 16) | 1), "the fade overlay is taken down");
  tasks.length = 0;
});

test("a relocated passenger's voyage ends, and its leftover ticks never touch the next one", () => {
  tasks.length = 0;
  const player = createPlayer({ at: CATHERBY_DOCK });
  CharterShips._test.sail(player, row("brimhaven"), 480);
  const [first] = tasks;
  first.execute();
  player.moveTo(SARIM_DOCK);
  assert.equal(player.blocked, false, "a teleport frees the voyage's lock");

  CharterShips._test.sail(player, row("catherby"), 1000);
  assert.equal(tasks.length, 2, "a new voyage can start at once");
  const second = tasks[1];
  for (let tick = 2; tick <= 6; tick++) first.execute();
  assert.equal(first.running, false);
  assert.deepEqual(player.moves.slice(1), [], "the old voyage lands nobody");
  assert.equal(player.blocked, true, "nor frees the new voyage's lock");

  for (let tick = 1; tick <= 6; tick++) second.execute();
  assert.equal(player.getLocation().getX(), row("catherby").deck.x);
  assert.equal(player.blocked, false);
  assert.equal(second.running, false);
  tasks.length = 0;
});

test("closing the map closes its list", () => {
  const player = createPlayer({ at: SARIM_DOCK });
  hooks.events.get("interface:closed")({ player, interfaceId: CacheDefinitions.getInterfaceId("sailing_menu") });
  assert.deepEqual(player.sent.closed, [(161 << 16) | 74]);
});

test("the plugin persists the last destination and the warning, and hooks by name", () => {
  assert.equal(CharterShips.members, true);
  assert.equal(hooks.persisted.get(CharterShips._test.PREVIOUS_DESTINATION_ATTRIBUTE), 0);
  assert.equal(hooks.persisted.get(CharterShips._test.SKIP_CONFIRMATION_ATTRIBUTE), false);
  const names = hooks.npcs[0].names;
  assert.ok(names.includes("Trader Stan") && names.includes("Trader Crewmember"));
  assert.deepEqual(Object.keys(hooks.npcs[0].actions), ["Charter", "Trade"], "Talk-to stays with the transcript");
});

test("the transcripts play the crew's current-port question as an exact variant, by name", () => {
  const starts = new Map();
  require("../plugins/npcs/NpcDialogues.plugin").register(new Proxy({
    core: {},
    onCustomEvent: (name, handler) => starts.set(name, handler),
  }, { get: (target, key) => target[key] ?? (() => {}) }));
  const shown = [];
  const player = {
    getDialogueManager: () => ({
      reset() {},
      startDialogues(chain) {
        for (const entry of [...chain.getDialogues().values()]) shown.push(entry.getText?.() ?? entry.constructor.name);
      },
    }),
    getPacketSender: () => ({ sendInterfaceRemoval() {} }),
    getAppearance: () => ({ isMale: () => true }),
    getUsername: () => "charter",
    sendMessage() {},
  };
  // 9338 is the Catherby crewmember as a player who last chartered to Catherby sees him.
  const crew = { player, npcId: 9338, variant: "right-click-charter-to-current-location", exact: true, handled: false };
  starts.get("npc-dialogue:start")(crew);
  assert.equal(crew.handled, true);
  const stan = { player, npcId: 9301, variant: "right-click-charter-to-current-location", exact: true, handled: false };
  starts.get("npc-dialogue:start")(stan);
  assert.equal(stan.handled, false, "Trader Stan has no such variant, so nothing plays");
});
