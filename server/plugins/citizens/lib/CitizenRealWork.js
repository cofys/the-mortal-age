"use strict";

/**
 * CitizenRealWork — Jon 2026-10-13: NO FAKE SKILLING. Citizens work ONLY
 * through real engine interactions:
 *
 *   fishing:    click a live "Fishing spot" NPC. The Fishing plugin then runs
 *               the session itself — real animation loop, real catches, real
 *               XP. A spot that relocates ends the session (as in OSRS); the
 *               driver re-scans and re-clicks the new position like a player.
 *   woodcutting: click a real tree object ("Chop down"). The Woodcutting
 *               plugin runs the session; a felled tree ends it and the
 *               driver moves to the next tree.
 *   mining:     click a real rock object ("Mine"). Same deal via the Mining
 *               plugin; depleted rocks are skipped like a player would.
 *
 * No live target in reach: the citizen does NOT work — no animation, no
 * conjured items, no XP. Standing at the bank waiting for a spot is honest;
 * animating on grass is not.
 *
 * The drivers are used by skilling sessions (lib/CitizenSkilling), whose
 * members' brains are busy following the party leader — so members get
 * opportunistic clicks only (no walking: never fight the brain or the engine
 * follow), while the session leader gets the full walk-to-target treatment.
 * The citizen_routine and the citizen_fish/chop/mine activities drive the
 * same real interactions through the brain actions directly.
 *
 * Returns "active" (a real plugin session is running — hands off),
 * "engaged" (walking to / clicking a real target this tick), or false
 * (nothing to work — stay honest).
 */

const CitizenTiles = require("./CitizenTiles");
const { normalizeName } = require("./CitizenBonds");

// Honest starter tools (same set the routine grants — Jon 2026-10-12).
const BRONZE_AXE_ID = 1351;
const BRONZE_PICKAXE_ID = 1265;
const SMALL_NET_ID = 303;

const FISH_RADIUS = 10; // tiles — spot must be this close to bother
const HARVEST_RADIUS = 14; // tiles — tree/rock must be this close
const CLICK_REACH = 2; // tiles — the plugins' own within-distance
const ENGAGED_MS = 45 * 1000; // a walk-to-target owns movement this long
const FAIL_BACKOFF_MS = 5 * 60 * 1000; // clicks that never start a session back off
const MAX_FAILS = 3;

function fishingPlugin() {
  try {
    return require("../../skills/Fishing.plugin");
  } catch {
    return null;
  }
}
function woodcuttingPlugin() {
  try {
    return require("../../skills/Woodcutting.plugin");
  } catch {
    return null;
  }
}
function miningPlugin() {
  try {
    return require("../../skills/Mining.plugin");
  } catch {
    return null;
  }
}
function objectCatalog() {
  try {
    return require("../../bots/brain/BotObjectCatalog");
  } catch {
    return null;
  }
}
function tierTables(kind) {
  try {
    return require("../brain/actions/CitizenGoToPlace")._tierTables(kind) ?? [];
  } catch {
    return [];
  }
}
function targetTierFor(level, tiers) {
  try {
    return require("../brain/actions/CitizenGoToPlace")._targetTierFor(level, tiers) ?? null;
  } catch {
    return null;
  }
}
function skillLevelOf(bot, skill) {
  try {
    return require("../brain/CitizenGoalResolver").skillLevel(bot, skill) ?? 1;
  } catch {
    return 1;
  }
}

// --- per-bot drive state (module-level; keyed by normalized username) --------
const driveState = new Map(); // name -> { engagedUntil, fails, backedOffUntil }
function ds(bot) {
  const key = normalizeName(bot?.getUsername?.() ?? "?");
  let s = driveState.get(key);
  if (!s) driveState.set(key, (s = { engagedUntil: 0, fails: 0, backedOffUntil: 0 }));
  return s;
}
function clearDrive(bot) {
  driveState.delete(normalizeName(bot?.getUsername?.() ?? "?"));
}

