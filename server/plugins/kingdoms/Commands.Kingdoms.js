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
const Store = require("./KingdomStore");
const Simulation = require("./Simulation.Kingdoms");
const Tension = require("./Tension.Kingdoms");
const Alliances = require("./Alliances.Kingdoms");

let pluginApi = null;

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * ::office list data — every office (and its holder) in the realm, or in one
 * kingdom. Returns plain lines; the command adds its own headers. The
 * steward's audience renders the same lines in-dialogue.
 */
function officeListLines(kingdomId = null, max = 20) {
  return Offices.getOffices(kingdomId)
    .slice(0, max)
    .map((o) => `${o.officeId} — ${o.title}: ${Offices.holderName(o.holder)}`);
}

function showList(player, args) {
  const kingdomId = args[0] ?? null;
  const lines = officeListLines(kingdomId);
  if (lines.length === 0) {
    player.sendMessage("[Offices] No offices found.");
    return;
  }
  player.sendMessage("[Offices] Offices of the realm:");
  for (const line of lines) {
    player.sendMessage(`  ${line}`);
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

/**
 * ::kingdom status data — the realm at a glance: treasury, stockpile,
 * offices, wars. Returns plain lines; the command adds its own headers.
 * The war table renders the same lines in-interface.
 */
function realmStatusLines(maxKingdoms = 8) {
  const kingdoms = Store.getKingdoms();
  if (kingdoms.length === 0) return [];
  const wars = Store.getActiveWars();
  return kingdoms.slice(0, maxKingdoms).map((k) => {
    const treasury = k.treasury ?? 0;
    const stockpile = Simulation.stockpileOf(k.id);
    const atWar = wars.some((w) => w.attackerId === k.id || w.defenderId === k.id);
    const offices = Offices.getOffices(k.id);
    const vacant = offices.filter((o) => !o.holder).map((o) => o.office);
    return (
      `${k.name}: ${treasury}c treasury, ${stockpile} stores` +
      (atWar ? " — AT WAR" : "") +
      (vacant.length > 0 ? ` — vacant: ${vacant.join(", ")}` : "")
    );
  });
}

function showKingdomStatus(player) {
  const lines = realmStatusLines();
  if (lines.length === 0) {
    player.sendMessage("[Kingdom] No kingdoms yet.");
    return;
  }
  player.sendMessage("[Kingdom] The realm at a glance:");
  for (const line of lines) player.sendMessage(`  ${line}`);
}

function onKingdomCommand(player, args) {
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "status") return showKingdomStatus(player);
  player.sendMessage("[Kingdom] Usage: ::kingdom status");
}

function ago(timestamp) {
  const mins = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function tensionWord(tension) {
  return tension >= 90 ? "WAR FEVER" : tension >= 70 ? "skirmishes" : tension >= 55 ? "grumbling" : "calm";
}

/**
 * ::war data — open wars, hottest borders, levies. The command adds its own
 * headers; the war table renders wars + hot borders in-interface.
 */
function warSummary({ maxWars = 5, maxHot = 5, maxLevies = 8 } = {}) {
  const wars = Store.getActiveWars()
    .slice(0, maxWars)
    .map((w) => {
      const a = Store.getKingdom(w.attackerId)?.name ?? w.attackerId;
      const d = Store.getKingdom(w.defenderId)?.name ?? w.defenderId;
      return (
        `${a} vs ${d} — declared ${ago(w.declaredAt)}` +
        (w.reason ? `: ${w.reason}` : "")
      );
    });
  const hot = Tension.hottestPairs(maxHot).map(
    (h) => `${h.aName} / ${h.bName}: tension ${h.tension} (${tensionWord(h.tension)})`
  );
  const levies = Store.getKingdoms()
    .slice(0, maxLevies)
    .map((k) => `${k.name}: ${Tension.garrisonOf(k.id)}/60`);
  return { wars, hot, levies };
}

/** ::war — the state of the realm's wars, hottest borders, and levies. */
function showWarStatus(player) {
  const { wars, hot, levies } = warSummary();
  player.sendMessage("[War] The state of the realm's wars:");
  if (wars.length === 0) {
    player.sendMessage("  No open wars — an uneasy peace.");
  }
  for (const w of wars) player.sendMessage(`  ${w}`);
  player.sendMessage("[War] Hottest borders:");
  if (hot.length === 0) {
    player.sendMessage("  The borders are quiet.");
  }
  for (const h of hot) player.sendMessage(`  ${h}`);
  player.sendMessage("[War] Levies (garrison strength):");
  for (const l of levies) player.sendMessage(`  ${l}`);
}

function onWarCommand(player, args) {
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "status") return showWarStatus(player);
  player.sendMessage("[War] Usage: ::war");
}

/**
 * ::alliances data — the realm's pacts and the royal calendar's recent news.
 * The command adds its own headers; the war table renders both in-interface.
 */
function allianceSummary({ maxPacts = 8, maxNews = 16 } = {}) {
  const pacts = Alliances.pactSummary()
    .slice(0, maxPacts)
    .map((p) => {
      const risk = p.betrayalRisk >= 70 ? "— the court whispers of knives" :
        p.betrayalRisk >= 40 ? "— strained" : "— firm";
      return `${p.pactName}: ${p.aName} & ${p.bName} (bond ${p.strength}/5 ${risk})`;
    });
  const news = [];
  for (const k of Store.getKingdoms().slice(0, 8)) {
    const log = k.flags?.["royals:log"] ?? [];
    for (const entry of log.slice(0, 2)) {
      news.push(`${k.name} — ${entry.type}: ${entry.text.slice(0, 110)}`);
      if (news.length >= maxNews) break;
    }
    if (news.length >= maxNews) break;
  }
  return { pacts, news };
}

/** ::alliances — the realm's pacts, and the royal calendar's recent news. */
function showAlliances(player) {
  const { pacts, news } = allianceSummary();
  player.sendMessage("[Alliances] The realm's pacts:");
  if (pacts.length === 0) {
    player.sendMessage("  No pacts sealed — every crown stands alone.");
  }
  for (const p of pacts) player.sendMessage(`  ${p}`);
  player.sendMessage("[Alliances] Recent royal news:");
  if (news.length === 0) {
    player.sendMessage("  The courts have been quiet.");
  }
  for (const n of news) player.sendMessage(`  ${n}`);
}

function onAlliancesCommand(player, args) {
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "status") return showAlliances(player);
  player.sendMessage("[Alliances] Usage: ::alliances");
}

