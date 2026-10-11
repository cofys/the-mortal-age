"use strict";

/**
 * WartimePvp.Kingdoms — wartime open PvP in kingdom territory.
 *
 * Design (Jon, 2026-10-11): when two kingdoms are at war, their subjects
 * may fight each other on either kingdom's territory — the roads the
 * territory warning already calls unsafe. Capitals and frontier towns
 * stay true safe zones even mid-war. Peace, neutrality, same-kingdom and
 * kingdomless pairs are untouched: outside the Wilderness the engine's
 * default for player pairs is "cannot attack", and this module only ever
 * lifts that for a lawful wartime pair on lawful ground.
 *
 * This module is the ONE home of the rule. Three callers:
 *   - Areas.Kingdoms: each KingdomArea's canAttack() asks here, and its
 *     process() drives the client Attack option from isHotGround().
 *   - GuardPatrol (citizens): a witnessed "assault" that isLawfulWarFight
 *     is lawful war, not a crime — no hatred, no bounty, no goodwill hit.
 *   - Tests.
 *
 * The war state is the real one: KingdomStore.getActiveWars() (the same
 * records WarResolution resolves). When a war ends — resolution, treaty,
 * expiry — the records stop being active and every answer here flips
 * back the same tick. Nothing is cached across calls except the town and
 * territory tables, which are static data.
 *
 * No skull system outside the Wilderness: wartime kills use standard
 * engine death rules (keep 3-4 by value) and feed the hooks that already
 * exist (Tension's cross-kingdom PK tension/influence). Kills never post
 * bounties — bounties come from crimes, and lawful war is not one.
 */

const Store = require("./KingdomStore");
const Membership = require("./Membership.Kingdoms");

const WARTIME_PVP_CONFIG = Object.freeze({
  /** Town safe-zone radius (Chebyshev tiles) around a capital's square. */
  TOWN_SAFE_RADIUS_CAPITAL: 70,
  /** Town safe-zone radius (Chebyshev tiles) around a settlement's square. */
  TOWN_SAFE_RADIUS_SETTLEMENT: 36,
  /** The client's "you may attack players here" switch (Wilderness parity). */
  VARBIT_IN_WILDERNESS: 5963,
  /** Player interaction-option slot the Attack option lives in. */
  ATTACK_OPTION_INDEX: 2,
});

// --- static tables (lazy: load order must never couple plugins) --------------

let townsCache = null;
function towns() {
  if (!townsCache) {
    try {
      townsCache = require("../housing/HousingPortals").TOWNS ?? [];
    } catch {
      townsCache = [];
    }
  }
  return townsCache;
}

let territoriesCache = null;
function territories() {
  if (!territoriesCache) {
    try {
      territoriesCache = require("./Areas.Kingdoms").KINGDOM_TERRITORIES ?? [];
    } catch {
      territoriesCache = [];
    }
  }
  return territoriesCache;
}

// --- small helpers -------------------------------------------------------------

/** Normalize a mobile or a location into a plain { x, y, z }, or null. */
function locOf(mobileOrLocation) {
  try {
    const loc = mobileOrLocation?.getLocation
      ? mobileOrLocation.getLocation()
      : mobileOrLocation;
    if (!loc) return null;
    const x = loc.x ?? loc.getX?.();
    const y = loc.y ?? loc.getY?.();
    const z = loc.z ?? loc.getZ?.() ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, z: Number.isFinite(z) ? z : 0 };
  } catch {
    return null;
  }
}

/** The actor's kingdom id ("kingdom:id"), or null when kingdomless. */
function kingdomOfActor(mobile) {
  try {
    const id = mobile?.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE);
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** The active war record between two kingdoms, or null. */
function findWar(a, b, wars) {
  if (!a || !b || a === b) return null;
  const list = wars ?? Store.getActiveWars();
  return (
    list.find(
      (w) =>
        (w.attackerId === a && w.defenderId === b) ||
        (w.attackerId === b && w.defenderId === a)
    ) ?? null
  );
}

/** True when the two kingdoms have an active war. */
function atWar(a, b, wars) {
  return findWar(a, b, wars) !== null;
}

/**
 * The town safe zone covering this location, or null. Towns are the 13
 * HousingPortals towns (5 capitals + 8 frontier settlements): a square of
 * TOWN_SAFE_RADIUS_* around the town square, all building floors above a
 * surface town included (underground areas use offset y bands, so a
 * same-x/y tile below ground is never matched by accident).
 */
function townSafeAt(mobileOrLocation) {
  const p = locOf(mobileOrLocation);
  if (!p) return null;
  for (const town of towns()) {
    const radius =
      town.kind === "capital"
        ? WARTIME_PVP_CONFIG.TOWN_SAFE_RADIUS_CAPITAL
        : WARTIME_PVP_CONFIG.TOWN_SAFE_RADIUS_SETTLEMENT;
    const floorOk = town.z === 0 ? p.z >= 0 && p.z <= 3 : p.z === town.z;
    if (!floorOk) continue;
    if (Math.max(Math.abs(p.x - town.x), Math.abs(p.y - town.y)) <= radius) {
      return town;
    }
  }
  return null;
}

/** The kingdom territory id containing this location, or null. */
function territoryAt(mobileOrLocation) {
  const p = locOf(mobileOrLocation);
  if (!p) return null;
  for (const def of territories()) {
    if (!def.heights.includes(p.z)) continue;
    for (const [x1, x2, y1, y2] of def.rects) {
      if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) return def.id;
    }
  }
  return null;
}

