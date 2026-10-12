"use strict";

/**
 * CitizenAnchor — director-side activity anchors.
 *
 * A roster record's data-tier position: where an offline citizen "is".
 * Commoners anchor at their work site (their town's work tile, their
 * settlement's work tile, their kingdom's work tile, or the dock for
 * fishers); every other role anchors at home. The director measures spawn proximity against record.position
 * and spawnCitizen materializes the bot there — so a player walking up to
 * a mining camp finds the miners actually there, instead of everyone
 * spawning at home regardless of where their living is.
 *
 * Work-kind assignment mirrors CitizenRoutine.resolveWorkKind's mix
 * (capitals with a dock get ~40% fishers, rolled once per citizen from the
 * record seed) so the director's anchor and the brain's work shift agree.
 * The chosen kind is stamped on the bot at spawn (ATTR_CITIZEN_WORK_KIND)
 * and the routine adopts it; the spawn kick (queueDirectedPick) starts the
 * citizen on the anchored activity on the first re-decide.
 */

const { ROLE_COMMONER } = require("../constants");
const {
  siteTileByKingdom,
  workSiteByKingdom,
  workSiteBySettlement,
  siteTileByTown,
  workSiteByTown,
  fishingBiasByTown,
} = require("../brain/CitizenSites");
const {
  ACT_MINE,
  ACT_CHOP,
  ACT_FISH,
} = require("../brain/CitizenDecisions");
const { agentRng } = require("./humanizer");

/** Activity the spawn kick directs for each work kind. */
function activityIdForWorkKind(workKind) {
  if (workKind === "rock") return ACT_MINE;
  if (workKind === "tree") return ACT_CHOP;
  // Fishers kick straight into the decision-layer fish activity (real
  // fishing-spot NPCs, real catches/XP via the Fishing plugin).
  if (workKind === "fishing") return ACT_FISH;
  return null;
}

function isGatherKind(catalog) {
  return catalog === "rock" || catalog === "tree";
}

/**
 * Resolve the anchor for a roster record.
 * Returns { x, y, z, workKind, activityId } or null (anchor at home).
 */
function anchorFor(record) {
  if (!record || record.role !== ROLE_COMMONER) {
    return null;
  }
  let tile = null;
  let workKind = null;
  if (record.townId) {
    // Smaller-town citizens work their town's nodes: the town's fishing
    // bias (seeded per citizen, mirroring the routine's roll) sends
    // fishers to the town dock; everyone else works the town's gather
    // site. Towns without a gather site (Blast Furnace district) anchor
    // at home — no fictional work tiles.
    const dock = siteTileByTown(record.townId, "dock");
    const bias = fishingBiasByTown(record.townId);
    if (dock && bias > 0) {
      const rng = agentRng(`anchor:${record.username}:${record.seed ?? 0}`);
      if (rng() < bias) {
        tile = dock;
        workKind = "fishing";
      }
    }
    if (!tile) {
      const work = workSiteByTown(record.townId);
      if (work && isGatherKind(work.catalog)) {
        tile = { x: work.x, y: work.y, z: work.z ?? 0 };
        workKind = work.catalog;
      }
    }
  } else if (record.settlementId) {
    // Frontier settlement citizens work their settlement's site.
    // No docks in settlements yet — no fishing.
    const site = workSiteBySettlement(record.settlementId);
    if (site && isGatherKind(site.catalog)) {
      tile = { x: site.x, y: site.y, z: site.z ?? 0 };
      workKind = site.catalog;
    }
  } else {
    // Capital citizens: ~40% fishers where a dock exists (stable per
    // citizen, seeded by the record seed — mirrors the routine's mix),
    // everyone else at the kingdom's work site.
    const dock = siteTileByKingdom(record.kingdomId, "dock");
    if (dock) {
      const rng = agentRng(`anchor:${record.username}:${record.seed ?? 0}`);
      if (rng() < 0.4) {
        tile = dock;
        workKind = "fishing";
      }
    }
    if (!tile) {
      const work = workSiteByKingdom(record.kingdomId);
      if (work && isGatherKind(work.catalog)) {
        tile = { x: work.x, y: work.y, z: work.z ?? 0 };
        workKind = work.catalog;
      }
    }
  }
  if (!tile || !workKind) {
    return null;
  }
  return {
    x: tile.x,
    y: tile.y,
    z: tile.z ?? 0,
    workKind,
    activityId: activityIdForWorkKind(workKind),
  };
}

module.exports = {
  anchorFor,
  activityIdForWorkKind,
};
