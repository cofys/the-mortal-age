"use strict";

/**
 * CitizenExplore — venture into the wilderness, search, discover, return.
 *
 * Complements (does not duplicate) CitizenExplorers: that module runs the
 * abstract expedition simulation (parties, musters, journeys). This is the
 * PHYSICAL brain action — the citizen actually walks out of town, searches
 * the wilds, and can make REAL discoveries (persisted via CitizenDiscovery).
 *
 * Flow per tick:
 *   - Walk to the wilderness edge (deterministic spot outside town).
 *   - Search: roll for discovery (Hunter level improves odds, curious
 *     personality helps). On success, record a real discovery.
 *   - Danger check: each search risks bandits (flee = walk home) or
 *     traps (real damage via player.hit).
 *   - After SEARCH_ROUNDS searches or GIVE_UP_MS, walk home -> "success".
 *
 * Hunter integration: citizens with real Hunter levels find more and
 * survive better. The Hunter plugin's hunterLevel() is the source of
 * truth; unreadable = 1 (safe fallback).
 *
 * Discovery types mirror CitizenDiscovery.DISCOVERY_TYPES. Names are
 * generated from deterministic pools (no hash-fiction — the discovery
 * itself is the real record with real coordinates).
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
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const SEARCH_ROUNDS = 5;
const ARRIVE_RADIUS = 8;
const SEARCH_COOLDOWN_MS = 8000; // human-paced searching

// Wilderness spots: outside town, where the wild things are.
// Deterministic per kingdom (personalSpot spreads citizens).
const WILDERNESS_OFFSETS = [
  { dx: 40, dy: 30 },
  { dx: -35, dy: 45 },
  { dx: 50, dy: -25 },
];

// Discovery name pools (deterministic pick by rng, not hash-fiction —
// the NAME is flavor, the DISCOVERY RECORD is real).
const DISCOVERY_NAMES = {
  resource_node: ["old copper vein", "abandoned iron seam", "hidden fishing pool", "dense yew grove"],
  dungeon_entrance: ["mossy stone stair", "collapsed mine shaft", "dark cave mouth"],
  trade_route: ["old smuggler's path", "forgotten trade road", "mountain pass"],
  ancient_ruin: ["crumbled watchtower", "overgrown shrine", "sunken chapel"],
  monster_lair: ["gnarled den", "shadowed burrow", "bone-strewn hollow"],
};

function hunterPlugin() {
  try {
    return require("../../../skills/Hunter.plugin");
  } catch {
    return null;
  }
}

/** Hunter level, 1 when unreadable (safe fallback). */
function hunterLevel(player) {
  try {
    const Hunter = hunterPlugin();
    if (Hunter?.hunterLevel) return Hunter.hunterLevel(player) ?? 1;
    return player.getSkills?.()?.getLevel?.(16) ?? 1; // 16 = Hunter skill id
  } catch {
    return 1;
  }
}

function discoveryApi() {
  try {
    return require("../../lib/CitizenDiscovery");
  } catch {
    return null;
  }
}

/**
 * Wilderness tile for this citizen: town site + deterministic offset.
 */
function wildernessTile(player, rng) {
  try {
    const home = siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
    const off = WILDERNESS_OFFSETS[Math.floor(rng() * WILDERNESS_OFFSETS.length)];
    return personalSpot(player.getUsername?.() ?? "unknown", home.x + off.dx, home.y + off.dy, 2, 8);
  } catch {
    return { x: 3240, y: 3230, z: 0 };
  }
}

/**
 * Pick a discovery type. Weighted: resource nodes common, dungeons rare.
 */
function pickDiscoveryType(rng) {
  const roll = rng();
  if (roll < 0.35) return "resource_node";
  if (roll < 0.55) return "trade_route";
  if (roll < 0.70) return "ancient_ruin";
  if (roll < 0.85) return "monster_lair";
  return "dungeon_entrance";
}

/**
 * Discovery chance per search: base 15%, +1% per Hunter level (cap 40%),
 * +10% if curious personality.
 */
