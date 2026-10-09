"use strict";

/**
 * CitizenRoutine — the commoner's day. Home -> work (real skilling via the
 * shared interactObject action at the kingdom work site) -> a midday market
 * trip -> a meal break (buys and eats bread at the market) -> work ->
 * tavern -> home, driven by the wall clock with per-citizen variation:
 * seeded phase offsets, occasional swapped shifts, rare days off.
 *
 * Work output is real: logs/ore land in the inventory and get banked, feeding
 * the master_trade goal. When the inventory fills mid-shift the routine runs
 * an internal bank trip, then goes back to work.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const {
  createInteractObjectAction,
} = require("../../../bots/brain/actions/InteractObject");
const { getReferencePrice } = require("../../../economy/Prices.Economy");
const { createBankAction } = require("../../../bots/brain/actions/Bank");
const { createIdleSocialAction } = require("./IdleSocial");
const { siteTile, workSite, dockSite, kingdomIdOf } = require("../CitizenSites");
const { isKingdomAtWar } = require("../../CitizenEvents");
const {
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_ROLE,
  ATTR_SUPPLIER_MERCHANT,
  ATTR_KINGDOM_ID,
  ROLE_MERCHANT,
} = require("../../constants");
const { attemptFeed, sellsFood, addMood } = require("../CitizenNeeds");
const { findLocalCitizen } = require("../findCitizen");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  personalSpot,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const {
  INTENT_EARN_COINS,
  INTENT_GAIN_XP,
  INTENT_SOCIALIZE,
  INTENT_EXPLORE,
  activeIntents,
} = require("../CitizenIntents");

const KIND_HOME = "home";
const KIND_WORK = "work";
const KIND_MARKET = "market";
const KIND_MEAL = "meal";
const KIND_SOCIAL = "social";

const WORK_FISHING = "fishing";

const DAY_MINUTES = 24 * 60;
const RETRY_WORK_MS = 60000;
const CASTS_PER_HAUL = 4;
// Haul pricing (alignment review finding #5): gatherer drops and fisher
// catches sell at the living-economy reference price for that item — the
// same real price table merchant stalls, player shops, and the trade
// guild's gouging rule price from (GE baseline × live demand pressure).
// Never a fixed per-item coin; see haulPriceFor below.
// Don't stall the shift forever waiting on a supplier that never shows.
const SELL_GIVE_UP_MS = 3 * 60 * 1000;
const COINS_ID = 995;
const BREAD_ID = 2309;
// The small-net catch table (Fishing.plugin.js: small net, animation 621 —
// the citizen fishing visual): raw shrimps + raw anchovies.
const RAW_SHRIMPS_ID = 317;
const RAW_ANCHOVIES_ID = 321;

// Goal-threading (review finding #2): the day plan is a reasonable default,
// but active session intents bend it instead of the clock winning blindly.
// A citizen grinding "earn 2000 coins" skips the midday market browse and
// works late; near-done grinds push to finish. Capped so the plan stays
// recognizable — goals bend, they don't replace the day with chaos.
const NEAR_DONE_RATIO = 0.7; // intent >=70%: extend the shift to finish it
const FRESH_GRIND_RATIO = 0.5; // intent <50%: work through low-value legs
const WORK_EXTEND_MIN = 45; // near-done: finish the grind
const WORK_GRIND_LATE_MIN = 60; // fresh grind: work into the evening
const MAX_BENDS_PER_DAY = 2;

const FISHING_LINES = Object.freeze({
  plain: Object.freeze([
    "Come on, bite...",
    "The river's generous today.",
    "Caught a boot last week. A BOOT.",
    "Quiet water, full net. That's the way.",
    "My father fished this same spot.",
    "Shh — you'll scare them off.",
  ]),
  terse: Object.freeze([
    "bite...",
    "good water today.",
    "caught a boot once.",
    "quiet. good.",
    "dad fished here.",
    "shh.",
  ]),
});

function minutesNow() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function dayStamp() {
  const now = new Date();
  return now.getFullYear() * 1000 + dayOfYear(now);
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

/**
 * Build today's phase plan. Seeded per citizen per day so the routine varies
 * without drifting: offsets shift boundaries, some days swap the shifts,
 * rare days are "days off" (tavern all day — everyone needs one).
 */
