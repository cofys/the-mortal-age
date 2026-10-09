"use strict";

/**
 * CitizenWildGather — brave citizens work the wilderness resource edge.
 *
 * Most citizens never cross the ditch. The brave ones do: the contested
 * Wilderness pays +25% XP on every yield (see server/plugins/skills/* /
 * Wilderness.*.js) and its rocks and timber are rich and unwatched — runite
 * rocks, yew trees — for anyone willing to risk a PK death for what's in
 * their pack. This action is that risk/reward loop, played the human way:
 *
 *   stage    — walk to the wilderness edge staging tile at the citizen's own
 *              x (the brain's DitchCrossing handles the ditch itself; only
 *              y=3521/3522 are forbidden targets, never the wild interior).
 *   prospect — scan REAL world objects (world.objectSearch, the same seam the
 *              bot brain's InteractObject uses) for the citizen's tier inside
 *              the economy plugin's WILDERNESS_SURFACE rect. No cache-memory
 *              coordinates, no invented spots: if nothing real is there, the
 *              run ends and the day re-decides.
 *   gather   — approach and click the real object through the real click path
 *              (walkToObject + world.emitObjectInteraction, clickType 1), so
 *              the Mining/Woodcutting plugins run their real sessions: real
 *              inventory, real XP, real level-ups.
 *   flee     — while gathering, watch for danger: a real (non-bot) player
 *              within a few tiles, or actually taking damage. Steadfast-brave
 *              citizens finish the inventory when merely watched; everyone
 *              else — and anyone actually attacked — runs for the ditch, and
 *              teleports home when shallow enough (below level 20, the same
 *              RETREAT_TELEPORT_LEVEL the PvP defensive node uses).
 *
 * Session ends: inventory full or 5-10 minutes of gathering (seeded per
 * citizen), then "success" — the decision layer's citizen_bank hinge handles
 * the banking, reused not reinvented. Death ends the action ("failed"): the
 * engine owns the death, the drops, and the economy sink.
 *
 * Eligibility is personality-gated at the door: cautious/nervous/timid
 * citizens never pick this (the scoring snippet in CitizenDecisions keeps
 * them out; the action double-checks because directed picks exist).
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain. NO *2 modules, NO hash-derived fiction — every coordinate and
 * object comes from the live world.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
  approachObject,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { siteTile } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");
const { WILDERNESS_SURFACE } = require("../../../economy/constants");

// --- tuning (all magic numbers here) -----------------------------------------
const MIN_WILD_LEVEL = 30; // coal rocks / willow trees: below this the wild isn't worth the walk
const STAGE_Y = 3517; // staging tile: safe ground just south of the ditch
const FLEE_Y = 3515; // run target: south of the ditch, out of the wild
const DITCH_MIN_X = 2952; // levelled-area x bounds (mirrors Wilderness.LEVELLED_AREAS)
const DITCH_MAX_X = 3383;
const PROSPECT_REGION_RADIUS = 4; // ±256 tiles from the staging tile
const TARGET_SPREAD = 6; // pick randomly among this many nearest spots (destack)
const ARRIVE_RADIUS = 3;
const DIRECT_ROUTE_TILES = 20;
const CLICK_COOLDOWN_MS = 8000; // re-click only on a yield lull, like a human
const LULL_MS = 20000; // no inventory growth this long -> click again
const STALL_MS = 90000; // no growth this long after a click -> repick the spot
const MAX_REPICKS = 3;
const SESSION_MIN_MS = 5 * 60 * 1000;
const SESSION_MAX_MS = 10 * 60 * 1000;
const TRAVEL_CAP_MS = 20 * 60 * 1000; // travel + session hard cap: never stall the day
const FLEE_TIMEOUT_MS = 60 * 1000;
const WATCH_RADIUS = 10; // tiles — a real player this close is a potential PKer
const TELEPORT_LEVEL = 20; // below this wilderness level, teleporting out is legal

const START_LINES = Object.freeze([
  "this is sketchy but the ore is worth it",
  "nobody comes out here. that's the point",
  "quick in, quick out. rich rocks, no witnesses",
  "the wilds provide... if the wilds don't kill me first",
]);

const WATCHED_LINES = Object.freeze([
  "easy... just a miner",
  "i'm not looking for trouble, just ore",
  "you saw nothing. these rocks are mine",
  "relax. i'm almost done here",
]);

const FLEE_LINES = Object.freeze([
  "nope nope nope!",
  "not today!",
  "worth it? NOT worth it!",
  "i knew this was a bad idea!",
]);

// --- lazy engine seams (TS sources; stubbed in require.cache by tests) -------

function miningPlugin() {
  try {
    return require("../../../skills/Mining.plugin");
  } catch {
    return null;
  }
}

function woodcuttingPlugin() {
  try {
    return require("../../../skills/Woodcutting.plugin");
  } catch {
    return null;
  }
}

function objectCatalog() {
  try {
    return require("../../../bots/brain/BotObjectCatalog");
  } catch {
    return null;
  }
}

function mapObjects() {
  try {
    return require("../../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects")
      .MapObjects;
  } catch {
    return null;
  }
}

function skillEnum() {
  try {
    return require("../../../../src/main/typescript/elvarg/game/model/Skill").Skill;
  } catch {
    return null;
  }
}

function teleportKit() {
  try {
    const { TeleportHandler } = require("../../../../src/main/typescript/elvarg/game/model/teleportation/TeleportHandler");
    const { TeleportType } = require("../../../../src/main/typescript/elvarg/game/model/teleportation/TeleportType");
    const { Location } = require("../../../../src/main/typescript/elvarg/game/model/Location");
    if (!TeleportHandler || !TeleportType || !Location) return null;
    return { TeleportHandler, TeleportType, Location };
  } catch {
    return null;
  }
}

// --- personality gating -------------------------------------------------------
// Trait vocabulary matches the rest of the citizen system: "brave" gates
// boss-trip invites (CitizenSocialMechanics), "cautious" gates tavern bets
// (CitizenTavernGames), "nervous" feeds the humanizer risk profile.

const BRAVE_TRAITS = ["brave", "adventurous", "reckless", "daring"];
const CAUTIOUS_TRAITS = ["cautious", "nervous", "timid"];
// Steadfast is the narrower core of brave: these citizens finish the
// inventory when merely watched. The merely adventurous/daring still flee.
const STEADFAST_TRAITS = ["brave", "reckless"];

function personalityOf(player) {
  try {
    return player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    return {};
  }
}

function traitSetOf(personality) {
  return new Set(personality?.traits ?? []);
}

function demeanorOf(personality) {
  return String(personality?.demeanor ?? "");
}

function isCautious(personality) {
  const traits = traitSetOf(personality);
  if (CAUTIOUS_TRAITS.some((t) => traits.has(t))) return true;
  const demeanor = demeanorOf(personality);
  return demeanor.includes("nervous") || demeanor.includes("soft-spoken");
}

function isBrave(personality) {
  const traits = traitSetOf(personality);
  if (BRAVE_TRAITS.some((t) => traits.has(t))) return true;
  const demeanor = demeanorOf(personality);
  return demeanor.includes("bold") || demeanor.includes("brash");
}

/** Steadfast: finishes the inventory when merely watched. */
function isSteadfast(personality) {
  if (isCautious(personality)) return false;
  const traits = traitSetOf(personality);
  if (STEADFAST_TRAITS.some((t) => traits.has(t))) return true;
  const demeanor = demeanorOf(personality);
  return demeanor.includes("bold") || demeanor.includes("brash");
}

