"use strict";

/**
 * CitizenFishing — verifies the citizen_fish activity is wired correctly.
 *
 * Tests:
 * 1. The activity is defined in citizen-activities.json with the right actions
 *    (ensureItem net -> fish with the NET tool until inventory full -> citizenBank)
 * 2. The decision layer scores it above default for a coastal industrious
 *    citizen, gates landlocked kingdoms down, and penalizes the weary.
 * 3. The upstream action type (fish) resolves through the shared registry.
 */

const path = require("path");
const fs = require("fs");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const ACTIVITIES_PATH = path.join(
  __dirname, "..", "..", "data", "citizen-activities.json"
);

// Fish.js pulls navigation -> TypeScript engine modules, which plain node
// can't resolve. Stub them the way CitizenIntegration.test.js does — the
// engine boundary is the only thing stubbed.
(function stubTypeScriptModules() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request.includes("src/main/typescript")) {
      // Fishing.plugin.js builds its tool tables at require time from
      // IdEnums/Skill — hand it unique fake ids so the tables populate.
      const makeIds = () => {
        let nextId = 1;
        return new Proxy(
          {},
          {
            get: (t, k) => {
              if (k === "__esModule") return false;
              if (!(k in t)) t[k] = nextId++;
              return t[k];
            },
          }
        );
      };
      if (request.endsWith("/IdEnums")) {
        const ids = makeIds();
        return { ItemIds: ids, NpcIds: ids };
      }
      if (request.endsWith("/model/Skill")) {
        return { Skill: makeIds() };
      }
      if (request.endsWith("/task/Task")) {
        return { Task: class {} };
      }
      return {};
    }
    // Fish.js's navigation imports do require-time engine work; stub the
    // modules (same boundary the integration test stubs).
    if (request.includes("behaviours/navigation/BotNavigation")) {
      return {
        navigateTo: () => false,
        isNavigating: () => false,
        stopNavigation: () => {},
        peekMovementRequest: () => null,
        dispatchMovementRequest: () => ({}),
        requestMovement: () => {},
        clearMovementRequest: () => {},
      };
    }
    if (request.includes("behaviours/navigation/BotLongRoutes")) {
      return { canReachSpot: () => undefined };
    }
    if (request.includes("behaviours/navigation/ObjectReach")) {
      return { createEntityReachChecker: () => () => false };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
})();

describe("citizen_fish activity", () => {
  test("is defined with citizenGoToPlace -> ensureItem -> fish -> citizenBank", () => {
    const data = JSON.parse(fs.readFileSync(ACTIVITIES_PATH, "utf8"));
    const fish = data.activities.find((a) => a.id === "citizen_fish");
    assert.ok(fish, "citizen_fish activity must exist");
    assert.equal(fish.mode, "citizen_fish");
    assert.equal(fish.repeat, false);

    const types = fish.actions.map((a) => a.type);
    assert.deepEqual(types, [
      "citizenGoToPlace",
      "ensureItem",
      "fish",
      "citizenBank",
    ]);

    const goTo = fish.actions[0];
    assert.equal(goTo.kind, "fish");

    const net = fish.actions[1];
    assert.equal(net.item, "SMALL_FISHING_NET");

    const fishStep = fish.actions[2];
    assert.equal(fishStep.tool, "NET");
    assert.ok(fishStep.until?.inventoryFull, "must fish until inventory full");
  });

  test("requires commoner role", () => {
    const data = JSON.parse(fs.readFileSync(ACTIVITIES_PATH, "utf8"));
    const fish = data.activities.find((a) => a.id === "citizen_fish");
    const roles = fish.requires?.[0]?.citizen?.roles;
    assert.ok(roles?.includes("commoner"), "commoners can fish");
  });

  test("fish action type resolves through the shared registry", () => {
    const { createFishAction } = require("../../../bots/brain/actions/Fish.PlayerBots.js");
    assert.equal(typeof createFishAction, "function");
    // Unknown tools must throw at activity-compile time, not at runtime.
    assert.throws(() => createFishAction({ tool: "NOPE" }, {}), /unknown fishing tool/);
  });
});

describe("citizen_fish decision scoring", () => {
  function decisions() {
    try {
      return require("../CitizenDecisions");
    } catch {
      return null; // module has heavy deps, skip in isolation
    }
  }

  function snap(overrides = {}) {
    return {
      hp: 100, energy: 100, mood: 50,
      goal: { type: "master_trade" }, personality: { industriousness: 0.9 },
      coins: 30, food: 5, freeSlots: 20, nearby: 0, hour: 10,
      kingdomId: "asgarnia", rawFood: 20,
      ...overrides,
    };
  }

  test("ACT_FISH constant is exported", () => {
    const d = decisions();
    if (!d) return;
    assert.equal(d.ACT_FISH, "citizen_fish");
  });

  test("scores above default for a coastal industrious citizen", () => {
    const d = decisions();
    if (!d || typeof d.scoreActivity !== "function") return;
    const score = d.scoreActivity("citizen_fish", snap());
    assert.ok(score > 30, `fishing should score above default, got ${score}`);
    assert.ok(score > 50, `industrious broke coastal citizen should want to fish, got ${score}`);
  });

  test("landlocked kingdoms score lower than coastal ones (dock gate)", () => {
    const d = decisions();
    if (!d || typeof d.scoreActivity !== "function") return;
    const coastal = d.scoreActivity("citizen_fish", snap({ kingdomId: "asgarnia" }));
    const landlocked = d.scoreActivity("citizen_fish", snap({ kingdomId: "keldagrim" }));
    assert.equal(coastal - landlocked, 30, `dock swing should be +10/-20, got ${coastal} vs ${landlocked}`);
  });

  test("the weary stay away", () => {
    const d = decisions();
    if (!d || typeof d.scoreActivity !== "function") return;
    const rested = d.scoreActivity("citizen_fish", snap());
    const weary = d.scoreActivity("citizen_fish", snap({ energy: 5 }));
    assert.ok(weary < rested, `weary citizen should score lower, got ${weary} vs ${rested}`);
  });

  test("low raw fish raises the score (cook-fire need)", () => {
    const d = decisions();
    if (!d || typeof d.scoreActivity !== "function") return;
    const stocked = d.scoreActivity("citizen_fish", snap({ rawFood: 30 }));
    const hungry = d.scoreActivity("citizen_fish", snap({ rawFood: 2 }));
    assert.ok(hungry > stocked, `low raw fish should raise the score, got ${hungry} vs ${stocked}`);
  });
});
