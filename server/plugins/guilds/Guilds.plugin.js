"use strict";

/**
 * Guilds — player-founded guilds with AI citizen members.
 *
 * Players found guilds by saying "found a guild called <name>" in public
 * chat (diegetic — no ::commands). Officers recruit citizens with
 * "recruit <name>"; citizens with compatible personalities and friendships
 * inside the guild sometimes ask to join on their own.
 *
 * Guilds muster at their guild hall (the kingdom tavern) and head out on
 * outings together — tavern nights, fishing trips, market runs — with
 * player members invited along. All data tier, zero LLM; the journal and
 * LLM context keep the foreground truthful.
 */

const Registry = require("./GuildRegistry");
const Recruitment = require("./GuildRecruitment");
const GuildsApi = require("./GuildsApi");

const BOT_HOST_ADDRESS = "bot"; // set by bots/behaviours/spawn/BotPlayerFactory.js

let pluginApi = null;

function isCitizenBot(player) {
  return player?.getHostAddress?.() === BOT_HOST_ADDRESS;
}

function playerKingdomId(player) {
  try {
    return require("./../quests/mortal/QuestUtil").playerKingdomId(player);
  } catch {
    return null;
  }
}

function send(player, text) {
  try {
    player.sendMessage(String(text));
  } catch {
    // Non-fatal.
  }
}

/** Find a citizen bot by display-ish name among the speaker's local players. */
function findNearbyCitizen(speaker, name) {
  const want = Registry.normalizeName(name);
  try {
    for (const local of speaker.getLocalPlayers?.() ?? []) {
      if (!isCitizenBot(local)) continue;
      const uname = Registry.normalizeName(local.getUsername?.() ?? "");
      if (uname === want) return local;
      // Also match display names via the director roster.
      try {
        const { getDirector } = require("../citizens/director/CitizenDirector");
        const rec = getDirector()?.roster?.get?.(uname);
        if (rec && Registry.normalizeName(rec.displayName) === want) return local;
      } catch {
        // Non-fatal.
      }
    }
  } catch {
    // Non-fatal.
  }
  return null;
}

function kingdomName(kingdomId) {
  try {
    const name = require("../kingdoms/KingdomStore").getKingdom(kingdomId)?.name;
    if (typeof name === "string" && name) return name;
  } catch {
    // fall through
  }
  return String(kingdomId ?? "the realm").replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());
}

// --- chat keywords -----------------------------------------------------------
// All diegetic phrases — no ::commands. Handled as data; the reply is the
// action's confirmation.

