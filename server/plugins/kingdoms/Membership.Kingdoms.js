"use strict";

/**
 * Membership.Kingdoms — player membership in the great powers: attributes,
 * commands, and the helpers other content (quests, courts, future AI systems)
 * use to move players through ranks. Every rank change travels the event bus
 * as kingdom:rank-granted; this module only emits, the Events module applies.
 *
 * Attributes (persisted):
 *   kingdom:id     — the kingdom the player serves, or unset
 *   kingdom:rank   — rank title from the kingdom's hierarchy
 *   kingdom:titles — honorifics earned, string array
 *
 * NPCs carry the same keys via tagCourtier: allegiance, rank and court role
 * need no engine changes — Mobile already has setAttribute/getAttribute.
 */

const Store = require("./KingdomStore");

const KINGDOM_ID_ATTRIBUTE = "kingdom:id";
const KINGDOM_RANK_ATTRIBUTE = "kingdom:rank";
const KINGDOM_TITLES_ATTRIBUTE = "kingdom:titles";
const KINGDOM_COURT_ROLE_ATTRIBUTE = "kingdom:court-role";

const BASE_RANK = "Subject";

let pluginApi;

function kingdomOf(player) {
  return Store.getKingdom(player?.getAttribute?.(KINGDOM_ID_ATTRIBUTE));
}

/**
 * Your standing with your crown: kingdom name, rank, ruler, titles.
 * Returns plain lines; the ::kingdom command sends them, and the war table
 * renders them in-interface.
 */
function membershipLines(player) {
  const kingdom = kingdomOf(player);
  if (!kingdom) return ["You swear fealty to no kingdom."];
  const rank = player.getAttribute(KINGDOM_RANK_ATTRIBUTE) ?? BASE_RANK;
  const titles = player.getAttribute(KINGDOM_TITLES_ATTRIBUTE) ?? [];
  const lines = [`You serve ${kingdom.name} as ${rank}.`];
  if (kingdom.ruler) lines.push(`Ruled by ${kingdom.ruler}.`);
  if (titles.length) lines.push(`Titles: ${titles.join(", ")}.`);
  return lines;
}

function showKingdom({ player }) {
  for (const line of membershipLines(player)) player.sendMessage(line);
}

/** Emit a rank grant after validating kingdom and rank. */
function emitRankGranted(target, kingdomId, rank, title) {
  const kingdom = Store.getKingdom(kingdomId);
  if (!kingdom) return false;
  const valid = (kingdom.hierarchy ?? []).includes(rank);
  pluginApi.emitCustomEvent("kingdom:rank-granted", {
    player: target,
    kingdomId,
    rank: valid ? rank : BASE_RANK,
    title: title ?? null,
  });
  return true;
}

/** ::kingdomrank <player> <kingdom> <rank...> — owner tool for testing courts. */
function grantRankCommand({ player, parts }) {
  if (parts.length < 4) {
    player.sendMessage("Usage: ::kingdomrank <player> <kingdom> <rank>");
    return;
  }
  const target = pluginApi.core.World.getPlayerByName(parts[1]);
  if (!target) {
    player.sendMessage(`No online player named '${parts[1]}'.`);
    return;
  }
  const kingdomId = parts[2].toLowerCase();
  const rank = parts.slice(3).join(" ");
  const kingdom = Store.getKingdom(kingdomId);
  if (!kingdom) {
    player.sendMessage(`Unknown kingdom '${parts[2]}'.`);
    return;
  }
  if (!(kingdom.hierarchy ?? []).includes(rank)) {
    player.sendMessage(`Unknown rank. Valid: ${(kingdom.hierarchy ?? []).join(", ")}.`);
    return;
  }
  emitRankGranted(target, kingdomId, rank);
  player.sendMessage(`${target.getUsername?.() ?? parts[1]} is now ${rank} of ${kingdom.name}.`);
  target.sendMessage(`You have been named ${rank} of ${kingdom.name}.`);
}

/** A player swears fealty at the base rank — the v1 "rise within a hierarchy" entry. */
function joinKingdom(player, kingdomId) {
  return emitRankGranted(player, kingdomId, BASE_RANK);
}

/** Bestow an honorific without changing rank. */
function grantTitle(player, title) {
  const kingdomId = player?.getAttribute?.(KINGDOM_ID_ATTRIBUTE);
  if (!kingdomId || !title) return false;
  const rank = player.getAttribute(KINGDOM_RANK_ATTRIBUTE) ?? BASE_RANK;
  return emitRankGranted(player, kingdomId, rank, title);
}

/**
 * Tag an NPC as a courtier: allegiance, rank, and role (king, general,
 * spymaster, steward...). Used when court NPCs are spawned; stored, not live.
 */
function tagCourtier(npc, kingdomId, rank, role) {
  if (!npc?.setAttribute) return false;
  npc.setAttribute(KINGDOM_ID_ATTRIBUTE, kingdomId);
  npc.setAttribute(KINGDOM_RANK_ATTRIBUTE, rank);
  if (role) npc.setAttribute(KINGDOM_COURT_ROLE_ATTRIBUTE, role);
  return true;
}

function attachMembership(api) {
  pluginApi = api;
  api.persistAttribute(KINGDOM_ID_ATTRIBUTE);
  api.persistAttribute(KINGDOM_RANK_ATTRIBUTE);
  api.persistAttribute(KINGDOM_TITLES_ATTRIBUTE);
  api.registerCommand("kingdom", showKingdom, undefined, "Show the kingdom you serve and your rank");
  api.registerCommand(
    "kingdomrank",
    grantRankCommand,
    api.core.PlayerRights.OWNER,
    "Grant a kingdom rank: ::kingdomrank <player> <kingdom> <rank>"
  );
}

module.exports = attachMembership;
module.exports.KINGDOM_ID_ATTRIBUTE = KINGDOM_ID_ATTRIBUTE;
module.exports.KINGDOM_RANK_ATTRIBUTE = KINGDOM_RANK_ATTRIBUTE;
module.exports.KINGDOM_TITLES_ATTRIBUTE = KINGDOM_TITLES_ATTRIBUTE;
module.exports.KINGDOM_COURT_ROLE_ATTRIBUTE = KINGDOM_COURT_ROLE_ATTRIBUTE;
module.exports.joinKingdom = joinKingdom;
module.exports.grantTitle = grantTitle;
module.exports.tagCourtier = tagCourtier;
module.exports.membershipLines = membershipLines;
