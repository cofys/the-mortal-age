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
const VengeanceTimer = require("../plugins/interface/VengeanceTimer.plugin");

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
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
