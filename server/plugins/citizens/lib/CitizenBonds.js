"use strict";

/**
 * CitizenBonds — the social graph data layer for AI citizens.
 *
 * Every social mechanic (friends, enemies, parties, invites) lives here as
 * pure data. Zero LLM calls — this is the background tier. The foreground
 * (chat, notifications) reads this and roleplays from it.
 *
 * Per citizen:
 *   friends: [username] — mutual friendships with players (and citizens)
 *   enemies: [username] — grudge-3 relationships with real consequences
 *   party: { id, leader, members } — current adventuring party, if any
 *   pendingInvites: [{ id, kind, from, to, createdAt, expiresAt, data }]
 *     kinds: friend_request, clan_invite, boss_trip, party_invite, activity_invite
 *
 * Persisted to data/saves/citizen-bonds.json. Bounded: max friends/enemies
 * per citizen, invites expire.
 */

const fs = require("fs");
const path = require("path");
const CitizenAccountStore = require("./CitizenAccountStore");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-bonds.json");

const MAX_FRIENDS = 30;
const MAX_ENEMIES = 10;
const INVITE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Invite kinds.
const INVITE_FRIEND = "friend_request";
const INVITE_CLAN = "clan_invite";
const INVITE_BOSS = "boss_trip";
const INVITE_PARTY = "party_invite";
const INVITE_ACTIVITY = "activity_invite";

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    const parsed = raw && typeof raw === "object" ? raw : {};
    // Dual-read: overlay account blocks over the old-file cache.
    if (storeEnabled) {
      for (const key of Object.keys(parsed)) {
        const block = storeBlockFor(key);
        if (block) parsed[key] = block;
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

let cache = null;
let dirty = false;

// Dual-read with the per-citizen account store: the account block wins when
// present and non-empty, the old citizen-bonds.json file is the fallback
// (and stays fully written).
const STORE_BLOCK = "socialBonds";
let storeEnabled = true;

/** This citizen's account block, or null when absent/empty/the store is off. */
function storeBlockFor(name) {
  if (!storeEnabled) return null;
  try {
    const block = CitizenAccountStore.getBlock(name, STORE_BLOCK);
    if (block && typeof block === "object" && Object.keys(block).length > 0) return block;
  } catch {
    // The old-file cache is the fallback — never break the tick.
  }
  return null;
}

/** Dual-write one citizen's bonds entry into their account block. */
function syncStore(name, entry) {
  if (!storeEnabled || !name) return;
  try {
    CitizenAccountStore.setBlock(name, STORE_BLOCK, entry);
  } catch {
    // The old-file save remains the durable fallback.
  }
}

function data() {
  if (!cache) cache = load();
  return cache;
}

function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    // Prune expired invites on save.
    const now = Date.now();
    for (const key of Object.keys(cache)) {
      const b = cache[key];
      if (Array.isArray(b.pendingInvites)) {
        b.pendingInvites = b.pendingInvites.filter((i) => (i.expiresAt ?? 0) > now);
      }
    }
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache));
    dirty = false;
  } catch {
    // Never break the tick on a save failure.
  }
}

function bonds(citizenName) {
  const key = normalizeName(citizenName);
  const d = data();
  if (!d[key]) {
    // The account block wins when present, else a blank entry.
    d[key] = storeBlockFor(citizenName) ?? { friends: [], enemies: [], party: null, pendingInvites: [], following: null };
    dirty = true;
  }
  const b = d[key];
  if (!Array.isArray(b.friends)) b.friends = [];
  if (!Array.isArray(b.enemies)) b.enemies = [];
  if (!Array.isArray(b.pendingInvites)) b.pendingInvites = [];
  // following: { target, reason, since } | null — who this citizen is
  // physically following (party leader, boss-trip partner, etc.)
  return b;
}

// --- friends ---------------------------------------------------------------

function isFriend(citizenName, otherName) {
  return bonds(citizenName).friends.includes(normalizeName(otherName));
}

function addFriend(citizenName, otherName) {
  const b = bonds(citizenName);
  const n = normalizeName(otherName);
  if (!n || b.friends.includes(n)) return false;
  if (b.friends.length >= MAX_FRIENDS) b.friends.shift(); // oldest out
  // Can't be both friend and enemy.
  b.enemies = b.enemies.filter((e) => e !== n);
  b.friends.push(n);
  dirty = true;
  syncStore(citizenName, b);
  return true;
}

