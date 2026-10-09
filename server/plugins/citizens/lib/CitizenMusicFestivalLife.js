"use strict";

/**
 * CitizenMusicFestivalLife — the slow tick for the music-festival production
 * layer. Registers promoters, schedules ambient festivals, settles finished
 * ones, maintains grounds, and announces near real players.
 *
 * Never throws. All engine reads are defensive.
 */

const MF = require("./CitizenMusicFestivals");
const { agentRng } = require("./humanizer");
const { sayPublic } = require("../chat/CitizenSayPublic");

// === Tuning ===
const PROMOTER_REGISTRY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h per kingdom
const AMBIENT_FESTIVAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // weekly per kingdom
const SETTLE_CHECK_MS = 30 * 60 * 1000; // settle ripe festivals every 30m
const ANNOUNCE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // announce at most every 4h

let lastRegistry = {}; // kingdomId -> timestamp
let lastAmbient = {}; // kingdomId -> timestamp
let lastSettle = 0;
let lastAnnounce = 0;

function resetForTests() {
  lastRegistry = {};
  lastAmbient = {};
  lastSettle = 0;
  lastAnnounce = 0;
}

function nowMs() {
  return Date.now();
}

/**
 * Defensive: list online citizens from the director.
 */
function onlineCitizens(director) {
  try {
    const list = director.getOnlineCitizens ? director.getOnlineCitizens() : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/**
 * Defensive: read a citizen's username.
 */
function usernameOf(citizen) {
  try {
    return citizen.username || citizen.name || null;
  } catch (e) {
    return null;
  }
}

/**
 * Defensive: read a citizen's kingdom.
 */
function kingdomOf(citizen, director) {
  try {
    if (citizen.kingdomId) return citizen.kingdomId;
    if (director.kingdomIdOf) return director.kingdomIdOf(citizen);
  } catch (e) { /* fall through */ }
  return null;
}

/**
 * Defensive: check if a citizen looks like a promoter (career or traits).
 */
function looksLikePromoter(citizen) {
  try {
    const career = citizen.career || citizen.getCareer?.();
    if (career === "promoter") return true;
    const traits = citizen.traits || citizen.personality || {};
    return !!(traits.organized || traits.charismatic || traits.entrepreneurial);
  } catch (e) {
    return false;
  }
}

/**
 * The slow tick. Never throws.
 */
function tickMusicFestivalLife(director, now) {
  try {
    const t = now || nowMs();
    const citizens = onlineCitizens(director);

    // 1. Register promoters from the online roster (throttled per kingdom).
    const byKingdom = {};
    for (const c of citizens) {
      const kid = kingdomOf(c, director);
      if (!kid) continue;
      if (!byKingdom[kid]) byKingdom[kid] = [];
      byKingdom[kid].push(c);
    }
    for (const kid of Object.keys(byKingdom)) {
      if (t - (lastRegistry[kid] || 0) < PROMOTER_REGISTRY_COOLDOWN_MS) continue;
      lastRegistry[kid] = t;
      for (const c of byKingdom[kid]) {
        if (!looksLikePromoter(c)) continue;
        const username = usernameOf(c);
        if (!username) continue;
        try { MF.registerPromoter(username, kid); } catch (e) { /* never throw */ }
      }
    }

    // 2. Ambient festivals: a registered promoter may schedule one (weekly).
    for (const kid of Object.keys(byKingdom)) {
      if (t - (lastAmbient[kid] || 0) < AMBIENT_FESTIVAL_COOLDOWN_MS) continue;
      const promoters = byKingdom[kid].filter((c) => {
        const u = usernameOf(c);
        return u && MF.isPromoter(u);
      });
      if (promoters.length === 0) continue;
      // Only schedule if no upcoming festival exists.
      let upcoming = [];
      try { upcoming = MF.upcomingFestivals(kid); } catch (e) { upcoming = []; }
      if (upcoming.length > 0) continue;
      // The first promoter's company (or a new one) schedules.
      const promoter = promoters[0];
      const username = usernameOf(promoter);
      try {
        // Find or found a company.
        let company = null;
        // Defensive: scan companies for one founded by this promoter.
        // (No public list API — use a deterministic name.)
        const companyName = username + " " + "Festivals";
        company = MF.companyFor(companyName);
        if (!company) {
          const fr = MF.foundCompany(username, companyName);
          if (fr.ok) company = fr.company;
        }
        if (!company) continue;
        // Seed the treasury so ambient festivals can book acts.
        MF.creditTreasury(company.nameLower, 2000);
        const days = 2 + Math.floor(agentRng(kid + t, "festival-days")() * 3);
        const sr = MF.scheduleFestival(company.nameLower, kid, days);
        if (sr.ok) {
          lastAmbient[kid] = t;
          // Announce near real players.
          if (t - lastAnnounce > ANNOUNCE_COOLDOWN_MS) {
            lastAnnounce = t;
            try {
              sayPublic(director, promoter, `Hear ye! ${sr.festival.name} comes to ${kid} — ${sr.festival.days} days of music!`);
            } catch (e) { /* never throw */ }
          }
        }
      } catch (e) { /* never throw */ }
    }

    // 3. Settle ripe festivals (throttled).
    if (t - lastSettle > SETTLE_CHECK_MS) {
      lastSettle = t;
      for (const kid of Object.keys(byKingdom)) {
        let festivals = [];
        try { festivals = MF.festivalsForKingdom(kid); } catch (e) { festivals = []; }
        for (const f of festivals) {
          if (f.status !== "scheduled") continue;
          if (f.endsAt > t) continue;
          try {
            // Settle with real coin movement (defensive — no payCoins in tick).
            const r = MF.settleFestival(f.id, null);
            if (r.ok && r.stars >= 4) {
              // Great festival — award the promoter a fame deed (defensive).
              try {
                const company = MF.companyFor(f.companyLower);
                if (company) {
                  const { awardDeed } = require("./CitizenReputation");
                  if (typeof awardDeed === "function") {
                    awardDeed(company.founder, MF.DEED_FESTIVAL_LEGEND);
                  }
                }
              } catch (e) { /* never throw */ }
            }
          } catch (e) { /* never throw */ }
        }
      }
    }

    // 4. Ground upkeep (weekly, defensive).
    for (const kid of Object.keys(byKingdom)) {
      try { MF.payUpkeep(kid, null); } catch (e) { /* never throw */ }
    }
  } catch (e) {
    // The tick never throws.
  }
}

module.exports = {
  tickMusicFestivalLife,
  resetForTests,
};
