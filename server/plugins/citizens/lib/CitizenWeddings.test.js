"use strict";
// CitizenWeddings unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  anniversariesDue,
  milestoneName,
  proposalChance,
  coldFeetChance,
  eligibleAdmirer,
  isRealPlayer,
  withinTiles,
  pickOne,
} = require("./CitizenWeddings");

const YEAR_MS = 365 * 24 * 3600 * 1000;
const now = 1_800_000_000_000;

// Deterministic LCG for coverage.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- anniversariesDue ---
{
  const married = { stage: "married", updatedAt: now - 2 * YEAR_MS - 1000, data: {} };
  assert.equal(anniversariesDue(married, now), 2, "two years married, none celebrated -> 2 due");

  const oneCelebrated = { stage: "married", updatedAt: now - 2 * YEAR_MS - 1000, data: { anniversaries: 1 } };
  assert.equal(anniversariesDue(oneCelebrated, now), 1, "one celebrated -> 1 due");

  const fresh = { stage: "married", updatedAt: now - 1000, data: {} };
  assert.equal(anniversariesDue(fresh, now), 0, "just married -> none due");

  const courting = { stage: "courting", updatedAt: now - 5 * YEAR_MS, data: {} };
  assert.equal(anniversariesDue(courting, now), 0, "not married -> none due");

  const future = { stage: "married", updatedAt: now + YEAR_MS, data: {} };
  assert.equal(anniversariesDue(future, now), 0, "wedding in the future -> none due");

  assert.equal(anniversariesDue(null, now), 0, "null bond -> 0");
}

// --- milestoneName ---
{
  assert.equal(milestoneName(1), "1st");
  assert.equal(milestoneName(2), "2nd");
  assert.equal(milestoneName(3), "3rd");
  assert.equal(milestoneName(5), "5th");
  assert.equal(milestoneName(10), "10th (tin)");
  assert.equal(milestoneName(25), "25th (silver)");
  assert.equal(milestoneName(50), "50th (gold)");
}

// --- proposalChance ---
{
  const romantic = proposalChance(["devout", "cheerful"], ["chatty"]);
  const shy = proposalChance(["taciturn", "gruff"], ["suspicious"]);
  const plain = proposalChance([], []);
  assert.ok(romantic > plain, "romantic traits raise proposal chance");
  assert.ok(shy < plain, "shy/gruff traits lower proposal chance");
  assert.ok(romantic <= 0.95 && shy >= 0.05, "clamped to [0.05, 0.95]");
  assert.ok(Math.abs(proposalChance(["cheerful"], []) - proposalChance([], ["cheerful"])) < 1e-9, "symmetric across partners");
}

// --- coldFeetChance ---
{
  const nervous = coldFeetChance(["nervous", "timid"], []);
  const bold = coldFeetChance(["bold", "confident"], []);
  const plain = coldFeetChance([], []);
  assert.ok(nervous > plain, "nervous traits raise cold-feet chance");
  assert.ok(bold < plain, "bold traits lower cold-feet chance");
  assert.ok(nervous <= 0.2, "capped at 0.2");
}

// --- eligibleAdmirer ---
{
  const k = { hasRomance: (n) => n === "taken_single" };
  const mkRec = (username, kingdomId) => ({ username, kingdomId });
  const bond = { kingdomId: "asgarnia" };
  const ctx = { bond, hasRomance: k.hasRomance };

  assert.equal(eligibleAdmirer(mkRec("ann", "asgarnia"), "x", "bob", "cat", ctx), true, "single same-kingdom citizen eligible");
  assert.equal(eligibleAdmirer(mkRec("bob", "asgarnia"), "x", "bob", "cat", ctx), false, "partner a not eligible");
  assert.equal(eligibleAdmirer(mkRec("cat", "asgarnia"), "x", "bob", "cat", ctx), false, "partner b not eligible");
  assert.equal(eligibleAdmirer(mkRec("ann", "misthalin"), "x", "bob", "cat", ctx), false, "different kingdom not eligible");
  assert.equal(eligibleAdmirer(mkRec("taken_single", "asgarnia"), "x", "bob", "cat", ctx), false, "already in romance not eligible");
  assert.equal(eligibleAdmirer(null, "x", "bob", "cat", ctx), false, "null record not eligible");
}

// --- isRealPlayer / withinTiles / pickOne ---
{
  const bot = { isPlayerBot: () => true, getUsername: () => "bot1" };
  const human = { getUsername: () => "Jon", getHostAddress: () => "1.2.3.4" };
  assert.equal(isRealPlayer(bot), false, "bot is not a real player");
  assert.equal(isRealPlayer(human), true, "human is a real player");
  assert.equal(isRealPlayer(null), false, "null is not a player");

  const mkEnt = (x, y, z = 0) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(withinTiles(mkEnt(0, 0), mkEnt(10, 10), 14), true, "diagonal within radius");
  assert.equal(withinTiles(mkEnt(0, 0), mkEnt(15, 0), 14), false, "outside radius");
  assert.equal(withinTiles(mkEnt(0, 0, 1), mkEnt(0, 0, 0), 14), false, "different plane");

  const rng = lcg(42);
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(pickOne(rng, ["a", "b", "c"]));
  assert.ok(seen.size > 1, "pickOne varies with rng");
  assert.equal(pickOne(() => 0, ["a", "b"]), "a", "rng 0 picks first");
}

console.log("CitizenWeddings: all assertions passed.");
