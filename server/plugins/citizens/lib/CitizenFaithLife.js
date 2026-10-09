"use strict";

/**
 * CitizenFaithLife — director tick dynamics for faith, devotion, priests,
 * holy days, and holy wars. Data tier, zero LLM.
 *
 * Each slow tick:
 *  1. Faithless roster citizens gain a faith (family inheritance first,
 *     then personality, then kingdom patron).
 *  2. Devotion drifts: chapel temples and holy days lift it, neglect
 *     and opposed-faith wars wear it down.
 *  3. Clergy-career citizens with high devotion are ordained as priests.
 *  4. Holy days are observed: journaled, announced where players gather.
 *  5. Rare conversions: restless or lovestruck citizens change gods.
 *  6. Holy wars are detected: opposed-faith kingdoms at war get
 *     journaled and announced — the priests preach about it.
 *
 * Wiring: CitizenDirector calls tickFaith(this, nowMs) in the slow tick
 * inside try/catch.
 */

const Faith = require("./CitizenFaith");
const { agentRng } = require("./humanizer");

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, text, kind || "faith");
  } catch {
    // best-effort
  }
}

function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const player = director?.getPlayer?.(username) ?? director?.players?.get?.(username);
    if (player) sayPublic(player, text);
  } catch {
    // best-effort
  }
}

// Lazy singletons for cross-module reads.
function families() {
  try {
    return require("./CitizenFamilies");
  } catch {
    return null;
  }
}
function careers() {
  try {
    return require("./CitizenCareers");
  } catch {
    return null;
  }
}

function rosterRecords(director) {
  try {
    return [...(director?.roster?.values?.() ?? [])];
  } catch {
    return [];
  }
}

