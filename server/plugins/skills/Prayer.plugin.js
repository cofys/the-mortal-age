/**
 * Burying bones, from plugins/skills/data/bones.json, and scattering demonic ashes, from
 * plugins/skills/data/ashes.json (docs/prayer-bones.md).
 *
 * Other plugins bury through custom events:
 *   api.emitCustomEvent("prayer:bury", { player, itemId, scale, crushed })
 *     -> sets `handled` when `itemId` is a bone: its experience (times `scale`, default 1) and
 *        its Prayer restore are given. `crushed` (the bonecrusher) leaves out bones it can't crush.
 *   api.emitCustomEvent("prayer:bone", { itemId, bone: null })
 *     -> sets `bone` to the bone's row ({ xp, level, ... }) when `itemId` is a bone, for content
 *        that gives its own experience (altars).
 *   api.onCustomEvent("prayer:bone-restore", (event) => { event.restore = event.points; })
 *     -> asked after every burial; `points` is the bone's restore, and Prayer gives back
 *        `restore` once, so two sources (the Catacombs, a dragonbone necklace) never stack.
 */
const DATA = require("./data/bones.json");
const ASHES = require("./data/ashes.json");

// --- Fork addition: offering bones on a generic altar ---------------------
// Upstream's rewritten Prayer (this file) handles burying and serves the
// "prayer:bone" lookup; its BoneAltars plugin covers the Chaos Temple altar
// and construction's Altars covers player-owned house altars. The fork has
// always also let players offer bones on any other object named "Altar"
// (2.5x bury XP) or "Gilded altar" (3.5x) — CitizenPrayer's offerBonesAtAltar
// mirrors these multipliers — so that behaviour is kept below. Two guards
// stop double-handling with upstream's new plugins: the Chaos Temple altar
// tile is skipped (BoneAltars owns it), and offerings inside a private area
// are skipped (house altars own those).
const OFFER_DELAY_MS = 1800; // Three OSRS game ticks per offering.
const ALTAR_MULTIPLIERS = new Map([
  ["Altar", 2.5],
  ["Gilded altar", 3.5],
]);
const CHAOS_ALTAR_TILE = { x: 2947, y: 3820, z: 0 }; // BoneAltars.plugin.js

function offerBone(event) {
  const { player, itemId, object } = event;
  const slot = event.slot ?? event.itemSlot;
  const core = api.core;
  const bone = boneFor(itemId);
  if (!bone) return;
  const altarName = object.getDefinition()?.getName();
  const multiplier = ALTAR_MULTIPLIERS.get(altarName);
  if (!multiplier) return;
  const at = player.getLocation();
  if (at.x === CHAOS_ALTAR_TILE.x && at.y === CHAOS_ALTAR_TILE.y && at.z === CHAOS_ALTAR_TILE.z) return;
  if (player.getPrivateArea?.()) return;
  if (!player.getClickDelay().elapsedTime(OFFER_DELAY_MS)) {
    event.handled = true;
    return;
  }
  const inventory = player.getInventory();
  if (inventory.get(slot)?.getId() !== itemId) {
    event.handled = true;
    return;
  }
  const xp = Math.floor(experience(bone.xp, 1) * multiplier);
  player.getSkillManager().stopSkillable();
  player.getPacketSender().sendInterfaceRemoval();
  player.performAnimation(new core.Animation(BURY_ANIMATION));
  core.Sounds.sendSound(player, core.Sound.BURY_BONES);
  const location = at.clone();
  // Consume and award XP together on the resolving tick, as buryBone does:
  // an interrupted offering keeps its bone.
  const task = new core.CountdownTask(player, 2, () => {
    if (!canComplete() || inventory.get(slot)?.getId() !== itemId) return;
    inventory.deleteAtSlot(slot, 1);
    const boneName = core.ItemDefinition.forId(itemId).getName();
    if (altarName === "Gilded altar") {
      player.sendMessage(`You offer the ${boneName} at the gilded altar.`);
      player.sendMessage("The gods are pleased with your offering.");
    } else {
      player.sendMessage(`You offer the ${boneName} at the altar.`);
    }
    player.getSkillManager().addExperiences(core.Skill.PRAYER, xp);
  });
  function canComplete() {
    return player.isRegistered() && player.getHitpoints() > 0 &&
      player.getLocation().equals(location) && player.getMovementQueue().size() === 0 &&
      player.getForceMovement() == null;
  }
  task.onTick = () => { if (!canComplete()) task.stop(); };
  const stop = task.stop.bind(task);
  task.stop = () => {
    stop();
    if (player.isRegistered()) player.performAnimation(core.Animation.DEFAULT_RESET_ANIMATION);
  };
  api.getTaskManager().submit(task);
  player.getClickDelay().reset();
  event.handled = true;
}

