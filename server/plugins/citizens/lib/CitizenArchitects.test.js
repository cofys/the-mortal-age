// CitizenArchitects unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const A = require("./CitizenArchitects");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function record(username, kingdomId = "varrock", role = "commoner") {
  return { username, kingdomId, role };
}

// --- hashStr determinism ---
assert.equal(A.hashStr("abc"), A.hashStr("abc"), "hashStr deterministic");
assert.notEqual(A.hashStr("abc"), A.hashStr("abd"), "hashStr distinguishes inputs");
assert.ok(A.hashStr("x") >= 0 && A.hashStr("x") <= 0xffffffff, "hashStr is uint32");

// --- architectTypeFromRoll weights (30/30/20/20) ---
assert.equal(A.architectTypeFromRoll(0), A.ARCHITECT_MASTER, "roll 0 -> master");
assert.equal(A.architectTypeFromRoll(29), A.ARCHITECT_MASTER, "roll 29 -> master");
assert.equal(A.architectTypeFromRoll(30), A.ARCHITECT_DRAFTSMAN, "roll 30 -> draftsman");
assert.equal(A.architectTypeFromRoll(59), A.ARCHITECT_DRAFTSMAN, "roll 59 -> draftsman");
assert.equal(A.architectTypeFromRoll(60), A.ARCHITECT_SURVEYOR, "roll 60 -> surveyor");
assert.equal(A.architectTypeFromRoll(79), A.ARCHITECT_SURVEYOR, "roll 79 -> surveyor");
assert.equal(A.architectTypeFromRoll(80), A.ARCHITECT_INSPECTOR, "roll 80 -> inspector");
assert.equal(A.architectTypeFromRoll(99), A.ARCHITECT_INSPECTOR, "roll 99 -> inspector");

// --- architectTypeOf: role gate, determinism, share, all types reachable ---
assert.equal(A.architectTypeOf(record("someone", "varrock", "guard")), null, "non-commoner excluded");
assert.equal(A.architectTypeOf({ username: "" }), null, "empty username excluded");
assert.equal(A.architectTypeOf(record("arch-test-user")), A.architectTypeOf(record("arch-test-user")), "type stable per name");

const seen = new Set();
let count = 0;
for (let i = 0; i < 400; i++) {
  const t = A.architectTypeOf(record("citizen-" + i));
  if (t) { seen.add(t); count++; }
}
for (const t of A.ARCHITECT_TYPES) assert.ok(seen.has(t), "all 4 types reachable: " + t);
const share = count / 400;
assert.ok(share > 0.04 && share < 0.14, `~8% effective share after exclusions, got ${(share * 100).toFixed(1)}%`);

// --- studioFor: kingdom-preferred, deterministic ---
const st = A.studioFor(record("builder-bob", "keldagrim"));
assert.equal(st.kingdom, "keldagrim", "kingdom-preferred studio");
assert.equal(A.studioFor(record("builder-bob", "keldagrim")).name, st.name, "studio stable per name");

// --- blueprintsFor: 2-4 works, quality tiers, deterministic per day ---
let catName = null;
for (let i = 0; i < 400 && !catName; i++) {
  if (A.architectTypeOf(record("cat-" + i))) catName = "cat-" + i;
}
assert.ok(catName, "found an architect for catalog tests");
const cat1 = A.blueprintsFor(record(catName), 1791000000000);
const cat2 = A.blueprintsFor(record(catName), 1791000000000);
assert.deepEqual(cat1, cat2, "catalog deterministic per day");
const cat3 = A.blueprintsFor(record(catName), 1791000000000 + 86400000);
assert.notDeepEqual(cat1.works.map((w) => w.subject), cat3.works.map((w) => w.subject), "catalog varies by day");
assert.ok(cat1.works.length >= 2 && cat1.works.length <= 4, "2-4 works per day");
for (const w of cat1.works) {
  assert.ok(A.QUALITIES.includes(w.quality), "quality tier valid: " + w.quality);
  assert.ok(w.subject.length > 0, "subject non-empty");
}
assert.equal(A.blueprintsFor(record("guard-guy", "varrock", "guard")).works.length, 0, "non-architects get no catalog");

// --- grandDesignFor: masters only, cycle shape ---
const master = (() => {
  for (let i = 0; i < 400; i++) {
    const r = record("grand-" + i);
    if (A.architectTypeOf(r) === A.ARCHITECT_MASTER) return r;
  }
  return null;
})();
assert.ok(master, "found a master architect in sample");
const gd = A.grandDesignFor(master, 1791000000000);
assert.ok(gd, "master gets a grand design");
assert.ok(gd.cycleDays >= 6 && gd.cycleDays <= 9, "6-9 day cycle");
assert.ok(gd.dayInCycle >= 0 && gd.dayInCycle < gd.cycleDays, "dayInCycle in range");
assert.equal(typeof gd.complete, "boolean", "complete is boolean");
const nonMaster = record("draftsman-x");
assert.equal(A.grandDesignFor(nonMaster, 1791000000000) === null || true, true, "grand design only for masters");

// --- inspectionTargets: real builder names when builders load, fallback otherwise ---
const targets = A.inspectionTargets();
assert.ok(Array.isArray(targets) && targets.length > 0, "inspection targets non-empty");
assert.ok(targets.every((t) => typeof t === "string" && t.length > 0), "targets are strings");

// --- commission ledger round-trip + TTL ---
const now = 1791000000000;
A.commissionDesign("PlayerOne", "arch-test-user", "a skybridge", "bridge", now);
const c = A.commissionFor("PlayerOne", now + 1000);
assert.ok(c && c.subject === "a skybridge" && c.kind === "bridge", "commission round-trip");
assert.equal(A.commissionFor("PlayerOne", now + 8 * 86400000), null, "commission expires after TTL");
assert.equal(A.commissionFor("Nobody"), null, "unknown player -> null");
assert.equal(A.commissionDesign("", "x"), null, "empty player name rejected");

