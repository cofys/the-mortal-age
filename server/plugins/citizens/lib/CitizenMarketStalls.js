"use strict";

/**
 * CitizenMarketStalls — merchants run real market stalls.
 *
 * Data tier, zero LLM. On the fast (~10s) visible-life tick, online merchant
 * citizens claim a market stall during market hours (08:00–19:00 server
 * time), walk to their deterministic stall spot near the kingdom's market
 * anchor, and set up 3-5 wares for the day with personality-driven list
 * prices (greedy = high, easygoing/cheerful = low). At night they pack up
 * and the stall closes.
 *
 * Selling goes through the existing MerchantShops Trade interface: this
 * module publishes the day's wares on the merchant's
 * `citizens:market-wares` attribute (JSON [{id, price}]), and
 * MerchantShops renders up to 4 of them with its usual layered market
 * pricing (war / scarcity / demand / season) on top. Stock is the
 * merchant's live inventory — the module tops it up at setup ("restocked
 * wholesale overnight"), and every sale moves real coins and items.
 *
 * Haggling is data-tier too: when a liked customer (favorite / regular /
 * warm standing in CitizenMemory) lingers near the stall, the merchant
 * occasionally grants a one-time discount via memory.recordHaggle, which
 * the Trade interface consumes on open with a "haggled X% off" note.
 * The offer line is scripted; the journal entry lets the LLM voice the
 * haggle chat later.
 *
 * Deliberately NOT CitizenShopkeeping: that module is the in-shift bustle
 * (restock/arrange/sweep tasks + customer greetings) for merchant shop
 * owners. This module is the stall itself — claiming the pitch, the day's
 * inventory and prices, haggle offers, and the open/close cycle.
 * Deliberately NOT CitizenDailyRoutines: that covers the merchant's whole
 * day (forge shifts, meals, tavern). This covers the stall as a tradeable
 * shop front.
 *
 * Wiring: CitizenDirector.tickProximity() calls tickMarketStalls(this,
 * nowMs) on the fast tick, right after the shopkeeping layer.
 * Per-citizen try/catch: one bad bot never breaks the tick.
 */

const { getJournal } = require("./CitizenJournal");
const { getMemory } = require("./CitizenMemory");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { normalizeName } = require("./CitizenBonds");
const { ATTR_MARKET_WARES } = require("../constants");

// --- tuning --------------------------------------------------------------------

const MARKET_OPEN_HOUR = 8; // stalls open at 08:00 server time
const MARKET_CLOSE_HOUR = 19; // stalls close at 19:00 server time
const MIN_WARES = 3;
const MAX_WARES = 5;
const STOCK_TARGET_MIN = 6; // inventory top-up range per ware at setup
const STOCK_TARGET_MAX = 18;
const HAGGLE_RADIUS = 6; // tiles: a liked customer this close may get an offer
const HAGGLE_OFFER_COOLDOWN_MS = 30 * 60 * 1000; // per merchant
const HAGGLE_OFFER_CHANCE = 0.35; // per eligible tick
const HAGGLE_PCT_MIN = 5;
const HAGGLE_PCT_MAX = 15;
const PITCH_RADIUS = 10; // tiles: sales pitches carry this far
const PITCH_COOLDOWN_MS = 20 * 60 * 1000; // per merchant
const PITCH_CHANCE = 0.25; // per eligible tick

// Stall spots: a ring of pitches around the market anchor so merchants
// spread out deterministically instead of stacking on one tile.
const STALL_SPOT_OFFSETS = Object.freeze([
  [-4, -2], [-2, -2], [0, -2], [2, -2], [4, -2],
  [-4, 0], [4, 0],
  [-4, 2], [-2, 2], [0, 2], [2, 2], [4, 2],
]);

