"use strict";

/**
 * PlayerShopUpkeep — the slow clock behind player-owned market stalls.
 *
 * processUpkeep runs every ~6 minutes (a repeating core Task started by
 * PlayerShops.js) and does wall-clock math over the shop store, so a missed
 * sweep just settles more days/weeks on the next one:
 *   - daily wages: the till pays each hired hand DAILY_WAGE per day; a till
 *     that can't cover it loses the employee — they complain out loud when
 *     their citizen bot is online (hooks.findEmployeeBot).
 *   - weekly rent: taken from the till; the shortfall becomes rentDebt, and
 *     arrears beyond MISSED_RENT_WEEKS repossess the stall — stock and till
 *     are queued for ::shop claim and the hand is released.
 *
 * Kingdom names come from KingdomStore (pure fs/path). Everything
 * player- or bot-shaped arrives through hooks, so this module stays
 * unit-testable with plain node — no TS core graph:
 *   hooks = { findEmployeeBot(stall) -> bot|null,
 *             notifyOwner(stall, message),
 *             clearEmployeeMark(bot) }
 */

const Store = require("./PlayerShopStore");
const KingdomStore = require("../../kingdoms/KingdomStore");

const QUIT_LINES = [
  "No pay, no work — I quit!",
  "The till's empty and so is my patience. I'm done.",
  "Find yourself another shopkeep!",
];

const COINS = 995;

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function kingdomName(kingdomId) {
  try {
    return KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
  } catch {
    return kingdomId;
  }
}

function releaseEmployee(stall, reason, hooks = {}) {
  const name = stall.employee;
  if (!name) return;
  stall.employee = null;
  let bot = null;
  try {
    bot = hooks.findEmployeeBot?.(stall) ?? null;
  } catch {
    bot = null;
  }
  if (bot) {
    try {
      hooks.clearEmployeeMark?.(bot);
    } catch {
      // Cosmetic.
    }
    if (reason === "unpaid") {
      try {
        bot.forceChat?.(pick(QUIT_LINES));
      } catch {
        // Silent resentment.
      }
    }
  }
  console.info("[player-shops] employee released", {
    stall: stall.owner,
    employee: name,
    reason,
  });
}

function repossessStall(stall, hooks = {}) {
  const entries = Object.entries(stall.stock ?? {})
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => ({ id: Number(id), qty }));
  if ((stall.till ?? 0) > 0) {
    entries.push({ id: COINS, qty: stall.till });
  }
  Store.addReturns(stall.ownerKey, entries);
  releaseEmployee(stall, "repossessed", hooks);
  Store.removeStall(stall.ownerKey);
  Store.save();
  try {
    hooks.notifyOwner?.(
      stall,
      `Your market stall in ${kingdomName(stall.kingdomId)} was repossessed ` +
        `for unpaid rent. Your stock and till are waiting — type ::shop claim.`
    );
  } catch {
    // Offline owner: the message is lost, the returns queue isn't.
  }
  console.warn("[player-shops] stall repossessed", {
    stall: stall.owner,
    kingdom: stall.kingdomId,
    rentDebt: stall.rentDebt,
  });
}

/** Sweep every stall: wages by the day, rent by the week. Idempotent. */
function processUpkeep(hooks = {}, now = Date.now()) {
  const stalls = Store.getAllStalls();
  for (const stall of stalls) {
    // Daily wages come out of the till; a till that can't pay loses its hand.
    if (stall.employee) {
      const days = Math.floor((now - (stall.lastWageAt ?? now)) / Store.DAY_MS);
      if (days > 0) {
        const owed = days * Store.DAILY_WAGE;
        if ((stall.till ?? 0) >= owed) {
          stall.till -= owed;
        } else {
          releaseEmployee(stall, "unpaid", hooks);
        }
        stall.lastWageAt = (stall.lastWageAt ?? now) + days * Store.DAY_MS;
      }
    } else {
      stall.lastWageAt = now;
    }
    // Weekly rent comes out of the till; deep arrears repossess the stall.
    const { weeklyRent } = Store.stallCosts(stall.kingdomId);
    const weeks = Math.floor((now - (stall.lastRentAt ?? now)) / Store.WEEK_MS);
    if (weeks > 0) {
      const due = weeks * weeklyRent;
      const paid = Math.min(stall.till ?? 0, due);
      stall.till = (stall.till ?? 0) - paid;
      stall.rentDebt = (stall.rentDebt ?? 0) + (due - paid);
      stall.lastRentAt = (stall.lastRentAt ?? now) + weeks * Store.WEEK_MS;
      if (stall.rentDebt >= Store.MISSED_RENT_WEEKS * weeklyRent) {
        repossessStall(stall, hooks);
      } else if (stall.rentDebt > 0) {
        try {
          hooks.notifyOwner?.(
            stall,
            `Your market stall owes ${stall.rentDebt} coins in back rent. ` +
              `Keep the till funded or lose the pitch.`
          );
        } catch {
          // Offline owner.
        }
      }
    }
  }
  if (stalls.length > 0) {
    Store.save();
  }
}

module.exports = {
  processUpkeep,
  releaseEmployee,
  repossessStall,
  kingdomName,
};
