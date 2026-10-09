"use strict";

/**
 * CitizenSchoolLife — director tick dynamics for schools, pupils, tuition,
 * and graduation. Data tier, zero LLM.
 *
 * Each slow tick:
 *  1. Found schoolhouses: a kingdom with enough school-age family children
 *     and no schoolhouse gets one (tile near the market, deterministic).
 *  2. Appoint teachers: scribe-career citizens become schoolmasters
 *     (same pattern as CitizenFaith ordaining priests).
 *  3. Enroll: school-age family children (child/teen stage) join the
 *     kingdom school while there is capacity.
 *  4. Lessons: enrolled pupils gain literacy and numeracy; milestones
 *     are journaled.
 *  5. Tuition: 25 coins/pupil/day from the parents' real coins (same
 *     take-coins pattern as CitizenHomeLife rent). Offline parents accrue
 *     debt; 7 days unpaid → unenrolled. Waived while the council's
 *     "Free Schooling" law is active.
 *  6. Graduation: pupils who outgrow school age (adult stage, roster
 *     join, or left town) graduate with their final scores journaled —
 *     their education bonus then applies via CitizenSchools.xpBonusFor.
 *
 * Wiring: CitizenDirector calls tickSchools(this, nowMs) in the slow tick
 * inside try/catch.
 */

const Schools = require("./CitizenSchools");
const { agentRng } = require("./humanizer");

const COINS = 995;
const DAY_MS = 24 * 3600 * 1000;
const TEACHER_STIPEND_SHARE = 15; // of the 25 tuition, 15 goes to an online teacher

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, text, kind || "school");
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
function families() {
  try {
    return require("./CitizenFamilies");
  } catch {
    return null;
  }
}
function careers() {
  try {
    return require("./CitizenCareers");
  } catch {
    return null;
  }
}
function government() {
  try {
    return require("./CitizenGovernment");
  } catch {
    return null;
  }
}

function rosterRecords(director) {
  try {
    return [...(director?.roster?.values?.() ?? [])];
  } catch {
    return [];
  }
}

function recordFor(director, username) {
  try {
    const { normalizeName } = require("./CitizenBonds");
    return director?.roster?.get?.(normalizeName(username)) ?? null;
  } catch {
    return null;
  }
}

function botFor(director, record) {
  try {
    return director?.getBot ? director.getBot(record) : null;
  } catch {
    return null;
  }
}

/** Remove coins for real; returns the amount actually removed. */
function takeCoins(bot, amount) {
  try {
    const inv = bot?.getInventory?.();
    if (!inv || typeof inv.deleted !== "function" || typeof inv.getAmount !== "function")
      return 0;
    const before = inv.getAmount(COINS) ?? 0;
    if (before < amount) return 0;
    inv.deleted(COINS, amount, true);
    const after = inv.getAmount(COINS) ?? before;
    return Math.max(0, before - after);
  } catch {
    return 0;
  }
}

/** Give coins for real; returns true when the inventory accepted them. */
function giveCoins(bot, amount) {
  // Canonical: adds(id, amount) with balance verification. inv.add takes an
  // Item instance, not (id, amount) — the old call threw inside ItemContainer.
  try {
    const inv = bot?.getInventory?.();
    if (!inv) return false;
    const before = inv.getAmount?.(COINS) ?? 0;
    inv.adds?.(COINS, amount);
    return (inv.getAmount?.(COINS) ?? 0) === before + amount;
  } catch {
    return false;
  }
}

function schoolAgeChildren(director) {
  const F = families();
  if (!F) return [];
  let kids = [];
  try {
    kids = F.allChildren() ?? [];
  } catch {
    return [];
  }
  return kids.filter((c) => Schools.isSchoolAgeChild(c));
}

function tuitionWaived(kingdomId, nowMs) {
  try {
    const Gov = government();
    return !!Gov?.hasLaw?.(kingdomId, "school-funding", nowMs);
  } catch {
    return false;
  }
}

