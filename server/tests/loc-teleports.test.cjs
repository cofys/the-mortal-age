// Run after `yarn build`: node --test tests/loc-teleports.test.cjs
// Captured loc teleports (docs/loc-teleports.md): which captured locs become entries
// (scripts/loc-teleport-matching.cjs), the data against the cache, and the plugin playing an
// entry as live OSRS does.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { MapObjects } = require("../dist/game/entity/impl/object/MapObjects");

const { choose, isNetwork, refusals, toEntry, requirementFor } = require("../scripts/loc-teleport-matching.cjs");
const LocTeleports = require("../plugins/world/LocTeleports.plugin");
const data = require("../plugins/world/data/loc-teleports.json");
const decisions = require("../plugins/world/data/loc-teleport-sync.json");

let core;
const hooks = {};
const prompts = [];
const emitted = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  core.RegionManager.init();
  LocTeleports.register({
    core,
    persistAttribute() {},
    onObjectInteraction: (handler) => (hooks.object = handler),
    onItemOnObject: (handler) => (hooks.itemOnObject = handler),
    onCustomEvent: (name, handler) => (hooks[name] = handler),
    sendMultiChatboxPrompt: (player, title, ...pairs) => prompts.push({ title, options: pairs.filter((_, i) => i % 2 === 0), pick: (text) => pairs[pairs.indexOf(text) + 1]() }),
    emitCustomEvent: (name, payload) => emitted.push([name, payload]),
  });
});

const captured = (fields) => ({
  name: "cave_entry", id: 1, op: 1, x: 10, y: 10, z: 0, labels: [], teleports: 3, failures: [], dialogue: null,
  destinations: [{ x: 50, y: 9000, z: 0, from: [[10, 11, 0]] }], recordings: 3, ...fields,
});
const nothing = [{ status: "nothing", handledBy: null }];

test("a captured cave tsps does nothing with becomes an entry; one tsps already does doesn't", () => {
  assert.deepEqual(choose(captured({}), nothing, "Cave", decisions), { take: true });
  assert.equal(choose(captured({}), [{ status: "same" }], "Cave", decisions).reason, "tsps already does this");
  // Ladders asks other content first, so a ladder it takes and gets wrong is fixed here too.
  assert.deepEqual(choose(captured({}), [{ status: "handled-no-move", handledBy: "Ladders" }], "Ladder", decisions), { take: true });
  assert.equal(choose(captured({}), [{ status: "different", handledBy: "Agility" }], "Cave", decisions).reason, "handled by Agility");
});

test("left out: instances, networks, requirements, dialogue choices, other kinds and decisions", () => {
  const reason = (fields, display = "Cave") => choose(captured(fields), nothing, display, decisions).reason;
  assert.equal(reason({ labels: ["instance"] }), "labelled instance");
  assert.equal(reason({ labels: ["special-world"] }), undefined, "Leagues worlds move players the same way");
  assert.equal(reason({ name: "league_6_cave", labels: ["special-world"] }), "Leagues content");
  // Spirit trees and the magic mushtree: an interface picks among far-apart destinations.
  const network = { destinations: [{ x: 3676, y: 3871, z: 0 }, { x: 3760, y: 3758, z: 0 }] };
  assert.equal(isNetwork(network), true);
  assert.match(reason(network), /travel network/);
  assert.match(reason({ failures: [["That looks too steep to safely climb down with just your bare hands.", 1]] }), /refused/);
  assert.deepEqual(refusals(captured({ failures: [["You drink some of your stamina potion.", 1]] })), [], "a potion isn't a requirement");
  assert.equal(reason({ dialogue: { prompt: "Climb up or down the ladder?" } }), "dialogue choice");
  assert.equal(reason({}, "Rowboat"), "not a ladder, stair, cave or hole");
  assert.equal(reason({}, "Passageway"), undefined, "doors, gates and passageways that move the player are taken");
  assert.equal(reason({ name: "lift_back" }, "Lift"), undefined, "an included loc of another kind (a Haunted Mine lift)");
  assert.match(reason({ name: "freedomfighterentrancel" }, "Wooden doors"), /In Search of the Myreque/);
  assert.equal(reason({ name: "sailing_gangplank_shipyard" }), "In the shipyard; Sailing handles it.");
  assert.match(reason({ name: "ladder", x: 3284, y: 3165 }), /Leagues/, "one placement of a shared name");
  assert.equal(reason({ name: "ladder" }), undefined, "the other ladders of that name");
});

