"use strict";

/**
 * NewspaperApi — HTTP data layer for the web client's newspaper overlay.
 *
 * The town crier sets the newspaper:open player attribute to the edition id
 * when handing a player a copy (see CitizenNewspaper.tickCrier); the React
 * NewspaperOverlay (client/game/plugins/newspaper) polls this endpoint and
 * renders the week's paper in the heraldic style.
 *
 *   GET /api/newspaper-status?player=<username>
 *     -> { open: false } | { open: true, paper: {...} }
 *
 *   ...&action=close — clear the newspaper:open flag (overlay dismissed)
 */

const { latestEdition, NEWSPAPER_OPEN_ATTRIBUTE } = require("../citizens/lib/CitizenNewspaper");

function findPlayer(api, username) {
  const name = (username || "").trim();
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function paperFor(edition) {
  if (!edition) return null;
  return {
    id: String(edition.id || ""),
    kingdom: String(edition.kingdom || ""),
    paper: String(edition.paper || "The Realm Reporter"),
    compiledAt: edition.compiledAt || 0,
    headlines: (edition.headlines || []).slice(0, 5),
    gossip: (edition.gossip || []).slice(0, 5),
    announcements: (edition.announcements || []).slice(0, 5),
    obituaries: (edition.obituaries || []).slice(0, 3),
  };
}

function attach(api) {
  console.info("[newspaper-api] registering newspaper-status endpoint");
  api.registerContentEndpoint("newspaper-status", (query) => {
    try {
      const player = findPlayer(api, query.get("player"));
      const action = (query.get("action") || "").trim().toLowerCase();

      if (player && action === "close") {
        try { player.setAttribute(NEWSPAPER_OPEN_ATTRIBUTE, ""); }
        catch (e) { console.warn("[newspaper-api] close failed", e?.message ?? e); }
        return { open: false };
      }

      if (!player) return { open: false };

      let editionId = "";
      try { editionId = String(player.getAttribute(NEWSPAPER_OPEN_ATTRIBUTE) || "").trim(); }
      catch { editionId = ""; }
      if (!editionId) return { open: false };

      const edition = latestEdition();
      if (!edition) {
        try { player.setAttribute(NEWSPAPER_OPEN_ATTRIBUTE, ""); } catch { /* ignore */ }
        return { open: false };
      }

      return { open: true, paper: paperFor(edition) };
    } catch (e) {
      console.warn("[newspaper-api] handler failed:", e?.message ?? e);
      return { open: false };
    }
  });
}

module.exports = { attach, NEWSPAPER_OPEN_ATTRIBUTE };
