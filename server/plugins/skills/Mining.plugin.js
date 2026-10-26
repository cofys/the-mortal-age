const { Skill } = require("../../src/main/typescript/elvarg/game/model/Skill");
const { Equipment } = require("../../src/main/typescript/elvarg/game/model/container/impl/Equipment");
const { Animation } = require("../../src/main/typescript/elvarg/game/model/Animation");
const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const { MapObjects } = require("../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
const { GameObject } = require("../../src/main/typescript/elvarg/game/entity/impl/object/GameObject");
const { ItemIds, ObjectIds } = require("../../src/main/typescript/elvarg/util/IdEnums");
const InfernalPickaxe = require("./mining/InfernalPickaxe.Mining");
const CrystalPickaxe = require("./mining/CrystalPickaxe.Mining");
const Mines = require("./mining/Mines.Mining");
const Hazards = require("./mining/Hazards.Mining");
const Wilderness = require("./mining/Wilderness.Mining");
const Mastery = require("./mining/Mastery.Mining");
const Supply = require("./mining/Supply.Mining");
const ClueGeodes = require("./mining/ClueGeodes.Mining");
const { pauseForLevelUp } = require("./SkillActions");

// rsprox recordings: a mined-out rock becomes "rocks1"/"rocks2" (the digit of the rock's own gameval,
// copperrock2 -> rocks2) and the miner is sent a respawn timer by the cache's add_overlaytimer_loc.
const DEPLETED_ROCK_NAME = "rocks";
const DEFAULT_DEPLETED_ROCK = `${DEPLETED_ROCK_NAME}1`;
const ROCK_VARIANT_PATTERN = /rock_?(\d)$/;
const RESPAWN_TIMER_SCRIPT = 5474; // add_overlaytimer_loc: coord, loc, shape, timer id, ticks, colour, 0
const RESPAWN_TIMER_ID = 1;
const RESPAWN_TIMER_COLOUR = 16765184;
const SCENERY_SHAPE = 10;
const NO_ORE_MESSAGE = "There is currently no ore available in this rock.";
const SWING_MESSAGE = "You swing your pick at the rock.";
const NO_PICKAXE_MESSAGE = "You need a pickaxe to mine this rock. You do not have a pickaxe which you have the Mining level to use.";
const MINING_SUCCESS_SOUND = 3600;
const SMELT_SOUND = 2725;
const SMOKEPUFF_GRAPHIC = 86;
const SMOKEPUFF_HEIGHT = 150;
const ORE_MINED_VARP = "tracking_ore_mined";
const ORE_MINED_ATTRIBUTE = "mining:ores-mined";
const MINING_ANIMATION_INTERVAL_TICKS = 4;
let miningTick = 0;

const PICKAXES = [
  { id: ItemIds.BRONZE_PICKAXE, requiredLevel: 1, speed: 0.03, attemptIntervalTicks: 8, animation: new Animation(625) },
  { id: ItemIds.IRON_PICKAXE, requiredLevel: 1, speed: 0.05, attemptIntervalTicks: 7, animation: new Animation(626) },
  { id: ItemIds.STEEL_PICKAXE, requiredLevel: 6, speed: 0.09, attemptIntervalTicks: 6, animation: new Animation(627) },
  { id: ItemIds.BLACK_PICKAXE, requiredLevel: 11, speed: 0.11, attemptIntervalTicks: 5, animation: new Animation(3873) },
  { id: ItemIds.MITHRIL_PICKAXE, requiredLevel: 21, speed: 0.13, attemptIntervalTicks: 5, animation: new Animation(629) },
  { id: ItemIds.ADAMANT_PICKAXE, requiredLevel: 31, speed: 0.16, attemptIntervalTicks: 4, animation: new Animation(628) },
  { id: ItemIds.RUNE_PICKAXE, requiredLevel: 41, speed: 0.2, attemptIntervalTicks: 3, animation: new Animation(624) },
  { id: ItemIds.DRAGON_PICKAXE, requiredLevel: 61, speed: 0.25, attemptIntervalTicks: 3, animation: new Animation(7139) },
  { id: ItemIds.CRYSTAL_PICKAXE, requiredLevel: 71, speed: 0.25, attemptIntervalTicks: 3, animation: new Animation(8347) },
  { id: ItemIds.INFERNAL_PICKAXE, requiredLevel: 61, speed: 0.25, attemptIntervalTicks: 3, animation: new Animation(4482) },
];

const PICKAXES_DESC = [...PICKAXES].sort((a, b) => b.requiredLevel - a.requiredLevel);

const ROCKS = [
  { objectName: "Clay rocks", objectIds: [9711, 9712, 9713, 15503, 15504, 15505], level: 1, xp: 5, oreId: ItemIds.CLAY, petBase: 741600, cycles: 11, respawnTicks: 2 },
  { objectName: "Copper rocks", objectIds: [7453,7484], level: 1, xp: 17.5, oreId: ItemIds.COPPER_ORE, petBase: 741600, cycles: 12, respawnTicks: 4 },
  { objectName: "Tin rocks", objectIds: [7485, 7486], level: 1, xp: 17.5, oreId: ItemIds.TIN_ORE, petBase: 741600, cycles: 12, respawnTicks: 4 },
  { objectName: "Blurite rocks", objectIds: [ObjectIds.BLURITE_ROCKS, ObjectIds.BLURITE_ROCKS_2], level: 10, xp: 17.5, oreId: ItemIds.BLURITE_ORE, successLow: 90, successHigh: 350, respawnTicks: 42 },
  { objectName: "Iron rocks", objectIds: [7455, 7488], level: 15, xp: 35, oreId: ItemIds.IRON_ORE, petBase: 741600, cycles: 13, respawnTicks: 9 },
  // Wiki Rocks (Barronite): level 14, 1-minute respawn; each success is 76% shards (4-6, 16xp)
  // or 24% deposit (1, 32xp). Success chart 0.328125 at level 14 -> 0.394531 at 99 (/256: 84 at level 14, 101 at level 99).
  {
    objectName: "Barronite rocks",
    objectIds: [41547, 41548, 41549, 41550],
    level: 14, xp: 32, oreId: ItemIds.BARRONITE_DEPOSIT,
    successLow: 82, successHigh: 101, respawnTicks: 100,
    outcomes: [
      { itemId: ItemIds.BARRONITE_SHARDS, min: 4, max: 6, weight: 76, xp: 16, message: "You manage to mine some barronite shards." },
      { itemId: ItemIds.BARRONITE_DEPOSIT, min: 1, max: 1, weight: 24, xp: 32, message: "You manage to mine a barronite deposit." },
    ],
  },
  // Wiki Sandstone rocks / Granite rocks: one piece per success, then the rock is "rocks1" for 9 ticks
  // (5.4 s; recorded add_overlaytimer_loc 9). The chance of any piece (56.5% at 35 -> 92.7% at 99 for
  // sandstone, 42.0% at 45 -> 68.2% at 99 for granite) is extended to level 1 on the 256 roll, and each
  // size's share of a success moves from the Wiki's chart at the rock's level to its chart at 99.
  // Recorded (232/03162): "You manage to quarry some sandstone."
  {
    objectName: "Sandstone rocks",
    objectIds: [11386],
    level: 35, xp: 30, oreId: 6971, petBase: 741600, // Wiki (Rock golem, Clue geode)
    successLow: 95, successHigh: 237, respawnTicks: 9,
    outcomes: [
      { itemId: 6971, min: 1, max: 1, weight: 39.6, weightHigh: 28.9, xp: 30, message: "You manage to quarry some sandstone." },
      { itemId: 6973, min: 1, max: 1, weight: 25.5, weightHigh: 24.0, xp: 40, message: "You manage to quarry some sandstone." },
      { itemId: 6975, min: 1, max: 1, weight: 20.3, weightHigh: 25.6, xp: 50, message: "You manage to quarry some sandstone." },
      { itemId: 6977, min: 1, max: 1, weight: 14.5, weightHigh: 21.5, xp: 60, message: "You manage to quarry some sandstone." },
    ],
  },
  {
    objectName: "Granite rocks",
    objectIds: [11387],
    depletedRock: "rocks2", // recorded (227/01757, 234/03285)
    level: 45, xp: 50, oreId: 6979, petBase: 741600,
    successLow: 53, successHigh: 175, respawnTicks: 9,
    outcomes: [
      { itemId: 6979, min: 1, max: 1, weight: 37.8, weightHigh: 30.4, xp: 50, message: "You manage to quarry some granite." },
      { itemId: 6981, min: 1, max: 1, weight: 31.6, weightHigh: 32.5, xp: 60, message: "You manage to quarry some granite." },
      { itemId: 6983, min: 1, max: 1, weight: 30.7, weightHigh: 37.2, xp: 75, message: "You manage to quarry some granite." },
    ],
  },
  { objectName: "Silver rocks", objectIds: [7457], level: 20, xp: 40, oreId: ItemIds.SILVER_ORE, petBase: 741600, cycles: 14, respawnTicks: 100 },
  { objectName: "Coal rocks", objectIds: [7456], level: 30, xp: 50, oreId: ItemIds.COAL, petBase: 290640, cycles: 15, respawnTicks: 50 },
  { objectName: "Gold rocks", objectIds: [7491, 9720, 9721, 9722, 11951, 11183, 11184, 11185, 2099, ObjectIds.GOLD_ROCKS_2], level: 40, xp: 65, oreId: ItemIds.GOLD_ORE, petBase: 296640, cycles: 15, respawnTicks: 100 },
  { objectName: "Mithril rocks", objectIds: [7492, 7459], level: 55, xp: 80, oreId: ItemIds.MITHRIL_ORE, petBase: 148320, cycles: 17, respawnTicks: 200 },
  { objectName: "Adamantite rocks", objectIds: [7460], level: 70, xp: 95, oreId: ItemIds.ADAMANTITE_ORE, petBase: 59328, cycles: 18, respawnTicks: 400 },
  { objectName: "Runite rocks", objectIds: [14859, 4860, 2106, 2107, 7461], level: 85, xp: 125, oreId: ItemIds.RUNITE_ORE, petBase: 42377, cycles: 23, respawnTicks: 1200 },
  { objectName: "Amethyst crystals", objectIds: [ObjectIds.AMETHYST_CRYSTALS, ObjectIds.AMETHYST_CRYSTALS_2], level: 92, xp: 240, oreId: ItemIds.AMETHYST, petBase: 42377, cycles: 20, respawnTicks: 60 },
];

// The essence mine rocks are infinite and have no level requirement.
const ESSENCE_ROCKS = [
  { objectName: "Rune Essence", objectIds: [ObjectIds.RUNE_ESSENCE_3], level: 1, xp: 5, oreId: ItemIds.PURE_ESSENCE, cycles: 1, respawnTicks: 0, infinite: true, oreMessage: "You get some essence." },
  { objectName: "Rune essence", objectIds: [ObjectIds.RUNE_ESSENCE, ObjectIds.RUNE_ESSENCE_2], level: 1, xp: 5, oreId: ItemIds.PURE_ESSENCE, cycles: 1, respawnTicks: 0, infinite: true, oreMessage: "You get some essence." },
];

const ALL_ROCKS = [...ROCKS, ...ESSENCE_ROCKS];

const ROCK_BY_NAME = new Map(ALL_ROCKS.map((rock) => [rock.objectName, rock]));
let activeSessions;
const ACTIVE_MINERS = new Set();

class RockRespawnTask extends Task {
  constructor(delayTicks, originalRockObject, depletedObject) {
    super(Math.max(1, delayTicks));
    this.originalRockObject = originalRockObject;
    this.depletedObject = depletedObject;
  }

  execute() {
    const existingDepleted = MapObjects.get(
      this.depletedObject.getId(),
      this.depletedObject.getLocation(),
      this.depletedObject.getPrivateArea()
    );
    if (existingDepleted) {
      ObjectManager.deregister(existingDepleted, true);
    }
    ObjectManager.register(this.originalRockObject, true);
    this.stop();
  }
}

function getMiningLevel(player) {
  return player.getSkillManager().getCurrentLevel(Skill.MINING);
}

/**
 * The level the success rolls use: the visible level plus invisible boosts other plugins add
 * ("mining:level-boost", the celestial ring's +4). Requirements still read the visible level.
 */
function getRollMiningLevel(player) {
  const request = { player, boost: 0 };
  pluginApi.emitCustomEvent("mining:level-boost", request);
  return getMiningLevel(player) + Math.max(0, Number(request.boost) || 0);
}

/** "mining:best-pickaxe": the best pickaxe the player can use, for other mining content (stars). */
function answerBestPickaxe(request) {
  if (request && request.player && request.pickaxe == null) {
    request.pickaxe = findBestPickaxe(request.player);
  }
}

function findBestPickaxe(player) {
  const miningLevel = getMiningLevel(player);
  const weapon = player.getEquipment().getItems()[Equipment.WEAPON_SLOT];
  const weaponId = weapon ? weapon.getId() : -1;

  for (const pickaxe of PICKAXES_DESC) {
    if (miningLevel < pickaxe.requiredLevel) {
      continue;
    }
    if (weaponId === pickaxe.id || player.getInventory().contains(pickaxe.id)) {
      return pickaxe;
    }
  }
  return null;
}

function cyclesRequired(player, rock, pickaxe) {
  if (rock.successLow !== undefined) return 1;
  let cycles = rock.cycles + Math.floor(Math.random() * 5);
  cycles -= getRollMiningLevel(player) * 0.1;
  cycles -= cycles * pickaxe.speed;
  const tickBudget = Math.max(3, Math.floor(cycles));
  return Math.max(1, Math.ceil(tickBudget / pickaxe.attemptIntervalTicks));
}

function stopMining(activeSessions, player, resetAnim = true) {
  if (!activeSessions.has(player)) {
    return;
  }
  activeSessions.delete(player);
  ACTIVE_MINERS.delete(player);
  if (resetAnim) {
    player.performAnimation(Animation.DEFAULT_RESET_ANIMATION);
  }
}

/**
 * Mining depth seam (./mining/MINING-DEPTH.md): every ore yield emits
 * "mining:ore-yield" before the ore is awarded. Listeners add bonusOre (rich
 * veins, prime strikes) or scale the XP via multiplier; both are honored here.
 * "mining:success" carries stop:false - a listener (cave-ins) may set
 * event.stop to end the session after this yield. Returns what the yield
 * granted, for tests. Additive only.
 */
function awardOre(player, state) {
  // Upstream outcome rocks (Barronite): the yield is a weighted outcome, not
  // the rock's oreId. Rolled before any listener emit so the random sequence
  // stays upstream's: success roll -> outcome roll -> amount roll.
  const outcome = state.rock.outcomes ? rollOutcome(state.rock, getRollMiningLevel(player)) : null;
  const oreId = outcome?.itemId ?? state.rock.oreId;
  const amount = outcome ? outcomeAmount(outcome) : 1;
  const event = {
    player,
    rock: state.rock,
    pickaxe: state.pickaxe,
    outcome,
    oreId,
    multiplier: 1,
    bonusOre: 0,
    location: {
      x: state.location.getX(),
      y: state.location.getY(),
      z: state.location.getZ(),
    },
  };
  pluginApi.emitCustomEvent("mining:ore-yield", event);
  const bonusOre = Math.max(0, Math.floor(event.bonusOre));
  const xpMultiplier = event.multiplier > 0 ? event.multiplier : 0;

  if (InfernalPickaxe.tryCombustOre(player, state.pickaxe.id, oreId)) {
    player.performGraphic(new pluginApi.core.Graphic(SMOKEPUFF_GRAPHIC, 0, SMOKEPUFF_HEIGHT));
    player.getPacketSender().sendSoundEffect(SMELT_SOUND, 1, 0, 1);
  } else {
    // An open container takes the ore first ("storage:gather", the coal bag
    // included — upstream #656 replaced the old "mining:ore" coal-bag event).
    giveOre(player, oreId, amount + bonusOre);
    countOre(player, state.rock);
    if (bonusOre > 0) {
      player.sendMessage(`A rich seam — ${bonusOre} extra ore!`);
    }
  }
  if (!state.rock.infinite) {
    player.getPacketSender().sendSoundEffect(MINING_SUCCESS_SOUND, 1, 0, 1);
  }
  player.sendMessage(outcome?.message ?? state.rock.oreMessage ?? oreMessage(state.rock));
  CrystalPickaxe.tryUseCharge(player);
  const xpGranted = (outcome?.xp ?? state.rock.xp) * xpMultiplier;
  player.getSkillManager().addExperiences(Skill.MINING, xpGranted);
  const success = {
    player,
    skill: Skill.MINING,
    petBase: state.rock.petBase,
    oreId,
    itemId: oreId,
    outcome,
    rockName: state.rock.objectName,
    bonusOre,
    xp: xpGranted,
    location: event.location,
    stop: false,
  };
  pluginApi.emitCustomEvent("mining:success", success);
  if (!outcome) grantExtraOre(player, state);
  return { bonusOre, xpMultiplier, outcome, stop: success.stop === true };
}

/**
 * "mining:extra-ore": a mining enhancer (the charged celestial ring) may grant a second ore with
 * its experience. Without room for it, neither is given (Wiki, Mod Ash).
 * (Upstream semantics preserved through our awardOre path.)
 */
function grantExtraOre(player, state) {
  const rock = state.rock;
  if (rock.infinite) {
    return;
  }
  const request = { player, oreId: rock.oreId, rockLevel: rock.level, extra: false };
  pluginApi.emitCustomEvent("mining:extra-ore", request);
  if (!request.extra || inventoryBlocks(player, rock.oreId)) {
    return;
  }
  giveOre(player, rock.oreId, 1);
  player.getSkillManager().addExperiences(Skill.MINING, rock.xp);
}


/** The mined-out loc for a rock: its own (granite's rocks2), else "rocks" plus the digit its gameval ends in (copperrock2 -> rocks2). */
function depletedRockId(rockId, rock) {
  const { CacheDefinitions } = pluginApi.core;
  if (rock?.depletedRock) return CacheDefinitions.getLocId(rock.depletedRock);
  const variant = ROCK_VARIANT_PATTERN.exec(CacheDefinitions.getLocNames().get(rockId) ?? "")?.[1];
  return CacheDefinitions.getLocId(variant ? `${DEPLETED_ROCK_NAME}${variant}` : DEFAULT_DEPLETED_ROCK);
}

/** The respawn timer the client draws over a depleted rock (cache script add_overlaytimer_loc). */
function sendRespawnTimer(player, depleted, ticks) {
  const location = depleted.getLocation();
  const coordinate = (location.getZ() << 28) | (location.getX() << 14) | location.getY();
  player
    .getPacketSender()
    .sendClientScript(RESPAWN_TIMER_SCRIPT, coordinate, depleted.getId(), SCENERY_SHAPE, RESPAWN_TIMER_ID, ticks, RESPAWN_TIMER_COLOUR, 0);
}

function depleteRock(player, rockObject, rock) {
  const depleted = new GameObject(
    depletedRockId(rockObject.getId(), rock),
    rockObject.getLocation().clone(),
    rockObject.getType(),
    rockObject.getFace(),
    rockObject.getPrivateArea()
  );
  ObjectManager.deregister(rockObject, true);
  ObjectManager.register(depleted, true);
  TaskManager.submit(new RockRespawnTask(rock.respawnTicks, rockObject, depleted));
  sendRespawnTimer(player, depleted, rock.respawnTicks);
}

/** Failures are message boxes in live OSRS (rsprox recordings). */
function messageBox(player, text) {
  const { DialogueChainBuilder, StatementDialogue } = pluginApi.core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, text)));
}

