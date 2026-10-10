"use strict";

/**
 * Castle Wars lobby: the team portals (Guthix balances the teams), the lobby bank chest, and the
 * portals back out of the waiting rooms and the game. In development a real player joining seeds
 * bots so a game can start; production worlds leave that off (world.json pluginConfig
 * "CastleWars:seedBots").
 */

const FoodPlugin = require("../../items/Food.plugin");
const { createBotPlayer } = require("../../bots/behaviours/spawn/BotPlayerFactory");
const { ATTR_SKIP_PERSISTENCE } = require("../../bots/runtime/BotPersistenceConstants");
const { ShopManager } = require("../../../src/main/typescript/elvarg/game/model/container/shop/ShopManager");

const CASTLE_WARS_TICKET_EXCHANGE_SHOP = 1432;
const SEED_BOTS_CONFIG_KEY = "CastleWars:seedBots";
const BOT_ROLE_ATTRIBUTE = "castlewars:bot-role";
const BOT_TIER_ATTRIBUTE = "castlewars:bot-tier";
const BOTS_PER_TEAM = 30;
// The lobby prompt's bot choices; the label is what the player clicks, the value the tier
// Bots.CastleWars pins each spawned bot's loadout and combat level band to.
const BOT_TIER_OPTIONS = Object.freeze([
  ["Novice", "novice"],
  ["Intermediate", "intermediate"],
  ["Veteran", "veteran"],
]);
// One entry per bot slot: attackers, flag runners, stand guards, one keeper per gate, two
// battlement archers, two battlement mages and one catapult crew, per team.
const BOT_ROLE_MIX = Object.freeze([
  ...Array(12).fill("attacker"),
  ...Array(6).fill("flag"),
  ...Array(5).fill("guard"),
  "doorman",
  "side-doorman",
  ...Array(2).fill("archer"),
  ...Array(2).fill("mage"),
  "catapult",
]);

const FOOD_ITEM_IDS = Array.isArray(FoodPlugin.FOOD_ITEM_IDS) ? FoodPlugin.FOOD_ITEM_IDS : [];

let api;
let game;
let core;
let data;
let botSerial = 0;

function moveToWaitingRoom(player, teamId) {
  game.setTeamId(player, teamId);
  player.sendMessage(`You have been added to the ${game.getTeamData(teamId).name} team.`);
  if (player.isPlayerBot?.() === true) {
    // Straight into the room: a bot still walking when the countdown ends misses the start
    // move and then squats the waiting room for the whole match, blocking the next prompt.
    player.moveTo(game.getTeamData(teamId).waitingRoom);
    return;
  }
  player.smartMove(game.getTeamData(teamId).waitingRoom, 8);
}

function spawnCastleWarsBot(teamId, role = "attacker", username = `CWBot${++botSerial}`, tier = null) {
  const bot = createBotPlayer(username, data.LOBBY_TELEPORT, { api, loadPersistence: false, saveRandomizedAppearance: false });
  if (!bot) {
    return;
  }
  bot.setPlayerBot(true);
  bot.setAttribute(ATTR_SKIP_PERSISTENCE, true);
  bot.setAttribute(game.BOT_KEY, true);
  bot.setAttribute(BOT_ROLE_ATTRIBUTE, role);
  if (tier) {
    bot.setAttribute(BOT_TIER_ATTRIBUTE, tier);
  }
  api.emitPlayerLogin({ player: bot, username });
  moveToWaitingRoom(bot, teamId);
}

/** Stable names per team slot, so a repeated populate skips bots that are already in. */
function castleWarsBotUsername(teamId, index) {
  return `CWBot${teamId === data.TEAM.SARADOMIN ? "S" : "Z"}${index}`;
}

function populateCastleWarsBots(teamId, tier) {
  const opposingTeam = game.opposingTeam(teamId);
  for (let index = 0; index < BOTS_PER_TEAM; index++) {
    const role = BOT_ROLE_MIX[index % BOT_ROLE_MIX.length];
    spawnCastleWarsBot(teamId, role, castleWarsBotUsername(teamId, index), tier);
    spawnCastleWarsBot(opposingTeam, role, castleWarsBotUsername(opposingTeam, index), tier);
  }
}

function seedCastleWarsBots(teamId) {
  const opposingTeam = game.opposingTeam(teamId);
  spawnCastleWarsBot(teamId, "attacker");
  spawnCastleWarsBot(opposingTeam, "guard");
  spawnCastleWarsBot(opposingTeam, "flag");
}

/** Dev-only bot seeding: off unless world.json turns it on, so production lobbies are players only. */
function seedsBots(registry = api) {
  return registry.getPluginConfig(SEED_BOTS_CONFIG_KEY, false) === true;
}

