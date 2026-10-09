"use strict";

/**
 * CitizenFishing — real catches for citizens who are actively fishing.
 *
 * The skilling session flow (lib/CitizenSkilling) walks citizens to the dock
 * and plays the fishing animation, but its yield is data-tier: items via the
 * real inventory but XP into the fictional skillStore, and catches are not
 * gated to real fishing spots. This module is the real-yield layer:
 *
 *   - Only fires for MATERIALIZED citizens (director.isOnline + getBot) who
 *     are in an arrived fishing skilling session — the LOD gate.
 *   - Only fires when the citizen stands near a REAL "Fishing spot" NPC,
 *     resolved through the Fishing skill plugin's own spot tables
 *     (server/plugins/skills/Fishing.plugin.js) via getSpotTool.
 *   - Rolls the catch with the plugin's REAL tables (FISH defs) and REAL
 *     math (rollCatch: level-gated, Wiki catch charts, depth-module events).
 *   - Grants REAL items via the player inventory API (adds) and REAL Fishing
 *     XP via the player skills API (addExperiences). Real XP flows through
 *     SkillManager, so the deployed level-up celebration (fireworks graphic
 *     + sound + onCitizenLevelUpNotice chat announcement) fires for citizens
 *     exactly as it does for players.
 *   - Inventory-full: no catch is granted (raw fish don't stack). The
 *     decision layer already scores citizen_bank at 70 when freeSlots <= 2,
 *     so the existing CitizenBank hinge handles the banking — reused, not
 *     reinvented.
 *
 * Zero LLM. Tick-safe: per-citizen try/catch, every engine read guarded.
 * The data-tier fishing grant in CitizenSkilling.doSkillAction is skipped for
 * fishing (this module owns the yield now) — no double-dipping.
 */

const { normalizeName } = require("../../lib/CitizenBonds");

// --- tuning (all magic numbers here) -----------------------------------------
const CATCH_MIN_MS = 15000; // fastest steady catch cadence per citizen
const CATCH_MAX_MS = 32000; // slowest; randomized per catch, human pacing
const SPOT_RADIUS = 6; // tiles — must be this close to a real fishing-spot NPC
const SITE_RADIUS = 12; // tiles — must still be near the session's dock site
const JOURNAL_CHANCE = 0.12; // journal a real catch this often (LLM truth)

// nextCatchAt: normalized username -> ms timestamp of next allowed attempt.
const nextCatchAt = new Map();

function fishingPlugin() {
  try {
    return require("../../../skills/Fishing.plugin.js");
  } catch {
    return null;
  }
}

function skillingSessions() {
  try {
    return require("../../lib/CitizenSkilling")._sessions ?? new Map();
  } catch {
    return new Map();
  }
}

function journal() {
  try {
    return require("../../lib/CitizenJournal").getJournal();
  } catch {
    return null;
  }
}

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY() };
  } catch {
    return null;
  }
}

/** The arrived fishing session this citizen is a member of, if any. */
function fishingSessionFor(sessions, username) {
  const key = normalizeName(username);
  for (const session of sessions.values()) {
    if (!session || session.skill !== "fishing" || !session.arrived) continue;
    const members = session.members ?? [];
    for (const m of members) {
      if (normalizeName(m) === key) return session;
    }
  }
  return null;
}

/**
 * Find a real fishing-spot NPC near the bot, resolved through the Fishing
 * plugin's own spot tables. Returns { npc, tool } or null.
 */
function fishSpotNear(Fishing, bot, bx, by) {
  let npcs = [];
  try {
    npcs = bot.getLocalNpcs?.() ?? [];
  } catch {
    return null;
  }
  const smallNetId = Fishing.TOOLS?.NET?.id;
  for (const npc of npcs) {
    try {
      const nloc = npc.getLocation?.();
      if (!nloc) continue;
      if (chebyshev(nloc.getX(), nloc.getY(), bx, by) > SPOT_RADIUS) continue;
      const def = npc.getDefinition?.();
      const actions = def?.getActions?.() ?? [];
      const tools = [];
      for (let click = 1; click <= actions.length; click++) {
        const tool = Fishing.getSpotTool(npc.getId(), def, click);
        if (tool && !tools.includes(tool)) tools.push(tool);
      }
      if (!tools.length) continue;
      // Prefer the small net: no bait, and it matches the citizen fishing
      // visual (animation 621). Otherwise the spot's first tool.
      const tool = tools.find((t) => t.id === smallNetId) ?? tools[0];
      return { npc, tool };
    } catch {
      // Next NPC — never break the scan on one bad entry.
    }
  }
  return null;
}

function inventoryFull(bot) {
  try {
    const inv = bot.getInventory?.();
    if (!inv) return true; // no inventory to read — don't grant into the void
    return typeof inv.isFull === "function" ? inv.isFull() : false;
  } catch {
    return true;
  }
}

