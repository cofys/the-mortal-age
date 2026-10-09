"use strict";

/**
 * CitizenBankGuildLife — the slow-tick dynamics for the bankers' association.
 *
 * No-overlap boundary:
 *   - CitizenBankingLife owns: interest accrual, banker appointment, loan
 *     defaults, overdue reminders.
 *   - This owns: guild dues, insurance-premium collection, branch audits,
 *     tribunal settlement, insurance-claim filing and payout, banker-school
 *     classes, promotion, coverage pruning, and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenBankGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenTamper = new Set(); // tampered record ids already auto-reported (per process)

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

function sitesApi() {
  try { return require("../brain/CitizenSites"); } catch { return null; }
}

function kingdomIds() {
  try {
    const S = sitesApi();
    if (S && Array.isArray(S.KINGDOM_IDS) && S.KINGDOM_IDS.length) return S.KINGDOM_IDS.slice();
  } catch { /* fall through */ }
  return [];
}

function onlineRoster(director) {
  try {
    const roster = director.roster?.values?.() ?? director.roster ?? [];
    const arr = Array.isArray(roster) ? roster : [...roster];
    return arr.filter((r) => {
      try { return director.isOnline ? director.isOnline(r) : true; }
      catch { return false; }
    });
  } catch { return []; }
}

function botFor(director, record) {
  try {
    return director.isOnline?.(record) ? director.getBot?.(record) : null;
  } catch { return null; }
}

function usernameOf(record) {
  return record?.username || record?.name || null;
}

function kingdomIdOf(record) {
  try {
    const { kingdomIdOf } = require("../brain/CitizenSites");
    return kingdomIdOf(record) || record.kingdomId || null;
  } catch { return record?.kingdomId || null; }
}

function hasItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    if (typeof inv.count === "function") return inv.count(itemId) >= amount;
    if (Array.isArray(inv.items)) {
      return inv.items.filter((i) => (i?.id ?? i) === itemId).length >= amount;
    }
    return false;
  } catch { return false; }
}

function removeItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    if (typeof inv.remove === "function") { inv.remove(itemId, amount); return true; }
    if (typeof inv.delete === "function") { inv.delete(itemId, amount); return true; }
    return false;
  } catch { return false; }
}

function addCoins(bot, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv || typeof inv.add !== "function") return false;
    inv.add(Guilds.COINS_ID, amount);
    return true;
  } catch { return false; }
}

function awardDeed(username, deedKind) {
  try {
    const Rep = require("./CitizenReputation");
    Rep.awardDeed?.(username, deedKind);
  } catch { /* fame is optional */ }
}

function journal(kind, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log?.(kind, data);
  } catch { /* journal optional */ }
}

function announce(director, kingdomId, message, nowMs) {
  try {
    const last = lastAnnounce.get(kingdomId) ?? 0;
    if (last > 0 && nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    let bot = null;
    for (const record of onlineRoster(director)) {
      if (kingdomIdOf(record) !== kingdomId) continue;
      const b = botFor(director, record);
      if (b) { bot = b; break; }
    }
    if (!bot) return;
    sayPublic(bot, message);
    lastAnnounce.set(kingdomId, nowMs);
  } catch { /* speech failed — skip */ }
}

// --- dues ---------------------------------------------------------------------

function collectDues(director, nowMs) {
  try {
    for (const record of onlineRoster(director)) {
      const username = usernameOf(record);
      if (!username) continue;
      const m = Guilds.memberOf(username);
      if (!m || m.suspended || m.expelled) continue;
      if ((m.duesPaidUntil ?? 0) > nowMs) continue;
      const bot = botFor(director, record);
      if (bot && hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) && removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
        m.duesPaidUntil = nowMs + Guilds.DUES_PERIOD_MS;
        m.missedDues = 0;
        Guilds.creditTreasury(m.kingdomId, Guilds.DUES_WEEKLY - Guilds.DUES_INSURANCE_SHARE);
        Guilds.creditInsuranceFund(m.kingdomId, Guilds.DUES_INSURANCE_SHARE);
        journal("bankguild-dues", { username, kingdomId: m.kingdomId });
      } else {
        // Broke or no inventory — a miss, not a crime. Offline members are
        // skipped entirely (no penalty for not being around).
        m.missedDues = (m.missedDues || 0) + 1;
        m.duesPaidUntil = nowMs + Guilds.DUES_PERIOD_MS;
        if (m.missedDues >= Guilds.SUSPEND_AFTER_MISSED) {
          m.suspended = true;
          m.suspendUntil = 0; // lifted by paying dues via command
          journal("bankguild-suspended", { username, kingdomId: m.kingdomId, reason: "dues" });
        }
      }
    }
  } catch { /* dues never break the tick */ }
}