test("an entry keeps the captured move, with whole ticks and a destination per side", () => {
  const entry = toEntry(captured({ sequence_tick: 1.5, teleport_tick: 2.5, sounds: [[2454, 1]], fade: true }), { display: "Cave", option: "Enter", sequenceId: 11580 });
  assert.deepEqual([entry.to, entry.anim, entry.animTick, entry.tick, entry.sound, entry.fade], [[50, 9000, 0], 11580, 2, 3, 2454, true]);
  const stairs = toEntry(captured({ destinations: [{ x: 1, y: 2, z: 1, from: [[3, 3, 0]] }, { x: 5, y: 6, z: 1, from: [[9, 9, 0]] }] }), { display: "Stairs", option: "Climb" });
  assert.deepEqual(stairs.sides, [{ from: [3, 3, 0], to: [1, 2, 1] }, { from: [9, 9, 0], to: [5, 6, 1] }]);
});

test("every entry is a placed loc with that option in the rev 241 cache, once per tile and option", () => {
  const keys = new Set();
  for (const entry of data.locs) {
    const key = `${entry.x},${entry.y},${entry.z}:${entry.op}`;
    assert.ok(!keys.has(key), `${entry.name} ${key} twice`);
    keys.add(key);
    const cached = CacheDefinitions.getObject(entry.id);
    const variants = cached.transforms ? cached.transforms.filter((id) => id !== -1).map((id) => CacheDefinitions.getObject(id)) : [cached];
    assert.ok(variants.some((variant) => variant?.actions?.[entry.op - 1]), `${entry.name} (${entry.id}) has no option ${entry.op}`);
    assert.ok(entry.to || entry.sides?.length, `${entry.name} goes nowhere`);
  }
  // Left to their own work: the shipyard, spirit trees, the magic mushtree.
  assert.ok(!data.locs.some((entry) => /^(sailing_|spirittree|fossil_magic_mushtree)/.test(entry.name)));
});

/** A real player whose packets are recorded per tick. */
function explorer(at) {
  const player = new Player(null);
  player.setUsername(`explorer${Math.random()}`);
  player.setLocation(new core.Location(...at));
  const ticks = [[]];
  const log = (entry) => ticks[ticks.length - 1].push(entry);
  const sender = new Proxy({}, {
    get: (target, key) => {
      if (key === "sendVarbit") return (id, value) => (log(`varbit ${id}=${value}`), sender);
      if (key === "sendSound") return (id) => (log(`sound ${id}`), sender);
      if (key === "sendSubInterface") return (uid, id) => (log(`open ${id}`), sender);
      if (key === "closeSubInterface") return () => (log("close overlay"), sender);
      if (key === "getVarbit" || key === "getVarp") return () => 0;
      return () => sender;
    },
  });
  player.getPacketSender = () => sender;
  player.performAnimation = (animation) => log(`anim ${animation.getId()}`);
  player.isRegistered = () => true;
  const moveTo = player.moveTo.bind(player);
  player.moveTo = (location) => (log(`move ${location.getX()},${location.getY()},${location.getZ()}`), moveTo(location));
  return { player, ticks, nextTick: () => ticks.push([]) };
}

function runTicks(explorer, count) {
  for (let i = 0; i < count; i++) {
    explorer.nextTick();
    core.TaskManager.process();
  }
}

function locAt(id, x, y, z) {
  core.RegionManager.loadMapFiles(x, y);
  const object = MapObjects.get(id, new core.Location(x, y, z), null);
  assert.ok(object, `loc ${id} at ${x},${y},${z}`);
  return object;
}

test("the Tlati dragon nest cave plays as captured: crawl, sound and fade, then in on tick 4", () => {
  // Captured: crawl animation and sound 2454 two ticks after arriving, the fade out with them,
  // the minimap off a tick later, the move on tick 4, the fade back in a tick after it. The
  // click is handled the tick after arriving, so each comes one tick earlier from the click.
  const object = locAt(57591, 1288, 3133, 0);
  const visit = explorer([1289, 3136, 0]);
  const event = { player: visit.player, object, objectId: object.getId(), clickType: 1, handled: false };
  hooks.object(event);
  assert.equal(event.handled, true);
  runTicks(visit, 6);
  assert.deepEqual(visit.ticks, [
    [],
    ["anim 11580", "sound 2454", "open 174"],
    ["varbit 6719=2"],
    ["move 1245,9527,0"],
    ["varbit 6719=0", "open 174"],
    [],
    ["close overlay"],
  ]);
});

test("a Climb that Ladders would ask about goes the captured way: the Arceuus library stairs go up", () => {
  const object = locAt(27851, 1612, 3818, 1);
  const visit = explorer([1615, 3819, 1]);
  const request = { player: visit.player, object, objectId: object.getId(), clickType: 1, handled: false };
  hooks["ladders:climb"](request);
  assert.equal(request.handled, true);
  runTicks(visit, 3);
  assert.deepEqual(visit.player.getLocation().getZ(), 2);
  assert.deepEqual([visit.player.getLocation().getX(), visit.player.getLocation().getY()], [1608, 3819]);
});

