"use strict";

/**
 * CitizenTradeGuildLife — the slow-tick dynamics for the merchants' association.
 *
 * No-overlap boundary:
 *   - CitizenGuilds owns: generic guild membership/ranks/missions/rivalry.
 *   - CitizenTradeCharters owns: monopoly charters/tolls.
 *   - CitizenTradeCaravans owns: caravan muster/journey/settlement.
 *   - CitizenMarketStalls owns: stall setup/sales/haggling.
 *   - This owns: association dues, market licenses, weights-and-measures
 *     inspections, manifest certification upkeep, trade fairs, tribunal
 *     settlement, merchant-school classes, and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenTradeGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp

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

function kingdomOf(record) {
  try {
    const S = sitesApi();
    return S && typeof S.kingdomIdOf === "function" ? S.kingdomIdOf(record) : null;
  } catch { return null; }
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

const COINS_ID = 995;

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

function marketStallsApi() {
  try { return require("./CitizenMarketStalls"); } catch { return null; }
}

const ATTR_MARKET_WARES = "citizens:market-wares";

function waresOf(bot) {
  try {
    const MS = marketStallsApi();
    const raw = bot?.getAttribute?.(ATTR_MARKET_WARES);
    if (MS && typeof MS.parseMarketWares === "function") return MS.parseMarketWares(raw);
    if (!raw) return null;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    return list.filter((w) => w && Number(w.id) > 0 && Number(w.price) > 0);
  } catch { return null; }
}

function referencePrice(director, itemId) {
  try {
    const MS = marketStallsApi();
    if (MS && typeof MS.referencePrice === "function") return MS.referencePrice(director, itemId);
  } catch { /* fall through */ }
  return 1;
}

function tickTradeGuildLife(director, nowMs = Date.now()) {
  try {
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Guilds.ensureGuild(kid);

      const roster = onlineRoster(director);

      // --- dues from online members (real coins; offline skipped, never penalized)
      for (const record of roster) {
        if (kingdomOf(record) !== kid) continue;
        const name = usernameOf(record);
        const m = Guilds.memberOf(name);
        if (!m || m.suspended) continue;
        if ((m.duesPaidUntilMs || 0) > nowMs) continue;
        const bot = botFor(director, record);
        if (bot && hasItem(bot, COINS_ID, Guilds.DUES_WEEKLY) && removeItem(bot, COINS_ID, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          Guilds.recordMissedDues(name, nowMs);
        }
      }

      // --- weights & measures: merchantmasters inspect active stalls
      try {
        const inspector = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_MASTER);
        if (inspector) {
          for (const record of roster) {
            if (kingdomOf(record) !== kid) continue;
            const name = usernameOf(record);
            if (!name || Guilds.isGuildMember(name)) continue; // members police others
            const bot = botFor(director, record);
            const wares = bot ? waresOf(bot) : null;
            if (!wares || wares.length === 0) continue;
            const result = Guilds.inspectWares(wares, (id) => referencePrice(director, id));
            Guilds.recordInspection(kid, inspector, name, result, nowMs);
            if (!result.pass) {
              Guilds.reportMisconduct(kid, name, Guilds.CASE_GOUGING, inspector, { violation: true });
              announce(director, kid,
                `The merchants' association fined ${name}'s stall for price gouging.`, nowMs);
            }
          }
        }
      } catch { /* inspection failure never breaks the tick */ }

      // --- unlicensed trading scan: stalls without a guild license
      try {
        for (const record of roster) {
          if (kingdomOf(record) !== kid) continue;
          const name = usernameOf(record);
          if (!name) continue;
          const bot = botFor(director, record);
          const wares = bot ? waresOf(bot) : null;
          if (!wares || wares.length === 0) continue;
          if (!Guilds.licenseFor(name, nowMs).valid) {
            Guilds.reportMisconduct(kid, name, Guilds.CASE_UNLICENSED, null, { stallActive: true });
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe tribunal cases
      try {
        const settled = Guilds.settleRipeCases(kid, nowMs);
        for (const s of settled) {
          if (s.guilty) {
            announce(director, kid,
              `The merchants' association convicted ${s.accused} of ${s.kind === Guilds.CASE_GOUGING ? "price gouging" : "unlicensed trading"}.`,
              nowMs);
          }
        }
      } catch { /* never breaks the tick */ }

      // --- trade fair: schedule quarterly, resolve when entries exist
      try {
        if (Guilds.fairDue(kid, nowMs)) {
          // Auto-enter online licensed stallholders; entry fees taken honestly.
          let entered = 0;
          for (const record of roster) {
            if (kingdomOf(record) !== kid) continue;
            const name = usernameOf(record);
            const bot = botFor(director, record);
            const wares = bot ? waresOf(bot) : null;
            if (!wares || wares.length === 0) continue;
            if (!Guilds.licenseFor(name, nowMs).valid) continue;
            if (bot && hasItem(bot, COINS_ID, Guilds.FAIR_ENTRY_FEE) && removeItem(bot, COINS_ID, Guilds.FAIR_ENTRY_FEE)) {
              Guilds.enterFair(kid, name);
              entered += 1;
            }
            if (entered >= 12) break; // cap the fair
          }
          if (entered > 0) {
            const r = Guilds.resolveFair(kid, null, nowMs);
            if (r.ok && r.winner) {
              announce(director, kid,
                `The trade fair crowns ${r.winner}'s stall the fairest in the kingdom!`, nowMs);
            }
          } else {
            // No fair this quarter — reset the clock honestly.
            Guilds.ensureGuild(kid).lastFairAtMs = nowMs;
            Guilds.markDirty();
          }
        }
      } catch { /* fair failure never breaks the tick */ }

      // --- merchant school (merchantmaster teaches peddlers)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_MASTER);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              const g = Guilds.guildOf(kid);
              if (g) {
                for (const n of Object.keys(g.members)) {
                  if (g.members[n].rank === Guilds.RANK_PEDDLER) Guilds.tryPromote(n, nowMs);
                }
              }
            }
          }
        }
      } catch { /* school failure never breaks the tick */ }

      // --- retry honestly-owed fair prizes (banking may have been down)
      try {
        Guilds.retryFairOwed(kid);
      } catch { /* retry failure never breaks the tick */ }
    }
  } catch { /* the whole tick never throws */ }
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  lastClass.clear();
}

module.exports = {
  tickTradeGuildLife,
  resetForTests,
};
