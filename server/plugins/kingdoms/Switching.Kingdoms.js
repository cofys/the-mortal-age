"use strict";

/**
 * Switching.Kingdoms — leaving a kingdom and joining another one.
 *
 * Allegiance is a choice, not a tattoo. A subject may renounce their oath,
 * and a free subject may travel to another capital and petition its steward
 * for naturalization. Both directions run through the real systems — the
 * hatred backend (Influence.breakOath), the war-effort service economy
 * (donations earn real influence), and the membership event bus
 * (kingdom:rank-granted seats the new subject).
 *
 * THE FLOW
 *   renounce      — at your own steward's desk or the My Kingdom panel.
 *                   Calls Influence.breakOath: -75 with the old kingdom, 40%
 *                   word-spread of -15 to each other kingdom. Vacates any
 *                   offices held, strips rank and titles, clears allegiance,
 *                   and starts the 7-day cooldown.
 *   petition-join — at a foreign capital's steward's desk, diegetic: you
 *                   must travel there yourself. Only the allegiance-free may
 *                   petition. Opens a naturalization quest.
 *   naturalize    — earn NATURALIZATION_INFLUENCE_TARGET influence with the
 *                   target kingdom through REAL service (war-effort donations
 *                   and kingdom tasks land through the normal influence
 *                   events — no fake progress bars), and carry
 *                   NATURALIZATION_FEE coins for the court's fee.
 *   take-oath     — at the same steward's desk, once service is proven, the
 *                   fee is in hand, and the cooldown has run its course. The
 *                   oath seats the subject at +10 influence (the standard
 *                   fealty grant) and starts the tenure clock.
 *
 * NEW-MEMBER LIMITS (tenure): no office petitions/challenges and no
 * strategic war-council powers until TENURE_MS of sworn membership. Defense
 * (sally, repair) and service (supply contributions, donations) are every
 * subject's duty and stay open. Existing subjects predate the oath ledger:
 * their tenure falls back to their first recorded service, and when nothing
 * is recorded at all they are grandfathered in.
 *
 * Storage: kingdom:oath-at (timestamp of the current oath, per player —
 * reset on every new oath), kingdom:renounced-at (last renounce, drives the
 * cooldown), kingdom:naturalization ({ kingdomId, startedAt }).
 *
 * Pure except for attach (persists the attributes, holds the event bus) and
 * the treasury/inventory touches in takeOath, which follow donateToKingdom's
 * exact pattern. Does NOT require Commands or Politics — those require this
 * module (tenure gates), so this layer stays below them.
 */

const Influence = require("./Influence.Kingdoms");
const Membership = require("./Membership.Kingdoms");
const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");

const DAY_MS = 24 * 60 * 60 * 1000;
const COINS_ID = 995;

/** All switching numbers live here. Nothing else in the codebase hardcodes them. */
const SWITCHING_CONFIG = Object.freeze({
  /** After renouncing, no new oath may be sworn until this has passed. */
  cooldownMs: 7 * DAY_MS,
  /** New members may not petition for offices or use strategic war powers until this much sworn time. */
  tenureMs: 14 * DAY_MS,
  /** Effective influence with the target kingdom that proves a naturalization petition. */
  naturalizationInfluenceTarget: 150,
  /** Coins the new court charges at the oath ceremony. */
  naturalizationFee: 10000,
});

const OATH_AT_ATTRIBUTE = "kingdom:oath-at";
const RENOUNCED_AT_ATTRIBUTE = "kingdom:renounced-at";
const NATURALIZATION_ATTRIBUTE = "kingdom:naturalization";

let pluginApi = null;

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function kingdomName(kingdomId) {
  return Store.getKingdom(kingdomId)?.name ?? kingdomId;
}

function getAttr(player, key) {
  try {
    return player?.getAttribute?.(key) ?? null;
  } catch {
    return null;
  }
}

function setAttr(player, key, value) {
  try {
    player?.setAttribute?.(key, value);
  } catch {
    // Best effort.
  }
}

/** The kingdom the player currently serves, or null. */
function allegianceOf(player) {
  return getAttr(player, Membership.KINGDOM_ID_ATTRIBUTE) || null;
}

/**
 * When the player's current oath to this kingdom began. Falls back to the
 * first recorded service for subjects sworn before the oath ledger existed,
 * and to "tenured" when nothing is recorded at all (grandfathered).
 * Returns null when the player does not serve the kingdom.
 */
