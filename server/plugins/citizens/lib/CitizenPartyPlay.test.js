// CitizenPartyPlay unit checks — pure logic, no running server.
const assert = require("node:assert/strict");

const PartyPlay = require("./CitizenPartyPlay");
const {
  decidePartyInvite,
  joinOrCreateParty,
  leaveParty,
  findBestFood,
  eatBestFood,
  PARTY_OPTION_SLOT,
  _resetStateForTests,
} = PartyPlay;

_resetStateForTests();

// --- test helpers -----------------------------------------------------------

/** Minimal mock bot with inventory. */
function mockBot({ hp = 100, maxHp = 100, items = [] } = {}) {
  const inv = new Map(items); // itemId -> amount
  let healed = 0;
  return {
    _healed: 0,
    get healed() { return healed; },
    getInventory() {
      return {
        getItems() {
          return [...inv.entries()].map(([id, amount]) => ({
            getId: () => id,
            getAmount: () => amount,
          }));
        },
        getAmount: (id) => inv.get(id) ?? 0,
        deleteNumber: (id, n) => inv.set(id, Math.max(0, (inv.get(id) ?? 0) - n)),
        adds: (id, n) => inv.set(id, (inv.get(id) ?? 0) + n),
      };
    },
    getSkillManager() {
      return {
        getCurrentLevel: () => 99,
        getMaxLevel: () => 99,
      };
    },
    getHitpoints: () => hp,
    getMaxHitpoints: () => maxHp,
    heal: (n) => { healed += n; },
    getCombat: () => null,
    isPlayerBot: () => true,
    getUsername: () => "TestCitizen",
    getAttribute: () => ({}),
    performAnimation: () => {},
    forceChat: () => {},
    getPacketSender: () => ({ sendPublicChat: () => {} }),
    getLocalPlayers: () => [],
  };
}

/** Minimal mock record. */
function mockRecord(name, personality = {}) {
  return { username: name, displayName: name, personality };
}

/** Minimal mock player. */
function mockPlayer(name, combatLevel = 50) {
  return {
    getUsername: () => name,
    isPlayerBot: () => false,
    getSkillManager: () => ({ getCombatLevel: () => combatLevel }),
    getCombat: () => ({ getTarget: () => null }),
  };
}

// --- 1. Party option slot ---------------------------------------------------

{
  assert.equal(PARTY_OPTION_SLOT, 9, "Party option uses slot 9 (1-8 taken)");
}

// --- 2. Invite decision: enemy never accepts --------------------------------

{
  // Mock CitizenBonds to control relationships.
  const bondsPath = require.resolve("./CitizenBonds");
  const bonds = require(bondsPath);
  const origIsEnemy = bonds.isEnemy;
  const origIsFriend = bonds.isFriend;
  bonds.isEnemy = () => true;
  bonds.isFriend = () => false;

  const record = mockRecord("Bryn");
  const player = mockPlayer("EnemyPlayer");
  // rng always returns 0 (would accept if chance allowed).
  const decision = decidePartyInvite(record, player, 3, () => 0);
  assert.equal(decision.accept, false, "Enemy invite must be declined");
  assert.equal(decision.reason, "enemy");

  bonds.isEnemy = origIsEnemy;
  bonds.isFriend = origIsFriend;
}

// --- 3. Invite decision: friend likely accepts -------------------------------

{
  const bondsPath = require.resolve("./CitizenBonds");
  const bonds = require(bondsPath);
  const origIsEnemy = bonds.isEnemy;
  const origIsFriend = bonds.isFriend;
  bonds.isEnemy = () => false;
  bonds.isFriend = () => true;

  const record = mockRecord("Mara", { traits: ["chatty", "brave"] });
  const player = mockPlayer("FriendPlayer", 40);
  // rng returns 0.5 — friend base chance is 0.45 + 0.35 = 0.8, so accepts.
  const decision = decidePartyInvite(record, player, 40, () => 0.5);
  assert.equal(decision.accept, true, "Friend invite should be accepted");

  bonds.isEnemy = origIsEnemy;
  bonds.isFriend = origIsFriend;
}

