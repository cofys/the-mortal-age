"use strict";

/**
 * CitizenHistorians — recorders of events and chroniclers of the realm:
 * chroniclers who write the daily record, archivists who keep the vaults,
 * genealogists who trace the families, and lorekeepers who guard the old
 * legends before they fade.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived historian types; per-kingdom daily chronicles derived from
 *   date + hash with real journaled events folded in as chronicle entries
 *   (bounded journal scan, same pattern as the bards' ballad-of-the-week);
 *   7-day-TTL player ledgers for read requests, contributed accounts and
 *   commissioned histories.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players, archive
 * hours 08:00-20:00 server time): scripted recording emotes, chronicle
 * announcements, read offers, contribution acknowledgments, commission
 * confirmations.
 *
 * Zero LLM: all lines from scripted pools; chronicles assemble from real
 * journaled event descriptions plus scripted frames; the journal feeds the
 * LLM mouth.
 *
 * ACTIVITY SYSTEM, not a profession: any commoner may be a historian — no
 * professional exclusion chain (see the chain-saturation warning in the
 * citizen-ai-builder skill). Distinct from CitizenLibrarians (written
 * catalogs, borrowers, donations — this module owns the WRITTEN RECORD of
 * events, not the book lending) and CitizenStorytellers (ORAL tales — oral
 * and written lore reference each other). The "lorekeeper" type guards
 * fading legends; it does not perform epics like the storytellers' type.
 *
 * Wired into the director proximity tick right after the storytellers block.
 * Plain-node testable: CitizenHistorians.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { isHobbyVisible } = require("./CitizenPrimaryHobby"); // Phase 2: visibility weighting

// === Tuning ===
const HISTORIAN_RADIUS = 14; // tiles — close enough to see/hear
const HISTORIAN_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const HISTORIAN_CHANCE = 0.35; // per eligible citizen per proximity tick
const CHRONICLE_CHANCE = 0.1; // per archive per day of a big chronicle moment
const CHRONICLE_MAX_ENTRIES = 3; // entries in the daily chronicle
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const ARCHIVE_START_HOUR = 8; // 08:00 server time
const ARCHIVE_END_HOUR = 20; // 20:00 server time
const ACCOUNT_MAX_CHARS = 280;

// === Historian types ===
const HISTORIAN_CHRONICLER = "chronicler";
const HISTORIAN_ARCHIVIST = "archivist";
const HISTORIAN_GENEALOGIST = "genealogist";
const HISTORIAN_LOREKEEPER = "lorekeeper";
const HISTORIAN_TYPES = [
  HISTORIAN_CHRONICLER,
  HISTORIAN_ARCHIVIST,
  HISTORIAN_GENEALOGIST,
  HISTORIAN_LOREKEEPER,
];
const HISTORIAN_WEIGHTS = {
  [HISTORIAN_CHRONICLER]: 35,
  [HISTORIAN_ARCHIVIST]: 25,
  [HISTORIAN_GENEALOGIST]: 20,
  [HISTORIAN_LOREKEEPER]: 20,
};

// === Archives (kingdom-preferred) ===
const ARCHIVES = [
  { name: "the Varrock chronicle vault", kingdom: "misthalin" },
  { name: "the Lumbridge scriptorium", kingdom: "misthalin" },
  { name: "the Falador record hall", kingdom: "asgarnia" },
  { name: "the Taverley annals chamber", kingdom: "asgarnia" },
  { name: "the Ardougne archive stacks", kingdom: "kandarin" },
  { name: "the Hemenster log office", kingdom: "kandarin" },
  { name: "the Keldagrim deep library", kingdom: "keldagrim" },
  { name: "the Dorgesh cave records", kingdom: "keldagrim" },
  { name: "the Darkmeyer memorial crypt", kingdom: "morytania" },
  { name: "the Al Kharid sand scriptorium", kingdom: "kharidian" },
];

// === Scripted frames ===
const RECORD_LINES = {
  [HISTORIAN_CHRONICLER]: [
    "*dips a quill and writes in a steady hand*",
    "*dates a fresh page in the chronicle*",
    "History is being made as we speak — someone must write it down.",
    "*presses the page dry with blotting sand*",
  ],
  [HISTORIAN_ARCHIVIST]: [
    "*slides a scroll into its pigeon-hole*",
    "*dusts a stack of records with a cloth*",
    "Everything in its place, and every place recorded.",
    "*checks a shelf twice, then nods*",
  ],
  [HISTORIAN_GENEALOGIST]: [
    "*unrolls a long parchment of names*",
    "*traces a family line with a fingertip*",
    "Your grandfather's grandfather was a hero, lad. It's all here.",
    "*cross-references two family trees, nodding slowly*",
  ],
  [HISTORIAN_LOREKEEPER]: [
    "*mends the spine of a cracked old tome*",
    "*reads a faded legend aloud under breath*",
    "The old stories fade if nobody keeps them. I keep them.",
    "*lights a candle over the fragile pages*",
  ],
};

const CHRONICLE_LINES = [
  // Kept short: filled with {kingdom} (<=13) + {entry} (<=75) these stay <=120.
  "Recorded this day in {kingdom}: {entry}.",
  "Today's {kingdom} chronicle: {entry}.",
  "*taps the page dry* {kingdom}: {entry}.",
];

const READ_LINES = [
  "The chronicles are open to any citizen — would you like me to read today's entry?",
  "I can read you the chronicle of {kingdom}, or your family's line. Which?",
  "Ask, and the records answer. What do you wish to know?",
];

const CONTRIBUTION_LINES = [
  "A first-hand account! I'll enter it in the chronicle exactly as you told it.",
  "Noted, word for word. History thanks you.",
  "The records are richer for it — I'll copy this into the annals tonight.",
];

const COMMISSION_LINES = [
  "A commissioned history! I'll trace the names and bring you the scroll in a few days.",
  "Consider it undertaken. The archives will yield what they yield.",
  "History for hire, and gladly — I'll have your scroll by week's end.",
];

const LEGEND_FRAMES = [
  "the archivists have preserved the telling of {legend} for the future",
  "a faded tale of {legend} was copied fresh before the ink was lost",
  "the old legend of {legend} was entered into the permanent record",
];

// === Routine chronicle material (when the journal is quiet) ===
const ROUTINE_ENTRIES = [
  "the markets opened in good order and the bread sold out by noon",
  "the watch reported a quiet night, the walls held, and the lamps were lit on time",
  "the council sat through the morning session with no quarrels worth recording",
  "rain fell on the fields and the farmers smiled, which the chronicle duly notes",
  "a flock of swallows returned to the eaves, which the old ones count lucky",
  "the blacksmiths' quarter rang from dawn to dusk and no apprentices were singed",
  "the fishing boats came in full and the gulls were bribed with the usual offal",
  "the tax grain was tallied twice and the clerks agreed for once",
];

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Player ledgers (7-day TTL) ===
const reads = new Map(); // normName -> { kingdom, at }
const accounts = new Map(); // normName -> { text, at }
const commissions = new Map(); // normName -> { subject, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const m of [reads, accounts, commissions]) {
    for (const [k, v] of m) {
      if (nowMs - v.at > LEDGER_TTL_MS) m.delete(k);
    }
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** Cheap rng from a seed (LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** True during archive hours (08:00-20:00 server time). */
function isArchiveHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= ARCHIVE_START_HOUR && h < ARCHIVE_END_HOUR;
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

