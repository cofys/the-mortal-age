"use strict";

/**
 * SurplusManifest — shared data model for Phase 4 resource flows.
 *
 * Phases 1-3 put real gathered goods into citizen banks (mining,
 * woodcutting, fishing, herbs, farming). Phase 4 moves them on:
 *   - CitizenSurplusSales: banked surplus -> needs-driven peer citizens
 *     (verified coin-for-goods trades at Prices.Economy reference prices)
 *   - CitizenWarContributions: wartime war-supply surplus -> the
 *     kingdom quartermaster (OfficeTools.deliverSupplies: real items to
 *     real war stock, treasury pays real coins)
 *
 * Everything here is data tier, zero LLM, zero hash-fiction. Every
 * movement is a REAL inventory operation — items and coins are verified
 * before/after, nothing is minted, nothing vanishes.
 *
 * EXPORT-READY DATA MODEL (intra-kingdom now, caravans later):
 *   - every movement is recorded in the manifest with originKingdom
 *   - WarSupply.addStock tags credited war stock with origins per
 *     contributing kingdom
 * An inter-kingdom export flow plugs in by reading manifest.recent() /
 * category.origins and routing goods across a border; nothing in phase 4
 * invents the caravan itself (Jon's call, separate design).
 */

// Item ids verified against server/data/definitions/item-gameplay.json.
const GATHERED_GOODS = {
  // --- food: raw fish ---
  317: { cat: "food", name: "Raw shrimps" },
  321: { cat: "food", name: "Raw anchovies" },
  327: { cat: "food", name: "Raw sardine" },
  335: { cat: "food", name: "Raw trout" },
  345: { cat: "food", name: "Raw herring" },
  353: { cat: "food", name: "Raw mackerel" },
  359: { cat: "food", name: "Raw tuna" },
  363: { cat: "food", name: "Raw bass" },
  371: { cat: "food", name: "Raw swordfish" },
  377: { cat: "food", name: "Raw lobster" },
  331: { cat: "food", name: "Raw salmon" },
  383: { cat: "food", name: "Raw shark" },
  389: { cat: "food", name: "Raw manta ray" },
  3142: { cat: "food", name: "Raw karambwan" },
  // --- food: cooked fish ---
  315: { cat: "food", name: "Shrimps" },
  319: { cat: "food", name: "Anchovies" },
  333: { cat: "food", name: "Trout" },
  351: { cat: "food", name: "Pike" },
  355: { cat: "food", name: "Mackerel" },
  361: { cat: "food", name: "Tuna" },
  365: { cat: "food", name: "Bass" },
  373: { cat: "food", name: "Swordfish" },
  379: { cat: "food", name: "Lobster" },
  385: { cat: "food", name: "Shark" },
  // --- food: farm produce ---
  1942: { cat: "food", name: "Potato" },
  1957: { cat: "food", name: "Onion" },
  1965: { cat: "food", name: "Cabbage" },
  1982: { cat: "food", name: "Tomato" },
  5982: { cat: "food", name: "Watermelon" },
  // --- food: war-grade provisions (also quartermaster-eligible) ---
  2309: { cat: "food", name: "Bread" },
  2142: { cat: "food", name: "Cooked meat" },
  2140: { cat: "food", name: "Cooked chicken" },
  // --- timber ---
  1511: { cat: "timber", name: "Logs" },
  1521: { cat: "timber", name: "Oak logs" },
  1519: { cat: "timber", name: "Willow logs" },
  1517: { cat: "timber", name: "Maple logs" },
  1515: { cat: "timber", name: "Yew logs" },
  1513: { cat: "timber", name: "Magic logs" },
  6332: { cat: "timber", name: "Mahogany logs" },
  6333: { cat: "timber", name: "Teak logs" },
  // --- ore ---
  436: { cat: "ore", name: "Copper ore" },
  438: { cat: "ore", name: "Tin ore" },
  440: { cat: "ore", name: "Iron ore" },
  442: { cat: "ore", name: "Silver ore" },
  444: { cat: "ore", name: "Gold ore" },
  447: { cat: "ore", name: "Mithril ore" },
  449: { cat: "ore", name: "Adamantite ore" },
  451: { cat: "ore", name: "Runite ore" },
  453: { cat: "ore", name: "Coal" },
  // --- herbs ---
  199: { cat: "herb", name: "Grimy guam leaf" },
  201: { cat: "herb", name: "Grimy marrentill" },
  203: { cat: "herb", name: "Grimy tarromin" },
  205: { cat: "herb", name: "Grimy harralander" },
  207: { cat: "herb", name: "Grimy ranarr weed" },
  209: { cat: "herb", name: "Grimy irit leaf" },
  211: { cat: "herb", name: "Grimy avantoe" },
  213: { cat: "herb", name: "Grimy kwuarm" },
  215: { cat: "herb", name: "Grimy cadantine" },
  217: { cat: "herb", name: "Grimy dwarf weed" },
  219: { cat: "herb", name: "Grimy torstol" },
  2481: { cat: "herb", name: "Lantadyme" },
  3049: { cat: "herb", name: "Grimy toadflax" },
};

