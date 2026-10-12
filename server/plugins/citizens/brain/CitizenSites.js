"use strict";

/**
 * CitizenSites — physical anchor tiles per kingdom (court, market, tavern,
 * bank, patrol circuit, work site). Data lives in data/sites.json, keyed by
 * the kingdoms plugin's kingdom ids. Falls back to the first defined kingdom
 * so a misconfigured bot still does something sane.
 */

const path = require("path");
const fs = require("fs");
const { ATTR_KINGDOM_ID, ATTR_CITIZEN_TOWN } = require("../constants");

const SITES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "sites.json"), "utf8")
);
const KINGDOM_IDS = Object.keys(SITES).filter((key) => !key.startsWith("_"));

// Smaller towns + Keldagrim city districts: in-kingdom population anchors.
// Each town carries its great power's kingdomId for kingdom mechanics;
// citizens live at the town, not the capital. Bankless towns (real-RS-
// accurate: Port Sarim, Taverley, Burgh de Rott) have no bank anchor — the
// bank hinge falls back to the town's bankTown, then the capital's bank.
const TOWNS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "towns.json"), "utf8")
);
const TOWN_IDS = Object.keys(TOWNS).filter((key) => !key.startsWith("_"));

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

/** The smaller town / city district this citizen lives in (null for capitals). */
function townIdOf(player) {
  try {
    const id = player?.getAttribute?.(ATTR_CITIZEN_TOWN);
    return typeof id === "string" && TOWNS[id] ? id : null;
  } catch {
    return null;
  }
}

