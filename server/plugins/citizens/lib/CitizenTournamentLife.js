"use strict";

/**
 * CitizenTournamentLife — slow-tick dynamics for participatory tournaments.
 *
 * WHAT IT DOES (runs in the director's slow tick, never throws):
 *   - Opens seasonal tournaments: per kingdom per sport, when none is open
 *     and the last one closed 7+ days ago or in a previous season.
 *   - Ambient entries: tournaments closing within 6h with too few entrants
 *     get eligible online citizens auto-entered (competitive trait, can
 *     afford the fee). Entry fees are REAL coins.
 *   - Closes expired tournaments: runs the bracket, pays champion/runner-up
 *     prizes in REAL coins (online winners; unclaimed prizes return to the
 *     kingdom purse — never invented, never lost), settles parimutuel bets
 *     (online bettors paid; unclaimed winnings to the purse), awards fame
 *     deeds, and announces results via sayPublic near real players.
 *   - Cancelled tournaments (too few entrants): entry fees refunded in REAL
 *     coins to online entrants; offline refunds to the purse.
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented money: every payout is real coins or purse funds.
 *   - Never throws — one bad tournament never breaks the tick.
 */

const T = require("./CitizenTournaments");

const TICK_MS = 5 * 60 * 1000; // slow tick runs every ~5 min
const REOPEN_DAYS = 7; // min days between tournaments per kingdom+sport
const FILL_WINDOW_MS = 6 * 60 * 60 * 1000; // auto-fill when closing within 6h
const ANNOUNCE_RADIUS = 14; // tiles — near enough to hear

let lastTick = 0;

function tournaments() {
  try {
    return require("./CitizenTournaments");
  } catch {
    return null;
  }
}

function safeJournal(director) {
  try {
    return director.getJournal?.() ?? null;
  } catch {
    return null;
  }
}

function kingdomsOf(director) {
  try {
    const roster = director.roster?.values?.() ?? director.roster ?? [];
    const ids = new Set();
    for (const record of roster) {
      const k = record?.kingdomId ?? record?.kingdom ?? null;
      if (k) ids.add(String(k));
    }
    return [...ids];
  } catch {
    return [];
  }
}

function onlineCitizens(director) {
  const out = [];
  try {
    for (const record of director?.roster?.values?.() ?? []) {
      if (!record) continue;
      const username = record.username ?? record.name;
      if (!username) continue;
      let online = false;
      try {
        online = director.isOnline(record);
      } catch {
        online = false;
      }
      if (online) out.push({ record, username });
    }
  } catch {
    // roster unreadable — nothing to do
  }
  return out;
}

function botFor(director, record) {
  try {
    return director?.getBot?.(record) ?? null;
  } catch {
    return null;
  }
}

function anyRealPlayerNear(director, citizen, radius) {
  try {
    const { anyRealPlayerNear: check } = require("./CitizenSites");
    if (typeof check === "function") return check(director, citizen, radius);
  } catch {
    // fall through
  }
  try {
    const players = director?.getLocalPlayers?.(citizen) ?? [];
    return players.some((p) => !p?.isBot && !p?.getAttribute?.("citizen:bot"));
  } catch {
    return false;
  }
}

function competitiveOf(record) {
  try {
    const p = record?.personality ?? record?.traits ?? {};
    return Number(p.competitive ?? p.driven ?? p.ambitious ?? 0);
  } catch {
    return 0;
  }
}

function kingdomIdOf(record) {
  return record?.kingdomId ?? record?.kingdom ?? null;
}

/**
 * Pay real coins to an online citizen. Returns true if paid.
 * Unpaid amounts are NOT invented — the caller recycles them to the purse.
 */
function payCitizen(director, record, amount) {
  if (!record || !(amount > 0)) return false;
  try {
    const bot = botFor(director, record);
    if (!bot) return false;
    return T.addCoins(bot, Math.floor(amount)) === true;
  } catch {
    return false;
  }
}

function recordByUsername(director, username) {
  try {
    const key = String(username ?? "").toLowerCase();
    for (const record of director?.roster?.values?.() ?? []) {
      const n = String(record?.username ?? record?.name ?? "").toLowerCase();
      if (n && n === key) return record;
    }
  } catch {
    // fall through
  }
  return null;
}

