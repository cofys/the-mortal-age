"use strict";

/**
 * Citizens — the CITIZEN SYSTEM for The Mortal Age.
 *
 * The AI population: believable agents that play the game for real
 * (skilling, trading, guarding, socializing) instead of looping bot tasks.
 * Scripted body (BotBrain activities) + LLM mouth (the llm-gateway plugin).
 *
 * Wiring (plugins talk through custom events, never new core hooks):
 *   in:  kingdom:war-declared / kingdom:war-ended  (kingdoms plugin)
 *   in:  kingdom:office-assigned / kingdom:office-vacated (kingdoms plugin;
 *        player office-holders, so citizens address them by title)
 *   in:  citizens:chat-heard                       (stubbed — see chat/CitizenChat.js)
 *   out: llm:citizen-register                      (llm-gateway plugin)
 *   out: kingdom:rank-granted                       (kingdoms plugin)
 *
 * Boot is gated on CITIZENS_ENABLED=1 so the shipped wilderness population
 * is untouched until this is deliberately switched on.
 */

const { PlayerRights } = require("../../src/main/typescript/elvarg/game/model/rights/PlayerRights");
const { onWarDeclared, onWarEnded, onOfficeAssigned, onOfficeVacated } = require("./CitizenEvents");
const { onKingdomRumor, onPatrolOrdered, onWageDay, onPlayerArrived, onSkirmish, onWarDeclaredFear, onWarEndedRelief } = require("./RealmReactions");
const { initCitizenChat, onCitizenChatHeard, onSocialPacket } = require("./chat/CitizenChat");
const { initCitizenSocial, onSocialChatResponse } = require("./chat/CitizenSocial");
const { registerCitizenActionTypes } = require("./brain/CitizenActionTypes");
const {
  registerCitizenActivities,
  getBaseRegistry,
} = require("./brain/CitizenActivityRegistry");
const { initDirector, getDirector } = require("./director/CitizenDirector");
const { initMerchantShops } = require("./shop/MerchantShops");
const { initPlayerShops } = require("./shop/PlayerShops");
const { initMarketBoard } = require("./shop/MarketBoard.Shops");
const { initMarketRegistrar } = require("./shop/MarketRegistrar.Shops");
const attachWarRefugees = require("./WarRefugees");
const {
  getMemory,
  initCitizenMemory,
  GRUDGE_ATTACK,
  GRUDGE_THEFT,
  GOSSIP_ATTACK,
  GOSSIP_THEFT,
  GOSSIP_OFFICE,
} = require("./lib/CitizenMemory");
const { initCitizenJournal } = require("./lib/CitizenJournal");
const KingdomStore = require("../kingdoms/KingdomStore");
const {
  EVENT_WAR_DECLARED,
  EVENT_WAR_ENDED,
  EVENT_CITIZEN_CHAT_HEARD,
  EVENT_OFFICE_ASSIGNED,
  EVENT_OFFICE_VACATED,
  ATTR_CITIZEN_ROLE,
  ATTR_KINGDOM_ID,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_COMMONER,
  ROLE_COURTIER,
} = require("./constants");

function citizensEnabled() {
  // Check at runtime, not module load — the module may be cached from a
  // context where the env var wasn't set yet.
  return (process.env.CITIZENS_ENABLED ?? "1") === "1";
}

let pluginApi = null;

function initCitizens(api) {
  pluginApi = api;
  initCitizenChat(api);
  initCitizenSocial(api);
  initCitizenMemory();
  initCitizenJournal();
  registerCitizenActionTypes();
  const added = registerCitizenActivities();
  api.log?.("[citizens] activities registered", { added });
  initMarketBoard(api);
  initMarketRegistrar(api);
  if (!citizensEnabled()) {
    api.log?.("[citizens] director idle — set CITIZENS_ENABLED=1 to spawn the population");
    return;
  }
  const director = initDirector(api, getBaseRegistry());
  director.boot();
  console.log("[citizens] director booted, roster:", director.roster.size);
  initMerchantShops(api);
  initPlayerShops(api);
  api.log?.("[citizens] director booted", director.status());
}

function onKingdomWarDeclared(event) {
  onWarDeclared(event);
}

function onKingdomWarEnded(event) {
  onWarEnded(event);
}

function onKingdomOfficeAssigned(event) {
  onOfficeAssigned(event);
  // Office wins travel: "Did you hear? X took the Steward's seals!"
  const holder = event?.holder;
  const kingdomId = event?.kingdomId;
  if (holder?.kind !== "player" || !holder.ref || !kingdomId) {
    return;
  }
  const memory = getMemory();
  const title =
    event.title ?? String(event.officeId ?? "office").split(":").pop();
  const kingdomName = KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
  const seed = kingdomGossipSeed(kingdomId);
  memory.seedGossip({
    kingdomId,
    kind: GOSSIP_OFFICE,
    subject: holder.ref,
    text: `took the ${title} of ${kingdomName}!`,
    holder: seed,
  });
  pluginApi?.emitCustomEvent("kingdom:rumor", {
    kingdomId,
    text: `Did you hear? ${holder.ref} took the ${title} of ${kingdomName}!`,
  });
}

