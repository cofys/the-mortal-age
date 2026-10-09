"use strict";

/**
 * CitizenTheaterLife — the slow tick for the theater production layer.
 *
 * What it does (all defensive, never throws):
 *   - Registers playwrights from the online roster: citizens in the
 *     playwright career, or expressive/creative citizens who wander near
 *     a theater with papyrus to spare.
 *   - Ambient playwriting: registered playwrights draft plays in slow
 *     rounds (1 real papyrus per draft), throttled per kingdom.
 *   - Troupe formation: actors band together into named troupes when a
 *     kingdom has enough unattached performers.
 *   - Touring: restless troupes (wanderlust trait) book tours to other
 *     kingdoms; travel takes real time via CitizenTheater.tourTo.
 *   - Performance settlement: finished shows settle revenue splits and
 *     reviews; great premieres are announced near real players via
 *     throttled sayPublic.
 *   - Upkeep: crown-owned theaters decay honestly when upkeep lapses.
 *
 * Complements CitizenActors (scripted scenes) and CitizenEntertainment
 * (house shows) — this only runs the production economics.
 */

const Theater = require("./CitizenTheater");
const { agentRng } = require("./humanizer");
const { sayPublic } = require("../chat/CitizenSayPublic");

const WRITE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // ambient drafts at most every 4h/kingdom
const TROUPE_FORM_COOLDOWN_MS = 12 * 60 * 60 * 1000; // new troupes at most every 12h/kingdom
const TOUR_COOLDOWN_MS = 24 * 60 * 60 * 1000; // tours at most daily per troupe
const ANNOUNCE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // premieres announced at most every 2h/kingdom
const MIN_TROUPE_SIZE = 3;

const lastWrite = new Map(); // kingdomId -> timestamp
const lastTroupeForm = new Map(); // kingdomId -> timestamp
const lastTour = new Map(); // troupeLower -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp

function cooled(map, key, ms, now) {
  const last = map.get(key) || 0;
  if (last > 0 && now - last < ms) return true;
  map.set(key, now);
  return false;
}

function usernameOf(record) {
  try {
    return record?.getUsername?.() ?? record?.username ?? "";
  } catch {
    return "";
  }
}

function kingdomIdOf(record) {
  try {
    const { kingdomIdOf } = require("../brain/CitizenSites");
    return kingdomIdOf(record) || record.kingdomId || null;
  } catch {
    return record?.kingdomId || null;
  }
}

function personalityOf(record) {
  try {
    return record?.getAttribute?.("citizens:personality") ?? record?.personality ?? {};
  } catch {
    return {};
  }
}

function careerOf(record) {
  try {
    return record?.getAttribute?.("citizens:career") ?? record?.career ?? null;
  } catch {
    return null;
  }
}

function botFor(director, record) {
  try {
    return director?.getBot ? director.getBot(record) : null;
  } catch {
    return null;
  }
}

function hasPapyrus(bot, record) {
  try {
    // Roster records are plain data (no getInventory) — read the
    // materialized bot's inventory. No bot, no papyrus, no draft.
    const inv = bot?.getInventory?.() ?? record?.getInventory?.();
    if (!inv) return false;
    return (inv.getAmount?.(Theater.PAPYRUS_ID) ?? inv.count?.(Theater.PAPYRUS_ID) ?? 0) >= 1;
  } catch {
    return false;
  }
}

function isOnline(record) {
  try {
    return record?.isOnline?.() ?? !!record;
  } catch {
    return false;
  }
}

