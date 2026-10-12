// Naval warfare Phase 1 ("Sail & Shoot"): cannon broadsides from deck cannon facilities,
// hull HP + fires + sinking, one kraken encounter, one navy cutter, piracy notoriety.
// Mechanics only — no questlines (quest-content HOLD).
const { Task } = require("../../../src/main/typescript/elvarg/game/task/Task");
const { TaskManager } = require("../../../src/main/typescript/elvarg/game/task/TaskManager");
const { content } = require("./sailingContent");
const { notorietyOf, decayNotoriety } = require("./navalNotoriety");
const {
  KRAKEN,
  METAL_TIERS,
  navalTick,
  fireBroadside,
  patchHull,
  spawnNavyBoat,
  krakenState,
  navyState,
} = require("./navalCombat");

/** Deck cannon facilities are "<Metal> cannon", from the cache's sailing facility table. */
const CANNON_OBJECTS = METAL_TIERS.map((metal) => `${metal[0].toUpperCase()}${metal.slice(1)} cannon`);
/** Item name from sailing-cargo.json's supplies list (live-capture names). */
const REPAIR_KIT_NAME = "Repair kit";
/** Repair kit item ids (charged states), from the cache's item definitions. */
const REPAIR_KIT_IDS = [31964, 31965, 31966];
/** Buccaneers' Haven landing: the Phase 1 pirate port (sailing-ports.json). */
const PIRATE_PORT = { x: 2080, y: 3689, z: 0 };
/** A generic pirate look from the cache (Mos Le'Harmless pirates use it too). */
const PIRATE_NPC_ID = 522;

let pluginApi = null;
/** The haven's quartermaster NPC instance (spawned on startup). */
let quartermaster = null;

function startNaval() {
  spawnNavyBoat();
  spawnPiratePort();
  TaskManager.submit(new (class extends Task {
    constructor() { super(1); }
    execute() {
      navalTick();
      syncKrakenVisual();
    }
  })());
}

/** The kraken's NPC is decorative: the fight runs on navalCombat's engine state. */
function syncKrakenVisual() {
  if (!pluginApi) return;
  if (krakenState.alive && !krakenState.npc) {
    const npc = pluginApi.spawnNpc({ id: KRAKEN.npcId, x: KRAKEN.x, y: KRAKEN.y, wanderRadius: 0 });
    npc.getMovementQueue().setBlockMovement(true).reset();
    npc.setFlag("combat:no-retaliate");
    krakenState.npc = npc;
  } else if (!krakenState.alive && krakenState.npc) {
    pluginApi.removeNpc(krakenState.npc);
    krakenState.npc = null;
  }
}

function decayNotorietyOnLogin({ player }) {
  decayNotoriety(player);
}

/** The pirate port's quartermaster: a haven greeter whose welcome scales with notoriety. */
function spawnPiratePort() {
  if (!pluginApi || quartermaster) return;
  quartermaster = pluginApi.spawnNpc({
    id: PIRATE_NPC_ID, x: PIRATE_PORT.x, y: PIRATE_PORT.y, z: PIRATE_PORT.z, wanderRadius: 2,
  });
}

function talkQuartermaster({ player, npc }) {
  if (npc !== quartermaster) return; // Only our haven's quartermaster, not every pirate.
  const notoriety = notorietyOf(player);
  if (notoriety >= 75) {
    player.sendMessage("Quartermaster: \"The Terror of the Seas walks among us! The Haven is yours, captain.\"");
  } else if (notoriety >= 50) {
    player.sendMessage("Quartermaster: \"Marked by the navy, eh? You'll find no law here — only opportunity.\"");
  } else if (notoriety >= 25) {
    player.sendMessage("Quartermaster: \"Word of your piracy spreads. Fence your loot here; the navy won't follow.\"");
  } else {
    player.sendMessage("Quartermaster: \"Buccaneers' Haven. We don't know you yet — come back when you've earned a name at sea.\"");
  }
}

function fireCannons({ player }) {
  fireBroadside(player);
}

function patchShipHull() {
  return (event) => {
    event.handled = true;
    // Prefer the clicked item's real id; fall back to the known repair-kit ids.
    const kitIds = [event.itemId, ...REPAIR_KIT_IDS].filter((id) => Number.isInteger(id));
    patchHull(event.player, kitIds);
  };
}

module.exports = {
  name: "NavalCombat",
  members: true,
  register(api) {
    pluginApi = api;
    content();
    for (const cannon of CANNON_OBJECTS) api.onObjectInteraction(cannon, { "Fire-broadside": fireCannons });
    api.onItemAction(REPAIR_KIT_NAME, { "Patch-hull": patchShipHull() });
    api.onNpcInteraction("Pirate", { "Talk-to": talkQuartermaster });
    api.onPlayerLogin(decayNotorietyOnLogin);
    api.onServerStartup(startNaval);
  },
};