/**
 * The door: only brave non-cautious player-bot citizens. Cautious citizens
 * must never pick this — the decision layer scores them out and this
 * double-checks because directed picks exist.
 */
function isWildGatherEligible(player) {
  try {
    if (!player || player.isPlayerBot?.() !== true) return false;
  } catch {
    return false;
  }
  const personality = personalityOf(player);
  if (isCautious(personality)) return false;
  return isBrave(personality);
}

// --- wilderness geometry ------------------------------------------------------
// WILDERNESS_SURFACE is the economy plugin's single definition of the wild
// (server/plugins/economy/constants.js). wildLevelAt mirrors the engine's
// Wilderness.levelAt (elvarg/game/content/wilderness/Wilderness.ts).

function inWilderness(x, y, z = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return (
    z === WILDERNESS_SURFACE.z &&
    x >= WILDERNESS_SURFACE.x1 &&
    x <= WILDERNESS_SURFACE.x2 &&
    y >= WILDERNESS_SURFACE.y1 &&
    y <= WILDERNESS_SURFACE.y2
  );
}

function wildLevelAt(x, y) {
  if (x >= 2944 && x <= 3391 && y >= 3520 && y <= 4351) {
    return Math.floor((y - 3520) / 8) + 1;
  }
  return 0;
}

