"use strict";

/**
 * CitizenCivilLife — director tick dynamics for the REAL civil-law layer.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenCivilLaw owns the data tier: contracts, wills, disputes,
 *     advocates, judgments.
 *   - CitizenJusticeLife owns CRIMINAL trials and punishment.
 *   - CitizenLegalLife owns judges, appeals, pardons, player trials.
 *   - THIS module owns the civil tick: contract deadline enforcement
 *     (expired → breached → auto-dispute), dispute mediation then civil
 *     hearings before the sitting judge, judgment enforcement with real
 *     coins, and will execution from the real death feed.
 *
 * All coin movement is real (inventories, bank accounts). Never throws.
 * Zero LLM. Dirty-flag persistence via CitizenCivilLaw.save().
 */

const CivilLaw = require("./CitizenCivilLaw");
const { agentRng } = require("./humanizer");

// How often the heavier passes run (probability per slow tick).
const MEDIATION_CHANCE = 0.6;
const HEARING_CHANCE = 0.5;
const ENFORCE_CHANCE = 0.7;

function safeTick(director, fn, label) {
  try {
    fn(director);
  } catch (error) {
    try {
      director?.log?.(`${label} failed`, { error: String(error?.message ?? error) });
    } catch { /* never throw */ }
  }
}

function rosterRecords(director) {
  try {
    const roster = director?.roster;
    if (!roster) return [];
    if (typeof roster.values === "function") return Array.from(roster.values());
    if (Array.isArray(roster)) return roster;
    return Object.values(roster);
  } catch {
    return [];
  }
}

function usernameOf(record) {
  return record?.username ?? record?.name ?? null;
}

function botFor(director, record) {
  try {
    if (director?.isOnline?.(record)) return director.getBot?.(record) ?? null;
    return null;
  } catch {
    return null;
  }
}

/** Resolve a username to a live bot (or null). Used for real coin movement. */
function playerFor(director) {
  const byName = new Map();
  try {
    for (const r of rosterRecords(director)) {
      const u = usernameOf(r);
      if (u) byName.set(u.toLowerCase(), r);
    }
  } catch { /* best-effort */ }
  return (username) => {
    try {
      const rec = byName.get(String(username || "").toLowerCase());
      return rec ? botFor(director, rec) : null;
    } catch {
      return null;
    }
  };
}

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    // Canonical signature: log(citizenName, kind, text, opts).
    getJournal().log(citizenName, kind || "civillaw", text);
  } catch { /* best-effort */ }
}

function awardDeed(username, deedKind) {
  try {
    require("./CitizenReputation").awardDeed?.(username, deedKind, Date.now());
  } catch { /* best-effort */ }
}

/**
 * Resolve a username to its live bot via the canonical director path:
 * roster record (keyed by normalized username) -> isOnline(record) ->
 * getBot(record). director.getPlayer/players do NOT exist — this is the
 * real shape.
 */
function botForUsername(director, username) {
  try {
    const norm = String(username || "").toLowerCase();
    if (!norm) return null;
    const roster = director?.roster;
    let record = null;
    if (roster instanceof Map) {
      record = roster.get(norm) || null;
    } else if (roster) {
      const vals =
        typeof roster.values === "function"
          ? Array.from(roster.values())
          : Array.isArray(roster)
            ? roster
            : Object.values(roster);
      record = vals.find((r) => String(r?.username ?? r?.name ?? "").toLowerCase() === norm) || null;
    }
    if (record && director?.isOnline?.(record)) return director.getBot?.(record) ?? null;
  } catch { /* best-effort */ }
  return null;
}

/** Speak as the citizen (canonical: sayPublic(bot, text)). */
function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const bot = botForUsername(director, username);
    if (bot) sayPublic(bot, text);
  } catch { /* best-effort */ }
}

/**
 * True when a real (non-bot) player could hear this citizen. Canonical
 * proximity scan: bot.getLocalPlayers() filtered by isRealPlayer.
 */