function awardDeed(username, deedKind) {
  try {
    const Rep = require("./CitizenReputation");
    if (typeof Rep.awardDeed === "function") Rep.awardDeed(username, deedKind);
  } catch {
    // reputation is best-effort
  }
}

/**
 * The director calls this on its slow tick.
 * @param {object} director - the CitizenDirector
 * @param {number} nowMs
 */
function tickTournaments(director, nowMs = Date.now()) {
  const TT = tournaments();
  if (!TT) return;
  try {
    if (nowMs - lastTick < TICK_MS) return;
    lastTick = nowMs;

    const kingdoms = kingdomsOf(director);
    for (const kingdomId of kingdoms) {
      try {
        maintainTournaments(director, TT, kingdomId, nowMs);
      } catch {
        // One bad kingdom never breaks the tick.
      }
    }
  } catch {
    // Never throw out of the tick.
  }
}

function maintainTournaments(director, TT, kingdomId, nowMs) {
  const season = TT.currentSeason(nowMs);
  for (const sportId of Object.keys(TT.SPORTS)) {
    try {
      const open = TT.openTournamentFor(kingdomId, sportId);
      if (open) {
        maybeFill(director, TT, open, nowMs);
        if (nowMs >= open.closesAt) closeTournament(director, TT, open, nowMs);
        continue;
      }
      // No open tournament — open one if the last closed 7+ days ago
      // or in a previous season.
      if (shouldReopen(TT, kingdomId, sportId, season, nowMs)) {
        const t = TT.openTournament(kingdomId, sportId, nowMs);
        if (t) announceOpen(director, TT, t);
      }
    } catch {
      // One bad sport never breaks the kingdom.
    }
  }
}

function lastClosedFor(TT, kingdomId, sportId) {
  // The data tier records the reigning champion per kingdom+sport with the
  // season and timestamp — that's the recency signal for reopening.
  try {
    const c = TT.championOf(kingdomId, sportId);
    if (c && c.at) return { at: c.at, season: c.season };
  } catch {
    // fall through
  }
  return null;
}

function shouldReopen(TT, kingdomId, sportId, season, nowMs) {
  const last = lastClosedFor(TT, kingdomId, sportId);
  if (!last) return true; // never run here — open the first
  if (last.season && last.season !== season) return true; // new season, new circuit
  return nowMs - (last.at ?? 0) > REOPEN_DAYS * 24 * 60 * 60 * 1000;
}

/** Auto-fill a tournament closing soon with eligible online citizens. */
function maybeFill(director, TT, tournament, nowMs) {
  if (tournament.entries.length >= TT.MIN_ENTRANTS) return;
  if (tournament.closesAt - nowMs > FILL_WINDOW_MS) return;
  const fee = TT.entryFeeFor(tournament.sportId);
  for (const { record, username } of onlineCitizens(director)) {
    if (tournament.entries.length >= TT.MAX_ENTRANTS) break;
    try {
      if (String(kingdomIdOf(record)) !== String(tournament.kingdomId)) continue;
      if (competitiveOf(record) < 0.5) continue;
      const bot = botFor(director, record);
      if (!bot) continue;
      if (TT.coinCount(bot) < fee) continue;
      const rating = TT.athleticRatingFor(bot, tournament.sportId);
      if (!TT.removeCoins(bot, fee)) continue;
      const res = TT.enterTournament(tournament.id, username, rating, nowMs);
      if (!res.ok) {
        // Entry failed — refund the fee, never eat real coins.
        TT.addCoins(bot, fee);
      }
    } catch {
      // One bad citizen never breaks the fill.
    }
  }
}

