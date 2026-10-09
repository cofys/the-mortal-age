"use strict";

/**
 * CitizenPets.test.js — data tier tests. Plain node, no engine needed.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Pets = require("./CitizenPets");

const TMP_SAVE = path.join(os.tmpdir(), `citizen-pets-test-${process.pid}.json`);

beforeEach(() => {
  Pets._setSavePathForTests(TMP_SAVE);
  Pets.resetForTests();
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.unlinkSync(TMP_SAVE); } catch { /* ignore */ }
});

describe("CitizenPets", () => {
  test("PET_CATALOG has real item ids for all pet types", () => {
    expect(Pets.PET_CATALOG.kitten.itemIds).toContain(1555);
    expect(Pets.PET_CATALOG.cat.itemIds).toContain(1561);
    expect(Pets.PET_CATALOG.dog.itemIds.length).toBeGreaterThan(0);
    expect(Pets.PET_CATALOG.bird.itemIds.length).toBeGreaterThan(0);
    expect(Pets.PET_CATALOG.horse.itemIds.length).toBeGreaterThan(0);
    expect(Pets.PET_CATALOG.horse.mount).toBe(true);
    expect(Pets.PET_CATALOG.cat.mount).toBe(false);
  });

  test("addPet / petsOf round-trips", () => {
    const pet = Pets.addPet("Alice", "kitten", 1555, { name: "Mittens" });
    expect(pet).not.toBeNull();
    expect(pet.name).toBe("Mittens");
    expect(Pets.petsOf("Alice")).toHaveLength(1);
    expect(Pets.petsOf("alice")).toHaveLength(1); // normalized
  });

  test("addPet rejects unknown types and wrong item ids", () => {
    expect(Pets.addPet("Bob", "dragon", 99999)).toBeNull();
    expect(Pets.addPet("Bob", "kitten", 99999)).toBeNull(); // not a kitten item
    expect(Pets.petsOf("Bob")).toHaveLength(0);
  });

  test("removePet removes by item id", () => {
    Pets.addPet("Cara", "kitten", 1555);
    Pets.addPet("Cara", "kitten", 1556);
    expect(Pets.removePet("Cara", 1555)).toBe(true);
    expect(Pets.petsOf("Cara")).toHaveLength(1);
    expect(Pets.removePet("Cara", 99999)).toBe(false);
  });

  test("hasMount / travelSpeedFor", () => {
    Pets.addPet("Dan", "kitten", 1555);
    expect(Pets.hasMount("Dan")).toBe(false);
    expect(Pets.travelSpeedFor("Dan")).toBe(1.0);

    Pets.addPet("Erin", "horse", 19764);
    expect(Pets.hasMount("Erin")).toBe(true);
    expect(Pets.travelSpeedFor("Erin")).toBe(Pets.MOUNT_TRAVEL_MULTIPLIER);
    expect(Pets.travelSpeedFor("Erin")).toBeLessThan(1.0); // faster
  });

  test("mountedCombatBonusFor", () => {
    expect(Pets.mountedCombatBonusFor("nobody")).toBe(0);
    Pets.addPet("Frank", "horse", 19764);
    expect(Pets.mountedCombatBonusFor("Frank")).toBe(Pets.MOUNT_COMBAT_BONUS);
  });

  test("moodBonusFor: happy pets lift mood, starving pets drag it", () => {
    Pets.addPet("Gail", "kitten", 1555, { happiness: 90, hunger: 90 });
    expect(Pets.moodBonusFor("Gail")).toBe(Pets.MOOD_BONUS_PER_HAPPY_PET);

    Pets.addPet("Hank", "kitten", 1555, { happiness: 10, hunger: 10 });
    expect(Pets.moodBonusFor("Hank")).toBe(-Pets.MOOD_BONUS_PER_HAPPY_PET);

    expect(Pets.moodBonusFor("nobody")).toBe(0);
  });

  test("feedPet restores hunger and boosts happiness", () => {
    Pets.addPet("Ivy", "kitten", 1555, { happiness: 50, hunger: 20 });
    expect(Pets.feedPet("Ivy", 1555)).toBe(true);
    const [pet] = Pets.petsOf("Ivy");
    expect(pet.hunger).toBe(20 + Pets.FEED_HUNGER_RESTORE);
    expect(pet.happiness).toBe(50 + Pets.FEED_HAPPINESS_BOOST);
    expect(Pets.feedPet("Ivy", 99999)).toBe(false);
  });

  test("playWithPet boosts happiness", () => {
    Pets.addPet("Jack", "dog", 19760, { happiness: 40 });
    expect(Pets.playWithPet("Jack", 19760)).toBe(true);
    expect(Pets.petsOf("Jack")[0].happiness).toBe(40 + Pets.PLAY_HAPPINESS_BOOST);
  });

  test("decayPets decays hunger/happiness and flags critical", () => {
    Pets.addPet("Kim", "kitten", 1555, { happiness: 80, hunger: 30 });
    const critical = Pets.decayPets("Kim", 1);
    const [pet] = Pets.petsOf("Kim");
    expect(pet.hunger).toBe(30 - Pets.HUNGER_DECAY_PER_DAY);
    expect(pet.happiness).toBeLessThan(80);
    expect(critical).toHaveLength(1); // hunger 5 < 20
  });

  test("breedCheck: same type, happy, no cooldown → null", () => {
    const a = { type: "kitten", happiness: 80, bredAt: 0 };
    const b = { type: "kitten", happiness: 80, bredAt: 0 };
    expect(Pets.breedCheck(a, b)).toBeNull();
  });

  test("breedCheck rejects mismatches", () => {
    const happy = { type: "kitten", happiness: 80, bredAt: 0 };
    expect(Pets.breedCheck(happy, { type: "dog", happiness: 80, bredAt: 0 })).toBe("different species");
    expect(Pets.breedCheck(happy, { type: "kitten", happiness: 10, bredAt: 0 })).toBe("unhappy");
    expect(Pets.breedCheck(null, happy)).toBe("missing pet");
  });

  test("breedCheck enforces cooldown", () => {
    const now = Date.now();
    const a = { type: "kitten", happiness: 80, bredAt: now };
    const b = { type: "kitten", happiness: 80, bredAt: 0 };
    expect(Pets.breedCheck(a, b)).toBe("cooldown");
  });

  test("recordBreeding sets bredAt on both", () => {
    const a = { type: "kitten", happiness: 80, bredAt: 0 };
    const b = { type: "kitten", happiness: 80, bredAt: 0 };
    expect(Pets.recordBreeding(a, b)).toBe(true);
    expect(a.bredAt).toBeGreaterThan(0);
    expect(b.bredAt).toBeGreaterThan(0);
    // Second breeding immediately fails (cooldown).
    expect(Pets.recordBreeding(a, b)).toBe(false);
  });

  test("babyItemIdFor returns real kitten item", () => {
    expect(Pets.babyItemIdFor("cat")).toBe(1555);
    expect(Pets.babyItemIdFor("kitten")).toBe(1555);
    expect(Pets.babyItemIdFor("dog")).toBe(Pets.PET_CATALOG.dog.itemIds[0]);
    expect(Pets.babyItemIdFor("dragon")).toBeNull();
  });

  test("canTame requires Hunter 20+", () => {
    const lowHunter = { getSkillManager: () => ({ getCurrentLevel: () => 10 }) };
    const highHunter = { getSkillManager: () => ({ getCurrentLevel: () => 35 }) };
    expect(Pets.canTame(lowHunter)).toBe(false);
    expect(Pets.canTame(highHunter)).toBe(true);
    expect(Pets.canTame(null)).toBe(false);
    expect(Pets.canTame({})).toBe(false);
  });

  test("save/load round-trips", () => {
    Pets.addPet("Liam", "kitten", 1555, { name: "Whiskers" });
    Pets.save();
    expect(fs.existsSync(TMP_SAVE)).toBe(true);

    Pets.resetForTests();
    expect(Pets.petsOf("Liam")).toHaveLength(0);

    Pets.load();
    const pets = Pets.petsOf("Liam");
    expect(pets).toHaveLength(1);
    expect(pets[0].name).toBe("Whiskers");
  });
});
