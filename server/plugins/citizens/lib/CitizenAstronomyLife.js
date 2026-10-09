"use strict";

/**
 * CitizenAstronomyLife — slow-tick dynamics for the astronomy profession layer.
 *
 *   - Registers online curious citizens as astronomers (defensive: reads real
 *     personality; never invents).
 *   - Night-only observations: online astronomers at the observatory create
 *     star charts (real persistent records with real navigation effects).
 *   - Celestial event scheduling: announces active events via sayPublic near
 *     real players (throttled), journals them.
 *   - Omen flavor: kingdom omens surface in announcements during eclipses.
 *
 * Complements (does not duplicate):
 *   - CitizenScience owns astronomy EXPERIMENTS and peer-reviewed findings.
 *   - CitizenDayNightLife owns stargazing FLAVOR lines.
 *   - This module owns the profession tick: who watches, what they chart,
 *     what the sky is doing tonight.
 *
 * Never throws. Zero LLM. Data tier, plain-node testable with a stub director.
 */

const Astro = require("./CitizenAstronomy");

// Observation cadence: check every slow tick, but observations are slow.
const OBSERVE_EVERY_MS = 30 * 60 * 1000; // 30 min between observation rounds

function isNightTime(nowMs) {
  try {
    const DayNight = require("./CitizenDayNight");
    if (typeof DayNight.isNight === "function") return !!DayNight.isNight(nowMs);
  } catch { /* fall through to hour math */ }
  const h = new Date(nowMs).getHours();
  return h >= 21 || h < 5;
}

function say(director, bot, line) {
  try {
    if (bot && typeof bot.sayPublic === "function") bot.sayPublic(line);
    else if (typeof director?.sayAs === "function") director.sayAs(bot, line);
  } catch { /* speech never breaks the tick */ }
}

function journal(director, text, tags) {
  try {
    const j = director?.getJournal?.();
    if (j && typeof j.log === "function") j.log(text, tags || ["astronomy"]);
  } catch { /* journal never breaks the tick */ }
}

function tickAstronomy(director, nowMs) {
  const now = nowMs || Date.now();
  try {
    const st = Astro.load();

    // 1. Register curious online citizens as astronomers.
    try {
      for (const record of director?.roster?.values?.() ?? []) {
        try {
          if (!record || record.role !== "commoner") continue;
          const username = record.username;
          if (!username || Astro.astronomerFor(username)) continue;
          if (!director.isOnline || !director.isOnline(record)) continue;
          const bot = director.getBot ? director.getBot(record) : null;
          const curiosity = bot?.getPersonality?.()?.curious
            ?? record.personality?.curious ?? 0;
          if (curiosity >= Astro.ASTRONOMER_MIN_CURIOSITY) {
            let kingdomId = null;
            try {
              const { kingdomIdOf } = require("../brain/CitizenSites");
              kingdomId = kingdomIdOf(bot || record);
            } catch { /* no sites */ }
            if (kingdomId) Astro.registerAstronomer(username, kingdomId);
          }
        } catch { /* one bad citizen never breaks the tick */ }
      }
    } catch { /* roster unreadable */ }

    // 2. Night observations: astronomers at the observatory chart the sky.
    const night = isNightTime(now);
    if (night) {
      try {
        const lastKey = "__astro_last_observe";
        const last = st[lastKey] || 0;
        if (now - last >= OBSERVE_EVERY_MS) {
          st[lastKey] = now;
          for (const astro of Object.values(st.astronomers)) {
            try {
              const bot = director?.playerFor?.(astro.username)
                ?? director?.getBot?.({ username: astro.username });
              if (!bot) continue; // offline astronomers don't observe
              const obs = Astro.observatoryFor(astro.kingdomId);
              if (!obs || !obs.tile) continue;
              // Quality from wisdom: seasoned watchers chart better skies.
              const quality = Math.max(1, Math.min(10,
                Math.round((astro.wisdom || 10) / 10)));
              const r = Astro.createChart(astro.username, astro.kingdomId, quality);
              if (r.ok) {
                Astro.gainWisdom(astro.username, 1);
                journal(director,
                  `${astro.username} charted the stars (quality ${r.quality}).`,
                  ["astronomy", "chart"]);
              }
            } catch { /* one bad astronomer never breaks the tick */ }
          }
        }
      } catch { /* observation round failed */ }
    }

    // 3. Celestial events: announce active events near real players.
    try {
      const kingdoms = new Set(Object.values(st.astronomers).map((a) => a.kingdomId));
      for (const kingdomId of kingdoms) {
        const ev = Astro.activeEventFor(kingdomId, now);
        if (!ev) continue;
        if (!Astro.announceEvent(kingdomId, ev.kind, now)) continue; // throttled
        const omen = Astro.kingdomOmenFor(kingdomId, now);
        const line = ev.kind === "meteor_shower"
          ? "Look up — the sky is falling in streaks of fire tonight."
          : ev.kind === "comet"
          ? "A comet hangs in the sky. The old ones say it means change."
          : ev.kind === "lunar_eclipse"
          ? "The moon is swallowed by shadow. An omen — fortune favors the bold tonight."
          : "The sun is dying at midday. Stay close to the lamps, friends.";
        // Announce near a real player if one is around.
        try {
          const bots = director?.getBotsForKingdom?.(kingdomId) ?? [];
          const bot = bots[0] || null;
          say(director, bot, line);
        } catch { /* no bot to speak through */ }
        journal(director,
          `Celestial event over ${kingdomId}: ${ev.label}${omen ? ` (omen: ${omen})` : ""}.`,
          ["astronomy", "event"]);
        // Fame for the kingdom's astronomers when they call it right.
        try {
          const Rep = require("./CitizenReputation");
          for (const a of Astro.astronomersFor(kingdomId)) {
            if (typeof Rep.awardDeed === "function") {
              Rep.awardDeed(a.username, "stargazer");
            }
          }
        } catch { /* reputation optional */ }
      }
    } catch { /* event announcements failed */ }
  } catch (error) {
    try { director?.log?.("astronomy failed", { error: String(error?.message ?? error) }); }
    catch { /* logging never breaks the tick */ }
  }
}

module.exports = { tickAstronomy, isNightTime };
