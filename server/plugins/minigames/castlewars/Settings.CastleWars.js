"use strict";

let api;
let game;
let core;
const DEFAULTS = Object.freeze({ teamSize: 30, opponent: "mixed", freezeSeconds: 0, barricades: 10 });

function editable(player) {
  const counts = game.queueCounts();
  if (game.getPhase() !== game.PHASE.IDLE || Object.values(counts).some((count) => count > 0)) {
    player.sendMessage("Castle Wars settings are locked until the lobby is empty.");
    return false;
  }
  return true;
}

function choose(context, title, entries, key, back = openSettings) {
  const { player } = context;
  if (!editable(player)) return;
  api.sendMultiChatboxPrompt(player, title, ...entries.flatMap(([label, value]) => [label, () => {
    if (!editable(player)) return;
    game.settings[key] = value;
    back(context);
  }]));
}

function openMoreSettings(context) {
  const { player } = context;
  if (!editable(player)) return;
  const settings = game.settings;
  api.sendMultiChatboxPrompt(player, "More Castle Wars practice settings",
    `Ice freeze: ${settings.freezeSeconds || "standard"}${settings.freezeSeconds ? " seconds" : ""}`, () => choose(context, "Maximum ice freeze", [["Standard", 0], ["10 seconds", 10], ["15 seconds", 15]], "freezeSeconds", openMoreSettings),
    `Barricades per team: ${settings.barricades}`, () => choose(context, "Barricades per team", [["10", 10], ["20", 20]], "barricades", openMoreSettings),
    "Back", () => openSettings(context));
}

function openSettings({ player, requestedTeam = null, portalGod = requestedTeam ?? "guthix" }) {
  if (!editable(player)) return;
  const context = { player, requestedTeam, portalGod };
  const settings = game.settings;
  api.sendMultiChatboxPrompt(player, "Castle Wars practice settings",
    "Join practice", () => { if (editable(player)) game.joinFromLobby(player, requestedTeam, undefined, portalGod); },
    `Teams: ${settings.teamSize} vs ${settings.teamSize}`, () => choose(context, "Players per team", [["1 vs 1", 1], ["3 vs 3", 3], ["5 vs 5", 5], ["10 vs 10", 10], ["30 vs 30", 30]], "teamSize"),
    `Bots: ${settings.opponent}`, () => choose(context, "Practice opponent", [["Mixed team", "mixed"], ["Scorer (magic defence)", "scorer"], ["Defender (magic)", "defender"]], "opponent"),
    "More settings", () => openMoreSettings(context),
    "Reset defaults", () => { if (editable(player)) { Object.assign(settings, DEFAULTS); openSettings(context); } });
}

function capFreeze(event) {
  if (event.kind !== "ice" || !game.settings.freezeSeconds || !game.isPlaying(event.source) || !game.isPlaying(event.target)) return;
  if (event.source.getArea() !== game.gameArea || event.target.getArea() !== game.gameArea) return;
  // Whole ticks: ten seconds is rounded down so the selected limit is never exceeded.
  event.ticks = Math.min(event.ticks, Math.floor(game.settings.freezeSeconds / 0.6));
}

function castleShove(event) {
  if (!game.isPlaying(event.attacker) || !game.isPlaying(event.target)) return;
  if (event.attacker.getArea() !== game.gameArea || event.target.getArea() !== game.gameArea) return;
  if (event.attacker.getEquipment().getSlot(core.Equipment.WEAPON_SLOT) !== core.ItemIdentifiers.ZAMORAKIAN_HASTA) return;
  event.chain = true;
  event.animate = false;
  event.attackDelay = 1;
}

module.exports = function attachCastleWarsSettings(registry, castleWars) {
  api = registry;
  core = registry.core;
  game = castleWars;
  game.settings = { ...DEFAULTS };
  game.getBarricadeLimit = () => game.settings.barricades;
  api.onNpcInteraction("Lanthus", { "Talk-to": openSettings });
  api.onCustomEvent("combat:freeze-duration", capFreeze);
  api.onCustomEvent("combat:shove-rules", castleShove);
};

module.exports._test = { DEFAULTS, openSettings, capFreeze, castleShove };
module.exports.openSettings = openSettings;
