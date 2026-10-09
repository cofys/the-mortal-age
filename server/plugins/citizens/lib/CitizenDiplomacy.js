"use strict";

/**
 * CitizenDiplomacy — the data tier for the COVERT and DYNASTIC layer of
 * citizen diplomacy: espionage and royal marriage alliances.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Espionage: sneaky citizens with real Thieving 20+ run spy missions
 *     against rival kingdoms. Intelligence is REAL engine state read at
 *     gather time: garrison size (Tension.garrisonOf), border tension,
 *     and active wars (KingdomStore). Discovery has a real cost: +5
 *     border tension and a reputation hit for the spy.
 *   - Royal marriage alliances: charismatic, famous citizens broker
 *     dynastic marriages between kingdoms. Proposals move through real
 *     negotiation rounds — the foreign court can accept, counter, or
 *     refuse, with odds read from REAL state (live border tension,
 *     shared rivals, existing marriage bonds, broker fame). Ratification
 *     sets the REAL royals:marriage-bond flags both ways (the same flags
 *     Royals.Kingdoms reads, so stewards negotiate easier) and cools the
 *     border by 15 — the same number a royal wedding applies.
 *   - Player hook: players ask "what news from <kingdom>" and get the
 *     latest real intelligence summary.
 *
 * NO OVERLAP:
 *   - CitizenDiplomats owns the OVERT layer: courtier-diplomats, trade/
 *     culture/peace/alliance missions, stationed ambassadors, escort
 *     invitations. This module never posts ambassadors, never runs trade
 *     or peace missions — it owns what happens in the shadows (spies)
 *     and in the marriage bed (dynastic alliances), neither of which
 *     CitizenDiplomats covers.
 *   - Diplomacy.Kingdoms owns the OFFICE layer (stewards, spymasters,
 *     pacts, betrayals). This module never creates or breaks pacts.
 *   - Royals.Kingdoms owns AMBIENT royal events. Citizen-brokered
 *     marriages are a NEW path to the same real marriage-bond flags —
 *     a complement, not a duplicate.
 *   - Tension.Kingdoms owns the powder keg. This module only CALLS its
 *     public API — never reimplements it.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Negotiation rounds, marriage expiry, spy
 *     gathering, discovery, and announcements live in
 *     lib/CitizenDiplomacyLife.js.
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented money, no invented wars, no invented intelligence.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-diplomacy.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-diplomacy.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const KINGDOMS = Object.freeze(["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania"]);

// Marriage alliance: how long the bond lasts, and the border cooling.
const MARRIAGE_DURATION_MS = 90 * 24 * 60 * 60 * 1000;
const MARRIAGE_TENSION_DROP = 15; // same number a royal wedding applies
// Negotiation: a proposal gets one court round at most this often.
const NEGOTIATION_ROUND_MS = 6 * 60 * 60 * 1000;
// Proposals die unanswered after this long.
const PROPOSAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
// Fame required to broker a royal marriage.
const BROKER_FAME_REQUIRED = 40;
// Spy discovery chance per gather tick.
const SPY_DISCOVERY_CHANCE = 0.08;
// Caught spies cost their home kingdom this much border tension.
const SPY_CAUGHT_TENSION = 5;
// Thieving level required to run a spy mission.
const SPY_THIEVING_LEVEL = 20;

// --- state -------------------------------------------------------------------

let cache = null; // { marriages: [], spies: [], intel: {} }
let dirty = false;

function blank() {
  return { marriages: [], spies: [], intel: {} };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = {
      marriages: Array.isArray(parsed.marriages) ? parsed.marriages : [],
      spies: Array.isArray(parsed.spies) ? parsed.spies : [],
      intel: parsed.intel ?? {},
    };
  } catch {
    cache = blank();
  }
  return cache;
}

function markDirty() {
  dirty = true;
}

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
}

/** Persist if dirty. Returns true when a write happened. */
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

// --- kingdom helpers ---------------------------------------------------------

function kingdoms() {
  return [...KINGDOMS];
}

/** Canonical unordered pair key: "asgarnia:misthalin". */
function pairKey(a, b) {
  return [String(a ?? "").toLowerCase(), String(b ?? "").toLowerCase()].sort().join(":");
}

function isKnownKingdom(id) {
  return KINGDOMS.includes(String(id ?? "").toLowerCase());
}

// --- marriage alliances ------------------------------------------------------

