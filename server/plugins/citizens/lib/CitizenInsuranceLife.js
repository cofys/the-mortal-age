"use strict";

/**
 * CitizenInsuranceLife — slow-tick dynamics for the REAL insurance layer.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenInsurance owns the data tier: policies, premiums, claims,
 *     pool, risk assessment.
 *   - THIS module owns the tick: insurer appointment from the real
 *     roster, weekly premium collection from real inventories and bank
 *     accounts, policy sales by insurers to uninsured citizens who can
 *     honestly afford them, claim triggers from real state (funeral
 *     deaths → life claims, sickness → health claims, burglary rolls →
 *     property claims), owed-payout flushing, and announcements near
 *     real players.
 *
 * All coin movement is real (inventories, bank accounts, pool).
 * Never throws. Zero LLM. Dirty-flag persistence via CitizenInsurance.save().
 */

const Insurance = require("./CitizenInsurance");
const { agentRng } = require("./humanizer");

const WEEK_MS = 7 * 24 * 3600 * 1000;
const KINGDOMS = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"];
const BURGLARY_BASE_WEEKLY = 0.005; // 0.5% per week, scaled by kingdom risk

function safeTick(director, fn, label) {
  try {
    fn(director);
  } catch (error) {
    try {
      director?.log?.(`${label} failed`, { error: String(error?.message ?? error) });
    } catch { /* never throw */ }
  }
}

function rosterRecords(director) {
  try {
    const roster = director?.roster;
    if (!roster) return [];
    if (typeof roster.values === "function") return Array.from(roster.values());
    if (Array.isArray(roster)) return roster;
    return Object.values(roster);
  } catch {
    return [];
  }
}

function usernameOf(record) {
  return record?.username ?? record?.name ?? null;
}

function botFor(director, record) {
  try {
    if (director?.isOnline?.(record)) return director.getBot?.(record) ?? null;
    return null;
  } catch {
    return null;
  }
}

function kingdomIdOfRecord(record) {
  // Roster records carry kingdomId directly; kingdomIdOf() only reads
  // live bot attributes (and defaults to misthalin for plain objects).
  const direct = record?.kingdomId ?? record?.kingdom ?? null;
  if (typeof direct === "string" && direct) return direct.toLowerCase();
  try {
    const { kingdomIdOf } = require("../brain/CitizenSites");
    return kingdomIdOf(record);
  } catch {
    return null;
  }
}

function careerOf(username) {
  try {
    return require("./CitizenCareers").careerOf?.(username) ?? null;
  } catch {
    return null;
  }
}

function journalEvent(citizenName, text, kind) {
  try {
    // Canonical journal API: getJournal().log(name, kind, text).
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, kind || "insurance", text);
  } catch { /* best-effort */ }
}

function announce(director, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    for (const record of rosterRecords(director)) {
      try {
        if (!record || record.role !== "commoner") continue;
        const bot = botFor(director, record);
        if (!bot) continue;
        // Canonical engine API: near-player scan lives on the bot, not the director.
        const players = bot.getLocalPlayers?.() ?? [];
        if (!players.some((p) => !p?.isBot && !p?.isCitizen)) continue;
        sayPublic(bot, text);
        journalEvent("insurance", text, "insurance");
        return true;
      } catch { /* next citizen */ }
    }
  } catch { /* sayPublic optional */ }
  return false;
}

/**
 * Appoint insurers from the real roster: citizens in the insurer career,
 * one per kingdom office that lacks one.
 */
function appointInsurers(director, nowMs) {
  for (const kid of KINGDOMS) {
    if (Insurance.insurersIn(kid).length > 0) continue;
    for (const record of rosterRecords(director)) {
      try {
        if (!record) continue;
        if (careerOf(usernameOf(record))?.career !== "insurer") continue;
        if (kingdomIdOfRecord(record) !== kid) continue;
        Insurance.registerInsurer(usernameOf(record), kid);
        break;
      } catch { /* next citizen */ }
    }
  }
}

/**
 * Collect weekly premiums: online holders pay from real inventory (then
 * bank account); offline holders miss a payment; two misses lapse.
 */
