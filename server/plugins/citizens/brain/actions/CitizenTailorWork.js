"use strict";

/**
 * CitizenTailorWork — the brain action for tailor citizens making real garments.
 *
 * The visible "tailor at work" half. The slow tick (CitizenFashionLife)
 * handles trend rotation, competitions, and shop restocking; this action
 * is what a nearby player actually sees:
 *
 * Flow per tick:
 *   - Walk to the kingdom market (deterministic tile — tailors work near shops).
 *   - Pick the best garment type the citizen can afford (real materials
 *     from real inventory).
 *   - Sew the garment (human-paced 8s cooldown), consuming REAL materials,
 *     creating a REAL garment record, granting REAL Crafting XP.
 *   - List the garment in the kingdom clothing shop.
 *   - After WORK_ROUNDS rounds or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
 *
 * No-overlap: CitizenTailors.js owns the flavor layer (trade assignment,
 * hawking, commissions). This owns the real production layer.
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
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const WORK_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const SEW_COOLDOWN_MS = 8000; // human-paced sewing

function fashionApi() {
  try {
    return require("../../lib/CitizenFashion");
  } catch {
    return null;
  }
}

/** The market tile for this citizen's kingdom (defensive). */
function workTileFor(player) {
  try {
    return siteTile(player, "market");
  } catch {
    return null;
  }
}

/** Pick the most valuable garment this citizen can afford to make. */
function pickGarment(Fashion, player, nowMs) {
  try {
    const types = Fashion.GARMENT_TYPES ?? [];
    let best = null;
    let bestValue = -1;
    for (const type of types) {
      const check = Fashion.canAffordMaterials(player, type);
      if (!check.ok) continue;
      // Value a prototype garment to pick the best.
      const proto = { type, color: "natural", quality: 50 };
      const value = Fashion.garmentValue(proto, nowMs);
      if (value > bestValue) {
        bestValue = value;
        best = type;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function createCitizenTailorWorkAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`tailor:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> sewing -> returning -> done
        roundsDone: 0,
        lastSewAt: 0,
        workTile: null,
        homeTile: null,
        currentType: null,
      };
    });
  }

  const action = {
    id: "citizenTailorWork",
    update(ctx) {
      const player = ctx?.player;
      if (!player) return "failed";
      const nowMs = Date.now();
      const st = botState(player);
      const Fashion = fashionApi();
      if (!Fashion) return "failed"; // fashion system unavailable — honest fail

      if (!st.giveUpAt) st.giveUpAt = nowMs + GIVE_UP_MS;
      if (nowMs > st.giveUpAt) return done(player, st, "success"); // give up -> success

      switch (st.phase) {
        case "outbound": {
          if (!st.workTile) st.workTile = workTileFor(player);
          if (!st.workTile) return done(player, st, "success"); // no workshop — honest
          if (!st.homeTile) {
            try {
            st.homeTile = st.workTile
              ? personalSpot(player.getUsername?.() ?? "unknown", st.workTile.x, st.workTile.y, 2, 8)
              : null;
            } catch {
              st.homeTile = null;
            }
          }
          if (atTile(player, st.workTile, ARRIVE_RADIUS)) {
            st.phase = "sewing";
            break;
          }
          requestMovement(player, st.workTile.x, st.workTile.y, { z: st.workTile.z ?? 0 });
          return "running";
        }
        case "sewing": {
          if (st.roundsDone >= WORK_ROUNDS) {
            st.phase = "returning";
            break;
          }
          if (nowMs - st.lastSewAt < SEW_COOLDOWN_MS) return "running"; // human pace
          // Pick (or re-pick) a garment we can afford.
          if (!st.currentType) {
            st.currentType = pickGarment(Fashion, player, nowMs);
          }
          if (!st.currentType) {
            st.phase = "returning"; // can't afford anything — honest
            break;
          }
          // Sew: consume real materials, create real garment.
          const consumed = Fashion.consumeMaterials(player, st.currentType);
          if (!consumed) {
            st.currentType = null; // materials ran out — try another type
            break;
          }
          const quality = 40 + Math.floor(st.rng() * 40); // 40-80, skill would refine
          const color = pickColor(st.rng);
          const username = player.getUsername?.() ?? "unknown";
          const garment = Fashion.createGarment(st.currentType, color, username, quality);
          if (garment) {
            // List in the kingdom shop.
            try {
              const kingdomId = kingdomIdOf(player);
              if (kingdomId) Fashion.listGarment(kingdomId, garment.id);
            } catch {
              // Shop unavailable — garment still exists.
            }
            // Real Crafting XP for the work.
            grantCraftingXp(player, 25);
          }
          st.lastSewAt = nowMs;
          st.roundsDone++;
          st.currentType = null;
          return "running";
        }
        case "returning": {
          if (st.homeTile && !atTile(player, st.homeTile, ARRIVE_RADIUS)) {
            requestMovement(player, st.homeTile.x, st.homeTile.y, { z: st.homeTile.z ?? 0 });
            return "running";
          }
          return done(player, st, "success");
        }
        default:
          return done(player, st, "success");
      }
      return "running";
    },
  };

  function done(player, st, result) {
    try {
      clearMovementRequest(player);
    } catch {
      // Ignore.
    }
    return result;
  }

  return action;
}

function atTile(player, tile, radius) {
  try {
    const px = player.getX?.() ?? player.x ?? 0;
    const py = player.getY?.() ?? player.y ?? 0;
    const tx = tile?.x ?? 0;
    const ty = tile?.y ?? 0;
    return Math.abs(px - tx) <= radius && Math.abs(py - ty) <= radius;
  } catch {
    return false;
  }
}

function pickColor(rng) {
  const colors = ["crimson", "azure", "emerald", "golden", "violet", "natural"];
  return colors[Math.floor(rng() * colors.length)];
}

function grantCraftingXp(player, amount) {
  try {
    player.getSkills?.()?.addXp?.("crafting", amount);
  } catch {
    try {
      player.addXp?.("crafting", amount);
    } catch {
      // XP unavailable — the garment is still real.
    }
  }
}

module.exports = { createCitizenTailorWorkAction };
