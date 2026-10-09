"use strict";

/**
 * CitizenTreaties — the citizen-owned diplomacy layer: formal treaties,
 * embassies, and summits between the five great kingdoms.
 *
 * WHAT IT DOES (data tier, free, slow director tick):
 *   - Treaties: peace, trade, and alliance agreements brokered by citizens
 *     (or real players). Proposals advance one court round per
 *     NEGOTIATION_ROUND_MS, expire after PROPOSAL_EXPIRY_MS, and on
 *     ratification apply REAL effects through the kingdom layer's public
 *     APIs — never invented numbers:
 *       * peace:   Tension.setTension cooled by PEACE_TENSION_DROP
 *       * trade:   tension cooled + tradeBonusFor(a,b) seam (5% caravan
 *                  profit bonus — the caravan layer reads this defensively)
 *       * alliance: emits kingdom:alliance-formed { a, b, pactName, broker }
 *                  — the kingdoms layer persists the pact, pins the border
 *                  calm, and pays the trade bonus on tax day. The citizen
 *                  layer never reimplements pacts (complement, not duplicate).
 *   - Embassies: one permanent embassy per (home, host) pair, built with
 *     real coins (EMBASSY_COST from the builder's real inventory — honest
 *     failure when they cannot pay). An embassy is REQUIRED to propose
 *     trade or alliance treaties (gives embassies real purpose). Embassies
 *     cool their border a little every tick and are sacked when the pair
 *     goes to war (read defensively from the war layer).
 *   - Summits: leaders of two kingdoms meet — requires an embassy pair.
 *     Held 24h after scheduling; cools tension, gives pending treaties a
 *     ratification bonus, and is announced realm-wide. Never invents
 *     leaders: attendance is read defensively and the summit stands on
 *     the treaty record either way.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Negotiation rounds, embassy decay, summit execution,
 *     treaty expiry, and announcements live in lib/CitizenTreatyLife.js.
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented money, no invented wars, no invented intelligence.
 *   - Never touches lib/*2 (frozen).
 *   - No overlap with CitizenDiplomats (envoy missions), CitizenDiplomacy
 *     (espionage + royal marriages), or the kingdoms-layer pact owners
 *     (Alliances/Diplomacy.Kingdoms own pact persistence).
 *
 * Persisted to data/saves/citizen-treaties.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-treaties.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const KINGDOMS = Object.freeze(["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania"]);

// Treaty types: duration, border cooling on ratification.
const TREATY_TYPES = Object.freeze({
  peace: Object.freeze({ durationMs: 30 * 24 * 60 * 60 * 1000, tensionDrop: 20, label: "peace treaty" }),
  trade: Object.freeze({ durationMs: 60 * 24 * 60 * 60 * 1000, tensionDrop: 10, label: "trade treaty" }),
  alliance: Object.freeze({ durationMs: 90 * 24 * 60 * 60 * 1000, tensionDrop: 25, label: "alliance" }),
});

// Trade treaty: caravan profit bonus read defensively by the caravan layer.
const TRADE_CARAVAN_BONUS = 0.05;

// Embassy: real-coin construction cost.
const EMBASSY_COST = 5000;
// Embassy: border cooling per slow tick while it stands.
const EMBASSY_TENSION_DECAY = 1;
// Fame required to broker a treaty (mirrors the marriage-broker rule).
const BROKER_FAME_REQUIRED = 30;
// Negotiation: a proposal gets one court round at most this often.
const NEGOTIATION_ROUND_MS = 6 * 60 * 60 * 1000;
// Proposals die unanswered after this long.
const PROPOSAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
// Summit: held this long after scheduling.
const SUMMIT_DELAY_MS = 24 * 60 * 60 * 1000;
// Summit: border cooling when leaders meet.
const SUMMIT_TENSION_DROP = 10;
// Summit: acceptance bonus for pending treaties between the pair.
const SUMMIT_RATIFY_BONUS = 0.15;

// --- state -------------------------------------------------------------------

let cache = null; // { proposals: [], treaties: [], embassies: [], summits: [] }
let dirty = false;

function blank() {
  return { proposals: [], treaties: [], embassies: [], summits: [] };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = {
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      treaties: Array.isArray(parsed.treaties) ? parsed.treaties : [],
      embassies: Array.isArray(parsed.embassies) ? parsed.embassies : [],
      summits: Array.isArray(parsed.summits) ? parsed.summits : [],
    };
  } catch {
    cache = blank();
  }
  return cache;
}

function markDirty() {
  dirty = true;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(load(), null, 2), "utf8");
    dirty = false;
    return true;
  } catch {
    // persistence is best-effort; the tick keeps going
    return false;
  }
}

function resetForTests() {
  cache = blank();
  dirty = false;
}

function isKnownKingdom(id) {
  return KINGDOMS.includes(String(id ?? "").toLowerCase());
}

function kingdoms() {
  return [...KINGDOMS];
}

function pairKey(a, b) {
  return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join("|");
}

// --- fame (defensive read) ---------------------------------------------------

function fameOf(username) {
  try {
    // Canonical fame read: CitizenReputation.reputationFor(username) returns
    // the citizen's score (same seam CitizenTradeCharters uses). The old
    // code read Rep.fameOf / Rep.scoreOf — neither is exported, so this
    // always returned 0 and EVERY citizen broker was rejected as
    // "fame-too-low": only players could ever propose treaties.
    const Rep = require("./CitizenReputation");
    if (typeof Rep.reputationFor === "function") return Rep.reputationFor(username) ?? 0;
  } catch {
    // reputation unreachable — fame check fails closed for citizens
  }
  return 0;
}

// --- embassies ---------------------------------------------------------------

/**
 * Build an embassy: home kingdom's mission in the host kingdom.
 * Costs EMBASSY_COST real coins, taken via the injected takeCoins()
 * (the caller resolves the builder's real player and removes real coins —
 * the data tier never touches inventories directly). Honest failure when
 * they cannot pay.
 * Returns { ok, embassy } or { ok:false, reason }.
 */
