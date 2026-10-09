"use strict";

/**
 * ItemWear — equipment durability, breakage and repair.
 *
 * Every worn weapon/armour piece has 1000 durability (tracked in item meta;
 * items that predate this system default to full). Combat wears gear down:
 * weapons on landed hits, armour on hits taken. Higher crafting quality
 * (see CraftingQuality.plugin.js) degrades slower.
 *
 * At 0 durability the piece is broken: it stays equipped but grants no
 * bonuses, and cannot be re-equipped once removed. Repair paths:
 *   - Anvil (item on anvil): free self-repair with a hammer if your Smithing
 *     meets the metal's level; otherwise the local smith offers paid repair.
 *   - Smith NPCs (Bob, Dunstan, ...): paid repair-all, via economy/Repair.Economy.js
 *     (registered earlier in plugin load order so it can defer to Barrows).
 *
 * Items owned by bespoke degradation systems (barrows, crystal charges) are
 * skipped — detected by their meta keys, so no double-degradation.
 *
 * Pure logic lives in ./lib/item-wear.js (plain-node testable). This file is
 * the plugin-API wiring, following the attach() pattern for tests.
 */

const wear = require("./lib/item-wear");

let core = null;
let BonusManager = null;
let pluginApi = null;
let rng = Math.random;

const ARMOUR_SLOTS = [0, 4, 5, 7, 9, 10]; // head, body, shield, legs, hands, feet

function equippedWeapon(player) {
  try {
    return player.getEquipment().get(core.Equipment.WEAPON_SLOT);
  } catch {
    return null;
  }
}

function wornArmourPieces(player) {
  const pieces = [];
  try {
    const equipment = player.getEquipment();
    for (const slot of ARMOUR_SLOTS) {
      const item = equipment.get(slot);
      if (wear.isWearable(item)) pieces.push(item);
    }
  } catch {
    // ignore
  }
  return pieces;
}

function refresh(player) {
  try {
    player.getInventory().refreshItems();
    player.getEquipment().refreshItems();
    BonusManager?.update(player);
  } catch {
    // ignore
  }
}

/** Degrade one item by a single point, warning/breaking as thresholds hit. */
function degrade(player, item) {
  const before = wear.getDurability(item);
  if (before <= 0) return false;
  // Fine/Superior craftsmanship holds up longer.
  if (rng() < wear.QUALITY_WEAR_SKIP[wear.getQuality(item)]) return false;
  const after = wear.setDurability(item, before - 1);
  const name = wear.itemName(item);
  for (const threshold of wear.WARN_THRESHOLDS) {
    if (
      before / wear.MAX_DURABILITY > threshold &&
      after / wear.MAX_DURABILITY <= threshold
    ) {
      const pct = Math.round((after / wear.MAX_DURABILITY) * 100);
      player.sendMessage(`Your ${name} is wearing down (${pct}% durability left).`);
      break;
    }
  }
  if (after <= 0) {
    player.sendMessage(
      `Your ${name} has broken! Repair it at an anvil or pay a smith to fix it.`
    );
  }
  refresh(player);
  return after <= 0;
}

function onHitResolved({ attacker, target, hit }) {
  if (!hit?.getHandleAfterHitEffects?.() || !hit?.isAccurate?.()) return;
  const playerAttacker = attacker?.isPlayer?.() ? attacker.getAsPlayer() : null;
  if (playerAttacker) {
    const weapon = equippedWeapon(playerAttacker);
    if (wear.isWearable(weapon)) degrade(playerAttacker, weapon);
  }
  const playerTarget = target?.isPlayer?.() ? target.getAsPlayer() : null;
  const damage = Number(hit?.getTotalDamage?.()) || 0;
  if (playerTarget && damage > 0) {
    const pieces = wornArmourPieces(playerTarget);
    if (pieces.length > 0) {
      degrade(playerTarget, pieces[Math.floor(rng() * pieces.length)]);
    }
  }
}

function onCanEquip(event) {
  if (wear.isBroken(event?.item)) {
    event.allow = false;
    event.player?.sendMessage?.(
      `Your ${wear.itemName(event.item)} is broken and must be repaired before you can wear it.`
    );
  }
}

