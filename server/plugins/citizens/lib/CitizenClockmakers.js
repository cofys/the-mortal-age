"use strict";

/**
 * CitizenClockmakers — horologists, assemblers, repairers and sellers who
 * build the kingdoms' clocks, watches and timepieces.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived clockmaker types, per-day timepiece catalogs, 6-9-day
 *   great works (clocktowers, astronomical clocks), masterwork unveilings,
 *   a 7-day TTL commission ledger and a repair ledger. Reads the real
 *   CitizenJewelers gem tables (jeweled bearings) and the real
 *   CitizenEngineers metal tables (brass movements) so the fiction is
 *   consistent.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-17:00): scripted precision-assembly emotes, timepiece hawking,
 * masterwork unveiling fanfare, repair and commission offers, coin tips
 * ("use coins on clockmaker").
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director proximity tick right after the engineers block.
 * Plain-node testable: CitizenClockmakers.test.js.
 */

const { normalizeName } = require("./CitizenBonds");

// Hoisted exclusion-chain requires (was: lazy require per citizen per tick).
// The chain is linear with no back-references, so top-level is safe.
function safeRequire(path) {
  try { return require(path); } catch { return null; }
}
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
const _typeCache = new Map(); // normName -> type|null
const _TYPE_CACHE_MAX = 1000;
function memoizedTypeOf(name, compute) {
  if (_typeCache.has(name)) return _typeCache.get(name);
  const result = compute();
  if (_typeCache.size >= _TYPE_CACHE_MAX) {
    const firstKey = _typeCache.keys().next().value;
    _typeCache.delete(firstKey);
  }
  _typeCache.set(name, result);
  return result;
}

// === Tuning ===
const CLOCKMAKER_RADIUS = 14; // tiles — close enough to see/hear
const CLOCKMAKER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const CLOCKMAKER_CHANCE = 0.35; // per eligible citizen per proximity tick
const CLOCKMAKER_SHARE = 30; // nominal % of commoners
const WORKSHOP_START_HOUR = 8; // 08:00 server time
const WORKSHOP_END_HOUR = 17; // 17:00 server time
const GREAT_WORK_MIN_DAYS = 6;
const GREAT_WORK_MAX_DAYS = 9;
const MASTERWORK_CHANCE = 0.08; // per workshop per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip

// === Clockmaker types ===
const CLOCKMAKER_HOROLOGIST = "horologist";
const CLOCKMAKER_ASSEMBLER = "assembler";
const CLOCKMAKER_REPAIRER = "repairer";
const CLOCKMAKER_SELLER = "seller";
const CLOCKMAKER_TYPES = [
  CLOCKMAKER_HOROLOGIST,
  CLOCKMAKER_ASSEMBLER,
  CLOCKMAKER_REPAIRER,
  CLOCKMAKER_SELLER,
];
const CLOCKMAKER_WEIGHTS = {
  [CLOCKMAKER_HOROLOGIST]: 30,
  [CLOCKMAKER_ASSEMBLER]: 30,
  [CLOCKMAKER_REPAIRER]: 20,
  [CLOCKMAKER_SELLER]: 20,
};

// === Workshops (kingdom-preferred) ===
const WORKSHOPS = [
  { name: "the Varrock Clocktower Workshop", kingdom: "misthalin" },
  { name: "the Lumbridge Bell Tower Loft", kingdom: "misthalin" },
  { name: "the Falador Horologists' Guild", kingdom: "asgarnia" },
  { name: "the White Knights' Clock Hall", kingdom: "asgarnia" },
  { name: "the Ardougne Precision Atelier", kingdom: "kandarin" },
  { name: "the Hemenster Chronometer Works", kingdom: "kandarin" },
  { name: "the Keldagrim Deep Time Hall", kingdom: "keldagrim" },
  { name: "the Dorgesh Gear Caves", kingdom: "keldagrim" },
  { name: "the Darkmeyer Nightglass Atelier", kingdom: "morytania" },
  { name: "the Al Kharid Sundial Court", kingdom: "kharidian" },
];

