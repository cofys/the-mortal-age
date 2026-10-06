/**
 * Fishing mastery: what high-level fishers get beyond XP.
 *
 * Quality grades - every catch is graded by the fisher's level: small catches at
 * low level, and from 50+ the chance of big ones. Large catches pay bonus XP;
 * huge ones sometimes land a second fish; trophy catches (90+, rare) are the
 * stories anglers tell - bonus XP, extra fish, and real standing with the guild.
 * Bigger fish means more food for the war effort, not just a bigger number.
 *
 * Guild reputation - the Fishing Guild keeps score. Big catches, storm fishing,
 * wilderness primes and shoal runs earn it; at 50 the guild names you Angler, at
 * 200 Master Angler, at 500 Legendary Angler. Rank has teeth: Masters fish storms
 * without fear of losing gear, and rank opens the old salts' secret marks -
 * hidden spots at Ape Atoll, Burgh de Rott and Oo'glog that fish far better for
 * proven anglers. No commands, no menus: the water and the guild just know you.
 *
 * Attaches last of the depth modules: it reads the flags the earlier modules set
 * on "fishing:success" (event.conditions, event.shoalRun, event.wilderness,
 * event.prime) and the spot on "fishing:catch-chance".
 */
const REP_ATTRIBUTE = "fishing:guild-reputation";

const TIERS = Object.freeze([
  { rep: 500, name: "Legendary Angler" },
  { rep: 200, name: "Master Angler" },
  { rep: 50, name: "Angler" },
]);

const STORM_IMMUNE_REP = 200;

// The old salts' marks: remote spots (npc-spawns.json) that fish better for
// anglers the guild vouches for. Ape Atoll, Burgh de Rott, Oo'glog.
const HIDDEN_SPOT_NAMES = Object.freeze(["FISHING_SPOT_65", "FISHING_SPOT_56", "FISHING_SPOT_9"]);

let api = null;
let core = null;
let hiddenSpotIds = new Set();

function getRep(player) {
  return Number(player.getAttribute(REP_ATTRIBUTE)) || 0;
}

function tierFor(rep) {
  return TIERS.find((tier) => rep >= tier.rep) ?? null;
}

function getTier(player) {
  return tierFor(getRep(player));
}

/** Storms stop being a gear risk once the guild calls you Master Angler. */
function isStormImmune(player) {
  return getRep(player) >= STORM_IMMUNE_REP;
}

function addRep(player, amount, reason) {
  if (!(amount > 0)) return;
  const before = tierFor(getRep(player));
  const rep = getRep(player) + amount;
  player.setAttribute(REP_ATTRIBUTE, rep);
  const after = tierFor(rep);
  if (after && after !== before) {
    player.sendMessage(`The Fishing Guild names you ${after.name}! (${rep} reputation)`);
    api.log("guild tier", { player: player.getUsername?.(), tier: after.name, reason });
  }
}

function hiddenSpotMultiplier(player) {
  const rep = getRep(player);
  if (rep >= 500) return 1.5;
  if (rep >= 200) return 1.35;
  if (rep >= 50) return 1.15;
  return 1;
}

function onCatchChance(event) {
  if (!(event.multiplier > 0)) return;
  const npcId = event.spot?.npcId;
  if (npcId == null || !hiddenSpotIds.has(npcId)) return;
  event.multiplier *= hiddenSpotMultiplier(event.player);
}

/** Grades one catch. Returns the grade; null when the event carries no fish. */
function gradeCatch(player, random = Math.random) {
  const level = player.getSkillManager().getMaxLevel(core.Skill.FISHING);
  const roll = random();
  if (level >= 90 && roll < 0.01) return "trophy";
  if (level >= 75 && roll < 0.05) return "huge";
  if (level >= 50 && roll < 0.25) return "large";
  if (level < 20 && roll < 0.25) return "small";
  return "standard";
}

function grantBonusFish(player, fishId, amount) {
  const free = player.getInventory().getFreeSlots();
  const granted = Math.min(amount, Math.max(0, free));
  if (granted > 0) {
    player.getInventory().addItem(new core.Item(fishId, granted));
  }
  return granted;
}

function onSuccess(event) {
  const { player, fish, fishId } = event;
  if (!fish || fishId == null) return;

  // Reputation from how and where the fish was caught (flags set by the earlier modules).
  if (event.shoalRun) addRep(player, 2, "shoal-run");
  if (event.wilderness) addRep(player, 1, "wilderness");
  if (event.prime) addRep(player, 2, "prime");
  if (event.conditions?.storm) addRep(player, 1, "storm");

  const grade = gradeCatch(player);
  const xp = fish.experience;
  const addXp = (fraction) => player.getSkillManager().addExperiences(core.Skill.FISHING, xp * fraction);

  switch (grade) {
    case "small":
      player.sendMessage("It's a small one.");
      break;
    case "large":
      addXp(0.25);
      addRep(player, 1, "large");
      player.sendMessage("A big one!");
      break;
    case "huge":
      addXp(0.5);
      addRep(player, 3, "huge");
      if (grantBonusFish(player, fishId, 1) > 0) {
        player.sendMessage("That's a huge one - you land a second alongside it!");
      } else {
        player.sendMessage("That's a huge one!");
      }
      break;
    case "trophy": {
      addXp(1);
      addRep(player, 10, "trophy");
      const weight = (2 + Math.random() * 8).toFixed(1);
      const extra = grantBonusFish(player, fishId, 2);
      player.sendMessage(`TROPHY CATCH! A magnificent specimen (${weight}kg)!`);
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
  const { NpcIdentifiers: N } = core;
  hiddenSpotIds = new Set(HIDDEN_SPOT_NAMES.map((name) => N[name]).filter((id) => id != null));
  api.persistAttribute(REP_ATTRIBUTE);
  api.onCustomEvent("fishing:catch-chance", onCatchChance);
  api.onCustomEvent("fishing:success", onSuccess);
  api.log("registered", { hiddenSpots: hiddenSpotIds.size });
}

module.exports = {
  attach, getRep, addRep, getTier, tierFor, isStormImmune, gradeCatch, hiddenSpotMultiplier,
  REP_ATTRIBUTE, TIERS, HIDDEN_SPOT_NAMES,
  _test: { onCatchChance, onSuccess, hiddenSpotIds: () => hiddenSpotIds },
};
