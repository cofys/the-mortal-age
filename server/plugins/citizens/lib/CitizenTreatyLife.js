"use strict";

/**
 * CitizenTreatyLife — the slow-tick dynamics for the citizen treaty layer:
 * embassy decay, treaty negotiation, summits, and treaty expiry.
 *
 * WHAT IT DOES (wired into the director slow tick, try/catch, never throws):
 *   - Treaty negotiations: pending proposals advance at most one court
 *     round per NEGOTIATION_ROUND_MS. Accepted proposals are ratified with
 *     their REAL effects (alliance ratification emits
 *     kingdom:alliance-formed through the injected emitter — set once from
 *     the plugin attach where pluginApi is available).
 *   - Embassies: standing embassy pairs cool their border a little each
 *     tick through the Tension API. Embassies are sacked when the war layer
 *     reports an active war between the pair.
 *   - Summits: due summits are held with real effects; pending treaties
 *     between the pair get a ratification bonus.
 *   - Expiry: expired treaties lapse honestly and are journaled.
 *   - Announcements: ratified treaties, held summits, and sacked embassies
 *     are announced via sayPublic where real players can hear them, and
 *     journaled.
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented effects: every number lands through a real API.
 *   - Never touches lib/*2 (frozen).
 */

const T = require("./CitizenTreaties");

// Injected once from the plugin attach (pluginApi.emitCustomEvent).
let emitFn = null;

/** Wire the kingdom event emitter (called from Citizens.plugin.js attach). */
function setEmitter(fn) {
  emitFn = typeof fn === "function" ? fn : null;
}

function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const { normalizeName } = require("./CitizenBonds");
    const record = director?.roster?.get?.(normalizeName(username));
    const player = record && director.isOnline?.(record) ? director.getBot?.(record) : null;
    if (player) sayPublic(player, text);
  } catch {
    // speech is best-effort
  }
}

function journal(director, username, text, data = {}) {
  try {
    // Canonical journal API: getJournal().log(citizenName, kind, text, opts)
    // (CitizenJournal.js). The old code called director.journal(...), which
    // does not exist on the real CitizenDirector, so every treaty journal
    // entry silently died. Broker-less realm events journal under "Realm".
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(username ?? "Realm", "treaty", text, data);
  } catch {
    try {
      director?.log?.(`[treaties] ${text}`, data);
    } catch {
      // journaling is best-effort
    }
  }
}