// --- the rule ------------------------------------------------------------------

/**
 * The wartime canAttack matrix for one pair, judged from the territory
 * whose Area is being asked (core asks the attacker's area, then the
 * target's — the answer is the same from either side of the pair's own
 * ground, and "no opinion" everywhere else):
 *
 *   - either side not a player actor (NPCs are not subjects)  -> null
 *   - either side kingdomless, or same kingdom                -> null
 *   - no active war between the two kingdoms                  -> null
 *   - territory is neither side's kingdom                     -> null
 *   - either side inside a town safe zone                     -> false
 *   - otherwise                                               -> true
 *
 * Returning null outside the lawful case is what keeps peacetime safe:
 * the engine default for a player pair with no opinion is CANT_ATTACK.
 */
function wartimeCanAttack(attacker, target, territoryId) {
  if (attacker?.isPlayer?.() !== true || target?.isPlayer?.() !== true) {
    return null;
  }
  const attackerKingdom = kingdomOfActor(attacker);
  const targetKingdom = kingdomOfActor(target);
  if (!attackerKingdom || !targetKingdom || attackerKingdom === targetKingdom) {
    return null;
  }
  if (!findWar(attackerKingdom, targetKingdom)) return null;
  if (territoryId !== attackerKingdom && territoryId !== targetKingdom) {
    return null;
  }
  if (townSafeAt(attacker) || townSafeAt(target)) return false;
  return true;
}

/**
 * Is this fight lawful war? Used by the crime hooks (GuardPatrol's
 * assault witness): two subjects of warring kingdoms fighting on either
 * kingdom's territory, outside the town safe zones. The fight's ground
 * is read from the actors' live locations — victim first, assailant as
 * fallback — because no Area instance is at hand there.
 */
function isLawfulWarFight(assailant, victim) {
  const assailantKingdom = kingdomOfActor(assailant);
  const victimKingdom = kingdomOfActor(victim);
  if (!assailantKingdom || !victimKingdom || assailantKingdom === victimKingdom) {
    return false;
  }
  if (!findWar(assailantKingdom, victimKingdom)) return false;
  const territoryId = territoryAt(victim) ?? territoryAt(assailant);
  if (territoryId !== assailantKingdom && territoryId !== victimKingdom) {
    return false;
  }
  if (townSafeAt(assailant) || townSafeAt(victim)) return false;
  return true;
}

/**
 * Is this ground "hot" for this player — should their client show the
 * Attack option here? True when the player's kingdom is at war with the
 * territory's kingdom (an invader's ground), or the player stands on
 * their own kingdom's ground while it has any active war (home defense).
 * Town safe zones are never hot. Third-party and kingdomless players
 * never see the option: nobody here is a lawful target for them.
 */
function isHotGround(player, territoryId) {
  const kingdom = kingdomOfActor(player);
  if (!kingdom || !territoryId) return false;
  if (townSafeAt(player)) return false;
  const wars = Store.getActiveWars();
  if (kingdom === territoryId) {
    return wars.some((w) => w.attackerId === kingdom || w.defenderId === kingdom);
  }
  return findWar(kingdom, territoryId, wars) !== null;
}

// --- client signal ---------------------------------------------------------------

// player -> true while the wartime Attack option is shown. Sends happen
// only on flips (the Wilderness plugin's lastWildernessState pattern), so
// a player standing still costs two map reads a tick and no packets.
const uiShown = new WeakMap();

/**
 * Drive the client's "you may attack players here" switch the way the
 * Wilderness plugin does: varbit 5963 plus the Attack interaction option.
 * The pvp_icons overlay is NOT driven from here — it is owned by the
 * Wilderness plugin and keyed to real PvP ground; faking a skull over a
 * kingdom road would lie about the Wilderness level row it carries. The
 * honest signals are the option itself, the varbit, and the territory
 * entry warning that already fires.
 */
function syncWartimeUi(player, hot) {
  if (!player || player.isPlayerBot?.() === true) return;
  const shown = uiShown.get(player) === true;
  if (shown === hot) return;
  uiShown.set(player, hot);
  try {
    const sender = player.getPacketSender?.();
    if (!sender) return;
    sender.sendVarbit?.(WARTIME_PVP_CONFIG.VARBIT_IN_WILDERNESS, hot ? 1 : 0);
    sender.sendInteractionOption?.(
      hot ? "Attack" : "null",
      WARTIME_PVP_CONFIG.ATTACK_OPTION_INDEX,
      true
    );
  } catch {
    // The option is a courtesy; combat legality never depends on it.
  }
}

/** Reset the signal without sending packets to a logging-out player. */
function clearWartimeUi(player, logout) {
  if (!player) return;
  if (logout) {
    uiShown.delete(player);
    return;
  }
  syncWartimeUi(player, false);
}

module.exports = {
  WARTIME_PVP_CONFIG,
  kingdomOfActor,
  findWar,
  atWar,
  townSafeAt,
  territoryAt,
  wartimeCanAttack,
  isLawfulWarFight,
  isHotGround,
  syncWartimeUi,
  clearWartimeUi,
};
// Test seams.
module.exports._test = {
  locOf,
  seedTowns(list) {
    townsCache = list;
  },
  seedTerritories(list) {
    territoriesCache = list;
  },
  resetUi(player) {
    uiShown.delete(player);
  },
};
