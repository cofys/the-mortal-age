"use strict";

/**
 * CitizenBankingLife — slow-tick dynamics for the REAL banking layer.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenBankers owns hash-derived banker flavor (teller dialogue, vault
 *     heat, suspicion, wall-clock hours).
 *   - CitizenBankers2 owns hash-derived moneyfolk flavor (exchange rates,
 *     assay, pawn tickets).
 *   - THIS module owns the real-economy tick: interest accrual on savings
 *     and treasury deposits, loan interest, overdue reminders, default
 *     processing (reputation hit + guard report), banker appointment from
 *     the real roster, and announcements near real players.
 *
 * All coin movement is real (inventories, treasury). Never throws.
 * Zero LLM. Dirty-flag persistence via CitizenBanking.save().
 */

const Banking = require("./CitizenBanking");

function safeTick(director, fn, label) {
  try {
    fn(director);
  } catch (error) {
    try {
      director?.log?.(`${label} failed`, { error: String(error?.message ?? error) });
    } catch { /* never throw */ }
  }
}

function anyRealPlayerNear(director, bot, radius) {
  try {
    const players = director?.getLocalPlayers?.(bot) ?? [];
    return players.some((p) => !p?.isBot && !p?.isCitizen);
  } catch {
    return false;
  }
}

function announce(director, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    // Find any online citizen near a real player to make the announcement.
    for (const record of director?.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
        if (!bot) continue;
        if (!anyRealPlayerNear(director, bot, 20)) continue;
        sayPublic(bot, text);
        try {
          director.getJournal?.().log?.("banking", text);
        } catch { /* journal optional */ }
        return true;
      } catch { /* next citizen */ }
    }
  } catch { /* sayPublic optional */ }
  return false;
}

/**
 * Appoint bankers from the real roster: citizens in the banker career,
 * one per kingdom branch that lacks one.
 */
function appointBankers(director, nowMs) {
  const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"];
  for (const kid of kingdoms) {
    if (Banking.bankersIn(kid).length > 0) continue;
    // Find an online citizen in the banker career for this kingdom.
    for (const record of director?.roster?.values?.() ?? []) {
      try {
        if (!record) continue;
        let career = null;
        let rKingdom = null;
        try {
          const Careers = require("./CitizenCareers");
          career = Careers.careerOf?.(record.username);
        } catch { /* careers optional */ }
        if (career !== "banker") continue;
        try {
          const { kingdomIdOf } = require("../brain/CitizenSites");
          rKingdom = kingdomIdOf(record.username);
        } catch { /* sites optional */ }
        if (rKingdom !== kid) continue;
        Banking.registerBanker(record.username, kid);
        break;
      } catch { /* next citizen */ }
    }
  }
}

/**
 * Process loan defaults: 60+ days overdue → reputation hit + guard report.
 */
function processDefaults(director, nowMs) {
  const st = Banking._data();
  for (const key of Object.keys(st.loans)) {
    const loan = st.loans[key];
    if (!loan || loan.owed <= 0) continue;
    if (!Banking.isDefaulted(key, nowMs)) continue;
    if (loan.defaulted) continue; // already processed
    loan.defaulted = true;
    // Reputation hit.
    try {
      const Rep = require("./CitizenReputation");
      Rep.addDeed?.(key, "defaulter", -8);
    } catch { /* reputation optional */ }
    // Report to the watch.
    try {
      const Crime = require("./CitizenCrime");
      Crime.reportOffense?.({
        citizen: key,
        kind: "debt-default",
        severity: 2,
        kingdom: null,
        witnessed: false,
        victim: "bank",
      }, nowMs);
    } catch { /* crime optional */ }
    announce(director, `${key} has defaulted on a bank loan of ${loan.owed} coins.`);
  }
}

/**
 * Remind overdue borrowers near real players.
 */
function remindOverdue(director, nowMs) {
  const st = Banking._data();
  let reminded = 0;
  for (const key of Object.keys(st.loans)) {
    const loan = st.loans[key];
    if (!loan || loan.owed <= 0) continue;
    if (!Banking.isOverdue(key, nowMs)) continue;
    if (loan.lastReminder && nowMs - loan.lastReminder < 24 * 3600 * 1000) continue;
    loan.lastReminder = nowMs;
    reminded++;
  }
  if (reminded > 0) {
    announce(director, `The bank reminds ${reminded} borrower${reminded > 1 ? "s" : ""}: loans are overdue.`);
  }
}

function tickBankingLife(director, nowMs) {
  safeTick(director, () => {
    Banking.accrueInterest(nowMs);
    Banking.accrueLoanInterest(nowMs);
  }, "banking-interest");
  safeTick(director, (d) => appointBankers(d, nowMs), "banking-appoint");
  safeTick(director, (d) => processDefaults(d, nowMs), "banking-defaults");
  safeTick(director, (d) => remindOverdue(d, nowMs), "banking-reminders");
}

module.exports = { tickBankingLife };
