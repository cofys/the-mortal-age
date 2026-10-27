"use strict";

/**
 * Kovac (11472, shown by kovac_multi 11560 once Sleeping Giants is complete): commissions and
 * his Talk-to.
 *
 * - Talk-to plays the Wiki's "Transcript:Kovac" (npc-dialogues.json). This unit answers its
 *   "has a commission" conditions and fills in its "[sword style]" blanks; the "Make [sword
 *   style] sword." line hands out the commission it names.
 * - Commission (op4) gives one straight away (rsprox captures: commission_word_1/2 are set on
 *   the click's tick, then "Make <col=ef1020>Light Spiked</col> sword.").
 *
 * - Hand-in (op3), as captured (recording 101): "Hmm... sword look good. Hand over.", then on
 *   continuing "Kovac deposits 46,020 coins into your bank as payment.", the reputation varp,
 *   the preform and commission varbits clear, the preform leaves the player's hands, jingle
 *   293, the HUD closes and a message box reports the sword; after it the game message "Total
 *   swords made in the Giants Foundry: 31" and "Receive another commission?" (Yes./No.).
 *   Rewards are the Wiki's: XP (floor(q^2/73) + floor(1.5q) + 1) * 30, twice that in coins, the
 *   quality in Foundry Reputation and half the run energy back; a ruined sword gives 30 XP and
 *   60 coins.
 *
 * A commission is two words from enum 4372 on different axes: the first Broad, Narrow, Heavy
 * or Light, the second Heavy, Light, Flat or Spiked (the twelve pairs live OSRS hands out).
 */

const Shared = require("./Shared.GiantsFoundry");
const Preform = require("./Preform.GiantsFoundry");

const WORDS_ENUM = 4372;
const WORD = { NARROW: 1, LIGHT: 2, FLAT: 3, BROAD: 4, HEAVY: 5, SPIKED: 6 };
const FIRST_WORDS = [WORD.BROAD, WORD.NARROW, WORD.HEAVY, WORD.LIGHT];
const SECOND_WORDS = [WORD.HEAVY, WORD.LIGHT, WORD.FLAT, WORD.SPIKED];
/** Each word's axis: Broad-Narrow, Heavy-Light, Spiked-Flat. */
const AXIS = { 1: 0, 4: 0, 2: 1, 5: 1, 3: 2, 6: 2 };
const STYLE_COLOUR = "ef1020";
const STYLE_PLACEHOLDER = "[sword style]";

/** "Transcript:Kovac" conditions, by step id. */
const CONDITION = {
  NO_COMMISSION: ["Hponlh", "Gf7nCm"],
  HAS_COMMISSION: ["JVpUXP", "n4UTPI", "AGlqvx"],
};

const COMMISSION_STARTED = "commissionStarted";
const TUTORIAL = "tutorial";
const FIELD = { SWORDS: "swordsMade", BEST: "best" };
const JINGLE_HAND_IN = 293;
const RUINED_REWARD = { xp: 30, coins: 60 };
const RUN_ENERGY_BACK = 50;
const MAX_COMPLETION = 1000;
const COINS = 995;
const COLLECTION_LOG_CATEGORY = "Giants' Foundry";

/** Every pair Kovac can ask for: the two words never share an axis. */
const PAIRS = FIRST_WORDS.flatMap((first) =>
  SECOND_WORDS.filter((second) => AXIS[first] !== AXIS[second]).map((second) => [first, second]));

function wordName(word) {
  const { CacheDefinitions } = Shared.core();
  return String(CacheDefinitions.getEnumValues(WORDS_ENUM).get(word) ?? "");
}

function words(player) {
  return [Shared.get(player, Shared.VARBIT.COMMISSION_WORD_1), Shared.get(player, Shared.VARBIT.COMMISSION_WORD_2)];
}

function hasCommission(player) {
  return words(player)[0] !== 0;
}

/** "Light Spiked", coloured as Kovac says it. */
function style(player) {
  const [first, second] = words(player);
  return `<col=${STYLE_COLOUR}>${wordName(first)} ${wordName(second)}</col>`;
}