/** Any citizen username of the kingdom to seed a rumor with (online first). */
function kingdomGossipSeed(kingdomId) {
  const director = getDirector();
  if (!director) {
    return "";
  }
  const online = director.onlineBotsForKingdom(kingdomId);
  if (online.length > 0) {
    return online[0].getUsername?.() ?? "";
  }
  for (const record of director.roster.values()) {
    if (record.kingdomId === kingdomId) {
      return record.username;
    }
  }
  return "";
}

function isCitizenBot(player) {
  return player?.getAttribute?.(ATTR_CITIZEN_ROLE) != null;
}

/** Citizen bots in the player's local players (excluding `exclude`). */
function nearbyCitizens(player, exclude = null) {
  const out = [];
  for (const local of player.getLocalPlayers?.() ?? []) {
    if (local === exclude || !isCitizenBot(local)) {
      continue;
    }
    out.push(local);
  }
  return out;
}

const ATTACK_OUTCRY = [
  "Guards! I'm attacked!",
  "Help! Murder in the street!",
  "You'll pay for that, villain!",
];

/** A real player attacked a citizen: grudge, outcry, witnesses, gossip. */
function onCitizenAttackedByPlayer({ player, target }) {
  if (!player || !target) {
    return;
  }
  if (player.isPlayerBot?.() === true) {
    return; // citizen-on-citizen scraps don't make grudges
  }
  if (!isCitizenBot(target)) {
    return;
  }
  const memory = getMemory();
  const attackerName = player.getUsername?.() ?? "?";
  const victimName = target.getUsername?.() ?? "?";
  memory.addGrudge(victimName, attackerName, GRUDGE_ATTACK, "attack");
  try {
    target.forceChat?.(
      ATTACK_OUTCRY[Math.floor(Math.random() * ATTACK_OUTCRY.length)]
    );
  } catch (error) {
    // Cosmetic.
  }
  const kingdomId = target.getAttribute?.(ATTR_KINGDOM_ID);
  for (const witness of nearbyCitizens(player, target)) {
    memory.heardAbout(
      witness.getUsername?.() ?? "?",
      attackerName,
      GOSSIP_ATTACK,
      1
    );
  }
  memory.seedGossip({
    kingdomId,
    kind: GOSSIP_ATTACK,
    subject: attackerName,
    text: `attacked ${victimName} in the street!`,
    holder: victimName,
  });
  pluginApi?.log?.("[citizens] citizen attacked", {
    victim: victimName,
    attacker: attackerName,
    kingdom: kingdomId,
  });
}

/**
 * A player stole something with citizens watching (market stalls,
 * pickpocketing): witnesses remember the thief — cold shoulders, gossip.
 */
function onThievingWitnessed(event) {
  const player = event?.player;
  if (!player || player.isPlayerBot?.() === true) {
    return;
  }
  const witnesses = nearbyCitizens(player);
  if (witnesses.length === 0) {
    return;
  }
  const memory = getMemory();
  const thiefName = player.getUsername?.() ?? "?";
  let kingdomId = null;
  for (const witness of witnesses) {
    const witnessName = witness.getUsername?.() ?? "?";
    kingdomId = kingdomId ?? witness.getAttribute?.(ATTR_KINGDOM_ID);
    memory.recordTone(witnessName, thiefName, -2);
    memory.addGrudge(witnessName, thiefName, GRUDGE_THEFT, "theft-witnessed");
  }
  memory.seedGossip({
    kingdomId,
    kind: GOSSIP_THEFT,
    subject: thiefName,
    text: "caught stealing, bold as brass!",
    holder: witnesses[0].getUsername?.() ?? "",
  });
  pluginApi?.emitCustomEvent("kingdom:rumor", {
    kingdomId,
    text: `Did you hear what ${thiefName} did? Caught stealing at the market!`,
  });
  pluginApi?.log?.("[citizens] theft witnessed", {
    thief: thiefName,
    witnesses: witnesses.length,
    kingdom: kingdomId,
  });
}

function onKingdomOfficeVacated(event) {
  onOfficeVacated(event);
}

function onCitizenSocialPacket(event) {
  onSocialPacket(event);
}

function onSocialThreadResponse(payload) {
  onSocialChatResponse(payload);
}

