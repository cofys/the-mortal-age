/**
 * The lair's food piles, as captured (docs/scurrius.md) and per the Wiki (Food Pile): out of
 * combat, a player can eat from one once every ten minutes to restore their hitpoints to full.
 * The pick-up, then the eating animation and sound with the message a tick later; the cooldown's
 * minutes go to varbit 9581 (rat_boss_food_pile_player_eat_delay), which the client shows.
 */
const Common = require("./Common.Scurrius");

const COOLDOWN_VARBIT = 9581;
const COOLDOWN_MINUTES = 10;
const MINUTE_MS = 60_000;
/** When the player last ate from a pile (epoch ms). */
const ATE_AT_ATTRIBUTE = "scurrius:food-pile-ate-at";

/** Cache sequences human_pickupfloor and human_eat, and the captured eating sound. */
const PICKUP_ANIM = 827;
const EAT_ANIM = 829;
const EAT_SOUND = 2393;

const MESSAGES = Object.freeze({
  combat: "You cannot eat from the food pile while in combat.",
  full: "You already have full Hitpoints.",
  eat: "You take food from the food pile and eat it, restoring your hitpoints.",
  cooldown: (minutes) => `You ate from the food pile recently. The foul stench prevents you eating from it for another ${minutes} minutes.`,
});

let core = null;
/** player -> the task counting their cooldown's varbit down. */
const countdowns = new Map();

function minutesLeft(player, now = Date.now()) {
  const ateAt = Number(player.getAttribute(ATE_AT_ATTRIBUTE)) || 0;
  if (ateAt <= 0) return 0;
  return Math.max(0, Math.ceil((ateAt + COOLDOWN_MINUTES * MINUTE_MS - now) / MINUTE_MS));
}

/** Sends the cooldown's minutes, and keeps them counting down while the player is online. */
function syncCooldown(player) {
  countdowns.get(player)?.stop();
  countdowns.delete(player);
  const minutes = minutesLeft(player);
  player.getPacketSender().sendVarbit(COOLDOWN_VARBIT, minutes);
  if (minutes <= 0) {
    if (Number(player.getAttribute(ATE_AT_ATTRIBUTE)) > 0) player.setAttribute(ATE_AT_ATTRIBUTE, 0);
    return;
  }
  const ateAt = Number(player.getAttribute(ATE_AT_ATTRIBUTE));
  const untilNextMinute = (ateAt + (COOLDOWN_MINUTES - minutes + 1) * MINUTE_MS - Date.now()) / 600;
  countdowns.set(player, Common.later(Math.max(1, Math.ceil(untilNextMinute)), () => {
    countdowns.delete(player);
    if (player.isRegistered?.() !== false) syncCooldown(player);
  }));
}

function eat({ player }) {
  if (core.CombatFactory.inCombat(player)) {
    player.sendMessage(MESSAGES.combat);
    return true;
  }
  const minutes = minutesLeft(player);
  if (minutes > 0) {
    player.sendMessage(MESSAGES.cooldown(minutes));
    return true;
  }
  const skills = player.getSkillManager();
  if (skills.getCurrentLevel(core.Skill.HITPOINTS) >= skills.getMaxLevel(core.Skill.HITPOINTS)) {
    player.sendMessage(MESSAGES.full);
    return true;
  }
  player.performAnimation(new core.Animation(PICKUP_ANIM));
  Common.later(1, () => {
    if (player.isRegistered?.() === false) return;
    player.performAnimation(new core.Animation(EAT_ANIM));
    player.getPacketSender().sendSound(EAT_SOUND, 1, 0);
    skills.setCurrentLevel(core.Skill.HITPOINTS, skills.getMaxLevel(core.Skill.HITPOINTS), true);
    player.sendMessage(MESSAGES.eat);
    player.setAttribute(ATE_AT_ATTRIBUTE, Date.now());
    syncCooldown(player);
  });
  return true;
}

function onLogin({ player }) {
  if (minutesLeft(player) > 0) syncCooldown(player);
}

function onLogout({ player }) {
  countdowns.get(player)?.stop();
  countdowns.delete(player);
}

function attach(api) {
  core = api.core;
  api.persistAttribute(ATE_AT_ATTRIBUTE, 0);
  api.onPlayerLogin(onLogin);
  api.onPlayerLogout(onLogout);
  api.onObjectInteraction("Food Pile", { Eat: eat });
}

module.exports = { attach, _test: { COOLDOWN_VARBIT, ATE_AT_ATTRIBUTE, MESSAGES, minutesLeft, eat, syncCooldown } };