function buildEmbassy({ home, host, builder, nowMs = Date.now(), takeCoins } = {}) {
  const h = String(home ?? "").toLowerCase();
  const t = String(host ?? "").toLowerCase();
  if (!isKnownKingdom(h) || !isKnownKingdom(t) || h === t) {
    return { ok: false, reason: "unknown-kingdom" };
  }
  const st = load();
  if (st.embassies.some((e) => e.home === h && e.host === t && e.status === "standing")) {
    return { ok: false, reason: "already-standing" };
  }
  if (typeof takeCoins !== "function" || takeCoins(EMBASSY_COST) !== true) {
    return { ok: false, reason: "cannot-afford" };
  }
  const embassy = {
    id: `emb-${nowMs}-${st.embassies.length}`,
    home: h,
    host: t,
    builder: builder ? String(builder) : null,
    builtAt: nowMs,
    status: "standing",
  };
  st.embassies.push(embassy);
  markDirty();
  return { ok: true, embassy };
}

/** The standing embassy for home-in-host, or null. */
function embassyFor(home, host) {
  const h = String(home ?? "").toLowerCase();
  const t = String(host ?? "").toLowerCase();
  return load().embassies.find((e) => e.home === h && e.host === t && e.status === "standing") ?? null;
}

/** Both directions standing? */
function embassyPair(a, b) {
  return !!embassyFor(a, b) && !!embassyFor(b, a);
}

/** Mark an embassy sacked (war). Never deletes — history stands. */
function sackEmbassy(id, reason = "war") {
  const st = load();
  const e = st.embassies.find((x) => x.id === id);
  if (!e || e.status !== "standing") return false;
  e.status = "sacked";
  e.sackedAt = Date.now();
  e.sackReason = reason;
  markDirty();
  return true;
}

// --- treaty proposals --------------------------------------------------------

/**
 * Propose a treaty. Peace needs no embassy; trade and alliance require a
 * standing embassy pair (embassies have real purpose). The broker needs
 * BROKER_FAME_REQUIRED fame, or isPlayer bypasses (players are their own
 * authority — the court judges the proposal, not the fame).
 */
