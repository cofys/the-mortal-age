"use strict";

/**
 * AdminWorldMapApi — HTTP action layer for Jon's admin tools on the game's
 * real world map.
 *
 * Jon (2026-10-12): "maybe we need to create an admin ui/map, where I can see
 * where all players, teleport to them, have special tools and whatnot in there
 * so we can easily see what all is happening in the world."
 *
 * Jon (2026-10-12): "Why didn't you just use the map already in the game, and
 * add an overlay to it?" — the old full-screen React overlay is gone. Citizen
 * dots now render on the game's own world map (see WorldMapPlayers.plugin.js,
 * which streams [x, y, plane, kind, ...] rows the map renderer draws).
 * Right-clicking a citizen dot offers Teleport / Pause brain.
 *
 * Endpoints (all admin-only, via PlayerRights.hasAdminRights):
 *
 *   GET /api/admin-worldmap
 *     -> { layer: 0|1 }                        (no action: layer state)
 *   ...&action=layer&enabled=1|0               — toggle the citizen layer
 *   ...&action=layer-state                      — { layer: 0|1 }
 *   ...&action=teleport&target=<username>      — teleport viewer to citizen
 *   ...&action=set-activity&target=<u>&activity=<id>
 *   ...&action=toggle-brain&target=<username>  — pause/resume citizen brain
 *   ...&action=spawn&x=<x>&y=<y>&z=<z>         — spawn a citizen nearby
 *
 * The citizen layer defaults ON; the sidebar button toggles it per player.
 */

const ContentApiAuth = require("./ContentApiAuth");

const CITIZEN_LAYER_ATTRIBUTE = "worldmap:citizen-layer";
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

/** Citizen layer defaults ON; "0" hides the dots. Declared once here. */
function layerOn(player) {
  try {
    return String(player.getAttribute?.(CITIZEN_LAYER_ATTRIBUTE) ?? "").trim() !== "0";
  } catch {
    return true;
  }
}

function setLayer(player, enabled) {
  const on = String(enabled) === "1" || enabled === true || String(enabled).toLowerCase() === "on";
  try {
    player.setAttribute?.(CITIZEN_LAYER_ATTRIBUTE, on ? "1" : "0");
  } catch { /* ignore */ }
  return on;
}

function handleAction(api, player, query) {
  const action = String(query.get("action") || "").toLowerCase();
  const director = getDirector?.();

  if (action === "layer") {
    const on = setLayer(player, query.get("enabled"));
    return { ok: "Citizen layer " + (on ? "shown" : "hidden"), layer: on ? 1 : 0 };
  }
  if (action === "layer-state") {
    return { layer: layerOn(player) ? 1 : 0 };
  }

  if (action === "teleport") {
    const target = norm(query.get("target"));
    const record = director?.roster?.get(target);
    if (!record) return { error: "Citizen not found: " + query.get("target") };
    const pos = record.position || record.home;
    if (!pos) return { error: "No position for " + record.username };
    try {
      const { Location } = require("../../src/main/typescript/elvarg/game/model/Location");
      player.moveTo(new Location(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z || 0)));
      return { ok: "Teleported to " + record.username };
    } catch (e) {
      return { error: "Teleport failed: " + e.message };
    }
  }

  if (action === "toggle-brain") {
    const target = norm(query.get("target"));
    const record = director?.roster?.get(target);
    if (!record) return { error: "Citizen not found: " + query.get("target") };
    record.brainPaused = !record.brainPaused;
    return {
      ok: record.username + " brain " + (record.brainPaused ? "paused" : "resumed"),
      brainPaused: record.brainPaused ? 1 : 0,
    };
  }

  if (action === "set-activity") {
    const target = norm(query.get("target"));
    const activityId = String(query.get("activity") || "").trim();
    const record = director?.roster?.get(target);
    if (!record) return { error: "Citizen not found: " + query.get("target") };
    if (!activityId) return { error: "No activity id given" };
    record.currentActivityId = activityId;
    record.anchorActivityId = activityId;
    return { ok: record.username + " activity set to " + activityId };
  }

  if (action === "spawn") {
    const x = parseInt(query.get("x"), 10);
    const y = parseInt(query.get("y"), 10);
    const z = parseInt(query.get("z") || "0", 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { error: "spawn needs ?x=<x>&y=<y>" };
    }
    try {
      const added = director?.debugSpawnCitizen?.({ x, y, z });
      return { ok: added ? "Spawned " + added : "Spawn requested" };
    } catch (e) {
      return { error: "Spawn failed: " + e.message };
    }
  }

  return { layer: layerOn(player) ? 1 : 0 };
}

function attach(api) {
  setCore(api);
  ContentApiAuth.setPluginApi(api);
  api.registerContentEndpoint("admin-worldmap", (query) => {
    try {
      // Admin tool: every action requires session-token auth. No fallback
      // to ?player= — this endpoint can teleport and spawn.
      const player = ContentApiAuth.requireAuth(query);
      if (!player || !isAdmin(player)) return { error: "admin only" };
      return handleAction(api, player, query);
    } catch {
      return { error: "request failed" };
    }
  });
}

module.exports = { attach, CITIZEN_LAYER_ATTRIBUTE };
