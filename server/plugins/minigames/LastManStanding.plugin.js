/**
 * Last Man Standing (https://oldschool.runescape.wiki/w/Last_Man_Standing): Casual, Competitive and
 * High Stakes, built from an rsprox recording of eight competitive games and a win
 * (plugins/minigames/data/last-man-standing.json, docs/last-man-standing.md). The units are in
 * ./lms/:
 * - Profile: the saved figures (introduction, rank, wins, kills, games, load-outs, coffer);
 * - Stash: the player's own belongings and stats, kept while they play;
 * - Items: the game's copies of real items behave as those items (specials, ranged, ammunition);
 * - Loadouts: the builds, Lisa's supply chest (646) and the settings (476);
 * - Lobby: Lisa, the three waiting areas, the queues, the overlay and the scoreboard;
 * - Coffer: the coffer, High Stakes fees and the reward chest's winnings;
 * - Match: the arena copy, the countdown, the overlay, deaths, the win, rank and points;
 * - Fog: the safe zone, its markers and the fog's damage;
 * - Loot: keys, chests, crates and the drops of the fallen;
 * - Rewards: Justine's shop (645);
 * - Bots: PvP bots filling the waiting area (world config `LastManStanding:seedBots`).
 */
const Common = require("./lms/Common.LastManStanding");
const Profile = require("./lms/Profile.LastManStanding");
const Stash = require("./lms/Stash.LastManStanding");
const Items = require("./lms/Items.LastManStanding");
const Loadouts = require("./lms/Loadouts.LastManStanding");
const Lobby = require("./lms/Lobby.LastManStanding");
const Coffer = require("./lms/Coffer.LastManStanding");
const Match = require("./lms/Match.LastManStanding");
const Fog = require("./lms/Fog.LastManStanding");
const Loot = require("./lms/Loot.LastManStanding");
const Rewards = require("./lms/Rewards.LastManStanding");
const Bots = require("./lms/Bots.LastManStanding");

module.exports = {
  name: "LastManStanding",
  register(api) {
    Common.init(api);
    Profile.attachProfile(api);
    Stash.attachStash(api);
    Items.attachItems(api);
    Loadouts.attachLoadouts(api);
    Lobby.attachLobby(api);
    Coffer.attachCoffer(api);
    Match.attachMatch(api);
    Fog.attachFog(api);
    Loot.attachLoot(api);
    Rewards.attachRewards(api);
    Bots.attachBots(api);
  },
};
