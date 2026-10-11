"use strict";

/**
 * Bounties.Kingdoms — the WANTED board (Phase 3, Jon 2026-10-11).
 *
 * Courts post bounties on real offenders: caught saboteurs (Espionage),
 * witnessed assailants (GuardPatrol), thieving citizens (CitizenCrime),
 * and subjects whose hatred standing crosses into the Enemy tier
 * (Influence). The money is REAL: the issuing treasury escrows the full
 * amount at posting time via KingdomStore.spendTax, so a bounty can
 * never promise coins the court does not hold. Collection pays out of
 * the record itself — the treasury is never dipped twice.
 *
 * Wanted records live in store state.wanted:
 *   { username, kingdomId, crime, amount, crimes, postedAt, lastCrimeAt,
 *     lastDecayAt }
 *
 * Decay (Jon's shape, 2026-10-11): while the offender stays clean, the
 * bounty shrinks by BOUNTY_CONFIG.DECAY_FRACTION_PER_DAY of its current
 * amount per full clean day; each shrunk portion refunds to the issuing
 * treasury (grantTax). The record clears when the amount reaches zero,
 * or after CLEAN_MS clean days, whichever comes first (the remainder
 * refunds then too). A fresh crime resets the clean clock and escalates.
 *
 * Bank robberies (BankRobbery.plugin, 2026-10-11) are the #1 bounty
 * generator by design: they post with an explicit amount override of
 * 100k + 25% of the take, kingdom-funded. MAX_AMOUNT was raised from
 * 10k to 1M for them — a capital-vault job can put 850k on a crew's head.
 *
 * No LLM, no tick of its own: decay is applied lazily on read
 * (listWanted / collect / markWanted), the same pattern WarSupply uses
 * for demands.
 */

const BOUNTY_CONFIG = {
  /** Bounty posted/escalated per crime, by crime kind. */
  PER_CRIME: {
    assault: 500,
    theft: 300,
    attack: 500,
    sabotage: 2000,
    "enemy-of-the-realm": 1000,
    /** Bank robbery base; the caller overrides with 100k + 25% of take. */
    "bank-robbery": 100000,
  },
  DEFAULT_PER_CRIME: 250,
  /** Hard ceiling on one wanted record (raised for bank-robbery bounties). */
  MAX_AMOUNT: 1000000,
  /** Fraction of the current amount that decays away per clean day. */
  DECAY_FRACTION_PER_DAY: 0.25,
  /** Clean-period cap: after this long clean, the record clears outright. */
  CLEAN_MS: 3 * 24 * 3600 * 1000,
  DAY_MS: 24 * 3600 * 1000,
};

function wantedOf(store) {
  const state = store.load();
  if (!Array.isArray(state.wanted)) state.wanted = [];
  return state.wanted;
}

function norm(name) {
  return String(name ?? "").toLowerCase().trim();
}

function findRecord(store, username, kingdomId) {
  return (
    wantedOf(store).find(
      (r) => r && norm(r.username) === norm(username) && r.kingdomId === kingdomId
    ) ?? null
  );
}

/**
 * Apply gradual decay to one record as of `now`. Refunds every shrunk
 * portion to the issuing treasury. Returns true when the record cleared
 * (and has been removed from state.wanted).
 */
function applyDecay(rec, store, now) {
  const cleanSince = rec.lastCrimeAt ?? rec.postedAt ?? now;
  // Hard cap: clean long enough, the court lets it go entirely.
  if (now - cleanSince >= BOUNTY_CONFIG.CLEAN_MS) {
    if (rec.amount > 0) {
      try {
        store.grantTax(rec.kingdomId, rec.amount);
      } catch {
        // Refund is accounting; clearing still stands.
      }
      rec.amount = 0;
    }
    const list = wantedOf(store);
    const idx = list.indexOf(rec);
    if (idx >= 0) list.splice(idx, 1);
    return true;
  }
  const lastDecay = rec.lastDecayAt ?? cleanSince;
  const days = Math.floor((now - lastDecay) / BOUNTY_CONFIG.DAY_MS);
  if (days <= 0) return false;
  let amount = rec.amount;
  for (let i = 0; i < days; i++) {
    amount -= Math.ceil(amount * BOUNTY_CONFIG.DECAY_FRACTION_PER_DAY);
    if (amount <= 0) {
      amount = 0;
      break;
    }
  }
  const refund = rec.amount - amount;
  rec.lastDecayAt = lastDecay + days * BOUNTY_CONFIG.DAY_MS;
  if (refund > 0) {
    rec.amount = amount;
    try {
      store.grantTax(rec.kingdomId, refund);
    } catch {
      // See above.
    }
  }
  if (rec.amount <= 0) {
    const list = wantedOf(store);
    const idx = list.indexOf(rec);
    if (idx >= 0) list.splice(idx, 1);
    return true;
  }
  return false;
}

/** Decay every record (lazy, on read). Saves when anything changed. */
function decayAll(store, now = Date.now()) {
  const list = [...wantedOf(store)];
  let changed = false;
  for (const rec of list) {
    const before = rec.amount;
    if (applyDecay(rec, store, now)) changed = true;
    else if (rec.amount !== before || rec.lastDecayAt) changed = changed || rec.amount !== before;
  }
  if (changed) {
    try {
      store.save();
    } catch {
      // The next mutation saves anyway.
    }
  }
}

