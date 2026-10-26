/**
 * Offering bones on an altar (docs/bone-altars.md), from plugins/skills/data/bone-altars.json:
 * the Chaos Temple's altar in level 38 Wilderness gives 3.5 times the bones' burying experience,
 * and half its offerings keep the bone (Wiki). Bones are taken from the top-left of the
 * inventory, not the slot used (Wiki, 22 February 2023), and the offering repeats every 4 ticks
 * while that kind of bone lasts, as captured on a house altar. The bones and their experience
 * come from the Prayer plugin ("prayer:bone").
 */
const DATA = require("./data/bone-altars.json");
const { pauseForLevelUp } = require("./SkillActions");

let api = null;
let core = null;
let ids = null;

/** The gamevals in the data file, resolved on first use. */
function resolved() {
  if (ids) return ids;
  const { CacheDefinitions } = core;
  const id = (kind, name, lookup) => {
    const value = lookup(name);
    if (!Number.isInteger(value)) throw new Error(`[BoneAltars] unknown ${kind} gameval ${name}`);
    return value;
  };
  ids = {
    seq: id("seq", DATA.seq, (name) => CacheDefinitions.getSeqId(name)),
    spotanim: id("spotanim", DATA.spotanim, (name) => CacheDefinitions.getSpotanimId(name)),
    zealot: new Set(DATA.zealot.pieces.map((name) => id("obj", name, (n) => CacheDefinitions.getObjId(n)))),
    altars: DATA.altars.map((altar) => ({ ...altar, id: id("loc", altar.loc, (name) => CacheDefinitions.getLocId(name)) })),
  };
  return ids;
}

function altarAt(objectId, location) {
  return resolved().altars.find((altar) => altar.id === objectId &&
    altar.x === location.x && altar.y === location.y && altar.z === location.z) ?? null;
}

function boneFor(itemId) {
  const request = { itemId, bone: null };
  api.emitCustomEvent("prayer:bone", request);
  return request.bone;
}

function zealotPieces(player) {
  const worn = new Set(player.getEquipment().getItems().map((item) => item?.getId?.() ?? -1));
  return [...resolved().zealot].filter((id) => worn.has(id)).length;
}

/** The altar keeps the bone, or failing that the Zealot's robes do (Wiki: two rolls). */
function spared(player, altar) {
  if (Math.random() < altar.spareChance) return "altar";
  return Math.random() < zealotPieces(player) * DATA.zealot.chancePerPiece ? "robes" : null;
}

/** The altar's tile nearest the player, where the captured offering graphic plays. */
function graphicTile(player, object) {
  const location = object.getLocation();
  const definition = object.getDefinition?.();
  const turned = (object.getFace?.() ?? 0) % 2 === 1;
  const sizeX = (turned ? definition?.sizeY : definition?.sizeX) ?? 1;
  const sizeY = (turned ? definition?.sizeX : definition?.sizeY) ?? 1;
  const at = player.getLocation();
  const clamp = (value, low, size) => Math.max(low, Math.min(low + size - 1, value));
  return new core.Location(clamp(at.getX(), location.getX(), sizeX), clamp(at.getY(), location.getY(), sizeY), location.getZ());
}

/** One offering of the first `boneId` carried; false when there is none left. */
function offer(player, object, altar, boneId, bone) {
  const inventory = player.getInventory();
  const slot = inventory.getSlotForItemId(boneId);
  if (slot < 0) return false;
  const kept = spared(player, altar);
  if (!kept) inventory.deleteAtSlot(slot, 1);
  const message = kept === "altar" ? altar.spareMessage : DATA.message;
  player.getPacketSender().sendTypedMessage(core.ChatType.SPAM, message);
  // Experience first: a level-up pop-up resets the player's animation, and this offering's
  // animation still plays over it.
  player.getSkillManager().addExperiences(core.Skill.PRAYER, Math.ceil(bone.xp * altar.xpScale));
  const tile = graphicTile(player, object);
  const { seq, spotanim } = resolved();
  player.setPositionToFace(tile);
  player.performAnimation(new core.Animation(seq));
  player.getPacketSender().sendSound(DATA.sound, 1, 0).sendGlobalGraphic(new core.Graphic(spotanim), tile);
  return true;
}

/** Each player's repeating offering, retained while the level-up dialogue is open. */
const offerings = new WeakMap();

/**
 * Offers every `intervalTicks` from the next one, keyed to the player so a walk or click stops
 * it; a level-up pop-up pauses it, as it does other skilling (docs/settings.md).
 */
function keepOffering(player, object, altar, boneId, bone) {
  let tick = 0;
  const task = new (class extends core.Task {
    constructor() { super(1, player.getIndex(), false); }
    execute() {
      if (!player.isRegistered() || player.getHitpoints() <= 0) return this.stop();
      if (this.levelUpPaused) return;
      if (++tick % DATA.intervalTicks !== 0) return;
      if (!offer(player, object, altar, boneId, bone)) this.stop();
    }
  })();
  offerings.set(player, task);
  core.TaskManager.submit(task);
}

function stopOffering({ player }) {
  offerings.get(player)?.stop();
  offerings.delete(player);
}

function pauseOffering(event) {
  pauseForLevelUp(event, offerings, (player) => stopOffering({ player }));
}

function useBoneOnAltar(event) {
  const { player, object, objectId, itemId, location } = event;
  const altar = altarAt(objectId, location);
  if (!altar) return;
  const bone = boneFor(itemId);
  if (!bone) return;
  event.handled = true;
  if (bone.level && player.getSkillManager().getMaxLevel(core.Skill.PRAYER) < bone.level) {
    player.sendMessage(`You need a Prayer level of ${bone.level} to offer these bones.`);
    return;
  }
  stopOffering({ player });
  // Register the loop before the immediate offering so its first XP drop can pause it too.
  keepOffering(player, object, altar, itemId, bone);
  if (!offer(player, object, altar, itemId, bone)) stopOffering({ player });
}

module.exports = {
  name: "BoneAltars",
  members: true,
  _test: { altarAt, spared, zealotPieces, graphicTile },
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    api.onItemOnObject(useBoneOnAltar, { noted: false });
    api.onCustomEvent("level-up:popup-opened", pauseOffering);
  },
};