function discoveryChance(player, personality) {
  const level = hunterLevel(player);
  let chance = 0.15 + Math.min(level * 0.01, 0.25);
  const traits = personality?.traits ?? [];
  if (traits.includes("curious") || traits.includes("adventurous")) chance += 0.10;
  return Math.min(chance, 0.50);
}

/**
 * Danger chance per search: base 20%, -0.5% per Hunter level (min 5%).
 * Hunters know the wilds.
 */
function dangerChance(player) {
  const level = hunterLevel(player);
  return Math.max(0.20 - level * 0.005, 0.05);
}

function createCitizenExploreAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`explore:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> searching -> returning -> done
        searchesDone: 0,
        lastSearchAt: 0,
        wildTile: null,
        homeTile: null,
      };
    });
  }

  const action = {
    id: "citizenExplore",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Discovery = discoveryApi();
      const state = botState(player);

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.wildTile = wildernessTile(player, state.rng);
        try {
          state.homeTile = siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
        } catch {
          state.homeTile = { x: 3200, y: 3200, z: 0 };
        }
      }
      if (nowMs >= state.giveUpAt) {
        try { clearMovementRequest(player); } catch { /* best-effort */ }
        return "success"; // long day — head home, brain re-decides
      }

      const px = player.getX?.() ?? 0;
      const py = player.getY?.() ?? 0;

      // --- phase: outbound (walk to wilderness) ---
      if (state.phase === "outbound") {
        const dx = state.wildTile.x - px, dy = state.wildTile.y - py;
        if (Math.sqrt(dx * dx + dy * dy) <= ARRIVE_RADIUS) {
          state.phase = "searching";
          return "running";
        }
        try {
          requestMovement(player, state.wildTile.x, state.wildTile.y);
        } catch { /* best-effort */ }
        return "running";
      }

      // --- phase: searching ---
      if (state.phase === "searching") {
        if (state.searchesDone >= SEARCH_ROUNDS) {
          state.phase = "returning";
          return "running";
        }
        if (nowMs - state.lastSearchAt < SEARCH_COOLDOWN_MS) {
          return "running"; // pacing — searching takes time
        }
        state.lastSearchAt = nowMs;
        state.searchesDone++;

        // Danger first: the wilds are dangerous.
        if (state.rng() < dangerChance(player)) {
          const dangerRoll = state.rng();
          if (dangerRoll < 0.5) {
            // Bandits! Flee back to town.
            state.phase = "returning";
            try {
              const { sayPublic } = require("../../chat/CitizenSayPublic");
              // Only shout if a real player might hear (cheap check).
              sayPublic(null, player.getUsername?.(), "Bandits! I'm getting out of here!");
            } catch { /* best-effort */ }
            return "running";
          } else {
            // Trap! Real damage.
            try {
              const dmg = 3 + Math.floor(state.rng() * 8);
              player.hit?.(dmg);
            } catch { /* best-effort */ }
          }
        }

        // Discovery roll.
        if (Discovery && state.rng() < discoveryChance(player, state.personality)) {
          try {
            const type = pickDiscoveryType(state.rng);
            const names = DISCOVERY_NAMES[type];
            const name = names[Math.floor(state.rng() * names.length)];
            // Discovery at current position (real coordinates).
            Discovery.recordDiscovery(type, px, py, 0, player.getUsername?.(), name);
          } catch { /* best-effort */ }
        }

        return "running";
      }

      // --- phase: returning (walk home) ---
      if (state.phase === "returning") {
        const dx = state.homeTile.x - px, dy = state.homeTile.y - py;
        if (Math.sqrt(dx * dx + dy * dy) <= ARRIVE_RADIUS) {
          try { clearMovementRequest(player); } catch { /* best-effort */ }
          return "success";
        }
        try {
          requestMovement(player, state.homeTile.x, state.homeTile.y);
        } catch { /* best-effort */ }
        return "running";
      }

      return "success";
    },
  };

  return action;
}

module.exports = {
  createCitizenExploreAction,
  // exposed for tests
  _hunterLevel: hunterLevel,
  _discoveryChance: discoveryChance,
  _dangerChance: dangerChance,
  _pickDiscoveryType: pickDiscoveryType,
  _wildernessTile: wildernessTile,
  SEARCH_ROUNDS,
  GIVE_UP_MS,
};
