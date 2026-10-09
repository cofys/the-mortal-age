"use strict";

/**
 * CitizenTradeCharters — exclusive trade charters (monopolies) for guilds.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick, the economy, and chat):
 *   - Trade charters: a trade guild (merchants or crafters) holds the EXCLUSIVE
 *     right to trade a goods category in a kingdom. One charter per
 *     (kingdom, category) — real monopolies.
 *   - Categories tied to real skills: weapons, armor, food, potions, runes,
 *     lumber, ore, jewelry. Each maps to the tsps skills that produce them.
 *   - Charter lifecycle: petition (5,000 real coins to the kingdom treasury
 *     via CitizenBanking) -> granted (30 days) -> renew (2,500 from the guild
 *     treasury) or lapse. Only guild masters/grandmasters (or 30+ fame
 *     citizens) may petition.
 *   - REAL effects (never invented):
 *     * tollBpsFor(kingdomId, category): non-guild sellers pay a 2% toll on
 *       GE sales of chartered goods. The economy fee hook reads this
 *       defensively — no charter, no toll.
 *     * memberExempt(username): trade-guild members are exempt from the toll.
 *     * Guild treasury: tolls accrue as real tracked coins; renewals draw
 *       from it honestly (can't pay = charter lapses).
 *   - Revocation: the tick revokes charters when the kingdom is at war
 *     (read defensively from the war layer) or the guild treasury is empty
 *     at renewal.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Expiry, renewal, revocation, and announcements live
 *     in lib/CitizenTradeCharterLife.js.
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - No invented money: every coin movement is real (player inventory) or
 *     honestly tracked (guild treasury ledger).
 *   - Never touches lib/*2 (frozen).
 *
 * No-overlap boundary: CitizenGuilds owns membership/ranks/dues/missions;
 * this owns ONLY the charter/monopoly layer on top. CitizenBanking owns
 * kingdom treasuries (we only deposit into them).
 *
 * Persisted to data/saves/citizen-trade-charters.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-trade-charters.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const KINGDOMS = Object.freeze(["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania"]);

// Goods categories a charter can cover. skills: the real tsps skill ids whose
// products fall under this category.
const CATEGORIES = Object.freeze({
  weapons: Object.freeze({ label: "weapons", skills: Object.freeze(["smithing"]), guilds: Object.freeze(["merchants", "crafters"]) }),
  armor: Object.freeze({ label: "armor", skills: Object.freeze(["smithing"]), guilds: Object.freeze(["merchants", "crafters"]) }),
  food: Object.freeze({ label: "food", skills: Object.freeze(["cooking"]), guilds: Object.freeze(["merchants"]) }),
  potions: Object.freeze({ label: "potions", skills: Object.freeze(["herblore"]), guilds: Object.freeze(["merchants", "crafters"]) }),
  runes: Object.freeze({ label: "runes", skills: Object.freeze(["runecraft"]), guilds: Object.freeze(["merchants"]) }),
  lumber: Object.freeze({ label: "lumber", skills: Object.freeze(["woodcutting"]), guilds: Object.freeze(["merchants"]) }),
  ore: Object.freeze({ label: "ore", skills: Object.freeze(["mining"]), guilds: Object.freeze(["merchants", "crafters"]) }),
  jewelry: Object.freeze({ label: "jewelry", skills: Object.freeze(["crafting"]), guilds: Object.freeze(["crafters"]) }),
});

const CHARTER_FEE = 5000; // petition fee, real coins -> kingdom treasury
const RENEWAL_FEE = 2500; // renewal fee, real coins from guild treasury
const CHARTER_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOLL_BPS = 200; // 2% reference rate (used when offer value is known)
const SALE_TOLL_FLAT = 25; // flat toll per chartered GE sale, real coins
const PETITION_FAME = 30; // fame needed to petition without guild-master rank

// --- state -------------------------------------------------------------------

let cache = null;
// { charters: { "kingdom|category": { guildId, grantedAt, expiresAt, petitioner } },
//   treasuries: { guildId: coins } }
let dirty = false;

function blankState() {
  return { charters: Object.create(null), treasuries: Object.create(null) };
}

function charterKey(kingdomId, category) {
  return `${String(kingdomId ?? "").toLowerCase()}|${String(category ?? "").toLowerCase()}`;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    cache = blankState();
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw.charters ?? {})) {
        if (!v || typeof v !== "object") continue;
        const [kid, cat] = String(k).split("|");
        if (!KINGDOMS.includes(kid) || !CATEGORIES[cat]) continue;
        if (!["merchants", "crafters"].includes(v.guildId)) continue;
        cache.charters[k] = {
          guildId: v.guildId,
          grantedAt: Number(v.grantedAt ?? 0),
          expiresAt: Number(v.expiresAt ?? 0),
          petitioner: String(v.petitioner ?? "unknown"),
        };
      }
      for (const [k, v] of Object.entries(raw.treasuries ?? {})) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) cache.treasuries[k] = Math.floor(n);
      }
    }
  } catch {
    cache = blankState();
  }
  return cache;
}

function markDirty() {
  dirty = true;
}

function resetForTests() {
  cache = null;
  dirty = false;
}

// --- reads -------------------------------------------------------------------

/** The charterable goods categories. */
function categories() {
  return CATEGORIES;
}

