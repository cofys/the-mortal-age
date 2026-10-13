"use strict";

/**
 * CitizenLoot — citizens pick up what they kill.
 *
 * Jon 2026-10-13: citizens walked away from monster drops; a real player loots.
 *
 * Hooks the engine's "npc-drops:roll" custom event (NpcDrops.dropFor): when
 * the killer is a player bot, the rolled drops are stashed as a pending loot
 * run. The director slow tick (tickCitizenLoot) then walks the citizen to
 * each drop and picks it up through the REAL engine pickup path —
 * MovementQueue.walkToGroundItem + ItemOnGroundManager.pickup, exactly what
 * PickupItemPacketListener does for a player clicking a ground item. No
 * teleports, no conjured items.
 *
 * Player-like judgment, not a vacuum cleaner:
 *   - bones always (they feed the existing prayer bone-offering training),
 *   - food always (heals are survival),
 *   - valuables at/above LOOT_VALUE_THRESHOLD always,
 *   - stackables they already carry (top up the stack),
 *   - cheap junk sometimes, weighted by personality greed — sometimes it
 *     stays on the ground, like a real player deciding it's not worth it.
 * Inventory-full stops the run; the existing citizen_bank loop handles
 * banking. A citizen mid-fight doesn't wander off to loot.
 *
 * Data tier, zero LLM. Tick-safe: every engine read wrapped in try/catch.
 */

const { normalizeName } = require("../../lib/CitizenBonds");

// Lazy TS requires (module must load under plain node for unit tests; the
// server runtime resolves these like every other plugin).
function tsLocation() {
  try {
    return require("../../../../src/main/typescript/elvarg/game/model/Location").Location;
  } catch {
    return null;
  }
}

function tsItemDefinition() {
  try {
    return require("../../../../src/main/typescript/elvarg/game/definition/ItemDefinition").ItemDefinition;
  } catch {
    return null;
  }
}

const LOOT_VALUE_THRESHOLD = 500; // total stack value worth bending over for
const LOOT_STALE_MS = 10 * 60 * 1000; // a loot run older than this is abandoned
const LOOT_SCAN_RADIUS = 2; // chebyshev tiles around the kill to find the drop
const LOOT_START_DELAY_MS = 2500; // humans loot after the fight, not during

// Bones feed the prayer training (CitizenPrayer boneXp): bones, big bones.
const BONE_IDS = new Set([526, 532]);

let pluginApi = null;
let groundItems = null; // ItemOnGroundManager (statics), lazy

/** username -> { items:[{id,amount,left}], x,y,z, at } */
const pendingLoot = new Map();

function manager() {
  if (!groundItems) {
    try {
      groundItems = pluginApi?.getItemOnGroundManager?.() ?? null;
    } catch {
      groundItems = null;
    }
  }
  return groundItems;
}

function initCitizenLoot(api) {
  pluginApi = api ?? pluginApi;
}

/** Engine truth: is this entity one of our player bots? */
function isBotEntity(player) {
  try {
    return player?.isPlayerBot?.() === true;
  } catch {
    return false;
  }
}

function botOf(username) {
  try {
    const { getDirector } = require("../../director/CitizenDirector");
    const director = getDirector?.();
    if (!director) return null;
    const record = director.roster?.get?.(normalizeName(username));
    if (!record || !director.isOnline?.(record)) return null;
    return director.getBot?.(record) ?? null;
  } catch {
    return null;
  }
}

function personalityOf(username) {
  try {
    const { getDirector } = require("../../director/CitizenDirector");
    const director = getDirector?.();
    const record = director?.roster?.get?.(normalizeName(username));
    return record?.personality ?? {};
  } catch {
    return {};
  }
}

function foodIds() {
  try {
    const foods = require("../../../items/Food.plugin.js").FOOD ?? null;
    return foods instanceof Map ? foods : null;
  } catch {
    return null;
  }
}

