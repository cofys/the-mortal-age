// Run after `yarn build`: node --test tests/vengeance.test.cjs
// Vengeance and Vengeance Other, against the OSRS Wiki (Vengeance, Vengeance_Other) and
// rsprox captures of live OSRS (docs/vengeance.md).
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { EffectSpells } = require("../dist/game/content/combat/magic/EffectSpells");
const { LunarSpells } = require("../dist/game/content/combat/magic/LunarSpells");
const { Spell } = require("../dist/game/content/combat/magic/Spell");
const { SecondsTimer } = require("../dist/game/model/SecondsTimer");
const { Skill } = require("../dist/game/model/Skill");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const VengeanceTimer = require("../plugins/interface/VengeanceTimer.plugin");

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  require("../plugins/items/BlightedSpellSacks.plugin").register(PluginManager.createApi("BlightedSpellSacksTest"));
});

const COOLDOWN_MESSAGE = "You can only cast vengeance spells every 30 seconds.";

/** Replaces `object[key]` with `value` while `run` runs. */
function withStub(object, key, value, run) {
  const original = object[key];
  object[key] = value;
  try {
    return run();
  } finally {
    object[key] = original;
  }
}

const castable = (run) => withStub(Spell.prototype, "canCast", () => true, run);

/** A Lunar caster with real vengeance state that records messages, XP and varbits. */
function lunarPlayer() {
  const player = {
    messages: [],
    experience: [],
    varbits: [],
    vengeance: false,
    timer: new SecondsTimer(),
    attributes: new Map(),
    getDueling: () => ({ inDuel: () => false }),
    getSkillManager: () => ({
      getMaxLevel: () => 99,
      getCurrentLevel: () => 99,
      addExperiences(skill, amount) { player.experience.push([skill, amount]); },
    }),
    hasVengeanceReturn: () => player.vengeance,
    setHasVengeance(value) { player.vengeance = value; },
    getVengeanceTimer: () => player.timer,
    getInventory: () => ({ deleteItemSet() {} }),
    getLocation: () => ({ isWithinDistance: () => true }),
    getAttribute(key) { return player.attributes.get(key) ?? null; },
    setAttribute(key, value) { player.attributes.set(key, value); },
    performAnimation() {},
    performGraphic() {},
    sendMessage(message) { player.messages.push(message); },
    getPacketSender: () => {
      const sender = {
        sendEffectTimer: () => sender,
        sendMessage(message) { player.messages.push(message); return sender; },
        sendVarbit(id, value) { player.varbits.push([id, value]); return sender; },
      };
      return sender;
    },
  };
  return player;
}

const castVengeance = (player) => castable(() => LunarSpells.handleSelf(player, "Vengeance"));
const castVengeanceOther = (player, target) => castable(() => LunarSpells.handlePlayerTarget(player, target, "Vengeance Other"));

test("Vengeance gives 112 Magic XP and no chat message", () => {
  const player = lunarPlayer();
  assert.equal(castVengeance(player), true);
  assert.equal(player.vengeance, true);
  assert.deepEqual(player.experience, [[Skill.MAGIC, 112]]);
  assert.deepEqual(player.messages, []);
  assert.equal(player.timer.finished(), false);
});

test("a vengeance spell on cooldown gives the live message", () => {
  const player = lunarPlayer();
  castVengeance(player);
  player.vengeance = false; // the rebound has fired, the cooldown still runs
  castVengeance(player);
  assert.equal(player.vengeance, false);
  assert.deepEqual(player.messages, [COOLDOWN_MESSAGE]);
  assert.equal(player.experience.length, 1);
});

test("Vengeance Other puts the caster on the shared cooldown, not the target", () => {
  const caster = lunarPlayer();
  const target = lunarPlayer();
  castVengeanceOther(caster, target);
  assert.equal(target.vengeance, true);
  assert.deepEqual(target.messages, ["You have the power of vengeance!"]);
  assert.equal(caster.timer.finished(), false, "caster's cooldown");
  assert.equal(target.timer.finished(), true, "target's cooldown");
  target.vengeance = false;
  castVengeance(target);
  assert.equal(target.vengeance, true, "the target can still cast Vengeance itself");

  const other = lunarPlayer();
  castVengeanceOther(caster, other);
  assert.equal(other.vengeance, false);
  assert.deepEqual(caster.messages, [COOLDOWN_MESSAGE]);
  castVengeance(caster);
  assert.equal(caster.vengeance, false, "Vengeance shares the cooldown");
});

