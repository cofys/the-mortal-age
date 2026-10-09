"use strict";

/**
 * CitizenLawyer — the brain action for lawyer-career citizens taking cases.
 *
 * WHAT IT DOES:
 *   - The lawyer looks for accused citizens (on the watch's wanted list)
 *     who don't yet have counsel, and takes their case.
 *   - The fee (150 coins) is collected honestly: real coins move from the
 *     client's real inventory to the lawyer's real inventory. A client who
 *     can't pay still gets defended pro bono (feePaid=false) — lawyers
 *     build their name on hard cases too.
 *   - The representation is registered in CitizenLegalCode so the trial
 *     hook applies the defense bonus. On acquittal, the lawyer earns the
 *     `advocate` fame deed (awarded by the Life tick when it sees the
 *     verdict, not here).
 *   - Human-paced: one case per run, then done. A human lawyer doesn't
 *     sign ten clients in a minute.
 *
 * WHAT IT DOES NOT DO:
 *   - No invented money. No coins on either side → the case is still taken
 *     (pro bono) but no coins move.
 *   - No LLM. Zero.
 */

const LegalCode = require("../../lib/CitizenLegalCode");

const ACTION_ID = "citizenLawyer";
const GIVE_UP_MS = 10 * 60 * 1000; // 10 minutes, then give up honestly
const COINS_ITEM_ID = 995;

function countCoins(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(COINS_ITEM_ID) || 0;
    if (typeof inv.getAmount === "function") return inv.getAmount(COINS_ITEM_ID) || 0;
    return 0;
  } catch {
    return 0;
  }
}

function moveCoins(fromPlayer, toPlayer, amount) {
  try {
    const fromInv = fromPlayer?.getInventory?.();
    const toInv = toPlayer?.getInventory?.();
    if (!fromInv || !toInv || amount <= 0) return 0;
    const have = countCoins(fromPlayer);
    const take = Math.min(have, amount);
    if (take <= 0) return 0;
    if (typeof fromInv.remove === "function") fromInv.remove(COINS_ITEM_ID, take);
    else if (typeof fromInv.delete === "function") fromInv.delete(COINS_ITEM_ID, take);
    else return 0;
    if (typeof toInv.add === "function") toInv.add(COINS_ITEM_ID, take);
    return take;
  } catch {
    return 0;
  }
}

function createCitizenLawyerAction(deps = {}) {
  const {
    sayPublic = () => {},
    wantedList = () => [], // () => [usernames] of accused without counsel
    playerFor = () => null, // (username) => player/bot or null
  } = deps;

  return {
    id: ACTION_ID,

    async run(player, ctx = {}) {
      const startedAt = ctx.startedAt || Date.now();
      if (Date.now() - startedAt > GIVE_UP_MS) {
        return { ok: true, done: true, reason: "give-up" };
      }

      const username = player?.getUsername?.() || player?.username || "citizen";

      // Find an accused citizen without counsel.
      let clients = [];
      try {
        clients = wantedList() || [];
      } catch {
        clients = [];
      }
      const client = clients.find(
        (u) => u && u !== username && !LegalCode.lawyerFor(u)
      );
      if (!client) {
        return { ok: true, done: true, reason: "no-clients" };
      }

      // Take the case. Collect the fee honestly from the client's inventory.
      const clientPlayer = playerFor(client);
      let feePaid = false;
      if (clientPlayer) {
        const moved = moveCoins(clientPlayer, player, LegalCode.LAWYER_FEE);
        feePaid = moved >= LegalCode.LAWYER_FEE;
      }
      LegalCode.hireLawyer(client, username, Date.now(), feePaid);

      try {
        sayPublic(player, `I'll defend ${client} before the court — every citizen deserves counsel.`);
      } catch {
        // best-effort
      }
      return { ok: true, done: true, reason: "case-taken", client, feePaid };
    },
  };
}

module.exports = { createCitizenLawyerAction, ACTION_ID };
