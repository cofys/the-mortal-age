"use strict";

/**
 * Myreque — the Myreque reputation track for The Mortal Age.
 *
 * What comes after "In Search of the Myreque": a two-sided standing track
 * between the Myreque resistance and Lowerniel Drakan's regime. One needle,
 * no fence-sitting — helping one side hurts the other, tier doors lock
 * behind you, and the world (patrols, citizens, rumors, tension) reacts.
 *
 * Content units live in sibling files; this file is a registration list only.
 */

module.exports = {
  name: "Myreque",
  register(api) {
    require("./Reputation.Myreque")(api);
    require("./Actors.Myreque")(api);
    require("./Danger.Myreque")(api);
    require("./Commands.Myreque")(api);
  },
};