function clampDitchX(x) {
  return Math.min(Math.max(x, DITCH_MIN_X), DITCH_MAX_X);
}

/** Safe-ground tile just south of the ditch, at the citizen's own x. */
function stagingTile(player) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    return { x: clampDitchX(loc.getX()), y: STAGE_Y, z: 0 };
  } catch {
    return null;
  }
}

// --- skill + tier selection ----------------------------------------------------

function safeLevel(manager, skill) {
  try {
    const lvl = manager.getCurrentLevel(skill);
    return Number.isInteger(lvl) && lvl > 0 ? lvl : 1;
  } catch {
    return 1;
  }
}

function skillLevels(player) {
  const Skill = skillEnum();
  const manager = player?.getSkillManager?.();
  if (!Skill || !manager) return { mining: 1, woodcutting: 1 };
  return {
    mining: safeLevel(manager, Skill.MINING),
    woodcutting: safeLevel(manager, Skill.WOODCUTTING),
  };
}

/** Richest-first rock tiers from the Mining plugin's own ROCKS table. */
function rockTiers() {
  const Mining = miningPlugin();
  const rocks = Mining?.ROCKS ?? [];
  return rocks
    .filter((r) => r && r.objectName && Number.isFinite(r.level))
    .map((r) => ({
      tier: String(r.objectName).replace(/\s+rocks?$/i, "").trim().toLowerCase(),
      level: r.level,
      click: "Mine",
    }))
    .sort((a, b) => b.level - a.level);
}

/** Richest-first tree tiers from the Woodcutting plugin's own TREES table. */
function treeTiers() {
  const WC = woodcuttingPlugin();
  const trees = WC?.TREES ?? [];
  return trees
    .filter((t) => t && t.name && Number.isFinite(t.requiredLevel))
    .map((t) => ({
      tier: String(t.name).toLowerCase(),
      level: t.requiredLevel,
      click: [].concat(t.action ?? "Chop down")[0] ?? "Chop down",
    }))
    .sort((a, b) => b.level - a.level);
}

/**
 * The citizen's wild skill: the higher of Mining/Woodcutting, level-gated.
 * Returns { key, catalog, level, tier, click, ids } or null when the citizen
 * has no business in the wild (too low, or the catalog can't resolve ids).
 */
function pickSkillFor(player, overrides = {}) {
  const levels = overrides.levels ?? skillLevels(player);
  const miningFirst = levels.mining >= levels.woodcutting;
  const defs = [
    {
      key: "mining",
      catalog: "rock",
      level: levels.mining,
      tiers: overrides.rockTiers ?? rockTiers(),
    },
    {
      key: "woodcutting",
      catalog: "tree",
      level: levels.woodcutting,
      tiers: overrides.treeTiers ?? treeTiers(),
    },
  ].sort((a, b) =>
    miningFirst ? (a.key === "mining" ? -1 : 1) : a.key === "woodcutting" ? -1 : 1
  );
  const catalog = objectCatalog();
  if (!catalog?.resolveCatalogObjectIds) return null;
  for (const def of defs) {
    if (def.level < MIN_WILD_LEVEL) continue;
    const tier = (def.tiers ?? []).find((t) => t.level <= def.level);
    if (!tier) continue;
    let ids = [];
    try {
      ids = catalog.resolveCatalogObjectIds({ catalog: def.catalog, tier: tier.tier }) ?? [];
    } catch {
      ids = [];
    }
    if (!ids.length) continue;
    return { key: def.key, catalog: def.catalog, level: def.level, tier: tier.tier, click: tier.click, ids };
  }
  return null;
}

