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

const { playerState } = require("../../../bots/brain/ActionState.PlayerBots.js");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/Navigation.PlayerBots.js");
const { Bank } = require("../../../../src/main/typescript/elvarg/game/model/container/impl/Bank");
const { Item } = require("../../../../src/main/typescript/elvarg/game/model/Item");
const { ItemIds } = require("../../../../src/main/typescript/elvarg/util/IdEnums");
const { isKingdomAtWar } = require("../../CitizenEvents");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const {
  ATTR_CITIZEN_PERSONALITY,
  ATTR_WARE_ITEM,
  ATTR_WARE_PRICE,
  ATTR_KINGDOM_ID,
} = require("../../constants");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { getMemory } = require("../../lib/CitizenMemory");
const { addMood } = require("../CitizenNeeds");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");
const { hawkerLine } = require("../../lib/CitizenHawker");
const { sayPublic } = require("../../chat/CitizenSayPublic");

const COINS = 995; // ItemIds.COINS, verified in ItemIdentifiers.ts

const PHASE_STALL = "stall";
const PHASE_TO_BANK = "toBank";
const PHASE_RESTOCK = "restock";
const PHASE_TO_STALL = "toStall";
const PHASE_CLOSED = "closed";

const ARRIVE_RADIUS = 2;

// Kingdom-choice slice phase 1: merchants know their own. Fellows get a warm
// word in their home capital; foreigners get cold-but-neutral curiosity in
// peacetime — never hostility (guards own hostility). Same 5-minute
// per-player cooldown as the guard's home greeting. {capital} fills at speak.
const RECOGNIZE_RADIUS_TILES = 12;
const RECOGNIZE_COOLDOWN_MS = 5 * 60 * 1000;

const MERCHANT_HOME_LINES = Object.freeze({
  plain: Object.freeze([
    "Hail, and welcome back to {capital}.",
    "One of our own! Good to see you.",
    "The {capital} market thanks you for your custom.",
  ]),
  terse: Object.freeze([
    "back in {capital}, eh.",
    "one of ours.",
  ]),
});

const MERCHANT_COLD_LINES = Object.freeze({
  plain: Object.freeze([
    "We don't see many of your kind here.",
    "Mind yourself, outlander.",
    "Trade's trade, friend — but you'll find no warm hearth in {capital}.",
  ]),
  terse: Object.freeze([
    "not many of your kind here.",
    "outlander. mind yourself.",
  ]),
});

