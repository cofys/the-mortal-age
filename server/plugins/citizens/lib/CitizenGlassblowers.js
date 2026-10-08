"use strict";

/**
 * CitizenGlassblowers — vessel makers, window makers, ornament makers and
 * furnace tenders who blow and shape glass at the kingdom glasshouses.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived glassblower types, per-day glass catalogs, 6-9-day great
 *   works (grand glasshouses, cathedral windows), masterwork unveilings, a
 *   7-day TTL commission ledger. Reads the real CitizenAlchemists glassware
 *   tables (the alchemists buy their vials from the glasshouses) and the
 *   real CitizenJewelers gem tables (jeweled ornament settings) so the
 *   fiction is consistent.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-17:00): scripted furnace/glassblowing emotes, glassware hawking,
 * masterwork unveiling fanfare, commission offers, coin tips
 * ("use coins on glassblower").
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director proximity tick right after the clockmakers block.
 * Plain-node testable: CitizenGlassblowers.test.js.
 */

const { normalizeName } = require("./CitizenBonds");

// Hoisted exclusion-chain requires (was: lazy require per citizen per tick).
// The chain is linear with no back-references, so top-level is safe.
function safeRequire(path) {
  try { return require(path); } catch { return null; }
}
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
const GLASSBLOWER_RADIUS = 14; // tiles — close enough to see/hear
const GLASSBLOWER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const GLASSBLOWER_CHANCE = 0.35; // per eligible citizen per proximity tick
// Nominal roll share. The mutual exclusions with the 12 prior professional
// systems remove ~96% of names, so 75% nominal lands at ~3% effective —
// a visible handful of glassblowers per kingdom, same as the earlier
// systems got when the chain was shorter.
const GLASSBLOWER_SHARE = 75;
const FURNACE_START_HOUR = 8; // 08:00 server time
const FURNACE_END_HOUR = 17; // 17:00 server time
const GREAT_WORK_MIN_DAYS = 6;
const GREAT_WORK_MAX_DAYS = 9;
const MASTERWORK_CHANCE = 0.08; // per workshop per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip

// === Glassblower types ===
const GLASSBLOWER_VESSEL = "vessel-maker";
const GLASSBLOWER_WINDOW = "window-maker";
const GLASSBLOWER_ORNAMENT = "ornament-maker";
const GLASSBLOWER_FURNACE = "furnace-tender";
const GLASSBLOWER_TYPES = [
  GLASSBLOWER_VESSEL,
  GLASSBLOWER_WINDOW,
  GLASSBLOWER_ORNAMENT,
  GLASSBLOWER_FURNACE,
];
const GLASSBLOWER_WEIGHTS = {
  [GLASSBLOWER_VESSEL]: 35,
  [GLASSBLOWER_WINDOW]: 30,
  [GLASSBLOWER_ORNAMENT]: 20,
  [GLASSBLOWER_FURNACE]: 15,
};

// === Workshops (kingdom-preferred) ===
const WORKSHOPS = [
  { name: "the Varrock Glasshouse", kingdom: "misthalin" },
  { name: "the Lumbridge Bottle Works", kingdom: "misthalin" },
  { name: "the Falador Glassworks", kingdom: "asgarnia" },
  { name: "the White Knights' Glaziers' Hall", kingdom: "asgarnia" },
  { name: "the Ardougne Stained Glass Atelier", kingdom: "kandarin" },
  { name: "the Hemenster Bottle House", kingdom: "kandarin" },
  { name: "the Keldagrim Deep Furnace", kingdom: "keldagrim" },
  { name: "the Dorgesh Glass Caves", kingdom: "keldagrim" },
  { name: "the Darkmeyer Nightglass Works", kingdom: "morytania" },
  { name: "the Al Kharid Glass Court", kingdom: "kharidian" },
];

// === Glassware ===
const PIECES = [
  { name: "a blown drinking glass", kinds: [GLASSBLOWER_VESSEL] },
  { name: "a green wine bottle", kinds: [GLASSBLOWER_VESSEL] },
  { name: "a potion vial", kinds: [GLASSBLOWER_VESSEL] },
  { name: "a glass carafe", kinds: [GLASSBLOWER_VESSEL] },
  { name: "a faceted decanter", kinds: [GLASSBLOWER_VESSEL] },
  { name: "a stained-glass pane (saradomin blue)", kinds: [GLASSBLOWER_WINDOW] },
  { name: "a leaded lattice window", kinds: [GLASSBLOWER_WINDOW] },
  { name: "a rose-window panel", kinds: [GLASSBLOWER_WINDOW] },
  { name: "a chapel lancet", kinds: [GLASSBLOWER_WINDOW] },
  { name: "a glass swan", kinds: [GLASSBLOWER_ORNAMENT] },
  { name: "a set of cat's-eye marbles", kinds: [GLASSBLOWER_ORNAMENT] },
  { name: "a glass pendant", kinds: [GLASSBLOWER_ORNAMENT] },
  { name: "a crystal prism", kinds: [GLASSBLOWER_ORNAMENT] },
  { name: "a fire-polished tumbler", kinds: [GLASSBLOWER_FURNACE] },
  { name: "a sturdy storage jar", kinds: [GLASSBLOWER_FURNACE] },
  { name: "a glass brick", kinds: [GLASSBLOWER_FURNACE] },
  { name: "a furnace-grade crucible", kinds: [GLASSBLOWER_FURNACE] },
];

