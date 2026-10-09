"use strict";

/**
 * CitizenFestivalLife — festival dynamics: the full festival system.
 *
 * WHAT IT DOES (data tier, free):
 *   Merges three festival sources into one calendar citizens know:
 *     1. Seasonal festivals — the 5 realm-wide annual festivals from
 *        CitizenFestivals (Founding Day, Springtide, Midsummer, Harvest
 *        Home, Embernight).
 *     2. Religious feasts — one annual 2-day feast per god from the
 *        CitizenFaith pantheon (Light's Vigil, Feast of Embers, ...).
 *     3. Council festival weeks — when a town council passes the
 *        "Harvest Festival" law, that kingdom feasts for a week.
 *   Citizens journal participation (shared history for gossip/LLM),
 *   anticipate upcoming festivals (3 days out, once each), festival
 *   weeks calm unrest slightly, and market days boost trade.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   "when is the next festival" / "what festivals are coming" chat
 *   answers; newly declared council festivals are announced in the
 *   streets; players can join festival games (see CitizenFestivalGames).
 *
 * Zero LLM: pure date math + honest state reads. Religious feasts are
 * registered into CitizenFestivals' calendar via registerFestivalSource
 * so the games module runs during feasts too — council festival weeks
 * are per-kingdom, so they are journaled here per-kingdom instead.
 */

const { normalizeName } = require("./CitizenBonds");

// Lazy requires (chat, voice, journal) happen inside the functions that use
// them, so plain-node tests can stub via require.cache.

// === Tuning: all magic numbers here ===
const FEAST_DURATION_DAYS = 2; // each god's annual feast runs 2 days
const ANTICIPATION_DAYS = 3; // citizens look forward to a festival this far out
const ANTICIPATION_CHANCE = 0.15; // per eligible citizen per tick
const FESTIVAL_UNREST_RELIEF = -1; // unrest calmed per festival day per kingdom
const FESTIVAL_ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-announce at most every 6h

// === Annual religious feasts: month is 0-indexed (0 = January) ===
// One feast per god — real data, deterministic, realm-wide.
const GOD_FEASTS = Object.freeze([
  {
    god: "saradomin",
    id: "feast-lights-vigil",
    name: "Light's Vigil",
    month: 0,
    startDay: 10,
    mood: "solemn",
    blurb: "Saradomin's feast of light",
  },
  {
    god: "wanderer",
    id: "feast-roadfare",
    name: "Roadfare",
    month: 2,
    startDay: 15,
    mood: "restless",
    blurb: "the Wanderer's feast of roads",
  },
  {
    god: "guthix",
    id: "feast-wildsbloom",
    name: "Wildsbloom",
    month: 4,
    startDay: 1,
    mood: "wild",
    blurb: "Guthix's feast of the wild",
  },
  {
    god: "zamorak",
    id: "feast-embers",
    name: "Feast of Embers",
    month: 6,
    startDay: 15,
    mood: "fierce",
    blurb: "Zamorak's feast of embers",
  },
  {
    god: "silent-one",
    id: "feast-night-veils",
    name: "Night of Veils",
    month: 9,
    startDay: 31,
    mood: "quiet",
    blurb: "the Silent One's night",
  },
  {
    god: "hearthmother",
    id: "feast-hearthtide",
    name: "Hearthtide",
    month: 11,
    startDay: 1,
    mood: "warm",
    blurb: "the Hearthmother's feast",
  },
]);

// === Memory-only state (ephemeral; announcements don't need disk) ===
const journaledExtended = new Map(); // `${username}:${festivalId}:${year}` -> ms
const anticipatedByCitizen = new Map(); // `${username}:${festivalId}:${year}` -> ms
const announcedCouncilFestivals = new Map(); // `${kingdomId}:${passedAtMs}` -> ms
const lastUnrestRelief = new Map(); // `${kingdomId}:${dateStr}` -> ms
let lastPruneAt = 0;

