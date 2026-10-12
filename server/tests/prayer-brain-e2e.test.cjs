// Run after `yarn build`: node --test tests/prayer-brain-e2e.test.cjs
//
// End-to-end: the citizen prayer BRAIN (real decision logic, real engine
// module access via the _setEngine seam) drives the REAL compiled engine
// PrayerHandler. A bot "in combat" with a melee NPC ends up with Protect
// from Melee + Piety actually active in engine state — the exact combat
// tell this work removes.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
const ACTIONS = path.join(__dirname, "..", "plugins", "citizens", "brain", "actions");

// Break the Player -> QuickPrayers -> PrayerHandler load cycle (see
// prayer-bot-integration.test.cjs).
{
  const qp = path.join(DIST, "game", "content", "QuickPrayers.js");
  require.cache[qp] = {
    id: qp,
    filename: qp,
    loaded: true,
    exports: { QuickPrayers: class QuickPrayers {} },
  };
}
// BotNavigation pulls TS at load; the brain only needs requestMovement.
{
  const nav = path.resolve(ACTIONS, "../../../bots/behaviours/navigation/BotNavigation");
  const resolved = require.resolve(nav);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { requestMovement: () => {}, clearMovementRequest: () => {} },
  };
}

const { PrayerHandler } = require(path.join(DIST, "game", "content", "PrayerHandler.js"));
const { Skill } = require(path.join(DIST, "game", "model", "Skill.js"));
const { CombatType } = require(path.join(DIST, "game", "content", "combat", "CombatType.js"));
const { CombatFactory } = require(path.join(DIST, "game", "content", "combat", "CombatFactory.js"));
const { Animation } = require(path.join(DIST, "game", "model", "Animation.js"));
const { Item } = require(path.join(DIST, "game", "model", "Item.js"));
const { Sound } = require(path.join(DIST, "game", "Sound.js"));
const { Sounds } = require(path.join(DIST, "game", "Sounds.js"));
const { ItemDefinition } = require(path.join(DIST, "game", "definition", "ItemDefinition.js"));
const { ItemIdentifiers } = require(path.join(DIST, "util", "ItemIdentifiers.js"));
const { ObjectIdentifiers } = require(path.join(DIST, "util", "ObjectIdentifiers.js"));
const { BONE_XP } = require(path.join(DIST, "game", "content", "combat", "magic", "ArceuusOfferings.js"));

const Prayer = require(path.join(ACTIONS, "CitizenPrayer.js"));

// Install the REAL engine into the brain's seam.
Prayer._setEngine({
  PrayerHandler, Skill, CombatFactory, CombatType, Animation, Item,
  Sound, Sounds, ItemDefinition, ItemIdentifiers, ObjectIdentifiers, BONE_XP,
  altarIds: null,
});

function makeCombat() {
  return {
    _target: null, _attacker: null, _ammo: null, _weapon: null,
    getTarget() { return this._target; },
    getAttacker() { return this._attacker; },
    getPrayerBlockTimer: () => ({ finished: () => true }),
    getAmmunition() { return this._ammo; },
    setAmmunition(a) { this._ammo = a; },
    getRangedWeapon() { return this._weapon; },
    setRangedWeapon(w) { this._weapon = w; },
    getCastSpell: () => null,
    getAutocastSpell: () => null,
  };
}