// --- small helpers ------------------------------------------------------------
function cheby(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}
function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ() };
  } catch {
    return null;
  }
}
function queueBusy(bot) {
  try {
    return (bot.getMovementQueue?.()?.size?.() ?? 0) > 0;
  } catch {
    return true; // unknown: don't fight what we can't see
  }
}
function inventoryFull(bot) {
  try {
    const inv = bot.getInventory?.();
    if (!inv) return true;
    return typeof inv.isFull === "function" ? inv.isFull() : false;
  } catch {
    return true;
  }
}
function ensureTool(bot, itemId) {
  try {
    const inv = bot.getInventory?.();
    if (!inv || typeof inv.getAmount !== "function") return false;
    if (inv.getAmount(itemId) > 0) return true;
    if (inventoryFull(bot)) return false;
    inv.adds(itemId, 1);
    return true;
  } catch {
    return false;
  }
}
function faceToward(bot, x, y, z) {
  try {
    const loc = { getX: () => x, getY: () => y, getZ: () => z };
    if (typeof bot.forcePositionToFace === "function") bot.forcePositionToFace(loc);
    else bot.setPositionToFace?.(loc);
  } catch {
    // Cosmetic only.
  }
}
function npcsNear(api, bot, radius) {
  try {
    const World = api?.core?.World;
    const loc = bot.getLocation?.();
    if (!World?.getNpcsNear || !loc) return [];
    return World.getNpcsNear(loc, radius, bot.getPrivateArea?.() ?? null) ?? [];
  } catch {
    return [];
  }
}

/** Nearest land (not water, not blocked) tile to (sx, sy), rings 1..6. */
function landStandTile(sx, sy, sz) {
  let best = null;
  let bestScore = Infinity;
  for (let r = 1; r <= 6; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = sx + dx;
        const y = sy + dy;
        try {
          if (CitizenTiles.isWaterTile(x, y, sz) === true) continue;
          if (CitizenTiles.isBlockedTile(x, y, sz) === true) continue;
        } catch {
          continue;
        }
        const score = r; // ring 1 preferred — adjacent to the spot
        if (score < bestScore) {
          bestScore = score;
          best = { x, y, z: sz };
        }
      }
    }
    if (best) return best; // nearest ring with any land wins
  }
  return best;
}

/**
 * The nearest live fishing-spot NPC with a SMALL_NET click, within radius.
 * Returns { npc, clickType, x, y, z } or null. Mirrors the spot resolution
 * the real fish brain action uses (Fishing.spotTools).
 */
function nearestFishSpot(Fishing, api, bot, radius) {
  let best = null;
  let bestD = Infinity;
  const tile = botTile(bot);
  if (!tile) return null;
  for (const npc of npcsNear(api, bot, radius)) {
    try {
      if (npc.isRegistered?.() === false) continue;
      const def = npc.getDefinition?.();
      if (!def || !Fishing.FISHING_SPOT_NAMES.includes(def.getName?.())) continue;
      const entry = (Fishing.spotTools(npc.getId(), def) ?? []).find(
        (e) => e.tool === "NET"
      );
      if (!entry || !entry.clickType) continue;
      const nl = npc.getLocation?.();
      if (!nl || (nl.getZ?.() ?? 0) !== tile.z) continue;
      const d = cheby(nl.getX(), nl.getY(), tile.x, tile.y);
      if (d < bestD) {
        bestD = d;
        best = { npc, clickType: entry.clickType, x: nl.getX(), y: nl.getY(), z: nl.getZ() };
      }
    } catch {
      // Next NPC — never break the scan on one bad entry.
    }
  }
  return best;
}

/** Emit the REAL npc interaction — the same click a player makes on the spot. */
function clickFishSpot(api, bot, spot) {
  try {
    // Re-validate at click time: a spot that moved/relocated is not clicked
    // stale — the next tick re-scans and the citizen walks to the new spot.
    const npc = spot.npc;
    if (npc.isRegistered?.() === false) return false;
    const nl = npc.getLocation?.();
    if (!nl) return false;
    faceToward(bot, nl.getX(), nl.getY(), nl.getZ?.() ?? 0);
    return (
      api.emitNpcInteraction?.({
        player: bot,
        npc,
        npcId: npc.getId(),
        npcIndex: npc.getIndex(),
        clickType: spot.clickType,
        location: { x: nl.getX(), y: nl.getY(), z: nl.getZ?.() ?? 0 },
        handled: false,
      }) === true
    );
  } catch {
    return false;
  }
}