// ============================================================================
// Historian identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * Weighted pick of a historian type from a 0..99 roll.
 */
function historianTypeFromRoll(roll) {
  let acc = 0;
  for (const t of HISTORIAN_TYPES) {
    acc += HISTORIAN_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return HISTORIAN_CHRONICLER;
}

/**
 * The historian type for a roster record, or null.
 * ACTIVITY SYSTEM: no professional exclusion chain — any commoner may be a
 * historian. (Distinct from the librarians module: its librarianTypeFor
 * identifies library staff; this module's types are recorders, not book
 * keepers.)
 */
function historianTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    const roll = hashStr("historian:" + name) % 100;
    return historianTypeFromRoll(roll);
  } catch {
    return null;
  }
}

/** Kingdom-preferred archive assignment, stable across restarts. */
function archiveFor(record) {
  const kid = record?.kingdomId;
  const local = ARCHIVES.filter((g) => g.kingdom === kid);
  const pool = local.length ? local : ARCHIVES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("historianarchive:" + name) % pool.length];
}

function kingdomName(kid) {
  const names = {
    misthalin: "Misthalin",
    asgarnia: "Asgarnia",
    kandarin: "Kandarin",
    keldagrim: "Keldagrim",
    morytania: "Morytania",
    kharidian: "the Kharidian",
  };
  return names[kid] ?? "the kingdom";
}

