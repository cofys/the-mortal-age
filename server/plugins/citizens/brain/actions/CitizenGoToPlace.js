"use strict";

/**
 * CitizenGoToPlace — walk to a gather place before the real skilling action.
 *
 * Prepend to citizen_chop / citizen_mine / citizen_fish in
 * citizen-activities.json:
 *   { "type": "citizenGoToPlace", "kind": "tree" }   // "tree" | "rock" | "fish"
 *
 * Place choice is deterministic per citizen per ~90 min bucket: a citizen has
 * "their spot" for a while, then drifts to another. Success on arrival, so
 * the next action in the activity (equipTool / interactObject / fish) starts
 * AT the place. Fails (brain re-picks) if there's no place or they're stuck.
 */

const { playerState } = require("../../../bots/brain/ActionState.PlayerBots.js");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/Navigation.PlayerBots.js");
const { pickPlace, GATHER_PLACES, kingdomIdOf } = require("../CitizenSites");
const { agentRng, personalSpot } = require("../../lib/humanizer");
const SlotCapacity = require("../CitizenSlotCapacity");
// Jon 2026-10-13 (Catherby water tiles): slot/personal-spot tiles around a
// dock can land in the sea — snap the final destination to walkable.
const CitizenTiles = require("../../lib/CitizenTiles");
const {
  ATTR_CITIZEN_LOCAL_RESOURCE,
  ATTR_CITIZEN_LOCAL_TIER,
} = require("../../constants");

const ARRIVE_RADIUS = 6;
const STUCK_MS = 4 * 60 * 1000;
const STICKY_MS = 90 * 60 * 1000;

// Work what's near you (Jon 2026-10-13): prospect real resources around the
// citizen before walking to a fixed anchor. Radius in chebyshev tiles.
const LOCAL_RESOURCE_RADIUS = 48;
// Spread pick among this many nearest candidates of the chosen tier.
const LOCAL_SPREAD = 4;
const KIND_TO_CATALOG = { tree: "tree", rock: "rock" };
const KIND_TO_SKILL = { tree: "woodcutting", rock: "mining", fish: "fishing" };

// --- lazy engine seams (same pattern as CitizenWildGather) ---
function woodcuttingPlugin() {
  try {
    return require("../../../skills/Woodcutting.plugin");
  } catch {
    return null;
  }
}
function miningPlugin() {
  try {
    return require("../../../skills/Mining.plugin");
  } catch {
    return null;
  }
}
function objectCatalog() {
  try {
    return require("../../../bots/brain/ObjectCatalog.PlayerBots.js");
  } catch {
    return null;
  }
}
function fishingPlugin() {
  try {
    return require("../../../skills/Fishing.plugin");
  } catch {
    return null;
  }
}
function skillLevelOf(player, skill) {
  try {
    return require("../CitizenGoalResolver").skillLevel(player, skill) ?? 1;
  } catch {
    return 1;
  }
}

function cheby(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Richest-first [{ tier, level }] for the kind. */
function tierTables(kind) {
  if (kind === "tree") {
    const WC = woodcuttingPlugin();
    return ((WC && WC.TREES) || [])
      .filter((t) => t && t.name && Number.isFinite(t.requiredLevel))
      // Normalize to the tier vocabulary sites.json uses ("normal tree" -> "normal").
      .map((t) => ({ tier: String(t.name).toLowerCase().replace(/\s+trees?$/i, "").trim(), level: t.requiredLevel }))
      .sort((a, b) => b.level - a.level);
  }
  if (kind === "rock") {
    const M = miningPlugin();
    return ((M && M.ROCKS) || [])
      .filter((r) => r && r.objectName && Number.isFinite(r.level))
      .map((r) => ({
        tier: String(r.objectName).replace(/\s+rocks?$/i, "").trim().toLowerCase(),
        level: r.level,
      }))
      .sort((a, b) => b.level - a.level);
  }
  return [];
}

/** Best tier the citizen's level qualifies for (Jon 2026-10-13: skill by
 *  level — a 60 woodcutter works yews, not normals). Null when nothing
 *  qualifies. */
function targetTierFor(level, tiers) {
  for (const t of tiers) {
    if (level >= t.level) return t.tier;
  }
  return null;
}

/**
 * Nearest land tile (not water, not blocked) to (sx, sy) within maxRadius,
 * rings outward — ring 1 preferred so fishers stand adjacent to the spot.
 * Jon 2026-10-13 (Draynor): no pier there; fishing is from the shoreline.
 */
function nearestShoreTile(sx, sy, z, maxRadius) {
  for (let r = 1; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = sx + dx;
        const y = sy + dy;
        try {
          if (CitizenTiles.isWaterTile(x, y, z) === true) continue;
          if (CitizenTiles.isBlockedTile(x, y, z) === true) continue;
        } catch {
          continue;
        }
        return { x, y, z };
      }
    }
  }
  return null;
}