function proposeTreaty({ from, to, type, broker, isPlayer = false, nowMs = Date.now() } = {}) {
  const f = String(from ?? "").toLowerCase();
  const t = String(to ?? "").toLowerCase();
  const ty = String(type ?? "").toLowerCase();
  if (!isKnownKingdom(f) || !isKnownKingdom(t) || f === t) return { ok: false, reason: "unknown-kingdom" };
  if (!TREATY_TYPES[ty]) return { ok: false, reason: "unknown-type" };
  if (!isPlayer && broker && fameOf(broker) < BROKER_FAME_REQUIRED) {
    return { ok: false, reason: "fame-too-low", required: BROKER_FAME_REQUIRED };
  }
  if ((ty === "trade" || ty === "alliance") && !embassyPair(f, t)) {
    return { ok: false, reason: "needs-embassies" };
  }
  const st = load();
  const existing = st.proposals.find(
    (p) => p.type === ty && pairKey(p.from, p.to) === pairKey(f, t) && p.status === "pending"
  );
  if (existing) return { ok: false, reason: "already-pending", id: existing.id };
  const active = st.treaties.find(
    (x) => x.type === ty && pairKey(x.a, x.b) === pairKey(f, t) && x.status === "active" && x.expiresAt > nowMs
  );
  if (active) return { ok: false, reason: "already-active", id: active.id };
  const proposal = {
    id: `prop-${nowMs}-${st.proposals.length}`,
    from: f,
    to: t,
    type: ty,
    broker: broker ? String(broker) : null,
    isPlayer: !!isPlayer,
    status: "pending",
    rounds: 0,
    proposedAt: nowMs,
    lastRoundAt: 0,
  };
  st.proposals.push(proposal);
  markDirty();
  return { ok: true, proposal };
}

function proposalById(id) {
  return load().proposals.find((p) => p.id === id) ?? null;
}

function pendingProposalsFor(kingdomId) {
  const k = String(kingdomId ?? "").toLowerCase();
  return load().proposals.filter((p) => p.status === "pending" && (p.from === k || p.to === k));
}

/** Accepted but not yet ratified — picked up by the next tick. */
function unratifiedProposalsFor(kingdomId) {
  const k = String(kingdomId ?? "").toLowerCase();
  return load().proposals.filter((p) => p.status === "accepted" && (p.from === k || p.to === k));
}

// Deterministic acceptance: calm borders + famous brokers succeed.
// Seeded on the proposal id so tests are stable and ticks are idempotent.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function acceptanceChance(proposal) {
  let chance = 0.45;
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    const tension = Tension.getTension?.(proposal.from, proposal.to) ?? 50;
    chance += (50 - Math.min(100, Math.max(0, tension))) / 200; // calm borders: up to +0.25
  } catch {
    // tension unreachable — base chance stands
  }
  if (proposal.broker) chance += Math.min(0.2, fameOf(proposal.broker) / 500);
  if (proposal.summitBonus) chance += SUMMIT_RATIFY_BONUS;
  return Math.min(0.9, Math.max(0.1, chance));
}

/**
 * Advance one court round for a pending proposal.
 * Returns "accepted" | "declined" | "countered" | "expired" | "waiting".
 */
function negotiateRound(id, nowMs = Date.now()) {
  const st = load();
  const p = st.proposals.find((x) => x.id === id);
  if (!p || p.status !== "pending") return "waiting";
  if (nowMs - p.proposedAt > PROPOSAL_EXPIRY_MS) {
    p.status = "expired";
    markDirty();
    return "expired";
  }
  if (p.lastRoundAt > 0 && nowMs - p.lastRoundAt < NEGOTIATION_ROUND_MS) return "waiting";
  p.rounds += 1;
  p.lastRoundAt = nowMs;
  const roll = (hashStr(p.id + ":" + p.rounds) % 1000) / 1000;
  const chance = acceptanceChance(p);
  let outcome;
  if (roll < chance) outcome = "accepted";
  else if (roll < chance + 0.2 && p.rounds < 3) outcome = "countered";
  else outcome = p.rounds >= 3 ? "declined" : "countered";
  if (outcome === "accepted" || outcome === "declined") {
    p.status = outcome === "accepted" ? "accepted" : "declined";
  }
  markDirty();
  return outcome;
}

// --- ratification: REAL effects through kingdom APIs -------------------------

/**
 * Ratify an accepted proposal. Applies real effects; never invents them.
 * emit(eventName, payload) is injected by the Life tick (wired to the
 * plugin api's emitCustomEvent) so alliance pacts persist in the kingdoms
 * layer. Returns the list of applied effects (for the journal).
 */
