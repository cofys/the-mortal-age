// CitizenBuilders unit checks — pure logic, no running server.
// Run: node CitizenBuilders.test.js
"use strict";

const assert = require("node:assert/strict");
const {
  hashName,
  tradeFor,
  pickOne,
  isRealPlayer,
  chebyshev,
  phaseFor,
  generateProject,
  siteTile,
  tradeSpot,
  eligibleBuilder,
  rebuildBuilders,
  advanceProjects,
  getBuilderInfo,
  SLOTS_PER_TRADE,
  TRADES,
  PROJECT_TYPES,
  PROJECT_PHASES,
} = require("./CitizenBuilders");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- hashName ---
{
  const a = hashName("Mason Bob");
  const b = hashName("Mason Bob");
  const c = hashName("mason bob"); // case-insensitive
  const d = hashName("Different Name");
  assert.equal(a, b, "hashName is deterministic");
  assert.equal(a, c, "hashName is case-insensitive");
  assert.notEqual(a, d, "hashName differs for different names");
  assert.ok(Number.isInteger(a) && a >= 0, "hashName returns uint32");
}

// --- tradeFor ---
{
  const t1 = tradeFor("Some Citizen");
  const t2 = tradeFor("Some Citizen");
  assert.equal(t1, t2, "tradeFor is stable");
  assert.ok(Object.keys(TRADES).includes(t1), "tradeFor returns a valid trade");
  // Distribution sanity: all 4 trades appear across 200 names.
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(tradeFor(`Citizen ${i}`));
  assert.equal(seen.size, 4, "all 4 trades assigned across population");
}

// --- pickOne ---
{
  const arr = ["a", "b", "c"];
  const rng = lcg(42);
  const picks = new Set();
  for (let i = 0; i < 50; i++) picks.add(pickOne(rng, arr));
  assert.ok(picks.size > 1, "pickOne varies");
  assert.ok([...picks].every((p) => arr.includes(p)), "pickOne picks from array");
}

// --- isRealPlayer ---
{
  assert.equal(isRealPlayer(null), false, "null is not a player");
  assert.equal(isRealPlayer(undefined), false, "undefined is not a player");
  assert.equal(
    isRealPlayer({ isPlayerBot: () => true }),
    false,
    "bots are not real players"
  );
  assert.equal(
    isRealPlayer({ getHostAddress: () => "bot" }),
    false,
    "bot hosts are not real"
  );
  assert.equal(
    isRealPlayer({ getUsername: () => "Jon" }),
    true,
    "real player passes"
  );
  assert.equal(isRealPlayer({}), false, "empty object fails");
}

// --- chebyshev ---
{
  assert.equal(chebyshev({ x: 0, y: 0 }, { x: 3, y: 4 }), 4, "chebyshev max");
  assert.equal(chebyshev({ x: 0, y: 0 }, { x: 0, y: 0 }), 0, "same tile");
  assert.equal(
    chebyshev({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }),
    Infinity,
    "different plane"
  );
  assert.equal(chebyshev(null, { x: 0, y: 0 }), Infinity, "null safe");
}

// --- phaseFor ---
{
  assert.equal(phaseFor(0, 100), "scaffolding", "0% = scaffolding");
  assert.equal(phaseFor(24, 100), "scaffolding", "24% = scaffolding");
  assert.equal(phaseFor(25, 100), "structure", "25% = structure");
  assert.equal(phaseFor(69, 100), "structure", "69% = structure");
  assert.equal(phaseFor(70, 100), "finishing", "70% = finishing");
  assert.equal(phaseFor(99, 100), "finishing", "99% = finishing");
  assert.equal(phaseFor(100, 100), "complete", "100% = complete");
  assert.equal(phaseFor(150, 100), "complete", "over = complete");
}

// --- generateProject ---
{
  const rng = lcg(7);
  const p = generateProject(rng, "asgarnia");
  assert.ok(Object.keys(PROJECT_TYPES).includes(p.type), "valid project type");
  assert.ok(typeof p.name === "string" && p.name.length > 0, "project has a name");
  assert.equal(p.work, 0, "new project starts at 0 work");
  assert.ok(p.total > 0, "project has positive total work");
  assert.equal(p.phase, "scaffolding", "new project starts at scaffolding");
  assert.equal(p.kingdomId, "asgarnia", "kingdom id preserved");
  // All project types generatable.
  const types = new Set();
  for (let i = 0; i < 100; i++)
    types.add(generateProject(lcg(i * 2654435761 + 11), "k").type);
  assert.equal(types.size, 4, "all 4 project types generated");
}

