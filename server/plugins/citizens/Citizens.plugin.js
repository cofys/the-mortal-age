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
 *   in:  citizens:chat-heard                       (stubbed — see chat/CitizenChat.js)
 *   out: llm:citizen-register                      (llm-gateway plugin)
 *   out: kingdom:rank-granted                       (kingdoms plugin)
 *
 * Boot is gated on CITIZENS_ENABLED=1 so the shipped wilderness population
 * is untouched until this is deliberately switched on.
 */

const { PlayerRights } = require("../../src/main/typescript/elvarg/game/model/rights/PlayerRights");
const { onWarDeclared, onWarEnded } = require("./CitizenEvents");
const { initCitizenChat, onCitizenChatHeard } = require("./chat/CitizenChat");
const { registerCitizenActionTypes } = require("./brain/CitizenActionTypes");
const {
  registerCitizenActivities,
  getBaseRegistry,
} = require("./brain/CitizenActivityRegistry");
const { initDirector, getDirector } = require("./director/CitizenDirector");
const {
  EVENT_WAR_DECLARED,
  EVENT_WAR_ENDED,
  EVENT_CITIZEN_CHAT_HEARD,
  ROLE_GUARD,
  ROLE_MERCHANT,
  ROLE_COMMONER,
  ROLE_COURTIER,
} = require("./constants");

const CITIZENS_ENABLED = (process.env.CITIZENS_ENABLED ?? "0") === "1";

function initCitizens(api) {
  console.log("[DIAG] Citizens plugin loading, CITIZENS_ENABLED=" + process.env.CITIZENS_ENABLED);
  initCitizenChat(api);
  registerCitizenActionTypes();
  const added = registerCitizenActivities();
  api.log?.("[citizens] activities registered", { added });
  if (!CITIZENS_ENABLED) {
    api.log?.("[citizens] director idle — set CITIZENS_ENABLED=1 to spawn the population");
    return;
  }
  const director = initDirector(api, getBaseRegistry());
  director.boot();
  api.log?.("[citizens] director booted", director.status());
}

function onKingdomWarDeclared(event) {
  onWarDeclared(event);
}

function onKingdomWarEnded(event) {
  onWarEnded(event);
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
  player.sendMessage("Usage: ::citizen [status|spawn]");
  return true;
}

module.exports = {
  name: "Citizens",
  register(api) {
    initCitizens(api);
    api.onCustomEvent(EVENT_WAR_DECLARED, onKingdomWarDeclared);
    api.onCustomEvent(EVENT_WAR_ENDED, onKingdomWarEnded);
    api.onCustomEvent(EVENT_CITIZEN_CHAT_HEARD, onCitizenChatHeard);
    api.registerCommand(
      "citizen",
      onCitizenCommand,
      PlayerRights.ADMINISTRATOR,
      "Manage AI citizens: ::citizen [status|spawn]"
    );
  },
};