function itemValue(id) {
  try {
    return tsItemDefinition()?.forId(id)?.getValue?.() ?? 0;
  } catch {
    return 0;
  }
}

function isStackable(id) {
  try {
    return tsItemDefinition()?.forId(id)?.isStackable?.() === true;
  } catch {
    return false;
  }
}

/** The noted form of a drop (NpcDrops registers noted drops under the note id). */
function noteIdOf(id) {
  try {
    const noteId = tsItemDefinition()?.forId(id)?.getNoteId?.();
    return Number.isInteger(noteId) && noteId >= 0 ? noteId : null;
  } catch {
    return null;
  }
}

/**
 * Would this citizen bother picking up `amount` of `id`? Bones, food,
 * valuables, and stack top-ups are always worth it; junk is a
 * personality-weighted maybe.
 */
function shouldTake(bot, personality, id, amount) {
  if (BONE_IDS.has(id)) return true;
  try {
    const foods = foodIds();
    if (foods?.has(id) && (foods.get(id)?.heal ?? 0) > 0) return true;
  } catch {
    // fall through to value judgment
  }
  try {
    if (itemValue(id) * amount >= LOOT_VALUE_THRESHOLD) return true;
  } catch {
    // fall through
  }
  try {
    if (isStackable(id) && bot?.getInventory?.()?.contains?.(id)) return true;
  } catch {
    // fall through
  }
  // Junk: greedy citizens grab it, others often leave it.
  let greed = 0.15;
  try {
    const traits = new Set(personality?.traits ?? []);
    const demeanor = String(personality?.demeanor ?? "");
    if (traits.has("greedy") || traits.has("miserly") || demeanor.includes("greedy")) {
      greed = 0.6;
    } else if (traits.has("generous") || traits.has("proud")) {
      greed = 0.05;
    }
  } catch {
    // default greed
  }
  return Math.random() < greed;
}

/**
 * "npc-drops:roll" handler. Stash the rolled drops as a pending loot run
 * when the killer is a bot. The drops land as ground items registered under
 * the killer's username; the tick finds them by area scan around the kill.
 */
function onCitizenDropsRolled(event) {
  try {
    const { player, npc, drops } = event ?? {};
    if (!isBotEntity(player)) return;
    if (!Array.isArray(drops) || drops.length === 0) return;
    const username = player.getUsername?.();
    if (!username) return;
    let x = null;
    let y = null;
    let z = 0;
    try {
      const loc = npc?.getLocation?.() ?? player?.getLocation?.();
      x = loc?.getX?.();
      y = loc?.getY?.();
      z = loc?.getZ?.() ?? 0;
    } catch {
      // no position — can't loot what we can't find
    }
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    pendingLoot.set(username, {
      items: drops
        .filter((d) => Number.isInteger(d?.itemId) && (d?.amount ?? 0) > 0)
        .map((d) => ({ id: d.itemId, amount: d.amount, left: d.amount })),
      x,
      y,
      z,
      at: Date.now(),
    });
  } catch {
    // A missed loot run is cosmetic, never fatal.
  }
}

function botBusy(bot) {
  try {
    const combat = bot?.getCombat?.();
    if (combat?.getTarget?.() || combat?.getAttacker?.()) return true;
  } catch {
    // fall through
  }
  try {
    if (bot?.busy?.() === true) return true;
  } catch {
    // fall through
  }
  return false;
}

function inventoryFullFor(bot, id) {
  try {
    const inv = bot?.getInventory?.();
    if (!inv) return true;
    if (inv.getFreeSlots?.() > 0) return false;
    // A full inventory can still take a stackable it already holds.
    return !(isStackable(id) && inv.contains?.(id));
  } catch {
    return true;
  }
}

/**
 * Find the citizen's ground item for `id` near (x, y, z): tries the id
 * itself and its noted form, scanning a small radius (drops can land a tile
 * or two off the corpse, e.g. boss-body relocation).
 */
