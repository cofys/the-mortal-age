/**
 * Shared rumor helper for the fishing-depth modules.
 *
 * Not attached: required by Conditions, ShoalRun, Wilderness, Mastery and Supply.
 * A rumor does two things, both best-effort:
 *   1. emits "kingdom:rumor" so a citizen of that kingdom says it aloud (street-talk path);
 *   2. seeds the citizen gossip network so the news hops citizen to citizen.
 * When the citizens plugin is disabled both degrade silently - the game never depends on them.
 */
const { getMemory } = require("../../citizens/lib/CitizenMemory");

const GOSSIP_KIND = "fishing";

function spreadRumor(api, kingdomId, text) {
  if (!kingdomId || !text) return;
  api.emitCustomEvent("kingdom:rumor", { kingdomId, text });
  try {
    getMemory().seedGossip({ kingdomId, kind: GOSSIP_KIND, subject: "anglers", text, holder: "" });
  } catch (error) {
    // Citizens disabled or memory not loaded: the street-talk event above still fired.
  }
}

module.exports = { spreadRumor, GOSSIP_KIND };
