"use strict";

/**
 * Militia — citizen war participation with real combat.
 *
 * When kingdoms go to war, brave citizens volunteer as militia. They muster
 * at their capital, march to the fight, and engage real enemy NPCs with the
 * real combat engine (bot.getCombat().attack, same path as CitizenSlayer).
 * They take real damage, can really die (funerals via CitizenFunerals), and
 * take orders from the Marshal (attack/defend/fallback).
 *
 * Data model:
 * - Militia roster: in-memory Map, username -> { kingdomId, side, joinedAt }.
 *   Rebuilt from citizen attributes on boot; the attribute
 *   `citizens:militia` is the source of truth per citizen.
 * - Orders: per-kingdom { order: 'attack'|'defend'|'fallback', setBy, setAt }.
 *   Set by the Marshal via OfficeDashboardApi; read by CitizenMilitia action.
 * - Enemy NPCs: spawned during sieges near the defender's castle. Real NPCs
 *   with real HP that fight back. Despawned when the siege ends.
 * - Kill tracking: militia kills feed siege power (every 10 kills = +1 power
 *   for their side that tick).
 *
 * Zero LLM. All combat through the real engine. Deaths are real.
 */

const Store = require("./KingdomStore");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Minimum combat level to volunteer for militia. */
const MILITIA_MIN_COMBAT = 15;
/** Base volunteer chance per recruitment tick for eligible citizens. */
const VOLUNTEER_BASE_CHANCE = 0.08;
/** Brave/aggressive personalities volunteer this much more. */
const BRAVE_BONUS = 0.12;
/** Enemy NPC id: Guard (real OSRS NPC, fights back). */
const RAIDER_NPC_ID = 11911;
/** How many raiders to spawn per siege (scales with defender fort tier). */
const RAIDERS_BASE = 4;
const RAIDERS_PER_FORT_TIER = 2;
/** Raiders spawn this far from the defender's capital center. */
const RAIDER_SPAWN_RADIUS = 12;
/** Militia kills needed for +1 siege power. */
const KILLS_PER_SIEGE_POWER = 10;
/** Attribute keys (mirrored in citizens/constants.js). */
const ATTR_MILITIA = "citizens:militia";

// ---------------------------------------------------------------------------
// State (in-memory; attributes are the persistent source of truth)
// ---------------------------------------------------------------------------

/** username (lowercase) -> { kingdomId, side: 'attacker'|'defender', joinedAt } */
const roster = new Map();
/** kingdomId -> { order: 'attack'|'defend'|'fallback', setBy, setAt } */
const orders = new Map();
/** siegeKey -> [{ npc, spawnedAt }] — spawned raider NPCs per siege */
const raiders = new Map();
/** kingdomId -> { kills, deaths } — this war's tally */
const tallies = new Map();

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const VALID_ORDERS = new Set(["attack", "defend", "fallback"]);

function getOrders(kingdomId) {
  const o = orders.get(String(kingdomId));
  return o ? o.order : "defend"; // default: hold ground
}

function setOrders(kingdomId, order, setBy) {
  if (!VALID_ORDERS.has(order)) {
    return { ok: false, reason: "invalid-order" };
  }
  orders.set(String(kingdomId), {
    order,
    setBy: setBy ?? null,
    setAt: Date.now(),
  });
  return { ok: true, order };
}

