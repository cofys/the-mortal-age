"use strict";

/**
 * CitizenTradeCaravans — merchant citizens organize trade caravans between capitals.
 *
 * WHAT IT DOES (data tier, free):
 *   Trade routes run between every pair of capitals. On a staggered schedule
 *   each route musters a caravan: a merchant leader, 2-4 hired citizen guards,
 *   and a cargo of REAL goods from the origin kingdom's regional surplus
 *   (real item ids, e.g. Keldagrim coal 453, Kandarin yew logs 1515). The
 *   caravan "travels" as data (the journey is abstracted — cities are
 *   map-regions apart, no physical walk), then arrives: bandit risk is
 *   rolled, cargo sells at live Prices.Economy reference prices, and the
 *   real buy/sell spread is split (leader keeps the lion's share, guards get
 *   a flat wage, player guards/traders get paid in real coins). The merchant
 *   buys the cargo at muster with real coins from their purse (verified
 *   pre/post; can't afford it → smaller cargo or no caravan) and the purse
 *   is credited at arrival (verified pre/post). Nothing is minted, nothing
 *   vanishes — a failed verification aborts that leg and journals it.
 *   Notable runs and ambushes are journaled so gossip, rumors, and the LLM
 *   mouth spread the story.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Muster shouts at the market anchor ("Caravan to Ardougne forming —
 *   guards wanted!"), departure farewells, arrival announcements with fresh
 *   goods, and guard/trader invites through the existing CitizenBonds invite
 *   system (player says "yes"/"no" via the chat keyword path, same as
 *   companion invites). Player guards earn a wage; player traders earn a
 *   profit share.
 *
 * Zero LLM: all lines are scripted pools; the journal carries the story for
 * the LLM to riff on later. Bandit attacks tie narratively into the bounty
 * system (survivors' journals name the price on bandit scalps).
 *
 * Wiring: tickCaravans on the slow (~60s) director tick next to festivals;
 * tickCaravanShouts on the fast proximity tick next to market stalls.
 * Plain-node testable: CitizenTradeCaravans.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { normalizeName, sendInvite, getInvites, resolveInvite } = require("./CitizenBonds");
const { KINGDOM_IDS } = require("../brain/CitizenSites");
const { ROLE_MERCHANT, ROLE_GUARD } = require("../constants");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


let KingdomStore = null;
try {
  KingdomStore = require("../../kingdoms/KingdomStore");
} catch {
  KingdomStore = null;
}

let PricesEconomy = null;
try {
  PricesEconomy = require("../../economy/Prices.Economy");
} catch {
  PricesEconomy = null;
}

// === Tuning: all magic numbers here ===
const COINS = 995;
const MUSTER_MS = 45 * 60 * 1000; // merchants recruit at the market this long
const JOURNEY_MS = 3 * 60 * 60 * 1000; // abstracted travel time, each way
const LAYOVER_MS = 30 * 60 * 1000; // trading in the destination before return
const ROUTE_CADENCE_MS = 8 * 60 * 60 * 1000; // a route forms a caravan this often
const GUARD_MIN = 2;
const GUARD_MAX = 4;
const CARGO_MIN = 3;
const CARGO_MAX = 6;
const SHOUT_RADIUS = 12; // tiles — market anchor earshot
const SHOUT_COOLDOWN_MS = 20 * 60 * 1000; // per caravan per phase
const INVITE_KIND_GUARD = "caravan_guard";
const INVITE_KIND_TRADER = "caravan_trader";
const MAX_PLAYER_GUARDS = 2;
const MAX_PLAYER_TRADERS = 2;
const TRADER_SHARE_PCT = 8; // each player trader's cut of net profit
const BIG_RUN_THRESHOLD = 5000; // profit above this is newsworthy
const BIG_LOSS_THRESHOLD = 40; // cargo loss % above this is newsworthy

// Fallback city names if the kingdoms plugin has no display name.
const CITY_FALLBACK = Object.freeze({
  asgarnia: "Falador",
  kandarin: "Ardougne",
  keldagrim: "Keldagrim",
  misthalin: "Varrock",
  morytania: "Darkmeyer",
});

// Real caravan goods: each origin kingdom loads its regional surplus
// (server/plugins/economy/data/regional-resources.json) as REAL item ids.
// Ids verified against server/data/definitions/item-gameplay.json; prices
// come live from Prices.Economy (GE baselines x demand pressure).
//
// Surplus -> item mapping choices (documented per Jon's real-goods law):
//   asgarnia: wheat -> Grain (1947, the millable grain item); bread -> Bread
//     (2309, exact); barley -> Barley (6006); hops -> Asgarnian hops (5996);
//     limestone -> Limestone (3211).
//   kandarin: oak/willow/yew/magic logs exact (1521/1519/1515/1513);
//     raw_fish -> Raw lobster (377) + Raw swordfish (371); flax -> Flax (1779).
//   keldagrim: coal/iron/mithril/adamantite ore exact (453/440/447/449);
//     gems -> Uncut sapphire/emerald/ruby/diamond (1623/1621/1619/1617);
//     master_smithing_labor SKIPPED (labor is not a good).
//   misthalin: leather -> Leather (1741); cowhide -> Cowhide (1739);
//     wool -> Wool (1737); cloth -> Bolt of cloth (8790);
//     trade_services SKIPPED (a service is not a good).
//   morytania: herbs -> Grimy ranarr/avantoe/kwuarm/dwarf weed
//     (207/211/213/217); mort_myre_fungus -> 2970; swamp_paste -> 1941;
//     swamp_tar -> 1939.
const KINGDOM_GOODS = Object.freeze({
  asgarnia: Object.freeze([
    { itemId: 1947, name: "Grain" },
    { itemId: 2309, name: "Bread" },
    { itemId: 6006, name: "Barley" },
    { itemId: 5996, name: "Asgarnian hops" },
    { itemId: 3211, name: "Limestone" },
  ]),
  kandarin: Object.freeze([
    { itemId: 1521, name: "Oak logs" },
    { itemId: 1519, name: "Willow logs" },
    { itemId: 1515, name: "Yew logs" },
    { itemId: 1513, name: "Magic logs" },
    { itemId: 377, name: "Raw lobster" },
    { itemId: 371, name: "Raw swordfish" },
    { itemId: 1779, name: "Flax" },
  ]),
  keldagrim: Object.freeze([
    { itemId: 453, name: "Coal" },
    { itemId: 440, name: "Iron ore" },
    { itemId: 447, name: "Mithril ore" },
    { itemId: 449, name: "Adamantite ore" },
    { itemId: 1623, name: "Uncut sapphire" },
    { itemId: 1621, name: "Uncut emerald" },
    { itemId: 1619, name: "Uncut ruby" },
    { itemId: 1617, name: "Uncut diamond" },
  ]),
  misthalin: Object.freeze([
    { itemId: 1741, name: "Leather" },
    { itemId: 1739, name: "Cowhide" },
    { itemId: 1737, name: "Wool" },
    { itemId: 8790, name: "Bolt of cloth" },
  ]),
  morytania: Object.freeze([
    { itemId: 207, name: "Grimy ranarr weed" },
    { itemId: 211, name: "Grimy avantoe" },
    { itemId: 213, name: "Grimy kwuarm" },
    { itemId: 217, name: "Grimy dwarf weed" },
    { itemId: 2970, name: "Mort myre fungus" },
    { itemId: 1941, name: "Swamp paste" },
    { itemId: 1939, name: "Swamp tar" },
  ]),
});

const MUSTER_LINES = Object.freeze([
  "Caravan to {city} forming at the market — guards wanted, {wage} coins each!",
  "Who'll ride guard to {city}? Good pay, honest work — {wage} coins!",
  "The {city} caravan leaves soon! Traders welcome, guards needed!",
]);

const DEPART_LINES = Object.freeze([
  "Wagons rolling! Next stop {city}!",
  "The caravan departs for {city} — gods keep the roads clear!",
]);

const ARRIVE_LINES = Object.freeze([
  "Fresh {goods} from {city}! The caravan has arrived!",
  "The {city} caravan is in — {goods} at fair prices!",
]);

const AMBUSH_TALK = Object.freeze([
  "Bandits on the {city} road! We fought them off, but it cost us.",
  "The {city} road isn't safe — bandits took {pct}% of our cargo.",
]);

const RETURN_LINES = Object.freeze([
  "Back from {city} with a fat purse. The roads were kind.",
  "The {city} run is done. Already planning the next one.",
]);

// === Caravan store (transient — a restart simply starts new caravans) ===
/** routeKey -> caravan object */
const caravans = new Map();

