"use strict";

/**
 * HousingDiegetic — world entry point for the housing overlay.
 *
 * The engine estate agent owns Talk-to / Relocate / Redecorate. This adds a
 * separate right-click option, "Housing", that opens the kingdom housing
 * panel (residence, valuation, boons, visitor settings) instead of the
 * engine dialogue. No ::commands, no engine changes.
 */

const { HOUSING_OPEN_ATTRIBUTE } = require("./HousingApi");

function openHousingPanel(event) {
  const player = event?.player;
  if (!player || player.isPlayerBot?.() === true) return;
  try {
    player.setAttribute(HOUSING_OPEN_ATTRIBUTE, "1");
  } catch {
    // ignore
  }
}

function attach(api) {
  const opts = { Housing: openHousingPanel };
  api.onNpcInteraction("Estate agent", opts);
  api.onNpcInteraction("Estate Agent", opts);
  api.onNpcInteraction("Alwyn", opts);
}

module.exports = attach;