function clearOrders(kingdomId) {
  orders.delete(String(kingdomId));
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

function normalizeUsername(u) {
  return String(u ?? "").toLowerCase().trim();
}

function isMilitia(username) {
  return roster.has(normalizeUsername(username));
}

function militiaOf(username) {
  return roster.get(normalizeUsername(username)) ?? null;
}

function militiaForKingdom(kingdomId) {
  const out = [];
  for (const [username, rec] of roster) {
    if (rec.kingdomId === String(kingdomId)) {
      out.push({ username, ...rec });
    }
  }
  return out;
}

function militiaCount(kingdomId) {
  let n = 0;
  for (const rec of roster.values()) {
    if (rec.kingdomId === String(kingdomId)) n++;
  }
  return n;
}

/**
 * Enlist a citizen in the militia. Sets the attribute (persistent) and the
 * in-memory roster. Returns true if newly enlisted.
 */
function enlist(bot, kingdomId, side) {
  const username = bot?.getUsername?.();
  if (!username) return false;
  const key = normalizeUsername(username);
  if (roster.has(key)) return false;
  const rec = {
    kingdomId: String(kingdomId),
    side: side === "attacker" ? "attacker" : "defender",
    joinedAt: Date.now(),
  };
  roster.set(key, rec);
  try {
    bot.setAttribute?.(ATTR_MILITIA, JSON.stringify(rec));
  } catch {
    // Attribute is best-effort; roster is authoritative this session.
  }
  return true;
}

/**
 * Discharge a citizen from militia (war ended, or they fell). Clears the
 * attribute and roster entry.
 */
function discharge(botOrUsername, kingdomId) {
  const username =
    typeof botOrUsername === "string"
      ? botOrUsername
      : botOrUsername?.getUsername?.();
  if (!username) return false;
  const key = normalizeUsername(username);
  const rec = roster.get(key);
  if (!rec) return false;
  if (kingdomId && rec.kingdomId !== String(kingdomId)) return false;
  roster.delete(key);
  const bot =
    typeof botOrUsername === "string" ? null : botOrUsername;
  try {
    bot?.removeAttribute?.(ATTR_MILITIA);
  } catch {
    // Best-effort.
  }
  return true;
}

/** Discharge all militia of a kingdom (peace declared). */
function dischargeKingdom(kingdomId, getBot) {
  const kid = String(kingdomId);
  let n = 0;
  for (const [username, rec] of [...roster]) {
    if (rec.kingdomId === kid) {
      roster.delete(username);
      try {
        const bot = getBot?.(username);
        bot?.removeAttribute?.(ATTR_MILITIA);
      } catch {
        // Best-effort.
      }
      n++;
    }
  }
  clearOrders(kid);
  return n;
}

// ---------------------------------------------------------------------------
// Tallies (kills/deaths feed siege power)
// ---------------------------------------------------------------------------

function tallyFor(kingdomId) {
  const kid = String(kingdomId);
  if (!tallies.has(kid)) tallies.set(kid, { kills: 0, deaths: 0 });
  return tallies.get(kid);
}

function recordKill(kingdomId) {
  tallyFor(kingdomId).kills++;
}

function recordDeath(kingdomId) {
  tallyFor(kingdomId).deaths++;
}

function resetTally(kingdomId) {
  tallies.delete(String(kingdomId));
}

/**
 * Siege power bonus from militia performance: every KILLS_PER_SIEGE_POWER
 * kills = +1 power. Called by Siege.Kingdoms during tick resolution.
 */
function militiaSiegeBonus(kingdomId) {
  const t = tallies.get(String(kingdomId));
  if (!t) return 0;
  return Math.floor(t.kills / KILLS_PER_SIEGE_POWER);
}

// ---------------------------------------------------------------------------
// Raider spawning (enemy NPCs for militia to fight)
// ---------------------------------------------------------------------------

function siegeKey(attackerId, defenderId) {
  return `${attackerId}>${defenderId}`;
}

/**
 * Spawn raider NPCs near the defender's capital during a siege.
 * These are real NPCs — militia fight them with real combat, they fight
 * back, they can kill. Despawned when the siege ends.
 *
 * @param {object} api - plugin api (for spawnNpc)
 * @param {string} attackerId - attacking kingdom
 * @param {string} defenderId - defending kingdom
 * @param {object} capital - { x, y, z } defender capital center
 * @param {number} fortTier - defender fort tier (scales raider count)
 * @returns {number} raiders spawned
 */
function spawnRaiders(api, attackerId, defenderId, capital, fortTier = 0) {
  const key = siegeKey(attackerId, defenderId);
  // Don't double-spawn.
  if (raiders.has(key)) return 0;
  const count = RAIDERS_BASE + Math.max(0, Math.min(4, fortTier)) * RAIDERS_PER_FORT_TIER;
  const spawned = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const x = Math.round(capital.x + Math.cos(angle) * RAIDER_SPAWN_RADIUS);
    const y = Math.round(capital.y + Math.sin(angle) * RAIDER_SPAWN_RADIUS);
    try {
      const npc = api.spawnNpc?.({
        id: RAIDER_NPC_ID,
        x,
        y,
        z: capital.z ?? 0,
        wanderRadius: 8,
      });
      if (npc) {
        // Tag them as war raiders so militia can identify them.
        try {
          npc.warRaider = { attackerId: String(attackerId), defenderId: String(defenderId) };
        } catch {
          // Tag is best-effort.
        }
        spawned.push({ npc, spawnedAt: Date.now() });
      }
    } catch {
      // Spawn failed — skip this one.
    }
  }
  if (spawned.length > 0) {
    raiders.set(key, spawned);
  }
  return spawned.length;
}