/**
 * Build today's phase plan. Seeded per citizen per day so the routine varies
 * without drifting. Boundaries share one jittered value each (then forced
 * monotonic) so adjacent phases always meet — no gaps, no overlaps.
 * Some days are "late days" (the whole day slides ~90 min — a lie-in),
 * rare days are "days off" (tavern all day — everyone needs one).
 */
function buildDayPlan(rng) {
  const offset = () => Math.round((rng() - 0.5) * 90); // ±45 min
  const lateDay = chance(rng, 0.18);
  const dayOff = chance(rng, 0.06);
  const slide = lateDay ? 90 : 0;
  const t = (hours, minutes = 0) => hours * 60 + minutes + slide + offset();
  const bounds = [t(6, 30), t(11), t(12), t(13), t(17), t(22)];
  for (let i = 1; i < bounds.length; i += 1) {
    bounds[i] = Math.max(bounds[i], bounds[i - 1] + 15); // keep phases ordered, >=15 min
  }
  const [b630, b11, b12, b13, b17, b22] = bounds;
  const plan = [
    { kind: KIND_HOME, start: 0, end: b630 },
    { kind: KIND_WORK, start: b630, end: b11 },
    { kind: KIND_MARKET, start: b11, end: b12 },
    { kind: KIND_MEAL, start: b12, end: b13 },
    { kind: KIND_WORK, start: b13, end: b17 },
    { kind: KIND_SOCIAL, start: b17, end: b22 },
    { kind: KIND_HOME, start: b22, end: DAY_MINUTES },
  ];
  if (dayOff) {
    return plan.map((phase) =>
      phase.kind === KIND_WORK ? { ...phase, kind: KIND_SOCIAL } : phase
    );
  }
  return plan;
}

function phaseFor(plan, minute) {
  for (const phase of plan) {
    if (minute >= phase.start && minute < phase.end) {
      return phase;
    }
  }
  return plan[plan.length - 1];
}

/**
 * Active, unfinished work intents (earn coins / gain XP). The routine's legs
 * bend around these — everything else (socialize, explore, restock) is
 * already served by the plan's market/tavern/meal legs.
 */
function workIntentsFor(player) {
  try {
    return activeIntents(player).filter(
      (i) => i.type === INTENT_EARN_COINS || i.type === INTENT_GAIN_XP
    );
  } catch (error) {
    return [];
  }
}

/** True when a social/explore intent wants the citizen out among people. */
function hasSocialPull(player) {
  try {
    return activeIntents(player).some(
      (i) => i.type === INTENT_SOCIALIZE || i.type === INTENT_EXPLORE
    );
  } catch (error) {
    return false;
  }
}

function intentRatio(intent) {
  const target = Number(intent?.target) || 0;
  if (target <= 0) {
    return 1;
  }
  return Math.max(0, Math.min(1, (Number(intent.progress) || 0) / target));
}

/**
 * Stretch the work leg that precedes `upcomingPhase` by extendMin minutes.
 * The overlap naturally shortens the following leg (a shorter browse, a
 * later tavern) — the day keeps its shape, it just bends. Clamped so one
 * bend can't swallow the whole next leg.
 */
function extendWorkShift(plan, upcomingPhase, extendMin) {
  const idx = plan.indexOf(upcomingPhase);
  if (idx <= 0) {
    return false;
  }
  const workPhase = plan[idx - 1];
  if (!workPhase || workPhase.kind !== KIND_WORK) {
    return false;
  }
  const maxEnd = upcomingPhase.end; // never absorb the entire next leg
  workPhase.end = Math.min(workPhase.end + extendMin, maxEnd);
  return workPhase.end > upcomingPhase.start;
}

