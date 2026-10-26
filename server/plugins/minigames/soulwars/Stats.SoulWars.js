/**
 * The player's saved Soul Wars figures: Zeal (lifetime), Zeal Tokens (to spend), games, wins, kills
 * and deaths, kept as attributes and shown on their varps at login (recorded: soul_wars_zeal,
 * soul_wars_zeal_tokens, soul_wars_total_*).
 */
const Common = require("./Common.SoulWars");

const FIGURES = Object.keys(Common.FIGURE_ATTRIBUTES);

function loggedIn({ player }) {
  for (const name of FIGURES) {
    const id = Common.core.CacheDefinitions.getVarpId(`soul_wars_${name}`);
    if (id != null) player.getPacketSender().sendConfig(id, Common.getVarp(player, name));
  }
}

function attachStats(api) {
  for (const key of Object.values(Common.FIGURE_ATTRIBUTES)) api.persistAttribute(key, 0);
  api.onPlayerLogin(loggedIn);
}

module.exports = { attachStats, FIGURES };