function pruneMemory(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 7 * 24 * 3600 * 1000;
  for (const [m, at] of [
    [journaledExtended, 0],
    [anticipatedByCitizen, 0],
    [announcedCouncilFestivals, 0],
    [lastUnrestRelief, 0],
  ]) {
    void at;
    for (const [k, v] of m) {
      if (v < cutoff) m.delete(k);
    }
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Seasonal festivals from the real calendar (read-only). */
function seasonalFestivals() {
  try {
    return require("./CitizenFestivals").FESTIVALS ?? [];
  } catch {
    return [];
  }
}

/** Religious feasts for a year — defs shaped like the seasonal calendar. */
function religiousFestivals(_year) {
  return GOD_FEASTS.map((f) => ({
    id: f.id,
    name: f.name,
    month: f.month,
    startDay: f.startDay,
    durationDays: FEAST_DURATION_DAYS,
    mood: f.mood,
    blurb: f.blurb,
    kind: "religious",
    god: f.god,
  }));
}

/** The merged calendar: seasonal + religious, sorted by date. Pure. */
function allFestivals(year) {
  const seasonal = seasonalFestivals().map((f) => ({ ...f, kind: "seasonal" }));
  const out = [...seasonal, ...religiousFestivals(year)];
  out.sort((a, b) => a.month - b.month || a.startDay - b.startDay);
  return out;
}

/** Start timestamp of a festival def in a given year. */
function festivalStartMs(f, year) {
  return new Date(year, f.month, f.startDay).getTime();
}

/** End timestamp (exclusive) of a festival def in a given year. */
function festivalEndMs(f, year) {
  const dur = f.durationDays ?? 3;
  return festivalStartMs(f, year) + dur * 24 * 3600 * 1000;
}

/**
 * The next festival after nowMs (or currently running), from the merged
 * calendar. Pure. This is the "citizens know the calendar" API.
 */
function nextFestival(nowMs) {
  const d = new Date(nowMs);
  for (const year of [d.getFullYear(), d.getFullYear() + 1]) {
    for (const f of allFestivals(year)) {
      if (festivalEndMs(f, year) > nowMs) {
        return { ...f, year };
      }
    }
  }
  return null;
}

/** The next n festivals after nowMs. Pure. */
function festivalsComing(n, nowMs) {
  const d = new Date(nowMs);
  const out = [];
  for (const year of [d.getFullYear(), d.getFullYear() + 1]) {
    for (const f of allFestivals(year)) {
      if (festivalEndMs(f, year) > nowMs) {
        out.push({ ...f, year });
        if (out.length >= n) return out;
      }
    }
  }
  return out;
}

/** Whole days until the festival starts (0 if running now). Pure. */
function daysUntil(f, nowMs) {
  const ms = festivalStartMs(f, f.year) - nowMs;
  return Math.max(0, Math.ceil(ms / (24 * 3600 * 1000)));
}

/** True while the council's festival law is active for a kingdom. */
function councilFestivalActive(kingdomId, nowMs) {
  try {
    const Gov = require("./CitizenGovernment");
    return Gov.hasLaw(kingdomId, "festival", nowMs);
  } catch {
    return false;
  }
}

/** True while the council's market-day law is active for a kingdom. */
function marketDayActive(kingdomId, nowMs) {
  try {
    const Gov = require("./CitizenGovernment");
    return Gov.hasLaw(kingdomId, "market-day", nowMs);
  } catch {
    return false;
  }
}

/**
 * All festivals "active" for a kingdom right now: seasonal, religious,
 * plus the council festival week. Pure data read.
 */
function activeFestivals(kingdomId, nowMs) {
  const out = [];
  const d = new Date(nowMs);
  try {
    const Fest = require("./CitizenFestivals");
    const cal = Fest.activeFestival?.(nowMs);
    if (cal) out.push({ ...cal, kind: cal.kind ?? "seasonal" });
  } catch {
    /* calendar absent */
  }
  // Religious feasts are checked directly (not via the registered source)
  // so this stays pure even when the source isn't wired.
  for (const f of religiousFestivals(d.getFullYear())) {
    if (
      d.getMonth() === f.month &&
      d.getDate() >= f.startDay &&
      d.getDate() < f.startDay + (f.durationDays ?? FEAST_DURATION_DAYS)
    ) {
      if (!out.some((o) => o.id === f.id)) out.push(f);
    }
  }
  if (councilFestivalActive(kingdomId, nowMs)) {
    out.push({
      id: "council-feast",
      name: "the council's feast",
      kind: "council",
      mood: "merry",
      blurb: "a week of feasting declared by the council",
    });
  }
  return out;
}

/** "festive" if anything is on, else "ordinary". Data other systems read. */
function festivalMood(kingdomId, nowMs) {
  return activeFestivals(kingdomId, nowMs).length > 0 ? "festive" : "ordinary";
}

/** 1 during festival/market days (merchants do well), else 0. */
function tradeBoost(kingdomId, nowMs) {
  if (marketDayActive(kingdomId, nowMs)) return 1;
  if (activeFestivals(kingdomId, nowMs).length > 0) return 1;
  return 0;
}

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// The tick function — called from the slow director tick after tickFaith.
// Gate order: prune → council announcements → participation journaling →
// anticipation → unrest relief. All cheap data-tier work; visible output
// is one sayPublic per new council festival (cooldown-gated).
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickFestivalLife(director, nowMs) {
  pruneMemory(nowMs);
  try {
    const roster = [...(director.roster?.values?.() ?? [])];
    if (!roster.length) return;

    // 1. Announce newly declared council festivals (one voice per kingdom).
    announceCouncilFestivals(director, roster, nowMs);

    // 2. Journal participation in extended festivals (council weeks +
    //    religious feasts not on the seasonal calendar). Seasonal
    //    participation is journaled by CitizenFestivals itself.
    journalExtendedParticipation(roster, nowMs);

    // 3. Anticipation: citizens look forward to the next festival.
    journalAnticipation(director, roster, nowMs);

    // 4. Unrest relief: festivals calm the town a little each day.
    relieveUnrest(roster, nowMs);
  } catch (e) {
    console.warn("[citizen-festival-life] tick failed:", e?.message ?? e);
  }
}

/** Announce a council's festival law once per kingdom (sayPublic). */
function announceCouncilFestivals(director, roster, nowMs) {
  let Gov;
  try {
    Gov = require("./CitizenGovernment");
  } catch {
    return;
  }
  const kingdoms = new Set(roster.map((r) => r?.kingdomId).filter(Boolean));
  for (const kingdomId of kingdoms) {
    let laws = [];
    try {
      laws = Gov.activeLaws(kingdomId, nowMs) ?? [];
    } catch {
      continue;
    }
    for (const law of laws) {
      if (law?.id !== "festival") continue;
      const key = `${kingdomId}:${law.passedAtMs}`;
      if (announcedCouncilFestivals.has(key)) continue;
      if (nowMs - (announcedCouncilFestivals.get(key) ?? 0) < FESTIVAL_ANNOUNCE_COOLDOWN_MS) {
        continue;
      }
      announcedCouncilFestivals.set(key, nowMs);
      // One voice: any online citizen of that kingdom.
      const voice = roster.find(
        (r) => r?.kingdomId === kingdomId && director.isOnline?.(r)
      );
      const citizen = voice ? director.getBot?.(voice) : null;
      journalEvent(
        voice?.username ?? "the town crier",
        `The council declared a week of feasting in ${kingdomId}.`,
        "social"
      );
      if (citizen) {
        try {
          const { sayPublic } = require("../chat/CitizenSayPublic");
          const { voiceFor, voiceLine } = require("./citizenVoice");
          const line = "Hear ye! The council declares a week of feasting! Games in the square, stalls open late — come one, come all!";
          const p = citizen.getAttribute?.("citizen:personality") ?? {};
          sayPublic(citizen, voiceLine(voiceFor(p), { plain: [line.slice(0, 140)] }));
        } catch {
          // A shy crier.
        }
      }
    }
  }
}

/** Journal once-per-festival participation for council weeks + feasts. */
function journalExtendedParticipation(roster, nowMs) {
  const year = new Date(nowMs).getFullYear();
  for (const record of roster) {
    const username = record?.username;
    if (!username) continue;
    const active = activeFestivals(record.kingdomId, nowMs).filter(
      (f) => f.kind !== "seasonal" // seasonal is journaled by CitizenFestivals
    );
    for (const f of active) {
      const key = `${normalizeName(username)}:${f.id}:${year}`;
      if (journaledExtended.has(key)) continue;
      journaledExtended.set(key, nowMs);
      journalEvent(
        username,
        `Celebrated ${f.name} (${f.blurb}) in ${record.kingdomId ?? "the realm"}.`,
        "social"
      );
    }
  }
}

/** 3 days out, citizens occasionally journal looking forward to it. */
function journalAnticipation(director, roster, nowMs) {
  const year = new Date(nowMs).getFullYear();
  for (const record of roster) {
    const username = record?.username;
    if (!username) continue;
    for (const f of festivalsComing(2, nowMs)) {
      const key = `${normalizeName(username)}:${f.id}:${f.year}`;
      if (anticipatedByCitizen.has(key)) continue;
      const days = daysUntil(f, nowMs);
      if (days === 0 || days > ANTICIPATION_DAYS) continue;
      // Deterministic-ish per citizen per festival: seeded by name+id.
      const seed = hashStr(username + ":" + f.id);
      const rng = mulberry32(seed);
      if (rng() > ANTICIPATION_CHANCE) continue;
      anticipatedByCitizen.set(key, nowMs);
      journalEvent(
        username,
        `Looking forward to ${f.name} — only ${days} day${days === 1 ? "" : "s"} away.`,
        "social"
      );
    }
  }
  void year;
  void director;
}

/** Festivals calm unrest a little each day per kingdom. */
function relieveUnrest(roster, nowMs) {
  let Gov;
  try {
    Gov = require("./CitizenGovernment");
    if (typeof Gov.adjustUnrest !== "function") return;
  } catch {
    return;
  }
  const dateStr = new Date(nowMs).toISOString().slice(0, 10);
  const kingdoms = new Set(roster.map((r) => r?.kingdomId).filter(Boolean));
  for (const kingdomId of kingdoms) {
    if (festivalMood(kingdomId, nowMs) !== "festive") continue;
    const key = `${kingdomId}:${dateStr}`;
    if (lastUnrestRelief.has(key)) continue;
    lastUnrestRelief.set(key, nowMs);
    try {
      Gov.adjustUnrest(kingdomId, FESTIVAL_UNREST_RELIEF);
    } catch {
      // Unrest is someone else's problem today.
    }
  }
}

// --- tiny deterministic hash + rng for anticipation (no engine deps) ---
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Register religious feasts with the seasonal calendar so games run too. */
function registerFeastSource() {
  try {
    const Fest = require("./CitizenFestivals");
    if (typeof Fest.registerFestivalSource !== "function") return false;
    Fest.registerFestivalSource((nowMs) => {
      const d = new Date(nowMs);
      for (const f of religiousFestivals(d.getFullYear())) {
        if (
          d.getMonth() === f.month &&
          d.getDate() >= f.startDay &&
          d.getDate() < f.startDay + (f.durationDays ?? FEAST_DURATION_DAYS)
        ) {
          return f;
        }
      }
      return null;
    });
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  journaledExtended.clear();
  anticipatedByCitizen.clear();
  announcedCouncilFestivals.clear();
  lastUnrestRelief.clear();
  lastPruneAt = 0;
}

module.exports = {
  tickFestivalLife,
  // Calendar (pure):
  GOD_FEASTS,
  religiousFestivals,
  allFestivals,
  nextFestival,
  festivalsComing,
  daysUntil,
  festivalStartMs,
  festivalEndMs,
  // Kingdom state (pure reads):
  councilFestivalActive,
  marketDayActive,
  activeFestivals,
  festivalMood,
  tradeBoost,
  // Wiring:
  registerFeastSource,
  // Test seam:
  resetForTests,
};
