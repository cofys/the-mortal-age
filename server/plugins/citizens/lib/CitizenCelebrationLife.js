"use strict";

/**
 * CitizenCelebrationLife — celebration dynamics on the director slow tick.
 *
 * WHAT IT DOES (data tier, free):
 *   Runs on the director's slow tick (like other *Life modules):
 *
 *   - Planner appointment: each kingdom gets a head planner (sociable,
 *     reputable citizen) if it doesn't have one. Planners are picked
 *     from real roster citizens.
 *   - Custom festival scheduling: planners schedule one custom festival
 *     per month per kingdom (if the kingdom treasury can fund the
 *     minimum budget). Festivals get a parade + fireworks + booths.
 *   - Parade announcements: when a parade is active and near real
 *     players, announce it via sayPublic (once per parade).
 *   - Fireworks announcements: when fireworks are tonight and near
 *     real players, announce them (once per show).
 *   - Announcements are personality-gated and cooldown-gated.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   "The Starlight Festival begins tomorrow!" / "The parade is marching
 *   through the market!" / "Fireworks tonight at dusk!" — scripted
 *   sayPublic lines from the planner or nearby citizens.
 *
 * Zero LLM. Never throws — every section is try/caught.
 * Plain-node testable: CitizenCelebrationLife.test.js.
 *
 * No-overlap: CitizenFestivalLife owns the calendar festivals;
 * this owns the custom/participatory layer.
 */

const Celebrations = require("./CitizenCelebrations");

// === Tuning: all magic numbers here ===
const TICK_INTERVAL_MS = 5 * 60 * 1000; // run at most every 5 min
const FESTIVAL_SCHEDULE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // one custom per month
const PARADE_LEAD_TIME_MS = 2 * 60 * 60 * 1000; // parade 2h after festival starts
const FIREWORKS_LEAD_TIME_MS = 10 * 60 * 60 * 1000; // fireworks 10h after start (evening)
const ANNOUNCE_RADIUS = 20; // tiles — announce to players within this

let lastTick = 0;

/**
 * Slow-tick entry point. Called by the director.
 * director: the CitizenDirector (needs roster, getBot, sayPublic helpers).
 * nowMs: current timestamp.
 */
function tickCelebrationLife(director, nowMs) {
  const now = nowMs ?? Date.now();
  if (now - lastTick < TICK_INTERVAL_MS) return;
  lastTick = now;

  try {
    ensurePlanners(director, now);
  } catch { /* never break the tick */ }
  try {
    scheduleCustoms(director, now);
  } catch { /* never break the tick */ }
  try {
    announceParades(director, now);
  } catch { /* never break the tick */ }
  try {
    announceFireworks(director, now);
  } catch { /* never break the tick */ }
}

/**
 * Ensure each kingdom with citizens has a head planner.
 * Picks the most sociable reputable citizen from the roster.
 */
function ensurePlanners(director, now) {
  const roster = director.roster;
  if (!roster || typeof roster.values !== "function") return;

  // Group citizens by kingdom.
  const byKingdom = new Map();
  for (const record of roster.values()) {
    if (!record || !record.kingdomId) continue;
    if (!byKingdom.has(record.kingdomId)) byKingdom.set(record.kingdomId, []);
    byKingdom.get(record.kingdomId).push(record);
  }

  for (const [kingdomId, citizens] of byKingdom) {
    if (Celebrations.plannerFor(kingdomId)) continue; // already have one

    // Find the most sociable reputable citizen.
    let best = null;
    let bestScore = -1;
    for (const c of citizens) {
      const rep = reputationOf(c);
      const social = socialOf(c);
      if (rep < Celebrations.PLANNER_MIN_REPUTATION) continue;
      if (social < Celebrations.PLANNER_MIN_SOCIAL) continue;
      const score = rep + social;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) {
      Celebrations.appointPlanner(kingdomId, best.username ?? best.name, reputationOf(best), socialOf(best));
    }
  }
}

/**
 * Planners schedule one custom festival per month per kingdom.
 * The festival gets a parade, fireworks, and carnival booths.
 */
