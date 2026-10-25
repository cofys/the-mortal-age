"use strict";

/**
 * Simon Templeton buys the artefacts (OSRS Wiki: Simon Templeton): talking to him with any in
 * the pack, noted or not, plays "with-pyramid-plunder-artefacts-in-inventory" and he takes the
 * lot; using one (unnoted) artefact on him sells just that one. The transcript's "(Simon takes
 * ...)" step takes them and its "coins" step pays: ivory comb 50, pottery scarab 75, pottery
 * statuette 100, stone seal 150, stone scarab 175, stone statuette 200, gold seal 750, golden
 * scarab 1,000, golden statuette 1,250. His pyramid top and sceptre lines stay with the
 * transcript.
 *
 * Wiki: https://oldschool.runescape.wiki/w/Transcript:Simon_Templeton
 */

const Common = require("./Common.PyramidPlunder");

const VARIANT = {
  carrying: "with-pyramid-plunder-artefacts-in-inventory",
  usedOne: "using-items-on-him-any-pyramid-plunder-artefact",
};
/** Transcript steps: he takes the artefacts, then pays. */
const TAKE_ALL = new Set(["Kn2FnM", "9B09eW"]);
const TAKE_ONE = "0egJhg";
const PAY = new Set(["7vfUYS", "wb91_I", "dFDQfD"]);

/** player -> coins owed by the step that took the artefacts, paid at the coins step. */
const owed = new Map();
/** player -> the artefact item id used on him, until his one-at-a-time offer is answered. */
const offered = new Map();

const isSimon = (npcId) => npcId === Common.ids().simon;

function artefactKey(itemId) {
  const { artefacts, noted } = Common.ids().item;
  for (const key of Object.keys(artefacts)) {
    if (artefacts[key] === itemId || noted[key] === itemId) return key;
  }
  return null;
}

/** Every artefact in the pack, noted or not: [itemId, amount, coins each]. */
function carried(player) {
  const inventory = player.getInventory();
  const out = [];
  const { artefacts, noted } = Common.ids().item;
  for (const [key, artefact] of Object.entries(Common.DATA.artefacts)) {
    for (const id of [artefacts[key], noted[key]]) {
      if (!id) continue;
      const amount = inventory.getAmount(id);
      if (amount > 0) out.push([id, amount, artefact.coins]);
    }
  }
  return out;
}

/** Talk-to: the carrying lines when there's anything to sell; a stale one-item offer is dropped. */
function onDialogueVariant(context) {
  if (!isSimon(context.npcId)) return null;
  return carried(context.player).length > 0 ? VARIANT.carrying : null;
}

function talk({ player, npcId }) {
  if (isSimon(npcId)) offered.delete(player);
}

function forget({ player }) {
  owed.delete(player);
  offered.delete(player);
}

function takeAll(player) {
  let coins = 0;
  for (const [id, amount, each] of carried(player)) {
    player.getInventory().deleteNumber(id, amount);
    coins += amount * each;
  }
  owed.set(player, (owed.get(player) ?? 0) + coins);
}

function takeOne(player) {
  const itemId = offered.get(player);
  offered.delete(player);
  const key = itemId === undefined ? null : artefactKey(itemId);
  if (!key || player.getInventory().getAmount(itemId) <= 0) return;
  player.getInventory().deleteNumber(itemId, 1);
  owed.set(player, (owed.get(player) ?? 0) + Common.DATA.artefacts[key].coins);
}

function pay(request) {
  const player = request.player;
  const coins = owed.get(player) ?? 0;
  owed.delete(player);
  request.handled = true;
  if (coins <= 0) return;
  player.getInventory().addItem(new (Common.getCore().Item)(Common.ids().item.coins, coins));
  player.sendMessage(`Simon hands you ${coins.toLocaleString("en-GB")} coins.`);
}

function onDialogueAction(request) {
  if (!isSimon(request.npcId)) return;
  if (TAKE_ALL.has(request.stepId)) {
    request.handled = true;
    takeAll(request.player);
  } else if (request.stepId === TAKE_ONE) {
    request.handled = true;
    takeOne(request.player);
  } else if (PAY.has(request.stepId)) {
    pay(request);
  }
}

/** An unnoted artefact used on him: his one-at-a-time offer. */
function onItemOnNpc(event) {
  if (event.handled || !isSimon(event.npcId)) return;
  const key = artefactKey(event.itemId);
  if (!key || Common.ids().item.artefacts[key] !== event.itemId) return;
  event.handled = true;
  offered.set(event.player, event.itemId);
  Common.getApi().emitCustomEvent("npc-dialogue:start", {
    player: event.player, npc: event.target, npcId: event.npcId, variant: VARIANT.usedOne, handled: false,
  });
}

module.exports = function registerSimon(api) {
  Common.bind(api);
  api.onBeforeNpcInteraction(talk);
  api.onNpcDialogueVariant(onDialogueVariant);
  api.onCustomEvent("npc-dialogue:action", onDialogueAction);
  api.onItemOnNpc(onItemOnNpc);
  api.onPlayerLogout(forget);
  api.onPlayerDisconnect(forget);
};

module.exports._test = {
  VARIANT, TAKE_ALL, TAKE_ONE, PAY, owed, offered, artefactKey, carried, onDialogueVariant,
  takeAll, takeOne, pay, onDialogueAction, onItemOnNpc, forget,
};
