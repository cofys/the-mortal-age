// Run after `yarn build`: node --test tests/keldagrim-access.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { PluginManager } = require("../dist/plugins/PluginManager");
const core = PluginManager.getCoreApi();
const Keldagrim = require("../plugins/areas/Keldagrim.plugin");
const Rellekka = require("../plugins/areas/Rellekka.plugin");

test("the Rellekka tunnel reaches the cave, while the city passage needs The Giant Dwarf started", () => {
  let started = false;
  const pluginApi = {
    core,
    emitCustomEvent(name, request) {
      if (name === "quest:is-started") request.started = started;
    },
  };
  Keldagrim._test.init(pluginApi);
  Rellekka.register({ core, onObjectInteraction() {} });

  const landings = [];
  const messages = [];
  const player = {
    moveTo: (location) => landings.push([location.getX(), location.getY()]),
    sendMessage: (message) => messages.push(message),
  };
  const entry = { player, location: { x: 2731, y: 3712, z: 0 }, handled: false };
  Rellekka._test.enterTunnel(entry);
  assert.deepEqual(landings, [[2773, 10162]], "the cave remains reachable so the quest can be started");

  Keldagrim._test.goThrough({ player, objectId: core.ObjectIdentifiers.CAVE_ENTRANCE_29 });
  assert.deepEqual(landings, [[2773, 10162]], "the city passage rejects an unstarted quest");
  assert.match(messages[0], /start The Giant Dwarf/);

  started = true;
  Keldagrim._test.goThrough({ player, objectId: core.ObjectIdentifiers.CAVE_ENTRANCE_29 });
  assert.deepEqual(landings.at(-1), [2838, 10124], "starting The Giant Dwarf opens the city passage");
});

test("the ferrymen's Travel takes the 2-coin fare, one coin as the transcript's exception, and refuses with none", () => {
  const starts = [];
  Keldagrim._test.init({ core, emitCustomEvent(name, request) { if (name === "npc-dialogue:start") { starts.push(request); request.handled = true; } } });
  const npcId = core.NpcIdentifiers.DWARVEN_FERRYMAN;
  const rider = (coins) => {
    let balance = coins;
    const landings = [];
    return {
      landings,
      get coins() { return balance; },
      moveTo: (location) => landings.push([location.getX(), location.getY()]),
      sendMessage() {},
      getInventory: () => ({
        getAmount: () => balance,
        deleteNumber: (id, amount) => { balance -= amount; },
      }),
    };
  };
  const rich = rider(10);
  Keldagrim._test.travel({ player: rich, npcId });
  assert.equal(rich.coins, 8);
  assert.equal(rich.landings.length, 1);

  const one = rider(1);
  Keldagrim._test.travel({ player: one, npcId });
  assert.equal(one.coins, 0);
  assert.equal(one.landings.length, 1, "one coin is the transcript's exception");

  const none = rider(0);
  Keldagrim._test.travel({ player: none, npcId });
  assert.equal(none.landings.length, 0, "no free crossing");
  const page = require("../data/definitions/npc-dialogues.json")["Dwarven Ferryman"];
  const picked = starts.at(-1).select(page.variants[starts.at(-1).variant]);
  // The dialogue engine follows "call" steps into the page's branches.
  const lines = JSON.stringify(picked.flatMap((step) => (step.type === "call" ? page.branches[step.branch] : [step])));
  assert.match(lines, /You don't even have 2 gold coins, humans?!/);
});
