// The Barracudas' boats (rsprox): each trial master stands on his boat at the trial's start
// (Rum-dashed Ralph north of the Storm Tempor, Gurtob with Ros at Backwater, Gwyna by Porth
// Gwenith), and the trials' supply boats lie out on the course (the rum boat south of Tempoross
// Cove, the toad boat at the Jubbly Jive's far west, each with a rat aboard). They're public,
// unboardable world entities of type 10, from their own template zones.
const common = require("./Common.BarracudaTrials");
const StaticShips = require("../StaticShips.Sailing");

/** Ros steps between her two tiles now and then (rsprox). */
const ROS_STEP_TICKS = 8;

/** Spawned ships by data id: the ship and the NPCs on it. */
const spawned = new Map();

function spawnShip(entry) {
  const ship = StaticShips.spawn(entry.id, { fineX: entry.fineX, fineY: entry.fineY, angle: entry.angle });
  if (!ship) return undefined;
  const npcs = (entry.npcs ?? []).map((npc) => StaticShips.addDeckNpc(ship, npc.id, npc.tile[0], npc.tile[1], undefined, { shared: true }));
  const record = { ship, npcs };
  spawned.set(entry.id, record);
  return record;
}

function spawnAll() {
  for (const trial of common.trials) {
    for (const entry of trial.ships) {
      const record = spawnShip(entry);
      if (!record) continue;
      if (entry.id === trial.master.ship) {
        const [x, y] = trial.master.tile;
        record.master = StaticShips.addDeckNpc(record.ship, trial.master.npc, x, y, undefined, { shared: true });
        if (trial.assistant) {
          const [ax, ay] = trial.assistant.tiles[0];
          record.assistant = StaticShips.addDeckNpc(record.ship, trial.assistant.npc, ax, ay, undefined, { shared: true });
          pace(record, trial.assistant.tiles);
        }
      }
    }
  }
}

/** The assistant's idle steps between her tiles. */
function pace(record, tiles) {
  const { Task, TaskManager, PathFinder } = common.core();
  let next = 1;
  TaskManager.submit(new (class extends Task {
    constructor() { super(ROS_STEP_TICKS, "barracuda-trials:assistant", false); }
    execute() {
      const npc = record.assistant;
      if (!npc?.isRegistered?.()) return this.stop();
      const [x, y] = tiles[next];
      const to = StaticShips.deckLocation(record.ship, x, y);
      npc.setSpawnPosition?.(to);
      PathFinder.calculateWalkRoute(npc, to.getX(), to.getY());
      next = (next + 1) % tiles.length;
    }
  })());
}

/** A spawned ship's world entity index (hint arrows, camera targets), by its data id. */
function entityIndex(id) {
  return spawned.get(id)?.ship.boat.entityIndex;
}

function shipOf(id) {
  return spawned.get(id)?.ship;
}

function masterOf(trial) {
  return spawned.get(trial.master.ship)?.master;
}

function attach(api) {
  common.init(api);
  StaticShips.attach(api);
  api.onServerStartup(spawnAll);
}

module.exports = attach;
module.exports.entityIndex = entityIndex;
module.exports.shipOf = shipOf;
module.exports.masterOf = masterOf;
module.exports.spawnAll = spawnAll;
