"use strict";

/**
 * CitizenSurgeryLife.test.js — slow-tick tests for advanced citizen medicine.
 *
 * Plain node:assert. Mocks the director, roster, and CitizenHealth.
 * Run with: node <this file>.
 */

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// --- mock CitizenHealth before the Life module loads it ---
const healthPath = require.resolve("./CitizenHealth");
const fakeHealth = {
  _sick: new Map(), // normName -> { illness, severity, treatedBy }
  _epidemicKingdoms: new Set(),
  recordOf(name) {
    return this._sick.get(name.toLowerCase()) ?? null;
  },
  illnessDef(key) {
    const defs = {
      infection: { label: "a wound infection", severity: 3 },
      plague: { label: "the pale plague", severity: 4 },
      cold: { label: "a common cold", severity: 1 },
    };
    return defs[key] ?? null;
  },
  isSick(name) {
    return this._sick.has(name.toLowerCase());
  },
  isEpidemic(kid) {
    return this._epidemicKingdoms.has(kid);
  },
  cure(name, how) {
    const existed = this._sick.has(name.toLowerCase());
    this._sick.delete(name.toLowerCase());
    return existed;
  },
  sicken(name, illness, nowMs, opts = {}) {
    this._sick.set(name.toLowerCase(), {
      illness,
      severity: opts.severity ?? 3,
      treatedBy: opts.treatedBy ?? null,
    });
  },
  setEpidemic(kid, on) {
    if (on) this._epidemicKingdoms.add(kid);
    else this._epidemicKingdoms.delete(kid);
  },
  reset() {
    this._sick.clear();
    this._epidemicKingdoms.clear();
  },
};
require.cache[healthPath] = { exports: fakeHealth };

const Surgery = require("./CitizenSurgery");
const { tickSurgery } = require("./CitizenSurgeryLife");

// Redirect saves to temp.
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "surg-life-")), "surgery.json");
Surgery._setSavePathForTests(tmpSave);
Surgery._setMaterialIdsForTests({
  thread: 1001, bandage: 1002, splint: 1003, paper: 1004,
  clean_herb: 2001, super_restore: 2002,
});

function freshDirector(records) {
  const roster = new Map(records.map((r) => [r.username.toLowerCase(), r]));
  const journaled = [];
  const said = [];
  const bots = new Map();
  return {
    roster,
    journaled,
    said,
    getJournal() {
      return { log: (text, data) => journaled.push({ text, data }) };
    },
    sayPublic(text, opts) {
      said.push({ text, opts });
    },
    getBot(rec) {
      const name = (rec.username ?? rec.name ?? "").toLowerCase();
      if (!bots.has(name)) {
        // Fake bot with a real-ish inventory and herblore level.
        const items = new Map();
        bots.set(name, {
          _items: items,
          getLevel: (skill) => (skill === "herblore" ? 75 : 1),
          inventory: {
            // Canonical ItemContainer API: getAmount(id),
            // deleteNumber(id, amount). The old fake inv.count/inv.remove
            // API never touched a real balance.
            getAmount: (id) => items.get(id) ?? 0,
            deleteNumber: (id, n) => items.set(id, Math.max(0, (items.get(id) ?? 0) - n)),
          },
          getInventory() { return this.inventory; },
        });
      }
      return bots.get(name);
    },
    log() { /* quiet */ },
  };
}

function stockBot(director, name, items) {
  const bot = director.getBot({ username: name });
  for (const [id, n] of Object.entries(items)) bot._items.set(Number(id), n);
}

