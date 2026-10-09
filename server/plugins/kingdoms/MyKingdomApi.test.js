"use strict";

/**
 * MyKingdomApi.test.js — plain-node tests for the My Kingdom panel data layer.
 *
 * Verifies: payload shape, no-kingdom case, standing with/without office,
 * news assembly, realms list, and that every failure path returns safely.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

// --- Fake KingdomStore -------------------------------------------------------
const fakeKingdoms = {
  asgarnia: {
    id: "asgarnia",
    name: "Asgarnia",
    capital: "Falador",
    ruler: "King Roald",
    rulerTitle: "King",
    treasury: 350000,
    situation: "A proud realm.",
    flags: {
      "royals:log": [
        { at: 1700000000000, type: "marriage", text: "A royal wedding was held." },
      ],
    },
  },
  misthalin: {
    id: "misthalin",
    name: "Misthalin",
    capital: "Varrock",
    ruler: "King Roald II",
    rulerTitle: "King",
    treasury: 280000,
    situation: null,
    flags: {},
  },
};

const Module = require("module");
const origResolve = Module._resolveFilename;
const storePath = path.join(
  __dirname,
  "..", "..", "..", "..", "..",
  "worktrees", "mykingdom", "server", "plugins", "kingdoms", "KingdomStore.js"
);

function makePlayer(attrs) {
  return {
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = v; },
    getUsername: () => attrs.__username || "TestPlayer",
    isPlayerBot: () => false,
  };
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok -", name);
  } catch (e) {
    failed++;
    console.log("  FAIL -", name, ":", e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// Load the API module with stubbed sibling requires by running it in a
// temp dir with a module cache override. Simpler: require it and stub
// via the _test seam against a fake store. We do it by pre-seeding
// require.cache for the sibling paths.
const WT = path.join(__dirname, "..", "..", "..");
const apiPath = path.join(WT, "server", "plugins", "kingdoms", "MyKingdomApi.js");

function stubSiblings() {
  const storeModPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "KingdomStore.js"));
  const officesPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "Offices.Kingdoms.js"));
  const relationsPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "Relations.Kingdoms.js"));
  const coalitionsPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "Coalitions.Kingdoms.js"));
  const crisisPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "SuccessionCrisis.Kingdoms.js"));

  require.cache[storeModPath] = {
    id: storeModPath, filename: storeModPath, loaded: true,
    exports: {
      getKingdom: (id) => fakeKingdoms[id] ?? null,
      getKingdoms: () => Object.values(fakeKingdoms),
      getActiveWars: () => [],
      load: () => ({ kingdoms: fakeKingdoms, sieges: {}, vassals: {} }),
    },
  };
  require.cache[officesPath] = {
    id: officesPath, filename: officesPath, loaded: true,
    exports: {
      getOffices: () => [],
      officeIdFor: (kid, o) => `${kid}:${o}`,
      holderOf: () => null,
    },
  };
  require.cache[relationsPath] = {
    id: relationsPath, filename: relationsPath, loaded: true,
    exports: { relationOf: () => "neutral" },
  };
  require.cache[coalitionsPath] = {
    id: coalitionsPath, filename: coalitionsPath, loaded: true,
    exports: { coalitionOf: () => null },
  };
  require.cache[crisisPath] = {
    id: crisisPath, filename: crisisPath, loaded: true,
    exports: { inCivilWar: () => false, inSuccessionCrisis: () => false },
  };
}

console.log("MyKingdomApi tests:");
stubSiblings();
const api = require(apiPath);
const T = api._test;
assert(T && T.statusPayload, "missing _test seam");

test("no kingdom -> kingdom null, open true", () => {
  const p = makePlayer({});
  const out = T.statusPayload(p);
  assert(out.open === true, "open should be true");
  assert(out.kingdom === null, "kingdom should be null");
  assert(Array.isArray(out.news) && out.news.length === 0, "news empty");
});

test("member sees kingdom, rank, treasury", () => {
  const p = makePlayer({ "kingdom:id": "asgarnia", "kingdom:rank": "Knight", __username: "TestPlayer" });
  const out = T.statusPayload(p);
  assert(out.kingdom.name === "Asgarnia", "name");
  assert(out.kingdom.capital === "Falador", "capital");
  assert(out.kingdom.ruler === "King Roald", "ruler");
  assert(out.kingdom.treasury === 350000, "treasury is real");
  assert(out.standing.rank === "Knight", "rank");
  assert(out.standing.office === null, "no office");
});

test("unknown kingdom id -> null kingdom", () => {
  const p = makePlayer({ "kingdom:id": "nope" });
  const out = T.statusPayload(p);
  assert(out.kingdom === null, "null kingdom");
});

test("news includes royal log entries", () => {
  const p = makePlayer({ "kingdom:id": "asgarnia" });
  const out = T.statusPayload(p);
  assert(out.news.length >= 1, "has news");
  assert(out.news[0].type === "marriage", "royal event type");
  assert(out.news[0].text.includes("wedding"), "royal event text");
});

test("realms lists other kingdoms, not home", () => {
  const p = makePlayer({ "kingdom:id": "asgarnia" });
  const out = T.statusPayload(p);
  assert(out.realms.length === 1, "one other realm");
  assert(out.realms[0].id === "misthalin", "misthalin listed");
  assert(out.realms[0].name === "Misthalin", "name real");
});

test("null player -> safe", () => {
  const out = T.statusPayload(null);
  assert(out.open === true, "open");
  assert(out.kingdom === null, "null kingdom");
});

test("office holder detected", () => {
  // Re-stub offices with a holder.
  const officesPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "Offices.Kingdoms.js"));
  require.cache[officesPath].exports = {
    getOffices: () => [{ office: "steward", title: "Steward", description: "Keeps the books." }],
    officeIdFor: (kid, o) => `${kid}:${o}`,
    holderOf: () => ({ kind: "player", ref: "TestPlayer" }),
  };
  delete require.cache[apiPath];
  stubSiblingsKeepOffices();
  const api2 = require(apiPath);
  const p = makePlayer({ "kingdom:id": "asgarnia", "kingdom:rank": "Steward", __username: "TestPlayer" });
  const out = api2._test.statusPayload(p);
  assert(out.standing.office !== null, "office detected");
  assert(out.standing.office.title === "Steward", "title");
  function stubSiblingsKeepOffices() {
    const storeModPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "KingdomStore.js"));
    const relationsPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "Relations.Kingdoms.js"));
    const coalitionsPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "Coalitions.Kingdoms.js"));
    const crisisPath = require.resolve(path.join(WT, "server", "plugins", "kingdoms", "SuccessionCrisis.Kingdoms.js"));
    require.cache[storeModPath].exports = {
      getKingdom: (id) => fakeKingdoms[id] ?? null,
      getKingdoms: () => Object.values(fakeKingdoms),
      getActiveWars: () => [],
      load: () => ({ kingdoms: fakeKingdoms, sieges: {}, vassals: {} }),
    };
    require.cache[relationsPath].exports = { relationOf: () => "neutral" };
    require.cache[coalitionsPath].exports = { coalitionOf: () => null };
    require.cache[crisisPath].exports = { inCivilWar: () => false, inSuccessionCrisis: () => false };
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
