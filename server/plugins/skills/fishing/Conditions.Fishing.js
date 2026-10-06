/**
 * Fishing conditions: time of day and weather change what is biting.
 *
 * Time of day (server clock): dawn/dusk sees the rise on rivers (fly and barbarian
 * rods), night favors eels and dark crab. Weather is a small state machine rolled
 * every ~30 minutes: rain helps everything a little, storms churn the deep water
 * (much better bites for harpoon/big-net/dark-crab, +50% XP) but punish gear -
 * bait gets ripped away, waves can knock a fisher off their spot, and cheap tools
 * can be torn from your hands. Master Anglers (see Mastery.Fishing) fish storms
 * without fear. Cave and dungeon spots never see the weather.
 *
 * Listens on "fishing:catch-chance" (emitted by Fishing.plugin per catch roll) and
 * enriches "fishing:success" with event.conditions for the later depth modules.
 * Attach order matters: this module attaches before ShoalRun/Wilderness/Mastery/Supply.
 */
const Mastery = require("./Mastery.Fishing");
const { spreadRumor } = require("./Rumors.Fishing");

const WEATHER = Object.freeze({ CLEAR: "clear", OVERCAST: "overcast", RAIN: "rain", STORM: "storm" });
const TIME = Object.freeze({ DAWN: "dawn", DAY: "day", DUSK: "dusk", NIGHT: "night" });

const HABITAT = Object.freeze({ RIVER: "river", SHORE: "shore", DEEP: "deep", CAVE: "cave" });

// Weather rolls about every 30 minutes (a tick is 0.6s).
const WEATHER_ROLL_TICKS = 3000;

// Storms only threaten replaceable tools, and never an upgraded variant.
const STORM_TOOL_LOSS_CHANCE = 0.01;
const STORM_BAIT_LOSS_CHANCE = 0.1;
const STORM_KNOCKBACK_CHANCE = 0.03;
const STORM_XP_BONUS = 0.5;

// Flavor messages are throttled per player so they stay flavor, not spam.
const FLAVOR_ATTRIBUTE = "fishing:conditions-flavor-at";
const FLAVOR_COOLDOWN_MS = 5 * 60 * 1000;

let api = null;
let core = null;
let weather = WEATHER.CLEAR;
// Raw fish id -> habitat, and cave fishing-spot npc ids, filled at attach from the cache enums.
let habitatByFishId = new Map();
let caveSpotIds = new Set();
let cheapToolIds = new Set();

function getTimeOfDay(now = new Date()) {
  const hour = now.getHours();
  if (hour >= 5 && hour < 8) return TIME.DAWN;
  if (hour >= 8 && hour < 17) return TIME.DAY;
  if (hour >= 17 && hour < 20) return TIME.DUSK;
  return TIME.NIGHT;
}

function getWeather() {
  return weather;
}

/** Markov roll: storms are rare, and they always blow themselves out. */
function rollWeather(random = Math.random) {
  const roll = random();
  switch (weather) {
    case WEATHER.CLEAR:
      return roll < 0.35 ? WEATHER.OVERCAST : WEATHER.CLEAR;
    case WEATHER.OVERCAST:
      if (roll < 0.4) return WEATHER.RAIN;
      if (roll < 0.75) return WEATHER.CLEAR;
      return WEATHER.OVERCAST;
    case WEATHER.RAIN:
      if (roll < 0.25) return WEATHER.STORM;
      if (roll < 0.55) return WEATHER.OVERCAST;
      if (roll < 0.75) return WEATHER.CLEAR;
      return WEATHER.RAIN;
    case WEATHER.STORM:
    default:
      return roll < 0.6 ? WEATHER.OVERCAST : WEATHER.RAIN;
  }
}

function updateWeather() {
  const next = rollWeather();
  if (next === weather) return;
  weather = next;
  if (weather === WEATHER.STORM) {
    spreadRumor(api, "kandarin", "A storm is rolling in off the coast. Deep-water fish will bite - if your gear holds.");
    spreadRumor(api, "misthalin", "A storm is rolling in off the coast. Deep-water fish will bite - if your gear holds.");
  } else if (weather === WEATHER.CLEAR) {
    spreadRumor(api, "kandarin", "The storm has passed. Seas are calming.");
  }
  api.log("weather", { weather });
}

function isCaveSpot(npcId) {
  return caveSpotIds.has(npcId);
}

function habitatOf(fishId) {
  return habitatByFishId.get(fishId) ?? null;
}

function sayThrottled(player, text) {
  const now = Date.now();
  const last = Number(player.getAttribute(FLAVOR_ATTRIBUTE)) || 0;
  if (now - last < FLAVOR_COOLDOWN_MS) return;
  player.setAttribute(FLAVOR_ATTRIBUTE, now);
  player.sendMessage(text);
}

/** Multiplies event.multiplier by the time/weather conditions for this roll. */
function onCatchChance(event) {
  if (!(event.multiplier > 0)) return;
  const habitat = habitatOf(event.fish?.id);
  if (!habitat) return;
  const cave = event.spot?.npcId != null && isCaveSpot(event.spot.npcId);
  let multiplier = 1;

  if (!cave) {
    if (weather === WEATHER.RAIN) multiplier *= 1.15;
    else if (weather === WEATHER.OVERCAST) multiplier *= 1.1;
    else if (weather === WEATHER.STORM && habitat === HABITAT.DEEP) multiplier *= 1.4;
  }

  const time = getTimeOfDay();
  if ((time === TIME.DAWN || time === TIME.DUSK) && habitat === HABITAT.RIVER) multiplier *= 1.25;
  if (time === TIME.NIGHT && (habitat === HABITAT.CAVE || habitat === HABITAT.DEEP)) multiplier *= 1.15;

  event.multiplier *= multiplier;
}