function prettyKingdom(id) {
  const s = String(id ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Slow-tick entry. director: the CitizenDirector. nowMs: real time.
 * Never throws.
 */
function tickTreaties(director, nowMs = Date.now()) {
  try {
    advanceNegotiations(director, nowMs);
  } catch (error) {
    director?.log?.("treaties negotiations failed", { error: String(error?.message ?? error) });
  }
  try {
    tendEmbassies(director);
  } catch (error) {
    director?.log?.("treaties embassies failed", { error: String(error?.message ?? error) });
  }
  try {
    holdDueSummits(director, nowMs);
  } catch (error) {
    director?.log?.("treaties summits failed", { error: String(error?.message ?? error) });
  }
  try {
    expireOldTreaties(director, nowMs);
  } catch (error) {
    director?.log?.("treaties expiry failed", { error: String(error?.message ?? error) });
  }
}

function advanceNegotiations(director, nowMs) {
  const seen = new Set();
  // Unratified acceptances from earlier ticks get ratified first.
  for (const k of T.kingdoms()) {
    for (const accepted of T.unratifiedProposalsFor(k)) {
      if (seen.has(accepted.id)) continue;
      seen.add(accepted.id);
      ratifyAndAnnounce(director, accepted, nowMs);
    }
  }
  for (const k of T.kingdoms()) {
    for (const pending of T.pendingProposalsFor(k)) {
      if (seen.has(pending.id)) continue;
      seen.add(pending.id);
      let outcome;
      try {
        outcome = T.negotiateRound(pending.id, nowMs);
      } catch {
        continue; // one bad proposal never breaks the tick
      }
      const label = T.TREATY_TYPES[pending.type]?.label ?? pending.type;
      if (outcome === "accepted") {
        ratifyAndAnnounce(director, T.proposalById(pending.id) ?? pending, nowMs);
      } else if (outcome === "declined") {
        journal(director, pending.broker, `${prettyKingdom(pending.to)} declined the ${label} from ${prettyKingdom(pending.from)}.`, {
          proposal: pending.id,
        });
      } else if (outcome === "expired") {
        journal(director, pending.broker, `The ${label} talks between ${prettyKingdom(pending.from)} and ${prettyKingdom(pending.to)} died unanswered.`, {
          proposal: pending.id,
        });
      }
      // "countered" and "waiting" are quiet — haggling happens behind closed doors.
    }
  }
}

/** Ratify an accepted proposal and announce it. Never throws. */
function ratifyAndAnnounce(director, proposal, nowMs) {
  const label = T.TREATY_TYPES[proposal.type]?.label ?? proposal.type;
  let result = { ok: false, effects: [] };
  try {
    result = T.ratifyTreaty(proposal.id, emitFn, nowMs);
  } catch {
    return; // stays accepted — the next tick retries
  }
  if (!result.ok) return;
  const text =
    `Hear ye! ${prettyKingdom(proposal.from)} and ${prettyKingdom(proposal.to)} have signed a ${label}.` +
    (result.effects?.length ? ` ${result.effects.join("; ")}.` : "");
  journal(director, proposal.broker, text, { treaty: result.treaty?.id ?? proposal.id, effects: result.effects });
  if (proposal.broker) sayPublicTo(director, proposal.broker, text);
}

function tendEmbassies(director) {
  const st = { pairs: new Set() };
  for (const k of T.kingdoms()) {
    for (const other of T.kingdoms()) {
      if (other <= k) continue;
      const e1 = T.embassyFor(k, other);
      const e2 = T.embassyFor(other, k);
      if (e1 && e2) {
        // War sacks embassies.
        let war = false;
        try {
          war = T.atWar(k, other);
        } catch {
          war = false;
        }
        if (war) {
          T.sackEmbassy(e1.id, "war");
          T.sackEmbassy(e2.id, "war");
          const text = `War! The embassies of ${prettyKingdom(k)} and ${prettyKingdom(other)} have been sacked.`;
          journal(director, null, text, { pair: [k, other] });
          continue;
        }
        // Standing pairs cool their border a little each tick.
        try {
          const Tension = require("../../kingdoms/Tension.Kingdoms");
          if (typeof Tension.getTension === "function" && typeof Tension.setTension === "function") {
            const cur = Tension.getTension(k, other) ?? 0;
            if (cur > 0) Tension.setTension(k, other, Math.max(0, cur - T.EMBASSY_TENSION_DECAY));
          }
        } catch {
          // tension unreachable — the embassies stand as ceremony
        }
        st.pairs.add(k + "|" + other);
      }
    }
  }
  return st.pairs.size;
}

function holdDueSummits(director, nowMs) {
  for (const s of T.summitsDue(nowMs)) {
    let result = { ok: false, effects: [] };
    try {
      result = T.holdSummit(s.id, nowMs);
    } catch {
      continue;
    }
    if (!result.ok) continue;
    const text =
      `The rulers of ${prettyKingdom(s.a)} and ${prettyKingdom(s.b)} have met in summit.` +
      (result.effects?.length ? ` ${result.effects.join("; ")}.` : "");
    journal(director, s.broker, text, { summit: s.id, effects: result.effects });
    if (s.broker) sayPublicTo(director, s.broker, text);
  }
}

function expireOldTreaties(director, nowMs) {
  let expired = [];
  try {
    expired = T.expireTreaties(nowMs);
  } catch {
    return;
  }
  for (const id of expired) {
    journal(director, null, `A treaty has lapsed (id ${id}).`, { treaty: id });
  }
}

module.exports = { tickTreaties, setEmitter };
