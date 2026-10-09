"use strict";

/**
 * CitizenTradeGuilds.test.js — plain-node tests for the merchants' association
 * data tier. No jest, no engine: proof injection keeps trader-status checks
 * honest without a live server.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const G = require("./CitizenTradeGuilds");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tradeguild-")), "save.json");
G._setSavePathForTests(tmpSave);

function reset() {
  G.resetForTests();
}

const PROOF_TRADER = { guildMember: true, traderCareer: false, stallholder: false, caravanTrader: false };
const PROOF_NONE = { guildMember: false, traderCareer: false, stallholder: false, caravanTrader: false };
const KID = "test-kingdom";

// --- membership ---
reset();
{
  const r = G.joinGuild(KID, "Alice", PROOF_NONE);
  assert.strictEqual(r.ok, false, "join without trader proof must fail");
  assert.strictEqual(r.reason, "not-a-trader");
}
console.log("ok - join requires real trader proof");

reset();
{
  const r = G.joinGuild(KID, "Alice", PROOF_TRADER);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rank, "peddler");
  assert.strictEqual(G.isGuildMember("Alice"), true);
  assert.strictEqual(G.guildRankOf("ALICE"), "peddler", "rank lookup is case-insensitive");
  const dup = G.joinGuild(KID, "Alice", PROOF_TRADER);
  assert.strictEqual(dup.ok, false, "double join rejected");
}
console.log("ok - join/leave/membership");

reset();
{
  G.joinGuild(KID, "Bob", { stallholder: true });
  const lv = G.leaveGuild("Bob");
  assert.strictEqual(lv.ok, true);
  assert.strictEqual(G.isGuildMember("Bob"), false);
}
console.log("ok - stallholder proof path works");

// --- dues ---
reset();
{
  const now = Date.now();
  G.joinGuild(KID, "Cara", PROOF_TRADER, now);
  const t0 = G.guildTreasuryFor(KID);
  const f0 = G.fairFundFor(KID);
  const pay = G.recordDuesPayment("Cara", now + 8 * 24 * 60 * 60 * 1000);
  assert.strictEqual(pay.ok, true);
  assert.strictEqual(G.guildTreasuryFor(KID), t0 + (G.DUES_WEEKLY - 5));
  assert.strictEqual(G.fairFundFor(KID), f0 + 5, "fair share feeds the fair fund");
  const m1 = G.recordMissedDues("Cara", now);
  assert.strictEqual(m1.suspended, false, "one miss does not suspend");
  const m2 = G.recordMissedDues("Cara", now);
  assert.strictEqual(m2.suspended, true, "two misses suspend");
}
console.log("ok - dues, fair share, suspension");

// --- licenses ---
reset();
{
  const now = Date.now();
  const no = G.licenseFor("Dan", now);
  assert.strictEqual(no.valid, false);
  const b = G.buyLicense(KID, "Dan", now);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(G.licenseFor("Dan", now).valid, true);
  assert.strictEqual(G.licenseFor("Dan", now + G.LICENSE_MS + 1).valid, false, "license expires");
  assert.strictEqual(G.guildTreasuryFor(KID), G.LICENSE_FEE, "fee credited honestly");
}
console.log("ok - market licenses");

// --- inspections (pure) ---
{
  const wares = [
    { id: 1, price: 100 },
    { id: 2, price: 1000 },
    { id: 3, price: 5 },
  ];
  const priceFor = (id) => ({ 1: 100, 2: 100, 3: 10 }[id] || 1);
  const res = G.inspectWares(wares, priceFor);
  assert.strictEqual(res.pass, false);
  assert.strictEqual(res.violations.length, 1, "only the 10x ware violates");
  assert.strictEqual(res.violations[0].id, 2);
  assert.strictEqual(res.violations[0].ratio, 10);
  const clean = G.inspectWares([{ id: 1, price: 250 }], priceFor);
  assert.strictEqual(clean.pass, true, "2.5x is within the 3x bar");
  const edge = G.inspectWares([{ id: 1, price: 300 }], priceFor);
  assert.strictEqual(edge.pass, true, "exactly 3x is not a violation");
  const over = G.inspectWares([{ id: 1, price: 301 }], priceFor);
  assert.strictEqual(over.pass, false, "just over 3x violates");
  const empty = G.inspectWares([], priceFor);
  assert.strictEqual(empty.pass, true);
  const junk = G.inspectWares([{ id: 0, price: -5 }], priceFor);
  assert.strictEqual(junk.checked, 1, "checked counts entries");
  assert.strictEqual(junk.pass, true, "invalid entries skipped");
}
console.log("ok - inspectWares pure logic");

reset();
{
  const now = Date.now();
  G.joinGuild(KID, "Eve", PROOF_TRADER, now);
  G.joinGuild(KID, "Frank", PROOF_TRADER, now);
  // promote Frank to master manually for the test
  const g = G.ensureGuild(KID);
  g.members["frank"].rank = G.RANK_MASTER;
  const res = G.inspectWares([{ id: 7, price: 400 }], () => 100);
  const rec = G.recordInspection(KID, "Frank", "Eve", res, now);
  assert.strictEqual(rec.pass, false);
  assert.strictEqual(g.members["frank"].inspectionsConducted, 1);
  const hist = G.inspectionsFor("Eve");
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].inspector, "frank");
}
console.log("ok - recordInspection + history");

// --- caravan certification ---
reset();
{
  const now = Date.now();
  G.joinGuild(KID, "Gus", PROOF_TRADER, now);
  const before = G.certifiedBonusFor({ leader: "Gus" }, now);
  assert.strictEqual(before, 0, "no bonus without certification");
  const c = G.certifyManifest(KID, "Gus", now);
  assert.strictEqual(c.ok, true);
  const after = G.certifiedBonusFor({ leader: "Gus" }, now);
  assert.strictEqual(after, G.CERT_BONUS);
  const expired = G.certifiedBonusFor({ leader: "Gus" }, now + G.CERT_MS + 1);
  assert.strictEqual(expired, 0, "certification expires");
  assert.strictEqual(G.certifiedBonusFor(null, now), 0, "null caravan safe");
  assert.strictEqual(G.certifiedBonusFor({ leader: "Nobody" }, now), 0);
  // suspended members lose the bonus
  G.recordMissedDues("Gus", now);
  G.recordMissedDues("Gus", now);
  assert.strictEqual(G.certifiedBonusFor({ leader: "Gus" }, now), 0, "suspended = no bonus");
}
console.log("ok - manifest certification + bonus");

// --- tribunal ---
reset();
{
  const now = Date.now();
  G.joinGuild(KID, "Hank", PROOF_TRADER, now);
  G.joinGuild(KID, "Ivy", PROOF_TRADER, now);
  G.ensureGuild(KID).members["ivy"].rank = G.RANK_MASTER;
  // unlicensed report without evidence fails
  const bad = G.reportMisconduct(KID, "Hank", G.CASE_UNLICENSED, "Ivy", {});
  assert.strictEqual(bad.ok, false);
  // with stall evidence it opens
  const rep = G.reportMisconduct(KID, "Hank", G.CASE_UNLICENSED, "Ivy", { stallActive: true });
  assert.strictEqual(rep.ok, true);
  const dup = G.reportMisconduct(KID, "Hank", G.CASE_UNLICENSED, "Ivy", { stallActive: true });
  assert.strictEqual(dup.ok, false, "no double jeopardy");
  assert.strictEqual(G.openCases(KID).length, 1);
  // non-master cannot vote
  const nv = G.voteOnCase(KID, rep.caseId, "Hank", true);
  assert.strictEqual(nv.ok, false);
  const v = G.voteOnCase(KID, rep.caseId, "Ivy", true);
  assert.strictEqual(v.ok, true);
  // not ripe yet
  assert.strictEqual(G.settleRipeCases(KID, now).length, 0);
  const settled = G.settleRipeCases(KID, now + 25 * 60 * 60 * 1000);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].guilty, true);
  const m = G.memberOf("Hank");
  assert.strictEqual(m.suspended, true, "unlicensed conviction suspends");
  assert.ok((m.finesOwed || 0) >= 100, "fine recorded honestly");
}
console.log("ok - tribunal unlicensed flow");

reset();
{
  const now = Date.now();
  G.joinGuild(KID, "Jake", PROOF_TRADER, now);
  G.joinGuild(KID, "Kim", PROOF_TRADER, now);
  G.ensureGuild(KID).members["kim"].rank = G.RANK_MASTER;
  // gouging needs a real failed inspection
  const noev = G.reportMisconduct(KID, "Jake", G.CASE_GOUGING, "Kim", {});
  assert.strictEqual(noev.ok, false, "gouging needs evidence");
  G.recordInspection(KID, "Kim", "Jake", G.inspectWares([{ id: 9, price: 500 }], () => 100), now);
  const rep = G.reportMisconduct(KID, "Jake", G.CASE_GOUGING, "Kim", {});
  assert.strictEqual(rep.ok, true);
  G.voteOnCase(KID, rep.caseId, "Kim", false); // acquit vote
  const settled = G.settleRipeCases(KID, now + 25 * 60 * 60 * 1000);
  assert.strictEqual(settled[0].guilty, false, "single innocent vote acquits (no majority)");
  assert.strictEqual(G.isGuildMember("Jake"), true, "acquitted member stays");
}
console.log("ok - tribunal gouging flow + acquittal");

// --- fairs ---
reset();
{
  const now = Date.now();
  G.joinGuild(KID, "Liam", PROOF_TRADER, now);
  G.joinGuild(KID, "Mia", PROOF_TRADER, now);
  G.ensureGuild(KID).members["mia"].rank = G.RANK_MASTER;
  assert.strictEqual(G.fairDue(KID, now), true, "first fair is due");
  const e1 = G.enterFair(KID, "Liam");
  assert.strictEqual(e1.ok, true);
  assert.strictEqual(G.fairFundFor(KID), G.FAIR_ENTRY_FEE);
  // Liam: licensed + passing inspection, fairest prices
  G.buyLicense(KID, "Liam", now);
  G.recordInspection(KID, "Mia", "Liam", G.inspectWares([{ id: 1, price: 110 }], () => 100), now);
  // No license for nobody-else; resolve with no eligible winner if Liam absent
  const r = G.resolveFair(KID, null, now);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.winner, "liam");
  // fund holds one 50-coin entry: honest partial payout, rest owed
  assert.strictEqual(r.prizePaid, G.FAIR_ENTRY_FEE);
  assert.strictEqual(r.prizePaid + r.prizeOwed, G.FAIR_PRIZE);
  assert.strictEqual(G.fairDue(KID, now), false, "fair clock reset");
}
console.log("ok - trade fair entry + resolution");

reset();
{
  const now = Date.now();
  G.joinGuild(KID, "Nora", PROOF_TRADER, now);
  G.enterFair(KID, "Nora"); // entry fee in, but Nora unlicensed
  const r = G.resolveFair(KID, null, now);
  assert.strictEqual(r.winner, null, "unlicensed entrant cannot win");
  assert.strictEqual(r.reason, "no-eligible-stall");
}
console.log("ok - fair with no eligible winner");

// --- school / promotion ---
reset();
{
  const now = Date.now();
  G.joinGuild(KID, "Owen", PROOF_TRADER, now - 40 * 24 * 60 * 60 * 1000);
  G.joinGuild(KID, "Pam", PROOF_TRADER, now);
  G.ensureGuild(KID).members["pam"].rank = G.RANK_MASTER;
  const cls = G.holdClass(KID, "Pam");
  assert.strictEqual(cls.ok, true);
  assert.strictEqual(cls.taught, 1, "only peddlers taught");
  G.holdClass(KID, "Pam");
  const p = G.tryPromote("Owen", now);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.rank, "trader");
  const early = G.tryPromote("Pam", now);
  assert.strictEqual(early.ok, false, "master cannot promote further");
}
console.log("ok - school + promotion");

// --- persistence round-trip (own fresh save file: true process-reload sim) ---
{
  const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tradeguild-")), "save.json");
  G._setSavePathForTests(fresh);
  G.resetForTests();
  const now = Date.now();
  G.joinGuild(KID, "Quinn", PROOF_TRADER, now);
  G.buyLicense(KID, "Quinn", now);
  assert.strictEqual(G.save(), true, "dirty save writes");
  G.resetForTests(); // drop memory only — disk keeps Quinn
  assert.strictEqual(G.isGuildMember("Quinn"), true, "member survives reload");
  assert.strictEqual(G.licenseFor("Quinn", now).valid, true, "license survives reload");
  G._setSavePathForTests(tmpSave);
  G.resetForTests();
}
console.log("ok - persistence round-trip");

// --- describe ---
reset();
{
  G.joinGuild(KID, "Rita", PROOF_TRADER);
  const d = G.describe(KID);
  assert.strictEqual(d.members, 1);
  assert.strictEqual(typeof d.treasury, "number");
  assert.strictEqual(G.describe("nope"), null);
}
console.log("ok - describe");

console.log("\nAll CitizenTradeGuilds tests passed.");
