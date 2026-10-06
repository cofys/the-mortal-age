"use strict";

/**
 * Merchant — the merchant's body. Tends a stall at the kingdom market:
 * advertises wares on log-normal intervals, "sells" to passers-by (ware out,
 * coins in — real inventory ops), and walks to the bank to restock when the
 * stock runs low. On a kingdom war alert the merchant packs up and goes home
 * until the alert lifts.
 *
 * This is a behavioural merchant, not a shop interface: the economy loop is
 * real (items move, coins accumulate toward the save_gold goal) while the
 * customer side stays abstract. A future shop-front can replace sellTick.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { Bank } = require("../../../../src/main/typescript/elvarg/game/model/container/impl/Bank");
const { Item } = require("../../../../src/main/typescript/elvarg/game/model/Item");
const { ItemIds } = require("../../../../src/main/typescript/elvarg/util/IdEnums");
const { isKingdomAtWar } = require("../../CitizenEvents");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");

const COINS = 995; // ItemIds.COINS, verified in ItemIdentifiers.ts

const PHASE_STALL = "stall";
const PHASE_TO_BANK = "toBank";
const PHASE_RESTOCK = "restock";
const PHASE_TO_STALL = "toStall";
const PHASE_CLOSED = "closed";

const ARRIVE_RADIUS = 2;

const AD_LINES = Object.freeze([
  "Fresh bread! Warm from the oven!",
  "Bread, bread! Best in the city, only twelve coins!",
  "Hungry, friend? You look hungry.",
  "Come see, come see — fresh loaves!",
  "Bread for the road, bread for the table!",
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

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function walkTo(player, tile) {
  const noisy = noisyTile(tile.x, tile.y, ARRIVE_RADIUS, null);
  requestMovement(player, noisy.x, noisy.y, {
    reason: "citizen_merchant",
    basicPather: true,
    z: tile.z ?? 0,
  });
}

/** Pull wares from the bank into the inventory, mirroring Bank.js. */
function restockFromBank(player, wareId, want) {
  const inventory = player.getInventory();
  let remaining = Math.max(0, want - inventory.getAmount(wareId));
  if (remaining <= 0) {
    return true;
  }
  let guard = 0;
  let withdrew = false;
  while (remaining > 0 && guard++ < 40) {
    let took = false;
    for (let tab = 0; tab < Bank.TOTAL_BANK_TABS - 1; tab++) {
      const bank = player.getBank(tab);
      if (!bank) {
        continue;
      }
      const slot = bank.getSlotForItemId?.(wareId) ?? -1;
      if (slot < 0) {
        continue;
      }
      const stack = bank.getItems()[slot];
      if (!stack || stack.getId() !== wareId) {
        continue;
      }
      const take = Math.min(remaining, stack.getAmount());
      Bank.withdraw(player, wareId, slot, take, tab);
      remaining -= take;
      took = true;
      withdrew = true;
      if (remaining <= 0) {
        break;
      }
    }
    if (!took) {
      break;
    }
  }
  return withdrew;
}