test("a target on its own vengeance cooldown can still receive Vengeance Other", () => {
  const caster = lunarPlayer();
  const target = lunarPlayer();
  castVengeance(target);
  target.vengeance = false;
  castVengeanceOther(caster, target);
  assert.equal(target.vengeance, true);
});

function sackCaster({ x = 3100, y = 3600, sacks = 2, magic = 99, defence = 99, book } = {}) {
  const core = PluginManager.getCoreApi();
  const player = new Player(null);
  const sender = new Proxy({}, { get: () => () => sender });
  player.getPacketSender = () => sender;
  player.messages = [];
  player.sendMessage = (message) => player.messages.push(message);
  player.setLocation(new core.Location(x, y, 0));
  player.setSpellbook(book ?? core.MagicSpellbook.LUNAR);
  for (const [skill, level] of [[Skill.MAGIC, magic], [Skill.DEFENCE, defence]]) {
    player.getSkillManager().setMaxLevels(skill, level, false);
    player.getSkillManager().setCurrentLevel(skill, level, false);
  }
  player.getInventory().resetItems();
  if (sacks) player.getInventory().add(new core.Item(core.ItemIdentifiers.BLIGHTED_VENGEANCE_SACK, sacks), false);
  return player;
}

test("blighted sacks pay one complete Vengeance cast, retaining regular runes and cooldown", () => {
  const core = PluginManager.getCoreApi();
  const player = sackCaster();
  for (const item of EffectSpells.VENGEANCE.itemsRequired(player)) player.getInventory().add(item.clone(), false);
  assert.equal(LunarSpells.handleSelf(player, "Vengeance"), true);
  assert.equal(player.hasVengeanceReturn(), true);
  assert.equal(player.getInventory().getAmount(core.ItemIdentifiers.BLIGHTED_VENGEANCE_SACK), 1);
  assert.ok(EffectSpells.VENGEANCE.itemsRequired(player).every(item => player.getInventory().getAmount(item.id) === item.getAmount()));
  player.setHasVengeance(false);
  LunarSpells.handleSelf(player, "Vengeance");
  assert.equal(player.getInventory().getAmount(core.ItemIdentifiers.BLIGHTED_VENGEANCE_SACK), 1);
  assert.ok(player.messages.includes(COOLDOWN_MESSAGE));
});

test("blighted sacks also fund Vengeance Other, with normal target and cooldown checks", () => {
  const core = PluginManager.getCoreApi();
  const caster = sackCaster();
  const target = sackCaster({ x: 3101 });
  target.setAttribute("accept-aid", false);
  assert.equal(LunarSpells.handlePlayerTarget(caster, target, "Vengeance Other"), false);
  assert.equal(caster.getInventory().getAmount(core.ItemIdentifiers.BLIGHTED_VENGEANCE_SACK), 2);
  target.setAttribute("accept-aid", true);
  assert.equal(LunarSpells.handlePlayerTarget(caster, target, "Vengeance Other"), true);
  assert.equal(target.hasVengeanceReturn(), true);
  assert.equal(caster.getInventory().getAmount(core.ItemIdentifiers.BLIGHTED_VENGEANCE_SACK), 1);
  assert.equal(caster.getVengeanceTimer().finished(), false);
  assert.equal(target.getVengeanceTimer().finished(), true);
});

