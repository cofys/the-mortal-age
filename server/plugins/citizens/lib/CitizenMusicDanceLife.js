"use strict";

/**
 * CitizenMusicDanceLife — the slow-tick dynamics for citizen music & dance.
 *
 * TICK LAYERS (all defensive, never throws):
 *   1. Concert scheduling — one weekly concert per kingdom when an
 *      ensemble exists (rotating by concerts played).
 *   2. Festival grand concerts — during active festivals (read from
 *      CitizenFestivals, same pattern as CitizenEntertainLife theater),
 *      schedule a FREE grand concert with a bigger announcement.
 *   3. Concert resolution — pay real-coin payouts to performers
 *      (caller layer moves coins via the payout records), split the hall
 *      share to the kingdom treasury defensively, award the `virtuoso`
 *      fame deed to headliners, announce near real players.
 *   4. Rehearsals — ensembles and troupes rehearse daily: members gain
 *      proficiency, occasionally announced.
 *
 * NO OVERLAP: CitizenEntertainLife owns tavern bard performances, arena
 * fights, theater shows, and drunkenness decay. This owns concerts,
 * rehearsals, and lessons bookkeeping.
 */

const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const REHEARSAL_ANNOUNCE_COOLDOWN_MS = 6 * 3600 * 1000;

function musicDance() {
  try {
    return require("./CitizenMusicDance");
  } catch {
    return null;
  }
}

function festivals() {
  try {
    return require("./CitizenFestivals");
  } catch {
    return null;
  }
}

function reputation() {
  try {
    return require("./CitizenReputation");
  } catch {
    return null;
  }
}

function festivalActive(nowMs) {
  try {
    const F = festivals();
    return !!F?.isFestivalActive?.(nowMs);
  } catch {
    return false;
  }
}

/** Citizens online in a kingdom (defensive roster read). */
function citizensInKingdom(director, kingdomId) {
  try {
    const out = [];
    for (const record of director.roster?.values?.() ?? []) {
      if (record && record.kingdomId === kingdomId) out.push(record);
    }
    return out;
  } catch {
    return [];
  }
}