/** Richest-first object ids of the best tier the citizen qualifies for. */
function harvestIdsFor(bot, kind) {
  const catalog = objectCatalog();
  if (!catalog || typeof catalog.resolveCatalogObjectIds !== "function") return [];
  const skill = kind === "tree" ? "woodcutting" : "mining";
  const tiers = tierTables(kind); // richest first
  const level = skillLevelOf(bot, skill);
  const target = targetTierFor(level, tiers);
  if (!target) return [];
  try {
    return catalog.resolveCatalogObjectIds({ catalog: kind, tier: target }) ?? [];
  } catch {
    return [];
  }
}

/**
 * Nearest live harvestable object (tree/rock of the citizen's tier) within
 * radius. Depleted trees/rocks (stumps, empty ids) are naturally skipped —
 * their ids aren't in the catalog. Returns { object, x, y, z } or null.
 */
function nearestHarvestable(api, bot, kind, radius) {
  const ids = harvestIdsFor(bot, kind);
  if (!ids.length) return null;
  const idSet = new Set(ids);
  const tile = botTile(bot);
  if (!tile) return null;
  let objects = [];
  try {
    objects = api?.core?.World?.getObjects?.() ?? [];
  } catch {
    return null;
  }
  let best = null;
  let bestD2 = radius * radius;
  for (const object of objects) {
    try {
      if (!idSet.has(object.getId?.())) continue;
      const ol = object.getLocation?.();
      if (!ol || (ol.getZ?.() ?? 0) !== tile.z) continue;
      const dx = ol.getX() - tile.x;
      const dy = ol.getY() - tile.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > bestD2) continue;
      bestD2 = d2;
      best = { object, x: ol.getX(), y: ol.getY(), z: ol.getZ() };
    } catch {
      // Next object.
    }
  }
  return best;
}

/** Emit the REAL object interaction — the same click a player makes. */
function clickHarvestable(api, bot, target) {
  try {
    const object = target.object;
    const ol = object.getLocation?.();
    if (!ol) return false;
    faceToward(bot, ol.getX(), ol.getY(), ol.getZ?.() ?? 0);
    const bloc = bot.getLocation?.();
    return (
      api.emitObjectInteraction?.({
        player: bot,
        object,
        objectId: object.getId(),
        clickType: 1, // "Chop down" / "Mine" — the live brain path uses 1
        location: { x: ol.getX(), y: ol.getY(), z: ol.getZ?.() ?? 0 },
        sourceLocation: bloc
          ? { x: bloc.getX(), y: bloc.getY(), z: bloc.getZ?.() ?? 0 }
          : { x: target.x, y: target.y, z: target.z },
        handled: false,
      }) === true
    );
  } catch {
    return false;
  }
}

function noteFail(bot) {
  const s = ds(bot);
  s.fails += 1;
  if (s.fails >= MAX_FAILS) {
    s.backedOffUntil = Date.now() + FAIL_BACKOFF_MS;
    s.fails = 0;
  }
}

/**
 * Drive one tick of real fishing for a session member.
 * leader=true: walk to a land stand tile adjacent to the spot, then click.
 * leader=false: opportunistic click only (never fight the brain/follow).
 */
function driveRealFishing(api, bot, leader) {
  const Fishing = fishingPlugin();
  if (!Fishing?.isFishingActive || typeof Fishing.spotTools !== "function") return false;
  const st = ds(bot);
  if (Date.now() < st.backedOffUntil) return false;
  if (Fishing.isFishingActive(bot)) {
    clearDrive(bot); // the plugin owns them now — hands off
    return "active";
  }
  if (queueBusy(bot)) return false; // brain or follow is moving them
  if (inventoryFull(bot)) return false; // the bank hinge owns this state
  if (!ensureTool(bot, SMALL_NET_ID)) return false;

  const spot = nearestFishSpot(Fishing, api, bot, FISH_RADIUS);
  if (!spot) return false;
  const tile = botTile(bot);
  if (!tile) return false;

  // Already in click reach: click now — the same interaction a player makes.
  if (tile.z === spot.z && cheby(tile.x, tile.y, spot.x, spot.y) <= CLICK_REACH) {
    const ok = clickFishSpot(api, bot, spot);
    if (!ok) noteFail(bot);
    return ok ? "engaged" : false;
  }
  if (!leader) return false; // members don't walk — no brain fights
  // Leader: walk to a walkable shore tile adjacent to the spot, then click.
  // Never onto water (Jon 2026-10-13, Draynor).
  const stand = landStandTile(spot.x, spot.y, spot.z);
  if (!stand) return false;
  st.engagedUntil = Date.now() + ENGAGED_MS;
  try {
    const bloc = bot.getLocation();
    const dest = bloc.clone();
    dest.setX(stand.x);
    dest.setY(stand.y);
    bot.getMovementQueue().walkToTile(dest, () => {
      // Arrival: click the CURRENT spot position, not a stale one.
      const fresh = nearestFishSpot(Fishing, api, bot, CLICK_REACH + 1);
      if (fresh) clickFishSpot(api, bot, fresh);
      else noteFail(bot);
    });
    return "engaged";
  } catch {
    return false;
  }
}

