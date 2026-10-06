"use strict";

/**
 * findCitizen — tiny local-player scans for citizen-to-citizen business.
 *
 * Prime merchants find their supplier, commoners find theirs, hungry
 * citizens find provisioners — all among the bots actually standing nearby.
 * Predicates live with the callers; this module only does the scan.
 */

function localCitizens(player) {
  const out = [];
  let locals = [];
  try {
    locals = player.getLocalPlayers?.() ?? [];
  } catch (error) {
    return out;
  }
  for (const local of locals) {
    if (local === player) {
      continue;
    }
    try {
      if (local?.isPlayerBot?.() === true) {
        out.push(local);
      }
    } catch (error) {
      // Skip unreadable entries.
    }
  }
  return out;
}

function findLocalCitizen(player, predicate) {
  for (const local of localCitizens(player)) {
    try {
      if (predicate(local)) {
        return local;
      }
    } catch (error) {
      // A broken predicate skips one candidate, not the search.
    }
  }
  return null;
}

module.exports = {
  localCitizens,
  findLocalCitizen,
};