function loseBait(player, baitId, random = Math.random) {
  const held = player.getInventory().getAmount(baitId);
  if (held <= 0) return;
  const lost = Math.min(held, 1 + Math.floor(random() * 3));
  player.getInventory().deleteNumber(baitId, lost);
  player.sendMessage("The storm rips bait from your pouch!");
}

function onSuccess(event) {
  const { player } = event;
  const npcId = event.spot?.npcId;
  const cave = npcId != null && isCaveSpot(npcId);
  const storm = weather === WEATHER.STORM && !cave;
  event.conditions = { weather, timeOfDay: getTimeOfDay(), storm };

  if (!storm || !event.fish) return;

  // The upside: fighting the storm pays.
  player.getSkillManager().addExperiences(core.Skill.FISHING, event.fish.experience * STORM_XP_BONUS);
  if (habitatOf(event.fish.id) === HABITAT.DEEP) {
    sayThrottled(player, "The storm churns the deep water - the big ones are biting!");
  }

  // The risk: Master Anglers have weathered worse.
  if (Mastery.isStormImmune(player)) return;
  const random = Math.random;
  if (event.baitId != null && random() < STORM_BAIT_LOSS_CHANCE) {
    loseBait(player, event.baitId, random);
  } else if (random() < STORM_KNOCKBACK_CHANCE) {
    event.stop = true;
    player.sendMessage("A wave crashes over you - you lose your footing and stop fishing.");
  }
  if (
    event.variantBonus === 100 && event.toolId != null && cheapToolIds.has(event.toolId) &&
    random() < STORM_TOOL_LOSS_CHANCE
  ) {
    if (player.getInventory().contains(event.toolId)) {
      player.getInventory().deleteNumber(event.toolId, 1);
      player.sendMessage("The storm tears your fishing gear from your hands!");
      event.stop = true;
    }
  }
}

function buildHabitatMap() {
  const I = core.ItemIdentifiers;
  const river = [I.RAW_TROUT, I.RAW_SALMON, I.RAW_PIKE, I.LEAPING_TROUT, I.LEAPING_SALMON, I.LEAPING_STURGEON];
  const shore = [
    I.RAW_SHRIMPS, I.RAW_ANCHOVIES, I.RAW_SARDINE, I.RAW_HERRING,
    I.RAW_MACKEREL, I.RAW_COD, I.RAW_BASS, I.RAW_LOBSTER,
  ];
  const deep = [I.RAW_TUNA, I.RAW_SWORDFISH, I.RAW_SHARK, I.RAW_MONKFISH, I.RAW_ANGLERFISH, I.RAW_DARK_CRAB];
  const cave = [I.RAW_CAVE_EEL, I.RAW_SLIMY_EEL, I.RAW_LAVA_EEL, I.INFERNAL_EEL, I.SACRED_EEL];
  const map = new Map();
  for (const id of river) map.set(id, HABITAT.RIVER);
  for (const id of shore) map.set(id, HABITAT.SHORE);
  for (const id of deep) map.set(id, HABITAT.DEEP);
  for (const id of cave) map.set(id, HABITAT.CAVE);
  return map;
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  const { NpcIdentifiers: N, ItemIdentifiers: I } = core;
  habitatByFishId = buildHabitatMap();
  // Mirrors the eel/frog-spawn spot mapping in Fishing.plugin (SPOT_TOOLS_BY_NPC): these
  // spots are underground or in swamps, so surface weather never reaches them.
  caveSpotIds = new Set([
    N.FISHING_SPOT_2, N.FISHING_SPOT_3, N.FISHING_SPOT_4, N.FISHING_SPOT_5, N.FISHING_SPOT_92,
    N.FISHING_SPOT_40, N.FISHING_SPOT_41, N.FISHING_SPOT_42,
    N.FISHING_SPOT_63, N.FISHING_SPOT_6, N.FISHING_SPOT_130,
    N.FISHING_SPOT_68, N.ROD_FISHING_SPOT_20,
  ]);
  cheapToolIds = new Set([
    I.SMALL_FISHING_NET, I.BIG_FISHING_NET, I.FISHING_ROD, I.FLY_FISHING_ROD, I.LOBSTER_POT, I.HARPOON,
  ]);

  // Roll once at boot so restarts do not always open on a clear sky.
  weather = rollWeather();
  api.onCustomEvent("fishing:catch-chance", onCatchChance);
  api.onCustomEvent("fishing:success", onSuccess);
  api.getTaskManager().submit(new (class extends core.Task {
    constructor() { super(WEATHER_ROLL_TICKS); }
    execute() { updateWeather(); }
  })());
  api.log("registered", { weather });
}

module.exports = {
  attach, getWeather, getTimeOfDay, rollWeather, habitatOf, isCaveSpot,
  WEATHER, TIME, HABITAT, FLAVOR_ATTRIBUTE,
  _test: { onCatchChance, onSuccess, setWeather: (value) => { weather = value; }, updateWeather },
};
