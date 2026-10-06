"use strict";

/**
 * PrimeMerchant — the one fully-real merchant per capital.
 *
 * Opens the stall at 08:00 and works it until 19:00: advertises, makes
 * abstract sales to passers-by (ware out, coins in — real inventory ops,
 * like the base merchant), and when stock runs low complains overhead and
 * walks to the kingdom's supplier citizen to restock WHOLESALE — spending
 * its own coin on wares, both sides real inventory ops. After closing it
 * heads to the tavern (the director switches it to tavern_social at 19:00;
 * the action itself idles at the tavern if it ever runs past hours).
 * On a kingdom war alert it packs up and goes home until the alert lifts.
 *
 * The wholesale loop is the point: supplier coins grow with every restock
 * (feeding their save_gold goal), the prime's margin is retail minus the
 * wholesale price, and when the supplier can't deliver the prime says so
 * where players can hear it.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { Item } = require("../../../../src/main/typescript/elvarg/game/model/Item");
const { ItemIds } = require("../../../../src/main/typescript/elvarg/util/IdEnums");
const { isKingdomAtWar } = require("../../CitizenEvents");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { findLocalCitizen } = require("../findCitizen");
const { addMood } = require("../CitizenNeeds");
const {
  ATTR_CITIZEN_PERSONALITY,
  ATTR_SUPPLIER_MERCHANT,
  ATTR_KINGDOM_ID,
} = require("../../constants");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");

const COINS = 995; // ItemIds.COINS, verified in ItemIdentifiers.ts

const PHASE_STALL = "stall";
const PHASE_TO_SUPPLIER = "toSupplier";
const PHASE_WHOLESALE = "wholesale";
const PHASE_TO_STALL = "toStall";
const PHASE_CLOSED = "closed";

const ARRIVE_RADIUS = 2;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 19;
const WHOLESALE_RETRY_MS = 5 * 60 * 1000;

const AD_LINES = Object.freeze([
  "Fine bronze swords! Sharp enough to shave with!",
  "Swords! Protect your home, protect your king!",
  "Bronze swords, fairly priced — come see!",
  "Arm yourself — the roads aren't safe.",
  "A sword for every hand that'll hold one!",
]);

const LOW_STOCK_LINES = Object.freeze([
  "Nearly out of bronze swords, curse these supply lines!",
  "Swords running low — my supplier had better show his face.",
  "Three swords left. THREE. The roads must be cursed.",
]);

const NO_SUPPLIER_LINES = Object.freeze([
  "My supplier's vanished — cursed roads.",
  "No supplier, no swords. Someone's getting an earful.",
]);

const DEAL_LINES = Object.freeze([
  "Pleasure doing business.",
  "Swords secured. The stall lives another day.",
]);

function resolveWareId(name) {
  if (Number.isInteger(name)) {
    return name;
  }
  const key = String(name ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  return ItemIds[key] ?? null;
}

function stockCount(player, wareId) {
  return player?.getInventory?.()?.getAmount?.(wareId) ?? 0;
}

function coinCount(player) {
  return player?.getInventory?.()?.getAmount?.(COINS) ?? 0;
}

function hourNow() {
  return new Date().getHours();
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function walkTo(player, tile, radius = ARRIVE_RADIUS) {
  const noisy = noisyTile(tile.x, tile.y, radius, null);
  requestMovement(player, noisy.x, noisy.y, {
    reason: "citizen_prime_merchant",
    basicPather: true,
    z: tile.z ?? 0,
  });
}

function isMySupplier(player, kingdomId) {
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

function createPrimeMerchantAction(spec, world) {
  const wareId = resolveWareId(spec.wareItem ?? "BRONZE_SWORD");
  const pricePerWare = Math.max(1, Math.floor(Number(spec.pricePerWare ?? 78)));
  const wholesalePrice = Math.max(1, Math.floor(Number(spec.wholesalePrice ?? 55)));
  const restockThreshold = Math.max(1, Math.floor(Number(spec.restockThreshold ?? 3)));
  const restockTarget = Math.max(restockThreshold + 1, Math.floor(Number(spec.restockTarget ?? 20)));
  const adMinMs = Math.max(1000, Number(spec.adIntervalMinMs ?? 180000));
  const adMaxMs = Math.max(adMinMs, Number(spec.adIntervalMaxMs ?? 420000));

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`prime:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        phase: PHASE_STALL,
        nextAdAt: 0,
        nextSaleAt: 0,
        nextWholesaleAt: 0,
        lowStockAnnounced: false,
        announcedOpen: false,
        announcedClose: false,
      };
    });
  }

  function say(player, line) {
    try {
      player.forceChat?.(line);
    } catch (error) {
      // Cosmetic only.
    }
  }

  /** One abstract sale: a sword leaves, coins arrive. Real inventory ops. */
  function sellTick(player, state, nowMs) {
    if (nowMs < state.nextSaleAt) {
      return;
    }
    const crowd = (player.getLocalPlayers?.() ?? []).length;
    const baseGap = crowd > 3 ? 120000 : 300000;
    state.nextSaleAt =
      nowMs + logNormalJitter(state.rng, baseGap, state.human.tempoSigma);
    const inventory = player.getInventory();
    if (!inventory || inventory.getAmount(wareId) <= 0) {
      return;
    }
    // Sword buyers take one at a time.
    inventory.deleteNumber(wareId, 1);
    try {
      inventory.add(new Item(COINS, pricePerWare), true);
    } catch (error) {
      world?.log?.("citizen_prime_sale_failed", {
        merchant: player.getUsername?.(),
        error: String(error?.message ?? error),
      });
      return;
    }
    addMood(player, 1); // earning feels good
    world?.log?.("citizen_prime_sale", {
      merchant: player.getUsername?.(),
      ware: wareId,
      coins: coinCount(player),
    });
  }

  function advertise(player, state, nowMs) {
    if (nowMs < state.nextAdAt) {
      return;
    }
    const gap = adMinMs + state.rng() * (adMaxMs - adMinMs);
    state.nextAdAt = nowMs + Math.round(gap / Math.max(0.2, state.human.chatRate));
    if (!chance(state.rng, 0.75)) {
      return;
    }
    say(player, AD_LINES[Math.floor(state.rng() * AD_LINES.length)]);
  }

  /**
   * Wholesale restock from the supplier citizen: the prime's own coin buys
   * swords at the wholesale price — real transfers on both sides.
   */
  function wholesale(player, state) {
    const kingdomId = kingdomIdOf(player);
    const supplier = findLocalCitizen(player, isMySupplier(player, kingdomId));
    if (!supplier) {
      return false;
    }
    const inventory = player.getInventory?.();
    const supplierInv = supplier.getInventory?.();
    if (!inventory || !supplierInv) {
      return false;
    }
    const want = Math.max(0, restockTarget - stockCount(player, wareId));
    if (want <= 0) {
      return true;
    }
    const affordable = Math.floor(coinCount(player) / wholesalePrice);
    const available = supplierInv.getAmount?.(wareId) ?? 0;
    const qty = Math.min(want, affordable, available);
    if (qty <= 0) {
      return false;
    }
    const cost = qty * wholesalePrice;
    inventory.deleteNumber(COINS, cost);
    supplierInv.adds(COINS, cost);
    supplierInv.deleteNumber(wareId, qty);
    inventory.adds(wareId, qty);
    addMood(supplier, 3); // the wholesaler likes getting paid
    if (stockCount(player, wareId) >= restockThreshold) {
      state.lowStockAnnounced = false; // shelves full again — may complain anew later
    }
    say(player, DEAL_LINES[Math.floor(state.rng() * DEAL_LINES.length)]);
    world?.log?.("citizen_prime_wholesale", {
      merchant: player.getUsername?.(),
      supplier: supplier.getUsername?.(),
      ware: wareId,
      qty,
      cost,
    });
    return true;
  }

  const action = {
    id: "primeMerchant",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!Number.isInteger(wareId)) {
        return "failed";
      }
      const state = botState(player);
      const kingdomId = kingdomIdOf(player);
      const atWar = isKingdomAtWar(kingdomId);
      const stall = siteTile(player, "market");
      if (!stall) {
        return "failed";
      }

      // War alert: pack up and go home until it lifts.
      if (atWar && state.phase !== PHASE_CLOSED) {
        state.phase = PHASE_CLOSED;
        state.announcedClose = false;
      } else if (!atWar && state.phase === PHASE_CLOSED) {
        state.phase = PHASE_TO_STALL;
      }

      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }

      // Outside stall hours the director switches activities; idle at the
      // tavern if this action ever runs past hours anyway.
      const hour = hourNow();
      if ((hour < OPEN_HOUR || hour >= CLOSE_HOUR) && state.phase !== PHASE_CLOSED) {
        const tavern = siteTile(player, "tavern");
        if (tavern && !atTile(player, tavern, 4)) {
          walkTo(player, tavern, 4);
        }
        return "running";
      }

      switch (state.phase) {
        case PHASE_STALL: {
          if (!atTile(player, stall)) {
            walkTo(player, stall);
            return "running";
          }
          if (!state.announcedOpen) {
            state.announcedOpen = true;
            say(player, "Open for business — fine bronze swords!");
          }
          advertise(player, state, nowMs);
          sellTick(player, state, nowMs);
          if (stockCount(player, wareId) < restockThreshold) {
            if (!state.lowStockAnnounced) {
              state.lowStockAnnounced = true;
              state.nextWholesaleAt = nowMs + WHOLESALE_RETRY_MS;
              say(
                player,
                LOW_STOCK_LINES[Math.floor(state.rng() * LOW_STOCK_LINES.length)]
              );
              state.phase = PHASE_TO_SUPPLIER;
            } else if (nowMs >= state.nextWholesaleAt) {
              // Still dry — walk the supply run again (and say so).
              state.nextWholesaleAt = nowMs + WHOLESALE_RETRY_MS;
              state.lowStockAnnounced = false;
              state.phase = PHASE_TO_SUPPLIER;
            }
          }
          return "running";
        }
        case PHASE_TO_SUPPLIER: {
          const supplier = findLocalCitizen(player, isMySupplier(player, kingdomId));
          if (!supplier) {
            // Nowhere to buy from — say so (throttled), then try again later.
            if (nowMs >= state.nextWholesaleAt) {
              state.nextWholesaleAt = nowMs + WHOLESALE_RETRY_MS;
              say(
                player,
                NO_SUPPLIER_LINES[Math.floor(state.rng() * NO_SUPPLIER_LINES.length)]
              );
            }
            return "running";
          }
          let supplierLoc = null;
          try {
            supplierLoc = supplier.getLocation?.();
          } catch (error) {
            return "running";
          }
          if (!supplierLoc) {
            return "running";
          }
          const tile = {
            x: supplierLoc.getX(),
            y: supplierLoc.getY(),
            z: supplierLoc.getZ(),
          };
          if (!atTile(player, tile, 3)) {
            walkTo(player, tile, 3);
            return "running";
          }
          state.phase = PHASE_WHOLESALE;
          return "running";
        }
        case PHASE_WHOLESALE: {
          if (wholesale(player, state)) {
            state.phase = PHASE_TO_STALL;
          } else if (nowMs >= state.nextWholesaleAt) {
            // Supplier's dry or the purse is light — say so, retry later.
            state.nextWholesaleAt = nowMs + WHOLESALE_RETRY_MS;
            say(
              player,
              NO_SUPPLIER_LINES[Math.floor(state.rng() * NO_SUPPLIER_LINES.length)]
            );
            state.phase = PHASE_TO_STALL;
          }
          return "running";
        }
        case PHASE_TO_STALL: {
          if (atTile(player, stall)) {
            state.phase = PHASE_STALL;
            state.nextAdAt = nowMs + logNormalJitter(state.rng, 60000, 0.8);
            state.nextSaleAt = nowMs + logNormalJitter(state.rng, 120000, 0.8);
            return "running";
          }
          walkTo(player, stall);
          return "running";
        }
        case PHASE_CLOSED: {
          const home = ctx.state?.home;
          if (!state.announcedClose) {
            state.announcedClose = true;
            say(player, "War! Stall's closed — stay safe, all of you.");
          }
          if (home && !atTile(player, home, 4)) {
            walkTo(player, home, 4);
          }
          return "running";
        }
        default:
          state.phase = PHASE_STALL;
          return "running";
      }
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
  createPrimeMerchantAction,
};
