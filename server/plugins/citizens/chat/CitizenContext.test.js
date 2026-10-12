"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const CTX_PATH = path.join(
  __dirname,
  "CitizenContext.js"
);

/**
 * Load CitizenContext with stubbed dependencies.
 * We intercept require calls for the lazy-loaded modules.
 */
function loadWithStubs({ skills, breadRatio, activityId } = {}) {
  // Clear any cached version
  delete require.cache[CTX_PATH];

  const fakeRecord = {
    username: "Test Citizen",
    kingdom: "asgarnia",
    kingdomId: "asgarnia",
    currentActivityId: activityId ?? null,
    goal: null,
  };
  const fakeBot = {
    getAttribute: () => null,
    getSkills: skills
      ? () => ({ getLevel: (n) => skills[n] ?? 1 })
      : undefined,
  };
  const fakeDirector = {
    roster: new Map([["test citizen", fakeRecord]]),
    getBot: () => fakeBot,
  };

  // Pre-populate require cache for lazy requires
  const stub = (request, exports) => {
    try {
      const resolved = require.resolve(request, { paths: [path.dirname(CTX_PATH)] });
      require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports,
      };
    } catch {
      // Module not resolvable; skip
    }
  };

  stub("../director/CitizenDirector", { getDirector: () => fakeDirector });
  stub("../lib/CitizenBonds", { normalizeName: (n) => String(n).toLowerCase() });
  stub("../lib/CitizenMemory", { getMemory: () => ({}) });
  stub("../lib/CitizenJournal", { getJournal: () => ({ latelyLine: () => null }) });
  stub("../lib/emotions", { emotionLine: () => null });
  stub("../lib/CitizenSocialBonds", {});
  stub("../lib/CitizenKinship", {});
  stub("../lib/CitizenOffices", { officeOfCitizen: () => null });
  stub("../../kingdoms/KingdomStore", {});
  stub("../../guilds/GuildRegistry", {});
  stub("../../economy/Prices.Economy", {
    getBaseline: () => 100,
    getReferencePrice: () => Math.round(100 * (breadRatio ?? 1)),
  });
  stub("../brain/CitizenNeeds", { BREAD_ID: 2309 });
  stub("../constants", {
    ATTR_CITIZEN_NEEDS: "needs",
    ATTR_CITIZEN_GOAL: "goal",
  });

  return require(CTX_PATH);
}

test("buildContext includes top skill levels", () => {
  const { buildContext } = loadWithStubs({
    skills: { woodcutting: 87, fishing: 72, mining: 45, cooking: 5 },
  });
  const ctx = buildContext("Test Citizen", "SomePlayer");
  assert.match(ctx, /woodcutting 87/i);
  assert.match(ctx, /fishing 72/i);
  assert.match(ctx, /mining 45/i);
  // cooking 5 is below threshold, should not appear
  assert.doesNotMatch(ctx, /cooking 5/i);
});

test("buildContext omits skills section when bot has no skills", () => {
  const { buildContext } = loadWithStubs({});
  const ctx = buildContext("Test Citizen", "SomePlayer");
  assert.doesNotMatch(ctx, /your best skills/i);
});

test("buildContext mentions bread price spike", () => {
  const { buildContext } = loadWithStubs({ breadRatio: 1.25 });
  const ctx = buildContext("Test Citizen", "SomePlayer");
  assert.match(ctx, /bread.*25%/i);
});

test("buildContext mentions bread price drop", () => {
  const { buildContext } = loadWithStubs({ breadRatio: 0.8 });
  const ctx = buildContext("Test Citizen", "SomePlayer");
  assert.match(ctx, /bread.*20%/i);
});

test("buildContext omits price when stable", () => {
  const { buildContext } = loadWithStubs({ breadRatio: 1.0 });
  const ctx = buildContext("Test Citizen", "SomePlayer");
  assert.doesNotMatch(ctx, /bread costs/i);
  assert.doesNotMatch(ctx, /bread is.*cheaper/i);
});

test("buildContext never crashes on missing data", () => {
  const { buildContext } = loadWithStubs({});
  // Unknown citizen
  const ctx = buildContext("Nobody", "SomePlayer");
  assert.equal(typeof ctx, "string");
});