// --- Journal access (lazy require — CitizenJournal may not load in tests) ---
let _journalEvent = null;
function journalEvent() {
  if (_journalEvent !== null) return _journalEvent;
  try {
    _journalEvent = require("./CitizenJournal").getJournal() || false;
  } catch {
    _journalEvent = false;
  }
  return _journalEvent;
}

let _seedRumor = null;
function seedRumorFn() {
  if (_seedRumor !== null) return _seedRumor;
  try {
    _seedRumor = require("./CitizenRumors").seedRumor || false;
  } catch {
    _seedRumor = false;
  }
  return _seedRumor;
}

/** Best-effort journal write; never throws. */
function journalize(citizen, text) {
  try {
    const j = journalEvent();
    const name = citizen?.getUsername?.() ?? citizen?.username;
    // CitizenJournal's real API is log(name, kind, text) — there is no
    // addEntry method (mentors2 lesson: wire the real function, not a name
    // that reads right). The old call was a silent no-op, so the historians'
    // "written record" was never actually written.
    if (j && name) j.log?.(name, "historian", text);
  } catch { /* cosmetic */ }
}

/**
 * Best-effort rumor seed; never throws.
 * CitizenRumors' real signature is seedRumor(rng, { kind, who, what, where,
 * holder }) — a bare string seed silently returns null, so build the event.
 */
function seedRumor(citizen, what, where) {
  try {
    const fn = seedRumorFn();
    const name = citizen?.getUsername?.() ?? citizen?.username;
    if (fn && name && what) {
      fn(Math.random, {
        kind: "chronicle",
        who: String(name),
        what: String(what),
        where: where ? String(where) : undefined,
        holder: String(name),
      });
    }
  } catch { /* cosmetic */ }
}

/**
 * Scan recent journal entries for newsworthy words and return up to
 * CHRONICLE_MAX_ENTRIES short event descriptions. Cheap: bounded scan,
 * caller gates to at most once per archive per day. Same keyword pattern
 * as the storytellers' legend-growing.
 */
function chronicleEventsFor() {
  const keywords = [
    ["wedding", "a wedding was celebrated"],
    ["married", "a marriage was joined"],
    ["festival", "the festival filled the streets"],
    ["election", "the election was decided"],
    ["crowned", "a crown changed heads"],
    ["victory", "a great victory was won"],
    ["dragon", "a dragon was slain"],
    ["tournament", "the tournament named a champion"],
    ["treaty", "a treaty was signed"],
    ["funeral", "a farewell was held"],
    ["ship", "a great ship put out"],
    ["storm", "a great storm passed over"],
    ["battle", "steel was drawn in battle"],
    ["siege", "the walls stood a siege"],
    ["birth", "a child was born"],
    ["fire", "fire took a building"],
    ["chronicle", "the day's chronicle was duly entered"],
  ];
  const found = [];
  try {
    const j = journalEvent();
    if (!j || !j.entries) return found;
    let scanned = 0;
    for (const record of j.entries.values()) {
      for (const ev of record?.events ?? []) {
        const text = String(ev?.text ?? "").toLowerCase();
        for (const [word, desc] of keywords) {
          if (text.includes(word) && !found.includes(desc)) {
            found.push(desc);
            if (found.length >= CHRONICLE_MAX_ENTRIES) return found;
            break;
          }
        }
        if (++scanned > 600) return found;
      }
    }
  } catch { /* best effort */ }
  return found;
}

/**
 * The daily chronicle for a kingdom: { date, kingdom, entries[] }.
 * Derived, zero storage — entries come from real journaled events first,
 * padded with scripted routine material so every day has a record.
 */
function chronicleFor(kingdomId, dateMs) {
  const kid = kingdomId || "misthalin";
  const day = dayNumber(dateMs);
  const entries = [...chronicleEventsFor()];
  const rng = seededRng(hashStr("chronicle:" + kid + ":" + day));
  const archive = ARCHIVES.filter((a) => a.kingdom === kid);
  const archiveName = archive.length
    ? archive[hashStr("chronicle-archive:" + kid + ":" + day) % archive.length].name
    : ARCHIVES[0].name;
  let guard = 0;
  while (entries.length < CHRONICLE_MAX_ENTRIES && guard++ < 20) {
    const raw = fill(pickOne(rng, ROUTINE_ENTRIES), { archive: archiveName });
    if (!entries.includes(raw)) entries.push(raw);
  }
  return { date: day, kingdom: kingdomName(kid), entries };
}

