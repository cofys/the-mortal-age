"use strict";

const assert = require("node:assert");
const { test } = require("node:test");

const Loot = require("./CitizenLoot");

function mockBot(over = {}) {
  const inv = {
    slots: over.invSlots ?? {},
    getFreeSlots: () => over.freeSlots ?? 28,
    contains: (id) => (over.invSlots ?? {})[id] > 0,
  };
  return {
    getUsername: () => over.username ?? "Test Citizen",
    getInventory: () => inv,
    getCombat: () => over.inCombat ? { getTarget: () => ({}), getAttacker: () => null } : { getTarget: () => null, getAttacker: () => null },
    busy: () => false,
    getPrivateArea: () => null,
    getMovementQueue: () => ({
      walkToGroundItem: (pos, cb) => {
        (over.walkCalls ?? (over.walkCalls = [])).push({ x: pos.getX(), y: pos.getY() });
        cb();
      },
    }),
    ...over.extra,
  };
}

function mockGroundItems(foundAt) {
  // foundAt: Map "x,y,id" -> ground item
  const calls = { pickup: [] };
  return {
    calls,
    getGroundItem: (owner, id, pos) => {
      const key = `${pos.getX()},${pos.getY()},${id}`;
      return foundAt.get(key) ?? null;
    },
    pickup: (bot, gi) => {
      calls.pickup.push(gi);
    },
  };
}

function giAt(x, y, id, amount = 1) {
  return {
    getItem: () => ({ getId: () => id, getAmount: () => amount }),
    getPosition: () => ({
      getX: () => x,
      getY: () => y,
      clone: () => ({ getX: () => x, getY: () => y }),
    }),
  };
}

function rollEvent(bot, drops, x = 100, y = 200) {
  return {
    player: bot,
    npc: { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }) },
    drops,
  };
}

test("onCitizenDropsRolled: ignores real players and empty drops", () => {
  Loot._resetForTests();
  const realPlayer = mockBot();
  realPlayer.isPlayerBot = () => false;
  Loot.onCitizenDropsRolled(rollEvent(realPlayer, [{ itemId: 526, amount: 1 }]));
  Loot.onCitizenDropsRolled({ player: realPlayer, npc: null, drops: [] });
  assert.equal(Loot._pendingLoot.size, 0);
});

test("onCitizenDropsRolled: stashes a loot run for a bot killer", () => {
  Loot._resetForTests();
  const bot = mockBot({ username: "Looter Lane" });
  bot.isPlayerBot = () => true;
  Loot.onCitizenDropsRolled(rollEvent(bot, [{ itemId: 526, amount: 2 }, { itemId: 995, amount: 50 }], 3210, 3500));
  const run = Loot._pendingLoot.get("Looter Lane");
  assert.ok(run);
  assert.equal(run.items.length, 2);
  assert.equal(run.x, 3210);
  assert.equal(run.y, 3500);
});

test("shouldTake: bones are always worth it", () => {
  const bot = mockBot();
  assert.equal(Loot.shouldTake(bot, {}, 526, 1), true);
  assert.equal(Loot.shouldTake(bot, { traits: ["proud"] }, 532, 3), true);
});

test("shouldTake: junk returns a boolean (personality-weighted)", () => {
  const bot = mockBot();
  const r1 = Loot.shouldTake(bot, { traits: ["greedy"] }, 12345, 1);
  const r2 = Loot.shouldTake(bot, {}, 12345, 1);
  assert.equal(typeof r1, "boolean");
  assert.equal(typeof r2, "boolean");
});

test("tickCitizenLoot: walks to the drop and picks it up through the engine", () => {
  Loot._resetForTests();
  const bot = mockBot({ username: "Looter Lane" });
  bot.isPlayerBot = () => true;
  Loot.onCitizenDropsRolled(rollEvent(bot, [{ itemId: 526, amount: 1 }], 100, 200));

  const found = new Map([["100,200,526", giAt(100, 200, 526, 1)]]);
  const mgr = mockGroundItems(found);
  const walkCalls = [];
  bot.getMovementQueue = () => ({
    walkToGroundItem: (pos, cb) => {
      walkCalls.push({ x: pos.getX(), y: pos.getY() });
      cb();
    },
  });

  Loot.tickCitizenLoot(Date.now() + 60_000, {
    botFor: () => bot,
    personalityFor: () => ({}),
    groundItems: mgr,
  });

  assert.equal(walkCalls.length, 1);
  assert.deepEqual([walkCalls[0].x, walkCalls[0].y], [100, 200]);
  assert.equal(mgr.calls.pickup.length, 1);
  assert.equal(Loot._pendingLoot.has("Looter Lane"), false); // run complete
});

test("tickCitizenLoot: skips the tick while the citizen is in combat", () => {
  Loot._resetForTests();
  const bot = mockBot({ username: "Busy Bob", inCombat: true });
  bot.isPlayerBot = () => true;
  Loot.onCitizenDropsRolled(rollEvent(bot, [{ itemId: 526, amount: 1 }], 100, 200));

  const mgr = mockGroundItems(new Map());
  let walked = 0;
  bot.getMovementQueue = () => ({
    walkToGroundItem: (pos, cb) => {
      walked++;
      cb();
    },
  });

  Loot.tickCitizenLoot(Date.now() + 60_000, {
    botFor: () => bot,
    personalityFor: () => ({}),
    groundItems: mgr,
  });

  assert.equal(walked, 0);
  assert.equal(Loot._pendingLoot.has("Busy Bob"), true); // run kept for later
});

test("tickCitizenLoot: stale runs are abandoned", () => {
  Loot._resetForTests();
  const bot = mockBot({ username: "Old Oak" });
  bot.isPlayerBot = () => true;
  Loot.onCitizenDropsRolled(rollEvent(bot, [{ itemId: 526, amount: 1 }], 100, 200));

  const mgr = mockGroundItems(new Map());
  Loot.tickCitizenLoot(Date.now() + 60 * 60_1000, {
    botFor: () => bot,
    personalityFor: () => ({}),
    groundItems: mgr,
  });
  assert.equal(Loot._pendingLoot.has("Old Oak"), false);
});

test("tickCitizenLoot: one pickup per tick (human-paced)", () => {
  Loot._resetForTests();
  const bot = mockBot({ username: "Slow Sam" });
  bot.isPlayerBot = () => true;
  Loot.onCitizenDropsRolled(
    rollEvent(bot, [{ itemId: 526, amount: 1 }, { itemId: 532, amount: 1 }], 100, 200)
  );

  const found = new Map([
    ["100,200,526", giAt(100, 200, 526, 1)],
    ["100,200,532", giAt(100, 200, 532, 1)],
  ]);
  const mgr = mockGroundItems(found);
  let walked = 0;
  bot.getMovementQueue = () => ({
    walkToGroundItem: (pos, cb) => {
      walked++;
      cb();
    },
  });
  const deps = {
    botFor: () => bot,
    personalityFor: () => ({}),
    groundItems: mgr,
  };

  Loot.tickCitizenLoot(Date.now() + 60_000, deps);
  assert.equal(walked, 1);
  assert.equal(Loot._pendingLoot.has("Slow Sam"), true); // second item next tick
  Loot.tickCitizenLoot(Date.now() + 61_000, deps);
  assert.equal(walked, 2);
  assert.equal(Loot._pendingLoot.has("Slow Sam"), false);
});
