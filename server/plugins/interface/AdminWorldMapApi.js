"use strict";

/**
 * AdminWorldMapApi — HTTP data layer for Jon's admin world map overlay.
 *
 * Jon (2026-10-12): "maybe we need to create an admin ui/map, where I can see
 * where all players, teleport to them, have special tools and whatnot in there
 * so we can easily see what all is happening in the world."
 *
 * Endpoints (all admin-only, via PlayerRights.hasAdminRights):
 *
 *   GET /api/admin-worldmap?player=<username>
 *     -> { open: false } | { open: true, ...status }
 *   ...&action=open            — set the adminworldmap:open attribute
 *   ...&action=close           — clear it
 *   ...&action=status          — full map snapshot (polled by the overlay)
 *   ...&action=teleport&target=<username>        — teleport viewer to citizen
 *   ...&action=set-activity&target=<u>&activity=<id>
 *   ...&action=toggle-brain&target=<username>    — pause/resume citizen brain
 *   ...&action=spawn&x=<x>&y=<y>&z=<z>           — spawn a citizen nearby
 *
 * Status shape:
 *   { citizens: [{ n, x, y, z, a (activityId), g (goal), k (kingdomId),
 *                  p (profession), o (online 0/1), b (brainPaused 0/1),
 *                  t (seconds since last tick) }],
 *     players: [{ n, x, y, z, bot }],
 *     stats: { roster, online, bands: { near, mid, far, asleep } } }
 *
 * Payloads are compact (single-letter keys) — 3,111 citizens must fit in a
 * 2s poll without hurting the tick.
 */

const ContentApiAuth = require("./ContentApiAuth");

const OPEN_ATTRIBUTE = "adminworldmap:open";
const { getDirector } = require("../citizens/director/CitizenDirector");

let core = null;
let PlayerRights = null;

function setCore(api) {
  core = api.core;
  try {
    PlayerRights =
      api.core.PlayerRights ||
      require("../../src/main/typescript/elvarg/game/model/rights/PlayerRights").PlayerRights;
  } catch {
    PlayerRights = null;
  }
}