test("sacks preserve spell requirements and cannot supply another Lunar spell", () => {
  const core = PluginManager.getCoreApi();
  for (const options of [
    { magic: 93 }, { defence: 39 }, { book: core.MagicSpellbook.NORMAL },
    { x: 3200, y: 3200 }, { sacks: 0 },
  ]) {
    const player = sackCaster(options);
    LunarSpells.handleSelf(player, "Vengeance");
    assert.equal(player.hasVengeanceReturn(), false, JSON.stringify(options));
    assert.equal(player.getInventory().getAmount(core.ItemIdentifiers.BLIGHTED_VENGEANCE_SACK), options.sacks ?? 2);
  }
  const player = sackCaster();
  LunarSpells.handleSelf(player, "Dream");
  assert.equal(player.getInventory().getAmount(core.ItemIdentifiers.BLIGHTED_VENGEANCE_SACK), 2);
  assert.ok(player.messages.some(message => message.includes("required items")));
});

test("sacks can be used in Ferox, Mage Arena bank, supported PvP minigames and PvP worlds", (t) => {
  const core = PluginManager.getCoreApi();
  const players = [sackCaster({ x: 3130, y: 3630 }), sackCaster({ x: 2539, y: 4712 })];
  for (const name of ["Castle Wars", "Soul Wars"]) {
    const player = sackCaster({ x: 3200, y: 3200 });
    player.getArea = () => ({ getName: () => name });
    players.push(player);
  }
  for (const player of players) {
    LunarSpells.handleSelf(player, "Vengeance");
    assert.equal(player.hasVengeanceReturn(), true);
  }
  t.mock.method(core.WorldDefinition, "hasGlobalWorldTag", tag => tag === "pvp");
  const pvp = sackCaster({ x: 3200, y: 3200 });
  LunarSpells.handleSelf(pvp, "Vengeance");
  assert.equal(pvp.hasVengeanceReturn(), true);
});

test("vengeance_rebound follows the effect; vengeance_timelimit the cooldown", () => {
  const hooks = {};
  VengeanceTimer.register({
    onPlayerLogin: (handler) => { hooks.login = handler; },
    onPlayerProcess: (handler) => { hooks.process = handler; },
    onPlayerLogout: (handler) => { hooks.logout = handler; },
  });
  const player = lunarPlayer();
  hooks.login({ player });
  assert.deepEqual(player.varbits, [[2451, 0], [2450, 0]]);
  castVengeance(player);
  player.varbits.length = 0;
  hooks.process({ player });
  assert.deepEqual(player.varbits, [[2451, 1], [2450, 1]]);
  player.varbits.length = 0;
  player.vengeance = false;
  hooks.process({ player });
  assert.deepEqual(player.varbits, [[2450, 0]]);
});

test("Vengeance can't be cast in a player-owned house, and entering one ends it", () => {
  const core = PluginManager.getCoreApi();
  const hooks = [];
  require("../plugins/skills/construction/Core.Construction").init({ core });
  const Instance = require("../plugins/skills/construction/Instance.Construction");
  const House = require("../plugins/skills/construction/House.Construction");
  const api = new Proxy({}, {
    get: (_, name) => (name === "onSpellDisabled" ? (handler) => hooks.push(handler) : () => {}),
  });
  House.attach(api);
  assert.equal(hooks.length, 1);

  const house = Object.create(Instance.PlayerHouseInstance.prototype);
  const player = lunarPlayer();
  player.getPrivateArea = () => house;
  const event = (spell) => ({ player, spellbook: null, spellId: spell.spellId(), spell, disabled: null });
  const vengeance = event(EffectSpells.VENGEANCE);
  hooks[0](vengeance);
  assert.equal(vengeance.disabled, true);
  assert.deepEqual(player.messages, ["You can't use this spell inside a player-owned house."]);
  const other = event(EffectSpells.BONES_TO_BANANAS);
  hooks[0](other);
  assert.equal(other.disabled, null);
  player.getPrivateArea = () => null;
  const outside = event(EffectSpells.VENGEANCE);
  hooks[0](outside);
  assert.equal(outside.disabled, null);

  player.vengeance = true;
  Object.assign(house, {
    save: {},
    getTemplateObjects() {},
    enter() {},
    getEntryLocation: () => null,
    rebuild: () => false,
  });
  player.getArea = () => null;
  player.moveTo = () => {};
  withStub(Instance.PlayerHouseInstance, "getTemplateObjects", () => {}, () => house.enterHouse(player, false));
  assert.equal(player.vengeance, false);
});
