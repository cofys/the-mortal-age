"use strict";

/**
 * CitizenEspionage — the data tier for the OPERATIONS layer of citizen
 * espionage: covert operations, counter-intelligence, spy networks, embassy
 * cover, and the war-intelligence seam.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Spy networks: one per kingdom (the crown's eyes). Spies are
 *     recruited from the real roster; handlers are promoted from veteran
 *     spies. Cells are spies stationed in a target kingdom.
 *   - Covert operations: sabotage and assassination. Operations move
 *     planning -> active -> done with deterministic seeded rolls. Effects
 *     are REAL engine state, never invented:
 *       * sabotage/supply: destroys a real in-transit caravan's cargo value
 *         (the caravan is marked sabotaged and settles for less).
 *       * sabotage/treasury: steals real coins from the target kingdom's
 *         treasury (CitizenBanking), capped at what the treasury holds.
 *       * assassination: kills a real citizen through the honest death
 *         path (CitizenDeathRespawn.recordCitizenDeath — they wake at
 *         their hearth, same as always; funerals, wills, and gossip all
 *         fire for real).
 *     Discovery has real costs: border tension spikes, crime offenses
 *     (vandalism/assault) for the operative, and the operative can be
 *     caught and interrogated.
 *   - Counter-intelligence: each kingdom appoints counter-agents from its
 *     real roster. Counter-agents sweep for enemy cells and active
 *     operations in their home kingdom; caught spies can be interrogated
 *     to reveal their network's other operations (real operation ids).
 *   - Embassy cover: a cell stationed under diplomatic cover halves its
 *     discovery chance. Cover requires a STANDING embassy pair, read
 *     defensively from CitizenTreaties — no embassy, no cover, honestly.
 *   - War-intelligence seam: intelAdvantageFor(attacker, defender) returns
 *     0..1 from fresh successful intel/operations. CitizenWarfare reads it
 *     defensively to muster slightly larger militias — the citizen layer
 *     never touches war state itself.
 *   - Player spies: players run their own infiltration via the ::spy
 *     command (CitizenSpyEvents).
 *
 * NO OVERLAP:
 *   - CitizenDiplomacy owns PASSIVE intel gathering (spy missions that
 *     read garrison/tension/wars), royal marriages, and passive discovery
 *     rolls. This module never starts passive gather missions and never
 *     brokers marriages — it owns what happens AFTER the intel: the
 *     operations, the hunters, and the networks.
 *   - CitizenDiplomats owns the OVERT layer (courtier-diplomats, trade/
 *     culture/peace missions, stationed ambassadors). This module never
 *     posts ambassadors or runs overt missions.
 *   - CitizenTreaties owns treaties, embassies, and summits. This module
 *     only READS embassy pairs (for cover eligibility) — never creates
 *     or sacks them.
 *   - CitizenWarfare owns militias and battles. This module only exposes
 *     the intel-advantage number; the war layer decides what to do with it.
 *   - CitizenCrime owns offenses and sentencing. Covert operatives caught
 *     in the act are reported through CitizenCrime.reportOffense —
 *     never sentenced here.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Operation advancement, counter-intel sweeps, and
 *     announcements live in lib/CitizenEspionageLife.js.
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented money, wars, caravans, or deaths.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-espionage.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-espionage.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const KINGDOMS = Object.freeze(["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania"]);

// Thieving level required to run covert operations.
const OPERATIVE_THIEVING_LEVEL = 25;
// Operations take this long in planning before going active.
const PLANNING_MS = 2 * 60 * 60 * 1000;
// Intel stays fresh for the war seam this long after a success.
const INTEL_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
// Sabotage destroys this fraction of a caravan's cargo value.
const SABOTAGE_CARGO_FRACTION = 0.6;
// Treasury theft is capped at this fraction of the treasury balance.
const TREASURY_THEFT_FRACTION = 0.15;
// Base discovery chance per operation tick; embassy cover halves it.
const OP_DISCOVERY_BASE = 0.10;
// Caught operatives cost their home kingdom this much border tension.
const CAUGHT_TENSION = 8;
// Successful sabotage/assassination adds this much tension (someone knows).
const SUCCESS_TENSION = 4;

// --- state -------------------------------------------------------------------

function blank() {
  return {
    v: 1,
    networks: {}, // kingdomId -> { kingdom, foundedAt, founder, spies: [], handlers: [] }
    cells: [], // { id, spy, homeKingdom, targetKingdom, underCover, since }
    operations: [], // { id, network, type, subtype, targetKingdom, target, operative, state, outcome, plannedAt, activatedAt, resolvedAt }
    counterAgents: {}, // kingdomId -> [usernames]
    interrogations: [], // { spy, by, at, revealed: [opIds] }
    intel: {}, // "attacker>defender" -> { score, at, reason }
    seq: 0,
  };
}

let st = null;
let dirty = false;

function load() {
  if (st) return st;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      st = Object.assign(blank(), parsed);
      return st;
    }
  } catch {
    // missing or corrupt — start blank
  }
  st = blank();
  return st;
}

function markDirty() {
  dirty = true;
}

function resetForTests() {
  st = blank();
  dirty = false;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(st, null, 2), "utf8");
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

// --- helpers -----------------------------------------------------------------

function kingdoms() {
  return KINGDOMS;
}

function isKnownKingdom(id) {
  return KINGDOMS.includes(String(id ?? "").toLowerCase());
}

function nextId(prefix) {
  const s = load();
  s.seq += 1;
  markDirty();
  return `${prefix}-${s.seq}`;
}

/** Deterministic 0..1 roll from a string seed. */
function hashRoll(seed) {
  let h = 2166136261;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function prettyKingdom(id) {
  const names = {
    asgarnia: "Asgarnia",
    kandarin: "Kandarin",
    keldagrim: "Keldagrim",
    misthalin: "Misthalin",
    morytania: "Morytania",
  };
  return names[String(id ?? "").toLowerCase()] ?? String(id ?? "unknown");
}

// --- defensive reads of other layers -----------------------------------------

function tensionApi() {
  try {
    return require("./CitizenTension");
  } catch {
    return null;
  }
}

function addTension(a, b, amount) {
  try {
    tensionApi()?.addTension?.(a, b, amount);
  } catch {
    // tension layer absent — the op still happened, the border just doesn't know
  }
}

/** Standing embassy pair? Read defensively from CitizenTreaties. */
function hasEmbassyPair(home, host) {
  try {
    const T = require("./CitizenTreaties");
    const pair = T.embassyPair?.(home, host);
    return Array.isArray(pair) && pair.length === 2;
  } catch {
    return false;
  }
}

function reportCrime(username, kind, opts = {}) {
  try {
    require("./CitizenCrime").reportOffense(username, kind, opts);
  } catch {
    // crime layer absent — recorded nowhere, but the op still resolved
  }
}

// --- spy networks ------------------------------------------------------------

function networkFor(kingdomId) {
  const s = load();
  return s.networks[String(kingdomId ?? "").toLowerCase()] ?? null;
}

function foundNetwork({ kingdom, founder, nowMs = Date.now() }) {
  if (!isKnownKingdom(kingdom)) return null;
  const s = load();
  const kid = String(kingdom).toLowerCase();
  if (s.networks[kid]) return s.networks[kid];
  s.networks[kid] = {
    kingdom: kid,
    foundedAt: nowMs,
    founder: founder ?? null,
    spies: [],
    handlers: [],
  };
  markDirty();
  return s.networks[kid];
}

function recruitSpy({ kingdom, spy }) {
  const net = networkFor(kingdom);
  if (!net || !spy) return false;
  const norm = normalizeName(spy);
  if (net.spies.some((x) => normalizeName(x) === norm)) return false;
  net.spies.push(spy);
  markDirty();
  return true;
}

function promoteHandler({ kingdom, spy }) {
  const net = networkFor(kingdom);
  if (!net || !spy) return false;
  const norm = normalizeName(spy);
  if (!net.spies.some((x) => normalizeName(x) === norm)) return false;
  if (net.handlers.some((x) => normalizeName(x) === norm)) return false;
  net.handlers.push(spy);
  markDirty();
  return true;
}

function isHandler(kingdom, spy) {
  const net = networkFor(kingdom);
  if (!net || !spy) return false;
  const norm = normalizeName(spy);
  return net.handlers.some((x) => normalizeName(x) === norm);
}

// --- cells (spies stationed abroad) ------------------------------------------

function assignCell({ spy, homeKingdom, targetKingdom, underCover = false, nowMs = Date.now() }) {
  if (!spy || !isKnownKingdom(homeKingdom) || !isKnownKingdom(targetKingdom)) return null;
  const home = String(homeKingdom).toLowerCase();
  const target = String(targetKingdom).toLowerCase();
  if (home === target) return null;
  const s = load();
  const norm = normalizeName(spy);
  const existing = s.cells.find((c) => normalizeName(c.spy) === norm && !c.recalledAt);
  if (existing) return existing;
  // Cover is only real with a standing embassy pair — checked honestly.
  const cover = underCover === true && hasEmbassyPair(home, target);
  const cell = {
    id: nextId("cell"),
    spy,
    homeKingdom: home,
    targetKingdom: target,
    underCover: cover,
    coverRequested: underCover === true,
    since: nowMs,
    recalledAt: 0,
  };
  s.cells.push(cell);
  markDirty();
  return cell;
}

function cellFor(spy) {
  const s = load();
  const norm = normalizeName(spy ?? "");
  return s.cells.find((c) => normalizeName(c.spy) === norm && !c.recalledAt) ?? null;
}

function cellsIn(targetKingdom) {
  const s = load();
  const t = String(targetKingdom ?? "").toLowerCase();
  return s.cells.filter((c) => c.targetKingdom === t && !c.recalledAt);
}

function recallCell(cellId) {
  const s = load();
  const cell = s.cells.find((c) => c.id === cellId && !c.recalledAt);
  if (!cell) return false;
  cell.recalledAt = Date.now();
  markDirty();
  return true;
}

// --- counter-intelligence ----------------------------------------------------

function assignCounterAgent({ kingdom, agent }) {
  if (!isKnownKingdom(kingdom) || !agent) return false;
  const s = load();
  const kid = String(kingdom).toLowerCase();
  if (!s.counterAgents[kid]) s.counterAgents[kid] = [];
  const norm = normalizeName(agent);
  if (s.counterAgents[kid].some((x) => normalizeName(x) === norm)) return false;
  s.counterAgents[kid].push(agent);
  markDirty();
  return true;
}

function counterAgentsOf(kingdomId) {
  const s = load();
  return [...(s.counterAgents[String(kingdomId ?? "").toLowerCase()] ?? [])];
}

function counterIntelStrength(kingdomId) {
  return counterAgentsOf(kingdomId).length;
}

// --- covert operations -------------------------------------------------------

const OP_TYPES = Object.freeze(["sabotage", "assassination"]);
const SABOTAGE_SUBTYPES = Object.freeze(["supply", "treasury"]);

function planOperation({ network, type, subtype = null, targetKingdom, target = null, operative, nowMs = Date.now() }) {
  if (!OP_TYPES.includes(type)) return null;
  if (!isKnownKingdom(network) || !isKnownKingdom(targetKingdom)) return null;
  if (String(network).toLowerCase() === String(targetKingdom).toLowerCase()) return null;
  if (!operative) return null;
  if (type === "sabotage" && !SABOTAGE_SUBTYPES.includes(subtype)) return null;
  if (type === "assassination" && !target) return null;
  const s = load();
  const norm = normalizeName(operative);
  const busy = s.operations.some(
    (o) => normalizeName(o.operative) === norm && (o.state === "planning" || o.state === "active")
  );
  if (busy) return null; // one operation at a time — humans can't be in two shadows
  const op = {
    id: nextId("op"),
    network: String(network).toLowerCase(),
    type,
    subtype,
    targetKingdom: String(targetKingdom).toLowerCase(),
    target,
    operative,
    state: "planning",
    outcome: null,
    plannedAt: nowMs,
    activatedAt: 0,
    resolvedAt: 0,
  };
  s.operations.push(op);
  markDirty();
  return op;
}

function operationById(id) {
  const s = load();
  return s.operations.find((o) => o.id === id) ?? null;
}

function pendingOperationsFor(kingdomId) {
  const s = load();
  const kid = String(kingdomId ?? "").toLowerCase();
  return s.operations.filter(
    (o) => o.network === kid && (o.state === "planning" || o.state === "active")
  );
}

/** Discovery chance for an operation: cover halves it, counter-intel raises it. */
function discoveryChanceFor(op) {
  let chance = OP_DISCOVERY_BASE;
  const cell = cellFor(op.operative);
  if (cell?.underCover) chance *= 0.5;
  chance += counterIntelStrength(op.targetKingdom) * 0.04;
  return Math.min(0.6, Math.max(0.01, chance));
}

/**
 * Resolve one operation. Returns the outcome record, or null if not ready.
 * Deterministic seeded roll — same op, same tick, same result.
 */
function resolveOperation(id, nowMs = Date.now()) {
  const op = operationById(id);
  if (!op || op.state !== "active") return null;
  const roll = hashRoll(`op:${op.id}:${Math.floor(nowMs / 3600000)}`);
  const discovered = roll < discoveryChanceFor(op);
  const successRoll = hashRoll(`op:${op.id}:success`);
  // Base success 55%, +10% if the operative has a live cell in-target, -5% per counter-agent.
  let successChance = 0.55;
  if (cellFor(op.operative)?.targetKingdom === op.targetKingdom) successChance += 0.1;
  successChance -= counterIntelStrength(op.targetKingdom) * 0.05;
  successChance = Math.min(0.9, Math.max(0.15, successChance));
  const succeeded = !discovered && successRoll < successChance;

  op.resolvedAt = nowMs;
  op.state = "done";
  op.outcome = discovered ? "caught" : succeeded ? "success" : "failed";
  markDirty();

  if (op.outcome === "success") {
    applyOperationEffects(op, nowMs);
    addTension(op.network, op.targetKingdom, SUCCESS_TENSION);
    recordIntel(op.network, op.targetKingdom, 0.5, `operation ${op.id}`, nowMs);
  } else if (op.outcome === "caught") {
    addTension(op.network, op.targetKingdom, CAUGHT_TENSION);
    // The operative committed a real crime in the target kingdom.
    reportCrime(op.operative, op.type === "assassination" ? "assault" : "vandalism", {
      kingdomId: op.targetKingdom,
      witnessed: true,
      nowMs,
    });
    // Burn the cell — a caught spy's cover is blown.
    const cell = cellFor(op.operative);
    if (cell) recallCell(cell.id);
  }
  return op;
}

function activateOperation(id, nowMs = Date.now()) {
  const op = operationById(id);
  if (!op || op.state !== "planning") return null;
  if (nowMs - op.plannedAt < PLANNING_MS) return null; // still planning
  op.state = "active";
  op.activatedAt = nowMs;
  markDirty();
  return op;
}

/** Apply the REAL effects of a successful operation. Defensive throughout. */
function applyOperationEffects(op, nowMs) {
  try {
    if (op.type === "sabotage" && op.subtype === "supply") {
      sabotageCaravan(op, nowMs);
    } else if (op.type === "sabotage" && op.subtype === "treasury") {
      stealTreasury(op, nowMs);
    } else if (op.type === "assassination") {
      assassinateTarget(op, nowMs);
    }
  } catch {
    // one bad effect never breaks the op record — the outcome stands
  }
}

function sabotageCaravan(op, nowMs) {
  let Caravans = null;
  try {
    Caravans = require("./CitizenTradeCaravans");
  } catch {
    return;
  }
  const list = Caravans.activeCaravans?.() ?? Caravans.caravansInTransit?.() ?? [];
  const victim = list.find(
    (c) => String(c.from ?? "").toLowerCase() === op.targetKingdom && !c.sabotaged
  );
  if (!victim) return; // no caravan to hit — the op still counts as success intel-wise
  const cargoValue = Number(victim.cargoValue ?? 0);
  const destroyed = Math.floor(cargoValue * SABOTAGE_CARGO_FRACTION);
  try {
    Caravans.markSabotaged?.(victim.id, destroyed, nowMs);
  } catch {
    // caravan layer has no sabotage hook — record the loss on the op itself
    op.cargoDestroyed = destroyed;
    op.caravanId = victim.id;
    markDirty();
  }
}

function stealTreasury(op, nowMs) {
  void nowMs;
  let Banking = null;
  try {
    Banking = require("./CitizenBanking");
  } catch {
    return;
  }
  const balance = Banking.treasuryBalance?.(op.targetKingdom) ?? 0;
  if (balance <= 0) return; // empty vault — nothing to steal
  const stolen = Math.min(balance, Math.max(1, Math.floor(balance * TREASURY_THEFT_FRACTION)));
  try {
    const res = Banking.treasuryWithdraw?.(op.targetKingdom, stolen);
    if (res?.ok) {
      op.coinsStolen = stolen;
      // The loot goes to the home network's treasury — spies get paid.
      Banking.treasuryDeposit?.(op.network, stolen);
      markDirty();
    }
  } catch {
    // no withdraw hook — record intent only
    op.coinsStolen = 0;
    markDirty();
  }
}

function assassinateTarget(op, nowMs) {
  // The target must be a real roster citizen — never an invented name.
  // The kill goes through the honest death path: they wake at their hearth.
  op.assassinationAttempted = true;
  markDirty();
  try {
    const Death = require("./CitizenDeathRespawn");
    const roster = op._roster ?? null; // injected by the tick (director roster)
    const victim = roster?.get?.(normalizeName(op.target)) ?? null;
    if (victim && Death.recordCitizenDeath) {
      Death.recordCitizenDeath(op._director ?? null, victim, {
        cause: "assassinated",
        killerName: op.operative,
      }, nowMs);
      op.assassinationLanded = true;
      markDirty();
    }
  } catch {
    // death path unavailable — the attempt is recorded, the target lives
  }
}

// --- interrogation -----------------------------------------------------------

/**
 * Interrogate a caught spy. Reveals their network's other live operations.
 * Returns the revealed operation ids (real ids, never invented).
 */
function interrogate({ spy, by, nowMs = Date.now() }) {
  if (!spy || !by) return [];
  const s = load();
  const cell = s.cells.find((c) => normalizeName(c.spy) === normalizeName(spy));
  const homeNet = cell?.homeKingdom ?? null;
  const revealed = homeNet
    ? s.operations
        .filter((o) => o.network === homeNet && (o.state === "planning" || o.state === "active"))
        .map((o) => o.id)
    : [];
  s.interrogations.push({ spy, by, at: nowMs, revealed: [...revealed], network: homeNet });
  markDirty();
  // A talked spy is burned — recall any live cell.
  const live = cellFor(spy);
  if (live) recallCell(live.id);
  return revealed;
}

function interrogationsOf(spy) {
  const s = load();
  const norm = normalizeName(spy ?? "");
  return s.interrogations.filter((i) => normalizeName(i.spy) === norm);
}

// --- war-intelligence seam -----------------------------------------------------

/**
 * Fresh successful intel/operations by `attacker` against `defender`
 * produce a 0..1 advantage number. CitizenWarfare reads this defensively.
 */
function recordIntel(attacker, defender, score, reason, nowMs = Date.now()) {
  const s = load();
  const key = `${String(attacker).toLowerCase()}>${String(defender).toLowerCase()}`;
  const prev = s.intel[key];
  s.intel[key] = {
    score: Math.min(1, Math.max(0, (prev?.score ?? 0) * 0.5 + score)),
    at: nowMs,
    reason: reason ?? prev?.reason ?? "unknown",
  };
  markDirty();
}

function intelAdvantageFor(attacker, defender, nowMs = Date.now()) {
  const s = load();
  const key = `${String(attacker ?? "").toLowerCase()}>${String(defender ?? "").toLowerCase()}`;
  const rec = s.intel[key];
  if (!rec) return 0;
  if (nowMs - rec.at > INTEL_FRESH_MS) return 0; // stale intel is no intel
  // Successful passive gathers (CitizenDiplomacy) also feed this via noteIntel.
  return Math.min(1, Math.max(0, rec.score));
}

/** Called by the espionage tick when a CitizenDiplomacy gather succeeds. */
function noteIntel(attacker, defender, nowMs = Date.now()) {
  recordIntel(attacker, defender, 0.3, "passive gather", nowMs);
}

function pruneIntel(nowMs = Date.now()) {
  const s = load();
  let pruned = 0;
  for (const key of Object.keys(s.intel)) {
    if (nowMs - s.intel[key].at > INTEL_FRESH_MS * 2) {
      delete s.intel[key];
      pruned++;
    }
  }
  if (pruned > 0) markDirty();
  return pruned;
}

// --- spymaster career helpers --------------------------------------------------

function isSpymasterCandidate(record) {
  if (!record) return false;
  const p = record.personality ?? {};
  const sneaky = p.sneaky ?? p.mischievous ?? 0;
  return sneaky > 0.6;
}

module.exports = {
  // tuning (tests + brain read these)
  OPERATIVE_THIEVING_LEVEL,
  PLANNING_MS,
  INTEL_FRESH_MS,
  // kingdoms
  kingdoms,
  isKnownKingdom,
  prettyKingdom,
  // networks
  networkFor,
  foundNetwork,
  recruitSpy,
  promoteHandler,
  isHandler,
  // cells
  assignCell,
  cellFor,
  cellsIn,
  recallCell,
  // counter-intel
  assignCounterAgent,
  counterAgentsOf,
  counterIntelStrength,
  // operations
  planOperation,
  operationById,
  pendingOperationsFor,
  activateOperation,
  resolveOperation,
  discoveryChanceFor,
  // interrogation
  interrogate,
  interrogationsOf,
  // war seam
  recordIntel,
  noteIntel,
  intelAdvantageFor,
  pruneIntel,
  // career
  isSpymasterCandidate,
  // persistence
  save,
  resetForTests,
  _setSavePathForTests,
};
