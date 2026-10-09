"use strict";

/**
 * CitizenInteractionSeams.test.js — regression tests for the 2026-10-09
 * interaction-tier fixes across the new citizen life systems (espionage,
 * trade charters, archaeology, theater, athletics).
 *
 * Bug class: the new Life modules called engine APIs that don't exist on the
 * real objects — director.journal, director.sayPublic, director.getRealPlayers,
 * record.getLocalPlayers, CitizenSites.marketTile, CitizenJournal.journal /
 * record, sayPublic(null, text), sayPublic(director, tile, text). Every call
 * was try/catch-guarded, so the features silently no-op'd instead of
 * crashing: athletes could never train, no announcements ever reached chat,
 * no journal entries were ever written.
 *
 * These tests pin the REAL seams, all verified against the engine sources:
 *   - getJournal().log(citizenName, kind, text, opts) (CitizenJournal.js:79)
 *   - sayPublic(bot, text) (chat/CitizenSayPublic.js)
 *   - director.getBot(record) / getBot({username}) (CitizenDirector.js:1540)
 *   - bot.getLocalPlayers() (canonical proximity seam)
 *   - siteTileByKingdom(kingdomId, "market") (brain/CitizenSites.js)
 *
 * Run: node server/plugins/citizens/lib/CitizenInteractionSeams.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Real-API-shape stubs (installed before any Life module loads)
// ---------------------------------------------------------------------------

const said = [];      // { bot, text } via canonical sayPublic(bot, text)
const journaled = []; // { name, kind, text, data } via getJournal().log

const sayPublicPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[sayPublicPath] = {
  id: sayPublicPath, filename: sayPublicPath, loaded: true,
  exports: {
    sayPublic: (bot, text) => { said.push({ bot, text }); return true; },
    isRealPlayer: (p) => {
      try { return p?.isRealPlayer?.() ?? !p?.isBot; }
      catch { return false; }
    },
  },
};

const journalPath = path.resolve(__dirname, "./CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: {
    getJournal: () => ({
      log: (name, kind, text, data) => { journaled.push({ name, kind, text, data }); return {}; },
    }),
  },
};

const MARKET = { x: 3200, y: 3200, z: 0 };
const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["asgarnia"],
    kingdomIdOf: (r) => (typeof r === "string" ? r : r?.kingdomId) || "asgarnia",
    siteTile: () => ({ ...MARKET }),
    siteTileByKingdom: () => ({ ...MARKET }),
  },
};

// Stub explorers: no expeditions (we seed dig sites directly via Arch).
const explorersPath = path.resolve(__dirname, "./CitizenExplorers.js");
require.cache[explorersPath] = {
  id: explorersPath, filename: explorersPath, loaded: true,
  exports: { finishedExpeditions: () => [] },
};

// --- real modules under test ---
const Athletics = require("./CitizenAthletics");
const AthleticsLife = require("./CitizenAthleticsLife");
const Theater = require("./CitizenTheater");
const TheaterLife = require("./CitizenTheaterLife");
const Charters = require("./CitizenTradeCharters");
const CharterLife = require("./CitizenTradeCharterLife");
const Arch = require("./CitizenArchaeology");
const ArchLife = require("./CitizenArchaeologyLife");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "seams-test-"));
Athletics.setSaveFile(path.join(TMP, "athletics.json"));
Theater._setSavePathForTests(path.join(TMP, "theater.json"));
Charters._setSavePathForTests(path.join(TMP, "charters.json"));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function realPlayer(x, y) {
  return {
    isRealPlayer: () => true,
    isBot: false,
    getPosition: () => ({ x, y, z: 0 }),
    getIndex: () => 42,
  };
}

function materializedBot(username, opts = {}) {
  const inv = opts.inventory || null;
  return {
    username,
    getUsername: () => username,
    getInventory: () => inv,
    getLocalPlayers: () => opts.nearby || [],
    forceChat: () => {},
  };
}

let passed = 0;
function test(name, fn) {
  Athletics.resetForTests();
  Theater.resetForTests();
  TheaterLife.resetForTests();
  Charters.resetForTests();
  CharterLife.resetForTests();
  Arch.resetForTests();
  ArchLife.resetForTests();
  said.length = 0;
  journaled.length = 0;
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 1. Athletics: stadiumTile resolves through the real CitizenSites seam
// ---------------------------------------------------------------------------

test("athletics: stadiumTile resolves via siteTileByKingdom (was marketTile -> null)", () => {
  Athletics.foundStadium("asgarnia");
  const t = Athletics.stadiumTile("asgarnia");
  assert.ok(t, "stadiumTile must not be null (old code returned null: marketTile doesn't exist)");
  assert.strictEqual(t.x, MARKET.x + 8, "stadium sits 8 tiles east of the market");
  assert.strictEqual(t.y, MARKET.y);
});

// ---------------------------------------------------------------------------
// 2. Athletics: record-broken announcement reaches a nearby real player
// ---------------------------------------------------------------------------

test("athletics: record announcement uses sayPublic(bot, text), gated on real players", () => {
  Athletics.registerAthlete("Champ", "running");
  Athletics.foundStadium("asgarnia");
  for (let i = 0; i < 20; i++) Athletics.trainAthlete("Champ", Date.now());
  const info = Athletics.athleteInfo("Champ");
  assert.ok(info.skill >= 10 && info.fitness >= 60, "champ is record-ready");

  const rp = realPlayer(MARKET.x + 8, MARKET.y); // standing at the stadium
  const bot = materializedBot("Champ", { nearby: [rp] });
  const director = {
    citizensOnline: () => [],
    onlineBotsForKingdom: () => [bot],
    getBot: () => bot,
    roster: new Map(),
  };
  AthleticsLife.tickAthleticsLife(director, Date.now());
  const hit = said.find((s) => /Champ/.test(s.text) && /record/i.test(s.text));
  assert.ok(hit, "record announcement should fire via sayPublic");
  assert.strictEqual(hit.bot.username, "Champ", "speaker is the record holder's bot (old code passed (director, tile, text))");
});

test("athletics: record announcement stays silent with no real player near", () => {
  Athletics.registerAthlete("QuietChamp", "running");
  Athletics.foundStadium("asgarnia");
  for (let i = 0; i < 20; i++) Athletics.trainAthlete("QuietChamp", Date.now());
  const bot = materializedBot("QuietChamp", { nearby: [] }); // nobody around
  const director = {
    citizensOnline: () => [],
    onlineBotsForKingdom: () => [bot],
    getBot: () => bot,
    roster: new Map(),
  };
  AthleticsLife.tickAthleticsLife(director, Date.now());
  assert.strictEqual(said.length, 0, "LOD gate: no real player, no announcement");
});

// ---------------------------------------------------------------------------
// 3. Theater: playwriting works end-to-end and announces near real players
// ---------------------------------------------------------------------------

test("theater: playwright drafts a play (papyrus from bot inventory) and announces it", () => {
  const PAPYRUS_ID = 970;
  const record = {
    username: "Pippa",
    kingdomId: "asgarnia",
    career: "playwright",
    personality: { creativity: 0.9, expressiveness: 0.8 },
  };
  const rp = realPlayer(3200, 3200);
  const bot = materializedBot("Pippa", {
    nearby: [rp],
    inventory: {
      getAmount: (id) => (id === PAPYRUS_ID ? 5 : 0),
      remove: () => true,
    },
  });
  const director = {
    roster: new Map([["pippa", record]]),
    isOnline: () => true,
    getBot: () => bot,
  };
  TheaterLife.tickTheaterLife(director, Date.now());
  assert.ok(Theater.playsIn("asgarnia").length >= 1, "play should be written (old code: writePlay(record) always failed takePapyrus)");
  const hit = said.find((s) => /Just finished/.test(s.text));
  assert.ok(hit, "playwright announcement should fire (old code: nearRealPlayers(record) always false)");
  assert.strictEqual(hit.bot.username, "Pippa", "speaker is the playwright's bot (old code passed the plain record)");
});

test("theater: no announcement when no real player is near", () => {
  const record = {
    username: "LonelyLydia",
    kingdomId: "asgarnia",
    career: "playwright",
    personality: { creativity: 0.9, expressiveness: 0.8 },
  };
  const bot = materializedBot("LonelyLydia", {
    nearby: [],
    inventory: { getAmount: () => 5, remove: () => true },
  });
  const director = {
    roster: new Map([["lonelylydia", record]]),
    isOnline: () => true,
    getBot: () => bot,
  };
  TheaterLife.tickTheaterLife(director, Date.now());
  assert.ok(Theater.playsIn("asgarnia").length >= 1, "play still written (data tier)");
  assert.strictEqual(said.length, 0, "LOD gate: no announcement without a real player");
});

// ---------------------------------------------------------------------------
// 4. Trade charters: lapse journals canonically and announces near players
// ---------------------------------------------------------------------------

function seedExpiredCharter() {
  const Rep = require("./CitizenReputation");
  Rep._setSavePathForTests?.(path.join(TMP, "rep.json"));
  Rep.resetForTests?.();
  for (let i = 0; i < 10; i++) Rep.addReputation("SeedBob", 10, "test", Date.now());
  let bal = 99999;
  const player = {
    getInventory() {
      return {
        getAmount: (id) => (id === 995 ? bal : 0),
        deleteNumber: (id, n) => { if (id === 995 && bal >= n) { bal -= n; return true; } return false; },
        adds: (id, n) => { if (id === 995) bal += n; },
      };
    },
  };
  const past = Date.now() - 31 * 24 * 60 * 60 * 1000; // expired 31 days ago
  const res = Charters.petitionCharter("SeedBob", "merchants", "asgarnia", "weapons", player, past);
  assert.ok(res.ok, `seed petition failed: ${res.reason}`);
}

test("charters: expired charter lapse is journaled under the petitioner", () => {
  seedExpiredCharter();
  CharterLife.tickTradeCharters(null, Date.now());
  assert.strictEqual(Charters.isChartered("asgarnia", "weapons"), false, "charter lapsed");
  const j = journaled.find((e) => e.kind === "charter_lapsed");
  assert.ok(j, "lapse should be journaled (old code probed J.journal/J.record — neither exists)");
  assert.strictEqual(j.name, "SeedBob", "journaled under the petitioner's name (canonical getJournal().log shape)");
});

test("charters: lapse announcement reaches a nearby real player via a kingdom bot", () => {
  seedExpiredCharter();
  const rp = realPlayer(3200, 3200);
  const bot = materializedBot("TownCrier", { nearby: [rp] });
  const director = {
    onlineBotsForKingdom: () => [bot],
    getBot: () => bot,
    roster: new Map(),
  };
  CharterLife.tickTradeCharters(director, Date.now());
  const hit = said.find((s) => /lapsed/i.test(s.text));
  assert.ok(hit, "lapse announcement should fire (old code: sayPublic(null, text) -> instant false)");
  assert.ok(hit.bot, "spoken by a materialized kingdom bot");
});

// ---------------------------------------------------------------------------
// 5. Archaeology: major-find announcement reaches a real player near the museum
// ---------------------------------------------------------------------------

test("archaeology: major find is announced to real players near the museum", () => {
  // Find a dig seed that yields a major find within its slots (deterministic).
  let site = null;
  for (let i = 0; i < 30 && !site; i++) {
    const res = Arch.foundSiteFromDiscovery(`exp-seam-${i}`, { name: "ancient tomb of the old kings" }, "asgarnia", "DigDora");
    if (!res.ok || !res.site) continue;
    let majorAt = -1;
    for (let d = 0; d < res.site.slotsLeft; d++) {
      const r = Arch.excavate("DigDora", res.site.id);
      if (!r.ok) break;
      if (r.major) { majorAt = d; break; }
    }
    if (majorAt >= 0) site = { expId: `exp-seam-${i}`, majorAt };
  }
  assert.ok(site, "expected at least one seeded site to yield a major find");

  // Reset and re-seed identically (same expedition id -> same dig sequence).
  Arch.resetForTests();
  ArchLife.resetForTests();
  said.length = 0;
  const res = Arch.foundSiteFromDiscovery(site.expId, { name: "ancient tomb of the old kings" }, "asgarnia", "DigDora");
  assert.ok(res.ok && res.site, "re-seed works");
  Arch.registerArchaeologist("DigDora", "asgarnia");

  // Museum tile = stub market (3200,3200) + (30,-18) = (3230, 3182).
  const rp = realPlayer(3230, 3182);
  const bot = materializedBot("DigDora", { nearby: [rp] });
  const record = { username: "DigDora", kingdomId: "asgarnia", personality: { curiosity: 0.9 } };
  const director = {
    roster: new Map([["digdora", record]]),
    isOnline: () => true,
    getBot: () => bot,
  };
  let announced = false;
  for (let i = 0; i < 40 && !announced; i++) {
    ArchLife.tickArchLife(director, Date.now() + i * (2 * 3600 * 1000 + 60000));
    announced = said.some((s) => /pulled/i.test(s.text));
  }
  assert.ok(announced, "major find should be announced (old code: director.getRealPlayers doesn't exist -> always silent)");
  const hit = said.find((s) => /pulled/i.test(s.text));
  assert.strictEqual(hit.bot.username, "DigDora", "announced by the finder's bot");
});

console.log(`\nCitizenInteractionSeams: ${passed} passed.`);
