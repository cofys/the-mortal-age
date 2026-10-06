"use strict";

/**
 * CitizenActivityRegistry — compiles the citizens plugin's data-driven
 * activities (data/citizen-activities.json) into the shared bot activity
 * registry via appendActivityDefinitions. The registry, capacity slots and
 * pickActivity stay unified: citizen activities are simply gated by the
 * `citizen` requires-condition so only citizen bots can draw them.
 */

const path = require("path");
const fs = require("fs");
const {
  appendActivityDefinitions,
  getBotActivityRegistries,
} = require("../../bots/brain/BotActivityRegistry");

const DEFINITIONS_PATH = path.join(__dirname, "..", "data", "citizen-activities.json");

let registered = false;

function baseRegistry() {
  const registries = getBotActivityRegistries();
  return registries.length > 0 ? registries[0] : null;
}

/** Compiles citizen activities into the shared registry. Returns the ids added. */
function registerCitizenActivities() {
  if (registered) {
    return [];
  }
  const registry = baseRegistry();
  if (!registry) {
    throw new Error(
      "[citizens] no bot activity registry exists yet — the PlayerBots plugin must register first"
    );
  }
  const raw = JSON.parse(fs.readFileSync(DEFINITIONS_PATH, "utf8"));
  const added = appendActivityDefinitions(registry, raw);
  registered = true;
  return added;
}

function getBaseRegistry() {
  return baseRegistry();
}

module.exports = {
  registerCitizenActivities,
  getBaseRegistry,
};
