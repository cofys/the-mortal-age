"use strict";

/**
 * CitizenMonitorApi — read-only debug endpoint for remote movement verification.
 *
 * Frank polls this via SSH tunnel to confirm citizens are actually moving,
 * without needing Jon to log in and look.
 *
 *   GET /api/citizen-monitor
 *     -> {
 *          timestamp: 1234567890123,
 *          total: 3111,
 *          materialized: 60,
 *          citizens: [
 *            { name, x, y, z, activity, online, lastMoveAt, secsSinceMove },
 *            ...
 *          ]
 *        }
 *
 * By default only materialized (online) citizens are included — use
 * ?all=1 to include the full roster (heavier).
 *
 * `recentSpeech` carries the last ~200 citizen utterances recorded by
 * CitizenSayPublic (who said what, where, whether it reached a chat box) —
 * server-side observability for ambient chatter without a real player
 * watching.
 *
 * `skills` on each citizen carries live skill levels/XP from IN-MEMORY state
 * only (never the save files — read-only debug surfacing like recentSpeech):
 * materialized citizens read the engine SkillManager (source of truth while
 * online); everyone else reads the data-tier skillStore snapshot (module
 * state, updated on every grant and dematerialize). Only skills with xp > 0
 * are listed, as { skillId: { level, xp } }. `skillSummary` aggregates the
 * gain signal across the returned set: citizens with XP above start in any
 * non-HP skill — i.e. whether the skill systems are actually granting XP,
 * not just wired in code.
 *
 * No auth: read-only position data that's visible to any player in-game.
 * This is a debug endpoint; do not expose the game port publicly.
 */

const { getDirector, CitizenDirector } = require("../citizens/director/CitizenDirector");
const { recentSpeechEvents } = require("../citizens/chat/CitizenSayPublic");
const { skillStore, levelForXp } = require("../citizens/lib/CitizenSkilling");
const { SKILL_ID_TO_ENUM, getSkillEnum } = require("../citizens/lib/CitizenXpSync");

// Skill enum captured at attach (api.core.Skill) for live engine reads.
let SkillEnum = null;

const NON_HP_SKILLS = Object.keys(SKILL_ID_TO_ENUM).filter((id) => id !== "hitpoints");

/**
 * Live skill levels/XP for one citizen, from in-memory state only.
 * 1) Materialized citizens: engine SkillManager (source of truth while online).
 * 2) Everyone else (or no Skill enum): data-tier skillStore snapshot.
 * Returns { skillId: { level, xp } } for skills with xp > 0. Read-only.
 */
function getCitizenSkills(director, record) {
  const skills = {};
  const username = record && record.username;
  if (!username) return skills;

  // 1) Live engine read for materialized citizens.
  if (SkillEnum) {
    try {
      const bot = director.getBot?.(record);
      const sm = bot?.getSkillManager?.();
      if (sm?.getExperience) {
        for (const skillId of Object.keys(SKILL_ID_TO_ENUM)) {
          const skill = getSkillEnum(SkillEnum, skillId);
          if (!skill) continue;
          let xp = 0;
          try {
            xp = sm.getExperience(skill) || 0;
          } catch {
            continue;
          }
          if (xp > 0) {
            const whole = Math.floor(xp);
            skills[skillId] = { level: levelForXp(whole), xp: whole };
          }
        }
        return skills;
      }
    } catch {
      /* fall through to store */
    }
  }

  // 2) Data-tier in-memory snapshot (live module state — not a file read).
  try {
    for (const skillId of Object.keys(SKILL_ID_TO_ENUM)) {
      const xp = skillStore.getXp(username, skillId) || 0;
      if (xp > 0) {
        const whole = Math.floor(xp);
        skills[skillId] = { level: levelForXp(whole), xp: whole };
      }
    }
  } catch {
    /* no skills */
  }
  return skills;
}

// username -> { x, y, z, lastMoveAt }. Module-level so it persists across polls.
const lastSeen = new Map();

function getLivePosition(director, record) {
  // Prefer the live bot's location when materialized; fall back to record.position.
  try {
    const bot = director.getBot?.(record);
    if (bot) {
      const loc = bot.getLocation?.();
      if (loc) {
        return {
          x: Math.round(loc.getX?.() ?? 0),
          y: Math.round(loc.getY?.() ?? 0),
          z: Math.round(loc.getZ?.() ?? 0),
          live: true,
        };
      }
    }
  } catch {
    /* fall through to record position */
  }
  try {
    const pos = record.position || record.home;
    if (pos) {
      return {
        x: Math.round(pos.x ?? 0),
        y: Math.round(pos.y ?? 0),
        z: Math.round(pos.z ?? 0),
        live: false,
      };
    }
  } catch {
    /* no position */
  }
  return null;
}