function nearRealPlayers(director, record) {
  try {
    // Roster records are plain data — resolve the materialized bot and
    // read ITS nearby players. (The old code called record.getLocalPlayers,
    // which doesn't exist on records, so this always returned false and
    // every theater announcement silently died.)
    const bot = botFor(director, record);
    const players = bot?.getLocalPlayers?.() ?? [];
    return players.some((p) => {
      try {
        return p?.isRealPlayer?.() ?? !p?.isBot;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Speak through the materialized bot; silent when nobody's there to hear. */
function speakFor(director, record, text) {
  try {
    const bot = botFor(director, record);
    if (!bot) return;
    sayPublic(bot, text);
  } catch {
    // speech is best-effort
  }
}

function onlineRoster(director) {
  try {
    const roster = director?.roster?.values?.() ?? director?.roster ?? [];
    const arr = Array.isArray(roster) ? roster : [...roster];
    return arr.filter((r) => {
      try { return director.isOnline ? director.isOnline(r) : isOnline(r); }
      catch { return false; }
    });
  } catch { return []; }
}

/**
 * Slow tick entry. `director` is the CitizenDirector; the roster is derived
 * from it. Never throws — one bad citizen must not stop the show.
 */
function tickTheaterLife(director, nowMs) {
  try {
    const now = nowMs ?? Date.now();
    const list = onlineRoster(director);
    const byKingdom = new Map();

    for (const record of list) {
      try {
        if (!isOnline(record)) continue;
        const username = usernameOf(record);
        if (!username) continue;
        const kingdomId = kingdomIdOf(record);
        if (!kingdomId) continue;
        if (!byKingdom.has(kingdomId)) byKingdom.set(kingdomId, []);
        byKingdom.get(kingdomId).push({ record, username, kingdomId, bot: botFor(director, record) });

        // register playwrights: career playwrights, or creative citizens
        const career = careerOf(record);
        const pers = personalityOf(record);
        const creative = (pers.creativity ?? pers.expressiveness ?? 0) >= 0.6;
        if (career === "playwright" || creative) {
          Theater.registerPlaywright(username, kingdomId);
        }
      } catch { /* per-citizen safety */ }
    }

    for (const [kingdomId, citizens] of byKingdom) {
      try {
        Theater.ensureTheater(kingdomId);

        // ambient playwriting — throttled, needs real papyrus
        if (!cooled(lastWrite, kingdomId, WRITE_COOLDOWN_MS, now)) {
          const writers = citizens.filter(
            (c) => Theater.isPlaywright(c.username) && hasPapyrus(c.bot, c.record)
          );
          if (writers.length) {
            const rng = agentRng(`theater-write:${kingdomId}:${Math.floor(now / WRITE_COOLDOWN_MS)}`);
            const writer = writers[Math.floor(rng() * writers.length)];
            const genres = Theater.GENRE_KEYS;
            const genre = genres[Math.floor(rng() * genres.length)];
            const res = Theater.writePlay(writer.bot ?? writer.record, genre);
            if (res.ok && nearRealPlayers(director, writer.record)) {
              speakFor(director, writer.record, `Just finished a new ${genre} — "${res.play.title}"!`);
            }
          }
        }

        // troupe formation — enough unattached performers band together
        if (!cooled(lastTroupeForm, kingdomId, TROUPE_FORM_COOLDOWN_MS, now)) {
          const existing = new Set();
          for (const t of Theater.troupesIn(kingdomId)) {
            for (const m of t.members) existing.add(String(m).toLowerCase());
          }
          const free = citizens.filter((c) => {
            const pers = personalityOf(c.record);
            const performative = (pers.expressiveness ?? pers.sociability ?? 0) >= 0.5;
            return performative && !existing.has(c.username.toLowerCase());
          });
          if (free.length >= MIN_TROUPE_SIZE) {
            const rng = agentRng(`theater-troupe:${kingdomId}:${Math.floor(now / TROUPE_FORM_COOLDOWN_MS)}`);
            const founder = free[Math.floor(rng() * free.length)];
            const res = Theater.formTroupe(founder.username, kingdomId);
            if (res.ok) {
              for (const c of free.slice(0, MIN_TROUPE_SIZE + 1)) {
                if (c.username !== founder.username) Theater.joinTroupe(c.username, res.troupe.name);
              }
              // seed the repertoire with a local play if one exists
              const plays = Theater.playsIn(kingdomId);
              if (plays.length) Theater.addToRepertoire(res.troupe.name, plays[0].id);
              if (nearRealPlayers(director, founder.record)) {
                speakFor(director, founder.record, `Hear ye! ${res.troupe.name} takes the stage!`);
              }
            }
          }
        }

        // touring — restless troupes seek new audiences
        for (const troupe of Theater.troupesIn(kingdomId)) {
          try {
            if (cooled(lastTour, troupe.nameLower, TOUR_COOLDOWN_MS, now)) continue;
            const loc = Theater.troupeLocation(troupe);
            if (!loc || loc.traveling) continue;
            const rng = agentRng(`theater-tour:${troupe.nameLower}:${Math.floor(now / TOUR_COOLDOWN_MS)}`);
            if (rng() < 0.25 && (troupe.showsPlayed || 0) >= 2) {
              const others = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"].filter(
                (k) => k !== loc.kingdomId
              );
              const dest = others[Math.floor(rng() * others.length)];
              Theater.tourTo(troupe.name, dest);
            }
          } catch { /* per-troupe safety */ }
        }

        // settle finished performances
        for (const perf of Theater.finishedUnsettledPerformances(kingdomId)) {
          try {
            const res = Theater.settlePerformance(perf.id);
            if (res.ok && res.review.stars >= 4 && !cooled(lastAnnounce, kingdomId, ANNOUNCE_COOLDOWN_MS, now)) {
              const witness = citizens.find((c) => nearRealPlayers(director, c.record));
              if (witness) {
                speakFor(
                  director,
                  witness.record,
                  `${res.review.troupe}'s "${res.review.playTitle}" ${res.review.verdict}!`
                );
              }
            }
          } catch { /* per-performance safety */ }
        }

        // upkeep decay on crown theaters
        const theater = Theater.theaterFor(kingdomId);
        if (theater && theater.owner === "crown" && now > (theater.upkeepDueAt || 0)) {
          Theater.decayTheater(kingdomId);
        }
      } catch { /* per-kingdom safety */ }
    }

    Theater.save();
  } catch { /* never throw out of the tick */ }
}

function resetForTests() {
  lastWrite.clear();
  lastTroupeForm.clear();
  lastTour.clear();
  lastAnnounce.clear();
}

module.exports = { tickTheaterLife, resetForTests };