function collectPremiums(director, nowMs) {
  const st = Insurance._data();
  let collected = 0;
  let lapsed = 0;
  let touched = false;
  for (const key of Object.keys(st.policies)) {
    const slot = st.policies[key];
    for (const t of Object.keys(Insurance.POLICY_TYPES)) {
      const policy = slot[t];
      if (!policy || policy.status !== "active") continue;
      if (Insurance.POLICY_TYPES[t].term !== "weekly") continue;
      if (policy.nextDueAt && nowMs < policy.nextDueAt) continue;
      touched = true;
      const record = rosterRecords(director).find(
        (r) => String(usernameOf(r) ?? "").toLowerCase() === key
      );
      const bot = record ? botFor(director, record) : null;
      if (!bot) {
        policy.missed = (policy.missed ?? 0) + 1;
        if (policy.missed > Insurance.MAX_MISSED) {
          policy.status = "lapsed";
          lapsed++;
          journalEvent(key, `let their ${t} policy lapse after missed premiums.`, "insurance");
        }
        continue;
      }
      const r = Insurance.payPremium(bot, key, t);
      if (r.ok) {
        collected += r.paid;
      } else {
        policy.missed = (policy.missed ?? 0) + 1;
        if (policy.missed > Insurance.MAX_MISSED) {
          policy.status = "lapsed";
          lapsed++;
          journalEvent(key, `let their ${t} policy lapse — could not pay the premium.`, "insurance");
        }
      }
    }
  }
  if (touched) Insurance.markDirty();
  if (collected > 0 || lapsed > 0) {
    try { director?.log?.("insurance premiums", { collected, lapsed }); } catch { /* ignore */ }
  }
}

/**
 * Insurers sell policies to uninsured online citizens in their kingdom —
 * but only when the buyer can honestly afford the first premium (keeps
 * 4x the premium in hand after paying). Two sales per kingdom per tick.
 */
function sellPolicies(director, nowMs) {
  const types = ["life", "health", "property"];
  for (const kid of KINGDOMS) {
    const insurers = Insurance.insurersIn(kid);
    if (insurers.length === 0) continue;
    const seller = insurers[0];
    let sold = 0;
    const candidates = rosterRecords(director).filter((r) => {
      try {
        return kingdomIdOfRecord(r) === kid && botFor(director, r);
      } catch {
        return false;
      }
    });
    const rng = agentRng(`insurance:sales:${kid}:${Math.floor(nowMs / 3600000)}`);
    // Shuffle deterministically.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (const record of candidates) {
      if (sold >= 2) break;
      try {
        const uname = usernameOf(record);
        if (!uname || String(uname).toLowerCase() === seller) continue;
        const bot = botFor(director, record);
        const coins = bot?.getInventory?.()?.getAmount?.(995) ?? 0;
        // Pick a type the citizen lacks, weighted to their situation.
        const missing = types.filter((t) => {
          const p = Insurance.policyFor(uname, t);
          return !p || p.status !== "active";
        });
        if (missing.length === 0) continue;
        const type = missing[Math.floor(rng() * missing.length)];
        const face = Math.min(
          Insurance.POLICY_TYPES[type].maxFace,
          Math.max(Insurance.POLICY_TYPES[type].minFace, Math.floor(coins / 4))
        );
        if (coins < face * 0.05) continue; // cannot honestly afford cover
        const r = Insurance.buyPolicy(bot, uname, type, face, {
          kingdomId: kid,
          // careerOf() returns a record { career, ... }; assessRisk wants the name.
          career: careerOf(uname)?.career ?? null,
          age: Number(record?.personality?.age),
        });
        if (r.ok) {
          sold++;
          journalEvent(uname, `bought ${type} insurance (face ${face}) from ${seller}.`, "insurance");
          try {
            const Rep = require("./CitizenReputation");
            Rep.addReputation?.(seller, 1, "sold an insurance policy");
          } catch { /* reputation optional */ }
        }
      } catch { /* next candidate */ }
    }
  }
}

/**
 * Life claims: new funeral deaths with an active life policy pay the
 * face value to the estate (the holder's bank account).
 */