/** Personal need stays home: citizens never sell below this banked reserve. */
const RESERVE = { food: 12, timber: 8, ore: 6, herb: 4 };

const COINS_ID = 995;

function gatheredInfo(itemId) {
  return GATHERED_GOODS[itemId] ?? null;
}

/** Banked count above the personal reserve = what may move. */
function surplusOf(banked, itemId) {
  const info = gatheredInfo(itemId);
  if (!info) return 0;
  return Math.max(0, banked - (RESERVE[info.cat] ?? 0));
}

// --- war-supply eligibility -------------------------------------------------
// Mirrors WarSupply.WAR_SUPPLY_ITEMS + OfficeTools.SUPPLY_ITEMS by id.
// Loaded live when the kingdoms plugin is present; the static fallback
// keeps the tick alive (and the tests engine-free) when it isn't.

const STATIC_WAR_SUPPLY_IDS = new Set([
  2309, 2142, 2140, // provisions
  882, 884, 886, 888, 890, 892, // arrows
  556, 555, 557, 554, 562, 563, 560, 565, // runes
  1511, 1521, // timber
  2351, 2353, 2359, // bars
]);

let warSupplyIds = null;
function warSupplyIdSet() {
  if (warSupplyIds) return warSupplyIds;
  const ids = new Set(STATIC_WAR_SUPPLY_IDS);
  try {
    const WarSupply = require("../../kingdoms/WarSupply.Kingdoms");
    for (const id of Object.keys(WarSupply.WAR_SUPPLY_ITEMS ?? {})) ids.add(Number(id));
  } catch {
    // Static set stands.
  }
  try {
    const OfficeTools = require("../../kingdoms/OfficeTools.Kingdoms");
    for (const id of Object.keys(OfficeTools.SUPPLY_ITEMS ?? {})) ids.add(Number(id));
  } catch {
    // Static set stands.
  }
  warSupplyIds = ids;
  return ids;
}

/** True when the quartermaster would accept this item for the war effort. */
function isWarSupplyItem(itemId) {
  return warSupplySpec(itemId) !== null;
}