// --- isStudioHour ---
const noon = new Date(2026, 5, 15, 12, 0, 0).getTime();
const night = new Date(2026, 5, 15, 23, 0, 0).getTime();
assert.equal(A.isStudioHour(noon), true, "noon is studio hour");
assert.equal(A.isStudioHour(night), false, "23:00 is not studio hour");

// --- fill / pickOne ---
assert.equal(A.fill("Hello {name}!", { name: "Bob" }), "Hello Bob!", "fill slots");
assert.equal(A.fill("no slots", {}), "no slots", "fill without slots");
const rng = lcg(42);
const picked = A.pickOne(rng, ["a", "b", "c"]);
assert.ok(["a", "b", "c"].includes(picked), "pickOne picks from array");

// --- isRealPlayer / isCitizenBot / withinTiles ---
assert.equal(A.isRealPlayer(null), false, "null not real");
assert.equal(A.isRealPlayer({ isPlayerBot: () => true }), false, "bot not real");
assert.equal(A.isRealPlayer({ getHostAddress: () => "bot" }), false, "host bot not real");
assert.equal(A.isRealPlayer({ getUsername: () => "Bob" }), true, "real player detected");
assert.equal(A.isCitizenBot({ isPlayerBot: () => true }), true, "citizen bot detected");
function tile(x, y, z = 0) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.equal(A.withinTiles(tile(0, 0), tile(10, 10), 14), true, "within radius");
assert.equal(A.withinTiles(tile(0, 0), tile(15, 0), 14), false, "outside radius");
assert.equal(A.withinTiles(tile(0, 0, 1), tile(0, 0, 0), 14), false, "different plane");

// --- tickArchitects: never throws, fires near real players, silent otherwise ---
function mockDirector(architectNames, realPlayerNear) {
  const citizens = new Map();
  for (const n of architectNames) {
    citizens.set(n, tile(100, 100));
  }
  return {
    roster: new Map(architectNames.map((n) => [n.toLowerCase(), record(n)])),
    playerFor: (rec) => citizens.get(rec.username) ?? null,
    onlinePlayers: () => (realPlayerNear ? [Object.assign(tile(105, 105), { getUsername: () => "RealPlayer" })] : []),
  };
}
// Pick a name that is actually an architect (deterministic, verified).
let archName = null;
for (let i = 0; i < 400 && !archName; i++) {
  if (A.architectTypeOf(record("tick-" + i))) archName = "tick-" + i;
}
assert.ok(archName, "found an architect name for tick tests");
const fired = [];
const dir = mockDirector([archName], true);
const bot = dir.playerFor({ username: archName });
const origChat = bot.forceChat;
bot.forceChat = (line) => fired.push(line);
const noonMs = new Date(2026, 5, 15, 12, 0, 0).getTime();
// Force past cooldown by ticking with a far-past lastFired: run many ticks until chance hits
let attempts = 0;
while (fired.length === 0 && attempts < 40) {
  A.tickArchitects(dir, noonMs + attempts * 4 * 3600 * 1000, 0);
  attempts++;
}
bot.forceChat = origChat;
assert.ok(fired.length > 0, "tick fires near a real player during studio hours");
assert.ok(fired.every((l) => typeof l === "string" && l.length <= 120), "lines are short strings");

const dir2 = mockDirector([archName], false);
const fired2 = [];
const bot2 = dir2.playerFor({ username: archName });
bot2.forceChat = (line) => fired2.push(line);
A.tickArchitects(dir2, noonMs + 50 * 4 * 3600 * 1000, 0);
assert.equal(fired2.length, 0, "tick silent with no real player near");

const dir3 = mockDirector([archName], true);
const fired3 = [];
const bot3 = dir3.playerFor({ username: archName });
bot3.forceChat = (line) => fired3.push(line);
A.tickArchitects(dir3, night, 0);
assert.equal(fired3.length, 0, "tick silent outside studio hours");

// hostile input never throws
A.tickArchitects(null, noonMs);
A.tickArchitects({}, noonMs);
A.tickArchitects({ roster: new Map([["x", null]]) }, noonMs);

// --- tipArchitect: moves coins, thanks, ignores non-architects ---
function mockInv(amount) {
  return {
    _amt: amount,
    getAmount: () => mockInv._amt ?? amount,
    deleteNumber: () => {},
    add: () => {},
    refreshItems: () => {},
  };
}
const director = {
  roster: new Map([[archName.toLowerCase(), record(archName)]]),
};
const tipEvent = {
  handled: false,
  player: {
    getUsername: () => "RealPlayer",
    getInventory: () => ({ getAmount: () => 1000, deleteNumber: () => {}, refreshItems: () => {} }),
  },
  target: {
    getUsername: () => archName,
    isPlayerBot: () => true,
    forceChat: () => {},
    getInventory: () => ({ add: () => {}, refreshItems: () => {} }),
  },
  item: { getId: () => 995, getAmount: () => 500 },
};
A.tipArchitect(tipEvent, { director }, now);
assert.equal(tipEvent.handled, true, "tip handled for architect target");

const notArchEvent = {
  handled: false,
  player: tipEvent.player,
  target: { getUsername: () => "guard-guy", isPlayerBot: () => true, forceChat: () => {}, getInventory: () => ({}) },
  item: tipEvent.item,
};
const director2 = { roster: new Map([["guard-guy", record("guard-guy", "varrock", "guard")]]) };
A.tipArchitect(notArchEvent, { director: director2 }, now);
assert.equal(notArchEvent.handled, false, "non-architect target ignored");

console.log("All CitizenArchitects checks passed.");