function processDeathClaims(director, nowMs) {
  let Funerals = null;
  try {
    Funerals = require("./CitizenFunerals");
  } catch {
    return;
  }
  const st = Insurance._data();
  // Snapshot the watermark BEFORE the loop: getDeceased() is newest-first,
  // so advancing it per-record would skip every older unprocessed death.
  const startWatermark = st.lastDeathWatermark;
  let maxSeen = startWatermark;
  let paid = 0;
  for (const d of Funerals.getDeceased()) {
    if (!d) continue;
    const diedAt = d.diedAt ?? 0;
    if (diedAt > maxSeen) maxSeen = diedAt;
    if (diedAt <= startWatermark) continue;
    const uname = d.username ?? d.name;
    if (!uname) continue;
    const policy = Insurance.policyFor(uname, "life");
    if (!policy || policy.status !== "active") continue;
    const r = Insurance.fileClaim(uname, "life", "death");
    if (r.ok) {
      paid += r.paid;
      journalEvent(uname, `life insurance paid ${r.paid} coins to the estate.`, "insurance");
      announce(director, `${uname}'s life policy paid out ${r.paid} coins to their family.`);
    }
  }
  Insurance.setDeathWatermark(maxSeen);
}

/**
 * Health claims: sick citizens with an active health policy get half
 * the face value, once per bout of illness.
 */
function processHealthClaims(director, nowMs) {
  let Health = null;
  try {
    Health = require("./CitizenHealth");
  } catch {
    return;
  }
  for (const record of rosterRecords(director)) {
    try {
      const uname = usernameOf(record);
      if (!uname) continue;
      const policy = Insurance.policyFor(uname, "health");
      if (!policy || policy.status !== "active") continue;
      const rec = Health.recordOf?.(uname);
      if (!rec || !rec.illness) continue;
      if (policy.claimedFor === String(rec.illness).toLowerCase()) continue;
      const r = Insurance.fileClaim(uname, "health", "illness", { illnessKey: rec.illness });
      if (r.ok) {
        journalEvent(uname, `health insurance paid ${r.paid} coins for ${rec.illness}.`, "insurance");
        announce(director, `${uname}'s health policy covered their ${rec.illness} — ${r.paid} coins.`);
      }
    } catch { /* next citizen */ }
  }
}

/**
 * Property claims: a weekly deterministic burglary roll per insured
 * citizen, scaled by real kingdom risk. Hits pay 40% of face value.
 */
function processPropertyMisfortune(director, nowMs) {
  const week = Math.floor(nowMs / WEEK_MS);
  const st = Insurance._data();
  for (const key of Object.keys(st.policies)) {
    try {
      const policy = st.policies[key]?.property;
      if (!policy || policy.status !== "active") continue;
      const rng = agentRng(`insurance:burglary:${key}:${week}`);
      const risk = Insurance.assessRisk(key, "property", { kingdomId: policy.kingdomId });
      const chance = BURGLARY_BASE_WEEKLY * risk.multiplier;
      if (rng() >= chance) continue;
      const r = Insurance.fileClaim(key, "property", "burglary");
      if (r.ok) {
        journalEvent(key, `was burgled — property insurance paid ${r.paid} coins.`, "insurance");
        announce(director, `Burglars hit ${key}'s home, but their property policy paid ${r.paid} coins.`);
      }
    } catch { /* next holder */ }
  }
}

function tickInsuranceLife(director, nowMs) {
  safeTick(director, (d) => appointInsurers(d, nowMs), "insurance-appoint");
  safeTick(director, (d) => collectPremiums(d, nowMs), "insurance-premiums");
  safeTick(director, (d) => sellPolicies(d, nowMs), "insurance-sales");
  safeTick(director, (d) => processDeathClaims(d, nowMs), "insurance-deaths");
  safeTick(director, (d) => processHealthClaims(d, nowMs), "insurance-health");
  safeTick(director, (d) => processPropertyMisfortune(d, nowMs), "insurance-burglary");
  safeTick(director, () => Insurance.flushOwedPayouts(), "insurance-owed");
}

module.exports = { tickInsuranceLife };
