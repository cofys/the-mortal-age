"use strict";

/**
 * CitizenTreatyEvents — player-facing diplomacy: the ::treaty command.
 *
 * Mirrors the ::insurance command pattern (PlayerRights.NONE so every
 * player can use it). Players can propose treaties, build embassies, and
 * schedule summits — all with real coins from their real inventory.
 * Citizen brokers keep the fame gate; players are their own authority.
 */

const T = require("./lib/CitizenTreaties");

const COINS_ID = 995;

const USAGE =
  "Diplomacy: ::treaty [relations|propose <peace|trade|alliance> <kingdom>|embassy <kingdom>|summit <kingdom>|treaties]";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function kingdomOf(player) {
  try {
    return player?.getAttribute?.("kingdom:id") ?? player?.getAttribute?.("kingdomId") ?? null;
  } catch {
    return null;
  }
}

function coinsOf(player) {
  try {
    // Canonical: ItemContainer.getAmount(id). There is no inv.count(id).
    return player?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0;
  } catch {
    return 0;
  }
}

function takeCoinsFrom(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    if (before < amount) return false;
    // Canonical engine API: ItemContainer.deleteNumber(id, amount).
    // There is no inv.remove(id, amount) and no inv.count(id).
    inv.deleteNumber?.(COINS_ID, amount);
    // Honest: the balance must actually have moved, or the fee wasn't taken.
    return (inv.getAmount?.(COINS_ID) ?? 0) === before - amount;
  } catch {
    return false;
  }
}

function prettyKingdom(id) {
  const s = String(id ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function onTreatyCommand({ player, parts }) {
  if (!player || player.isPlayerBot?.() === true) return true; // citizens don't run this
  const username = usernameOf(player);
  const home = kingdomOf(player);
  const sub = String(parts[1] ?? "help").toLowerCase();

  try {
    switch (sub) {
      case "help": {
        player.sendMessage("Diplomacy shapes the realm. Your kingdom: " + (home ? prettyKingdom(home) : "unknown") + ".");
        player.sendMessage("::treaty relations — your kingdom's treaties and embassies.");
        player.sendMessage("::treaty propose <peace|trade|alliance> <kingdom> — open talks.");
        player.sendMessage(`::treaty embassy <kingdom> — build an embassy (${T.EMBASSY_COST} coins, real).`);
        player.sendMessage("::treaty summit <kingdom> — call a leaders' summit (needs embassies).");
        player.sendMessage("Trade and alliance talks need embassies in both courts.");
        return true;
      }
      case "relations":
      case "treaties": {
        if (!home) {
          player.sendMessage("Your kingdom is unknown — diplomacy needs a home court.");
          return true;
        }
        const d = T.describe(home);
        if (!d.treaties.length && !d.embassies.length && !d.pendingProposals.length) {
          player.sendMessage(`${prettyKingdom(home)} holds no treaties or embassies. The realm watches.`);
          return true;
        }
        for (const t of d.treaties) {
          player.sendMessage(`Treaty: ${t.type} with ${t.partnerName} (until ${t.expires}).`);
        }
        for (const e of d.embassies) {
          player.sendMessage(`Embassy: ${prettyKingdom(e.home)} mission in ${prettyKingdom(e.host)}.`);
        }
        for (const p of d.pendingProposals) {
          player.sendMessage(`Talks: ${p.type} with ${prettyKingdom(p.from === home ? p.to : p.from)} (in negotiation).`);
        }
        return true;
      }
      case "propose": {
        const type = String(parts[2] ?? "").toLowerCase();
        const target = String(parts[3] ?? "").toLowerCase();
        if (!home) {
          player.sendMessage("Your kingdom is unknown — diplomacy needs a home court.");
          return true;
        }
        const r = T.proposeTreaty({ from: home, to: target, type, broker: username, isPlayer: true });
        if (!r.ok) {
          player.sendMessage(`Cannot propose: ${describeReason(r)}.`);
          return true;
        }
        player.sendMessage(`Your ${type} proposal to ${prettyKingdom(target)} goes to their court.`);
        return true;
      }
      case "embassy": {
        const target = String(parts[2] ?? "").toLowerCase();
        if (!home) {
          player.sendMessage("Your kingdom is unknown — diplomacy needs a home court.");
          return true;
        }
        if (coinsOf(player) < T.EMBASSY_COST) {
          player.sendMessage(`An embassy costs ${T.EMBASSY_COST} coins. You carry ${coinsOf(player)}.`);
          return true;
        }
        const r = T.buildEmbassy({
          home,
          host: target,
          builder: username,
          takeCoins: (amount) => takeCoinsFrom(player, amount),
        });
        if (!r.ok) {
          player.sendMessage(`Cannot build: ${describeReason(r)}.`);
          return true;
        }
        player.sendMessage(`The ${prettyKingdom(home)} embassy rises in ${prettyKingdom(target)}.`);
        return true;
      }
      case "summit": {
        const target = String(parts[2] ?? "").toLowerCase();
        if (!home) {
          player.sendMessage("Your kingdom is unknown — diplomacy needs a home court.");
          return true;
        }
        const r = T.scheduleSummit({ a: home, b: target, broker: username, isPlayer: true });
        if (!r.ok) {
          player.sendMessage(`Cannot call a summit: ${describeReason(r)}.`);
          return true;
        }
        player.sendMessage(`A summit with ${prettyKingdom(target)} is called. The rulers will meet within a day.`);
        return true;
      }
      default: {
        player.sendMessage(USAGE);
        return true;
      }
    }
  } catch {
    player.sendMessage("Diplomacy faltered. Try again.");
    return true;
  }
}

function describeReason(r) {
  switch (r?.reason) {
    case "unknown-kingdom":
      return "unknown kingdom — choose from: " + T.kingdoms().map(prettyKingdom).join(", ") + ".";
    case "unknown-type":
      return "unknown treaty — peace, trade, or alliance.";
    case "needs-embassies":
      return "trade and alliance talks need embassies standing in both courts.";
    case "already-pending":
      return "talks are already underway.";
    case "already-active":
      return "that treaty is already in force.";
    case "already-standing":
      return "your embassy already stands there.";
    case "already-scheduled":
      return "a summit is already called.";
    case "cannot-afford":
      return `you cannot afford it (${T.EMBASSY_COST} coins).`;
    default:
      return r?.reason ?? "the court refused.";
  }
}

module.exports = { onTreatyCommand, USAGE , takeCoinsFrom };