function onCitizenCommand({ player, parts }) {
  const director = getDirector();
  const sub = (parts[1] ?? "status").toLowerCase();
  if (sub === "status") {
    if (!director) {
      player.sendMessage("Citizen director is not running (CITIZENS_ENABLED=0).");
      return true;
    }
    const status = director.status();
    player.sendMessage(
      `Citizens: ${status.online}/${status.total} online. ` +
        `Roles: ${JSON.stringify(status.byRole)}`
    );
    return true;
  }
  if (sub === "spawn") {
    if (!director) {
      player.sendMessage("Citizen director is not running (CITIZENS_ENABLED=0).");
      return true;
    }
    const role = (parts[2] ?? "").toLowerCase();
    const kingdomId = (parts[3] ?? "").toLowerCase();
    if (![ROLE_GUARD, ROLE_MERCHANT, ROLE_COMMONER, ROLE_COURTIER].includes(role)) {
      player.sendMessage("Usage: ::citizen spawn <guard|merchant|commoner|courtier> <kingdom>");
      return true;
    }
    const record = director.addCitizen(kingdomId, role);
    const ok = director.spawnCitizen(record);
    player.sendMessage(
      ok ? `Spawned ${record.username} (${role}, ${kingdomId}).` : "Spawn failed."
    );
    return true;
  }
  if (sub === "memory") {
    const target = (parts[2] ?? "").trim();
    if (!target) {
      player.sendMessage("Usage: ::citizen memory <player>");
      return true;
    }
    const memory = getMemory();
    const rows = [];
    for (const [key, record] of memory.citizens) {
      const held = record.players.get(target.toLowerCase());
      if (!held) {
        continue;
      }
      const standing = memory.standing(record.display, target);
      const mult = memory.priceMultiplier(record.display, target);
      rows.push(
        `${record.display}: ${standing} (met ${held.entry.met}x, spent ${held.entry.spent}, x${mult})`
      );
      if (rows.length >= 8) {
        break;
      }
    }
    player.sendMessage(
      rows.length > 0
        ? `Memory of ${target}: ${rows.join(" | ")}`
        : `No citizen remembers ${target} yet.`
    );
    return true;
  }
  player.sendMessage("Usage: ::citizen [status|spawn|memory <player>]");
  return true;
}

function onKingdomRumorHeard(event) {
  onKingdomRumor(event);
}

function onKingdomPatrolOrdered(event) {
  onPatrolOrdered(event);
}

function onKingdomWageDay(event) {
  const total = onWageDay(event) ?? 0;
  // The steward's ledger records real wages paid (kingdom:wages-paid).
  if (total > 0) {
    pluginApi?.emitCustomEvent("kingdom:wages-paid", {
      kingdomId: event?.kingdomId,
      total,
    });
  }
}

function onArrivalPlayerArrived(event) {
  onPlayerArrived(event);
}

function onKingdomSkirmish(event) {
  onSkirmish(event);
}

function onKingdomWarDeclaredFear(event) {
  onWarDeclaredFear(event);
}

function onKingdomWarEndedRelief(event) {
  onWarEndedRelief(event);
}

module.exports = {
  name: "Citizens",
  register(api) {
    initCitizens(api);
    attachWarRefugees(api);
    api.onCustomEvent(EVENT_WAR_DECLARED, onKingdomWarDeclared);
    api.onCustomEvent(EVENT_WAR_ENDED, onKingdomWarEnded);
    api.onCustomEvent(EVENT_WAR_DECLARED, onKingdomWarDeclaredFear);
    api.onCustomEvent(EVENT_WAR_ENDED, onKingdomWarEndedRelief);
    api.onCustomEvent("kingdom:skirmish", onKingdomSkirmish);
    api.onCustomEvent(EVENT_OFFICE_ASSIGNED, onKingdomOfficeAssigned);
    api.onCustomEvent(EVENT_OFFICE_VACATED, onKingdomOfficeVacated);
    api.onCustomEvent(EVENT_CITIZEN_CHAT_HEARD, onCitizenChatHeard);
    api.onCustomEvent("llm:chat-response", onSocialThreadResponse);
    api.onCustomEvent("kingdom:rumor", onKingdomRumorHeard);
    api.onCustomEvent("kingdom:patrol-ordered", onKingdomPatrolOrdered);
    api.onCustomEvent("kingdom:wage-day", onKingdomWageDay);
    api.onCustomEvent("arrival:player-arrived", onArrivalPlayerArrived);
    api.onPlayerAttack(onCitizenAttackedByPlayer);
    api.onCustomEvent("thieving:success", onThievingWitnessed);
    api.onSocialPacket(onCitizenSocialPacket);
    api.registerCommand(
      "citizen",
      onCitizenCommand,
      PlayerRights.ADMINISTRATOR,
      "Manage AI citizens: ::citizen [status|spawn]"
    );
  },
};
