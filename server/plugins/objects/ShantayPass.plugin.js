"use strict";

// The Shantay Pass loc is a walk-through menu action, not a normal hinged gate. Its
// collision remains closed in the cache, so the player has to be force-walked through
// the one-tile fence gap after passing the guard. OSRS consumes a Shantay pass when
// entering the desert; returning to Al Kharid is free.
const ObstacleRunner = require("../skills/agility/ObstacleRunner.Agility");

const PASS_LOCATION = Object.freeze({ x: 3302, y: 3116, z: 0 });
const PASS_OBJECT_ID = 4031;
const PASS_ITEM_ID = 1854;

function crossingFor(source, gate = PASS_LOCATION) {
  if (!source || !Number.isInteger(source.x) || !Number.isInteger(source.y)) return null;
  if (source.z !== gate.z || Math.abs(source.x - gate.x) > 1 || Math.abs(source.y - gate.y) > 1) return null;
  if (source.y > gate.y) return { desert: true, path: [[source.x, gate.y], [source.x, gate.y - 1]] };
  if (source.y < gate.y) return { desert: false, path: [[source.x, gate.y], [source.x, gate.y + 1]] };
  return null;
}

function crossPass({ player, objectId, location, sourceLocation, handled }) {
  if (handled || objectId !== PASS_OBJECT_ID
    || !location || location.x !== PASS_LOCATION.x || location.y !== PASS_LOCATION.y || location.z !== PASS_LOCATION.z) return;

  const crossing = crossingFor(sourceLocation);
  if (!crossing) return;

  if (crossing.desert) {
    const inventory = player.getInventory();
    if (inventory.getAmount(PASS_ITEM_ID) < 1) {
      player.sendMessage("You need a Shantay pass to enter the desert.");
      return true;
    }
    inventory.deleteNumber(PASS_ITEM_ID, 1);
  }

  player.sendMessage(crossing.desert ? "You pass through the gate into the desert." : "You pass through the gate into Al Kharid.");
  ObstacleRunner.run({ player }, [{ wait: 1 }, { walk: crossing.path }]);
  return true;
}

module.exports = {
  name: "ShantayPass",
  crossingFor,
  register(api) {
    ObstacleRunner.init(api);
    api.onObjectInteraction("Shantay pass", { "Go-through": crossPass });
  },
};
