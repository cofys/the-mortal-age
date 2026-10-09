"use strict";

/**
 * CitizenSpyGuilds — the spymasters' association (espionage guild) operations layer.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenEspionage owns: spy networks, cells, covert operations,
 *     counter-intelligence, interrogations, and the war-intel seam. Its
 *     records are READ-ONLY here (join gating reads networks/cells/
 *     counter-agents; the mole tribunal reads foreign cells; interrogation
 *     bounties call the REAL interrogate API) — nothing is ever planned,
 *     activated, or resolved by this module.
 *   - CitizenSpyMaster (brain) owns: planning operations, counter-agent
 *     patrols. Never touched here.
 *   - CitizenEspionageLife owns: op activation/resolution, counter-intel
 *     sweeps, cell upkeep, announcements. Never touched here.
 *   - CitizenDiplomaticCorps owns: the diplomatic corps and its treason
 *     tribunal (which reads THIS layer's cells as treason evidence).
 *     This module never reads the corps.
 *   - CitizenDiplomacy owns: passive intel gathering. Never touched here.
 *   - CitizenCrime owns: offenses and sentencing. Never touched here.
 *   - THIS module owns: the profession's GUILD layer — per-kingdom shadow
 *     associations, membership ranks with real-coin dues, the tradecraft
 *     code, dead drops (real sealed member-to-member messages), safe-house
 *     sanctuary (dues-exempt hiding), the tradecraft school (training
 *     under spymaster-rank masters), interrogation bounties (real coins
 *     for guild-led interrogations through the real API), and the mole
 *     tribunal (verifiable double agents only).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Shadow associations: one per kingdom with a hall tile in a discreet
 *     back-alley offset from the market anchor, a real tracked treasury,
 *     and a real tracked tradecraft fund.
 *   - Membership: operative -> agent -> spymaster ranks. Joining requires
 *     being a REAL spy — the spymaster career (CitizenCareers), a real
 *     network spy/handler (CitizenEspionage), a live cell operative for
 *     the kingdom's network, or an appointed counter-agent. The guild
 *     polices the trade, it does not mint spies. Weekly real-coin dues
 *     (25, of which 5 feeds the tradecraft fund); 2 missed online
 *     collections suspend; offline members skipped, never penalized.
 *   - Tradecraft code: the guild's code (read-only — discretion, loyalty,
 *     cover integrity, restraint, dead-drop discipline).
 *   - Dead drops: sealed member-to-member messages. Both endpoints must
 *     be members in good standing; text is capped; drops expire after 7
 *     days; only the named recipient can read them. Pickup marks read.
 *     Nothing is ever invented — a drop exists only if a real member
 *     left it for a real member.
 *   - Safe-house sanctuary: a burned or hunted member may lay low — 100
 *     real coins buys 7 days of dues-exempt hiding at the guild's safe
 *     house. The guild does not report sanctuary members anywhere.
 *   - Interrogation bounties: a spymaster-rank member who interrogates a
 *     caught enemy spy through the REAL CitizenEspionage.interrogate API
 *     earns a 100-coin bounty from the tradecraft fund into their REAL
 *     bank account (owed honestly when the fund runs dry, retried on the
 *     life tick). The revealed operation ids are logged to the guild's
 *     intelligence file — real ids, never invented.
 *   - Tradecraft school: spymaster-rank masters hold tradecraft classes
 *     for operatives; attendance grants training credit. Promotion:
 *     operative -> agent at 30 days tenure + 2 training credits + handler
 *     status in the real network (the operations layer already vetted
 *     them as veteran) + clean record; agent -> spymaster at 60 days +
 *     4 credits + 2 guild interrogations led + clean record. All
 *     verifiable from real records — never invented.
 *   - Mole tribunal: violations are REPORTED and VERIFIED against real
 *     data, never assumed. The one verifiable guild crime: a double
 *     agent — a guild member running a LIVE foreign cell against their
 *     own kingdom (CitizenEspionage.cellsIn). Spymaster-rank members vote;
 *     cases settle after 24h. Guilty: expulsion + the `doubleagent` fame
 *     deed.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here (lib/CitizenSpyGuildLife.js is ticked by the director).
 *   - No LLM. No movement (brain/actions/CitizenShadowGuild.js).
 *   - No invented coins, spies, cells, operations, or interrogations.
 *   - Never touches lib/*2 (frozen).
 */