function siteTile(player, kind) {
  const townId = townIdOf(player);
  if (townId) {
    // Bankless towns resolve through the bank fallback chain (bankTown,
    // then the capital's bank) — the hinge always has a real booth to walk
    // to. Every other kind reads the town's own anchor.
    const townTile =
      kind === "bank"
        ? bankTileByTown(townId)
        : siteTileByTown(townId, kind);
    if (townTile) return townTile;
  }
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

/** Anchor tile for a smaller town / city district (director-side, pre-spawn). */
function siteTileByTown(townId, kind) {
  const sites = TOWNS[townId];
  if (!sites) return null;
  return siteTileFor(sites, kind);
}

/** The great power a smaller town belongs to. */
function kingdomIdOfTown(townId) {
  const sites = TOWNS[townId];
  const id = sites?.kingdomId;
  return typeof id === "string" && SITES[id] ? id : KINGDOM_IDS[0];
}

/** Town ids belonging to a kingdom (for roster distribution + tests). */
function townsForKingdom(kingdomId) {
  return TOWN_IDS.filter((townId) => TOWNS[townId]?.kingdomId === kingdomId);
}

/**
 * Share of a town's commoners who fish (0 when the town has no dock).
 * Town character lives in data: fishing towns fish, wood towns cut,
 * mining towns mine — not an even spread.
 */
function fishingBiasByTown(townId) {
  const sites = TOWNS[townId];
  if (!sites || !siteTileFor(sites, "dock")) return 0;
  const bias = Number(sites.fishingBias);
  return Number.isFinite(bias) && bias > 0 ? Math.min(1, bias) : 0;
}

/**
 * Bank anchor for a town citizen. Bankless towns (real-RS-accurate) fall
 * back to their bankTown's bank, then to the kingdom capital's bank — the
 * bank hinge always has somewhere real to walk to.
 */
function bankTileByTown(townId) {
  const sites = TOWNS[townId];
  if (!sites) return null;
  const own = siteTileFor(sites, "bank");
  if (own) return own;
  const bankTown = sites.bankTown;
  if (typeof bankTown === "string" && TOWNS[bankTown]) {
    const via = siteTileFor(TOWNS[bankTown], "bank");
    if (via) return via;
  }
  return siteTileByKingdom(kingdomIdOfTown(townId), "bank");
}

/**
 * Work site config for a smaller town / city district: x/y/z plus
 * catalog/tier/option for the InteractObject work delegate. Null when the
 * town has no gather site (e.g. the Blast Furnace district — its citizens
 * anchor at home, not at a fictional work tile).
 */
function workSiteByTown(townId) {
  const sites = TOWNS[townId];
  const work = sites?.work;
  if (!work || !Number.isFinite(work.x) || !Number.isFinite(work.y)) {
    return null;
  }
  return {
    catalog: work.catalog ?? "tree",
    tier: work.tier ?? "normal",
    option: work.option ?? "Chop down",
    x: work.x,
    y: work.y,
    z: work.z ?? 0,
  };
}

/**
 * Work site config for a frontier settlement: x/y/z plus catalog/tier/option
 * for the InteractObject work delegate. Null when the settlement has no
 * work site configured.
 */
function workSiteBySettlement(settlementId) {
  const sites = SETTLEMENTS[settlementId];
  const work = sites?.work;
  if (!work || !Number.isFinite(work.x) || !Number.isFinite(work.y)) {
    return null;
  }
  return {
    catalog: work.catalog ?? "tree",
    tier: work.tier ?? "normal",
    option: work.option ?? "Chop down",
    x: work.x,
    y: work.y,
    z: work.z ?? 0,
  };
}

/**
 * Work site config for a kingdom capital: x/y/z plus catalog/tier/option
 * for the InteractObject work delegate. Null when the kingdom has no work
 * site configured. (Director-side, pre-spawn — mirrors workSiteBySettlement.)
 */
function workSiteByKingdom(kingdomId) {
  const sites = SITES[kingdomId] ?? SITES[KINGDOM_IDS[0]];
  const work = sites?.work;
  if (!work || !Number.isFinite(work.x) || !Number.isFinite(work.y)) {
    return null;
  }
  return {
    catalog: work.catalog ?? "tree",
    tier: work.tier ?? "normal",
    option: work.option ?? "Chop down",
    x: work.x,
    y: work.y,
    z: work.z ?? 0,
  };
}

/** The great power a settlement affiliates with (nearest kingdom). */
function kingdomIdOfSettlement(settlementId) {
  const sites = SETTLEMENTS[settlementId];
  const id = sites?.kingdomId;
  return typeof id === "string" && SITES[id] ? id : KINGDOM_IDS[0];
}

function patrolCircuit(player) {
  const townId = townIdOf(player);
  if (townId) {
    // Town guards walk a beat around their own town square, not the
    // capital's — a Burthorpe guardsman patrols Burthorpe.
    const square = siteTileByTown(townId, "square");
    if (square) {
      const r = 10;
      const z = square.z ?? 0;
      return [
        { x: square.x - r, y: square.y - r, z },
        { x: square.x + r, y: square.y - r, z },
        { x: square.x + r, y: square.y + r, z },
        { x: square.x - r, y: square.y + r, z },
      ];
    }
  }
  const sites = sitesFor(player);
  const circuit = Array.isArray(sites?.patrol) ? sites.patrol : [];
  return circuit.filter(
    (tile) => tile && Number.isFinite(tile.x) && Number.isFinite(tile.y)
  );
}

function workSite(player) {
  const townId = townIdOf(player);
  if (townId) {
    const townWork = TOWNS[townId]?.work;
    if (townWork) return townWork;
  }
  const sites = sitesFor(player);
  return sites?.work ?? null;
}

/** Dock/water tile for commoner fishers; null where none exists (Keldagrim). */
function dockSite(player) {
  const townId = townIdOf(player);
  if (townId) {
    const townDock = siteTileByTown(townId, "dock");
    if (townDock) return townDock;
  }
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
  TOWN_IDS,
  kingdomIdOf,
  kingdomIdOfSettlement,
  kingdomIdOfTown,
  townsForKingdom,
  townIdOf,
  sitesFor,
  siteTile,
  siteTileByKingdom,
  siteTileBySettlement,
  siteTileByTown,
  bankTileByTown,
  fishingBiasByTown,
  workSiteByKingdom,
  workSiteBySettlement,
  workSiteByTown,
  patrolCircuit,
  workSite,
  dockSite,
};