function findPlayer(api, username) {
  try {
    const name = String(username || "").trim();
    if (!name) return null;
    const players = core?.World?.getPlayers?.() || [];
    for (const p of players) {
      try {
        if (p.getUsername?.()?.toLowerCase() === name.toLowerCase()) return p;
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return null;
}

function isAdmin(player) {
  try {
    if (PlayerRights?.hasAdminRights) return PlayerRights.hasAdminRights(player) === true;
    const rights = player.getRights?.();
    return rights && typeof rights.isAdmin === "function" && rights.isAdmin();
  } catch {
    return false;
  }
}

function norm(name) {
  return String(name ?? "").trim().toLowerCase();
}

/** Compact citizen row for the map. Never throws. */
function citizenRow(record, director) {
  try {
    const pos = record.position || record.home || { x: 3200, y: 3200, z: 0 };
    let online = 0;
    try {
      online = director.getBot?.(record) ? 1 : 0;
    } catch { /* offline */ }
    const lastTick = record.lastTickAt || 0;
    return {
      n: record.username,
      x: Math.round(pos.x || 0),
      y: Math.round(pos.y || 0),
      z: Math.round(pos.z || 0),
      a: record.currentActivityId || null,
      g: typeof record.goal === "string" ? record.goal : record.goal?.id || null,
      k: record.kingdomId || null,
      p: record.role || null,
      o: online,
      b: record.brainPaused ? 1 : 0,
      t: lastTick ? Math.max(0, Math.round((Date.now() - lastTick) / 1000)) : -1,
    };
  } catch {
    return null;
  }
}

function buildStatus() {
  const director = getDirector?.();
  if (!director?.roster) return { citizens: [], players: [], stats: null };
  const citizens = [];
  try {
    for (const record of director.roster.values()) {
      const row = citizenRow(record, director);
      if (row) citizens.push(row);
    }
  } catch { /* partial list is fine */ }

  const players = [];
  try {
    for (const p of core?.World?.getPlayers?.() || []) {
      try {
        const loc = p.getLocation?.();
        players.push({
          n: p.getUsername?.() || "?",
          x: loc?.getX?.() ?? 0,
          y: loc?.getY?.() ?? 0,
          z: loc?.getZ?.() ?? 0,
          bot: p.isPlayerBot?.() === true ? 1 : 0,
        });
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  return {
    citizens,
    players,
    stats: {
      roster: director.roster.size,
      online: citizens.filter((c) => c.o === 1).length,
    },
  };
}

function handleAction(api, player, query) {
  const action = String(query.get("action") || "").toLowerCase();
  const director = getDirector?.();

  if (action === "open") {
    player.setAttribute(OPEN_ATTRIBUTE, "1");
    return { open: true, ...buildStatus() };
  }
  if (action === "close") {
    player.setAttribute(OPEN_ATTRIBUTE, "");
    return { open: false };
  }
  if (action === "status") {
    return { open: true, ...buildStatus() };
  }

  // Mutating admin actions below.
  if (action === "teleport") {
    const target = norm(query.get("target"));
    const record = director?.roster?.get(target);
    if (!record) return { open: true, error: "Citizen not found: " + query.get("target") };
    const pos = record.position || record.home;
    if (!pos) return { open: true, error: "No position for " + record.username };
    try {
      const { Location } = require("../../src/main/typescript/elvarg/game/model/Location");
      player.moveTo(new Location(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z || 0)));
      return { open: true, ok: "Teleported to " + record.username };
    } catch (e) {
      return { open: true, error: "Teleport failed: " + e.message };
    }
  }

  if (action === "toggle-brain") {
    const target = norm(query.get("target"));
    const record = director?.roster?.get(target);
    if (!record) return { open: true, error: "Citizen not found: " + query.get("target") };
    record.brainPaused = !record.brainPaused;
    return {
      open: true,
      ok: record.username + " brain " + (record.brainPaused ? "paused" : "resumed"),
      brainPaused: record.brainPaused ? 1 : 0,
    };
  }

  if (action === "set-activity") {
    const target = norm(query.get("target"));
    const activityId = String(query.get("activity") || "").trim();
    const record = director?.roster?.get(target);
    if (!record) return { open: true, error: "Citizen not found: " + query.get("target") };
    if (!activityId) return { open: true, error: "No activity id given" };
    record.currentActivityId = activityId;
    record.anchorActivityId = activityId;
    return { open: true, ok: record.username + " activity set to " + activityId };
  }

  if (action === "spawn") {
    const x = parseInt(query.get("x"), 10);
    const y = parseInt(query.get("y"), 10);
    const z = parseInt(query.get("z") || "0", 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { open: true, error: "spawn needs ?x=<x>&y=<y>" };
    }
    try {
      const added = director?.debugSpawnCitizen?.({ x, y, z });
      return { open: true, ok: added ? "Spawned " + added : "Spawn requested" };
    } catch (e) {
      return { open: true, error: "Spawn failed: " + e.message };
    }
  }

  return { open: true, ...buildStatus() };
}

function attach(api) {
  setCore(api);
  ContentApiAuth.setPluginApi(api);
  api.registerContentEndpoint("admin-worldmap", (query) => {
    try {
      // Admin tool: every action requires session-token auth. No fallback
      // to ?player= — this endpoint can teleport and spawn.
      const player = ContentApiAuth.requireAuth(query);
      if (!player || !isAdmin(player)) return { open: false };

      const action = String(query.get("action") || "").toLowerCase();
      // status/teleport/etc. work without the overlay being "open" — the
      // overlay polls action=status directly.
      if (action && action !== "open") {
        return handleAction(api, player, query);
      }
      const open = String(player.getAttribute(OPEN_ATTRIBUTE) || "").trim();
      if (action === "open" || open) return handleAction(api, player, query);
      return { open: false };
    } catch {
      return { open: false };
    }
  });
}

module.exports = { attach, OPEN_ATTRIBUTE };
