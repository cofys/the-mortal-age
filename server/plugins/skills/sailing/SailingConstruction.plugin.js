// Boat construction: blueprints, drydock, brig. A shipwright's Buy-blueprint sells the brig
// blueprint; Build-boat runs a three-stage drydock build (hull, masts & rigging, fit-out),
// each stage costing materials and Construction XP on completion, with visible progress as
// the shipwright's crew works. Launching names the ship (three-word picker) and paints the
// hull (12 colours), then Sailing.giveBoat moors the brig at the shipwright's port.
//
// The brig reuses the sloop's hull model and deck (boats.json) until it gets its own cache
// art; stats are the design's (cargo 70, medium+ speed, first real warship hull).
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../../src/main/typescript/elvarg/game/model/Item");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const { Task } = require("../../../src/main/typescript/elvarg/game/task/Task");
const { TaskManager } = require("../../../src/main/typescript/elvarg/game/task/TaskManager");
const { content, boatName, randomBoatName } = require("./SailingContent.Sailing");

const BUILD_ATTRIBUTE = "sailing:boat-build";
const BRIG_BLUEPRINT = 50006;
const COINS = 995;
/** What a shipwright charges for the brig blueprint. */
const BLUEPRINT_PRICE = 100000;
/** Construction level to build the brig. */
const BUILD_LEVEL = 55;
/** Ticks each drydock stage takes (~36 seconds a stage). */
const STAGE_TICKS = 60;
/** Sailing XP for launching a ship you built. */
const LAUNCH_XP = 2500;
/** The twelve hull paint colours. */
const PAINTS = [
  "Black", "White", "Red", "Blue", "Green", "Yellow",
  "Purple", "Orange", "Brown", "Grey", "Teal", "Pink",
];
/** A drydock stage: its materials, Construction XP and the work message. */
const STAGES = [
  {
    name: "hull",
    materials: [
      [ItemIdentifiers.OAK_PLANK, 40],
      [ItemIdentifiers.STEEL_NAILS, 200],
    ],
    xp: 1200,
    work: "The shipwright's crew starts laying your brig's hull...",
    done: "The hull is laid: oak ribs rising from the drydock.",
  },
  {
    name: "masts and rigging",
    materials: [
      [ItemIdentifiers.OAK_PLANK, 20],
      [ItemIdentifiers.BOLT_OF_CLOTH, 10],
    ],
    xp: 1200,
    work: "Masts go up and the rigging is rove through the blocks...",
    done: "The masts stand and the rigging is taut.",
  },
  {
    name: "fit-out",
    materials: [
      [ItemIdentifiers.SWAMP_TAR, 10],
      [ItemIdentifiers.STEEL_NAILS, 100],
    ],
    xp: 1600,
    work: "The seams are tarred and the fit-out begins...",
    done: "She is tarred, fitted and ready to launch.",
  },
];

let pluginApi = null;

function buildOf(player) {
  return player.getAttribute(BUILD_ATTRIBUTE);
}

function setBuild(player, build) {
  player.setAttribute(BUILD_ATTRIBUTE, build ?? null);
}

/** The shipwright NPC's dock, from its name (same lookup as Recover-boat). */
function dockForNpc(npc) {
  const name = npc.getDefinition?.()?.getName?.() ?? "";
  return content().docks.find((candidate) => candidate.shipwright === name);
}

function constructionLevel(player) {
  return player.getSkillManager().getMaxLevel(Skill.CONSTRUCTION);
}

/** True when the player holds every material for the stage. */
function hasMaterials(player, stage) {
  const inventory = player.getInventory();
  return stage.materials.every(([id, amount]) => inventory.getAmount(id) >= amount);
}

function takeMaterials(player, stage) {
  const inventory = player.getInventory();
  for (const [id, amount] of stage.materials) inventory.delete(id, amount);
}

function materialList(stage) {
  return stage.materials.map(([id, amount]) => `${amount} x ${itemName(id)}`).join(", ");
}

function itemName(id) {
  if (id === ItemIdentifiers.OAK_PLANK) return "oak planks";
  if (id === ItemIdentifiers.STEEL_NAILS) return "steel nails";
  if (id === ItemIdentifiers.BOLT_OF_CLOTH) return "bolts of cloth";
  if (id === ItemIdentifiers.SWAMP_TAR) return "swamp tar";
  return `item ${id}`;
}

/** A shipwright's Buy-blueprint: the brig blueprint, for gold. */
function buyBlueprint({ player }) {
  const inventory = player.getInventory();
  if (inventory.getAmount(COINS) < BLUEPRINT_PRICE) {
    player.sendMessage(`The brig blueprint costs ${BLUEPRINT_PRICE} coins.`);
    return;
  }
  inventory.delete(COINS, BLUEPRINT_PRICE);
  inventory.addItem(new Item(BRIG_BLUEPRINT, 1));
  player.sendMessage("You buy a brig blueprint. Take it to a shipwright to build in their drydock.");
}

