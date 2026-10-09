"use strict";

/**
 * CitizenSurgeryLife — the slow-tick dynamics for advanced citizen medicine.
 *
 * WHAT IT DOES (slow tick, called by CitizenDirector):
 *   1. Surgeon promotion: healer-career citizens with herblore 50+ are
 *      registered as surgeons (once).
 *   2. Surgery scheduling: citizens who needSurgery() get matched with an
 *      available surgeon in their kingdom; procedures are scheduled.
 *   3. Procedure resolution: in-progress procedures complete after their
 *      duration; success rolls against successChanceFor(); materials are
 *      consumed from the surgeon's real inventory at start.
 *   4. Medical research: in-progress research advances; completion unlocks
 *      procedures kingdom-wide and is announced.
 *   5. Epidemic response: when CitizenHealth.isEpidemic() in a kingdom,
 *      sick citizens are quarantined (isolation without contagion spread);
 *      mass treatment sweeps cure quarantined patients faster.
 *   6. Player patients: queued player surgery requests get a surgeon
 *      assigned and resolved the same way.
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. Announcements go through sayPublic near real players and
 *     the journal; the chat layer riffs on them.
 *   - Never throws. Every section is try/catch isolated — one bad
 *     citizen never breaks the tick.
 *   - Materials are honest: if the surgeon lacks the real items, the
 *     procedure waits. Nothing is invented.
 */

const Surgery = require("./CitizenSurgery");

// --- small helpers (all defensive) --------------------------------------------

function usernameOf(rec) {
  try {
    return rec?.username ?? rec?.name ?? null;
  } catch {
    return null;
  }
}

function kingdomOf(rec) {
  try {
    return rec?.kingdomId ?? rec?.kingdom_id ?? null;
  } catch {
    return null;
  }
}

function herbloreLevelOf(player) {
  try {
    // Real skill level via the engine's skill manager. Defensive: the
    // player may be a plain record in tests.
    if (typeof player?.getLevel === "function") return player.getLevel("herblore") ?? 1;
    if (typeof player?.skills?.herblore === "number") return player.skills.herblore;
    return 1;
  } catch {
    return 1;
  }
}

