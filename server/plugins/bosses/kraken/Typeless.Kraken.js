"use strict";

/**
 * Typeless boss hits (see ../Kraken.plugin.js for behaviour and sources).
 * Wiki (Kraken): the Kraken and its Enormous Tentacles use typeless Magic — Protect from
 * Magic gives no damage reduction. Cave krakens are regular Magic and stay prayable, so
 * they are left out here.
 */

const Shared = require("./Shared.Kraken");

function krakenTypeless(event) {
  const attacker = event?.attacker;
  if (!attacker?.isNpc?.()) return;
  const npcId = attacker.getId?.();
  const { BOSS, TENTACLE } = Shared.ids();
  if (npcId !== BOSS && npcId !== TENTACLE) return;
  event.bypassProtectionPrayer = true;
}

function attach(api) {
  api.onCombatHitRoll(krakenTypeless);
}

module.exports = { attach, krakenTypeless };
