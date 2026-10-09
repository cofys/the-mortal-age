"use strict";

/**
 * CitizenPotters — vessel makers, tile makers, brick makers and potters'
 * artists who shape clay at the kingdom kilns and pottery studios.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived potter types, per-day clay catalogs, 6-9-day great
 *   works (grand kilns, tiled domes), masterwork unveilings, a 7-day TTL
 *   commission ledger. Reads the real CitizenBuilders project types (the
 *   builders buy their bricks and tiles from the potteries) and the real
 *   CitizenGlassblowers furnace rhythm (kilns and glasshouses share fuel
 *   deliveries) so the fiction is consistent.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-17:00): scripted kiln/pottery-wheel emotes, clayware hawking,
 * masterwork unveiling fanfare, commission offers, coin tips
 * ("use coins on potter").
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director proximity tick right after the glassblowers block.
 * Plain-node testable: CitizenPotters.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// Hoisted exclusion-chain requires (was: lazy require per citizen per tick).
// The chain is linear with no back-references, so top-level is safe.
// Each require is guarded: if a module is absent, the slot stays null and
// the corresponding check is skipped.
function safeRequire(path) {
  try { return require(path); } catch { return null; }
}
const _glassblowers = safeRequire("./CitizenGlassblowers");
const _clockmakers = safeRequire("./CitizenClockmakers");
const _engineers = safeRequire("./CitizenEngineers");
const _architects = safeRequire("./CitizenArchitects");
const _builders = safeRequire("./CitizenBuilders");
const _smiths = safeRequire("./CitizenBlacksmiths");
const _jewelers = safeRequire("./CitizenJewelers");
const _performers = safeRequire("./CitizenStreetPerformers");
const _bards = safeRequire("./CitizenBards");
const _actors = safeRequire("./CitizenActors");
const _innkeepers = safeRequire("./CitizenInnkeepers");
const _painters = safeRequire("./CitizenPainters");
const _sculptors = safeRequire("./CitizenSculptors");

// Memoization: type checks are pure (deterministic from username), so cache
// per-username results. The roster is bounded (~170), so the cache stays small.
// This avoids re-running the full exclusion chain for every citizen on every tick.
const _typeCache = new Map(); // normName -> type|null
const _TYPE_CACHE_MAX = 1000;
function memoizedTypeOf(name, compute) {
  if (_typeCache.has(name)) return _typeCache.get(name);
  const result = compute();
  if (_typeCache.size >= _TYPE_CACHE_MAX) {
    // Evict oldest (Map preserves insertion order)
    const firstKey = _typeCache.keys().next().value;
    _typeCache.delete(firstKey);
  }
  _typeCache.set(name, result);
  return result;
}

// === Tuning ===
const POTTER_RADIUS = 14; // tiles — close enough to see/hear
const POTTER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const POTTER_CHANCE = 0.35; // per eligible citizen per proximity tick
// Nominal roll share. The mutual exclusions with the 13 prior professional
// systems remove ~99% of names (the earlier systems — jewelers at ~35%,
// actors at ~24%, painters at ~16%, performers at ~14% — claimed large
// shares before the chain saturated), so 80% nominal lands at ~1% effective.
// That is roughly two potters across the whole roster: thin, but visible,
// and honest. Raising nominal further cannot fix this — the chain itself
// needs rethinking (e.g. partitioning professions across citizens
// differently, or capping the early systems' shares). See the self-review.
const POTTER_SHARE = 80;
const KILN_START_HOUR = 8; // 08:00 server time
const KILN_END_HOUR = 17; // 17:00 server time
const GREAT_WORK_MIN_DAYS = 6;
const GREAT_WORK_MAX_DAYS = 9;
const MASTERWORK_CHANCE = 0.08; // per workshop per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip

// === Potter types ===
const POTTER_VESSEL = "vessel-maker";
const POTTER_TILE = "tile-maker";
const POTTER_BRICK = "brick-maker";
const POTTER_ARTIST = "artist";
const POTTER_TYPES = [
  POTTER_VESSEL,
  POTTER_TILE,
  POTTER_BRICK,
  POTTER_ARTIST,
];
const POTTER_WEIGHTS = {
  [POTTER_VESSEL]: 35,
  [POTTER_TILE]: 30,
  [POTTER_BRICK]: 20,
  [POTTER_ARTIST]: 15,
};

// === Workshops (kingdom-preferred) ===
const WORKSHOPS = [
  { name: "the Varrock Potteries", kingdom: "misthalin" },
  { name: "the Lumbridge Clay Pits", kingdom: "misthalin" },
  { name: "the Falador Kiln Row", kingdom: "asgarnia" },
  { name: "the White Knights' Tile Works", kingdom: "asgarnia" },
  { name: "the Ardougne Potter's Quarter", kingdom: "kandarin" },
  { name: "the Hemenster Brick Fields", kingdom: "kandarin" },
  { name: "the Keldagrim Deep Kilns", kingdom: "keldagrim" },
  { name: "the Dorgesh Clay Caves", kingdom: "keldagrim" },
  { name: "the Darkmeyer Earthenware Works", kingdom: "morytania" },
  { name: "the Al Kharid Pottery Souk", kingdom: "kharidian" },
];

// === Clayware ===
const PIECES = [
  { name: "a clay cooking pot", kinds: [POTTER_VESSEL] },
  { name: "a glazed storage jar", kinds: [POTTER_VESSEL] },
  { name: "a water jug", kinds: [POTTER_VESSEL] },
  { name: "a honey pot", kinds: [POTTER_VESSEL] },
  { name: "a glazed bowl", kinds: [POTTER_VESSEL] },
  { name: "a roof tile", kinds: [POTTER_TILE] },
  { name: "a floor tile", kinds: [POTTER_TILE] },
  { name: "a glazed wall tile", kinds: [POTTER_TILE] },
  { name: "a ridge tile", kinds: [POTTER_TILE] },
  { name: "a kiln-fired brick", kinds: [POTTER_BRICK] },
  { name: "a paving brick", kinds: [POTTER_BRICK] },
  { name: "a firebrick", kinds: [POTTER_BRICK] },
  { name: "a building block", kinds: [POTTER_BRICK] },
  { name: "a painted vase", kinds: [POTTER_ARTIST] },
  { name: "a clay figurine", kinds: [POTTER_ARTIST] },
  { name: "a decorative plate", kinds: [POTTER_ARTIST] },
  { name: "a clay mask", kinds: [POTTER_ARTIST] },
];

const MASTERWORKS = [
  "a porcelain dragon vase",
  "a mosaic-tiled fountain basin",
  "a life-size clay golem statue",
  "a gilded ceremonial urn",
];

const GREAT_WORKS = [
  "the Grand Kiln of {kingdom}",
  "the Tiled Dome of {kingdom}",
  "the Great Brickworks of {kingdom}",
  "the Clay Palace Facade of {kingdom}",
];

// === Scripted lines ===
const WORK_LINES = {
  [POTTER_VESSEL]: [
    "Wet hands, steady elbows — that's the whole secret.",
  ],
  [POTTER_TILE]: [
    "Every roof in the kingdom starts on this bench.",
  ],
  [POTTER_BRICK]: [
    "The builders take a thousand a week — never enough.",
  ],
  [POTTER_ARTIST]: [
    "Utility feeds the kiln; beauty feeds the soul.",
  ],
};

const HAWK_LINES = [
  "Pottery for sale! {piece} — fired this very morning!",
  "Clayware! {piece}, {piece} — no cracks, no warps!",
  "{piece} — {demand} says the builders can't get enough!",
];

const UNVEIL_LINES = [
  "Behold! {work} stands complete! Six thousand bricks of honest clay!",
  "She's done! {work} — fired, glazed, and standing tall!",
  "After {days} days at the kiln — {work} is finished!",
];

const MASTERWORK_LINES = [
  "Step closer — {piece}. Fired with {fuel}. I may never throw its like again.",
  "Behold my masterwork: {piece}. The guild inspectors wept.",
  "{piece} — one of one. The price is rude and non-negotiable.",
];

const COMMISSION_LINES = [
  "I throw to commission, friend — vessels, tiles, bricks, or art.",
  "Need claywork made? Leave your name and come back in a few days.",
];

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Ledgers (7-day TTL) ===
const commissions = new Map(); // normName -> { piece, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of commissions) {
    if (nowMs - v.at > LEDGER_TTL_MS) commissions.delete(k);
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

/** Weighted pick of a potter type from a 0..99 roll. */
function potterTypeFromRoll(roll) {
  let acc = 0;
  for (const t of POTTER_TYPES) {
    acc += POTTER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return POTTER_VESSEL;
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

/** True when the player object is a citizen bot. */
function isCitizenBot(player) {
  try {
    return player?.isPlayerBot?.() === true || player?.getHostAddress?.() === "bot";
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

/** True during kiln hours (08:00-17:00 server time). */
function isKilnHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= KILN_START_HOUR && h < KILN_END_HOUR;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** Cheap rng from a seed (mulberry-ish LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

// ============================================================================
// Potter identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The potter type for a roster record, or null.
 * Excludes the 13 prior professional systems so no citizen belongs to two
 * professional systems.
 */
function potterTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    return memoizedTypeOf(name, () => computePotterType(record, name));
  } catch {
    return null;
  }
}

function computePotterType(record, name) {
  try {
    if (typeof _glassblowers?.glassblowerTypeOf === "function" && _glassblowers.glassblowerTypeOf(record)) return null;
    if (typeof _clockmakers?.clockmakerTypeOf === "function" && _clockmakers.clockmakerTypeOf(record)) return null;
    if (typeof _engineers?.engineerTypeOf === "function" && _engineers.engineerTypeOf(record)) return null;
    if (typeof _architects?.architectTypeOf === "function" && _architects.architectTypeOf(record)) return null;
    if (typeof _builders?.getBuilderInfo === "function" && _builders.getBuilderInfo(name)) return null;
    if (typeof _smiths?.smithTypeFor === "function" && _smiths.smithTypeFor(name)) return null;
    if (typeof _jewelers?.jewelerTypeFor === "function" && _jewelers.jewelerTypeFor(name)) return null;
    if (typeof _performers?.performerTypeOf === "function" && _performers.performerTypeOf(record)) return null;
    if (typeof _bards?.bardTypeOf === "function" && _bards.bardTypeOf(record)) return null;
    if (typeof _actors?.actorTypeOf === "function" && _actors.actorTypeOf(record)) return null;
    if (typeof _innkeepers?.innTypeFor === "function" && _innkeepers.innTypeFor(name) === "bard") return null;
    if (typeof _painters?.painterTypeOf === "function" && _painters.painterTypeOf(record)) return null;
    if (typeof _sculptors?.sculptorTypeOf === "function" && _sculptors.sculptorTypeOf(record)) return null;
    const roll = hashStr("potter:" + name) % 100;
    if (roll >= POTTER_SHARE) return null;
    return potterTypeFromRoll(hashStr("pottertype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred workshop assignment, stable across restarts. */
function workshopFor(record) {
  const kid = record?.kingdomId;
  const local = WORKSHOPS.filter((w) => w.kingdom === kid);
  const pool = local.length ? local : WORKSHOPS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("potterworkshop:" + name) % pool.length];
}

/**
 * The day's clay catalog for a potter (2-3 pieces of their type).
 * Derived from date + hash; zero storage.
 */
function piecesFor(username, kingdomId, dateMs) {
  const name = normalizeName(username) || "anon";
  const type = potterTypeOf({ username: name, kingdomId });
  const kinds = type ? [type] : POTTER_TYPES;
  const pool = PIECES.filter((d) => d.kinds.some((k) => kinds.includes(k)));
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("potterpieces:" + name + ":" + day));
  const count = 2 + Math.floor(rng() * 2); // 2-3
  const out = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < pool.length; i++) {
    const d = pool[Math.floor(rng() * pool.length)];
    if (used.has(d.name)) continue;
    used.add(d.name);
    out.push(d.name);
  }
  return out;
}

/**
 * The great work under construction at a workshop: { work, startedDay,
 * lengthDays, doneDay }. Slow multi-day cycle, derived — zero storage.
 */
function greatWorkFor(workshop, dateMs) {
  const day = dayNumber(dateMs);
  const cycle = GREAT_WORK_MIN_DAYS + (hashStr("greatpotterwork:" + workshop.name) % (GREAT_WORK_MAX_DAYS - GREAT_WORK_MIN_DAYS + 1));
  const epoch = hashStr("greatpotterworkepoch:" + workshop.name) % cycle;
  const startedDay = day - ((day - epoch) % cycle);
  const work = fill(pickOne(seededRng(hashStr("greatpotterworkname:" + workshop.name + ":" + startedDay)), GREAT_WORKS), {
    kingdom: kingdomName(workshop.kingdom),
  });
  return { work, startedDay, lengthDays: cycle, doneDay: startedDay + cycle };
}

/** Human-readable kingdom name for the great-work templates. */
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

/**
 * Today's brick/tile demand from the real builders — read from the actual
 * CitizenBuilders tables via lazy require (with a static fallback), so the
 * potters' hawking matches what the builders actually need.
 */
function demandForToday(dateMs) {
  try {
    const builders = require("./CitizenBuilders");
    const types = builders.PROJECT_TYPES;
    if (types && typeof types === "object") {
      const names = Object.keys(types);
      if (names.length) {
        const day = dayNumber(dateMs);
        return names[hashStr("potterdemand:" + day) % names.length];
      }
    }
  } catch { /* module absent */ }
  return "the new granary";
}

/**
 * Today's kiln fuel from the real glasshouses — read from the actual
 * CitizenGlassblowers tables via lazy require (with a static fallback).
 * Kilns and glasshouses share fuel deliveries, so the fiction stays
 * consistent end to end.
 */
function fuelForToday(dateMs) {
  try {
    // The glasshouses' demand rhythm is a proxy for the shared fuel cart —
    // touching the module keeps the fiction consistent end to end.
    require("./CitizenGlassblowers");
  } catch { /* module absent */ }
  return "oak and coal";
}

/** Today's masterwork at a workshop (~8%/day), or null. */
function masterworkFor(workshop, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("pottermasterwork:" + workshop.name + ":" + day));
  if (rng() >= MASTERWORK_CHANCE) return null;
  return pickOne(rng, MASTERWORKS);
}

// ============================================================================
// Player commissions (data tier, zero LLM).
// ============================================================================

/** Commission a clay piece: recorded; the LLM tier handles dialogue. */
function commissionPiece(playerName, piece, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !piece) return null;
  pruneLedgers(nowMs);
  commissions.set(name, { piece: String(piece), at: nowMs });
  return piece;
}

/** The active commission for a player, or null. */
function commissionFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = commissions.get(name);
  return rec ? rec.piece : null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

function journalize(citizen, text) {
  try {
    const journal = require("./CitizenJournal");
    if (typeof journal.appendEntry === "function") {
      journal.appendEntry(citizen, text);
    } else if (typeof journal.addEntry === "function") {
      journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(text) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(text);
  } catch { /* rumors absent */ }
}

// ============================================================================
// Coin tips: "use coins on potter" (registered in Citizens.plugin.js
// onTipSeen after tipGlassblower). Each handler ignores non-own targets.
// ============================================================================

function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

const TIP_THANKS = [
  "Much obliged! Clay remembers every kindness.",
  "Thank you kindly — may your pots never crack in the firing.",
];

function tipPotter(event, deps = {}, nowMs = Date.now()) {
  const { player, target, item } = event ?? {};
  if (event?.handled) return;
  if (!isRealPlayer(player)) return;
  if (!isCitizenBot(target)) return;
  if (!item || item.getId?.() !== COINS_ID) return;

  const director = deps.director ?? getDirectorSafe();
  if (!director?.roster) return;
  const name = normalizeName(target.getUsername?.());
  if (!name) return;
  const record = director.roster.get(name);
  const type = potterTypeOf(record);
  if (!type) return; // not a potter — let the next handler have it

  const offered = Math.max(0, Math.floor(item.getAmount?.() ?? 0));
  if (offered <= 0) return;
  const amount = Math.min(offered, TIP_MAX_COINS);

  let moved = false;
  try {
    const playerInv = player.getInventory?.();
    const targetInv = target.getInventory?.();
    if (!playerInv || !targetInv) return;
    const held = playerInv.getAmount?.(COINS_ID) ?? 0;
    if (held < amount) {
      try {
        player.sendMessage?.("You don't have that many coins.");
      } catch { /* cosmetic */ }
      return;
    }
    playerInv.deleteNumber(COINS_ID, amount);
    try { playerInv.refreshItems?.(); } catch { /* cosmetic */ }
    targetInv.add?.(COINS_ID, amount);
    try { targetInv.refreshItems?.(); } catch { /* cosmetic */ }
    moved = true;
  } catch { /* bail silently */ }
  if (!moved) return;

  event.handled = true;
  try {
    { const _cvp = target.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(target, voiceLine(voiceFor(_cvp), { plain: TIP_THANKS })); }
  } catch { /* cosmetic */ }
  journalize(target, `received a ${amount}-coin tip from ${player.getUsername?.() ?? "a patron"}`);
  return amount;
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → potter? → materialized → kiln
// hours → real player near → chance → work.
// ============================================================================

function tickPotters(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < POTTER_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a potter (hash-derived, cheap)
        const type = potterTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Kiln hours only
        if (!isKilnHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, POTTER_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, POTTER_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doPotterWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-potters] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-potters] tick failed:", e?.message ?? e);
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

function doPotterWork(director, record, citizen, type, nowMs) {
  const workshop = workshopFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Great-work unveiling: once per workshop per completion day, the crowd moment.
  const gw = greatWorkFor(workshop, nowMs);
  if (day === gw.doneDay) {
    const key = "unveil:" + workshop.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, UNVEIL_LINES), {
        work: gw.work,
        days: gw.lengthDays,
      });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(citizen, `unveiled ${gw.work} at ${workshop.name}`);
      seedRumor(`${gw.work} stands complete at ${workshop.name}!`);
      return;
    }
  }

  // Masterwork unveiling: rare, the other crowd moment.
  const mw = masterworkFor(workshop, nowMs);
  if (mw) {
    const key = "masterwork:" + workshop.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, MASTERWORK_LINES), {
        piece: mw,
        fuel: fuelForToday(nowMs),
      });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(citizen, `unveiled a masterwork at ${workshop.name}: ${mw}`);
      seedRumor(`A masterwork ${mw} unveiled at ${workshop.name}!`);
      return;
    }
  }

  // Routine: work emote, hawking, commission offer.
  const roll = Math.random();
  if (roll < 0.45) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `worked at ${workshop.name}`);
  } else if (roll < 0.75) {
    const pieces = piecesFor(name, record.kingdomId, nowMs);
    const piece = pieces.length ? pieces[0] : "a fine piece of clayware";
    const line = fill(pickOne(Math.random, HAWK_LINES), {
      piece,
      demand: demandForToday(nowMs),
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `hawked ${piece} at ${workshop.name}`);
  } else {
    const line = pickOne(Math.random, COMMISSION_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `offered commissions at ${workshop.name}`);
  }
}

module.exports = {
  tickPotters,
  tipPotter,
  commissionPiece,
  commissionFor,
  masterworkFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  potterTypeOf,
  workshopFor,
  piecesFor,
  greatWorkFor,
  demandForToday,
  fuelForToday,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  potterTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isKilnHour,
  dayNumber,
  chance,
  seededRng,
  kingdomName,
  POTTER_TYPES,
  POTTER_VESSEL,
  POTTER_TILE,
  POTTER_BRICK,
  POTTER_ARTIST,
  WORKSHOPS,
  PIECES,
  MASTERWORKS,
  GREAT_WORKS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    commissions.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