function grantCatch(bot, Skill, session, caught) {
  const landed = [];
  for (const fish of caught) {
    let amount = 1;
    try {
      amount = typeof fish.amount === "function" ? fish.amount(bot) : 1;
      if (!Number.isFinite(amount) || amount < 1) amount = 1;
    } catch {
      amount = 1;
    }
    // Re-check space per fish: a full pack banks via the decision layer
    // (citizen_bank scores 70 at freeSlots <= 2) — never conjure overflow.
    if (inventoryFull(bot)) break;
    try {
      bot.getInventory().adds(fish.id, amount);
    } catch {
      break;
    }
    try {
      bot.getSkillManager().addExperiences(Skill.FISHING, fish.experience);
      for (const [skill, xp] of fish.extraXp ?? []) {
        bot.getSkillManager().addExperiences(skill, xp);
      }
    } catch {
      // XP grant failed — the item already landed; keep the world truthful
      // by not journaling this one as a full catch below.
      continue;
    }
    session.items = (session.items ?? 0) + amount;
    session.xp = (session.xp ?? 0) + fish.experience;
    landed.push({ fish, amount });
  }
  return landed;
}

function describeLanded(landed) {
  return landed
    .map(({ fish, amount }) => (amount > 1 ? `${amount} ${fish.caught}` : fish.caught))
    .join(", ");
}

function doCatchAttempt(ctx) {
  const { director, record, bot, session, Fishing, Skill, nowMs } = ctx;
  void director;
  const tile = botTile(bot);
  if (!tile) return;
  // Still at the work site — arrived sessions can drift.
  const site = session.site;
  if (site && chebyshev(tile.x, tile.y, site.x, site.y) > SITE_RADIUS) return;

  const spot = fishSpotNear(Fishing, bot, tile.x, tile.y);
  if (!spot) return; // at the dock but no real spot in range — no fish

  let level = 1;
  try {
    level = bot.getSkillManager().getCurrentLevel(Skill.FISHING);
  } catch {
    return;
  }
  if (level < (spot.tool.level ?? 1)) return;

  if (inventoryFull(bot)) return; // the bank hinge owns this state

  let caught = [];
  try {
    const nloc = spot.npc.getLocation();
    caught =
      Fishing.rollCatch(bot, spot.tool, Math.random, 100, {
        x: nloc.getX(),
        y: nloc.getY(),
        npcId: spot.npc.getId(),
      }) ?? [];
  } catch {
    return; // roll failed — skip this round, tick-safe
  }
  if (!caught.length) return; // miss — the water keeps its secrets

  const landed = grantCatch(bot, Skill, session, caught);
  if (landed.length && Math.random() < JOURNAL_CHANCE) {
    try {
      journal()?.log(record.username, "work", `Netted ${describeLanded(landed)}.`);
    } catch {
      // Non-fatal.
    }
  }
  void nowMs;
}

/**
 * Director tick entry. LOD-gated: only materialized citizens (isOnline +
 * getBot) in arrived fishing sessions can land real catches.
 */
function tickCitizenFishing(director, overrides = {}) {
  const nowMs = overrides.nowMs ?? Date.now();
  const Fishing = overrides.fishing ?? fishingPlugin();
  if (!Fishing?.rollCatch || !Fishing?.getSpotTool || !Fishing?.TOOLS) return;
  const Skill = director?.api?.core?.Skill;
  if (!Skill?.FISHING) return;
  const sessions = overrides.sessions ?? skillingSessions();
  if (!sessions || sessions.size === 0) return;
  let roster = [];
  try {
    roster = [...(director.roster?.values?.() ?? [])];
  } catch {
    return;
  }

  for (const record of roster) {
    try {
      if (!record || !director.isOnline(record)) continue; // LOD gate
      const bot = director.getBot(record);
      if (!bot) continue;
      const session = fishingSessionFor(sessions, record.username);
      if (!session) continue; // not actively fishing
      const key = normalizeName(record.username);
      if (nowMs < (nextCatchAt.get(key) ?? 0)) continue;
      nextCatchAt.set(
        key,
        nowMs + CATCH_MIN_MS + Math.random() * (CATCH_MAX_MS - CATCH_MIN_MS)
      );
      doCatchAttempt({ director, record, bot, session, Fishing, Skill, nowMs });
    } catch {
      // Per-citizen isolation — one bad citizen never breaks the tick.
    }
  }
}

module.exports = {
  tickCitizenFishing,
  // exposed for tests
  _resetForTests() {
    nextCatchAt.clear();
  },
  _nextCatchAt: nextCatchAt,
  _fishingSessionFor: fishingSessionFor,
  _fishSpotNear: fishSpotNear,
};
