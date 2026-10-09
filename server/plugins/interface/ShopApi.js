"use strict";

/**
 * ShopApi — HTTP data layer for the web client's marketplace overlay.
 *
 * The marketplace overlay (client/game/plugins/shop/ShopOverlay) is the
 * visual trading UI for player-owned market stalls: browsing every open
 * stall, managing your own (stock, prices, till, employee), and buying.
 * It polls this endpoint the same way the examine overlay polls
 * /api/examine-status.
 *
 *   GET /api/shop-status?player=<username>
 *     -> { open: false } | { open: true, view, ... }
 *
 * View switching:
 *   ...&view=board                      all stalls + lease options
 *   ...&view=manage                     your own stall
 *   ...&view=browse&owner=<name>        another player's stall
 *   ...&action=close                    dismiss the overlay
 *
 * Mutations (applied as the requesting player, before the payload builds):
 *   ...&do=stock&item=<id>&qty=<n>
 *   ...&do=unstock&item=<id>&qty=<n>
 *   ...&do=price&item=<id>&price=<n>
 *   ...&do=buy&owner=<name>&item=<id>&qty=<n>
 *   ...&do=collect&amount=<n>
 *   ...&do=claim
 *   ...&do=lease&kingdom=<id>
 *   ...&do=fire
 *   ...&do=hire&name=<name>
 *   ...&do=close-stall
 *
 * Every mutation delegates to PlayerShops (the ::shop logic) — the overlay
 * is a visual skin over the same store, never a parallel implementation.
 * A short `notice` string comes back with the payload for user feedback.
 */

const Store = require("../citizens/shop/PlayerShopStore");
const PlayerShops = require("../citizens/shop/PlayerShops");
const KingdomStore = require("../kingdoms/KingdomStore");
const ContentApiAuth = require("./ContentApiAuth");

const OVERLAY_OPEN_ATTRIBUTE = "shop:overlay-open";
const COINS = 995;

let pluginApi = null;

function findPlayer(username) {
  const name = String(username ?? "").trim();
  if (!name) return null;
  try {
    const player = pluginApi.core.World.getPlayerByName(name) || null;
    if (player?.isPlayerBot?.() === true) return null;
    return player;
  } catch {
    return null;
  }
}

