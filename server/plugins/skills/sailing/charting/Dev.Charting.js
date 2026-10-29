// Developer commands for trying sea charting: ::chart go <spot> (the boat next to a spot), ::chart
// done <spot> (chart it as if done), ::chart reset [spot] (forget one or every chart), ::chart find
// <text> (spots whose key matches). Spots by key (generic_rock_bay_of_sarim) or unique id.
const common = require("./Common.Charting");

const USAGE = "::chart go <spot> | done <spot> | reset [spot] | find <text>";

function spotNamed(name) {
  if (name === undefined) return undefined;
  if (/^\d+$/.test(name)) return common.allSpots().get(Number(name));
  return common.spotByKey(String(name).toLowerCase()) ?? common.spotByKey(`generic_${String(name).toLowerCase()}`);
}

function command({ player, parts }) {
  const [, action, name] = parts;
  const spot = spotNamed(name);
  if (action === "find" && name) {
    const found = [...common.allSpots().values()].filter((each) => each.key.includes(name.toLowerCase())).slice(0, 12);
    player.sendMessage(found.map((each) => `${each.uid}:${each.key}`).join(", ") || "No spot matches.");
    return true;
  }
  if (action === "done" && spot) {
    common.complete(player, spot);
    return true;
  }
  if (action === "reset") {
    common.updateProgress(player, (saved) => {
      saved.charted = spot ? saved.charted.filter((uid) => uid !== spot.uid) : [];
      if (!spot) Object.assign(saved, { owed: [], paid: [], fullOwed: false, fullPaid: false });
    });
    const sender = player.getPacketSender();
    for (let i = 0; i < 12; i++) sender.sendConfig(common.VARP_SPOTS + i, 0);
    common.sendProgress(player);
    player.sendMessage(spot ? `Forgot ${spot.key}.` : "Forgot every chart.");
    return true;
  }
  if (action === "go" && spot?.location) {
    const boat = common.core().Sailing.instanceAboard(player);
    if (!boat) {
      player.sendMessage("You need to be aboard your boat.");
      return true;
    }
    const [x, y] = spot.location;
    const { BoatManager } = common.core();
    // The nearest sailable tile a few tiles off the spot.
    for (let r = 3; r <= 12; r++) {
      for (const [dx, dy] of [[0, -r], [0, r], [-r, 0], [r, 0], [-r, -r], [r, r], [-r, r], [r, -r]]) {
        if (!BoatManager.isSailable(x + dx, y + dy, 0)) continue;
        BoatManager.teleport(boat, { fineX: (x + dx) * 128 + 64, fineY: (y + dy) * 128 + 64 });
        return true;
      }
    }
    player.sendMessage(`No sailable tile near ${spot.key}.`);
    return true;
  }
  player.sendMessage(USAGE);
  return true;
}

function attach(api) {
  common.init(api);
  api.registerCommand("chart", command, api.core.PlayerRights.DEVELOPER, `Sea charting: ${USAGE}`);
}

module.exports = attach;
