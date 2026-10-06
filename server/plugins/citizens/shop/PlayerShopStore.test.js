// PlayerShopStore unit checks — pure logic, no running server.
// From server/: node plugins/citizens/shop/PlayerShopStore.test.js (plain node, no server)
const assert = require("node:assert/strict");
const Store = require("./PlayerShopStore");

Store.resetForTests(); // in-memory only; never touches data/saves/

// --- stall costs ---
assert.deepEqual(Store.stallCosts("misthalin"), { upfront: 10000, weeklyRent: 1000 });
assert.deepEqual(Store.stallCosts("morytania"), { upfront: 3000, weeklyRent: 300 });
assert.deepEqual(Store.stallCosts("nope"), Store.DEFAULT_STALL_COST);

// --- price clamping: 10%..1000% of the reference price ---
assert.equal(Store.clampPrice(100, 50), 50);
assert.equal(Store.clampPrice(100, 5), 10, "floors at 10%");
assert.equal(Store.clampPrice(100, 5000), 1000, "caps at 1000%");
assert.equal(Store.clampPrice(100, 0), 1, "never below 1");
assert.equal(Store.clampPrice(100, -40), 1);
assert.equal(Store.clampPrice(1, 50), 10, "tiny reference still allows 10x");
assert.equal(Store.clampPrice(null, 42), 10, "unusable reference anchors at 1 (10x cap)");

// --- store round-trip ---
Store.upsertStall({
  owner: "Jon",
  kingdomId: "misthalin",
  stock: { 526: 10 },
  prices: { 526: 12 },
  till: 500,
  employee: "Shopkeep_Sue",
  rentDebt: 0,
});
const stall = Store.getStallByOwner("JON"); // case-insensitive lookup
assert.equal(stall.owner, "Jon");
assert.equal(stall.ownerKey, "jon");
assert.equal(stall.stock[526], 10);
assert.equal(stall.till, 500);
assert.equal(Store.getAllStalls().length, 1);
assert.ok(Store.isEmployed("shopkeep_sue"));
assert.ok(!Store.isEmployed("someone_else"));

// partial update merges without clobbering
Store.upsertStall({ owner: "Jon", till: 600 });
assert.equal(Store.getStallByOwner("jon").till, 600);
assert.equal(Store.getStallByOwner("jon").stock[526], 10, "merge keeps stock");

// explicit null clears the employee
Store.upsertStall({ owner: "Jon", employee: null });
assert.equal(Store.getStallByOwner("jon").employee, null);
assert.ok(!Store.isEmployed("shopkeep_sue"));

// --- returns queue ---
Store.addReturns("jon", [{ id: 526, qty: 4 }, { id: 995, qty: 100 }, { id: 526, qty: 1 }]);
assert.deepEqual(Store.peekReturns("jon"), [
  { id: 526, qty: 5 },
  { id: 995, qty: 100 },
]);
assert.deepEqual(Store.takeReturns("jon"), [
  { id: 526, qty: 5 },
  { id: 995, qty: 100 },
]);
assert.deepEqual(Store.peekReturns("jon"), [], "take clears the queue");
Store.addReturns("jon", [{ id: -1, qty: 5 }, { id: 526, qty: 0 }]);
assert.deepEqual(Store.peekReturns("jon"), [], "junk entries are dropped");

// --- removal ---
assert.ok(Store.removeStall("JON"));
assert.equal(Store.getStallByOwner("jon"), null);
assert.equal(Store.getAllStalls().length, 0);

// --- upkeep sweep (PlayerShopUpkeep is pure over the stores; hooks stubbed) ---
const { processUpkeep } = require("./PlayerShopUpkeep");
const now = Date.now();
const calls = { complained: [], notified: [], unmarked: [] };
const hooks = {
  findEmployeeBot: (stall) => ({
    forceChat: (text) => calls.complained.push({ stall: stall.owner, text }),
    setAttribute: (k, v) => calls.unmarked.push({ k, v }),
  }),
  notifyOwner: (stall, message) => calls.notified.push({ stall: stall.owner, message }),
  clearEmployeeMark: (bot) => bot.setAttribute("shop:stall-employee", null),
};

// wages: 2 days owed, till covers it
Store.upsertStall({
  owner: "WageBoss",
  kingdomId: "asgarnia", // rent 750/week
  stock: {},
  prices: {},
  till: 1000,
  employee: "Sue",
  lastWageAt: now - 2 * Store.DAY_MS,
  lastRentAt: now,
  rentDebt: 0,
});
processUpkeep(hooks, now);
let s = Store.getStallByOwner("wageboss");
assert.equal(s.till, 1000 - 2 * Store.DAILY_WAGE, "two days of wages paid");
assert.equal(s.employee, "Sue", "paid hand stays");

// wages: till can't cover -> the hand quits (silently; no director in tests)
Store.upsertStall({
  owner: "BrokeBoss",
  kingdomId: "asgarnia",
  stock: {},
  prices: {},
  till: 10,
  employee: "Pete",
  lastWageAt: now - Store.DAY_MS,
  lastRentAt: now,
  rentDebt: 0,
});
processUpkeep(hooks, now);
s = Store.getStallByOwner("brokeboss");
assert.equal(s.employee, null, "unpaid employee quits");
assert.equal(s.till, 10, "till untouched when wages can't be paid");
assert.equal(calls.complained.length, 1, "the hand complains out loud");
assert.equal(calls.unmarked.length, 1, "employee mark cleared");

// rent: a week owed, till covers it
Store.upsertStall({
  owner: "RentPayer",
  kingdomId: "misthalin", // rent 1000/week
  stock: {},
  prices: {},
  till: 5000,
  employee: null,
  lastWageAt: now,
  lastRentAt: now - Store.WEEK_MS,
  rentDebt: 0,
});
processUpkeep(hooks, now);
s = Store.getStallByOwner("rentpayer");
assert.equal(s.till, 4000, "one week of rent taken");
assert.equal(s.rentDebt, 0);

// rent: partial payment becomes arrears, stall survives the first miss
Store.upsertStall({
  owner: "LatePayer",
  kingdomId: "misthalin",
  stock: { 526: 3 },
  prices: { 526: 12 },
  till: 100,
  employee: null,
  lastWageAt: now,
  lastRentAt: now - Store.WEEK_MS,
  rentDebt: 0,
});
processUpkeep(hooks, now);
s = Store.getStallByOwner("latepayer");
assert.equal(s.till, 0);
assert.equal(s.rentDebt, 900, "shortfall becomes debt");
assert.ok(s, "stall survives first missed week");
assert.ok(
  calls.notified.some((n) => n.stall === "LatePayer" && n.message.includes("900")),
  "owner warned about back rent"
);

// rent: arrears beyond two weeks -> repossessed, stock + till queued for claim
Store.upsertStall({
  owner: "Deadbeat",
  kingdomId: "misthalin",
  stock: { 526: 3 },
  prices: { 526: 12 },
  till: 50,
  employee: "Gone_Soon",
  lastWageAt: now,
  lastRentAt: now - Store.WEEK_MS,
  rentDebt: 1500,
});
processUpkeep(hooks, now);
assert.equal(Store.getStallByOwner("deadbeat"), null, "stall repossessed");
// The 50-coin till went to the partial rent payment first — only stock returns.
assert.deepEqual(Store.peekReturns("deadbeat"), [{ id: 526, qty: 3 }]);
assert.equal(calls.notified.filter((n) => n.stall === "Deadbeat").length, 1, "owner told");
assert.ok(!Store.isEmployed("gone_soon"), "employee released on repossession");

console.log("PlayerShopStore.test.js: all checks passed");