function inventoryFull(player, oreId) {
  const name = pluginApi.core.CacheDefinitions.getItem(oreId).name.toLowerCase();
  messageBox(player, `Your inventory is too full to hold any more ${name}.`);
}

/** "You manage to mine some iron." - the first word of the rock's name, as recorded for each ore. */
function oreMessage(rock) {
  return `You manage to mine some ${rock.objectName.split(" ")[0].toLowerCase()}.`;
}

function startMining(player, rockObject, rock, activeSessions) {
  const pickaxe = findBestPickaxe(player);
  if (!pickaxe) {
    messageBox(player, NO_PICKAXE_MESSAGE);
    return false;
  }

  const miningLevel = getMiningLevel(player);
  if (miningLevel < rock.level) {
    messageBox(player, `You need a Mining level of ${rock.level} to mine this rock.`);
    return false;
  }
  if (inventoryBlocks(player, rock.oreId)) {
    inventoryFull(player, rock.oreId);
    return false;
  }

  stopMining(activeSessions, player, false);
  activeSessions.set(player, {
    rock,
    pickaxe,
    objectId: rockObject.getId(),
    location: rockObject.getLocation().clone(),
    privateArea: rockObject.getPrivateArea(),
    cyclesUntilOre: cyclesRequired(player, rock, pickaxe),
    swingTick: miningTick + 1,
    nextAnimationTick: miningTick + 1 + MINING_ANIMATION_INTERVAL_TICKS,
    nextOreAttemptTick: miningTick + pickaxe.attemptIntervalTicks,
    attemptIntervalTicks: pickaxe.attemptIntervalTicks,
  });
  ACTIVE_MINERS.add(player);
  return true;
}

