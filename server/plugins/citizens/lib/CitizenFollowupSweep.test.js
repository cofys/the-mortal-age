"use strict";

/**
 * CitizenFollowupSweep.test.js (lib) — regression tests for the 05:00
 * seven-systems audit follow-up sweep (scopes 1–3), journal-arg shapes.
 *
 * Every assertion targets the REAL CitizenJournal contract:
 *   log(citizenName, kind, text, opts)  — returns null when name/kind/text
 *   is missing, so a wrong-arg call is never journaled.
 * The journal itself is a spy behind require.cache; the spy follows the
 * real signature. Never let a stub codify a dead API.
 *
 * Run: node server/plugins/citizens/lib/CitizenFollowupSweep.test.js
 */

const assert = require("assert");
const path = require("path");

function stub(p, exports) {
  const abs = path.resolve(__dirname, p);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// --- journal spy (real log() signature) ---

const journalCalls = [];
stub("./CitizenJournal.js", {
  getJournal: () => ({
    log: (citizenName, kind, text, opts = {}) => {
      journalCalls.push({ citizenName, kind, text, opts });
      return { citizenName, kind, text };
    },
  }),
});

// --- dependency stubs for the life modules ---

stub("./CitizenGovernment.js", {});
stub("./humanizer.js", { agentRng: () => () => 0.5, humanizerProfile: () => ({}) });
stub("./CitizenTravel.js", { kingdomName: (id) => String(id) });
stub("./CitizenBonds.js", {
  normalizeName: (n) => String(n ?? "").trim().toLowerCase(),
});
stub("../constants.js", { ATTR_KINGDOM_ID: "citizens:kingdom-id" });
stub("./CitizenDiplomacy.js", {});
stub("./CitizenGalleries.js", {});
stub("../chat/CitizenSayPublic.js", { sayPublic: () => {} });

// --- modules under test ---

const Gov = require("./CitizenGovernmentLife");
const Travel = require("./CitizenTravelLife");
const Dip = require("./CitizenDiplomacyLife");
const Gal = require("./CitizenGalleriesLife");
const Disc = require("./CitizenDiscovery");
const Cel = require("./CitizenCelebrations");

let passed = 0;
function test(name, fn) {
  journalCalls.length = 0;
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

function lastCall() {
  assert.strictEqual(journalCalls.length, 1, "expected exactly one journal call");
  return journalCalls[0];
}

// --- scope 3: GovernmentLife journalEvent (callers pass (name, text, kind)) ---

test("GovernmentLife: journalEvent(name, text, kind) lands as log(name, kind, text)", () => {
  Gov._journalEvent("Aldric", "the council was dissolved.", "politics");
  const j = lastCall();
  assert.strictEqual(j.citizenName, "Aldric");
  assert.strictEqual(j.kind, "politics"); // old body swapped kind/text
  assert.strictEqual(j.text, "the council was dissolved.");
});

test("GovernmentLife: missing kind defaults to politics", () => {
  Gov._journalEvent("Aldric", "a quiet season.", undefined);
  const j = lastCall();
  assert.strictEqual(j.kind, "politics");
  assert.strictEqual(j.text, "a quiet season.");
});

// --- scope 4: TravelLife journalEvent ---

test("TravelLife: journalEvent(name, text, kind) lands as log(name, kind, text)", () => {
  Travel._journalEvent("Bea", "arrived in Varrock by ship.", "travel");
  const j = lastCall();
  assert.strictEqual(j.citizenName, "Bea");
  assert.strictEqual(j.kind, "travel");
  assert.strictEqual(j.text, "arrived in Varrock by ship.");
});

// --- scope 6: DiplomacyLife dead director.journal ---

test("DiplomacyLife: journal(username, text, data) -> log(name, diplomacy, text, {data})", () => {
  Dip._journal(null, "SpySam", "returned with word of levies.", { mission: "m1" });
  const j = lastCall();
  assert.strictEqual(j.citizenName, "SpySam");
  assert.strictEqual(j.kind, "diplomacy");
  assert.strictEqual(j.text, "returned with word of levies.");
  assert.deepStrictEqual(j.opts, { data: { mission: "m1" } });
});

test("DiplomacyLife: kingdom-level events journal under Realm", () => {
  Dip._journal(null, null, "the proposal died unanswered.", { marriage: "x" });
  const j = lastCall();
  assert.strictEqual(j.citizenName, "Realm");
  assert.strictEqual(j.kind, "diplomacy");
  assert.strictEqual(j.text, "the proposal died unanswered.");
});

// --- scope 7: GalleriesLife dead director.journal ---

test("GalleriesLife: journalGallery(name, text, data) -> log(name, galleries, text, {data})", () => {
  Gal._journalGallery("CuratorCat", "auction closed: Sunset Study", { sold: true });
  const j = lastCall();
  assert.strictEqual(j.citizenName, "CuratorCat");
  assert.strictEqual(j.kind, "galleries");
  assert.strictEqual(j.text, "auction closed: Sunset Study");
  assert.deepStrictEqual(j.opts, { data: { sold: true } });
});

test("GalleriesLife: null name journals under Realm", () => {
  Gal._journalGallery(null, "tour arrived: Grand Tour", {});
  const j = lastCall();
  assert.strictEqual(j.citizenName, "Realm");
  assert.strictEqual(j.kind, "galleries");
});

// --- scope 8: Discovery missing text ---

test("Discovery: recordDiscovery journals log(discoverer, discovery, text, {data})", () => {
  const d = Disc.recordDiscovery("ancient_ruin", 3200, 3200, 0, "ExplorerEd", "Old Ruin");
  const j = lastCall();
  assert.strictEqual(j.citizenName, "ExplorerEd");
  assert.strictEqual(j.kind, "discovery"); // old code put the data object here
  assert.ok(
    typeof j.text === "string" && j.text.includes("Old Ruin"),
    "text must be present (old code passed no text, log() returned null)"
  );
  assert.strictEqual(j.opts.data.id, d.id);
  assert.strictEqual(j.opts.data.type, "ancient_ruin");
});

test("Discovery: claimDiscovery journals log(Realm, discovery-claimed, text, {data})", () => {
  const d = Disc.recordDiscovery("resource_node", 3201, 3201, 0, "ExplorerEd", "Rich Vein");
  journalCalls.length = 0;
  const ok = Disc.claimDiscovery(d.id, "varrock");
  assert.strictEqual(ok, true);
  const j = lastCall();
  assert.strictEqual(j.citizenName, "Realm");
  assert.strictEqual(j.kind, "discovery-claimed");
  assert.ok(typeof j.text === "string" && j.text.length > 0);
  assert.deepStrictEqual(j.opts.data, {
    id: d.id,
    kingdomId: "varrock",
    type: "resource_node",
  });
});

// --- scope 9: Celebrations missing kind ---

test("Celebrations: appointPlanner journals log(planner, celebration, text)", () => {
  Cel.resetForTests();
  Cel.appointPlanner("varrock", "PlannerPam", 100, 100);
  const j = lastCall();
  assert.strictEqual(j.citizenName, "plannerpam"); // normalized
  assert.strictEqual(j.kind, "celebration"); // old code put the text here
  assert.ok(typeof j.text === "string" && j.text.includes("festival planner"));
});

test("Celebrations: organizeFestival journals log(organizer, celebration, text)", () => {
  Cel.resetForTests();
  const fest = Cel.organizeFestival({
    name: "Starlight Fair",
    theme: "starlight",
    kingdomId: "varrock",
    organizer: "OrganizerOli",
    budget: 5000,
  });
  assert.ok(fest, "festival should organize");
  const j = lastCall();
  assert.strictEqual(j.citizenName, "organizeroli");
  assert.strictEqual(j.kind, "celebration");
  assert.ok(typeof j.text === "string" && j.text.includes("Starlight Fair"));
});

console.log(`\n${passed} passed`);
