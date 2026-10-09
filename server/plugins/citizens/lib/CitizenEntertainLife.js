"use strict";

/**
 * CitizenEntertainLife — director tick dynamics for taverns, bards,
 * theater, and the arena. Data tier, zero LLM.
 *
 * Each slow tick:
 *  1. Sobriety: drinkers sober up (drunkenness decays with elapsed time).
 *  2. Bard performances: bard-career citizens perform in their kingdom's
 *     tavern every few hours — announced once via sayPublic where real
 *     players can hear, listeners get mood + the bard gets tips.
 *  3. Theater: during festivals (read from CitizenFestivals), a play is
 *     staged in the Grand Theater — announced, citizens may attend.
 *  4. Arena: sparring matches are scheduled between willing fighters —
 *     winner takes the purse, both get mood.
 *
 * Wiring: CitizenDirector calls tickEntertain(this, nowMs) in the slow
 * tick inside try/catch. CitizenEntertainment.save() goes in the save
 * section.
 */

const Entertain = require("./CitizenEntertainment");
const { normalizeName } = require("./CitizenBonds");

const HOUR_MS = 3600 * 1000;
const BARD_COOLDOWN_MS = 3 * HOUR_MS; // a bard performs at most every 3h
const PERFORMANCE_CHANCE = 0.3; // per eligible bard per tick
const ARENA_COOLDOWN_MS = 6 * HOUR_MS;
const ARENA_CHANCE = 0.2;
const THEATER_COOLDOWN_MS = 12 * HOUR_MS;

function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const player = director?.getPlayer?.(username) ?? director?.players?.get?.(username);
    if (player) sayPublic(player, text);
  } catch {
    // best-effort
  }
}

function careers() {
  try {
    return require("./CitizenCareers");
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

function journal() {
  try {
    return require("./CitizenJournal").getJournal();
  } catch {
    return null;
  }
}

function onlineCitizens(director) {
  const out = [];
  try {
    const roster = director?.roster;
    if (!roster) return out;
    const values = typeof roster.values === "function" ? roster.values() : roster;
    for (const record of values) {
      if (!record) continue;
      const username = record.username ?? record.name;
      if (!username) continue;
      let player = null;
      try {
        player = director?.getPlayer?.(username) ?? director?.players?.get?.(username);
      } catch {
        player = null;
      }
      if (player) out.push({ record, player, username });
    }
  } catch {
    // best-effort
  }
  return out;
}

function isBard(record) {
  try {
    const Careers = careers();
    if (!Careers) return false;
    const career = Careers.careerOf?.(record?.username ?? record?.name ?? "");
    return String(career ?? "").toLowerCase() === "bard";
  } catch {
    return false;
  }
}

function tickEntertain(director, nowMs) {
  // 1. Sobriety — everyone sobers up with time.
  try {
    const online = onlineCitizens(director);
    // Approximate elapsed hours since last tick: the slow tick runs ~60s.
    const elapsedH = 1 / 60;
    for (const { username } of online) {
      try {
        Entertain.soberUp(username, elapsedH);
      } catch {
        // one bad citizen never breaks the tick
      }
    }
  } catch {
    // best-effort
  }

  // 2. Bard performances.
  try {
    const online = onlineCitizens(director);
    for (const { record, username } of online) {
      try {
        if (!isBard(record)) continue;
        const last = Entertain.lastPerformanceAt(username);
        if (nowMs - last < BARD_COOLDOWN_MS) continue;
        if (Math.random() >= PERFORMANCE_CHANCE) continue;
        const kingdomId = record?.kingdomId ?? null;
        const tavern = Entertain.tavernOfKingdom(kingdomId);
        const venue = tavern ? tavern.name : "the tavern";
        Entertain.recordPerformance(username, nowMs);
        sayPublicTo(
          director,
          username,
          `${username} tunes their lute and begins to play in ${venue}. Come listen!`
        );
        const j = journal();
        try {
          j?.record?.("bard_performance", { bard: username, venue, at: nowMs });
        } catch {
          // journal is best-effort
        }
      } catch {
        // one bad bard never breaks the tick
      }
    }
  } catch {
    // best-effort
  }

  // 3. Theater during festivals.
  try {
    const Festivals = festivals();
    let festivalActive = false;
    try {
      festivalActive = !!Festivals?.isFestivalActive?.(nowMs);
    } catch {
      festivalActive = false;
    }
    if (festivalActive) {
      const shows = Entertain.recentShows?.(1) ?? [];
      const lastShow = shows[0];
      if (!lastShow || nowMs - lastShow.at > THEATER_COOLDOWN_MS) {
        const titles = [
          "The Tale of the Fallen King",
          "A Midsummer Night's Mischief",
          "The Dragon and the Milkmaid",
          "Seven Swords for Seven Brothers",
        ];
        const title = titles[Math.floor(Math.random() * titles.length)];
        Entertain.recordShow(title, "misthalin", nowMs);
        const j = journal();
        try {
          j?.record?.("theater_show", { title, at: nowMs });
        } catch {
          // journal is best-effort
        }
        // Announce via a random online citizen near the theater.
        const online = onlineCitizens(director);
        if (online.length > 0) {
          const herald = online[Math.floor(Math.random() * online.length)];
          sayPublicTo(
            director,
            herald.username,
            `Hear ye! "${title}" plays tonight at the Grand Theater! Tickets ${Entertain.THEATER_PRICE} coins!`
          );
        }
      }
    }
  } catch {
    // best-effort
  }

  // 4. Arena sparring.
  try {
    const fights = Entertain.recentFights(1);
    const lastFight = fights[0];
    if (!lastFight || nowMs - lastFight.at > ARENA_COOLDOWN_MS) {
      if (Math.random() < ARENA_CHANCE) {
        const online = onlineCitizens(director);
        if (online.length >= 2) {
          const a = online[Math.floor(Math.random() * online.length)];
          let b = online[Math.floor(Math.random() * online.length)];
          let guard = 0;
          while (b.username === a.username && guard++ < 10) {
            b = online[Math.floor(Math.random() * online.length)];
          }
          if (b.username !== a.username) {
            const winner = Math.random() < 0.5 ? a.username : b.username;
            Entertain.recordFight(a.username, b.username, winner, nowMs);
            sayPublicTo(
              director,
              winner,
              `${winner} wins the sparring bout at the Pit against ${winner === a.username ? b.username : a.username}! The crowd roars!`
            );
            const j = journal();
            try {
              j?.record?.("arena_fight", {
                fighterA: a.username,
                fighterB: b.username,
                winner,
                at: nowMs,
              });
            } catch {
              // journal is best-effort
            }
          }
        }
      }
    }
  } catch {
    // best-effort
  }
}

module.exports = { tickEntertain };