/**
 * Bend today's plan at a phase boundary using the citizen's active intents.
 * Returns the leg kind to enter. Mutates state.plan (skip/extend), so the
 * bend is idempotent — re-entering the routine re-reads the bent plan
 * instead of bending twice.
 *
 * - KIND_MARKET with an active work intent (and no social pull): the midday
 *   browse becomes work. A grinding player skips the stalls.
 * - Leaving KIND_WORK for KIND_SOCIAL with an unfinished work intent:
 *   near-done (>=70%) grinds 45 more minutes to finish; fresh grinds (<50%)
 *   work an hour late. The evening just starts later.
 * - KIND_MEAL is never bent: eating stays HP-driven, lunch stays lunch.
 * - Day-off plans have no work legs, so there's nothing to bend.
 */
function bendLeg(player, state, phase) {
  const fallback = phase.kind;
  try {
    if (!state.plan || state.bendsToday >= MAX_BENDS_PER_DAY) {
      return fallback;
    }
    const intents = workIntentsFor(player);
    if (intents.length === 0) {
      return fallback;
    }
    // Day-off plans have no work legs — bending market->work would break
    // the day off. Goals bend, they don't cancel rest days.
    const hasWorkToday = state.plan.some((p) => p.kind === KIND_WORK);
    if (!hasWorkToday) {
      return fallback;
    }
    // Skip the midday market browse: pure downtime for a grinder.
    if (phase.kind === KIND_MARKET && !hasSocialPull(player)) {
      phase.kind = KIND_WORK;
      state.bendsToday += 1;
      return KIND_WORK;
    }
    // Stretch the afternoon shift into the evening.
    if (state.phaseKind === KIND_WORK && phase.kind === KIND_SOCIAL) {
      const ratios = intents.map(intentRatio);
      const best = Math.max(...ratios);
      const worst = Math.min(...ratios);
      const extendMin =
        best >= NEAR_DONE_RATIO
          ? WORK_EXTEND_MIN
          : worst < FRESH_GRIND_RATIO
            ? WORK_GRIND_LATE_MIN
            : 0;
      if (extendMin > 0 && extendWorkShift(state.plan, phase, extendMin)) {
        state.bendsToday += 1;
        return KIND_WORK;
      }
    }
    return fallback;
  } catch (error) {
    return fallback; // intent reads never break the routine
  }
}

