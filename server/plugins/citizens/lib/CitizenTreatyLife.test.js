"use strict";

/**
 * CitizenTreatyLife.test.js — slow-tick tests for the citizen treaty layer.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const T = require("./CitizenTreaties");
const Life = require("./CitizenTreatyLife");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-test-"));
T._setSavePathForTests(path.join(TMP, "citizen-treaties.json"));

let passed = 0;
function test(name, fn) {
  T.resetForTests();
  Life.setEmitter(null);
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
  const journaled = [];
  const said = [];
  const logs = [];
  return {
    journaled,
    said,
    logs,
    roster: { get: () => null, values: () => [] },
    isOnline: () => false,
    getBot: () => null,
    journal: (kind, text, data) => journaled.push({ kind, text, data }),
    log: (msg, data) => logs.push({ msg, data }),
    sayPublicTo: (username, text) => said.push({ username, text }),
  };
}

test("tickTreaties: never throws on empty state", () => {
  const d = fakeDirector();
  Life.tickTreaties(d, NOW); // must not throw
  assert.equal(d.logs.length, 0);
});

test("tickTreaties: accepted proposal ratifies and journals", () => {
  const d = fakeDirector();
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "peace", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  const emitted = [];
  Life.setEmitter((name, payload) => emitted.push([name, payload]));
  Life.tickTreaties(d, NOW + 7 * 60 * 60 * 1000);
  assert.ok(d.journaled.some((j) => j.kind === "treaties" && /peace treaty/.test(j.text)));
  assert.equal(T.proposalById(p.id).status, "ratified");
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
  T.scheduleSummit({ a: "asgarnia", b: "misthalin", isPlayer: true, nowMs: NOW });
  Life.tickTreaties(d, NOW + 25 * 60 * 60 * 1000);
  assert.ok(d.journaled.some((j) => /summit/.test(j.text)));
});

test("tickTreaties: expired treaties lapse and journal", () => {
  const d = fakeDirector();
  T.buildEmbassy({ home: "asgarnia", host: "misthalin", nowMs: NOW, takeCoins: paid });
  T.buildEmbassy({ home: "misthalin", host: "asgarnia", nowMs: NOW, takeCoins: paid });
  const r = T.proposeTreaty({ from: "asgarnia", to: "misthalin", type: "trade", isPlayer: true, nowMs: NOW });
  const p = T.proposalById(r.proposal.id);
  p.status = "accepted";
  const res = T.ratifyTreaty(p.id, null, NOW);
  Life.tickTreaties(d, res.treaty.expiresAt + 1000);
  assert.ok(d.journaled.some((j) => /lapsed/.test(j.text)));
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