// Ad lines live in the pure CitizenHawker module, picked by poolKey + stock tier
// so merchants never hawk wares they don't have (empty shelves => silence).
function poolKeyForWare(wareId) {
  return wareId === ItemIds.BRONZE_SWORD ? "bronze_sword" : "bread";
}

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
  const baseWareId = resolveWareId(spec.wareItem ?? "BREAD");
  const basePrice = Math.max(1, Math.floor(Number(spec.pricePerWare ?? 12)));
  const restockThreshold = Math.max(1, Math.floor(Number(spec.restockThreshold ?? 6)));
  const adMinMs = Math.max(1000, Number(spec.adIntervalMinMs ?? 180000));
  const adMaxMs = Math.max(adMinMs, Number(spec.adIntervalMaxMs ?? 420000));

  /**
   * Per-merchant ware override: the director tags specialist merchants
   * (e.g. the sword supplier) with citizens:ware-item / citizens:ware-price;
   * everyone else sells the spec's default ware.
   */
  function wareFor(player) {
    let wareId = baseWareId;
    let price = basePrice;
    try {
      const attrItem = player.getAttribute?.(ATTR_WARE_ITEM);
      if (attrItem !== undefined && attrItem !== null && attrItem !== "") {
        const id = resolveWareId(attrItem);
        if (Number.isInteger(id)) {
          wareId = id;
        }
      }
      const attrPrice = player.getAttribute?.(ATTR_WARE_PRICE);
      if (Number(attrPrice) > 0) {
        price = Math.floor(Number(attrPrice));
      }
    } catch (error) {
      // Spec defaults.
    }
    return { wareId, price };
  }

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const { wareId, price } = wareFor(player);
      return {
        rng: agentRng(`merchant:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        phase: PHASE_STALL,
        wareId,
        pricePerWare: price,
        nextAdAt: 0,
        nextSaleAt: 0,
        restockPauseUntil: 0,
        announcedClose: false,
        nextRecognizeAt: 0,
        recognizedAt: new Map(), // username -> timestamp (recognition lines)
      };
    });
  }

  function say(player, state, line) {
    try {
      sayPublic(player, line);
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
    const wareId = state.wareId;
    const pricePerWare = state.pricePerWare;
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
    addMood(player, 1); // earning feels good
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
    const poolKey = poolKeyForWare(state.wareId);
    const line = hawkerLine(
      poolKey,
      stockCount(player, state.wareId),
      restockThreshold,
      state.rng
    );
    if (!line) {
      return; // Shelves empty: never advertise wares we don't have.
    }
    say(player, state, line);
  }

  /** Capital display name for {capital} lines; falls back to the kingdom id. */
  function capitalName(kingdomId) {
    try {
      const Store = require("../../../kingdoms/KingdomStore");
      return Store.getKingdom?.(kingdomId)?.capital ?? kingdomId;
    } catch {
      return kingdomId;
    }
  }

  function notorietyOf(username, nowMs) {
    try {
      return getMemory().notoriety(username, nowMs) ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Kingdom-choice slice phase 1: the merchant notices passers-by. Real
   * players only (never bot-to-bot noise); fellow-kingdom players get a warm
   * word, foreigners a cold-but-neutral one — peacetime only, personality-
   * scaled, 5-minute per-player cooldown. Notorious players get silence.
   */
  function maybeRecognize(player, state, nowMs, kingdomId) {
    if (isKingdomAtWar(kingdomId)) {
      return;
    }
    if (nowMs < state.nextRecognizeAt) {
      return;
    }
    state.nextRecognizeAt =
      nowMs + logNormalJitter(state.rng, 30000, state.human.tempoSigma);
    const locals = player.getLocalPlayers?.() ?? [];
    const selfLoc = player.getLocation?.();
    if (!selfLoc) {
      return;
    }
    for (const other of locals) {
      if (typeof other.isPlayerBot === "function" && other.isPlayerBot() === true) {
        continue;
      }
      const username = other.getUsername?.();
      if (!username) {
        continue;
      }
      const otherLoc = other.getLocation?.();
      if (!otherLoc) {
        continue;
      }
      const dist = Math.max(
        Math.abs(selfLoc.getX() - otherLoc.getX()),
        Math.abs(selfLoc.getY() - otherLoc.getY())
      );
      if (dist > RECOGNIZE_RADIUS_TILES) {
        continue;
      }
      if (nowMs - (state.recognizedAt.get(username) ?? 0) < RECOGNIZE_COOLDOWN_MS) {
        continue;
      }
      if (notorietyOf(username, nowMs) >= 0.5) {
        continue;
      }
      if (!chance(state.rng, state.human.chatRate * 0.3)) {
        continue;
      }
      const fellow =
        (other.getAttribute?.(ATTR_KINGDOM_ID) ?? null) === kingdomId;
      const pool = fellow ? MERCHANT_HOME_LINES : MERCHANT_COLD_LINES;
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const line = voiceLine(voiceFor(personality), pool, state.rng)
        .replaceAll("{capital}", capitalName(kingdomId));
      state.recognizedAt.set(username, nowMs);
      say(player, state, line);
      world?.log?.("citizen_merchant_recognize", {
        merchant: player.getUsername?.(),
        recognized: username,
        kingdom: kingdomId,
        fellow,
      });
      return;
    }
  }

  const action = {
    id: "merchant",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      const wareId = state.wareId;
      if (!Number.isInteger(wareId)) {
        return "failed";
      }
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
          maybeRecognize(player, state, nowMs, kingdomId);
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
