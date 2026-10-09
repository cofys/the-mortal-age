"use strict";

/**
 * CitizenResearch — the brain action for doing science.
 *
 * The citizen walks to their kingdom's laboratory, then either:
 *   - works on their running experiment (human-paced, grants a small
 *     progress boost for hands-on work), or
 *   - starts a new experiment: picks the best template they qualify for
 *     (field skill + lab level), consumes the REAL materials from their
 *     real inventory, and registers the experiment.
 * No affordable experiment → walk home, done honestly.
 *
 * Completion happens on the slow tick (CitizenScienceLife), which resolves
 * the experiment, records discoveries, and awards fame. This action is the
 * physical "doing the science" half.
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
const WORK_ROUNDS = 4;
const ARRIVE_RADIUS = 8;
const RESEARCH_COOLDOWN_MS = 15000; // human-paced lab work

function scienceApi() {
  try {
    return require("../../lib/CitizenScience");
  } catch {
    return null;
  }
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

/** Clean herb ids read from the Herblore plugin at runtime (never hardcoded). */
function cleanHerbIds() {
  try {
    const Herblore = require("../../skills/Herblore.plugin.js");
    const ids = [];
    for (const r of Herblore.HERBLORE_RECIPES ?? []) {
      if (r.kind === "clean" && Number.isFinite(r.outputId)) ids.push(r.outputId);
    }
    return ids;
  } catch {
    return [];
  }
}

/** Resolve a material key to a real item id (defensive). */
function materialIdFor(key, Science) {
  if (key === "clean_herb") {
    const ids = cleanHerbIds();
    return ids.length ? ids[0] : null;
  }
  const id = Science.MATERIAL_IDS[key];
  return Number.isFinite(id) && id > 0 ? id : null;
}

function fieldSkillLevel(player, field, Science) {
  try {
    const skill = Science.FIELDS[field]?.skill;
    if (!skill) {
      // Astronomy: curiosity, not a skill. Read the personality traits.
      const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
      const p = player?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const traits = p.traits ?? [];
      return traits.includes("curious") || traits.includes("adventurous") ? 35 : 1;
    }
    return player?.getSkills?.()?.getLevel?.(skill) ?? player?.skills?.[skill] ?? 1;
  } catch {
    return 1;
  }
}

/** Best experiment template the scientist can run with what's on hand. */
function affordableExperiment(player, Science, kingdomId) {
  const inv = player?.getInventory?.();
  if (!inv) return null;
  const username = player?.getUsername?.() ?? player?.username ?? "";
  const rec = Science.scientistFor(username);
  if (!rec) return null;
  const lab = Science.labFor(kingdomId);
  for (const tmplId of Science.experimentIds()) {
    const tmpl = Science.experiment(tmplId);
    if (!tmpl || tmpl.field !== rec.field) continue;
    if (lab.level < tmpl.labLevel) continue;
    if (fieldSkillLevel(player, tmpl.field, Science) < tmpl.levelReq) continue;
    // Already discovered by this kingdom? Skip repeats of the same finding.
    if (Science.hasDiscovery(kingdomId, tmpl.discoveryId)) continue;
    let ok = true;
    for (const [matKey, amount] of Object.entries(tmpl.materials)) {
      const itemId = materialIdFor(matKey, Science);
      if (!itemId || countItem(inv, itemId) < amount) {
        ok = false;
        break;
      }
    }
    if (ok) return tmplId;
  }
  return null;
}

function consumeMaterials(player, Science, tmplId) {
  const tmpl = Science.experiment(tmplId);
  if (!tmpl) return;
  const inv = player?.getInventory?.();
  if (!inv) return;
  for (const [matKey, amount] of Object.entries(tmpl.materials)) {
    const itemId = materialIdFor(matKey, Science);
    if (itemId) takeItem(inv, itemId, amount);
  }
}

function labTileFor(player, Science) {
  try {
    const kingdomId = kingdomIdOf(player);
    return Science.labTile(kingdomId) ?? siteTile(player, "market");
  } catch {
    return null;
  }
}

function createCitizenResearchAction(player, director) {
  const Science = scienceApi();
  if (!Science) return { id: "citizenResearch", tick: () => "success" };

  const state = {
    phase: "outbound",
    startedAt: Date.now(),
    rounds: 0,
    lastWork: 0,
    target: null,
  };

  function failSafe() {
    try {
      clearMovementRequest(player);
    } catch { /* movement is best-effort */ }
    return "success";
  }

  return {
    id: "citizenResearch",
    tick() {
      try {
        if (!player) return failSafe();
        if (Date.now() - state.startedAt > GIVE_UP_MS) return failSafe();

        const kingdomId = kingdomIdOf(player);
        const username = player?.getUsername?.() ?? player?.username ?? "";
        const rec = Science.scientistFor(username);
        if (!rec) return failSafe(); // not a scientist — nothing to do

        if (state.phase === "outbound") {
          state.target = labTileFor(player, Science);
          if (!state.target) return failSafe();
          requestMovement(player, state.target);
          state.phase = "working";
          return "running";
        }

        // Arrived? Check distance to lab.
        try {
          const pos = playerState(player)?.position ?? player?.getPosition?.();
          if (pos && state.target) {
            const dx = Math.abs((pos.x ?? 0) - (state.target.x ?? 0));
            const dy = Math.abs((pos.y ?? 0) - (state.target.y ?? 0));
            if (dx + dy > ARRIVE_RADIUS) return "running"; // still walking
          }
        } catch { /* position read is best-effort */ }

        if (state.phase === "working") {
          // Active experiment? Tinker on it (human-paced progress boost).
          const active = Science.experimentFor(username);
          if (active) {
            if (Date.now() - state.lastWork >= RESEARCH_COOLDOWN_MS) {
              Science.advanceExperiment(active.id, 2); // hands-on work counts double
              state.lastWork = Date.now();
              state.rounds += 1;
            }
            if (state.rounds >= WORK_ROUNDS) return failSafe();
            return "running";
          }
          // No active experiment — start the best affordable one.
          const tmplId = affordableExperiment(player, Science, kingdomId);
          if (!tmplId) return failSafe(); // nothing affordable — honest end
          consumeMaterials(player, Science, tmplId);
          Science.startExperiment(username, tmplId, kingdomId);
          state.phase = "started";
          return "running";
        }

        return failSafe();
      } catch {
        return failSafe();
      }
    },
  };
}

module.exports = { createCitizenResearchAction };
