"use strict";

/**
 * CitizenMusicFestivals.test.js — plain-node tests for the music-festival
 * production data tier. No jest, no engine.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MF = require("./CitizenMusicFestivals");

function freshState() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mf-test-"));
  const savePath = path.join(tmp, "citizen-music-festivals.json");
  MF._setSavePathForTests(savePath);
  MF.resetForTests();
  return { tmp, savePath };
}

function okTake(amount) {
  let taken = 0;
  return {
    fn: (n) => { if (n <= amount - taken) { taken += n; return { ok: true }; } return { ok: false }; },
    taken: () => taken,
  };
}

function run() {
  let passed = 0;
  const t = (name, fn) => { fn(); passed++; console.log("  ok:", name); };

  // --- promoters ---
  t("registerPromoter is idempotent", () => {
    freshState();
    const a = MF.registerPromoter("Alice", "varrock");
    const b = MF.registerPromoter("alice", "varrock");
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(a.promoter.username, "Alice");
  });

  t("registerPromoter rejects empty username", () => {
    freshState();
    assert.strictEqual(MF.registerPromoter("", "varrock").ok, false);
  });

  t("isPromoter reflects registration", () => {
    freshState();
    assert.strictEqual(MF.isPromoter("Bob"), false);
    MF.registerPromoter("Bob", "falador");
    assert.strictEqual(MF.isPromoter("bob"), true);
  });

  // --- companies ---
  t("foundCompany requires promoter", () => {
    freshState();
    assert.strictEqual(MF.foundCompany("Nobody", "Big Sounds").ok, false);
    MF.registerPromoter("Cara", "varrock");
    const r = MF.foundCompany("Cara", "Big Sounds");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.company.founder, "Cara");
  });

  t("foundCompany rejects duplicate names", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    assert.strictEqual(MF.foundCompany("Cara", "big sounds").ok, false);
  });

  t("treasury credit/debit are honest", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    assert.strictEqual(MF.creditTreasury("Big Sounds", 1000).treasury, 1000);
    assert.strictEqual(MF.debitTreasury("Big Sounds", 400).treasury, 600);
    const broke = MF.debitTreasury("Big Sounds", 9999);
    assert.strictEqual(broke.ok, false);
    assert.strictEqual(broke.reason, "insufficient-funds");
    assert.strictEqual(MF.companyTreasury("Big Sounds"), 600);
  });

  t("joinCompany adds members idempotently", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.joinCompany("Dave", "Big Sounds");
    MF.joinCompany("Dave", "Big Sounds");
    assert.deepStrictEqual(MF.companyFor("Big Sounds").members, ["Cara", "Dave"]);
  });

  // --- grounds ---
  t("ensureGround creates deterministic grounds", () => {
    freshState();
    const g = MF.ensureGround("varrock");
    assert.strictEqual(g.kingdomId, "varrock");
    assert.strictEqual(g.capacity, 200);
    assert.strictEqual(g.owner, "crown");
    const g2 = MF.ensureGround("varrock");
    assert.strictEqual(g, g2);
  });

  t("renovateGround improves condition with real cost", () => {
    freshState();
    const g = MF.ensureGround("varrock");
    g.condition = 50;
    const take = okTake(1000);
    const r = MF.renovateGround("varrock", 10, take.fn);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.condition, 60);
    assert.strictEqual(take.taken(), 100);
  });

  t("renovateGround fails honestly when broke", () => {
    freshState();
    const g = MF.ensureGround("varrock");
    g.condition = 50;
    const take = okTake(0);
    const r = MF.renovateGround("varrock", 10, take.fn);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "insufficient-funds");
    assert.strictEqual(MF.groundFor("varrock").condition, 50);
  });

  // --- festivals ---
  t("scheduleFestival creates a real production", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    const r = MF.scheduleFestival("Big Sounds", "varrock", 3);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.festival.days, 3);
    assert.strictEqual(r.festival.status, "scheduled");
    assert.ok(r.festival.name.length > 0);
    assert.strictEqual(MF.promoterFor("Cara").festivalsPromoted, 1);
  });

  t("scheduleFestival clamps days", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    assert.strictEqual(MF.scheduleFestival("Big Sounds", "varrock", 99).festival.days, 4);
    assert.strictEqual(MF.scheduleFestival("Big Sounds", "varrock", 0).festival.days, 2);
  });

  t("scheduleFestival fails on derelict ground", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.ensureGround("varrock").condition = 10;
    assert.strictEqual(MF.scheduleFestival("Big Sounds", "varrock", 2).reason, "ground-derelict");
  });

  // --- bookings ---
  t("bookAct books real acts with real fees", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.creditTreasury("Big Sounds", 5000);
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    const lookup = (type, name) => ({ name });
    const r = MF.bookAct(f.id, 0, "ensemble", "The Lutes", true, lookup);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fee, 300);
    assert.strictEqual(MF.companyTreasury("Big Sounds"), 4700);
    const fest = MF.festivalFor(f.id);
    assert.strictEqual(fest.lineup[0].length, 1);
    assert.strictEqual(fest.lineup[0][0].headliner, true);
  });

  t("bookAct fails honestly on missing act", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.creditTreasury("Big Sounds", 5000);
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    const r = MF.bookAct(f.id, 0, "bard", "Nobody", false, () => null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "act-not-found");
  });

  t("bookAct fails honestly on broke treasury", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    const r = MF.bookAct(f.id, 0, "ensemble", "The Lutes", false, () => ({}));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "insufficient-funds");
  });

  t("bookAct rejects bad act types and days", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.creditTreasury("Big Sounds", 5000);
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    assert.strictEqual(MF.bookAct(f.id, 0, "dj", "X", false, () => ({})).reason, "bad-act-type");
    assert.strictEqual(MF.bookAct(f.id, 9, "bard", "X", false, () => ({})).reason, "bad-day");
  });

  // --- tickets ---
  t("sellTicket moves real coins", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    const take = okTake(1000);
    const r = MF.sellTicket(f.id, "Eve", "day", take.fn);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.price, 15);
    assert.strictEqual(take.taken(), 15);
    assert.strictEqual(MF.festivalFor(f.id).attendance, 1);
  });

  t("sellTicket fails honestly when broke", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    const take = okTake(0);
    assert.strictEqual(MF.sellTicket(f.id, "Eve", "day", take.fn).reason, "insufficient-funds");
  });

  t("setTicketPrices clamps and requires ownership", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.registerPromoter("Zed", "varrock");
    MF.foundCompany("Zed", "Rival Sounds");
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    assert.strictEqual(MF.setTicketPrices(f.id, "Rival Sounds", 10, 20).reason, "not-owner");
    const r = MF.setTicketPrices(f.id, "Big Sounds", 9999, 1);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.tickets.dayPass, 200);
    assert.strictEqual(r.tickets.fullPass, 5);
  });

  // --- vendors & camping ---
  t("addVendor charges real stall fees", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    const take = okTake(1000);
    const r = MF.addVendor(f.id, "Frank", take.fn);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(take.taken(), 50);
    assert.strictEqual(MF.companyTreasury("Big Sounds"), 50);
  });

  t("addCamper charges nightly fees", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    const f = MF.scheduleFestival("Big Sounds", "varrock", 3).festival;
    const take = okTake(1000);
    const r = MF.addCamper(f.id, "Gina", 2, take.fn);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fee, 20);
    assert.strictEqual(take.taken(), 20);
  });

  // --- settlement ---
  t("settleFestival splits revenue and reviews deterministically", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.creditTreasury("Big Sounds", 5000);
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    const lookup = () => ({});
    MF.bookAct(f.id, 0, "ensemble", "The Lutes", true, lookup);
    MF.bookAct(f.id, 0, "bard", "Tom", false, lookup);
    MF.bookAct(f.id, 1, "busker", "Jim", false, lookup);
    const take = okTake(100000);
    for (let i = 0; i < 100; i++) MF.sellTicket(f.id, "fan" + i, "day", take.fn);
    const paid = [];
    const r = MF.settleFestival(f.id, (to, amount) => { paid.push({ to, amount }); return { ok: true }; });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.revenue, 1500);
    assert.strictEqual(r.companyShare, 825);
    assert.strictEqual(r.groundShare, 300);
    assert.ok(r.stars >= 1 && r.stars <= 5);
    assert.strictEqual(MF.festivalFor(f.id).status, "settled");
    // Deterministic: same inputs → same stars.
    assert.strictEqual(r.stars, MF.festivalFor(f.id).reviews.stars);
  });

  t("settleFestival is idempotent", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    MF.settleFestival(f.id, () => ({ ok: true }));
    assert.strictEqual(MF.settleFestival(f.id, () => ({ ok: true })).reason, "already-settled");
  });

  // --- tours ---
  t("startTour schedules real travel", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    const r = MF.startTour("Big Sounds", "varrock", "falador");
    assert.strictEqual(r.ok, true);
    assert.ok(r.arrivesAt > Date.now());
    assert.strictEqual(MF.startTour("Big Sounds", "varrock", "varrock").reason, "same-kingdom");
  });

  // --- persistence ---
  t("save round-trips state", () => {
    const { savePath } = freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.creditTreasury("Big Sounds", 1234);
    assert.strictEqual(MF.save(), true);
    MF.resetForTests();
    MF._setSavePathForTests(savePath);
    assert.strictEqual(MF.companyTreasury("Big Sounds"), 1234);
    assert.strictEqual(MF.isPromoter("cara"), true);
  });

  console.log(`\n${passed} tests passed.`);
}

run();