let marriageSeq = 0;

/**
 * A famous citizen proposes a royal marriage alliance between two
 * kingdoms. Returns the proposal, or null when invalid (unknown
 * kingdoms, same kingdom, or an identical pending proposal exists).
 */
function proposeMarriage({ from, to, broker, nowMs = Date.now() }) {
  const a = String(from ?? "").toLowerCase();
  const b = String(to ?? "").toLowerCase();
  if (!broker || !isKnownKingdom(a) || !isKnownKingdom(b) || a === b) return null;
  const st = load();
  const dupe = st.marriages.find(
    (m) => pairKey(m.from, m.to) === pairKey(a, b) &&
      (m.status === "proposed" || m.status === "negotiating")
  );
  if (dupe) return null;
  marriageSeq += 1;
  const proposal = {
    id: `mar-${nowMs}-${marriageSeq}`,
    from: a,
    to: b,
    broker: String(broker),
    status: "proposed",
    rounds: 0,
    createdAt: nowMs,
    lastRoundAt: 0,
    respondedAt: null,
    ratifiedAt: null,
    expiresAt: nowMs + MARRIAGE_DURATION_MS,
  };
  st.marriages.push(proposal);
  markDirty();
  return { ...proposal };
}

function marriageById(id) {
  const m = load().marriages.find((x) => x.id === id);
  return m ? { ...m } : null;
}

/** Pending (proposed/negotiating) marriage proposals involving a kingdom. */
function pendingMarriagesFor(kingdomId) {
  const k = String(kingdomId ?? "").toLowerCase();
  return load()
    .marriages.filter(
      (m) => (m.status === "proposed" || m.status === "negotiating") && (m.from === k || m.to === k)
    )
    .map((m) => ({ ...m }));
}

/** Active (ratified, unexpired) marriage alliances involving a kingdom. */
function activeMarriagesFor(kingdomId, nowMs = Date.now()) {
  const k = String(kingdomId ?? "").toLowerCase();
  return load()
    .marriages.filter((m) => m.status === "ratified" && m.expiresAt > nowMs && (m.from === k || m.to === k))
    .map((m) => ({ ...m }));
}

function hasMarriageAlliance(a, b, nowMs = Date.now()) {
  const key = pairKey(a, b);
  return load().marriages.some(
    (m) => m.status === "ratified" && m.expiresAt > nowMs && pairKey(m.from, m.to) === key
  );
}

/**
 * Read the foreign court's disposition toward a marriage proposal from
 * REAL state. Returns an acceptance weight 0..1 the Life tick turns into
 * accept/counter/refuse.
 */
function courtDisposition(proposal) {
  let w = 0.4; // dynastic marriages are a hard sell
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    const t = Tension.getTension(proposal.from, proposal.to);
    if (typeof t === "number") {
      if (t < 20) w += 0.2; // calm borders marry
      else if (t > 60) w -= 0.2; // hot borders don't
    }
    // Shared rival: courts bond against a common enemy.
    try {
      const Store = require("../../kingdoms/KingdomStore");
      const wars = Store.getActiveWars?.() ?? [];
      const fromFoes = new Set();
      const toFoes = new Set();
      for (const war of wars) {
        const at = war.attackerId ?? war.attacker;
        const df = war.defenderId ?? war.defender;
        if (at === proposal.from || df === proposal.from) fromFoes.add(at === proposal.from ? df : at);
        if (at === proposal.to || df === proposal.to) toFoes.add(at === proposal.to ? df : at);
      }
      for (const foe of fromFoes) {
        if (toFoes.has(foe)) {
          w += 0.2;
          break;
        }
      }
    } catch { /* wars unreadable */ }
  } catch { /* tension unreadable */ }
  // An existing marriage bond means the families already like each other.
  try {
    const Store = require("../../kingdoms/KingdomStore");
    if (Store.getFlag?.(proposal.to, `royals:marriage-bond:${proposal.from}`)) w += 0.15;
  } catch { /* flags unreadable */ }
  // A legendary broker opens doors a famous one can't.
  try {
    const Rep = require("./CitizenReputation");
    if (proposal.broker && typeof Rep.reputationFor === "function") {
      const score = Rep.reputationFor(proposal.broker);
      if (score >= 75) w += 0.15;
      else if (score >= 40) w += 0.05;
    }
  } catch { /* reputation unreadable */ }
  return Math.max(0.05, Math.min(0.95, w));
}

