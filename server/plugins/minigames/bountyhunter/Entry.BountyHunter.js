"use strict";

/**
 * Getting into and out of Daimon's Crater (https://oldschool.runescape.wiki/w/Bounty_Hunter,
 * Transcript:Bounty_Hunter_portal, Transcript:Corrupted_Warrior_(Bounty_Hunter)):
 *
 * - the portal in Ferox Enclave asks "Teleport to Bounty Hunter?" and puts the player in Fort
 *   Daimon; it needs combat level 32 (no play-time requirement here). The first time, the Corrupted Warrior
 *   outside gives the rules instead (14 June 2023). The crater's portal asks "Leave Bounty
 *   Hunter?" and goes back to Ferox. Every world here counts as a Bounty Hunter world;
 * - the fort's Arena gates (Enter) put the player on a random demonic sigil in the arena, once
 *   their coffer holds the minimum deposit and the other units agree ("bounty-hunter:can-enter");
 *   the arena's Exit gates lead back into the fort, though not while dying or straight after a
 *   special attack (7 June 2023).
 *
 * Refusal messages other than the transcripts' are our wording.
 */

const MIN_COMBAT_LEVEL = 32;
// ponytail: the Wiki's PvP world rule says "a few seconds" after a special attack; 3 s here.
const SPECIAL_EXIT_DELAY_TICKS = 5;
const SPAWN_SEARCH_RADIUS = 2;
const RULES_ATTRIBUTE = "bounty-hunter:rules-accepted";
const VARBIT_ARENA_ENTER_WARNING = "bh_arena_enter_warning";

const RULES = [
  "Excuse me! This area is different than the rest of the Wilderness, are you sure you understand the rules?",
  "I can tell you everything you need to know, but if you're in a rush then be warned my overlords will NOT be happy if they find you to be fighting with no honour.",
  "Just don't go doing anything silly like selling your soul to your opponent else there will be big trouble!",
];

let api;
let core;
let bh;

function tile({ x, y }) {
  return new core.Location(x, y, 0);
}

function inCraterBox(location) {
  return bh.isArenaTile(location) || bh.isLobbyTile(location);
}

function portalRefusal(player) {
  if (player.getSkillManager().getCombatLevel() < MIN_COMBAT_LEVEL) {
    return `You need a combat level of at least ${MIN_COMBAT_LEVEL} to enter Bounty Hunter.`;
  }
  return null;
}

function syncRules({ player }) {
  if (player.getAttribute(RULES_ATTRIBUTE) === true) player.getPacketSender().sendVarbit(core.CacheDefinitions.getVarbitId(VARBIT_ARENA_ENTER_WARNING), 1);
}

function acceptRules(player) {
  player.setAttribute(RULES_ATTRIBUTE, true);
  syncRules({ player });
}

function rules(player) {
  const { DialogueChainBuilder, NpcDialogue, ActionDialogue, NpcIdentifiers } = core;
  const chain = new DialogueChainBuilder();
  RULES.forEach((line, index) => chain.add(new NpcDialogue(index, NpcIdentifiers.CORRUPTED_WARRIOR_3, line)));
  chain.add(new ActionDialogue(RULES.length, {
    execute: () => api.sendMultiChatboxPrompt(player, "Buying or selling kills within Bounty Hunter is against the rules.",
      "Yes, I acknowledge these rules.", () => acceptRules(player),
      "No.", () => {}),
  }));
  player.getDialogueManager().startDialogues(chain);
}

function enterFromFerox(player) {
  const refusal = portalRefusal(player);
  if (refusal) {
    player.sendMessage(refusal);
    return;
  }
  if (player.getAttribute(RULES_ATTRIBUTE) !== true) {
    rules(player);
    return;
  }
  api.sendMultiChatboxPrompt(player, "Teleport to Bounty Hunter?",
    "Yes", () => player.moveTo(tile(bh.CRATER.lobbyArrival)),
    "No", () => {});
}

