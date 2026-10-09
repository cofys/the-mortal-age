"use strict";

/**
 * CitizenPetLife.test.js — slow tick tests. Plain node, mocked director.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Pets = require("./CitizenPets");
const PetLife = require("./CitizenPetLife");

const TMP_SAVE = path.join(os.tmpdir(), `citizen-petlife-test-${process.pid}.json`);

function makeDirector(records = []) {
  const journaled = [];
  const map = new Map();
  for (const r of records) {
    if (r && r.username) map.set(r.username, r);
  }
  return {
    roster: map,
    getJournal: () => ({ log: (user, msg) => journaled.push({ user, msg }) }),
    _journaled: journaled,
    isOnline: () => null, // no bots online in tests
    getBot: () => null,
  };
}

beforeEach(() => {
  Pets._setSavePathForTests(TMP_SAVE);
  Pets.resetForTests();
  PetLife.resetForTests();
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

describe("CitizenPetLife", () => {
  test("tickPets never throws with empty roster", () => {
    const director = makeDirector([]);
    expect(() => PetLife.tickPets(director, Date.now())).not.toThrow();
  });

  test("tickPets never throws with missing roster", () => {
    expect(() => PetLife.tickPets({}, Date.now())).not.toThrow();
    expect(() => PetLife.tickPets(null, Date.now())).not.toThrow();
  });

  test("tickPets decays pets over elapsed days", () => {
    Pets.addPet("Alice", "kitten", 1555, { happiness: 80, hunger: 80 });
    const director = makeDirector([{ username: "Alice", kingdomId: "varrock" }]);

    const now = Date.now();
    PetLife.tickPets(director, now); // first tick sets baseline
    PetLife.tickPets(director, now + 2 * 24 * 3600 * 1000); // 2 days later

    const [pet] = Pets.petsOf("Alice");
    expect(pet.hunger).toBeLessThan(80);
    expect(pet.happiness).toBeLessThan(80);
  });

  test("tickPets journals critically hungry pets", () => {
    Pets.addPet("Bob", "kitten", 1555, { happiness: 50, hunger: 5 });
    const director = makeDirector([{ username: "Bob", kingdomId: "varrock" }]);

    const now = Date.now();
    PetLife.tickPets(director, now);
    PetLife.tickPets(director, now + 24 * 3600 * 1000);

    const hungry = director._journaled.filter((j) => j.msg.includes("starving"));
    expect(hungry.length).toBeGreaterThan(0);
  });

  test("tickPets skips citizens with no pets", () => {
    const director = makeDirector([{ username: "Cara", kingdomId: "varrock" }]);
    expect(() => PetLife.tickPets(director, Date.now())).not.toThrow();
    expect(director._journaled).toHaveLength(0);
  });

  test("tickPets handles corrupt records gracefully", () => {
    const director = makeDirector([null, {}, { username: "" }]);
    expect(() => PetLife.tickPets(director, Date.now())).not.toThrow();
  });
});