/** Hands out a new commission and starts its timer (the hand-in reports the time taken). */
function giveCommission(player, pair = PAIRS[Math.floor(Math.random() * PAIRS.length)]) {
  Shared.set(player, Shared.VARBIT.COMMISSION_WORD_1, pair[0]);
  Shared.set(player, Shared.VARBIT.COMMISSION_WORD_2, pair[1]);
  Shared.setField(player, COMMISSION_STARTED, Date.now());
}

function clearCommission(player) {
  Shared.set(player, Shared.VARBIT.COMMISSION_WORD_1, 0);
  Shared.set(player, Shared.VARBIT.COMMISSION_WORD_2, 0);
  Shared.setField(player, COMMISSION_STARTED, null);
  Shared.setField(player, TUTORIAL, null);
}

/** Sleeping Giants hands out its Flat Broad commission ("giants-foundry:start-commission"). */
function startQuestCommission({ player, words: pair, tutorial }) {
  if (!player || !Array.isArray(pair) || hasCommission(player)) return;
  giveCommission(player, pair);
  if (tutorial) Shared.setField(player, TUTORIAL, true);
}

/** The quest takes its finished sword ("giants-foundry:discard-preform"). */
function discardPreform({ player, preserveQuality = false }) {
  if (player) clearPreform(player, preserveQuality);
}

/** The new commission's line, handing it out first. */
function commissionLine(player) {
  giveCommission(player);
  return `Make ${style(player)} sword.`;
}

/** Wiki: XP for a sword of quality q (30 at 0, 25,230 at 199). */
function swordXp(quality) {
  return (Math.floor((quality * quality) / 73) + Math.floor(1.5 * quality) + 1) * 30;
}

/** "52m 10s", or with hours "1h 2m 3s". */
function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString("en-US");
}

/** The personal best is the highest quality, the quicker sword breaking a tie. */
function better(a, b) {
  if (!b) return true;
  return a.quality > b.quality || (a.quality === b.quality && a.ms < b.ms);
}

function isUltimateIronman(player) {
  const query = { player, mode: "none" };
  Shared.api().emitCustomEvent("ironman:mode", query);
  return query.mode === "ultimate";
}

/** Kovac pays into the bank (Ultimate Ironmen into the inventory, Wiki). */
function pay(player, coins) {
  const { Item } = Shared.core();
  const bank = isUltimateIronman(player) ? null : player.getBanks?.().find((tab) => tab?.getFreeSlots?.() > 0 || tab?.contains?.(COINS));
  if (bank) {
    bank.add(new Item(COINS, coins), true);
    bank.refreshItems?.();
    player.sendMessage(`Kovac deposits ${formatNumber(coins)} coins into your bank as payment.`);
    return;
  }
  player.getInventory().adds(COINS, coins);
  player.getInventory().refreshItems();
}

/** Clears the finished preform and its commission. */
function clearPreform(player, preserveQuality = false) {
  Shared.stopWork(player);
  Preform.unequip(player);
  const cleared = [Shared.VARBIT.PREFORM_DIFFICULTY, Shared.VARBIT.COMPLETION, Shared.VARBIT.PREFORM_STORED];
  if (!preserveQuality) cleared.push(Shared.VARBIT.PREFORM_QUALITY, Shared.VARBIT.PREFORM_START_QUALITY);
  for (const varbit of cleared) {
    Shared.set(player, varbit, 0);
  }
  clearCommission(player);
}

