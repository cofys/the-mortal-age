"use strict";

const {
  canAttackByWildernessLevel,
} = require("../../../areas/Wilderness.plugin");

// The wilderness level range is symmetric, so a player outside it is neither a target
// worth walking to nor a threat worth reacting to.
function isVisibleRealPlayer(sourcePlayer, candidate) {
  return (
    candidate &&
    candidate !== sourcePlayer &&
    candidate.isPlayerBot?.() !== true &&
    candidate.isRegistered?.() === true &&
    (candidate.getHitpoints?.() ?? 0) > 0 &&
    candidate.getPrivateArea?.() === sourcePlayer.getPrivateArea?.() &&
    canAttackByWildernessLevel(sourcePlayer, candidate)
  );
}

module.exports = {
  isVisibleRealPlayer,
};
