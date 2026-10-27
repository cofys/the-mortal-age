"use strict";

const { api, Animation, Skill, ItemIdentifiers, World } = require("./Core.Construction");
const Ids = require("./Ids.Construction");
const Instance = require("./Instance.Construction");
const ALTAR_BONUS = { OAK_ALTAR: 1, TEAK_ALTAR: 1.1, CLOTH_ALTAR: 1.25, MAHOGANY_ALTAR: 1.5, LIMESTONE_ALTAR: 1.75, MARBLE_ALTAR: 2, GILDED_ALTAR: 2.5 };
const BURNERS = new Set(["INCENSE_BURNER", "MAHOGANY_BURNER", "MARBLE_BURNER"]);
// The offering's message by burners lit: none as captured (rsprox 2850), one and two as on the
// Wiki's Gilded altar page and in rsprox 86 and 572.
const OFFERING_MESSAGES = [
  "The gods accept your offering.",
  "The gods are pleased with your offering.",
  "The gods are very pleased with your offering.",
];

function lightHouseBurner(event) {
  const { player } = event;
  const house = player.getPrivateArea();
  if (!(house instanceof Instance.PlayerHouseInstance)) return false;
  const furniture = house.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
  if (!furniture || !BURNERS.has(furniture.buildableKey)) return false;
  const level = player.getSkillManager().getCurrentLevel(Skill.FIREMAKING);
  if (level < 30) { player.sendMessage("You need Firemaking level 30 to light incense."); return true; }
  const inventory = player.getInventory();
  if (!inventory.contains(ItemIdentifiers.TINDERBOX) || !inventory.contains(ItemIdentifiers.MARRENTILL)) { player.sendMessage("You need a tinderbox and a clean marrentill herb."); return true; }
  if (!player.getClickDelay().elapsedTime(1200)) return true;
  inventory.delete(ItemIdentifiers.MARRENTILL, 1);
  house.litBurners.set(furniture, World.getProcessCycle() + 200 + level + Math.floor(Math.random() * level));
  player.performAnimation(new Animation(Ids.seq("human_light_torch")));
  player.getSkillManager().addExperiences(Skill.FIREMAKING, 50);
  player.getClickDelay().reset();
  house.redrawFurniture();
  return true;
}

function expireHouseBurners(house, now = World.getProcessCycle()) {
  let changed = false;
  for (const [furniture, until] of house.litBurners) if (until <= now) {
    house.litBurners.delete(furniture);
    changed = true;
  }
  if (changed) house.redrawFurniture();
}

/** Burners lit in the altar's room, each adding 50% (Wiki: Chapel). */
function litBurners(house, location) {
  const room = house.getRoom(house.getRoomPositionAt(location));
  const now = World.getProcessCycle();
  return Math.min(2, Object.values(room?.furnitureByLocation ?? {})
    .filter(value => BURNERS.has(value.buildableKey) && (house.litBurners.get(value) ?? 0) > now).length);
}

/**
 * The house altar's part of each offering, asked again for every bone so a burner going out
 * mid-batch counts at once: the altar's bonus (Wiki: Chapel) plus 50% a lit burner, or null once
 * the player has left the house or the altar is gone.
 */
function houseBlessing(player, house, event) {
  return (bone) => {
    if (player.getPrivateArea() !== house) return null;
    const furniture = house.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
    const multiplier = furniture && ALTAR_BONUS[furniture.buildableKey];
    if (!multiplier) return null;
    const lit = litBurners(house, event.location);
    return { experience: bone.xp * (multiplier + lit * 0.5), message: OFFERING_MESSAGES[lit] };
  };
}

/** Bones on a house altar: offered by BoneAltars' loop, as on the Chaos Temple's altar. */
function offerHouseBones(event) {
  const { player } = event;
  const house = player.getPrivateArea();
  if (!(house instanceof Instance.PlayerHouseInstance)) return false;
  const furniture = house.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
  if (!furniture || !ALTAR_BONUS[furniture.buildableKey]) return false;
  const request = { player, object: event.object, itemId: event.itemId, altar: { blessing: houseBlessing(player, house, event) }, handled: false };
  api.emitCustomEvent("bone-altars:offer", request);
  return request.handled;
}

Object.assign(module.exports, { lightHouseBurner, expireHouseBurners, offerHouseBones });