const MASTERWORKS = [
  "a crystal phoenix decanter",
  "a stained-glass rose window",
  "a glass kraken sculpture",
  "a jeweled coronation goblet",
];

const GREAT_WORKS = [
  "the Grand Glasshouse of {kingdom}",
  "the Cathedral Window of {kingdom}",
  "the Great Mirrored Hall of {kingdom}",
  "the Crystal Bell Tower of {kingdom}",
];

// === Scripted lines ===
const WORK_LINES = {
  [GLASSBLOWER_VESSEL]: [
    "*gathers molten glass on the pipe*",
    "*blows into the pipe, cheeks puffed*",
    "Mind the punt — she'll crack if she cools too fast.",
    "*spins the blowpipe, evening the gather*",
  ],
  [GLASSBLOWER_WINDOW]: [
    "*cuts a diamond of blue glass*",
    "*sets a pane into the lead came*",
    "Blue for the sky, red for the blood of kings.",
    "*solders the joints with a steady hand*",
  ],
  [GLASSBLOWER_ORNAMENT]: [
    "*pulls a thread of glass into a swan's neck*",
    "*marvers the gather on the steel table*",
    "Pretty things pay the rent — nobody buys ugly.",
    "*flashes the piece in the glory hole*",
  ],
  [GLASSBLOWER_FURNACE]: [
    "*stokes the furnace mouth*",
    "*banks the coals for the night shift*",
    "Eleven hundred degrees and climbing — mind your eyebrows.",
    "*checks the annealing oven*",
  ],
};

const HAWK_LINES = [
  "Fresh from the furnace! {piece} — blown this very morning!",
  "Glassware for sale! {piece}, {piece} — no chips, no bubbles!",
  "{piece} — {glass} says the alchemists can't keep them in stock!",
];

const UNVEIL_LINES = [
  "Behold! {work} stands complete! Light itself has moved in!",
  "She's done! {work} — come and watch the sunrise through it!",
  "After {days} days at the furnace — {work} is finished!",
];

const MASTERWORK_LINES = [
  "Step closer — {piece}. Set with {jewel}. I may never blow its like again.",
  "Behold my masterwork: {piece}. The guild inspectors wept.",
  "{piece} — one of one. The price is rude and non-negotiable.",
];

