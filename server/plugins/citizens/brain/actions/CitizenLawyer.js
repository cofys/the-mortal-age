"use strict";

/**
 * CitizenLawyer — the brain action for lawyer-career citizens taking cases.
 *
 * WHAT IT DOES:
 *   - CRIMINAL: The lawyer looks for accused citizens (on the watch's
 *     wanted list) who don't yet have counsel, and takes their case.
 *     The fee (150 coins) is collected honestly: real coins move from the
 *     client's real inventory to the lawyer's real inventory. A client who
 *     can't pay still gets defended pro bono (feePaid=false) — lawyers
 *     build their name on hard cases too.
 *     The representation is registered in CitizenLegalCode so the trial
 *     hook applies the defense bonus. On acquittal, the lawyer earns the
 *     `advocate` fame deed (awarded by the Life tick when it sees the
 *     verdict, not here).
 *   - CIVIL: The lawyer also takes civil disputes (breach, debt,
 *     defamation) where a party lacks an advocate. The fee (100 coins)
 *     is collected honestly the same way. Representation is registered
 *     in CitizenCivilLaw so the hearing applies the advocate bonus.
 *     On winning, the lawyer earns the `counselor` fame deed (awarded
 *     by the civil Life tick, not here).
 *   - Human-paced: one case per run, then done. A human lawyer doesn't
 *     sign ten clients in a minute. Criminal defense is tried first;
 *     civil disputes fill the rest of the practice.
 *
 * WHAT IT DOES NOT DO:
 *   - No invented money. No coins on either side → the case is still taken
 *     (pro bono) but no coins move.
 *   - No LLM. Zero.
 */

const LegalCode = require("../../lib/CitizenLegalCode");
const CivilLaw = require("../../lib/CitizenCivilLaw");

const ACTION_ID = "citizenLawyer";
const GIVE_UP_MS = 10 * 60 * 1000; // 10 minutes, then give up honestly
const COINS_ITEM_ID = 995;

function countCoins(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    // Canonical engine API: ItemContainer.getAmount(id). inv.count does not
    // exist on the engine container.
    if (typeof inv.getAmount === "function") return inv.getAmount(COINS_ITEM_ID) || 0;
    return 0;
  } catch {
    return 0;
  }
}

function moveCoins(fromPlayer, toPlayer, amount) {
  // Canonical engine APIs with balance verification: deleteNumber(id, n)
  // and adds(id, n). The old inv.remove/add shapes were dead on the real
  // ItemContainer (remove doesn't exist; add takes an Item instance, not
  // (id, amount)) — a stale mock's shapes masked it, and debit could
  // succeed while delivery threw: vanishing coins. A failed credit rolls
  // the debit back, so coins are never lost mid-move.
  try {
    const fromInv = fromPlayer?.getInventory?.();
    const toInv = toPlayer?.getInventory?.();
    if (!fromInv || !toInv || amount <= 0) return 0;
    if (typeof fromInv.deleteNumber !== "function" || typeof toInv.adds !== "function") return 0;
    if (typeof fromInv.getAmount !== "function" || typeof toInv.getAmount !== "function") return 0;
    const take = Math.min(countCoins(fromPlayer), Math.floor(amount));
    if (take <= 0) return 0;
    const beforeFrom = fromInv.getAmount(COINS_ITEM_ID);
    const beforeTo = toInv.getAmount(COINS_ITEM_ID);
    fromInv.deleteNumber(COINS_ITEM_ID, take);
    toInv.adds(COINS_ITEM_ID, take);
    const debited = fromInv.getAmount(COINS_ITEM_ID) === beforeFrom - take;
    const credited = toInv.getAmount(COINS_ITEM_ID) === beforeTo + take;
    if (debited && credited) return take;
    // Roll back whatever half moved — never lose coins.
    try {
      if (credited) toInv.deleteNumber(COINS_ITEM_ID, take);
      if (debited) fromInv.adds(COINS_ITEM_ID, take);
    } catch { /* rollback is best-effort */ }
    return 0;
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
      if (client) {
        // Take the criminal case. Collect the fee honestly from the client's inventory.
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
      }

      // No criminal clients — look for civil disputes needing an advocate.
      return takeCivilCase(player, username, playerFor, sayPublic);
    },
  };
}

/**
 * Take a civil dispute case: find a dispute where a party lacks an
 * advocate, collect the fee honestly, register the representation.
 * Module-level so both run() and tests can reach it.
 */
async function takeCivilCase(player, username, playerFor, sayPublic) {
  let disputes = [];
  try {
    disputes = CivilLaw.disputesNeedingAdvocates() || [];
  } catch {
    disputes = [];
  }
  // Take the first dispute where this lawyer isn't already involved and
  // isn't a party.
  const norm = String(username).toLowerCase();
  const dispute = disputes.find((d) => {
    if (!d || !d.id) return false;
    if (d.plaintiff === norm || d.defendant === norm) return false;
    const advP = CivilLaw.advocateFor(d.id, d.plaintiff);
    const advD = CivilLaw.advocateFor(d.id, d.defendant);
    if (advP && advP.lawyer === norm) return false;
    if (advD && advD.lawyer === norm) return false;
    return true;
  });
  if (!dispute) {
    return { ok: true, done: true, reason: "no-clients" };
  }
  // Represent the party that lacks counsel (plaintiff first).
  const partyNorm = !CivilLaw.advocateFor(dispute.id, dispute.plaintiff) ? dispute.plaintiff : dispute.defendant;
  const partyDisplay = partyNorm === dispute.plaintiff ? dispute.displayPlaintiff : dispute.displayDefendant;
  const clientPlayer = playerFor(partyDisplay || partyNorm);
  let feePaid = false;
  if (clientPlayer) {
    const moved = moveCoins(clientPlayer, player, CivilLaw.ADVOCATE_FEE);
    feePaid = moved >= CivilLaw.ADVOCATE_FEE;
  }
  CivilLaw.hireAdvocate(dispute.id, partyNorm, username, feePaid);

  try {
    sayPublic(player, `I'll represent ${partyDisplay || partyNorm} in their ${dispute.type} dispute — the law protects us all.`);
  } catch {
    // best-effort
  }
  return { ok: true, done: true, reason: "civil-case-taken", disputeId: dispute.id, client: partyDisplay || partyNorm, feePaid };
}

module.exports = { createCitizenLawyerAction, ACTION_ID, takeCivilCase };
