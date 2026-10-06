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

const Selection = require("./Selection.Origins");
const Gui = require("./Gui.Origins");
const OriginsApi = require("./OriginsApi");

module.exports = {
  name: "Origins",
  register(api) {
    Selection(api);
    Gui.attach(api);
    OriginsApi.attach(api);
    // Triggers live in Selection; the screen lives in Gui. Wire them here so
    // neither module requires the other at load time.
    Selection.setGuiHooks(Gui.hooks());
  },
};
