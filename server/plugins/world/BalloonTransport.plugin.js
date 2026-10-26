/**
 * The balloon transport system (https://oldschool.runescape.wiki/w/Balloon_transport_system),
 * from plugins/world/data/balloon-transport.json: after Enlightened Journey, the balloon map
 * from Auguste, his assistants and the baskets, the trips between Entrana, Taverley, the Crafting
 * Guild, Varrock, Castle Wars and the Grand Tree, opening the routes from Entrana with the balloon
 * controls, and the stations' shared log storage. Each lives
 * in ./balloontransport/.
 */
const Common = require("./balloontransport/Common.BalloonTransport");
const Travel = require("./balloontransport/Travel.BalloonTransport");
const Storage = require("./balloontransport/Storage.BalloonTransport");
const Controls = require("./balloontransport/Controls.BalloonTransport");

module.exports = {
  name: "BalloonTransport",
  members: true,
  register(api) {
    Common.init(api);
    Travel.attach(api);
    Storage.attach(api);
    Controls.attach(api);
  },
};
