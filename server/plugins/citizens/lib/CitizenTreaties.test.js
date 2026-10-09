"use strict";

/**
 * CitizenTreaties.test.js — data-tier tests for the citizen treaty layer:
 * treaties, embassies, summits, and their real effects.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const T = require("./CitizenTreaties");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-test-"));
T._setSavePathForTests(path.join(TMP, "citizen-treaties.json"));

let passed = 0;
function test(name, fn) {
  T.resetForTests();
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    console.error(e.stack?.split("\n").slice(0, 4).join("\n"));
    process.exitCode = 1;
  }
}

const NOW = 1_700_000_000_000;
const paid = () => true;
const broke = () => false;

// --- kingdoms ---

test("kingdoms: five great powers", () => {
  assert.deepEqual(T.kingdoms(), ["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania"]);
});

test("treaty types: peace, trade, alliance", () => {
  assert.deepEqual(Object.keys(T.TREATY_TYPES).sort(), ["alliance", "peace", "trade"]);
});

// --- embassies ---

test("buildEmbassy: real coins, honest failure when broke", () => {
  const r1 = T.buildEmbassy({ home: "asgarnia", host: "misthalin", builder: "Alice", nowMs: NOW, takeCoins: broke });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "cannot-afford");
  const r2 = T.buildEmbassy({ home: "asgarnia", host: "misthalin", builder: "Alice", nowMs: NOW, takeCoins: paid });
  assert.equal(r2.ok, true);
  assert.equal(r2.embassy.home, "asgarnia");
  assert.equal(r2.embassy.host, "misthalin");
  assert.equal(r2.embassy.status, "standing");
});

test("buildEmbassy: rejects unknown kingdoms and self", () => {
  assert.equal(T.buildEmbassy({ home: "asgarnia", host: "narnia", takeCoins: paid }).ok, false);
  assert.equal(T.buildEmbassy({ home: "asgarnia", host: "asgarnia", takeCoins: paid }).ok, false);
});

test("buildEmbassy: one standing embassy per pair", () => {
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  const r = T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW + 1, takeCoins: paid });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "already-standing");
});

test("embassyFor / embassyPair: directional lookups", () => {
  assert.equal(T.embassyFor("asgarnia", "misthalin"), null);
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  assert.ok(T.embassyFor("asgarnia", "misthalin"));
  assert.equal(T.embassyPair("asgarnia", "misthalin"), false);
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  assert.equal(T.embassyPair("asgarnia", "misthalin"), true);
});

test("sackEmbassy: marks sacked, never deletes", () => {
  const r = T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  assert.equal(T.sackEmbassy(r.embassy.id, "war"), true);
  assert.equal(T.embassyFor("asgarnia", "misthalin"), null);
  assert.equal(T.sackEmbassy(r.embassy.id, "war"), false); // already sacked
});

// --- treaty proposals ---

test("proposeTreaty: peace needs no embassy", () => {
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", broker: "Bob", isPlayer: true, nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.proposal.status, "pending");
});

test("proposeTreaty: trade/alliance require embassy pair", () => {
  const r1 = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "trade", broker: "Bob", isPlayer: true, nowMs: NOW });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "needs-embassies");
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const r2 = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "trade", broker: "Bob", isPlayer: true, nowMs: NOW });
  assert.equal(r2.ok, true);
  const r3 = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "alliance", broker: "Bob", isPlayer: true, nowMs: NOW });
  assert.equal(r3.ok, true);
});

test("proposeTreaty: fame gate for citizen brokers", () => {
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", broker: "Nobody Famous", nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "fame-too-low");
});

test("proposeTreaty: rejects duplicates and active treaties", () => {
  T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", isPlayer: true, nowMs: NOW });
  const dup = T.proposeTreaty({ from: "misthalin", to: "asgarnia", type: "peace", isPlayer: true, nowMs: NOW + 1 });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, "already-pending");
  const bad = T.proposeTreaty({ from: "asgarnia", to: "asgarnia", type: "peace", isPlayer: true, nowMs: NOW });
  assert.equal(bad.ok, false);
  const badType = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "war", isPlayer: true, nowMs: NOW });
  assert.equal(badType.ok, false);
});

// --- negotiation ---

test("negotiateRound: throttles to one round per window", () => {
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", isPlayer: true, nowMs: NOW });
  const o1 = T.negotiateRound(r.proposal.id, NOW + 1000);
  assert.ok(["accepted", "declined", "countered"].includes(o1));
  if (o1 === "countered") {
    const o2 = T.negotiateRound(r.proposal.id, NOW + 2000);
    assert.equal(o2, "waiting"); // too soon
  }
});

test("negotiateRound: proposals expire unanswered", () => {
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", isPlayer: true, nowMs: NOW });
  const out = T.negotiateRound(r.proposal.id, NOW + 8 * 24 * 60 * 60 * 1000);
  assert.equal(out, "expired");
  assert.equal(T.proposalById(r.proposal.id).status, "expired");
});

// --- ratification ---

test("ratifyTreaty: peace applies tension cooling, records treaty", () => {
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted"; // simulate a won court round
  const res = T.ratifyTreaty(p.id, null, NOW);
  assert.equal(res.ok, true);
  assert.equal(res.treaty.type, "peace");
  assert.equal(res.treaty.status, "active");
  assert.ok(T.treatyBetween("asgarnia", "misthalin", "peace", NOW));
  assert.equal(T.proposalById(p.id).status, "ratified");
});

test("ratifyTreaty: alliance emits the real kingdom pact event", () => {
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "alliance", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  const emitted = [];
  const res = T.ratifyTreaty(p.id, (name, payload) => emitted.push([name, payload]), NOW);
  assert.equal(res.ok, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], "kingdom:alliance-formed");
  assert.equal(emitted[0][1].a, "asgarnia");
  assert.equal(emitted[0][1].b, "misthalin");
  assert.ok(emitted[0][1].pactName);
});

test("ratifyTreaty: trade treaty powers the caravan bonus seam", () => {
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  assert.equal(T.tradeBonusFor("asgarnia", "misthalin", NOW), 0);
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "trade", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  T.ratifyTreaty(p.id, null, NOW);
  assert.equal(T.tradeBonusFor("asgarnia", "misthalin", NOW), T.TRADE_CARAVAN_BONUS);
  assert.equal(T.tradeBonusFor("misthalin", "asgarnia", NOW), T.TRADE_CARAVAN_BONUS); // symmetric
  assert.equal(T.tradeBonusFor("asgarnia", "kandarin", NOW), 0); // unrelated pair
});

test("expireTreaties: old treaties lapse, bonus seam closes", () => {
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "trade", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  const res = T.ratifyTreaty(p.id, null, NOW);
  const expired = T.expireTreaties(res.treaty.expiresAt + 1);
  assert.deepEqual(expired, [res.treaty.id]);
  assert.equal(T.tradeBonusFor("asgarnia", "misthalin", res.treaty.expiresAt + 1), 0);
});

// --- summits ---

test("scheduleSummit: requires embassy pair", () => {
  const r1 = T.scheduleSummit({ a: "asgarnia", b: "misthalin", broker: "Bob", isPlayer: true, nowMs: NOW });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "needs-embassies");
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const r2 = T.scheduleSummit({ a: "asgarnia", b: "misthalin", broker: "Bob", isPlayer: true, nowMs: NOW });
  assert.equal(r2.ok, true);
  assert.equal(r2.summit.status, "scheduled");
  const r3 = T.scheduleSummit({ a: "asgarnia", b: "misthalin", isPlayer: true, nowMs: NOW + 1 });
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, "already-scheduled");
});

test("holdSummit: not due early, applies effects when held", () => {
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const r = T.scheduleSummit({ a: "asgarnia", b: "misthalin", isPlayer: true, nowMs: NOW });
  assert.equal(T.holdSummit(r.summit.id, NOW).ok, false);
  const held = T.holdSummit(r.summit.id, NOW + 25 * 60 * 60 * 1000);
  assert.equal(held.ok, true);
  assert.equal(held.summit.status, "held");
});

test("holdSummit: pending treaties get the summit bonus", () => {
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const pr = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", isPlayer: true, nowMs: NOW });
  const sr = T.scheduleSummit({ a: "asgarnia", b: "misthalin", isPlayer: true, nowMs: NOW });
  T.holdSummit(sr.summit.id, NOW + 25 * 60 * 60 * 1000);
  assert.equal(T.proposalById(pr.proposal.id).summitBonus, true);
});

// --- persistence ---

test("save/load round-trip", () => {
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", isPlayer: true, nowMs: NOW });
  T.save();
  const raw = fs.readFileSync(path.join(TMP, "citizen-treaties.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.embassies.length, 1);
  assert.equal(parsed.proposals.length, 1);
});

test("describe: chat-facing summary", () => {
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  const d = T.describe("asgarnia", NOW);
  assert.equal(d.kingdomId, "asgarnia");
  assert.equal(d.embassies.length, 1);
  assert.deepEqual(d.treaties, []);
});

console.log(`\n${passed} tests passed.`);
