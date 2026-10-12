// Run after `yarn build`: node --test tests/prayer-bot-integration.test.cjs
//
// Integration check: a bot in combat activates a prayer through the REAL
// engine PrayerHandler (compiled dist), the same code path a human's
// prayer-orb click ends in.
//
// Loading PrayerHandler as the entry point trips a circular import
// (Player -> QuickPrayers -> PrayerHandler) that the server's own boot
// order avoids; the QuickPrayers stub below breaks the cycle the same way
// boot order does. QuickPrayers itself is orb UI state — untouched by this
// work (a parallel workstream owns its lazy init).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");

// Break the Player -> QuickPrayers -> PrayerHandler load cycle.
{
  const qp = path.join(DIST, "game", "content", "QuickPrayers.js");
  require.cache[qp] = {
    id: qp,
    filename: qp,
    loaded: true,
    exports: { QuickPrayers: class QuickPrayers {} },
  };
}

const { PrayerHandler } = require(path.join(DIST, "game", "content", "PrayerHandler.js"));
const { Skill } = require(path.join(DIST, "game", "model", "Skill.js"));
const { BonusManager } = require(path.join(DIST, "game", "model", "equipment", "BonusManager.js"));

/**
 * A bot as the engine sees one: a Player instance. Implements every method
 * the real activatePrayerPrayerId / canUse / processDrain path touches.
 */
function makeBotPlayer({ prayerMax = 50, prayerPoints = 43, defence = 70 } = {}) {
  const prayers = new Array(29).fill(false);
  const varbits = new Map();
  const messages = [];
  const state = {
    prayerMax, prayerPoints, defence,
    draining: false,
    prayerPointDrain: 0,
    activatedThisTick: false,
    headHint: -1,
  };
  const player = {
    _prayers: prayers,
    _varbits: varbits,
    _messages: messages,
    _state: state,
    isNpc: () => false,
    isPlayer: () => true,
    isPlayerBot: () => true,
    getAsPlayer: () => player,
    getPrayerActive: () => prayers,
    setPrayerActive: (id, on) => { prayers[id] = on; },
    getHitpoints: () => 50,
    isSkulled: () => false,
    getSkullType: () => 0,
    isDrainingPrayer: () => state.draining,
    setDrainingPrayer: (v) => { state.draining = v; },
    getPrayerPointDrain: () => state.prayerPointDrain,
    setPrayerPointDrain: (v) => { state.prayerPointDrain = v; },
    markPrayerActivatedThisTick: () => { state.activatedThisTick = true; },
    consumePrayerActivatedThisTick: () => {
      const v = state.activatedThisTick;
      state.activatedThisTick = false;
      return v;
    },
    getSkillManager: () => ({
      getCurrentLevel: (s) => (s === Skill.PRAYER ? state.prayerPoints : 1),
      getMaxLevel: (s) =>
        s === Skill.PRAYER ? state.prayerMax : s === Skill.DEFENCE ? state.defence : 1,
      setCurrentLevel: (s, v) => {
        if (s === Skill.PRAYER) state.prayerPoints = v;
      },
    }),
    getCombat: () => ({
      getPrayerBlockTimer: () => ({ finished: () => true }),
    }),
    getDueling: () => ({ inDuel: () => false }),
    getBonusManager: () => ({
      attackBonus: new Array(5).fill(0),
      defenceBonus: new Array(5).fill(0),
      otherBonus: new Array(10).fill(0),
      getOtherBonus: function () { return this.otherBonus; },
    }),
    getEquipment: () => ({ getItems: () => [] }),
    getQuickPrayers: () => ({ checkActive: () => {}, setEnabled: () => {} }),
    getAppearance: () => ({ setHeadHint: (h) => { state.headHint = h; } }),
    getPacketSender: () => ({
      sendVarbit: (id, v) => varbits.set(id, v),
      sendQuickPrayersState: () => {},
    }),
    sendMessage: (m) => messages.push(m),
    getUsername: () => "PrayerBot",
  };
  return player;
}