function handleMonitor(query) {
  // DEBUG: Fake player control for autonomous testing (no real player needed).
  // ?fakePlayer=x,y,z - simulate a player at coordinates
  // ?clearFakePlayer=1 - remove the simulated player
  // Note: query is a Map (has .get()), not a plain object.
  try {
    const getParam = (k) => {
      try {
        if (query && typeof query.get === "function") return query.get(k);
        if (query && query[k] != null) return query[k];
      } catch {}
      return null;
    };
    const fakePlayerParam = getParam("fakePlayer");
    if (fakePlayerParam) {
      const parts = String(fakePlayerParam).split(",").map(Number);
      if (parts.length >= 2 && parts.slice(0, 2).every(Number.isFinite)) {
        CitizenDirector.setDebugFakePlayer(parts[0], parts[1], parts[2] ?? 0);
        return { ok: true, fakePlayer: { x: parts[0], y: parts[1], z: parts[2] ?? 0 } };
      }
      return { ok: false, error: "Invalid fakePlayer format. Use ?fakePlayer=x,y,z" };
    }
    if (getParam("clearFakePlayer")) {
      CitizenDirector.clearDebugFakePlayers();
      return { ok: true, cleared: true };
    }
  } catch (e) {
    return { ok: false, error: "fake player control failed: " + (e && e.message ? e.message : String(e)) };
  }
  const director = getDirector?.();
  const roster = director?.roster;
  const now = Date.now();
  const includeAll = String(query.get("all") || "").trim() === "1";

  const citizens = [];
  let materialized = 0;
  let total = 0;

  if (roster) {
    for (const record of roster.values()) {
      total += 1;
      let online = 0;
      try {
        online = director.getBot?.(record) ? 1 : 0;
      } catch {
        /* offline */
      }
      if (online) materialized += 1;
      if (!includeAll && !online) continue;

      const pos = getLivePosition(director, record);
      if (!pos) continue;

      const key = String(record.username || "").toLowerCase();
      const prev = lastSeen.get(key);
      let lastMoveAt;
      if (!prev || prev.x !== pos.x || prev.y !== pos.y || prev.z !== pos.z) {
        lastMoveAt = now;
        lastSeen.set(key, { x: pos.x, y: pos.y, z: pos.z, lastMoveAt });
      } else {
        lastMoveAt = prev.lastMoveAt;
      }

      citizens.push({
        name: record.username,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        activity: record.currentActivityId || null,
        online,
        live: pos.live ? 1 : 0,
        lastMoveAt,
        secsSinceMove: Math.round((now - lastMoveAt) / 1000),
        skills: getCitizenSkills(director, record),
      });
    }
  }

  // Aggregate gain signal: citizens with XP above start in any non-HP skill.
  const skillSummary = {
    scope: includeAll ? "all" : "materialized",
    citizensChecked: citizens.length,
    citizensWithNonHpXp: 0,
    skillsTouched: {},
  };
  for (const c of citizens) {
    let gained = false;
    for (const skillId of NON_HP_SKILLS) {
      const s = c.skills && c.skills[skillId];
      if (s && s.xp > 0) {
        gained = true;
        skillSummary.skillsTouched[skillId] = (skillSummary.skillsTouched[skillId] || 0) + 1;
      }
    }
    if (gained) skillSummary.citizensWithNonHpXp += 1;
  }

  // Prune entries for citizens that no longer exist (roster churn).
  if (lastSeen.size > total + 100) {
    const alive = new Set();
    if (roster) {
      for (const record of roster.values()) {
        alive.add(String(record.username || "").toLowerCase());
      }
    }
    for (const key of lastSeen.keys()) {
      if (!alive.has(key)) lastSeen.delete(key);
    }
  }

  // Sort: most recently moved first, so Frank sees activity at the top.
  citizens.sort((a, b) => b.lastMoveAt - a.lastMoveAt);

  let fakePlayers = [];
  try { fakePlayers = CitizenDirector.getDebugFakePlayers(); } catch {}
  return {
    timestamp: now,
    total,
    materialized,
    count: citizens.length,
    citizens,
    debugFakePlayers: fakePlayers,
    recentSpeech: recentSpeechEvents(),
    skillSummary,
  };
}

function attach(api) {
  SkillEnum = api?.core?.Skill ?? null;
  api.registerContentEndpoint("citizen-monitor", (query) => {
    try {
      return handleMonitor(query);
    } catch (e) {
      return { error: "monitor failed: " + (e && e.message ? e.message : String(e)) };
    }
  });
}

module.exports = { attach };