/** Broken gear stays equipped but grants nothing until repaired. */
function applyBrokenPenalty({ player, bonuses }) {
  if (!bonuses || !player) return;
  for (const item of player.getEquipment().getItems()) {
    if (!wear.isBroken(item)) continue;
    let base = [];
    try {
      base = item.getDefinition().getBonuses() || [];
    } catch {
      continue;
    }
    const n = Math.min(bonuses.length, base.length);
    for (let i = 0; i < n; i++) bonuses[i] -= Number(base[i]) || 0;
  }
}

function findDamagedWearable(player, itemId) {
  let best = null;
  let bestDurability = wear.MAX_DURABILITY;
  try {
    for (const item of player.getInventory().getItems()) {
      if (!item || item.getId() !== itemId || !wear.isWearable(item)) continue;
      const durability = wear.getDurability(item);
      if (durability < bestDurability) {
        best = item;
        bestDurability = durability;
      }
    }
  } catch {
    // ignore
  }
  return bestDurability < wear.MAX_DURABILITY ? best : null;
}

function getSmithingLevel(player) {
  try {
    return player.getSkillManager().getCurrentLevel(core.Skill.SMITHING);
  } catch {
    return 1;
  }
}

/**
 * Item-on-anvil: free self-repair for smiths, paid repair via the local smith
 * for everyone else. Runs before Smithing.plugin's handler (I < S); non-wear
 * items (bars) fall through untouched.
 */
function repairOnAnvil(event) {
  const { player, object, itemId } = event;
  let objectName = "";
  try {
    objectName = object.getDefinition().getName();
  } catch {
    return;
  }
  if (objectName !== "Anvil") return;
  const item = findDamagedWearable(player, itemId);
  if (!item) return; // e.g. bars — Smithing.plugin handles those
  const name = wear.itemName(item);
  const required = wear.smithingLevelFor(item);
  const level = getSmithingLevel(player);
  if (level >= required) {
    let hasHammer = false;
    try {
      hasHammer = player.getInventory().contains(core.ItemIds.HAMMER);
    } catch {
      // ignore
    }
    if (!hasHammer) {
      player.sendMessage("You need a hammer to repair equipment yourself.");
      event.handled = true;
      return;
    }
    wear.setDurability(item, wear.MAX_DURABILITY);
    refresh(player);
    player.sendMessage(`You repair your ${name} back to pristine condition.`);
    event.handled = true;
    return;
  }
  const cost = wear.repairCost(item);
  const coins = (() => {
    try {
      return player.getInventory().getAmount(995);
    } catch {
      return 0;
    }
  })();
  const prompt =
    `You need ${required} Smithing to repair this yourself. ` +
    `Pay the local smith ${cost.toLocaleString("en-US")} coins to repair your ${name}?`;
  const doPaidRepair = () => {
    let balance = 0;
    try {
      balance = player.getInventory().getAmount(995);
    } catch {
      balance = 0;
    }
    if (balance < cost) {
      player.sendMessage(
        `You need ${cost.toLocaleString("en-US")} coins for the repair.`
      );
      return;
    }
    player.getInventory().deleteNumber(995, cost);
    wear.setDurability(item, wear.MAX_DURABILITY);
    refresh(player);
    player.sendMessage(
      `The smith repairs your ${name} for ${cost.toLocaleString("en-US")} coins.`
    );
  };
  if (coins < cost) {
    player.sendMessage(
      `You need ${required} Smithing to repair this yourself, or ${cost.toLocaleString("en-US")} coins for the smith.`
    );
    event.handled = true;
    return;
  }
  try {
    pluginApi.sendMultiChatboxPrompt(player, prompt, "Pay", doPaidRepair, "Cancel", () => {});
  } catch {
    doPaidRepair();
  }
  event.handled = true;
}

function attach(api) {
  core = api.core;
  pluginApi = api;
  try {
    BonusManager = api.getBonusManager();
  } catch {
    BonusManager = null;
  }
  api.onCombatHitResolved(onHitResolved);
  api.onCanEquip(onCanEquip);
  api.onItemOnObject(repairOnAnvil, { noted: false });
  api.registerBonusProvider({ apply: applyBrokenPenalty });
}

module.exports = {
  name: "ItemWear",
  attach,
  register(api) {
    attach(api);
  },
  _test: {
    onHitResolved,
    onCanEquip,
    repairOnAnvil,
    applyBrokenPenalty,
    degrade,
    setRng: (next) => {
      rng = next;
    },
  },
};