// --- insurance premiums --------------------------------------------------------

/**
 * Collect monthly deposit-insurance premiums from online citizens who hold
 * real bank accounts. Coverage lapses honestly when unpaid — the guild
 * never invents coverage.
 */
function collectPremiums(director, nowMs) {
  try {
    const B = bankingApi();
    if (!B) return;
    for (const record of onlineRoster(director)) {
      const username = usernameOf(record);
      if (!username) continue;
      if (Guilds.isCovered(username, nowMs)) continue;
      const premium = Guilds.premiumFor(username);
      if (!(premium > 0)) continue;
      const bot = botFor(director, record);
      if (!bot) continue;
      if (!hasItem(bot, Guilds.COINS_ID, premium)) continue; // cannot pay — no coverage
      if (!removeItem(bot, Guilds.COINS_ID, premium)) continue;
      let kid = null;
      try { kid = kingdomIdOf(record); } catch { kid = null; }
      if (!kid) {
        // No kingdom — refund honestly rather than inventing a destination.
        addCoins(bot, premium);
        continue;
      }
      Guilds.creditInsuranceFund(kid, premium);
      Guilds.markCovered(username, nowMs);
      journal("bankguild-premium", { username, kingdomId: kid, premium });
    }
  } catch { /* premiums never break the tick */ }
}

// --- audits -----------------------------------------------------------------------

function runAudits(director, nowMs) {
  try {
    for (const kid of kingdomIds()) {
      try {
        const g = Guilds.ensureGuild(kid);
        if (!g) continue;
        if (g.branch.lastAuditAt > 0 && nowMs - g.branch.lastAuditAt < Guilds.AUDIT_PERIOD_MS) continue;
        // Prefer an online auditor-rank member; otherwise the guild
        // auto-audits (the ledger is public to the guild).
        let auditor = "guild";
        for (const record of onlineRoster(director)) {
          if (kingdomIdOf(record) !== kid) continue;
          const username = usernameOf(record);
          if (!username) continue;
          const m = Guilds.memberOf(username);
          if (m && m.rank === Guilds.RANK_AUDITOR && !m.suspended) { auditor = username; break; }
        }
        const res = Guilds.conductAudit(kid, auditor, nowMs);
        if (!res.ok) continue;
        const a = res.audit;
        journal("bankguild-audit", {
          auditId: a.id, kingdomId: kid, auditor: a.auditor,
          verdict: a.verdict, leverage: a.leverage, defaultRate: a.defaultRate,
        });
        if (a.verdict === "pass") {
          if (auditor !== "guild") {
            awardDeed(auditor, "vaultkeeper");
            announce(director, kid, `${auditor} has certified the ${kid} bank — the guild's seal of sound banking.`, nowMs);
          }
        } else if (res.branchStatus === "failed") {
          const fr = Guilds.fileFailureClaims(kid, nowMs);
          journal("bankguild-branch-failed", { kingdomId: kid, claimsFiled: fr.ok ? fr.filed : 0 });
          announce(director, kid, `The guild has declared the ${kid} bank FAILED. Covered depositors: file your claims — the insurance fund stands behind you.`, nowMs);
        } else {
          announce(director, kid, `The guild has flagged the ${kid} bank: ${a.reasons.join("; ")}. The bankers must set it right.`, nowMs);
        }
      } catch { /* one bad kingdom never breaks the audits */ }
    }
  } catch { /* audits never break the tick */ }
}

// --- insurance claims ------------------------------------------------------------------

function payClaims(director, nowMs) {
  try {
    for (const kid of kingdomIds()) {
      for (const c of Guilds.openClaims(kid)) {
        try {
          const res = Guilds.payClaim(c.id);
          if (!res.ok) continue;
          journal("bankguild-claim-paid", {
            claimId: c.id, kingdomId: kid, depositor: c.depositor,
            paid: res.paid, owed: res.owed,
          });
        } catch { /* one bad claim never breaks payouts */ }
      }
    }
  } catch { /* claims never break the tick */ }
}

