"use strict";

/**
 * The island shrines that cook harpoonfish. Captures: Cook-at plays `human_cooking` with sound
 * 2577 and every 3 ticks "You successfully cook a harpoonfish." (+10 points). Wiki: no burning,
 * 10 Cooking XP a fish, 3 ticks each.
 */

const Shared = require("./Shared.Tempoross");
const { coveOf } = require("./Cove.Tempoross");
const { untetherFor } = require("./Tethers.Tempoross");

const { DATA, ITEM, ANIM, SOUND } = Shared;

const COOKING_XP = 10;

function cook(event) {
  const { player, object } = event;
  const cove = coveOf(player);
  if (!cove?.fight || !cove.contains(object.getLocation())) return false;
  untetherFor(player);
  if (!player.getInventory().contains(ITEM.RAW)) {
    player.sendMessage("You have no raw harpoonfish to cook.");
    return true;
  }
  const fight = cove.fight;
  player.setPositionToFace(object.getLocation().transform(1, 1, 0));
  Shared.animate(player, ANIM.COOK);
  player.getPacketSender().sendSound(SOUND.COOK, 100, 0);
  Shared.startAction(player, "cook", (ticks) => {
    if (ticks % DATA.ticks.cook !== 0) return true;
    const inventory = player.getInventory();
    if (!inventory.contains(ITEM.RAW)) return false;
    inventory.delete(ITEM.RAW, 1);
    inventory.adds(ITEM.COOKED, 1);
    inventory.refreshItems();
    player.sendMessage("You successfully cook a harpoonfish.");
    Shared.addXp(player, "COOKING", COOKING_XP);
    fight.addPoints(player, DATA.points.cook);
    if (!inventory.contains(ITEM.RAW)) return false;
    Shared.animate(player, ANIM.COOK);
    player.getPacketSender().sendSound(SOUND.COOK, 100, 0);
    return true;
  });
  return true;
}

function attachShrine(api) {
  api.onObjectInteraction("Shrine", { "Cook-at": cook });
  api.onItemOnObject("Raw harpoonfish", "Shrine", cook, { noted: false });
}

module.exports = { attachShrine };
