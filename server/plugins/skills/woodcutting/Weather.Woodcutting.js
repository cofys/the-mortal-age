/**
 * Woodcutting weather: the same sky the anglers fish under.
 *
 * Woodcutters read the world's one weather machine (fishing's
 * Conditions.Fishing exposes it - one sky, two trades). Rain softens the
 * earth (+10% cut), overcast is kind (+5%), storms whip the canopy (-15% cut)
 * but shake nests loose (double nest chance) and bring down windfall logs (a
 * bonus log on some successes). Dawn wakes the birds (1.5x nest chance).
 * Master Foresters (see Mastery.Woodcutting) fell straight through storms.
 *
 * Listens on "woodcutting:cut-chance" and "woodcutting:nest-roll" (emitted by
 * Woodcutting.plugin per roll) and enriches "woodcutting:success" with
 * event.conditions for the later depth modules. Attach order matters: this
 * module attaches before Wilderness/Mastery/Supply.
 */
const Sky = require("../fishing/Conditions.Fishing");
const Mastery = require("./Mastery.Woodcutting");

const STORM_CUT_PENALTY = 0.85;
const RAIN_CUT_BONUS = 1.1;
const OVERCAST_CUT_BONUS = 1.05;
const STORM_NEST_MULTIPLIER = 2;
const DAWN_NEST_MULTIPLIER = 1.5;
// Storms shake loose a windfall log on some successes.
const WINDFALL_CHANCE = 0.08;

// Flavor messages are throttled per player so they stay flavor, not spam.
const FLAVOR_ATTRIBUTE = "woodcutting:weather-flavor-at";
const FLAVOR_COOLDOWN_MS = 5 * 60 * 1000;

let api = null;
let core = null;

function sayThrottled(player, text) {
  const now = Date.now();
  const last = Number(player.getAttribute(FLAVOR_ATTRIBUTE)) || 0;
  if (now - last < FLAVOR_COOLDOWN_MS) return;
  player.setAttribute(FLAVOR_ATTRIBUTE, now);
  player.sendMessage(text);
}

/** Multiplies event.multiplier by the weather for this roll. */
function onCutChance(event) {
  if (!(event.multiplier > 0)) return;
  const weather = Sky.getWeather();
  if (weather === Sky.WEATHER.STORM) {
    // Master Foresters have felled in worse.
    if (!Mastery.isStormImmune(event.player)) {
      event.multiplier *= STORM_CUT_PENALTY;
    }
  } else if (weather === Sky.WEATHER.RAIN) {
    event.multiplier *= RAIN_CUT_BONUS;
  } else if (weather === Sky.WEATHER.OVERCAST) {
    event.multiplier *= OVERCAST_CUT_BONUS;
  }
}

/** Storms shake nests loose; dawn wakes the birds. */
function onNestRoll(event) {
  if (!(event.multiplier > 0)) return;
  const weather = Sky.getWeather();
  if (weather === Sky.WEATHER.STORM) {
    event.multiplier *= STORM_NEST_MULTIPLIER;
  } else if (Sky.getTimeOfDay() === Sky.TIME.DAWN) {
    event.multiplier *= DAWN_NEST_MULTIPLIER;
  }
}

function grantWindfall(player, logId) {
  if (player.getInventory().getFreeSlots() <= 0) return 0;
  player.getInventory().addItem(new core.Item(logId, 1));
  return 1;
}

function onSuccess(event) {
  const { player } = event;
  const weather = Sky.getWeather();
  const timeOfDay = Sky.getTimeOfDay();
  const storm = weather === Sky.WEATHER.STORM;
  event.conditions = { weather, timeOfDay, storm };
  if (!storm || event.logId == null) return;

  if (Math.random() < WINDFALL_CHANCE && grantWindfall(player, event.logId) > 0) {
    sayThrottled(player, "A gust shakes a windfall log loose from the canopy!");
  } else {
    sayThrottled(player, "The storm whips the canopy - hold your footing!");
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("woodcutting:cut-chance", onCutChance);
  api.onCustomEvent("woodcutting:nest-roll", onNestRoll);
  api.onCustomEvent("woodcutting:success", onSuccess);
  api.log("registered", { weather: Sky.getWeather() });
}

module.exports = {
  attach,
  STORM_CUT_PENALTY, RAIN_CUT_BONUS, OVERCAST_CUT_BONUS,
  STORM_NEST_MULTIPLIER, DAWN_NEST_MULTIPLIER, WINDFALL_CHANCE, FLAVOR_ATTRIBUTE,
  _test: { onCutChance, onNestRoll, onSuccess, sayThrottled },
};
