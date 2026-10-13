"use strict";

/**
 * Citizen account-store wiring test (Jon 2026-10-13).
 *
 * Drives the director's account migration methods with the engine boundary
 * stubbed (same pattern as CitizenSettlementRoster.test.js):
 *   1. hydrateCitizenAccounts() loads per-citizen account files back into
 *      the roster record (gender, home) and the data-tier skill store (XP).
 *   2. saveCitizenAccounts() sweeps the roster in bounded slices and writes
 *      only accounts whose data changed (dirty check via the store cache).
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The store + skill store resolve their save dirs from process.cwd() —
// point them at a scratch dir BEFORE requiring the director.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "citizen-account-wiring-"));
const citizenDir = path.join(tmpDir, "data", "saves", "citizens");
fs.mkdirSync(citizenDir, { recursive: true });
process.chdir(tmpDir);

// ---------------------------------------------------------------------------
// Engine-boundary stubs. Installed BEFORE requiring CitizenDirector.
// ---------------------------------------------------------------------------
function genericStub() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get: (target, prop) => (typeof prop === "string" ? noop : undefined),
    }
  );
}

class StubLocation {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

const REAL_MODULES = [
  "../constants",
  "brain/CitizenSites",
  "lib/personalities",
  "lib/humanizer",
  "lib/CitizenBonds",
  // The wiring under test — these four stay real.
  "lib/CitizenAccountStore",
  "lib/CitizenSkilling",
  "lib/CitizenAging",
  "lib/CitizenHealth",
];

function installStubs() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const parentFile = parent && parent.filename ? parent.filename : "";
    const isDirector = parentFile.endsWith(path.join("director", "CitizenDirector.js"));
    if (request.includes("src/main/typescript")) {
      if (request.endsWith("/Location")) return { Location: StubLocation };
      return {};
    }
    if (isDirector) {
      if (REAL_MODULES.some((m) => request.includes(m))) {
        return originalLoad.call(this, request, parent, isMain);
      }
      return genericStub();
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

installStubs();

const { CitizenDirector } = require("./CitizenDirector");
const Store = require("../lib/CitizenAccountStore");
const CitizenSkilling = require("../lib/CitizenSkilling");

function record(username, gender, role, kingdomId, home) {
  return {
    username,
    gender,
    role,
    kingdomId,
    settlementId: null,
    townId: null,
    home,
    personality: { gender, traits: ["kind"] },
  };
}

function sweepAll(director) {
  let written = 0;
  let guard = 0;
  do {
    written += director.saveCitizenAccounts();
    guard++;
  } while (director._accountSaveNames && guard < 50);
  return written;
}

describe("citizen account store wiring", () => {
  let director;

  before(() => {
    director = new CitizenDirector({ api: {}, registry: {} });
    director.startTask = () => {};
    director.log = () => {};
    director.roster.set(
      "maude limber",
      record("Maude Limber", "female", "commoner", "asgarnia", { x: 3201, y: 3201, z: 0 })
    );
    director.roster.set(
      "borin oak",
      record("Borin Oak", "male", "guard", "misthalin", { x: 3220, y: 3220, z: 0 })
    );
    // Pre-existing account file (simulates a migrated citizen with XP).
    Store.save("maude limber", {
      username: "Maude Limber",
      normalizedName: "maude limber",
      gender: "female",
      createdAt: 1111,
      identity: {
        role: "commoner",
        kingdomId: "asgarnia",
        home: { x: 1, y: 2, z: 0 },
      },
      appearance: { gender: "female" },
      skills: { woodcutting: 5000 },
      aging: { age: 41 },
      health: {},
    });
    Store.clearCache(); // force the director to read from disk like a fresh boot
  });

  it("hydrateCitizenAccounts loads accounts into records and the skill store", () => {
    director.hydrateCitizenAccounts();
    const rec = director.roster.get("maude limber");
    assert.equal(rec.gender, "female");
    assert.deepEqual(rec.home, { x: 1, y: 2, z: 0 });
    const xp = CitizenSkilling.skillStore.xp.get("maude limber");
    assert.ok(xp, "skill store should be hydrated from the account file");
    assert.equal(xp.woodcutting, 5000);
  });

  it("saveCitizenAccounts creates account files for the whole roster", () => {
    const written = sweepAll(director);
    assert.ok(written >= 1, "should write at least the citizen without an account");
    for (const name of ["maude-limber.json", "borin-oak.json"]) {
      assert.ok(fs.existsSync(path.join(citizenDir, name)), `${name} should exist`);
    }
    const borin = JSON.parse(fs.readFileSync(path.join(citizenDir, "borin-oak.json"), "utf8"));
    assert.equal(borin.username, "Borin Oak");
    assert.equal(borin.gender, "male");
    assert.equal(borin.identity.role, "guard");
    assert.equal(borin.appearance.gender, "male");
    assert.equal(borin.version, Store.ACCOUNT_VERSION);
  });

  it("saveCitizenAccounts rewrites only changed accounts", () => {
    const rewritten = sweepAll(director);
    assert.equal(rewritten, 0, "steady-state sweep should write nothing");
    // One XP change -> exactly one rewrite on the next sweep.
    CitizenSkilling.skillStore.xp.set("borin oak", { mining: 999 });
    const after = sweepAll(director);
    assert.equal(after, 1, "should rewrite exactly the changed citizen");
    const borin = JSON.parse(fs.readFileSync(path.join(citizenDir, "borin-oak.json"), "utf8"));
    assert.equal(borin.skills.mining, 999);
  });
});
