"use strict";

/**
 * CitizenPrayerOffer unit checks — bone offering at town altars for real
 * Prayer XP (the prayer-XP training gap: the citizen_prayer hinge used to
 * only bury bones where the citizen stood).
 *
 * Proves the brain's contracts without a running server:
 *   - offerXp: pure XP math — floor(base * multiplier), null for unknown
 *     altars or bones.
 *   - offerBonesAtAltar (fake engine via _setEngine): offers one bone at
 *     an adjacent name-verified altar (2.5x / 3.5x XP, altar messages),
 *     walks to a far altar, reports no-altar honestly, does nothing with
 *     no bones, and respects the human-paced offering cooldown.
 *   - createCitizenPrayerAction: prefers offering at a reachable altar
 *     over burying; still buries when no altar is near.
 *
 * The engine is faked through the _setEngine seam (the real TS modules
 * don't resolve in plain node); offerXp needs no engine at all.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- stub BotNavigation (pulls TS at load) ----------------------------------
const movements = [];
(function stubNavigation() {
  const rel = "../../../bots/behaviours/navigation/BotNavigation";
  const full = path.join(__dirname, rel);
  const resolved = require.resolve(full);
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

const Prayer = require("./CitizenPrayer");
const {
  offerXp,
  offerBonesAtAltar,
  ALTAR_XP_MULTIPLIERS,
  createCitizenPrayerAction,
} = Prayer;

// --- fake engine ---------------------------------------------------------------

function makeFakeEngine() {
  return {
    Skill: { PRAYER: "PRAYER" },
    Animation: class { constructor(id) { this.id = id; } },
    Sound: { BURY_BONES: 2 },
    Sounds: { sendSound: () => {} },
    ItemDefinition: { forId: (id) => ({ getName: () => `item-${id}` }) },
    ItemIdentifiers: {},
    ObjectIdentifiers: { ALTAR: 409, SHRINE: 29088 },
    BONE_XP: new Map([[526, 5], [532, 15], [536, 72]]),
  };
}

// --- fake bot ---------------------------------------------------------------------

function makeBot(opts = {}) {
  const inv = new Map();
  const items = [];
  for (const [id, amount] of Object.entries(opts.inventory ?? {})) {
    const slot = items.length;
    items.push({ id: Number(id), amount });
    inv.set(Number(id), slot);
  }
  const state = { xp: 0, sent: [], animations: [] };
  return {
    _state: state,
    getUsername: () => "TestBot",
    getAttribute: () => null,
    getSkillManager: () => ({
      addExperiences: (s, xp) => { state.xp += xp; },
    }),
    getInventory: () => ({
      getAmount: (id) => items[inv.get(id)]?.amount ?? 0,
      getSlotForItemId: (id) => inv.get(id) ?? -1,
      getItems: () => items.map((it) => (it ? { getId: () => it.id } : null)),
      deleteAtSlot: (slot, n) => {
        const it = items[slot];
        if (!it) return;
        it.amount -= n;
        if (it.amount <= 0) { items[slot] = null; inv.delete(it.id); }
      },
    }),
    getCombat: () => ({ getTarget: () => null, getAttacker: () => null }),
    getLocation: () => ({
      getX: () => opts.x ?? 3200,
      getY: () => opts.y ?? 3200,
      getZ: () => 0,
    }),
    performAnimation: (a) => state.animations.push(a.id),
    sendMessage: (m) => state.sent.push(m),
  };
}

function makeAltarWorld(name, ax, ay) {
  return {
    objectSearch: {
      findCandidatesByIds: () => [{
        getDefinition: () => ({ getName: () => name }),
        getLocation: () => ({ getX: () => ax, getY: () => ay, getZ: () => 0 }),
      }],
    },
  };
}

function bind(eng) {
  Prayer._setEngine(eng);
  return eng;
}
function unbind() {
  Prayer._clearEngine();
}

// --- offerXp (pure) -----------------------------------------------------------------

{
  const eng = makeFakeEngine();
  assert.equal(offerXp(eng, 526, "Altar"), 12, "bones at altar: floor(5*2.5)");
  assert.equal(offerXp(eng, 526, "Gilded altar"), 17, "bones at gilded: floor(5*3.5)");
  assert.equal(offerXp(eng, 532, "Altar"), 37, "big bones at altar: floor(15*2.5)");
  assert.equal(offerXp(eng, 536, "Gilded altar"), 252, "dragon bones at gilded");
  assert.equal(offerXp(eng, 526, "Shrine"), null, "shrine has no offering table");
  assert.equal(offerXp(eng, 526, "Altar of the Occult"), null, "unknown altar");
  assert.equal(offerXp(eng, 99999, "Altar"), null, "unknown bone");
  assert.deepEqual(
    [...ALTAR_XP_MULTIPLIERS.entries()],
    [["Altar", 2.5], ["Gilded altar", 3.5]],
    "multipliers mirror Prayer.plugin"
  );
  console.log("ok - offerXp");
}

// --- offerBonesAtAltar ----------------------------------------------------------------

{
  const eng = makeFakeEngine();
  bind(eng);

  // Adjacent plain altar: offers one bone at 2.5x.
  const world = makeAltarWorld("Altar", 3201, 3201);
  const bot = makeBot({ inventory: { 526: 3 }, x: 3200, y: 3200 });
  const t0 = Date.now();
  assert.equal(offerBonesAtAltar(bot, world, eng, t0), "offered");
  assert.equal(bot._state.xp, 12, "one bone offered for 12 xp");
  assert.deepEqual(bot._state.animations.slice(-1), [827], "offer animation");
  assert.ok(
    bot._state.sent.includes("You offer the item-526 at the altar."),
    "altar message"
  );
  assert.equal(
    bot.getInventory().getAmount(526), 2, "one bone consumed"
  );

  // Cooldown: a second call inside 4s offers nothing new.
  assert.equal(offerBonesAtAltar(bot, world, eng, t0 + 1000), "offered");
  assert.equal(bot._state.xp, 12, "no double-dip inside the cooldown");
  assert.equal(bot.getInventory().getAmount(526), 2);

  // After the cooldown the next bone goes too.
  assert.equal(offerBonesAtAltar(bot, world, eng, t0 + 5000), "offered");
  assert.equal(bot._state.xp, 24);
  assert.equal(bot.getInventory().getAmount(526), 1);

  // Gilded altar: 3.5x and the pleased-gods line.
  const gilded = makeAltarWorld("Gilded altar", 3201, 3201);
  const rich = makeBot({ inventory: { 532: 1 }, x: 3200, y: 3200 });
  assert.equal(offerBonesAtAltar(rich, gilded, eng, t0 + 9000), "offered");
  assert.equal(rich._state.xp, 52, "big bones at gilded: floor(15*3.5)");
  assert.ok(
    rich._state.sent.includes("The gods are pleased with your offering."),
    "gilded message"
  );

  // Far altar: walks there instead of offering from range.
  movements.length = 0;
  const farWorld = makeAltarWorld("Altar", 3300, 3300);
  const walker = makeBot({ inventory: { 526: 1 }, x: 3200, y: 3200 });
  assert.equal(offerBonesAtAltar(walker, farWorld, eng, t0 + 9000), "walking");
  assert.equal(movements.length, 1, "movement requested to the altar");
  assert.equal(walker._state.xp, 0, "no xp while walking");
  assert.equal(walker.getInventory().getAmount(526), 1, "bone kept");

  // No altar: honest no-altar.
  const emptyWorld = { objectSearch: { findCandidatesByIds: () => [] } };
  const lost = makeBot({ inventory: { 526: 1 } });
  assert.equal(offerBonesAtAltar(lost, emptyWorld, eng, t0 + 9000), "no-altar");

  // No bones: nothing to offer.
  const empty = makeBot({});
  assert.equal(offerBonesAtAltar(empty, world, eng, t0 + 9000), null);

  unbind();
  console.log("ok - offerBonesAtAltar");
}

// --- action: offering preferred over burying ------------------------------------------

{
  const eng = makeFakeEngine();
  bind(eng);
  const altarWorld = makeAltarWorld("Altar", 3201, 3201);
  const action = createCitizenPrayerAction({}, altarWorld);

  // Bones + reachable altar: offers (12 xp), stays running.
  const bot = makeBot({ inventory: { 526: 2 }, x: 3200, y: 3200 });
  const t0 = Date.now();
  assert.equal(action.update({ player: bot, nowMs: t0 }), "running");
  assert.equal(bot._state.xp, 12, "offered, not buried");

  // Bones + no altar nearby: falls back to burying (5 xp).
  const emptyWorld = { objectSearch: { findCandidatesByIds: () => [] } };
  const action2 = createCitizenPrayerAction({}, emptyWorld);
  const bot2 = makeBot({ inventory: { 526: 2 } });
  assert.equal(action2.update({ player: bot2, nowMs: t0 + 5000 }), "running");
  assert.equal(bot2._state.xp, 5, "buried when no altar near");

  unbind();
  console.log("ok - createCitizenPrayerAction offering");
}

console.log("\nAll CitizenPrayerOffer checks passed.");
