"use strict";

/**
 * CitizenPriests — priest citizens who guide worship: services, blessings,
 * confessions, shrine-tending, cryptic prophecies, and rites of passage.
 *
 * WHAT IT DOES (data tier, free):
 *   Every kingdom gets named temples with a daily service schedule
 *   (06:00 / 12:00 / 18:00, derived from hashes — no storage), per-day
 *   congregations, and per-oracle daily prophecies. High priests hold
 *   memorial rites for citizens who died in the last day (read from the
 *   real CitizenFunerals tables) and offer to officiate weddings. Player
 *   blessings and confessions live in a small in-memory ledger (24h TTL)
 *   so the LLM tier can answer "am I blessed?" truthfully.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   High priests lead services during service hours with scripted sermons,
 *   bless lingering players, and speak memorial rites. Chaplains hear
 *   confessions with scripted absolutions. Monks meditate and tend shrines.
 *   Oracles give cryptic prophecies in the evening. All of it scripted.
 *
 * Zero LLM: every forceChat line comes from the curated pools below.
 *
 * Integration: CitizenFunerals (recentDeceased — real deaths), CitizenWeddings
 * (officiant offers; the weddings module owns the ceremony), CitizenHealers
 * (spiritual healing complements the healers' clinics — lines only, no overlap),
 * CitizenScholars (theology — scholars own the research, priests own the faith).
 *
 * Wired into tickProximity() right after the librarians block. Plain-node
 * testable: CitizenPriests.test.js.
 */