/** The first swing lands the tick after the click (rsprox recordings: message and animation at +1). */
function swing(player, state) {
  state.swingTick = undefined;
  player.sendMessage(SWING_MESSAGE);
  player.performAnimation(state.pickaxe.animation);
}

/** An outcome's weight at this level: `weight` at the rock's level, moving to `weightHigh` (if any) at 99. */
function outcomeWeight(outcome, rock, level) {
  if (outcome.weightHigh === undefined || rock.level >= 99) return outcome.weight;
  const progress = Math.max(0, Math.min(1, (level - rock.level) / (99 - rock.level)));
  return outcome.weight + (outcome.weightHigh - outcome.weight) * progress;
}

function rollOutcome(rock, level) {
  const { outcomes } = rock;
  const weights = outcomes.map((outcome) => outcomeWeight(outcome, rock, level));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < outcomes.length; i++) {
    roll -= weights[i];
    if (roll < 0) return outcomes[i];
  }
  return outcomes[outcomes.length - 1];
}

function outcomeAmount(outcome) {
  return outcome.min + Math.floor(Math.random() * (outcome.max - outcome.min + 1));
}

class MiningTask extends Task {
  constructor(activeSessions) {
    super(1);
    this.activeSessions = activeSessions;
    this.cycle = 0;
  }

