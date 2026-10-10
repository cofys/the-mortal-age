"use strict";

/**
 * CitizenSites — physical anchor tiles per kingdom (court, market, tavern,
 * bank, patrol circuit, work site). Data lives in data/sites.json, keyed by
 * the kingdoms plugin's kingdom ids. Falls back to the first defined kingdom
 * so a misconfigured bot still does something sane.
 */

const path = require("path");
const fs = require("fs");
const { ATTR_KINGDOM_ID } = require("../constants");

const SITES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "sites.json"), "utf8")
);
const KINGDOM_IDS = Object.keys(SITES).filter((key) => !key.startsWith("_"));

// Frontier settlements: towns in unclaimed regions. Each settlement carries
// its own site anchors plus the nearest great power's kingdomId for
// kingdom-level mechanics. Citizens live at the settlement, not the capital.
const SETTLEMENTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "settlements.json"), "utf8")
);
const SETTLEMENT_IDS = Object.keys(SETTLEMENTS).filter(
  (key) => !key.startsWith("_")
);

function kingdomIdOf(player) {
  const id = player?.getAttribute?.(ATTR_KINGDOM_ID);
  return typeof id === "string" && SITES[id] ? id : KINGDOM_IDS[0];
}

function sitesFor(player) {
  return SITES[kingdomIdOf(player)];
}

function siteTile(player, kind) {
  const sites = sitesFor(player);
  return siteTileFor(sites, kind);
}

function siteTileFor(sites, kind) {
  const tile = sites?.[kind];
  if (tile && Number.isFinite(tile.x) && Number.isFinite(tile.y)) {
    return { x: tile.x, y: tile.y, z: tile.z ?? 0 };
  }
  return null;
}

/** Anchor tile without a player entity (director-side, pre-spawn). */
function siteTileByKingdom(kingdomId, kind) {
  const sites = SITES[kingdomId] ?? SITES[KINGDOM_IDS[0]];
  return siteTileFor(sites, kind);
}

/** Anchor tile for a frontier settlement (director-side, pre-spawn). */
function siteTileBySettlement(settlementId, kind) {
  const sites = SETTLEMENTS[settlementId];
  if (!sites) return null;
  return siteTileFor(sites, kind);
}

/** The great power a settlement affiliates with (nearest kingdom). */
function kingdomIdOfSettlement(settlementId) {
  const sites = SETTLEMENTS[settlementId];
  const id = sites?.kingdomId;
  return typeof id === "string" && SITES[id] ? id : KINGDOM_IDS[0];
}

function patrolCircuit(player) {
  const sites = sitesFor(player);
  const circuit = Array.isArray(sites?.patrol) ? sites.patrol : [];
  return circuit.filter(
    (tile) => tile && Number.isFinite(tile.x) && Number.isFinite(tile.y)
  );
}

function workSite(player) {
  const sites = sitesFor(player);
  return sites?.work ?? null;
}

/** Dock/water tile for commoner fishers; null where none exists (Keldagrim). */
function dockSite(player) {
  const sites = sitesFor(player);
  const tile = sites?.dock;
  if (tile && Number.isFinite(tile.x) && Number.isFinite(tile.y)) {
    return { x: tile.x, y: tile.y, z: tile.z ?? 0 };
  }
  return null;
}

module.exports = {
  KINGDOM_IDS,
  SETTLEMENT_IDS,
  kingdomIdOf,
  kingdomIdOfSettlement,
  sitesFor,
  siteTile,
  siteTileByKingdom,
  siteTileBySettlement,
  patrolCircuit,
  workSite,
  dockSite,
};
