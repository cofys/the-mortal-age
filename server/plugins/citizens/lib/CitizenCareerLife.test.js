// CitizenCareerLife unit checks — tick dynamics with a stub director.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Careers = require("./CitizenCareers");
const { tickCareers } = require("./CitizenCareerLife");

const DAY_MS = 24 * 3600 * 1000;

let passed = 0;
function check(name, fn) {
  Careers.resetForTests();
  Careers._setSavePathForTests(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "careerlife-")), "careers.json")
  );
  fn();
  passed++;
  console.log("ok - " + name);
}

/** Minimal stub director: roster map + getBot + log. */
function stubDirector(records, bots = {}) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  return {
    roster,
    getBot: (record) => bots[record?.username?.toLowerCase()] ?? null,
    log: () => {},
  };
}

function record(username, role = "commoner", extra = {}) {
  return {
    username,
    displayName: username,
    role,
    kingdomId: "asgarnia",
    personality: { traits: [] },
    goal: { type: "master_trade" },
    home: { x: 3200, y: 3200, z: 0 },
    ...extra,
  };
}

function stubBot(coins = 0) {
  let balance = coins;
  return {
    getInventory: () => ({
      getAmount: () => balance,
      adds: (id, qty) => {
        balance += qty;
      },
      deleted: (id, qty) => {
        const take = Math.min(balance, qty);
        balance -= take;
      },
    }),
  };
}

// --- assignment --------------------------------------------------------------------

check("tick assigns careers from role", () => {
  const d = stubDirector([
    record("Guard One", "guard"),
    record("Merch Two", "merchant"),
    record("Court Three", "courtier"),
  ]);
  tickCareers(d, Date.now());
  assert.equal(Careers.careerOf("Guard One")?.career, "guard");
  assert.equal(Careers.careerOf("Merch Two")?.career, "trader");
  assert.equal(Careers.careerOf("Court Three")?.career, "scribe");
});

check("tick assigns laborer to commoners with no skills", () => {
  const d = stubDirector([record("Common Four")]);
  tickCareers(d, Date.now());
  assert.equal(Careers.careerOf("Common Four")?.career, "laborer");
});

// --- promotions ----------------------------------------------------------------------

check("tick promotes on tenure for service careers", () => {
  const now = Date.now();
  const d = stubDirector([record("Vet Guard", "guard")]);
  tickCareers(d, now);
  const rec = Careers.careerOf("Vet Guard");
  // Backdate the career start 40 days, then tick again.
  rec.since = now - 40 * DAY_MS;
  tickCareers(d, now + 1000);
  assert.equal(Careers.careerOf("Vet Guard")?.rank, Careers.RANK_MASTER);
});

// --- wages -----------------------------------------------------------------------------

check("tick pays daily wage to online service workers in real coins", () => {
  const now = Date.now();
  const bot = stubBot(0);
  const d = stubDirector([record("Wage Guard", "guard")], { "wage guard": bot });
  tickCareers(d, now);
  const rec = Careers.careerOf("Wage Guard");
  const before = bot.getInventory().getAmount();
  rec.lastWageAt = 0; // force the daily wage
  tickCareers(d, now + 1000);
  const expected = Careers.dailyWage("guard", Careers.RANK_APPRENTICE);
  assert.ok(expected > 0);
  assert.equal(bot.getInventory().getAmount() - before, expected);
});

check("tick banks wages as savings for offline workers", () => {
  const now = Date.now();
  const d = stubDirector([record("Off Guard", "guard")]); // no bot = offline
  tickCareers(d, now);
  const rec = Careers.careerOf("Off Guard");
  const before = rec.savings;
  rec.lastWageAt = 0;
  tickCareers(d, now + 1000);
  const expected = Careers.dailyWage("guard", Careers.RANK_APPRENTICE);
  assert.equal(rec.savings - before, expected);
});

check("tick flushes savings when the worker materializes", () => {
  const now = Date.now();
  const d0 = stubDirector([record("Flush Guard", "guard")]);
  tickCareers(d0, now);
  const rec = Careers.careerOf("Flush Guard");
  rec.lastWageAt = 0;
  tickCareers(d0, now + 1000);
  assert.ok(rec.savings > 0);
  const saved = rec.savings;
  // Now the citizen comes online.
  const bot = stubBot(0);
  const d1 = stubDirector([record("Flush Guard", "guard")], { "flush guard": bot });
  rec.lastWageAt = now + 1000; // wage already paid today; only flush savings
  tickCareers(d1, now + 2000);
  assert.equal(rec.savings, 0);
  assert.equal(bot.getInventory().getAmount(), saved);
});

check("trade careers earn no wage", () => {
  const now = Date.now();
  const bot = stubBot(0);
  const d = stubDirector([record("Smithy", "commoner")], { smithy: bot });
  Careers.setCareer("Smithy", "smith", now); // trade career before first tick
  const rec = Careers.careerOf("Smithy");
  rec.lastWageAt = 0;
  tickCareers(d, now + 1000);
  assert.equal(bot.getInventory().getAmount(), 0);
  assert.equal(rec.savings, 0);
});

// --- career changes -----------------------------------------------------------------------

check("guards never change careers", () => {
  const now = Date.now();
  // Force many ticks with a restless guard — the guard stays a guard.
  const d = stubDirector([
    record("Loyal Guard", "guard", { personality: { traits: ["restless"] } }),
  ]);
  for (let i = 0; i < 50; i++) tickCareers(d, now + i * 61000);
  assert.equal(Careers.careerOf("Loyal Guard")?.career, "guard");
});

// --- teaching -------------------------------------------------------------------------------

check("master mentors accelerate apprentice tenure", () => {
  const now = Date.now();
  const d = stubDirector([
    record("Master Scribe", "courtier"),
    record("Young Scribe", "courtier"),
  ]);
  tickCareers(d, now);
  const master = Careers.careerOf("Master Scribe");
  const pupil = Careers.careerOf("Young Scribe");
  master.rank = Careers.RANK_MASTER; // tenure cheat for the test
  const before = pupil.since;
  // Run many ticks; mentoring is chance-based but 200 ticks will hit.
  for (let i = 0; i < 200; i++) tickCareers(d, now + i * 61000);
  assert.ok(pupil.since < before, "apprentice clock accelerated by teaching");
});

console.log(`\n${passed} checks passed.`);