// Memory-leak plug for per-caravan shout cooldowns.
const lastShoutAt = new Map(); // caravanId -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastShoutAt) {
    if (at < cutoff) lastShoutAt.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a hash of a string, unsigned 32-bit. */
function hashStr(s) {
  let h = 2166136261;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Canonical route key: "asgarnia->kandarin". */
function routeKey(from, to) {
  return `${from}->${to}`;
}

/** All ordered pairs of distinct kingdoms. */
function allRoutes(kingdomIds) {
  const out = [];
  for (const from of kingdomIds) {
    for (const to of kingdomIds) {
      if (from !== to) out.push({ from, to, key: routeKey(from, to) });
    }
  }
  return out;
}

/** Deterministic stagger so routes don't all muster at once. */
function departureOffsetMs(key) {
  return hashStr(`caravan:offset:${key}`) % ROUTE_CADENCE_MS;
}

/** Bandit risk for a route, 0.10–0.30, deterministic per route. */
function riskFor(key) {
  return 0.1 + (hashStr(`caravan:risk:${key}`) % 21) / 100;
}

/** Display name for a kingdom id. */
function cityName(kingdomId) {
  try {
    const n = KingdomStore?.getKingdom?.(kingdomId)?.name;
    if (typeof n === "string" && n.length > 0) return n;
  } catch {
    // fall through to fallback
  }
  return CITY_FALLBACK[kingdomId] ?? kingdomId;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill a template's {tokens}. */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

/**
 * Pick caravan crew from candidate roster records.
 * Pure: (rng, candidates[{username,role,kingdomId}], originKingdom) => {leader, guards[]}
 * Leader: a merchant of the origin kingdom. Guards: guards of the origin kingdom.
 */
function pickCrew(rng, candidates, originKingdom) {
  const merchants = candidates.filter(
    (c) => c.role === ROLE_MERCHANT && c.kingdomId === originKingdom
  );
  const guards = candidates.filter(
    (c) => c.role === ROLE_GUARD && c.kingdomId === originKingdom
  );
  if (merchants.length === 0) return null;
  const leader = merchants[Math.floor(rng() * merchants.length)].username;
  const shuffled = [...guards].sort(() => rng() - 0.5);
  const n = GUARD_MIN + Math.floor(rng() * (GUARD_MAX - GUARD_MIN + 1));
  return { leader, guards: shuffled.slice(0, n).map((g) => g.username) };
}

/**
 * Live reference price for an item id, floored at 1 (never zero — no free
 * goods). Mirrors the SurplusManifest.referencePrice contract: the economy
 * feed when loaded, floor price when it isn't.
 */
function refPrice(itemId, nowMs) {
  try {
    const p = PricesEconomy?.getReferencePrice?.(itemId, nowMs ?? Date.now());
    if (Number.isFinite(p) && p >= 1) return Math.floor(p);
  } catch {
    // Economy feed unavailable — floor price, never zero.
  }
  return 1;
}

/** Real goods an origin kingdom can load (its regional surplus). Pure. */
function goodsForKingdom(originKingdom) {
  return KINGDOM_GOODS[originKingdom] ?? [];
}

/**
 * Build a cargo manifest from the origin kingdom's REAL surplus goods:
 * 3-6 distinct goods, 4-12 units each. Each line is
 * { itemId, name, qty, buyPrice } — buyPrice is the origin reference price
 * captured at muster. No fictional margin: the margin is the real
 * destination-minus-origin price spread (tradeProfit). Pure: priceFn
 * injected (defaults to the live reference price).
 */
function buildCargo(rng, originKingdom, priceFn) {
  const price = typeof priceFn === "function" ? priceFn : (id) => refPrice(id);
  const pool = [...goodsForKingdom(originKingdom)].sort(() => rng() - 0.5);
  const n = Math.min(
    pool.length,
    CARGO_MIN + Math.floor(rng() * (CARGO_MAX - CARGO_MIN + 1))
  );
  return pool.slice(0, n).map((g) => ({
    itemId: g.itemId,
    name: g.name,
    qty: 4 + Math.floor(rng() * 9), // 4–12 units
    buyPrice: Math.max(1, Math.floor(price(g.itemId))),
  }));
}

/** Coins the merchant paid to assemble the cargo (origin prices). Pure. */
function cargoCost(cargo) {
  return (cargo ?? []).reduce((sum, c) => sum + c.qty * (c.buyPrice ?? 0), 0);
}

/**
 * What the cargo fetches at the given prices (destination prices at
 * arrival). Pure: priceFn injected (defaults to the live reference price).
 */
function cargoValue(cargo, priceFn) {
  const price = typeof priceFn === "function" ? priceFn : (id) => refPrice(id);
  return (cargo ?? []).reduce(
    (sum, c) => sum + c.qty * Math.max(1, Math.floor(price(c.itemId))),
    0
  );
}

/**
 * Real trade profit of one leg: sum((sellPrice - buyPrice) * qty).
 * Negative is a bad trade — that's real. Pure.
 */
function tradeProfit(cargo, priceFn) {
  const price = typeof priceFn === "function" ? priceFn : (id) => refPrice(id);
  return (cargo ?? []).reduce(
    (sum, c) =>
      sum + (Math.max(1, Math.floor(price(c.itemId))) - (c.buyPrice ?? 0)) * c.qty,
    0
  );
}

/**
 * Shrink a cargo to what `coins` cover: drop the priciest lines first so the
 * caravan keeps as many goods as it can afford. Returns the affordable lines
 * (possibly empty). Pure.
 */
function affordableCargo(cargo, coins) {
  const lines = [...(cargo ?? [])];
  const purse = Math.max(0, Math.floor(coins));
  const byCostDesc = [...lines].sort(
    (a, b) => b.qty * (b.buyPrice ?? 0) - a.qty * (a.buyPrice ?? 0)
  );
  const dropped = new Set();
  let cost = cargoCost(lines);
  for (const line of byCostDesc) {
    if (cost <= purse) break;
    dropped.add(line);
    cost -= line.qty * (line.buyPrice ?? 0);
  }
  return lines.filter((l) => !dropped.has(l));
}

/** Flat guard wage, scaled by route risk. Pure. */
function guardWage(rng, risk) {
  const base = 150 + Math.floor(rng() * 151); // 150–300
  return Math.round(base * (1 + risk));
}

/**
 * Resolve the bandit attack on arrival. Pure.
 * @returns {{attacked:boolean, lossPct:number, severity:string|null}}
 */
function resolveBanditAttack(rng, risk) {
  if (rng() >= risk) return { attacked: false, lossPct: 0, severity: null };
  const roll = rng();
  if (roll < 0.6) return { attacked: true, lossPct: 10 + Math.floor(rng() * 11), severity: "skirmish" };
  if (roll < 0.9) return { attacked: true, lossPct: 25 + Math.floor(rng() * 16), severity: "ambush" };
  return { attacked: true, lossPct: 45 + Math.floor(rng() * 21), severity: "disaster" };
}

/** Net profit after cargo loss. Pure. */
function netProfit(gross, lossPct) {
  return Math.round(gross * (1 - lossPct / 100));
}

/**
 * Split the take. Pure.
 * Guards (citizen + player) get a flat wage each; each player trader gets
 * TRADER_SHARE_PCT of net; the leader keeps the rest (min 0).
 */
function splitShares(net, guardCount, playerGuardCount, playerTraderCount, wage) {
  const guardPayout = guardCount * wage + playerGuardCount * wage;
  const traderPayout = Math.round((net * TRADER_SHARE_PCT * playerTraderCount) / 100);
  const leaderKeeps = Math.max(0, net - guardPayout - traderPayout);
  return { guardPayout, traderPayout, leaderKeeps };
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

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// Verified coin/goods movement — Jon's law: real goods, real coins, no
// minting. Every movement is checked pre/post (the CitizenSurplusSales /
// SurplusManifest contract). A failed verification aborts that leg and the
// failure is journaled; nothing is fabricated to cover it.
// ============================================================================

/** The leader's live inventory, or null when they aren't materialized. */
function leaderInventory(director, leaderName) {
  try {
    const record = director.roster?.get?.(normalizeName(leaderName));
    if (!record || !director.isOnline?.(record)) return null;
    const bot = director.getBot?.(record);
    return bot?.getInventory?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Verified coin debit: true only when the purse shows exactly `coins` fewer
 * afterwards. Pure against the inventory interface.
 */
function debitCoinsVerified(inv, coins) {
  const take = Math.max(0, Math.floor(coins));
  if (take <= 0) return true;
  try {
    const before = inv?.getAmount?.(COINS) ?? 0;
    if (before < take) return false; // can't cover — no partial debit
    inv.deleteNumber?.(COINS, take);
    return (inv?.getAmount?.(COINS) ?? -1) === before - take;
  } catch {
    return false;
  }
}

/**
 * Verified coin credit: true only when the purse shows exactly `coins` more
 * afterwards. Pure against the inventory interface.
 */
function creditCoinsVerified(inv, coins) {
  const give = Math.max(0, Math.floor(coins));
  if (give <= 0) return true;
  try {
    const before = inv?.getAmount?.(COINS) ?? 0;
    inv.adds?.(COINS, give);
    return (inv?.getAmount?.(COINS) ?? -1) === before + give;
  } catch {
    return false;
  }
}

/**
 * Verified purse-to-purse transfer. On a failed credit the debit is rolled
 * back (the sellItems contract) — nothing vanishes mid-deal.
 */
function transferCoinsVerified(fromInv, toInv, coins) {
  const amount = Math.max(0, Math.floor(coins));
  if (amount <= 0) return true;
  if (!fromInv || !toInv) return false;
  if (!debitCoinsVerified(fromInv, amount)) return false;
  if (creditCoinsVerified(toInv, amount)) return true;
  creditCoinsVerified(fromInv, amount); // roll the debit back
  return false;
}

/**
 * The muster buy: the merchant buys the cargo at origin reference prices.
 * Online leader: real coins leave the purse (verified pre/post). Offline
 * leader: no purse to touch — the spend is journaled against their books
 * (citizen coin economy stays abstracted for offline citizens, same as
 * guard wages). The cargo shrinks to what the purse covers; returns null
 * when nothing is affordable, and then no caravan forms.
 */
function buyCargo(director, leaderName, cargo, nowMs) {
  const inv = leaderInventory(director, leaderName);
  if (!inv) {
    const cost = cargoCost(cargo);
    journalEvent(
      leaderName,
      `Bought the caravan cargo at the market — ${cost} coins of ${caravanGoodsSummary(cargo)}.`,
      "trade"
    );
    return { cargo: [...(cargo ?? [])], cost, verified: false };
  }
  const purse = inv.getAmount?.(COINS) ?? 0;
  const affordable = affordableCargo(cargo, purse);
  if (affordable.length === 0) {
    journalEvent(
      leaderName,
      `Could not afford the caravan cargo (${cargoCost(cargo)} coins against a ${purse}-coin purse) — the run is cancelled.`,
      "trade"
    );
    return null;
  }
  const cost = cargoCost(affordable);
  if (!debitCoinsVerified(inv, cost)) {
    journalEvent(
      leaderName,
      `The cargo purchase of ${cost} coins failed verification — the run is cancelled.`,
      "trade"
    );
    return null;
  }
  if (affordable.length < (cargo ?? []).length) {
    journalEvent(
      leaderName,
      `Short on coin — the caravan loads a smaller cargo (${cost} coins of goods).`,
      "trade"
    );
  }
  return { cargo: affordable, cost, verified: true };
}

/** One-line cargo summary for journals: "8 Coal, 5 Iron ore". */
function caravanGoodsSummary(cargo) {
  return (cargo ?? []).map((c) => `${c.qty} ${c.name}`).join(", ");
}

/**
 * The arrival sale: the surviving cargo sells at destination reference
 * prices and the merchant's purse is credited (verified pre/post). Offline
 * leader: journaled. A failed verification aborts the leg — the coins are
 * journaled as held at the market, not fabricated.
 */
function sellCargo(director, leaderName, cargo, lossPct, nowMs) {
  const proceeds = netProfit(cargoValue(cargo, (id) => refPrice(id, nowMs)), lossPct);
  const inv = leaderInventory(director, leaderName);
  if (!inv) {
    journalEvent(
      leaderName,
      `Sold the caravan cargo at destination prices — ${proceeds} coins.`,
      "trade"
    );
    return { proceeds, verified: false };
  }
  if (!creditCoinsVerified(inv, proceeds)) {
    journalEvent(
      leaderName,
      `Sold the cargo for ${proceeds} coins but the purse credit failed verification — the coins are held at the market, not lost.`,
      "trade"
    );
    return { proceeds: 0, verified: false };
  }
  return { proceeds, verified: true };
}

// ============================================================================
// Caravan lifecycle (data tier)
// ============================================================================

function newCaravanId(route, nowMs) {
  return `caravan:${route.key}:${nowMs}`;
}

function formCaravan(director, route, nowMs) {
  const rng = agentRng(`caravan:form:${route.key}:${nowMs >> 16}`);
  const candidates = [];
  try {
    for (const record of director.roster?.values?.() ?? []) {
      candidates.push({ username: record.username, role: record.role, kingdomId: record.kingdomId });
    }
  } catch {
    return null;
  }
  const crew = pickCrew(rng, candidates, route.from);
  if (!crew) return null; // no merchant available in the origin city
  const risk = riskFor(route.key);
  // Real cargo: the merchant buys origin-surplus goods at muster prices.
  // Can't afford the full load -> smaller cargo; can't afford any of it ->
  // no caravan forms.
  const purchase = buyCargo(director, crew.leader, buildCargo(rng, route.from), nowMs);
  if (!purchase || purchase.cargo.length === 0) return null;
  const caravan = {
    id: newCaravanId(route, nowMs),
    routeKey: route.key,
    from: route.from,
    to: route.to,
    phase: "mustering",
    phaseEndsAt: nowMs + MUSTER_MS,
    leader: crew.leader,
    guards: crew.guards,
    playerGuards: [],
    playerTraders: [],
    cargo: purchase.cargo,
    cargoCost: purchase.cost,
    cargoVerified: purchase.verified,
    wage: guardWage(rng, risk),
    risk,
    formedAt: nowMs,
    announced: false,
    departed: false,
    arrived: false,
  };
  caravans.set(route.key, caravan);
  journalEvent(
    caravan.leader,
    `Organizing a trade caravan to ${cityName(route.to)} — recruiting guards at the market.`,
    "trade"
  );
  return caravan;
}

/**
 * Pay player hands in real coins if they're online; journal otherwise.
 * The wage moves out of the leader's purse when it's reachable (verified
 * transfer, merchant -> player); otherwise the player is credited directly
 * (verified) so online hands are never stiffed, and the shortfall is
 * journaled against the leader's books.
 */
function payPlayer(director, leaderName, playerName, coins, reason) {
  let paid = false;
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      let name = "";
      try {
        name = p.getUsername?.() ?? "";
      } catch {
        continue;
      }
      if (normalizeName(name) !== normalizeName(playerName)) continue;
      const pinv = p.getInventory?.();
      if (!pinv) break;
      const minv = leaderInventory(director, leaderName);
      if (minv && transferCoinsVerified(minv, pinv, coins)) {
        paid = true;
      } else if (minv) {
        // The purse couldn't cover it — pay the hand anyway (verified) and
        // journal the shortfall rather than stiffing an online player.
        paid = creditCoinsVerified(pinv, coins);
        if (paid) {
          journalEvent(leaderName, `Short on coin after the run — covered ${playerName}'s ${coins}-coin wage from the venture.`, "trade");
        }
      } else {
        paid = creditCoinsVerified(pinv, coins);
      }
      break;
    }
  } catch {
    // fall through to journal
  }
  if (!paid) {
    journalEvent(playerName, `Owed ${coins} coins for caravan work (${reason}) — collect from the market.`, "trade");
  }
  return paid;
}

function settleCaravan(director, caravan, nowMs) {
  // Real pricing: the cargo sells at destination reference prices; the
  // merchant's P&L is (destination proceeds) - (origin cost). Negative is a
  // bad trade — that's real.
  const priceNow = (id) => refPrice(id, nowMs);
  const sellValue = cargoValue(caravan.cargo, priceNow);
  const cost = Number.isFinite(caravan.cargoCost) ? caravan.cargoCost : cargoCost(caravan.cargo);
  const rng = agentRng(`caravan:settle:${caravan.id}`);
  const attack = resolveBanditAttack(rng, caravan.risk);
  // The arrival sale: surviving cargo -> merchant's purse (verified when the
  // leader is materialized; journaled otherwise; aborted + journaled when a
  // transfer fails verification).
  const sale = sellCargo(director, caravan.leader, caravan.cargo, attack.lossPct, nowMs);
  const net = sale.proceeds - cost;
  // Trade treaties pay a real caravan profit bonus between treaty partners.
  // Read defensively: an active trade treaty means open roads and full
  // markets. (Alliance pacts pay their own trade bonus through the
  // kingdoms tax-day path — this is trade-treaty only, no double-count.)
  let bonus = 0;
  try {
    bonus = require("./CitizenTreaties").tradeBonusFor(caravan.from, caravan.to, nowMs) ?? 0;
  } catch {
    bonus = 0;
  }
  // Guild-certified manifests earn the merchants'-association bonus on top.
  // Read defensively; certification lives in CitizenTradeGuilds.
  try {
    bonus += require("./CitizenTradeGuilds").certifiedBonusFor(caravan, nowMs) ?? 0;
  } catch {
    // no association — no bonus
  }
  const netWithBonus = net > 0 && bonus > 0 ? Math.round(net * (1 + bonus)) : net;
  const shares = splitShares(
    netWithBonus,
    caravan.guards.length,
    caravan.playerGuards.length,
    caravan.playerTraders.length,
    caravan.wage
  );

  const destCity = cityName(caravan.to);
  // Citizen guards get their wage as journaled earnings (their coin economy
  // is abstracted); the leader's books balance in the journal too.
  for (const g of caravan.guards) {
    journalEvent(g, `Guarded the ${destCity} caravan — earned ${caravan.wage} coins.`, "trade");
  }
  journalEvent(
    caravan.leader,
    `The ${destCity} caravan cleared ${shares.leaderKeeps} coins after wages and shares.`,
    "trade"
  );
  // Player hands get real coins.
  for (const pg of caravan.playerGuards) {
    payPlayer(director, caravan.leader, pg, caravan.wage, `guarding the ${destCity} caravan`);
    journalEvent(caravan.leader, `${pg} rode guard for us — paid ${caravan.wage} coins.`, "trade");
  }
  const traderCut = Math.max(0, Math.round((netWithBonus * TRADER_SHARE_PCT) / 100));
  for (const pt of caravan.playerTraders) {
    payPlayer(director, caravan.leader, pt, traderCut, `trading on the ${destCity} caravan`);
    journalEvent(caravan.leader, `${pt} traded with the caravan — ${traderCut} coins profit share.`, "trade");
  }

  if (attack.attacked) {
    const line = fill(pickOne(rng, AMBUSH_TALK), { city: destCity, pct: attack.lossPct });
    journalEvent(caravan.leader, line, attack.lossPct >= BIG_LOSS_THRESHOLD ? "trade" : "social");
    for (const g of caravan.guards) {
      journalEvent(g, `Fought bandits on the ${destCity} road — the watch will pay for bandit scalps.`, "trade");
    }
    if (attack.severity === "disaster") {
      const hurt = caravan.guards[0];
      if (hurt) journalEvent(hurt, `Took a bandit arrow on the ${destCity} road — I'll be abed a week.`, "trade");
    }
  } else if (net >= BIG_RUN_THRESHOLD) {
    journalEvent(
      caravan.leader,
      `The ${destCity} run was the richest in years — ${net} coins clear. The market will talk of this.`,
      "trade"
    );
  }
  caravan.settlement = {
    gross: sellValue,
    cost,
    net,
    proceeds: sale.proceeds,
    saleVerified: sale.verified,
    lossPct: attack.lossPct,
    severity: attack.severity,
    shares,
  };
  return caravan.settlement;
}

/** Advance one caravan's phase machine. Data tier. */
function advanceCaravan(director, caravan, nowMs) {
  if (nowMs < caravan.phaseEndsAt) return;
  if (caravan.phase === "mustering") {
    caravan.phase = "traveling";
    caravan.phaseEndsAt = nowMs + JOURNEY_MS;
    journalEvent(caravan.leader, `The caravan departed for ${cityName(caravan.to)}.`, "trade");
    for (const g of caravan.guards) {
      journalEvent(g, `On the road to ${cityName(caravan.to)} with the caravan.`, "trade");
    }
    // Visible journey: walk the road when one exists (lazy require — the
    // journey module requires this file back for the caravan store).
    try {
      require("./CaravanJourney").onCaravanDepart(director, caravan);
    } catch (e) {
      console.warn("[citizen-caravans] journey depart failed:", caravan.id, e?.message ?? e);
    }
  } else if (caravan.phase === "traveling") {
    caravan.phase = "arrived";
    caravan.phaseEndsAt = nowMs + LAYOVER_MS;
    settleCaravan(director, caravan, nowMs);
    journalEvent(caravan.leader, `Caravan arrived in ${cityName(caravan.to)} — selling the cargo.`, "trade");
  } else if (caravan.phase === "arrived") {
    caravan.phase = "returning";
    caravan.phaseEndsAt = nowMs + JOURNEY_MS;
    caravan.playerGuards = [];
    caravan.playerTraders = [];
    journalEvent(caravan.leader, `Heading home from ${cityName(caravan.to)} with an empty wagon and a full purse.`, "trade");
    // Visible journey: walk the road back (reversed waypoints) when one exists.
    try {
      require("./CaravanJourney").onCaravanReturn(director, caravan);
    } catch (e) {
      console.warn("[citizen-caravans] journey return failed:", caravan.id, e?.message ?? e);
    }
  } else if (caravan.phase === "returning") {
    caravan.phase = "done";
    journalEvent(caravan.leader, `Back in ${cityName(caravan.from)} from the ${cityName(caravan.to)} run.`, "trade");
    caravans.delete(caravan.routeKey);
  }
}

/**
 * Slow-tick data tier: form new caravans on schedule, advance live ones.
 * Called from the director's slow tick. Zero LLM, per-route try/catch.
 */
function tickCaravans(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    const routes = allRoutes(KINGDOM_IDS);
    for (const route of routes) {
      try {
        const existing = caravans.get(route.key);
        if (existing) {
          advanceCaravan(director, existing, nowMs);
          continue;
        }
        // Staggered cadence: this route is due when its offset slot passes.
        const slot = (nowMs + departureOffsetMs(route.key)) % ROUTE_CADENCE_MS;
        const lastFormed = route._lastFormed ?? 0;
        if (slot < 60 * 1000 && nowMs - lastFormed > ROUTE_CADENCE_MS / 2) {
          route._lastFormed = nowMs;
          formCaravan(director, route, nowMs);
        }
      } catch (e) {
        // One bad route never breaks the tick.
        console.warn("[citizen-caravans] route failed:", route.key, e?.message ?? e);
      }
    }
    // Visible journeys: advance caravans walking real roads (early-outs when
    // none are walking — the usual case).
    try {
      require("./CaravanJourney").tickVisibleCaravans(director, nowMs);
    } catch (e) {
      console.warn("[citizen-caravans] visible journey tick failed:", e?.message ?? e);
    }
  } catch (e) {
    console.warn("[citizen-caravans] tick failed:", e?.message ?? e);
  }
}

// ============================================================================
// Interaction tier: shouts near real players (fast proximity tick)
// ============================================================================

/** Leader bot if materialized, else null. */
function leaderBot(director, caravan) {
  try {
    const record = director.roster?.get?.(normalizeName(caravan.leader));
    if (!record) return null;
    return director.getBot?.(record) ?? null;
  } catch {
    return null;
  }
}

function realPlayersNearBot(bot, radius) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && isRealPlayer(p)) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out.filter((p) => withinTiles(bot, p, radius));
}

