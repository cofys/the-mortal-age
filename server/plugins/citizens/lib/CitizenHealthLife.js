"use strict";

/**
 * CitizenHealthLife — director tick dynamics for sickness and healing.
 * Data tier, zero LLM.
 *
 * Each slow tick:
 *  1. Onset: healthy citizens have a small daily chance to fall ill.
 *     Elders and children are more vulnerable; guards risk wound
 *     infection; winter raises cold/flu odds.
 *  2. Spread: contagious illnesses (cold, flu, plague) can pass to
 *     healthy kingdom-mates.
 *  3. Recovery: illnesses run their course — recoverAt passes, the
 *     citizen is cured (journaled).
 *  4. Healers: healer-career citizens treat the sick — herb-cure
 *     illnesses consume a REAL clean herb from the healer's inventory
 *     as medicine; plague needs the visit itself.
 *  5. Hospitals: severe cases are admitted where beds are free;
 *     patients recover twice as fast.
 *  6. Epidemics: 3+ same-illness cases in a kingdom is announced once
 *     (memory-guarded) via sayPublic.
 *
 * Wiring: CitizenDirector calls tickHealth(this, nowMs) in the slow tick
 * inside try/catch. CitizenHealth.save() goes in the save section.
 */

const Health = require("./CitizenHealth");
const { agentRng, chance } = require("./humanizer");
const { normalizeName } = require("./CitizenBonds");

const DAY_MS = 24 * 3600 * 1000;

// Per slow-tick (~60s) base onset chance. Tuned so a ~170-citizen realm
// sees a few new cases a day, not a ward full.
const ONSET_PER_TICK = 0.0006;
const CHILD_VULN_MULT = 1.6;
const ELDER_VULN_MULT = 1.8;
const GUARD_INFECTION_BONUS = 0.0012; // guards earn their wounds honestly
const WINTER_COLD_MULT = 2.0;

// Which illnesses the onset roll can produce, weighted.
const ONSET_TABLE = Object.freeze([
  ["cold", 40],
  ["flu", 25],
  ["foodpoison", 20],
  ["infection", 12],
  ["plague", 3],
]);

function pickWeighted(rng, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = rng() * total;
  for (const [key, w] of table) {
    roll -= w;
    if (roll <= 0) return key;
  }
  return table[table.length - 1][0];
}

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, text, kind || "health");
  } catch {
    // best-effort
  }
}

function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const player = director?.getPlayer?.(username) ?? director?.players?.get?.(username);
    if (player) sayPublic(player, text);
  } catch {
    // best-effort
  }
}

// Lazy singletons for cross-module reads (defensive: never break the tick).
function careers() {
  try {
    return require("./CitizenCareers");
  } catch {
    return null;
  }
}
function families() {
  try {
    return require("./CitizenFamilies");
  } catch {
    return null;
  }
}

/** Roster records as an array. Defensive across director shapes. */
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

function kingdomOf(record) {
  return record?.kingdomId ?? record?.kingdom ?? null;
}

function ageOf(record) {
  const a = Number(record?.personality?.age);
  return Number.isFinite(a) ? a : 35;
}

function isChildRecord(record, director) {
  // Family children are data records until adulthood; roster adults are
  // never children. Young roster citizens (<18) count as vulnerable too.
  return ageOf(record) < 18;
}

/** Clean herb item ids, read from the Herblore plugin at runtime. */
function cleanHerbIds() {
  try {
    const Herblore = require("../../skills/Herblore.plugin.js");
    const ids = [];
    for (const r of Herblore.HERBLORE_RECIPES ?? []) {
      if (r.kind === "clean" && Number.isFinite(r.outputId)) ids.push(r.outputId);
    }
    return ids;
  } catch {
    return [];
  }
}

function countItem(player, itemId) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(itemId);
    if (typeof inv.getAmount === "function") return inv.getAmount(itemId);
    return 0;
  } catch {
    return 0;
  }
}

