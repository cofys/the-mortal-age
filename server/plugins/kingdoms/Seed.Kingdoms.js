"use strict";

/**
 * Seed.Kingdoms — plants the five great powers from the world bible at server
 * startup. Runs after the store loads; seeding is idempotent — records that
 * already exist keep their live treasury, ruler and flags, so a reseed never
 * clobbers a world that has moved on.
 */

const Store = require("./KingdomStore");

let pluginApi;

// The rank ladder every great power shares in v1. Per-kingdom hierarchies
// (the Consortium's company ranks, Lowerniel's blood court) are stubbed.
const DEFAULT_HIERARCHY = [
  "Outsider",
  "Subject",
  "Man-at-arms",
  "Knight",
  "Lord",
  "Regent",
  "Monarch",
];

// The five great powers at launch, straight from the world bible.
// Treasuries are v1 seed numbers, not canon.
const GREAT_POWERS = [
  {
    id: "asgarnia",
    name: "Asgarnia",
    capital: "Falador",
    ruler: "Sir Amik Varze",
    rulerTitle: "Lord Regent, Steward of Falador",
    situation:
      "The kingdom with no king. King Vallance unseen for years; Crown Prince " +
      "Anlaf holds Burthorpe with the Imperial Guard, fearing assassination; " +
      "the Kinshra arm in the wilderness. The server's central plot engine.",
    hierarchy: DEFAULT_HIERARCHY,
    treasury: 250000,
    flags: { "asgarnia:regency": true },
  },
  {
    id: "misthalin",
    name: "Misthalin",
    capital: "Varrock",
    ruler: "Roald III",
    rulerTitle: "King of Misthalin",
    situation:
      "The heirless crown. Aging Roald III with no named heir; the Church rivals " +
      "the monarchy; the Phoenix Gang and the Black Arm Gang feud in the streets; " +
      "the Shield of Arrav is a legitimacy token waiting to matter.",
    hierarchy: DEFAULT_HIERARCHY,
    treasury: 400000,
    flags: { "misthalin:bastard-son-hidden": true },
  },
  {
    id: "kandarin",
    name: "Kandarin",
    capital: "East Ardougne",
    ruler: "King Lathas",
    rulerTitle: "King of Kandarin",
    situation:
      "The lie. Lathas sits the throne; the plague quarantine holds West Ardougne " +
      "in misery. Our flagship custom questline exposes the lie and topples a king.",
    hierarchy: DEFAULT_HIERARCHY,
    treasury: 300000,
    flags: { "ardougne:plague-lie-active": true },
  },
  {
    id: "morytania",
    name: "Morytania",
    capital: "Meiyerditch",
    ruler: "Lowerniel Drakan",
    rulerTitle: "Lord of Morytania",
    situation:
      "The dark. Lowerniel farms humans for blood; the Myreque is newly founded " +
      "and desperate. The River Salve — ancient god-magic in an age of silence — " +
      "is the server's doomsday clock.",
    hierarchy: DEFAULT_HIERARCHY,
    treasury: 150000,
    flags: { "morytania:salve-integrity": 100 },
  },
  {
    id: "keldagrim",
    name: "Keldagrim",
    capital: "Keldagrim",
    ruler: "The Consortium",
    rulerTitle: "The Eight Companies, in council",
    situation:
      "The company war. Eight mining companies rule as oligarchs; the exiled Red " +
      "Axe builds a chaos-dwarf army in secret. The monarchy question is live.",
    hierarchy: DEFAULT_HIERARCHY,
    treasury: 500000,
    flags: { "keldagrim:red-axe-threat": "rising" },
  },
];

function seedKingdoms() {
  Store.load();
  for (const def of GREAT_POWERS) {
    if (!Store.getKingdom(def.id)) {
      Store.upsertKingdom(def);
      pluginApi.emitCustomEvent("kingdom:created", {
        kingdomId: def.id,
        name: def.name,
        capital: def.capital,
        ruler: def.ruler,
        seed: true,
      });
    }
  }
  Store.save();
}

module.exports = function attachSeed(api) {
  pluginApi = api;
  api.onServerStartup(seedKingdoms);
};

module.exports.GREAT_POWERS = GREAT_POWERS;
module.exports.DEFAULT_HIERARCHY = DEFAULT_HIERARCHY;
