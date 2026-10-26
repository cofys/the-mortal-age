let core;
const THEFT_ATTRIBUTE = "thieving:stall-thefts";
const theftTimers = new WeakMap();
const THIEVING_SOUND = 2581;
const GUARDS = new Set(["guard", "market guard", "black guard", "knight of ardougne", "paladin", "hero"]);
// shortcut: a five-tile lookout range, verify the exact radius against a live stall capture.
const LOOKOUT_RADIUS = 5;
const depleted = new WeakMap();

const STALLS = new Map([
  [
    "Bakery stall",
    {
      respawnTicks: 4, owners: ["Baker", "Randivor"],
      theft: "cake", minutes: 15, safeUnderOwner: true,
      petBase: 124066,
      level: 5,
      xp: 16,
      rewards: [
        ["CAKE", 1, 13],
        ["BREAD", 1, 5, "You steal some bread."],
        ["CHOCOLATE_SLICE", 1, 2],
      ],
    },
  ],
  ["Silk stall", { theft: "silk", respawnTicks: 8, owners: ["Silk merchant", "Silk Merchant", "Anwen"], petBase: 68926, level: 20, xp: 24, rewards: [["SILK", 1, 1]] }],
  ["Tea stall", { theft: "tea", attemptMessage: "You attempt to steal a cup of tea...", respawnTicks: 4, owners: ["Tea Seller"], petBase: 68926, level: 5, xp: 16, rewards: [["CUP_OF_TEA", 1, 1, "You steal a cup of tea."]] }],
  ["Fur stall", { theft: "fur", respawnTicks: 12, owners: ["Fur trader", "Fur Merchant"], petBase: 36490, level: 35, xp: 45, rewards: [["GREY_WOLF_FUR", 1, 1]] }],
  [
    "Gem stall",
    {
      theft: "gem", attemptMessage: "You attempt to steal a gem from the gem stall.", respawnTicks: 100, owners: ["Gem merchant", "Gem Merchant", "Hervi", "Glenda"],
      petBase: 36490,
      level: 75,
      xp: 408,
      rewards: [
        ["UNCUT_SAPPHIRE", 1, 105, "You steal an uncut sapphire."],
        ["UNCUT_EMERALD", 1, 17],
        ["UNCUT_RUBY", 1, 5],
        ["UNCUT_DIAMOND", 1, 1],
      ],
    },
  ],
  [
    "Seed Stall",
    {
      theft: "seed", respawnTicks: 4, owners: ["Olivia"],
      petBase: 36490,
      level: 27,
      xp: 10,
      rewards: [
        ["HAMMERSTONE_SEED", 1, 120],
        ["POTATO_SEED", 1, 119],
        ["MARIGOLD_SEED", 1, 119],
        ["BARLEY_SEED", 1, 118],
        ["ONION_SEED", 1, 89],
        ["ASGARNIAN_SEED", 1, 83],
        ["CABBAGE_SEED", 1, 71],
        ["YANILLIAN_SEED", 1, 47],
        ["ROSEMARY_SEED", 1, 36],
        ["NASTURTIUM_SEED", 1, 35],
        ["TOMATO_SEED", 1, 35],
        ["JUTE_SEED", 1, 35],
        ["SWEETCORN_SEED", 1, 30],
        ["KRANDORIAN_SEED", 1, 24],
        ["STRAWBERRY_SEED", 1, 18],
        ["WILDBLOOD_SEED", 1, 12],
        ["WATERMELON_SEED", 1, 9],
      ],
    },
  ],
]);

STALLS.set("Silver stall", { theft: "silver", attemptMessage: "You attempt to steal some silver from the silver stall.", respawnTicks: 32, owners: ["Silver merchant", "Osian", "Gulldamar"], petBase: 36490, level: 50, xp: 205,
  rewards: [["SILVER_ORE", 1, 16, "You steal a piece of silver."], ["SILVER_BAR", 1, 3], ["TIARA", 1, 1]] });
