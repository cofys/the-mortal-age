"use strict";

/**
 * CitizenLibrarianGuildLife — the slow-tick dynamics for the Librarians' Guild.
 *
 * No-overlap boundary:
 *   - CitizenLibrariesLife owns: library upkeep, loan enforcement, ambient
 *     book writing, archive writing, and announcements.
 *   - CitizenScholarsLife (if any) owns: researcher findings and announcements.
 *   - This owns: guild dues, certification settlement, owed-bounty retries,
 *     plagiarism auto-scan, tribunal settlement, restricted-index
 *     settlement, scriptorium inspections, archive seals, golden-quill
 *     grants, scriptorium-school classes, promotions, and guild
 *     announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenLibrarianGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenPlagiarism = new Set(); // plagiarism keys already auto-reported (per process)

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
  try {
    return record?.getUsername?.() ?? record?.username ?? "";
  } catch { return ""; }
}

function hasItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    const n = inv.getAmount?.(itemId) ?? inv.count?.(itemId) ?? 0;
    return n >= amount;
  } catch { return false; }
}

function removeItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    // Canonical: deleteNumber(id, amount) with balance verification. ItemContainer
    // has no inv.remove(id, amount).
    const before = inv.getAmount?.(itemId) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(itemId, amount);
    return (inv.getAmount?.(itemId) ?? 0) === before - amount;
  } catch { return false; }
}

function announce(director, kingdomId, text, nowMs) {
  try {
    const last = lastAnnounce.get(kingdomId) || 0;
    if (nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    lastAnnounce.set(kingdomId, nowMs);
    const roster = onlineRoster(director);
    const near = roster.find((r) => {
      try {
        const S = sitesApi();
        // Roster records are plain objects WITH a kingdomId field — read it
        // first. The brain's kingdomIdOf falls back to KINGDOM_IDS[0] for
        // anything without the kingdom attribute, so it must only be the
        // live-entity fallback, never the primary read.
        const rkid = r?.kingdomId ||
          (S && typeof S.kingdomIdOf === "function" ? S.kingdomIdOf(r) : null);
        return rkid === kingdomId;
      } catch { return false; }
    });
    const bot = near ? botFor(director, near) : null;
    if (bot && typeof sayPublic === "function") sayPublic(bot, text);
  } catch { /* announcements are best-effort */ }
}

function tickLibrarianGuildLife(director, nowMs = Date.now()) {
  try {
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Guilds.ensureGuild(kid);

      // --- dues from online members (real coins; offline skipped, never penalized)
      const roster = onlineRoster(director);
      for (const record of roster) {
        let rkid = null;
        try {
          const S = sitesApi();
          // Plain roster record: read its own kingdomId first; the brain
          // read is the live-entity fallback (it pins to KINGDOM_IDS[0]
          // for anything without the kingdom attribute).
          rkid = record?.kingdomId ||
            (S && typeof S.kingdomIdOf === "function" ? S.kingdomIdOf(record) : null);
        } catch { rkid = null; }
        if (rkid !== kid) continue;
        const name = usernameOf(record);
        const m = Guilds.memberOf(name);
        if (!m || m.suspended) continue;
        if ((m.duesPaidUntilMs || 0) > nowMs) continue;
        const bot = botFor(director, record);
        if (bot && hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) && removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          // Broke or no inventory — a miss, not a crime. Offline members are
          // never iterated here, so they never accrue misses.
          Guilds.recordMissedDues(name, nowMs);
        }
      }

      // --- retry owed certification bounties as funds refill
      try {
        Guilds.retryOwedBounties(kid);
      } catch { /* never breaks the tick */ }

      // --- plagiarism auto-scan: check recent certifications for copied works
      try {
        const st = Guilds.load();
        for (const cert of Object.values(st.certifications || {})) {
          if (cert.kingdomId !== kid) continue;
          const key = `${kid}:${Guilds.normalizeTitle(cert.title)}`;
          if (seenPlagiarism.has(key)) continue;
          const found = Guilds.scanPlagiarism(cert.title);
          if (found && found.accused.id === cert.id) {
            seenPlagiarism.add(key);
            Guilds.reportPlagiarism(kid, "guild", cert.title);
            announce(director, kid,
              `The Librarians' Guild opened a plagiarism case over "${cert.title}".`, nowMs);
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe tribunal cases
      try {
        const res = Guilds.settleRipeCases(kid, nowMs);
        if (res.settled && res.settled.length) {
          announce(director, kid,
            `The Librarians' Guild settled ${res.settled.length} tribunal case(s).`, nowMs);
        }
      } catch { /* never breaks the tick */ }

      // --- settle ripe restricted-index proposals
      try {
        const res = Guilds.settleRipeRestrictions(kid, nowMs);
        if (res.settled && res.settled.length) {
          const restricted = (Guilds.restrictedList(kid) || []).length;
          announce(director, kid,
            `The Librarians' Guild settled ${res.settled.length} content-standards proposal(s). ` +
            `${restricted} work(s) now sit on the Restricted Index.`, nowMs);
        }
      } catch { /* never breaks the tick */ }

      // --- scriptorium inspections: announce collection audits
      try {
        const insp = Guilds.inspectionFor(kid);
        if (insp.members > 0 && insp.score < 40) {
          announce(director, kid,
            `The Librarians' Guild calls a collection audit — only ${insp.withWorks} of ${insp.members} members have real written works.`, nowMs);
        }
      } catch { /* inspection failure never breaks the tick */ }

      // --- golden quill: quarterly award
      try {
        const r = Guilds.grantGoldenQuill(kid, nowMs);
        if (r.ok) {
          announce(director, kid,
            `${r.winner} wins the golden quill with ${r.books} certified book(s)!`, nowMs);
        }
      } catch { /* quill failure never breaks the tick */ }

      // --- scriptorium school (archivist teaches pages)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_ARCHIVIST);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              // Promotions are attempted for pages/librarians with enough credits.
              for (const n of Guilds.memberNames(kid)) {
                Guilds.tryPromote(n);
              }
            }
          }
        }
      } catch { /* school failure never breaks the tick */ }
    }
  } catch { /* the whole tick never throws */ }
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  lastClass.clear();
  seenPlagiarism.clear();
}

module.exports = {
  tickLibrarianGuildLife,
  resetForTests,
};
