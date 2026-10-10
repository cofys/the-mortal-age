"use strict";

/**
 * CitizenClans — the data layer for citizen-formed clans.
 *
 * Citizens form their own clans around shared interests (craft, trade,
 * guard duty, skilling, friendship). A clan is founded by a citizen with
 * leadership traits, grows through the real friendship graph, runs group
 * activities, and can invite players the members trust.
 *
 * This is the DATA tier: pure state, zero LLM, tick-safe. The dynamics
 * (formation, invites, outings, celebrations, competitions) live in
 * lib/CitizenClanLife.js, which the director ticks. The foreground (chat,
 * LLM) reads this and roleplays from it.
 *
 * Not to confuse with:
 *   - GuildRegistry (plugins/guilds): player-FOUNDED guilds that recruit
 *     citizens. Clans are citizen-founded; players join as guests.
 *   - CitizenActivityParties: ad-hoc activity groups. Clan outings are
 *     scheduled by the clan, not pickup groups.
 *   - CitizenBonds pendingInvites: the invite transport. Clan invites
 *     ride on INVITE_CLAN with { clanId } in the data payload.
 *
 * Persisted to data/saves/citizen-clans.json (never committed). Bounded:
 * member lists, activity log and invites are capped.
 */

const fs = require("fs");
const path = require("path");
const {
  sendInvite,
  resolveInvite,
  getInvites,
  isFriend,
  bonds,
  INVITE_CLAN,
  normalizeName,
} = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-clans.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

const MAX_MEMBERS = 12; // citizen members — clans stay intimate
const MAX_PLAYER_MEMBERS = 8;
const MAX_CLANS_PER_KINGDOM = 6;
const MAX_ACTIVITY_LOG = 40;

const KIND_CRAFT = "craft";
const KIND_TRADE = "trade";
const KIND_GUARD = "guard";
const KIND_SKILL = "skill";
const KIND_SOCIAL = "social";
const CLAN_KINDS = Object.freeze([KIND_CRAFT, KIND_TRADE, KIND_GUARD, KIND_SKILL, KIND_SOCIAL]);

const KIND_LABELS = Object.freeze({
  [KIND_CRAFT]: "Crafters",
  [KIND_TRADE]: "Traders",
  [KIND_GUARD]: "Wardens",
  [KIND_SKILL]: "Skilled",
  [KIND_SOCIAL]: "Fellows",
});

const LEADER_TRAITS = Object.freeze(["outgoing", "ambitious", "charismatic", "leader"]);

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Never break the tick.
  }
}

/**
 * Clan kind from a roster record's real role + goal. No hashes, no fiction:
 * guards ward, merchants trade, crafters craft, boss-slayers guard,
 * friend-seekers socialize, everyone else socializes.
 */
function kindForRecord(record) {
  const role = String(record?.role ?? "").toLowerCase();
  const goalType = String(record?.goal?.type ?? "").toLowerCase();
  if (role === "guard") return KIND_GUARD;
  if (role === "merchant") return KIND_TRADE;
  if (goalType === "boss_slayer") return KIND_GUARD;
  if (goalType === "save_gold") return KIND_TRADE;
  if (goalType === "master_trade") return KIND_CRAFT;
  if (goalType === "rank_up") return KIND_GUARD;
  if (goalType === "make_friends") return KIND_SOCIAL;
  return KIND_SOCIAL;
}

/**
 * Whether a record can found a clan: leadership traits, enough citizen
 * friends to seed it, and not already in one. `isRosterCitizen` is a
 * predicate (name -> bool) so this stays testable without a director.
 */
function founderEligible(record, isRosterCitizen) {
  if (!record?.username) return false;
  const traits = record.personality?.traits ?? [];
  if (!traits.some((t) => LEADER_TRAITS.includes(t))) return false;
  if (clanOf(record.username)) return false;
  let citizenFriends = 0;
  try {
    for (const f of bonds(record.username).friends ?? []) {
      if (isRosterCitizen && isRosterCitizen(f)) citizenFriends += 1;
    }
  } catch {
    return false;
  }
  return citizenFriends >= 3;
}