function findGroundItem(mgr, username, id, x, y, z, privateArea) {
  const ids = [id];
  const noteId = noteIdOf(id);
  if (noteId !== null && noteId !== id) ids.push(noteId);
  const Loc = tsLocation();
  for (const tryId of ids) {
    for (let dx = -LOOT_SCAN_RADIUS; dx <= LOOT_SCAN_RADIUS; dx++) {
      for (let dy = -LOOT_SCAN_RADIUS; dy <= LOOT_SCAN_RADIUS; dy++) {
        try {
          const pos = Loc ? new Loc(x + dx, y + dy, z) : { getX: () => x + dx, getY: () => y + dy };
          const gi = mgr.getGroundItem(username, tryId, pos, privateArea);
          if (gi) return gi;
        } catch {
          // keep scanning
        }
      }
    }
  }
  return null;
}

/**
 * Director slow-tick: advance one pending loot run per citizen per tick.
 * One pickup per tick per citizen — human-paced, never a vacuum.
 *
 * @param {number} nowMs
 * @param {object} deps test seam: { botFor(username)->bot|null,
 *   personalityFor(username)->personality, groundItems }
 */
function tickCitizenLoot(nowMs = Date.now(), deps = {}) {
  const mgr = deps.groundItems ?? manager();
  if (!mgr) return;
  const botFor = deps.botFor ?? botOf;
  const personalityFor = deps.personalityFor ?? personalityOf;
  for (const [username, run] of pendingLoot) {
    try {
      if (nowMs - run.at > LOOT_STALE_MS) {
        pendingLoot.delete(username);
        continue;
      }
      // Humans loot after the fight, not during the death animation.
      if (nowMs - run.at < LOOT_START_DELAY_MS) continue;
      const bot = botFor(username);
      if (!bot) {
        pendingLoot.delete(username);
        continue;
      }
      if (botBusy(bot)) continue; // mid-fight: loot later

      const personality = personalityFor(username);
      let progressed = false;
      for (const item of run.items) {
        if (item.left <= 0) continue;
        if (!shouldTake(bot, personality, item.id, item.left)) {
          item.left = 0; // decided: not worth it, like a real player
          continue;
        }
        if (inventoryFullFor(bot, item.id)) {
          // Full — stop the run. The citizen_bank loop handles banking;
          // the run is dropped so we don't spin on a full inventory.
          run.items.forEach((i) => {
            i.left = 0;
          });
          progressed = true;
          break;
        }
        let privateArea = null;
        try {
          privateArea = bot.getPrivateArea?.() ?? null;
        } catch {
          // no private area
        }
        const gi = findGroundItem(mgr, username, item.id, run.x, run.y, run.z, privateArea);
        if (!gi) {
          item.left = 0; // gone (taken, despawned) — move on
          continue;
        }
        // Real pickup path: walk there, then the engine's own pickup.
        const pos = gi.getPosition().clone();
        try {
          bot.getMovementQueue().walkToGroundItem(pos, () => {
            try {
              mgr.pickup(bot, gi);
            } catch {
              // pickup is best-effort
            }
          });
        } catch {
          // movement failed — try again next tick
          continue;
        }
        item.left = Math.max(0, item.left - (gi.getItem().getAmount?.() ?? 1));
        progressed = true;
        break; // one pickup per tick per citizen
      }
      if (run.items.every((i) => i.left <= 0)) {
        pendingLoot.delete(username);
      }
    } catch {
      // One citizen's loot run never breaks the tick.
      try {
        pendingLoot.delete(username);
      } catch {
        // ignore
      }
    }
  }
}

/** Test seam. */
function _resetForTests() {
  pendingLoot.clear();
  groundItems = null;
  pluginApi = null;
}

module.exports = {
  initCitizenLoot,
  onCitizenDropsRolled,
  tickCitizenLoot,
  shouldTake,
  LOOT_VALUE_THRESHOLD,
  _resetForTests,
  _pendingLoot: pendingLoot,
};