function oathTimestamp(player, kingdomId) {
  try {
    if ((player?.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE) ?? null) !== kingdomId) {
      return null;
    }
    const oathAt = player?.getAttribute?.(OATH_AT_ATTRIBUTE);
    if (typeof oathAt === "number" && oathAt > 0) return oathAt;
    const records = player?.getAttribute?.(Influence.INFLUENCE_ATTRIBUTE) ?? {};
    const rec = records && typeof records === "object" ? records[kingdomId] : null;
    if (rec && typeof rec.firstEarned === "number" && rec.firstEarned > 0) {
      return rec.firstEarned;
    }
    return -Infinity; // Grandfathered: sworn before any ledger.
  } catch {
    return -Infinity;
  }
}

/** Sworn membership duration in ms. Infinity for grandfathered subjects, 0 when unsworn. */
function tenureMsOf(player, kingdomId) {
  const ts = oathTimestamp(player, kingdomId);
  if (ts === -Infinity) return Infinity;
  if (ts == null) return 0;
  return Math.max(0, Date.now() - ts);
}

/** True when the player has been sworn to this kingdom for at least TENURE_MS. */
function hasTenure(player, kingdomId) {
  return tenureMsOf(player, kingdomId) >= SWITCHING_CONFIG.tenureMs;
}

/** Whole days of sworn membership, for display. */
function tenureDaysOf(player, kingdomId) {
  const ms = tenureMsOf(player, kingdomId);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / DAY_MS);
}

/** Milliseconds until the player may swear a new oath, or 0. */
function cooldownRemainingMs(player) {
  const at = getAttr(player, RENOUNCED_AT_ATTRIBUTE);
  if (typeof at !== "number" || !(at > 0)) return 0;
  return Math.max(0, at + SWITCHING_CONFIG.cooldownMs - Date.now());
}

/** Whole days until the cooldown ends, for display. */
function cooldownDaysLeft(player) {
  return Math.ceil(cooldownRemainingMs(player) / DAY_MS);
}

/** The kingdom id an active naturalization quest points at, or null. */
function naturalizationTarget(player) {
  try {
    const quest = player?.getAttribute?.(NATURALIZATION_ATTRIBUTE);
    if (quest && typeof quest === "object" && typeof quest.kingdomId === "string") {
      return quest.kingdomId;
    }
  } catch {
    // Fall through.
  }
  return null;
}

function coinsCarried(player) {
  try {
    return player?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Renounce the player's oath. Vacates their offices (the same
 * kingdom:office-vacated event Commands.vacateOffice emits, so bound
 * citizens unbind cleanly), applies Influence.breakOath, strips rank and
 * titles, clears the allegiance, and starts the cooldown.
 * otherKingdomIds is injected like breakOath's (Store ids minus the old
 * one); rng is injectable for tests. Returns a result object or null.
 */
function renounce(player, otherKingdomIds, rng) {
  const oldKingdomId = allegianceOf(player);
  if (!player?.setAttribute || !oldKingdomId) return null;
  const username = usernameOf(player);

  // Lay down the seals first — a subject with no kingdom holds no offices.
  if (username) {
    for (const office of Offices.getOffices(oldKingdomId) ?? []) {
      if (office?.holder?.kind === "player" && office.holder.ref === username) {
        try {
          if (pluginApi) {
            pluginApi.emitCustomEvent("kingdom:office-vacated", {
              officeId: office.officeId,
              kingdomId: oldKingdomId,
            });
          }
        } catch {
          // The event is notification-only; the seat is cleared below regardless.
        }
        player.sendMessage(
          `[Oath] You lay down the seals of ${office.title ?? office.officeId}. The court will name another.`
        );
      }
    }
  }

  const broke = Influence.breakOath(player, oldKingdomId, otherKingdomIds, rng);

  setAttr(player, Membership.KINGDOM_ID_ATTRIBUTE, null);
  setAttr(player, Membership.KINGDOM_RANK_ATTRIBUTE, null);
  setAttr(player, Membership.KINGDOM_TITLES_ATTRIBUTE, []);
  setAttr(player, OATH_AT_ATTRIBUTE, null);
  setAttr(player, NATURALIZATION_ATTRIBUTE, null);
  setAttr(player, RENOUNCED_AT_ATTRIBUTE, Date.now());

  try {
    if (pluginApi) {
      pluginApi.emitCustomEvent("kingdom:oath-broken", {
        player,
        oldKingdomId,
        spreadTo: broke?.spreadTo ?? [],
      });
    }
  } catch {
    // Notification only.
  }

  const spread = broke?.spreadTo ?? [];
  player.sendMessage(
    `[Oath] You renounce your oath to ${kingdomName(oldKingdomId)}. Your influence there lies in ruins.`
  );
  if (spread.length > 0) {
    player.sendMessage(
      `[Oath] Word travels fast — ${spread.map((id) => kingdomName(id)).join(", ")} ` +
        `${spread.length === 1 ? "has" : "have"} heard of your oathbreaking.`
    );
  }
  player.sendMessage(
    `[Oath] Seven days must pass before any court will hear a new oath from you.`
  );

  return { ok: true, oldKingdomId, spreadTo: spread };
}