function blankClan(id, founderName, founderDisplay, kingdomId, kingdomName, kind) {
  const label = KIND_LABELS[kind] ?? KIND_LABELS[KIND_SOCIAL];
  return {
    id,
    name: `${kingdomName} ${label}`,
    kind,
    kingdomId,
    founder: normalizeName(founderName),
    founderDisplay: founderDisplay ?? founderName,
    leader: normalizeName(founderName),
    members: [normalizeName(founderName)], // citizen usernames, normalized
    memberDisplay: { [normalizeName(founderName)]: founderDisplay ?? founderName },
    playerMembers: [], // real-player usernames, normalized
    playerDisplay: {},
    createdAt: Date.now(),
    activityLog: [],
    activeOuting: null, // { activity, dest, leaderName, endsAt, startedAt }
    lastCelebScan: Date.now(),
  };
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return { clans: {}, meta: { moots: {} }, seq: 0 };
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return { clans: {}, meta: { moots: {} }, seq: 0 };
    if (!raw.clans || typeof raw.clans !== "object") raw.clans = {};
    if (!raw.meta || typeof raw.meta !== "object") raw.meta = { moots: {} };
    if (!Number.isFinite(raw.seq)) raw.seq = 0;
    return raw;
  } catch {
    return { clans: {}, meta: { moots: {} }, seq: 0 };
  }
}

let cache = null;
let dirty = false;