/** Send guard/trader invites to real players near the mustering leader. */
function invitePlayers(director, caravan, bot) {
  const rng = agentRng(`caravan:invite:${caravan.id}`);
  const nearby = realPlayersNearBot(bot, SHOUT_RADIUS);
  for (const p of nearby) {
    let name = "";
    try {
      name = p.getUsername?.() ?? "";
    } catch {
      continue;
    }
    if (!name) continue;
    const norm = normalizeName(name);
    if (caravan.playerGuards.includes(norm) || caravan.playerTraders.includes(norm)) continue;
    // Offer a guard post first; traders fill remaining slots.
    const kind =
      caravan.playerGuards.length < MAX_PLAYER_GUARDS ? INVITE_KIND_GUARD : INVITE_KIND_TRADER;
    if (kind === INVITE_KIND_TRADER && caravan.playerTraders.length >= MAX_PLAYER_TRADERS) continue;
    try {
      const existing = getInvites(name).some((i) => i.kind === kind && i.data?.caravanId === caravan.id);
      if (existing) continue;
      sendInvite(caravan.leader, name, kind, {
        caravanId: caravan.id,
        routeKey: caravan.routeKey,
        wage: caravan.wage,
        dest: cityName(caravan.to),
      });
    } catch {
      // Non-fatal.
    }
    if (rng() < 0.5) break; // don't spam the whole crowd at once
  }
}

