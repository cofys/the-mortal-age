"use strict";

/**
 * CitizenTradeCaravans — merchant citizens organize trade caravans between capitals.
 *
 * WHAT IT DOES (data tier, free):
 *   Trade routes run between every pair of capitals. On a staggered schedule
 *   each route musters a caravan: a merchant leader, 2-4 hired citizen guards,
 *   and a cargo manifest of trade goods. The caravan "travels" as data (the
 *   journey is abstracted — cities are map-regions apart, no physical walk),
 *   then arrives: bandit risk is rolled, cargo sold at a margin, and profits
 *   split (leader keeps the lion's share, guards get a flat wage, player
 *   guards/traders get paid in real coins). Notable runs and ambushes are
 *   journaled so gossip, rumors, and the LLM mouth spread the story.
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

// Trade goods: name + per-unit margin range in coins (data only — no item
// ids needed, cargo is a manifest, not an inventory).
const TRADE_GOODS = Object.freeze([
  { name: "spices", marginMin: 8, marginMax: 22 },
  { name: "silk bolts", marginMin: 12, marginMax: 28 },
  { name: "iron ingots", marginMin: 5, marginMax: 14 },
  { name: "cured hides", marginMin: 6, marginMax: 16 },
  { name: "dried fish", marginMin: 4, marginMax: 10 },
  { name: "wine casks", marginMin: 10, marginMax: 24 },
  { name: "timber", marginMin: 5, marginMax: 12 },
  { name: "gems", marginMin: 15, marginMax: 35 },
  { name: "grain sacks", marginMin: 3, marginMax: 8 },
  { name: "potions", marginMin: 9, marginMax: 20 },
]);

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

/** Build a cargo manifest: 3-6 goods with quantities. Pure. */
function buildCargo(rng) {
  const pool = [...TRADE_GOODS].sort(() => rng() - 0.5);
  const n = CARGO_MIN + Math.floor(rng() * (CARGO_MAX - CARGO_MIN + 1));
  return pool.slice(0, n).map((g) => ({
    name: g.name,
    qty: 4 + Math.floor(rng() * 9), // 4–12 units
    margin: g.marginMin + Math.floor(rng() * (g.marginMax - g.marginMin + 1)),
  }));
}

/** Gross profit of a cargo manifest in coins. Pure. */
function cargoValue(cargo) {
  return cargo.reduce((sum, c) => sum + c.qty * c.margin, 0);
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
    cargo: buildCargo(rng),
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

/** Pay player hands in real coins if they're online; journal otherwise. */
function payPlayer(director, playerName, coins, reason) {
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
      try {
        p.getInventory?.()?.adds?.(COINS, coins);
        paid = true;
      } catch {
        // fall through to journal
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
  const gross = cargoValue(caravan.cargo);
  const rng = agentRng(`caravan:settle:${caravan.id}`);
  const attack = resolveBanditAttack(rng, caravan.risk);
  const net = netProfit(gross, attack.lossPct);
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
  const netWithBonus = bonus > 0 ? Math.round(net * (1 + bonus)) : net;
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
    payPlayer(director, pg, caravan.wage, `guarding the ${destCity} caravan`);
    journalEvent(caravan.leader, `${pg} rode guard for us — paid ${caravan.wage} coins.`, "trade");
  }
  const traderCut = Math.round((netWithBonus * TRADER_SHARE_PCT) / 100);
  for (const pt of caravan.playerTraders) {
    payPlayer(director, pt, traderCut, `trading on the ${destCity} caravan`);
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
  caravan.settlement = { gross, net, lossPct: attack.lossPct, severity: attack.severity, shares };
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
