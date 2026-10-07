"use strict";

/**
 * GuildRegistry — the data layer for player-founded guilds with citizen members.
 *
 * A guild is founded by a real player and can recruit AI citizens (and other
 * players) as members with ranks. Everything here is pure data — zero LLM.
 * The foreground (chat keywords, LLM context, web API) reads this and acts.
 *
 * Persisted to data/saves/guilds.json (never committed). Bounded: member
 * lists, invites and activity log are capped.
 *
 * Ranks: founder > officer > member.
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "guilds.json");

const RANK_FOUNDER = "founder";
const RANK_OFFICER = "officer";
const RANK_MEMBER = "member";
const RANKS = [RANK_FOUNDER, RANK_OFFICER, RANK_MEMBER];

const MAX_MEMBERS = 40;
const MAX_GUILDS_PER_PLAYER = 1; // a player founds at most one guild
const INVITE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_LOG = 60;

const BANNERS = [
  "crimson", "azure", "emerald", "golden", "silver",
  "obsidian", "violet", "bronze",
];

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return { guilds: {}, memberOf: {} };
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return { guilds: {}, memberOf: {} };
    if (!raw.guilds || typeof raw.guilds !== "object") raw.guilds = {};
    if (!raw.memberOf || typeof raw.memberOf !== "object") raw.memberOf = {};
    return raw;
  } catch {
    return { guilds: {}, memberOf: {} };
  }
}

let cache = null;
let dirty = false;

function data() {
  if (!cache) cache = load();
  return cache;
}

function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    const now = Date.now();
    for (const g of Object.values(data().guilds)) {
      if (Array.isArray(g.invites)) {
        g.invites = g.invites.filter((i) => (i.expiresAt ?? 0) > now);
      }
      if (Array.isArray(g.activityLog) && g.activityLog.length > MAX_LOG) {
        g.activityLog = g.activityLog.slice(-MAX_LOG);
      }
    }
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache));
    dirty = false;
  } catch {
    // Never break the tick on a save failure.
  }
}

function markDirty() {
  dirty = true;
}

// --- validation ------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9 '’-]{3,28}$/;

function validGuildName(name) {
  const n = String(name ?? "").trim();
  if (!NAME_RE.test(n)) return false;
  if (/^\s|\s$/.test(n) || /\s{2,}/.test(n)) return false;
  return true;
}

function validBanner(banner) {
  return BANNERS.includes(String(banner ?? "").toLowerCase());
}

// --- reads -----------------------------------------------------------------

function getGuild(guildId) {
  return data().guilds[String(guildId)] ?? null;
}

function getGuildByName(name) {
  const n = normalizeName(name);
  for (const g of Object.values(data().guilds)) {
    if (normalizeName(g.name) === n) return g;
  }
  return null;
}

function listGuilds() {
  return Object.values(data().guilds).map((g) => ({
    id: g.id,
    name: g.name,
    banner: g.banner,
    description: g.description ?? "",
    kingdomId: g.kingdomId ?? null,
    founderDisplay: g.founderDisplay ?? g.founder,
    memberCount: Object.keys(g.members ?? {}).length,
    createdAt: g.createdAt,
  }));
}

/** Guild (full object) that this player/citizen belongs to, or null. */
function memberGuild(name) {
  const id = data().memberOf[normalizeName(name)];
  return id ? getGuild(id) : null;
}

function memberRank(guild, name) {
  const m = guild?.members?.[normalizeName(name)];
  return m?.rank ?? null;
}

function isOfficerOrFounder(guild, name) {
  const r = memberRank(guild, name);
  return r === RANK_FOUNDER || r === RANK_OFFICER;
}

function pendingInvitesFor(name) {
  const now = Date.now();
  const out = [];
  for (const g of Object.values(data().guilds)) {
    for (const i of g.invites ?? []) {
      if (normalizeName(i.to) === normalizeName(name) && i.expiresAt > now) {
        out.push({ guildId: g.id, guildName: g.name, from: i.fromDisplay ?? i.from, expiresAt: i.expiresAt });
      }
    }
  }
  return out;
}

// --- writes ----------------------------------------------------------------

let guildSeq = 0;