/**
 * Despawn raiders for a siege (siege ended). Returns count removed.
 */
function despawnRaiders(attackerId, defenderId) {
  const key = siegeKey(attackerId, defenderId);
  const list = raiders.get(key);
  if (!list) return 0;
  let n = 0;
  for (const { npc } of list) {
    try {
      npc?.unregister?.();
      n++;
    } catch {
      // Already gone.
    }
  }
  raiders.delete(key);
  return n;
}

/** All live raiders for a siege (filters out dead/despawned). */
function liveRaiders(attackerId, defenderId) {
  const key = siegeKey(attackerId, defenderId);
  const list = raiders.get(key) ?? [];
  return list
    .map((r) => r.npc)
    .filter((npc) => {
      try {
        return npc && !npc.isDead?.() && !npc.isDying?.() && npc.isRegistered?.() !== false;
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// Volunteer eligibility
// ---------------------------------------------------------------------------

function combatLevel(bot) {
  try {
    return bot?.getSkillManager?.()?.getCombatLevel?.() ?? 3;
  } catch {
    return 3;
  }
}

/**
 * True if this citizen can volunteer: combat level high enough, not already
 * militia, not a refugee.
 */
function canVolunteer(bot) {
  if (!bot) return false;
  const username = bot.getUsername?.();
  if (!username || isMilitia(username)) return false;
  if (combatLevel(bot) < MILITIA_MIN_COMBAT) return false;
  // Refugees don't fight — they fled.
  try {
    const role = bot.getAttribute?.("citizens:role");
    if (role === "refugee") return false;
  } catch {
    // Ignore.
  }
  return true;
}

/**
 * Volunteer chance for an eligible citizen: base + bravery bonus.
 * Personality is a plain object; brave/aggressive traits raise the odds.
 */
function volunteerChance(bot, rng = Math.random) {
  let chance = VOLUNTEER_BASE_CHANCE;
  try {
    const p = bot.getAttribute?.("citizens:personality") ?? {};
    const bravery = Number(p.bravery ?? p.courage ?? 0.5);
    const aggression = Number(p.aggression ?? p.aggressiveness ?? 0.5);
    if (bravery > 0.7 || aggression > 0.7) chance += BRAVE_BONUS;
  } catch {
    // Personality unreadable — base chance.
  }
  return chance;
}

// ---------------------------------------------------------------------------
// Director tick: recruitment and discharge
// ---------------------------------------------------------------------------

/**
 * tickMilitia(director, api) — called from the CitizenDirector tick.
 *
 * For each active war: brave, able-bodied citizens of the warring kingdoms
 * may volunteer for the militia. Volunteers are enlisted and switched to
 * the militia_duty activity. When a war ends, its militia is discharged
 * and citizens return to normal life.
 *
 * During sieges, spawns raider NPCs near the defender's capital for the
 * militia to fight (real NPCs, real combat). Despawns them when the siege
 * ends.
 *
 * The director provides: roster (Map of citizen records), getBot(record),
 * switchActivity(record, activityId). The api provides spawnNpc.
 */
function tickMilitia(director, api) {
  let wars = [];
  try {
    wars = Store.getActiveWars?.() ?? [];
  } catch {
    return;
  }

  const activeKingdoms = new Set();
  for (const war of wars) {
    if (war?.attackerId) activeKingdoms.add(String(war.attackerId));
    if (war?.defenderId) activeKingdoms.add(String(war.defenderId));
  }

  // Discharge militia whose kingdom is no longer at war.
  for (const [username, rec] of [...roster]) {
    if (!activeKingdoms.has(rec.kingdomId)) {
      try {
        const bot = director.getBot?.({ username });
        discharge(bot ?? username, rec.kingdomId);
        // Send them home: switch back to routine.
        if (bot) {
          director.switchActivity?.({ username, currentActivityId: "militia_duty" }, "citizen_routine");
        }
      } catch {
        // Non-fatal.
      }
    }
  }

  // Siege raiders: spawn for active sieges, despawn for ended ones.
  try {
    syncSiegeRaiders(api);
  } catch {
    // Non-fatal.
  }

  if (!director?.roster) return;

  for (const war of wars) {
    for (const [kingdomId, side] of [
      [war.attackerId, "attacker"],
      [war.defenderId, "defender"],
    ]) {
      if (!kingdomId) continue;
      const kid = String(kingdomId);
      // Cap militia size so wars don't drain the streets.
      if (militiaCount(kid) >= 12) continue;
      for (const record of director.roster.values()) {
        if (record.kingdomId !== kid) continue;
        let bot = null;
        try {
          bot = director.getBot?.(record);
        } catch {
          continue;
        }
        if (!bot || !canVolunteer(bot)) continue;
        const chance = volunteerChance(bot);
        if (Math.random() >= chance) continue;
        // Volunteer! Enlist and send to muster.
        if (enlist(bot, kid, side)) {
          try {
            director.switchActivity?.(record, "militia_duty");
          } catch {
            // Enlisted but activity switch failed — they'll muster next tick.
          }
          // Announce the volunteering where players can hear.
          try {
            const { sayPublic } = require("../citizens/chat/CitizenSayPublic");
            const { voiceFor, voiceLine } = require("../citizens/lib/citizenVoice");
            const personality = bot.getAttribute?.("citizens:personality") ?? {};
            const line = voiceLine(voiceFor(personality), {
              plain: ["The levy calls — I'm off to war."],
              terse: ["off to war."],
            }, Math.random);
            sayPublic(bot, line);
          } catch {
            // Cosmetic.
          }
          // One volunteer per kingdom per tick — the muster grows over time.
          break;
        }
      }
    }
  }
}

/**
 * syncSiegeRaiders(api) — keep raider NPCs in sync with active sieges.
 * Spawns raiders for new sieges, despawns for ended ones.
 */
function syncSiegeRaiders(api) {
  if (!api?.spawnNpc) return;
  let sieges = {};
  try {
    const state = Store.load();
    sieges = state.sieges ?? {};
  } catch {
    return;
  }
  const activeKeys = new Set();
  for (const [defenderId, siege] of Object.entries(sieges)) {
    if (!siege || siege.status !== "active") continue;
    const attackerId = siege.attackerKingdomId;
    if (!attackerId) continue;
    const key = siegeKey(attackerId, defenderId);
    activeKeys.add(key);
    if (raiders.has(key)) continue; // already spawned
    // New siege: spawn raiders near the defender's capital.
    let capital = null;
    let fortTier = 0;
    try {
      const { CAPITALS } = require("../world/DiegeticObjects");
      capital = CAPITALS.find((c) => c.id === String(defenderId)) ?? null;
      const state2 = Store.load();
      fortTier = state2.castles?.[defenderId]?.fortTier ?? 0;
    } catch {
      // Capital lookup failed.
    }
    if (capital) {
      spawnRaiders(api, attackerId, defenderId, capital, fortTier);
    }
  }
  // Despawn raiders for sieges that ended.
  for (const key of [...raiders.keys()]) {
    if (!activeKeys.has(key)) {
      const [attackerId, defenderId] = key.split(">");
      despawnRaiders(attackerId, defenderId);
    }
  }
}

module.exports = attachMilitia;
Object.assign(module.exports, {
  // Tuning
  MILITIA_MIN_COMBAT,
  RAIDER_NPC_ID,
  ATTR_MILITIA,
  // Orders
  getOrders,
  setOrders,
  clearOrders,
  // Roster
  isMilitia,
  militiaOf,
  militiaForKingdom,
  militiaCount,
  enlist,
  discharge,
  dischargeKingdom,
  // Tallies
  recordKill,
  recordDeath,
  resetTally,
  militiaSiegeBonus,
  // Raiders
  spawnRaiders,
  despawnRaiders,
  liveRaiders,
  // Recruitment
  canVolunteer,
  volunteerChance,
  combatLevel,
  tickMilitia,
  // Test seams
  _roster: roster,
  _orders: orders,
  _raiders: raiders,
  _tallies: tallies,
});

/**
 * Plugin attach: Militia is a library module — no hooks of its own.
 * The director tick calls tickMilitia; the dashboard calls setOrders;
 * the Citizens plugin handles militia deaths. This exists so
 * loadContentModule can load it like the other kingdom modules.
 */
function attachMilitia(api) {
  // No hooks — library only. Siege integration wires raiders via
  // Siege.Kingdoms calling spawnRaiders/despawnRaiders directly.
}