/** Category definition by id, or null. */
function categoryFor(id) {
  return CATEGORIES[String(id ?? "").toLowerCase()] ?? null;
}

/** The five kingdoms charters can be held in. */
function kingdoms() {
  return [...KINGDOMS];
}

function isKnownKingdom(id) {
  return KINGDOMS.includes(String(id ?? "").toLowerCase());
}

/** The active charter for (kingdom, category), or null. */
function charterFor(kingdomId, category) {
  if (!isKnownKingdom(kingdomId) || !categoryFor(category)) return null;
  const c = load().charters[charterKey(kingdomId, category)];
  if (!c) return null;
  if (c.expiresAt > 0 && c.expiresAt <= Date.now()) return null; // expired
  return c;
}

/** True when the category is chartered in the kingdom. */
function isChartered(kingdomId, category) {
  return charterFor(kingdomId, category) !== null;
}

/** Guild id holding the charter, or null. */
function charterHolder(kingdomId, category) {
  return charterFor(kingdomId, category)?.guildId ?? null;
}

/**
 * Toll in basis points on GE sales of chartered goods by non-guild sellers.
 * Returns 0 when no charter covers (kingdom, category) — the economy fee
 * hook reads this defensively.
 */
function tollBpsFor(kingdomId, category) {
  return isChartered(kingdomId, category) ? TOLL_BPS : 0;
}

/**
 * True when the citizen is exempt from charter tolls (member of a trade
 * guild that holds any charter). Reads CitizenGuilds defensively.
 */
function memberExempt(username) {
  if (!username) return false;
  try {
    const G = require("./CitizenGuilds");
    const m = typeof G.membershipFor === "function" ? G.membershipFor(username) : null;
    if (!m || !["merchants", "crafters"].includes(m.guildId)) return false;
    // Exempt only if their guild actually holds a charter somewhere.
    const st = load();
    return Object.values(st.charters).some((c) => c.guildId === m.guildId && (c.expiresAt <= 0 || c.expiresAt > Date.now()));
  } catch {
    return false;
  }
}

/** Guild treasury balance (real tracked coins from tolls). */
function treasuryFor(guildId) {
  return Math.max(0, Math.floor(load().treasuries[String(guildId ?? "").toLowerCase()] ?? 0));
}

/** All charters including expired ones, for the tick's cleanup sweep. */
function allCharters() {
  const st = load();
  const out = [];
  for (const [k, c] of Object.entries(st.charters)) {
    const [kingdomId, category] = String(k).split("|");
    out.push({ kingdomId, category, ...c });
  }
  return out;
}