function createGuild({ founderName, founderDisplay, name, banner, description, kingdomId }) {
  const cleanName = String(name ?? "").trim();
  if (!validGuildName(cleanName)) {
    return { error: "Guild names need 3-28 letters, numbers, spaces or apostrophes." };
  }
  if (getGuildByName(cleanName)) {
    return { error: `There's already a guild called '${cleanName}'.` };
  }
  const fn = normalizeName(founderName);
  if (!fn) return { error: "I don't know who you are, friend." };
  if (memberGuild(fn)) {
    return { error: "You're already in a guild — leave it before founding your own." };
  }
  // One founded guild per player (they can still join others as members).
  for (const g of Object.values(data().guilds)) {
    if (normalizeName(g.founder) === fn) {
      return { error: `You've already founded '${g.name}'.` };
    }
  }
  const b = validBanner(banner) ? String(banner).toLowerCase() : "bronze";
  const id = `guild_${Date.now().toString(36)}_${++guildSeq}`;
  const guild = {
    id,
    name: cleanName,
    banner: b,
    description: String(description ?? "").slice(0, 280),
    founder: fn,
    founderDisplay: founderDisplay ?? founderName,
    kingdomId: kingdomId ?? null,
    createdAt: Date.now(),
    hallSite: "tavern", // muster site key into CitizenSites — the guild hall gathering place
    members: {},
    invites: [],
    activityLog: [],
  };
  guild.members[fn] = {
    name: fn,
    displayName: founderDisplay ?? founderName,
    kind: "player",
    rank: RANK_FOUNDER,
    joinedAt: Date.now(),
  };
  data().guilds[id] = guild;
  data().memberOf[fn] = id;
  markDirty();
  logActivity(id, `${guild.members[fn].displayName} founded the guild.`);
  save();
  return { guild };
}

function disbandGuild(guildId, byName) {
  const g = getGuild(guildId);
  if (!g) return { error: "No such guild." };
  if (normalizeName(g.founder) !== normalizeName(byName)) {
    return { error: "Only the founder can disband the guild." };
  }
  for (const m of Object.keys(g.members ?? {})) {
    delete data().memberOf[normalizeName(m)];
  }
  delete data().guilds[guildId];
  markDirty();
  save();
  return { disbanded: g.name };
}

function addMember(guildId, { name, displayName, kind, rank }) {
  const g = getGuild(guildId);
  if (!g) return { error: "No such guild." };
  const n = normalizeName(name);
  if (!n) return { error: "Unknown recruit." };
  if (g.members[n]) return { error: `${displayName ?? name} is already in the guild.` };
  if (Object.keys(g.members).length >= MAX_MEMBERS) {
    return { error: `The guild is full (${MAX_MEMBERS} members).` };
  }
  if (data().memberOf[n] && data().memberOf[n] !== guildId) {
    return { error: `${displayName ?? name} already belongs to another guild.` };
  }
  const r = RANKS.includes(rank) ? rank : RANK_MEMBER;
  g.members[n] = {
    name: n,
    displayName: displayName ?? name,
    kind: kind === "citizen" ? "citizen" : "player",
    rank: r === RANK_FOUNDER ? RANK_MEMBER : r, // founder can't be granted
    joinedAt: Date.now(),
  };
  data().memberOf[n] = guildId;
  // Clear any pending invite for them.
  g.invites = (g.invites ?? []).filter((i) => normalizeName(i.to) !== n);
  markDirty();
  logActivity(guildId, `${g.members[n].displayName} joined the guild.`);
  save();
  return { member: g.members[n] };
}

function removeMember(guildId, name, byName) {
  const g = getGuild(guildId);
  if (!g) return { error: "No such guild." };
  const n = normalizeName(name);
  const target = g.members[n];
  if (!target) return { error: "They're not in the guild." };
  const byRank = memberRank(g, byName);
  const selfLeave = normalizeName(byName) === n;
  if (target.rank === RANK_FOUNDER) {
    return { error: "The founder can't be removed — disband the guild instead." };
  }
  if (!selfLeave && byRank !== RANK_FOUNDER && !(byRank === RANK_OFFICER && target.rank === RANK_MEMBER)) {
    return { error: "You don't have the authority to remove them." };
  }
  const display = target.displayName;
  delete g.members[n];
  delete data().memberOf[n];
  markDirty();
  logActivity(guildId, selfLeave ? `${display} left the guild.` : `${display} was removed from the guild.`);
  save();
  return { removed: display };
}

function setRank(guildId, name, rank, byName) {
  const g = getGuild(guildId);
  if (!g) return { error: "No such guild." };
  if (normalizeName(g.founder) !== normalizeName(byName)) {
    return { error: "Only the founder can change ranks." };
  }
  const n = normalizeName(name);
  const target = g.members[n];
  if (!target) return { error: "They're not in the guild." };
  if (target.rank === RANK_FOUNDER) return { error: "The founder's rank can't change." };
  if (![RANK_OFFICER, RANK_MEMBER].includes(rank)) return { error: "Rank must be officer or member." };
  target.rank = rank;
  markDirty();
  logActivity(guildId, `${target.displayName} is now ${rank === RANK_OFFICER ? "an officer" : "a member"}.`);
  save();
  return { rank };
}