  execute() {
    this.cycle++;
    miningTick = this.cycle;
    for (const [player, state] of this.activeSessions) {
      if (!player || !player.isRegistered() || player.getHitpoints() <= 0) {
        this.activeSessions.delete(player);
        continue;
      }
      if (player.getMovementQueue().size() > 0 || player.getForceMovement() != null) {
        stopMining(this.activeSessions, player);
        continue;
      }
      if (state.levelUpPaused) continue;

      const rockObject = MapObjects.get(
        state.objectId,
        state.location,
        state.privateArea
      );
      if (!rockObject) {
        stopMining(this.activeSessions, player);
        continue;
      }

      if (!player.getLocation().isWithinInteractionDistance(rockObject.getLocation())) {
        stopMining(this.activeSessions, player);
        continue;
      }

      const pickaxe = findBestPickaxe(player);
      if (!pickaxe || getMiningLevel(player) < state.rock.level) {
        stopMining(this.activeSessions, player);
        continue;
      }

      state.pickaxe = pickaxe;
      state.attemptIntervalTicks = pickaxe.attemptIntervalTicks;

      if (inventoryBlocks(player, state.rock.oreId)) {
        inventoryFull(player, state.rock.oreId);
        stopMining(this.activeSessions, player);
        continue;
      }

      if (state.swingTick !== undefined && this.cycle >= state.swingTick) {
        swing(player, state);
      }
      if (this.cycle >= state.nextAnimationTick) {
        player.performAnimation(state.pickaxe.animation);
        state.nextAnimationTick = this.cycle + MINING_ANIMATION_INTERVAL_TICKS;
      }

      if (this.cycle < state.nextOreAttemptTick) {
        continue;
      }
      state.nextOreAttemptTick = this.cycle + state.attemptIntervalTicks;

      if (state.rock.successLow !== undefined) {
        // Wiki skilling success chart interpolates level 1/99 values on a 256-sided roll.
        const level = Math.max(1, Math.min(99, getRollMiningLevel(player)));
        const chance = Math.floor(state.rock.successLow + (state.rock.successHigh - state.rock.successLow) * (level - 1) / 98);
        if (Math.floor(Math.random() * 256) >= chance) continue;
      } else {
        state.cyclesUntilOre--;
        if (state.cyclesUntilOre > 0) continue;
      }

      const result = awardOre(player, state);
      if (result.stop) {
        stopMining(this.activeSessions, player);
        continue;
      }
      if (state.rock.infinite) {
        if (inventoryBlocks(player, state.rock.oreId)) {
          inventoryFull(player, state.rock.oreId);
          stopMining(this.activeSessions, player);
          continue;
        }
        state.cyclesUntilOre = cyclesRequired(player, state.rock, pickaxe);
        continue;
      }
      depleteRock(player, rockObject, state.rock);
      stopMining(this.activeSessions, player);
    }
  }
}