const path = require("path");

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-spyguilds.json";
const COINS_ID = 995;

const RANK_OPERATIVE = "operative";
const RANK_AGENT = "agent";
const RANK_SPYMASTER = "spymaster";
const RANKS = Object.freeze([RANK_OPERATIVE, RANK_AGENT, RANK_SPYMASTER]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_TRADECRAFT_SHARE = 5; // of each dues payment, this much feeds the tradecraft fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2; // missed online collections before suspension

const DROP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // dead drops expire after 7 days
const DROP_TEXT_MAX = 280; // sealed messages are short — tradecraft

const SANCTUARY_COST = 100; // real coins for 7 days of hiding
const SANCTUARY_MS = 7 * 24 * 60 * 60 * 1000;

const INTERROGATION_BOUNTY = 100; // real coins per guild-led interrogation

const PROMOTE_AGENT_DAYS = 30;
const PROMOTE_AGENT_TRAINING = 2;
const PROMOTE_SPYMASTER_DAYS = 60;
const PROMOTE_SPYMASTER_TRAINING = 4;
const PROMOTE_SPYMASTER_INTERROGATIONS = 2;

const CASE_SETTLE_MS = 24 * 60 * 60 * 1000; // auto-settle open cases after 24h

const HALL_TILE_DX = -7; // shadow halls sit in back alleys, away from the market crowds
const HALL_TILE_DY = 3;

// --- state --------------------------------------------------------------------

let cache = null;
// {
//   guilds: { kingdomId: {
//     hallTile: {x,y,z} | null, foundedAtMs,
//     treasury: number, tradecraftFund: number,
//     members: { normName: { displayName, rank, joinedAtMs, duesPaidUntilMs,
//       missedDues, suspended, trainingCredits, interrogationsLed,
//       cleanRecord, sanctuaryUntilMs } },
//     drops: { dropId: { from, to, text, leftAtMs, expiresAtMs, readAtMs } },
//     cases: { caseId: { accused, kind, reporter, filedAtMs,
//       status, votes: { voter: "guilty"|"not" }, verdict } },
//     intel: [ { atMs, by, spy, revealed: [opIds] } ],
//   } },
// }

function _saveFile() {
  try {
    const { savePath } = require("./CitizenSaves");
    return savePath(SAVE_KEY);
  } catch {
    return path.join(__dirname, "..", "data", "saves", SAVE_KEY);
  }
}

function _setSavePathForTests(p) {
  _testSavePath = p;
}
let _testSavePath = null;

function state() {
  if (!cache) {
    cache = { guilds: Object.create(null) };
    try {
      const fs = require("fs");
      const p = _testSavePath || _saveFile();
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        if (raw && typeof raw === "object") cache = raw;
        if (!cache.guilds) cache.guilds = Object.create(null);
      }
    } catch { /* start fresh */ }
  }
  return cache;
}