function removeFriend(citizenName, otherName) {
  const b = bonds(citizenName);
  const n = normalizeName(otherName);
  const before = b.friends.length;
  b.friends = b.friends.filter((f) => f !== n);
  if (b.friends.length !== before) dirty = true;
  if (b.friends.length !== before) syncStore(citizenName, b);
  return b.friends.length !== before;
}

// --- enemies ---------------------------------------------------------------

function isEnemy(citizenName, otherName) {
  return bonds(citizenName).enemies.includes(normalizeName(otherName));
}

function addEnemy(citizenName, otherName) {
  const b = bonds(citizenName);
  const n = normalizeName(otherName);
  if (!n || b.enemies.includes(n)) return false;
  if (b.enemies.length >= MAX_ENEMIES) b.enemies.shift();
  // Enemies aren't friends.
  b.friends = b.friends.filter((f) => f !== n);
  b.enemies.push(n);
  dirty = true;
  syncStore(citizenName, b);
  return true;
}

function removeEnemy(citizenName, otherName) {
  const b = bonds(citizenName);
  const n = normalizeName(otherName);
  const before = b.enemies.length;
  b.enemies = b.enemies.filter((e) => e !== n);
  if (b.enemies.length !== before) dirty = true;
  if (b.enemies.length !== before) syncStore(citizenName, b);
  return b.enemies.length !== before;
}

// --- invites ----------------------------------------------------------------

let inviteSeq = 0;

function sendInvite(from, to, kind, extraData) {
  const toBonds = bonds(to);
  const now = Date.now();
  // Don't duplicate an active invite of the same kind from the same sender.
  const dup = toBonds.pendingInvites.find(
    (i) => normalizeName(i.from) === normalizeName(from) && i.kind === kind && i.expiresAt > now
  );
  if (dup) return dup.id;
  const id = `inv_${now}_${++inviteSeq}`;
  toBonds.pendingInvites.push({
    id,
    kind,
    from: normalizeName(from),
    fromDisplay: String(from ?? ""),
    to: normalizeName(to),
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    data: extraData ?? {},
  });
  dirty = true;
  syncStore(to, toBonds);
  return id;
}

function getInvites(name) {
  const now = Date.now();
  return bonds(name).pendingInvites.filter((i) => i.expiresAt > now);
}

function resolveInvite(name, inviteId, accepted) {
  const b = bonds(name);
  const idx = b.pendingInvites.findIndex((i) => i.id === inviteId);
  if (idx < 0) return null;
  const [invite] = b.pendingInvites.splice(idx, 1);
  dirty = true;
  syncStore(name, b);
  // Apply the accepted invite's effect.
  if (accepted) {
    if (invite.kind === INVITE_FRIEND) {
      addFriend(name, invite.from);
      addFriend(invite.from, name); // mutual
    }
    // Clan/boss/party invites are handled by their own systems on accept;
    // the invite record just tracks the pending state.
  }
  return { invite, accepted };
}

// --- follow -----------------------------------------------------------------
// Physical following: party members follow the leader, boss-trip partners
// travel together. Data tier — the director tick applies it via setFollowing.

function getFollow(citizenName) {
  return bonds(citizenName).following ?? null;
}

function setFollow(citizenName, targetName, reason) {
  const b = bonds(citizenName);
  const t = normalizeName(targetName);
  if (!t) return false;
  b.following = { target: t, reason: reason ?? "follow", since: Date.now() };
  dirty = true;
  syncStore(citizenName, b);
  return true;
}

function clearFollow(citizenName) {
  const b = bonds(citizenName);
  if (!b.following) return false;
  b.following = null;
  dirty = true;
  syncStore(citizenName, b);
  return true;
}

// --- party ------------------------------------------------------------------

function getParty(citizenName) {
  return bonds(citizenName).party;
}

function setParty(citizenName, party) {
  const b = bonds(citizenName);
  b.party = party;
  dirty = true;
  syncStore(citizenName, b);
}

function clearParty(citizenName) {
  const b = bonds(citizenName);
  b.party = null;
  dirty = true;
  syncStore(citizenName, b);
}

module.exports = {
  SAVE_FILE,
  INVITE_FRIEND,
  INVITE_CLAN,
  INVITE_BOSS,
  INVITE_PARTY,
  INVITE_ACTIVITY,
  INVITE_TTL_MS,
  bonds,
  isFriend,
  addFriend,
  removeFriend,
  isEnemy,
  addEnemy,
  removeEnemy,
  sendInvite,
  getInvites,
  resolveInvite,
  getParty,
  setParty,
  clearParty,
  getFollow,
  setFollow,
  clearFollow,
  save,
  normalizeName,
};
