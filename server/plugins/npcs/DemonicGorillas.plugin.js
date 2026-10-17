"use strict";

/**
 * Demonic and tortured gorillas in the Crash Site Cavern (docs/demonic-gorillas.md): style
 * changes after missed hits, the demonic gorillas' protection prayers and boulders, and the
 * cavern's aggression and anti-safespot rules.
 */
module.exports = {
  name: "DemonicGorillas",
  members: true,
  register(api) {
    require("./demonicgorillas/Combat.DemonicGorillas")(api);
    require("./demonicgorillas/Prayer.DemonicGorillas")(api);
    require("./demonicgorillas/Cavern.DemonicGorillas")(api);
  },
};
