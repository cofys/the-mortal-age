"use strict";

/**
 * CitizenAthleticsEvents.test.js — ::athletics command tests (plain node).
 */

const assert = require("assert");
const Athletics = require("./lib/CitizenAthletics");
const { onAthleticsCommand } = require("./CitizenAthleticsEvents");

function stubPlayer(username, opts) {
  const o = opts || {};
  const messages = [];
  return {
    messages,
    getUsername: () => username,
    username,
    isPlayerBot: () => !!o.isBot,
    sendMessage: (t) => messages.push(t),
  };
}

// Stub CitizenSites for kingdomOf
const path = require("path");
const sitesPath = path.resolve(__dirname, "./lib/../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { kingdomIdOf: () => "asgarnia" },
};

function run() {
  let passed = 0;
  const test = (name, fn) => {
    Athletics.resetForTests();
    try { fn(); passed++; }
    catch (e) { console.error(`FAIL: ${name}: ${e.message}`); process.exitCode = 1; }
  };

  test("bots are rejected", () => {
    const p = stubPlayer("BotBob", { isBot: true });
    onAthleticsCommand(p, "stadiums");
    assert(p.messages.length > 0, "should send rejection");
    assert(p.messages[0].includes("Citizens"), "rejection mentions citizens");
  });

  test("stadiums lists stadiums", () => {
    Athletics.foundStadium("misthalin", 250);
    const p = stubPlayer("Alice");
    onAthleticsCommand(p, "stadiums");
    assert(p.messages.length > 0);
    assert(p.messages[0].includes("misthalin"), "should list misthalin");
  });

  test("register creates athlete", () => {
    const p = stubPlayer("Alice");
    onAthleticsCommand(p, "register running");
    assert(Athletics.isAthlete("Alice"), "should register");
    assert(p.messages[0].includes("Registered"), "should confirm");
  });

  test("register rejects invalid sport", () => {
    const p = stubPlayer("Alice");
    onAthleticsCommand(p, "register chess");
    assert(!Athletics.isAthlete("Alice"), "should not register");
    assert(p.messages[0].includes("Sports:"), "should list sports");
  });

  test("train requires registration", () => {
    const p = stubPlayer("Alice");
    onAthleticsCommand(p, "train");
    assert(p.messages[0].includes("Register first"), "should prompt registration");
  });

  test("train works for registered athlete", () => {
    Athletics.registerAthlete("Alice", "running");
    Athletics.foundStadium("asgarnia");
    const p = stubPlayer("Alice");
    const before = Athletics.athleteInfo("Alice").fitness;
    onAthleticsCommand(p, "train");
    const after = Athletics.athleteInfo("Alice").fitness;
    assert(after > before, "fitness should rise");
  });

  test("fitness shows fitness", () => {
    Athletics.registerAthlete("Alice", "running");
    const p = stubPlayer("Alice");
    onAthleticsCommand(p, "fitness");
    assert(p.messages[0].includes("fitness"), "should show fitness");
  });

  test("records lists records", () => {
    Athletics.registerAthlete("Alice", "running");
    for (let i = 0; i < 15; i++) Athletics.trainAthlete("Alice", Date.now());
    Athletics.attemptRecord("Alice", "misthalin", "running", Date.now());
    const p = stubPlayer("Bob");
    onAthleticsCommand(p, "records");
    assert(p.messages[0].includes("Alice"), "should list record holder");
  });

  test("records empty when none", () => {
    const p = stubPlayer("Bob");
    onAthleticsCommand(p, "records");
    assert(p.messages[0].includes("No records"), "should say none");
  });

  test("athletes lists athletes", () => {
    Athletics.registerAthlete("Alice", "running");
    const p = stubPlayer("Bob");
    onAthleticsCommand(p, "athletes");
    assert(p.messages[0].includes("Alice"), "should list Alice");
  });

  console.log(`CitizenAthleticsEvents: ${passed} passed`);
}

run();
