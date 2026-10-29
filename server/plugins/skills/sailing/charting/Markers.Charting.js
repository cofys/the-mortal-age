// The hint markers over the spyglass views and current ducks' starts: plain locs live adds with the
// zone, charted or not (rsprox: loc_add_change of 59281/59282, shape 10, rotation 0, at the spots
// the Wiki lists for the tasks).
const common = require("./Common.Charting");

const LOC_MARKER = Object.freeze({ spyglass: 59281, current_duck: 59282 });
const SHAPE_CENTREPIECE = 10;

function placeMarkers() {
  const { GameObject, Location, ObjectManager } = common.core();
  for (const [type, id] of Object.entries(LOC_MARKER)) {
    for (const spot of common.spotsOfType(type)) {
      if (!spot.marker) continue;
      const [x, y] = spot.location;
      ObjectManager.register(new GameObject(id, new Location(x, y, 0), SHAPE_CENTREPIECE, 0, null), true);
    }
  }
}

function attach(api) {
  common.init(api);
  api.onServerStartup(placeMarkers);
}

module.exports = attach;
module.exports.LOC_MARKER = LOC_MARKER;