/**
 * Advance one negotiation round on a marriage proposal. Returns:
 * "accepted" | "countered" | "refused" | "waiting" | "expired" | null.
 */
function negotiateRound(proposalId, nowMs = Date.now()) {
  const st = load();
  const m = st.marriages.find((x) => x.id === proposalId);
  if (!m || (m.status !== "proposed" && m.status !== "negotiating")) return null;
  if (nowMs - m.lastRoundAt < NEGOTIATION_ROUND_MS) return "waiting";
  if (nowMs > m.createdAt + PROPOSAL_EXPIRY_MS) {
    m.status = "expired";
    m.respondedAt = nowMs;
    markDirty();
    return "expired";
  }
  m.rounds += 1;
  m.lastRoundAt = nowMs;
  m.status = "negotiating";
  const roll = Math.random();
  const w = courtDisposition(m);
  let outcome;
  if (roll < w * 0.7) {
    outcome = "accepted";
    m.status = "ratified";
    m.ratifiedAt = nowMs;
    m.respondedAt = nowMs;
  } else if (roll < w * 0.7 + 0.25 && m.rounds < 4) {
    outcome = "countered"; // the court haggles over the dowry, behind doors
  } else {
    outcome = "refused";
    m.status = "rejected";
    m.respondedAt = nowMs;
  }
  markDirty();
  return outcome;
}

/**
 * Apply the REAL effects of a ratified marriage alliance. Called once per
 * alliance by the Life tick (it checks m.effectsApplied). Returns a list
 * of human-readable effect descriptions for announcements.
 */
function applyMarriageEffects(proposal) {
  const st = load();
  const m = st.marriages.find((x) => x.id === proposal.id);
  if (!m || m.status !== "ratified" || m.effectsApplied) return [];
  const effects = [];
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    const Store = require("../../kingdoms/KingdomStore");
    if (typeof Tension.getTension === "function" && typeof Tension.setTension === "function") {
      const cur = Tension.getTension(m.from, m.to) ?? 0;
      Tension.setTension(m.from, m.to, Math.max(0, cur - MARRIAGE_TENSION_DROP));
      effects.push(`border tension cooled by ${MARRIAGE_TENSION_DROP}`);
    }
    // The REAL marriage-bond flags Royals.Kingdoms reads.
    Store.setFlag?.(m.from, `royals:marriage-bond:${m.to}`, true);
    Store.setFlag?.(m.to, `royals:marriage-bond:${m.from}`, true);
    Store.setFlag?.(m.from, "royals:last-marriage-at", Date.now());
    Store.setFlag?.(m.to, "royals:last-marriage-at", Date.now());
    effects.push("royal marriage bond sealed");
  } catch { /* kingdom layer unreachable — the alliance stands on paper only */ }
  m.effectsApplied = true;
  markDirty();
  if (m.broker) {
    try {
      const Rep = require("./CitizenReputation");
      Rep.awardDeed?.(m.broker, "peacemaker");
    } catch { /* reputation unreachable */ }
  }
  return effects;
}

// --- espionage ---------------------------------------------------------------

/**
 * Start a spy mission. The spy must have real Thieving >= 20 — checked by
 * the caller; this records the mission. One active mission per spy.
 */
function startSpyMission({ spy, homeKingdom, targetKingdom, nowMs = Date.now() }) {
  const home = String(homeKingdom ?? "").toLowerCase();
  const target = String(targetKingdom ?? "").toLowerCase();
  if (!spy || !isKnownKingdom(home) || !isKnownKingdom(target) || home === target) return null;
  const st = load();
  const active = st.spies.find(
    (m) => normalizeName(m.spy) === normalizeName(spy) && m.status === "active"
  );
  if (active) return null;
  const mission = {
    id: `spy-${nowMs}-${st.spies.length}`,
    spy: String(spy),
    homeKingdom: home,
    targetKingdom: target,
    status: "active",
    startedAt: nowMs,
    intel: null,
    discoveredAt: null,
  };
  st.spies.push(mission);
  markDirty();
  return { ...mission };
}

function spyMissionFor(spy) {
  const m = load().spies.find(
    (x) => normalizeName(x.spy) === normalizeName(spy) && x.status === "active"
  );
  return m ? { ...m } : null;
}

