/**
 * Gravestones: a PvM death's lost items wait in a grave only the player sees, for 15 minutes,
 * then go to Death's Office. Death's Office and Death's Coffer are in
 * plugins/areas/DeathsOffice.plugin.js, and reach the storage kept here through `gravestones:*`
 * events (gravestones/Events.Gravestones.js). See docs/gravestones.md.
 */
module.exports = {
  name: "Gravestones",
  register(api) {
    require("./gravestones/Storage.Gravestones").attach(api);
    require("./gravestones/Death.Gravestones").attach(api);
    require("./gravestones/Interface.Gravestones").attach(api);
    require("./gravestones/Timer.Gravestones").attach(api);
    require("./gravestones/Events.Gravestones").attach(api);
  },
};
