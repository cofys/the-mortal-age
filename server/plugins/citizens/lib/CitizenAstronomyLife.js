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

// Last observation-round timestamp (module-local, NOT persisted to the save).
let lastObserveAtMs = 0;

function resetForTests() {
  lastObserveAtMs = 0;
}

function isNightTime(nowMs) {
  try {
    const DayNight = require("./CitizenDayNight");
    if (typeof DayNight.isNight === "function") return !!DayNight.isNight(nowMs);
  } catch { /* fall through to hour math */ }
  const h = new Date(nowMs).getHours();
  return h >= 21 || h < 5;
}

/**
 * Canonical speech: sayPublic(citizen, text) from chat/CitizenSayPublic.
 * (bot.sayPublic and director.sayAs do NOT exist — they silently no-op'd.)
 */
function say(bot, line) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    if (bot && typeof sayPublic === "function") sayPublic(bot, line);
  } catch { /* speech never breaks the tick */ }
}

/**
 * Canonical journal: getJournal().log(name, kind, text).
 * (director.getJournal does NOT exist on the real CitizenDirector.)
 */
function journal(name, kind, text) {
  try {
    const { getJournal } = require("./CitizenJournal");
    const j = typeof getJournal === "function" ? getJournal() : null;
    if (j && typeof j.log === "function") j.log(name, kind, text);
  } catch { /* journal never breaks the tick */ }
}

/** True when a real player is within overhead-chat range of the bot. */
function realPlayerNear(bot) {
  try {
    const { isRealPlayer } = require("../chat/CitizenSayPublic");
    const locals = bot?.getLocalPlayers?.() ?? [];
    for (const p of locals) {
      try {
        if (typeof isRealPlayer === "function" ? isRealPlayer(p) : (p?.isRealPlayer?.() ?? !p?.isBot)) {
          return true;
        }
      } catch { /* keep scanning */ }
    }
  } catch { /* engine seam failed */ }
  return false;
}

/** Cheap LOD gate: nothing to do when zero citizens are online. */
function anyCitizenOnline(director) {
  try {
    for (const record of director?.roster?.values?.() ?? []) {
      try {
        if (director?.isOnline && director.isOnline(record)) return true;
      } catch { /* keep scanning */ }
    }
  } catch { /* roster unreadable */ }
  return false;
}

function tickAstronomy(director, nowMs) {
  const now = nowMs || Date.now();
  try {
    // LOD gate: no ticking when no citizens are online at all.
    if (!anyCitizenOnline(director)) return;
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
        // Cooldown checked BEFORE the (expensive) astronomer materialization.
        if (now - lastObserveAtMs >= OBSERVE_EVERY_MS) {
          lastObserveAtMs = now;
          for (const astro of Object.values(st.astronomers)) {
            try {
              // Canonical: director.getBot takes the record ({ username }).
              // (director.playerFor does NOT exist.)
              const bot = director?.getBot ? director.getBot({ username: astro.username }) : null;
              if (!bot) continue; // offline astronomers don't observe
              const obs = Astro.observatoryFor(astro.kingdomId);
              if (!obs || !obs.tile) continue;
              // Quality from wisdom: seasoned watchers chart better skies.
              const quality = Math.max(1, Math.min(10,
                Math.round((astro.wisdom || 10) / 10)));
              const r = Astro.createChart(astro.username, astro.kingdomId, quality);
              if (r.ok) {
                Astro.gainWisdom(astro.username, 1);
                journal(astro.username, "astronomy",
                  `${astro.username} charted the stars (quality ${r.quality}).`);
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
        // Announce through an online kingdom bot — but only when a real
        // player is near enough to hear it (LOD: no shouts into the void).
        // (director.getBotsForKingdom does NOT exist; canonical is
        // director.onlineBotsForKingdom(kingdomId).)
        let speaker = null;
        try {
          const bots = typeof director?.onlineBotsForKingdom === "function"
            ? director.onlineBotsForKingdom(kingdomId)
            : [];
          speaker = Array.isArray(bots) && bots.length ? bots[0] : null;
        } catch { speaker = null; }
        if (speaker && realPlayerNear(speaker)) say(speaker, line);
        const reporter = (Astro.astronomersFor(kingdomId)[0] || {}).username || "stargazers";
        journal(reporter, "astronomy",
          `Celestial event over ${kingdomId}: ${ev.label}${omen ? ` (omen: ${omen})` : ""}.`);
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

module.exports = { tickAstronomy, isNightTime, resetForTests };
