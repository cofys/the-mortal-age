"use strict";

/**
 * Commands.Kingdoms — ::office (PLAYER).
 *
 * Offices of the realm are holdable by AI citizens or players — the holder
 * is data, and this command is the player-facing half of the interchange.
 * v1: claim a vacant office, vacate one you hold, list who holds what.
 * Taking an AI-held office by politics (challenge, appointment, election)
 * is the next step; the registry already supports it.
 *
 *   ::office list [kingdomId]  — offices and their holders
 *   ::office claim <officeId>  — claim a vacant office (officeId looks like asgarnia:quartermaster)
 *   ::office vacate <officeId> — vacate an office you hold
 */

const Offices = require("./Offices.Kingdoms");

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
        "Offices change hands by politics, not command — for now."
    );
    return;
  }
  const username = usernameOf(player);
  if (!username) return;
  pluginApi.emitCustomEvent("kingdom:office-assigned", {
    officeId,
    kingdomId: office.kingdomId,
    holder: { kind: "player", ref: username },
  });
  player.sendMessage(`[Offices] You now hold the office of ${office.title} (${office.kingdomId}). Rule well.`);
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
  if (sub === "vacate") return vacateOffice(player, rest);
  return showList(player, sub === "list" ? rest : args);
}

module.exports = function attachCommands(api) {
  pluginApi = api;
  api.registerCommand(
    "office",
    onOfficeCommand,
    api.core.PlayerRights.NONE,
    "Offices: ::office list [kingdom] | claim <id> | vacate <id>"
  );
};