/**
 * Prospect real resources near the citizen. Returns { x, y, z, tier } or
 * null. tree/rock: nearest objects of the best tier the citizen qualifies
 * for; fish: nearest fishing-spot NPC. Null when nothing suitable is near —
 * the caller falls back to the anchor flow.
 */
function prospectLocalResource(player, kind, world, rng) {
  const loc = player.getLocation?.();
  if (!loc) return null;
  const px = loc.getX();
  const py = loc.getY();
  const pz = loc.getZ();
  if (kind === "fish") return prospectLocalFishSpot(player, world, rng, px, py, pz);
  if (kind !== "tree" && kind !== "rock") return null;
  const catalog = objectCatalog();
  if (!catalog || typeof catalog.resolveCatalogObjectIds !== "function") return null;
  const target = targetTierFor(skillLevelOf(player, KIND_TO_SKILL[kind]), tierTables(kind));
  if (!target) return null;
  let ids = [];
  try {
    ids = catalog.resolveCatalogObjectIds({ catalog: KIND_TO_CATALOG[kind], tier: target }) || [];
  } catch {
    return null;
  }
  if (!ids.length) return null;
  let candidates = [];
  try {
    candidates =
      world?.objectSearch?.findCandidatesByIds?.(player, ids, {
        regionRadius: 1,
        z: pz,
        privateArea: player.getPrivateArea?.() ?? null,
      }) ?? [];
  } catch {
    return null;
  }
  const near = [];
  for (const object of candidates) {
    const ol = object?.getLocation?.();
    if (!ol || (ol.getZ?.() ?? 0) !== pz) continue;
    const x = ol.getX();
    const y = ol.getY();
    const d = cheby(px, py, x, y);
    if (d > LOCAL_RESOURCE_RADIUS) continue;
    near.push({ x, y, z: pz, d });
  }
  if (!near.length) return null;
  near.sort((a, b) => a.d - b.d);
  const pool = near.slice(0, LOCAL_SPREAD);
  const pick = pool[Math.floor(rng() * pool.length)] ?? pool[0];
  return { x: pick.x, y: pick.y, z: pick.z, tier: target };
}

/** Nearest fishing-spot NPC within radius (the fish action handles tools). */
function prospectLocalFishSpot(player, world, rng, px, py, pz) {
  const Fishing = fishingPlugin();
  if (!Fishing || !Array.isArray(Fishing.FISHING_SPOT_NAMES)) return null;
  let npcs = [];
  try {
    // World.getNpcsNear like the fish action's siteSpots — getLocalNpcs is
    // player-visibility-limited and too narrow for prospecting.
    npcs =
      world?.core?.World?.getNpcsNear?.(
        player.getLocation(),
        LOCAL_RESOURCE_RADIUS,
        player.getPrivateArea?.() ?? null
      ) ?? [];
  } catch {
    return null;
  }
  const near = [];
  for (const npc of npcs) {
    try {
      if (npc.isRegistered?.() === false) continue;
      const def = npc.getDefinition?.();
      if (!def || !Fishing.FISHING_SPOT_NAMES.includes(def.getName?.())) continue;
      const nl = npc.getLocation?.();
      if (!nl || (nl.getZ?.() ?? 0) !== pz) continue;
      const x = nl.getX();
      const y = nl.getY();
      const d = cheby(px, py, x, y);
      if (d > LOCAL_RESOURCE_RADIUS) continue;
      near.push({ x, y, z: pz, d });
    } catch {
      // Next NPC — never break the scan on one bad entry.
    }
  }
  if (!near.length) return null;
  near.sort((a, b) => a.d - b.d);
  const pool = near.slice(0, LOCAL_SPREAD);
  const pick = pool[Math.floor(rng() * pool.length)] ?? pool[0];
  return { x: pick.x, y: pick.y, z: pick.z, tier: null };
}

