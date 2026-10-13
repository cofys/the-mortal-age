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
// Jon 2026-10-13 — no fake skilling: routine fishers click real fishing spots
// through the same brain action the citizen_fish activity uses. The Fishing
// plugin owns animation, catches, and XP from the real click.
const { createFishAction } = require("../../../bots/brain/actions/Fish");
const { getReferencePrice } = require("../../../economy/Prices.Economy");
const { createBankAction } = require("../../../bots/brain/actions/Bank");
const { createIdleSocialAction } = require("./IdleSocial");
const { siteTile, workSite, dockSite, kingdomIdOf, siteTileBySettlement, workSiteBySettlement, siteTileByTown, workSiteByTown, fishingBiasByTown, pickPlace } = require("../CitizenSites");
const { isKingdomAtWar } = require("../../CitizenEvents");
const {
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_ROLE,
  ATTR_SUPPLIER_MERCHANT,
  ATTR_KINGDOM_ID,
  ATTR_CITIZEN_SETTLEMENT,
  ATTR_CITIZEN_TOWN,
  ATTR_CITIZEN_WORK_KIND,
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
const { ACT_ROUTINE } = require("../CitizenDecisions");
const { industriousness, sociabilityOf } = require("../CitizenDecisions");
const SlotCapacity = require("../CitizenSlotCapacity");

const KIND_HOME = "home";
const KIND_WORK = "work";
const KIND_MARKET = "market";
const KIND_MEAL = "meal";

// Bump to force day-plan rebuild on deploy (old plans have SOCIAL phase).
const PLAN_VERSION = 3;
// KIND_EVENING replaced KIND_SOCIAL (Jon 2026-10-12): no more 5-hour tavern
// block. Evenings are personality-varied — work late, home early, or a brief
// tavern beer break — and socializing happens ambiently wherever citizens are.
const KIND_EVENING = "evening";

const WORK_FISHING = "fishing";

// Evening styles, resolved once per citizen per day (seeded): no two
// citizens have identical evenings.
const EVENING_WORK_LATE = "workLate";
const EVENING_HOME_EARLY = "homeEarly";
const EVENING_TAVERN_BREAK = "tavernBreak";

// Work tools: citizens arrive at the work site with the tool for their
// trade. Without these the skill plugins refuse silently ("You don't have
// an axe") and the citizen stands at the tree/rock doing nothing — the
// 2026-10-12 standing bug. Bronze is the honest starter set.
const BRONZE_AXE_ID = 1351;
const BRONZE_PICKAXE_ID = 1265;
const SMALL_NET_ID = 303;
// Tavern beer break (Jon 2026-10-12): walk to the tavern, trade the
// barkeeper for a beer, drink it, chat a minute or two, back to work.
const BEER_ID = 1917;
const BEER_PRICE = 2; // coins, the standard tavern price
const BEER_BREAK_MAX_MS = 20 * 60 * 1000; // never longer than 20 minutes
const BEER_CHAT_MIN_MS = 60 * 1000; // chat 1-2 minutes, per Jon
const BEER_CHAT_MAX_MS = 2 * 60 * 1000;
// Animations (engine ids): 829 = drink (Potions.plugin.js). Fishing
// animation comes from the real Fishing plugin session now (Jon 2026-10-13:
// no fake skilling) — never played by hand.
const DRINK_ANIM_ID = 829;

// Lazy engine Animation (CitizenPrayer pattern): cosmetic only, never blocks.
let AnimationClass = null;
let animationTried = false;
function getAnimationClass() {
  if (AnimationClass || animationTried) return AnimationClass;
  animationTried = true;
  try {
    AnimationClass =
      require("../../../../src/main/typescript/elvarg/game/model/Animation").Animation;
  } catch {
    AnimationClass = null;
  }
  return AnimationClass;
}
function playAnim(player, animId) {
  try {
    const Anim = getAnimationClass();
    if (Anim && player?.performAnimation) {
      player.performAnimation(new Anim(animId));
    }
  } catch {
    // Cosmetic only.
  }
}

/**
 * The 2026-10-12 standing-bug fix: the Woodcutting and Mining plugins
 * silently refuse ("You don't have an axe/pickaxe") when the citizen has
 * no tool, so the work delegate clicks forever and the citizen stands at
 * the tree/rock doing nothing visible. Ensure the trade's starter tool is
 * in the pack before the shift starts. Self-healing: re-granted if lost.
 */
function ensureWorkTool(player, workKind) {
  let toolId = null;
  if (workKind === "tree") toolId = BRONZE_AXE_ID;
  else if (workKind === "rock") toolId = BRONZE_PICKAXE_ID;
  else if (workKind === WORK_FISHING) toolId = SMALL_NET_ID;
  if (!toolId) return;
  try {
    const inventory = player.getInventory?.();
    if (!inventory) return;
    if ((inventory.getAmount?.(toolId) ?? 0) > 0) return;
    inventory.adds(toolId, 1);
  } catch {
    // A tool-less shift stalls; the retry loop covers it.
  }
}

const DAY_MINUTES = 24 * 60;
const RETRY_WORK_MS = 60000;

/**
 * Town + settlement-aware site resolution. Smaller-town citizens live at
 * their town, not the affiliated capital — their work/market/tavern are
 * the town's anchors. Frontier settlement citizens use the settlement's.
 * Capital citizens (no town/settlement attribute) use the kingdom sites
 * as before.
 */
function settlementIdOf(player) {
  try {
    const id = player?.getAttribute?.(ATTR_CITIZEN_SETTLEMENT);
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function townIdOf(player) {
  try {
    const id = player?.getAttribute?.(ATTR_CITIZEN_TOWN);
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function siteTileLocal(player, kind) {
  const tid = townIdOf(player);
  if (tid) {
    const tile = siteTileByTown(tid, kind);
    if (tile) return tile;
  }
  const sid = settlementIdOf(player);
  if (sid) {
    const tile = siteTileBySettlement(sid, kind);
    if (tile) return tile;
  }
  return siteTile(player, kind);
}

function workSiteLocal(player) {
  // Use pickPlace for inter-town variety: citizens work at gather places
  // across the kingdom, not just their town's single tile.
  try {
    const { agentRng } = require("../../lib/humanizer");
    const name = player.getUsername?.() ?? "unknown";
    const rng = agentRng(`workplace:${name}:${Math.floor(Date.now() / (90 * 60 * 1000))}`);
    // Pick based on citizen's work kind preference (default tree)
    const workKind = player.getAttribute?.("citizen:workKind") ?? "tree";
    const kind = workKind === "rock" ? "rock" : "tree";
    const place = pickPlace(player, kind, rng);
    if (place) {
      return {
        catalog: place.kind === "rock" ? "rock" : "tree",
        tier: place.tier ?? "normal",
        option: place.kind === "rock" ? "Mine" : "Chop down",
        x: place.x, y: place.y, z: place.z,
      };
    }
  } catch {
    // Fall through to legacy logic
  }
  const tid = townIdOf(player);
  if (tid) {
    const site = workSiteByTown(tid);
    if (site) return site;
  }
  const sid = settlementIdOf(player);
  if (sid) {
    const site = workSiteBySettlement(sid);
    if (site) return site;
  }
  return workSite(player);
}
// Haul pricing (alignment review finding #5): gatherer drops and fisher
// catches sell at the living-economy reference price for that item — the
// same real price table merchant stalls, player shops, and the trade
// guild's gouging rule price from (GE baseline × live demand pressure).
// Never a fixed per-item coin; see haulPriceFor below.
// Don't stall the shift forever waiting on a supplier that never shows.
const SELL_GIVE_UP_MS = 3 * 60 * 1000;
const COINS_ID = 995;
const BREAD_ID = 2309;

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
 * without drifting. Boundaries share one jittered value each (then forced
 * monotonic) so adjacent phases always meet — no gaps, no overlaps.
 * Some days are "late days" (the whole day slides ~90 min — a lie-in),
 * rare days are "days off" (a slow day: market, a tavern beer break, home —
 * everyone needs one).
 *
 * Jon 2026-10-12: the old 17:00-22:00 SOCIAL block is gone. Evenings are
 * personality-varied (work late / home early / tavern beer break) and
 * socializing happens ambiently wherever citizens are, not parked at the
 * tavern for five hours.
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
    { kind: KIND_EVENING, start: b17, end: b22 },
    { kind: KIND_HOME, start: b22, end: DAY_MINUTES },
  ];
  if (dayOff) {
    // Day off: the work legs become evening legs (beer break + home),
    // so a day off is genuinely restful, not a tavern marathon.
    return plan.map((phase) =>
      phase.kind === KIND_WORK ? { ...phase, kind: KIND_EVENING } : phase
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
 * - Leaving KIND_WORK for KIND_EVENING with an unfinished work intent:
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
    if (state.phaseKind === KIND_WORK && phase.kind === KIND_EVENING) {
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
  // Slot claim on top of the personal ring: N citizens walking to the same
  // anchor land on N distinct slot tiles (structural de-dup). Falls back to
  // personalSpot when the spot is full — the 2026-10-08 destack stays the
  // floor, never a regression.
  let dest = null;
  try {
    const claim = SlotCapacity.claimSlot(
      player,
      ACT_ROUTINE,
      target.x,
      target.y,
      tile.z ?? 0,
      agentRng(`slots:${username}`)
    );
    if (claim) {
      dest = { x: claim.x, y: claim.y };
    }
  } catch {
    // fall through to personalSpot
  }
  // Personal spot, not just noise: ten fishers should spread along the
  // dock, not pile on the same tile with ±3 jitter.
  const spot = dest ?? personalSpot(username, target.x, target.y, 2, 8);
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
  // (The tavern socialDelegate was removed with KIND_SOCIAL, Jon 2026-10-12:
  // beer breaks handle tavern time now.)
  const marketDelegate = createIdleSocialAction(
    {
      anchorKind: "market",
      chatterMinMs: 180000,
      chatterMaxMs: 480000,
      activityId: "citizen_routine_market", // destack slot namespace
    },
    world
  );
  let workDelegate = null;
  // Work delegates are keyed by site config (catalog/tier/option): a single
  // shared delegate would lock every citizen to the first player's work type.
  // Settlement citizens (rock) and capital citizens (tree) need different
  // delegates. The InteractObject action keeps per-player state internally.
  const workDelegates = new Map();
  let bankDelegate = null;
  // One shared real-fish delegate (Jon 2026-10-13): routine fishers click
  // real fishing spots through the same brain action the citizen_fish
  // activity uses. Per-player state lives inside the action.
  let fishDelegate = null;

  function fishDelegatesFor(player) {
    if (!fishDelegate) {
      fishDelegate = createFishAction(
        { tool: "NET", until: { inventoryFull: true } },
        world
      );
    }
    if (!bankDelegate) {
      bankDelegate = createBankAction({}, world);
    }
    return { workDelegate: fishDelegate, bankDelegate };
  }

  function stopFishDelegate(player) {
    if (!fishDelegate || !player) return;
    try {
      fishDelegate.stop?.({ player, nowMs: Date.now() });
    } catch {
      // Best-effort.
    }
  }

  function delegatesFor(player) {
    const site = workSiteLocal(player) ?? { catalog: "tree", tier: "normal", option: "Chop down" };
    const key = `${site.catalog ?? "tree"}|${site.tier ?? "normal"}|${site.option ?? "Chop down"}`;
    let workDelegate = workDelegates.get(key);
    if (!workDelegate) {
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
      workDelegates.set(key, workDelegate);
    }
    if (!bankDelegate) {
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
        bendsToday: 0, // goal-threading: how many times intents bent today's plan
        eveningStyle: null, // resolved on first evening: workLate | homeEarly | tavernBreak
        beerBreak: null, // active beer-break state machine, or null
        beerBreakDoneDay: -1, // dayStamp of the last beer break (max one per day)
        nextWorkChatAt: 0, // ambient chatter while working (Jon 2026-10-12)
      };
    });
  }

  /**
   * Resolve this citizen's evening style: seeded per citizen per day, weighted
   * by personality. Industrious citizens work late; homebodies head home;
   * social ones take the tavern beer break. No two citizens share an evening.
   */
  function resolveEveningStyle(player, state) {
    if (state.eveningStyle) return state.eveningStyle;
    const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    const industrious = industriousness(personality);
    const social = sociabilityOf(personality);
    const roll = state.rng();
    // Weighted: industrious -> work late, social -> tavern, else home early.
    if (roll < 0.25 + industrious * 0.25) {
      state.eveningStyle = EVENING_WORK_LATE;
    } else if (roll < 0.55 + social * 0.2) {
      state.eveningStyle = EVENING_TAVERN_BREAK;
    } else {
      state.eveningStyle = EVENING_HOME_EARLY;
    }
    return state.eveningStyle;
  }

  const BEER_LINES = Object.freeze([
    "Ale's decent tonight.",
    "Long day. This one's earned.",
    "You working tomorrow?",
    "Heard the strangest rumour about the river...",
    "My back's killing me. Getting old.",
    "Another round? I'm buying. Well — almost.",
  ]);

  const WORK_LINES = Object.freeze([
    "Nice day for it.",
    "This one's stubborn.",
    "Steady pace wins the shift.",
    "Nearly got a full pack.",
    "The kingdom needs every bit of this.",
  ]);

  function sayBeerLine(player, state) {
    try {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      sayPublic(player, voiceLine(voiceFor(personality), BEER_LINES, state.rng));
    } catch {
      // Cosmetic only.
    }
  }

  function sayWorkLine(player, state) {
    try {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      sayPublic(player, voiceLine(voiceFor(personality), WORK_LINES, state.rng));
    } catch {
      // Cosmetic only.
    }
  }

  /**
   * Start a tavern beer break (Jon 2026-10-12): walk to the tavern, trade
   * the barkeeper for a beer, drink it, chat a minute or two, then back to
   * what they were doing. Max 20 minutes, once per day. An interrupt, not
   * a phase — the caller resumes its own work afterwards.
   */
  function startBeerBreak(ctx, state, returnTile) {
    const { player, nowMs } = ctx;
    const tavern = siteTileLocal(player, "tavern");
    if (!tavern) return false;
    state.beerBreak = {
      stage: "toTavern",
      startedAt: nowMs,
      endsAt: nowMs + BEER_BREAK_MAX_MS,
      chatUntil: 0,
      drinkAt: 0,
      saidSecond: false,
      returnTile: returnTile ?? null,
    };
    state.beerBreakDoneDay = dayStamp();
    walkTo(player, tavern);
    return true;
  }

  /**
   * Buy a beer from the barkeeper. Real trade semantics: coins leave, beer
   * arrives (verified, with rollback). The coins pay for the beer whether
   * or not a barkeeper NPC is standing there — the tavern always serves.
   */
  function buyBeer(player) {
    try {
      const inventory = player.getInventory?.();
      if (!inventory) return false;
      const coins = inventory.getAmount?.(COINS_ID) ?? 0;
      if (coins < BEER_PRICE) return false; // broke — skip the beer
      inventory.deleteNumber(COINS_ID, BEER_PRICE);
      if (!verifiedAdds(inventory, BEER_ID, 1)) {
        // Roll back the coins if the beer didn't land.
        try { inventory.adds(COINS_ID, BEER_PRICE); } catch { /* best effort */ }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function drinkBeer(player) {
    try {
      const inventory = player.getInventory?.();
      if ((inventory?.getAmount?.(BEER_ID) ?? 0) > 0) {
        inventory.deleteNumber(BEER_ID, 1);
      }
      playAnim(player, DRINK_ANIM_ID);
    } catch {
      // Cosmetic only.
    }
  }

  /**
   * Advance the beer-break state machine. Returns true while the break is
   * active (caller should return "running"), false when it's done and the
   * caller should resume its own work.
   */
  function beerBreakTick(ctx, state) {
    const { player, nowMs } = ctx;
    const br = state.beerBreak;
    if (!br) return false;
    // Hard cap: never longer than 20 minutes, then back to work.
    if (nowMs >= br.endsAt) {
      state.beerBreak = null;
      return false;
    }
    if (player.getForceMovement?.() != null) return true;
    if (player.getMovementQueue?.()?.size?.() > 0) return true;

    const tavern = siteTileLocal(player, "tavern");
    if (br.stage === "toTavern") {
      if (tavern && !atTile(player, tavern, 4)) {
        walkTo(player, tavern);
        return true;
      }
      br.stage = "buy";
      return true;
    }
    if (br.stage === "buy") {
      if (buyBeer(player)) {
        br.stage = "drink";
        br.drinkAt = nowMs + 3000; // a beat to "receive" the beer
      } else {
        // Couldn't buy (broke, or pack full) — chat anyway, then leave.
        br.stage = "chat";
        br.chatUntil = nowMs + BEER_CHAT_MIN_MS;
        sayBeerLine(player, state);
      }
      return true;
    }
    if (br.stage === "drink") {
      if (nowMs < br.drinkAt) return true;
      drinkBeer(player);
      br.stage = "chat";
      // 1-2 minutes of chat, per Jon — seeded per citizen.
      br.chatUntil =
        nowMs + BEER_CHAT_MIN_MS + Math.floor(state.rng() * (BEER_CHAT_MAX_MS - BEER_CHAT_MIN_MS));
      sayBeerLine(player, state);
      return true;
    }
    if (br.stage === "chat") {
      if (nowMs >= br.chatUntil) {
        br.stage = "return";
        return true;
      }
      if (!br.saidSecond && nowMs >= br.chatUntil - BEER_CHAT_MIN_MS / 2) {
        br.saidSecond = true;
        if (chance(state.rng, 0.6)) sayBeerLine(player, state);
      }
      return true;
    }
    if (br.stage === "return") {
      const dest = br.returnTile;
      if (dest && !atTile(player, dest, 6)) {
        walkTo(player, dest);
        return true;
      }
      state.beerBreak = null;
      return false;
    }
    state.beerBreak = null;
    return false;
  }

  /**
   * Should this citizen take a beer break right now? Seeded, max once per
   * day, weighted toward social personalities. Only during active work
   * (not when banking, selling, or already on a break). The dice are rolled
   * once per work-phase entry, not every tick.
   */
  function maybeBeerBreak(ctx, state) {
    if (state.beerBreak) return false;
    if (state.beerBreakDoneDay === dayStamp()) return false;
    if (state.beerBreakRolled) return false; // already rolled this phase
    state.beerBreakRolled = true;
    const personality = ctx.player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    const social = sociabilityOf(personality);
    // ~35% of days for an average citizen, more for social ones.
    if (!chance(state.rng, 0.2 + social * 0.3)) return false;
    const site = workSiteLocal(ctx.player);
    return startBeerBreak(ctx, state, site);
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
    // Director-assigned anchor (stamped at spawn from the roster record):
    // adopt it so the brain works where the director spawned them instead
    // of rolling a different living and walking off.
    const anchored = player.getAttribute?.(ATTR_CITIZEN_WORK_KIND);
    if (anchored === WORK_FISHING || anchored === "tree" || anchored === "rock") {
      state.workKind = anchored;
      return state.workKind;
    }
    // Town citizens work their town's nodes: the town's fishing bias sends
    // fishers to the town dock; everyone else works the town's gather
    // site. Towns without a gather site (Blast Furnace district) fall
    // through to the kingdom branch so they still have a living.
    const tid = townIdOf(player);
    if (tid) {
      const townDock = siteTileByTown(tid, "dock");
      const bias = fishingBiasByTown(tid);
      if (townDock && bias > 0 && chance(state.rng, bias)) {
        state.workKind = WORK_FISHING;
        return state.workKind;
      }
      const townWork = workSiteByTown(tid);
      if (townWork) {
        state.workKind = townWork.catalog;
        return state.workKind;
      }
    }
    // Settlement citizens work their settlement's site (tree/rock from
    // settlements.json). No docks in settlements yet — no fishing.
    const sid = settlementIdOf(player);
    if (sid) {
      state.workKind = workSiteLocal(player)?.catalog ?? "tree";
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
    return workSiteLocal(player);
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
    const market = siteTileLocal(player, "market");
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
    const market = siteTileLocal(player, "market");
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
    // A phase change stops any in-progress real-fishing delegate (its site
    // claim is released; the Fishing plugin session ends when they walk).
    stopFishDelegate(ctx?.player);
    // A phase change cancels any in-progress beer break (it resumes via
    // the new phase's own logic) and re-arms the per-phase break roll.
    state.beerBreak = null;
    state.beerBreakRolled = false;
    const { player } = ctx;
    if (kind === KIND_WORK) {
      // Snapshot the inventory: the shift's output is whatever appears
      // on top of this. Tools carried in are excluded by construction.
      state.invSnapshot = snapshotInventory(player);
      // The 2026-10-12 standing-bug fix: no tool, no visible work.
      ensureWorkTool(player, resolveWorkKind(player, state));
      const tile = workTileFor(player, state);
      if (tile) {
        walkTo(player, tile);
      }
    } else if (kind === KIND_EVENING) {
      // Evenings are personality-varied (Jon 2026-10-12): the style was
      // resolved when the phase was entered; walk to the starting point.
      const style = resolveEveningStyle(player, state);
      if (style === EVENING_WORK_LATE) {
        state.invSnapshot = snapshotInventory(player);
        ensureWorkTool(player, resolveWorkKind(player, state));
        const tile = workTileFor(player, state);
        if (tile) walkTo(player, tile);
      } else if (style === EVENING_TAVERN_BREAK) {
        // The beer break runs inside the evening tick; start walking now.
        const tavern = siteTileLocal(player, "tavern");
        if (tavern) walkTo(player, tavern);
      } else {
        const home = ctx.state?.home;
        if (home) walkTo(player, home);
      }
    } else if (kind === KIND_MARKET || kind === KIND_MEAL) {
      // Midday market trip, then the meal break right there among the stalls.
      const market = siteTileLocal(player, "market");
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

  /**
   * The evening leg (Jon 2026-10-12): no more five-hour tavern stand.
   * - workLate: keep working like a WORK phase, then drift home at ~20:00.
   * - homeEarly: home for the evening.
   * - tavernBreak: one beer break at the tavern, then home.
   * Socializing happens ambiently wherever citizens are, not here.
   */
  function eveningTick(ctx, state) {
    const { player, nowMs } = ctx;
    const style = resolveEveningStyle(player, state);
    // An in-progress beer break always runs to completion first.
    if (state.beerBreak) {
      if (beerBreakTick(ctx, state)) return "running";
      // Break done — fall through to the style's default.
    }
    if (style === EVENING_WORK_LATE) {
      // Work until ~20:00, then head home. Reuse the work leg.
      if (minutesNow() >= 20 * 60) {
        const home = ctx.state?.home;
        if (home && !atTile(player, home, 4)) {
          walkTo(player, home);
          return "running";
        }
        if (nowMs < state.lingerUntil) return "running";
        state.lingerUntil = nowMs + logNormalJitter(state.rng, 90000, state.human.tempoSigma);
        return "running";
      }
      return workLegTick(ctx, state);
    }
    if (style === EVENING_TAVERN_BREAK) {
      // One beer break per day; after it's done, home for the night.
      // The break's returnTile is null — the evening ends at home anyway.
      if (state.beerBreakDoneDay !== dayStamp()) {
        if (startBeerBreak(ctx, state, null)) return "running";
      }
      const home = ctx.state?.home;
      if (home && !atTile(player, home, 4)) {
        walkTo(player, home);
        return "running";
      }
      if (nowMs < state.lingerUntil) return "running";
      state.lingerUntil = nowMs + logNormalJitter(state.rng, 90000, state.human.tempoSigma);
      return "running";
    }
    // homeEarly: home for the evening.
    const home = ctx.state?.home;
    if (home && !atTile(player, home, 4)) {
      walkTo(player, home);
      return "running";
    }
    if (nowMs < state.lingerUntil) return "running";
    state.lingerUntil = nowMs + logNormalJitter(state.rng, 90000, state.human.tempoSigma);
    return "running";
  }

  /**
   * The work leg, shared by the WORK phase and the workLate evening style.
   * Includes the beer-break interrupt (Jon 2026-10-12) and ambient chatter
   * while working — citizens socialize wherever they are, not at a tavern.
   */
  function workLegTick(ctx, state) {
    const { player, nowMs } = ctx;
    // Beer break interrupt: a citizen already on one runs it to completion.
    if (state.beerBreak) {
      if (beerBreakTick(ctx, state)) return "running";
      // Break finished — fall through and resume work.
    } else if (!state.sellMode && state.workMode === "work") {
      // Mid-shift beer break: seeded, once per day, social personalities.
      // Not while banking or mid-sale — only during the actual grind.
      maybeBeerBreak(ctx, state);
      if (state.beerBreak) {
        if (beerBreakTick(ctx, state)) return "running";
      }
    }
    // Ambient chatter while working (Jon 2026-10-12): they talk where they
    // are — at the tree, the rock, the dock — not just at the tavern.
    if (nowMs >= state.nextWorkChatAt) {
      state.nextWorkChatAt =
        nowMs + logNormalJitter(state.rng, 180000, state.human.tempoSigma);
      if (chance(state.rng, 0.5 * state.human.chatRate)) {
        sayWorkLine(player, state);
      }
    }
    // Mid-shift sale: the supplier buys the shift's output at the market.
    if (state.sellMode) {
      return sellTick(ctx, state);
    }
    // Jon 2026-10-13 — no fake skilling: fishers click real fishing spots
    // through the real fish brain action (the Fishing plugin owns animation,
    // catches, and XP from the click). No pre-walk to a dock anchor: the
    // action picks its own live spot cluster and works from a land stand
    // tile; a relocated spot is re-targeted and re-clicked like a player.
    if (resolveWorkKind(player, state) === WORK_FISHING) {
      return runWorkDelegate(ctx, state, fishDelegatesFor(player), null);
    }
    return runWorkDelegate(ctx, state, delegatesFor(player), workSiteLocal(player));
  }

  /**
   * Shared work/bank/sell/retry flow for a work delegate. site=null skips
   * the pre-walk — the delegate picks its own spot (the fish action's live
   * fishing-spot clusters).
   */
  function runWorkDelegate(ctx, state, delegates, site) {
    const { player, nowMs } = ctx;
    const { workDelegate, bankDelegate } = delegates;
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
        const market = siteTileLocal(player, "market");
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
        return workLegTick(ctx, state);
      }

      if (state.phaseKind === KIND_EVENING) {
        return eveningTick(ctx, state);
      }

      if (state.phaseKind === KIND_MARKET) {
        // Midday market trip: browse the stalls with the market crowd.
        return marketDelegate.update(ctx);
      }

      if (state.phaseKind === KIND_MEAL) {
        return mealTick(ctx, state);
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
        stopFishDelegate(ctx.player);
        // Slot-capacity lifecycle: ending the routine frees the spot claim.
        try {
          SlotCapacity.releaseFor(ctx.player);
        } catch {
          // best effort
        }
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
  _settlementIdOf: settlementIdOf,
  _siteTileLocal: siteTileLocal,
  _workSiteLocal: workSiteLocal,
  _KIND_WORK: KIND_WORK,
  _KIND_MARKET: KIND_MARKET,
  _KIND_MEAL: KIND_MEAL,
  _KIND_EVENING: KIND_EVENING,
  _KIND_HOME: KIND_HOME,
};