test("bot activates Protect from Melee through the real PrayerHandler", () => {
  const bot = makeBotPlayer({ prayerMax: 50, prayerPoints: 43 });
  // Sanity on the stable public ids this work targets.
  assert.equal(PrayerHandler.PROTECT_FROM_MELEE, 18);
  assert.equal(PrayerHandler.PROTECT_FROM_MAGIC, 16);
  assert.equal(PrayerHandler.PROTECT_FROM_MISSILES, 17);
  assert.equal(PrayerHandler.PROTECT_ITEM, 10);
  assert.equal(PrayerHandler.PIETY, 26);

  PrayerHandler.activatePrayerPrayerId(bot, PrayerHandler.PROTECT_FROM_MELEE);

  assert.equal(bot._prayers[PrayerHandler.PROTECT_FROM_MELEE], true, "overhead is active");
  assert.equal(bot._varbits.get(4118), 1, "client varbit lit (config 4118)");
  assert.equal(bot._state.draining, true, "prayer drain started");
  assert.equal(bot._state.headHint, 0, "melee overhead head icon");
});

test("overhead swap deactivates the old overhead (real engine exclusivity)", () => {
  const bot = makeBotPlayer({ prayerMax: 50, prayerPoints: 43 });
  PrayerHandler.activatePrayerPrayerId(bot, PrayerHandler.PROTECT_FROM_MELEE);
  assert.equal(bot._prayers[18], true);
  PrayerHandler.activatePrayerPrayerId(bot, PrayerHandler.PROTECT_FROM_MAGIC);
  assert.equal(bot._prayers[18], false, "melee overhead dropped");
  assert.equal(bot._prayers[16], true, "magic overhead up");
  assert.equal(bot._state.headHint, 2, "magic overhead head icon");
});

test("engine refuses piety below the prayer/defence requirements", () => {
  const bot = makeBotPlayer({ prayerMax: 50, prayerPoints: 50, defence: 70 });
  PrayerHandler.activatePrayerPrayerId(bot, PrayerHandler.PIETY);
  assert.equal(bot._prayers[PrayerHandler.PIETY], false, "piety refused at prayer 50 (req 70)");
  assert.ok(
    bot._messages.some((m) => /Prayer level/i.test(m)),
    "engine explains the requirement"
  );

  const pious = makeBotPlayer({ prayerMax: 99, prayerPoints: 99, defence: 99 });
  PrayerHandler.activatePrayerPrayerId(pious, PrayerHandler.PIETY);
  assert.equal(pious._prayers[PrayerHandler.PIETY], true, "piety allowed at 99 prayer/99 defence");
});

test("engine refuses prayers at 0 prayer points", () => {
  const bot = makeBotPlayer({ prayerMax: 50, prayerPoints: 0 });
  PrayerHandler.activatePrayerPrayerId(bot, PrayerHandler.PROTECT_FROM_MELEE);
  assert.equal(bot._prayers[PrayerHandler.PROTECT_FROM_MELEE], false, "no points, no prayer");
});

test("real drain ticks prayer points down while an overhead is up", () => {
  const bot = makeBotPlayer({ prayerMax: 99, prayerPoints: 99 });
  PrayerHandler.activatePrayerPrayerId(bot, PrayerHandler.PROTECT_FROM_MELEE);
  const before = bot._state.prayerPoints;
  // First processDrain call is the free activation tick; drain after that.
  PrayerHandler.processDrain(bot);
  for (let i = 0; i < 200; i++) PrayerHandler.processDrain(bot);
  assert.ok(bot._state.prayerPoints < before, `drained ${before} -> ${bot._state.prayerPoints}`);
});

test("deactivatePrayers drops everything the brain put up", () => {
  const bot = makeBotPlayer({ prayerMax: 99, prayerPoints: 99, defence: 99 });
  PrayerHandler.activatePrayerPrayerId(bot, PrayerHandler.PROTECT_FROM_MELEE);
  PrayerHandler.activatePrayerPrayerId(bot, PrayerHandler.PIETY);
  assert.ok(bot._prayers[18] && bot._prayers[26]);
  PrayerHandler.deactivatePrayers(bot);
  assert.ok(bot._prayers.every((p) => !p), "all prayers off");
  assert.equal(bot._state.headHint, -1, "head icon cleared");
});

test("getProtectingPrayer maps threat styles to overheads", () => {
  const { CombatType } = require(path.join(DIST, "game", "content", "combat", "CombatType.js"));
  assert.equal(PrayerHandler.getProtectingPrayer(CombatType.MELEE), 18);
  assert.equal(PrayerHandler.getProtectingPrayer(CombatType.RANGED), 17);
  assert.equal(PrayerHandler.getProtectingPrayer(CombatType.MAGIC), 16);
});