function shoutPhase(director, caravan, nowMs) {
  const last = lastShoutAt.get(`${caravan.id}:${caravan.phase}`) || 0;
  if (nowMs - last < SHOUT_COOLDOWN_MS) return;
  const bot = leaderBot(director, caravan);
  if (!bot) return;
  if (realPlayersNearBot(bot, SHOUT_RADIUS).length === 0) return;
  const rng = agentRng(`caravan:shout:${caravan.id}:${caravan.phase}`);
  let line = null;
  if (caravan.phase === "mustering") {
    line = fill(pickOne(rng, MUSTER_LINES), { city: cityName(caravan.to), wage: caravan.wage });
    invitePlayers(director, caravan, bot);
  } else if (caravan.phase === "traveling" && !caravan.departed) {
    line = fill(pickOne(rng, DEPART_LINES), { city: cityName(caravan.to) });
    caravan.departed = true;
  } else if (caravan.phase === "arrived" && !caravan.arrived) {
    const goods = caravan.cargo.slice(0, 2).map((c) => c.name).join(" and ");
    line = fill(pickOne(rng, ARRIVE_LINES), { city: cityName(caravan.from), goods });
    caravan.arrived = true;
  } else if (caravan.phase === "returning") {
    line = fill(pickOne(rng, RETURN_LINES), { city: cityName(caravan.to) });
  }
  if (line) {
    try {
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    } catch {
      // Non-fatal.
    }
    lastShoutAt.set(`${caravan.id}:${caravan.phase}`, nowMs);
  }
}