// --- ethics: tamper scan + tribunal settlement -------------------------------------------------

function scanForTampering(director, nowMs) {
  try {
    for (const t of Guilds.findTamperedRecords()) {
      const rid = `${t.kind}:${t.id}`;
      if (seenTamper.has(rid)) continue;
      seenTamper.add(rid);
      try {
        const r = Guilds.reportViolation("guild", t.id, Guilds.VIOLATION_TAMPERING, nowMs);
        if (r.ok) journal("bankguild-case-opened", { caseId: r.id, accused: t.id, type: "tampering" });
      } catch { /* one bad record never breaks the scan */ }
    }
  } catch { /* the scan never breaks the tick */ }
}

function settleTribunal(director, nowMs) {
  try {
    for (const c of Guilds.openCases()) {
      try {
        if (nowMs - (c.filedAt ?? 0) < Guilds.CASE_SETTLE_MS) continue;
        const res = Guilds.settleCase(c.id, nowMs);
        if (!res.ok) continue;
        const kid = Guilds.guildKingdomOf(c.accused);
        journal("bankguild-verdict", { caseId: c.id, accused: c.accused, verdict: res.verdict, sanction: res.sanction });
        if (res.verdict === "guilty") {
          awardDeed(c.accused, "embezzler");
          announce(director, kid, `${c.accused} has been expelled from the bankers' guild for ledger tampering. The ledger is sacred.`, nowMs);
        }
      } catch { /* one bad case never breaks the tribunal */ }
    }
  } catch { /* the tribunal never breaks the tick */ }
}

// --- banker school ------------------------------------------------------------------------------

function holdSchool(director, nowMs) {
  try {
    for (const kid of kingdomIds()) {
      try {
        const last = lastClass.get(kid) ?? 0;
        if (last > 0 && nowMs - last < CLASS_COOLDOWN_MS) continue;
        let master = null;
        const pupils = [];
        for (const record of onlineRoster(director)) {
          if (kingdomIdOf(record) !== kid) continue;
          const username = usernameOf(record);
          if (!username) continue;
          const rank = Guilds.guildRankOf(username);
          if (rank === Guilds.RANK_AUDITOR && !master && Guilds.isGuildMember(username)) master = username;
          else if (rank === Guilds.RANK_CLERK && Guilds.isGuildMember(username)) pupils.push(username);
        }
        if (!master || !pupils.length) continue;
        const res = Guilds.holdClass(master, pupils, kid, nowMs);
        if (!res.ok) continue;
        lastClass.set(kid, nowMs);
        journal("bankguild-class", { master, pupils: res.pupils, kingdomId: kid });
        for (const u of [master, ...res.pupils]) {
          try {
            const p = Guilds.promote(u, nowMs);
            if (p.ok) {
              journal("bankguild-promotion", { username: u, rank: p.to });
              announce(director, kid, `${u} has been promoted to ${p.to} of the bankers' guild!`, nowMs);
            }
          } catch { /* promotion is optional */ }
        }
      } catch { /* one bad kingdom never breaks the school */ }
    }
  } catch { /* the school never breaks the tick */ }
}

// --- main tick ------------------------------------------------------------------------

function tickBankGuildLife(director, nowMs) {
  try {
    for (const kingdomId of kingdomIds()) {
      try {
        const last = lastTick.get(kingdomId) || 0;
        if (last > 0 && nowMs - last < TICK_COOLDOWN_MS) continue; // first run always allowed
        lastTick.set(kingdomId, nowMs);
        Guilds.ensureGuild(kingdomId);
      } catch { /* one bad kingdom never breaks the tick */ }
    }
    collectDues(director, nowMs);
    collectPremiums(director, nowMs);
    runAudits(director, nowMs);
    payClaims(director, nowMs);
    scanForTampering(director, nowMs);
    settleTribunal(director, nowMs);
    holdSchool(director, nowMs);
    try { Guilds.pruneCoverage(nowMs); } catch { /* coverage optional */ }
    try { Guilds.save(); } catch { /* save is best-effort */ }
  } catch { /* the guild tick never breaks the director */ }
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  lastClass.clear();
  seenTamper.clear();
}

module.exports = { tickBankGuildLife, resetForTests };
