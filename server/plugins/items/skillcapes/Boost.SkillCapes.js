/**
 * Boost (Wiki: Cape of Accomplishment): putting a skillcape on, or its worn Boost option, raises
 * the skill by 1 (to 100) for up to a minute, decaying as any other boost does. It cannot be
 * used again until the skill is back to 99. The Hitpoints and Prayer capes boost at most once
 * a minute (rsprox captures: "Your Skillcape of Hitpoints can only provide a hitpoint boost once
 * per minute." on wearing it again). The max cape has no boost.
 */
const Capes = require("./Common.SkillCapes");

const BOOSTED_LEVEL = 100;
const COOLDOWN_TICKS = 100;
const COOLDOWN_MESSAGES = {
  HITPOINTS: "Your Skillcape of Hitpoints can only provide a hitpoint boost once per minute.",
  PRAYER: "Your Skillcape of Prayer can only provide a prayer boost once per minute.",
};

const lastBoost = new WeakMap();
const wornCape = new WeakMap();

function boost(player, cape) {
  const skills = player.getSkillManager();
  if (Capes.baseLevel(player, cape.skill) < Capes.MAX_LEVEL) return;
  if (skills.getCurrentLevel(cape.skill) > Capes.MAX_LEVEL) return;
  const cooldown = COOLDOWN_MESSAGES[cape.skillKey];
  if (cooldown) {
    const boosts = lastBoost.get(player) ?? {};
    const now = Capes.core.World.getProcessCycle();
    const last = boosts[cape.skillKey];
    if (last !== undefined && now - last < COOLDOWN_TICKS) {
      player.sendMessage(cooldown);
      return;
    }
    lastBoost.set(player, { ...boosts, [cape.skillKey]: now });
  }
  skills.setCurrentLevel(cape.skill, Math.min(BOOSTED_LEVEL, skills.getCurrentLevel(cape.skill) + 1), true);
}

function boostOption(event) {
  const cape = Capes.CAPE_BY_ITEM.get(event.itemId);
  if (!cape || event.interfaceId !== Capes.core.Equipment.INVENTORY_INTERFACE_ID) return;
  if (Capes.itemOption(event).option !== "Boost") return;
  event.handled = true;
  boost(event.player, cape);
}

/** A skillcape just put on boosts its skill. */
function boostOnWear({ player }) {
  const id = Capes.capeSlotId(player);
  const previous = wornCape.get(player);
  wornCape.set(player, id);
  if (previous === undefined || previous === id) return;
  const cape = Capes.CAPE_BY_ITEM.get(id);
  // The Agility and max capes swap to their worn ids as they go on; only the first change counts.
  if (cape && Capes.CAPE_BY_ITEM.get(previous) !== cape) boost(player, cape);
}

function rememberOnLogin({ player }) {
  wornCape.set(player, Capes.capeSlotId(player));
}

module.exports = function attachBoost(api) {
  api.onItemAction(boostOption);
  api.onCustomEvent("equipment:changed", boostOnWear);
  api.onPlayerLogin(rememberOnLogin);
};

module.exports._test = { boost, boostOption, boostOnWear, lastBoost };