const BURY_DELAY_MS = 1200; // Two OSRS game ticks.
const BURY_ANIMATION = 827; // human_pickupfloor
// Scattering as live OSRS sends it (rsprox captures, docs/prayer-bones.md): no spotanim.
const SCATTER_ANIMATION = 2295; // farming_ingredient_sprinkle
const SCATTER_SOUND = 2444; // farming_sprinkle

let api = null;
let bones = null;
let ashes = null;
const burials = new WeakMap();

/**
 * world.json `pluginConfig` `"Prayer:sequentialBurying": true` (overridable in world.local.json)
 * makes one Bury click continue through the inventory's bones (docs/prayer-bones.md). Off by
 * default: one bone per click, as OSRS.
 */
const SEQUENTIAL_CONFIG = "Prayer:sequentialBurying";
const sequentialBurying = () => api.getPluginConfig(SEQUENTIAL_CONFIG, false) === true;

/** Rows keyed by item id, resolved from their obj gamevals on first use. */
function rowsByItemId(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = api.core.CacheDefinitions.getObjId(row.obj);
    if (!Number.isInteger(id)) throw new Error(`[Prayer] unknown obj gameval ${row.obj}`);
    map.set(id, row);
  }
  return map;
}

/** The bone rows by item id. */
function boneFor(itemId) {
  if (!bones) bones = rowsByItemId(DATA.bones);
  return bones.get(itemId) ?? null;
}

/** The demonic ash rows by item id. */
function ashFor(itemId) {
  if (!ashes) ashes = rowsByItemId(ASHES.ashes);
  return ashes.get(itemId) ?? null;
}

/** Experience is whole in tsps; a bone's tenths round up, as the old table did (bones 4.5 -> 5). */
const experience = (xp, scale) => Math.ceil(xp * scale);

function restorePrayer(player, itemId, bone) {
  if (!bone.restore) return;
  const event = { player, itemId, points: bone.restore, restore: 0 };
  api.emitCustomEvent("prayer:bone-restore", event);
  if (event.restore <= 0) return;
  const { Skill } = api.core;
  const skills = player.getSkillManager();
  const max = skills.getMaxLevel(Skill.PRAYER);
  if (skills.getCurrentLevel(Skill.PRAYER) >= max) return;
  skills.increaseCurrentLevel(Skill.PRAYER, event.restore, max);
}

function award(player, itemId, bone, scale) {
  player.getSkillManager().addExperiences(api.core.Skill.PRAYER, experience(bone.xp, scale));
  restorePrayer(player, itemId, bone);
}

/** "prayer:bury": a bone buried without the spade (the bonecrusher). */
function buryRequest(request) {
  const bone = boneFor(request?.itemId);
  if (!bone || !request.player) return;
  if (request.crushed && bone.crush === false) return;
  award(request.player, request.itemId, bone, request.scale ?? 1);
  request.handled = true;
}

/** "prayer:bone": the bone's row for `itemId`. */
function boneRequest(request) {
  if (request) request.bone = boneFor(request.itemId);
}

function stopBurial({ player }) {
  burials.get(player)?.stop();
}

function interruptBurialForItem(event) {
  // Merely calculating worn-item bonuses is not a player action.
  if (event.action !== "bonus") stopBurial(event);
}

function buryBone({ player, itemId, slot }) {
  const core = api.core;
  const bone = boneFor(itemId);
  if (!bone) return false;
  if (!player.getClickDelay().elapsedTime(BURY_DELAY_MS)) return true;
  const inventory = player.getInventory();
  if (inventory.get(slot)?.getId() !== itemId) return true;
  if (bone.level && player.getSkillManager().getMaxLevel(core.Skill.PRAYER) < bone.level) {
    player.sendMessage(`You need a Prayer level of ${bone.level} to bury these bones.`);
    return true;
  }
  if (sequentialBurying()) burySequence(player, itemId, slot, bone);
  else buryOnce(player, itemId, slot, bone);
  return true;
}

/** Still online, alive and standing where the burial started. */
function stillBurying(player, location) {
  return player.isRegistered() && player.getHitpoints() > 0 &&
    player.getLocation().equals(location) && player.getMovementQueue().size() === 0 &&
    player.getForceMovement() == null;
}

/** Consumes the bone at `slot` with its messages and experience; false when it is no longer there. */
function resolveBurial(player, itemId, slot, bone) {
  const inventory = player.getInventory();
  if (inventory.get(slot)?.getId() !== itemId) return false;
  inventory.deleteAtSlot(slot, 1);
  player.sendMessage("You dig a hole in the ground..");
  player.sendMessage(`..and bury the ${api.core.ItemDefinition.forId(itemId).getName()}.`);
  award(player, itemId, bone, 1);
  return true;
}