// --- 4. Party formation ------------------------------------------------------

{
  const bondsPath = require.resolve("./CitizenBonds");
  const bonds = require(bondsPath);
  const origGetParty = bonds.getParty;
  const origSetParty = bonds.setParty;

  const parties = new Map();
  bonds.getParty = (name) => parties.get(name.toLowerCase()) ?? null;
  bonds.setParty = (name, party) => parties.set(name.toLowerCase(), party);

  const party = joinOrCreateParty("Bryn", "PlayerOne");
  assert.equal(party.leader, "PlayerOne", "Player leads the party");
  assert.equal(party.playerLed, true);
  assert.ok(party.members.includes("Bryn"), "Citizen is a member");
  assert.ok(party.members.includes("PlayerOne"), "Player is a member");

  // Joining again doesn't duplicate.
  const party2 = joinOrCreateParty("Bryn", "PlayerOne");
  const playerCount = party2.members.filter((m) => m === "PlayerOne").length;
  assert.equal(playerCount, 1, "Player not duplicated in party");

  bonds.getParty = origGetParty;
  bonds.setParty = origSetParty;
}

// --- 5. Food finding: picks best heal ----------------------------------------

{
  // FOOD map: use real IDs from Food.plugin.js if available, else mock.
  let foodIds;
  try {
    const { FOOD } = require("../../items/Food.plugin.js");
    // Find two foods with different heals.
    const entries = [...FOOD.entries()].filter(([, v]) => v.heal > 0);
    entries.sort((a, b) => a[1].heal - b[1].heal);
    foodIds = { weak: entries[0][0], strong: entries[entries.length - 1][0] };
  } catch {
    foodIds = null;
  }

  if (foodIds) {
    const bot = mockBot({ items: [[foodIds.weak, 5], [foodIds.strong, 2]] });
    const best = findBestFood(bot);
    assert.ok(best, "Should find food");
    assert.equal(best.id, foodIds.strong, "Should pick highest heal");
  }

  // No food → null.
  const emptyBot = mockBot({ items: [[1234, 1]] }); // Non-food item.
  const none = findBestFood(emptyBot);
  assert.equal(none, null, "No food returns null");
}

// --- 6. Food eating: consumes and heals --------------------------------------

{
  let foodId, healAmount;
  try {
    const { FOOD } = require("../../items/Food.plugin.js");
    const entry = [...FOOD.entries()].find(([, v]) => v.heal > 0);
    foodId = entry[0];
    healAmount = entry[1].heal;
  } catch {
    foodId = null;
  }

  if (foodId) {
    const bot = mockBot({ hp: 30, maxHp: 100, items: [[foodId, 3]] });
    const before = bot.getInventory().getAmount(foodId);
    const ate = eatBestFood(bot);
    assert.equal(ate, true, "Should eat food");
    assert.equal(bot.getInventory().getAmount(foodId), before - 1, "One consumed");
    assert.ok(bot.healed > 0, "HP restored");
  }

  // No food → false.
  const starving = mockBot({ hp: 10, items: [] });
  assert.equal(eatBestFood(starving), false, "No food returns false");
}

// --- 7. Leave party ----------------------------------------------------------

{
  const bondsPath = require.resolve("./CitizenBonds");
  const bonds = require(bondsPath);
  const origGetParty = bonds.getParty;
  const origSetParty = bonds.setParty;
  const origClearParty = bonds.clearParty;

  const parties = new Map();
  bonds.getParty = (name) => parties.get(name.toLowerCase()) ?? null;
  bonds.setParty = (name, party) => parties.set(name.toLowerCase(), party);
  bonds.clearParty = (name) => parties.delete(name.toLowerCase());

  joinOrCreateParty("Bryn", "PlayerOne");
  joinOrCreateParty("Mara", "PlayerOne"); // Second citizen joins same party.
  
  leaveParty("Bryn");
  assert.equal(bonds.getParty("bryn"), null, "Bryn left the party");

  bonds.getParty = origGetParty;
  bonds.setParty = origSetParty;
  bonds.clearParty = origClearParty;
}

console.log("All CitizenPartyPlay tests passed!");
