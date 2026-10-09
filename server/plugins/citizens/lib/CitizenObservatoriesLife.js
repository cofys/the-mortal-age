"use strict";

/**
 * CitizenObservatoriesLife — the slow tick for public observatory operations.
 *
 * Complements (does not duplicate):
 *   - CitizenAstronomyLife owns: astronomer registration, night observations,
 *     chart creation, celestial-event announcements. This never observes or
 *     creates charts.
 *   - This tick owns: viewing-party hosting when celestial events go active,
 *     tour lifecycle (close finished tours), and premiere announcements for
 *     tours/parties near real players.
 *
 * Tick-safe: never throws; every engine read guarded; announcements are
 * throttled per kingdom.
 */

function observatoriesApi() {
  try {
    return require("./CitizenObservatories");
  } catch {
    return null;
  }
}

const ANNOUNCE_COOLDOWN_MS = 6 * 3600 * 1000;
const lastAnnounce = Object.create(null); // "kingdomId:kind" -> ms

function shouldAnnounce(kingdomId, kind, nowMs) {
  const key = `${kingdomId}:${kind}`;
  const last = lastAnnounce[key] ?? 0;
  if (last > 0 && nowMs - last < ANNOUNCE_COOLDOWN_MS) return false;
  lastAnnounce[key] = nowMs;
  return true;
}

function resetForTests() {
  for (const k of Object.keys(lastAnnounce)) delete lastAnnounce[k];
}

function say(director, bot, line) {
  try {
    if (typeof bot?.sayPublic === "function") bot.sayPublic(line);
  } catch { /* speech is best-effort */ }
}

function journal(director, text, tags) {
  try {
    director?.journalCitizens?.(text, tags ?? ["observatory"]);
  } catch { /* journaling is best-effort */ }
}

function onlineBots(director) {
  try {
    const list = director?.getOnlineCitizens?.() ?? director?.onlineCitizens ?? [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function tickObservatories(director, nowMs = Date.now()) {
  const Obs = observatoriesApi();
  if (!Obs) return;
  try {
    const kids = Obs.KINGDOM_IDS;
    for (const kid of kids) {
      // 1. Viewing parties: host while a celestial event is active.
      let party = null;
      try {
        party = Obs.maybeStartParty(kid, nowMs);
      } catch { /* party hosting is best-effort */ }
      if (party && shouldAnnounce(kid, `party:${party.eventKind}`, nowMs)) {
        const label = String(party.eventKind).replace(/_/g, " ");
        journal(director, `Viewing party at the ${kid} observatory — a ${label} is in the sky.`, ["observatory", "party"]);
        for (const bot of onlineBots(director)) {
          try {
            const bk = bot?.getKingdomId?.() ?? bot?.kingdomId;
            if (bk === kid) say(director, bot, `Viewing party at the observatory tonight — come see the ${label}!`);
          } catch { /* per-bot best-effort */ }
        }
      }
      // 2. Tours: close finished ones, announce upcoming ones once.
      let tours = [];
      try {
        tours = Obs.toursFor(kid, nowMs);
      } catch { /* tour reads are best-effort */ }
      for (const t of tours) {
        if (nowMs > t.endsAt) {
          try { Obs.closeTour(t.id, nowMs); } catch { /* best-effort */ }
          continue;
        }
        if (t.status === "scheduled" && nowMs >= t.scheduledFor - 30 * 60 * 1000 && shouldAnnounce(kid, `tour:${t.id}`, nowMs)) {
          journal(director, `Guided sky tour at the ${kid} observatory, led by ${t.astronomer}.`, ["observatory", "tour"]);
        }
      }
    }
  } catch { /* the tick never throws */ }
}

module.exports = { tickObservatories, resetForTests };