// Ware pools by merchant specialization (item NAME strings, resolved
// against api.core.ItemIds at setup; unknown names are dropped, never
// fatal). The prime runs the mixed general stall, the supplier deals in
// gear, the provisioner in food.
const WARE_POOLS = Object.freeze({
  provisioner: Object.freeze([
    "BREAD", "COOKED_MEAT", "TROUT", "SALMON", "CAKE", "MEAT_PIE",
  ]),
  supplier: Object.freeze([
    "IRON_SWORD", "BRONZE_SWORD", "STEEL_SWORD", "BRONZE_ARROW",
    "IRON_ARROW", "OAK_SHIELD", "LEATHER_BOOTS", "LEATHER_GLOVES",
  ]),
  prime: Object.freeze([
    "BREAD", "CAKE", "IRON_SWORD", "FEATHER", "ROPE", "POT", "KNIFE",
    "BUCKET", "TINDERBOX", "LEATHER_GLOVES",
  ]),
});
const DEFAULT_POOL = WARE_POOLS.prime;

// Personality-driven list pricing. Greedy merchants ask more, easygoing /
// cheerful ones price to move. (The Trade interface's haggleEdge stacks on
// top as the bargaining layer.)
const PRICE_MULT_GREEDY = 1.3;
const PRICE_MULT_EASY = 0.9;
const PRICE_MULT_NEUTRAL = 1.0;

// --- scripted lines (data tier; the LLM riffs via the journal) -----------------

const HAGGLE_OFFER_LINES = Object.freeze([
  "For you, {player} — {pct}% off today. Don't tell the others.",
  "Psst, {player}. {pct}% off, just for you. We go back a ways.",
  "{player}! Good to see you. Take {pct}% off, on the house — nearly.",
  "For a friend of the stall: {pct}% off, {player}. Today only.",
]);

const PITCH_LINES = Object.freeze([
  "Fresh {ware}, best prices in town!",
  "{ware} here! Come and see!",
  "Finest {ware} you'll find — step right up!",
  "Selling {ware}, priced to move!",
]);

// --- state (in-memory; re-derived on restart, idempotent) -----------------------

const stallState = new Map(); // normalized citizen name -> { dateKey, spot, wares: [{id, name, price}] }
const lastOfferAt = new Map(); // normalized citizen name -> ms
const lastPitchAt = new Map(); // normalized citizen name -> ms

// --- pure helpers (testable with plain node) ------------------------------------

/** Market hours: 08:00 (inclusive) to 19:00 (exclusive), server time. */
function isMarketOpenHour(hour) {
  const h = Number(hour);
  return Number.isFinite(h) && h >= MARKET_OPEN_HOUR && h < MARKET_CLOSE_HOUR;
}

