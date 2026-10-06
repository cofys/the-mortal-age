"use strict";

/**
 * Commands.Kingdoms — ::office (PLAYER).
 *
 * Offices of the realm are holdable by AI citizens or players — the holder
 * is data, and this command is the player-facing half of the interchange.
 * Vacant offices are petitioned for, held offices challenged, and the court
 * (Politics.Kingdoms.js) rules on influence — never on command.
 *
 *   ::office list [kingdomId]  — offices and their holders
 *   ::office claim <officeId>  — claim a vacant office (routes through petition)
 *   ::office petition <officeId> — petition for a vacant office, or challenge its holder
 *   ::office influence [kingdom] — where you stand with a court
 *   ::office vacate <officeId> — vacate an office you hold
 */

const Offices = require("./Offices.Kingdoms");
const Politics = require("./Politics.Kingdoms");

let pluginApi = null;

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function showList(player, args) {
  const kingdomId = args[0] ?? null;
  const list = Offices.getOffices(kingdomId);
  if (list.length === 0) {
    player.sendMessage("[Offices] No offices found.");
    return;
  }
  player.sendMessage("[Offices] Offices of the realm:");
  for (const o of list.slice(0, 20)) {
    player.sendMessage(`  ${o.officeId} — ${o.title}: ${Offices.holderName(o.holder)}`);
  }
}

function claimOffice(player, args) {
  const officeId = args[0];
  const office = Offices.getOffice(officeId);
  if (!office) {
    player.sendMessage("[Offices] No such office. Try ::office list");
    return;
  }
  if (office.holder) {
    player.sendMessage(
      `[Offices] ${office.title} of ${office.kingdomId} is held by ${Offices.holderName(office.holder)}. ` +
        `Offices change hands by politics, not command — petition the court: ::office petition ${officeId}`
    );
    return;
  }
  // A vacant office is still taken by politics: claim routes through petition.
  Politics.petition(player, args);
}

function vacateOffice(player, args) {
  const officeId = args[0];
  const office = Offices.getOffice(officeId);
  if (!office) {
    player.sendMessage("[Offices] No such office.");
    return;
  }
  const username = usernameOf(player);
  const holder = office.holder;
  const ownOffice = holder?.kind === "player" && holder.ref === username;
  const isOwner = player.getRights?.()?.getId?.() >= 3;
  if (!ownOffice && !isOwner) {
    player.sendMessage("[Offices] You don't hold that office.");
    return;
  }
  pluginApi.emitCustomEvent("kingdom:office-vacated", {
    officeId,
    kingdomId: office.kingdomId,
  });
  player.sendMessage(`[Offices] The office of ${office.title} (${office.kingdomId}) is vacant.`);
}

function onOfficeCommand(player, args) {
  const sub = (args[0] ?? "list").toLowerCase();
  const rest = args.slice(1);
  if (sub === "claim") return claimOffice(player, rest);
  if (sub === "petition") return Politics.petition(player, rest);
  if (sub === "influence") return Politics.showInfluence(player, rest);
  if (sub === "vacate") return vacateOffice(player, rest);
  return showList(player, sub === "list" ? rest : args);
}

module.exports = function attachCommands(api) {
  pluginApi = api;
  api.registerCommand(
    "office",
    onOfficeCommand,
    api.core.PlayerRights.NONE,
    "Offices: ::office list [kingdom] | claim <id> | petition <id> | influence [kingdom] | vacate <id>"
  );
};