function scheduleCustoms(director, now) {
  for (const { kingdomId, username } of Celebrations.allPlanners()) {
    // Skip if there's already an active or upcoming custom.
    if (Celebrations.activeCustom(kingdomId, now)) continue;
    if (Celebrations.upcomingCustoms(kingdomId, now).length > 0) continue;

    // Check the last scheduled custom for this kingdom.
    const customs = Celebrations.customsFor(kingdomId);
    const lastStart = customs.length > 0
      ? Math.max(...customs.map((c) => c.startsAt))
      : 0;
    if (now - lastStart < FESTIVAL_SCHEDULE_INTERVAL_MS) continue;

    // Pick a theme (rotate through themes deterministically).
    const theme = Celebrations.THEMES[customs.length % Celebrations.THEMES.length];

    // Schedule for 3 days from now.
    const startsAt = now + 3 * 24 * 60 * 60 * 1000;
    const fest = Celebrations.organizeFestival({
      theme,
      kingdomId,
      organizer: username,
      budget: Celebrations.CUSTOM_FESTIVAL_MIN_BUDGET,
      startsAt,
    });
    if (!fest) continue;

    // Schedule parade, fireworks, and booths.
    Celebrations.scheduleParade(fest.id, kingdomId, startsAt + PARADE_LEAD_TIME_MS);
    Celebrations.scheduleFireworks(fest.id, kingdomId, startsAt + FIREWORKS_LEAD_TIME_MS);
    Celebrations.setupBooths(fest.id, [username]);

    // Announce the upcoming festival near real players.
    announceUpcoming(director, kingdomId, fest, now);
  }
}

/**
 * Announce active parades near real players (once per parade).
 */
function announceParades(director, now) {
  const kingdoms = new Set();
  const roster = director.roster;
  if (roster && typeof roster.values === "function") {
    for (const r of roster.values()) {
      if (r?.kingdomId) kingdoms.add(r.kingdomId);
    }
  }

  for (const kingdomId of kingdoms) {
    for (const parade of Celebrations.activeParades(kingdomId, now)) {
      if (parade.announced) continue;
      if (!Celebrations.canAnnounce(kingdomId, "parade", now)) continue;
      if (!anyRealPlayerNear(director, kingdomId)) continue;

      sayNear(director, kingdomId,
        `The parade is marching through the streets! Come join the celebration!`);
      Celebrations.markParadeAnnounced(parade.id, now);
    }
  }
}

/**
 * Announce tonight's fireworks near real players (once per show).
 */
function announceFireworks(director, now) {
  const kingdoms = new Set();
  const roster = director.roster;
  if (roster && typeof roster.values === "function") {
    for (const r of roster.values()) {
      if (r?.kingdomId) kingdoms.add(r.kingdomId);
    }
  }

  for (const kingdomId of kingdoms) {
    for (const show of Celebrations.tonightFireworks(kingdomId, now)) {
      if (show.announced) continue;
      if (!Celebrations.canAnnounce(kingdomId, "fireworks", now)) continue;
      if (!anyRealPlayerNear(director, kingdomId)) continue;

      sayNear(director, kingdomId,
        `Fireworks tonight at dusk! Don't miss the lights over the market!`);
      Celebrations.markFireworksAnnounced(show.id, now);
    }
  }
}

// --- helpers (defensive, never throw) ---

function reputationOf(citizen) {
  try {
    const Rep = require("./CitizenReputation");
    return Rep.scoreFor?.(citizen.username ?? citizen.name) ?? 0;
  } catch { return 0; }
}

function socialOf(citizen) {
  try {
    // Social score from personality or a stored field.
    const p = citizen.personality ?? {};
    const sociable = p.sociable ?? p.sociability ?? 0;
    if (typeof sociable === "number" && sociable <= 1) return sociable * 100;
    return sociable ?? 50;
  } catch { return 50; }
}

function anyRealPlayerNear(director, kingdomId) {
  try {
    // A real player is near if the director has any online real player
    // in this kingdom. Defensive: default to true in test stubs.
    if (typeof director.anyRealPlayerInKingdom === "function") {
      return director.anyRealPlayerInKingdom(kingdomId);
    }
    return true;
  } catch { return true; }
}

function sayNear(director, kingdomId, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    // Find a citizen in this kingdom to speak.
    const roster = director.roster;
    if (roster && typeof roster.values === "function") {
      for (const r of roster.values()) {
        if (r?.kingdomId === kingdomId) {
          const bot = director.getBot?.(r);
          if (bot) {
            sayPublic(bot, text);
            return;
          }
        }
      }
    }
  } catch { /* speech is best-effort */ }
}

function announceUpcoming(director, kingdomId, fest, now) {
  try {
    if (!Celebrations.canAnnounce(kingdomId, "upcoming", now)) return;
    if (!anyRealPlayerNear(director, kingdomId)) return;
    sayNear(director, kingdomId,
      `${fest.name} begins in 3 days! The ${fest.organizer} invites everyone!`);
  } catch { /* best-effort */ }
}

// For tests: reset the tick throttle.
function resetForTests() {
  lastTick = 0;
  Celebrations.resetForTests();
}

module.exports = {
  tickCelebrationLife,
  ensurePlanners,
  scheduleCustoms,
  announceParades,
  announceFireworks,
  resetForTests,
  TICK_INTERVAL_MS,
};