function inviteMember(guildId, toName, toDisplay, fromName, fromDisplay) {
  const g = getGuild(guildId);
  if (!g) return { error: "No such guild." };
  if (!isOfficerOrFounder(g, fromName)) {
    return { error: "Only officers and the founder can invite." };
  }
  const t = normalizeName(toName);
  if (!t) return { error: "Invite whom?" };
  if (g.members[t]) return { error: "They're already in the guild." };
  const now = Date.now();
  const dup = (g.invites ?? []).find(
    (i) => normalizeName(i.to) === t && i.expiresAt > now
  );
  if (dup) return { error: "They already have a pending invite." };
  g.invites.push({
    to: t,
    toDisplay: toDisplay ?? toName,
    from: normalizeName(fromName),
    fromDisplay: fromDisplay ?? fromName,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
  });
  markDirty();
  save();
  return { invited: toDisplay ?? toName };
}

function acceptInvite(guildId, name, displayName, kind) {
  const g = getGuild(guildId);
  if (!g) return { error: "No such guild." };
  const n = normalizeName(name);
  const idx = (g.invites ?? []).findIndex(
    (i) => normalizeName(i.to) === n && i.expiresAt > Date.now()
  );
  if (idx < 0) return { error: "No pending invite for you." };
  g.invites.splice(idx, 1);
  markDirty();
  return addMember(guildId, { name: n, displayName: displayName ?? name, kind, rank: RANK_MEMBER });
}

function declineInvite(guildId, name) {
  const g = getGuild(guildId);
  if (!g) return false;
  const n = normalizeName(name);
  const before = (g.invites ?? []).length;
  g.invites = (g.invites ?? []).filter((i) => normalizeName(i.to) !== n);
  if (g.invites.length !== before) markDirty();
  return g.invites.length !== before;
}

function setDescription(guildId, text, byName) {
  const g = getGuild(guildId);
  if (!g) return { error: "No such guild." };
  if (!isOfficerOrFounder(g, byName)) {
    return { error: "Only officers and the founder can do that." };
  }
  g.description = String(text ?? "").slice(0, 280);
  markDirty();
  save();
  return { description: g.description };
}

function setBanner(guildId, banner, byName) {
  const g = getGuild(guildId);
  if (!g) return { error: "No such guild." };
  if (!isOfficerOrFounder(g, byName)) {
    return { error: "Only officers and the founder can do that." };
  }
  if (!validBanner(banner)) {
    return { error: `Banner must be one of: ${BANNERS.join(", ")}.` };
  }
  g.banner = String(banner).toLowerCase();
  markDirty();
  save();
  return { banner: g.banner };
}

function logActivity(guildId, text) {
  const g = getGuild(guildId);
  if (!g) return;
  g.activityLog.push({ at: Date.now(), text: String(text).slice(0, 200) });
  if (g.activityLog.length > MAX_LOG) g.activityLog = g.activityLog.slice(-MAX_LOG);
  markDirty();
}

function guildSummary(guildId) {
  const g = getGuild(guildId);
  if (!g) return null;
  const members = Object.values(g.members ?? {});
  const officers = members.filter((m) => m.rank === RANK_OFFICER).length;
  return {
    id: g.id,
    name: g.name,
    banner: g.banner,
    description: g.description ?? "",
    kingdomId: g.kingdomId ?? null,
    founderDisplay: g.founderDisplay ?? g.founder,
    memberCount: members.length,
    citizenCount: members.filter((m) => m.kind === "citizen").length,
    playerCount: members.filter((m) => m.kind === "player").length,
    officers,
    hallSite: g.hallSite ?? "tavern",
    members: members
      .sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank) || a.joinedAt - b.joinedAt)
      .map((m) => ({ name: m.displayName, kind: m.kind, rank: m.rank })),
    recentActivity: (g.activityLog ?? []).slice(-8).reverse(),
  };
}

module.exports = {
  SAVE_FILE,
  RANK_FOUNDER,
  RANK_OFFICER,
  RANK_MEMBER,
  RANKS,
  BANNERS,
  INVITE_TTL_MS,
  MAX_MEMBERS,
  normalizeName,
  validGuildName,
  createGuild,
  disbandGuild,
  getGuild,
  getGuildByName,
  listGuilds,
  memberGuild,
  memberRank,
  isOfficerOrFounder,
  pendingInvitesFor,
  addMember,
  removeMember,
  setRank,
  inviteMember,
  acceptInvite,
  declineInvite,
  setDescription,
  setBanner,
  logActivity,
  guildSummary,
  save,
};
