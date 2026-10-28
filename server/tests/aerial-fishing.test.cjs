const assert = require("node:assert/strict");
const { test, before, afterEach } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const C = require("../plugins/skills/hunter/Context.Hunter");
const Aerial = require("../plugins/skills/hunter/Aerial.Hunter");
let core;

before(async () => {
  await CachePipeline.initialize(process.cwd());
  core = PluginManager.getCoreApi();
  C.H.core = core;
  C.H.data = require("../plugins/skills/hunter/Data.Hunter").build(core);
  C.H.api = { emitCustomEvent() {} };
});
afterEach(() => {
  for (const player of C.H.players) { Aerial.cleanup({ player }); C.cancel(player); }
  C.H.players.clear();
});

function scene({ hunter = 35, fishing = 43, range = 2 } = {}) {
  const I = core.ItemIdentifiers;
  const levels = new Map([[core.Skill.HUNTER, hunter], [core.Skill.FISHING, fishing]]);
  const counts = new Map([[I.FISH_OFFCUTS, 10]]), attributes = new Map(), equipment = new Map();
  const experience = new Map(), messages = [];
  const at = new core.Location(1367, 3631, 0);
  const destination = at.clone().add(range, 0);
  const empty = new core.Item(-1, 0);
  const sender = { sendGraphic() {}, sendProjectile() {} };
  const player = {
    counts, levels, experience, messages,
    getPrivateArea: () => null,
    getLocation: () => at,
    isRegistered: () => true,
    getHitpoints: () => 10,
    busy: () => false,
    getCombat: () => ({ getTarget: () => null, getAttacker: () => null }),
    getAttribute: key => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getSkillManager: () => ({
      getCurrentLevel: skill => levels.get(skill) ?? 1,
      stopSkillable() {},
      addExperiences: (skill, xp) => experience.set(skill, (experience.get(skill) ?? 0) + xp),
    }),
    getInventory: () => ({
      getItems: () => [...counts].map(([id, n]) => new core.Item(id, n)),
      capacity: () => 28,
      contains: id => (counts.get(id) ?? 0) > 0,
      deleteNumber: (id, n) => counts.set(id, (counts.get(id) ?? 0) - n),
      adds: (id, n) => counts.set(id, (counts.get(id) ?? 0) + n),
    }),
    getEquipment: () => ({
      get: slot => equipment.get(slot) ?? empty,
      set: (slot, item) => equipment.set(slot, item),
      getItems: () => [...equipment.values()],
      refreshItems() {},
    }),
    getUpdateFlag: () => ({ flag() {} }),
    getPacketSender: () => sender,
    performAnimation() {},
    sendMessage: message => messages.push(message),
    getBank: () => null,
  };
  const npc = { getLocation: () => destination, getPrivateArea: () => null };
  return { player, npc };
}

function catchFish(t, s) {
  // Midpoint avoids the rare tench, pearl and clue rolls; minimum-level fish is bluegill.
  const saved = Math.random;
  Math.random = () => 0.5;
  t.after(() => { Math.random = saved; });
  assert.equal(Aerial.fish({ ...s, npcId: core.NpcIdentifiers.FISHING_SPOT_12 }), true);
}
function advance(ticks) {
  for (let i = 0; i < ticks; i++) { C.H.tick++; C.processActions(); }
}
function assertBluegill(player) {
  assert.equal(player.counts.get(core.ItemIdentifiers.BLUEGILL), 1);
  assert.equal(player.experience.get(core.Skill.HUNTER), 16.5);
  assert.equal(player.experience.get(core.Skill.FISHING), 11.5);
}

test("minimum levels are required to borrow the cormorant", () => {
  for (const stats of [{ hunter: 34 }, { fishing: 42 }]) {
    const { player } = scene(stats);
    Aerial.borrow({ player });
    assert.ok(player.messages.some(message => message.startsWith("You need level")));
    assert.equal(player.getEquipment().get(core.Equipment.WEAPON_SLOT).getId(), -1);
  }
});

test("a borrowed cormorant catches bluegill after both borrowing boosts expire", t => {
  const s = scene();
  Aerial.borrow(s);
  s.player.levels.set(core.Skill.HUNTER, 34);
  s.player.levels.set(core.Skill.FISHING, 42);
  catchFish(t, s);
  advance(1);
  assertBluegill(s.player);
  assert.equal(s.player.counts.get(core.ItemIdentifiers.FISH_OFFCUTS), 10);
});

test("boost expiry while the bird is in flight still awards the guaranteed catch", t => {
  const s = scene({ range: 5 });
  Aerial.borrow(s);
  catchFish(t, s);
  advance(1);
  assert.equal(s.player.counts.get(core.ItemIdentifiers.BLUEGILL), undefined);
  s.player.levels.set(core.Skill.HUNTER, 34);
  s.player.levels.set(core.Skill.FISHING, 42);
  advance(2);
  assertBluegill(s.player);
});

test("no bird or no bait still prevents a catch", t => {
  const s = scene();
  catchFish(t, s);
  advance(5);
  assert.equal(s.player.experience.size, 0);
  Aerial.borrow(s);
  s.player.counts.clear();
  catchFish(t, s);
  advance(5);
  assert.equal(s.player.experience.size, 0);
});

test("walking away cancels the in-flight catch", t => {
  const s = scene({ range: 5 });
  Aerial.borrow(s);
  catchFish(t, s);
  s.player.getLocation().add(1, 0);
  advance(3);
  assert.equal(s.player.experience.size, 0);
});

for (const skill of ["HUNTER", "FISHING"]) {
  test(`expiry of only the ${skill} borrowing boost still allows bluegill`, t => {
    const s = scene();
    Aerial.borrow(s);
    s.player.levels.set(core.Skill[skill], skill === "HUNTER" ? 34 : 42);
    catchFish(t, s);
    advance(1);
    assertBluegill(s.player);
  });
}

test("returning the bird before arrival cancels the catch", t => {
  const s = scene({ range: 5 });
  Aerial.borrow(s);
  catchFish(t, s);
  Aerial.cleanup(s);
  advance(3);
  assert.equal(s.player.experience.size, 0);
});
