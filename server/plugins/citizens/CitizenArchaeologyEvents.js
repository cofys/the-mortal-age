"use strict";

/**
 * CitizenArchaeologyEvents — player-facing archaeology: the ::dig command.
 *
 * Mirrors the ::spy / ::charter command pattern (PlayerRights.NONE so every
 * player can use it). Players can list active dig sites, dig at a site,
 * view the museum, donate artifacts, sell to the museum fund, and restore
 * damaged finds. Bots are rejected: citizens dig through the brain, not
 * the command.
 */

const Arch = require("./lib/CitizenArchaeology");

const COINS_ID = 995;

const DIG_USAGE =
  "::dig [sites|dig <site>|museum|donate <artifact>|sell <artifact>|restore <artifact>|collection]";

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

function giveCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return false;
    // Canonical: adds(id, amount). add(item, refresh) takes an Item object —
    // add(id, amount) throws, so prize money silently never arrived.
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    inv.adds?.(COINS_ID, amount);
    // Honest: the balance must actually have moved, or the prize wasn't paid.
    return (inv.getAmount?.(COINS_ID) ?? 0) === before + amount;
  } catch {
    return false;
  }
}

function takeCoins(player, amount) {
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

function onDigCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens dig through their own expeditions, not this command.");
    return;
  }
  const username = usernameOf(player);
  const home = kingdomOf(player);
  const sub = String(args?.[0] ?? "sites").toLowerCase();

  if (sub === "sites") {
    const sites = Arch.activeSites(home);
    if (!sites.length) {
      say(player, "No open dig sites right now. Explorers must report ancient finds first.");
      return;
    }
    say(player, `Open dig sites (${sites.length}):`);
    for (const s of sites.slice(0, 8)) {
      say(player, `- ${s.name} [${s.id}] — richness ${s.richness}/10, ${s.slotsLeft} finds left`);
    }
    return;
  }

  if (sub === "dig") {
    const siteId = String(args?.[1] ?? "");
    if (!siteId) return say(player, "Dig where? ::dig dig <site>");
    const res = Arch.excavate(username, siteId);
    if (!res.ok) return say(player, `Dig failed: ${res.reason}.`);
    const a = res.artifact;
    say(player, `You unearth ${a.name} (worth ~${a.value} coins)!`);
    say(player, a.history);
    if (res.major) say(player, "A major find! The museum will hear of this.");
    return;
  }

  if (sub === "museum") {
    if (!home) return say(player, "You need a home kingdom first.");
    const m = Arch.museumStatus(home);
    say(player, `Museum of ${home} — prestige ${m.prestige}, fund ${m.fund} coins, ${m.displayed} pieces on display.`);
    for (const f of m.finest) {
      say(player, `- ${f.name} (~${f.value} coins), found by ${f.finder}`);
    }
    return;
  }

  if (sub === "collection" || sub === "artifacts") {
    const owned = Arch.artifactsOfOwner(username);
    if (!owned.length) return say(player, "You hold no artifacts. Go dig.");
    say(player, `Your artifacts (${owned.length}):`);
    for (const a of owned.slice(0, 10)) {
      say(player, `- ${a.name} [${a.id}] (~${a.value} coins, ${a.condition})`);
    }
    return;
  }

  if (sub === "donate") {
    const artifactId = String(args?.[1] ?? "");
    if (!artifactId) return say(player, "Donate what? ::dig donate <artifact>");
    const res = Arch.donateArtifact(username, artifactId);
    if (!res.ok) return say(player, `Donation failed: ${res.reason}.`);
    try {
      const Rep = require("./lib/CitizenReputation");
      Rep.awardDeed?.(username, "curator");
    } catch { /* fame optional */ }
    say(player, `Donated ${res.artifact.name} to the museum. Scholars will remember your name.`);
    return;
  }

  if (sub === "sell") {
    const artifactId = String(args?.[1] ?? "");
    if (!artifactId) return say(player, "Sell what? ::dig sell <artifact>");
    const res = Arch.sellArtifactToMuseum(username, artifactId, (who, coins) =>
      who === username ? giveCoins(player, coins) : false
    );
    if (!res.ok) return say(player, `Sale failed: ${res.reason}.`);
    say(player, `Sold ${res.artifact.name} to the museum for ${res.price} coins.`);
    return;
  }

  if (sub === "restore") {
    const artifactId = String(args?.[1] ?? "");
    if (!artifactId) return say(player, "Restore what? ::dig restore <artifact>");
    const res = Arch.restoreArtifact(username, artifactId, (who, coins) =>
      who === username ? takeCoins(player, coins) : false
    );
    if (!res.ok) return say(player, `Restoration failed: ${res.reason}.`);
    say(player, `Restored to ${res.artifact.name} (fee ${res.fee} coins, now worth ~${res.artifact.value}).`);
    return;
  }

  say(player, DIG_USAGE);
}

module.exports = { onDigCommand, DIG_USAGE , giveCoins, takeCoins };
