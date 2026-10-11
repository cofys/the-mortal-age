"use strict";

// Count Check (random event): talking reports his account check and hands out a lamp when
// the player passes. OSRS requires a Jagex Account and a Bank PIN; every account on this
// server is a Jagex account and there is no bank PIN feature to check, so the check passes.
// See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");

function definition(api) {
  return {
    id: api.core.NpcIdentifiers.COUNT_CHECK_2,
    kind: "countcheck",
    greeting: "Ahahahaha",
    talk(active, { serve }) {
      Flow.chat(api, {
        player: active.player,
        npcId: active.definition.id,
        lines: [
          "Ahahahaha! Please let me check you over...",
          "You have a Jagex Account, and your account security looks good.",
          "Congratulations, you pass my checks! Enjoy your prize.",
        ],
      });
      if (serve(active, [api.core.ItemIdentifiers.LAMP])) {
        active.player.sendMessage("Count Check gives you a lamp.");
      }
    },
  };
}

module.exports = function attach(api, Events) {
  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition(api)));
};