/**
 * Petition a foreign court for naturalization. The player must be
 * allegiance-free (renounce first), and a hated or enemy-tier court will not
 * hear them. Replaces any in-progress petition elsewhere. Returns
 * { ok, reason?, message } — the message is player-facing.
 */
function startNaturalization(player, kingdomId) {
  if (!player?.setAttribute || !kingdomId || !Store.getKingdom(kingdomId)) {
    return { ok: false, reason: "no-kingdom", message: "That court does not exist." };
  }
  const allegiance = allegianceOf(player);
  if (allegiance) {
    return {
      ok: false,
      reason: "already-sworn",
      message:
        `You already serve ${kingdomName(allegiance)} — renounce your oath ` +
        `before this court will hear a petition from you.`,
    };
  }
  const tier = Influence.hatredTier(Influence.effectiveInfluence(player, kingdomId));
  if (tier === "hated" || tier === "enemy") {
    return {
      ok: false,
      reason: "unwelcome",
      message:
        `The court of ${kingdomName(kingdomId)} will not hear you — ` +
        (tier === "enemy"
          ? "you are declared an enemy of the realm."
          : "you are hated by the court.") +
        " Redeem yourself through service before petitioning.",
    };
  }
  const existing = naturalizationTarget(player);
  setAttr(player, NATURALIZATION_ATTRIBUTE, { kingdomId, startedAt: Date.now() });
  player.sendMessage(
    `[Court] The steward of ${kingdomName(kingdomId)} hears your petition. ` +
      `Prove yourself: earn ${SWITCHING_CONFIG.naturalizationInfluenceTarget} influence ` +
      `through service to the realm — war-effort donations, supplies, the court's tasks — ` +
      `and bring ${SWITCHING_CONFIG.naturalizationFee.toLocaleString("en-US")} coins for the court's fee. ` +
      `Then kneel here and swear.`
  );
  if (existing && existing !== kingdomId) {
    player.sendMessage(
      `[Court] Your petition to ${kingdomName(existing)} is withdrawn — one court at a time.`
    );
  }
  return { ok: true, kingdomId };
}

/**
 * The naturalization quest state for the overlay: live influence (the real
 * number — no fake progress bars), fee status, and exactly what still
 * blocks the oath. Null when no quest is active.
 */
function naturalizationProgress(player) {
  const kingdomId = naturalizationTarget(player);
  if (!kingdomId) return null;
  const target = SWITCHING_CONFIG.naturalizationInfluenceTarget;
  const fee = SWITCHING_CONFIG.naturalizationFee;
  const influence = Math.floor(Influence.effectiveInfluence(player, kingdomId));
  const feeCarried = coinsCarried(player);
  const cooldownLeft = cooldownDaysLeft(player);
  const tier = Influence.hatredTier(Influence.effectiveInfluence(player, kingdomId));
  const blockers = [];
  if (allegianceOf(player)) blockers.push("You already serve a kingdom — renounce first.");
  if (influence < target) {
    blockers.push(
      `Earn ${target - influence} more influence through service to ${kingdomName(kingdomId)}.`
    );
  }
  if (feeCarried < fee) {
    blockers.push(
      `Bring ${(fee - feeCarried).toLocaleString("en-US")} more coins for the court's fee.`
    );
  }
  if (cooldownLeft > 0) {
    blockers.push(
      `Your broken oath is still fresh — ${cooldownLeft} day${cooldownLeft === 1 ? "" : "s"} ` +
        `before any court will take your oath.`
    );
  }
  if (tier === "hated" || tier === "enemy") {
    blockers.push("This court will not hear you while you are its enemy.");
  }
  return {
    kingdomId,
    kingdomName: kingdomName(kingdomId),
    startedAt: getAttr(player, NATURALIZATION_ATTRIBUTE)?.startedAt ?? null,
    influence,
    target,
    fee,
    feeCarried,
    cooldownDaysLeft: cooldownLeft,
    oathReady: blockers.length === 0,
    blockers,
  };
}

