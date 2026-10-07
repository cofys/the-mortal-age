"use strict";

/**
 * QuestUtil — small shared helpers for the Mortal Age quest system.
 *
 * playerKingdomId  — the player's kingdom, falling back through origin
 *                    data to "misthalin" (Edgeville sits in Misthalin).
 * substitute       — replaces {var} placeholders in quest text.
 */

const DataOrigins = require("../../origins/Data.Origins");

const KINGDOM_ID_ATTRIBUTE = "kingdom:id";
const ORIGIN_ID_ATTRIBUTE = "origin:id";
const FALLBACK_KINGDOM = "misthalin";

function playerKingdomId(player) {
  try {
    const direct = player?.getAttribute?.(KINGDOM_ID_ATTRIBUTE);
    if (typeof direct === "string" && direct) return direct;
    const originId = player?.getAttribute?.(ORIGIN_ID_ATTRIBUTE);
    const origin = originId ? DataOrigins.BY_ID?.get(originId) : null;
    if (origin?.kingdomId) return origin.kingdomId;
  } catch {
    // fall through
  }
  return FALLBACK_KINGDOM;
}

function playerName(player) {
  try {
    return player?.getUsername?.() ?? "traveller";
  } catch {
    return "traveller";
  }
}

/** Replace {key} placeholders with vars[key] (missing keys left as-is). */
function substitute(text, vars) {
  if (typeof text !== "string") return text;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, key) =>
    vars && vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : m
  );
}

module.exports = { playerKingdomId, playerName, substitute };