const COMMISSION_LINES = [
  "I blow to commission, friend — vessels, windows, ornaments.",
  "Need glasswork made? Leave your name and come back in a few days.",
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

/** Weighted pick of a glassblower type from a 0..99 roll. */
function glassblowerTypeFromRoll(roll) {
  let acc = 0;
  for (const t of GLASSBLOWER_TYPES) {
    acc += GLASSBLOWER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return GLASSBLOWER_VESSEL;
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

/** True during furnace hours (08:00-17:00 server time). */
function isFurnaceHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= FURNACE_START_HOUR && h < FURNACE_END_HOUR;
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
// Glassblower identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The glassblower type for a roster record, or null.
 * Excludes clockmakers, engineers, architects, builders, smiths, jewelers,
 * performers and other artist systems so no citizen belongs to two
 * professional systems.
 */
function glassblowerTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    return memoizedTypeOf(name, () => computeGlassblowerType(record, name));
  } catch {
    return null;
  }
}

function computeGlassblowerType(record, name) {
  try {
    // No overlap: clockmakers own timepieces, engineers own machines,
    // architects own designs, builders own construction, smiths own
    // metalwork, jewelers own gems.
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
    const roll = hashStr("glassblower:" + name) % 100;
    if (roll >= GLASSBLOWER_SHARE) return null;
    return glassblowerTypeFromRoll(hashStr("glassblowertype:" + name) % 100);
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
  return pool[hashStr("glassworkshop:" + name) % pool.length];
}

/**
 * The day's glass catalog for a glassblower (2-3 pieces of their type).
 * Derived from date + hash; zero storage.
 */
function piecesFor(username, kingdomId, dateMs) {
  const name = normalizeName(username) || "anon";
  const type = glassblowerTypeOf({ username: name, kingdomId });
  const kinds = type ? [type] : GLASSBLOWER_TYPES;
  const pool = PIECES.filter((d) => d.kinds.some((k) => kinds.includes(k)));
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("glasspieces:" + name + ":" + day));
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
  const cycle = GREAT_WORK_MIN_DAYS + (hashStr("greatglasswork:" + workshop.name) % (GREAT_WORK_MAX_DAYS - GREAT_WORK_MIN_DAYS + 1));
  const epoch = hashStr("greatglassworkepoch:" + workshop.name) % cycle;
  const startedDay = day - ((day - epoch) % cycle);
  const work = fill(pickOne(seededRng(hashStr("greatglassworkname:" + workshop.name + ":" + startedDay)), GREAT_WORKS), {
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
 * Today's glassware demand from the real alchemists — read from the actual
 * CitizenAlchemists tables via lazy require (with a static fallback), so the
 * glassblowers' hawking matches what the alchemists actually buy.
 */
function glasswareForToday(dateMs) {
  try {
    const alchemists = require("./CitizenAlchemists");
    if (typeof alchemists.waresFor === "function") {
      const wares = alchemists.waresFor("glasshouse-shop", null, dateMs);
      if (Array.isArray(wares) && wares.length) return wares[0];
    }
  } catch { /* module absent */ }
  return "a crate of potion vials";
}

/**
 * Today's jeweled setting for fine ornaments — read from the real
 * CitizenJewelers tables via lazy require (with a static fallback).
 */
function jewelForToday(dateMs) {
  try {
    const jewelers = require("./CitizenJewelers");
    if (typeof jewelers.jewelsFor === "function") {
      const jewels = jewelers.jewelsFor("glasshouse-shop", null, dateMs);
      if (Array.isArray(jewels) && jewels.length) return jewels[0];
    }
  } catch { /* module absent */ }
  return "a polished garnet";
}

/** Today's masterwork at a workshop (~8%/day), or null. */
function masterworkFor(workshop, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("glassmasterwork:" + workshop.name + ":" + day));
  if (rng() >= MASTERWORK_CHANCE) return null;
  return pickOne(rng, MASTERWORKS);
}

// ============================================================================
// Player commissions (data tier, zero LLM).
// ============================================================================

/** Commission a glass piece: recorded; the LLM tier handles dialogue. */
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
// Coin tips: "use coins on glassblower" (registered in Citizens.plugin.js
// onTipSeen after tipClockmaker). Each handler ignores non-own targets.
// ============================================================================

function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

const TIP_THANKS = [
  "Much obliged! Glass is fragile, but my thanks are solid.",
  "Thank you kindly — may your cup never crack.",
];

function tipGlassblower(event, deps = {}, nowMs = Date.now()) {
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
  const type = glassblowerTypeOf(record);
  if (!type) return; // not a glassblower — let the next handler have it

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
// Gate order: cooldown (cheapest) → glassblower? → materialized → furnace
// hours → real player near → chance → work.
// ============================================================================

function tickGlassblowers(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < GLASSBLOWER_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a glassblower (hash-derived, cheap)
        const type = glassblowerTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Furnace hours only
        if (!isFurnaceHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, GLASSBLOWER_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, GLASSBLOWER_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doGlassblowerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-glassblowers] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-glassblowers] tick failed:", e?.message ?? e);
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

function doGlassblowerWork(director, record, citizen, type, nowMs) {
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
      const line = fill(pickOne(Math.random, MASTERWORK_LINES), {
        piece: mw,
        jewel: jewelForToday(nowMs),
      });
      citizen.forceChat?.(line);
      journalize(citizen, `unveiled a masterwork at ${workshop.name}: ${mw}`);
      seedRumor(`A masterwork ${mw} unveiled at ${workshop.name}!`);
      return;
    }
  }

  // Routine: work emote, hawking, commission offer.
  const roll = Math.random();
  if (roll < 0.45) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `worked at ${workshop.name}`);
  } else if (roll < 0.75) {
    const pieces = piecesFor(name, record.kingdomId, nowMs);
    const piece = pieces.length ? pieces[0] : "a fine piece of glass";
    const line = fill(pickOne(Math.random, HAWK_LINES), {
      piece,
      glass: glasswareForToday(nowMs),
    });
    citizen.forceChat?.(line);
    journalize(citizen, `hawked ${piece} at ${workshop.name}`);
  } else {
    const line = pickOne(Math.random, COMMISSION_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `offered commissions at ${workshop.name}`);
  }
}

module.exports = {
  tickGlassblowers,
  tipGlassblower,
  commissionPiece,
  commissionFor,
  masterworkFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  glassblowerTypeOf,
  workshopFor,
  piecesFor,
  greatWorkFor,
  glasswareForToday,
  jewelForToday,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  glassblowerTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isFurnaceHour,
  dayNumber,
  chance,
  seededRng,
  kingdomName,
  GLASSBLOWER_TYPES,
  GLASSBLOWER_VESSEL,
  GLASSBLOWER_WINDOW,
  GLASSBLOWER_ORNAMENT,
  GLASSBLOWER_FURNACE,
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