function attachCommands(api) {
  pluginApi = api;
  api.registerCommand(
    "office",
    onOfficeCommand,
    api.core.PlayerRights.NONE,
    "Offices: ::office list [kingdom] | claim <id> | petition <id> | influence [kingdom] | vacate <id>"
  );
  api.registerCommand(
    "kingdom",
    onKingdomCommand,
    api.core.PlayerRights.NONE,
    "Kingdom: ::kingdom status"
  );
  api.registerCommand(
    "war",
    onWarCommand,
    api.core.PlayerRights.NONE,
    "War: ::war — open wars, hottest borders, levies"
  );
  api.registerCommand(
    "alliances",
    onAlliancesCommand,
    api.core.PlayerRights.NONE,
    "Alliances: ::alliances — the realm's pacts and recent royal news"
  );
}

// Data exports for diegetic renderers (the war table reuses these; the
// ::commands above keep working during the no-commands migration).
module.exports = attachCommands;
module.exports.realmStatusLines = realmStatusLines;
module.exports.warSummary = warSummary;
module.exports.allianceSummary = allianceSummary;
// The steward's audience (phase 2) drives the same office flows in-dialogue.
module.exports.officeListLines = officeListLines;
module.exports.showList = showList;
module.exports.vacateOffice = vacateOffice;