/** Close a tournament: run it, pay out, settle bets, award fame, announce. */
function closeTournament(director, TT, tournament, nowMs) {
  const journal = safeJournal(director);
  const res = TT.closeAndRun(tournament.id, nowMs);
  if (!res) return;

  if (res.cancelled) {
    refundEntries(director, TT, res.tournament);
    journal?.log?.("tournament-cancelled", {
      kingdom: res.tournament.kingdomId,
      sport: res.tournament.sportId,
      reason: "too-few-entrants",
    });
    return;
  }

  const t = res.tournament;
  // Prizes: real coins to online winners; unclaimed -> purse.
  payPrize(director, TT, t, t.champion, t.championPrize, journal, "champion");
  payPrize(director, TT, t, t.runnerUp, t.runnerUpPrize, journal, "runner-up");

  // Fame: the point of it all.
  if (t.champion) awardDeed(t.champion, "champion");
  if (t.runnerUp) awardDeed(t.runnerUp, "finalist");

  // Bets: parimutuel settlement, real coins to online bettors.
  const settled = TT.settleBets(t.id);
  if (settled) {
    for (const p of settled.payouts) {
      const record = recordByUsername(director, p.bettor);
      if (record && payCitizen(director, record, p.amount)) {
        journal?.log?.("tournament-bet-paid", {
          tournament: t.id, bettor: p.bettor, amount: p.amount,
        });
      } else {
        TT.addToPurse(t.kingdomId, p.amount);
        journal?.log?.("tournament-bet-unclaimed", {
          tournament: t.id, bettor: p.bettor, amount: p.amount,
        });
      }
    }
  }

  journal?.log?.("tournament-closed", {
    kingdom: t.kingdomId,
    sport: t.sportId,
    champion: t.champion,
    runnerUp: t.runnerUp,
    entrants: t.entries.length,
  });
  announceResult(director, TT, t);
}

function payPrize(director, TT, tournament, username, amount, journal, place) {
  if (!username || !(amount > 0)) return;
  const record = recordByUsername(director, username);
  if (record && payCitizen(director, record, amount)) {
    journal?.log?.("tournament-prize-paid", {
      tournament: tournament.id, winner: username, place, amount,
    });
  } else {
    TT.addToPurse(tournament.kingdomId, amount);
    journal?.log?.("tournament-prize-unclaimed", {
      tournament: tournament.id, winner: username, place, amount,
    });
  }
}

function refundEntries(director, TT, tournament) {
  const fee = TT.entryFeeFor(tournament.sportId);
  const journal = safeJournal(director);
  for (const e of tournament.entries) {
    const record = recordByUsername(director, e.username);
    if (record && payCitizen(director, record, fee)) {
      journal?.log?.("tournament-refund", {
        tournament: tournament.id, entrant: e.username, amount: fee,
      });
    } else {
      TT.addToPurse(tournament.kingdomId, fee);
    }
  }
}

function announceOpen(director, TT, tournament) {
  try {
    const sport = TT.SPORTS[tournament.sportId];
    const say = director.sayPublic ?? director.say ?? null;
    if (typeof say !== "function") return;
    // Only announce where a real player can hear it.
    let heard = false;
    for (const { record } of onlineCitizens(director)) {
      try {
        const bot = botFor(director, record);
        if (bot && anyRealPlayerNear(director, bot, ANNOUNCE_RADIUS)) { heard = true; break; }
      } catch { /* next */ }
    }
    if (!heard) return;
    const fee = TT.entryFeeFor(tournament.sportId);
    say(`${tournament.kingdomId} hosts a ${sport.label} tournament! Entry is ${fee} coins — sign up at the ${sport.venueName}!`);
    safeJournal(director)?.log?.("tournament-opened", {
      kingdom: tournament.kingdomId, sport: tournament.sportId, fee,
    });
  } catch {
    // announcements are best-effort
  }
}

function announceResult(director, TT, tournament) {
  try {
    const sport = TT.SPORTS[tournament.sportId];
    const say = director.sayPublic ?? director.say ?? null;
    if (typeof say !== "function" || !tournament.champion) return;
    let heard = false;
    for (const { record } of onlineCitizens(director)) {
      try {
        const bot = botFor(director, record);
        if (bot && anyRealPlayerNear(director, bot, ANNOUNCE_RADIUS)) { heard = true; break; }
      } catch { /* next */ }
    }
    if (!heard) return;
    say(`${tournament.champion} wins the ${tournament.kingdomId} ${sport.label} tournament!`);
  } catch {
    // announcements are best-effort
  }
}

/** Test seam — reset tick throttle. */
function _resetTickForTests() {
  lastTick = 0;
}

module.exports = {
  tickTournaments,
  _resetTickForTests,
};
