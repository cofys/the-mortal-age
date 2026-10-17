/**
 * Dark totems (Wiki: Dark totem, Dark totem base, Ancient shard):
 * - Any two of the base, middle and top used together with the third in the pack join into a
 *   dark totem (as captured: sound 3316, the item box "You bring the totem pieces together...").
 * - Every monster but ghosts in the Catacombs of Kourend and the Giants' Den drops a totem piece
 *   1 time in (500 - hitpoints), a superior Slayer monster always; and an ancient shard
 *   3 times in 2 x (500 - min(hitpoints, 400)).
 * - Skotizo rolls his totem table 4 times in 128: a whole totem 1 time in 4, a piece otherwise.
 * A piece is always the one the player has fewest of (pack and bank), base, middle, top on a tie.
 */
const Common = require("./Common.Skotizo");

const JOIN_SOUND = 3316;
const JOINED = "You bring the totem pieces together with a click. It looks kind of like an arcane key and pulses with dark power in your hand.";

const pieceIds = () => Common.DATA.drops.pieces.map((name) => Common.core.ItemIdentifiers[name]);

/** The player's amount of an item in their pack and every bank tab. */
function owned(player, itemId) {
  let total = player.getInventory().getAmount(itemId);
  for (const bank of player.getBanks?.() ?? []) total += bank?.getAmount?.(itemId) ?? 0;
  return total;
}

/** The piece the player has fewest of; ties go base, middle, top. */
function nextPiece(player) {
  let best = null;
  for (const id of pieceIds()) {
    const count = owned(player, id);
    if (!best || count < best.count) best = { id, count };
  }
  return best.id;
}

/** Two pieces used together, with the third in the pack: a dark totem. */
function join({ player }) {
  const inventory = player.getInventory();
  const pieces = pieceIds();
  if (!pieces.every((id) => inventory.contains(id))) return false;
  for (const id of pieces) inventory.delete(id, 1);
  inventory.adds(Common.core.ItemIdentifiers.DARK_TOTEM, 1);
  player.getPacketSender().sendSoundEffect(JOIN_SOUND, 1, 0, 0);
  const { DialogueChainBuilder, ItemStatementDialogue } = Common.core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, Common.core.ItemIdentifiers.DARK_TOTEM, JOINED)));
  return true;
}

const roll = (weight, outOf) => outOf > 0 && Math.floor(Math.random() * outOf) < weight;

function inCatacombs(npc) {
  const at = npc?.getLocation?.();
  if (!at) return false;
  const x = at.getX();
  const y = at.getY();
  return Common.DATA.drops.catacombs.boxes.some(([minX, minY, maxX, maxY]) => x >= minX && x <= maxX && y >= minY && y <= maxY);
}

function isSuperior(npc) {
  const request = { npc, superior: false };
  Common.api.emitCustomEvent("slayer:is-superior", request);
  return request.superior === true;
}

/** "npc-drops:add": the totem and shard rolls where a kill earns them. */
function addDrops(event) {
  const { player, npc, npcId, drops } = event;
  if (!player || !npc || !Array.isArray(drops)) return;
  if (npcId === Common.DATA.npcs.boss && npc.__skotizoLair) {
    const { weight, outOf, fullTotemChance } = Common.DATA.drops.totemTable;
    if (!roll(weight, outOf)) return;
    const full = Math.floor(Math.random() * fullTotemChance) === 0;
    drops.push({ itemId: full ? Common.core.ItemIdentifiers.DARK_TOTEM : nextPiece(player), amount: 1 });
    return;
  }
  const rules = Common.DATA.drops.catacombs;
  if (!inCatacombs(npc) || rules.excludedNames.includes(Common.npcName(npc))) return;
  const hitpoints = Math.max(1, npc.getMaxHitpoints?.() ?? (npc.getCurrentDefinition?.() ?? npc.getDefinition()).getHitpoints());
  if (isSuperior(npc) || roll(1, rules.totemFrom - Math.min(hitpoints, rules.totemFrom - 1))) {
    drops.push({ itemId: nextPiece(player), amount: 1 });
  }
  if (roll(rules.shardWeight, 2 * (rules.shardFrom - Math.min(hitpoints, rules.shardHitpointsCap)))) {
    drops.push({ itemId: Common.core.ItemIdentifiers.ANCIENT_SHARD, amount: 1 });
  }
}

module.exports = function attachTotems(api) {
  api.onItemOnItem("Dark totem base", "Dark totem middle", join, { noted: false });
  api.onItemOnItem("Dark totem base", "Dark totem top", join, { noted: false });
  api.onItemOnItem("Dark totem middle", "Dark totem top", join, { noted: false });
  api.onCustomEvent("npc-drops:add", addDrops);
};

module.exports._test = { nextPiece, addDrops, inCatacombs };
