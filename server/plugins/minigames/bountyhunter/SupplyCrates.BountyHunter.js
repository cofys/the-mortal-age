"use strict";

/**
 * Bounty supply crates (https://oldschool.runescape.wiki/w/Bounty_supply_crate and its two item
 * pages). The crate in Fort Daimon fills one crate from a blighted super restore(4), two blighted
 * karambwan, eight blighted manta rays or anglerfish and 1,000 coins; the transcript's prompt and
 * box are used as written. A crate opens only inside the crater, into eight fish, two karambwan
 * and the restore, released in a varied order (29 January 2025 update). No more than two crates
 * may be taken into Bounty Hunter: entry asks "bounty-hunter:can-enter".
 *
 * Messages without a Wiki source (no materials, no space, outside the crater, too many crates)
 * are our wording.
 */

const { inCrater } = require("./Fort.BountyHunter");

const MAX_CRATES_IN_ARENA = 2;
const FISH_PER_CRATE = 8;
const KARAMBWAN_PER_CRATE = 2;
const COINS_PER_CRATE = 1000;

let core;
let crates;

function crateTypes(Items) {
  const shared = { restore: Items.BLIGHTED_SUPER_RESTORE_4_, karambwan: Items.BLIGHTED_KARAMBWAN };
  return [
    { ...shared, crate: Items.BOUNTY_SUPPLY_CRATE_MANTA_RAY_, fish: Items.BLIGHTED_MANTA_RAY, fishName: "manta rays" },
    { ...shared, crate: Items.BOUNTY_SUPPLY_CRATE_ANGLERFISH_, fish: Items.BLIGHTED_ANGLERFISH, fishName: "anglerfish" },
  ];
}

/** How many crates of `type` the inventory can fill. */
function fillable(inventory, type) {
  return Math.min(
    inventory.getAmount(type.restore),
    Math.floor(inventory.getAmount(type.karambwan) / KARAMBWAN_PER_CRATE),
    Math.floor(inventory.getAmount(type.fish) / FISH_PER_CRATE),
    Math.floor(inventory.getAmount(core.ItemIdentifiers.COINS) / COINS_PER_CRATE),
  );
}

function fill(player, type, wanted) {
  const inventory = player.getInventory();
  const count = Math.min(Math.trunc(Number(wanted) || 0), fillable(inventory, type));
  if (count <= 0) return;
  inventory.deleteNumber(type.restore, count);
  inventory.deleteNumber(type.karambwan, count * KARAMBWAN_PER_CRATE);
  inventory.deleteNumber(type.fish, count * FISH_PER_CRATE);
  inventory.deleteNumber(core.ItemIdentifiers.COINS, count * COINS_PER_CRATE);
  inventory.adds(type.crate, count);
  const { DialogueChainBuilder, ItemStatementDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, type.crate,
    `You fill and take ${count} Bounty Hunter supply ${count === 1 ? "crate" : "crates"}.`)));
}

function take(player, type) {
  const most = fillable(player.getInventory(), type);
  if (most <= 0) {
    player.sendMessage(`You need a blighted super restore(4), two blighted karambwan, eight blighted ${type.fishName} and 1,000 coins to fill a supply crate.`);
    return;
  }
  player.setEnteredAmountAction({ execute: (amount) => fill(player, type, amount) });
  player.getPacketSender().sendEnterAmountPrompt(`How many supply crates would you like to take? (Up to ${most})`);
}

const takeMantaRay = ({ player }) => take(player, crates[0]);
const takeAnglerfish = ({ player }) => take(player, crates[1]);

function shuffled(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function contents(type) {
  return [
    ...Array(FISH_PER_CRATE).fill(type.fish),
    ...Array(KARAMBWAN_PER_CRATE).fill(type.karambwan),
    type.restore,
  ];
}

function open({ player, itemId, slot }) {
  const type = crates.find((crate) => crate.crate === itemId);
  if (!inCrater(player)) {
    player.sendMessage("You can only open this crate inside Bounty Hunter.");
    return;
  }
  const inventory = player.getInventory();
  const items = contents(type);
  if (inventory.getFreeSlots() + 1 < items.length) {
    player.sendMessage(`You need ${items.length - 1} free inventory spaces to open this crate.`);
    return;
  }
  inventory.deleteAtSlot(slot, 1);
  for (const id of shuffled(items)) inventory.adds(id, 1);
}

/** Crates carried, noted ones included: the Wiki's limit is on crates brought in. */
function cratesCarried(player) {
  const inventory = player.getInventory();
  return crates.reduce((total, type) => {
    const noted = core.ItemDefinition.forId(type.crate)?.getNoteId?.() ?? -1;
    return total + inventory.getAmount(type.crate) + (noted > 0 ? inventory.getAmount(noted) : 0);
  }, 0);
}

/** Query from the arena entrance: { player, allowed: true, reason: null }. */
function canEnter(request) {
  if (!request?.player || request.allowed === false) return;
  if (cratesCarried(request.player) <= MAX_CRATES_IN_ARENA) return;
  request.allowed = false;
  request.reason = "You can't take more than two supply crates into Bounty Hunter.";
}

module.exports = function attachSupplyCrates(api) {
  core = api.core;
  crates = crateTypes(core.ItemIdentifiers);
  api.onObjectInteraction("Bounty supply crate", { "Take manta ray": takeMantaRay, "Take anglerfish": takeAnglerfish });
  api.onItemAction("Bounty supply crate (manta ray)", { Open: open });
  api.onItemAction("Bounty supply crate (anglerfish)", { Open: open });
  api.onCustomEvent("bounty-hunter:can-enter", canEnter);
};

Object.assign(module.exports, { _test: { fillable, fill, take, open, contents, canEnter, cratesCarried } });