/** Any real (non-bot) player near a citizen of this kingdom? Defensive. */
function anyRealPlayerNear(director, kingdomId) {
  try {
    const citizens = citizensInKingdom(director, kingdomId);
    for (const record of citizens) {
      const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
      if (!bot) continue;
      const near = bot.getLocalPlayers?.() ?? [];
      for (const p of near) {
        if (p && !p.isBot && !p.bot) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function journalize(director, kind, data) {
  try {
    const journal = getJournal();
    journal?.log?.(kind, data);
  } catch { /* journaling is best-effort */ }
}

function announce(director, kingdomId, text) {
  try {
    // Announce from the first online citizen of the kingdom so a real
    // player nearby hears it in public chat.
    const citizens = citizensInKingdom(director, kingdomId);
    for (const record of citizens) {
      const bot = director.isOnline?.(record) ? director.getBot?.(record) : null;
      if (bot && typeof bot.sayPublic === "function") {
        bot.sayPublic(text);
        return true;
      }
    }
    // Fallback: journal it so the LLM tier can riff later.
    journalize(director, "concert_announcement", { kingdomId, text });
    return false;
  } catch {
    return false;
  }
}

function awardDeed(username, deedKind) {
  try {
    const R = reputation();
    R?.awardDeed?.(username, deedKind);
  } catch { /* fame is best-effort */ }
}

/** Resolve one concert: payouts, fame, mood, announcements. */
function resolveConcert(director, MD, concert, nowMs) {
  const res = MD.resolveConcert(concert.id, nowMs);
  if (!res) return;
  const { payouts, hallShare } = res;
  // Move real coins to performers (online only; offline payouts are lost —
  // honest, never invented).
  for (const payout of payouts) {
    try {
      const record = director.roster?.get?.(normalizeName(payout.username));
      const bot = record && director.isOnline?.(record) ? director.getBot?.(record) : null;
      if (bot && payout.amount > 0) MD.giveCoins?.(bot, payout.amount);
    } catch { /* one bad payout never breaks the tick */ }
  }
  // Hall share to the kingdom treasury (defensive).
  if (hallShare > 0) {
    try {
      const KS = require("../../kingdoms/KingdomStore");
      KS.addToTreasury?.(concert.kingdomId, hallShare);
    } catch { /* treasury unavailable — the coins stay unclaimed, not invented */ }
  }
  // Fame for headliners.
  try {
    const ensemble = MD.ensembles().find((e) => e.id === concert.ensembleId);
    if (ensemble && ensemble.leader) awardDeed(ensemble.leader, "virtuoso");
  } catch { /* best-effort */ }
  journalize(director, "concert_played", {
    kingdomId: concert.kingdomId,
    ensemble: concert.ensembleName,
    troupe: concert.troupeName,
    attendees: concert.attendees.length,
    revenue: concert.revenue,
    festival: !!concert.festival,
  });
  if (anyRealPlayerNear(director, concert.kingdomId)) {
    const what = concert.festival ? "grand festival concert" : "concert";
    announce(
      director,
      concert.kingdomId,
      `What a ${what}! ${concert.ensembleName} played to a full hall` +
        (concert.troupeName ? ` with ${concert.troupeName} dancing` : "") +
        `.`
    );
  }
}

/** Rehearse one group: members gain proficiency, occasionally announced. */
function rehearseGroup(director, MD, group, kind, nowMs, kingdomId) {
  if (!group) return;
  if ((group.lastRehearsal || 0) > 0 && nowMs - group.lastRehearsal < 24 * 3600 * 1000) return;
  group.lastRehearsal = nowMs;
  for (const m of group.members ?? []) {
    if (kind === "ensemble") MD.addMusic(m, 1);
    else MD.addDance(m, 1);
  }
  // Persist the rehearsal timestamp (groups live in the save state).
  MD.touch();
  journalize(director, "rehearsal", { kind, name: group.name, kingdomId });
}

function tickMusicDance(director, nowMs) {
  const MD = musicDance();
  if (!MD) return;
  try {
    const kingdoms = ["misthalin", "asgarnia", "kandarin", "morytania", "keldagrim"];
    const fest = festivalActive(nowMs);

    for (const kingdomId of kingdoms) {
      try {
        // 1. Schedule the weekly concert (or a free grand concert during festivals).
        const existing = MD.concertFor(kingdomId);
        if (!existing) {
          const concert = MD.scheduleConcert(kingdomId, nowMs, { festival: fest });
          if (concert && anyRealPlayerNear(director, kingdomId)) {
            const price = concert.ticketPrice > 0 ? ` Tickets ${concert.ticketPrice} coins.` : " Free entry!";
            announce(
              director,
              kingdomId,
              `${fest ? "A grand festival concert" : "A concert"} is announced at the dance hall: ` +
                `${concert.ensembleName}${concert.troupeName ? ` with ${concert.troupeName}` : ""}.${price}`
            );
          }
          if (concert) {
            journalize(director, "concert_scheduled", {
              kingdomId,
              ensemble: concert.ensembleName,
              troupe: concert.troupeName,
              festival: fest,
            });
          }
        } else if (existing.status === "scheduled" && nowMs - existing.at > 2 * 3600 * 1000) {
          // 2. Concert time: resolve it (2h after scheduling = showtime).
          resolveConcert(director, MD, existing, nowMs);
        }

        // 3. Rehearsals: first ensemble and first troupe per kingdom.
        const ensembles = MD.ensembles();
        if (ensembles[0]) rehearseGroup(director, MD, ensembles[0], "ensemble", nowMs, kingdomId);
        const troupes = MD.troupes();
        if (troupes[0]) rehearseGroup(director, MD, troupes[0], "troupe", nowMs, kingdomId);
      } catch {
        // One bad kingdom never breaks the tick.
      }
    }

    MD.save();
  } catch {
    // The whole layer never throws.
  }
}

module.exports = { tickMusicDance };
