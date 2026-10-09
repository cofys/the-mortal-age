"use strict";

/**
 * CitizenPetCare — the brain action for feeding and playing with pets.
 *
 * WHAT IT DOES:
 *   - The citizen feeds their hungriest pet: removes a REAL food item
 *     from their real inventory (fish for cats, meat for dogs, seeds
 *     for birds, hay/produce for horses) and records the feeding.
 *   - Plays with their saddest pet: boosts happiness, no items needed.
 *   - Human-paced: one care action per run, then done. A human doesn't
 *     spend all day fussing over pets — they feed, play a bit, move on.
 *
 * WHAT IT DOES NOT DO:
 *   - No invented food. No food in inventory → the action ends honestly.
 *   - No LLM. Zero.
 */

const Pets = require("../../lib/CitizenPets");

const ACTION_ID = "citizenPetCare";
const GIVE_UP_MS = 10 * 60 * 1000; // 10 minutes, then give up honestly

// Real food item ids by pet food type. These are engine item ids for
// common foods — the citizen must actually HAVE them.
const FOOD_ITEMS = Object.freeze({
  fish: [331, 333, 335, 339, 341], // raw sardine, trout, salmon, cod, etc.
  meat: [2142, 2144, 4293], // cooked meat, chicken
  seed: [5312, 5313, 5314], // acorn, apple tree seed, willow seed
  hay: [5315, 5316], // barley seed, jute seed (grain for horses)
});

function createCitizenPetCareAction(deps = {}) {
  const {
    inventoryOf = (player) => player?.getInventory?.(),
    sayPublic = () => {},
  } = deps;

  return {
    id: ACTION_ID,

    /**
     * The brain calls this to run the action. player: the citizen bot.
     * Returns a result object the brain understands.
     */
    async run(player, ctx = {}) {
      const startedAt = ctx.startedAt || Date.now();
      if (Date.now() - startedAt > GIVE_UP_MS) {
        return { ok: true, done: true, reason: "give-up" };
      }

      const username = player?.getUsername?.() || player?.username || "citizen";
      const pets = Pets.petsOf(username);
      if (!pets.length) {
        return { ok: true, done: true, reason: "no-pets" };
      }

      // Feed the hungriest pet first.
      const hungriest = [...pets].sort((a, b) => a.hunger - b.hunger)[0];
      if (hungriest && hungriest.hunger < 70) {
        const fed = feedRealFood(player, hungriest);
        if (fed) {
          Pets.feedPet(username, hungriest.itemId);
          return { ok: true, done: true, reason: "fed", pet: hungriest.type };
        }
        // No real food — be honest about it.
        return { ok: true, done: true, reason: "no-food" };
      }

      // Play with the saddest pet.
      const saddest = [...pets].sort((a, b) => a.happiness - b.happiness)[0];
      if (saddest && saddest.happiness < 80) {
        Pets.playWithPet(username, saddest.itemId);
        return { ok: true, done: true, reason: "played", pet: saddest.type };
      }

      return { ok: true, done: true, reason: "pets-happy" };
    },
  };
}

/**
 * Remove one real food item for the pet's food type from the citizen's
 * real inventory. Returns true if food was consumed.
 */
function feedRealFood(player, pet) {
  try {
    const catalog = Pets.PET_CATALOG[pet.type];
    if (!catalog) return false;
    const foodIds = FOOD_ITEMS[catalog.food] || [];
    const inv = player?.getInventory?.();
    if (!inv) return false;
    for (const itemId of foodIds) {
      try {
        if (inv.contains?.(itemId)) {
          inv.deleteNumber?.(itemId, 1);
          return true;
        }
        // Fallback: some inventories use different APIs.
        const items = inv.getItems?.() || [];
        const found = items.find((it) => it?.getId?.() === itemId || it?.id === itemId);
        if (found) {
          inv.remove?.(found, 1);
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  createCitizenPetCareAction,
  ACTION_ID,
  FOOD_ITEMS,
};