// Static mirror of WarSupply.WAR_SUPPLY_ITEMS + OfficeTools.SUPPLY_ITEMS
// (units verified against WarSupply.Kingdoms.js): fallback when the
// kingdoms plugin isn't loaded, e.g. plain-node tests.
const STATIC_WAR_SUPPLY_SPECS = {
  2309: { units: 2, cat: "food" },
  2142: { units: 3, cat: "food" },
  2140: { units: 2, cat: "food" },
  882: { units: 2, cat: "arrows" },
  884: { units: 3, cat: "arrows" },
  886: { units: 5, cat: "arrows" },
  888: { units: 8, cat: "arrows" },
  890: { units: 12, cat: "arrows" },
  892: { units: 18, cat: "arrows" },
  556: { units: 2, cat: "runes" },
  555: { units: 2, cat: "runes" },
  557: { units: 2, cat: "runes" },
  554: { units: 2, cat: "runes" },
  562: { units: 6, cat: "runes" },
  563: { units: 8, cat: "runes" },
  560: { units: 10, cat: "runes" },
  565: { units: 12, cat: "runes" },
  1511: { units: 4, cat: "materials" },
  1521: { units: 6, cat: "materials" },
  2351: { units: 6, cat: "materials" },
  2353: { units: 10, cat: "materials" },
  2359: { units: 16, cat: "materials" },
};

/**
 * The war-supply spec for an item ({ units, cat }) or null when the
 * quartermaster doesn't buy it. Live from the kingdoms plugin when
 * loaded, static mirror otherwise.
 */
function warSupplySpec(itemId) {
  const id = Number(itemId);
  try {
    const WarSupply = require("../../kingdoms/WarSupply.Kingdoms");
    const live = WarSupply.WAR_SUPPLY_ITEMS?.[id];
    if (live) return { units: live.units, cat: live.cat };
  } catch {
    // Fall through.
  }
  try {
    const OfficeTools = require("../../kingdoms/OfficeTools.Kingdoms");
    const order = OfficeTools.SUPPLY_ITEMS?.[id];
    if (order) return { units: order.units, cat: "food" };
  } catch {
    // Fall through.
  }
  return STATIC_WAR_SUPPLY_SPECS[id] ?? null;
}

// --- bank access ------------------------------------------------------------
// Pure inventory ops on the bank containers (Bank extends ItemContainer, so
// getAmount/deleteNumber/adds all work): no engine-class requires in the
// plugin layer (server/AGENTS.md), and every move is verified before/after
// like the sellItems vanishing-coins contract.

const BANK_TABS = 11; // Bank.TOTAL_BANK_TABS; getBank returns null past the end anyway

function bankTotal(player, itemId) {
  let total = 0;
  try {
    for (let tab = 0; tab < BANK_TABS; tab++) {
      const bank = player.getBank?.(tab);
      if (!bank) continue;
      total += bank.getAmount?.(itemId) ?? 0;
    }
  } catch {
    // Bank unavailable — treat as empty.
  }
  return total;
}

/**
 * Withdraw qty of itemId from the citizen's bank into their pack.
 * Verified: returns the count that actually landed in the pack; the bank
 * debit is checked against the bank's own amount, so a failed withdrawal
 * never fabricates items. Never touches the engine Bank class — bank
 * containers are ItemContainers, so deleteNumber/adds suffice for a
 * background (UI-closed) withdrawal.
 */
function withdrawFromBank(player, itemId, qty, opts = {}) {
  const want = Math.max(0, Math.floor(qty));
  if (want <= 0) return 0;
  const inventory = player?.getInventory?.();
  if (!inventory) return 0;
  const stackable = isStackable(itemId);
  let withdrawn = 0;
  let guard = 0;
  try {
    for (let tab = 0; tab < BANK_TABS && withdrawn < want && guard++ < 40; tab++) {
      const bank = player.getBank?.(tab);
      if (!bank) continue;
      let take = Math.min(want - withdrawn, bank.getAmount?.(itemId) ?? 0);
      if (take <= 0) continue;
      if (!stackable) {
        const free = freeSlots(inventory);
        if (free <= 0) break;
        take = Math.min(take, free);
      } else if ((inventory.getAmount?.(itemId) ?? 0) === 0 && freeSlots(inventory) <= 0) {
        break; // no room for even the stack's first slot
      }
      const bankBefore = bank.getAmount?.(itemId) ?? 0;
      const invBefore = inventory.getAmount?.(itemId) ?? 0;
      try {
        bank.deleteNumber?.(itemId, take);
        inventory.adds?.(itemId, take);
      } catch {
        // The credit threw mid-move: restore the debit, nothing fabricated.
        try {
          bank.adds?.(itemId, take);
        } catch {
          // Best-effort restore.
        }
        break;
      }
      const bankAfter = bank.getAmount?.(itemId) ?? 0;
      const invAfter = inventory.getAmount?.(itemId) ?? 0;
      const debited = bankBefore - bankAfter;
      const landed = invAfter - invBefore;
      const moved = Math.max(0, Math.min(debited, landed, take));
      if (moved <= 0) {
        // Roll the partial back: the bank keeps whatever didn't land.
        try {
          if (debited > landed) bank.adds?.(itemId, debited - Math.max(0, landed));
        } catch {
          // Best-effort restore.
        }
        break;
      }
      withdrawn += moved;
      if (moved < take) break; // container capped the move — stop
    }
  } catch {
    // Engine hiccup — the caller sees only what verified.
  }
  return withdrawn;
}

