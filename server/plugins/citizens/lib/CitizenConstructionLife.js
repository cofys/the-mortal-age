"use strict";

/**
 * CitizenConstructionLife — slow-tick dynamics for real construction.
 *
 * On the director's slow tick:
 *   - Advances "building"-phase projects (real time progress).
 *   - Completes projects: creates the persistent built record, applies
 *     the real effect, awards fame deeds to the designer, announces near
 *     real players via sayPublic (landmarks announce realm-wide).
 *   - Auto-commissions: when a kingdom has no active project and its
 *     treasury can afford a useful building, the crown commissions one
 *     (deterministic pick from what's not yet built — no spam, one at a
 *     time per kingdom).
 *
 * Zero LLM. Never throws: per-project try/catch.
 */

const Construction = require("./CitizenConstruction");
const { getJournal } = require("./CitizenJournal");
const { sayPublic } = require("../chat/CitizenSayPublic");

// Auto-commission picks the first unbuilt useful building per kingdom.
const AUTO_COMMISSION_ORDER = [
  "granary",
  "walls",
  "barracks",
  "market_hall",
  "temple",
  "bathhouse",
  "library",
  "aqueduct",
  "lighthouse",
  "monument",
];

function fameApi() {
  try {
    return require("./CitizenReputation");
  } catch {
    return null;
  }
}

function tickConstruction(director, nowMs) {
  try {
    // 1. Advance building-phase projects.
    const kingdoms = kingdomsOf(director);
    for (const kingdomId of kingdoms) {
      try {
        const active = Construction.activeProjectFor(kingdomId);
        if (!active) continue;
        if (active.status !== "building") continue;
        const done = Construction.progressProject(active.id, 1);
        if (done) onProjectComplete(director, done);
      } catch {}
    }

    // 2. Auto-commission: one active project per kingdom at a time.
    for (const kingdomId of kingdoms) {
      try {
        if (Construction.activeProjectFor(kingdomId)) continue;
        autoCommission(director, kingdomId);
      } catch {}
    }
  } catch {}
}

function kingdomsOf(director) {
  try {
    const roster = director.roster;
    const set = new Set();
    if (roster && typeof roster.values === "function") {
      for (const r of roster.values()) {
        if (r && r.kingdomId) set.add(r.kingdomId);
      }
    }
    return [...set];
  } catch {
    return [];
  }
}

function onProjectComplete(director, proj) {
  const spec = Construction.specFor(proj.type);
  if (!spec) return;
  const Fame = fameApi();
  // Fame deed for the designer.
  if (Fame && typeof Fame.awardDeed === "function" && proj.designer) {
    try {
      Fame.awardDeed(proj.designer, proj.isLandmark ? "landmark" : "builder");
    } catch {}
  }
  const msg = proj.isLandmark
    ? `Hear ye! The ${spec.label} stands complete in ${proj.kingdomId} — a wonder of the realm!`
    : `The new ${spec.label} is finished in ${proj.kingdomId}!`;
  try {
    getJournal().log("construction", msg);
  } catch {}
  // Announce near real players.
  announceNear(director, proj.kingdomId, msg, proj.isLandmark);
}

function announceNear(director, kingdomId, msg, realmWide) {
  try {
    const bots = botsOf(director, kingdomId);
    let announced = false;
    for (const bot of bots) {
      try {
        if (sayPublic(director, bot, msg)) {
          announced = true;
          if (!realmWide) break;
        }
      } catch {}
    }
    if (!announced) {
      try {
        getJournal().log("construction", `(no herald nearby) ${msg}`);
      } catch {}
    }
  } catch {}
}

function botsOf(director, kingdomId) {
  const out = [];
  try {
    const roster = director.roster;
    if (roster && typeof roster.values === "function") {
      for (const r of roster.values()) {
        if (!r || r.kingdomId !== kingdomId) continue;
        try {
          const bot = director.isOnline?.(r) ? director.getBot?.(r) : null;
          if (bot) out.push(bot);
        } catch {}
      }
    }
  } catch {}
  return out;
}

function autoCommission(director, kingdomId) {
  // Don't auto-commission while the kingdom is at war (resources are scarce).
  try {
    const KingdomStore = require("../../kingdoms/KingdomStore");
    const wars = KingdomStore.getActiveWars?.() ?? [];
    if (wars.some((w) => w && (w.attacker === kingdomId || w.defender === kingdomId))) return;
  } catch {}

  const built = new Set(Construction.builtFor(kingdomId).map((b) => b.type));
  const want = AUTO_COMMISSION_ORDER.find((t) => !built.has(t));
  if (!want) return; // everything built

  // Need a blueprint first — draft one as the crown's architect.
  const bp = Construction.createBlueprint("crown-architect", want, "medium", "crown");
  if (!bp.ok) return;
  const res = Construction.commissionProject(kingdomId, bp.id, "crown", { royal: true });
  if (!res.ok) {
    // Treasury too thin — try again later. Honest: no project without funds.
    return;
  }
  try {
    getJournal().log("construction", `The crown commissioned ${Construction.specFor(want).label} in ${kingdomId}.`);
  } catch {}
}

module.exports = { tickConstruction };