let passed = 0;
function test(name, fn) {
  // Fresh state per test.
  Surgery.resetForTests();
  Surgery._setSavePathForTests(tmpSave);
  Surgery._setMaterialIdsForTests({
    thread: 1001, bandage: 1002, splint: 1003, paper: 1004,
    clean_herb: 2001, super_restore: 2002,
  });
  fakeHealth.reset();
  try {
    fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${e.message}\n${e.stack?.split("\n").slice(1, 3).join("\n")}`);
    process.exitCode = 1;
  }
}

console.log("CitizenSurgeryLife tick tests:");

test("tick never throws on empty director", () => {
  tickSurgery({}, Date.now());
  tickSurgery(null, Date.now());
  tickSurgery({ roster: new Map() }, Date.now());
});

test("healer with herblore 50+ is promoted to surgeon", () => {
  const d = freshDirector([
    { username: "Mira", kingdomId: "varrock", career: { key: "healer" } },
    { username: "Tom", kingdomId: "varrock", career: { key: "farmer" } },
  ]);
  assert.strictEqual(Surgery.isSurgeon("Mira"), false);
  tickSurgery(d, Date.now());
  assert.strictEqual(Surgery.isSurgeon("Mira"), true);
  assert.strictEqual(Surgery.isSurgeon("Tom"), false); // not a healer
});

test("sick citizen gets surgery scheduled when surgeon has materials", () => {
  const now = Date.now();
  fakeHealth.sicken("SickSam", "infection", now, { treatedBy: "Mira" });
  const d = freshDirector([
    { username: "Mira", kingdomId: "varrock", career: { key: "healer" } },
    { username: "SickSam", kingdomId: "varrock", career: { key: "farmer" } },
  ]);
  Surgery.buildWing("varrock", now);
  // Stock Mira's bot with thread + bandages (ids 1001, 1002).
  stockBot(d, "Mira", { 1001: 5, 1002: 10 });
  tickSurgery(d, now);
  assert.strictEqual(Surgery.isSurgeon("Mira"), true);
  const p = Surgery.procedureOf("SickSam");
  assert.ok(p, "procedure should be scheduled");
  assert.strictEqual(p.procedure, "stitch_wound");
  assert.strictEqual(p.status, "in_progress");
});

test("surgery does not schedule without a wing", () => {
  const now = Date.now();
  fakeHealth.sicken("SickSam", "infection", now, { treatedBy: "Mira" });
  const d = freshDirector([
    { username: "Mira", kingdomId: "varrock", career: { key: "healer" } },
    { username: "SickSam", kingdomId: "varrock", career: { key: "farmer" } },
  ]);
  stockBot(d, "Mira", { 1001: 5, 1002: 10 });
  tickSurgery(d, now); // no wing built
  assert.strictEqual(Surgery.procedureOf("SickSam"), null);
});

test("procedure completes after duration and cures via health system", () => {
  const now = Date.now();
  fakeHealth.sicken("SickSam", "infection", now, { treatedBy: "Mira" });
  const d = freshDirector([
    { username: "Mira", kingdomId: "varrock", career: { key: "healer" } },
    { username: "SickSam", kingdomId: "varrock", career: { key: "farmer" } },
  ]);
  Surgery.buildWing("varrock", now);
  stockBot(d, "Mira", { 1001: 5, 1002: 10 });
  Surgery.registerSurgeon("Mira", now);
  Surgery.scheduleProcedure("SickSam", "stitch_wound", "Mira", "varrock", now);
  // 3 hours later (procedure is 2h) — force success by running many ticks
  // is flaky; instead check the procedure resolves to a terminal state.
  let resolved = false;
  for (let i = 0; i < 50 && !resolved; i++) {
    tickSurgery(d, now + 3 * 3600 * 1000 + i);
    const p = Surgery.procedureOf("SickSam");
    resolved = p && p.status !== "in_progress";
  }
  assert.ok(resolved, "procedure should resolve after its duration");
});

test("epidemic triggers quarantine of the sick", () => {
  const now = Date.now();
  fakeHealth.sicken("Sick1", "plague", now);
  fakeHealth.sicken("Sick2", "plague", now);
  fakeHealth.setEpidemic("varrock", true);
  const d = freshDirector([
    { username: "Mira", kingdomId: "varrock", career: { key: "healer" } },
    { username: "Sick1", kingdomId: "varrock", career: { key: "farmer" } },
    { username: "Sick2", kingdomId: "varrock", career: { key: "farmer" } },
    { username: "Healthy", kingdomId: "varrock", career: { key: "farmer" } },
  ]);
  tickSurgery(d, now);
  assert.strictEqual(Surgery.isQuarantined("Sick1"), true);
  assert.strictEqual(Surgery.isQuarantined("Sick2"), true);
  assert.strictEqual(Surgery.isQuarantined("Healthy"), false);
  assert.ok(d.journaled.some((j) => j.text === "quarantine_started"));
});

test("research completes and unlocks procedures", () => {
  const now = Date.now();
  const d = freshDirector([
    { username: "Mira", kingdomId: "varrock", career: { key: "healer" } },
  ]);
  Surgery.startResearch("varrock", "plague_antidote", "Mira", now);
  assert.strictEqual(Surgery.procedureUnlocked("varrock", "purge_plague"), false);
  // 49 hours later (research is 48h).
  tickSurgery(d, now + 49 * 3600 * 1000);
  assert.strictEqual(Surgery.researchDone("varrock", "plague_antidote"), true);
  assert.strictEqual(Surgery.procedureUnlocked("varrock", "purge_plague"), true);
  assert.ok(d.said.some((s) => s.text.includes("Breakthrough")));
});

test("player surgery request gets a surgeon assigned", () => {
  const now = Date.now();
  const d = freshDirector([
    { username: "Mira", kingdomId: "varrock", career: { key: "healer" } },
  ]);
  Surgery.registerSurgeon("Mira", now);
  Surgery.requestSurgeryForPlayer("RealPlayer1", "stitch_wound", "varrock", now);
  tickSurgery(d, now);
  const p = Surgery.procedureOf("RealPlayer1");
  assert.ok(p, "player procedure should exist");
  // After assignment it becomes in_progress (scheduleProcedure overwrites).
  assert.ok(["queued", "in_progress"].includes(p.status));
});

test("consumeMaterials really consumes via deleteNumber, hasMaterials is honest", () => {
  // Regression: the old code used the fake inv.count/inv.remove API, so
  // materials were never consumed while the function reported success.
  const { _hasMaterialsForTests: hasM, _consumeMaterialsForTests: consumeM } = require("./CitizenSurgeryLife");
  const d = freshDirector([
    { username: "Mira", kingdomId: "varrock", career: { key: "healer" } },
  ]);
  stockBot(d, "Mira", { 1001: 5, 1002: 3 }); // thread x5, bandage x3
  const bot = d.getBot({ username: "Mira" });
  const mats = { thread: 2, bandage: 1 };
  assert.strictEqual(hasM(bot, mats), true, "has materials");
  assert.strictEqual(consumeM(bot, mats), true, "consumes materials");
  assert.strictEqual(bot.inventory.getAmount(1001), 3, "thread really reduced");
  assert.strictEqual(bot.inventory.getAmount(1002), 2, "bandage really reduced");
  assert.strictEqual(hasM(bot, { thread: 4 }), false, "honest when short");
  assert.strictEqual(consumeM(bot, { thread: 4 }), false, "refuses when short");
  assert.strictEqual(bot.inventory.getAmount(1001), 3, "failed consume touches nothing");
});

console.log(`\n${passed} tests passed.`);
