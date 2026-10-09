"use strict";

/**
 * CitizenAthleticsLife — slow tick for the athletics layer.
 *
 * - Registers athletic online citizens as athletes (athlete career, or
 *   strong/agile traits).
 * - Ambient training: athletes train at their kingdom's stadium, throttled.
 * - Fitness decay for idle athletes.
 * - Record attempts: trained athletes may break kingdom records; breaking
 *   one grants fame and is announced near real players.
 * - Stadium upkeep: weekly coin draw from the kingdom treasury (defensive).
 *
 * Never throws. All engine reads are defensive.
 */

const Athletics = require("./CitizenAthletics");

const WEEK_MS = 7 * 24 * 3600 * 1000;

function safeRequire(path) {
  try { return require(path); } catch { return null; }
}

function tickAthleticsLife(director, nowMs) {
  try {
    const s = { registered: 0, trained: 0, records: 0 };
    Athletics.decayFitness(nowMs);

    const citizens = listOnlineCitizens(director);
    for (const c of citizens) {
      try {
        const username = c.username || c.name || "";
        if (!username) continue;
        if (!Athletics.isAthlete(username) && looksAthletic(c)) {
          const sport = pickSport(c);
          Athletics.registerAthlete(username, sport);
          s.registered += 1;
        }
      } catch { /* per-citizen safety */ }
    }

    // Per-kingdom ambient training + upkeep
    const kingdoms = listKingdoms();
    for (const kid of kingdoms) {
      try {
        if (!Athletics.stadiumFor(kid)) Athletics.foundStadium(kid);
        payUpkeep(kid, nowMs);
        if (!Athletics.ambientDue(kid, nowMs)) continue;
        Athletics.markAmbient(kid, nowMs);
        const roster = rosterFor(kid, director);
        for (const username of roster) {
          try {
            if (!Athletics.isAthlete(username)) continue;
            const before = Athletics.athleteInfo(username);
            Athletics.trainAthlete(username, nowMs);
            s.trained += 1;
            // Record attempt: only well-trained athletes threaten records
            const after = Athletics.athleteInfo(username);
            if (after && after.skill >= 10 && after.fitness >= 60) {
              const rec = Athletics.attemptRecord(username, kid, after.sport, nowMs);
              if (rec) {
                s.records += 1;
                onRecordBroken(director, kid, after.sport, rec);
              }
            }
            void before;
          } catch { /* per-athlete safety */ }
        }
      } catch { /* per-kingdom safety */ }
    }
    return s;
  } catch {
    return { registered: 0, trained: 0, records: 0 };
  }
}

function listOnlineCitizens(director) {
  try {
    const list = director?.citizensOnline?.() ?? director?.onlineCitizens?.() ?? [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function looksAthletic(c) {
  try {
    if (c.career === "athlete") return true;
    const t = c.traits || c.personality || {};
    return (t.strength ?? 0) >= 0.7 || (t.agility ?? 0) >= 0.7 || (t.athletic ?? 0) >= 0.7;
  } catch { return false; }
}

function pickSport(c) {
  try {
    const t = c.traits || c.personality || {};
    if ((t.agility ?? 0) >= 0.7) return "running";
    if ((t.strength ?? 0) >= 0.7) return "wrestling";
    return Athletics.SPORTS[Math.abs(hashStr(c.username || "")) % Athletics.SPORTS.length];
  } catch { return "running"; }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function listKingdoms() {
  try {
    const { KINGDOM_IDS } = require("../brain/CitizenSites");
    return Array.isArray(KINGDOM_IDS) ? KINGDOM_IDS : [];
  } catch { return []; }
}

function rosterFor(kid, director) {
  // Athletes registered without kingdom; return all athlete names and let
  // the caller gate by kingdom membership defensively.
  try {
    return Athletics.athletesIn(kid, 50).map((a) => a.name);
  } catch { return []; }
}

function payUpkeep(kid, nowMs) {
  try {
    const st = Athletics.stadiumFor(kid);
    if (!st || nowMs < (st.upkeepDue || 0)) return;
    const Banking = safeRequire("./CitizenBanking");
    const paid = Banking?.payFromTreasury?.(kid, 500) ?? false;
    if (paid) {
      st.upkeepDue = nowMs + WEEK_MS;
      st.condition = Math.min(100, st.condition + 5);
    } else {
      st.condition = Math.max(0, st.condition - 10); // neglect shows
      st.upkeepDue = nowMs + WEEK_MS; // don't spam the treasury
    }
  } catch { /* upkeep is best-effort */ }
}

function onRecordBroken(director, kingdomId, sport, record) {
  try {
    const Rep = safeRequire("./CitizenReputation");
    Rep?.awardDeed?.(record.holder, "recordbreaker");
    const label = Athletics.SPORT_LABELS[sport] || sport;
    announce(director, kingdomId,
      `${record.holder} has set a new ${kingdomId} record in ${label}!`);
  } catch { /* announcements are best-effort */ }
}

function announce(director, kingdomId, text) {
  try {
    const { sayPublic } = safeRequire("../chat/CitizenSayPublic") || {};
    const { stadiumTile } = Athletics;
    const tile = stadiumTile(kingdomId);
    if (sayPublic && tile) sayPublic(director, tile, text);
  } catch { /* never throw */ }
}

module.exports = { tickAthleticsLife };