/**
 * Fast-tick interaction tier: phase shouts + player invites, only where a
 * real player can actually see them. Gate order: caravan exists → leader
 * materialized → real player near → shout.
 */
function tickCaravanShouts(director, nowMs) {
  try {
    for (const caravan of caravans.values()) {
      try {
        shoutPhase(director, caravan, nowMs);
      } catch (e) {
        console.warn("[citizen-caravans] shout failed:", caravan.id, e?.message ?? e);
      }
    }
  } catch (e) {
    console.warn("[citizen-caravans] shout tick failed:", e?.message ?? e);
  }
}

// ============================================================================
// Player opt-in (chat keyword path, mirrors CitizenCompanions)
// ============================================================================

function pendingInviteFor(citizenName, playerName, kind) {
  try {
    return (
      getInvites(playerName).find(
        (i) =>
          i.kind === kind && normalizeName(i.from) === normalizeName(citizenName)
      ) ?? null
    );
  } catch {
    return null;
  }
}

function caravanById(caravanId) {
  for (const c of caravans.values()) {
    if (c.id === caravanId) return c;
  }
  return null;
}

/**
 * Look up a live caravan by id. Used by the visible-journey layer and the
 * caravanWalk brain action.
 */
function getCaravanById(caravanId) {
  return caravanById(caravanId);
}