// --- spot prospecting ----------------------------------------------------------

/**
 * Find a REAL resource object inside the wilderness rect: the same
 * objectSearch seam the bot brain's InteractObject uses, filtered to the
 * economy plugin's wilderness rect. Picks randomly among the nearest few so
 * brave citizens don't stack on one rock. Returns
 * { objectId, x, y, z } or null.
 */
function prospectSpot(world, player, ids, rng = Math.random) {
  try {
    const loc = player.getLocation?.();
    if (!loc || !Array.isArray(ids) || ids.length === 0) return null;
    const px = loc.getX();
    const py = loc.getY();
    const candidates =
      world?.objectSearch?.findCandidatesByIds?.(player, ids, {
        regionRadius: PROSPECT_REGION_RADIUS,
        z: 0,
        privateArea: player.getPrivateArea?.() ?? null,
      }) ?? [];
    const live = [];
    for (const object of candidates) {
      const objectLoc = object?.getLocation?.();
      if (!objectLoc) continue;
      const x = objectLoc.getX();
      const y = objectLoc.getY();
      const z = objectLoc.getZ?.() ?? 0;
      if (!inWilderness(x, y, z)) continue;
      live.push({
        object,
        dist: Math.max(Math.abs(x - px), Math.abs(y - py)),
      });
    }
    live.sort((a, b) => a.dist - b.dist);
    const pool = live.slice(0, TARGET_SPREAD);
    if (pool.length === 0) return null;
    const pick = pool[Math.floor(rng() * pool.length)];
    const pickLoc = pick.object.getLocation();
    return {
      objectId: pick.object.getId(),
      x: pickLoc.getX(),
      y: pickLoc.getY(),
      z: pickLoc.getZ?.() ?? 0,
    };
  } catch {
    return null;
  }
}

function resolveTargetObject(player, target) {
  const MO = mapObjects();
  if (!MO || !target) return null;
  try {
    const loc = player.getLocation?.()?.clone?.();
    if (!loc || typeof loc.set !== "function") return null;
    loc.set(target.x, target.y, target.z);
    return MO.get(target.objectId, loc, player.getPrivateArea?.() ?? null) ?? null;
  } catch {
    return null;
  }
}

// --- danger sensing -------------------------------------------------------------

/**
 * Real-player threat sense. attacked: the citizen is actually taking damage
 * (combat attacker set — the same signal PlayerAttackReaction uses).
 * watched: a REAL player (not a fellow citizen bot) within a few tiles — a
 * potential PKer sizing them up.
 */
function senseDanger(player) {
  let attacked = false;
  try {
    const combat = player.getCombat?.();
    if (combat?.getAttacker?.()) attacked = true;
  } catch {
    // treat as unattacked
  }
  let watched = false;
  try {
    const me = player.getUsername?.();
    const myLoc = player.getLocation?.();
    const locals = player.getLocalPlayers?.() ?? [];
    for (const other of locals) {
      if (!other || other === player) continue;
      if (other.getUsername?.() === me) continue;
      if (other.isPlayerBot?.() === true) continue; // fellow citizen, not a threat
      const oLoc = other.getLocation?.();
      if (!oLoc || !myLoc) continue;
      const d = Math.max(
        Math.abs(oLoc.getX() - myLoc.getX()),
        Math.abs(oLoc.getY() - myLoc.getY())
      );
      if (d <= WATCH_RADIUS) {
        watched = true;
        break;
      }
    }
  } catch {
    // treat as unwatched
  }
  return { attacked, watched, threat: attacked || watched };
}

// --- small helpers ---------------------------------------------------------------

function botTile(player) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  const t = botTile(player);
  if (!t || !tile) return false;
  return (
    t.z === (tile.z ?? 0) &&
    Math.max(Math.abs(t.x - tile.x), Math.abs(t.y - tile.y)) <= radius
  );
}

function inventoryFull(player) {
  try {
    const inv = player.getInventory?.();
    if (!inv) return true;
    return typeof inv.isFull === "function" ? inv.isFull() : false;
  } catch {
    return true;
  }
}