/** All active charters, for the tick and chat. */
function activeCharters(nowMs = Date.now()) {
  const st = load();
  const out = [];
  for (const [k, c] of Object.entries(st.charters)) {
    if (c.expiresAt > 0 && c.expiresAt <= nowMs) continue;
    const [kingdomId, category] = String(k).split("|");
    out.push({ kingdomId, category, ...c });
  }
  return out;
}

// --- coin helpers (real engine reads, same pattern as CitizenGuilds) ----------
// Canonical engine API only (getAmount / deleteNumber / adds). The old guards
// probed `inv.count` / `inv.remove` (neither exists on the engine inventory).
// These three are the only coin paths; every balance move is verified before
// reporting success.

/** Read a real item amount. Never throws, never invents. */
function coinCountInv(inv, id) {
  try { return inv?.getAmount?.(id) ?? 0; } catch { return 0; }
}

/**
 * Remove exactly `amount` of `id`, verifying the balance moved.
 * Returns true only when the inventory confirms the debit.
 */
function takeCoins(inv, id, amount) {
  try {
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(id) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(id, amount);
    return (inv.getAmount?.(id) ?? 0) === before - amount;
  } catch { return false; }
}

/**
 * Credit exactly `amount` of `id`, verifying the balance moved.
 * Returns true only when the inventory confirms the credit.
 */
function giveCoins(inv, id, amount) {
  try {
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(id) ?? 0;
    inv.adds?.(id, amount);
    return (inv.getAmount?.(id) ?? 0) === before + amount;
  } catch { return false; }
}

/** Test seam: canonical real-API coin helpers (inventory audit). */
function _coinHelpersForTests() {
  return { coinCount: coinCountInv, takeCoins, giveCoins };
}

function coinCount(player) {
  try {
    const inv = player?.getInventory?.() ?? player?.inventory;
    if (typeof inv?.getAmount === "function") return coinCountInv(inv, 995);
    if (Array.isArray(inv)) {
      return inv.filter((i) => Number(i?.id) === 995).reduce((n, i) => n + Number(i?.amount ?? 1), 0);
    }
  } catch {
    // fall through
  }
  return 0;
}

function removeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.() ?? player?.inventory;
    return takeCoins(inv, 995, amount);
  } catch {
    // fall through
  }
  return false;
}

function fameOf(username) {
  try {
    const Rep = require("./CitizenReputation");
    if (typeof Rep.reputationFor === "function") return Rep.reputationFor(username) ?? 0;
  } catch {
    // reputation unreachable
  }
  return 0;
}

function guildRankOf(username) {
  try {
    const G = require("./CitizenGuilds");
    const m = typeof G.membershipFor === "function" ? G.membershipFor(username) : null;
    return m ? { guildId: m.guildId, rank: m.rank } : null;
  } catch {
    return null;
  }
}

function awardCharterReputation(username, points, reason, nowMs) {
  try {
    const Rep = require("./CitizenReputation");
    if (typeof Rep.awardDeed === "function") Rep.awardDeed(username, "charterholder", nowMs);
    else if (typeof Rep.addReputation === "function") Rep.addReputation(username, points, reason, nowMs);
  } catch {
    // reputation is best-effort
  }
}

// --- writes ------------------------------------------------------------------

/**
 * Petition the kingdom for an exclusive trade charter.
 * The petitioner must be a master/grandmaster of the merchants or crafters
 * guild (or have 30+ fame), and pay CHARTER_FEE real coins, which go to the
 * kingdom treasury via CitizenBanking. Returns { ok, charter?, reason? }.
 */
