"use strict";

/**
 * CitizenDiplomat — the brain action for the covert and dynastic layer:
 * spies and marriage brokers.
 *
 * WHAT IT DOES:
 *   - Spies (sneaky/mischievous trait + real Thieving 20+): when a border
 *     runs hot, start a spy mission against the rival kingdom. One
 *     mission at a time; travel to the target is handled by the travel
 *     system, not faked here.
 *   - Marriage brokers (charismatic + real fame 40+): when two kingdoms
 *     share calm borders, propose a royal marriage alliance between
 *     them. The foreign court negotiates for real.
 *   - Human-paced: one diplomatic act per run, then done. Zero LLM.
 *
 * WHAT IT DOES NOT DO:
 *   - No overlap with CitizenDiplomats' courtier-diplomats: this action
 *     never posts ambassadors and never runs trade/peace missions.
 *   - No invented missions or intelligence. Every record is real state.
 *   - No teleporting citizens to foreign courts.
 */

const Dip = require("../../lib/CitizenDiplomacy");
const { kingdomIdOf } = require("../CitizenSites");

const ACTION_ID = "citizenDiplomat";
const GIVE_UP_MS = 10 * 60 * 1000; // 10 minutes, then give up honestly

function createCitizenDiplomatAction(deps = {}) {
  const { sayPublic = () => {} } = deps;
  void sayPublic;

  return {
    id: ACTION_ID,

    async run(player, ctx = {}) {
      const startedAt = ctx.startedAt || Date.now();
      if (Date.now() - startedAt > GIVE_UP_MS) {
        return { ok: true, done: true, reason: "give-up" };
      }
      const username = player?.getUsername?.() || player?.username || "citizen";
      const home = kingdomIdOf(player);
      const personality = ctx.personality ?? player?.personality ?? {};

      // The sneaky with real thieving skill do the paperwork of war.
      const sneaky = personality?.sneaky ?? personality?.mischievous ?? 0;
      const thieving = ctx.thievingLevel ?? 1;
      if (sneaky > 0.6 && thieving >= Dip.SPY_THIEVING_LEVEL) {
        return runSpy(username, home);
      }

      // The charming and famous arrange the marriages of princes.
      const charisma = personality?.charisma ?? personality?.charming ?? 0;
      const fame = ctx.fameScore ?? fameOf(username);
      if (charisma > 0.6 && fame >= Dip.BROKER_FAME_REQUIRED) {
        return runBroker(username, home);
      }

      return { ok: true, done: true, reason: "no-mission" };
    },
  };
}

function fameOf(username) {
  try {
    const Rep = require("../../lib/CitizenReputation");
    return Rep.reputationFor?.(username) ?? 0;
  } catch {
    return 0;
  }
}

function runSpy(username, home) {
  const nowMs = Date.now();
  if (Dip.spyMissionFor(username)) {
    return { ok: true, done: true, reason: "mission-active" };
  }
  const target = pickRivalKingdom(home);
  if (!target) return { ok: true, done: true, reason: "no-rival" };
  const mission = Dip.startSpyMission({ spy: username, homeKingdom: home, targetKingdom: target, nowMs });
  if (!mission) return { ok: true, done: true, reason: "mission-failed" };
  return { ok: true, done: true, reason: "mission-started", target, mission: mission.id };
}

function runBroker(username, home) {
  const nowMs = Date.now();
  const target = pickMarriagePartner(home);
  if (!target) return { ok: true, done: true, reason: "no-partner" };
  const proposal = Dip.proposeMarriage({ from: home, to: target, broker: username, nowMs });
  if (!proposal) return { ok: true, done: true, reason: "proposal-exists" };
  return { ok: true, done: true, reason: "proposed", target, proposal: proposal.id };
}

/** The most tense foreign border — where spies are needed. */
function pickRivalKingdom(home) {
  let best = null;
  let bestT = 30; // only spy where it matters
  for (const k of Dip.kingdoms()) {
    if (k === home) continue;
    let t = 0;
    try {
      const Tension = require("../../../kingdoms/Tension.Kingdoms");
      t = Tension.getTension?.(home, k) ?? 0;
    } catch { /* tension unreadable */ }
    if (t > bestT) {
      bestT = t;
      best = k;
    }
  }
  return best;
}

/** A calm foreign border with no pending proposal — where marriages bloom. */
function pickMarriagePartner(home) {
  const candidates = [];
  for (const k of Dip.kingdoms()) {
    if (k === home) continue;
    let t = 50;
    try {
      const Tension = require("../../../kingdoms/Tension.Kingdoms");
      t = Tension.getTension?.(home, k) ?? 50;
    } catch { /* tension unreadable */ }
    if (t > 40) continue; // hot borders don't marry
    const pending = Dip.pendingMarriagesFor(home).some(
      (m) => Dip.pairKey(m.from, m.to) === Dip.pairKey(home, k)
    );
    if (pending) continue;
    if (Dip.hasMarriageAlliance(home, k)) continue;
    candidates.push(k);
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = { createCitizenDiplomatAction, ACTION_ID };