STALLS.set("Spice stall", { theft: "spice", minutes: 6, respawnTicks: 10, owners: ["Spice seller", "Spice Merchant", "Caerwyn"], petBase: 36490, level: 65, xp: 92, rewards: [["SPICE", 1, 1]] });
STALLS.set("Market stall", { theft: "wine", respawnTicks: 8, owners: ["Fortunato"], petBase: 36490, level: 22, xp: 27,
  rewards: [["BOTTLE_OF_WINE", 1, 11], ["GRAPES", 1, 17], ["JUG", 1, 39], ["JUG_OF_WATER", 1, 20], ["JUG_OF_WINE", 1, 13]] });

STALLS.set("Baker's stall", STALLS.get("Bakery stall"));
STALLS.set("Baker's Stall", STALLS.get("Bakery stall"));
STALLS.set("Gem Stall", STALLS.get("Gem stall"));

function randomReward(rewards) {
  const totalWeight = rewards.reduce((sum, [, , weight]) => sum + weight, 0);
  let roll = Math.floor(Math.random() * totalWeight);
  for (const reward of rewards) {
    roll -= reward[2];
    if (roll < 0) {
      return { item: new core.Item(core.ItemIds[reward[0]], reward[1]), message: reward[3] };
    }
  }
  const [itemId, amount, , message] = rewards[rewards.length - 1];
  return { item: new core.Item(core.ItemIds[itemId], amount), message };
}

let pluginApi;

/** The cache's empty counterpart, preserving each market's stall model and footprint. */
function emptyStallId(object) {
  const ids = core.ObjectIdentifiers;
  const id = object.getId();
  if (id === ids.MARKET_STALL_14) return ids.MARKET_STALL_15;
  if (id === ids.BAKERS_STALL_2) return ids.EMPTY_STALL;
  if ([ids.GEM_STALL_2, ids.BAKERY_STALL_2, ids.SILVER_STALL_2].includes(id)) return ids.MARKET_STALL_12;
  if ([ids.SILK_STALL_5, ids.SILVER_STALL_4, ids.GEM_STALL_6, ids.SPICE_STALL_5].includes(id)) return ids.MARKET_STALL_25;
  if ([ids.SILK_STALL_7, ids.FUR_STALL_7, ids.GEM_STALL_8, ids.SPICE_STALL_6, ids.BAKERS_STALL_4].includes(id)) return ids.MARKET_STALL_28;
  return ids.MARKET_STALL;
}

function depleteStall(object, ticks) {
  // Port Roberts stalls never deplete; their automatic theft/jail activity is separate content.
  if ([core.ObjectIdentifiers.SILK_STALL_8, core.ObjectIdentifiers.FUR_STALL_9, core.ObjectIdentifiers.SILVER_STALL_7, core.ObjectIdentifiers.SPICE_STALL_7, core.ObjectIdentifiers.GEM_STALL_11].includes(object.getId())) return;
  if (depleted.has(object)) return;
  depleted.set(object, core.World.getProcessCycle());
  const empty = new core.GameObject(emptyStallId(object), object.getLocation().clone(), object.getType(), object.getFace(), object.getPrivateArea()).setOwner(object.getOwner());
  if (!object.getPrivateArea()?.isDestroyed()) {
    core.ObjectManager.deregister(object, true);
    core.ObjectManager.register(empty, true);
  }
  core.TaskManager.submit(new core.CountdownTask(object, ticks, () => {
    depleted.delete(object);
    if (object.getPrivateArea()?.isDestroyed()) return;
    core.ObjectManager.deregister(empty, true);
    object.getPrivateArea()?.add(object);
    core.ObjectManager.register(object, true);
  }));
}