/** "YYYY-MM-DD" key so wares rotate daily. */
function dateKeyFor(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

/**
 * The day's wares for a merchant: 3-5 item names from their kind's pool,
 * deterministic per (username, date) so the stall is stable all day.
 * Pure: (username, merchantKind, dateKey) => string[].
 */
function dailyWaresFor(username, merchantKind, dateKey) {
  const pool = WARE_POOLS[merchantKind] ?? DEFAULT_POOL;
  const rng = agentRng(`marketstall:wares:${username}:${dateKey}`);
  const count = MIN_WARES + Math.floor(rng() * (MAX_WARES - MIN_WARES + 1));
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/** Personality list-price multiplier from a traits array (or Set). */
function priceMultiplierFor(traits) {
  const t = traits instanceof Set ? traits : new Set(traits ?? []);
  if (t.has("greedy")) return PRICE_MULT_GREEDY;
  if (t.has("easygoing") || t.has("cheerful")) return PRICE_MULT_EASY;
  return PRICE_MULT_NEUTRAL;
}

/** Deterministic stall spot: hash the username onto the pitch ring. */
function stallSpotFor(username, anchor) {
  const rng = agentRng(`marketstall:spot:${String(username).toLowerCase()}`);
  const [dx, dy] =
    STALL_SPOT_OFFSETS[Math.floor(rng() * STALL_SPOT_OFFSETS.length)];
  return { x: anchor.x + dx, y: anchor.y + dy, z: anchor.z ?? 0 };
}

/** Fill a scripted line template. */
function fillLine(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

/**
 * Parse the published market-wares attribute. Returns the validated list
 * or null (fall back to the single-ware path).
 */
function parseMarketWares(attrValue) {
  if (!attrValue) return null;
  let list = null;
  try {
    list = JSON.parse(attrValue);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const entry of list) {
    const id = Math.floor(Number(entry?.id));
    const price = Math.floor(Number(entry?.price));
    if (!(id > 0) || !(price > 0)) continue;
    out.push({ id, price });
  }
  return out.length > 0 ? out : null;
}

// --- bot helpers (same shapes as CitizenShopkeeping) -----------------------------

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function makeLocation(director, x, y, z) {
  try {
    const Loc = director?.api?.core?.Location;
    if (Loc) return new Loc(x, y, z ?? 0);
  } catch {
    // Non-fatal.
  }
  return null;
}

function walkTo(director, bot, tile) {
  try {
    const loc = makeLocation(director, tile.x, tile.y, tile.z);
    if (!loc) return false;
    bot.moveTo?.(loc);
    return true;
  } catch {
    return false;
  }
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me) return out;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || p?.isPlayerBot?.() === true) continue;
      if (chebyshev(me, botTile(p)) <= tiles) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function journalEvent(citizenName, text) {
  try {
    getJournal().log(citizenName, "trade", text);
  } catch {
    // Non-fatal.
  }
}

/** The kingdom's market anchor tile. Null-safe, never throws. */
function marketTile(kingdomId) {
  try {
    const anchor = siteTileByKingdom(kingdomId, "market");
    if (!anchor) return null;
    return { x: anchor.x, y: anchor.y, z: anchor.z ?? 0 };
  } catch {
    return null;
  }
}

// --- eligibility (same exclusions as CitizenShopkeeping) --------------------------

/** Never poach citizens claimed by CitizenSkilling's sessions. */
function skillingBusy(record) {
  try {
    const sk = require("./CitizenSkilling");
    const name = normalizeName(record.username);
    const sessions = sk._sessions;
    if (!sessions) return false;
    if (sessions.has(name)) return true;
    for (const s of sessions.values()) {
      if (
        (s.members ?? []).some((m) => normalizeName(m) === name) ||
        normalizeName(s.leader) === name
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Never poach citizens in a party or being followed. */
function socialBusy(record) {
  try {
    const { getParty, getFollow } = require("./CitizenBonds");
    return !!(getParty(record.username) || getFollow(record.username));
  } catch {
    return false;
  }
}

function eligibleForStall(record, director) {
  if (!record || record.role !== "merchant") return false;
  const name = normalizeName(record.username);
  if (!name) return false;
  if (!director?.isOnline?.(record)) return false;
  if (skillingBusy(record)) return false;
  if (socialBusy(record)) return false;
  return true;
}

// --- pricing ----------------------------------------------------------------------

/**
 * Reference price for an item: the economy plugin's price first, the item
 * definition's base value as the fallback, 1 coin as the last resort.
 */
function referencePrice(director, itemId) {
  let price = null;
  try {
    director?.api?.emitCustomEvent?.("economy:price-query", {
      itemId,
      respond: (p) => {
        price = p;
      },
    });
  } catch {
    // Economy plugin absent — fall back below.
  }
  if (Number.isFinite(price) && price > 0) return Math.floor(price);
  try {
    const base = director?.api?.core?.ItemDefinition?.forId?.(itemId)?.getValue?.();
    if (Number.isFinite(base) && base > 0) return Math.floor(base);
  } catch {
    // Fall through.
  }
  return 1;
}

/** Resolve ware name strings to { name, id } via the engine's ItemIds. */
function resolveWareIds(director, names) {
  const ItemIds = director?.api?.core?.ItemIds;
  if (!ItemIds) return [];
  const out = [];
  for (const n of names) {
    const key = String(n ?? "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    const id = ItemIds[key];
    if (Number.isInteger(id)) out.push({ name: n, id });
  }
  return out;
}

// --- stall lifecycle ---------------------------------------------------------------

/**
 * Set up the merchant's stall for the day: walk to the claimed pitch,
 * resolve and price today's wares, top up inventory ("restocked wholesale
 * overnight"), and publish the market-wares attribute the Trade interface
 * reads.
 */
function setupStall(director, record, bot, todayKey, nowMs) {
  const name = normalizeName(record.username);
  const anchor = marketTile(record.kingdomId);
  if (!anchor) return false;
  const spot = stallSpotFor(record.username, anchor);
  const traits = record.personality?.traits ?? [];
  const mult = priceMultiplierFor(traits);
  const rng = agentRng(`marketstall:setup:${record.username}:${todayKey}`);

  const resolved = resolveWareIds(
    director,
    dailyWaresFor(record.username, record.merchantKind, todayKey)
  );
  if (resolved.length === 0) return false;

  const wares = [];
  const inv = bot.getInventory?.();
  for (const { name: wareName, id } of resolved) {
    const base = referencePrice(director, id);
    const price = Math.max(1, Math.round(base * mult));
    // Stock the pitch: top the merchant's inventory up to the day's
    // target. Finite — sales drain it, and tomorrow restocks again.
    try {
      const target = STOCK_TARGET_MIN + Math.floor(rng() * (STOCK_TARGET_MAX - STOCK_TARGET_MIN + 1));
      const have = inv?.getAmount?.(id) ?? 0;
      if (inv && have < target) inv.adds?.(id, target - have);
    } catch {
      // Stock stays whatever it was.
    }
    let displayName = wareName;
    try {
      displayName =
        director?.api?.core?.ItemDefinition?.forId?.(id)?.getName?.() ?? wareName;
    } catch {
      // Keep the pool name.
    }
    wares.push({ id, name: displayName, price });
  }
  if (wares.length === 0) return false;

  try {
    bot.setAttribute?.(
      ATTR_MARKET_WARES,
      JSON.stringify(wares.map((w) => ({ id: w.id, price: w.price })))
    );
  } catch {
    return false;
  }
  walkTo(director, bot, spot);
  try {
    bot.forceChat?.("*sets up their stall for the day*");
  } catch {
    // Cosmetic.
  }
  stallState.set(name, { dateKey: todayKey, spot, wares });
  journalEvent(
    record.username,
    `Set up their market stall: ${wares.map((w) => w.name).join(", ")}.`
  );
  return true;
}

/** Pack up for the night: clear the published wares, walk off the pitch. */
function closeStall(director, record, bot) {
  const name = normalizeName(record.username);
  try {
    bot.setAttribute?.(ATTR_MARKET_WARES, "");
  } catch {
    // The attribute is advisory; the stall is closed regardless.
  }
  const anchor = marketTile(record.kingdomId);
  if (anchor) walkTo(director, bot, anchor);
  try {
    bot.forceChat?.("*packs up the stall for the night*");
  } catch {
    // Cosmetic.
  }
  stallState.delete(name);
  journalEvent(record.username, "Packed up the market stall for the night.");
  return true;
}

// --- interaction tier ----------------------------------------------------------------

/**
 * Proactive haggle offers: a liked customer (favorite / regular / warm)
 * lingering near the stall occasionally gets a one-time discount, granted
 * data-tier via memory.recordHaggle. The Trade interface consumes it on
 * open with a "haggled X% off" note. Scripted offer line; the journal
 * entry lets the LLM voice the haggle chat later.
 */
function tickHaggleOffers(director, record, bot, name, nowMs) {
  if (nowMs - (lastOfferAt.get(name) ?? 0) < HAGGLE_OFFER_COOLDOWN_MS) return;
  const customers = realPlayersWithin(bot, HAGGLE_RADIUS);
  if (customers.length === 0) return;
  const memory = getMemory();
  const merchantName = bot.getUsername?.() ?? record.username;
  const rng = agentRng(`marketstall:haggle:${name}:${Math.floor(nowMs / 60000)}`);
  for (const customer of customers) {
    const playerName = customer.getUsername?.();
    if (!playerName) continue;
    let standing = "neutral";
    try {
      standing = memory.standing(merchantName, playerName, nowMs);
    } catch {
      continue;
    }
    if (standing !== "favorite" && standing !== "regular" && standing !== "warm") {
      continue;
    }
    try {
      if (memory.hasHaggledRecently(merchantName, playerName, nowMs)) continue;
    } catch {
      continue;
    }
    if (!chance(rng, HAGGLE_OFFER_CHANCE)) continue;
    const pct = HAGGLE_PCT_MIN + Math.floor(rng() * (HAGGLE_PCT_MAX - HAGGLE_PCT_MIN + 1));
    try {
      memory.recordHaggle(merchantName, playerName, pct, nowMs);
    } catch {
      continue;
    }
    const line = HAGGLE_OFFER_LINES[Math.floor(rng() * HAGGLE_OFFER_LINES.length)];
    try {
      bot.forceChat?.(fillLine(line, { player: playerName, pct }));
    } catch {
      // Cosmetic.
    }
    lastOfferAt.set(name, nowMs);
    journalEvent(
      record.username,
      `Offered ${playerName} ${pct}% off at the stall — a friend of the stall.`
    );
    return; // one offer per tick
  }
}

/** Occasional scripted sales pitch while customers browse. Subtle: long cooldown. */
function tickSalesPitch(director, record, bot, name, nowMs) {
  if (nowMs - (lastPitchAt.get(name) ?? 0) < PITCH_COOLDOWN_MS) return;
  const state = stallState.get(name);
  if (!state || state.wares.length === 0) return;
  if (realPlayersWithin(bot, PITCH_RADIUS).length === 0) return;
  const rng = agentRng(`marketstall:pitch:${name}:${Math.floor(nowMs / 60000)}`);
  if (!chance(rng, PITCH_CHANCE)) return;
  const ware = state.wares[Math.floor(rng() * state.wares.length)];
  const line = PITCH_LINES[Math.floor(rng() * PITCH_LINES.length)];
  try {
    bot.forceChat?.(fillLine(line, { ware: ware.name }));
  } catch {
    // Cosmetic.
  }
  lastPitchAt.set(name, nowMs);
}

// --- main tick ------------------------------------------------------------------------

function tickMerchantStall(director, record, open, todayKey, nowMs) {
  const name = normalizeName(record.username);
  const bot = director.getBot(record);
  if (!bot) return;

  if (!open) {
    // Night: pack up any open stall.
    if (stallState.has(name)) closeStall(director, record, bot);
    return;
  }

  if (!eligibleForStall(record, director)) return;

  const state = stallState.get(name);
  if (!state || state.dateKey !== todayKey) {
    // Morning (or fresh day, or first sighting): set up the stall.
    setupStall(director, record, bot, todayKey, nowMs);
    return;
  }

  // Stall is open for business: haggle offers and pitches.
  tickHaggleOffers(director, record, bot, name, nowMs);
  tickSalesPitch(director, record, bot, name, nowMs);
}

/**
 * Fast-tick entry. Called from CitizenDirector.tickProximity() (~10s),
 * after the shopkeeping layer. Wraps every citizen in try/catch.
 */
function tickMarketStalls(director, nowMs = Date.now()) {
  if (!director?.roster) return;
  const hour = new Date(nowMs).getHours();
  const open = isMarketOpenHour(hour);
  const todayKey = dateKeyFor(new Date(nowMs));
  for (const record of director.roster.values()) {
    try {
      if (record?.role !== "merchant") continue;
      tickMerchantStall(director, record, open, todayKey, nowMs);
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
}

module.exports = {
  // tuning
  MARKET_OPEN_HOUR,
  MARKET_CLOSE_HOUR,
  MIN_WARES,
  MAX_WARES,
  STOCK_TARGET_MIN,
  STOCK_TARGET_MAX,
  HAGGLE_RADIUS,
  HAGGLE_OFFER_COOLDOWN_MS,
  HAGGLE_OFFER_CHANCE,
  PITCH_RADIUS,
  PITCH_COOLDOWN_MS,
  PITCH_CHANCE,
  // data
  STALL_SPOT_OFFSETS,
  WARE_POOLS,
  HAGGLE_OFFER_LINES,
  PITCH_LINES,
  // pure/testable
  isMarketOpenHour,
  dateKeyFor,
  dailyWaresFor,
  priceMultiplierFor,
  stallSpotFor,
  fillLine,
  parseMarketWares,
  // lifecycle
  tickMarketStalls,
  setupStall,
  closeStall,
  // seams (tests)
  _stallState: stallState,
  _lastOfferAt: lastOfferAt,
  _lastPitchAt: lastPitchAt,
};