let TaskManager;
let ObjectManager;
let pluginApi;

/** A full inventory stops mining unless an open container (the coal bag) has room for the ore ("storage:room"). */
function inventoryBlocks(player, oreId) {
  if (!player.getInventory().isFull()) {
    return false;
  }
  const request = { player, itemId: oreId, room: false };
  pluginApi.emitCustomEvent("storage:room", request);
  return !request.room;
}

/** An open container takes the ore first ("storage:gather"); the rest goes to the inventory. */
function giveOre(player, oreId, amount) {
  const request = { player, itemId: oreId, amount, stored: 0 };
  pluginApi.emitCustomEvent("storage:gather", request);
  if (amount > request.stored) {
    player.getInventory().adds(oreId, amount - request.stored);
  }
}

/**
 * "mining:extra-ore": a mining enhancer (the charged celestial ring) may grant a second ore with
 * its experience. Without room for it, neither is given (Wiki, Mod Ash).
 */
function mineExtraOre(player, rock) {
  if (rock.infinite) {
    return;
  }
  const request = { player, oreId: rock.oreId, rockLevel: rock.level, extra: false };
  pluginApi.emitCustomEvent("mining:extra-ore", request);
  if (!request.extra || inventoryBlocks(player, rock.oreId)) {
    return;
  }
  giveOre(player, rock.oreId, 1);
  player.getSkillManager().addExperiences(Skill.MINING, rock.xp);
}

