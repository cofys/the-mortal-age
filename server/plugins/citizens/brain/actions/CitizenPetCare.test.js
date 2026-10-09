"use strict";

/**
 * CitizenPetCare.test.js — brain action tests. Plain node, mocked player.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Pets = require("../../lib/CitizenPets");
const { createCitizenPetCareAction, ACTION_ID, FOOD_ITEMS } = require("./CitizenPetCare");

const TMP_SAVE = path.join(os.tmpdir(), `citizen-petcare-test-${process.pid}.json`);

function makePlayer(username, itemIds = []) {
  const items = new Map(itemIds.map((id) => [id, 1]));
  return {
    username,
    getUsername: () => username,
    getInventory: () => ({
      contains: (id) => items.has(id),
      deleteNumber: (id, n) => {
        const cur = items.get(id) || 0;
        if (cur >= n) {
          items.set(id, cur - n);
          return true;
        }
        return false;
      },
      _items: items,
    }),
  };
}

beforeEach(() => {
  Pets._setSavePathForTests(TMP_SAVE);
  Pets.resetForTests();
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

describe("CitizenPetCare", () => {
  test("ACTION_ID is citizenPetCare", () => {
    expect(ACTION_ID).toBe("citizenPetCare");
  });

  test("no pets → done, no-pets", async () => {
    const action = createCitizenPetCareAction();
    const player = makePlayer("Alice");
    const result = await action.run(player);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("no-pets");
  });

  test("feeds hungriest pet with real food", async () => {
    Pets.addPet("Bob", "kitten", 1555, { hunger: 20, happiness: 50 });
    const action = createCitizenPetCareAction();
    const player = makePlayer("Bob", [331]); // raw sardine
    const result = await action.run(player);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("fed");
    expect(result.pet).toBe("kitten");
    // Food was consumed.
    expect(player.getInventory()._items.get(331)).toBe(0);
    // Pet was fed.
    expect(Pets.petsOf("Bob")[0].hunger).toBe(20 + Pets.FEED_HUNGER_RESTORE);
  });

  test("no real food → done, no-food (honest)", async () => {
    Pets.addPet("Cara", "kitten", 1555, { hunger: 20, happiness: 50 });
    const action = createCitizenPetCareAction();
    const player = makePlayer("Cara", []); // empty inventory
    const result = await action.run(player);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("no-food");
    // Pet was NOT fed.
    expect(Pets.petsOf("Cara")[0].hunger).toBe(20);
  });

  test("plays with saddest pet when all fed", async () => {
    Pets.addPet("Dan", "kitten", 1555, { hunger: 90, happiness: 40 });
    const action = createCitizenPetCareAction();
    const player = makePlayer("Dan", []);
    const result = await action.run(player);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("played");
    expect(Pets.petsOf("Dan")[0].happiness).toBe(40 + Pets.PLAY_HAPPINESS_BOOST);
  });

  test("happy pets → done, pets-happy", async () => {
    Pets.addPet("Erin", "kitten", 1555, { hunger: 90, happiness: 90 });
    const action = createCitizenPetCareAction();
    const player = makePlayer("Erin", []);
    const result = await action.run(player);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("pets-happy");
  });

  test("give-up after timeout", async () => {
    Pets.addPet("Frank", "kitten", 1555, { hunger: 90, happiness: 90 });
    const action = createCitizenPetCareAction();
    const player = makePlayer("Frank", []);
    const result = await action.run(player, { startedAt: Date.now() - 20 * 60 * 1000 });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("give-up");
  });

  test("FOOD_ITEMS covers all pet food types", () => {
    for (const pet of Object.values(Pets.PET_CATALOG)) {
      expect(FOOD_ITEMS[pet.food]).toBeDefined();
      expect(FOOD_ITEMS[pet.food].length).toBeGreaterThan(0);
    }
  });
});
