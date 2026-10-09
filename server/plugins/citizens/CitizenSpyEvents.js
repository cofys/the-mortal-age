"use strict";

/**
 * CitizenSpyEvents — player-facing espionage: the ::spy command.
 *
 * Mirrors the ::treaty command pattern (PlayerRights.NONE so every player
 * can use it). Players can infiltrate rival kingdoms, read the latest
 * real intelligence, and run their own sabotage operations — all with
 * real coins from their real inventory and real discovery risk.
 * Bots are rejected: citizens spy through the brain, not the command.
 */

const Esp = require("./lib/CitizenEspionage");

const COINS_ID = 995;
const INFILTRATION_COST = 500; // bribes, disguises, safe houses — real coins
const SABOTAGE_COST = 1000; // tools, muscle, getaway — real coins

const USAGE =
  "Espionage: ::spy [infiltrate <kingdom>|report <kingdom>|sabotage <kingdom>|networks|advantage <kingdom>]";

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

function isRealPlayer(player) {
  try {
    // Engine truth: Player#isPlayerBot() (server/src/main/typescript/elvarg/game/entity/impl/player/Player.ts:1084)
    // returns true for bot entities. The `?? false` fallback is deliberate: gate
    // call sites always receive a live command entity, so isPlayerBot() is always
    // callable there; the fallback preserves the legacy pass-through for anything
    // that isn't a known bot instead of silently blocking a new class of callers.
    return !(player?.isPlayerBot?.() ?? false);
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

function coinsOf(player) {
  try {
    // Canonical: ItemContainer.getAmount(id). There is no inv.count(id).
    return player?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0;
  } catch {
    return 0;
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

function parseKingdom(raw) {
  const k = String(raw ?? "").toLowerCase();
  return Esp.isKnownKingdom(k) ? k : null;
}

function onSpyCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens spy through their own channels, not this command.");
    return;
  }
  const username = usernameOf(player);
  const home = kingdomOf(player);
  const sub = String(args?.[0] ?? "").toLowerCase();

  if (sub === "infiltrate") {
    const target = parseKingdom(args[1]);
    if (!target) return say(player, "Infiltrate where? ::spy infiltrate <kingdom>");
    if (!home) return say(player, "You need a home kingdom first.");
    if (target === String(home).toLowerCase())
      return say(player, "You can't infiltrate your own kingdom.");
    if (coinsOf(player) < INFILTRATION_COST)
      return say(player, `Infiltration costs ${INFILTRATION_COST} coins (bribes, disguises).`);
    // Embassy cover is automatic for players when a pair stands.
    const cell = Esp.assignCell({
      spy: username,
      homeKingdom: home,
      targetKingdom: target,
      underCover: true, // honored only if a real embassy pair stands
    });
    if (!cell) return say(player, "You're already running an infiltration.");
    takeCoins(player, INFILTRATION_COST);
    const coverNote = cell.underCover ? " under diplomatic cover" : " (no embassy — no cover, be careful)";
    return say(player, `You're in${coverNote}. Lay low in ${Esp.prettyKingdom(target)}.`);
  }

  if (sub === "report") {
    const target = parseKingdom(args[1]);
    if (!target) return say(player, "Report on where? ::spy report <kingdom>");
    let summary = null;
    try {
      const Dip = require("./lib/CitizenDiplomacy");
      summary = Dip.describeIntel?.(target);
    } catch {
      summary = null;
    }
    if (!summary) return say(player, `No word from ${Esp.prettyKingdom(target)} yet.`);
    return say(player, `${Esp.prettyKingdom(target)}: ${summary}.`);
  }

  if (sub === "sabotage") {
    const target = parseKingdom(args[1]);
    if (!target) return say(player, "Sabotage where? ::spy sabotage <kingdom>");
    if (!home) return say(player, "You need a home kingdom first.");
    if (target === String(home).toLowerCase())
      return say(player, "Sabotaging your own kingdom is treason, not espionage.");
    if (coinsOf(player) < SABOTAGE_COST)
      return say(player, `Sabotage costs ${SABOTAGE_COST} coins (tools, muscle, getaway).`);
    if (!Esp.networkFor(home)) Esp.foundNetwork({ kingdom: home, founder: username });
    const op = Esp.planOperation({
      network: home,
      type: "sabotage",
      subtype: "supply",
      targetKingdom: target,
      operative: username,
      nowMs: Date.now(),
    });
    if (!op) return say(player, "You're already running an operation. One shadow at a time.");
    takeCoins(player, SABOTAGE_COST);
    return say(player, `Operation planned against ${Esp.prettyKingdom(target)}. It goes active soon — then stay out of sight.`);
  }

  if (sub === "networks") {
    const lines = [];
    for (const k of Esp.kingdoms()) {
      const net = Esp.networkFor(k);
      if (!net) continue;
      const cells = Esp.cellsIn(k).length;
      lines.push(`${Esp.prettyKingdom(k)}: ${net.spies.length} spies${cells ? `, ${cells} abroad` : ""}`);
    }
    if (!lines.length) return say(player, "No spy networks exist yet.");
    return say(player, lines.join(" | "));
  }

  if (sub === "advantage") {
    const target = parseKingdom(args[1]);
    if (!target) return say(player, "Advantage over whom? ::spy advantage <kingdom>");
    if (!home) return say(player, "You need a home kingdom first.");
    const adv = Esp.intelAdvantageFor(home, target);
    if (adv <= 0) return say(player, `No fresh intelligence on ${Esp.prettyKingdom(target)}.`);
    return say(player, `Intel advantage over ${Esp.prettyKingdom(target)}: ${Math.round(adv * 100)}% — our militias muster stronger.`);
  }

  return say(player, USAGE);
}

module.exports = { onSpyCommand, USAGE , takeCoins };