function handOver(player) {
  const quality = Shared.get(player, Shared.VARBIT.PREFORM_QUALITY);
  const ruined = quality <= 0;
  const started = Number(Shared.field(player, COMMISSION_STARTED, Date.now()));
  const ms = Date.now() - started;
  const xp = ruined ? RUINED_REWARD.xp : swordXp(quality);
  const coins = ruined ? RUINED_REWARD.coins : xp * 2;
  pay(player, coins);
  const award = { player, minigame: "giants-foundry", points: quality };
  Shared.api().emitCustomEvent("minigame:points", award);
  Shared.setReputation(player, Shared.reputation(player) + award.points);
  clearPreform(player);
  Shared.addXp(player, "SMITHING", xp);
  player.setRunEnergy(Math.min(100, player.getRunEnergy() + RUN_ENERGY_BACK));
  player.getPacketSender().sendRunStatus?.();
  player.getPacketSender().sendJingle(JINGLE_HAND_IN, 0);
  const swords = (Number(Shared.field(player, FIELD.SWORDS, 0)) || 0) + 1;
  Shared.setField(player, FIELD.SWORDS, swords);
  const sword = { quality, ms };
  const previous = Shared.field(player, FIELD.BEST, null);
  const best = better(sword, previous) ? sword : previous;
  Shared.setField(player, FIELD.BEST, best);
  const report = [
    `Sword completed in: ${duration(ms)} at quality: ${quality}`,
    `Best completed in: ${duration(best.ms)} at quality: ${best.quality}`,
    `You're awarded: ${xp} Smithing XP and ${formatNumber(coins)} coins.`,
    `Total swords made in the Giants Foundry: ${swords}`,
  ].join("<br>");
  const { DialogueChainBuilder, StatementDialogue, ActionDialogue } = Shared.core();
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new StatementDialogue(0, report),
    new ActionDialogue(1, { execute: () => {
      player.sendMessage(`Total swords made in the Giants Foundry: ${swords}`);
      offerCommission(player, "Receive another commission?");
    } }),
  ));
  Shared.api().emitCustomEvent("giants-foundry:sword-handed-in", { player, quality, swords });
}

function offerCommission(player, title) {
  Shared.options(player, title,
    "Yes.", () => Shared.kovacSays(player, commissionLine(player)),
    "No.", () => player.getPacketSender().sendInterfaceRemoval());
}

function handIn({ player }) {
  if (!hasCommission(player)) {
    Shared.kovacSays(player, "You no sword to hand over. I give new commission if want?",
      () => offerCommission(player, "Receive new commission?"));
    return;
  }
  if (!Shared.wornPreform(player)) {
    Shared.kovacSays(player, `You no sword to hand over. Kovac give commission already. Go make me ${style(player)} sword.`);
    return;
  }
  const ruined = Shared.get(player, Shared.VARBIT.PREFORM_QUALITY) <= 0;
  if (!ruined && Shared.get(player, Shared.VARBIT.COMPLETION) < MAX_COMPLETION) {
    Shared.kovacSays(player, "Hmm... sword not finished yet. Keep working.");
    return;
  }
  Shared.kovacSays(player, ruined ? "Sword no good. Give it here." : "Hmm... sword look good. Hand over.", () => handOver(player));
}

function swordCount(request) {
  if (request.category === COLLECTION_LOG_CATEGORY) request.count = Number(Shared.field(request.player, FIELD.SWORDS, 0)) || 0;
}

function commission({ player }) {
  if (hasCommission(player)) {
    Shared.kovacSays(player, `Kovac give commission already. Go make me ${style(player)} sword.`);
    return;
  }
  Shared.kovacSays(player, commissionLine(player));
}

function isKovac(npcId) {
  return npcId === Shared.NPC.KOVAC;
}

function answerCondition({ npcId, player, stepId }) {
  if (!isKovac(npcId)) return null;
  if (CONDITION.NO_COMMISSION.includes(stepId)) return !hasCommission(player);
  if (CONDITION.HAS_COMMISSION.includes(stepId)) return hasCommission(player);
  return null;
}

/** Fills "[sword style]"; the first line that names a new commission hands it out. */
function fillStyle(request) {
  if (!isKovac(request.npcId) || typeof request.text !== "string" || !request.text.includes(STYLE_PLACEHOLDER)) return;
  if (!hasCommission(request.player) && /^Make \[sword style\] sword\.$/.test(request.text)) {
    request.text = commissionLine(request.player);
    return;
  }
  request.text = request.text.split(STYLE_PLACEHOLDER).join(style(request.player));
}

module.exports = function attachKovac(api) {
  api.onNpcInteraction(Shared.NPC.KOVAC_NAME, { Commission: commission, "Hand-in": handIn });
  api.onCustomEvent("collection-log:category-count", swordCount);
  api.onCustomEvent("giants-foundry:start-commission", startQuestCommission);
  api.onCustomEvent("giants-foundry:discard-preform", discardPreform);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:line", fillStyle);
};

Object.assign(module.exports, {
  WORD, PAIRS, swordXp, duration, better, words, hasCommission, style, giveCommission, clearCommission, commissionLine, wordName,
  COMMISSION_STARTED,
});