/**
 * Tier-aware anchor pick: like pickPlace but prefers a place whose tier
 * matches the citizen's current tier (Jon 2026-10-13: a 60 woodcutter with
 * only normals nearby travels to the yews). Falls back to pickPlace when no
 * tier matches — kingdom-scoped either way.
 */
function pickTierPlace(player, kind, rng) {
  const level = skillLevelOf(player, KIND_TO_SKILL[kind]);
  const target = targetTierFor(level, tierTables(kind));
  if (target) {
    let kid = null;
    try {
      kid = kingdomIdOf(player);
    } catch {
      kid = null;
    }
    const pool = GATHER_PLACES.filter((p) => p.kind === kind && p.tier === target);
    const scoped = kid ? pool.filter((p) => p.kingdomId === kid) : pool;
    const picks = scoped.length > 0 ? scoped : pool;
    if (picks.length > 0) {
      return picks[Math.floor(rng() * picks.length)];
    }
  }
  return null;
}

// The activity that owns the gather spot of each kind, for destack slot
// claims. Same spot + same activity => same claim pool, so N citizens
// gathering at one place stand on N distinct slot tiles.
const GATHER_ACTIVITY_FOR_KIND = Object.freeze({
  tree: "citizen_chop",
  rock: "citizen_mine",
  fish: "citizen_fish",
});