let _dirty = false;
function markDirty() { _dirty = true; }
function save() {
  if (!_dirty) return false;
  try {
    const fs = require("fs");
    const p = _testSavePath || _saveFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 1));
    _dirty = false;
    return true;
  } catch { return false; }
}
function resetForTests() {
  cache = null;
  _dirty = false;
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

// --- guild existence ------------------------------------------------------------

function guildOf(kingdomId) {
  if (!kingdomId) return null;
  return state().guilds[kingdomId] || null;
}

function hallTileFor(kingdomId) {
  const kid = String(kingdomId || "");
  let tile = null;
  try {
    const S = require("../brain/CitizenSites");
    tile = S && typeof S.siteTile === "function" ? S.siteTile({ kingdomId: kid }, "market") : null;
  } catch { tile = null; }
  if (!tile || typeof tile.x !== "number") return { x: 3200, y: 3200, z: 0 };
  return { x: (tile.x ?? 3200) + HALL_TILE_DX, y: (tile.y ?? 3200) + HALL_TILE_DY, z: tile.z ?? 0 };
}

function ensureGuild(kingdomId) {
  if (!kingdomId) return null;
  const s = state();
  if (!s.guilds[kingdomId]) {
    s.guilds[kingdomId] = {
      kingdomId,
      hallTile: hallTileFor(kingdomId),
      foundedAtMs: Date.now(),
      treasury: 0,
      tradecraftFund: 0,
      members: Object.create(null),
      drops: Object.create(null),
      cases: Object.create(null),
      intel: [],
    };
    markDirty();
  }
  return s.guilds[kingdomId];
}

// --- membership -----------------------------------------------------------------

/**
 * A real spy, by one of four verifiable paths. The guild polices the
 * trade — it never mints spies.
 */
function isRealSpy(kingdomId, username) {
  const name = norm(username);
  if (!kingdomId || !name) return false;
  const kid = String(kingdomId);
  // Path 1: the citizen's career is spymaster.
  try {
    const Careers = require("./CitizenCareers");
    const rec = Careers.careerOf ? Careers.careerOf(username) : null;
    const key = rec && (rec.key || rec.career || rec.name);
    if (key && String(key).toLowerCase() === "spymaster") return true;
  } catch { /* no careers */ }
  // Paths 2-4: the real espionage layer.
  try {
    const Esp = require("./CitizenEspionage");
    const net = Esp.networkFor ? Esp.networkFor(kid) : null;
    if (net) {
      const inSpies = (net.spies || []).some((x) => norm(x) === name);
      const inHandlers = (net.handlers || []).some((x) => norm(x) === name);
      if (inSpies || inHandlers) return true;
    }
    const cell = Esp.cellFor ? Esp.cellFor(username) : null;
    if (cell && String(cell.homeKingdom || "").toLowerCase() === kid.toLowerCase()) return true;
    const counters = Esp.counterAgentsOf ? Esp.counterAgentsOf(kid) : [];
    if (counters.some((x) => norm(x) === name)) return true;
  } catch { /* no espionage */ }
  return false;
}

function isGuildMember(username) {
  const name = norm(username);
  if (!name) return false;
  const s = state();
  for (const kid of Object.keys(s.guilds)) {
    if (s.guilds[kid].members[name]) return true;
  }
  return false;
}

function memberOf(username) {
  const name = norm(username);
  if (!name) return null;
  const s = state();
  for (const kid of Object.keys(s.guilds)) {
    const m = s.guilds[kid].members[name];
    if (m) return { kingdomId: kid, ...m };
  }
  return null;
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function inSanctuary(username, nowMs = Date.now()) {
  const m = memberOf(username);
  return !!(m && m.sanctuaryUntilMs && nowMs < m.sanctuaryUntilMs);
}

function joinGuild(kingdomId, username) {
  const name = norm(username);
  if (!kingdomId || !name) return { ok: false, reason: "bad-request" };
  if (!isRealSpy(kingdomId, username)) return { ok: false, reason: "not-a-spy" };
  if (memberOf(username)) return { ok: false, reason: "already-member" };
  const g = ensureGuild(kingdomId);
  const now = Date.now();
  g.members[name] = {
    displayName: username,
    rank: RANK_OPERATIVE,
    joinedAtMs: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS,
    missedDues: 0,
    suspended: false,
    trainingCredits: 0,
    interrogationsLed: 0,
    cleanRecord: true,
    sanctuaryUntilMs: 0,
  };
  markDirty();
  return { ok: true, rank: RANK_OPERATIVE };
}

function leaveGuild(username) {
  const name = norm(username);
  if (!name) return false;
  const s = state();
  for (const kid of Object.keys(s.guilds)) {
    if (s.guilds[kid].members[name]) {
      delete s.guilds[kid].members[name];
      markDirty();
      return true;
    }
  }
  return false;
}

function recordDuesPayment(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return false;
  const g = guildOf(m.kingdomId);
  if (!g) return false;
  const rec = g.members[norm(username)];
  rec.duesPaidUntilMs = nowMs + DUES_PERIOD_MS;
  rec.missedDues = 0;
  rec.suspended = false;
  g.treasury += DUES_WEEKLY - DUES_TRADECRAFT_SHARE;
  g.tradecraftFund += DUES_TRADECRAFT_SHARE;
  markDirty();
  return true;
}

function recordMissedDues(username) {
  const m = memberOf(username);
  if (!m) return;
  const g = guildOf(m.kingdomId);
  if (!g) return;
  const rec = g.members[norm(username)];
  rec.missedDues = (rec.missedDues || 0) + 1;
  if (rec.missedDues >= SUSPEND_AFTER_MISSED) rec.suspended = true;
  markDirty();
}

// --- tradecraft code (read-only) ---------------------------------------------------

const TRADECRAFT_CODE = Object.freeze([
  "Discretion above all: a shadow that speaks is a shadow that dies.",
  "Loyalty to the crown that feeds you — one master, one coin.",
  "Cover integrity: never burn a cell for a lesser prize.",
  "No unnecessary blood: the knife is the last argument, not the first.",
  "Dead-drop discipline: seal it, mark it, walk away.",
]);

function tradecraftCode() {
  return TRADECRAFT_CODE.slice();
}

// --- dead drops -------------------------------------------------------------------

/**
 * Leave a sealed message for a fellow member. Both endpoints must be
 * members in good standing — the guild moves real messages between real
 * spies, nothing is ever invented or addressed to outsiders.
 */
function leaveDrop(kingdomId, from, to, text, nowMs = Date.now()) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const fn = norm(from), tn = norm(to);
  if (!fn || !tn) return { ok: false, reason: "bad-request" };
  if (fn === tn) return { ok: false, reason: "no-self-drops" };
  const fm = g.members[fn], tm = g.members[tn];
  if (!fm || fm.suspended) return { ok: false, reason: "sender-not-standing" };
  if (!tm || tm.suspended) return { ok: false, reason: "recipient-not-standing" };
  const clean = String(text ?? "").slice(0, DROP_TEXT_MAX).trim();
  if (!clean) return { ok: false, reason: "empty-message" };
  const dropId = `d-${nowMs.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  g.drops[dropId] = {
    from: fm.displayName, to: tm.displayName,
    text: clean, leftAtMs: nowMs, expiresAtMs: nowMs + DROP_TTL_MS, readAtMs: 0,
  };
  markDirty();
  return { ok: true, dropId };
}

/** Read this member's sealed drops. Reading marks them read. */
function pickupDrops(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return { ok: false, reason: "not-a-member", drops: [] };
  const g = guildOf(m.kingdomId);
  if (!g) return { ok: false, reason: "no-guild", drops: [] };
  const name = norm(username);
  const out = [];
  for (const [id, d] of Object.entries(g.drops)) {
    if (norm(d.to) !== name) continue;
    if (nowMs >= d.expiresAtMs) continue; // expired — gone, not readable
    out.push({ id, from: d.from, text: d.text, leftAtMs: d.leftAtMs });
    if (!d.readAtMs) d.readAtMs = nowMs;
  }
  if (out.length) markDirty();
  return { ok: true, drops: out };
}

function unreadDropCount(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return 0;
  const g = guildOf(m.kingdomId);
  if (!g) return 0;
  const name = norm(username);
  let n = 0;
  for (const d of Object.values(g.drops)) {
    if (norm(d.to) === name && !d.readAtMs && nowMs < d.expiresAtMs) n++;
  }
  return n;
}

function pruneDrops(kingdomId, nowMs = Date.now()) {
  const g = guildOf(kingdomId);
  if (!g) return 0;
  let pruned = 0;
  for (const id of Object.keys(g.drops)) {
    if (nowMs >= g.drops[id].expiresAtMs) { delete g.drops[id]; pruned++; }
  }
  if (pruned) markDirty();
  return pruned;
}

// --- safe-house sanctuary ------------------------------------------------------------

/**
 * Lay low at the guild's safe house: SANCTUARY_COST real coins buys
 * SANCTUARY_MS of dues-exempt hiding. The guild asks no questions and
 * reports sanctuary members nowhere.
 */
function layLow(kingdomId, username, nowMs = Date.now()) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const rec = g.members[norm(username)];
  if (!rec || rec.suspended) return { ok: false, reason: "not-standing" };
  if (rec.sanctuaryUntilMs && nowMs < rec.sanctuaryUntilMs) {
    return { ok: false, reason: "already-hidden" };
  }
  // The Events command already took the real coins; this records the stay.
  rec.sanctuaryUntilMs = nowMs + SANCTUARY_MS;
  markDirty();
  return { ok: true, untilMs: rec.sanctuaryUntilMs };
}

function expireSanctuaries(kingdomId, nowMs = Date.now()) {
  const g = guildOf(kingdomId);
  if (!g) return 0;
  let expired = 0;
  for (const rec of Object.values(g.members)) {
    if (rec.sanctuaryUntilMs && nowMs >= rec.sanctuaryUntilMs) {
      rec.sanctuaryUntilMs = 0;
      expired++;
    }
  }
  if (expired) markDirty();
  return expired;
}

function contributeTradecraft(kingdomId, amount) {
  // The Events command already took the real coins from the player's
  // inventory; this records the contribution honestly in the guild's fund.
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const taken = Math.floor(Number(amount) || 0);
  if (taken <= 0) return { ok: false, reason: "bad-request" };
  g.tradecraftFund += taken;
  markDirty();
  return { ok: true, contributed: taken };
}

// --- interrogation bounties ----------------------------------------------------------------

/**
 * A spymaster-rank member interrogates a caught enemy spy through the REAL
 * CitizenEspionage.interrogate API. The guild pays the standard bounty
 * from its tradecraft fund into the interrogator's REAL bank account —
 * owed honestly when the fund runs dry, retried on the life tick. The
 * revealed operation ids are logged to the guild's intelligence file:
 * real ids, never invented.
 */
function bountyInterrogation(kingdomId, interrogator, spy, nowMs = Date.now()) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  if (guildRankOf(interrogator) !== RANK_SPYMASTER) return { ok: false, reason: "spymasters-only" };
  const mem = memberOf(interrogator);
  if (!mem || mem.suspended) return { ok: false, reason: "not-standing" };
  if (!spy || norm(spy) === norm(interrogator)) return { ok: false, reason: "bad-target" };
  let revealed = [];
  try {
    const Esp = require("./CitizenEspionage");
    if (typeof Esp.interrogate !== "function") return { ok: false, reason: "no-interrogate" };
    revealed = Esp.interrogate({ spy, by: interrogator, nowMs }) || [];
  } catch {
    return { ok: false, reason: "interrogate-failed" };
  }
  g.intel.push({ atMs: nowMs, by: interrogator, spy, revealed: [...revealed] });
  if (g.intel.length > 200) g.intel = g.intel.slice(-200);
  const rec = g.members[norm(interrogator)];
  if (rec) rec.interrogationsLed = (rec.interrogationsLed || 0) + 1;
  // Pay the bounty from the tradecraft fund.
  let paid = 0, owed = INTERROGATION_BOUNTY;
  if (g.tradecraftFund >= INTERROGATION_BOUNTY) {
    g.tradecraftFund -= INTERROGATION_BOUNTY;
    paid = INTERROGATION_BOUNTY; owed = 0;
  } else if (g.tradecraftFund > 0) {
    paid = g.tradecraftFund; owed = INTERROGATION_BOUNTY - paid; g.tradecraftFund = 0;
  }
  if (paid > 0) {
    try {
      const Banking = require("./CitizenBanking");
      if (typeof Banking.creditAccount === "function") Banking.creditAccount(interrogator, paid);
      else { paid = 0; owed = INTERROGATION_BOUNTY; }
    } catch { paid = 0; owed = INTERROGATION_BOUNTY; }
  }
  const entry = { interrogator, spy, paid, owed, atMs: nowMs, revealed: revealed.length };
  g.intel[g.intel.length - 1].bounty = entry;
  markDirty();
  return { ok: true, paid, owed, revealed };
}

/** Retry owed interrogation bounties as the tradecraft fund refills. */
function retryOwedBounties(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return 0;
  let paid = 0;
  for (const entry of g.intel) {
    const b = entry.bounty;
    if (!b || !b.owed) continue;
    if (g.tradecraftFund <= 0) break;
    const amt = Math.min(b.owed, g.tradecraftFund);
    g.tradecraftFund -= amt;
    b.owed -= amt;
    try {
      const Banking = require("./CitizenBanking");
      if (typeof Banking.creditAccount === "function") Banking.creditAccount(b.interrogator, amt);
      else { g.tradecraftFund += amt; b.owed += amt; break; }
    } catch { g.tradecraftFund += amt; b.owed += amt; break; }
    paid += amt;
  }
  if (paid > 0) markDirty();
  return paid;
}

// --- mole tribunal ----------------------------------------------------------------------------

/**
 * The one verifiable guild crime: a double agent — a guild member running
 * a LIVE foreign cell against their own kingdom. Verified against the
 * real espionage layer, never assumed.
 */
function scanMole(kingdomId, username) {
  const name = norm(username);
  if (!kingdomId || !name) return null;
  const kid = String(kingdomId).toLowerCase();
  try {
    const Esp = require("./CitizenEspionage");
    const cells = Esp.cellsIn ? Esp.cellsIn(kingdomId) : [];
    for (const cell of cells) {
      if (norm(cell.spy) === name && String(cell.homeKingdom || "").toLowerCase() !== kid) {
        return "mole";
      }
    }
  } catch { /* no espionage */ }
  return null;
}

function reportMisconduct(kingdomId, accused, kind, reporter) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  if (kind !== "mole") return { ok: false, reason: "bad-kind" };
  if (!scanMole(kingdomId, accused)) return { ok: false, reason: "unverifiable" };
  // No double jeopardy: one open case per accused+kind.
  for (const cid of Object.keys(g.cases)) {
    const c = g.cases[cid];
    if (c.status === "open" && norm(c.accused) === norm(accused) && c.kind === kind) {
      return { ok: false, reason: "already-open" };
    }
  }
  const caseId = `m-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  g.cases[caseId] = {
    accused, kind, reporter: reporter || "guild",
    filedAtMs: Date.now(), status: "open", votes: Object.create(null), verdict: null,
  };
  markDirty();
  return { ok: true, caseId };
}

function voteOnCase(kingdomId, caseId, voter, guilty) {
  const g = guildOf(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const c = g.cases[caseId];
  if (!c || c.status !== "open") return { ok: false, reason: "no-such-case" };
  if (guildRankOf(voter) !== RANK_SPYMASTER) return { ok: false, reason: "spymasters-only" };
  c.votes[norm(voter)] = guilty ? "guilty" : "not";
  markDirty();
  return { ok: true };
}

function settleCase(kingdomId, caseId) {
  const g = guildOf(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const c = g.cases[caseId];
  if (!c || c.status !== "open") return { ok: false, reason: "no-such-case" };
  const votes = Object.values(c.votes);
  const guilty = votes.filter((v) => v === "guilty").length;
  const notGuilty = votes.filter((v) => v === "not").length;
  const verdict = guilty > notGuilty ? "guilty" : "acquitted";
  c.status = "decided";
  c.verdict = verdict;
  if (verdict === "guilty") {
    // A double agent is burned out of the guild — and marked for the realm.
    delete g.members[norm(c.accused)];
    try {
      const Rep = require("./CitizenReputation");
      if (typeof Rep.awardDeed === "function") Rep.awardDeed(c.accused, "doubleagent");
    } catch { /* reputation unavailable */ }
  } else {
    const rec = g.members[norm(c.accused)];
    if (rec) rec.cleanRecord = true;
  }
  markDirty();
  return { ok: true, verdict };
}

function settleRipeCases(kingdomId, nowMs) {
  const g = guildOf(kingdomId);
  if (!g) return 0;
  let settled = 0;
  for (const cid of Object.keys(g.cases)) {
    const c = g.cases[cid];
    if (c.status === "open" && nowMs - c.filedAtMs >= CASE_SETTLE_MS) {
      settleCase(kingdomId, cid);
      settled++;
    }
  }
  return settled;
}

// --- tradecraft school ---------------------------------------------------------------------------

function holdClass(kingdomId, masterName) {
  const g = guildOf(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  if (guildRankOf(masterName) !== RANK_SPYMASTER) return { ok: false, reason: "spymasters-only" };
  let taught = 0;
  for (const n of Object.keys(g.members)) {
    const rec = g.members[n];
    if (rec.rank === RANK_OPERATIVE && !rec.suspended) {
      rec.trainingCredits = (rec.trainingCredits || 0) + 1;
      taught++;
    }
  }
  markDirty();
  return { ok: true, taught };
}

function tryPromote(username) {
  const m = memberOf(username);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  const g = guildOf(m.kingdomId);
  const rec = g.members[norm(username)];
  const tenureDays = (Date.now() - rec.joinedAtMs) / (24 * 60 * 60 * 1000);
  if (rec.rank === RANK_OPERATIVE) {
    // Handler status in the real network is the operations layer's own
    // veteran vetting — verifiable, never self-claimed.
    let veteran = false;
    try {
      const Esp = require("./CitizenEspionage");
      veteran = !!(Esp.isHandler && Esp.isHandler(m.kingdomId, username));
    } catch { /* no espionage */ }
    if (tenureDays >= PROMOTE_AGENT_DAYS &&
        (rec.trainingCredits || 0) >= PROMOTE_AGENT_TRAINING &&
        veteran && rec.cleanRecord) {
      rec.rank = RANK_AGENT;
      markDirty();
      return { ok: true, rank: RANK_AGENT };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  if (rec.rank === RANK_AGENT) {
    if (tenureDays >= PROMOTE_SPYMASTER_DAYS &&
        (rec.trainingCredits || 0) >= PROMOTE_SPYMASTER_TRAINING &&
        (rec.interrogationsLed || 0) >= PROMOTE_SPYMASTER_INTERROGATIONS &&
        rec.cleanRecord) {
      rec.rank = RANK_SPYMASTER;
      markDirty();
      try {
        const Rep = require("./CitizenReputation");
        if (typeof Rep.awardDeed === "function") Rep.awardDeed(username, "shadowmaster");
      } catch { /* reputation unavailable */ }
      return { ok: true, rank: RANK_SPYMASTER };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  return { ok: false, reason: "max-rank" };
}

// --- describe ---------------------------------------------------------------------------------

function describe(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return null;
  let spymasters = 0, agents = 0, operatives = 0, hidden = 0;
  const now = Date.now();
  for (const rec of Object.values(g.members)) {
    if (rec.suspended) continue;
    if (rec.rank === RANK_SPYMASTER) spymasters++;
    else if (rec.rank === RANK_AGENT) agents++;
    else operatives++;
    if (rec.sanctuaryUntilMs && now < rec.sanctuaryUntilMs) hidden++;
  }
  const openCases = Object.values(g.cases).filter((c) => c.status === "open").length;
  let unreadDrops = 0;
  for (const d of Object.values(g.drops)) {
    if (!d.readAtMs && now < d.expiresAtMs) unreadDrops++;
  }
  return {
    members: spymasters + agents + operatives,
    spymasters, agents, operatives, hidden,
    treasury: g.treasury,
    tradecraftFund: g.tradecraftFund,
    unreadDrops, openCases,
    intelReports: g.intel.length,
  };
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  markDirty,
  COINS_ID,
  RANK_OPERATIVE, RANK_AGENT, RANK_SPYMASTER, RANKS,
  DUES_WEEKLY, DUES_TRADECRAFT_SHARE, SANCTUARY_COST, SANCTUARY_MS,
  INTERROGATION_BOUNTY, DROP_TTL_MS,
  ensureGuild,
  guildOf,
  hallTileFor,
  isRealSpy,
  isGuildMember,
  memberOf,
  guildRankOf,
  inSanctuary,
  joinGuild,
  leaveGuild,
  recordDuesPayment,
  recordMissedDues,
  tradecraftCode,
  leaveDrop,
  pickupDrops,
  unreadDropCount,
  pruneDrops,
  layLow,
  expireSanctuaries,
  contributeTradecraft,
  bountyInterrogation,
  retryOwedBounties,
  scanMole,
  reportMisconduct,
  voteOnCase,
  settleCase,
  settleRipeCases,
  holdClass,
  tryPromote,
  describe,
};