/**
 * Post or escalate a bounty. The increment is escrowed from the issuing
 * treasury at once; if the treasury cannot cover it, the bounty is
 * capped at what was actually funded (a record that funds 0 is dropped).
 *
 * Signature is contractual: Espionage.Kingdoms calls
 * markWanted(username, targetKingdomId, "sabotage", store).
 *
 * The optional 5th parameter amountOverride replaces the per-crime config
 * amount for this posting (BankRobbery.plugin passes 100k + 25% of take).
 * Escalation against an existing record and treasury funding behave the
 * same either way.
 *
 * @returns the wanted record, or null when nothing could be funded.
 */
function markWanted(username, issuingKingdomId, crime, store, amountOverride) {
  if (!username || !issuingKingdomId || !store) return null;
  const now = Date.now();
  decayAll(store, now);
  const perCrime =
    amountOverride != null && amountOverride > 0
      ? Math.min(BOUNTY_CONFIG.MAX_AMOUNT, Math.floor(amountOverride))
      : BOUNTY_CONFIG.PER_CRIME[crime] ?? BOUNTY_CONFIG.DEFAULT_PER_CRIME;
  let rec = findRecord(store, username, issuingKingdomId);
  const existing = rec ? rec.amount : 0;
  const wanted = Math.min(BOUNTY_CONFIG.MAX_AMOUNT, existing + perCrime);
  const increment = wanted - existing;
  let funded = 0;
  if (increment > 0) {
    // spendTax is all-or-nothing; walk down to what the treasury holds.
    let tryAmount = increment;
    while (tryAmount > 0) {
      let ok = false;
      try {
        ok = store.spendTax(issuingKingdomId, tryAmount) === true;
      } catch {
        ok = false;
      }
      if (ok) {
        funded = tryAmount;
        break;
      }
      tryAmount = Math.floor(tryAmount / 2);
    }
  }
  if (!rec) {
    if (funded <= 0) return null;
    rec = {
      username: String(username),
      kingdomId: issuingKingdomId,
      crime: String(crime ?? "crime"),
      amount: funded,
      crimes: 1,
      postedAt: now,
      lastCrimeAt: now,
      lastDecayAt: now,
    };
    wantedOf(store).push(rec);
  } else {
    rec.amount = existing + funded;
    rec.crimes = (rec.crimes ?? 1) + 1;
    rec.crime = String(crime ?? rec.crime ?? "crime");
    rec.lastCrimeAt = now;
    rec.lastDecayAt = now;
    if (rec.amount <= 0) return null;
  }
  try {
    store.save();
  } catch {
    // Callers save on their own paths too.
  }
  return rec;
}

/** Live wanted records (decay applied), optionally for one issuing court. */
function listWanted(store, kingdomId = null) {
  if (!store) return [];
  decayAll(store);
  return wantedOf(store)
    .filter((r) => r && r.amount > 0 && (!kingdomId || r.kingdomId === kingdomId))
    .map((r) => ({ ...r }));
}

function wantedRecord(username, store) {
  if (!username || !store) return null;
  decayAll(store);
  return (
    wantedOf(store).find((r) => r && norm(r.username) === norm(username) && r.amount > 0) ??
    null
  );
}

/**
 * Collect a bounty: the dead is wanted AND the killer holds the bounty
 * contract (checked via Jobs, lazily — or an injected hasContract for
 * tests). The payout comes from the record (escrowed at posting), the
 * record clears, and the payout is returned for the caller to credit to
 * the killer's purse.
 *
 * @returns {{ payout: number, record: object } | null}
 */
function collect(deadUsername, killerUsername, store, opts = {}) {
  if (!deadUsername || !killerUsername || !store) return null;
  if (norm(deadUsername) === norm(killerUsername)) return null;
  decayAll(store);
  const rec = wantedOf(store).find(
    (r) => r && norm(r.username) === norm(deadUsername) && r.amount > 0
  );
  if (!rec) return null;
  let holds = false;
  if (typeof opts.hasContract === "function") {
    try {
      holds = !!opts.hasContract(killerUsername, rec);
    } catch {
      holds = false;
    }
  } else {
    try {
      const Jobs = require("./Jobs.Kingdoms");
      holds = Jobs.holdsBountyContract(killerUsername, rec, store);
    } catch {
      holds = false;
    }
  }
  if (!holds) return null;
  const payout = rec.amount;
  const list = wantedOf(store);
  const idx = list.indexOf(rec);
  if (idx >= 0) list.splice(idx, 1);
  try {
    store.save();
  } catch {
    // The record is cleared in memory; the next save persists it.
  }
  return { payout, record: { ...rec } };
}

function attachBounties(api) {
  console.info("[bounties] wanted board armed — courts escrow real coin");
}

module.exports = attachBounties;
module.exports.attachBounties = attachBounties;
module.exports.BOUNTY_CONFIG = BOUNTY_CONFIG;
module.exports.markWanted = markWanted;
module.exports.listWanted = listWanted;
module.exports.wantedRecord = wantedRecord;
module.exports.collect = collect;
module.exports.decayAll = decayAll;
module.exports._test = { applyDecay, findRecord };