function inventoryItemCount(player) {
  try {
    const items = player.getInventory?.()?.getItems?.() ?? [];
    let total = 0;
    for (const item of items) {
      total += item?.getAmount?.() ?? 0;
    }
    return total;
  } catch {
    return 0;
  }
}

function walkTo(player, tile, reason, spread = 8) {
  const username = player.getUsername?.() ?? "unknown";
  const spot = personalSpot(username, tile.x, tile.y, 3, spread);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason,
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function logWild(world, player, event, extra) {
  try {
    world?.log?.("citizen_wild_gather", {
      citizen: player.getUsername?.(),
      event,
      ...(extra ?? {}),
    });
  } catch {
    // non-fatal
  }
}

function createCitizenWildGatherAction(spec, world) {
  const chatterMinMs = Math.max(1000, Number(spec.chatterMinMs ?? 45000));
  const chatterMaxMs = Math.max(chatterMinMs, Number(spec.chatterMaxMs ?? 180000));

  function botState(player) {
    return playerState(action, player, () => {
      const personality = personalityOf(player);
      return {
        rng: agentRng(`wildgather:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        steadfast: isSteadfast(personality),
        phase: "init",
        skill: null, // pickSkillFor() result
        staging: null,
        target: null, // { objectId, x, y, z }
        repicks: 0,
        lastClickAt: 0,
        lastProgressAt: 0,
        itemCount: 0,
        giveUpAt: 0,
        sessionEndsAt: 0,
        fleeUntil: 0,
        teleportTried: false,
        teleportStarted: false,
        startedChat: false,
        nextChatAt: 0,
      };
    });
  }

  function maybeChat(player, state, nowMs, pool, rate = 0.6, force = false) {
    if (!force && nowMs < state.nextChatAt) return;
    const gap = chatterMinMs + state.rng() * (chatterMaxMs - chatterMinMs);
    state.nextChatAt = nowMs + Math.round(gap / Math.max(0.2, state.human?.chatRate ?? 1));
    if (!force && !chance(state.rng, rate)) return;
    try {
      const personality = personalityOf(player);
      const line = pool[Math.floor(state.rng() * pool.length)];
      if (!line) return;
      sayPublic(player, voiceLine(voiceFor(personality), { plain: [line.slice(0, 120)] }));
    } catch {
      // Cosmetic only.
    }
  }

  function initTick(ctx, state) {
    const { player, nowMs } = ctx;
    if (!isWildGatherEligible(player)) {
      return "failed"; // not brave, or not a citizen bot at all
    }
    const skill = pickSkillFor(player);
    if (!skill) {
      return "failed"; // too low, or no real objects for the tier
    }
    if (inventoryFull(player)) {
      return "failed"; // pack already full — the bank hinge owns this state
    }
    const staging = stagingTile(player);
    if (!staging) {
      return "failed";
    }
    state.skill = skill;
    state.staging = staging;
    state.itemCount = inventoryItemCount(player);
    state.lastProgressAt = nowMs;
    state.giveUpAt = nowMs + TRAVEL_CAP_MS;
    state.phase = "stage";
    logWild(world, player, "depart", {
      skill: skill.key,
      tier: skill.tier,
      level: skill.level,
    });
    return "running";
  }

  function stageTick(ctx, state) {
    const { player, nowMs } = ctx;
    if (nowMs >= state.giveUpAt) {
      return "success"; // the walk ate the day — move on
    }
    if (atTile(player, state.staging)) {
      state.phase = "prospect";
      return "running";
    }
    if (player.getForceMovement?.() != null) return "running";
    try {
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";
    } catch {
      // fall through and re-issue the walk
    }
    walkTo(player, state.staging, "citizen_wild_gather_stage");
    return "running";
  }

  function prospectTick(ctx, state) {
    const { player, nowMs } = ctx;
    if (nowMs >= state.giveUpAt) {
      return "success";
    }
    const spot = prospectSpot(world, player, state.skill.ids, state.rng);
    if (!spot) {
      // No real resource in reach — a human shrugs and heads home.
      logWild(world, player, "no-spot", { skill: state.skill.key });
      return "success";
    }
    state.target = spot;
    state.phase = "gather";
    // The gathering session clock starts on arrival, not at departure: the
    // walk to the wild shouldn't eat the 5-10 minute session.
    state.sessionEndsAt =
      nowMs + SESSION_MIN_MS + state.rng() * (SESSION_MAX_MS - SESSION_MIN_MS);
    logWild(world, player, "arrive", {
      skill: state.skill.key,
      x: spot.x,
      y: spot.y,
    });
    return "running";
  }

  function clickTarget(world, player, object) {
    const objectLoc = object.getLocation();
    try {
      player.getMovementQueue()?.walkToObject?.(object, {
        execute: () => {
          world.emitObjectInteraction?.({
            player,
            object,
            objectId: object.getId(),
            clickType: 1,
            location: {
              x: objectLoc.getX(),
              y: objectLoc.getY(),
              z: objectLoc.getZ?.() ?? 0,
            },
            sourceLocation: {
              x: player.getLocation().getX(),
              y: player.getLocation().getY(),
              z: player.getLocation().getZ?.() ?? 0,
            },
            handled: false,
          });
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  function gatherTick(ctx, state) {
    const { player, nowMs } = ctx;
    // Session end: full pack or the clock. The bank hinge re-decides.
    if (inventoryFull(player) || nowMs >= state.sessionEndsAt || nowMs >= state.giveUpAt) {
      logWild(world, player, "session-end", {
        full: inventoryFull(player),
        items: inventoryItemCount(player),
      });
      return "success";
    }

    if (!state.startedChat) {
      state.startedChat = true;
      maybeChat(player, state, nowMs, START_LINES, 0.8, true);
    }

    // Danger sense: attacked, or a real player close enough to be a PKer.
    const danger = senseDanger(player);
    if (danger.threat) {
      const merelyWatched = danger.watched && !danger.attacked;
      if (state.steadfast && merelyWatched && !inventoryFull(player)) {
        // Brave: finish the inventory. Say so, nervously.
        maybeChat(player, state, nowMs, WATCHED_LINES, 0.8);
      } else {
        state.phase = "flee";
        state.fleeUntil = nowMs + FLEE_TIMEOUT_MS;
        maybeChat(player, state, nowMs, FLEE_LINES, 1.0, true);
        logWild(world, player, "flee", {
          attacked: danger.attacked,
          watched: danger.watched,
        });
        return "running";
      }
    }

    if (!state.target) {
      state.phase = "prospect";
      return "running";
    }
    const object = resolveTargetObject(player, state.target);
    if (!object) {
      // Rock mined out / tree felled away, or the index moved on — repick.
      state.target = null;
      state.repicks += 1;
      if (state.repicks > MAX_REPICKS) {
        return "success"; // the patch is worked out — bank what we've got
      }
      state.phase = "prospect";
      return "running";
    }

    const tile = botTile(player);
    if (!tile) {
      return "running"; // location unreadable this tick — try again next tick
    }
    const tLoc = object.getLocation();
    const dist = Math.max(
      Math.abs(tile.x - tLoc.getX()),
      Math.abs(tile.y - tLoc.getY())
    );
    if (dist > DIRECT_ROUTE_TILES) {
      try {
        approachObject(player, object, { nowMs, reason: "citizen_wild_gather" });
      } catch {
        walkTo(player, { x: tLoc.getX(), y: tLoc.getY(), z: 0 }, "citizen_wild_gather");
      }
      return "running";
    }
    if (player.getForceMovement?.() != null) return "running";
    try {
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";
    } catch {
      // fall through and try the click
    }

    // Yield tracking: clicks land on a lull, like a human re-clicking a rock.
    const count = inventoryItemCount(player);
    if (count > state.itemCount) {
      state.itemCount = count;
      state.lastProgressAt = nowMs;
    }
    const sinceProgress = nowMs - state.lastProgressAt;
    if (sinceProgress >= STALL_MS && nowMs - state.lastClickAt > CLICK_COOLDOWN_MS) {
      // Clicked, waited, nothing landed — the spot is dead to us. Repick.
      state.target = null;
      state.repicks += 1;
      if (state.repicks > MAX_REPICKS) {
        return "success";
      }
      state.phase = "prospect";
      return "running";
    }
    if (state.lastClickAt > 0 && nowMs - state.lastClickAt < CLICK_COOLDOWN_MS) {
      return "running";
    }
    if (sinceProgress < LULL_MS && state.lastClickAt > 0) {
      return "running"; // yields still landing — hands off
    }
    state.lastClickAt = nowMs;
    clickTarget(world, player, object);
    return "running";
  }

  function fleeTick(ctx, state) {
    const { player, nowMs } = ctx;
    if (nowMs >= state.fleeUntil) {
      return "success"; // ran long enough — don't stall the day
    }
    const tile = botTile(player);
    if (!tile) {
      return "failed";
    }
    if (!inWilderness(tile.x, tile.y, tile.z)) {
      // Out of the wild — the run is over, re-decide (bank hinge next).
      try {
        clearMovementRequest(player);
      } catch {
        // best effort
      }
      logWild(world, player, "escaped");
      return "success";
    }

    // Shallow enough to teleport: vanish home like the PvP defensive node.
    const kit = teleportKit();
    const level = wildLevelAt(tile.x, tile.y);
    if (kit && !state.teleportTried && level >= 1 && level < TELEPORT_LEVEL) {
      state.teleportTried = true;
      const bank = siteTile(player, "bank");
      if (bank) {
        try {
          const dest = new kit.Location(bank.x, bank.y, bank.z ?? 0);
          const combat = player.getCombat?.();
          if (combat?.getTarget?.()) {
            try {
              combat.reset?.();
            } catch {
              // best effort
            }
          }
          if (kit.TeleportHandler.checkReqs(player, dest, TELEPORT_LEVEL)) {
            kit.TeleportHandler.teleport(player, dest, kit.TeleportType.NORMAL, false);
            state.teleportStarted = true;
            logWild(world, player, "teleport-escape", { level });
          }
        } catch {
          // fall through to running
        }
      }
    }
    if (state.teleportStarted) {
      return "running"; // the teleport animation is running its course
    }

    // Otherwise run for the ditch, south, like everyone who's ever lived.
    try {
      player.setRunning?.(player.getRunEnergy?.() > 0);
    } catch {
      // best effort
    }
    if (player.getForceMovement?.() != null) return "running";
    try {
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";
    } catch {
      // fall through and re-issue the run
    }
    walkTo(player, { x: clampDitchX(tile.x), y: FLEE_Y, z: 0 }, "citizen_wild_gather_flee", 4);
    return "running";
  }

  const action = {
    id: "citizenWildGather",
    update(ctx) {
      const { player, nowMs } = ctx;
      // Dead is dead: the engine owns the death, the drops, the sink.
      try {
        if (!player || (player.getHitpoints?.() ?? 1) <= 0) {
          return "failed";
        }
      } catch {
        return "failed";
      }
      const state = botState(player);
      switch (state.phase) {
        case "stage":
          return stageTick(ctx, state);
        case "prospect":
          return prospectTick(ctx, state);
        case "gather":
          return gatherTick(ctx, state);
        case "flee":
          return fleeTick(ctx, state);
        default:
          return initTick(ctx, state);
      }
    },
    stop(ctx) {
      if (ctx?.player) {
        try {
          clearMovementRequest(ctx.player);
        } catch {
          // best effort
        }
      }
    },
  };

  return action;
}

module.exports = {
  createCitizenWildGatherAction,
  // exposed for tests
  _isWildGatherEligible: isWildGatherEligible,
  _isBrave: isBrave,
  _isCautious: isCautious,
  _isSteadfast: isSteadfast,
  _inWilderness: inWilderness,
  _wildLevelAt: wildLevelAt,
  _stagingTile: stagingTile,
  _pickSkillFor: pickSkillFor,
  _prospectSpot: prospectSpot,
  _senseDanger: senseDanger,
  _rockTiers: rockTiers,
  _treeTiers: treeTiers,
  _TELEPORT_LEVEL: TELEPORT_LEVEL,
  _WATCH_RADIUS: WATCH_RADIUS,
  _MIN_WILD_LEVEL: MIN_WILD_LEVEL,
};