test("another tile or option isn't claimed: the click falls through to whoever handles it", () => {
  const object = locAt(57591, 1288, 3133, 0);
  const visit = explorer([1289, 3136, 0]);
  const event = { player: visit.player, object, objectId: object.getId(), clickType: 2, handled: false };
  hooks.object(event);
  assert.equal(event.handled, false);
});

test("a staircase used from either end takes the side the player stands on", () => {
  const entry = data.locs.find((loc) => loc.name === "ds2_lithkren_dungeon_stairs_lower");
  const { destinationFor } = LocTeleports._test;
  assert.deepEqual(destinationFor(entry, new core.Location(3549, 10468, 0)), [3549, 10473, 0]);
  assert.deepEqual(destinationFor(entry, new core.Location(3549, 10473, 0)), [3549, 10468, 0]);
});

test("trapdoor swaps: each loc has its option, and becomes the other state", () => {
  const swaps = require("../plugins/world/data/loc-swaps.json").swaps;
  for (const swap of swaps) {
    assert.equal(CacheDefinitions.getObject(swap.id)?.actions?.[swap.op - 1], swap.option, swap.name);
    assert.ok(CacheDefinitions.getObject(swap.becomes)?.name, `${swap.name} becomes ${swap.becomes}`);
  }
});

test("Draynor's trapdoor opens as captured, into the open trapdoor Ladders climbs down", () => {
  // Captured: "You open the trapdoor." a tick after arriving, the open-chest animation and
  // sound 91 a tick later, the open trapdoor on tick 3. Its Climb-down already led to the
  // cellar (3084, 9671) through Ladders; only Open did nothing.
  const closed = locAt(6434, 3084, 3272, 0);
  const visit = explorer([3084, 3273, 0]);
  visit.player.sendMessage = (text) => visit.ticks[visit.ticks.length - 1].push(`message ${text}`);
  const event = { player: visit.player, object: closed, objectId: closed.getId(), clickType: 1, handled: false };
  hooks.object(event);
  assert.equal(event.handled, true);
  runTicks(visit, 2);
  assert.deepEqual(visit.ticks, [["message You open the trapdoor."], ["anim 536", "sound 91"], []]);
  assert.ok(MapObjects.get(6435, new core.Location(3084, 3272, 0), null), "the open trapdoor is in place");
  assert.equal(MapObjects.get(6434, new core.Location(3084, 3272, 0), null), null, "the closed one is gone");
});

test("Monk's Friend keeps its cave ladder; other cellar ladders of that id go where the captures show", () => {
  // The ordinary cellar ladder (17385) is placed in many cellars; Monk's Friend sent every one of
  // them to its cave exit in Ardougne.
  const entry = data.locs.find((loc) => loc.id === 17385 && loc.x === 3405 && loc.y === 9907);
  assert.deepEqual(entry?.to, [3405, 3506, 0], "the cellar under the trapdoor north of Paterdomus");
  assert.ok(!data.locs.some((loc) => loc.x === 2561 && loc.y === 9622), "the cave's own ladder stays with the quest");
});

test("status lines, level-ups, food and unreachable clicks aren't refusals; a character turning the player away is", () => {
  const noise = ["<col=ff#>Your prayers have been drained!</col>", "Congratulations, you've just advanced your Agility level. You are now level #.",
    "You eat the shark.", "It heals some health.", "I can't reach that!", "<col=ef#>You have completed your task! You killed</col> # Bloodveld"];
  assert.deepEqual(refusals(captured({ failures: noise.map((message) => [message, 1]) })), []);
  assert.deepEqual(refusals(captured({ failures: [["Goblin guard|Go away, human! We already tell you not to come in!", 1]] })), ["Goblin guard|Go away, human! We already tell you not to come in!"]);
});

test("a gate decided in loc-teleport-sync.json lets a refused loc in, for one tile or every placement of a name", () => {
  const refused = { failures: [["Monk of Zamorak|You better dress appropriately, if you want to go up there!", 4]] };
  assert.match(choose(captured({ name: "chaos_temple_ladder", x: 2939, y: 3518, ...refused }), nothing, "Ladder", { ...decisions, requirements: [] }).reason, /refused/);
  assert.deepEqual(choose(captured({ name: "chaos_temple_ladder", x: 2939, y: 3518, ...refused }), nothing, "Ladder", decisions), { take: true });
  assert.ok(requirementFor({ name: "elid_crevice_clickzone", x: 3373, y: 2906, z: 0 }, decisions), "no tile: every placement");
  for (const entry of data.locs.filter((loc) => loc.name === "elid_crevice_clickzone")) assert.equal(entry.requires?.[0]?.tied, 954, `${entry.x},${entry.y}`);
});

