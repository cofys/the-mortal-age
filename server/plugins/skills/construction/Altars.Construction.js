"use strict";

const { Animation, Skill, ItemIdentifiers, ArceuusOfferings, World } = require("./Core.Construction");
const Ids = require("./Ids.Construction");
const Instance = require("./Instance.Construction");
const ALTAR_BONUS = { OAK_ALTAR: 1, TEAK_ALTAR: 1.1, CLOTH_ALTAR: 1.25, MAHOGANY_ALTAR: 1.5, LIMESTONE_ALTAR: 1.75, MARBLE_ALTAR: 2, GILDED_ALTAR: 2.5 };
const BURNERS = new Set(["INCENSE_BURNER", "MAHOGANY_BURNER", "MARBLE_BURNER"]);

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

function offerHouseBones(event) {
  const { player } = event;
  const house = player.getPrivateArea();
  if (!(house instanceof Instance.PlayerHouseInstance)) return false;
  const furniture = house.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
  const multiplier = furniture && ALTAR_BONUS[furniture.buildableKey];
  const xp = ArceuusOfferings.BONE_XP.get(event.itemId);
  if (!multiplier || !xp) return false;
  if (!player.getClickDelay().elapsedTime(1800)) return true;
  const inventory = player.getInventory();
  if (inventory.getItems()[event.itemSlot]?.getId() !== event.itemId || inventory.getAmount(event.itemId) < 1) return true;
  const room = house.getRoom(house.getRoomPositionAt(event.location));
  const lit = Object.values(room?.furnitureByLocation ?? {}).filter(value => BURNERS.has(value.buildableKey) && (house.litBurners.get(value) ?? 0) > World.getProcessCycle()).length;
  inventory.delete(event.itemId, 1);
  player.performAnimation(new Animation(Ids.seq("human_bone_sacrifice")));
  player.getSkillManager().addExperiences(Skill.PRAYER, xp * (multiplier + Math.min(2, lit) * 0.5));
  player.getClickDelay().reset();
  return true;
}

Object.assign(module.exports, { lightHouseBurner, expireHouseBurners, offerHouseBones });
