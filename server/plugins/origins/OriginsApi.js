"use strict";

/**
 * OriginsApi — HTTP data layer for the web client's origin overlay.
 *
 * The web client cannot render the game engine's widget system, so the
 * origin selection screen is a React HTML/CSS overlay. This module feeds
 * it: realm data for display, and per-player status (does this player
 * still need to choose?).
 *
 *   GET /api/origins-status?player=<username>
 *     -> { needsChoice: boolean,
 *          realms: [{ id, name, city, demonym, epithet, lens, welcome }] }
 *
 * The overlay sends the player's choice back through the normal command
 * channel (::origin claim <id>); this endpoint is read-only by design.
 */

const Data = require("./Data.Origins");
const Selection = require("./Selection.Origins");

function statusPayload(player) {
  const realms = Data.ORIGINS.map((o) => ({
    id: o.id,
    name: o.name,
    city: o.city,
    demonym: o.demonym,
    epithet: o.epithet,
    lens: o.lens,
    welcome: o.welcome,
  }));
  if (!player) {
    return { needsChoice: false, realms };
  }
  return { needsChoice: !Selection.hasOrigin(player), realms };
}

function attach(api) {
  api.registerContentEndpoint("origins-status", (query) => {
    const username = (query.get("player") || "").trim();
    let player = null;
    if (username) {
      try {
        player = api.core.World.getPlayerByName(username) || null;
      } catch {
        player = null;
      }
    }
    return statusPayload(player);
  });
}

module.exports = { attach };
