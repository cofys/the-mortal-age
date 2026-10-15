"use strict";

/**
 * The player's foundry state survives logouts, and every varbit it holds is re-sent at login
 * (rsprox captures: the login burst carries the commission, mould, crucible and preform
 * varbits, the unlocked moulds and varp 3436 wherever the player logs in).
 */

const Shared = require("./Shared.GiantsFoundry");

/** Reputation kept by the generic shop that stood in for Kovac's before interface 753. */
const LEGACY_REPUTATION_ATTRIBUTE = "shop-currency:Foundry Reputation";

function migrateReputation(player) {
  const legacy = Number(player.getAttribute(LEGACY_REPUTATION_ATTRIBUTE)) || 0;
  if (legacy <= 0) return;
  player.setAttribute(LEGACY_REPUTATION_ATTRIBUTE, 0);
  player.setAttribute(Shared.REPUTATION_ATTRIBUTE, Shared.reputation(player) + legacy);
}

function syncOnLogin({ player }) {
  migrateReputation(player);
  Shared.sync(player);
}

module.exports = function attachState(api) {
  api.persistAttribute(Shared.STATE_ATTRIBUTE, { vars: {} });
  api.persistAttribute(Shared.REPUTATION_ATTRIBUTE);
  api.persistAttribute(LEGACY_REPUTATION_ATTRIBUTE);
  api.onPlayerLogin(syncOnLogin);
};