/**
 * Gather intelligence: read REAL engine state about the target kingdom.
 * Returns the intel record (also persisted for "what news from X" chat).
 */
function gatherIntel(missionId, nowMs = Date.now()) {
  const st = load();
  const m = st.spies.find((x) => x.id === missionId);
  if (!m || m.status !== "active") return null;
  const intel = { gatheredAt: nowMs, targetKingdom: m.targetKingdom };
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    intel.garrison = Tension.garrisonOf?.(m.targetKingdom) ?? null;
    intel.tensionWithHome = Tension.getTension?.(m.homeKingdom, m.targetKingdom) ?? null;
  } catch { /* tension unreadable */ }
  try {
    const Store = require("../../kingdoms/KingdomStore");
    const wars = Store.getActiveWars?.() ?? [];
    intel.atWarWith = wars
      .filter((w) => {
        const at = w.attackerId ?? w.attacker;
        const df = w.defenderId ?? w.defender;
        return at === m.targetKingdom || df === m.targetKingdom;
      })
      .map((w) => {
        const at = w.attackerId ?? w.attacker;
        const df = w.defenderId ?? w.defender;
        return at === m.targetKingdom ? df : at;
      });
  } catch { /* wars unreadable */ }
  m.intel = intel;
  m.status = "reported";
  st.intel[m.targetKingdom] = { ...intel, spy: m.spy, homeKingdom: m.homeKingdom };
  markDirty();
  return { ...intel };
}

/**
 * Discovery roll for an active mission. On discovery the mission ends,
 * border tension rises by a REAL amount, and the spy takes a reputation
 * hit. Returns true when discovered.
 */
function discoveryRoll(missionId, nowMs = Date.now()) {
  const st = load();
  const m = st.spies.find((x) => x.id === missionId);
  if (!m || m.status !== "active") return false;
  if (Math.random() >= SPY_DISCOVERY_CHANCE) return false;
  m.status = "discovered";
  m.discoveredAt = nowMs;
  markDirty();
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    Tension.addTension?.(m.homeKingdom, m.targetKingdom, SPY_CAUGHT_TENSION);
  } catch { /* tension unreachable */ }
  try {
    const Rep = require("./CitizenReputation");
    Rep.addReputation?.(m.spy, -4, "caught spying", nowMs);
  } catch { /* reputation unreachable */ }
  return true;
}

/** Latest intelligence on a kingdom (for chat answers). */
function latestIntelOn(kingdomId) {
  const r = load().intel[String(kingdomId ?? "").toLowerCase()];
  return r ? { ...r } : null;
}

/** Human-readable intel summary. Null when there's nothing to report. */
function describeIntel(kingdomId) {
  const r = latestIntelOn(kingdomId);
  if (!r) return null;
  const bits = [];
  if (r.garrison != null) bits.push(`a garrison of about ${r.garrison} levies`);
  if (r.tensionWithHome != null) {
    const t = r.tensionWithHome;
    bits.push(t >= 60 ? "the border seethes" : t >= 30 ? "the border is tense" : "the border is calm");
  }
  if (Array.isArray(r.atWarWith) && r.atWarWith.length) {
    bits.push(`at war with ${r.atWarWith.join(", ")}`);
  } else if (Array.isArray(r.atWarWith)) {
    bits.push("at peace, for now");
  }
  return bits.length ? bits.join("; ") : null;
}

// --- summaries ---------------------------------------------------------------

function summaryFor(kingdomId, nowMs = Date.now()) {
  const k = String(kingdomId ?? "").toLowerCase();
  return {
    marriages: activeMarriagesFor(k, nowMs).map(
      (m) => `royal marriage alliance between ${m.from} and ${m.to} (brokered by ${m.broker})`
    ),
    pending: pendingMarriagesFor(k).map(
      (m) => `marriage proposal between ${m.from} and ${m.to} (${m.status})`
    ),
  };
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  kingdoms,
  pairKey,
  isKnownKingdom,
  BROKER_FAME_REQUIRED,
  SPY_THIEVING_LEVEL,
  proposeMarriage,
  marriageById,
  pendingMarriagesFor,
  activeMarriagesFor,
  hasMarriageAlliance,
  courtDisposition,
  negotiateRound,
  applyMarriageEffects,
  startSpyMission,
  spyMissionFor,
  gatherIntel,
  discoveryRoll,
  latestIntelOn,
  describeIntel,
  summaryFor,
};