function makeBot({ prayerMax = 99, prayerPoints = 99, defence = 99, traits = [], username = "E2EBot" } = {}) {
  const prayers = new Array(29).fill(false);
  const varbits = new Map();
  const attrs = new Map([["citizens:personality", { traits }]]);
  const combat = makeCombat();
  const emptyItem = { getId: () => -1 };
  const state = { prayerMax, prayerPoints, defence, draining: false, pointDrain: 0, flick: false };
  const bot = {
    _prayers: prayers,
    _combat: combat,
    getUsername: () => username,
    getAttribute: (k) => attrs.get(k) ?? null,
    isNpc: () => false,
    isPlayer: () => true,
    isPlayerBot: () => true,
    getAsPlayer: () => bot,
    getPrayerActive: () => prayers,
    setPrayerActive: (id, on) => { prayers[id] = on; },
    getHitpoints: () => 60,
    isSkulled: () => false,
    getSkullType: () => 0,
    isDrainingPrayer: () => state.draining,
    setDrainingPrayer: (v) => { state.draining = v; },
    getPrayerPointDrain: () => state.pointDrain,
    setPrayerPointDrain: (v) => { state.pointDrain = v; },
    markPrayerActivatedThisTick: () => { state.flick = true; },
    consumePrayerActivatedThisTick: () => {
      const v = state.flick; state.flick = false; return v;
    },
    isSpecialActivated: () => false,
    getSkillManager: () => ({
      getCurrentLevel: (s) => (s === Skill.PRAYER ? state.prayerPoints : 1),
      getMaxLevel: (s) =>
        s === Skill.PRAYER ? state.prayerMax : s === Skill.DEFENCE ? state.defence : 1,
      setCurrentLevel: (s, v) => { if (s === Skill.PRAYER) state.prayerPoints = v; },
      getCombatLevel: () => 100,
    }),
    getCombat: () => combat,
    getDueling: () => ({ inDuel: () => false }),
    getBonusManager: () => ({
      attackBonus: new Array(5).fill(0),
      defenceBonus: new Array(5).fill(0),
      otherBonus: new Array(10).fill(0),
      getOtherBonus: function () { return this.otherBonus; },
    }),
    getEquipment: () => ({
      getItems: () => new Array(14).fill(emptyItem),
      hasStaffEquipped: () => false,
      contains: () => false,
    }),
    getInventory: () => ({
      getAmount: () => 0,
      getSlotForItemId: () => -1,
      getItems: () => [],
      contains: () => false,
    }),
    getQuickPrayers: () => ({ checkActive: () => {}, setEnabled: () => {} }),
    getAppearance: () => ({ setHeadHint: () => {} }),
    getPacketSender: () => ({
      sendVarbit: (id, v) => varbits.set(id, v),
      sendQuickPrayersState: () => {},
    }),
    getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
    sendMessage: () => {},
    performAnimation: () => {},
  };
  return bot;
}

function makeNpc(style, combatLevel) {
  const npc = {
    isNpc: () => true,
    isPlayer: () => false,
    getAsNpc: () => npc,
    getId: () => 117,
    getRealId: () => 117,
    getCombatMethod: () => ({ type: () => style }),
    getCurrentDefinition: () => ({ getCombatLevel: () => combatLevel }),
    getLocation: () => ({ getX: () => 3202, getY: () => 3202, getZ: () => 0 }),
  };
  return npc;
}

test("brain puts up Protect from Melee + Piety vs a melee boss via the real engine", () => {
  const bot = makeBot({ traits: ["devout"] });
  const boss = makeNpc(CombatType.MELEE, 318); // melee boss
  bot._combat._attacker = boss;
  bot._combat._target = boss;

  const res = Prayer.maintainCombatPrayer(bot, boss);

  assert.ok(res.activated.includes(PrayerHandler.PROTECT_FROM_MELEE),
    `protect from melee activated, got [${res.activated}]`);
  assert.ok(res.activated.includes(PrayerHandler.PIETY),
    `piety activated, got [${res.activated}]`);
  assert.equal(PrayerHandler.isActivated(bot, PrayerHandler.PROTECT_FROM_MELEE), true,
    "real engine state: overhead on");
  assert.equal(PrayerHandler.isActivated(bot, PrayerHandler.PIETY), true,
    "real engine state: piety on");
});

test("brain swaps overhead when the threat changes style (real engine)", () => {
  const bot = makeBot({});
  const meleeNpc = makeNpc(CombatType.MELEE, 92);
  bot._combat._attacker = meleeNpc;
  Prayer.maintainCombatPrayer(bot, meleeNpc);
  assert.equal(PrayerHandler.isActivated(bot, 18), true);

  const mageNpc = makeNpc(CombatType.MAGIC, 92);
  bot._combat._attacker = mageNpc;
  // force a re-decision past the human-cadence window
  const res = Prayer.maintainCombatPrayer(bot, mageNpc, { nowMs: Date.now() + 10000 });
  assert.equal(PrayerHandler.isActivated(bot, 18), false, "melee overhead off");
  assert.equal(PrayerHandler.isActivated(bot, 16), true, "magic overhead on");
  assert.ok(res.decision.overhead === 16, "decision tracks the swap");
});

test("brain prays nothing vs a trivial threat (goblin)", () => {
  const bot = makeBot({ traits: ["devout"] });
  const goblin = makeNpc(CombatType.MELEE, 2);
  bot._combat._attacker = goblin;
  const res = Prayer.maintainCombatPrayer(bot, goblin);
  assert.deepEqual(res.activated, [], "no prayers vs a level-2 goblin");
  assert.ok(bot._prayers.every((p) => !p), "engine state untouched");
});

test("brain releases everything when the fight ends (real engine)", () => {
  const bot = makeBot({});
  const npc = makeNpc(CombatType.MELEE, 92);
  bot._combat._attacker = npc;
  Prayer.maintainCombatPrayer(bot, npc);
  assert.ok(bot._prayers.some((p) => p), "prayers were up");
  const released = Prayer.releaseCombatPrayers(bot);
  assert.ok(released > 0, "released prayers");
  assert.ok(bot._prayers.every((p) => !p), "real engine state: all off");
});
