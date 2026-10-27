/**
 * The Phantom Muspah (https://oldschool.runescape.wiki/w/Phantom_Muspah), from
 * plugins/bosses/data/phantom-muspah.json, as captured: its lair past Secrets of the North (an
 * instance of the player's own), its five forms, spikes, Homing spikes, Lightning clouds, the
 * shockwave and prayer shield, corruption, and the loot. Each part lives in ./phantommuspah/.
 * See docs/phantom-muspah.md.
 */
const Common = require("./phantommuspah/Common.PhantomMuspah");
const Lair = require("./phantommuspah/Lair.PhantomMuspah");
const Fight = require("./phantommuspah/Fight.PhantomMuspah");
const Loot = require("./phantommuspah/Loot.PhantomMuspah");
const Scoreboard = require("./phantommuspah/Scoreboard.PhantomMuspah");

module.exports = {
  name: "PhantomMuspah",
  members: true,
  register(api) {
    Common.init(api);
    Lair.attachLair(api);
    Fight.attachFight(api);
    Loot.attachLoot(api);
    Scoreboard.attachScoreboard(api);
    require("./phantommuspah/Commands.PhantomMuspah")(api);
  },
};
