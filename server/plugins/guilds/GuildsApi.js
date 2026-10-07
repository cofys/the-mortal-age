"use strict";

/**
 * GuildsApi — HTTP data layer for guilds.
 *
 *   GET /api/guilds?action=list
 *     -> { guilds: [{ id, name, banner, memberCount, kingdomId, founderDisplay }] }
 *
 *   GET /api/guilds?player=<username>
 *     -> { guild: <summary|null>, invites: [{ guildId, guildName, from }] }
 *
 *   GET /api/guilds?action=info&guild=<id|name>
 *     -> { guild: <summary> }
 *
 * Management actions (player-scoped, for the future web overlay):
 *   action=create&player=<name>&name=<guild>&banner=<b>&description=<d>
 *   action=setdescription&player=<name>&text=<d>
 *   action=setbanner&player=<name>&banner=<b>
 *   action=invite&player=<name>&target=<name>
 *   action=accept&player=<name>&guild=<id>
 *   action=decline&player=<name>&guild=<id>
 *   action=leave&player=<name>
 *   action=promote&player=<name>&target=<name>
 *   action=demote&player=<name>&target=<name>
 *   action=kick&player=<name>&target=<name>
 *   action=disband&player=<name>&confirm=yes
 */

const Registry = require("./GuildRegistry");

let apiRef = null;

function findPlayer(username) {
  try {
    return apiRef?.core?.World?.getPlayerByName?.(username) ?? null;
  } catch {
    return null;
  }
}

function playerKingdomId(player) {
  try {
    return require("../quests/mortal/QuestUtil").playerKingdomId(player);
  } catch {
    return null;
  }
}

function err(message) {
  return { error: String(message) };
}

function handle(query) {
  const action = (query.get("action") || "").trim().toLowerCase();
  const playerName = (query.get("player") || "").trim();

  if (action === "list") {
    return { guilds: Registry.listGuilds() };
  }

  if (action === "info") {
    const key = (query.get("guild") || "").trim();
    const g = Registry.getGuild(key) ?? Registry.getGuildByName(key);
    if (!g) return err("No such guild.");
    return { guild: Registry.guildSummary(g.id) };
  }

  // Player-scoped reads.
  if (!action && playerName) {
    const g = Registry.memberGuild(playerName);
    return {
      guild: g ? Registry.guildSummary(g.id) : null,
      invites: Registry.pendingInvitesFor(playerName),
    };
  }

  // Management actions need a player.
  const player = playerName ? findPlayer(playerName) : null;
  if (!player) return err("Player not found or not online.");

  const displayOf = (p) => {
    try { return p.getUsername?.() ?? playerName; } catch { return playerName; }
  };

  if (action === "create") {
    const res = Registry.createGuild({
      founderName: playerName,
      founderDisplay: displayOf(player),
      name: query.get("name") ?? "",
      banner: query.get("banner") ?? "",
      description: query.get("description") ?? "",
      kingdomId: playerKingdomId(player),
    });
    if (res.error) return err(res.error);
    return { created: Registry.guildSummary(res.guild.id) };
  }

  const guild = Registry.memberGuild(playerName);
  if (!guild && !["accept", "decline"].includes(action)) {
    return err("You're not in a guild.");
  }

  if (action === "accept") {
    const key = (query.get("guild") || "").trim();
    const g = Registry.getGuild(key) ?? Registry.getGuildByName(key);
    if (!g) return err("No such guild.");
    const res = Registry.acceptInvite(g.id, playerName, displayOf(player), "player");
    if (res.error) return err(res.error);
    return { joined: Registry.guildSummary(g.id) };
  }

  if (action === "decline") {
    const key = (query.get("guild") || "").trim();
    const g = Registry.getGuild(key) ?? Registry.getGuildByName(key);
    if (!g) return err("No such guild.");
    Registry.declineInvite(g.id, playerName);
    return { declined: true };
  }

  // The rest operate on the player's own guild.
  const target = (query.get("target") || "").trim();

  switch (action) {
    case "setdescription": {
      const res = Registry.setDescription(guild.id, query.get("text") ?? "", playerName);
      return res.error ? err(res.error) : { description: res.description };
    }
    case "setbanner": {
      const res = Registry.setBanner(guild.id, query.get("banner") ?? "", playerName);
      return res.error ? err(res.error) : { banner: res.banner };
    }
    case "invite": {
      if (!target) return err("Invite whom?");
      const res = Registry.inviteMember(guild.id, target, target, playerName, displayOf(player));
      return res.error ? err(res.error) : { invited: res.invited };
    }
    case "leave": {
      const res = Registry.removeMember(guild.id, playerName, playerName);
      return res.error ? err(res.error) : { left: true };
    }
    case "promote": {
      if (!target) return err("Promote whom?");
      const res = Registry.setRank(guild.id, target, Registry.RANK_OFFICER, playerName);
      return res.error ? err(res.error) : { promoted: target };
    }
    case "demote": {
      if (!target) return err("Demote whom?");
      const res = Registry.setRank(guild.id, target, Registry.RANK_MEMBER, playerName);
      return res.error ? err(res.error) : { demoted: target };
    }
    case "kick": {
      if (!target) return err("Kick whom?");
      const res = Registry.removeMember(guild.id, target, playerName);
      return res.error ? err(res.error) : { kicked: res.removed };
    }
    case "disband": {
      if ((query.get("confirm") || "").toLowerCase() !== "yes") {
        return { confirm: `Say it with confirm=yes — disbanding '${guild.name}' is permanent.` };
      }
      const res = Registry.disbandGuild(guild.id, playerName);
      return res.error ? err(res.error) : { disbanded: res.disbanded };
    }
    default:
      return err(`Unknown action '${action}'.`);
  }
}

function attach(api) {
  apiRef = api;
  console.info("[guilds-api] registering guilds endpoint");
  api.registerContentEndpoint("guilds", (query) => {
    try {
      return handle(query);
    } catch (e) {
      return err(e?.message ?? "Guilds endpoint failed.");
    }
  });
}

module.exports = { attach };