/** Drive one tick of real woodcutting/mining for a session member. */
function driveRealHarvest(api, bot, kind, leader) {
  const plugin = kind === "tree" ? woodcuttingPlugin() : miningPlugin();
  const isActive =
    kind === "tree" ? plugin?.isWoodcuttingActive : plugin?.isMiningActive;
  if (typeof isActive !== "function") return false;
  const st = ds(bot);
  if (Date.now() < st.backedOffUntil) return false;
  if (isActive(bot)) {
    clearDrive(bot);
    return "active";
  }
  if (queueBusy(bot)) return false;
  if (inventoryFull(bot)) return false;
  if (!ensureTool(bot, kind === "tree" ? BRONZE_AXE_ID : BRONZE_PICKAXE_ID)) return false;

  const target = nearestHarvestable(api, bot, kind, HARVEST_RADIUS);
  if (!target) return false;
  const tile = botTile(bot);
  if (!tile) return false;

  // In click reach: click now. walkToObject routes into reach otherwise —
  // leader only; members never walk (no brain fights).
  const d = cheby(tile.x, tile.y, target.x, target.y);
  if (d <= CLICK_REACH && tile.z === target.z) {
    const ok = clickHarvestable(api, bot, target);
    if (!ok) noteFail(bot);
    return ok ? "engaged" : false;
  }
  if (!leader) return false;
  st.engagedUntil = Date.now() + ENGAGED_MS;
  try {
    bot.getMovementQueue().walkToObject(target.object, {
      execute: () => {
        // Arrival: the object may have depleted en route — click only if
        // it's still the same live object.
        try {
          if (target.object.isRegistered?.() === false) return;
        } catch {
          return;
        }
        if (!clickHarvestable(api, bot, target)) noteFail(bot);
      },
    });
    return "engaged";
  } catch {
    return false;
  }
}

/**
 * One driver tick for a skilling-session member. skillId is
 * "fishing" | "woodcutting" | "mining". opts.leader marks the session
 * leader (gets the full walk-to-target treatment; members click
 * opportunistically). Returns "active" | "engaged" | false.
 */
function drive(api, bot, skillId, opts = {}) {
  if (!api || !bot) return false;
  const leader = opts.leader === true;
  try {
    if (skillId === "fishing") return driveRealFishing(api, bot, leader);
    if (skillId === "woodcutting") return driveRealHarvest(api, bot, "tree", leader);
    if (skillId === "mining") return driveRealHarvest(api, bot, "rock", leader);
    return false;
  } catch {
    return false; // tick-safe: one bad member never breaks the session
  }
}

/** True while the bot is really working or walking to a real target. */
function isWorking(api, bot, skillId) {
  try {
    if (skillId === "fishing") {
      if (fishingPlugin()?.isFishingActive?.(bot)) return true;
    } else if (skillId === "woodcutting") {
      if (woodcuttingPlugin()?.isWoodcuttingActive?.(bot)) return true;
    } else if (skillId === "mining") {
      if (miningPlugin()?.isMiningActive?.(bot)) return true;
    } else {
      return false;
    }
    return Date.now() < ds(bot).engagedUntil;
  } catch {
    return false;
  }
}

module.exports = {
  drive,
  isWorking,
  driveRealFishing,
  driveRealHarvest,
  // exposed for tests
  _resetForTests() {
    driveState.clear();
  },
};