/** Live caravans currently walking a visible road journey. */
function visibleCaravanList() {
  const out = [];
  for (const c of caravans.values()) {
    if (c.visible) out.push(c);
  }
  return out;
}

/** Drop a caravan without settlement (failed run — cargo lost). */
function removeCaravan(routeKey) {
  return caravans.delete(routeKey);
}

/**
 * Player said "yes" to a caravan guard/trader invite.
 * Called from the chat keyword path. Returns the invite or null.
 */
function acceptCaravanInvite(playerName, citizenName, kind) {
  if (kind !== INVITE_KIND_GUARD && kind !== INVITE_KIND_TRADER) return null;
  const invite = pendingInviteFor(citizenName, playerName, kind);
  if (!invite) return null;
  const caravan = caravanById(invite.data?.caravanId);
  if (!caravan || caravan.phase !== "mustering") return null;
  try {
    resolveInvite(playerName, invite.id, true);
  } catch {
    // Non-fatal — still record the join.
  }
  const norm = normalizeName(playerName);
  if (kind === INVITE_KIND_GUARD) {
    if (caravan.playerGuards.length >= MAX_PLAYER_GUARDS) return null;
    if (!caravan.playerGuards.includes(norm)) caravan.playerGuards.push(norm);
    journalEvent(citizenName, `${playerName} signed on as caravan guard — ${caravan.wage} coins on safe arrival.`, "trade");
  } else {
    if (caravan.playerTraders.length >= MAX_PLAYER_TRADERS) return null;
    if (!caravan.playerTraders.includes(norm)) caravan.playerTraders.push(norm);
    journalEvent(citizenName, `${playerName} is trading with the caravan — ${TRADER_SHARE_PCT}% profit share.`, "trade");
  }
  return invite;
}