/** Sets every skill's level, for a total. */
function withLevels(player, level) {
  for (const skill of core.Skill.values()) player.getSkillManager().setMaxLevel(skill, level, false).setCurrentLevels(skill, level, false);
}

test("the Chaos Temple ladder needs a total level of 500 and Zamorak robes worn, refusing as captured", () => {
  const object = locAt(31580, 2939, 3518, 0);
  const climb = (setup) => {
    const visit = explorer([2939, 3517, 0]);
    const said = [];
    visit.player.sendMessage = (text) => said.push(text);
    visit.player.getDialogueManager().startDialogues = (chain) => said.push([...chain.getDialogues().values()].map((line) => line.text).join(" / "));
    setup(visit.player);
    const request = { player: visit.player, object, objectId: object.getId(), clickType: 1, handled: false };
    hooks["ladders:climb"](request);
    runTicks(visit, 2);
    return { said, at: visit.player.getLocation().getZ() };
  };
  assert.deepEqual(climb((player) => withLevels(player, 1)), { said: ["You need a skill total of 500 and a set of Zamorak robes equipped to go upstairs."], at: 0 });
  assert.deepEqual(climb((player) => withLevels(player, 30)), { said: ["You better dress appropriately, if you want to go up there!"], at: 0 });
  const robed = climb((player) => {
    withLevels(player, 30);
    player.getEquipment().setItem(core.Equipment.BODY_SLOT, new core.Item(1035, 1)).setItem(core.Equipment.LEG_SLOT, new core.Item(1033, 1));
  });
  assert.deepEqual(robed, { said: [], at: 1 });
});

test("the Elid crevice needs a rope tied first: too steep without, and the rope stays tied", () => {
  const object = locAt(10416, 3374, 2905, 0);
  const visit = explorer([3375, 2905, 0]);
  const said = [];
  visit.player.getDialogueManager().startDialogues = (chain) => said.push([...chain.getDialogues().values()].map((line) => line.text).join(" / "));
  const climb = () => hooks.object({ player: visit.player, object, objectId: object.getId(), clickType: 1, handled: false });
  climb();
  runTicks(visit, 5);
  assert.deepEqual([said, visit.player.getLocation().getY()], [["That looks too steep to safely climb down with just your bare hands."], 2905]);
  const rope = { player: visit.player, object, objectId: object.getId(), itemId: 954, handled: false };
  hooks.itemOnObject(rope);
  assert.equal(rope.handled, true);
  runTicks(visit, 5);
  assert.deepEqual([said.at(-1), visit.player.getLocation().getY()], ["You climb down the rope.", 9305]);
  assert.deepEqual(visit.player.getAttribute("loc-teleports:tied"), ["elid_crevice_clickzone"], "tied for every later climb");
});

test("a window that asks first: the game's question, then out on Yes, a tick after the climb", () => {
  // Captured: "Climb out of the window?" Yes./No.; the climb and sound a tick after the answer, out a tick later.
  const object = locAt(52998, 1670, 3088, 0);
  const visit = explorer([1670, 3088, 0]);
  hooks.object({ player: visit.player, object, objectId: object.getId(), clickType: 1, handled: false });
  const prompt = prompts.pop();
  assert.deepEqual([prompt.title, prompt.options], ["Climb out of the window?", ["Yes.", "No."]]);
  prompt.pick("Yes.");
  runTicks(visit, 2);
  assert.deepEqual(visit.ticks, [[], ["anim 828", "sound 2452"], ["move 1670,3087,0"]]);
  const stay = explorer([1670, 3088, 0]);
  hooks.object({ player: stay.player, object, objectId: object.getId(), clickType: 1, handled: false });
  prompts.pop().pick("No.");
  runTicks(stay, 3);
  assert.deepEqual([stay.player.getLocation().getX(), stay.player.getLocation().getY()], [1670, 3088], "No. stays");
});

test("a ladder that asks up or down: the captured way goes there, the other is Ladders' to find", () => {
  const object = locAt(12965, 3164, 3307, 1);
  const visit = explorer([3164, 3306, 1]);
  hooks["ladders:climb"]({ player: visit.player, object, objectId: object.getId(), clickType: 1, handled: false });
  const prompt = prompts.pop();
  assert.deepEqual([prompt.title, prompt.options], ["Climb up or down the ladder?", ["Climb Up.", "Climb Down."]]);
  prompt.pick("Climb Down.");
  assert.equal(emitted.at(-1)[0], "ladders:climbDown");
  hooks["ladders:climb"]({ player: visit.player, object, objectId: object.getId(), clickType: 1, handled: false });
  prompts.pop().pick("Climb Up.");
  runTicks(visit, 1);
  assert.equal(visit.player.getLocation().getZ(), 2);
});
