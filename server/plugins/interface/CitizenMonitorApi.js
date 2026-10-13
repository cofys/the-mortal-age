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
// DIAG-2026-10-13: lazy require (init order) — may be null if decisions never loaded.
let getPickDiag = null;
let getBaseRegistry = null;
try {
  getPickDiag = require("../citizens/brain/CitizenDecisions").getPickDiag ?? null;
} catch { /* diag unavailable */ }
try {
  getBaseRegistry = require("../citizens/brain/CitizenActivityRegistry").getBaseRegistry ?? null;
} catch { /* diag unavailable */ }

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
  // ?tileCheck=x,y[,z] - engine walkability report for a tile (debug)
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
    // ?decisionWiring=1 - TEMP-DIAG: report whether the decision layer
    // (activity picker + world.decisionTick) was installed at boot.
    if (getParam("decisionWiring")) {
      try {
        const w = require("../citizens/brain/CitizenDecisions").getDecisionWiring?.() ?? null;
        // TEMP-DIAG: sample live citizen brains — is world.decisionTick
        // present on the world object their brains actually use, and is it
        // the same object the install ran against?
        const brainSample = { checked: 0, withDecisionTick: 0, sameWorldAsRegistry: 0 };
        try {
          const director = getDirector?.();
          const runtime = director?.runtime?.();
          const entries = runtime?.entriesByUsername;
          const regWorld = require("../bots/brain/BotActivityRegistry").getBotActivityRegistries?.()?.[0]?.world ?? null;
          if (entries && typeof entries.forEach === "function") {
            entries.forEach((entry) => {
              if (brainSample.checked >= 30) return;
              const bw = entry?.brain?.world;
              if (!bw) return;
              brainSample.checked++;
              if (typeof bw.decisionTick === "function") brainSample.withDecisionTick++;
              if (regWorld && bw === regWorld) brainSample.sameWorldAsRegistry++;
            });
          }
          brainSample.registryWorldHasDecisionTick = regWorld ? typeof regWorld.decisionTick === "function" : null;
        } catch (e) {
          brainSample.error = String((e && e.message) || e);
        }
        return { ok: true, decisionWiring: w, brainSample };
      } catch (e) {
        return { ok: false, error: "decision wiring check failed: " + (e && e.message ? String(e.message) : String(e)) };
      }
    }
    // ?tileCheck=x,y[,z] - report engine walkability for tiles (debug).
    // Jon 2026-10-13 (Catherby water tiles): lets autonomous verification
    // confirm citizens stand on walkable tiles without a client.
    const tileCheckParam = getParam("tileCheck");
    if (tileCheckParam) {
      const parts = String(tileCheckParam).split(",").map(Number);
      if (parts.length >= 2 && parts.slice(0, 2).every(Number.isFinite)) {
        const x = Math.round(parts[0]);
        const y = Math.round(parts[1]);
        const z = Number.isFinite(parts[2]) ? Math.round(parts[2]) : 0;
        try {
          const CitizenTiles = require("../citizens/lib/CitizenTiles");
          const blocked = CitizenTiles.isBlockedTile(x, y, z);
          const snapped = CitizenTiles.snapToWalkableTile(x, y, z, 12);
          return { ok: true, tile: { x, y, z }, blocked, snapped };
        } catch (e) {
          return { ok: false, error: "tile check failed: " + (e && e.message ? String(e.message) : String(e)) };
        }
      }
      return { ok: false, error: "Invalid tileCheck format. Use ?tileCheck=x,y[,z]" };
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
        // DIAG-2026-10-13: last pick() top-8 scores + weary/hurt flags, so a
        // live read shows why the winner beat the alternatives.
        pickDiag: (() => { try { return getPickDiag?.(record.username) ?? null; } catch { return null; } })(),
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
  // DIAG-2026-10-13: global capacity room for the key work activities, so a
  // live read can tell "work scored low" apart from "work wasn't a candidate".
  let workCapacity = null;
  try {
    const reg = getBaseRegistry?.();
    if (reg && typeof reg.hasRoom === "function") {
      workCapacity = {};
      for (const id of ["citizen_chop", "citizen_mine", "citizen_fish", "citizen_routine", "safetynet_wander"]) {
        workCapacity[id] = reg.hasRoom(id);
      }
    }
  } catch { /* diag unavailable */ }
  return {
    timestamp: now,
    total,
    materialized,
    count: citizens.length,
    citizens,
    workCapacity,
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