// --- 1. founding ------------------------------------------------------------

function foundSchools(kids) {
  const byKingdom = new Map();
  for (const kid of kids) {
    const k = String(kid.kingdomId ?? "").toLowerCase();
    if (!k) continue;
    if (!byKingdom.has(k)) byKingdom.set(k, []);
    byKingdom.get(k).push(kid);
  }
  for (const [kingdomId, list] of byKingdom) {
    try {
      if (Schools.schoolOfKingdom(kingdomId)) continue;
      if (list.length < Schools.MIN_CHILDREN_FOR_SCHOOL) continue;
      const school = Schools.foundSchool(kingdomId, null);
      if (!school) continue;
      journalEvent(
        list[0].parents?.[0] ?? "town-crier",
        `A schoolhouse opened its doors: the ${school.name}.`,
        "school"
      );
    } catch {
      // one kingdom's school never breaks the tick
    }
  }
}

// --- 2. teachers ------------------------------------------------------------

function appointTeachers(director, records) {
  const C = careers();
  const byKingdom = new Map();
  for (const r of records) {
    const k = String(r?.kingdomId ?? "").toLowerCase();
    if (!k) continue;
    if (!byKingdom.has(k)) byKingdom.set(k, []);
    byKingdom.get(k).push(r);
  }
  for (const [kingdomId, list] of byKingdom) {
    try {
      const school = Schools.schoolOfKingdom(kingdomId);
      if (!school || school.teacher) continue;
      // Prefer scribe-career citizens (the literate), else a patient elder.
      let pick = null;
      if (C) {
        pick =
          list.find((r) => {
            try {
              return C.careerOf?.(r.username)?.career === "scribe";
            } catch {
              return false;
            }
          }) ?? null;
      }
      if (!pick) {
        const candidates = list.filter((r) => {
          const traits = new Set(r?.personality?.traits ?? []);
          return traits.has("patient") || traits.has("wise");
        });
        pick = candidates[0] ?? null;
      }
      if (!pick) continue;
      Schools.setTeacher(kingdomId, pick.username);
      journalEvent(
        pick.username,
        `was named schoolmaster of the ${school.name}.`,
        "school"
      );
    } catch {
      // best-effort
    }
  }
}

// --- 3. enrollment ----------------------------------------------------------

function enrollPupils(director, kids) {
  for (const kid of kids) {
    try {
      if (Schools.pupilOf(kid.id)) continue;
      const pupil = Schools.enrollPupil(kid);
      if (!pupil) continue;
      const parent = kid.parents?.[0];
      if (parent) {
        journalEvent(
          parent,
          `${kid.display} started lessons at the ${Schools.schoolOfKingdom(kid.kingdomId)?.name ?? "schoolhouse"}.`,
          "school"
        );
      }
    } catch {
      // one child's enrollment never breaks the tick
    }
  }
}

// --- 4. lessons -------------------------------------------------------------

function teachLessons(kids, rng) {
  for (const kid of kids) {
    try {
      if (!Schools.isEnrolled(kid.id)) continue;
      const before = Schools.pupilOf(kid.id);
      if (!before) continue;
      Schools.recordLesson(kid.id);
      const after = Schools.pupilOf(kid.id);
      // Milestones, journaled once each.
      const milestones = [
        [25, "literacy", "can read simple words now"],
        [50, "literacy", "reads fluently"],
        [25, "numeracy", "can count coin and change"],
        [50, "numeracy", "does sums like a little clerk"],
        [100, "literacy", "has mastered letters"],
        [100, "numeracy", "has mastered numbers"],
      ];
      for (const [mark, field, text] of milestones) {
        if ((before[field] ?? 0) < mark && (after[field] ?? 0) >= mark && rng() < 0.5) {
          journalEvent(kid.display, `${text}.`, "school");
          break;
        }
      }
    } catch {
      // best-effort
    }
  }
}

// --- 5. tuition -------------------------------------------------------------

