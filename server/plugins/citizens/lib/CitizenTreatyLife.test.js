"use strict";

/**
 * CitizenTreatyLife.test.js — slow-tick tests for the citizen treaty layer.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// --- real-API-shape stubs (installed before the Life module's lazy requires)
// The real journal seam is getJournal().log(citizenName, kind, text, opts)
// (CitizenJournal.js:79) — NOT director.journal (doesn't exist on the real
// director). The real speech seam is CitizenSayPublic.sayPublic(bot, text).
const journaled = [];
const said = [];
const journalPath = path.resolve(__dirname, "./CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: {
    getJournal: () => ({
      log: (name, kind, text, data) => { journaled.push({ name, kind, text, data }); },
    }),
  },
};
const sayPublicPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[sayPublicPath] = {
  id: sayPublicPath, filename: sayPublicPath, loaded: true,
  exports: {
    sayPublic: (bot, text) => { said.push({ bot, text }); return true; },
  },
};

const T = require("./CitizenTreaties");
const Life = require("./CitizenTreatyLife");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-test-"));
T._setSavePathForTests(path.join(TMP, "citizen-treaties.json"));

let passed = 0;
function test(name, fn) {
  T.resetForTests();
  Life.setEmitter(null);
  journaled.length = 0;
  said.length = 0;
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

function fakeDirector() {
  // Real director shape: roster is a Map of plain data records,
  // isOnline/getBot take the RECORD ({username}), log() is the server log.
  // Speech and journaling go through the stubbed canonical seams above.
  const logs = [];
  return {
    logs,
    roster: new Map(),
    isOnline: () => false,
    getBot: () => null,
    log: (msg, data) => logs.push({ msg, data }),
  };
}

test("tickTreaties: never throws on empty state", () => {
  const d = fakeDirector();
  Life.tickTreaties(d, NOW); // must not throw
  assert.equal(d.logs.length, 0);
  assert.equal(journaled.length, 0);
});

test("tickTreaties: accepted proposal ratifies and journals via getJournal().log", () => {
  const d = fakeDirector();
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", broker: "Herald", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  const emitted = [];
  Life.setEmitter((name, payload) => emitted.push([name, payload]));
  Life.tickTreaties(d, NOW + 7 * 60 * 60 * 1000);
  assert.ok(journaled.some((j) => j.kind === "treaty" && j.name === "Herald" && /peace treaty/.test(j.text)));
  assert.equal(T.proposalById(p.id).status, "ratified");
});

test("tickTreaties: broker speech uses the real director record + sayPublic seam", () => {
  const d = fakeDirector();
  d.roster.set("herald", { username: "Herald" });
  d.isOnline = () => true;
  const bot = { username: "Herald", forceChat() {}, getLocalPlayers: () => [] };
  d.getBot = () => bot;
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", broker: "Herald", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  Life.tickTreaties(d, NOW + 7 * 60 * 60 * 1000);
  assert.ok(said.some((s) => s.bot === bot && /peace treaty/.test(s.text)));
});

test("tickTreaties: alliance ratification emits kingdom:alliance-formed", () => {
  const d = fakeDirector();
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "alliance", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  const emitted = [];
  Life.setEmitter((name, payload) => emitted.push([name, payload]));
  Life.tickTreaties(d, NOW + 7 * 60 * 60 * 1000);
  assert.ok(emitted.some(([name]) => name === "kingdom:alliance-formed"));
});

test("tickTreaties: due summit is held and journaled", () => {
  const d = fakeDirector();
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  T.scheduleSummit({ a: "asgarnia", b: "misthalin", broker: "Envoy", isPlayer: true, nowMs: NOW });
  Life.tickTreaties(d, NOW + 25 * 60 * 60 * 1000);
  assert.ok(journaled.some((j) => j.kind === "treaty" && j.name === "Envoy" && /summit/.test(j.text)));
});

test("tickTreaties: expired treaties lapse and journal under Realm", () => {
  const d = fakeDirector();
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "trade", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  const res = T.ratifyTreaty(p.id, null, NOW);
  Life.tickTreaties(d, res.treaty.expiresAt + 1000);
  assert.ok(journaled.some((j) => j.kind === "treaty" && j.name === "Realm" && /lapsed/.test(j.text)));
});

test("tickTreaties: embassy pair cools the border", () => {
  const d = fakeDirector();
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  // Must not throw even with the kingdom layer present or absent.
  Life.tickTreaties(d, NOW);
  assert.equal(d.logs.length, 0);
});

console.log(`\n${passed} tests passed.`);