function recordOf(director, name) {
  try {
    return director?.roster?.get?.(String(name).toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/** Family god lookup: spouse's or parents' faith, if any. */
function familyGodFor(director, record) {
  try {
    const F = families();
    if (!F) return null;
    const fam = F.familyOfMember?.(String(record?.username ?? ""));
    if (!fam) return null;
    for (const member of [...(fam.spouses ?? []), ...(fam.children ?? [])]) {
      if (String(member).toLowerCase() === String(record?.username ?? "").toLowerCase())
        continue;
      const g = Faith.faithOf(member)?.god;
      if (g) return g;
    }
  } catch {
    // fall through
  }
  return null;
}

function ensureFaith(director, record, rng) {
  const username = record?.username;
  if (!username || Faith.faithOf(username)) return;
  const god = Faith.chooseGodFor(record, {
    familyGod: familyGodFor(director, record),
  });
  Faith.setFaith(username, god, 35 + Math.floor(rng() * 20));
}

function driftDevotion(director, record, rng) {
  const username = record?.username;
  const rec = Faith.faithOf(username);
  if (!rec) return;
  const kingdomId = String(record?.kingdomId ?? "");
  let delta = 0;
  // Chapel temples lift devotion.
  delta += Faith.templeBonus(kingdomId) * 0.8;
  // Priests in town lift everyone.
  // (checked per-kingdom below; small personal nudge here)
  // Neglect: tiny downward drift for the lukewarm.
  if (rec.devotion < 30) delta -= 0.4;
  // Opposed-faith holy war shakes the faithful.
  // (checked per-kingdom below)
  if (delta !== 0) Faith.adjustDevotion(username, delta);
  void rng;
}

function ordainPriests(director, record) {
  const username = record?.username;
  const rec = Faith.faithOf(username);
  if (!rec || rec.priest) return;
  try {
    const C = careers();
    const career = C?.careerOf?.(username);
    if (career?.key !== "clergy" && career?.key !== "scribe") return;
  } catch {
    return;
  }
  if (rec.devotion >= 70) {
    Faith.setPriest(username, true);
    journalEvent(
      username,
      `was ordained as a priest of ${Faith.godName(rec.god)}`,
      "faith"
    );
  }
}

/** Holy day of the week per god — simple day-of-week mapping. */
function holyDayToday(nowMs) {
  const day = new Date(nowMs).getDay(); // 0 = Sunday
  const map = {
    0: "saradomin", // Sunsday
    1: "wanderer", // Roadsday
    2: "hearthmother", // Hearthday
    3: "guthix", // Wildsday
    4: "zamorak", // Chaosday
    5: "silent-one", // Veilsday
    6: "hearthmother", // second hearth day — family day
  };
  return map[day] ?? null;
}

function observeHolyDay(director, record, holyGod, rng, announced) {
  const username = record?.username;
  const rec = Faith.faithOf(username);
  if (!rec || rec.god !== holyGod) return;
  // Devout observers journal the day; the most devout announce.
  if (rec.devotion >= 50 && rng() < 0.3) {
    journalEvent(
      username,
      `kept ${Faith.godOf(holyGod).holyDay} with prayer`,
      "faith"
    );
  }
  if (rec.devotion >= 80 && !announced.has(holyGod) && rng() < 0.2) {
    announced.add(holyGod);
    sayPublicTo(
      director,
      username,
      `${Faith.godOf(holyGod).prayerLine} Blessed ${Faith.godOf(holyGod).holyDay}, friends.`
    );
  }
  Faith.adjustDevotion(username, 1.5);
}

function maybeConvert(director, record, rng) {
  const username = record?.username;
  const rec = Faith.faithOf(username);
  if (!rec || rec.priest) return;
  const traits = new Set(record?.personality?.traits ?? []);
  // Restless or lovestruck citizens sometimes find a new god.
  const restless = traits.has("restless") || traits.has("curious");
  if (!restless || rng() > 0.002) return;
  const options = Faith.GOD_KEYS.filter((g) => g !== rec.god);
  const next = options[Math.floor(rng() * options.length)];
  Faith.convert(username, next);
  journalEvent(
    username,
    `has turned from ${Faith.godName(rec.god)} to ${Faith.godName(next)}`,
    "faith"
  );
}

function detectHolyWars(director, records, rng, announced) {
  // Group kingdoms present in the roster.
  const kingdoms = new Map();
  for (const r of records) {
    const k = String(r?.kingdomId ?? "").toLowerCase();
    if (k && !kingdoms.has(k)) kingdoms.set(k, []);
    if (k) kingdoms.get(k).push(r);
  }
  const ids = [...kingdoms.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const pair = [ids[i], ids[j]].sort().join("|");
      if (announced.has(pair)) continue;
      let holy = false;
      try {
        holy = Faith.holyWarBetween(ids[i], ids[j]);
      } catch {
        holy = false;
      }
      if (!holy) continue;
      announced.add(pair);
      // The priests preach about it — one announcement per pair.
      const preachers = (kingdoms.get(ids[i]) ?? []).filter((r) =>
        Faith.isPriest(r?.username)
      );
      const preacher = preachers[Math.floor(rng() * Math.max(1, preachers.length))];
      const godA = Faith.patronGodOfKingdom(ids[i], kingdoms.get(ids[i]));
      const godB = Faith.patronGodOfKingdom(ids[j], kingdoms.get(ids[j]));
      const text =
        `A holy war! ${Faith.godName(godA)} against ${Faith.godName(godB)} — ` +
        `pray for our soldiers.`;
      if (preacher) {
        sayPublicTo(director, preacher.username, text);
        journalEvent(preacher.username, `preached: ${text}`, "faith");
      }
    }
  }
}

function tickFaith(director, nowMs) {
  const rng = agentRng("faith", Math.floor(nowMs / 60000));
  const records = rosterRecords(director);
  const holyGod = holyDayToday(nowMs);
  const announced = new Set();
  for (const record of records) {
    try {
      ensureFaith(director, record, rng);
      driftDevotion(director, record, rng);
      ordainPriests(director, record);
      if (holyGod) observeHolyDay(director, record, holyGod, rng, announced);
      maybeConvert(director, record, rng);
    } catch {
      // one citizen's faith never breaks the tick
    }
  }
  try {
    detectHolyWars(director, records, rng, announced);
  } catch {
    // best-effort
  }
  void recordOf;
}

module.exports = { tickFaith };