/** tracking_ore_mined counts every ore a rock gives (not essence); the client reads it for the Mining tab. */
function countOre(player, rock) {
  if (rock.infinite) {
    return;
  }
  const mined = (player.getAttribute(ORE_MINED_ATTRIBUTE) ?? 0) + 1;
  player.setAttribute(ORE_MINED_ATTRIBUTE, mined);
  player.getPacketSender().sendConfig(pluginApi.core.CacheDefinitions.getVarpId(ORE_MINED_VARP), mined);
}

function sendOresMined({ player }) {
  const mined = player.getAttribute(ORE_MINED_ATTRIBUTE);
  if (mined > 0) {
    player.getPacketSender().sendConfig(pluginApi.core.CacheDefinitions.getVarpId(ORE_MINED_VARP), mined);
  }
}

/** A depleted rock ("rocks1"/"rocks2") still offers Mine; it only says it is empty. */
function mineDepletedRock(event) {
  const { CacheDefinitions } = pluginApi.core;
  const depleted = [`${DEPLETED_ROCK_NAME}1`, `${DEPLETED_ROCK_NAME}2`].map((name) => CacheDefinitions.getLocId(name));
  if (!depleted.includes(event.object.getId())) {
    return;
  }
  event.player.sendMessage(NO_ORE_MESSAGE);
  event.handled = true;
}