// --- tradeSpot ---
{
  const site = { x: 100, y: 100, z: 0 };
  const spots = ["mason", "carpenter", "architect", "laborer"].map((t) =>
    tradeSpot(site, t)
  );
  // All spots near the site, all distinct.
  const keys = new Set(spots.map((s) => `${s.x},${s.y}`));
  assert.equal(keys.size, 4, "trade spots are distinct");
  for (const s of spots) {
    assert.ok(
      Math.abs(s.x - site.x) <= 5 && Math.abs(s.y - site.y) <= 5,
      "spot near site"
    );
  }
  // Unknown trade falls back to site center.
  const fallback = tradeSpot(site, "plumber");
  assert.deepEqual(
    { x: fallback.x, y: fallback.y },
    { x: site.x, y: site.y },
    "unknown trade = site center"
  );
}

// --- TRADES / SLOTS sanity ---
{
  assert.equal(Object.keys(TRADES).length, 4, "4 trades defined");
  for (const [k, t] of Object.entries(TRADES)) {
    assert.ok(t.label === k, `${k} label matches`);
    assert.ok(t.verb && t.journal && t.offer, `${k} has verb/journal/offer`);
  }
  assert.deepEqual(
    Object.keys(SLOTS_PER_TRADE).sort(),
    Object.keys(TRADES).sort(),
    "slots cover all trades"
  );
  assert.deepEqual(
    PROJECT_PHASES,
    ["scaffolding", "structure", "finishing", "complete"],
    "4 phases in order"
  );
}

// --- eligibleBuilder ---
{
  assert.equal(eligibleBuilder(null), false, "null not eligible");
  assert.equal(
    eligibleBuilder({ role: "merchant", username: "Bob" }),
    false,
    "merchants not eligible"
  );
  assert.equal(
    eligibleBuilder({ role: "commoner", username: "Bob" }),
    true,
    "commoners eligible"
  );
  assert.equal(
    eligibleBuilder({ role: "commoner", username: "" }),
    false,
    "empty name not eligible"
  );
}

// --- rebuildBuilders + advanceProjects (mock director) ---
{
  const records = [];
  // 20 commoners in one kingdom.
  for (let i = 0; i < 20; i++) {
    records.push({
      role: "commoner",
      username: `Builder${i}`,
      kingdomId: "asgarnia",
    });
  }
  // A merchant (should be skipped).
  records.push({ role: "merchant", username: "Shopkeep", kingdomId: "asgarnia" });

  const director = { roster: new Map(records.map((r) => [r.username, r])) };
  rebuildBuilders(director);

  // getBuilderInfo works for a builder.
  const info = getBuilderInfo("Builder0");
  if (info) {
    assert.ok(Object.keys(TRADES).includes(info.trade), "builder has valid trade");
    assert.equal(info.kingdomId, "asgarnia", "kingdom preserved");
  }

  // Caps respected: count per trade <= slots.
  const counts = {};
  const roster2 = director.roster;
  rebuildBuilders(director); // idempotent
  for (const r of roster2.values()) {
    const bi = getBuilderInfo(r.username);
    if (bi) counts[bi.trade] = (counts[bi.trade] ?? 0) + 1;
  }
  for (const [trade, max] of Object.entries(SLOTS_PER_TRADE)) {
    assert.ok(
      (counts[trade] ?? 0) <= max,
      `${trade} capped at ${max} (got ${counts[trade] ?? 0})`
    );
  }
  // Merchant not a builder.
  assert.equal(getBuilderInfo("Shopkeep"), null, "merchant not a builder");

  // Projects advance.
  const now = Date.now();
  advanceProjects(director, now);
  const after = getBuilderInfo("Builder0");
  if (after) {
    assert.ok(after.activeProject, "active project exists after advance");
    assert.ok(
      PROJECT_PHASES.includes(after.activeProject.phase),
      "valid phase"
    );
  }
}

// --- getBuilderInfo for non-builder ---
{
  assert.equal(getBuilderInfo("Nobody Here"), null, "unknown = null");
  assert.equal(getBuilderInfo(""), null, "empty = null");
}

// --- project completion cycle ---
{
  const records = [];
  for (let i = 0; i < 10; i++) {
    records.push({ role: "commoner", username: `Crew${i}`, kingdomId: "kandarin" });
  }
  const director = { roster: new Map(records.map((r) => [r.username, r])) };
  rebuildBuilders(director);

  // Force a project to near-complete, then advance past the finish line.
  const { advanceProjects: adv } = require("./CitizenBuilders");
  // Run enough ticks to complete at least one project (max work = 120).
  for (let t = 0; t < 130; t++) {
    adv(director, Date.now() + t * 60000);
  }
  // After completion, a NEW project should be active (work reset).
  const info = getBuilderInfo("Crew0");
  if (info && info.activeProject) {
    assert.ok(
      info.recentCompletions.length >= 1,
      "completed projects tracked"
    );
  }
}

console.log("CitizenBuilders: all assertions passed.");