function heardByPlayer(director, username) {
  try {
    const bot = botForUsername(director, username);
    if (!bot) return false;
    const { isRealPlayer } = require("../chat/CitizenSayPublic");
    const locals = bot.getLocalPlayers?.() ?? [];
    return locals.some((p) => isRealPlayer(p));
  } catch {
    return false;
  }
}

function judgeFor(kingdomId, nowMs) {
  try {
    return require("./CitizenLegalCode").judgeFor?.(kingdomId, nowMs) || null;
  } catch {
    return null;
  }
}

// --- 1. contract deadlines -----------------------------------------------------

function passContractDeadlines(director, pf, nowMs) {
  for (const c of CivilLaw.activeContracts()) {
    if (c.deadlineMs && c.deadlineMs <= nowMs) {
      // Expired unfulfilled. The party who owed performance breaches.
      // For service/trade the owing party is partyB (worker/seller delivers);
      // for lease the tenant (partyB) owes rent.
      const breacher = c.partyB;
      const res = CivilLaw.breachContract(c.id, breacher);
      if (res.ok) {
        awardDeed(breacher, "oathbreaker");
        journalEvent(
          res.disputeId ? c.displayA : breacher,
          `${c.displayA} and ${c.displayB}'s ${c.type} contract expired unfulfilled — breach recorded.`,
          "civillaw"
        );
        if (heardByPlayer(director, c.displayA, 12)) {
          sayPublicTo(director, c.displayA, `The court notes my contract with ${c.displayB} went unfulfilled. I'll see them before the judge.`);
        }
      }
    }
  }
}

// --- 2. dispute mediation ------------------------------------------------------

function passMediation(director, pf, nowMs, rng) {
  if (rng() > MEDIATION_CHANCE) return;
  for (const d of CivilLaw.openDisputes()) {
    if (d.status !== CivilLaw.DISPUTE_STATUS.filed) continue;
    CivilLaw.setDisputeStatus(d.id, CivilLaw.DISPUTE_STATUS.mediation);
    if (rng() < CivilLaw.MEDIATION_SETTLE_CHANCE) {
      // Settled: the defendant pays half the claim, honestly.
      const defendant = pf(d.displayDefendant || d.defendant);
      const plaintiff = pf(d.displayPlaintiff || d.plaintiff);
      let paid = 0;
      if (defendant) {
        const half = Math.floor(d.claim / 2);
        try {
          const inv = defendant.getInventory?.();
          const have = typeof inv?.count === "function" ? inv.count(995) || 0 : 0;
          const take = Math.min(have, half);
          if (take > 0 && typeof inv.remove === "function") {
            inv.remove(995, take);
            paid = take;
            if (plaintiff && typeof plaintiff.getInventory?.()?.add === "function") {
              plaintiff.getInventory().add(995, take);
            }
          }
        } catch { /* honest: no coins moved */ }
      }
      CivilLaw.setDisputeStatus(d.id, CivilLaw.DISPUTE_STATUS.settled);
      journalEvent(d.displayPlaintiff, `${d.displayPlaintiff} and ${d.displayDefendant} settled their ${d.type} dispute in mediation (${paid} coins).`, "civillaw");
    } else {
      CivilLaw.setDisputeStatus(d.id, CivilLaw.DISPUTE_STATUS.hearing);
    }
  }
}

// --- 3. civil hearings -----------------------------------------------------------

/**
 * The civil hearing. The sitting judge (read defensively from the criminal
 * layer — one bench for the realm) weighs the claim:
 *   base merit 0.5, +0.15 with a written contract, +advocate bonus,
 *   +judge fairness nudge, -0.1 per prior breach by the plaintiff.
 * Awards the full claim on plaintiff win, nothing on loss. Dismissed when
 * there is no judge seated (the docket waits — honest, not invented).
 */