/**
 * The oath ceremony, sworn at the steward's desk of the petitioned court.
 * Server-side enforcement: the quest must be active for this kingdom, the
 * player allegiance-free, service proven, fee in hand, cooldown elapsed, and
 * the court not hostile. On success the fee moves to the new treasury, the
 * oath seats the subject (+10 fealty influence, the standard grant), the
 * tenure clock starts, and the quest clears.
 */
function takeOath(player, kingdomId) {
  if (!player?.setAttribute) return { ok: false, reason: "bad-args" };
  const questKingdomId = naturalizationTarget(player);
  if (!questKingdomId || questKingdomId !== kingdomId) {
    return {
      ok: false,
      reason: "no-quest",
      message: "You have no petition before this court. Petition the steward first.",
    };
  }
  if (allegianceOf(player)) {
    return {
      ok: false,
      reason: "already-sworn",
      message: "You already serve a kingdom. Renounce your oath before swearing anew.",
    };
  }
  const tier = Influence.hatredTier(Influence.effectiveInfluence(player, kingdomId));
  if (tier === "hated" || tier === "enemy") {
    return {
      ok: false,
      reason: "unwelcome",
      message: "This court will not take your oath while you are its enemy.",
    };
  }
  const influence = Math.floor(Influence.effectiveInfluence(player, kingdomId));
  if (influence < SWITCHING_CONFIG.naturalizationInfluenceTarget) {
    return {
      ok: false,
      reason: "insufficient-service",
      message:
        `The court is not yet convinced — your service stands at ${influence} influence, ` +
        `and it asks ${SWITCHING_CONFIG.naturalizationInfluenceTarget}.`,
    };
  }
  const cooldownLeft = cooldownDaysLeft(player);
  if (cooldownLeft > 0) {
    return {
      ok: false,
      reason: "on-cooldown",
      message:
        `Your broken oath is still fresh — ${cooldownLeft} day${cooldownLeft === 1 ? "" : "s"} ` +
        `must pass before any court will take your oath.`,
    };
  }
  const fee = SWITCHING_CONFIG.naturalizationFee;
  const inventory = player.getInventory?.();
  const have = inventory?.getAmount?.(COINS_ID) ?? 0;
  if (have < fee) {
    return {
      ok: false,
      reason: "insufficient-fee",
      message: `The court's fee is ${fee.toLocaleString("en-US")} coins — you carry ${have.toLocaleString("en-US")}.`,
    };
  }

  // The fee moves: purse -> new kingdom's treasury (same ledger path as donations).
  inventory.delete(COINS_ID, fee);
  inventory.refreshItems?.();
  Store.grantTax(kingdomId, fee);
  Store.recordIncome(kingdomId, "naturalization", fee);
  Store.save();

  // The oath itself: seats the subject at Subject, +10 fealty influence.
  Membership.joinKingdom(player, kingdomId);
  setAttr(player, OATH_AT_ATTRIBUTE, Date.now());
  setAttr(player, NATURALIZATION_ATTRIBUTE, null);

  player.sendMessage(
    `[Oath] You kneel before the court of ${kingdomName(kingdomId)} and swear. ` +
      `The steward raises you up: "Rise, subject of the realm. Serve well."`
  );
  return { ok: true, kingdomId };
}

function attachSwitching(api) {
  pluginApi = api;
  api.persistAttribute(OATH_AT_ATTRIBUTE);
  api.persistAttribute(RENOUNCED_AT_ATTRIBUTE);
  api.persistAttribute(NATURALIZATION_ATTRIBUTE);
}

module.exports = attachSwitching;
module.exports.SWITCHING_CONFIG = SWITCHING_CONFIG;
module.exports.OATH_AT_ATTRIBUTE = OATH_AT_ATTRIBUTE;
module.exports.RENOUNCED_AT_ATTRIBUTE = RENOUNCED_AT_ATTRIBUTE;
module.exports.NATURALIZATION_ATTRIBUTE = NATURALIZATION_ATTRIBUTE;
module.exports.allegianceOf = allegianceOf;
module.exports.tenureMsOf = tenureMsOf;
module.exports.tenureDaysOf = tenureDaysOf;
module.exports.hasTenure = hasTenure;
module.exports.cooldownRemainingMs = cooldownRemainingMs;
module.exports.cooldownDaysLeft = cooldownDaysLeft;
module.exports.naturalizationTarget = naturalizationTarget;
module.exports.startNaturalization = startNaturalization;
module.exports.naturalizationProgress = naturalizationProgress;
module.exports.takeOath = takeOath;
module.exports.renounce = renounce;