function ratifyTreaty(id, emit, nowMs = Date.now()) {
  const st = load();
  const p = st.proposals.find((x) => x.id === id);
  if (!p || p.status !== "accepted") return { ok: false, reason: "not-accepted" };
  const def = TREATY_TYPES[p.type];
  const effects = [];
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    if (typeof Tension.getTension === "function" && typeof Tension.setTension === "function") {
      const cur = Tension.getTension(p.from, p.to) ?? 0;
      Tension.setTension(p.from, p.to, Math.max(0, cur - def.tensionDrop));
      effects.push(`border tension cooled by ${def.tensionDrop}`);
    }
  } catch {
    // tension unreachable — the treaty stands on paper
  }
  if (p.type === "alliance" && typeof emit === "function") {
    // The REAL pact path: the kingdoms layer persists the pact, pins the
    // border calm, and pays the trade bonus on tax day. We never reimplement
    // pacts here — complement, not duplicate.
    const pactName = `the ${prettyKingdom(p.from)}-${prettyKingdom(p.to)} Accord`;
    try {
      emit("kingdom:alliance-formed", { a: p.from, b: p.to, pactName, broker: p.broker });
      effects.push("alliance pact formed (kingdoms layer)");
    } catch {
      effects.push("alliance declared (pact persistence unreachable)");
    }
  }
  const treaty = {
    id: `treaty-${nowMs}-${st.treaties.length}`,
    type: p.type,
    a: p.from,
    b: p.to,
    broker: p.broker,
    ratifiedAt: nowMs,
    expiresAt: nowMs + def.durationMs,
    status: "active",
  };
  st.treaties.push(treaty);
  p.status = "ratified";
  markDirty();
  if (p.broker && !p.isPlayer) {
    try {
      require("./CitizenReputation").awardDeed?.(p.broker, "treatybroker");
    } catch {
      // reputation unreachable
    }
  }
  return { ok: true, treaty, effects };
}

/** Active treaty between two kingdoms of a type, or null. */
function treatyBetween(a, b, type, nowMs = Date.now()) {
  const ty = String(type ?? "").toLowerCase();
  return (
    load().treaties.find(
      (x) => x.type === ty && pairKey(x.a, x.b) === pairKey(a, b) && x.status === "active" && x.expiresAt > nowMs
    ) ?? null
  );
}

function activeTreatiesFor(kingdomId, nowMs = Date.now()) {
  const k = String(kingdomId ?? "").toLowerCase();
  return load().treaties.filter(
    (x) => x.status === "active" && x.expiresAt > nowMs && (x.a === k || x.b === k)
  );
}

/** Expire old treaties. Returns the expired ids. */
function expireTreaties(nowMs = Date.now()) {
  const st = load();
  const expired = [];
  for (const t of st.treaties) {
    if (t.status === "active" && t.expiresAt <= nowMs) {
      t.status = "expired";
      expired.push(t.id);
    }
  }
  if (expired.length) markDirty();
  return expired;
}

/**
 * Caravan profit bonus between two kingdoms: 5% while a trade treaty is
 * active. Read defensively by the caravan layer. Alliance pacts pay their
 * own trade bonus through the kingdoms tax-day path — this seam is for
 * trade treaties only, so nothing double-counts.
 */
function tradeBonusFor(a, b, nowMs = Date.now()) {
  return treatyBetween(a, b, "trade", nowMs) ? TRADE_CARAVAN_BONUS : 0;
}

// --- summits -----------------------------------------------------------------

/**
 * Schedule a summit between two kingdoms. Requires a standing embassy pair.
 * The summit is held SUMMIT_DELAY_MS later by the Life tick.
 */
function scheduleSummit({ a, b, broker, isPlayer = false, nowMs = Date.now() } = {}) {
  const x = String(a ?? "").toLowerCase();
  const y = String(b ?? "").toLowerCase();
  if (!isKnownKingdom(x) || !isKnownKingdom(y) || x === y) return { ok: false, reason: "unknown-kingdom" };
  if (!embassyPair(x, y)) return { ok: false, reason: "needs-embassies" };
  const st = load();
  const pending = st.summits.find((s) => pairKey(s.a, s.b) === pairKey(x, y) && s.status === "scheduled");
  if (pending) return { ok: false, reason: "already-scheduled", id: pending.id };
  const summit = {
    id: `summit-${nowMs}-${st.summits.length}`,
    a: x,
    b: y,
    broker: broker ? String(broker) : null,
    isPlayer: !!isPlayer,
    status: "scheduled",
    scheduledAt: nowMs,
    heldAt: nowMs + SUMMIT_DELAY_MS,
  };
  st.summits.push(summit);
  markDirty();
  return { ok: true, summit };
}

