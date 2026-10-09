"use strict";

/**
 * CitizenDeathRespawn.test.js — unit tests for the persistent death-respawn resolver.
 * Run with: node --test server/plugins/citizens/lib/CitizenDeathRespawn.test.js
 * (from the repo root; uses node:test, no external deps)
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const D = require("./CitizenDeathRespawn");
const { getJournal } = require("./CitizenJournal");
const { getKinship, resetKinshipForTests, BOND_FRIEND } = require("./CitizenKinship");
const { getMemory } = require("./CitizenMemory");
const CitizenOffices = require("./CitizenOffices");

const NOW = 1790000000000;
const record = (over = {}) => ({
  username: "Testy McTest",
  display: "Testy McTest",
  kingdomId: "varrock",
  role: "guard",
  home: { x: 3210, y: 3420, z: 0 },
  ...over,
});

function journalTexts(name, n = 5) {
  return getJournal().recent(name, n).map((e) => e.text);
}

describe("hearthFor", () => {
  it("passes the home tile through", () => {
    assert.deepEqual(D.hearthFor(record()), { x: 3210, y: 3420, z: 0 });
  });
  it("defaults z to 0", () => {
    assert.deepEqual(D.hearthFor(record({ home: { x: 1, y: 2 } })), { x: 1, y: 2, z: 0 });
  });
  it("falls back when the record has no usable home", () => {
    assert.deepEqual(D.hearthFor(record({ home: null })), { x: 3200, y: 3200, z: 0 });
    assert.deepEqual(D.hearthFor({}), { x: 3200, y: 3200, z: 0 });
    assert.deepEqual(D.hearthFor(null), { x: 3200, y: 3200, z: 0 });
  });
});

describe("attachDeathRespawn", () => {
  it("wires the engine seam to the citizen's hearth", () => {
    const bot = {};
    assert.equal(D.attachDeathRespawn(bot, record()), true);
    assert.equal(typeof bot.__botResolveRespawnLocation, "function");
    // The shape the engine's Location.readTile consumes.
    assert.deepEqual(bot.__botResolveRespawnLocation(), { x: 3210, y: 3420, z: 0 });
  });
  it("refuses null bot or record", () => {
    assert.equal(D.attachDeathRespawn(null, record()), false);
    assert.equal(D.attachDeathRespawn({}, null), false);
  });
});

describe("resolveDeathOutcome", () => {
  it("is deterministic: same inputs -> identical outcome", () => {
    const detail = { deathSeq: 1, diedAt: NOW, cause: "was slain by a goblin", killerName: "a goblin" };
    assert.deepEqual(D.resolveDeathOutcome(record(), detail), D.resolveDeathOutcome(record(), detail));
  });
  it("carries the hearth and an engine-immediate respawn", () => {
    const o = D.resolveDeathOutcome(record(), { deathSeq: 1, diedAt: NOW, cause: "died", killerName: null });
    assert.deepEqual(o.hearth, { x: 3210, y: 3420, z: 0 });
    assert.equal(o.respawnAt, NOW);
    assert.equal(o.deathSeq, 1);
    assert.equal(o.username, "testy mctest");
  });
});

describe("recordCitizenDeath", () => {
  beforeEach(() => {
    D._resetForTests();
  });

  it("increments the persisted death sequence", () => {
    const o1 = D.recordCitizenDeath(null, record(), { cause: "was slain by a goblin", killerName: "a goblin" }, NOW);
    assert.equal(o1.deathSeq, 1);
    const o2 = D.recordCitizenDeath(null, record(), { cause: "died", killerName: null }, NOW + 1000);
    assert.equal(o2.deathSeq, 2);
    assert.equal(D.deathCountFor("Testy McTest"), 2);
    assert.equal(D.deathCountFor("Nobody"), 0);
  });

  it("appends to the ledger and journals the citizen's own death", () => {
    D.recordCitizenDeath(null, record(), { cause: "was slain by a goblin", killerName: "a goblin" }, NOW);
    const history = D.deathHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].cause, "was slain by a goblin");
    const texts = journalTexts("testy mctest");
    assert.ok(texts.some((t) => /Died — was slain by a goblin/.test(t)), "own journal remembers the death");
  });

  it("seeds a death gossip for the realm", () => {
    getMemory().gossip.length = 0;
    D.recordCitizenDeath(null, record(), { cause: "was slain by a goblin", killerName: "a goblin" }, NOW);
    const rumor = getMemory().gossip[getMemory().gossip.length - 1];
    assert.ok(rumor, "a gossip entry was seeded");
    assert.equal(rumor.kind, "death");
    assert.equal(rumor.kingdomId, "varrock");
    assert.ok(/Testy McTest was slain by a goblin/.test(rumor.text), "gossip names the death");
  });

  it("notifies spouse/partner/close friends via journal + heardAbout", () => {
    resetKinshipForTests();
    getKinship().add("Widy McTest", "Testy McTest", BOND_FRIEND, "close", "varrock", NOW);
    D.recordCitizenDeath(null, record(), { cause: "was slain by a goblin", killerName: "a goblin" }, NOW);
    const texts = journalTexts("widy mctest");
    assert.ok(
      texts.some((t) => /Testy McTest was slain by a goblin/.test(t)),
      "close friend gets a journaled word"
    );
    resetKinshipForTests();
  });

  it("vacates a held office on death", () => {
    CitizenOffices._bindings()["test:sheriff"] = {
      citizenName: "Testy McTest",
      kingdomId: "varrock",
      office: "sheriff",
      title: "Sheriff",
      boundAtMs: NOW,
      lastDutyMs: 0,
    };
    assert.ok(CitizenOffices.officeOfCitizen("Testy McTest"), "office held before death");
    const outcome = D.recordCitizenDeath(null, record(), { cause: "was slain by a goblin", killerName: "a goblin" }, NOW);
    assert.ok(outcome, "outcome still returned");
    assert.equal(CitizenOffices.officeOfCitizen("Testy McTest"), null, "office unbound on death");
    const texts = journalTexts("testy mctest");
    assert.ok(texts.some((t) => /Sheriff seat stands empty/.test(t)), "vacancy journaled");
    delete CitizenOffices._bindings()["test:sheriff"];
  });

  it("leaves the roster record's identity fields untouched", () => {
    const rec = record();
    const before = JSON.stringify({
      personality: rec.personality,
      goal: rec.goal,
      home: rec.home,
      kingdomId: rec.kingdomId,
      role: rec.role,
    });
    D.recordCitizenDeath(null, rec, { cause: "was slain by a goblin", killerName: "a goblin" }, NOW);
    const after = JSON.stringify({
      personality: rec.personality,
      goal: rec.goal,
      home: rec.home,
      kingdomId: rec.kingdomId,
      role: rec.role,
    });
    assert.equal(before, after, "record identity is not mutated by death");
  });

  it("rejects unusable records", () => {
    assert.equal(D.recordCitizenDeath(null, null, {}, NOW), null);
    assert.equal(D.recordCitizenDeath(null, {}, {}, NOW), null);
  });
});

describe("onCitizenDeath", () => {
  beforeEach(() => {
    D._resetForTests();
  });

  const director = () => ({ roster: new Map([["testy mctest", record()]]) });
  const player = () => ({ getUsername: () => "Testy McTest" });

  it("names a player killer", () => {
    const o = D.onCitizenDeath(director(), player(), { killer: { getUsername: () => "Jon" } }, NOW);
    assert.equal(o.cause, "was slain by Jon");
    assert.equal(o.killerName, "Jon");
  });

  it("names an NPC killer via its definition", () => {
    const npcKiller = { getDefinition: () => ({ getName: () => "Goblin" }) };
    const o = D.onCitizenDeath(director(), player(), { killer: npcKiller }, NOW + 1);
    assert.equal(o.cause, "was slain by Goblin");
    assert.equal(o.deathSeq, 1);
  });

  it("records a plain death when there is no killer", () => {
    const o = D.onCitizenDeath(director(), player(), { killer: null }, NOW + 2);
    assert.equal(o.cause, "died");
  });

  it("ignores unknown players and missing directors", () => {
    assert.equal(D.onCitizenDeath(director(), { getUsername: () => "Stranger" }, {}, NOW), null);
    assert.equal(D.onCitizenDeath(null, player(), {}, NOW), null);
    assert.equal(D.onCitizenDeath({ roster: new Map() }, {}, {}, NOW), null);
  });
});

describe("describeKiller", () => {
  it("handles players, NPCs, and unknowns", () => {
    assert.equal(D.describeKiller(null), null);
    assert.equal(D.describeKiller({ getUsername: () => "Jon" }), "Jon");
    assert.equal(D.describeKiller({ getDefinition: () => ({ getName: () => "Goblin" }) }), "Goblin");
    assert.equal(D.describeKiller({}), null);
  });
});

describe("persistence", () => {
  it("ledger and counts survive a restart", () => {
    D._resetForTests();
    const saveFile = D._saveFile();
    try {
      fs.unlinkSync(saveFile);
    } catch {
      // fresh
    }

    D.recordCitizenDeath(null, record(), { cause: "was slain by a goblin", killerName: "a goblin" }, NOW);
    D.recordCitizenDeath(null, record({ username: "Other Citizen" }), { cause: "died", killerName: null }, NOW);
    assert.equal(D.saveIfDirty(), true, "dirty ledger flushes to disk");
    assert.ok(fs.existsSync(saveFile), "save file written");
    assert.equal(D.saveIfDirty(), false, "clean ledger does not rewrite");

    // Simulate a restart: drop the module from the cache and reload.
    delete require.cache[require.resolve("./CitizenDeathRespawn")];
    const D2 = require("./CitizenDeathRespawn");
    assert.equal(D2.deathCountFor("Testy McTest"), 1, "death count survives restart");
    assert.equal(D2.deathCountFor("Other Citizen"), 1, "second citizen's count survives");
    const history = D2.deathHistory();
    assert.equal(history.length, 2, "ledger survives restart");
    assert.deepEqual(history[0].hearth, { x: 3210, y: 3420, z: 0 }, "hearth survives restart");
    // Deterministic re-resolution: same record + stored detail -> same outcome.
    const re = D2.resolveDeathOutcome(record(), {
      deathSeq: 1,
      diedAt: NOW,
      cause: "was slain by a goblin",
      killerName: "a goblin",
    });
    assert.deepEqual(re, history[0], "outcome re-resolves identically after restart");

    // Cleanup: the test save file must not leak into real runs.
    try {
      fs.unlinkSync(saveFile);
    } catch {
      // best-effort
    }
    try {
      fs.rmdirSync(path.dirname(saveFile));
    } catch {
      // keep data/saves if shared
    }
    D2._resetForTests();
  });
});
