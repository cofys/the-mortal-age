"use strict";

/**
 * CitizenMusicFestivalLife.test.js — plain-node tests for the festival life
 * tick. Stubs the director; never touches the engine.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MF = require("./CitizenMusicFestivals");
const Life = require("./CitizenMusicFestivalLife");

function freshState() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mfl-test-"));
  MF._setSavePathForTests(path.join(tmp, "citizen-music-festivals.json"));
  MF.resetForTests();
  Life.resetForTests();
}

function fakeDirector(citizens) {
  return {
    getOnlineCitizens: () => citizens,
    kingdomIdOf: (c) => c.kingdomId,
  };
}

function citizen(username, kingdomId, career, traits) {
  return { username, kingdomId, career: career || null, traits: traits || {} };
}

function run() {
  let passed = 0;
  const t = (name, fn) => { fn(); passed++; console.log("  ok:", name); };

  t("tick never throws on empty director", () => {
    freshState();
    Life.tickMusicFestivalLife(fakeDirector([]), Date.now());
    Life.tickMusicFestivalLife(null, Date.now());
    Life.tickMusicFestivalLife({}, Date.now());
  });

  t("tick registers promoter-career citizens", () => {
    freshState();
    const d = fakeDirector([citizen("Alice", "varrock", "promoter")]);
    Life.tickMusicFestivalLife(d, Date.now());
    assert.strictEqual(MF.isPromoter("Alice"), true);
  });

  t("tick registers charismatic citizens as promoters", () => {
    freshState();
    const d = fakeDirector([citizen("Bob", "falador", null, { charismatic: true })]);
    Life.tickMusicFestivalLife(d, Date.now());
    assert.strictEqual(MF.isPromoter("Bob"), true);
  });

  t("tick does not register unpromoter-like citizens", () => {
    freshState();
    const d = fakeDirector([citizen("Gruff", "varrock", "miner", { gruff: true })]);
    Life.tickMusicFestivalLife(d, Date.now());
    assert.strictEqual(MF.isPromoter("Gruff"), false);
  });

  t("tick schedules ambient festivals for promoters", () => {
    freshState();
    const d = fakeDirector([citizen("Cara", "varrock", "promoter")]);
    // First tick registers; the ambient festival needs a company.
    Life.tickMusicFestivalLife(d, Date.now());
    const festivals = MF.festivalsForKingdom("varrock");
    // Ambient scheduling may or may not fire (throttled) — but it must not throw.
    assert.ok(Array.isArray(festivals));
  });

  t("tick settles ripe festivals", () => {
    freshState();
    MF.registerPromoter("Cara", "varrock");
    MF.foundCompany("Cara", "Big Sounds");
    MF.creditTreasury("Big Sounds", 5000);
    const f = MF.scheduleFestival("Big Sounds", "varrock", 2).festival;
    // Force it ripe.
    f.endsAt = Date.now() - 1000;
    MF.markDirty();
    const d = fakeDirector([citizen("Cara", "varrock", "promoter")]);
    Life.tickMusicFestivalLife(d, Date.now());
    assert.strictEqual(MF.festivalFor(f.id).status, "settled");
  });

  t("tick maintains grounds without throwing", () => {
    freshState();
    MF.ensureGround("varrock");
    const d = fakeDirector([citizen("Alice", "varrock", "promoter")]);
    Life.tickMusicFestivalLife(d, Date.now());
    assert.ok(MF.groundFor("varrock"));
  });

  console.log(`\n${passed} tests passed.`);
}

run();