/** Gathered goods are stackable except timber and ore. */
function isStackable(itemId) {
  const cat = gatheredInfo(itemId)?.cat;
  return cat === "food" || cat === "herb";
}

function freeSlots(inventory) {
  try {
    const free = inventory.getFreeSlots?.();
    if (Number.isFinite(free)) return free;
  } catch {
    // Fall through.
  }
  return 27; // unknown container — assume roomy, verification still guards
}

// --- pricing ----------------------------------------------------------------

function referencePrice(itemId) {
  try {
    const { getReferencePrice } = require("../../economy/Prices.Economy");
    const price = getReferencePrice(itemId, Date.now());
    if (Number.isFinite(price) && price >= 1) return Math.floor(price);
  } catch {
    // Economy feed unavailable — floor price, never zero (no free goods).
  }
  return 1;
}

// --- journal ----------------------------------------------------------------

function journalTrade(player, text) {
  try {
    require("../lib/CitizenJournal").getJournal()?.log?.(player.getUsername?.(), "trade", text);
  } catch {
    // Journaling never blocks a trade.
  }
}

// --- the manifest -----------------------------------------------------------
// Every phase-4 movement, origin-tagged. In-memory ring buffer; the reader
// is what an inter-kingdom export flow will query. The war stock itself
// carries per-kingdom origins via WarSupply.addStock's origin param.

const MANIFEST_CAP = 500;
const movements = [];

function recordMovement(entry) {
  if (!entry || !Number.isFinite(entry.itemId) || !(entry.qty > 0)) return;
  movements.push({
    ts: Date.now(),
    kind: entry.kind, // 'peer-sale' | 'war-delivery'
    itemId: Math.floor(entry.itemId),
    qty: Math.floor(entry.qty),
    originKingdom: entry.originKingdom ?? null,
    seller: entry.seller ?? null,
    buyer: entry.buyer ?? null, // citizen name or 'quartermaster:<kingdom>'
    coins: Math.max(0, Math.floor(entry.coins ?? 0)),
    units: Math.max(0, Math.floor(entry.units ?? 0)),
  });
  if (movements.length > MANIFEST_CAP) movements.splice(0, movements.length - MANIFEST_CAP);
}

function recentMovements(n = 50) {
  return movements.slice(-Math.max(1, n));
}

function _resetManifest() {
  movements.length = 0;
  warSupplyIds = null;
}

module.exports = {
  GATHERED_GOODS,
  RESERVE,
  COINS_ID,
  gatheredInfo,
  surplusOf,
  isWarSupplyItem,
  warSupplySpec,
  bankTotal,
  withdrawFromBank,
  referencePrice,
  journalTrade,
  recordMovement,
  recentMovements,
  // test seams
  _resetManifest,
  _STATIC_WAR_SUPPLY_IDS: STATIC_WAR_SUPPLY_IDS,
};
