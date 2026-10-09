"use strict";

/**
 * CitizenCreateArt — the brain action for making art.
 *
 * WHAT IT DOES:
 *   - The citizen creates one artwork: picks the best medium they can
 *     afford (painting → sculpture → writing, by value), consumes REAL
 *     materials from their real inventory, and records the artwork.
 *   - Quality derives from their real Crafting level + creativity trait.
 *   - Masterpieces (85+) earn a real reputation deed and are journaled.
 *   - Human-paced: one artwork per run, then done. A human doesn't
 *     mass-produce art — they make a piece, then move on.
 *
 * WHAT IT DOES NOT DO:
 *   - No invented materials. No materials → the action ends honestly.
 *   - No LLM. Titles come from CitizenArt's word pools.
 *   - No fake items. Artworks are data records.
 */

const Art = require("../../lib/CitizenArt");

const ACTION_ID = "citizenCreateArt";
const GIVE_UP_MS = 10 * 60 * 1000; // 10 minutes, then give up honestly

// Preferred medium order (by base value, highest first).
const MEDIUM_PREFERENCE = ["sculpture", "painting", "writing"];

function createCitizenCreateArtAction(deps = {}) {
  const {
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
      const creativity = ctx.creativity ?? player?.personality?.creativity ?? 0.5;

      // Pick the best affordable medium.
      const mediumId = affordableMedium(player);
      if (!mediumId) {
        return { ok: true, done: true, reason: "no-materials" };
      }

      const craftingLevel = realCraftingLevel(player);
      const kingdomId = ctx.kingdomId ?? player?.kingdomId ?? "unknown";

      const art = Art.createArtwork(username, mediumId, craftingLevel, creativity, kingdomId);
      if (!art) {
        return { ok: true, done: true, reason: "create-failed" };
      }

      // Consume the real materials.
      consumeMaterials(player, mediumId);

      // Grant real Crafting XP for the work (art is craft).
      grantCraftingXp(player, mediumId);

      // Masterpieces earn fame.
      if (Art.isMasterpiece(art)) {
        try {
          const Rep = require("../../lib/CitizenReputation");
          Rep.addReputation?.(username, 5, "masterpiece", Date.now());
        } catch {
          // No reputation → no fame, art still exists.
        }
        try {
          sayPublic(`${username} has completed a masterpiece: "${art.title}"!`);
        } catch {
          // Announcement failure is not fatal.
        }
      }

      return { ok: true, done: true, reason: "created", artworkId: art.id, medium: mediumId };
    },
  };
}

/** Count of an item in inventory (defensive, multi-API). */
function countItem(inv, itemId) {
  try {
    if (!inv) return 0;
    if (typeof inv.getAmount === "function") return inv.getAmount(itemId) ?? 0;
    if (typeof inv.count === "function") return inv.count(itemId) ?? 0;
    if (typeof inv.contains === "function") return inv.contains(itemId) ? 1 : 0;
    return 0;
  } catch {
    return 0;
  }
}

/** Remove items from inventory (defensive, multi-API). Returns amount taken. */
function takeItem(inv, itemId, amount) {
  try {
    if (!inv) return 0;
    const have = countItem(inv, itemId);
    const take = Math.min(have, amount);
    if (take <= 0) return 0;
    if (typeof inv.deleteNumber === "function") inv.deleteNumber(itemId, take);
    else if (typeof inv.remove === "function") inv.remove(itemId, take);
    else if (typeof inv.delete === "function") inv.delete(itemId, take);
    else return 0;
    return take;
  } catch {
    return 0;
  }
}

/** Best affordable medium, or null. */
function affordableMedium(player) {
  const inv = player?.getInventory?.();
  if (!inv) return null;
  for (const mediumId of MEDIUM_PREFERENCE) {
    const medium = Art.ART_MEDIUMS[mediumId];
    if (!medium) continue;
    let ok = true;
    for (const mat of medium.materials) {
      const ids = mat.anyOf ?? [mat.item];
      const have = ids.reduce((sum, id) => sum + countItem(inv, id), 0);
      if (have < mat.amount) {
        ok = false;
        break;
      }
    }
    for (const tool of medium.tools ?? []) {
      if (countItem(inv, tool) < 1) {
        ok = false;
        break;
      }
    }
    if (ok) return mediumId;
  }
  return null;
}

function consumeMaterials(player, mediumId) {
  const medium = Art.ART_MEDIUMS[mediumId];
  if (!medium) return;
  const inv = player?.getInventory?.();
  if (!inv) return;
  for (const mat of medium.materials) {
    if (!mat.consumed) continue;
    let need = mat.amount;
    const ids = mat.anyOf ?? [mat.item];
    for (const id of ids) {
      if (need <= 0) break;
      need -= takeItem(inv, id, need);
    }
  }
}

function realCraftingLevel(player) {
  try {
    return player?.getSkills?.()?.getLevel?.("crafting") ?? player?.skills?.crafting ?? 1;
  } catch {
    return 1;
  }
}

/** Grant real Crafting XP — art is skilled craft work. */
function grantCraftingXp(player, mediumId) {
  try {
    const medium = Art.ART_MEDIUMS[mediumId];
    const xp = { painting: 40, sculpture: 60, writing: 30 }[mediumId] ?? 30;
    player?.getSkills?.()?.addXp?.("crafting", xp);
  } catch {
    // XP failure never breaks the action.
  }
}

module.exports = {
  createCitizenCreateArtAction,
  ACTION_ID,
};
