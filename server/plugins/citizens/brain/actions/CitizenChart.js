"use strict";

/**
 * CitizenChart — the brain action for real map drafting.
 *
 * Complements (does not duplicate):
 *   - CitizenCartographers: hash-derived cartographer FLAVOR (surveyors
 *     pacing, mapmaker desks, hawking, commission dialogue). Zero storage,
 *     zero real materials, zero real coins.
 *   - CitizenObserve (brain): walks to the observatory and creates star
 *     charts (navigation from the sky).
 *   - This action: walks to the kingdom's real MAP SHOP, drafts REAL maps
 *     from REAL papyrus in the real inventory, and lists them for sale —
 *     persistent records with real coin transactions. Treasure maps point
 *     at real discovery coordinates with real loot caches.
 *
 * Flow per tick:
 *   - Only registered cartographers (or curious citizens who register on
 *     arrival) draft. Non-cartographers honestly return home.
 *   - Walk to the map-shop tile (deterministic, near the market).
 *   - Draft in rounds (human-paced 8s): each round needs 1 real papyrus
 *     from the real inventory — no papyrus, session ends honestly.
 *   - Each drafted map is listed in the shop at its real value.
 *   - After DRAFT_ROUNDS or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const DRAFT_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const DRAFT_COOLDOWN_MS = 8000; // human-paced drafting

function mapsApi() {
  try {
    return require("../../lib/CitizenMaps");
  } catch {
    return null;
  }
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  try {
    const p = player.getPosition?.() ?? player.position;
    if (!p || !tile) return false;
    const dx = (p.x ?? 0) - tile.x;
    const dy = (p.y ?? 0) - tile.y;
    return Math.hypot(dx, dy) <= radius;
  } catch {
    return false;
  }
}

function walkTo(player, tile) {
  try {
    requestMovement(player, tile.x, tile.y, { z: tile.z ?? 0 });
  } catch {}
}

function stopWalking(player) {
  try {
    clearMovementRequest(player);
  } catch {}
}

function homeTileFor(player) {
  try {
    return siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
  } catch {
    return { x: 3200, y: 3200, z: 0 };
  }
}

function countItem(player, itemId) {
  try {
    const inv = player.inventory ?? player.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(itemId);
    if (Array.isArray(inv.items)) {
      return inv.items.filter((i) => (i?.id ?? i) === itemId).length;
    }
    return 0;
  } catch { return 0; }
}

function removeItem(player, itemId, amount) {
  try {
    const inv = player.inventory ?? player.getInventory?.();
    if (!inv) return false;
    if (typeof inv.remove === "function") { inv.remove(itemId, amount); return true; }
    if (typeof inv.delete === "function") { inv.delete(itemId, amount); return true; }
    return false;
  } catch { return false; }
}

function createCitizenChartAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`chart:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> drafting -> returning -> done
        roundsDone: 0,
        lastDraftAt: 0,
        shopTile: null,
        homeTile: null,
        kingdomId: null,
        isCartographer: false,
        drafted: 0,
      };
    });
  }

  const action = {
    id: "citizenChart",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Maps = mapsApi();
      if (!Maps) return "success"; // no maps system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        state.isCartographer = Maps.isCartographer(username);
        if (!state.kingdomId) {
          state.phase = "returning";
        } else {
          const shop = Maps.ensureShop(state.kingdomId);
          state.shopTile = shop?.tile ?? Maps.shopTileFor(state.kingdomId);
          if (!state.shopTile) {
            state.phase = "returning";
          } else if (!state.isCartographer) {
            // Register curious citizens as cartographers (honest first visit).
            const curiosity = state.personality?.curiosity ?? state.personality?.curious ?? 0;
            const adventurous = state.personality?.adventurousness ?? 0;
            if (curiosity >= 0.5 || adventurous >= 0.5) {
              Maps.registerCartographer(username, state.kingdomId);
              state.isCartographer = true;
            } else {
              state.phase = "returning"; // not a mapmaker
            }
          }
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.shopTile)) {
            stopWalking(player);
            state.phase = "drafting";
            state.lastDraftAt = nowMs - DRAFT_COOLDOWN_MS; // draft immediately on arrival
            return "running";
          }
          walkTo(player, state.shopTile);
          return "running";
        }
        case "drafting": {
          if (state.roundsDone >= DRAFT_ROUNDS) {
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastDraftAt < DRAFT_COOLDOWN_MS) return "running";
          state.lastDraftAt = nowMs;
          state.roundsDone++;
          // Honest materials: real papyrus or no map.
          if (countItem(player, Maps.MAT_PAPYRUS) < 1) {
            state.phase = "returning";
            return "running";
          }
          if (!removeItem(player, Maps.MAT_PAPYRUS, 1)) {
            state.phase = "returning";
            return "running";
          }
          try {
            const type = pickType(state.rng, Maps);
            const res = Maps.draftMap(username, state.kingdomId, type);
            if (res.ok) {
              Maps.listMap(res.map.id);
              state.drafted++;
              try {
                const Rep = require("../../lib/CitizenReputation");
                if (res.masterwork) Rep.awardDeed?.(username, "master_cartographer");
              } catch { /* fame optional */ }
            }
          } catch { /* draft failed, round still spent */ }
          return "running";
        }
        case "returning": {
          if (atTile(player, state.homeTile)) {
            stopWalking(player);
            return "success";
          }
          walkTo(player, state.homeTile);
          return "running";
        }
        default: {
          stopWalking(player);
          return "success";
        }
      }
    },
  };

  return action;
}

function pickType(rng, Maps) {
  const r = typeof rng === "function" ? rng() : Math.random();
  // Treasure/dungeon maps need real discoveries; the data tier honestly
  // fails without one, so bias toward world/city.
  if (r < 0.35) return Maps.MAP_WORLD;
  if (r < 0.7) return Maps.MAP_CITY;
  if (r < 0.85) return Maps.MAP_DUNGEON;
  return Maps.MAP_TREASURE;
}

module.exports = { createCitizenChartAction };
