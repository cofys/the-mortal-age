"use strict";

/**
 * BloodTithe.Kingdoms — the Morytania blood tithe engine.
 *
 * Lowerniel's collectors walk the collection beats once a day. Players with a
 * Morytania subject tie, or standing inside a collection area, owe the tithe:
 * a flat floor plus a cut of the coins on their person, capped. Pay, and the
 * coins split — a share funds the guard patrol payroll, the rest fills
 * Lowerniel's coffers. Refuse (or just be broke), and the shortfall lands in
 * a per-player debt ledger: notice on the first shortfall, grace on the
 * second consecutive, a wanted posting for tithe-evasion on the third.
 *
 * Sarev the Tithe-Officer's voluntary pay interaction stays the ONLY way a
 * player pays the tithe by hand — this module only collects; it never builds
 * a payment UI, an NPC interaction, or a ::command.
 *
 * Escalation side-effects on the third shortfall:
 *   - Bounties.markWanted(username, "morytania", "tithe-evasion", store, amt)
 *   - Tension.addTension("morytania", Rep.hottestRival(), 1)
 *   - a small Myreque +standing award (defiance noticed, capped per round)
 *   - blood-tithe:notoriety {username, debt} for the citizen layer
 *
 * When the tithe records burn (myreque:records-burned), outstanding debts
 * are wiped — the ledgers are ash. Standing is NOT touched.
 */

const Store = require("./KingdomStore");
const Bounties = require("./Bounties.Kingdoms");
const Tension = require("./Tension.Kingdoms");
const Rep = require("../myreque/Reputation.Myreque");

const COINS_ID = 995;
const KINGDOM_ID = "morytania";

/** Tithe math: floor + pct of carried coins, capped. Tunables. */
const TITHE_FLOOR = 100;
const TITHE_PCT = 0.05;
const TITHE_CAP = 5000;
/** Share of each collection that funds the guard patrol payroll. */
const PATROL_SHARE = 0.35;

const TITHE_CYCLE_MS = 24 * 60 * 60 * 1000; // daily
const ROUND_CHECK_MS = 60 * 60 * 1000; // hourly poll; round itself is throttled daily

const FLAG_LAST_AT = "morytania:blood-tithe:last-at";
const FLAG_ROUND_ACTIVE = "morytania:blood-tithe:round-active";
const FLAG_PATROL_FUND = "morytania:blood-tithe:patrol-fund";
const FLAG_BURN_APPLIED_AT = "morytania:blood-tithe:burn-applied-at";
const DEBT_FLAG = (username) => `morytania:blood-tithe:debt:${String(username).toLowerCase()}`;

// Collection beats: Canifis zone + Darkmeyer anchor ± radius.
const CANIFIS = { x1: 3450, x2: 3540, y1: 3440, y2: 3520 };
const DARKMEYER = { x: 3495, y: 3235, r: 60 };

/** Defiance noticed: small Myreque standing award per round, capped. */
const DEFIANCE_STANDING = 2;
const DEFIANCE_ROUND_CAP = 25;

// --- small helpers ------------------------------------------------------------

function isRealPlayer(player) {
  return !!player?.setAttribute && player.isPlayerBot?.() !== true;
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function coinsCarried(player) {
  try {
    return Math.floor(player.getInventory?.()?.getAmount?.(COINS_ID) ?? 0);
  } catch {
    return 0;
  }
}

function locationOf(player) {
  try {
    const loc = player?.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY() };
  } catch {
    return null;
  }
}

function hasSubjectTie(player) {
  try {
    return player?.getAttribute?.("kingdom:id") === KINGDOM_ID;
  } catch {
    return false;
  }
}

function inCollectionArea(player) {
  const loc = locationOf(player);
  if (!loc) return false;
  if (loc.x >= CANIFIS.x1 && loc.x <= CANIFIS.x2 && loc.y >= CANIFIS.y1 && loc.y <= CANIFIS.y2)
    return true;
  return Math.abs(loc.x - DARKMEYER.x) <= DARKMEYER.r && Math.abs(loc.y - DARKMEYER.y) <= DARKMEYER.r;
}

function isTarget(player) {
  return isRealPlayer(player) && (hasSubjectTie(player) || inCollectionArea(player));
}

