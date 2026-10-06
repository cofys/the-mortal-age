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
  kingdomIdOf,
  sitesFor,
  siteTile,
  siteTileByKingdom,
  patrolCircuit,
  workSite,
  dockSite,
};
