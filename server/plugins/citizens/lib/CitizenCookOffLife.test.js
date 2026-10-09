"use strict";

/**
 * CitizenCookOffLife.test.js — plain-node tests for the cook-off slow tick.
 * Run: node server/plugins/citizens/lib/CitizenCookOffLife.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const CookOffs = require("./CitizenCookOffs");
const { tickCookOffLife, resetForTests } = require("./CitizenCookOffLife");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cookofflife-")), "citizen-cookoffs.json");
CookOffs.setSaveFile(tmpSave);

const NOW = 1_700_000_000_000;
const WEEK = 7 * 24 * 3600 * 1000;

function makeBot(username, { career = "chef", cooking = 50, coins = 500, kingdomId = "misthalin", reputation = 60, inventory = null } = {}) {
  // Mock mirrors the REAL engine ItemContainer API: getAmount(id),
  // deleteNumber(id, amount), adds(id, amount). There is no inv.remove(id, amt)
  // and no inv.add(id, amt) — those were the silent no-ops being fixed.
  const inv = inventory || {
    _coins: coins,
    getAmount(id) { return id === 995 ? this._coins : 0; },
    deleteNumber(id, amt) { if (id === 995 && this._coins >= amt) this._coins -= amt; return this; },
    adds(id, amt) { if (id === 995 && amt > 0) this._coins += amt; return this; },
  };
  return {
    username, career, kingdomId, reputation,
    player: {
      getSkillManager() {
        return { getCurrentLevel() { return cooking; } };
      },
      getInventory() { return inv; },
      inventory: inv,
    },
  };
}

function makeDirector(bots) {
  const records = bots.map((b) => ({ username: b.username, career: b.career, kingdomId: b.kingdomId, reputation: b.reputation }));
  const byName = Object.fromEntries(bots.map((b) => [b.username, b]));
  const journalLines = [];
  return {
    roster: { values: () => records },
    isOnline: () => true,
    getBot: (rec) => byName[rec.username] ?? null,
    getJournal: () => ({ log: (t) => journalLines.push(t) }),
    kingdoms: [{ id: "misthalin" }],
    _journalLines: journalLines,
    _bots: byName,
  };
}

let passed = 0;
function test(name, fn) {
  CookOffs.resetForTests();
  resetForTests();
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("tick schedules a cook-off per kingdom and journals it", () => {
  const d = makeDirector([]);
  tickCookOffLife(d, NOW);
  const open = CookOffs.openCookOff("misthalin");
  assert.ok(open, "scheduled");
  assert.ok(d._journalLines.some((l) => l.includes("Cook-off scheduled")), "journaled");
});

test("tick never throws on a hostile director", () => {
  assert.doesNotThrow(() => tickCookOffLife(null, NOW));
  assert.doesNotThrow(() => tickCookOffLife({}, NOW));
  assert.doesNotThrow(() => tickCookOffLife({ roster: null }, NOW));
});

test("auto-enter takes the real fee from chef inventories", () => {
  const gordon = makeBot("Gordon", { cooking: 80, coins: 500 });
  const broke = makeBot("Broke", { cooking: 80, coins: 10 });
  const novice = makeBot("Novice", { cooking: 5, coins: 500 });
  const d = makeDirector([gordon, broke, novice]);
  tickCookOffLife(d, NOW);
  const open = CookOffs.openCookOff("misthalin");
  const names = open.entries.map((e) => e.chef);
  assert.ok(names.includes("Gordon"), "skilled rich chef entered");
  assert.ok(!names.includes("Broke"), "broke chef sat out honestly");
  assert.ok(!names.includes("Novice"), "unskilled chef sat out");
  assert.strictEqual(gordon.player.inventory._coins, 400, "fee really taken");
});

test("tick resolves a ripe cook-off with judges, prizes, and fame", () => {
  const gordon = makeBot("Gordon", { cooking: 90, coins: 500, reputation: 80 });
  const julia = makeBot("Julia", { cooking: 60, coins: 500, reputation: 70 });
  // Judges: high-reputation non-chefs.
  const judges = [
    makeBot("Judge1", { career: "noble", cooking: 1, reputation: 90 }),
    makeBot("Judge2", { career: "merchant", cooking: 1, reputation: 85 }),
    makeBot("Judge3", { career: "scholar", cooking: 1, reputation: 80 }),
  ];
  const d = makeDirector([gordon, julia, ...judges]);
  tickCookOffLife(d, NOW);
  const open = CookOffs.openCookOff("misthalin");
  // Both chefs scored all rounds (simulating completed brain actions).
  for (const chef of ["Gordon", "Julia"]) {
    for (const round of CookOffs.ROUNDS) {
      CookOffs.recordRoundScore(open.id, chef, round, chef === "Gordon" ? 90 : 50, 0.5);
    }
  }
  // Not yet ripe — no resolution.
  tickCookOffLife(d, NOW + 1000);
  assert.ok(!CookOffs.cookOffById(open.id).resolvedAt, "not ripe yet");
  // Ripe: 2+ days later.
  tickCookOffLife(d, NOW + CookOffs.COOKOFF_OPEN_MS + 1000);
  const done = CookOffs.cookOffById(open.id);
  assert.ok(done.resolvedAt, "resolved");
  assert.strictEqual(done.winner, "Gordon", "best chef wins");
  assert.ok(gordon.player.inventory._coins > 400, "winner got prize coins");
  assert.ok(d._journalLines.some((l) => l.includes("won by Gordon")), "win journaled");
});

test("tick does not resolve without 3 judges available", () => {
  const gordon = makeBot("Gordon", { cooking: 90, coins: 500 });
  const julia = makeBot("Julia", { cooking: 60, coins: 500 });
  const d = makeDirector([gordon, julia]); // no judges available
  tickCookOffLife(d, NOW);
  const open = CookOffs.openCookOff("misthalin");
  for (const chef of ["Gordon", "Julia"]) {
    for (const round of CookOffs.ROUNDS) CookOffs.recordRoundScore(open.id, chef, round, 60, 0.5);
  }
  tickCookOffLife(d, NOW + CookOffs.COOKOFF_OPEN_MS + 1000);
  assert.ok(!CookOffs.cookOffById(open.id).resolvedAt, "waits honestly for judges");
});

test("entry fee refused when deleteNumber is a no-op (old inv.remove shape)", () => {
  // Regression: the old inv.remove?.(id, amt) silently did nothing yet
  // returned true, inflating the pot with uncollected fees.
  const noopInv = {
    _coins: 500,
    getAmount(id) { return id === 995 ? this._coins : 0; },
    deleteNumber() { return this; }, // engine-shaped no-op
    adds(id, amt) { if (id === 995) this._coins += amt; return this; },
  };
  const cheater = makeBot("Cheater", { cooking: 80, inventory: noopInv });
  const d = makeDirector([cheater]);
  tickCookOffLife(d, NOW);
  const open = CookOffs.openCookOff("misthalin");
  assert.ok(!open.entries.some((e) => e.chef === "Cheater"), "no free entry on no-op delete");
  assert.strictEqual(open.pot, 0, "pot not inflated by uncollected fee");
});

test("prize skipped honestly when adds is unavailable (old inv.add shape)", () => {
  // Regression: the old inv.add(id, amt) hit the wrong engine overload and
  // threw, so winners were announced but prizes never landed.
  const noAddsInv = {
    _coins: 500,
    getAmount(id) { return id === 995 ? this._coins : 0; },
    deleteNumber(id, amt) { if (id === 995 && this._coins >= amt) this._coins -= amt; return this; },
    // no adds() — prize cannot be delivered
  };
  const gordon = makeBot("Gordon", { cooking: 90, coins: 500 });
  const julia = makeBot("Julia", { cooking: 60, inventory: noAddsInv });
  const judges = [
    makeBot("Judge1", { career: "noble", cooking: 1, reputation: 90 }),
    makeBot("Judge2", { career: "merchant", cooking: 1, reputation: 85 }),
    makeBot("Judge3", { career: "scholar", cooking: 1, reputation: 80 }),
  ];
  const d = makeDirector([gordon, julia, ...judges]);
  tickCookOffLife(d, NOW);
  const open = CookOffs.openCookOff("misthalin");
  for (const chef of ["Gordon", "Julia"]) {
    for (const round of CookOffs.ROUNDS) {
      CookOffs.recordRoundScore(open.id, chef, round, chef === "Gordon" ? 90 : 50, 0.5);
    }
  }
  tickCookOffLife(d, NOW + CookOffs.COOKOFF_OPEN_MS + 1000);
  const done = CookOffs.cookOffById(open.id);
  assert.ok(done.resolvedAt, "resolved");
  assert.strictEqual(julia.player.inventory._coins, 400, "runner-up prize NOT delivered without adds");
  assert.ok(gordon.player.inventory._coins > 400, "winner with working adds still paid");
});

console.log(`CookOff Life tick: ${passed} passed`);
