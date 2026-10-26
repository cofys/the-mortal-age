"use strict";

// Watson's master clues (Wiki "Watson", Transcript:Watson; the exchange from live captures,
// rsprox.net): use an easy, a medium, a hard and an elite clue on him, one of each, and he hands
// over a master clue (a scroll box after X Marks the Spot). "Check" says which tiers he still needs.
const Runtime = require("./Runtime.TreasureTrails");
const Dialogue = require("./Dialogue.TreasureTrails");
const LOWER_TIERS = ["easy", "medium", "hard", "elite"];
const GIVEN_ATTRIBUTE = tier => `treasure-trails:watson-${tier}`;
const ARTICLE = { easy: "an", medium: "a", hard: "a", elite: "an" };
const HANDED = "You hand over the clue scroll to Watson.";
const ALREADY = "You have already given Watson a clue scroll of that tier.";
const NICE_WORK = "Nice work [player name], I've had one of each lower tier clue scroll from you.";
const MASTER_SHERLOCK = "using-a-clue-scroll-on-watson-master-clue-with-an-active-sherlock-step";
const MASTER_OTHER = "using-a-clue-scroll-on-watson-master-clue-with-any-other-active-step";
let api;
let core;

/** Watson's NPC and the two forms it takes. */
function isWatson(npcId) {
  const base = core.CacheDefinitions.getNpcId("trail_watson");
  return npcId === base || (core.CacheDefinitions.getNpc(base)?.transforms ?? []).includes(npcId);
}

function given(player, tier) {
  return player.getAttribute(GIVEN_ATTRIBUTE(tier)) === true;
}

function sync(player) {
  for (const tier of LOWER_TIERS) {
    const varbit = core.CacheDefinitions.getVarbitId(`trail_watson_${tier}`);
    if (varbit != null) player.getPacketSender().sendVarbit(varbit, given(player, tier) ? 1 : 0);
  }
}

/** "I still need an easy clue, a medium clue … from you before I give you a master clue scroll." */
function stillNeeded(player) {
  const missing = LOWER_TIERS.filter(tier => !given(player, tier)).map(tier => `${ARTICLE[tier]} ${tier} clue`);
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0];
  return `I still need ${list} from you before I give you a master clue scroll.`;
}

/** With all four in, a master clue (or its box) if the player has room for another master clue. */
function settle(player, npcId) {
  if (!LOWER_TIERS.every(tier => given(player, tier))) return false;
  const receive = { player, tier: "master", allowed: null };
  api.emitCustomEvent("treasure-trails:can-receive", receive);
  if (receive.allowed === false || player.getInventory().getFreeSlots() < 1) return false;
  const clue = { player, itemId: core.ItemIdentifiers.CLUE_SCROLL_MASTER_, box: false };
  api.emitCustomEvent("treasure-trails:clue-item", clue);
  Dialogue.play(player, npcId, [{ npc: NICE_WORK }], () => {
    for (const tier of LOWER_TIERS) player.setAttribute(GIVEN_ATTRIBUTE(tier), false);
    sync(player);
    player.getInventory().forceAdd(player, new core.Item(clue.itemId, 1));
    player.getInventory().refreshItems();
    Dialogue.itemBox(player, clue.itemId, `Watson hands you a ${clue.itemId === core.ItemIdentifiers.CLUE_SCROLL_MASTER_ ? "master clue scroll" : "master scroll box"}.`);
  });
  return true;
}

function check(event) {
  if (event.handled || !isWatson(event.npcId)) return;
  const definition = event.definition ?? event.npc.getCurrentDefinition?.(event.player);
  if (definition?.getActions?.()[event.clickType - 1] !== "Check") return;
  event.handled = true;
  if (!settle(event.player, event.npcId)) Dialogue.play(event.player, event.npcId, [{ npc: stillNeeded(event.player) }]);
}

/** The lower tier of a clue scroll (not a challenge scroll or box), or "master". */
function clueTier(itemId) {
  return /^Clue scroll \((\w+)\)$/.exec(core.ItemDefinition.forId(itemId)?.getName?.() ?? "")?.[1] ?? null;
}

function useClue(event) {
  const { player, target: npc, npcId, itemId, slot } = event;
  if (event.handled || !isWatson(npcId)) return;
  const tier = clueTier(itemId);
  if (!tier || tier === "beginner") return;
  event.handled = true;
  if (tier === "master") {
    // His transcript: a joke about Sherlock, or the scroll is "for you, not me".
    const trail = Runtime.trails(player).find(entry => entry.slot === slot);
    const sherlock = trail?.step.family === "skillchallenge" && trail.step.target === "npc";
    Dialogue.play(player, npcId, Dialogue.lines(Dialogue.transcript(player, npc, npcId, sherlock ? MASTER_SHERLOCK : MASTER_OTHER)));
    return;
  }
  if (given(player, tier)) { player.sendMessage(ALREADY); return; }
  api.sendMultiChatboxPrompt(player, "Select an option", `Hand over ${tier} clue.`, () => handOver(player, npcId, slot, tier), "Cancel.", () => {});
}

// The clue item can change while the prompt is open (a generic clue is rolled into its step's
// item on use), so the slot need only still hold a clue of that tier.
function handOver(player, npcId, slot, tier) {
  const item = player.getInventory().getItems()[slot];
  if (!item || clueTier(item.getId()) !== tier || given(player, tier)) return;
  player.getInventory().deleteAtSlot(slot, 1);
  player.setAttribute(GIVEN_ATTRIBUTE(tier), true);
  sync(player);
  if (settle(player, npcId)) return;
  Dialogue.mesbox(player, HANDED);
}

function login({ player }) {
  sync(player);
}

module.exports = function attachWatson(pluginApi) {
  api = pluginApi;
  core = api.core;
  for (const tier of LOWER_TIERS) api.persistAttribute(GIVEN_ATTRIBUTE(tier), false);
  api.onBeforeNpcInteraction(check);
  api.onItemOnNpc(useClue);
  api.onPlayerLogin(login);
};

Object.assign(module.exports, { check, useClue, handOver, stillNeeded, settle, GIVEN_ATTRIBUTE, LOWER_TIERS });
