"use strict";

/**
 * CitizenJobs — citizens take kingdom job-board work (Phase 3).
 *
 * Two-tier by construction: this is data-tier logic on the director
 * tick — scripted, zero LLM. Citizens work through the SAME Jobs
 * functions players use (Jobs.Kingdoms claim/complete), and complete
 * only through REAL paths:
 *
 *   supply / craft — the citizen delivers goods from their own real
 *     inventory through OfficeTools.deliverSupplies (items leave the
 *     inventory, the quartermaster pays, kingdom:supply-delivered
 *     attributes the units to the claim), then Jobs.complete verifies
 *     the attributed units.
 *   soldier — the citizen enlists through Militia.enlist; completion
 *     comes from the war-event hook (Jobs.onWarEventResolved), never
 *     from here.
 *
 *   envoy / scout / sabotage / builder / bounty — NO honest bot path:
 *     envoy & scout are errands whose meaning is a player travelling;
 *     sabotage completion rolls Espionage's detection against a person;
 *     builder needs deliberate material hauling; bounty hunting needs
 *     a targeted kill path that does not exist for citizens. Bots do
 *     not take them.
 *
 * Money pressure: the brain's needs attribute (citizens:needs) carries
 * hp/energy/mood — it has no money field in this codebase — so pressure
 * is read from the citizen's REAL coin purse (inventory item 995, the
 * same purse CitizenCrime fines and CitizenNeeds food purchases use):
 * below MONEY_PRESSURE_COINS the citizen looks for work.
 *
 * Rewards: Jobs pays from the posting kingdom's treasury into the
 * citizen's real inventory (gold) plus Influence standing — the same
 * treasury-funded path players get. No purse is invented: a citizen
 * must be materialized (a live bot with an inventory) to work, exactly
 * like CitizenCrafting's stall deliveries.
 *
 * Gates, cheapest first: per-citizen cooldown → roster kingdom →
 * materialized bot → existing claim handling → money pressure → claim.
 */

const KingdomStore = require("../../kingdoms/KingdomStore");
const Jobs = require("../../kingdoms/Jobs.Kingdoms");

const JOBS_COOLDOWN_MS = 30 * 60 * 1000;
const MONEY_PRESSURE_COINS = 250;
const COINS_ID = 995;
const BOT_JOB_TYPES = ["supply", "craft", "soldier"];

const lastAttemptByCitizen = new Map(); // username -> timestamp

let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastAttemptByCitizen) {
    if (at < cutoff) lastAttemptByCitizen.delete(k);
  }
}

function coinPurse(bot) {
  try {
    return bot?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0;
  } catch {
    return 0;
  }
}

/** Try to deliver against a claimed supply/craft job from the bot's real inventory. */
function attemptDelivery(bot, job, store) {
  try {
    const OfficeTools = require("../../kingdoms/OfficeTools.Kingdoms");
    const WarSupply = require("../../kingdoms/WarSupply.Kingdoms");
    const inv = bot.getInventory?.();
    if (!inv) return;
    const remainingUnits = (job.units ?? 0) - (job.deliveredUnits ?? 0);
    if (remainingUnits <= 0) return;
    for (const [idStr, spec] of Object.entries(WarSupply.WAR_SUPPLY_ITEMS)) {
      if (!job.target?.stockpile && spec.cat !== job.target?.category) continue;
      const itemId = Number(idStr);
      const have = inv.getAmount?.(itemId) ?? 0;
      if (have <= 0) continue;
      const qty = Math.min(have, Math.ceil(remainingUnits / (spec.units || 1)));
      const res = OfficeTools.deliverSupplies(bot, job.kingdomId, itemId, qty);
      if (res?.ok) return; // one delivery per tick is plenty
    }
  } catch {
    // Delivery path unavailable: the claim waits for a later tick.
  }
}

/** Enlist a soldier claimant with the militia of their kingdom. */
function attemptEnlist(bot, job, store) {
  try {
    const Militia = require("../../kingdoms/Militia.Kingdoms");
    const username = bot.getUsername?.();
    if (!username || Militia.isMilitia(username)) return;
    let side = "defender";
    try {
      const war = (store.getActiveWars?.() ?? []).find(
        (w) => w && (w.attackerId === job.kingdomId || w.defenderId === job.kingdomId)
      );
      if (war && war.attackerId === job.kingdomId) side = "attacker";
    } catch {
      // Default to defending the home kingdom.
    }
    Militia.enlist(bot, job.kingdomId, side);
  } catch {
    // Militia unavailable: the claim still stands for the war hook.
  }
}

/** Work one citizen's claim (existing) or take a new one. */
function workCitizen(director, record, bot, nowMs) {
  const store = KingdomStore;
  const kingdomId =
    record.kingdomId ?? bot.getAttribute?.("kingdom:id") ?? null;
  if (!kingdomId) return;
  const username = record.username ?? bot.getUsername?.();
  if (!username) return;

  // Existing claim first: deliver / enlist / complete through real paths.
  const claims = Jobs.claimsOf(username, store);
  const mine = claims[0];
  if (mine) {
    if (mine.type === "supply" || mine.type === "craft") {
      attemptDelivery(bot, mine, store);
      const fresh = Jobs.claimsOf(username, store)[0];
      if (fresh && (fresh.deliveredUnits ?? 0) >= (fresh.units ?? 0)) {
        Jobs.complete(bot, fresh.id, store);
      }
    } else if (mine.type === "soldier") {
      attemptEnlist(bot, mine, store);
    }
    return;
  }

  // Money pressure gate: a comfortable citizen doesn't queue for work.
  if (coinPurse(bot) >= MONEY_PRESSURE_COINS) return;

  let board = [];
  try {
    board = Jobs.boardFor(kingdomId, store, nowMs);
  } catch {
    return;
  }
  const job = board.find((j) => j && BOT_JOB_TYPES.includes(j.type) && !j.claimedBy);
  if (!job) return;
  const res = Jobs.claim(bot, job.id, store, nowMs);
  if (!res?.ok) return;
  if (job.type === "soldier") attemptEnlist(bot, res.job, store);
  else attemptDelivery(bot, res.job, store);
}

/**
 * The tick function. Called from the director tick next to warfare.
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickCitizenJobs(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      const last = lastAttemptByCitizen.get(record.username) || 0;
      if (nowMs - last < JOBS_COOLDOWN_MS) continue;
      const bot = director.getBot?.(record) ?? director.playerFor?.(record) ?? null;
      if (!bot) continue; // data-tier citizens have no purse to pay into
      lastAttemptByCitizen.set(record.username, nowMs);
      try {
        workCitizen(director, record, bot, nowMs);
      } catch {
        // One citizen's job hunt must never break the tick.
      }
    }
  } catch (e) {
    console.warn("[citizen-jobs] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickCitizenJobs,
  JOBS_COOLDOWN_MS,
  MONEY_PRESSURE_COINS,
  BOT_JOB_TYPES,
  _test: { workCitizen, coinPurse, pruneCooldowns, lastAttemptByCitizen },
};
