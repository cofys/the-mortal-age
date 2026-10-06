"use strict";

/**
 * Origins — ORIGIN SELECTION for The Mortal Age.
 *
 * Mount & Blade style: at character creation (first login — the client has no
 * creation screen) the player picks a HOME from the five great powers or
 * wanders. The pick is the "feels like home" anchor: starting location,
 * starting kit, and the initial political lens.
 *
 * Content units live in sibling files; this file is a registration list only.
 */

module.exports = {
  name: "Origins",
  register(api) {
    require("./Selection.Origins")(api);
  },
};