function removeItem(player, itemId, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    if (typeof inv.remove === "function") {
      inv.remove(itemId, amount);
      return true;
    }
    if (typeof inv.delete === "function") {
      inv.delete(itemId, amount);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function healerCareerOf(record) {
  try {
    const C = careers();
    if (!C || typeof C.careerOf !== "function") return null;
    const c = C.careerOf(usernameOf(record));
    return c?.key === "healer" ? c : null;
  } catch {
    return null;
  }
}

// --- tick phases -------------------------------------------------------------

function phaseOnset(director, records, nowMs, rng) {
  const month = new Date(nowMs).getMonth();
  const winter = month === 11 || month === 0 || month === 1;
  for (const record of records) {
    const username = usernameOf(record);
    if (!username || Health.isSick(username)) continue;
    let p = ONSET_PER_TICK;
    const age = ageOf(record);
    if (age < 18) p *= CHILD_VULN_MULT;
    else if (age >= 60) p *= ELDER_VULN_MULT;
    if (String(record?.role ?? "").toLowerCase() === "guard") p += GUARD_INFECTION_BONUS;
    const illness = pickWeighted(rng, ONSET_TABLE);
    if (illness === "cold" || illness === "flu") {
      if (winter) p *= WINTER_COLD_MULT;
    }
    if (!chance(rng, p)) continue;
    // Guards' bonus funnels to wound infection — honest cause and effect.
    const finalIllness =
      String(record?.role ?? "").toLowerCase() === "guard" && rng() < 0.4 ? "infection" : illness;
    const rec = Health.sicken(username, finalIllness, nowMs, {
      rng,
      display: record?.displayName ?? record?.display ?? username,
      kingdomId: kingdomOf(record),
    });
    if (rec) {
      const def = Health.illnessDef(finalIllness);
      journalEvent(username, `has come down with ${def.label} (${def.symptom}).`, "health");
    }
  }
}

function phaseSpread(director, records, nowMs, rng) {
  // Group healthy citizens by kingdom for contagion checks.
  const byKingdom = new Map();
  for (const record of records) {
    const username = usernameOf(record);
    if (!username || Health.isSick(username)) continue;
    const k = kingdomOf(record);
    if (!k) continue;
    if (!byKingdom.has(k)) byKingdom.set(k, []);
    byKingdom.get(k).push(record);
  }
  for (const [kingdomId, healthy] of byKingdom) {
    for (const illnessKey of Health.ILLNESS_KEYS) {
      const def = Health.illnessDef(illnessKey);
      if (!def.contagious) continue;
      const cases = Health.casesOf(kingdomId, illnessKey);
      if (cases === 0) continue;
      for (const record of healthy) {
        const username = usernameOf(record);
        if (Health.isSick(username)) continue; // caught it from an earlier illness this tick
        // Each case is an independent exposure roll, capped to stay sane.
        const p = Math.min(0.25, def.contagious * cases);
        if (chance(rng, p)) {
          Health.sicken(username, illnessKey, nowMs, {
            rng,
            display: record?.displayName ?? record?.display ?? username,
            kingdomId,
          });
          journalEvent(username, `caught ${def.label} going around town.`, "health");
        }
      }
    }
  }
}

function phaseRecovery(director, nowMs) {
  const st = Health.load();
  for (const rec of Object.values(st.sick)) {
    if (nowMs < rec.recoverAt) continue;
    const def = Health.illnessDef(rec.illness);
    Health.dischargePatient(rec.username);
    Health.cure(rec.username, "recovered");
    journalEvent(
      rec.username,
      rec.treatedBy
        ? `has recovered from ${def.label}, thanks to ${rec.treatedBy}.`
        : `has recovered from ${def.label}.`,
      "health"
    );
  }
}

function phaseHealers(director, records, nowMs, rng) {
  const herbIds = cleanHerbIds();
  const healers = records.filter((r) => healerCareerOf(r));
  if (healers.length === 0) return;
  // Index sick citizens by kingdom for local treatment.
  const sickByKingdom = new Map();
  for (const record of records) {
    const username = usernameOf(record);
    if (!username || !Health.isSick(username)) continue;
    const rec = Health.recordOf(username);
    if (rec.treatedBy) continue; // already seen
    const k = kingdomOf(record);
    if (!k) continue;
    if (!sickByKingdom.has(k)) sickByKingdom.set(k, []);
    sickByKingdom.get(k).push({ record, rec });
  }
  for (const healer of healers) {
    const healerName = usernameOf(healer);
    const hk = kingdomOf(healer);
    const patients = (sickByKingdom.get(hk) ?? []).filter((p) => !p.rec.treatedBy);
    // Treat the worst first, up to 2 per tick.
    patients.sort((a, b) => b.rec.severity - a.rec.severity);
    let treated = 0;
    for (const { rec } of patients) {
      if (treated >= 2) break;
      const def = Health.illnessDef(rec.illness);
      if (def.cure === "herb") {
        // Medicine consumes a real clean herb from the healer's inventory.
        const player = director?.getPlayer?.(healerName) ?? director?.players?.get?.(healerName);
        let hasHerb = false;
        if (player) {
          for (const id of herbIds) {
            if (countItem(player, id) > 0) {
              removeItem(player, id, 1);
              hasHerb = true;
              break;
            }
          }
        }
        if (!hasHerb) continue; // no medicine to give — try the next patient
        journalEvent(
          healerName,
          `brewed a remedy for ${rec.display ?? rec.username}'s ${def.label}.`,
          "health"
        );
      } else {
        journalEvent(
          healerName,
          `is tending ${rec.display ?? rec.username}'s ${def.label}.`,
          "health"
        );
      }
      Health.setTreatedBy(rec.username, healerName);
      journalEvent(rec.username, `is being treated by ${healerName}.`, "health");
      treated++;
    }
  }
}

function phaseHospitals(director, records, nowMs) {
  for (const record of records) {
    const username = usernameOf(record);
    if (!username || !Health.isSick(username)) continue;
    const rec = Health.recordOf(username);
    if (!rec || rec.inHospital) continue;
    // Severe cases seek the infirmary where beds are free.
    if (rec.severity >= 3) {
      const k = kingdomOf(record);
      if (!k) continue;
      if (Health.admitPatient(username, k)) {
        journalEvent(username, "has been taken to the infirmary.", "health");
      }
    }
  }
}

// Epidemic announcements, memory-guarded so they fire once per outbreak.
const announcedEpidemics = new Set();

function phaseEpidemics(director, records, nowMs) {
  const kingdoms = new Set(records.map(kingdomOf).filter(Boolean));
  for (const kingdomId of kingdoms) {
    for (const illnessKey of Health.ILLNESS_KEYS) {
      const def = Health.illnessDef(illnessKey);
      if (!def.contagious) continue;
      const key = `${kingdomId}:${illnessKey}`;
      if (Health.isEpidemic(kingdomId, illnessKey)) {
        if (announcedEpidemics.has(key)) continue;
        announcedEpidemics.add(key);
        // Find a materialized citizen of the kingdom to spread the word.
        const townCrier = records.find(
          (r) => kingdomOf(r) === kingdomId && (director?.getPlayer?.(usernameOf(r)) ?? director?.players?.get?.(usernameOf(r)))
        );
        if (townCrier) {
          sayPublicTo(
            director,
            usernameOf(townCrier),
            `Word is ${def.label} is spreading through town — stay home if you're ${def.symptom}!`
          );
        }
        for (const record of records) {
          if (kingdomOf(record) !== kingdomId) continue;
          journalEvent(usernameOf(record), `${def.label} is spreading through town.`, "health");
        }
      } else {
        announcedEpidemics.delete(key); // outbreak over — may announce again later
      }
    }
  }
}

/**
 * The slow-tick entry point. director: CitizenDirector. nowMs: Date.now().
 * Everything is phase-ordered and individually guarded — one phase
 * failing must not starve the others.
 */
function tickHealth(director, nowMs) {
  if (!director) return;
  const rng = agentRng(`health:${Math.floor(nowMs / 60000)}`);
  const records = rosterRecords(director);
  if (records.length === 0) return;
  try {
    phaseOnset(director, records, nowMs, rng);
  } catch {
    // fall through
  }
  try {
    phaseSpread(director, records, nowMs, rng);
  } catch {
    // fall through
  }
  try {
    phaseRecovery(director, nowMs);
  } catch {
    // fall through
  }
  try {
    phaseHealers(director, records, nowMs, rng);
  } catch {
    // fall through
  }
  try {
    phaseHospitals(director, records, nowMs);
  } catch {
    // fall through
  }
  try {
    phaseEpidemics(director, records, nowMs);
  } catch {
    // fall through
  }
}

module.exports = {
  tickHealth,
  // Exported for tests:
  _phaseOnset: phaseOnset,
  _phaseSpread: phaseSpread,
  _phaseRecovery: phaseRecovery,
  _phaseHealers: phaseHealers,
  _phaseHospitals: phaseHospitals,
  _phaseEpidemics: phaseEpidemics,
  _announcedEpidemics: announcedEpidemics,
};