function createCitizenGoToPlaceAction(spec, world) {
  const kind = spec.kind;

  function st(player) {
    return playerState(action, player, () => ({ spot: null, giveUpAt: 0 }));
  }

  const action = {
    id: "citizenGoToPlace",
    update(ctx) {
      const { player, nowMs } = ctx;
      const s = st(player);
      const name = player.getUsername?.() ?? "unknown";

      if (!s.spot) {
        const rng = agentRng(`place:${name}:${kind}:${Math.floor(nowMs / STICKY_MS)}`);
        // Jon 2026-10-13: work what's near you first. Real trees/rocks/
        // fishing spots around the citizen — at the tier their level
        // qualifies for — beat a 120-tile walk to a fixed anchor.
        const local = prospectLocalResource(player, kind, world, rng);
        if (local) {
          let spot = null;
          if (kind === "fish") {
            // Stand tile = walkable shore tile adjacent to the spot's
            // water. Draynor has no pier — fishing is from the shoreline
            // (Jon 2026-10-13): never a ring around the dock anchor.
            spot = nearestShoreTile(local.x, local.y, local.z, 10);
          } else {
            // Stand next to the resource, spread per citizen, never on the
            // object's own (blocked) tile.
            spot = personalSpot(name, local.x, local.y, 2, 4);
          }
          if (spot) {
            try {
              const snapped = CitizenTiles.snapToWalkableTile(spot.x, spot.y, local.z, 12);
              if (snapped) spot = { x: snapped.x, y: snapped.y };
            } catch {
              // snap is best-effort; never breaks the trip
            }
            try {
              // Stamp for the scorer's locality bonus (fresh = "here") and
              // interactObject's tier filter.
              player.setAttribute?.(ATTR_CITIZEN_LOCAL_RESOURCE, `${kind}:${nowMs}`);
              player.setAttribute?.(
                ATTR_CITIZEN_LOCAL_TIER,
                local.tier ?? null
              );
            } catch {
              // Attributes never break the trip.
            }
            s.spot = {
              x: spot.x,
              y: spot.y,
              z: local.z,
              placeId: `local:${kind}`,
              // Tight arrival: the fish action must start adjacent to the
              // spot, not wander onto water via walkToEntity.
              arriveRadius: kind === "fish" ? 2 : ARRIVE_RADIUS,
            };
            s.giveUpAt = nowMs + STUCK_MS;
          }
        }
        if (!s.spot) {
          // No suitable local resource (or below the citizen's tier):
          // travel to a proper-tier gather place — the human-correct
          // behavior (Jon 2026-10-13: a 60 woodcutter goes to the yews).
          const place = pickTierPlace(player, kind, rng) ?? pickPlace(player, kind, rng);
          if (!place) return "failed";
          // Distinct slot tile at the shared gather place (destack); falls
          // back to the personal ring when the place's slots are full.
          let spot = null;
          const activityId = GATHER_ACTIVITY_FOR_KIND[kind];
          if (activityId) {
            try {
              const claim = SlotCapacity.claimSlot(
                player,
                activityId,
                Math.round(place.x),
                Math.round(place.y),
                Math.round(place.z ?? 0),
                rng
              );
              if (claim && Number.isFinite(claim.x) && Number.isFinite(claim.y)) {
                spot = { x: claim.x, y: claim.y };
              }
            } catch {
              // Claim failure degrades to the personal ring — never a break.
            }
          }
          if (!spot) {
            spot = personalSpot(name, place.x, place.y, 2, place.radius ?? 6);
          }
          // Jon 2026-10-13 (Catherby water tiles): a claimed slot or the
          // personal ring around a dock can sit in the sea — snap to the
          // nearest walkable tile so the citizen never walks onto water.
          try {
            const snapped = CitizenTiles.snapToWalkableTile(
              spot.x,
              spot.y,
              place.z ?? 0,
              12
            );
            if (snapped) spot = { x: snapped.x, y: snapped.y };
          } catch {
            // snap is best-effort; never breaks the trip
          }
          try {
            // The anchor's tier drives interactObject's tier filter, so the
            // citizen works the tier they traveled for.
            player.setAttribute?.(ATTR_CITIZEN_LOCAL_TIER, place.tier ?? null);
            player.setAttribute?.(ATTR_CITIZEN_LOCAL_RESOURCE, null);
          } catch {
            // Attributes never break the trip.
          }
          s.spot = { x: spot.x, y: spot.y, z: place.z, placeId: place.id };
          s.giveUpAt = nowMs + STUCK_MS;
          // TODO: shared ensureWorkTool(player, kind) here (see routine's fix),
          // so equipTool doesn't hit the silent no-axe stall.
        }
      }

      const loc = player.getLocation();
      const arriveRadius = s.spot.arriveRadius ?? ARRIVE_RADIUS;
      const arrived =
        loc.getZ() === s.spot.z &&
        Math.max(Math.abs(loc.getX() - s.spot.x), Math.abs(loc.getY() - s.spot.y)) <= arriveRadius;
      if (arrived) return "success";
      if (nowMs >= s.giveUpAt) return "failed";
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";

      requestMovement(player, s.spot.x, s.spot.y, {
        reason: "citizen_trip",
        basicPather: true,
        z: s.spot.z,
      });
      return "running";
    },
    stop(ctx) {
      if (!ctx?.player) return;
      st(ctx.player).spot = null; // fresh pick next run (no stale state)
      clearMovementRequest(ctx.player);
      try {
        SlotCapacity.releaseFor(ctx.player); // arrived or gave up: free the slot
      } catch {
        // Best-effort.
      }
    },
  };

  return action;
}

module.exports = {
  createCitizenGoToPlaceAction,
  // Exported for tests:
  _prospectLocalResource: prospectLocalResource,
  _targetTierFor: targetTierFor,
  _tierTables: tierTables,
  _nearestShoreTile: nearestShoreTile,
  _pickTierPlace: pickTierPlace,
};
