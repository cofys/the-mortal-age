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
 * No auth: read-only position data that's visible to any player in-game.
 * This is a debug endpoint; do not expose the game port publicly.
 */

const { getDirector, CitizenDirector } = require("../citizens/director/CitizenDirector");
const { recentSpeechEvents } = require("../citizens/chat/CitizenSayPublic");

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
      });
    }
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
  };
}

function attach(api) {
  api.registerContentEndpoint("citizen-monitor", (query) => {
    try {
      return handleMonitor(query);
    } catch (e) {
      return { error: "monitor failed: " + (e && e.message ? e.message : String(e)) };
    }
  });
}

module.exports = { attach };