function passHearings(director, nowMs, rng) {
  if (rng() > HEARING_CHANCE) return;
  for (const d of CivilLaw.openDisputes()) {
    if (d.status !== CivilLaw.DISPUTE_STATUS.hearing) continue;
    const judge = d.kingdomId ? judgeFor(d.kingdomId, nowMs) : null;
    if (!judge) continue; // no bench seated — the docket waits
    let merit = 0.5;
    if (d.contractId && CivilLaw.contractById(d.contractId)) merit += 0.15; // written contract
    merit += CivilLaw.advocateBonusFor(d.id, d.plaintiff);
    merit -= CivilLaw.advocateBonusFor(d.id, d.defendant);
    merit += ((judge.fairness ?? 0.5) - 0.5) * 0.2;
    // Prior breaches count against the plaintiff's credibility.
    try {
      const priors = CivilLaw.allContracts().filter(
        (c) => c.status === CivilLaw.CONTRACT_STATUS.breached && c.breachedBy === d.plaintiff
      ).length;
      merit -= Math.min(0.2, priors * 0.1);
    } catch { /* credibility check best-effort */ }
    const plaintiffWins = rng() < merit;
    const winner = plaintiffWins ? d.displayPlaintiff : d.displayDefendant;
    const award = plaintiffWins ? d.claim : 0;
    const res = CivilLaw.recordJudgment(d.id, winner, award);
    if (res.ok) {
      // The winning advocate earns their name.
      const adv = CivilLaw.advocateFor(d.id, plaintiffWins ? d.plaintiff : d.defendant);
      if (adv && adv.lawyer) awardDeed(adv.lawyer, "counselor");
      journalEvent(
        winner,
        `Judge ${judge.username} ruled for ${winner} in the ${d.type} dispute (${award} coins).`,
        "civillaw"
      );
      const speaker = plaintiffWins ? d.displayPlaintiff : d.displayDefendant;
      if (heardByPlayer(director, speaker, 14)) {
        sayPublicTo(director, speaker, plaintiffWins
          ? `The court ruled in my favor — ${award} coins awarded. Justice is served.`
          : `The court ruled against me. I'll accept the judgment.`);
      }
    }
  }
}

// --- 4. judgment enforcement -----------------------------------------------------

function passEnforcement(director, pf, nowMs, rng) {
  if (rng() > ENFORCE_CHANCE) return;
  for (const j of CivilLaw.unpaidJudgments()) {
    const res = CivilLaw.enforceJudgment(j.disputeId, pf);
    if (res.ok && res.paid > 0) {
      journalEvent(j.displayWinner, `${j.displayWinner} collected ${res.paid} coins on a court judgment.`, "civillaw");
      if (res.remaining > 0) {
        journalEvent(j.displayLoser, `${j.displayLoser} still owes ${res.remaining} coins on a court judgment.`, "civillaw");
      }
    }
  }
}

// --- 5. will execution -----------------------------------------------------------

function estateOf(player, username) {
  let coins = 0;
  try {
    const inv = player?.getInventory?.();
    if (inv && typeof inv.count === "function") coins += inv.count(995) || 0;
  } catch { /* ignore */ }
  try {
    // CitizenBanking exposes accountFor/balanceOf/deposit/withdraw —
    // accountOf and creditAccount do not exist. withdraw's real shape is
    // withdraw(player, username, amount).
    const Banking = require("./CitizenBanking");
    const acct = Banking.accountFor?.(username);
    if (acct && acct.balance > 0) {
      if (player) {
        // Online death: withdraw into the inventory so the inventory sweep
        // below picks the coins up.
        const res = Banking.withdraw?.(player, username, acct.balance);
        if (res && res.ok) coins += res.withdrew || 0;
        // On failure the balance stays put — not invented, not lost.
      } else {
        // Offline death: sweep the account straight into the estate.
        coins += acct.balance;
        acct.balance = 0;
        Banking.markDirty?.();
      }
    }
  } catch { /* banking unreadable */ }
  return coins;
}