/** One bone per Bury click, as OSRS (the default). */
function buryOnce(player, itemId, slot, bone) {
  const core = api.core;
  player.getSkillManager().stopSkillable();
  player.getPacketSender().sendInterfaceRemoval();
  player.performAnimation(new core.Animation(BURY_ANIMATION));
  core.Sounds.sendSound(player, core.Sound.BURY_BONES);
  const location = player.getLocation().clone();
  // Consume and award XP together on the resolving tick. An interrupted burial
  // keeps its bone, including on logout before the account is saved.
  const task = new core.CountdownTask(player, 2, () => {
    if (stillBurying(player, location)) resolveBurial(player, itemId, slot, bone);
  });
  task.onTick = () => { if (!stillBurying(player, location)) task.stop(); };
  const stop = task.stop.bind(task);
  task.stop = () => {
    stop();
    if (player.isRegistered()) player.performAnimation(core.Animation.DEFAULT_RESET_ANIMATION);
  };
  api.getTaskManager().submit(task);
  player.getClickDelay().reset();
}

/**
 * With `Prayer:sequentialBurying`: the clicked bone, then every eligible bone left in the
 * inventory in slot order, one every two ticks, until the player does anything else.
 */
function burySequence(player, itemId, slot, bone) {
  const core = api.core;
  const inventory = player.getInventory();
  stopBurial({ player });
  player.getSkillManager().stopSkillable();
  player.getPacketSender().sendInterfaceRemoval();
  const location = player.getLocation().clone();
  // Consume and award XP together on the resolving tick. An interrupted burial
  // keeps its bone, including on logout before the account is saved.
  const task = new (class extends core.Task {
    constructor() { super(2, player, false); }
    execute() {
      if (!canComplete() || !resolveBurial(player, itemId, slot, bone)) return this.stop();
      // Awarding XP can open a level-up popup and cancel this sequence.
      if (!this.isRunning() || !canComplete()) return this.stop();
      const next = inventory.getItems().findIndex(item => {
        if (!item || item.getAmount() <= 0) return false;
        if (!core.WorldDefinition.isMembersWorld() && core.CacheDefinitions.getItem(item.getId()).isMembers) return false;
        const row = boneFor(item.getId());
        return row && (!row.level || player.getSkillManager().getMaxLevel(core.Skill.PRAYER) >= row.level);
      });
      if (next < 0) return this.stop();
      slot = next;
      itemId = inventory.get(slot).getId();
      bone = boneFor(itemId);
      animate();
    }
    onTick() { if (!canComplete()) this.stop(); }
    stop() {
      super.stop();
      if (burials.get(player) !== this) return;
      burials.delete(player);
      if (player.getSkill() === action) {
        player.setSkill(null);
        if (player.isRegistered()) player.performAnimation(core.Animation.DEFAULT_RESET_ANIMATION);
      }
    }
  })();
  // Register as a cancellable skilling action so ordinary interactions can stop it.
  const action = { cancel: () => task.stop() };
  function canComplete() {
    return stillBurying(player, location) && player.getSkill() === action;
  }
  function animate() {
    player.performAnimation(new core.Animation(BURY_ANIMATION));
    core.Sounds.sendSound(player, core.Sound.BURY_BONES);
    player.getClickDelay().reset();
  }
  burials.set(player, task);
  player.setSkill(action);
  animate();
  api.getTaskManager().submit(task);
}

/**
 * "Scatter" on demonic ashes: Prayer experience, no restore (Wiki, Remains). Unlike burying, it
 * resolves on the tick it is clicked: live OSRS removes the ash and sends the experience, the
 * message, the sequence and the synth together.
 */
function scatterAshes({ player, itemId, slot }) {
  const core = api.core;
  const ash = ashFor(itemId);
  if (!ash) return false;
  // Burying's two-tick click delay; the captures only show scatters three or more ticks apart.
  if (!player.getClickDelay().elapsedTime(BURY_DELAY_MS)) return true;
  const inventory = player.getInventory();
  if (inventory.get(slot)?.getId() !== itemId) return true;

  player.getSkillManager().stopSkillable();
  player.getPacketSender().sendInterfaceRemoval();
  inventory.deleteAtSlot(slot, 1);
  player.performAnimation(new core.Animation(SCATTER_ANIMATION));
  core.Sounds.sendSound(player, new core.Sound(SCATTER_SOUND, 1, 0, 0));
  player.sendMessage("You scatter the ashes.");
  player.getSkillManager().addExperiences(core.Skill.PRAYER, ash.xp);
  player.getClickDelay().reset();
  return true;
}

module.exports = {
  name: "Prayer",
  register(pluginApi) {
    api = pluginApi;
    api.onItemFirstAction(buryBone);
    api.onItemFirstAction(scatterAshes);
    api.onCustomEvent("prayer:bury", buryRequest);
    api.onCustomEvent("prayer:bone", boneRequest);
    // Guarded: some upstream test mocks provide no onItemOnObject.
    if (typeof api.onItemOnObject === "function") {
      api.onItemOnObject(offerBone, { noted: false });
    }
    api.onCanUseItem(interruptBurialForItem);
    api.onPlayerLogout(stopBurial);
    api.onPlayerDisconnect(stopBurial);
    api.onPlayerDeath(stopBurial);
    api.onCustomEvent("level-up:popup-opened", stopBurial);
  },
};