/**
 * Chronicles of the last few days for a kingdom — for the LLM tier to quote
 * what the historians have been recording. Derived, zero storage.
 */
function recentChronicles(kingdomId, dateMs) {
  const out = [];
  for (let d = 0; d < 3; d++) {
    out.push(chronicleFor(kingdomId, dateMs - d * 86400000));
  }
  return out;
}

/**
 * A lorekeeper's preserving-of-legends moment: pulls today's oral legends
 * from the storytellers module (lazy bridge) and frames them as written
 * record; derived, zero storage. Returns { legend, text } or null.
 */
function preservedLegendFor(kingdomId, dateMs) {
  try {
    const storytellers = require("./CitizenStorytellers");
    if (typeof storytellers.recentLegends !== "function") return null;
    const legends = storytellers.recentLegends(
      { name: "the archive" },
      dateMs
    );
    if (!legends?.length) return null;
    const rng = seededRng(hashStr("legendpreserve:" + kingdomId + ":" + dayNumber(dateMs)));
    const legend = pickOne(rng, legends);
    const frame = pickOne(rng, LEGEND_FRAMES);
    return { legend, text: fill(frame, { legend }) };
  } catch {
    return null;
  }
}

/** The framed preserving text, or null (string wrapper for the LLM tier). */
function legendPreservedFor(kingdomId, dateMs) {
  return preservedLegendFor(kingdomId, dateMs)?.text ?? null;
}

/**
 * Cross-reference the librarians' written catalogs for a historian
 * (lazy bridge) — keeps the written record and the catalogs consistent.
 */
function librarianNoteFor(username, kingdomId, dateMs) {
  try {
    const librarians = require("./CitizenLibrarians");
    if (typeof librarians.catalogFor !== "function") return null;
    const cat = librarians.catalogFor(username, kingdomId, dateMs);
    if (cat?.library) return `The written records are kept at ${cat.library}.`;
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Player read requests, contributed accounts, commissioned histories.
// All data tier, zero LLM.
// ============================================================================

/** Request a chronicle reading: recorded; the LLM tier performs it. */
function requestReading(playerName, kingdomId, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  reads.set(name, { kingdom: kingdomId || "misthalin", at: nowMs });
  return reads.get(name).kingdom;
}

/** The active chronicle-read request for a player, or null. */
function readingFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = reads.get(name);
  return rec ? rec.kingdom : null;
}

/** Contribute a first-hand account: recorded; historians will enter it. */
function contributeAccount(playerName, text, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !text) return null;
  pruneLedgers(nowMs);
  accounts.set(name, { text: String(text).slice(0, ACCOUNT_MAX_CHARS), at: nowMs });
  return accounts.get(name).text;
}

/** The contributed account for a player, or null. */
function accountFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = accounts.get(name);
  return rec ? rec.text : null;
}

/** Commission a written history: recorded; the LLM tier delivers it. */
function commissionHistory(playerName, subject, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !subject) return null;
  pruneLedgers(nowMs);
  commissions.set(name, { subject: String(subject).slice(0, ACCOUNT_MAX_CHARS), at: nowMs });
  return commissions.get(name).subject;
}

/** The active commission for a player, or null. */
function commissionFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = commissions.get(name);
  return rec ? rec.subject : null;
}

// === Ledger acknowledgments (in-world answers to real player requests) ===
// The ledgers above are the data tier; without this, a player who requests
// a reading, contributes an account, or commissions a history never hears
// a word back in-world. Scripted, zero LLM, all <=120 chars.
const LEDGER_ACK_LINES = {
  reading: "You asked for the chronicle, friend. Gather round while I read today's entry.",
  account: "Your account is entered in the annals now, word for word.",
  commission: "Your commissioned history is underway; the archives yield slowly.",
};

/**
 * A nearby real player with a pending ledger entry, or null.
 * Checked before the routine branches so real requests get real answers.
 * Does not consume the ledger — the LLM dialogue tier still owns the
 * actual reading / account quoting / commission delivery.
 */
function pendingLedgerFor(director, citizen, radius, nowMs = Date.now()) {
  try {
    pruneLedgers(nowMs);
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, radius)) continue;
      const name = normalizeName(p.getUsername?.());
      if (!name) continue;
      if (reads.has(name)) return { kind: "reading", playerName: name };
      if (accounts.has(name)) return { kind: "account", playerName: name };
      if (commissions.has(name)) return { kind: "commission", playerName: name };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → historian? → materialized → archive