/** The team a joiner lands on, or null when the requested team is already the bigger one. */
function chooseTeam(sizes, requestedTeam) {
  const { SARADOMIN, ZAMORAK } = data.TEAM;
  const other = (team) => (team === SARADOMIN ? ZAMORAK : SARADOMIN);
  if (requestedTeam == null) {
    return sizes[ZAMORAK] > sizes[SARADOMIN] ? SARADOMIN : ZAMORAK;
  }
  return sizes[requestedTeam] > sizes[other(requestedTeam)] ? null : requestedTeam;
}

function joinWaitingRoom(player, requestedTeam) {
  const phase = game.getPhase();
  if (phase === game.PHASE.ACTIVE || phase === game.PHASE.ENDING) {
    player.sendMessage("There's already a Castle Wars game running. Please wait.");
    return;
  }
  const { HEAD_SLOT, CAPE_SLOT } = core.Equipment;
  if (player.getEquipment().getSlot(HEAD_SLOT) > 0 || player.getEquipment().getSlot(CAPE_SLOT) > 0) {
    player.sendMessage("You can't wear hats, capes, or helms in Castle Wars.");
    return;
  }
  if (FOOD_ITEM_IDS.length > 0 && player.getInventory().containsAny(FOOD_ITEM_IDS)) {
    player.sendMessage("You may not bring your own consumables inside Castle Wars.");
    return;
  }

  const counts = game.queueCounts();
  const teamId = chooseTeam(counts, requestedTeam);
  if (!teamId) {
    const team = game.getTeamData(requestedTeam).name;
    const other = game.getTeamData(game.opposingTeam(requestedTeam)).name;
    player.sendMessage(`The ${team} team is full, try ${other}.`);
    return;
  }

  const isBot = player.isPlayerBot() === true;
  const lobbyEmpty = counts[data.TEAM.SARADOMIN] === 0 && counts[data.TEAM.ZAMORAK] === 0;
  // The empty-lobby prompt replaces the dev seeding path, and returning after it means the
  // config seeding below can never double up on bots. The chosen tier sets the spawned
  // bots' combat level band and gear; None leaves the game player-only.
  if (!isBot && lobbyEmpty && !seedsBots()) {
    const options = BOT_TIER_OPTIONS.flatMap(([label, tier]) => [
      label,
      () => {
        populateCastleWarsBots(teamId, tier);
        moveToWaitingRoom(player, teamId);
      },
    ]);
    api.sendMultiChatboxPrompt(
      player,
      "The Castle Wars lobby is empty. Which bots should populate the game?",
      ...options,
      "None",
      () => moveToWaitingRoom(player, teamId)
    );
    return;
  }

  moveToWaitingRoom(player, teamId);
  if (!isBot && seedsBots()) {
    seedCastleWarsBots(teamId);
  }
}

function handleLobbyObject(player, object, clickType) {
  const id = object.getId();
  if (id === core.ObjectIdentifiers.BANK_CHEST_2) {
    if (clickType === 1) {
      player.getBank(player.getCurrentBankTab()).open();
    } else {
      player.sendMessage("The Grand Exchange is not available here.");
    }
    return true;
  }
  if (id in data.LOBBY_TEAMS) {
    joinWaitingRoom(player, data.LOBBY_TEAMS[id]);
    return true;
  }
  return false;
}

function useCastleWarsPortal(event) {
  const { player, object, clickType } = event;
  const location = object.getLocation();
  const id = object.getId();
  const inWaitingRoom = Object.values(data.TEAM_DATA).some((team) => team.waitingBounds.some((boundary) => boundary.inside(location)));
  let handled = false;
  if (data.LOBBY_BOUNDS.some((boundary) => boundary.inside(location))) {
    handled = handleLobbyObject(player, object, clickType);
  } else if (inWaitingRoom && data.WAITING_EXIT_IDS.has(id)) {
    game.returnToLobby(player);
    handled = true;
  } else if (game.inGameBounds(location) && data.GAME_EXIT_IDS.has(id)) {
    game.returnToLobby(player, "The Castle Wars game has ended for you.");
    handled = true;
  }
  if (handled) {
    event.handled = true;
  }
}

module.exports = function attachCastleWarsLobby(registry, castleWars) {
  api = registry;
  game = castleWars;
  core = registry.core;
  data = castleWars.data;
  game.BOT_ROLE_KEY = BOT_ROLE_ATTRIBUTE;
  game.BOT_TIER_KEY = BOT_TIER_ATTRIBUTE;
  registry.onObjectInteraction(useCastleWarsPortal);
  registry.onNpcInteraction("Lanthus", { Trade: ({ player }) => ShopManager.open(player, CASTLE_WARS_TICKET_EXCHANGE_SHOP) });
};

module.exports._test = { chooseTeam, seedsBots, SEED_BOTS_CONFIG_KEY, FOOD_ITEM_IDS, BOT_TIER_OPTIONS };