function data() {
  if (!cache) cache = load();
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

function kingdomNameOf(kingdomId) {
  try {
    const KingdomStore = require("../../kingdoms/KingdomStore");
    const name = KingdomStore.getKingdom?.(kingdomId)?.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    // Fall through to the raw id.
  }
  return String(kingdomId ?? "the realm");
}

// --- reads -------------------------------------------------------------------

function getClan(clanId) {
  return data().clans[String(clanId)] ?? null;
}

function allClans() {
  return Object.values(data().clans);
}

function clansInKingdom(kingdomId) {
  const kid = String(kingdomId ?? "");
  return allClans().filter((c) => String(c.kingdomId) === kid);
}

/** The clan a citizen belongs to (founder/leader/member), or null. */
function clanOf(citizenName) {
  const n = normalizeName(citizenName);
  if (!n) return null;
  return allClans().find((c) => (c.members ?? []).includes(n)) ?? null;
}

/** The clan a real player belongs to, or null. */
function clanOfPlayer(playerName) {
  const n = normalizeName(playerName);
  if (!n) return null;
  return allClans().find((c) => (c.playerMembers ?? []).includes(n)) ?? null;
}

function memberCount(clan) {
  return (clan?.members?.length ?? 0) + (clan?.playerMembers?.length ?? 0);
}

// --- writes ------------------------------------------------------------------

function recordActivity(clan, text) {
  if (!clan || !text) return;
  clan.activityLog.push({ at: Date.now(), text: String(text) });
  while (clan.activityLog.length > MAX_ACTIVITY_LOG) clan.activityLog.shift();
  markDirty();
}

/**
 * Found a clan. The founder is the first member. Name is derived from the
 * real kingdom name + kind label; a numeric suffix keeps it unique per
 * kingdom when two clans share a kind.
 */
function createClan(founderName, founderDisplay, kingdomId, kind) {
  const d = data();
  const kid = String(kingdomId ?? "");
  const existing = clansInKingdom(kid).filter((c) => c.kind === kind);
  if (existing.length >= MAX_CLANS_PER_KINGDOM) return null;
  const kName = kingdomNameOf(kid);
  d.seq += 1;
  const id = `clan_${d.seq}`;
  const clan = blankClan(id, founderName, founderDisplay, kid, kName, kind);
  if (existing.length > 0) clan.name = `${clan.name} ${existing.length + 1}`;
  d.clans[id] = clan;
  markDirty();
  journalEvent(founderName, `Founded the clan '${clan.name}'.`, "social");
  recordActivity(clan, `${clan.founderDisplay} founded the clan.`);
  return clan;
}

function addMember(clanId, citizenName, displayName) {
  const clan = getClan(clanId);
  if (!clan) return false;
  const n = normalizeName(citizenName);
  if (!n || clanOf(n)) return false; // one clan per citizen
  if ((clan.members?.length ?? 0) >= MAX_MEMBERS) return false;
  clan.members.push(n);
  clan.memberDisplay[n] = displayName ?? citizenName;
  markDirty();
  journalEvent(citizenName, `Joined the clan '${clan.name}'.`, "social");
  recordActivity(clan, `${displayName ?? citizenName} joined the clan.`);
  return true;
}

function addPlayerMember(clanId, playerName, displayName) {
  const clan = getClan(clanId);
  if (!clan) return false;
  const n = normalizeName(playerName);
  if (!n || clanOfPlayer(n)) return false;
  if ((clan.playerMembers?.length ?? 0) >= MAX_PLAYER_MEMBERS) return false;
  clan.playerMembers.push(n);
  clan.playerDisplay[n] = displayName ?? playerName;
  markDirty();
  journalEvent(n, `Joined the clan '${clan.name}' as a guest member.`, "social");
  recordActivity(clan, `${displayName ?? playerName} joined the clan.`);
  return true;
}

/**
 * A member leaves. If the leader leaves, the longest-standing member
 * (members[0] after the founder) takes over. An empty clan disbands.
 */
function removeMember(clanId, name) {
  const clan = getClan(clanId);
  if (!clan) return false;
  const n = normalizeName(name);
  const mi = (clan.members ?? []).indexOf(n);
  const pi = (clan.playerMembers ?? []).indexOf(n);
  if (mi < 0 && pi < 0) return false;
  if (mi >= 0) {
    clan.members.splice(mi, 1);
    delete clan.memberDisplay[n];
    journalEvent(n, `Left the clan '${clan.name}'.`, "social");
  } else {
    clan.playerMembers.splice(pi, 1);
    delete clan.playerDisplay[n];
  }
  recordActivity(clan, `${name} left the clan.`);
  if (normalizeName(clan.leader) === n && clan.members.length > 0) {
    clan.leader = clan.members[0];
    recordActivity(clan, `${clan.memberDisplay[clan.leader] ?? clan.leader} is the new clan leader.`);
  }
  markDirty();
  if (clan.members.length === 0) {
    disbandClan(clanId, "its last citizen member left");
  }
  return true;
}

function disbandClan(clanId, reason) {
  const d = data();
  const clan = d.clans[String(clanId)];
  if (!clan) return false;
  for (const m of clan.members ?? []) {
    journalEvent(m, `The clan '${clan.name}' disbanded (${reason ?? "faded away"}).`, "social");
  }
  delete d.clans[String(clanId)];
  markDirty();
  return true;
}

// --- invites -----------------------------------------------------------------

/**
 * A clan member invites another citizen. Rides the existing INVITE_CLAN
 * transport with the clan id in the payload.
 */
function inviteCitizen(inviterName, inviteeName, clanId) {
  const clan = getClan(clanId);
  if (!clan) return null;
  if (!normalizeName(inviterName) || !normalizeName(inviteeName)) return null;
  if (clanOf(inviteeName)) return null; // already in a clan
  return sendInvite(inviterName, inviteeName, INVITE_CLAN, { clanId: clan.id });
}

/** Resolve a citizen's pending clan invite (accept=true joins). */
function acceptClanInvite(citizenName, clanId, accepted) {
  const invites = getInvites(citizenName);
  const invite = invites.find(
    (i) => i.kind === INVITE_CLAN && String(i.data?.clanId ?? "") === String(clanId)
  );
  if (!invite) return false;
  resolveInvite(citizenName, invite.id, accepted);
  if (accepted) {
    return addMember(clanId, citizenName);
  }
  return true;
}

/** A clan member invites a real player they trust. */
function invitePlayer(inviterName, playerName, clanId) {
  const clan = getClan(clanId);
  if (!clan) return null;
  if (!normalizeName(inviterName) || !normalizeName(playerName)) return null;
  if (clanOfPlayer(playerName)) return null;
  return sendInvite(inviterName, playerName, INVITE_CLAN, { clanId: clan.id });
}

/** A player accepts a clan invite (called from the invite-accept path). */
function playerAcceptsClan(playerName, clanId, displayName) {
  const clan = getClan(clanId);
  if (!clan) return false;
  const ok = addPlayerMember(clanId, playerName, displayName ?? playerName);
  if (ok) {
    // Tell the clan: the leader journals it so the mouth knows.
    journalEvent(clan.leader, `${displayName ?? playerName} joined the clan '${clan.name}'.`, "social");
  }
  return ok;
}

/**
 * A player asks a clan's founder to let them in. Sends a requestJoin
 * invite to the founder; the clan tick processes it.
 */
function requestJoinClan(playerName, clanId) {
  const clan = getClan(clanId);
  if (!clan) return null;
  if (clanOfPlayer(playerName)) return null;
  return sendInvite(playerName, clan.founder, INVITE_CLAN, {
    clanId: clan.id,
    requestJoin: true,
  });
}

/**
 * Founders process pending join requests: player friends of the founder
 * get in (friends vouch), strangers stay pending until befriended.
 * Returns { accepted, declined } counts.
 */
function processJoinRequests() {
  let accepted = 0;
  for (const clan of allClans()) {
    const invites = getInvites(clan.founder);
    for (const invite of invites) {
      if (invite.kind !== INVITE_CLAN || !invite.data?.requestJoin) continue;
      if (String(invite.data?.clanId ?? "") !== String(clan.id)) continue;
      const playerName = invite.from;
      if (isFriend(clan.founder, playerName)) {
        resolveInvite(clan.founder, invite.id, true);
        if (playerAcceptsClan(playerName, clan.id, invite.fromDisplay)) accepted += 1;
      }
      // Strangers stay pending — befriend the founder first.
    }
  }
  return { accepted };
}

// --- moot bookkeeping --------------------------------------------------------

function lastMootAt(kingdomId) {
  return data().meta.moots[String(kingdomId)] ?? 0;
}

function stampMoot(kingdomId, atMs) {
  data().meta.moots[String(kingdomId)] = atMs;
  markDirty();
}

// --- player invite cooldowns --------------------------------------------------
// Per-player throttle so clans don't spam clan invites: a minimum gap
// between invites to the same player, and a no-re-ask window after a
// declined/ignored invite. Keyed by normalized player name, stored under
// meta so it rides the existing save/load. Bounded via pruning.

const MAX_INVITE_COOLDOWNS = 2000;

function inviteCooldowns() {
  const d = data();
  if (!d.meta.inviteCooldowns || typeof d.meta.inviteCooldowns !== "object") {
    d.meta.inviteCooldowns = {};
  }
  return d.meta.inviteCooldowns;
}

function pruneInviteCooldowns() {
  const map = inviteCooldowns();
  const keys = Object.keys(map);
  if (keys.length <= MAX_INVITE_COOLDOWNS) return;
  const byAge = keys
    .map((k) => ({
      k,
      at: Math.max(Number(map[k]?.noAskUntil) || 0, Number(map[k]?.lastInviteAt) || 0),
    }))
    .sort((a, b) => a.at - b.at);
  for (const { k } of byAge.slice(0, keys.length - MAX_INVITE_COOLDOWNS)) delete map[k];
}

/** Cooldown record for a player: { lastInviteAt, noAskUntil } (0 = none). */
function inviteCooldownOf(playerName) {
  const cd = inviteCooldowns()[normalizeName(playerName)] ?? {};
  return {
    lastInviteAt: Number(cd.lastInviteAt) || 0,
    noAskUntil: Number(cd.noAskUntil) || 0,
  };
}

/** Stamp that a clan invite went out to a player at atMs. */
function stampInviteSent(playerName, atMs = Date.now()) {
  const n = normalizeName(playerName);
  if (!n) return;
  const map = inviteCooldowns();
  map[n] = { ...(map[n] ?? {}), lastInviteAt: atMs };
  pruneInviteCooldowns();
  markDirty();
}

/** Register a no-re-ask window for a player (declined or ignored invite). */
function stampInviteNoAsk(playerName, noAskUntilMs) {
  const n = normalizeName(playerName);
  if (!n) return;
  const map = inviteCooldowns();
  map[n] = { ...(map[n] ?? {}), noAskUntil: noAskUntilMs };
  pruneInviteCooldowns();
  markDirty();
}

// --- test seams ---------------------------------------------------------------

function resetForTests() {
  cache = { clans: {}, meta: { moots: {} }, seq: 0 };
  dirty = false;
}

function clanCount() {
  return Object.keys(data().clans).length;
}

module.exports = {
  SAVE_FILE,
  KIND_CRAFT,
  KIND_TRADE,
  KIND_GUARD,
  KIND_SKILL,
  KIND_SOCIAL,
  CLAN_KINDS,
  KIND_LABELS,
  MAX_MEMBERS,
  MAX_PLAYER_MEMBERS,
  MAX_CLANS_PER_KINGDOM,
  kindForRecord,
  founderEligible,
  createClan,
  getClan,
  allClans,
  clansInKingdom,
  clanOf,
  clanOfPlayer,
  memberCount,
  addMember,
  addPlayerMember,
  removeMember,
  disbandClan,
  inviteCitizen,
  acceptClanInvite,
  invitePlayer,
  playerAcceptsClan,
  requestJoinClan,
  processJoinRequests,
  recordActivity,
  lastMootAt,
  stampMoot,
  inviteCooldownOf,
  stampInviteSent,
  stampInviteNoAsk,
  save,
  resetForTests,
  _setSavePathForTests,
  clanCount,
  normalizeName,
};