// hours → real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickHistorians(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < HISTORIAN_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a historian (hash-derived, cheap)
        const type = historianTypeOf(record);
        if (!type) continue;

        // 2b. Visibility weight (Phase 2 distribution fix): the primary hobby
        // always fires visibly; other hobbies fire 1/3 as often.
        if (!isHobbyVisible(record.username, "historian")) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Archive hours only
        if (!isArchiveHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, HISTORIAN_RADIUS)) continue;

        // 6. Chance gate
        if (Math.random() >= HISTORIAN_CHANCE) continue;

        // 7. Do the thing (scripted, zero LLM)
        doHistorianWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-historians] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-historians] tick failed:", e?.message ?? e);
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

function doHistorianWork(director, record, citizen, type, nowMs) {
  const archive = archiveFor(record);
  const day = dayNumber(nowMs);
  const kid = record.kingdomId || "misthalin";

  // Big chronicle moment: once per archive per day.
  const chronKey = "chronicle:" + archive.name + ":" + day;
  const rng = seededRng(hashStr(chronKey));
  if (rng() < CHRONICLE_CHANCE && !lastFiredByCitizen.has(chronKey)) {
    lastFiredByCitizen.set(chronKey, nowMs);
    const ch = chronicleFor(kid, nowMs);
    const line = fill(pickOne(Math.random, CHRONICLE_LINES), {
      kingdom: ch.kingdom,
      entry: ch.entries[0] || "a quiet day",
    });
    citizen.forceChat?.(line);
    journalize(citizen, `entered today's chronicle at ${archive.name}`);
    seedRumor(citizen, `wrote today's chronicle of ${ch.kingdom}`, archive.name);
    return;
  }

  // A nearby player with a pending ledger entry gets a personal answer
  // before any routine flavor — real requests deserve real replies.
  const pending = pendingLedgerFor(director, citizen, HISTORIAN_RADIUS, nowMs);
  if (pending && Math.random() < 0.6) {
    citizen.forceChat?.(LEDGER_ACK_LINES[pending.kind]);
    journalize(citizen, `answered a ${pending.kind} request from ${pending.playerName} at ${archive.name}`);
    return;
  }

  // Routine: recording emote, read offer, or cross-system flavor.
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, RECORD_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `recorded events at ${archive.name}`);
  } else if (roll < 0.75) {
    const line = fill(pickOne(Math.random, READ_LINES), { kingdom: kingdomName(kid) });
    citizen.forceChat?.(line);
    const note = librarianNoteFor(record.username, kid, nowMs);
    if (note) journalize(citizen, `${note} (via the librarians' catalog)`);
  } else if (type === HISTORIAN_LOREKEEPER) {
    const preserved = preservedLegendFor(kid, nowMs);
    if (preserved) {
      citizen.forceChat?.("*copies a fading legend into the permanent record*");
      journalize(citizen, preserved.text);
      seedRumor(citizen, `preserved the fading legend of ${preserved.legend}`, archive.name);
    } else {
      const line = pickOne(Math.random, RECORD_LINES[type]);
      citizen.forceChat?.(line);
    }
  } else if (type === HISTORIAN_GENEALOGIST) {
    citizen.forceChat?.("Bring me your grandfather's name and I'll find the rest of him.");
    journalize(citizen, `offered to trace family lines at ${archive.name}`);
  } else {
    const line = pickOne(Math.random, type === HISTORIAN_CHRONICLER ? CONTRIBUTION_LINES : COMMISSION_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `offered historical services at ${archive.name}`);
  }
}

module.exports = {
  tickHistorians,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  historianTypeOf,
  historianTypeFromRoll,
  archiveFor,
  chronicleFor,
  chronicleEventsFor,
  recentChronicles,
  legendPreservedFor,
  preservedLegendFor,
  librarianNoteFor,
  requestReading,
  readingFor,
  contributeAccount,
  accountFor,
  commissionHistory,
  commissionFor,
  anyRealPlayerNear,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  dayNumber,
  seededRng,
  isArchiveHour,
  isRealPlayer,
  withinTiles,
  HISTORIAN_TYPES,
  HISTORIAN_CHRONICLER,
  HISTORIAN_ARCHIVIST,
  HISTORIAN_GENEALOGIST,
  HISTORIAN_LOREKEEPER,
  CHRONICLE_LINES,
  LEDGER_ACK_LINES,
  ARCHIVES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    reads.clear();
    accounts.clear();
    commissions.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
    _journalEvent = null;
    _seedRumor = null;
  },
};
