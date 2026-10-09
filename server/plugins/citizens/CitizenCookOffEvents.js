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

function cookingLevel(player) {
  try {
    const Skill = require("../src/main/typescript/elvarg/game/model/Skill")?.Skill;
    const mgr = player?.getSkillManager?.();
    if (!mgr || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = Skill ? mgr.getCurrentLevel(Skill.COOKING) : mgr.getCurrentLevel("cooking");
    return Number.isInteger(lvl) && lvl > 0 ? lvl : 1;
  } catch { return 1; }
}

function coinsOf(player) {
  try { return player?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0; } catch { return 0; }
}

function takeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || coinsOf(player) < amount) return false;
    inv.remove?.(COINS_ID, amount);
    return true;
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

/** Defensively resolve an ingredient name to a real item id. */
function resolveItemId(name) {
  const key = String(name || "").toLowerCase().trim();
  if (!key) return null;
  try {
    const tables = [
      require("../data/item-gameplay.json"),
      require("./data/item-gameplay.json"),
    ];
    for (const table of tables) {
      if (!table) continue;
      const items = table.items ?? table;
      const upper = key.toUpperCase().replace(/ /g, "_");
      if (items[upper]?.id != null) return items[upper].id;
      if (items[key]?.id != null) return items[key].id;
    }
  } catch { /* fall through */ }
  return null;
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
      const consume = (chef, ingName) => {
        const id = resolveItemId(ingName);
        if (id == null) return false;
        try {
          if ((inv.getAmount?.(id) ?? 0) < 1) return false;
          inv.remove?.(id, 1);
          return true;
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
        (n, amt) => { try { player?.getInventory?.()?.add?.(COINS_ID, amt); } catch { /* refund best-effort */ } });
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
