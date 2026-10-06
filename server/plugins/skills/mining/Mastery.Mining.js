/**
 * Mining mastery: what high-level miners get beyond XP.
 *
 * Quality grades - every load is graded by the miner's level: flawed ore at
 * low level, and from 50+ the chance of clean stone. Pure loads pay bonus XP;
 * pristine loads often yield a second ore alongside; perfect loads (90+, rare)
 * are the stories miners tell - bonus XP, extra ore, and real standing with
 * the guild. Better ore means better steel for the war effort, not just a
 * bigger number.
 *
 * Guild reputation - the Mining Guild keeps score. Fine loads, cave-ins
 * survived, wilderness primes and rich veins earn it; at 50 the guild names
 * you Prospector, at 200 Master Prospector, at 500 Legendary Prospector. Rank
 * has teeth: Masters read the rock and never get caught by cave-ins or gas,
 * and rank opens the old miners' hidden delves - the deep workings under the
 * Dwarven Mine that yield better for proven hands. No commands, no menus: the
 * rock just knows you.
 *
 * Attaches after Mines/Hazards/Wilderness: it reads the flags the earlier
 * modules set on "mining:success" (event.mine, event.vein, event.wilderness,
 * event.prime) and the mine on "mining:ore-yield".
 */
const REP_ATTRIBUTE = "mining:guild-reputation";

const TIERS = Object.freeze([
  { rep: 500, name: "Legendary Prospector" },
  { rep: 200, name: "Master Prospector" },
  { rep: 50, name: "Prospector" },
]);

const CAVE_IN_IMMUNE_REP = 200;

// The old miners' mark: the deep workings under the Dwarven Mine (same rect
// as Hazards.Mining's DEEP_WORKINGS), which yield better for miners the guild
// vouches for.
const HIDDEN_DELVE = Object.freeze({ x1: 3005, x2: 3025, y1: 9855, y2: 9885, z: 0 });

let api = null;
let core = null;

function getRep(player) {
  return Number(player.getAttribute(REP_ATTRIBUTE)) || 0;
}

function tierFor(rep) {
  return TIERS.find((tier) => rep >= tier.rep) ?? null;
}

function getTier(player) {
  return tierFor(getRep(player));
}

/** Cave-ins and gas stop being a risk once the guild calls you Master Prospector. */
function isCaveInImmune(player) {
  return getRep(player) >= CAVE_IN_IMMUNE_REP;
}

function addRep(player, amount, reason) {
  if (!(amount > 0)) return;
  const before = tierFor(getRep(player));
  const rep = getRep(player) + amount;
  player.setAttribute(REP_ATTRIBUTE, rep);
  const after = tierFor(rep);
  if (after && after !== before) {
    player.sendMessage(`The Mining Guild names you ${after.name}! (${rep} reputation)`);
    api.log("guild tier", { player: player.getUsername?.(), tier: after.name, reason });
  }
}

function inHiddenDelve(location) {
  if (!location) return false;
  return location.z === HIDDEN_DELVE.z &&
    location.x >= HIDDEN_DELVE.x1 && location.x <= HIDDEN_DELVE.x2 &&
    location.y >= HIDDEN_DELVE.y1 && location.y <= HIDDEN_DELVE.y2;
}

/** Hidden delves: bonus-ore chance scales with guild standing. */
function hiddenDelveBonusChance(player) {
  const rep = getRep(player);
  if (rep >= 500) return 0.5;
  if (rep >= 200) return 0.35;
  if (rep >= 50) return 0.15;
  return 0;
}

function onOreYield(event) {
  if (!(event.multiplier > 0)) return;
  if (!inHiddenDelve(event.location)) return;
  if (Math.random() < hiddenDelveBonusChance(event.player)) {
    event.bonusOre += 1;
  }
}

/** Grades one load. Returns the grade; null when the event carries no ore. */
function gradeOre(player, random = Math.random) {
  const level = player.getSkillManager().getMaxLevel(core.Skill.MINING);
  const roll = random();
  if (level >= 90 && roll < 0.01) return "perfect";
  if (level >= 75 && roll < 0.05) return "pristine";
  if (level >= 50 && roll < 0.25) return "pure";
  if (level < 20 && roll < 0.25) return "flawed";
  return "standard";
}

function grantBonusOre(player, oreId, amount) {
  const free = player.getInventory().getFreeSlots();
  const granted = Math.min(amount, Math.max(0, free));
  if (granted > 0) {
    player.getInventory().addItem(new core.Item(oreId, granted));
  }
  return granted;
}

function onSuccess(event) {
  const { player, oreId, xp } = event;
  if (oreId == null || xp == null) return;

  // Reputation from how and where the load was mined (flags set by the earlier modules).
  if (event.vein) addRep(player, 2, "rich-vein");
  if (event.wilderness) addRep(player, 1, "wilderness");
  if (event.prime) addRep(player, 2, "prime");
  if (event.survivedCaveIn) addRep(player, 1, "cave-in");

  const grade = gradeOre(player);
  const addXp = (fraction) => player.getSkillManager().addExperiences(core.Skill.MINING, xp * fraction);

  switch (grade) {
    case "flawed":
      player.sendMessage("Flawed ore - the furnace will take it, grudgingly.");
      break;
    case "pure":
      addXp(0.25);
      addRep(player, 1, "pure");
      player.sendMessage("A pure load!");
      break;
    case "pristine": {
      addXp(0.5);
      addRep(player, 3, "pristine");
      const extra = grantBonusOre(player, oreId, 1);
      player.sendMessage(
        extra > 0
          ? "Pristine ore! It splits clean - a second load with it."
          : "Pristine ore! A miner's load.",
      );
      break;
    }
    case "perfect": {
      addXp(1);
      addRep(player, 10, "perfect");
      const extra = grantBonusOre(player, oreId, 2);
      player.sendMessage("PERFECT ORE! Stone the old masters dreamed of!");
      if (extra > 0) {
        player.sendMessage("The guild will hear of this one.");
      }
      break;
    }
    default:
      break;
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.persistAttribute(REP_ATTRIBUTE);
  api.onCustomEvent("mining:ore-yield", onOreYield);
  api.onCustomEvent("mining:success", onSuccess);
  api.log("registered", { hiddenDelve: HIDDEN_DELVE });
}

module.exports = {
  attach, getRep, addRep, getTier, tierFor, isCaveInImmune, gradeOre,
  hiddenDelveBonusChance, inHiddenDelve,
  REP_ATTRIBUTE, TIERS, HIDDEN_DELVE,
  _test: { onOreYield, onSuccess },
};
