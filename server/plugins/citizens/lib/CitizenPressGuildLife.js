"use strict";

/**
 * CitizenPressGuildLife — the slow-tick dynamics for the press association.
 *
 * No-overlap boundary:
 *   - CitizenPressLife owns: journalist registration, event gathering, story
 *     filing, edition compilation, distribution, announcements.
 *   - This owns: guild dues, ethics-tribunal settlement, Inkwell awards,
 *     journalism-school classes, promotion, press-pass pruning, and guild
 *     announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenPressGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // plagiarism scan window
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenScandal = new Set(); // story ids already auto-reported (per process)

function pressApi() {
  try { return require("./CitizenPress"); } catch { return null; }
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
        Guilds.creditTreasury(m.kingdomId, Guilds.DUES_WEEKLY);
        journal("pressguild-dues", { username, kingdomId: m.kingdomId });
      } else {
        // Broke or no inventory — a miss, not a crime. Offline members are
        // skipped entirely (no penalty for not being around).
        m.missedDues = (m.missedDues || 0) + 1;
        m.duesPaidUntil = nowMs + Guilds.DUES_PERIOD_MS;
        if (m.missedDues >= Guilds.SUSPEND_AFTER_MISSED) {
          m.suspended = true;
          m.suspendUntil = 0; // lifted by paying dues via command
          journal("pressguild-suspended", { username, kingdomId: m.kingdomId, reason: "dues" });
        }
      }
    }
  } catch { /* dues never break the tick */ }
}

// --- ethics: automatic plagiarism scan + tribunal settlement -------------------

function scanForPlagiarism(director, nowMs) {
  try {
    const P = pressApi();
    if (!P) return;
    for (const kid of kingdomIds()) {
      for (const beat of P.BEATS || []) {
        let stories = [];
        try { stories = P.storiesFor(kid, beat, SCAN_WINDOW_MS) || []; } catch { stories = []; }
        for (const s of stories) {
          if (seenScandal.has(String(s.id))) continue;
          seenScandal.add(String(s.id));
          try {
            const check = Guilds.verifyPlagiarism(s.id);
            if (check.ok && check.plagiarized) {
              const r = Guilds.reportViolation("guild", s.author, Guilds.VIOLATION_PLAGIARISM, s.id, nowMs);
              if (r.ok) journal("pressguild-case-opened", { caseId: r.id, accused: s.author, type: "plagiarism" });
            }
          } catch { /* one bad story never breaks the scan */ }
        }
      }
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
        journal("pressguild-verdict", { caseId: c.id, accused: c.accused, verdict: res.verdict, sanction: res.sanction });
        if (res.verdict === "guilty" && res.sanction === "expulsion") {
          awardDeed(c.accused, "fabricator");
          announce(director, kid, `${c.accused} has been expelled from the press guild for fabrication. The code is the trade.`, nowMs);
        } else if (res.verdict === "guilty") {
          announce(director, kid, `${c.accused} was found guilty of plagiarism by the press tribunal — fined and suspended.`, nowMs);
        }
      } catch { /* one bad case never breaks the tribunal */ }
    }
  } catch { /* the tribunal never breaks the tick */ }
}

// --- Inkwell awards ---------------------------------------------------------------

function grantAwards(director, nowMs) {
  try {
    const P = pressApi();
    if (!P) return;
    for (const kid of kingdomIds()) {
      for (const beat of P.BEATS || []) {
        try {
          const res = Guilds.grantAward(kid, beat, nowMs);
          if (!res.ok) continue;
          const a = res.award;
          journal("pressguild-award", { awardId: a.id, kingdomId: kid, beat, winner: a.winner });
          awardDeed(a.winner, "presslaureate");
          payPrize(director, a);
          announce(director, kid, `The Inkwell goes to ${a.winner} for ${beat} reporting! ${a.prize} coins and the guild's highest honor.`, nowMs);
        } catch { /* one bad award never breaks the cycle */ }
      }
    }
  } catch { /* awards never break the tick */ }
}

function payPrize(director, award) {
  try {
    if (!(award.prizeOwed > 0)) return;
    for (const record of onlineRoster(director)) {
      if (norm2(usernameOf(record)) !== norm2(award.winner)) continue;
      const bot = botFor(director, record);
      if (!bot) continue;
      if (!Guilds.debitTreasury(award.kingdomId, award.prizeOwed)) continue;
      if (!addCoins(bot, award.prizeOwed)) {
        Guilds.creditTreasury(award.kingdomId, award.prizeOwed);
        continue;
      }
      journal("pressguild-prize-paid", { awardId: award.id, winner: award.winner, amount: award.prizeOwed });
      award.prizeOwed = 0;
      return;
    }
  } catch { /* owed prizes wait for the next tick */ }
}

function norm2(name) {
  return String(name || "").trim().toLowerCase();
}

// --- journalism school -------------------------------------------------------------

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
          if (rank === Guilds.RANK_EDITOR && !master && Guilds.isGuildMember(username)) master = username;
          else if (rank === Guilds.RANK_STRINGER && Guilds.isGuildMember(username)) pupils.push(username);
        }
        if (!master || !pupils.length) continue;
        const res = Guilds.holdClass(master, pupils, kid, nowMs);
        if (!res.ok) continue;
        lastClass.set(kid, nowMs);
        journal("pressguild-class", { master, pupils: res.pupils, kingdomId: kid });
        // Opportunistic promotions after class.
        for (const u of [master, ...res.pupils]) {
          try {
            const p = Guilds.promote(u, nowMs);
            if (p.ok) {
              journal("pressguild-promotion", { username: u, rank: p.to });
              announce(director, kid, `${u} has been promoted to ${p.to} of the press guild!`, nowMs);
            }
          } catch { /* promotion is optional */ }
        }
      } catch { /* one bad kingdom never breaks the school */ }
    }
  } catch { /* the school never breaks the tick */ }
}

// --- main tick ------------------------------------------------------------------------

function tickPressGuildLife(director, nowMs) {
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
    scanForPlagiarism(director, nowMs);
    settleTribunal(director, nowMs);
    grantAwards(director, nowMs);
    payOwedPrizes(director);
    holdSchool(director, nowMs);
    try { Guilds.prunePasses(nowMs); } catch { /* passes are optional */ }
    try { Guilds.save(); } catch { /* save is best-effort */ }
  } catch { /* the guild tick never breaks the director */ }
}

function payOwedPrizes(director) {
  try {
    for (const kid of kingdomIds()) {
      for (const a of Guilds.awardsFor(kid)) {
        if (a.prizeOwed > 0) payPrize(director, a);
      }
    }
  } catch { /* owed prizes wait */ }
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  lastClass.clear();
  seenScandal.clear();
}

module.exports = { tickPressGuildLife, resetForTests };