// === Timepieces ===
const TIMEPIECES = [
  { name: "a verge-and-foliot movement", kinds: [CLOCKMAKER_HOROLOGIST] },
  { name: "a pendulum regulator", kinds: [CLOCKMAKER_HOROLOGIST] },
  { name: "a marine chronometer", kinds: [CLOCKMAKER_HOROLOGIST] },
  { name: "a tower-clock escapement", kinds: [CLOCKMAKER_HOROLOGIST] },
  { name: "a mantel clock", kinds: [CLOCKMAKER_ASSEMBLER] },
  { name: "a wall regulator", kinds: [CLOCKMAKER_ASSEMBLER] },
  { name: "a grandfather clock", kinds: [CLOCKMAKER_ASSEMBLER] },
  { name: "a carriage clock", kinds: [CLOCKMAKER_ASSEMBLER] },
  { name: "a freshly serviced pocket watch", kinds: [CLOCKMAKER_REPAIRER] },
  { name: "a recased mantel clock", kinds: [CLOCKMAKER_REPAIRER] },
  { name: "a re-strung wall clock", kinds: [CLOCKMAKER_REPAIRER] },
  { name: "a re-pinned music movement", kinds: [CLOCKMAKER_REPAIRER] },
  { name: "a silver pocket watch", kinds: [CLOCKMAKER_SELLER] },
  { name: "a brass pocket chronometer", kinds: [CLOCKMAKER_SELLER] },
  { name: "a jeweled wristlet", kinds: [CLOCKMAKER_SELLER] },
  { name: "a travel alarm clock", kinds: [CLOCKMAKER_SELLER] },
];

const MASTERWORKS = [
  "a tourbillon pocket watch",
  "a moonphase astronomical clock",
  "a singing-bird automaton clock",
  "a diamond-set chronometer",
];

const GREAT_WORKS = [
  "the Grand Clocktower of {kingdom}",
  "the Meridian Sundial of {kingdom}",
  "the Great Astronomical Clock of {kingdom}",
  "the Belfry Chimes of {kingdom}",
];

// === Scripted lines ===
const WORK_LINES = {
  [CLOCKMAKER_HOROLOGIST]: [
    "*files a gear tooth to a whisper*",
    "*tests the escapement tick*",
    "A second lost is a second never found again.",
    "*loupes a balance wheel*",
  ],
  [CLOCKMAKER_ASSEMBLER]: [
    "*seats the mainspring barrel*",
    "*fits the dial to the plate*",
    "Steady hands, now — the train goes in together or not at all.",
    "*oils the pinions*",
  ],
  [CLOCKMAKER_REPAIRER]: [
    "*opens a watch case*",
    "*cleans a fouled pivot*",
    "Brought in dead, she'll leave keeping Greenwich time.",
    "*replaces a broken mainspring*",
  ],
  [CLOCKMAKER_SELLER]: [
    "*polishes a watch glass*",
    "*winds the display pieces*",
    "Every piece guaranteed to outlive its owner — ask about the warranty.",
    "*arranges the chronometers in a row*",
  ],
};

const HAWK_LINES = [
  "Fine timepieces today! {piece} — built to keep true time!",
  "Fresh from the bench: {piece}. Wind it once, trust it forever!",
  "{piece}, {piece} — every household needs one!",
];

const UNVEIL_LINES = [
  "Behold! {work} stands complete! The hours themselves applaud!",
  "She's done! {work} — come and hear her strike!",
  "After {days} days of precision work — {work} is finished!",
];

const MASTERWORK_LINES = [
  "Step closer — {piece}. I may never build its like again.",
  "Behold my masterwork: {piece}. The guild inspectors wept.",
];

const COMMISSION_LINES = [
  "I build to commission, friend — tower clocks, pocket watches, chronometers.",
  "Need a timepiece made? Leave your name and come back in a few days.",
];

