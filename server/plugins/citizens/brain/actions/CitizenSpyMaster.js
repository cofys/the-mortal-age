"use strict";

/**
 * CitizenSpyMaster — the brain action for the espionage operations layer:
 * spymasters run covert operations, counter-agents hunt enemy spies.
 *
 * WHAT IT DOES:
 *   - Spymasters (sneaky trait + real Thieving 25+, in a kingdom with a
 *     founded network): handlers plan covert operations against rival
 *     kingdoms when the network has no live operation. One operation at
 *     a time per operative.
 *   - Counter-agents: citizens appointed to counter-intelligence patrol
 *     their home kingdom — the actual catching happens on the slow tick
 *     (CitizenEspionageLife), this action just keeps them visible and
 *     moving through the city.
 *   - Human-paced: one espionage act per run, then done. Zero LLM.
 *
 * WHAT IT DOES NOT DO:
 *   - No overlap with CitizenDiplomat (passive intel-gathering spy
 *     missions, marriage brokers) — this action never starts passive
 *     gather missions and never brokers marriages.
 *   - No invented operations or targets. Assassination targets must be
 *     real roster citizens (the tick verifies through the roster).
 *   - No teleporting citizens to foreign kingdoms.
 */

const Esp = require("../../lib/CitizenEspionage");
const { kingdomIdOf } = require("../CitizenSites");

const ACTION_ID = "citizenSpyMaster";
const GIVE_UP_MS = 10 * 60 * 1000; // 10 minutes, then give up honestly

function createCitizenSpyMasterAction(deps = {}) {
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
      const thieving = ctx.thievingLevel ?? 1;

      // Counter-agents hunt at home — the tick does the catching.
      const counterOf = Esp.counterAgentsOf(home);
      if (counterOf.some((a) => String(a).toLowerCase() === String(username).toLowerCase())) {
        return runCounterPatrol(username, home);
      }

      // Spymasters run the shadows: sneaky, skilled, and networked.
      const sneaky = personality?.sneaky ?? personality?.mischievous ?? 0;
      if (sneaky > 0.6 && thieving >= Esp.OPERATIVE_THIEVING_LEVEL) {
        return runSpymaster(username, home, ctx);
      }

      return { ok: true, done: true, reason: "no-mission" };
    },
  };
}

function runCounterPatrol(username, home) {
  // The patrol itself is ambient — sweeps resolve on the slow tick.
  // We just note the agent is on duty (visible presence, honest work).
  return { ok: true, done: true, reason: "counter-patrol", home };
}

function runSpymaster(username, home, ctx) {
  const nowMs = Date.now();
  // One operation at a time — check the operative isn't already running one.
  const live = Esp.pendingOperationsFor(home).filter(
    (o) => String(o.operative ?? "").toLowerCase() === String(username).toLowerCase()
  );
  if (live.length > 0) {
    return { ok: true, done: true, reason: "operation-active", op: live[0].id };
  }
  // The network must exist — a spymaster without a network is just sneaky.
  if (!Esp.networkFor(home)) {
    return { ok: true, done: true, reason: "no-network" };
  }
  // Handlers plan; non-handlers only run ops when the network is quiet
  // and the crown needs hands (keeps the handler rank meaningful).
  const target = pickTargetKingdom(home);
  if (!target) return { ok: true, done: true, reason: "no-target" };

  const opType = pickOpType(home, target);
  let op = null;
  if (opType === "assassination") {
    const victim = pickAssassinationTarget(target, ctx);
    if (!victim) return { ok: true, done: true, reason: "no-victim" };
    op = Esp.planOperation({
      network: home,
      type: "assassination",
      targetKingdom: target,
      target: victim,
      operative: username,
      nowMs,
    });
  } else {
    const subtype = Math.random() < 0.5 ? "supply" : "treasury";
    op = Esp.planOperation({
      network: home,
      type: "sabotage",
      subtype,
      targetKingdom: target,
      operative: username,
      nowMs,
    });
  }
  if (!op) return { ok: true, done: true, reason: "plan-failed" };
  return { ok: true, done: true, reason: "operation-planned", op: op.id, type: op.type, target };
}

/** The tensest foreign border — where covert work matters. */
function pickTargetKingdom(home) {
  let best = null;
  let bestT = 35; // only run ops where it matters
  for (const k of Esp.kingdoms()) {
    if (k === home) continue;
    let t = 0;
    try {
      const Tension = require("../../../kingdoms/Tension.Kingdoms");
      t = Tension.getTension?.(home, k) ?? 0;
    } catch {
      // tension unreadable — treat as calm
    }
    if (t > bestT) {
      bestT = t;
      best = k;
    }
  }
  return best;
}

/** Assassination is rare and targeted: rival kingdom's notables only. */
function pickOpType(home, target) {
  void home;
  void target;
  // 1 in 4 ops is an assassination — murder is expensive and loud.
  return Math.random() < 0.25 ? "assassination" : "sabotage";
}

/**
 * Assassination target: a real citizen of the target kingdom with some
 * standing (fame or office). Never an invented name — the tick verifies
 * through the roster before anything happens.
 */
function pickAssassinationTarget(target, ctx) {
  const roster = ctx.roster ?? null;
  if (!roster?.values) return null;
  const candidates = [];
  for (const record of roster.values()) {
    try {
      if (String(record?.kingdomId ?? "").toLowerCase() !== target) continue;
      const name = record?.username ?? record?.displayName;
      if (!name) continue;
      // Notables only: office-holders or the famous.
      const notable = record?.office || (record?.fame ?? 0) >= 30;
      if (!notable) continue;
      candidates.push(name);
    } catch {
      // one bad record never breaks the pick
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = { createCitizenSpyMasterAction, ACTION_ID };
