"use strict";

/**
 * CitizenCookOffEvents — player-facing cooking circuit: the ::cookoff command.
 *
 * Mirrors the ::athletics / ::stage command pattern (PlayerRights.NONE so
 * every player can use it). Players can list cook-offs, enter them (REAL
 * entry fee from their inventory), invent recipes (REAL ingredients
 * consumed), list/buy recipes (REAL coins), and view rankings.
 * Bots are rejected: citizens compete through the brain, not the command.
 */

const CookOffs = require("./lib/CitizenCookOffs");

const COOKOFF_USAGE =
  "::cookoff [list|enter|recipes [chef]|invent <ing1> <ing2> [ing3...]|discover <source>|sell <recipeId> <price>|buy <recipeId>|rankings]";

const COINS_ID = 995;
const KINGDOM_IDS = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"];

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function isRealPlayer(player) {
  try {
    return player?.isRealPlayer?.() ?? !player?.isBot;
  } catch {
    return true;
  }
}

function say(player, text) {
  try {
    player?.sendMessage?.(text);
  } catch {
    // messaging is best-effort
  }
}

function kingdomOf(player) {
  try {
    const { kingdomIdOf } = require("./lib/../brain/CitizenSites");
    return kingdomIdOf(player) || null;
  } catch {
    return null;
  }
}

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

function cookingLevel(player) {
  try {
    // NOTE: path is ../../src/... (server/src) — the old ../src/... pointed
    // at server/plugins/src, which does not exist, so every player read as
    // Cooking 1 and enter/invent were impossible.
    const Skill = safeRequire("../../src/main/typescript/elvarg/game/model/Skill")?.Skill;
    const mgr = player?.getSkillManager?.();
    if (!mgr || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = Skill ? mgr.getCurrentLevel(Skill.COOKING) : mgr.getCurrentLevel("cooking");
    return Number.isInteger(lvl) && lvl > 0 ? lvl : 1;
  } catch { return 1; }
}

function coinsOf(player) {
  try { return player?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0; } catch { return 0; }
}

function amountIn(inv, id) {
  try { return typeof inv?.getAmount === "function" ? inv.getAmount(id) : 0; } catch { return 0; }
}

function takeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const before = amountIn(inv, COINS_ID);
    if (before < amount) return false;
    // Canonical engine API: ItemContainer.deleteNumber(id, amount).
    // There is no inv.remove(id, amount) — the old call was a silent no-op
    // that still returned true, so purchases/inventions spent nothing.
    if (typeof inv.deleteNumber === "function") inv.deleteNumber(COINS_ID, amount);
    else if (typeof inv.delete === "function") inv.delete(COINS_ID, amount);
    else return false;
    // Honest: the balance must actually have moved, or the fee wasn't taken.
    return amountIn(inv, COINS_ID) === before - amount;
  } catch { return false; }
}

/** Credit a seller honestly: bank account (persists even when offline). */
function creditSeller(sellerName, amount) {
  try {
    const Banking = require("./lib/CitizenBanking");
    const acct = Banking.accountFor?.(sellerName);
    if (!acct) return false;
    acct.balance = (acct.balance ?? 0) + amount;
    Banking.markDirty?.();
    return true;
  } catch { return false; }
}

let _itemTable = null; // lazy cache of the engine item definitions

/**
 * Defensively resolve an ingredient name to a real item id from the engine
 * item definitions (server/data/definitions/item-gameplay.json — a flat
 * array of { id, name }). The old code required table files that do not
 * exist, so EVERY invention failed; and even with a table it only read a
 * keyed { items } map shape. Returns the lowest matching id, or null —
 * the caller refuses honestly rather than inventing an id.
 */
function resolveItemId(name) {
  const key = String(name || "").toLowerCase().trim().replace(/_/g, " ");
  if (!key) return null;
  try {
    if (!_itemTable) {
      const rows = require("../../data/definitions/item-gameplay.json");
      _itemTable = Array.isArray(rows) ? rows : [];
    }
    let best = null;
    for (const row of _itemTable) {
      if (String(row?.name || "").toLowerCase().replace(/_/g, " ") !== key) continue;
      if (best == null || row.id < best) best = row.id;
    }
    return best;
  } catch { return null; }
}

function onCookOffCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens duel through their own kitchens, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kingdomId = kingdomOf(player);
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "list").toLowerCase();

  switch (sub) {
    case "list": {
      const lines = [];
      for (const kid of KINGDOM_IDS) {
        const co = CookOffs.openCookOff(kid);
        if (!co) continue;
        lines.push(`${kid}: mystery ${co.mystery} — ${co.entries.length} chefs, pot ${co.pot}`);
      }
      say(player, lines.length ? lines.join(" | ") : "No cook-offs running. Check back soon!");
      return;
    }
    case "enter": {
      if (!kingdomId) { say(player, "You need to be in a kingdom to enter."); return; }
      const co = CookOffs.openCookOff(kingdomId);
      if (!co) { say(player, "No cook-off running in this kingdom."); return; }
      if (cookingLevel(player) < 25) { say(player, "You need Cooking 25 to enter a cook-off."); return; }
      const ok = CookOffs.enterCookOff(co.id, username, (n, amt) => takeCoins(player, amt), Date.now());
      say(player, ok
        ? `Entered the ${kingdomId} cook-off! Mystery ingredient: ${co.mystery}. Cook your rounds well.`
        : `Could not enter — you need ${CookOffs.ENTRY_FEE} coins.`);
      return;
    }
    case "recipes": {
      const chef = parts.slice(1).join(" ") || username;
      const list = CookOffs.recipesByChef(chef).slice(0, 10);
      if (!list.length) { say(player, `No recipes for ${chef} yet.`); return; }
      say(player, list.map((r) =>
        `${r.id} "${r.name}" (q${r.quality}, ${r.source}${r.listPrice > 0 ? `, ${r.listPrice}c` : ""})`
      ).join(" | "));
      return;
    }
    case "invent": {
      const ings = parts.slice(1).map((s) => s.toLowerCase());
      if (ings.length < 2 || ings.length > 5) {
        say(player, "Usage: ::cookoff invent <ingredient1> <ingredient2> [ingredient3...] (2-5 ingredients)");
        return;
      }
      const lvl = cookingLevel(player);
      if (lvl < 25) { say(player, "You need Cooking 25 to invent recipes."); return; }
      const inv = player?.getInventory?.();
      if (!inv) { say(player, "No inventory — cannot invent."); return; }
      // Pre-validate ALL ingredients before consuming any: inventRecipe does
      // not roll back, so a late failure would otherwise eat the early ones.
      for (const ing of ings) {
        const id = resolveItemId(ing);
        if (id == null || (inv.getAmount?.(id) ?? 0) < 1) {
          say(player, "Invention failed — you need one of each ingredient in your inventory.");
          return;
        }
      }
      const consume = (chef, ingName) => {
        const id = resolveItemId(ingName);
        if (id == null) return false;
        try {
          // Canonical engine API: ItemContainer.deleteNumber(id, amount).
          // inv.remove(id, 1) was a silent no-op — inventions were free.
          const before = (inv.getAmount?.(id) ?? 0);
          if (before < 1) return false;
          if (typeof inv.deleteNumber === "function") inv.deleteNumber(id, 1);
          else if (typeof inv.delete === "function") inv.delete(id, 1);
          else return false;
          return (inv.getAmount?.(id) ?? 0) === before - 1;
        } catch { return false; }
      };
      const r = CookOffs.inventRecipe(username, null, ings, lvl, consume, Date.now());
      say(player, r
        ? `Invented "${r.name}"! Quality ${r.quality}/10.`
        : "Invention failed — you need one of each ingredient in your inventory.");
      return;
    }
    case "discover": {
      const source = parts.slice(1).join(" ");
      if (!source) { say(player, "Usage: ::cookoff discover <where you found it>"); return; }
      const r = CookOffs.discoverRecipe(username, source, Date.now());
      say(player, r
        ? `Recorded "${r.name}"! Quality ${r.quality}/10.`
        : "Could not record that discovery.");
      return;
    }
    case "sell": {
      const [recipeId, price] = [parts[1], parts[2]];
      if (!recipeId || !price) { say(player, "Usage: ::cookoff sell <recipeId> <price>"); return; }
      const r = CookOffs.recipeById(recipeId);
      if (!r || r.inventor !== username) { say(player, "That's not your recipe."); return; }
      say(player, CookOffs.listRecipe(recipeId, price)
        ? `Listed "${r.name}" for ${price} coins.`
        : "Could not list that recipe.");
      return;
    }
    case "buy": {
      const recipeId = parts[1];
      if (!recipeId) { say(player, "Usage: ::cookoff buy <recipeId>"); return; }
      const r = CookOffs.recipeById(recipeId);
      if (!r) { say(player, "No such recipe."); return; }
      const ok = CookOffs.buyListedRecipe(recipeId, username,
        (n, amt) => takeCoins(player, amt),
        (seller, amt) => creditSeller(seller, amt),
        // Refund best-effort: canonical adds(id, amount); add(id, amount) was the wrong overload.
        (n, amt) => { try { player?.getInventory?.()?.adds?.(COINS_ID, amt); } catch { /* refund best-effort */ } });
      say(player, ok ? `You bought "${r.name}" for ${r.soldFor} coins!` : "Purchase failed — check the price and your coins.");
      return;
    }
    case "rankings": {
      const season = CookOffs.seasonOf(Date.now());
      const lines = [];
      for (const kid of KINGDOM_IDS) {
        const ranks = CookOffs.rankingsFor(kid, season, 3);
        if (ranks.length) lines.push(`${kid}: ${ranks.map((r) => `${r.name} (${r.points})`).join(", ")}`);
      }
      say(player, lines.length ? lines.join(" | ") : "No rankings this season yet.");
      return;
    }
    default:
      say(player, COOKOFF_USAGE);
  }
}

module.exports = { onCookOffCommand, COOKOFF_USAGE };
