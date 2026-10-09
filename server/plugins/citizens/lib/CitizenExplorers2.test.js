"use strict";

// CitizenExplorers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  pickOne,
  isRealPlayer,
  withinTiles,
  frontierRoleFor,
  settlementNameFor,
  nextStage,
  priceForSketch,
  discoveryKey,
  shouldFoundSettlement,
  reconReport,
  fieldNoteLine,
  formSettlement,
  fundExpedition,
  fundingBonusFor,
  mapsForSale,
  buyMap,
  purchasesFor,
  fundedExpeditions,
  listSettlements,
  resetForTests,
  tickExplorers2,
  FRONTIER_ROLES,
  SETTLEMENT_STAGES,
} = require("./CitizenExplorers2");
const {
  hashName,
  isExplorer,
  journeyOutcome,
  musteringExpeditions,
  finishedExpeditions,
  tickExplorers,
  resetForTests: explorersReset,
} = require("./CitizenExplorers");
const { agentRng } = require("./humanizer");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  resetForTests();
  explorersReset();
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function fakeAt(x, y, z = 0) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}

// Find usernames hashing into the explorer bucket (~5% of citizens).
function findExplorers(count, prefix) {
  const out = [];
  for (let i = 0; out.length < count && i < 5000; i++) {
    const n = `${prefix}${i}`;
    if (isExplorer(n)) out.push(n);
  }
  return out;
}

// Find usernames with a given frontier role.
function findRole(role, count, prefix) {
  const out = [];
  for (let i = 0; out.length < count && i < 5000; i++) {
    const n = `${prefix}${i}`;
    if (frontierRoleFor(n) === role) out.push(n);
  }
  return out;
}

const T0 = 1788470400000; // fixed local-time-ish base, no UTC dependence

// --- frontierRoleFor ---
check("frontierRoleFor is stable and returns a frontier role", () => {
  const a = frontierRoleFor("Bran");
  assert.ok(FRONTIER_ROLES.includes(a));
  assert.strictEqual(frontierRoleFor("Bran"), a);
  assert.strictEqual(frontierRoleFor("bran"), frontierRoleFor("Bran")); // hashName lowercases
});

check("all four frontier roles appear across a sample of citizens", () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(frontierRoleFor(`Citizen${i}`));
  assert.deepStrictEqual([...seen].sort(), [...FRONTIER_ROLES].sort());
});

// --- settlementNameFor ---
check("settlementNameFor builds 'Founder's Place' from a discovery", () => {
  assert.strictEqual(settlementNameFor("a hidden grove", "Bran"), "Bran's Grove");
  assert.strictEqual(settlementNameFor("a crater lake", "Sera"), "Sera's Lake");
  assert.strictEqual(settlementNameFor("", "Bran"), "Bran's Frontier");
});

// --- nextStage ---
check("nextStage grows camp -> hamlet -> village and caps", () => {
  assert.strictEqual(nextStage("camp"), "hamlet");
  assert.strictEqual(nextStage("hamlet"), "village");
  assert.strictEqual(nextStage("village"), "village");
  assert.strictEqual(nextStage("bogus"), "camp");
  assert.deepStrictEqual(SETTLEMENT_STAGES, ["camp", "hamlet", "village"]);
});

// --- priceForSketch: fixed 50-coin abstraction (hash-derived pricing removed 2026-10-08) ---
check("priceForSketch is fixed and within the coin range", () => {
  const p = priceForSketch("42:0");
  assert.ok(p >= 25 && p <= 75, `price ${p} out of range`);
  assert.strictEqual(priceForSketch("42:0"), p);
  assert.strictEqual(priceForSketch("99:9"), 50, "fixed abstraction price");
});

// --- discoveryKey / shouldFoundSettlement ---
check("discoveryKey is expId:idx and shouldFoundSettlement gates on rng", () => {
  assert.strictEqual(discoveryKey(7, 2), "7:2");
  assert.strictEqual(shouldFoundSettlement(() => 0), true);
  assert.strictEqual(shouldFoundSettlement(() => 0.999), false);
});

// --- reconReport / fieldNoteLine ---
check("reconReport names the region", () => {
  const line = reconReport("the deep forest", lcg(3));
  assert.ok(line.includes("the deep forest"), line);
});

check("fieldNoteLine names the creature and an observation", () => {
  const line = fieldNoteLine("an albino basilisk", lcg(5));
  assert.ok(line.includes("an albino basilisk"), line);
  assert.ok(line.length > 20, line);
});

// --- formSettlement ---
check("formSettlement builds a camp-stage settlement", () => {
  const s = formSettlement({ founder: "Bran", kingdomId: "misthalin", discovery: { name: "a misty valley" }, at: T0 });
  assert.strictEqual(s.name, "Bran's Valley");
  assert.strictEqual(s.site, "a misty valley");
  assert.strictEqual(s.stage, "camp");
  assert.strictEqual(s.founder, "Bran");
  assert.strictEqual(s.kingdomId, "misthalin");
});