function closeBondsOf(username) {
  try {
    // CitizenBonds exposes bonds(name) -> { friends: [...], enemies: [...] };
    // closeBondsOf/bondsOf do not exist.
    const Bonds = require("./CitizenBonds");
    const rec = Bonds.bonds?.(username);
    const friends = rec && Array.isArray(rec.friends) ? rec.friends : [];
    const norm = String(username || "").toLowerCase();
    return friends.filter((b) => b && String(b).toLowerCase() !== norm);
  } catch { /* bonds unreadable */ }
  return [];
}

function passWills(director, nowMs) {
  let watermark = CivilLaw.willWatermarkMs || 0;
  let deceased = [];
  try {
    deceased = require("./CitizenFunerals").getDeceased?.() || [];
  } catch {
    return; // funerals unreadable — try next tick
  }
  const fresh = deceased.filter((d) => (d.diedAt || 0) > watermark).sort((a, b) => a.diedAt - b.diedAt);
  if (fresh.length === 0) return;
  const pf = playerFor(director);
  for (const d of fresh) {
    const username = d.username;
    const player = pf(d.display || username);
    const estate = estateOf(player, username);
    // Take the inventory coins into the estate (they're being distributed,
    // not destroyed — the will decides who gets them).
    if (player && estate > 0) {
      try {
        const inv = player.getInventory?.();
        const have = typeof inv?.count === "function" ? inv.count(995) || 0 : 0;
        if (have > 0 && typeof inv.remove === "function") inv.remove(995, have);
      } catch { /* honest: leave what we can't move */ }
    }
    const res = CivilLaw.executeWill(username, estate, pf, closeBondsOf(username));
    if (res.ok) {
      const heirList = (res.heirs || []).filter((h) => h.username !== "__crown__").map((h) => `${h.display} (${h.amount})`).join(", ");
      journalEvent(
        d.display || username,
        res.intestate
          ? `${d.display || username} died intestate — the estate (${estate} coins) was divided by the court${heirList ? `: ${heirList}` : ""}.`
          : `${d.display || username}'s will was executed — ${estate} coins settled${heirList ? `: ${heirList}` : ""}.`,
        "civillaw"
      );
      awardDeed(username, "executor"); // the deceased's planning, honored
      if (heardByPlayer(director, d.display || username, 14)) {
        // The executor announces near the deceased's home.
        const exec = CivilLaw.willFor(username)?.displayExecutor;
        if (exec) sayPublicTo(director, exec, `By ${d.display || username}'s will, the estate is settled.`);
      }
    }
    if (d.diedAt > watermark) watermark = d.diedAt;
  }
  CivilLaw.setWillWatermarkMs(watermark);
}

// --- entry -----------------------------------------------------------------------

function tickCivilLife(director, nowMs) {
  // Time-bucketed seed: each slow tick gets fresh rolls, but the sequence
  // is stable within the tick (matches CitizenJusticeLife's pattern).
  const rng = agentRng(`civillaw:${Math.floor((nowMs || Date.now()) / 60000)}`);
  // LOD: with no live civil-law state, the deadline/mediation/hearing/
  // enforcement passes are guaranteed no-ops — skip them outright instead
  // of materializing the roster map. The will pass keeps its own cheap
  // no-fresh-deaths early-out. The roster map is built once and shared by
  // the passes that need it, not once per pass.
  if (
    CivilLaw.activeContracts().length > 0 ||
    CivilLaw.openDisputes().length > 0 ||
    CivilLaw.unpaidJudgments().length > 0
  ) {
    const pf = playerFor(director);
    safeTick(director, (d) => passContractDeadlines(d, pf, nowMs), "civil-law contracts");
    safeTick(director, (d) => passMediation(d, pf, nowMs, rng), "civil-law mediation");
    safeTick(director, (d) => passHearings(d, nowMs, rng), "civil-law hearings");
    safeTick(director, (d) => passEnforcement(d, pf, nowMs, rng), "civil-law enforcement");
  }
  safeTick(director, (d) => passWills(d, nowMs), "civil-law wills");
}

function resetForTests() {
  // No module-local state; CivilLaw.resetForTests covers the data tier.
}

module.exports = { tickCivilLife, resetForTests };
