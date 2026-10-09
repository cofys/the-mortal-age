"use strict";

/**
 * CitizenPetLife — the slow-tick dynamics for citizen pets and mounts.
 *
 * WHAT IT DOES (slow tick, free):
 *   - Hunger/happiness decay for every citizen's pets (1 tick = 1 day
 *     of pet time, scaled by real elapsed time).
 *   - Critically hungry pets are journaled so the LLM mouth can mention
 *     them ("my cat hasn't eaten in days").
 *   - Breeding: when two happy same-type pets exist in the same kingdom,
 *     a kitten/baby may be born — the real baby pet item is awarded via
 *     the Pets plugin's awardPet, same path as real players.
 *   - Taming: hunters with real Hunter 20+ may tame a wild pet — again
 *     via the real awardPet path.
 *   - Announcements: notable pet events (birth, taming) via sayPublic
 *     near real players, journaled for the LLM mouth.
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. No invented pets. No invented food.
 *   - Never touches lib/*2 (frozen).
 *   - Never throws: one bad citizen never breaks the tick.
 */

const Pets = require("./CitizenPets");
const { normalizeName } = require("./CitizenBonds");
const { sayPublic } = require("../chat/CitizenSayPublic");

// A citizen's pets get attention at most this often per slow tick pass.
const TAME_CHANCE = 0.05; // per eligible hunter per tick
const BREED_CHANCE = 0.1; // per eligible pair per tick

let lastTickMs = 0;

/**
 * The slow tick entry. director: the CitizenDirector. nowMs: real time.
 * Never throws.
 */
function tickPets(director, nowMs) {
  try {
    const elapsedMs = lastTickMs ? nowMs - lastTickMs : 0;
    lastTickMs = nowMs;
    const daysElapsed = Math.max(0, elapsedMs / (24 * 3600 * 1000));

    const roster = director.roster?.values?.() ?? [];
    for (const record of roster) {
      try {
        if (!record || !record.username) continue;
        const username = record.username;

        // 1. Decay hunger/happiness. Journal the critically hungry.
        const critical = daysElapsed > 0 ? Pets.decayPets(username, daysElapsed) : [];
        for (const pet of critical) {
          journalPetEvent(director, record, "hungry", pet);
        }

        // 2. Breeding: find another same-kingdom citizen with a happy
        //    same-type pet. Keep it rare and honest.
        maybeBreed(director, record);

        // 3. Taming: hunters may tame a wild pet.
        maybeTame(director, record);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    Pets.save();
  } catch {
    // The tick itself never throws.
  }
}

/**
 * Breeding check for one citizen's pets against the roster.
 * Two same-type happy pets in the same kingdom may produce a baby.
 */
function maybeBreed(director, record) {
  try {
    const myPets = Pets.petsOf(record.username);
    if (!myPets.length) return;

    const roster = director.roster?.values?.() ?? [];
    for (const myPet of myPets) {
      if (Math.random() >= BREED_CHANCE) continue;
      // Find a partner: same type, different owner, same kingdom.
      for (const other of roster) {
        if (!other || other.username === record.username) continue;
        if ((other.kingdomId || "") !== (record.kingdomId || "")) continue;
        const theirPets = Pets.petsOf(other.username);
        const partner = theirPets.find((p) => p.type === myPet.type);
        if (!partner) continue;

        const reason = Pets.breedCheck(myPet, partner);
        if (reason) continue;

        // Breed! Record it, award the real baby item to the owner.
        if (!Pets.recordBreeding(myPet, partner)) continue;
        const babyItemId = Pets.babyItemIdFor(myPet.type);
        if (babyItemId) {
          awardPetToCitizen(director, record, babyItemId);
          Pets.addPet(record.username, myPet.type === "kitten" ? "kitten" : myPet.type, babyItemId, {
            name: `baby ${myPet.type}`,
            happiness: 80,
            hunger: 80,
          });
          journalPetEvent(director, record, "born", myPet);
          announceNearPlayers(director, record, `${cap(record.username)}'s ${myPet.type} had a baby!`);
        }
        return; // one breeding per citizen per tick
      }
    }
  } catch {
    // Breeding never breaks the tick.
  }
}

/**
 * Taming check. Hunters with real Hunter 20+ may tame a wild pet.
 * The pet item comes from the real Pets plugin — never invented.
 */
function maybeTame(director, record) {
  try {
    if (Math.random() >= TAME_CHANCE) return;
    const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
    if (!bot) return;
    if (!Pets.canTame(bot)) return;

    // Pick a tameable pet type. Cats are the classic starter.
    const type = "kitten";
    const itemId = Pets.babyItemIdFor("cat");
    if (!itemId) return;

    awardPetToCitizen(director, record, itemId);
    Pets.addPet(record.username, "kitten", itemId, {
      name: "kitten",
      tamedBy: record.username,
    });
    journalPetEvent(director, record, "tamed", { type, itemId });
    announceNearPlayers(director, record, `${cap(record.username)} tamed a wild kitten!`);
  } catch {
    // Taming never breaks the tick.
  }
}

/**
 * Award a real pet item to a citizen's bot via the Pets plugin.
 * Defensive: the plugin may not be loaded; a missing plugin is a no-op.
 */
function awardPetToCitizen(director, record, itemId) {
  try {
    const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
    if (!bot) return false;
    // The Pets plugin exposes awardPet via its module. Try the direct
    // require first (same process), fall back to a custom event.
    try {
      const PetsPlugin = require("../../npcs/Pets.plugin.js");
      const api = PetsPlugin.__internals;
      if (api?.awardPet) {
        api.awardPet(bot, itemId);
        return true;
      }
    } catch {
      // Fall through to the event path.
    }
    // Event fallback: the Pets plugin listens for pet awards.
    director.emitCustomEvent?.("pets:award", { player: bot, itemId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Journal a pet event so the LLM mouth can mention it.
 * Defensive: the journal may not exist.
 */
function journalPetEvent(director, record, kind, pet) {
  try {
    const journal = director.getJournal?.();
    if (!journal?.log) return;
    const messages = {
      hungry: `${record.username}'s ${pet.type || "pet"} is starving — it hasn't been fed.`,
      born: `${record.username}'s ${pet.type || "pet"} had a baby!`,
      tamed: `${record.username} tamed a wild ${pet.type || "pet"}.`,
    };
    journal.log(record.username, messages[kind] || `${record.username}'s pet: ${kind}.`);
  } catch {
    // Journaling never breaks the tick.
  }
}

/**
 * Announce near real players via sayPublic. Defensive: no players
 * nearby means no announcement — never invented audience.
 */
function announceNearPlayers(director, record, message) {
  try {
    const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
    if (!bot) return;
    sayPublic(bot, message);
  } catch {
    // Announcements never break the tick.
  }
}

function cap(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function resetForTests() {
  lastTickMs = 0;
}

module.exports = {
  tickPets,
  resetForTests,
};