function hasMaterials(player, materials) {
  // materials: { itemKey: count }. Resolves keys to real item ids via
  // Surgery.materialIds(). Returns true only if the player's real
  // inventory holds every required item in the required count.
  // Canonical: ItemContainer.getAmount(id). There is no inv.count(id), and
  // inv[id] on a container object is undefined — not an item count.
  try {
    const ids = Surgery.materialIds();
    const inv = player?.inventory ?? player?.getInventory?.();
    if (!inv) return false;
    for (const [key, count] of Object.entries(materials ?? {})) {
      const id = ids[key];
      if (id == null) return false; // unresolvable material = cannot proceed
      const have = inv.getAmount?.(id) ?? 0;
      if (have < count) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function consumeMaterials(player, materials) {
  // Removes the real items. Returns true on success. Canonical:
  // deleteNumber(id, amount) with per-item balance verification — the old
  // inv.remove(id, amount) does not exist on ItemContainer, so materials
  // were never consumed while the function still reported success.
  try {
    const ids = Surgery.materialIds();
    const inv = player?.inventory ?? player?.getInventory?.();
    if (!inv) return false;
    for (const [key, count] of Object.entries(materials ?? {})) {
      const id = ids[key];
      if (id == null) return false;
      const before = inv.getAmount?.(id) ?? 0;
      if (before < count) return false;
      inv.deleteNumber?.(id, count);
      if ((inv.getAmount?.(id) ?? 0) !== before - count) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sayNear(director, kingdomId, text) {
  try {
    director?.sayPublic?.(text, { kingdomId });
  } catch {
    // sayPublic is best-effort.
  }
}

function journal(director, text, data) {
  try {
    director?.getJournal?.()?.log?.(text, data);
  } catch {
    // Journal is best-effort.
  }
}

// --- tick sections ---------------------------------------------------------------

function promoteSurgeons(director, records, nowMs) {
  // Healer-career citizens with herblore 50+ become surgeons.
  try {
    for (const rec of records) {
      const name = usernameOf(rec);
      if (!name || Surgery.isSurgeon(name)) continue;
      const career = rec?.career?.key ?? rec?.career;
      if (career !== "healer") continue;
      const bot = director?.getBot?.(rec) ?? null;
      if (herbloreLevelOf(bot ?? rec) >= Surgery.SURGEON_SKILL_REQ) {
        Surgery.registerSurgeon(name, nowMs);
        journal(director, "surgeon_promoted", { citizen: name });
      }
    }
  } catch {
    // Never break the tick.
  }
}

function scheduleSurgeries(director, records, nowMs) {
  // Match citizens who need surgery with kingdom surgeons.
  try {
    const Health = require("./CitizenHealth");
    for (const rec of records) {
      const name = usernameOf(rec);
      if (!name) continue;
      if (Surgery.procedureOf(name)?.status === "in_progress") continue;
      const need = Surgery.needsSurgery(name);
      if (!need) continue;
      const kid = kingdomOf(rec);
      if (!Surgery.procedureUnlocked(kid, need.procedure)) continue;
      if (!Surgery.wingOf(kid)) continue; // need a surgery wing
      const surgeons = Surgery.surgeonsOfKingdom(kid, records);
      if (surgeons.length === 0) continue;
      // Pick the first available surgeon (deterministic, no RNG).
      const surgeon = surgeons[0];
      const surgeonName = usernameOf(surgeon);
      const proc = Surgery.procedureDef(need.procedure);
      const bot = director?.getBot?.(surgeon) ?? null;
      if (!hasMaterials(bot ?? surgeon, proc.materials)) continue; // honest wait
      consumeMaterials(bot ?? surgeon, proc.materials);
      Surgery.scheduleProcedure(name, need.procedure, surgeonName, kid, nowMs);
      journal(director, "surgery_scheduled", {
        patient: name,
        procedure: need.procedure,
        surgeon: surgeonName,
      });
    }
  } catch {
    // Never break the tick.
  }
}

function resolveProcedures(director, nowMs) {
  // Complete procedures whose duration has elapsed.
  try {
    const Health = require("./CitizenHealth");
    const st = { done: 0 };
    // We iterate the save state's procedures via the public accessor.
    // completeProcedure handles the cure through CitizenHealth.
    const all = [];
    try {
      // Access via a lightweight scan: procedureOf is per-user, so we
      // need the roster. The director passes records; reuse them.
      for (const rec of director?.roster?.values?.() ?? []) {
        const name = usernameOf(rec);
        if (name) all.push({ name, rec });
      }
    } catch {
      return;
    }
    for (const { name, rec } of all) {
      const p = Surgery.procedureOf(name);
      if (!p || p.status !== "in_progress") continue;
      const proc = Surgery.procedureDef(p.procedure);
      if (!proc) continue;
      const elapsed = nowMs - p.startedAt;
      if (elapsed < proc.durationHours * 3600 * 1000) continue;
      const kid = p.kingdomId ?? kingdomOf(rec);
      const surgeonBot = p.surgeon ? director?.getBot?.({ username: p.surgeon }) ?? null : null;
      const chance = Surgery.successChanceFor(
        p.procedure,
        herbloreLevelOf(surgeonBot ?? { skills: { herblore: proc.skillReq } }),
        kid
      );
      const success = Math.random() < chance;
      Surgery.completeProcedure(name, success, nowMs);
      st.done++;
      if (success) {
        sayNear(director, kid, `${name} has recovered after surgery.`);
        journal(director, "surgery_completed", {
          patient: name,
          procedure: p.procedure,
          surgeon: p.surgeon,
        });
      } else {
        journal(director, "surgery_failed", {
          patient: name,
          procedure: p.procedure,
          surgeon: p.surgeon,
        });
      }
    }
  } catch {
    // Never break the tick.
  }
}

function advanceResearch(director, nowMs) {
  // In-progress research completes after its duration; announce unlocks.
  try {
    const seen = new Set();
    for (const rec of director?.roster?.values?.() ?? []) {
      const kid = kingdomOf(rec);
      if (!kid || seen.has(kid)) continue;
      seen.add(kid);
      for (const key of Surgery.RESEARCH_KEYS) {
        if (Surgery.researchStatus(kid, key) !== "in_progress") continue;
        if (Surgery.researchProgress(kid, key, nowMs) >= 1) {
          Surgery.completeResearch(kid, key, nowMs);
          const def = Surgery.researchDef(key);
          sayNear(
            director,
            kid,
            `Breakthrough! Our surgeons have completed research into ${def.label}.`
          );
          journal(director, "research_completed", { kingdom: kid, research: key });
        }
      }
    }
  } catch {
    // Never break the tick.
  }
}

function epidemicResponse(director, nowMs) {
  // When a kingdom has an epidemic, quarantine the sick: they recover
  // in isolation without spreading contagion.
  try {
    const Health = require("./CitizenHealth");
    if (typeof Health.isEpidemic !== "function") return;
    const seen = new Set();
    for (const rec of director?.roster?.values?.() ?? []) {
      const kid = kingdomOf(rec);
      if (!kid || seen.has(kid)) continue;
      seen.add(kid);
      let epidemic = false;
      try {
        epidemic = Health.isEpidemic(kid);
      } catch {
        continue;
      }
      if (!epidemic) continue;
      // Quarantine the sick in this kingdom.
      let quarantined = 0;
      for (const other of director?.roster?.values?.() ?? []) {
        if (kingdomOf(other) !== kid) continue;
        const name = usernameOf(other);
        if (!name || Surgery.isQuarantined(name)) continue;
        let sick = false;
        try {
          sick = Health.isSick(name);
        } catch {
          continue;
        }
        if (sick && Surgery.quarantinePatient(name, kid, nowMs)) {
          quarantined++;
        }
      }
      if (quarantined > 0) {
        sayNear(
          director,
          kid,
          `The sick are being quarantined — ${quarantined} citizens isolated.`
        );
        journal(director, "quarantine_started", { kingdom: kid, count: quarantined });
      }
      // Mass treatment: surgeons sweep the quarantine, curing faster.
      // Each quarantined patient gets a recovery boost — implemented as
      // a direct cure chance per tick for the quarantined.
      const patients = Surgery.quarantineOf(kid);
      const surgeons = Surgery.surgeonsOfKingdom(kid, director?.roster?.values?.() ?? []);
      if (surgeons.length > 0) {
        for (const patient of patients) {
          try {
            if (!Health.isSick(patient)) {
              Surgery.releaseFromQuarantine(patient, kid);
              continue;
            }
          } catch {
            continue;
          }
          // 5% per-tick mass-treatment cure chance per surgeon team.
          // Quarantine itself doesn't cure — it isolates. The sweep heals.
          if (Math.random() < 0.05 * Math.min(3, surgeons.length)) {
            try {
              Health.cure(patient, "mass treatment");
            } catch {
              // Health unavailable.
            }
            Surgery.releaseFromQuarantine(patient, kid);
            journal(director, "mass_treatment_cure", { patient, kingdom: kid });
          }
        }
      }
    }
  } catch {
    // Never break the tick.
  }
}

function assignPlayerSurgeries(director, nowMs) {
  // Queued player requests get a surgeon assigned from their kingdom.
  try {
    for (const rec of director?.roster?.values?.() ?? []) {
      const name = usernameOf(rec);
      if (!name) continue;
      const p = Surgery.procedureOf(name);
      if (!p || p.status !== "queued" || !p.isPlayer) continue;
      const kid = p.kingdomId ?? kingdomOf(rec);
      const surgeons = Surgery.surgeonsOfKingdom(kid, director?.roster?.values?.() ?? []);
      if (surgeons.length === 0) continue;
      const surgeonName = usernameOf(surgeons[0]);
      // Re-queue as in-progress with the assigned surgeon.
      Surgery.scheduleProcedure(name, p.procedure, surgeonName, kid, nowMs);
      journal(director, "player_surgery_assigned", {
        player: name,
        surgeon: surgeonName,
        procedure: p.procedure,
      });
    }
  } catch {
    // Never break the tick.
  }
}

// --- main tick ----------------------------------------------------------------

/**
 * Slow-tick entry point, called by CitizenDirector. Never throws.
 */
function tickSurgery(director, nowMs) {
  try {
    const records = [...(director?.roster?.values?.() ?? [])];
    promoteSurgeons(director, records, nowMs);
    scheduleSurgeries(director, records, nowMs);
    resolveProcedures(director, nowMs);
    advanceResearch(director, nowMs);
    epidemicResponse(director, nowMs);
    assignPlayerSurgeries(director, nowMs);
  } catch {
    // The director wraps this in try/catch too — belt and suspenders.
  }
}

module.exports = {
  tickSurgery,
  // test seams — inventory-API regression surface (canonical ItemContainer API)
  _hasMaterialsForTests: hasMaterials,
  _consumeMaterialsForTests: consumeMaterials,
};