// === Tuning: all magic numbers here ===
const PRIEST_RADIUS = 14; // tiles — close enough to see/hear
const PRIEST_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a priest fires at most every 3h
const PRIEST_OFFER_COOLDOWN_MS = 60 * 60 * 1000; // blessing/prophecy offers at most hourly per citizen
const PRIEST_CHANCE = 0.35; // per eligible citizen per ~60s tick
const SERVICE_WINDOW_MS = 30 * 60 * 1000; // services run 30 min past the hour
const BLESSING_TTL_MS = 24 * 60 * 60 * 1000; // blessings last a day
const SERVICE_HOURS = [6, 12, 18]; // services at dawn, noon, dusk

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastOfferByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastOfferByCitizen) {
    if (at < cutoff) lastOfferByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash, hex string. Deterministic across restarts. */
function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Deterministic 0..1 from one or more seed strings. */
function hashChance(...parts) {
  const h = parseInt(hashStr(parts.join("|")), 16);
  return (h % 100000) / 100000;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

// === Priest types ===
const PRIEST_TYPES = ["high-priest", "chaplain", "monk", "oracle"];
const PRIEST_TYPE_WEIGHTS = {
  "high-priest": 0.3,
  chaplain: 0.3,
  monk: 0.25,
  oracle: 0.15,
};

/** Hash-derived priest type for a username (~35% of commoners are priests). */
function priestTypeFor(username) {
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "priest") return null;
  const r = hashChance("priesttype", username);
  let acc = 0;
  for (const t of PRIEST_TYPES) {
    acc += PRIEST_TYPE_WEIGHTS[t];
    if (r < acc) return t;
  }
  return "high-priest";
}

// === Temples ===
const TEMPLES = [
  { name: "the Grand Temple of Saradomin", kingdom: "varrock", faith: "saradomin" },
  { name: "the Lumbridge Chapel", kingdom: "misthalin", faith: "saradomin" },
  { name: "the Falador Chapel", kingdom: "asgarnia", faith: "saradomin" },
  { name: "the Taverley Druid Circle", kingdom: "asgarnia", faith: "guthix" },
  { name: "the Ardougne Church", kingdom: "kandarin", faith: "saradomin" },
  { name: "the Seers' Shrine of Seren", kingdom: "kandarin", faith: "seren" },
  { name: "the Darkmeyer Blood Temple", kingdom: "morytania", faith: "zaros" },
  { name: "the Burgh de Rott Chapel", kingdom: "morytania", faith: "saradomin" },
  { name: "the Keldagrim Temple of Guthix", kingdom: "keldagrim", faith: "guthix" },
  { name: "the Dwarven War Shrine", kingdom: "keldagrim", faith: "bandos" },
];

const FAITHS = {
  saradomin: { epithet: "the light of order", blessing: "Saradomin's light" },
  zamorak: { epithet: "the fire of chaos", blessing: "Zamorak's strength" },
  guthix: { epithet: "the stillness of balance", blessing: "Guthix's balance" },
  zaros: { epithet: "the shadow of the Empty Lord", blessing: "the Empty Lord's gaze" },
  seren: { epithet: "the crystal song", blessing: "Seren's light" },
  bandos: { epithet: "the roar of war", blessing: "Bandos's might" },
};

/** Temple assignment: prefers the citizen's kingdom, falls back to any temple. */
function templeFor(username, kingdom) {
  const k = String(kingdom ?? "").toLowerCase();
  const local = TEMPLES.filter((t) => t.kingdom === k);
  const pool = local.length ? local : TEMPLES;
  return pool[parseInt(hashStr(`temple|${username}`), 16) % pool.length];
}

function faithOf(temple) {
  return FAITHS[temple?.faith] ?? FAITHS.saradomin;
}

// === Service schedule (data tier, derived per-day) ===
function dayKey(dateMs) {
  return new Date(dateMs).toISOString().slice(0, 10);
}

function hourOf(dateMs) {
  return new Date(dateMs).getHours();
}

/** True while a service is running: 30 minutes past a service hour. */
function inService(dateMs) {
  const d = new Date(dateMs);
  const h = d.getHours();
  const m = d.getMinutes();
  return SERVICE_HOURS.includes(h) && m < 30;
}

/** Next service hour today at or after dateMs, or the first tomorrow. */
function nextServiceHour(dateMs) {
  const h = hourOf(dateMs);
  for (const s of SERVICE_HOURS) {
    if (s > h || (s === h && new Date(dateMs).getMinutes() < 30)) return s;
  }
  return SERVICE_HOURS[0];
}

/**
 * Congregation for a temple on a day: how many worshippers attend, and a
 * notable regular's name. Derived from hashes — zero storage.
 */
function congregationFor(temple, dateMs) {
  const day = dayKey(dateMs);
  const size = 8 + Math.floor(hashChance("congregation", temple.name, day) * 40);
  const regular = hashChance("regular", temple.name, day) < 0.5;
  return { size, regular };
}

// === Oracle prophecies (data tier, derived per-day) ===
const ORACLE_PROPHECIES = [
  "I see a road that forks where the river bends. Choose the quieter path.",
  "Beware the smiling merchant — his scales are honest but his heart is not.",
  "A storm comes to the coast, but it carries good news in its belly.",
  "The coin you dropped will return to you threefold — be patient.",
  "Someone speaks your name in a far city. They mean you no harm.",
  "When the ravens gather on the chapel roof, stay indoors that night.",
  "A door you thought was locked will open this week. Walk through it.",
  "The old well holds more than water. Do not drink from it after dark.",
  "Your enemy's enemy is watching you. Decide if that is a friend.",
  "Plant something before the new moon and it will thrive.",
  "A letter is coming. Read it twice before you answer.",
  "The mountain remembers what the valley forgets. Listen to both.",
];

function prophecyFor(username, dateMs) {
  const day = dayKey(dateMs);
  const idx = Math.floor(hashChance("prophecy", username, day) * ORACLE_PROPHECIES.length);
  return ORACLE_PROPHECIES[idx];
}

// === Blessing ledger (in-memory, pruned) ===
const blessingLedger = new Map(); // playerName -> { temple, faith, since }
let lastLedgerPruneAt = 0;

function pruneLedger(nowMs) {
  if (nowMs - lastLedgerPruneAt < 3600 * 1000) return;
  lastLedgerPruneAt = nowMs;
  const cutoff = nowMs - BLESSING_TTL_MS;
  for (const [k, v] of blessingLedger) {
    if (v.since < cutoff) blessingLedger.delete(k);
  }
}

/** Bless a player. Returns the blessing or the existing unexpired one. */
function blessPlayer(playerName, templeName, nowMs = Date.now()) {
  const existing = blessingLedger.get(playerName);
  if (existing && nowMs - existing.since < BLESSING_TTL_MS) return existing;
  const blessing = { temple: templeName, faith: faithOf(TEMPLES.find((t) => t.name === templeName)), since: nowMs };
  blessingLedger.set(playerName, blessing);
  return blessing;
}

/** Read-only view of a player's blessing for the LLM tier. */
function blessingFor(playerName, nowMs = Date.now()) {
  const b = blessingLedger.get(playerName);
  if (!b || nowMs - b.since >= BLESSING_TTL_MS) return null;
  return b;
}

// === Confession ledger (counts only — confessions stay private) ===
const confessionCounts = new Map(); // templeName -> count today
let confessionDay = "";

function recordConfession(templeName, nowMs = Date.now()) {
  const day = dayKey(nowMs);
  if (confessionDay !== day) {
    confessionDay = day;
    confessionCounts.clear();
  }
  confessionCounts.set(templeName, (confessionCounts.get(templeName) ?? 0) + 1);
  return confessionCounts.get(templeName);
}

// === Funeral tie-in (CitizenFunerals, lazy) ===
let _funerals = null;
function funerals() {
  if (!_funerals) {
    try {
      _funerals = require("./CitizenFunerals");
    } catch {
      _funerals = {};
    }
  }
  return _funerals;
}

/** Most recent death within the last day, or null. Best-effort. */
function recentDeceased(nowMs = Date.now()) {
  try {
    const list = funerals().getDeceased?.() ?? [];
    const cutoff = nowMs - 24 * 3600 * 1000;
    for (const d of list) {
      if (d && d.diedAt >= cutoff) return d;
    }
  } catch {
    // Rites are garnish.
  }
  return null;
}

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
let _journal = null;
function journal() {
  if (!_journal) {
    try {
      _journal = require("./CitizenJournal").getJournal();
    } catch {
      _journal = { log() {} };
    }
  }
  return _journal;
}

function logWork(username, kind, text) {
  try {
    journal().log(username, kind, text);
  } catch {
    // Journal must never break the temple.
  }
}

function forceSay(bot, line) {
  try {
    bot.forceChat?.(String(line).slice(0, 120));
  } catch {
    // Cosmetic only.
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Nearest real player within radius, or null. */
function nearestRealPlayer(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    let best = null;
    let bestD = Infinity;
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      try {
        const la = citizen.getLocation?.();
        const lb = p.getLocation?.();
        if (!la || !lb || la.getZ() !== lb.getZ()) continue;
        const d = Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY()));
        if (d <= radius && d < bestD) {
          best = p;
          bestD = d;
        }
      } catch {
        // skip
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Decide whether this priest should fire now.
 * Pure: (rng, lastFiredMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < PRIEST_CITIZEN_COOLDOWN_MS) return false;
  return rng() < PRIEST_CHANCE;
}

function shouldOffer(lastOfferMs, nowMs) {
  return nowMs - (lastOfferMs || 0) >= PRIEST_OFFER_COOLDOWN_MS;
}

// === Scripted lines ===
const SERMON_LINES = [
  "Brothers and sisters, gather — the service begins.",
  "Let us give thanks for {epithet}.",
  "The {faith} teaches us: a kind hand outlasts a strong sword.",
  "Kneel, if your knees will have it, and quiet your hearts.",
  "Today we remember that {epithet} watches over this city.",
  "Bring your troubles to the altar; leave lighter than you came.",
];
const SERVICE_LINES = [
  "The choir is thin today, but the faith is loud.",
  "All are welcome at {temple} — believer or skeptic.",
  "The candles are lit. Take a seat, traveler.",
];
const BLESS_LINES = [
  "Kneel, child. May {blessing} go with you.",
  "{blessing} upon you, traveler. Walk safe.",
  "I bless you in the name of {epithet}.",
  "Go with {blessing}. Come back when your heart is heavy.",
];
const CONFESSION_LINES = [
  "Unburden yourself, child. These walls keep secrets.",
  "Speak freely — no sin is too heavy for {epithet}.",
  "I have heard worse, and forgiven worse. Tell me.",
];
const ABSOLUTION_LINES = [
  "You are forgiven. Go, and be kinder than you were.",
  "{epithet} absolves you. Sin no more — or sin less, at least.",
  "The weight is lifted. Walk in the light now.",
];
const MONK_LINES = [
  "*sweeps the shrine steps in slow, even strokes*",
  "*lights a stick of incense and bows*",
  "Silence is the oldest prayer. Join me a while.",
  "*tends the offering bowls, humming low*",
  "The temple asks little: sweep, breathe, be kind.",
];
const ORACLE_LINES = [
  "The mists part for you... listen well.",
  "Ask, and the signs will answer — after a fashion.",
  "I see... something. Come closer, traveler.",
];
const RITE_LINES = [
  "We gather to honor {name}, who walked among us.",
  "May {epithet} receive {name} with open arms.",
  "{name} is gone from the streets but not from our hearts.",
  "Rest now, {name}. The city keeps your memory.",
];
const OFFICIANT_LINES = [
  "Planning a wedding? {temple} would be honored to host it.",
  "I have married half this street. Say the word, and I'll marry you too.",
  "A wedding under {epithet} is a wedding that lasts.",
];
const EVENING_LINES = [
  "Evening prayers soon at {temple}. All are welcome.",
  "The lamps are lit. Come, pray with us.",
];

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function sermonLine(rng, faith) {
  return fill(pickOne(rng, SERMON_LINES), { epithet: faith.epithet, faith: "faith" });
}
function serviceLine(rng, temple) {
  return fill(pickOne(rng, SERVICE_LINES), { temple: temple.name });
}
function blessLine(rng, faith) {
  return fill(pickOne(rng, BLESS_LINES), { blessing: faith.blessing, epithet: faith.epithet });
}
function confessionLine(rng, faith) {
  return fill(pickOne(rng, CONFESSION_LINES), { epithet: faith.epithet });
}
function absolutionLine(rng, faith) {
  return fill(pickOne(rng, ABSOLUTION_LINES), { epithet: faith.epithet });
}
function monkLine(rng) {
  return pickOne(rng, MONK_LINES);
}
function oracleLine(rng) {
  return pickOne(rng, ORACLE_LINES);
}
function riteLine(rng, faith, name) {
  return fill(pickOne(rng, RITE_LINES), { epithet: faith.epithet, name });
}
function officiantLine(rng, temple, faith) {
  return fill(pickOne(rng, OFFICIANT_LINES), { temple: temple.name, epithet: faith.epithet });
}
function eveningLine(rng, temple) {
  return fill(pickOne(rng, EVENING_LINES), { temple: temple.name });
}

// ============================================================================
// The tick function — called from tickProximity().
// Gate order: cooldown (cheapest) → eligible type → materialized → real
// player near → work. Data tier runs free; only the visible layer gates on
// players.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   signature parity with sibling modules)
 */
function tickPriests(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  pruneLedger(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < PRIEST_CITIZEN_COOLDOWN_MS) continue;

        // 2. Eligibility: hash-derived priest type
        const type = priestTypeFor(record.username);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, PRIEST_RADIUS)) continue;

        // 5. Chance gate + do the work (scripted, zero LLM)
        if (!shouldFire(Math.random, last, nowMs)) continue;
        workTemple(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch {
        // Per-citizen: never let one bad record break the loop.
      }
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-priests] tick failed:", e?.message ?? e);
  }
}

