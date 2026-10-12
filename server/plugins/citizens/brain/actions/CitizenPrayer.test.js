"use strict";

/**
 * CitizenPrayer unit checks — bot prayer usage for citizens.
 *
 * Proves the brain's contracts without a running server:
 *   - decidePrayers: overhead by threat style, DPS by bot style, protect
 *     item when skulled/rich, nothing on trivial fights, nothing at 0
 *     points, proud citizens keep DPS over protection when low.
 *   - bestDpsPrayer: piety > chivalry > ultimate strength gating by
 *     prayer/defence levels; rigour/augury lines.
 *   - prayerProfile: devout prays early, greedy won't bank for potions,
 *     clumsy reacts late, proud biases DPS; stable per username.
 *   - maintainCombatPrayer (fake engine via _setEngine): activates the
 *     decided overhead + DPS via the engine API, deactivates stale
 *     overheads on threat change, sips a potion at the personality
 *     threshold, releases everything on releaseCombatPrayers.
 *   - drinkPrayerPotion: dose swap 4->3->2->1->vial, real restore math
 *     (7 + 25%, 27% with holy wrench).
 *   - buryBones: consumes one bone, awards BONE_XP, human-paced cooldown.
 *   - rechargeAtAltar: walks to a name-verified altar, recharges to full.
 *   - createCitizenPrayerAction: buries bones, recharges at altar, never
 *     interrupts combat, never stalls.
 *
 * The engine is faked through the _setEngine seam (the real TS modules
 * don't resolve in plain node); the pure decision logic needs no engine
 * at all.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- stub BotNavigation (pulls TS at load) ----------------------------------
const bankDelegates = [];
(function stubNavigation() {
  const rel = "../../../bots/behaviours/navigation/BotNavigation";
  const full = path.join(__dirname, rel);
  const resolved = require.resolve(full);
  const movements = [];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
      requestMovement: (player, x, y, opts) => {
        movements.push({ player, x, y, opts });
      },
      clearMovementRequest: () => {},
      _movements: movements,
    },
  };
})();

// --- stub the shared Bank action (also pulls TS at load) ----------------------
(function stubBank() {
  const rel = "../../../bots/brain/actions/Bank";
  const full = path.join(__dirname, rel);
  const resolved = require.resolve(full);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
      createBankAction: (spec, world) => {
        const delegate = {
          spec,
          update: () => "success",
          stop: () => {},
        };
        bankDelegates.push(delegate);
        return delegate;
      },
      _delegates: bankDelegates,
    },
  };
})();

const Prayer = require("./CitizenPrayer");
const {
  decidePrayers,
  prayerProfile,
  bestDpsPrayer,
  PRAY,
  createCitizenPrayerAction,
} = Prayer;

// --- fake engine ---------------------------------------------------------------

const MELEE = 0, RANGED = 1, MAGIC = 2;

function makeFakeEngine() {
  const active = new Array(29).fill(false);
  const calls = { activate: [], deactivate: [] };
  const Skill = { PRAYER: "PRAYER", DEFENCE: "DEFENCE" };
  const CombatType = { MELEE, RANGED, MAGIC };
  const PrayerHandler = {
    PROTECT_FROM_MELEE: 18,
    PROTECT_FROM_MISSILES: 17,
    PROTECT_FROM_MAGIC: 16,
    PROTECT_ITEM: 10,
    PIETY: 26, RIGOUR: 27, AUGURY: 28,
    activatePrayerPrayerId: (bot, id) => {
      calls.activate.push(id);
      // engine exclusivity: overheads and dps groups reset each other
      if ([16, 17, 18].includes(id)) {
        for (const o of [16, 17, 18]) if (o !== id) active[o] = false;
      }
      active[id] = true;
    },
    deactivatePrayer: (bot, id) => {
      calls.deactivate.push(id);
      active[id] = false;
    },
    getProtectingPrayer: (t) =>
      t === MELEE ? 18 : t === RANGED ? 17 : 16,
  };
  return {
    PrayerHandler, Skill, CombatType,
    CombatFactory: {
      getMethod: (e) => ({ type: () => e._style ?? MELEE }),
    },
    Animation: class { constructor(id) { this.id = id; } },
    Item: class { constructor(id, amount) { this.id = id; this.amount = amount; } getId() { return this.id; } },
    Sound: { PRAYER_RECHARGE: 1, BURY_BONES: 2, DRINK: 3 },
    Sounds: { sendSound: () => {} },
    ItemDefinition: { forId: (id) => ({ getName: () => `item-${id}` }) },
    ItemIdentifiers: {},
    ObjectIdentifiers: { ALTAR: 409, ALTAR_2: 2640, SHRINE: 29088, ALTAR_OF_THE_OCCULT: 99999 },
    BONE_XP: new Map([[526, 5], [532, 15], [536, 72]]),
    _active: active,
    _calls: calls,
  };
}

// --- fake bot ---------------------------------------------------------------------

function makeBot(opts = {}) {
  const inv = new Map(); // id -> { id, slot }
  const items = [];
  for (const [id, amount] of Object.entries(opts.inventory ?? {})) {
    const slot = items.length;
    items.push({ id: Number(id), amount });
    inv.set(Number(id), slot);
  }
  const bank = new Map();
  for (const [id, amount] of Object.entries(opts.bank ?? {})) {
    bank.set(Number(id), amount);
  }
  const attrs = new Map(Object.entries(opts.attributes ?? {}));
  const state = {
    prayerMax: opts.prayerMax ?? 50,
    prayerPoints: opts.prayerPoints ?? 50,
    defence: opts.defence ?? 70,
    skulled: !!opts.skulled,
    xp: 0,
    sent: [],
    animations: [],
  };
  const bot = {
    _state: state,
    getUsername: () => opts.username ?? "TestBot",
    getAttribute: (k) => attrs.get(k) ?? null,
    setAttribute: (k, v) => attrs.set(k, v),
    getSkillManager: () => ({
      getCurrentLevel: (s) => (s === "PRAYER" ? state.prayerPoints : 1),
      getMaxLevel: (s) =>
        s === "PRAYER" ? state.prayerMax : s === "DEFENCE" ? state.defence : 1,
      increaseCurrentLevel: (s, amt, cap) => {
        if (s === "PRAYER") {
          state.prayerPoints = Math.min(cap, state.prayerPoints + amt);
        }
      },
      setCurrentLevels: (s, v) => {
        if (s === "PRAYER") state.prayerPoints = v;
      },
      updateSkill: () => {},
      addExperiences: (s, xp) => { state.xp += xp; },
      getCombatLevel: () => opts.combatLevel ?? 60,
    }),
    getPrayerActive: () => bot._engine._active,
    isSkulled: () => state.skulled,
    getInventory: () => ({
      getAmount: (id) => items[inv.get(id)]?.amount ?? 0,
      getSlotForItemId: (id) => inv.get(id) ?? -1,
      getItems: () => items.map((it) => (it ? { getId: () => it.id } : null)),
      setItem: (slot, item) => {
        const old = items[slot];
        if (old) inv.delete(old.id);
        items[slot] = { id: item.id, amount: item.amount };
        inv.set(item.id, slot);
        return { refreshItems: () => {} };
      },
      refreshItems: () => {},
      contains: (id) => inv.has(id),
      deleteAtSlot: (slot, n) => {
        const it = items[slot];
        if (!it) return;
        it.amount -= n;
        if (it.amount <= 0) { items[slot] = null; inv.delete(it.id); }
      },
    }),
    getBank: (tab) => {
      if (tab !== 0) return null;
      return {
        getSlotForItemId: (id) => (bank.has(id) ? 0 : -1),
        getItems: () => [...bank.keys()].map((id) => ({ getId: () => id })),
      };
    },
    getCombat: () => ({
      getTarget: () => opts.combatTarget ?? null,
      getAttacker: () => opts.combatAttacker ?? null,
    }),
    getLocation: () => ({
      getX: () => opts.x ?? 3200,
      getY: () => opts.y ?? 3200,
      getZ: () => 0,
    }),
    isNpc: () => false,
    isPlayer: () => true,
    performAnimation: (a) => state.animations.push(a.id),
    sendMessage: (m) => state.sent.push(m),
    _engine: null,
  };
  return bot;
}

function makeNpc(style, combatLevel, name = "Hill giant") {
  return {
    isNpc: () => true,
    isPlayer: () => false,
    _style: style,
    getId: () => 117,
    getIndex: () => 7,
    getCurrentDefinition: () => ({ getCombatLevel: () => combatLevel, getName: () => name }),
    getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
    isDead: () => false,
    isDying: () => false,
  };
}

function bindEngine(bot, eng) {
  bot._engine = eng;
  Prayer._setEngine(eng);
  return eng;
}

function unbind() {
  Prayer._clearEngine();
}

// --- decidePrayers ---------------------------------------------------------------

{
  const base = {
    prayerLevel: 50, defenceLevel: 70, points: 50, max: 50,
    skulled: false, coins: 0, botStyle: "melee", profile: prayerProfile({}, "u1"),
  };

  // Overhead by threat style.
  let d = decidePrayers({ ...base, style: "melee", threatCombat: 90 });
  assert.equal(d.overhead, PRAY.PROTECT_FROM_MELEE, "protect from melee vs melee threat");
  d = decidePrayers({ ...base, style: "magic", threatCombat: 90 });
  assert.equal(d.overhead, PRAY.PROTECT_FROM_MAGIC, "protect from magic vs magic threat");
  d = decidePrayers({ ...base, style: "ranged", threatCombat: 90 });
  assert.equal(d.overhead, PRAY.PROTECT_FROM_MISSILES, "protect from missiles vs ranged threat");

  // Trivial fight: a level-3 goblin gets nothing — not even piety.
  d = decidePrayers({ ...base, prayerLevel: 99, style: "melee", threatCombat: 3 });
  assert.deepEqual(d, { overhead: null, dps: null, protectItem: false }, "trivial fight: no prayers");

  // No points, no prayers.
  d = decidePrayers({ ...base, points: 0, style: "melee", threatCombat: 90 });
  assert.deepEqual(d, { overhead: null, dps: null, protectItem: false }, "0 points: no prayers");

  // Unknown style: no overhead, but DPS still fine.
  d = decidePrayers({ ...base, style: null, threatCombat: 90 });
  assert.equal(d.overhead, null, "unknown style: no overhead");
  assert.equal(d.dps, PRAY.ULTIMATE_STRENGTH, "unknown style: DPS still up (prayer 50 -> ult strength)");

  // DPS by bot style at high prayer.
  const pious = { ...base, prayerLevel: 99, defenceLevel: 99 };
  d = decidePrayers({ ...pious, style: "melee", threatCombat: 200, botStyle: "melee" });
  assert.equal(d.dps, PRAY.PIETY, "melee bot with 99 prayer uses piety");
  d = decidePrayers({ ...pious, style: "melee", threatCombat: 200, botStyle: "ranged" });
  assert.equal(d.dps, PRAY.RIGOUR, "ranged bot with 99 prayer uses rigour");
  d = decidePrayers({ ...pious, style: "melee", threatCombat: 200, botStyle: "magic" });
  assert.equal(d.dps, PRAY.AUGURY, "magic bot with 99 prayer uses augury");

  // DPS never burns the last of the bar.
  d = decidePrayers({ ...pious, style: "melee", threatCombat: 200, points: 5 });
  assert.equal(d.dps, null, "low points: DPS dropped");
  assert.equal(d.overhead, PRAY.PROTECT_FROM_MELEE, "low points: overhead kept");

  // Protect Item: skulled or rich.
  d = decidePrayers({ ...base, style: "melee", threatCombat: 60, skulled: true });
  assert.equal(d.protectItem, true, "skulled: protect item");
  d = decidePrayers({ ...base, style: "melee", threatCombat: 60, coins: 200000 });
  assert.equal(d.protectItem, true, "rich: protect item");
  d = decidePrayers({ ...base, style: "melee", threatCombat: 60 });
  assert.equal(d.protectItem, false, "not skulled, not rich: no protect item");
  d = decidePrayers({ ...base, prayerLevel: 10, style: "melee", threatCombat: 60, skulled: true });
  assert.equal(d.protectItem, false, "prayer 10: can't use protect item (req 25)");

  // Prayer level gates overheads.
  d = decidePrayers({ ...base, prayerLevel: 30, style: "melee", threatCombat: 90 });
  assert.equal(d.overhead, null, "prayer 30: no protect from melee (req 43)");

  // The proud keep DPS over protection when the bar runs low.
  const proud = prayerProfile({ traits: ["proud"] }, "proudbot");
  d = decidePrayers({ ...pious, profile: proud, style: "melee", threatCombat: 200, points: 10, max: 99 });
  assert.equal(d.dps, PRAY.PIETY, "proud: DPS kept when low");
  assert.equal(d.overhead, null, "proud: overhead dropped when low");
  console.log("ok - decidePrayers");
}

// --- bestDpsPrayer ------------------------------------------------------------------

{
  assert.equal(bestDpsPrayer("melee", 99, 99), PRAY.PIETY);
  assert.equal(bestDpsPrayer("melee", 60, 60), PRAY.CHIVALRY, "60 prayer/60 def -> chivalry");
  assert.equal(bestDpsPrayer("melee", 60, 40), PRAY.ULTIMATE_STRENGTH, "60 prayer but 40 def -> ult strength");
  assert.equal(bestDpsPrayer("melee", 31, 40), PRAY.ULTIMATE_STRENGTH);
  assert.equal(bestDpsPrayer("melee", 30, 40), null, "below ult strength req -> null");
  assert.equal(bestDpsPrayer("ranged", 99, 99), PRAY.RIGOUR);
  assert.equal(bestDpsPrayer("ranged", 50, 70), PRAY.EAGLE_EYE);
  assert.equal(bestDpsPrayer("magic", 99, 99), PRAY.AUGURY);
  assert.equal(bestDpsPrayer("magic", 50, 70), PRAY.MYSTIC_MIGHT);
  assert.equal(bestDpsPrayer("cooking", 99, 99), null, "unknown style -> null");
  console.log("ok - bestDpsPrayer");
}

// --- prayerProfile ---------------------------------------------------------------------

{
  const devout = prayerProfile({ traits: ["devout"] }, "devoutbot");
  const greedy = prayerProfile({ traits: ["greedy"] }, "greedybot");
  const clumsy = prayerProfile({ traits: ["clumsy"] }, "clumsybot");
  const plain = prayerProfile({ traits: [] }, "plainbot");
  assert.ok(devout.overheadFloor < plain.overheadFloor, "devout prays earlier");
  assert.ok(devout.drinkAt > plain.drinkAt, "devout sips earlier");
  assert.equal(greedy.bringPotions, false, "greedy won't bank for potions");
  assert.ok(greedy.overheadFloor > plain.overheadFloor, "greedy prays only when it matters");
  assert.ok(clumsy.overheadFloor > plain.overheadFloor, "clumsy reacts late");
  assert.ok(prayerProfile({ traits: ["proud"] }, "p").dpsBias > 0.7, "proud biases DPS");
  // Stable per username.
  assert.deepEqual(prayerProfile({ traits: ["devout"] }, "same"), prayerProfile({ traits: ["devout"] }, "same"), "stable per username");
  assert.ok(devout.piety >= 0.9 && devout.piety <= 1, "devout piety near 1");
  console.log("ok - prayerProfile");
}

// --- maintainCombatPrayer (fake engine) --------------------------------------------------

{
  const eng = makeFakeEngine();
  const bot = makeBot({ prayerMax: 99, prayerPoints: 99, defence: 99, combatTarget: makeNpc(MELEE, 92) });
  bindEngine(bot, eng);

  const res = Prayer.maintainCombatPrayer(bot);
  assert.ok(res.activated.includes(18), "protect from melee activated vs melee npc");
  assert.ok(res.activated.includes(26), "piety activated for melee bot at 99 prayer");
  assert.equal(eng._active[18], true, "overhead actually on in engine state");
  assert.equal(eng._active[26], true, "piety actually on in engine state");

  // Second call inside the decide window: no duplicate activations.
  const callsBefore = eng._calls.activate.length;
  Prayer.maintainCombatPrayer(bot, null, { nowMs: Date.now() + 500 });
  assert.equal(eng._calls.activate.length, callsBefore, "no per-tick activation spam");

  // Threat changes to a mage after the window: overhead swaps.
  const mage = makeNpc(MAGIC, 92);
  bot.getCombat = () => ({ getTarget: () => mage, getAttacker: () => null });
  const res2 = Prayer.maintainCombatPrayer(bot, null, { nowMs: Date.now() + 5000 });
  assert.equal(eng._active[18], false, "melee overhead dropped vs mage");
  assert.equal(eng._active[16], true, "magic overhead up vs mage");
  // (the fake mirrors the real engine: activating an overhead auto-drops
  // the other overheads inside activatePrayerPrayerId)

  // Release drops everything.
  const released = Prayer.releaseCombatPrayers(bot);
  assert.ok(released >= 2, "released prayers");
  assert.equal(eng._active[16], false);
  assert.equal(eng._active[26], false);
  unbind();
  console.log("ok - maintainCombatPrayer");
}

// --- potion sip at the personality threshold ----------------------------------------------

{
  const eng = makeFakeEngine();
  // methodical bot: drinks at 50%.
  const bot = makeBot({
    prayerMax: 99, prayerPoints: 40, defence: 99,
    inventory: { 2434: 1 },
    attributes: { "citizens:personality": { traits: ["methodical"] } },
    combatTarget: makeNpc(MELEE, 92),
  });
  bindEngine(bot, eng);
  const res = Prayer.maintainCombatPrayer(bot);
  assert.equal(res.drank, true, "sipped below the methodical threshold");
  assert.equal(bot.getInventory().getAmount(2434), 0, "4-dose consumed");
  assert.equal(bot.getInventory().getAmount(139), 1, "3-dose left behind");
  // 7 + 25% of 99 = 31 (no holy wrench)
  assert.equal(bot._state.prayerPoints, Math.min(99, 40 + Math.floor(7 + 99 * 0.25)), "real restore math");
  unbind();
  console.log("ok - potion sip");
}

// --- drinkPrayerPotion: dose chains, holy wrench, cooldown ---------------------------------

{
  const eng = makeFakeEngine();
  const bot = makeBot({ prayerMax: 50, prayerPoints: 10, inventory: { 141: 1, 6714: 1 } });
  bindEngine(bot, eng);
  assert.equal(Prayer.drinkPrayerPotion(bot), true);
  assert.equal(bot.getInventory().getAmount(141), 0);
  assert.equal(bot.getInventory().getAmount(143), 1, "2-dose -> 1-dose");
  // 7 + 27% of 50 = 20 with the holy wrench
  assert.equal(bot._state.prayerPoints, 10 + Math.floor(7 + 50 * 0.27), "wrench-boosted restore");
  assert.deepEqual(bot._state.animations.slice(-1), [829], "drink animation");
  // Cooldown: immediate second sip refused.
  assert.equal(Prayer.drinkPrayerPotion(bot), false, "sip cooldown");
  // Last dose becomes a vial.
  assert.equal(Prayer.drinkPrayerPotion(bot, null, Date.now() + 5000), true);
  assert.equal(bot.getInventory().getAmount(229), 1, "empty dose -> vial");
  unbind();
  console.log("ok - drinkPrayerPotion");
}

// --- buryBones --------------------------------------------------------------------------------

{
  const eng = makeFakeEngine();
  const bot = makeBot({ inventory: { 526: 3, 536: 1 } });
  bindEngine(bot, eng);
  assert.equal(Prayer.boneCount(bot), 4);
  const t0 = Date.now();
  assert.equal(Prayer.buryBones(bot, null, t0), 1, "buried one bone");
  assert.equal(bot._state.xp, 5, "bones = 5 prayer xp");
  assert.equal(Prayer.boneCount(bot), 3);
  assert.deepEqual(bot._state.animations.slice(-1), [827], "bury animation");
  // Cooldown respected.
  assert.equal(Prayer.buryBones(bot, null, t0 + 500), 0, "bury cooldown");
  assert.equal(Prayer.buryBones(bot, null, t0 + 5000), 1, "second burial after cooldown");
  assert.equal(bot._state.xp, 5 + 5, "xp accumulates");
  unbind();
  console.log("ok - buryBones");
}

// --- rechargeAtAltar ----------------------------------------------------------------------------

{
  const eng = makeFakeEngine();
  const altarObj = {
    getDefinition: () => ({ getName: () => "Altar" }),
    getLocation: () => ({ getX: () => 3201, getY: () => 3201, getZ: () => 0 }),
  };
  const world = {
    objectSearch: {
      findCandidatesByIds: (bot, ids) => {
        assert.ok(ids.includes(409), "altar ids include the plain altar");
        return [altarObj];
      },
    },
  };
  const bot = makeBot({ prayerMax: 60, prayerPoints: 20, x: 3200, y: 3200 });
  bindEngine(bot, eng);
  // Adjacent: recharges immediately.
  assert.equal(Prayer.rechargeAtAltar(bot, world), "recharged");
  assert.equal(bot._state.prayerPoints, 60, "recharged to full");
  assert.deepEqual(bot._state.animations.slice(-1), [645], "altar animation");
  assert.ok(bot._state.sent.includes("You recharge your Prayer points."));

  // Far altar: walks.
  const farWorld = {
    objectSearch: {
      findCandidatesByIds: () => [{
        getDefinition: () => ({ getName: () => "Altar" }),
        getLocation: () => ({ getX: () => 3300, getY: () => 3300, getZ: () => 0 }),
      }],
    },
  };
  const walker = makeBot({ prayerMax: 60, prayerPoints: 20, x: 3200, y: 3200 });
  bindEngine(walker, eng);
  assert.equal(Prayer.rechargeAtAltar(walker, farWorld), "walking");

  // Non-prayer objects with altar-ish ids are name-filtered out.
  const occultWorld = {
    objectSearch: {
      findCandidatesByIds: () => [{
        getDefinition: () => ({ getName: () => "Altar of the Occult" }),
        getLocation: () => ({ getX: () => 3201, getY: () => 3201, getZ: () => 0 }),
      }],
    },
  };
  assert.equal(Prayer.rechargeAtAltar(walker, occultWorld), "no-altar", "occult altar is not a prayer altar");
  unbind();
  console.log("ok - rechargeAtAltar");
}

// --- ensureSupplies / tickSupplies ------------------------------------------------------------------

{
  const eng = makeFakeEngine();
  // Prayer 50, no potions, bank has some -> delegate.
  const bot = makeBot({ prayerMax: 50, prayerPoints: 50, bank: { 2434: 5 } });
  bindEngine(bot, eng);
  const delegate = Prayer.ensureSupplies(bot, {});
  assert.ok(delegate && typeof delegate.update === "function", "bank delegate when bank has potions");

  // Already stocked -> null.
  const stocked = makeBot({ prayerMax: 50, inventory: { 2434: 2 }, bank: { 2434: 5 } });
  bindEngine(stocked, eng);
  assert.equal(Prayer.ensureSupplies(stocked, {}), null, "no delegate when stocked");

  // Prayer too low to matter -> null.
  const lowbie = makeBot({ prayerMax: 10, bank: { 2434: 5 } });
  bindEngine(lowbie, eng);
  assert.equal(Prayer.ensureSupplies(lowbie, {}), null, "no delegate at prayer 10");

  // Greedy -> null (won't spend).
  const greedy = makeBot({
    prayerMax: 50, bank: { 2434: 5 },
    attributes: { "citizens:personality": { traits: ["greedy"] } },
  });
  bindEngine(greedy, eng);
  assert.equal(Prayer.ensureSupplies(greedy, {}), null, "greedy skips provisioning");

  // Bank empty -> null, never stalls.
  const broke = makeBot({ prayerMax: 50, bank: {} });
  bindEngine(broke, eng);
  assert.equal(Prayer.ensureSupplies(broke, {}), null, "no delegate when bank empty");

  // tickSupplies drives the delegate to completion.
  const runner = makeBot({ prayerMax: 50, bank: { 2434: 5 } });
  bindEngine(runner, eng);
  const state = {};
  let updates = 0;
  state.supplyDelegate = {
    update: () => (++updates >= 2 ? "success" : "running"),
    stop: () => {},
  };
  assert.equal(Prayer.tickSupplies(state, runner, {}, { player: runner }), false, "running while delegate runs");
  assert.equal(Prayer.tickSupplies(state, runner, {}, { player: runner }), true, "done when delegate finishes");
  assert.equal(state.prayerSupplied, true);
  unbind();
  console.log("ok - ensureSupplies/tickSupplies");
}

// --- createCitizenPrayerAction -------------------------------------------------------------------------

{
  const eng = makeFakeEngine();
  const world = { objectSearch: { findCandidatesByIds: () => [] } };

  // Bones: buries, stays running.
  const bony = makeBot({ inventory: { 526: 2 }, prayerMax: 40, prayerPoints: 40 });
  bindEngine(bony, eng);
  const action = createCitizenPrayerAction({}, world);
  assert.equal(action.id, "citizenPrayer");
  const t0 = Date.now();
  assert.equal(action.update({ player: bony, nowMs: t0 }), "running", "burying bones");
  assert.equal(bony._state.xp, 5);

  // Low prayer, no altar nearby: ends cleanly, never stalls.
  const low = makeBot({ prayerMax: 40, prayerPoints: 10 });
  bindEngine(low, eng);
  assert.equal(action.update({ player: low, nowMs: t0 + 10000 }), "success", "no altar -> success");

  // In combat: hands off to the combat actions.
  const fighting = makeBot({ prayerMax: 40, prayerPoints: 10, combatTarget: makeNpc(MELEE, 50) });
  bindEngine(fighting, eng);
  assert.equal(action.update({ player: fighting, nowMs: t0 + 20000 }), "success", "combat -> hands off");

  // Nothing to do: success.
  const fine = makeBot({ prayerMax: 40, prayerPoints: 40 });
  bindEngine(fine, eng);
  assert.equal(action.update({ player: fine, nowMs: t0 + 30000 }), "success");
  unbind();
  console.log("ok - createCitizenPrayerAction");
}

// --- wiring: activity JSON + action type registration -------------------------------

{
  const fs = require("node:fs");
  const data = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "..", "data", "citizen-activities.json"),
      "utf8"
    )
  );
  const prayer = data.activities.find((a) => a.id === "citizen_prayer");
  assert.ok(prayer, "citizen_prayer activity must exist");
  assert.deepEqual(
    prayer.actions.map((a) => a.type),
    ["citizenPrayer"],
    "activity maps to the citizenPrayer action type"
  );
  assert.ok(
    prayer.requires?.[0]?.citizen?.roles?.includes("commoner"),
    "commoners can pray"
  );
  const actionTypesSrc = fs.readFileSync(
    path.join(__dirname, "..", "CitizenActionTypes.js"),
    "utf8"
  );
  assert.ok(
    actionTypesSrc.includes('registerBotActionType("citizenPrayer"'),
    "citizenPrayer action type must be registered"
  );
  console.log("ok - wiring");
}

console.log("\nAll CitizenPrayer checks passed.");
