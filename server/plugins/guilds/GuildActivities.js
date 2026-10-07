"use strict";

/**
 * GuildActivities — guild outings: members doing things together.
 *
 * Periodically, a guild with online citizen members musters at its guild
 * hall (the kingdom tavern — the physical space where members gather) and
 * heads out together: a tavern night, a fishing trip, or a market run.
 * From Jon's perspective it looks like a guild doing content together.
 *
 * Player members are invited when they're online and nearby (activity
 * invite, accepted with "yes" / "accept guild"). Loot is split like
 * citizen activity parties.
 *
 * Data tier, zero LLM. Journaled for the foreground.
 *
 * Wiring: CitizenDirector.tick() calls tickOutings(director, hour) once per
 * tick. Outing travel leans on the existing tickFollow (party members
 * follow the leader); this module nudges the leader toward destinations.
 */

const Registry = require("./GuildRegistry");
const {
  getParty,
  getFollow,
  setFollow,
  clearFollow,
  clearParty,
  normalizeName,
} = require("../citizens/lib/CitizenBonds");
const { createParty, disbandParty, leaveParty } = require("../citizens/lib/CitizenSocialMechanics");
const { siteTileByKingdom } = require("../citizens/brain/CitizenSites");

function journalEvent(citizenName, text, kind) {
  try {
    require("../citizens/lib/CitizenJournal").getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function agentRng(seed) {
  try {
    return require("../citizens/lib/humanizer").agentRng(seed);
  } catch {
    return Math.random;
  }
}

function chance(rng, p) {
  try {
    return require("../citizens/lib/humanizer").chance(rng, p);
  } catch {
    return rng() < p;
  }
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function requestMovement(bot, x, y, z) {
  try {
    const { requestMovement: rm } = require("../bots/behaviours/navigation/BotNavigation");
    rm(bot, x, y, { reason: "guild_outing", basicPather: true, z: z ?? 0 });
    return true;
  } catch {
    return false;
  }
}

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

// --- outing definitions ------------------------------------------------------

const OUTINGS = {
  tavern_night: {
    site: "tavern",
    durationMin: 15,
    formLines: [
      "Guild night at the tavern — members, muster up!",
      "The guild's drinking tonight. Who's coming?",
    ],
    arriveLines: ["The guild's gathered at the hall. Ale all around."],
    flavorLines: [
      "are singing the guild's song, badly",
      "are swapping stories of the week's work",
      "raised a toast to the founder",
      "are arm-wrestling for the next round",
    ],
    endLines: ["Guild night done. See you at the next muster."],
    loot: null,
  },
  fishing_trip: {
    site: "dock",
    needsDock: true,
    durationMin: 12,
    formLines: [
      "Guild fishing trip — lines in the water, members welcome!",
      "The guild's off to the docks. Come along!",
    ],
    arriveLines: ["Guild's at the docks. Lines in!"],
    flavorLines: [
      "caught a fat one and the whole guild cheered",
      "are comparing catches",
      "lost a boot to the water, everyone laughed",
    ],
    endLines: ["Guild fishing trip done — full nets all around."],
    loot: { item: "RAW_SHRIMPS", min: 1, max: 3 },
  },
  market_run: {
    site: "market",
    durationMin: 10,
    formLines: [
      "Guild market run — let's see what's selling.",
      "Off to the market with the guild. Coming?",
    ],
    arriveLines: ["Guild's at the market. Mind your purses."],
    flavorLines: [
      "haggled a merchant down together",
      "are comparing prices stall to stall",
      "pooled coin for a round of bread",
    ],
    endLines: ["Guild market run done."],
    loot: null,
  },
};

const OUTING_IDS = Object.keys(OUTINGS);
const FORM_CHANCE = 0.01; // per eligible guild per tick
const ARRIVE_RADIUS = 6;
const FLAVOR_CHANCE = 0.15;

// Active outings keyed by guild id. (Not persisted — outings are ephemeral;
// a restart simply lets them reform.)
const activeOutings = new Map(); // guildId -> outing

function guildHallTile(guild) {
  const site = guild.hallSite ?? "tavern";
  return siteTileByKingdom(guild.kingdomId, site) ?? siteTileByKingdom(guild.kingdomId, "square");
}

function outingValidForKingdom(outingId, kingdomId) {
  const def = OUTINGS[outingId];
  if (!def) return false;
  if (def.needsDock && !siteTileByKingdom(kingdomId, "dock")) return false;
  return !!siteTileByKingdom(kingdomId, def.site);
}

// --- formation ---------------------------------------------------------------

function onlineCitizenMembers(director, guild) {
  const out = [];
  for (const key of Object.keys(guild.members ?? {})) {
    const m = guild.members[key];
    if (m.kind !== "citizen") continue;
    const record = director.roster.get(normalizeName(m.name));
    if (!record || !director.isOnline(record)) continue;
    if (getParty(record.username)) continue;
    if (getFollow(record.username)) continue;
    out.push(record);
  }
  return out;
}

function tryFormOuting(director, guild, hour) {
  if (activeOutings.has(guild.id)) return false;
  const rng = agentRng(`guildouting:${guild.id}:${Date.now() >> 16}`);
  if (!chance(rng, FORM_CHANCE)) return false;

  const members = onlineCitizenMembers(director, guild);
  if (members.length < 2) return false;

  const options = OUTING_IDS.filter((id) => {
    const def = OUTINGS[id];
    if (def.needsDock && !siteTileByKingdom(guild.kingdomId, "dock")) return false;
    return outingValidForKingdom(id, guild.kingdomId);
  });
  if (!options.length) return false;
  const outingId = pickOne(rng, options);
  const def = OUTINGS[outingId];

  const hall = guildHallTile(guild);
  const dest = siteTileByKingdom(guild.kingdomId, def.site);
  if (!dest) return false;

  // Leader: prefer an officer, else the longest-standing member.
  const rankOrder = { [Registry.RANK_FOUNDER]: 0, [Registry.RANK_OFFICER]: 1, [Registry.RANK_MEMBER]: 2 };
  members.sort((a, b) => {
    const ra = rankOrder[guild.members[normalizeName(a.username)]?.rank] ?? 2;
    const rb = rankOrder[guild.members[normalizeName(b.username)]?.rank] ?? 2;
    return ra - rb || (a.joinedAt ?? 0) - (b.joinedAt ?? 0);
  });
  const leader = members[0];
  const companions = members.slice(1, 6).map((r) => r.username); // cap party size

  const party = createParty(leader.username, companions);
  party.guildOuting = true;
  party.guildId = guild.id;
  party.outingId = outingId;
  party.stage = "muster"; // muster -> activity -> done
  party.hall = hall ? { x: hall.x, y: hall.y, z: hall.z ?? 0 } : null;
  party.destination = { x: dest.x, y: dest.y, z: dest.z ?? 0 };
  party.outingEndsAt = Date.now() + def.durationMin * 60 * 1000;
  party.arrived = false;

  for (const m of companions) setFollow(m, leader.username, "guild_outing");

  const leaderDisplay = leader.displayName ?? leader.username;
  const outing = { guildId: guild.id, party, leader: leader.username };
  activeOutings.set(guild.id, outing);

  journalEvent(leader.username, `Called the guild muster at the hall for ${outingLabel(outingId)}.`, "social");
  Registry.logActivity(guild.id, `${leaderDisplay} called a guild outing: ${outingLabel(outingId)}.`);
  for (const c of companions) {
    journalEvent(c, `Answered ${leaderDisplay}'s guild muster.`, "social");
  }

  // Invite player members: shout when real players are near, plus send
  // activity invites to online player members of the guild.
  try {
    const { offerActivityToPlayers } = require("../citizens/lib/CitizenPlayerActivities");
    offerActivityToPlayers(director, leader, party, {
      activityId: `guild_${outingId}`,
      label: `guild ${outingLabel(outingId)}`,
      formLines: def.formLines,
    });
  } catch {
    // Non-fatal.
  }
  // Direct invites to online player members even if not nearby.
  try {
    const { sendInvite, INVITE_ACTIVITY } = require("../citizens/lib/CitizenBonds");
    for (const key of Object.keys(guild.members ?? {})) {
      const m = guild.members[key];
      if (m.kind !== "player") continue;
      const online = isOnlinePlayer(director, m.name);
      if (!online) continue;
      sendInvite(leader.username, m.name, INVITE_ACTIVITY, {
        activity: `guild ${outingLabel(outingId)}`,
        guildId: guild.id,
      });
      journalEvent(leader.username, `Invited ${m.displayName} to the guild ${outingLabel(outingId)}.`, "social");
    }
  } catch {
    // Non-fatal.
  }
  return true;
}

function outingLabel(outingId) {
  return String(outingId ?? "").replace(/_/g, " ");
}

function isOnlinePlayer(director, name) {
  try {
    const PlayerActivities = require("../citizens/lib/CitizenPlayerActivities");
    return !!PlayerActivities.isOnlinePlayer(director, name);
  } catch {
    return false;
  }
}

// --- per-tick maintenance ----------------------------------------------------

function tickOutings(director, hour) {
  // Formation pass.
  for (const s of Registry.listGuilds()) {
    const guild = Registry.getGuild(s.id);
    if (!guild) continue;
    try {
      tryFormOuting(director, guild, hour);
    } catch {
      // Non-fatal.
    }
  }
  // Maintenance pass.
  for (const [guildId, outing] of [...activeOutings.entries()]) {
    try {
      maintainOuting(director, guildId, outing);
    } catch {
      // Non-fatal — drop broken outings rather than wedging.
      activeOutings.delete(guildId);
    }
  }
}

function maintainOuting(director, guildId, outing) {
  const guild = Registry.getGuild(guildId);
  const party = outing.party;
  if (!guild || !party) {
    activeOutings.delete(guildId);
    return;
  }
  const def = OUTINGS[party.outingId];
  if (!def) {
    endOuting(director, guild, outing, "called off.");
    return;
  }
  const now = Date.now();
  const rng = agentRng(`guildouting:${guildId}:${now >> 16}`);

  const leaderRecord = director.roster.get(normalizeName(outing.leader));
  const leaderOnline = leaderRecord && director.isOnline(leaderRecord);
  const leaderBot = leaderOnline ? director.getBot(leaderRecord) : null;
  if (!leaderOnline || !leaderBot) {
    endOuting(director, guild, outing, `${outingLabel(party.outingId)} called off — the leader headed home.`);
    return;
  }

  // Drop offline citizen members.
  for (const m of [...(party.members ?? [])]) {
    if (normalizeName(m) === normalizeName(outing.leader)) continue;
    const rec = director.roster.get(normalizeName(m));
    const online = (rec && director.isOnline(rec)) || isOnlinePlayer(director, m);
    if (!online) {
      try { leaveParty(m); } catch { /* non-fatal */ }
      try { clearFollow(m); } catch { /* non-fatal */ }
    }
  }

  // Time's up — loot split and disband.
  if (now >= (party.outingEndsAt ?? 0)) {
    splitLoot(director, party, def);
    endOuting(director, guild, outing, pickOne(rng, def.endLines));
    return;
  }

  // Stage 1: muster at the guild hall. Stage 2: the activity site.
  const target = party.stage === "muster" ? party.hall ?? party.destination : party.destination;
  if (!target) {
    endOuting(director, guild, outing, "called off — lost the way.");
    return;
  }
  const tile = botTile(leaderBot);
  const dist = chebyshev(tile, target);
  if (dist > ARRIVE_RADIUS) {
    const jx = target.x + Math.floor(rng() * 5) - 2;
    const jy = target.y + Math.floor(rng() * 5) - 2;
    requestMovement(leaderBot, jx, jy, target.z ?? 0);
    return; // still traveling
  }

  if (party.stage === "muster") {
    party.stage = "activity";
    party.arrived = false;
    journalEvent(outing.leader, "The guild's mustered at the hall. Moving out.", "social");
    Registry.logActivity(guild.id, `The guild mustered at the hall.`);
    try {
      if (realPlayersNear(leaderBot).length > 0) {
        leaderBot.forceChat?.("Guild's mustered — moving out!");
      }
    } catch { /* non-fatal */ }
    return;
  }

  if (!party.arrived) {
    party.arrived = true;
    const line = pickOne(rng, def.arriveLines);
    journalEvent(outing.leader, line, "social");
    try {
      if (realPlayersNear(leaderBot).length > 0) leaderBot.forceChat?.(line);
    } catch { /* non-fatal */ }
  }

  if (chance(rng, FLAVOR_CHANCE)) {
    const flavor = pickOne(rng, def.flavorLines);
    const who = pickOne(rng, party.members ?? [outing.leader]);
    journalEvent(who, `On the guild ${outingLabel(party.outingId)}: ${flavor}.`, "social");
  }
}

function splitLoot(director, party, def) {
  if (!def.loot) return;
  let itemId = null;
  try {
    itemId = director.api?.core?.ItemIds?.[def.loot.item] ?? null;
  } catch {
    itemId = null;
  }
  if (def.loot.item === "RAW_SHRIMPS" && !itemId) itemId = 317; // verified in ItemIdentifiers.ts
  if (!itemId) return;
  const rng = agentRng(`guildouting:loot:${party.id}`);
  for (const m of party.members ?? []) {
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) continue;
    const bot = director.getBot(rec);
    if (!bot) continue;
    const n = def.loot.min + Math.floor(rng() * (def.loot.max - def.loot.min + 1));
    try {
      bot.getInventory?.()?.adds?.(itemId, n);
    } catch { /* non-fatal */ }
    journalEvent(m, `Split the guild catch: ${n} raw shrimps.`, "work");
  }
  try {
    const { grantActivityLootToPlayers } = require("../citizens/lib/CitizenPlayerActivities");
    grantActivityLootToPlayers(director, party, itemId, def.loot.min, def.loot.max);
  } catch { /* non-fatal */ }
}

function endOuting(director, guild, outing, note) {
  const party = outing.party;
  for (const m of [...(party.members ?? [])]) {
    try { clearFollow(m); } catch { /* non-fatal */ }
  }
  try {
    disbandParty(outing.leader);
  } catch {
    for (const m of party.members ?? []) {
      try { clearParty(m); } catch { /* non-fatal */ }
    }
  }
  journalEvent(outing.leader, note, "social");
  Registry.logActivity(guild.id, `Guild outing ended: ${note}`);
  activeOutings.delete(guild.id);
}

module.exports = {
  OUTINGS,
  tickOutings,
  tryFormOuting,
  activeOutings,
};
