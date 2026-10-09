"use strict";

/**
 * CitizenTradeCharterLife — the slow tick for trade charters.
 *
 * WHAT IT DOES (runs on the director's slow tick, never throws):
 *   - Renewal: charters within 24h of expiry auto-renew when the guild
 *     treasury can afford RENEWAL_FEE (real tracked coins, debited honestly).
 *   - Lapse: expired charters that weren't renewed are revoked — the market
 *     reopens. The guild must petition anew (no silent resurrection).
 *   - War revocation: when the war layer reports a kingdom at war (defensive
 *     read), that kingdom's charters are revoked — trade monopolies don't
 *     survive sieges.
 *   - Announcements: renewals, lapses, and war revocations are journaled
 *     and announced via sayPublic.
 *
 * Zero LLM. Every engine read guarded. Never throws.
 */

const Charters = require("./CitizenTradeCharters");

const CHECK_MS = 6 * 60 * 60 * 1000; // per-charter check throttle
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000; // renew within 24h of expiry

let lastCheck = Object.create(null);

function resetForTests() {
  lastCheck = Object.create(null);
}

function kingdomAtWar(kingdomId) {
  try {
    const W = require("./CitizenWarfare");
    if (typeof W.kingdomAtWar === "function") return !!W.kingdomAtWar(kingdomId);
    if (typeof W.warFor === "function") return !!W.warFor(kingdomId);
  } catch {
    // war layer unreachable — charters stand
  }
  return false;
}

function journalFact(kind, data) {
  try {
    const J = require("./CitizenJournal");
    if (typeof J.journal === "function") J.journal(kind, data);
    else if (typeof J.record === "function") J.record(kind, data);
  } catch {
    // journaling is best-effort
  }
}

function announce(text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    if (typeof sayPublic === "function") sayPublic(null, text);
  } catch {
    // announcements are best-effort
  }
}

function guildName(guildId) {
  return guildId === "merchants" ? "Merchants'" : guildId === "crafters" ? "Crafters'" : guildId;
}

/**
 * Tick the charter system. director is passed for parity with other Life
 * ticks but is not required.
 */
function tickTradeCharters(director, nowMs = Date.now()) {
  try {
    for (const c of Charters.allCharters()) {
      const key = `${c.kingdomId}|${c.category}`;
      if (lastCheck[key] && nowMs - lastCheck[key] < CHECK_MS) continue;
      lastCheck[key] = nowMs;

      const expired = c.expiresAt > 0 && c.expiresAt <= nowMs;

      // War suspends trade monopolies.
      if (!expired && kingdomAtWar(c.kingdomId)) {
        Charters.revokeCharter(c.kingdomId, c.category);
        const cat = Charters.categoryFor(c.category);
        journalFact("charter_revoked_war", { kingdomId: c.kingdomId, category: c.category, guildId: c.guildId });
        announce(`The ${cat?.label ?? c.category} trade charter in ${c.kingdomId} has been suspended — war disrupts all monopolies.`);
        continue;
      }

      // Expired without renewal: lapse it. The guild must petition anew.
      if (expired) {
        Charters.revokeCharter(c.kingdomId, c.category);
        const cat = Charters.categoryFor(c.category);
        journalFact("charter_lapsed", { kingdomId: c.kingdomId, category: c.category, guildId: c.guildId });
        announce(`The ${cat?.label ?? c.category} trade charter in ${c.kingdomId} has lapsed — the market is open to all traders.`);
        continue;
      }

      // Renewal window: within 24h of expiry, renew from the guild treasury.
      const msLeft = c.expiresAt - nowMs;
      if (msLeft > 0 && msLeft < RENEWAL_WINDOW_MS) {
        const res = Charters.renewCharter(c.kingdomId, c.category, nowMs);
        if (res.ok) {
          const cat = Charters.categoryFor(c.category);
          journalFact("charter_renewed", { kingdomId: c.kingdomId, category: c.category, guildId: c.guildId });
          announce(`The ${guildName(c.guildId)} Guild has renewed its ${cat?.label ?? c.category} trade charter in ${c.kingdomId}.`);
        }
        // Renewal failure (treasury broke) is silent — the charter lapses
        // at expiry and the lapse announcement covers it.
      }
    }
  } catch {
    // never throw from the tick
  }
}

module.exports = {
  tickTradeCharters,
  resetForTests,
};