function kingdomOf(record) {
  return (
    record.kingdom ??
    record[Object.keys(record).find((k) => /kingdom/i.test(k)) ?? ""] ??
    "varrock"
  );
}

function workTemple(director, record, citizen, type, nowMs) {
  const kingdom = kingdomOf(record);
  const temple = templeFor(record.username, kingdom);
  const faith = faithOf(temple);
  const rng = Math.random;
  const player = nearestRealPlayer(director, citizen, PRIEST_RADIUS);
  const pname = player?.getUsername?.() ?? "traveler";

  if (type === "high-priest") {
    // Memorial rites take precedence: honor the recently dead.
    const dead = recentDeceased(nowMs);
    if (dead && dead.display) {
      forceSay(citizen, riteLine(rng, faith, dead.display));
      logWork(record.username, "rite", `Held a memorial rite for ${dead.display} at ${temple.name}.`);
      return;
    }
    if (inService(nowMs)) {
      forceSay(citizen, sermonLine(rng, faith));
      const cong = congregationFor(temple, nowMs);
      logWork(record.username, "service", `Led the service at ${temple.name} (${cong.size} worshippers).`);
    } else if (shouldOffer(lastOfferByCitizen.get(record.username), nowMs)) {
      // Bless the lingering player, or offer to officiate a wedding.
      if (blessingFor(pname, nowMs)) {
        forceSay(citizen, officiantLine(rng, temple, faith));
      } else {
        blessPlayer(pname, temple.name, nowMs);
        forceSay(citizen, blessLine(rng, faith));
        logWork(record.username, "blessing", `Blessed ${pname} at ${temple.name}.`);
      }
      lastOfferByCitizen.set(record.username, nowMs);
    } else {
      forceSay(citizen, serviceLine(rng, temple));
    }
  } else if (type === "chaplain") {
    if (shouldOffer(lastOfferByCitizen.get(record.username), nowMs)) {
      forceSay(citizen, confessionLine(rng, faith));
      lastOfferByCitizen.set(record.username, nowMs);
      // The absolution follows in the same breath — the confession itself
      // is the player's LLM dialogue; this keeps the visible scene whole.
      if (rng() < 0.5) {
        recordConfession(temple.name, nowMs);
        logWork(record.username, "confession", `Heard a confession at ${temple.name}.`);
      }
    } else {
      forceSay(citizen, "The healers mend the body; we mend the spirit. Rest here a while.");
    }
  } else if (type === "monk") {
    forceSay(citizen, monkLine(rng));
    logWork(record.username, "work", `Tended the shrine at ${temple.name}.`);
  } else if (type === "oracle") {
    const h = hourOf(nowMs);
    if (h >= 17 || h < 5) {
      if (shouldOffer(lastOfferByCitizen.get(record.username), nowMs)) {
        forceSay(citizen, oracleLine(rng));
        lastOfferByCitizen.set(record.username, nowMs);
        logWork(record.username, "prophecy", `Gave a prophecy to ${pname} at ${temple.name}.`);
      } else {
        forceSay(citizen, `For you, ${pname}: ${prophecyFor(record.username, nowMs)}`);
      }
    } else {
      forceSay(citizen, "*gazes into the smoke, saying nothing*");
    }
  }
}

