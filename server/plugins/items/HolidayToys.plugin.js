"use strict";

// Permanent reward interaction: owning the toy, not an active holiday window,
// permits viewing it. Rev241's native interface owns its model and Close script.
function lookAtSnowGlobe(api, { player, itemId }) {
  const cache = api.core.CacheDefinitions;
  if (itemId !== cache.getObjId("xmas16_snowglobe")) return false;
  player.getPacketSender().sendInterface(cache.getInterfaceId("xmas16_snow_globe"));
}

module.exports = {
  name: "HolidayToys",
  register(api) {
    api.onItemAction("Snow globe", { "Look at": lookAtSnowGlobe.bind(null, api) });
  },
};