function handleGuildKeyword(player, text) {
  const speaker = player.getUsername?.() ?? "";
  const said = String(text ?? "").trim();
  const low = said.toLowerCase();
  if (!said || !speaker) return false;

  let m;

  // "found a guild called <Name>"
  m = said.match(/^found a guild called (.+)$/i);
  if (m) {
    const res = Registry.createGuild({
      founderName: speaker,
      founderDisplay: speaker,
      name: m[1].trim(),
      banner: "",
      description: "",
      kingdomId: playerKingdomId(player),
    });
    if (res.error) {
      send(player, res.error);
    } else {
      const g = res.guild;
      send(
        player,
        `The guild '${g.name}' is founded! Your banner is ${g.banner}. ` +
          `Say "recruit <name>" near someone to invite them, or "guild invite <name>". ` +
          `Your guild hall is the tavern in ${kingdomName(g.kingdomId)}.`
      );
    }
    return true;
  }

  // "my guild" — summary.
  if (/^(my guild|guild info)$/.test(low)) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild. Say \"found a guild called <name>\" to start one.");
    } else {
      const s = Registry.guildSummary(g.id);
      const rank = Registry.memberRank(g, speaker);
      const top = s.members.slice(0, 6).map((x) => `${x.name} (${x.rank})`).join(", ");
      const more = s.memberCount > 6 ? ` and ${s.memberCount - 6} more` : "";
      send(
        player,
        `${s.name} [${s.banner}] — ${s.memberCount} members (${s.playerCount} players, ${s.citizenCount} citizens). ` +
          `You are ${rank}. Members: ${top}${more}. ` +
          (s.description ? `Motto: "${s.description}" ` : "") +
          `Hall: the tavern in ${kingdomName(s.kingdomId)}.`
      );
    }
    return true;
  }

  // "guild hall" — where members gather.
  if (/^guild hall$/.test(low)) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
    } else {
      send(
        player,
        `${g.name} — guild hall: the tavern in ${kingdomName(g.kingdomId)} — ` +
          `that's where the guild musters before outings.`
      );
    }
    return true;
  }

  // "recruit <name>" — officer recruits a nearby citizen.
  m = said.match(/^recruit (.+)$/i);
  if (m) {
    const target = m[1].trim();
    const bot = findNearbyCitizen(player, target);
    if (!bot) {
      send(player, `There's no one called '${target}' nearby to recruit.`);
      return true;
    }
    const res = Recruitment.recruitCitizen(speaker, speaker, bot.getUsername?.() ?? target);
    send(player, res.error ?? res.message);
    return true;
  }

  // "guild invite <name>" — officer invites a player (or citizen) by name.
  m = said.match(/^guild invite (.+)$/i);
  if (m) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
      return true;
    }
    const target = m[1].trim();
    const res = Registry.inviteMember(g.id, target, target, speaker, speaker);
    if (res.error) {
      send(player, res.error);
    } else {
      send(player, `${target} has been invited to ${g.name}. They can say "accept guild" to join.`);
      // If the invitee is online, nudge them directly.
      try {
        const invitee = pluginApi?.core?.World?.getPlayerByName?.(target);
        if (invitee && !isCitizenBot(invitee)) {
          invitee.sendMessage(`${speaker} invited you to the guild '${g.name}'. Say "accept guild" to join.`);
        }
      } catch {
        // Non-fatal.
      }
    }
    return true;
  }

  // "accept guild" / "decline guild"
  if (/^(accept guild|join guild)$/.test(low)) {
    const invites = Registry.pendingInvitesFor(speaker);
    if (!invites.length) {
      send(player, "You have no pending guild invites.");
      return true;
    }
    const inv = invites[0];
    // Determine kind: citizen bot vs real player.
    const kind = isCitizenBot(player) ? "citizen" : "player";
    const res = Registry.acceptInvite(inv.guildId, speaker, speaker, kind);
    send(player, res.error ?? `Welcome to ${inv.guildName}!`);
    return true;
  }
  if (/^(decline guild|reject guild)$/.test(low)) {
    const invites = Registry.pendingInvitesFor(speaker);
    if (!invites.length) {
      send(player, "You have no pending guild invites.");
      return true;
    }
    Registry.declineInvite(invites[0].guildId, speaker);
    send(player, "Invite declined.");
    return true;
  }

  // "leave guild"
  if (/^leave guild$/.test(low)) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
      return true;
    }
    const res = Registry.removeMember(g.id, speaker, speaker);
    send(player, res.error ?? `You left ${g.name}.`);
    return true;
  }

  // "promote <name>" / "demote <name>" — founder only.
  m = said.match(/^promote (.+)$/i);
  if (m) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
      return true;
    }
    const res = Registry.setRank(g.id, m[1].trim(), Registry.RANK_OFFICER, speaker);
    send(player, res.error ?? `${m[1].trim()} is now an officer of ${g.name}.`);
    return true;
  }
  m = said.match(/^demote (.+)$/i);
  if (m) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
      return true;
    }
    const res = Registry.setRank(g.id, m[1].trim(), Registry.RANK_MEMBER, speaker);
    send(player, res.error ?? `${m[1].trim()} is now a member of ${g.name}.`);
    return true;
  }

  // "guild kick <name>"
  m = said.match(/^guild kick (.+)$/i);
  if (m) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
      return true;
    }
    const res = Registry.removeMember(g.id, m[1].trim(), speaker);
    send(player, res.error ?? `${res.removed} was removed from ${g.name}.`);
    return true;
  }

  // "guild description <text>"
  m = said.match(/^guild description (.+)$/is);
  if (m) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
      return true;
    }
    const res = Registry.setDescription(g.id, m[1].trim(), speaker);
    send(player, res.error ?? "Guild description updated.");
    return true;
  }

  // "guild banner <color>"
  m = said.match(/^guild banner (\w+)$/i);
  if (m) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
      return true;
    }
    const res = Registry.setBanner(g.id, m[1].trim(), speaker);
    send(
      player,
      res.error ?? `Guild banner is now ${res.banner}.`
    );
    return true;
  }

  // "disband guild" — two-step confirm.
  if (/^disband guild$/.test(low)) {
    const g = Registry.memberGuild(speaker);
    if (!g) {
      send(player, "You're not in a guild.");
      return true;
    }
    if (Registry.normalizeName(g.founder) !== Registry.normalizeName(speaker)) {
      send(player, "Only the founder can disband the guild.");
      return true;
    }
    pendingDisbands[Registry.normalizeName(speaker)] = { guildId: g.id, at: Date.now() };
    send(player, `Disband '${g.name}' forever? Say "disband guild yes" to confirm.`);
    return true;
  }
  if (/^disband guild yes$/.test(low)) {
    const key = Registry.normalizeName(speaker);
    const pending = pendingDisbands[key];
    delete pendingDisbands[key];
    if (!pending || Date.now() - pending.at > 60000) {
      send(player, "Say \"disband guild\" first, then confirm within a minute.");
      return true;
    }
    const res = Registry.disbandGuild(pending.guildId, speaker);
    send(player, res.error ?? `The guild '${res.disbanded}' is no more.`);
    return true;
  }

  return false;
}

const pendingDisbands = {};

// --- social packet hook ------------------------------------------------------

function onGuildSocialPacket(event) {
  const { player, packet } = event ?? {};
  if (!packet || packet.type !== "public_chat") return;
  if (!player || isCitizenBot(player)) return;
  const text = String(packet.text ?? "").trim();
  if (!text) return;
  try {
    handleGuildKeyword(player, text);
  } catch {
    // Keywords must never break chat.
  }
}

// --- plugin ------------------------------------------------------------------

module.exports = {
  name: "Guilds",
  register(api) {
    pluginApi = api;
    // BISECT: GuildsApi.attach(api);
    api.onSocialPacket(onGuildSocialPacket);
    api.log?.("[guilds] player guilds with citizen members enabled");
  },
  // Exported for smoke tests.
  handleGuildKeyword,
};
