/**
 * Trimming (Wiki: Cape of Accomplishment, "Trimmed"): a player's first skillcape is untrimmed;
 * once they reach 99 in a second skill, every untrimmed skillcape they own - carried, worn or
 * banked - becomes trimmed, and so does any they pick up later. The Quest point, Achievement
 * diary and Music capes trim by their own option and are left alone.
 */
const Capes = require("./Common.SkillCapes");

const TRIMMED_BY_ID = new Map();

function buildTrims() {
  TRIMMED_BY_ID.clear();
  for (const cape of Capes.CAPES) {
    TRIMMED_BY_ID.set(cape.cape, cape.trimmed);
    if (cape.worn !== null && cape.trimmedWorn !== null) TRIMMED_BY_ID.set(cape.worn, cape.trimmedWorn);
  }
}

function trimIn(items) {
  let changed = false;
  for (const item of items) {
    const id = item?.getId?.() ?? -1;
    if (TRIMMED_BY_ID.has(id)) {
      item.setId(TRIMMED_BY_ID.get(id));
      changed = true;
    }
  }
  return changed;
}

/** Trims every skillcape the player owns; nothing until they have two 99s. */
function trimOwned(player) {
  if (Capes.count99s(player) < 2) return;
  if (trimIn(player.getInventory().getItems())) player.getInventory().refreshItems();
  if (trimIn(player.getEquipment().getItems())) player.getEquipment().refreshItems();
  for (const bank of player.getBanks()) {
    if (bank) trimIn(bank.getItems());
  }
}

function trimOnLevelUp({ player, oldLevel, newLevel }) {
  if (oldLevel < Capes.MAX_LEVEL && newLevel >= Capes.MAX_LEVEL) trimOwned(player);
}

function trimOnLogin({ player }) {
  trimOwned(player);
}

/** An untrimmed cape picked up by a player with two 99s comes up trimmed. */
function trimOnPickup({ player, groundItem }) {
  const item = groundItem?.getItem?.();
  if (!item || !TRIMMED_BY_ID.has(item.getId()) || Capes.count99s(player) < 2) return;
  item.setId(TRIMMED_BY_ID.get(item.getId()));
}

module.exports = function attachTrimming(api) {
  buildTrims();
  api.onPlayerLevelUp(trimOnLevelUp);
  api.onPlayerLogin(trimOnLogin);
  api.onGroundItemPickup(trimOnPickup);
};

module.exports._test = { TRIMMED_BY_ID, trimOwned, trimOnLevelUp, trimOnPickup };
