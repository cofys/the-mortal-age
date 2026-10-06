/**
 * Woodcutting mastery: what high-level woodcutters get beyond XP.
 *
 * Quality grades - every log is graded by the cutter's level: knotty wood at
 * low level, and from 50+ the chance of clean timber. Straight logs pay bonus
 * XP; heartwood sometimes yields a second log alongside; ancient heartwood
 * (90+, rare) is the story woodcutters tell - bonus XP, extra logs, and real
 * standing with the guild. Better timber means better palisades for the war
 * effort, not just a bigger number.
 *
 * Guild reputation - the Woodcutting Guild keeps score. Fine logs, storm
 * felling, wilderness primes and timber drives earn it; at 50 the guild names
 * you Forester, at 200 Master Forester, at 500 Legendary Forester. Rank has
 * teeth: Masters fell straight through storms, and rank opens the old
 * foresters' hidden grove - the Ape Atoll teak and mahogany that cut far
 * better for proven hands. No commands, no menus: the groves just know you.
 *
 * Attaches after Groves/Weather/Wilderness: it reads the flags the earlier
 * modules set on "woodcutting:success" (event.conditions, event.drive,
 * event.wilderness, event.prime, event.grove).
 */
const REP_ATTRIBUTE = "woodcutting:guild-reputation";

const TIERS = Object.freeze([
  { rep: 500, name: "Legendary Forester" },
  { rep: 200, name: "Master Forester" },
  { rep: 50, name: "Forester" },
]);

const STORM_IMMUNE_REP = 200;

// The old foresters' mark: the Ape Atoll teak and mahogany grove, drawn on
// real geography, that cuts better for woodcutters the guild vouches for.
const HIDDEN_GROVE = Object.freeze({ x1: 2750, x2: 2800, y1: 2700, y2: 2750, z: 0 });

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

/** Storms stop being a cut penalty once the guild calls you Master Forester. */
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
    player.sendMessage(`The Woodcutting Guild names you ${after.name}! (${rep} reputation)`);
    api.log("guild tier", { player: player.getUsername?.(), tier: after.name, reason });
  }
}

function inHiddenGrove(location) {
  if (!location) return false;
  return location.z === HIDDEN_GROVE.z &&
    location.x >= HIDDEN_GROVE.x1 && location.x <= HIDDEN_GROVE.x2 &&
    location.y >= HIDDEN_GROVE.y1 && location.y <= HIDDEN_GROVE.y2;
}

function hiddenGroveMultiplier(player) {
  const rep = getRep(player);
  if (rep >= 500) return 1.5;
  if (rep >= 200) return 1.35;
  if (rep >= 50) return 1.15;
  return 1;
}

function onCutChance(event) {
  if (!(event.multiplier > 0)) return;
  if (!inHiddenGrove(event.location)) return;
  event.multiplier *= hiddenGroveMultiplier(event.player);
}

/** Grades one log. Returns the grade; null when the event carries no log. */
function gradeLog(player, random = Math.random) {
  const level = player.getSkillManager().getMaxLevel(core.Skill.WOODCUTTING);
  const roll = random();
  if (level >= 90 && roll < 0.01) return "ancient";
  if (level >= 75 && roll < 0.05) return "heartwood";
  if (level >= 50 && roll < 0.25) return "straight";
  if (level < 20 && roll < 0.25) return "knotty";
  return "standard";
}

function grantBonusLog(player, logId, amount) {
  const free = player.getInventory().getFreeSlots();
  const granted = Math.min(amount, Math.max(0, free));
  if (granted > 0) {
    player.getInventory().addItem(new core.Item(logId, granted));
  }
  return granted;
}

function onSuccess(event) {
  const { player, logId, xpReward } = event;
  if (logId == null || xpReward == null) return;

  // Reputation from how and where the log was cut (flags set by the earlier modules).
  if (event.drive) addRep(player, 2, "timber-drive");
  if (event.wilderness) addRep(player, 1, "wilderness");
  if (event.prime) addRep(player, 2, "prime");
  if (event.conditions?.storm) addRep(player, 1, "storm");

  const grade = gradeLog(player);
  const addXp = (fraction) => player.getSkillManager().addExperiences(core.Skill.WOODCUTTING, xpReward * fraction);

  switch (grade) {
    case "knotty":
      player.sendMessage("Knotty wood - it will burn, at least.");
      break;
    case "straight":
      addXp(0.25);
      addRep(player, 1, "straight");
      player.sendMessage("A straight, clean log!");
      break;
    case "heartwood": {
      addXp(0.5);
      addRep(player, 3, "heartwood");
      const extra = grantBonusLog(player, logId, 1);
      player.sendMessage(
        extra > 0
          ? "Heartwood! The cut is so clean you take a second log with it."
          : "Heartwood! A cutter's log.",
      );
      break;
    }
    case "ancient": {
      addXp(1);
      addRep(player, 10, "ancient");
      const extra = grantBonusLog(player, logId, 2);
      player.sendMessage("ANCIENT HEARTWOOD! Timber the old kings built with!");
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
  api.onCustomEvent("woodcutting:cut-chance", onCutChance);
  api.onCustomEvent("woodcutting:success", onSuccess);
  api.log("registered", { hiddenGrove: HIDDEN_GROVE });
}

module.exports = {
  attach, getRep, addRep, getTier, tierFor, isStormImmune, gradeLog,
  hiddenGroveMultiplier, inHiddenGrove,
  REP_ATTRIBUTE, TIERS, HIDDEN_GROVE,
  _test: { onCutChance, onSuccess },
};
