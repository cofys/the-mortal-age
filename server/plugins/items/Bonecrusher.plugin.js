/**
 * Bonecrusher (https://oldschool.runescape.wiki/w/Bonecrusher), the hard Morytania diary's reward
 * from the ghost disciples (plugins/skills/ectofuntus/Disciples.Ectofuntus.js). Carried in the
 * inventory with charges and active, it crushes the bones a kill drops, one charge each, for half
 * their burying experience (all of it with the elite Morytania diary), and the Catacombs of
 * Kourend and a dragonbone necklace give back their Prayer restore as for burying. Bones dropped
 * noted and tertiary bones (long and curved) are left on the floor. See docs/prayer-bones.md.
 *
 * As captured (rsprox recordings 1857, 703, Leagues V; the item is the same on every world):
 * - An ectotoken used on it adds all of them, 25 charges each: synth 1413 and "The bonecrusher has
 *   2,125 charges. It is active and ready to crush bones."
 * - Check: "The bonecrusher has no charges. It can be charged with ectotokens." or the line above.
 * - Activity: "The bonecrusher has been deactivated, and will not crush bones now." with synth 974,
 *   or "The bonecrusher is active and ready to crush bones." with synth 975.
 * - It crushes as the loot lands, and every hundredth charge says "Your bonecrusher has 5,700
 *   charges left." Charges aren't sent to the client.
 * Not captured: Check while deactivated (the Activity line is used), and Uncharge, which the Wiki
 * says returns an ectotoken per 25 charges and keeps the rest; it answers with Check's line.
 */
const CHARGES_ATTRIBUTE = "bonecrusher:charges";
const INACTIVE_ATTRIBUTE = "bonecrusher:inactive";

const CHARGES_PER_TOKEN = 25;
const MAX_CHARGES = 2147483647; // charges_bonecrusher_quantity, bits 0-30 of varp 4675
const CHARGES_MESSAGE_EVERY = 100;
const CHARGE_SOUND = 1413;
const DEACTIVATE_SOUND = 974;
const ACTIVATE_SOUND = 975;
const HALF_EXPERIENCE = 0.5;

let api = null;
let core = null;

const charges = (player) => Number(player.getAttribute(CHARGES_ATTRIBUTE)) || 0;
const active = (player) => !player.getAttribute(INACTIVE_ATTRIBUTE);
const format = (count) => count.toLocaleString("en-GB");

function setCharges(player, count) {
  player.setAttribute(CHARGES_ATTRIBUTE, count);
}

function status(player) {
  const count = charges(player);
  if (count <= 0) return "The bonecrusher has no charges. It can be charged with ectotokens.";
  return active(player)
    ? `The bonecrusher has ${format(count)} charges. It is active and ready to crush bones.`
    : `The bonecrusher has ${format(count)} charges. It has been deactivated, and will not crush bones now.`;
}

function check({ player }) {
  player.sendMessage(status(player));
}

function toggleActivity({ player }) {
  const activating = !active(player);
  player.setAttribute(INACTIVE_ATTRIBUTE, activating ? 0 : 1);
  player.sendMessage(activating
    ? "The bonecrusher is active and ready to crush bones."
    : "The bonecrusher has been deactivated, and will not crush bones now.");
  player.getPacketSender().sendSound(activating ? ACTIVATE_SOUND : DEACTIVATE_SOUND, 1, 0);
}

function uncharge({ player }) {
  const tokens = Math.floor(charges(player) / CHARGES_PER_TOKEN);
  const inventory = player.getInventory();
  if (tokens > 0 && (inventory.contains(core.ItemIdentifiers.ECTO_TOKEN) || inventory.getFreeSlots() > 0)) {
    inventory.adds(core.ItemIdentifiers.ECTO_TOKEN, tokens);
    setCharges(player, charges(player) - tokens * CHARGES_PER_TOKEN);
  }
  player.sendMessage(status(player));
}

function charge({ player }) {
  const inventory = player.getInventory();
  const room = Math.floor((MAX_CHARGES - charges(player)) / CHARGES_PER_TOKEN);
  const tokens = Math.min(inventory.getAmount(core.ItemIdentifiers.ECTO_TOKEN), room);
  if (tokens <= 0) return;
  inventory.deleteNumber(core.ItemIdentifiers.ECTO_TOKEN, tokens);
  setCharges(player, charges(player) + tokens * CHARGES_PER_TOKEN);
  player.sendMessage(status(player));
  player.getPacketSender().sendSound(CHARGE_SOUND, 1, 0);
}

function experienceScale(player) {
  const request = { player, diary: "morytania", tier: "elite", complete: false };
  api.emitCustomEvent("diary:is-complete", request);
  return request.complete ? 1 : HALF_EXPERIENCE;
}

/** Crushes one bone; false when it isn't one the bonecrusher takes. */
function crush(player, itemId, scale) {
  const request = { player, itemId, scale, crushed: true, handled: false };
  api.emitCustomEvent("prayer:bury", request);
  if (!request.handled) return false;
  const left = charges(player) - 1;
  setCharges(player, left);
  if (left % CHARGES_MESSAGE_EVERY === 0) player.sendMessage(`Your bonecrusher has ${format(left)} charges left.`);
  return true;
}

/** "npc-drops:generated": the killer's bonecrusher takes the bones before the loot lands. */
function crushDrops({ player, drops }) {
  if (!player || !Array.isArray(drops) || charges(player) <= 0 || !active(player)) return;
  if (!player.getInventory().contains(core.ItemIdentifiers.BONECRUSHER)) return;
  let scale = null;
  for (const drop of drops) {
    if (drop.noted) continue;
    while (drop.amount > 0 && charges(player) > 0) {
      scale ??= experienceScale(player);
      if (!crush(player, drop.itemId, scale)) break;
      drop.amount--;
    }
  }
  for (let i = drops.length - 1; i >= 0; i--) if (drops[i].amount <= 0) drops.splice(i, 1);
}

module.exports = {
  name: "Bonecrusher",
  members: true,
  register(pluginApi) {
    api = pluginApi;
    core = api.core;
    api.persistAttribute(CHARGES_ATTRIBUTE, 0);
    api.persistAttribute(INACTIVE_ATTRIBUTE, 0);
    api.onItemAction("Bonecrusher", { Check: check, Activity: toggleActivity, Uncharge: uncharge });
    api.onItemOnItem("Ecto-token", "Bonecrusher", charge);
    api.onCustomEvent("npc-drops:generated", crushDrops);
  },
};