// === Public API for the LLM dialogue tier (data, zero LLM) ===

/** Bless a player at a temple. Returns the blessing. */
function blessPlayerAt(playerName, templeName, nowMs = Date.now()) {
  const b = blessPlayer(playerName, templeName, nowMs);
  logWork("priest", "blessing", `${playerName} was blessed at ${b.temple}.`);
  return b;
}

/** Record a confession (counts only — the words stay private). */
function hearConfession(playerName, templeName, nowMs = Date.now()) {
  recordConfession(templeName, nowMs);
  logWork("priest", "confession", `${playerName} confessed at ${templeName}.`);
  return confessionCounts.get(templeName) ?? 0;
}

/** Test seam: clear all state. */
function resetForTests() {
  lastFiredByCitizen.clear();
  lastOfferByCitizen.clear();
  blessingLedger.clear();
  confessionCounts.clear();
  confessionDay = "";
  lastPruneAt = 0;
  lastLedgerPruneAt = 0;
  _journal = null;
  _funerals = null;
}

module.exports = {
  tickPriests,
  // Public API (data tier, zero LLM):
  priestTypeFor,
  templeFor,
  faithOf,
  inService,
  nextServiceHour,
  congregationFor,
  prophecyFor,
  blessPlayer,
  blessPlayerAt,
  blessingFor,
  hearConfession,
  recordConfession,
  recentDeceased,
  // Pure helpers for tests:
  hashStr,
  hashChance,
  pickOne,
  isRealPlayer,
  withinTiles,
  shouldFire,
  shouldOffer,
  hourOf,
  sermonLine,
  serviceLine,
  blessLine,
  confessionLine,
  absolutionLine,
  monkLine,
  oracleLine,
  riteLine,
  officiantLine,
  eveningLine,
  // Tuning:
  PRIEST_TYPES,
  TEMPLES,
  FAITHS,
  PRIEST_RADIUS,
  PRIEST_CITIZEN_COOLDOWN_MS,
  PRIEST_CHANCE,
  SERVICE_HOURS,
  // Test seam:
  resetForTests,
};