/** Starts the next drydock stage, consuming its materials and working it over time. */
function startStage(player, dock, stageIndex) {
  const stage = STAGES[stageIndex];
  if (!stage) {
    launchBoat(player, dock);
    return;
  }
  if (!hasMaterials(player, stage)) {
    player.sendMessage(`The ${stage.name} needs: ${materialList(stage)}.`);
    setBuild(player, null);
    return;
  }
  takeMaterials(player, stage);
  setBuild(player, { stage: stageIndex, dock: dock.id });
  player.sendMessage(stage.work);
  TaskManager.submit(new (class extends Task {
    constructor() { super(STAGE_TICKS, player); }
    execute() {
      this.stop();
      finishStage(player, dock, stageIndex);
    }
  })());
}

/** A drydock stage finishes: Construction XP, then the next stage. */
function finishStage(player, dock, stageIndex) {
  const build = buildOf(player);
  if (!build || build.stage !== stageIndex) return; // Logged out or cancelled mid-stage.
  const stage = STAGES[stageIndex];
  player.getSkillManager().addExperience(Skill.CONSTRUCTION, stage.xp, true);
  player.sendMessage(`${stage.done} (+${stage.xp} Construction XP)`);
  startStage(player, dock, stageIndex + 1);
}

/** A shipwright's Build-boat: blueprint + materials + Construction 55 -> a brig. */
function buildBoat({ player, npc }) {
  const dock = npc && dockForNpc(npc);
  if (!dock) return;
  if (buildOf(player)) {
    player.sendMessage("Your brig is already taking shape in the drydock.");
    return;
  }
  if (constructionLevel(player) < BUILD_LEVEL) {
    player.sendMessage(`You need a Construction level of ${BUILD_LEVEL} to build a brig.`);
    return;
  }
  if (player.getInventory().getAmount(BRIG_BLUEPRINT) <= 0) {
    player.sendMessage("You need a brig blueprint to build here. The shipwright sells them.");
    return;
  }
  if (player.getSailing().boats.length >= 5) {
    player.sendMessage("You have no free boat berths. Recover or dispose of a boat first.");
    return;
  }
  player.sendMessage("The shipwright unrolls your blueprint and the drydock crew gets to work.");
  startStage(player, dock, 0);
}

/** Picks a name for the new brig: six random three-word names, or roll new ones. */
function pickName(player, dock, paint) {
  const names = Array.from({ length: 6 }, () => randomBoatName());
  const options = names.flatMap((name) => [
    `"${boatName({ name })}"`,
    () => launchWithName(player, dock, name, paint),
  ]);
  options.push("New names", () => pickName(player, dock, paint));
  pluginApi.sendMultiChatboxPrompt(player, "Name your brig:", ...options);
}

/** Picks the hull paint, then names her. */
function pickPaint(player, dock) {
  pluginApi.sendMultiChatboxPrompt(
    player,
    "Paint her hull:",
    ...PAINTS.flatMap((paint) => [paint, () => pickName(player, dock, paint)]),
  );
}

/** Launch: consume the blueprint, moor the brig, name her, paint her. */
function launchWithName(player, dock, name, paint) {
  player.getInventory().delete(BRIG_BLUEPRINT, 1);
  const boat = Sailing.giveBoat(player, "brig", dock.id, name);
  if (!boat) {
    player.getInventory().addItem(new Item(BRIG_BLUEPRINT, 1));
    player.sendMessage("There is no room to moor her; the blueprint is returned.");
    return;
  }
  boat.paint = paint;
  setBuild(player, null);
  player.getSkillManager().addExperience(Skill.SAILING, LAUNCH_XP, true);
  player.sendMessage(`The ${boatName(boat)} slides down the ways, ${paint.toLowerCase()} hull gleaming. (+${LAUNCH_XP} Sailing XP)`);
}

/** All three stages done: choose paint, then a name, then she launches. */
function launchBoat(player, dock) {
  pickPaint(player, dock);
}

function forgetBuild({ player }) {
  if (buildOf(player)) setBuild(player, null);
}

module.exports = {
  name: "SailingConstruction",
  members: true,
  BUILD_ATTRIBUTE,
  BRIG_BLUEPRINT,
  BUILD_LEVEL,
  STAGES,
  PAINTS,
  register(api) {
    pluginApi = api;
    content();
    const { docks } = content();
    for (const shipwright of new Set(docks.map((dock) => dock.shipwright).filter(Boolean))) {
      api.onNpcInteraction(shipwright, {
        "Buy-blueprint": buyBlueprint,
        "Build-boat": buildBoat,
      });
    }
    api.onPlayerLogout(forgetBuild);
  },
};