function atTile(player, tile, radius = 3) {
  if (!tile) {
    return true;
  }
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function walkTo(player, tile) {
  // Personality movement styles: the hasty walk direct, the elderly amble,
  // the drunk weaves, the nervous darts. Applied here so every routine
  // leg carries the citizen's physical personality.
  let target = { x: tile.x, y: tile.y };
  const username = player.getUsername?.() ?? "unknown";
  try {
    const { styleWalkTarget } = require("../../lib/CitizenAlive");
    const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    target = styleWalkTarget({ username, personality }, tile.x, tile.y);
  } catch {
    // Fall back to the unstyled target.
  }
  // Personal spot, not just noise: ten fishers should spread along the
  // dock, not pile on the same tile with ±3 jitter.
  const spot = personalSpot(username, target.x, target.y, 2, 8);
  requestMovement(player, spot.x, spot.y, {
    reason: "citizen_routine",
    basicPather: true,
    z: tile.z ?? 0,
  });
}

/** Inventory snapshot: id -> amount, so the shift's output can be diffed. */
function snapshotInventory(player) {
  const snap = new Map();
  try {
    const items = player.getInventory?.()?.getItems?.() ?? [];
    for (const item of items) {
      const id = item?.getId?.();
      const amount = item?.getAmount?.() ?? 0;
      if (Number.isInteger(id) && amount > 0) {
        snap.set(id, (snap.get(id) ?? 0) + amount);
      }
    }
  } catch (error) {
    // An unreadable inventory just means nothing to sell.
  }
  return snap;
}

/**
 * What the shift produced since the snapshot: positive deltas only, minus
 * coins and bread (wages and lunch, not work output).
 */
function gainedSince(player, snapshot) {
  const gained = [];
  const current = snapshotInventory(player);
  for (const [id, amount] of current) {
    if (id === COINS_ID || id === BREAD_ID) {
      continue;
    }
    const delta = amount - (snapshot?.get(id) ?? 0);
    if (delta > 0) {
      gained.push({ id, qty: delta });
    }
  }
  return gained;
}

function isSupplierFor(kingdomId) {
  return (local) => {
    if (!local?.getAttribute?.(ATTR_SUPPLIER_MERCHANT)) {
      return false;
    }
    try {
      return (local.getAttribute?.(ATTR_KINGDOM_ID) ?? null) === kingdomId;
    } catch (error) {
      return false;
    }
  };
}

/**
 * Real haul pricing (alignment review finding #5): the price of a work
 * drop or catch is the living-economy reference price for that item —
 * the same real table merchant stalls, player shops, and the trade
 * guild's gouging rule price from (GE baseline × live demand pressure).
 * Pure in-memory read, safe on the tick path; the economy module itself
 * floors at 1, so this never invents a price.
 */
function haulPriceFor(itemId) {
  try {
    const price = getReferencePrice(itemId, Date.now());
    if (Number.isFinite(price) && price >= 1) {
      return Math.floor(price);
    }
  } catch {
    // Economy unavailable — fall through to the floor.
  }
  return 1;
}

/**
 * Verified credit (vanishing-coins sweep contract): adds() throws on the
 * real engine, so an unchecked credit can leave a debit with nothing to
 * show for it. True only when the amount actually landed.
 */
function verifiedAdds(inv, id, qty) {
  try {
    const before = inv.getAmount?.(id) ?? 0;
    inv.adds(id, qty);
    return (inv.getAmount?.(id) ?? 0) === before + qty;
  } catch {
    return false;
  }
}

/**
 * One citizen-to-citizen sale with debit rollback (vanishing-coins sweep
 * contract): the seller's items and the buyer's coins move only when both
 * sides verify; any failure rolls the partial trade back so nothing
 * vanishes mid-deal. Returns the coins paid, or 0 when the trade
 * couldn't complete.
 */
function sellItems(sellerInv, buyerInv, itemId, qty, unitPrice) {
  const total = qty * unitPrice;
  if (qty <= 0 || total <= 0) {
    return 0;
  }
  let itemsMoved = false; // the seller's stock reached the buyer
  let coinsTaken = false; // the buyer's coins left the buyer
  try {
    const buyerCoins = buyerInv.getAmount?.(COINS_ID) ?? 0;
    if (buyerCoins < total) {
      return 0; // can't cover — the trade doesn't happen
    }
    // 1. Seller debits the items (verified).
    const sellerItemsBefore = sellerInv.getAmount?.(itemId) ?? 0;
    sellerInv.deleteNumber(itemId, qty);
    if ((sellerInv.getAmount?.(itemId) ?? 0) !== sellerItemsBefore - qty) {
      return 0; // the debit didn't land — nothing moved
    }
    // 2. Buyer credits the items (verified; nested try so a throwing
    // credit still reaches the seller-side restore).
    const buyerItemsBefore = buyerInv.getAmount?.(itemId) ?? 0;
    let itemsLanded = false;
    try {
      buyerInv.adds(itemId, qty);
      itemsLanded = (buyerInv.getAmount?.(itemId) ?? 0) === buyerItemsBefore + qty;
    } catch {
      itemsLanded = false;
    }
    if (!itemsLanded) {
      try {
        sellerInv.adds(itemId, qty);
      } catch {
        // Best-effort restore; the seller keeps whatever comes back.
      }
      return 0;
    }
    itemsMoved = true;
    // 3. Buyer debits the coins (verified).
    const buyerCoinsBefore = buyerInv.getAmount?.(COINS_ID) ?? 0;
    buyerInv.deleteNumber(COINS_ID, total);
    if ((buyerInv.getAmount?.(COINS_ID) ?? 0) !== buyerCoinsBefore - total) {
      throw new Error("coin debit unverified");
    }
    coinsTaken = true;
    // 4. Seller credits the coins (verified; nested try so a throwing
    // credit still reaches the rollback).
    const sellerCoinsBefore = sellerInv.getAmount?.(COINS_ID) ?? 0;
    let coinsLanded = false;
    try {
      sellerInv.adds(COINS_ID, total);
      coinsLanded = (sellerInv.getAmount?.(COINS_ID) ?? 0) === sellerCoinsBefore + total;
    } catch {
      coinsLanded = false;
    }
    if (coinsLanded) {
      return total;
    }
    throw new Error("coin credit unverified");
  } catch {
    // A throw anywhere still reaches this rollback: the buyer keeps its
    // coins, the seller gets its items back. Nothing vanishes mid-deal.
    try {
      if (coinsTaken) {
        buyerInv.adds(COINS_ID, total);
      }
    } catch {
      // Best-effort: the buyer keeps whatever comes back.
    }
    try {
      if (itemsMoved) {
        buyerInv.deleteNumber(itemId, qty);
        sellerInv.adds(itemId, qty);
      }
    } catch {
      // Best-effort: the seller keeps whatever the rollback recovers.
    }
    return 0;
  }
}

/**
 * Canonical journal write for sales (the LLM mouth's source of truth).
 * Flavor, never a trade blocker.
 */
function journalWork(player, text) {
  try {
    require("../../lib/CitizenJournal")
      .getJournal()
      ?.log?.(player.getUsername?.(), "work", text);
  } catch {
    // Journaling never blocks a trade.
  }
}

function createCitizenRoutineAction(spec, world) {
  // Internal delegates, created once so their per-player state stays keyed.
  const socialDelegate = createIdleSocialAction(
    { anchorKind: "tavern", chatterMinMs: 120000, chatterMaxMs: 420000 },
    world
  );
  const marketDelegate = createIdleSocialAction(
    { anchorKind: "market", chatterMinMs: 180000, chatterMaxMs: 480000 },
    world
  );
  let workDelegate = null;
  let bankDelegate = null;

  function delegatesFor(player) {
    if (!workDelegate) {
      const site = workSite(player) ?? { catalog: "tree", tier: "normal", option: "Chop down" };
      workDelegate = createInteractObjectAction(
        {
          catalog: site.catalog ?? "tree",
          tier: site.tier ?? "normal",
          option: site.option ?? "Chop down",
          until: { inventoryFull: true },
          stallSeconds: 120,
        },
        world
      );
      bankDelegate = createBankAction({}, world);
    }
    return { workDelegate, bankDelegate };
  }

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`routine:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        day: -1,
        plan: null,
        phaseKind: null,
        workMode: "work", // work | bank
        workRetryAt: 0,
        lingerUntil: 0,
        workKind: null, // resolved lazily: 'fishing' | 'tree' | 'rock'
        nextCastAt: 0,
        casts: 0,
        bendsToday: 0, // goal-threading: how many times intents bent today's plan
      };
    });
  }

  /**
   * What this commoner does for a living, resolved once per citizen (stable
   * across days). Capitals with a dock get fishers; everyone else works the
   * kingdom's tree/rock site. Believable mix, not identical mix.
   */
  function resolveWorkKind(player, state) {
    if (state.workKind) {
      return state.workKind;
    }
    const dock = dockSite(player);
    if (dock && chance(state.rng, 0.4)) {
      state.workKind = WORK_FISHING;
    } else {
      state.workKind = workSite(player)?.catalog ?? "tree";
    }
    return state.workKind;
  }

  function workTileFor(player, state) {
    if (resolveWorkKind(player, state) === WORK_FISHING) {
      return dockSite(player);
    }
    return workSite(player);
  }

  /**
   * Fisher's shift: walk to the dock, then cast on a human rhythm with
   * fishing chatter. Catches are the stubbed part (real fishing needs a
   * brain NPC-interaction path that doesn't exist yet — see DESIGN.md); the
   * visible behavior and the work rhythm are real, and completed hauls feed
   * the master_trade goal like banked loads do for gatherers.
   */
  function fishWorkTick(ctx, state) {
    const { player, nowMs } = ctx;
    const dock = dockSite(player);
    if (!dock) {
      return "failed";
    }
    if (!atTile(player, dock, 8)) {
      walkTo(player, dock);
      return "running";
    }
    if (nowMs < state.nextCastAt) {
      return "running";
    }
    state.nextCastAt =
      nowMs + logNormalJitter(state.rng, 45000, state.human.tempoSigma);
    state.casts += 1;
    if (chance(state.rng, 0.5 * state.human.chatRate)) {
      try {
        const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
        sayPublic(player, voiceLine(voiceFor(personality), FISHING_LINES, state.rng));
      } catch (error) {
        // Cosmetic only.
      }
    }
    if (state.casts % CASTS_PER_HAUL === 0) {
      const bucket = (ctx.state.citizens ??= {});
      bucket.workCyclesBanked = (bucket.workCyclesBanked ?? 0) + 1;
      world?.log?.("citizen_routine_haul", {
        citizen: player.getUsername?.(),
        kingdom: kingdomIdOf(player),
        hauls: bucket.workCyclesBanked,
      });
      // The catch goes to the provisioner: real fish items sold dockside at
      // the real reference price — the human trading loop (catch, check
      // price, sell), never minted coins. Unsold fish ride in the pack.
      try {
        sellFisherHaul(player, state);
      } catch (error) {
        // The haul still counted toward the goal.
      }
      addMood(player, 3);
    }
    return "running";
  }

  /**
   * The fisher's haul is real fish (the small-net catch table), granted as
   * real inventory items, then sold dockside to a nearby provisioner at
   * the real reference price per fish — verified credits with debit
   * rollback (vanishing-coins sweep contract). A provisioner that can't
   * cover the whole catch buys what it can; unsold fish stay in the pack
   * for the market trip (the decision layer banks a full pack).
   */
  function sellFisherHaul(player, state) {
    const inventory = player.getInventory?.();
    if (!inventory) {
      return;
    }
    const fishId = chance(state.rng, 0.6) ? RAW_SHRIMPS_ID : RAW_ANCHOVIES_ID;
    const qty = 2 + Math.floor((state.rng?.() ?? 0.5) * 3); // 2-4 fish
    if (!verifiedAdds(inventory, fishId, qty)) {
      return; // full pack — the haul never left the water
    }
    const unitPrice = haulPriceFor(fishId);
    let sold = 0;
    let earned = 0;
    let buyerName = null;
    for (const provisioner of localProvisioners(player)) {
      if (sold >= qty) {
        break;
      }
      const provisionerInv = provisioner.getInventory?.();
      if (!provisionerInv) {
        continue;
      }
      const canAfford = Math.floor(
        (provisionerInv.getAmount?.(COINS_ID) ?? 0) / unitPrice
      );
      const sellQty = Math.min(qty - sold, canAfford);
      if (sellQty <= 0) {
        continue;
      }
      const paid = sellItems(inventory, provisionerInv, fishId, sellQty, unitPrice);
      if (paid > 0) {
        sold += sellQty;
        earned += paid;
        buyerName = provisioner.getUsername?.() ?? buyerName;
      }
    }
    const fishName = fishId === RAW_ANCHOVIES_ID ? "raw anchovies" : "raw shrimps";
    if (sold > 0) {
      world?.log?.("citizen_routine_catch_sale", {
        citizen: player.getUsername?.(),
        provisioner: buyerName,
        item: fishId,
        qty: sold,
        unitPrice,
        earned,
      });
      journalWork(
        player,
        `Sold ${sold} ${fishName} to ${buyerName ?? "a provisioner"} for ${earned} coins (${unitPrice} each).`
      );
    } else {
      journalWork(
        player,
        `Kept the catch (${qty} ${fishName}) — no provisioner dockside with the coin.`
      );
    }
  }

  function ensurePlan(state) {
    const today = dayStamp();
    if (state.day !== today) {
      state.day = today;
      state.plan = buildDayPlan(state.rng);
      state.phaseKind = null; // force phase re-entry
      state.bendsToday = 0; // fresh day, fresh bends
    }
  }

  /** Bread-selling merchants in view — the meal break's food source. */
  function localProvisioners(player) {
    const out = [];
    for (const local of player.getLocalPlayers?.() ?? []) {
      if (local === player || local?.isPlayerBot?.() !== true) {
        continue;
      }
      try {
        if (
          local.getAttribute?.(ATTR_CITIZEN_ROLE) === ROLE_MERCHANT &&
          sellsFood(local)
        ) {
          out.push(local);
        }
      } catch (error) {
        // A broken read skips one candidate, not the meal.
      }
    }
    return out;
  }

  /** Meal break: at the market, eat own bread or buy a loaf from a stall. */
  function mealTick(ctx, state) {
    const { player } = ctx;
    const market = siteTile(player, "market");
    if (market && !atTile(player, market, 6)) {
      walkTo(player, market);
      return "running";
    }
    attemptFeed(player, localProvisioners(player));
    return "running";
  }

  /**
   * Sell the shift's output to the supplier citizen: real transfers at the
   * real reference price per item — the supplier's own coins move to the
   * commoner (as much as the supplier can cover), the drops move to the
   * supplier. Verified credits with debit rollback (vanishing-coins sweep
   * contract). Then the bank trip banks whatever is left, coins included.
   */
  function sellTick(ctx, state) {
    const { player, nowMs } = ctx;
    const market = siteTile(player, "market");
    if (market && !atTile(player, market, 6)) {
      walkTo(player, market);
      return "running";
    }
    const supplier = findLocalCitizen(player, isSupplierFor(kingdomIdOf(player)));
    if (supplier) {
      const supplierInv = supplier.getInventory?.();
      const inventory = player.getInventory?.();
      let earned = 0;
      const sales = [];
      if (supplierInv && inventory) {
        for (const { id, qty } of state.sellMode.items) {
          const held = inventory.getAmount?.(id) ?? 0;
          // Real price for THIS item — the living-economy reference price
          // (GE baseline × demand pressure), not a fixed per-drop coin.
          const unitPrice = haulPriceFor(id);
          const supplierCoins = supplierInv.getAmount?.(COINS_ID) ?? 0;
          const afford = Math.floor(supplierCoins / unitPrice);
          const sellQty = Math.min(qty, held, afford);
          if (sellQty <= 0) {
            continue;
          }
          const paid = sellItems(inventory, supplierInv, id, sellQty, unitPrice);
          if (paid > 0) {
            earned += paid;
            sales.push({ id, qty: sellQty, unitPrice });
          }
        }
      }
      if (earned > 0) {
        addMood(player, Math.min(12, 2 + Math.floor(earned / 8)));
        world?.log?.("citizen_routine_drop_sale", {
          citizen: player.getUsername?.(),
          supplier: supplier.getUsername?.(),
          earned,
          sales,
        });
        journalWork(
          player,
          `Sold the shift's haul to ${supplier.getUsername?.() ?? "the supplier"} for ${earned} coins (${sales
            .map((s) => `${s.qty} @ ${s.unitPrice}`)
            .join(", ")}).`
        );
      }
    } else if (nowMs < state.sellGiveUpAt) {
      return "running"; // supplier's out — wait a beat at the market
    }
    // Sold, or nobody to sell to: bank the rest and get back to work.
    state.sellMode = null;
    state.workMode = "bank";
    return "running";
  }

  function enterPhase(ctx, state, kind) {
    state.phaseKind = kind;
    state.workMode = "work";
    state.workRetryAt = 0;
    state.lingerUntil = 0;
    state.sellMode = null;
    state.sellGiveUpAt = 0;
    const { player } = ctx;
    if (kind === KIND_WORK) {
      // Snapshot the inventory: the shift's output is whatever appears
      // on top of this. Tools carried in are excluded by construction.
      state.invSnapshot = snapshotInventory(player);
      const tile = workTileFor(player, state);
      if (tile) {
        walkTo(player, tile);
      }
    } else if (kind === KIND_SOCIAL) {
      const tavern = siteTile(player, "tavern");
      if (tavern) {
        walkTo(player, tavern);
      }
    } else if (kind === KIND_MARKET || kind === KIND_MEAL) {
      // Midday market trip, then the meal break right there among the stalls.
      const market = siteTile(player, "market");
      if (market) {
        walkTo(player, market);
      }
    } else {
      const home = ctx.state?.home;
      if (home) {
        walkTo(player, home);
      }
    }
  }

  const action = {
    id: "citizenRoutine",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      ensurePlan(state);
      const phase = phaseFor(state.plan, minutesNow());
      if (phase.kind !== state.phaseKind) {
        // Goal-threading: intents bend the leg before the clock commits to
        // it. bendLeg may mutate today's plan (skip/extend); when it bends
        // back into the current leg there's no re-entry to do.
        const bentKind = bendLeg(player, state, phase);
        if (bentKind !== state.phaseKind) {
          enterPhase(ctx, state, bentKind);
        }
      }

      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }

      // War alert: commoners stay home. (Guards handle the walls.)
      if (isKingdomAtWar(kingdomIdOf(player)) && state.phaseKind !== KIND_HOME) {
        enterPhase(ctx, state, KIND_HOME);
        return "running";
      }

      if (state.phaseKind === KIND_WORK) {
        if (resolveWorkKind(player, state) === WORK_FISHING) {
          return fishWorkTick(ctx, state);
        }
        // Mid-shift sale: the supplier buys the shift's output at the market.
        if (state.sellMode) {
          return sellTick(ctx, state);
        }
        const { workDelegate, bankDelegate } = delegatesFor(player);
        const site = workSite(player);
        if (state.workMode === "bank") {
          const result = bankDelegate.update(ctx);
          if (result === "success") {
            bankDelegate.stop?.(ctx);
            state.workMode = "work";
            // Real output banked — the director's master_trade goal samples this.
            const bucket = (ctx.state.citizens ??= {});
            bucket.workCyclesBanked = (bucket.workCyclesBanked ?? 0) + 1;
          } else if (result === "failed") {
            bankDelegate.stop?.(ctx);
            state.workMode = "work"; // try work again; inventory may have room
          }
          return "running";
        }
        if (nowMs < state.workRetryAt) {
          return "running";
        }
        if (site && !atTile(player, site, 12)) {
          walkTo(player, site);
          return "running";
        }
        const result = workDelegate.update(ctx);
        if (result === "success") {
          workDelegate.stop?.(ctx);
          // Inventory full: sell the shift's output to the supplier first,
          // then bank whatever is left (coins included).
          const gained = gainedSince(player, state.invSnapshot);
          if (gained.length > 0) {
            state.sellMode = { items: gained };
            state.sellGiveUpAt = nowMs + SELL_GIVE_UP_MS;
            const market = siteTile(player, "market");
            if (market) {
              walkTo(player, market);
            }
          } else {
            state.workMode = "bank";
          }
        } else if (result === "failed") {
          workDelegate.stop?.(ctx);
          // No reachable resource right now — wait a beat, don't spin.
          state.workRetryAt =
            nowMs + logNormalJitter(state.rng, RETRY_WORK_MS, state.human.tempoSigma);
          world?.log?.("citizen_routine_work_stalled", {
            citizen: player.getUsername?.(),
            kingdom: kingdomIdOf(player),
          });
        }
        return "running";
      }

      if (state.phaseKind === KIND_MARKET) {
        // Midday market trip: browse the stalls with the market crowd.
        return marketDelegate.update(ctx);
      }

      if (state.phaseKind === KIND_MEAL) {
        return mealTick(ctx, state);
      }

      if (state.phaseKind === KIND_SOCIAL) {
        // Delegate the tavern evening to the social action.
        return socialDelegate.update(ctx);
      }

      // Home: linger with human timing, occasionally step out for air.
      if (nowMs < state.lingerUntil) {
        return "running";
      }
      const home = ctx.state?.home;
      if (home && !atTile(player, home, 4)) {
        walkTo(player, home);
        return "running";
      }
      state.lingerUntil =
        nowMs + logNormalJitter(state.rng, 90000, state.human.tempoSigma);
      return "running";
    },
    stop(ctx) {
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  return action;
}

module.exports = {
  createCitizenRoutineAction,
  buildDayPlan,
  // Test seams (not part of the public contract):
  _bendLeg: bendLeg,
  _haulPriceFor: haulPriceFor,
  _sellItems: sellItems,
  _verifiedAdds: verifiedAdds,
  _extendWorkShift: extendWorkShift,
  _phaseFor: phaseFor,
  _KIND_WORK: KIND_WORK,
  _KIND_MARKET: KIND_MARKET,
  _KIND_MEAL: KIND_MEAL,
  _KIND_SOCIAL: KIND_SOCIAL,
  _KIND_HOME: KIND_HOME,
};
