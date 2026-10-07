"use strict";

/**
 * GuildRecruitment — citizens joining player-founded guilds.
 *
 * Two paths:
 *   1. A guild officer/founder says "recruit <name>" near a citizen.
 *      The citizen decides data-tier (personality compatibility +
 *      relationship with the recruiter), voiced by the LLM afterwards.
 *   2. Autonomous: citizens who are friends with guild members and have
 *      compatible personalities sometimes ask to join on their own.
 *
 * Data tier, zero LLM. Join events are journaled so the foreground speaks
 * truthfully about them.
 */

const Registry = require("./GuildRegistry");
const {
  isFriend,
  isEnemy,
  normalizeName,
} = require("../citizens/lib/CitizenBonds");

function journalEvent(citizenName, text, kind) {
  try {
    require("../citizens/lib/CitizenJournal").getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function getDirector() {
  try {
    return require("../citizens/director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Compatibility score: how likely is this citizen to join this guild?
 * Positive = willing. Used for both player recruitment and autonomous joins.
 */
function compatibilityScore(record, guild) {
  let score = 0;
  const traits = record.personality?.traits ?? [];
  if (traits.includes("chatty")) score += 2;
  if (traits.includes("cheerful")) score += 2;
  if (traits.includes("easygoing")) score += 1;
  if (traits.includes("dutiful")) score += 2; // loyal — honors commitments
  if (traits.includes("proud")) score += 1;
  if (traits.includes("devout")) score += 1;
  if (traits.includes("suspicious")) score -= 2;
  if (traits.includes("taciturn")) score -= 1;
  if (traits.includes("gruff")) score -= 1;
  if (traits.includes("greedy")) score -= 1;

  // Relationships with existing members.
  let friendCount = 0;
  for (const m of Object.keys(guild.members ?? {})) {
    if (isEnemy(record.username, m) || isEnemy(m, record.username)) return -100;
    if (isFriend(record.username, m)) friendCount++;
  }
  score += Math.min(friendCount, 3) * 2;

  // Home turf matters.
  if (record.kingdomId && guild.kingdomId) {
    score += record.kingdomId === guild.kingdomId ? 1 : -1;
  }

  // Goals: guards chase rank, merchants chase networks, workers chase mastery.
  try {
    const goal = record.goal ?? null;
    const type = goal?.type ?? "";
    if (type === "rank_up") score += 2;
    else if (type === "save_gold") score += 1;
    else if (type === "master_trade") score += 1;
  } catch {
    // Non-fatal.
  }

  return score;
}

const RECRUIT_MIN_SCORE = 3;

/**
 * A guild officer/founder recruits a nearby citizen by name.
 * Returns { ok, message } for the chat reply, or { error }.
 */
function recruitCitizen(recruiterName, recruiterDisplay, citizenName) {
  const director = getDirector();
  if (!director) return { error: "The guilds aren't mustered right now." };
  const guild = Registry.memberGuild(recruiterName);
  if (!guild) return { error: "You're not in a guild." };
  if (!Registry.isOfficerOrFounder(guild, recruiterName)) {
    return { error: "Only officers and the founder can recruit." };
  }
  const record = director.roster.get(normalizeName(citizenName));
  if (!record) return { error: `I don't know anyone called '${citizenName}'.` };
  if (Registry.memberGuild(record.username)) {
    return { error: `${record.displayName ?? citizenName} already belongs to a guild.` };
  }
  if (!director.isOnline(record)) {
    return { error: `${record.displayName ?? citizenName} isn't around right now.` };
  }
  const score = compatibilityScore(record, guild);
  if (score < RECRUIT_MIN_SCORE) {
    journalEvent(record.username, `Turned down ${recruiterDisplay}'s invitation to join '${guild.name}'.`, "social");
    const display = record.displayName ?? citizenName;
    return {
      ok: false,
      message: `${display} shakes their head. "Thanks, but the guild life isn't for me."`,
    };
  }
  const res = Registry.addMember(guild.id, {
    name: record.username,
    displayName: record.displayName ?? record.username,
    kind: "citizen",
    rank: Registry.RANK_MEMBER,
  });
  if (res.error) return { error: res.error };
  const display = record.displayName ?? record.username;
  journalEvent(record.username, `Joined the guild '${guild.name}' at ${recruiterDisplay}'s invitation.`, "social");
  Registry.logActivity(guild.id, `${display} was recruited by ${recruiterDisplay}.`);
  return {
    ok: true,
    message: `${display} grins. "Aye — I'll stand with the ${guild.name}."`,
  };
}

// --- autonomous joins --------------------------------------------------------
// Friends of guild members with compatible personalities sometimes ask to
// join on their own. Rare, so guilds grow organically but slowly.

const AUTO_JOIN_CHANCE = 0.004; // per eligible citizen per tick

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

function tickRecruitment(director) {
  const summaries = Registry.listGuilds();
  if (!summaries.length) return;
  const now = Date.now();
  const rng = agentRng(`guildrecruit:${now >> 16}`);

  for (const record of director.roster.values()) {
    if (!director.isOnline(record)) continue;
    if (Registry.memberGuild(record.username)) continue;
    if (!chance(rng, AUTO_JOIN_CHANCE)) continue;

    // Find a guild this citizen would plausibly join: friends inside,
    // compatible, same kingdom preferred.
    let best = null;
    let bestScore = 4; // threshold for asking on their own
    for (const s of summaries) {
      const g = Registry.getGuild(s.id);
      if (!g) continue;
      // Must know someone inside — nobody joins a guild of strangers.
      let knowsSomeone = false;
      for (const m of Object.keys(g.members ?? {})) {
        if (isFriend(record.username, m)) { knowsSomeone = true; break; }
      }
      if (!knowsSomeone) continue;
      const sc = compatibilityScore(record, g);
      if (sc > bestScore) { bestScore = sc; best = g; }
    }
    if (!best) continue;

    const res = Registry.addMember(best.id, {
      name: record.username,
      displayName: record.displayName ?? record.username,
      kind: "citizen",
      rank: Registry.RANK_MEMBER,
    });
    if (res.error) continue;
    const display = record.displayName ?? record.username;
    journalEvent(record.username, `Asked to join the guild '${best.name}' — and was welcomed in.`, "social");
    Registry.logActivity(best.id, `${display} asked to join and was welcomed.`);
  }
}

module.exports = {
  compatibilityScore,
  recruitCitizen,
  tickRecruitment,
  RECRUIT_MIN_SCORE,
};