function createMerchantAction(spec, world) {
  const wareId = resolveWareId(spec.wareItem ?? "BREAD");
  const pricePerWare = Math.max(1, Math.floor(Number(spec.pricePerWare ?? 12)));
  const restockThreshold = Math.max(1, Math.floor(Number(spec.restockThreshold ?? 6)));
  const adMinMs = Math.max(1000, Number(spec.adIntervalMinMs ?? 180000));
  const adMaxMs = Math.max(adMinMs, Number(spec.adIntervalMaxMs ?? 420000));

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`merchant:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        phase: PHASE_STALL,
        nextAdAt: 0,
        nextSaleAt: 0,
        restockPauseUntil: 0,
        announcedClose: false,
      };
    });
  }

  function say(player, state, line) {
    try {
      player.forceChat?.(line);
    } catch (error) {
      // Cosmetic only.
    }
    void state;
  }

  /** One abstract sale: a ware leaves, coins arrive. Real inventory ops. */
  function sellTick(player, state, nowMs) {
    if (nowMs < state.nextSaleAt) {
      return;
    }
    // Sales bunch up when people are around — scale by local crowd.
    const crowd = (player.getLocalPlayers?.() ?? []).length;
    const baseGap = crowd > 3 ? 90000 : 240000;
    state.nextSaleAt =
      nowMs + logNormalJitter(state.rng, baseGap, state.human.tempoSigma);
    const inventory = player.getInventory();
    if (!inventory || inventory.getAmount(wareId) <= 0) {
      return;
    }
    // Passers-by buy 1-3 loaves at a time.
    const bought = Math.min(inventory.getAmount(wareId), 1 + Math.floor(state.rng() * 3));
    inventory.deleteNumber(wareId, bought);
    try {
      inventory.add(new Item(COINS, bought * pricePerWare), true);
    } catch (error) {
      // If the add fails, the sale still happened — log, don't crash.
      world?.log?.("citizen_merchant_sale_failed", {
        merchant: player.getUsername?.(),
        error: String(error?.message ?? error),
      });
      return;
    }
    world?.log?.("citizen_merchant_sale", {
      merchant: player.getUsername?.(),
      ware: wareId,
      sold: bought,
      coins: coinCount(player),
    });
  }

  function advertise(player, state, nowMs) {
    if (nowMs < state.nextAdAt) {
      return;
    }
    const gap =
      adMinMs + state.rng() * (adMaxMs - adMinMs);
    state.nextAdAt =
      nowMs + Math.round(gap / Math.max(0.2, state.human.chatRate));
    if (!chance(state.rng, 0.75)) {
      return; // Sometimes they just tend the stall quietly.
    }
    say(
      player,
      state,
      AD_LINES[Math.floor(state.rng() * AD_LINES.length)]
    );
  }

  const action = {
    id: "merchant",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!Number.isInteger(wareId)) {
        return "failed";
      }
      const state = botState(player);
      const kingdomId = kingdomIdOf(player);
      const atWar = isKingdomAtWar(kingdomId);
      const stall = siteTile(player, "market");
      const bank = siteTile(player, "bank");
      if (!stall || !bank) {
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

      switch (state.phase) {
        case PHASE_STALL: {
          if (!atTile(player, stall)) {
            walkTo(player, stall);
            return "running";
          }
          advertise(player, state, nowMs);
          sellTick(player, state, nowMs);
          if (stockCount(player, wareId) < restockThreshold) {
            state.phase = PHASE_TO_BANK;
          }
          return "running";
        }
        case PHASE_TO_BANK: {
          if (atTile(player, bank)) {
            state.phase = PHASE_RESTOCK;
            state.restockPauseUntil =
              nowMs + logNormalJitter(state.rng, 4000, state.human.tempoSigma);
            return "running";
          }
          walkTo(player, bank);
          return "running";
        }
        case PHASE_RESTOCK: {
          if (nowMs < state.restockPauseUntil) {
            return "running"; // Queueing at the booth like everyone else.
          }
          const got = restockFromBank(player, wareId, 28);
          world?.log?.("citizen_merchant_restock", {
            merchant: player.getUsername?.(),
            ware: wareId,
            restocked: got,
            stock: stockCount(player, wareId),
          });
          if (!got && stockCount(player, wareId) <= 0) {
            // Bank's empty: wait a while, then try again. The stall stays shut.
            state.restockPauseUntil = nowMs + 10 * 60 * 1000;
            return "running";
          }
          state.phase = PHASE_TO_STALL;
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
          // Head home and wait out the war.
          const home = ctx.state?.home;
          if (!state.announcedClose) {
            state.announcedClose = true;
            say(player, state, "War! Stall's closed — stay safe, all of you.");
          }
          if (home && !atTile(player, home, 4)) {
            walkTo(player, home);
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
  createMerchantAction,
};