/** A stall always succeeds unless a guard or its owner can see the thief. */
function caughtStealing(player, stall) {
  const nearby = core.World.getNpcsNear(player.getLocation(), LOOKOUT_RADIUS, player.getPrivateArea());
  const guards = nearby.filter((npc) => GUARDS.has(String(npc.getDefinition().getName() ?? "").toLowerCase()) && npc.getDefinition().isAttackable() && npc.getHitpoints() > 0 && !npc.getCombat().getTarget());
  const seesPlayer = (npc) => core.RegionManager.canProjectileAttackBounds(npc.getLocation(), player.getLocation(), npc.getSize(), npc.getSize(), 1, 1, player.getPrivateArea());
  const lookout = guards.find((npc) => !npc.getLocation().equals(player.getLocation()) && seesPlayer(npc))
    ?? nearby.find((npc) => stall.owners.includes(npc.getDefinition().getName()) && npc.getHitpoints() > 0
      && (!stall.safeUnderOwner || !npc.getLocation().equals(player.getLocation())) && seesPlayer(npc));
  if (!lookout) return false;
  lookout.forceChat("Hey! Get your hands off there!");
  const guard = guards.includes(lookout) ? lookout : guards[0];
  if (guard) guard.getCombat().attack(player);
  return true;
}

// The client uses these cache varbits for the merchants' stolen-stock state.
function syncTheft(player, key, value) {
  const id = core.CacheDefinitions.getVarbitId(`marketthief_${key}`);
  if (id != null) player.getPacketSender().sendVarbit(id, value);
}

const REGIONAL_THEFT_KEYS = new Map([
  ["dwarf_market_bakery", "keldabread"], ["dwarf_market_gems", "keldagem"], ["dwarf_market_silver", "keldasilver"],
  ["viking_fur_market", "vikingfur"], ["vikingexile_fur_market", "vikingfur"],
  ["prif_marketstall_silk", "silk_prif"], ["prif_marketstall_silver", "silver_prif"],
  ["prif_marketstall_gem", "gem_prif"], ["prif_marketstall_spice", "spice_prif"],
]);

function theftVarbitKey(object, stall) {
  return REGIONAL_THEFT_KEYS.get(core.CacheDefinitions.getLocNames().get(object.getId())) ?? stall.theft;
}

function stopTheftTimers(player) {
  for (const task of theftTimers.get(player)?.values() ?? []) task.stop();
  theftTimers.delete(player);
}

function rememberTheft(player, stall, varbitKey) {
  const key = stall.theft;
  const previous = player.getAttribute(THEFT_ATTRIBUTE) ?? {};
  const varbits = [...new Set([...(previous[key] ?? []), ...(varbitKey ? [varbitKey] : [])])];
  const stolen = { ...previous, [key]: varbits };
  player.setAttribute(THEFT_ATTRIBUTE, stolen);
  let timers = theftTimers.get(player);
  if (!timers) theftTimers.set(player, timers = new Map());
  timers.get(key)?.stop();
  for (const bit of varbits) syncTheft(player, bit, 1);
  const task = new core.CountdownTask(player, (stall.minutes ?? 10) * 100, () => {
    const remaining = { ...player.getAttribute(THEFT_ATTRIBUTE) };
    delete remaining[key];
    player.setAttribute(THEFT_ATTRIBUTE, Object.keys(remaining).length ? remaining : null);
    timers.delete(key);
    for (const bit of varbits) syncTheft(player, bit, 0);
  });
  timers.set(key, task);
  core.TaskManager.submit(task);
}

function login({ player }) {
  // The Wiki requires consecutive in-game minutes; a logout restarts the wait.
  for (const stall of new Set(STALLS.values())) {
    if (player.getAttribute(THEFT_ATTRIBUTE)?.[stall.theft]) rememberTheft(player, stall);
  }
}

function logout({ player }) {
  stopTheftTimers(player);
}

function merchantInteraction(event) {
  const name = event.definition.getName();
  const stall = [...STALLS.values()].find((entry) => entry.owners.includes(name));
  if (!stall || !event.player.getAttribute(THEFT_ATTRIBUTE)?.[stall.theft]) return false;
  event.npc.forceChat(name === "Fortunato" ? "You're the thief who stole from me!" : "You're the one who stole something from me!");
  core.TaskManager.submit(new core.CountdownTask(event.npc, 2, () => event.npc.forceChat("Guards guards!")));
  const guard = core.World.getNpcsNear(event.player.getLocation(), LOOKOUT_RADIUS, event.player.getPrivateArea()).find((npc) =>
    GUARDS.has(String(npc.getDefinition().getName() ?? "").toLowerCase()) && npc.getDefinition().isAttackable()
    && npc.getHitpoints() > 0 && !npc.getCombat().getTarget());
  if (guard) guard.getCombat().attack(event.player);
  event.handled = true;
}