const REPAIR_LINES = [
  "Watch running slow? I mend timepieces — bring her in and I'll have a look.",
  "Stuck hands, broken springs, tired mainsprings — I fix them all.",
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
const repairs = new Map(); // normName -> { item, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of commissions) {
    if (nowMs - v.at > LEDGER_TTL_MS) commissions.delete(k);
  }
  for (const [k, v] of repairs) {
    if (nowMs - v.at > LEDGER_TTL_MS) repairs.delete(k);
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

/** Weighted pick of a clockmaker type from a 0..99 roll. */
function clockmakerTypeFromRoll(roll) {
  let acc = 0;
  for (const t of CLOCKMAKER_TYPES) {
    acc += CLOCKMAKER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return CLOCKMAKER_HOROLOGIST;
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

/** True during workshop hours (08:00-17:00 server time). */
function isWorkshopHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORKSHOP_START_HOUR && h < WORKSHOP_END_HOUR;
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
// Clockmaker identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The clockmaker type for a roster record, or null.
 * Excludes engineers, architects, builders, smiths, jewelers, performers and
 * other artist systems so no citizen belongs to two professional systems.
 */
function clockmakerTypeOf(record) {
  try {
    const name = normalizeName(record?.username);
    if (!name) return null;
    return memoizedTypeOf(name, () => computeClockmakerType(record, name));
  } catch {
    return null;
  }
}

function computeClockmakerType(record, name) {
  try {
    // No overlap: engineers own machines, architects own designs, builders own
    // construction, smiths own metalwork, jewelers own gems.
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
    const roll = hashStr("clockmaker:" + name) % 100;
    if (roll >= CLOCKMAKER_SHARE) return null;
    return clockmakerTypeFromRoll(hashStr("clockmakertype:" + name) % 100);
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
  return pool[hashStr("clockworkshop:" + name) % pool.length];
}

/**
 * The day's timepiece catalog for a clockmaker (2-3 pieces of their type).
 * Derived from date + hash; zero storage.
 */
function piecesFor(username, kingdomId, dateMs) {
  const name = normalizeName(username) || "anon";
  const type = clockmakerTypeOf({ username: name, kingdomId });
  const kinds = type ? [type] : CLOCKMAKER_TYPES;
  const pool = TIMEPIECES.filter((d) => d.kinds.some((k) => kinds.includes(k)));
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("pieces:" + name + ":" + day));
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
  const cycle = GREAT_WORK_MIN_DAYS + (hashStr("greatwork:" + workshop.name) % (GREAT_WORK_MAX_DAYS - GREAT_WORK_MIN_DAYS + 1));
  const epoch = hashStr("greatworkepoch:" + workshop.name) % cycle;
  const startedDay = day - ((day - epoch) % cycle);
  const work = fill(pickOne(seededRng(hashStr("greatworkname:" + workshop.name + ":" + startedDay)), GREAT_WORKS), {
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
 * The jeweled bearing set in today's fine movements — read from the real
 * CitizenJewelers tables via lazy require (with a static fallback), so the
 * clockmakers' fine work matches what the jewelers actually cut.
 */
function jewelForToday(dateMs) {
  try {
    const jewelers = require("./CitizenJewelers");
    if (typeof jewelers.jewelsFor === "function") {
      const jewels = jewelers.jewelsFor("clockmaker-shop", null, dateMs);
      if (Array.isArray(jewels) && jewels.length) return jewels[0];
    }
  } catch { /* module absent */ }
  return "a polished garnet";
}

/**
 * Today's brass for the movements — read from the real CitizenEngineers
 * metal tables via lazy require (with a static fallback).
 */
function metalForToday(dateMs) {
  try {
    const engineers = require("./CitizenEngineers");
    if (typeof engineers.metalForToday === "function") {
      return engineers.metalForToday(dateMs);
    }
  } catch { /* module absent */ }
  return "brass";
}

/** Today's masterwork at a workshop (~8%/day), or null. */
function masterworkFor(workshop, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("masterwork:" + workshop.name + ":" + day));
  if (rng() >= MASTERWORK_CHANCE) return null;
  return pickOne(rng, MASTERWORKS);
}

// ============================================================================
// Player commissions and repairs (data tier, zero LLM).
// ============================================================================

/** Commission a timepiece: recorded; the LLM tier handles dialogue. */
function commissionTimepiece(playerName, piece, nowMs = Date.now()) {
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

/** Leave a timepiece in for repair: recorded; the LLM tier handles dialogue. */
function requestRepair(playerName, item, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !item) return null;
  pruneLedgers(nowMs);
  repairs.set(name, { item: String(item), at: nowMs });
  return item;
}

/** The active repair job for a player, or null. */
function repairFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = repairs.get(name);
  return rec ? rec.item : null;
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
// Coin tips: "use coins on clockmaker" (registered in Citizens.plugin.js
// onTipSeen after tipEngineer). Each handler ignores non-own targets.
// ============================================================================

function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

const TIP_THANKS = [
  "Much obliged! Time flies when the till is full.",
  "Thank you kindly — may your hours never drag.",
];

function tipClockmaker(event, deps = {}, nowMs = Date.now()) {
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
  const type = clockmakerTypeOf(record);
  if (!type) return; // not a clockmaker — let the next handler have it

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
    target.forceChat?.(pickOne(Math.random, TIP_THANKS));
  } catch { /* cosmetic */ }
  journalize(target, `received a ${amount}-coin tip from ${player.getUsername?.() ?? "a patron"}`);
  return amount;
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → clockmaker? → materialized → workshop
// hours → real player near → chance → work.
// ============================================================================

function tickClockmakers(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < CLOCKMAKER_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a clockmaker (hash-derived, cheap)
        const type = clockmakerTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Workshop hours only
        if (!isWorkshopHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, CLOCKMAKER_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, CLOCKMAKER_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doClockmakerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-clockmakers] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-clockmakers] tick failed:", e?.message ?? e);
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

function doClockmakerWork(director, record, citizen, type, nowMs) {
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
      citizen.forceChat?.(line);
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
      const line = fill(pickOne(Math.random, MASTERWORK_LINES), { piece: mw });
      citizen.forceChat?.(line);
      journalize(citizen, `unveiled a masterwork at ${workshop.name}: ${mw}`);
      seedRumor(`A masterwork ${mw} unveiled at ${workshop.name}!`);
      return;
    }
  }

  // Routine: work emote, hawking, repair/commission offer.
  const roll = Math.random();
  if (roll < 0.45) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `worked at ${workshop.name}`);
  } else if (roll < 0.75) {
    const pieces = piecesFor(name, record.kingdomId, nowMs);
    const piece = pieces.length ? pieces[0] : "a fine timepiece";
    const jewel = jewelForToday(nowMs);
    const metal = metalForToday(nowMs);
    const line = fill(pickOne(Math.random, HAWK_LINES), { piece });
    citizen.forceChat?.(line + ` Set with ${jewel}, cased in ${metal}.`);
    journalize(citizen, `hawked ${piece} at ${workshop.name}`);
  } else if (type === CLOCKMAKER_REPAIRER) {
    const line = pickOne(Math.random, REPAIR_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `offered repairs at ${workshop.name}`);
  } else {
    const line = pickOne(Math.random, COMMISSION_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `offered commissions at ${workshop.name}`);
  }
}

module.exports = {
  tickClockmakers,
  tipClockmaker,
  commissionTimepiece,
  commissionFor,
  requestRepair,
  repairFor,
  masterworkFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  clockmakerTypeOf,
  workshopFor,
  piecesFor,
  greatWorkFor,
  jewelForToday,
  metalForToday,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  clockmakerTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isWorkshopHour,
  dayNumber,
  chance,
  seededRng,
  kingdomName,
  CLOCKMAKER_TYPES,
  CLOCKMAKER_HOROLOGIST,
  CLOCKMAKER_ASSEMBLER,
  CLOCKMAKER_REPAIRER,
  CLOCKMAKER_SELLER,
  WORKSHOPS,
  TIMEPIECES,
  MASTERWORKS,
  GREAT_WORKS,
};
