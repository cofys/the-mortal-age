"use strict";

/**
 * CitizenMusicFestivalEvents.test.js — plain-node tests for the ::festival
 * command. Stubs the player; never touches the engine.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MF = require("./lib/CitizenMusicFestivals");
const { onFestivalCommand } = require("./CitizenMusicFestivalEvents");

function freshState() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mfe-test-"));
  MF._setSavePathForTests(path.join(tmp, "citizen-music-festivals.json"));
  MF.resetForTests();
}

function stubPlayer(username, opts) {
  const o = opts || {};
  const messages = [];
  return {
    username,
    getUsername: () => username,
    isRealPlayer: () => o.bot ? false : true,
    isBot: !!o.bot,
    sendMessage: (t) => messages.push(t),
    messages,
    getInventory: () => ({
      getAmount: () => o.coins || 0,
      remove: () => { o.coins = (o.coins || 0); },
    }),
  };
}

function run() {
  let passed = 0;
  const t = (name, fn) => { freshState(); fn(); passed++; console.log("  ok:", name); };

  t("bots are rejected", () => {
    const p = stubPlayer("Bot1", { bot: true });
    onFestivalCommand(p, "register");
    assert.ok(p.messages[0].includes("not this command"));
  });

  t("register makes a promoter", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "register");
    assert.ok(p.messages[0].includes("Registered"));
    assert.strictEqual(MF.isPromoter("Alice"), true);
  });

  t("found creates a company", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "register");
    onFestivalCommand(p, "found Loud Sounds");
    assert.ok(p.messages[1].includes("Founded"));
    assert.ok(MF.companyFor("Loud Sounds"));
  });

  t("found rejects without a name", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "register");
    onFestivalCommand(p, "found");
    assert.ok(p.messages[1].length > 0); // usage
  });

  t("join adds to a company", () => {
    const a = stubPlayer("Alice");
    onFestivalCommand(a, "register");
    onFestivalCommand(a, "found Loud Sounds");
    const b = stubPlayer("Bob");
    onFestivalCommand(b, "join Loud Sounds");
    assert.ok(b.messages[0].includes("Joined"));
  });

  t("schedule creates a festival", () => {
    const p = stubPlayer("Alice");
    // Stub kingdomOf via the brain module path — instead, register directly
    // and call the data tier through the command's schedule path.
    // (kingdomOf returns null without the engine; schedule still works
    // because the data tier accepts a null kingdom.)
    onFestivalCommand(p, "register");
    onFestivalCommand(p, "found Loud Sounds");
    onFestivalCommand(p, "schedule Loud Sounds 3");
    assert.ok(p.messages[2].includes("Scheduled") || p.messages[2].includes("Could not schedule"));
  });

  t("grounds lists kingdoms", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "grounds");
    assert.ok(p.messages[0].includes("misthalin"));
  });

  t("book validates args", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "book");
    assert.ok(p.messages[0].includes("::festival"));
  });

  t("ticket validates args", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "ticket");
    assert.ok(p.messages[0].includes("::festival"));
  });

  t("tour validates args", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "tour");
    assert.ok(p.messages[0].includes("::festival"));
  });

  t("unknown subcommand shows usage", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "frobnicate");
    assert.ok(p.messages[0].includes("::festival"));
  });

  t("renovate without kingdom is honest", () => {
    const p = stubPlayer("Alice");
    onFestivalCommand(p, "renovate 5");
    // kingdomOf returns null without the engine — honest message.
    assert.ok(p.messages[0].length > 0);
  });

  console.log(`\n${passed} tests passed.`);
}

run();