function handleMine(event) {
  const rock = ROCK_BY_NAME.get(event.definition.getName());
  if (!rock) {
    return;
  }

  const started = startMining(event.player, event.object, rock, activeSessions);
  if (started) {
    event.handled = true;
  }
}

function pauseMining(event) {
  pauseForLevelUp(event, activeSessions, (player) => stopMining(activeSessions, player, false));
}

module.exports = {
  name: "Mining",
  PICKAXES,
  PICKAXES_DESC,
  ROCKS,
  findBestPickaxe,
  rollOutcome,
  isMiningActive(player) {
    return ACTIVE_MINERS.has(player);
  },
  awardOre,
  register(api) {
    pluginApi = api;
    TaskManager = api.getTaskManager();
    ObjectManager = api.getObjectManager();
    activeSessions = new Map();
    TaskManager.submit(new MiningTask(activeSessions));

    api.onPlayerDisconnect(({ player }) => {
      stopMining(activeSessions, player, false);
    });
    api.onCustomEvent("level-up:popup-opened", pauseMining);
    api.onCustomEvent("mining:best-pickaxe", answerBestPickaxe);
    api.persistAttribute(ORE_MINED_ATTRIBUTE, 0);
    api.onPlayerLogin(sendOresMined);
    api.onObjectInteraction("Rocks", { Mine: mineDepletedRock });

    for (const rock of ALL_ROCKS) {
      api.onObjectInteraction(rock.objectName, { Mine: handleMine });
    }

    InfernalPickaxe.attach(api);
    CrystalPickaxe.attach(api);
    // Mining depth (./mining/MINING-DEPTH.md): attach order is listener order -
    // Mines stamps event.mine/event.vein, then Hazards/Wilderness/Mastery/Supply.
    Mines.attach(api);
    Hazards.attach(api);
    Wilderness.attach(api);
    Mastery.attach(api);
    Supply.attach(api);
    // Upstream clue-geode drops (read-only mining:success listener).
    ClueGeodes.attach(api);

    api.log("registered", {
      rocks: ROCKS.length,
      essenceRocks: ESSENCE_ROCKS.length,
      pickaxes: PICKAXES.length,
    });
  },
};