function petitionCharter(username, guildId, kingdomId, category, player = null, nowMs = Date.now()) {
  const gid = String(guildId ?? "").toLowerCase();
  const kid = String(kingdomId ?? "").toLowerCase();
  const cat = categoryFor(category);
  if (!["merchants", "crafters"].includes(gid)) return { ok: false, reason: "only trade guilds may hold charters" };
  if (!isKnownKingdom(kid)) return { ok: false, reason: "unknown kingdom" };
  if (!cat) return { ok: false, reason: "unknown goods category" };
  if (!cat.guilds.includes(gid)) return { ok: false, reason: `${cat.label} charters are not open to that guild` };
  if (!username) return { ok: false, reason: "no petitioner" };
  if (isChartered(kid, category)) return { ok: false, reason: "already chartered" };

  // Standing: guild master/grandmaster, or 30+ fame.
  const gm = guildRankOf(username);
  const isMaster = gm && gm.guildId === gid && ["master", "grandmaster"].includes(gm.rank);
  if (!isMaster && fameOf(username) < PETITION_FAME) {
    return { ok: false, reason: `needs guild-master rank or ${PETITION_FAME} fame` };
  }

  // Real coins: the fee goes to the kingdom treasury.
  if (player) {
    if (coinCount(player) < CHARTER_FEE) return { ok: false, reason: `needs ${CHARTER_FEE} coins for the charter fee` };
    if (!removeCoins(player, CHARTER_FEE)) return { ok: false, reason: "could not take charter fee" };
  }
  try {
    const B = require("./CitizenBanking");
    if (typeof B.treasuryDeposit === "function") B.treasuryDeposit(kid, CHARTER_FEE);
  } catch {
    // banking unreachable — the coins were still honestly taken
  }

  const st = load();
  st.charters[charterKey(kid, category)] = {
    guildId: gid,
    grantedAt: nowMs,
    expiresAt: nowMs + CHARTER_DURATION_MS,
    petitioner: String(username),
  };
  markDirty();
  awardCharterReputation(username, 8, `secured the ${cat.label} trade charter in ${kid}`, nowMs);
  return { ok: true, charter: st.charters[charterKey(kid, category)] };
}

/**
 * Renew an active charter for another 30 days. Draws RENEWAL_FEE from the
 * guild treasury honestly — can't pay, can't renew.
 */
function renewCharter(kingdomId, category, nowMs = Date.now()) {
  const c = charterFor(kingdomId, category);
  if (!c) return { ok: false, reason: "no active charter" };
  const st = load();
  const bal = treasuryFor(c.guildId);
  if (bal < RENEWAL_FEE) return { ok: false, reason: "guild treasury cannot afford renewal" };
  st.treasuries[c.guildId] = bal - RENEWAL_FEE;
  c.expiresAt = nowMs + CHARTER_DURATION_MS;
  markDirty();
  try {
    const B = require("./CitizenBanking");
    if (typeof B.treasuryDeposit === "function") B.treasuryDeposit(String(kingdomId).toLowerCase(), RENEWAL_FEE);
  } catch {
    // banking unreachable
  }
  return { ok: true, charter: c };
}

/**
 * Accrue a toll to the guild treasury. Called by the economy fee hook when
 * a non-guild seller trades chartered goods. Amount is real tracked coins.
 */
function collectToll(guildId, amount) {
  const gid = String(guildId ?? "").toLowerCase();
  const n = Math.floor(Number(amount ?? 0));
  if (!["merchants", "crafters"].includes(gid) || !(n > 0)) return 0;
  const st = load();
  st.treasuries[gid] = treasuryFor(gid) + n;
  markDirty();
  return st.treasuries[gid];
}

/** Revoke a charter (war, misconduct, expiry). Returns true when removed. */
function revokeCharter(kingdomId, category) {
  const st = load();
  const k = charterKey(kingdomId, category);
  if (!st.charters[k]) return false;
  delete st.charters[k];
  markDirty();
  return true;
}

// --- persistence ---------------------------------------------------------------

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(load(), null, 2), "utf8");
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  _setSavePathForTests,
  _coinHelpersForTests,
  resetForTests,
  categories,
  categoryFor,
  kingdoms,
  isKnownKingdom,
  charterFor,
  isChartered,
  charterHolder,
  tollBpsFor,
  memberExempt,
  treasuryFor,
  activeCharters,
  allCharters,
  petitionCharter,
  renewCharter,
  collectToll,
  revokeCharter,
  save,
  CHARTER_FEE,
  RENEWAL_FEE,
  CHARTER_DURATION_MS,
  TOLL_BPS,
  SALE_TOLL_FLAT,
  PETITION_FAME,
};