function finishTheft(event, stall) {
  const { player, object } = event;
  if (object.getPrivateArea()?.isDestroyed()) return;
  // Another item can fill the final slot during the attempt tick.
  if (player.getInventory().isFull()) { player.getInventory().full(); return; }
  const { item: reward, message } = randomReward(stall.rewards);
  const request = { player, itemId: reward.getId(), amount: reward.getAmount(), stored: 0 };
  pluginApi.emitCustomEvent("storage:gather", request);
  if (reward.getAmount() > request.stored) player.getInventory().addItem(new core.Item(reward.getId(), reward.getAmount() - request.stored));
  player.getSkillManager().addExperiences(core.Skill.THIEVING, stall.xp);
  player.sendMessage(message ?? `You steal ${reward.getAmount()} x ${reward.getDefinition().getName()}.`);
  rememberTheft(player, stall, theftVarbitKey(object, stall));
  pluginApi.emitCustomEvent("thieving:success", { player, skill: core.Skill.THIEVING, petBase: stall.petBase, method: "stall",
    stall: event.definition.getName(), itemId: reward.getId(), location: object.getLocation() });
  const ticks = object.getId() === core.ObjectIdentifiers.BAKERY_STALL_2 ? 16 : stall.respawnTicks;
  depleteStall(object, ticks);
}

function handleStealFromStall(event) {
  const stall = STALLS.get(event.definition.getName());
  if (!stall) {
    return;
  }

  // Other objects share the wine stall's name, including its clickable empty version.
  if (event.definition.getName() === "Market stall" && event.object.getId() !== core.ObjectIdentifiers.MARKET_STALL_14) return;
  event.handled = true;
  if (depleted.has(event.object)) return;

  const player = event.player;
  if (player.getSkillManager().getCurrentLevel(core.Skill.THIEVING) < stall.level) {
    player.sendMessage(`You need a Thieving level of at least ${stall.level} to do this.`);
    event.handled = true;
    return;
  }
  if (!player.getClickDelay().elapsedTime(1000)) {
    event.handled = true;
    return;
  }
  if (player.getInventory().isFull()) {
    player.getInventory().full();
    event.handled = true;
    return;
  }

  player.setPositionToFace(event.object.getLocation());
  const attempt = stall.attemptMessage;
  if (attempt) player.sendMessage(attempt);
  if (caughtStealing(player, stall)) return;
  player.getClickDelay().reset();
  player.performAnimation(new core.Animation(core.CacheDefinitions.getSeqId("human_pickuptable")));
  player.getPacketSender().sendSound(THIEVING_SOUND, 10, 0);
  core.TaskManager.submit(new core.CountdownTask(player, 1, () => finishTheft(event, stall)));
  event.handled = true;
}

function attach(api) {
  core = api.core;
  pluginApi = api;
  api.persistAttribute(THEFT_ATTRIBUTE, null);
  api.onPlayerLogin(login);
  api.onPlayerLogout(logout);
  api.onNpcsInteraction([...new Set([...STALLS.values()].flatMap((stall) => stall.owners))], { "Talk-to": merchantInteraction, Trade: merchantInteraction });
  api.onObjectInteraction("Silver stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Spice stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Market stall", { "Steal-From": handleStealFromStall });
  api.onObjectInteraction("Bakery stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Silk stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Tea stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Fur stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Gem stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Gem Stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Baker's stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Baker's Stall", { "Steal-from": handleStealFromStall });
  api.onObjectInteraction("Seed Stall", { "Steal from": handleStealFromStall });
}

module.exports = attach;
module.exports._test = { handleStealFromStall, STALLS, depleted, emptyStallId, merchantInteraction, login, logout, THEFT_ATTRIBUTE };