function onlinePlayers(api) {
  try {
    const stream = api?.core?.World?.getPlayers?.();
    if (!stream) return [];
    const arr = typeof stream.stream === "function" ? stream.stream().toArray?.() ?? [] : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function debtRecord(username, store) {
  try {
    return store?.getKingdom?.(KINGDOM_ID)?.flags?.[DEBT_FLAG(username)] ?? null;
  } catch {
    return null;
  }
}

function writeDebtRecord(username, rec, store) {
  try {
    Store.setFlag(KINGDOM_ID, DEBT_FLAG(username), rec);
    Store.save();
  } catch {
    // best-effort; the debt still lives in memory on the kingdom record
  }
}

function clearDebtRecord(username, store) {
  try {
    const kingdom = store?.getKingdom?.(KINGDOM_ID);
    if (kingdom?.flags && DEBT_FLAG(username) in kingdom.flags) {
      delete kingdom.flags[DEBT_FLAG(username)];
      Store.save();
    }
  } catch {
    // best-effort
  }
}

// --- core ---------------------------------------------------------------------

/**
 * What the player owes this round: flat floor + % of carried coins, capped.
 * @returns amount in coins (integer, >= 0)
 */
function titheOwedFor(player, store) {
  void store;
  const carried = coinsCarried(player);
  return Math.min(TITHE_CAP, Math.max(0, TITHE_FLOOR + Math.floor(carried * TITHE_PCT)));
}

/**
 * Collect the tithe from one player. Takes min(due, coinsCarried) from the
 * purse via inventory.delete, records treasury income under kind "tithe",
 * splits patrol payroll share off into the patrol-fund flag.
 * Shortfall records remaining debt and emits kingdom:tithe-refused.
 *
 * @param emit optional function(name, payload) to reach the event bus
 * @returns {{taken:number, shortfall:number}}
 */
function collectTithe(player, store, opts) {
  const emit = opts?.emit;
  const result = { taken: 0, shortfall: 0 };
  const username = usernameOf(player);
  if (!isRealPlayer(player) || !username) return result;

  const due = titheOwedFor(player, store);
  if (!(due > 0)) return result;
  const taken = Math.min(due, coinsCarried(player));
  const shortfall = due - taken;

  if (taken > 0) {
    try {
      const inventory = player.getInventory?.();
      inventory?.delete?.(COINS_ID, taken);
      inventory?.refreshItems?.();
    } catch {
      return result;
    }
    const patrolCut = Math.round(taken * PATROL_SHARE);
    const coffers = taken - patrolCut;
    Store.grantTax(KINGDOM_ID, coffers);
    Store.recordIncome(KINGDOM_ID, "tithe", taken);
    try {
      const fund = Number(Store.getKingdom(KINGDOM_ID)?.flags?.[FLAG_PATROL_FUND]) || 0;
      Store.setFlag(KINGDOM_ID, FLAG_PATROL_FUND, fund + patrolCut);
      Store.save();
    } catch {
      // payroll flag is bookkeeping; the money already moved
    }
    try {
      player.sendMessage?.(
        `[Tithe] The collectors take their due — ${taken}c blood tithe to the ${"Morytania"} regime.`
      );
    } catch {
      // cosmetic
    }
    try {
      emit?.("kingdom:tithe-collected", {
        player: username,
        taken,
        patrol: patrolCut,
        coffers,
      });
    } catch {
      // notification only
    }
  }

  if (shortfall > 0) {
    const prev = debtRecord(username, store) ?? { debt: 0, streak: 0 };
    writeDebtRecord(username, { debt: prev.debt + shortfall, streak: prev.streak }, store);
    try {
      emit?.("kingdom:tithe-refused", { player: username, shortfall: prev.debt + shortfall });
    } catch {
      // notification only
    }
  }

  result.taken = taken;
  result.shortfall = shortfall;
  return result;
}

// --- escalation -----------------------------------------------------------------

function wantedAmountFor(debt) {
  // modest bounty, scaled by debt: 500–2000
  return Math.min(2000, Math.max(500, Math.floor(debt * 2)));
}

function handleRefusalStreak(player, username, streak, store, opts) {
  const emit = opts?.emit;
  const rec = debtRecord(username, store) ?? { debt: 0, streak: 0 };
  const newStreak = streak;
  writeDebtRecord(username, { debt: rec.debt, streak: newStreak }, store);

  if (newStreak === 1) {
    // Notice: debt recorded, rumor whispered.
    try {
      player.sendMessage?.(
        "[Tithe] The collector scratches your name into his ledger. " +
          `You owe the tithe, ${rec.debt}c — the regime does not forget.`
      );
    } catch {
      // cosmetic
    }
    try {
      emit?.("kingdom:rumor", {
        kingdomId: KINGDOM_ID,
        text: `A collector's ledger now holds ${username}'s name, under debts.`,
      });
    } catch {
      // cosmetic
    }
    return { stage: "notice", streak: newStreak };
  }

  if (newStreak === 2) {
    // Grace: one more round to pay.
    try {
      player.sendMessage?.(
        "[Tithe] The collector's hand lingers on his sword-hilt. " +
          "Last grace — pay the tithe before the next round, or face the warrant."
      );
    } catch {
      // cosmetic
    }
    return { stage: "grace", streak: newStreak };
  }

  // Third consecutive shortfall: wanted, tension, defiance noticed.
  const debt = rec.debt;
  let wanted = null;
  try {
    wanted = Bounties.markWanted(username, KINGDOM_ID, "tithe-evasion", store, wantedAmountFor(debt));
  } catch {
    // treasury funding failed; the warrant can't be posted
  }
  try {
    Tension.addTension(KINGDOM_ID, Rep.hottestRival(), 1);
  } catch {
    // best-effort
  }
  try {
    if ((opts?.defianceAwarded?.size ?? 0) < DEFIANCE_ROUND_CAP) {
      Rep.addStanding(player, DEFIANCE_STANDING, "tithe-defiance");
      opts?.defianceAwarded?.add?.(username.toLowerCase());
    }
  } catch {
    // cosmetic
  }
  try {
    player.sendMessage?.(
      "[Tithe] The collector doesn't ask again. Your name goes on the wanted board — " +
        "tithe-evasion. The patrols will collect it from your corpse."
    );
  } catch {
    // cosmetic
  }
  try {
    emit?.("blood-tithe:notoriety", { username, debt });
  } catch {
    // the citizen layer consumes this; emit is best-effort
  }
  writeDebtRecord(username, { debt: 0, streak: 0 }, store);
  return { stage: "wanted", streak: 0, wanted, debt };
}

/**
 * Run one collection round over all online targets. Daily-throttled via the
 * last-at flag; pass {force:true} to run regardless (tests / admin recovery).
 * @returns {{ok:boolean, reason?:string, rounds?:object}}
 */
function runTitheRound(api, store, opts) {
  const now = Date.now();
  const lastAt = Number(Store.getKingdom(KINGDOM_ID)?.flags?.[FLAG_LAST_AT]) || 0;
  if (!opts?.force && now - lastAt < TITHE_CYCLE_MS) {
    return { ok: false, reason: "too-soon" };
  }

  // Records burned? Wipe outstanding debt before collecting.
  checkRecordsBurned(store, opts);

  // Mark the round live so the citizen layer (tithe_collection_duty scoring)
  // reads real engine state, not a guess. Cleared below even on error.
  try {
    Store.setFlag(KINGDOM_ID, FLAG_ROUND_ACTIVE, true);
    Store.save();
  } catch {
    // cosmetic
  }
  const rounds = { collected: 0, refused: 0, wanted: 0, defianceAwarded: new Set() };
  try {
  for (const player of onlinePlayers(api)) {
    if (!isTarget(player)) continue;
    const username = usernameOf(player);
    if (!username) continue;
    const { taken, shortfall } = collectTithe(player, store, { emit: opts?.emit });
    if (shortfall > 0) {
      rounds.refused += 1;
      const prev = debtRecord(username, store) ?? { debt: 0, streak: 0 };
      // streak counts this round's shortfall: previous streak + 1
      const res = handleRefusalStreak(player, username, prev.streak + 1, store, {
        emit: opts?.emit,
        defianceAwarded: rounds.defianceAwarded,
      });
      if (res.stage === "wanted") rounds.wanted += 1;
    } else if (taken > 0) {
      rounds.collected += 1;
      // Full payment breaks the escalation chain: the streak resets, the
      // recorded debt stands until paid.
      const prior = debtRecord(username, store);
      if (prior && prior.streak > 0) {
        writeDebtRecord(username, { debt: prior.debt, streak: 0 }, store);
      }
    }
    void taken;
  }
  } finally {
    try {
      Store.setFlag(KINGDOM_ID, FLAG_ROUND_ACTIVE, false);
    } catch {
      // cosmetic
    }
  }
  Store.setFlag(KINGDOM_ID, FLAG_LAST_AT, now);
  Store.save();
  return { ok: true, rounds };
}

/**
 * Force-run a round regardless of the daily throttle (tests, admin recovery).
 */
function runTitheRoundForce(api, store, opts) {
  return runTitheRound(api, store, { ...(opts ?? {}), force: true });
}

// --- records burned ---------------------------------------------------------------

function recordsBurnedAt() {
  try {
    return Number(Store.getKingdom(KINGDOM_ID)?.flags?.["morytania:records-burned-at"]) || 0;
  } catch {
    return 0;
  }
}

/**
 * Observe myreque:records-burned: wipe outstanding tithe debt for every
 * player. "The tithe ledgers are ash." Standing is NOT wiped.
 * @returns {wiped:number}
 */
function handleRecordsBurned(store, opts) {
  const burnedAt = recordsBurnedAt();
  const appliedAt = Number(Store.getKingdom(KINGDOM_ID)?.flags?.[FLAG_BURN_APPLIED_AT]) || 0;
  if (burnedAt <= 0 || burnedAt <= appliedAt) return { wiped: 0 };
  let wiped = 0;
  try {
    const flags = Store.getKingdom(KINGDOM_ID)?.flags ?? {};
    for (const key of Object.keys(flags)) {
      if (key.startsWith("morytania:blood-tithe:debt:")) {
        const rec = flags[key];
        if ((rec?.debt ?? 0) > 0) wiped += 1;
        delete flags[key];
      }
    }
    Store.setFlag(KINGDOM_ID, FLAG_BURN_APPLIED_AT, burnedAt);
    Store.save();
  } catch {
    // best-effort
  }
  try {
    opts?.emit?.("kingdom:rumor", {
      kingdomId: KINGDOM_ID,
      text: "Word spreads through the swamp: the tithe ledgers are ash. Debts die with the paper.",
    });
  } catch {
    // cosmetic
  }
  return { wiped };
}

function checkRecordsBurned(store, opts) {
  try {
    return handleRecordsBurned(store, opts);
  } catch {
    return { wiped: 0 };
  }
}

// --- attach -------------------------------------------------------------------

let pluginApi = null;

function busEmit(api, name, payload) {
  try {
    if (typeof api?.emitCustomEvent === "function") api.emitCustomEvent(name, payload);
    else api?.emit?.(name, payload);
  } catch {
    // notification only
  }
}

function attachBloodTithe(api) {
  pluginApi = api;
  const store = Store;
  const emit = (name, payload) => busEmit(api, name, payload);
  // Observe the records-burn event from the Myreque questline.
  try {
    if (typeof api?.onCustomEvent === "function") api.onCustomEvent("myreque:records-burned", () => handleRecordsBurned(store, { emit }));
    else api?.on?.("myreque:records-burned", () => handleRecordsBurned(store, { emit }));
  } catch {
    // bus not available; runTitheRound checks the flag directly
  }
  // Hourly poll; runTitheRound itself throttles to daily.
  try {
    const timer = setInterval(() => {
      try {
        runTitheRound(api, store, { emit });
      } catch (error) {
        console.warn("[blood-tithe] round failed", error?.message);
      }
    }, ROUND_CHECK_MS);
    timer.unref?.();
  } catch {
    // scheduling not available in this environment
  }
  console.info("[blood-tithe] engine armed — collectors walk the beats daily");
}

module.exports = attachBloodTithe;
module.exports.attachBloodTithe = attachBloodTithe;
module.exports.titheOwedFor = titheOwedFor;
module.exports.collectTithe = collectTithe;
module.exports.runTitheRound = runTitheRound;
module.exports.runTitheRoundForce = runTitheRoundForce;
module.exports.handleRecordsBurned = handleRecordsBurned;
module.exports.TITHE_FLOOR = TITHE_FLOOR;
module.exports.TITHE_PCT = TITHE_PCT;
module.exports.TITHE_CAP = TITHE_CAP;
module.exports.PATROL_SHARE = PATROL_SHARE;
module.exports.TITHE_CYCLE_MS = TITHE_CYCLE_MS;
module.exports.FLAG_ROUND_ACTIVE = FLAG_ROUND_ACTIVE;