function leaveToFerox(player) {
  api.sendMultiChatboxPrompt(player, "Leave Bounty Hunter?",
    "Yes", () => player.moveTo(tile(bh.CRATER.feroxArrival)),
    "No", () => {});
}

function usePortal({ player, objectId }) {
  const { BOUNTY_HUNTER_PORTAL, BOUNTY_HUNTER_PORTAL_2 } = core.ObjectIdentifiers;
  if (objectId === BOUNTY_HUNTER_PORTAL) enterFromFerox(player);
  else if (objectId === BOUNTY_HUNTER_PORTAL_2) leaveToFerox(player);
  else return false;
}

/** The coffer (Agent B's) and any other unit may refuse; an unanswered query lets the player in. */
function arenaRefusal(player) {
  const deposit = { player, amount: null };
  const coffer = { player, balance: null };
  api.emitCustomEvent("bounty-hunter:minimum-deposit", deposit);
  api.emitCustomEvent("bounty-hunter:coffer-balance", coffer);
  if (deposit.amount != null && coffer.balance != null && coffer.balance < deposit.amount) {
    return `You need at least ${deposit.amount.toLocaleString("en-GB")} coins in your coffer to enter the arena.`;
  }
  const request = { player, allowed: true, reason: null };
  api.emitCustomEvent("bounty-hunter:can-enter", request);
  return request.allowed === false ? request.reason ?? "You can't enter the arena right now." : null;
}

/** For Teleport to Target from the lobby, which lands in the arena without the gates. */
function answerArenaRefusal(request) {
  request.reason ??= arenaRefusal(request.player);
}

/** A walkable tile on or beside a random sigil (the sigils' own tiles hold candles). */
function spawnTile() {
  const { Misc, RegionManager } = core;
  const sigil = Misc.randomElement(bh.CRATER.sigils);
  const open = [];
  for (let dx = -SPAWN_SEARCH_RADIUS; dx <= SPAWN_SEARCH_RADIUS + 1; dx++) {
    for (let dy = -SPAWN_SEARCH_RADIUS; dy <= SPAWN_SEARCH_RADIUS + 1; dy++) {
      if (RegionManager.getClipping(sigil.x + dx, sigil.y + dy, 0, null) === 0) open.push({ x: sigil.x + dx, y: sigil.y + dy });
    }
  }
  return tile(open.length ? Misc.randomElement(open) : sigil);
}

function enterArena({ player, location }) {
  if (!inCraterBox(location)) return false;
  const refusal = arenaRefusal(player);
  if (refusal) {
    player.sendMessage(refusal);
    return;
  }
  player.moveTo(spawnTile());
}

function exitArena({ player, location }) {
  if (!inCraterBox(location)) return false;
  if (player.isDyingReturn?.()) return;
  if (core.World.getProcessCycle() - (bh.lastSpecialAt.get(player) ?? -Infinity) < SPECIAL_EXIT_DELAY_TICKS) {
    player.sendMessage("You can't leave so soon after using a special attack.");
    return;
  }
  const distance = (exit) => Math.abs(exit.x - location.x) + Math.abs(exit.y - location.y);
  const exit = bh.CRATER.exits.reduce((best, next) => (distance(next) < distance(best) ? next : best));
  player.moveTo(tile(exit.to));
}

module.exports = function attachEntry(pluginApi, state) {
  api = pluginApi;
  core = pluginApi.core;
  bh = state;
  api.persistAttribute(RULES_ATTRIBUTE, false);
  api.onPlayerLogin(syncRules);
  api.onObjectInteraction("Bounty Hunter portal", { Enter: usePortal });
  api.onObjectInteraction("Arena", { Enter: enterArena, Exit: exitArena });
  api.onCustomEvent("bounty-hunter:arena-refusal", answerArenaRefusal);
};

Object.assign(module.exports, { spawnTile, exitArena, _test: { portalRefusal, arenaRefusal, spawnTile, RULES_ATTRIBUTE } });