/**
 * Player said "no" to a caravan invite. Records the decline.
 * Called from the chat keyword path. Returns the invite or null.
 */
function declineCaravanInvite(playerName, citizenName, kind) {
  if (kind !== INVITE_KIND_GUARD && kind !== INVITE_KIND_TRADER) return null;
  const invite = pendingInviteFor(citizenName, playerName, kind);
  if (!invite) return null;
  try {
    resolveInvite(playerName, invite.id, false);
  } catch {
    // Non-fatal.
  }
  journalEvent(citizenName, `${playerName} turned down the caravan work.`, "social");
  return invite;
}

/**
 * Live caravan summary for the chat/LLM layer to quote.
 * Returns null when nothing is running.
 */
function caravanStatus() {
  const out = [];
  for (const c of caravans.values()) {
    out.push({
      id: c.id,
      from: cityName(c.from),
      to: cityName(c.to),
      phase: c.phase,
      leader: c.leader,
      guards: c.guards.length,
      playerGuards: c.playerGuards.length,
      playerTraders: c.playerTraders.length,
      wage: c.wage,
      goods: c.cargo.map((g) => g.name),
    });
  }
  return out;
}

/** True if the named player is signed onto any active caravan. */
function isCaravanHand(playerName) {
  const norm = normalizeName(playerName);
  for (const c of caravans.values()) {
    if (c.playerGuards.includes(norm) || c.playerTraders.includes(norm)) return true;
  }
  return false;
}

