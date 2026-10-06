"use strict";

/**
 * Common.Arrival — small shared helpers for the arrival plugin.
 *
 * The arrival plugin is the starting experience: welcome beats, ambient
 * rumors, notice boards. Everything here is read-only world access and
 * scheduling; no quest state, no stages, no checklists.
 */

/** Namespaced player attribute: the welcome beat fired exactly once. */
const ARRIVAL_WELCOMED_ATTRIBUTE = "arrival:welcomed";

/**
 * Run `action` once after `ticks` game ticks. Uses the core TaskManager so
 * delayed beat lines stay on the game thread (mirrors Common.WarriorsGuild).
 */
function later(core, ticks, action) {
  core.TaskManager.submit(
    new (class extends core.Task {
      constructor() {
        super(ticks, undefined, false);
      }
      execute() {
        this.stop();
        action();
      }
    })()
  );
}

/** True for real players; never for citizen bots or other mobiles. */
function isRealPlayer(mobile) {
  return mobile?.isPlayer?.() === true && mobile?.isPlayerBot?.() !== true;
}

/** True when a z-0 location sits inside [x1, x2, y1, y2]. All rects are z 0. */
function inRect(location, rect) {
  if (!location || typeof location.getX !== "function") return false;
  const [x1, x2, y1, y2] = rect;
  return (
    location.getZ() === 0 &&
    location.getX() >= x1 &&
    location.getX() <= x2 &&
    location.getY() >= y1 &&
    location.getY() <= y2
  );
}

/**
 * Nearest NPC whose definition name is one of `names`, within `range` tiles
 * of `location` (same height level). Returns null when nobody qualifies —
 * every caller has a chatbox-message fallback.
 */
function npcNamedNear(core, location, names, range = 14) {
  if (!location) return null;
  let found = null;
  let best = range + 1;
  for (const npc of core.World.getNpcs()) {
    if (!npc) continue;
    const name = npc.getDefinition?.()?.getName?.();
    if (!names.includes(name)) continue;
    const npcLoc = npc.getLocation?.();
    if (!npcLoc || npcLoc.getZ() !== location.getZ()) continue;
    const dist = npcLoc.getDistance(location);
    if (dist <= range && dist < best) {
      found = npc;
      best = dist;
    }
  }
  return found;
}

/** Any real player within `range` tiles of `location`? */
function realPlayerNear(core, location, range = 18) {
  for (const player of core.World.getPlayers()) {
    if (!isRealPlayer(player)) continue;
    const loc = player.getLocation?.();
    if (loc && loc.getZ() === location.getZ() && loc.getDistance(location) <= range) {
      return true;
    }
  }
  return false;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Capital zones for ambient systems (chatter, notice boards, bartender
 * territories). Approximate boxes around each home city, z 0. These are
 * arrival's own rects — the kingdoms plugin's Area rects cover the wider
 * territories and stay authoritative for law.
 */
const CAPITAL_ZONES = [
  { kingdomId: "asgarnia", rect: [2930, 3020, 3340, 3400] }, // Falador
  { kingdomId: "misthalin", rect: [3175, 3250, 3210, 3490] }, // Varrock + Lumbridge
  { kingdomId: "kandarin", rect: [2600, 2700, 3240, 3330] }, // East Ardougne
  { kingdomId: "morytania", rect: [3745, 3795, 3215, 3260] }, // Burgh de Rott
  { kingdomId: "keldagrim", rect: [2816, 2944, 10112, 10272] }, // Keldagrim
];

/** The kingdom whose capital zone contains `location`, or null. */
function kingdomAt(location) {
  for (const zone of CAPITAL_ZONES) {
    if (inRect(location, zone.rect)) return zone.kingdomId;
  }
  return null;
}

module.exports = {
  ARRIVAL_WELCOMED_ATTRIBUTE,
  later,
  isRealPlayer,
  inRect,
  npcNamedNear,
  realPlayerNear,
  pick,
  CAPITAL_ZONES,
  kingdomAt,
};
