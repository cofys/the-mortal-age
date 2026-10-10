/**
 * Ironman account types: Ironman, Ultimate Ironman and Hardcore Ironman, per player, set with the
 * admin command `::ironman` (docs/ironman.md; plugins/modes/data/ironman.json). Group Ironman and
 * the Ironman tutor come later.
 */
const Common = require("./ironman/Common.Ironman");

module.exports = {
  name: "Ironman",
  register(api) {
    Common.init(api);
    require("./ironman/Account.Ironman")(api);
    require("./ironman/Commands.Ironman")(api);
    require("./ironman/Trading.Ironman")(api);
    require("./ironman/Loot.Ironman")(api);
    require("./ironman/Shops.Ironman")(api);
    require("./ironman/Ultimate.Ironman")(api);
    require("./ironman/Hardcore.Ironman")(api);
  },
};