/**
 * Hold a scheduled summit whose time has come. Real effects: border
 * cooling through the Tension API, and pending treaties between the pair
 * get a ratification bonus on their next court round. Returns effects.
 */
function holdSummit(id, nowMs = Date.now()) {
  const st = load();
  const s = st.summits.find((x) => x.id === id);
  if (!s || s.status !== "scheduled" || s.heldAt > nowMs) return { ok: false, reason: "not-due" };
  const effects = [];
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    if (typeof Tension.getTension === "function" && typeof Tension.setTension === "function") {
      const cur = Tension.getTension(s.a, s.b) ?? 0;
      Tension.setTension(s.a, s.b, Math.max(0, cur - SUMMIT_TENSION_DROP));
      effects.push(`border tension cooled by ${SUMMIT_TENSION_DROP}`);
    }
  } catch {
    // tension unreachable — the summit stands as ceremony
  }
  // Pending treaties between the pair get the summit bonus on their next round.
  for (const p of st.proposals) {
    if (p.status === "pending" && pairKey(p.from, p.to) === pairKey(s.a, s.b)) {
      p.summitBonus = true;
    }
  }
  s.status = "held";
  markDirty();
  if (s.broker && !s.isPlayer) {
    try {
      require("./CitizenReputation").awardDeed?.(s.broker, "treatybroker");
    } catch {
      // reputation unreachable
    }
  }
  return { ok: true, summit: s, effects };
}

function summitsDue(nowMs = Date.now()) {
  return load().summits.filter((s) => s.status === "scheduled" && s.heldAt <= nowMs);
}

// --- war check (defensive) ---------------------------------------------------

/** True if the war layer reports an active war between a and b. */
function atWar(a, b) {
  try {
    const Wars = require("../../kingdoms/Wars.Kingdoms");
    const Store = require("../../kingdoms/KingdomStore");
    const wars = Wars.getWars?.(String(a).toLowerCase(), Store) ?? [];
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    return wars.some(
      (w) =>
        (w.attackerId === x && w.defenderId === y) || (w.attackerId === y && w.defenderId === x)
    );
  } catch {
    return false; // war layer unreachable — embassies stand
  }
}

// --- description (chat) ------------------------------------------------------

function prettyKingdom(id) {
  const s = String(id ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describe(kingdomId, nowMs = Date.now()) {
  const k = String(kingdomId ?? "").toLowerCase();
  const st = load();
  return {
    kingdomId: k,
    treaties: activeTreatiesFor(k, nowMs).map((t) => ({
      type: t.type,
      partner: t.a === k ? t.b : t.a,
      partnerName: prettyKingdom(t.a === k ? t.b : t.a),
      expires: new Date(t.expiresAt).toISOString().slice(0, 10),
    })),
    embassies: st.embassies
      .filter((e) => e.status === "standing" && (e.home === k || e.host === k))
      .map((e) => ({ home: e.home, host: e.host })),
    pendingProposals: pendingProposalsFor(k).map((p) => ({ id: p.id, type: p.type, from: p.from, to: p.to })),
  };
}

module.exports = {
  kingdoms,
  TREATY_TYPES,
  TRADE_CARAVAN_BONUS,
  EMBASSY_COST,
  EMBASSY_TENSION_DECAY,
  BROKER_FAME_REQUIRED,
  buildEmbassy,
  embassyFor,
  embassyPair,
  sackEmbassy,
  proposeTreaty,
  proposalById,
  pendingProposalsFor,
  unratifiedProposalsFor,
  negotiateRound,
  ratifyTreaty,
  treatyBetween,
  activeTreatiesFor,
  expireTreaties,
  tradeBonusFor,
  scheduleSummit,
  holdSummit,
  summitsDue,
  atWar,
  describe,
  save,
  resetForTests,
  _setSavePathForTests,
};