function readOverlayState(player) {
  try {
    const raw = String(player.getAttribute(OVERLAY_OPEN_ATTRIBUTE) || "").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function itemName(itemId) {
  try {
    return (
      pluginApi.core.ItemDefinition.forId(itemId)?.getName?.() ?? `Item ${itemId}`
    );
  } catch {
    return `Item ${itemId}`;
  }
}

/** Aggregate the player's inventory into [{ id, name, qty }] (coins excluded). */
function inventoryOf(player) {
  const out = [];
  try {
    const items = player.getInventory?.()?.getItems?.() ?? [];
    const byId = new Map();
    for (const entry of items) {
      const id = Number(entry?.getId?.() ?? entry?.id ?? 0);
      const qty = Math.floor(Number(entry?.getAmount?.() ?? entry?.amount ?? 0));
      if (!(id > 0) || id === COINS || !(qty > 0)) continue;
      byId.set(id, (byId.get(id) ?? 0) + qty);
    }
    for (const [id, qty] of byId) {
      out.push({ id, name: itemName(id), qty });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // Inventory unreadable — the stock section stays empty.
  }
  return out;
}

function waresOf(stall) {
  const out = [];
  try {
    for (const key of Object.keys(stall?.stock ?? {})) {
      const id = Number(key);
      if (!(id > 0)) continue;
      out.push({
        id,
        name: itemName(id),
        stock: Math.max(0, Math.floor(stall.stock[key] ?? 0)),
        price: Math.max(0, Math.floor(stall.prices?.[key] ?? 0)),
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // Unreadable stock — no wares listed.
  }
  return out;
}

function stallSummary(stall) {
  if (!stall) return null;
  const { weeklyRent } = Store.stallCosts(stall.kingdomId);
  return {
    owner: stall.owner,
    kingdomId: stall.kingdomId,
    kingdomName: PlayerShops.kingdomName(stall.kingdomId),
    till: Math.max(0, Math.floor(stall.till ?? 0)),
    employee: stall.employee ?? null,
    weeklyRent,
    rentDebt: Math.max(0, Math.floor(stall.rentDebt ?? 0)),
    dailyWage: Store.DAILY_WAGE,
    taxRate: Store.MARKET_TAX_RATE,
  };
}

function boardPayload(player) {
  const myKey = Store.keyOf(player.getUsername?.() ?? "");
  const myStall = Store.getStall(myKey);
  const stalls = [];
  for (const stall of Store.getAllStalls()) {
    const wares = Object.keys(stall.stock ?? {}).length;
    stalls.push({
      owner: stall.owner,
      kingdomName: PlayerShops.kingdomName(stall.kingdomId),
      wares,
      open: isOpen(stall),
      mine: Store.keyOf(stall.ownerKey) === myKey,
    });
  }
  stalls.sort((a, b) => a.owner.localeCompare(b.owner));
  const kingdoms = [];
  try {
    for (const k of KingdomStore.getKingdoms() ?? []) {
      const { upfront, weeklyRent } = Store.stallCosts(k.id);
      kingdoms.push({ id: k.id, name: k.name ?? k.id, upfront, weeklyRent });
    }
  } catch {
    // Kingdom list unavailable — lease section stays hidden.
  }
  return {
    open: true,
    view: "board",
    hasStall: !!myStall,
    myStall: stallSummary(myStall),
    stalls,
    kingdoms,
  };
}

function isOpen(stall) {
  if (!stall) return false;
  if (stall.employee) return true;
  try {
    return !!pluginApi.core.World.getPlayerByName(stall.owner);
  } catch {
    return false;
  }
}

function managePayload(player) {
  const stall = Store.getStall(Store.keyOf(player.getUsername?.() ?? ""));
  if (!stall) return boardPayload(player);
  return {
    open: true,
    view: "manage",
    stall: stallSummary(stall),
    wares: waresOf(stall),
    inventory: inventoryOf(player),
    sales: Store.getSales(stall.ownerKey),
    returns: Store.peekReturns(stall.ownerKey).map((e) => ({
      id: e.id,
      name: itemName(e.id),
      qty: e.qty,
    })),
    hireCandidates: PlayerShops.hireCandidates(stall),
    maxWares: Store.MAX_WARES,
  };
}

function browsePayload(player, ownerName) {
  const stall = Store.getStall(String(ownerName ?? "").trim());
  if (!stall) {
    const board = boardPayload(player);
    board.notice = "That stall is gone.";
    return board;
  }
  if (!isOpen(stall)) {
    const board = boardPayload(player);
    board.notice = `${stall.owner}'s stall is closed right now.`;
    return board;
  }
  return {
    open: true,
    view: "browse",
    stall: stallSummary(stall),
    wares: waresOf(stall),
  };
}

/** Run one overlay mutation as the player; returns a notice string or null. */
function applyMutation(player, query) {
  const api = pluginApi;
  const doWhat = String(query.get("do") ?? "").trim().toLowerCase();
  if (!doWhat) return null;
  const num = (key) => Math.floor(Number(query.get(key)));
  try {
    switch (doWhat) {
      case "stock": {
        const id = num("item");
        const qty = num("qty");
        if (!(id > 0)) return "Pick something from your inventory to stock.";
        PlayerShops.stockStall(api, player, String(id), qty > 0 ? qty : undefined);
        return null; // stockStall already tells the player what happened
      }
      case "unstock": {
        const id = num("item");
        const qty = num("qty");
        if (!(id > 0)) return "Pick a ware to take back.";
        PlayerShops.unstockStall(api, player, String(id), qty > 0 ? qty : undefined);
        return null;
      }
      case "price": {
        const id = num("item");
        const price = num("price");
        if (!(id > 0) || !(price >= 1)) return "Enter a price of at least 1 coin.";
        PlayerShops.priceStall(api, player, String(id), price);
        return null;
      }
      case "buy": {
        const owner = String(query.get("owner") ?? "").trim();
        const id = num("item");
        const qty = num("qty");
        const stall = Store.getStall(owner);
        if (!stall) return "That stall is gone.";
        if (!(id > 0)) return "Pick something to buy.";
        const result = PlayerShops.executePlayerSale(api, player, stall, id, qty > 0 ? qty : 1);
        return result.message;
      }
      case "collect": {
        PlayerShops.collectTill(api, player, query.get("amount"));
        return null;
      }
      case "claim": {
        PlayerShops.claimReturns(api, player);
        return null;
      }
      case "lease": {
        const kingdom = String(query.get("kingdom") ?? "").trim();
        if (!kingdom) return "Pick a kingdom for your stall.";
        PlayerShops.buyStall(api, player, kingdom);
        return null;
      }
      case "fire": {
        PlayerShops.fireEmployee(api, player);
        return null;
      }
      case "hire": {
        const name = String(query.get("name") ?? "").trim();
        if (!name) return "Pick a citizen to hire.";
        PlayerShops.hireEmployee(api, player, name);
        return null;
      }
      case "close-stall": {
        PlayerShops.closeOwnStall(api, player);
        return null;
      }
      default:
        return null;
    }
  } catch (error) {
    console.warn("[shop-api] mutation failed", {
      do: doWhat,
      player: player.getUsername?.(),
      error: error?.message ?? error,
    });
    return "Something went wrong — try again.";
  }
}

function attach(api) {
  pluginApi = api;
  ContentApiAuth.setPluginApi(api);
  console.info("[shop-api] registering shop-status endpoint");
  api.registerContentEndpoint("shop-status", (query) => {
    // P0 security fix: require per-session token auth instead of trusting ?player=
    const player = ContentApiAuth.requireAuth(query);
    if (!player) return { open: false, error: "unauthorized" };

    const action = String(query.get("action") ?? "").trim().toLowerCase();
    if (action === "close") {
      PlayerShops.closeShopOverlay(player);
      return { open: false };
    }

    // View switching comes before mutations so a fresh view always renders.
    const view = String(query.get("view") ?? "").trim().toLowerCase();
    if (view === "board" || view === "manage" || view === "browse") {
      PlayerShops.openShopOverlay(
        player,
        view,
        view === "browse" ? String(query.get("owner") ?? "").trim() : null
      );
    }

    const notice = applyMutation(player, query);

    const state = readOverlayState(player);
    if (!state) return { open: false };

    let payload;
    if (state.view === "manage") {
      payload = managePayload(player);
    } else if (state.view === "browse") {
      payload = browsePayload(player, state.owner);
    } else {
      payload = boardPayload(player);
    }
    if (notice && !payload.notice) payload.notice = notice;
    return payload;
  });
}

module.exports = { attach, OVERLAY_OPEN_ATTRIBUTE };
