/** Blast Furnace smelting, conveyor and dispenser; shared machinery lives in blastfurnace/. */
const Furnace = require("./blastfurnace/Furnace.BlastFurnace");

module.exports = {
  name: "BlastFurnace",
  members: true,
  _test: Furnace._test,
  register(api) {
    Furnace(api);
  },
};