module.exports = {
  tickCaravans,
  tickCaravanShouts,
  acceptCaravanInvite,
  declineCaravanInvite,
  caravanStatus,
  isCaravanHand,
  formCaravan,
  settleCaravan,
  getCaravanById,
  visibleCaravanList,
  removeCaravan,
  // Pure helpers for tests:
  hashStr,
  routeKey,
  allRoutes,
  departureOffsetMs,
  riskFor,
  cityName,
  pickOne,
  fill,
  pickCrew,
  buildCargo,
  cargoValue,
  cargoCost,
  tradeProfit,
  affordableCargo,
  goodsForKingdom,
  refPrice,
  debitCoinsVerified,
  creditCoinsVerified,
  transferCoinsVerified,
  buyCargo,
  sellCargo,
  caravanGoodsSummary,
  KINGDOM_GOODS,
  guardWage,
  resolveBanditAttack,
  netProfit,
  splitShares,
  isRealPlayer,
  withinTiles,
  INVITE_KIND_GUARD,
  INVITE_KIND_TRADER,
  MAX_PLAYER_GUARDS,
  MAX_PLAYER_TRADERS,
  TRADER_SHARE_PCT,
  ROUTE_CADENCE_MS,
  MUSTER_MS,
  JOURNEY_MS,
};
