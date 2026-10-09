"use strict";

/**
 * Militia.Kingdoms tests — plain node, no engine.
 *
 * Covers: orders (set/get/validate), roster (enlist/discharge/kingdom),
 * tallies (kill/death/siege bonus), volunteer eligibility, raider
 * spawn/despawn with a mock api.
 */

const assert = require("node:assert");
const { test } = require("node:test");

const Militia = require("./Militia.Kingdoms");

function mockBot(username, combatLevel = 30, personality = {}, role = "commoner") {
  const attrs = {
    "citizens:personality": personality,
    "citizens:role": role,
  };
  return {
    getUsername: () => username,
    getSkillManager: () => ({ getCombatLevel: () => combatLevel }),
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  };
}

function reset() {
  Militia._roster.clear();
  Militia._orders.clear();
  Militia._raiders.clear();
  Militia._tallies.clear();
}

test("orders: default is defend, set/get round-trips, invalid rejected", () => {
  reset();
  assert.strictEqual(Militia.getOrders("asgarnia"), "defend");
  assert.deepStrictEqual(Militia.setOrders("asgarnia", "attack", "marshal-bob"), { ok: true, order: "attack" });
  assert.strictEqual(Militia.getOrders("asgarnia"), "attack");
  assert.deepStrictEqual(Militia.setOrders("asgarnia", "charge!!", "x").ok, false);
  assert.strictEqual(Militia.getOrders("asgarnia"), "attack"); // unchanged
  Militia.clearOrders("asgarnia");
  assert.strictEqual(Militia.getOrders("asgarnia"), "defend");
});

test("roster: enlist/discharge round-trip", () => {
  reset();
  const bot = mockBot("BraveBob");
  assert.strictEqual(Militia.isMilitia("BraveBob"), false);
  assert.strictEqual(Militia.enlist(bot, "asgarnia", "defender"), true);
  assert.strictEqual(Militia.isMilitia("bravebob"), true); // case-insensitive
  assert.strictEqual(Militia.enlist(bot, "asgarnia", "defender"), false); // already in
  const rec = Militia.militiaOf("BraveBob");
  assert.strictEqual(rec.kingdomId, "asgarnia");
  assert.strictEqual(rec.side, "defender");
  assert.strictEqual(Militia.militiaCount("asgarnia"), 1);
  assert.strictEqual(Militia.militiaForKingdom("asgarnia").length, 1);
  assert.strictEqual(Militia.discharge("BraveBob", "asgarnia"), true);
  assert.strictEqual(Militia.isMilitia("BraveBob"), false);
});

test("dischargeKingdom removes all of a kingdom's militia", () => {
  reset();
  Militia.enlist(mockBot("A1"), "asgarnia", "attacker");
  Militia.enlist(mockBot("A2"), "asgarnia", "defender");
  Militia.enlist(mockBot("M1"), "misthalin", "defender");
  assert.strictEqual(Militia.dischargeKingdom("asgarnia", () => null), 2);
  assert.strictEqual(Militia.militiaCount("asgarnia"), 0);
  assert.strictEqual(Militia.militiaCount("misthalin"), 1);
});

test("tallies: kills feed siege bonus at 10:1", () => {
  reset();
  assert.strictEqual(Militia.militiaSiegeBonus("asgarnia"), 0);
  for (let i = 0; i < 9; i++) Militia.recordKill("asgarnia");
  assert.strictEqual(Militia.militiaSiegeBonus("asgarnia"), 0);
  Militia.recordKill("asgarnia");
  assert.strictEqual(Militia.militiaSiegeBonus("asgarnia"), 1);
  for (let i = 0; i < 15; i++) Militia.recordKill("asgarnia");
  assert.strictEqual(Militia.militiaSiegeBonus("asgarnia"), 2);
  Militia.recordDeath("asgarnia"); // deaths tracked but don't reduce bonus
  assert.strictEqual(Militia.militiaSiegeBonus("asgarnia"), 2);
  Militia.resetTally("asgarnia");
  assert.strictEqual(Militia.militiaSiegeBonus("asgarnia"), 0);
});

test("canVolunteer: combat gate, already-militia, refugees", () => {
  reset();
  assert.strictEqual(Militia.canVolunteer(mockBot("Weakling", 3)), false); // too low
  assert.strictEqual(Militia.canVolunteer(mockBot("Able", 15)), true); // at threshold
  assert.strictEqual(Militia.canVolunteer(mockBot("Strong", 60)), true);
  assert.strictEqual(Militia.canVolunteer(mockBot("Fleer", 40, {}, "refugee")), false);
  const bot = mockBot("Joined", 40);
  Militia.enlist(bot, "asgarnia", "defender");
  assert.strictEqual(Militia.canVolunteer(bot), false); // already in
  assert.strictEqual(Militia.canVolunteer(null), false);
});

test("volunteerChance: brave citizens volunteer more", () => {
  reset();
  const timid = mockBot("Timid", 30, { bravery: 0.2, aggression: 0.2 });
  const brave = mockBot("Brave", 30, { bravery: 0.9, aggression: 0.8 });
  assert.ok(Militia.volunteerChance(brave) > Militia.volunteerChance(timid));
});

test("raiders: spawn and despawn with mock api", () => {
  reset();
  const spawned = [];
  const api = {
    spawnNpc: ({ id, x, y }) => {
      const npc = { id, x, y, unregister: () => {}, isDead: () => false };
      spawned.push(npc);
      return npc;
    },
  };
  const n = Militia.spawnRaiders(api, "asgarnia", "misthalin", { x: 3165, y: 3485, z: 0 }, 2);
  assert.strictEqual(n, 8); // 4 base + 2*2 fort tier
  assert.strictEqual(spawned.length, 8);
  // No double-spawn.
  assert.strictEqual(Militia.spawnRaiders(api, "asgarnia", "misthalin", { x: 0, y: 0, z: 0 }, 0), 0);
  assert.strictEqual(Militia.liveRaiders("asgarnia", "misthalin").length, 8);
  assert.strictEqual(Militia.despawnRaiders("asgarnia", "misthalin"), 8);
  assert.strictEqual(Militia.liveRaiders("asgarnia", "misthalin").length, 0);
});