// --- isRealPlayer / withinTiles (template gates) ---
check("isRealPlayer and withinTiles gates hold", () => {
  assert.strictEqual(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
  assert.strictEqual(isRealPlayer({ getUsername: () => "Jon" }), true);
  assert.strictEqual(withinTiles(fakeAt(0, 0), fakeAt(12, 0), 12), true);
  assert.strictEqual(withinTiles(fakeAt(0, 0), fakeAt(13, 0), 12), false);
  assert.ok(pickOne(() => 0, ["a", "b"]) === "a");
});

// --- fundExpedition validation ---
check("fundExpedition rejects unknown expeditions and bad amounts", () => {
  assert.strictEqual(fundExpedition("Jon", 999999, 500, T0), false);
  assert.strictEqual(fundExpedition("", 1, 500, T0), false);
  assert.strictEqual(fundExpedition("Jon", 1, 50, T0), false); // below minimum
  assert.strictEqual(fundExpedition("Jon", 1, 200000, T0), false); // above maximum
  assert.strictEqual(fundExpedition("Jon", 1, "lots", T0), false); // not a number
  assert.strictEqual(fundingBonusFor(1), 0);
});

// --- buyMap validation ---
check("buyMap rejects unknown maps and records nothing", () => {
  const r = buyMap("Jon", "nope:0", T0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-such-map");
  assert.deepStrictEqual(purchasesFor("Jon", T0), []);
  assert.deepStrictEqual(mapsForSale(), []);
});

// --- Full integration: muster -> fund -> resolve -> sketch -> buy ---
function runExpeditionCycle() {
  // Two kingdoms, each with 2+ explorers and frontier role holders.
  const expA = findExplorers(2, "ExpA");
  const expB = findExplorers(2, "ExpB");
  const roles = ["scout", "pioneer", "cartographer", "naturalist"].flatMap((r) =>
    findRole(r, 1, `Role${r}`)
  );
  const [scoutN, pioneerN, cartoN, natN] = roles;
  const roster = new Map();
  for (const n of expA) roster.set(n, { username: n, kingdomId: "misthalin" });
  for (const n of expB) roster.set(n, { username: n, kingdomId: "asgarnia" });
  roster.set(scoutN, { username: scoutN, kingdomId: "misthalin" });
  roster.set(pioneerN, { username: pioneerN, kingdomId: "misthalin" });
  roster.set(cartoN, { username: cartoN, kingdomId: "asgarnia" });
  roster.set(natN, { username: natN, kingdomId: "asgarnia" });
  const director = { roster, getBot: () => null, onlinePlayers: () => [] };

  tickExplorers(director, T0); // muster phase
  const mustering = musteringExpeditions();
  assert.strictEqual(mustering.length, 2);

  // Consume-on-read bonus, checked on the second expedition.
  const probe = mustering[1];
  assert.strictEqual(fundExpedition("Jon", probe.id, 500, T0), true);
  assert.strictEqual(fundExpedition("Jon", probe.id, 500, T0), false); // one sponsor only
  assert.strictEqual(fundingBonusFor(probe.id), 1); // consume-on-read
  assert.strictEqual(fundingBonusFor(probe.id), 0);

  // The first expedition carries the resolve-time bonus assertion.
  const funded = mustering[0];
  assert.strictEqual(fundExpedition("Jon", funded.id, 500, T0), true);

  const tMid = T0 + 45 * 60 * 1000 + 1000; // muster -> journey
  tickExplorers(director, tMid);
  const tDone = T0 + 45 * 60 * 1000 + 4 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000 + 60000; // journey -> done
  tickExplorers(director, tDone);

  const done = finishedExpeditions(tDone);
  assert.strictEqual(done.length, 2);
  const fundedDone = done.find((e) => e.id === funded.id);
  const expectedBase = journeyOutcome(agentRng(`expedition:${funded.id}:return:${tDone >> 16}`)).discoveryCount;
  assert.strictEqual(fundedDone.discoveries.length, expectedBase + 1); // sponsor bonus applied
  assert.strictEqual(fundingBonusFor(funded.id), 0); // consumed by resolve

  // Frontier layer processes the finished expeditions.
  tickExplorers2(director, tDone);

  const forSale = mapsForSale();
  assert.ok(forSale.length >= 1, "expected sketch maps for sale");
  for (const m of forSale) {
    assert.ok(m.key && m.discovery && m.sketchedBy, JSON.stringify(m));
    assert.ok(m.price >= 25 && m.price <= 75, `price ${m.price}`);
  }

  const key = forSale[0].key;
  const bought = buyMap("Jon", key, tDone);
  assert.strictEqual(bought.ok, true);
  assert.strictEqual(bought.map.key, key);
  assert.strictEqual(buyMap("Jon", key, tDone).ok, false); // already owned
  assert.strictEqual(purchasesFor("Jon", tDone).length, 1);
  assert.strictEqual(purchasesFor("Jon", tDone)[0].discovery, forSale[0].discovery);

  const funds = fundedExpeditions();
  assert.strictEqual(funds.length, 2);
  for (const f of funds) {
    assert.strictEqual(f.sponsor, "Jon");
    assert.strictEqual(f.thanked, true);
  }

  // Settlements: at most one per expedition, well-formed if any.
  const settlements = listSettlements();
  assert.ok(settlements.length <= 2, `too many: ${settlements.length}`);
  for (const s of settlements) {
    assert.ok(SETTLEMENT_STAGES.includes(s.stage));
    assert.ok(s.name.includes("'s "), s.name);
  }
  return { director, tDone };
}

check("full cycle: fund -> resolve bonus -> sketch -> buy map", () => {
  runExpeditionCycle();
});

// --- tick safety ---
check("tickExplorers2 with an empty roster does nothing and does not throw", () => {
  tickExplorers2({ roster: new Map(), getBot: () => null }, T0);
  assert.deepStrictEqual(mapsForSale(), []);
  assert.deepStrictEqual(listSettlements(), []);
});

check("resetForTests clears funding, sketches, purchases and settlements", () => {
  const { tDone } = runExpeditionCycle();
  assert.ok(mapsForSale().length > 0);
  resetForTests();
  assert.deepStrictEqual(mapsForSale(), []);
  assert.deepStrictEqual(listSettlements(), []);
  assert.deepStrictEqual(purchasesFor("Jon", tDone), []);
  assert.deepStrictEqual(fundedExpeditions(), []);
});

console.log(`\n${passed} assertions passed`);