function collectTuition(director, kids, nowMs) {
  for (const kid of kids) {
    try {
      if (!Schools.isEnrolled(kid.id)) continue;
      const pupil = Schools.pupilOf(kid.id);
      if (!pupil) continue;
      if (nowMs - (pupil.lastTuitionAt ?? 0) < DAY_MS) continue;
      // Free Schooling law: the town covers it.
      if (tuitionWaived(kid.kingdomId, nowMs)) {
        Schools.clearTuitionDebt(kid.id, nowMs);
        continue;
      }
      // Try each parent in turn; the first online parent with coins pays.
      let paid = 0;
      for (const parentName of kid.parents ?? []) {
        const rec = recordFor(director, parentName);
        if (!rec) continue;
        const bot = botFor(director, rec);
        if (!bot) continue;
        paid = takeCoins(bot, Schools.TUITION_PER_DAY);
        if (paid > 0) break;
      }
      if (paid > 0) {
        Schools.clearTuitionDebt(kid.id, nowMs);
        // The teacher's share goes to the schoolmaster's real inventory;
        // the rest funds upkeep.
        const school = Schools.schoolOfKingdom(kid.kingdomId);
        if (school?.teacher) {
          const trec = recordFor(director, school.teacher);
          const tbot = trec ? botFor(director, trec) : null;
          if (tbot) giveCoins(tbot, TEACHER_STIPEND_SHARE);
        }
      } else {
        const debtDays = Schools.addTuitionDebt(kid.id);
        if (debtDays >= Schools.TUITION_DEBT_LIMIT_DAYS) {
          Schools.unenrollPupil(kid.id, "unpaid tuition");
          const parent = kid.parents?.[0];
          if (parent) {
            journalEvent(
              parent,
              `${kid.display} was turned away from school — the tuition went unpaid.`,
              "school"
            );
          }
        }
      }
    } catch {
      // one child's tuition never breaks the tick
    }
  }
}

// --- 6. graduation ----------------------------------------------------------

function graduatePupils(director, announced) {
  const F = families();
  // Scan every enrolled pupil, not just the school-age list — a pupil who
  // just aged out no longer appears in the school-age scan.
  for (const pupil of Schools.allPupils()) {
    try {
      // Graduate when the child outgrows school age by any door.
      let grown = false;
      try {
        const fresh = F?.getChild?.(pupil.childId);
        grown = !fresh || !Schools.isSchoolAgeChild(fresh);
      } catch {
        grown = true;
      }
      if (!grown) continue;
      Schools.graduatePupil(pupil.childId);
      const done = Schools.pupilOf(pupil.childId);
      journalEvent(
        pupil.display,
        `finished schooling — reads at ${done.literacy}, counts at ${done.numeracy}.`,
        "school"
      );
      // The town hears about bright graduates.
      if ((done.literacy + done.numeracy) / 2 >= 70 && !announced.has(pupil.childId)) {
        announced.add(pupil.childId);
        const fresh = F?.getChild?.(pupil.childId);
        const parent = fresh?.parents?.[0];
        if (parent) sayPublicTo(director, parent, `${pupil.display} finished school — top of the class!`);
      }
    } catch {
      // best-effort
    }
  }
}

function tickSchools(director, nowMs) {
  const rng = agentRng(`schools:${Math.floor(nowMs / DAY_MS)}`);
  const records = rosterRecords(director);
  const kids = schoolAgeChildren(director);
  const announced = new Set();
  try {
    foundSchools(kids);
  } catch {
    // best-effort
  }
  try {
    appointTeachers(director, records);
  } catch {
    // best-effort
  }
  try {
    enrollPupils(director, kids);
  } catch {
    // best-effort
  }
  try {
    teachLessons(kids, rng);
  } catch {
    // best-effort
  }
  try {
    collectTuition(director, kids, nowMs);
  } catch {
    // best-effort
  }
  try {
    graduatePupils(director, announced);
  } catch {
    // best-effort
  }
}

module.exports = { tickSchools, COINS };
