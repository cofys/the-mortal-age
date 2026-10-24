"use strict";

/**
 * Larxus, from his Wiki transcript (npc-dialogues.json): this unit only picks the variant, answers
 * its conditions and does what its choices and actions say.
 * - Talk-to: the standard conversation; Leon d'Cour's challenge once the other ten champions are
 *   beaten; the cape once Leon is.
 * - A champion's scroll used on him: that champion's rules (captured for the Giant), and "Yes, let
 *   me at him!" brings the champion into the arena. A scroll for a champion already beaten is void
 *   and taken; one while a champion is waiting, or any other item, gets its own line.
 */
const Common = require("./Common.ChampionsChallenge");
const { sessionOf } = require("./Gallery.ChampionsChallenge");

const ACCEPT = "Yes, let me at him!";
const CAPE_MESSAGE = "Larxus hands you the cape of Leon d'Cour.";
const SCROLL_REMOVED = "The player's scroll is removed.";

const VARIANT = Object.freeze({
  leonChallenge: "standard-dialogue-talking-to-larxus-after-being-challenged-by-leon-d-cour",
  leonDefeated: "standard-dialogue-talking-to-larxus-after-defeating-leon-d-cour",
  waiting: "using-items-on-larxus-attempting-to-give-him-a-scroll-after-accepting-a-challenge",
  void: "using-items-on-larxus-attempting-to-give-him-a-scroll-for-a-defeated-champion",
  otherItem: "using-items-on-larxus-irrelevant-items",
});

/** "using-items-on-larxus-earth-warrior-champion-scroll" and so on. */
const scrollVariant = (champion) => `using-items-on-larxus-${champion.name.toLowerCase().replace(/ /g, "-")}-champion-scroll`;

function pickVariant({ player, npcId }) {
  if (npcId !== Common.LARXUS) return null;
  const session = sessionOf(player);
  if (Common.hasDefeated(player, Common.LEON)) return VARIANT.leonDefeated;
  if (!session || session.challenge || !Common.leonUnlocked(player)) return null;
  session.offer = Common.LEON;
  return VARIANT.leonChallenge;
}

function answerCondition({ player, npcId, text }) {
  if (npcId !== Common.LARXUS) return null;
  const condition = String(text ?? "");
  if (condition.startsWith("If the player has a Champion's scroll")) return Common.heldScroll(player) !== null;
  if (condition.startsWith("If the player has no inventory space")) return player.getInventory().getFreeSlots() === 0;
  if (condition.startsWith("Before defeating any champions")) return !Common.anyDefeated(player);
  if (condition.startsWith("Before claiming a reward")) return Common.unclaimed(player) !== null && !Common.holdsLamp(player);
  if (condition.startsWith("While holding a Champion's lamp")) return Common.holdsLamp(player);
  if (condition.startsWith("If the player already has all rewards")) return true;
  return null;
}

function chooseOption({ player, npcId, option }) {
  if (npcId !== Common.LARXUS || option !== ACCEPT) return;
  const session = sessionOf(player);
  if (session?.offer && !session.challenge) session.accept(session.offer);
}

function runAction(action) {
  if (action.npcId !== Common.LARXUS) return;
  const { player } = action;
  if (action.kind === "message" && action.text === CAPE_MESSAGE) {
    const cape = Common.DATA.items.cape;
    player.getInventory().adds(cape, 1);
    Common.api.emitCustomEvent("collection-log:obtain", { player, itemId: cape, amount: 1 });
    action.box = { items: [cape] };
    action.handled = true;
    return;
  }
  if (action.text === SCROLL_REMOVED) {
    const session = sessionOf(player);
    if (session?.voidScroll) player.getInventory().delete(session.voidScroll, 1);
    if (session) session.voidScroll = null;
    action.handled = true;
  }
}

/** Anything used on Larxus. */
function useItemOnLarxus(event) {
  const { player, npcId, itemId, target } = event;
  if (npcId !== Common.LARXUS) return;
  const session = sessionOf(player);
  if (!session) return;
  event.handled = true;
  session.voidScroll = null;
  const champion = Common.byScroll.get(itemId);
  if (!champion) {
    Common.larxusVariant(player, VARIANT.otherItem, target);
    return;
  }
  if (session.challenge) {
    Common.larxusVariant(player, VARIANT.waiting, target);
    return;
  }
  if (Common.hasDefeated(player, champion)) {
    session.voidScroll = itemId;
    Common.larxusVariant(player, VARIANT.void, target);
    return;
  }
  session.offer = champion;
  Common.larxusVariant(player, scrollVariant(champion), target);
}

function attachLarxus(api) {
  api.onNpcDialogueVariant(pickVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:choice", chooseOption);
  api.onCustomEvent("npc-dialogue:action", runAction);
  api.onItemOnNpc(useItemOnLarxus);
}

module.exports = { attachLarxus, scrollVariant, answerCondition, pickVariant };
