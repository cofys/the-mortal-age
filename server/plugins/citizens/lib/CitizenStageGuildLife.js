"use strict";

/**
 * CitizenStageGuildLife — the slow-tick dynamics for the Players' Guild.
 *
 * No-overlap boundary:
 *   - CitizenTheaterLife owns: playwright registration, ambient playwriting,
 *     troupe formation, touring, performance settlement.
 *   - This owns: guild dues, certification queue settlement, plagiarism
 *     auto-scan, tribunal settlement, touring-circuit ledger + claims,
 *     critics' choice laurels, stage-school classes, promotion, owed-bounty
 *     retries, and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenStageGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenPlagiarism = new Set(); // "kingdom:playId" already auto-reported (per process)

function sitesApi() {
  try { return require("../brain/CitizenSites"); }
  catch { return null; }
}

function theaterApi() {
  try { return require("./CitizenTheater"); }
  catch { return null; }
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
  try {
    return record?.getUsername?.() ?? record?.username ?? "";
  } catch { return ""; }
}

function kingdomOf(record) {
  try {
    const S = sitesApi();
    return S && typeof S.kingdomIdOf === "function" ? S.kingdomIdOf(record) : null;
  } catch { return null; }
}

function hasCoins(bot, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    const n = inv.getAmount?.(Guilds.COINS_ID) ?? inv.count?.(Guilds.COINS_ID) ?? 0;
    return n >= amount;
  } catch { return false; }
}

function takeCoins(bot, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    // Canonical: deleteNumber(id, amount) with balance verification. ItemContainer
    // has no inv.remove(id, amount).
    const before = inv.getAmount?.(Guilds.COINS_ID) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(Guilds.COINS_ID, amount);
    return (inv.getAmount?.(Guilds.COINS_ID) ?? 0) === before - amount;
  } catch { return false; }
}

function announce(director, kingdomId, text, nowMs) {
  try {
    const last = lastAnnounce.get(kingdomId) || 0;
    if (nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    lastAnnounce.set(kingdomId, nowMs);
    const roster = onlineRoster(director);
    const near = roster.find((r) => kingdomOf(r) === kingdomId);
    const bot = near ? botFor(director, near) : null;
    if (bot && typeof sayPublic === "function") sayPublic(bot, text);
  } catch { /* announcements are best-effort */ }
}

function tickStageGuildLife(director, nowMs = Date.now()) {
  try {
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Guilds.ensureGuild(kid);

      // --- dues from online members (real coins; offline skipped, never penalized)
      const roster = onlineRoster(director);
      for (const record of roster) {
        if (kingdomOf(record) !== kid) continue;
        const name = usernameOf(record);
        const m = Guilds.memberOf(name);
        if (!m || m.suspended) continue;
        if ((m.duesPaidUntilMs || 0) > nowMs) continue;
        const bot = botFor(director, record);
        if (bot && hasCoins(bot, Guilds.DUES_WEEKLY) && takeCoins(bot, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          // Broke or no inventory — a miss, not a crime. Offline members are
          // never iterated here, so they never accrue misses.
          Guilds.recordMissedDues(name, nowMs);
        }
      }

      // --- certification: auto-submit members' worthy unsealed plays, then settle
      try {
        const T = theaterApi();
        if (T && typeof T.playsBy === "function") {
          const guildMembers = roster.map(usernameOf).filter((n) => Guilds.isGuildMember(n) && kingdomOf(roster.find((r) => usernameOf(r) === n)) === kid);
          for (const name of guildMembers.slice(0, 3)) { // cap per tick
            let plays = [];
            try { plays = T.playsBy(name) || []; } catch { continue; }
            const worthy = plays.find((p) => (p.quality || 0) >= 5 && !Guilds.sealFor(p.id));
            if (worthy) {
              const bot = botFor(director, roster.find((r) => usernameOf(r) === name));
              if (bot && hasCoins(bot, Guilds.CERT_FEE) && takeCoins(bot, Guilds.CERT_FEE)) {
                Guilds.submitForCertification(worthy.id, name, kid);
              }
            }
          }
        }
        const settled = Guilds.settleQueue(nowMs);
        for (const s of settled) {
          if (s.ok && s.grade === "A") {
            announce(director, kid, `The Players' Guild certified "${s.seal.title}" — a masterwork of the stage.`, nowMs);
          }
        }
        Guilds.retryOwedBounties(kid);
      } catch { /* certification failure never breaks the tick */ }

      // --- plagiarism auto-scan (verifiable against real play records)
      try {
        for (const cand of Guilds.plagiarismScan()) {
          if (norm(cand.kingdomId) !== kid) continue;
          const key = `${kid}:${cand.playId}`;
          if (seenPlagiarism.has(key)) continue;
          seenPlagiarism.add(key);
          const res = Guilds.reportPlagiarism(kid, cand.playId, "guild");
          if (res.ok) {
            announce(director, kid,
              `The Players' Guild opened a plagiarism case over "${cand.title}".`, nowMs);
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe tribunal cases
      try {
        const settled = Guilds.settleRipeCases(kid, nowMs);
        for (const c of settled) {
          if (c.status === "guilty") {
            announce(director, kid,
              `${c.accused} was expelled from the Players' Guild for plagiarism.`, nowMs);
          }
        }
      } catch { /* never breaks the tick */ }

      // --- touring-circuit ledger + auto-claim check
      try {
        Guilds.noteTroupeLocations(nowMs);
        for (const circuit of Guilds.circuitsFor(kid, true)) {
          // find a real troupe currently in the target with a guild member
          const T = theaterApi();
          if (!T || typeof T.troupesIn !== "function") break;
          const S = sitesApi();
          const kids = (S && Array.isArray(S.KINGDOM_IDS)) ? S.KINGDOM_IDS : [];
          let claimed = false;
          for (const kk of kids) {
            for (const t of T.troupesIn(kk) || []) {
              const res = Guilds.claimCircuit(circuit.id, t.name, "guild");
              if (res.ok) {
                announce(director, kid,
                  `${t.name} completed the guild's touring circuit to ${circuit.targetKingdom} — ${res.bounty} coins to their treasury.`, nowMs);
                claimed = true;
                break;
              }
            }
            if (claimed) break;
          }
        }
      } catch { /* circuit failure never breaks the tick */ }

      // --- critics' choice laurel (quarterly)
      try {
        const res = Guilds.grantLaurel(kid, nowMs);
        if (res.ok) {
          announce(director, kid,
            `The critics' choice laurel goes to ${res.laurel.troupe} — ${res.laurel.fiveStarCount} acclaimed shows this season.`, nowMs);
        }
      } catch { /* laurel failure never breaks the tick */ }

      // --- stage school (stagemaster teaches players)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) =>
            Guilds.guildRankOf(n) === Guilds.RANK_STAGEMASTER && kingdomOf(roster.find((r) => usernameOf(r) === n)) === kid);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              for (const record of roster) {
                if (kingdomOf(record) === kid) Guilds.tryPromote(usernameOf(record), nowMs);
              }
            }
          }
        }
      } catch { /* school failure never breaks the tick */ }
    }
  } catch { /* the whole tick never throws */ }
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  lastClass.clear();
  seenPlagiarism.clear();
}

module.exports = {
  tickStageGuildLife,
  resetForTests,
};
