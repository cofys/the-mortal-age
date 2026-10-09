"use strict";

/**
 * CitizenEspionageLife — the slow-tick dynamics for the citizen espionage
 * layer: operation advancement, counter-intelligence sweeps, cell upkeep,
 * and announcements.
 *
 * WHAT IT DOES (wired into the director slow tick, try/catch, never throws):
 *   - Operations: planning ops activate after PLANNING_MS; active ops
 *     resolve with their real effects (CitizenEspionage.resolveOperation).
 *   - Counter-intel sweeps: each kingdom's counter-agents get a sweep
 *     roll against enemy cells and active enemy operations in their home
 *     kingdom. Caught spies are interrogated automatically (the crown
 *     wants names), which burns their cells and reveals live operations.
 *   - Cell upkeep: cells whose operative has an active CitizenDiplomacy
 *     passive mission feed noteIntel (fresh eyes = fresh intel).
 *   - Passive gather bridge: successful CitizenDiplomacy intel gathers
 *     feed the war-intel seam via noteIntel (read defensively — the
 *     diplomacy layer never knows this module exists).
 *   - Announcements: successful sabotage, assassinations, and caught spies
 *     are journaled; the dramatic ones go out via sayPublic where real
 *     players can hear them (throttled, template + facts only).
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. No invented operations, spies, or intel.
 *   - Never touches lib/*2 (frozen).
 */

const Esp = require("./CitizenEspionage");

// Counter-intel sweep: one sweep per agent per tick window at most.
const SWEEP_WINDOW_MS = 60 * 60 * 1000;
// Base chance a sweep catches a given enemy cell/op.
const SWEEP_CATCH_BASE = 0.12;

function sayPublicTo(director, username, text) {
  try {
    // director.getBot takes the RECORD ({username}), not a bare string;
    // and speech goes through the canonical CitizenSayPublic seam, which
    // only reaches chat boxes of nearby real players. (The old code called
    // getBot(username) — always null — then bot.sayPublic/director.sayPublic,
    // neither of which exists, so espionage speech never fired.)
    const bot = director?.getBot ? director.getBot({ username }) : null;
    if (!bot) return;
    const { sayPublic } = require("../chat/CitizenSayPublic");
    if (typeof sayPublic === "function") sayPublic(bot, text);
  } catch {
    // speech is best-effort
  }
}

function journal(director, username, text, data = {}) {
  try {
    // Canonical journal API: getJournal().log(citizenName, kind, text, opts).
    // (The old code called director.journal(...), which doesn't exist on
    // the real CitizenDirector, so every espionage journal entry silently
    // died. director.log only writes the server log, not the journal.)
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(username, "espionage", text, data);
  } catch {
    try {
      director?.log?.(`[espionage] ${text}`, data);
    } catch {
      // journaling is best-effort
    }
  }
}

function prettyKingdom(id) {
  return Esp.prettyKingdom(id);
}

function tickEspionage(director, nowMs = Date.now()) {
  advanceOperations(director, nowMs);
  counterIntelSweeps(director, nowMs);
  bridgePassiveIntel(director, nowMs);
  try {
    Esp.pruneIntel(nowMs);
  } catch {
    // pruning is housekeeping
  }
}

/** Planning -> active -> resolved, with announcements on the dramatic ones. */
function advanceOperations(director, nowMs) {
  let ops = [];
  try {
    const s = require("./CitizenEspionage");
    ops = pendingOpsSnapshot(s);
  } catch {
    return;
  }
  for (const op of ops) {
    try {
      if (op.state === "planning") {
        const activated = Esp.activateOperation(op.id, nowMs);
        if (activated) {
          journal(director, op.operative, `Shadows move against ${prettyKingdom(op.targetKingdom)}.`, {
            op: op.id,
            kind: op.type,
          });
        }
        continue;
      }
      if (op.state === "active") {
        // Hand the tick's roster/director to the data tier for the death path.
        const resolved = resolveWithContext(op.id, director, nowMs);
        if (!resolved) continue;
        announceOutcome(director, resolved);
      }
    } catch {
      // one bad op never breaks the tick
    }
  }
}

function pendingOpsSnapshot(Espionage) {
  const out = [];
  for (const k of Espionage.kingdoms()) {
    for (const op of Espionage.pendingOperationsFor(k)) out.push(op);
  }
  return out;
}

function resolveWithContext(opId, director, nowMs) {
  const op = Esp.operationById(opId);
  if (!op) return null;
  // Inject tick context for the assassination death path (defensive).
  op._director = director ?? null;
  try {
    op._roster = director?.roster ?? null;
  } catch {
    op._roster = null;
  }
  const resolved = Esp.resolveOperation(opId, nowMs);
  try {
    delete op._director;
    delete op._roster;
  } catch {
    // cleanup is best-effort
  }
  return resolved;
}

function announceOutcome(director, op) {
  const target = prettyKingdom(op.targetKingdom);
  if (op.outcome === "success") {
    awardDeed(op.operative, "ghost");
    if (op.type === "assassination") {
      const text = `${op.target} was assassinated in ${target}. The shadows claim another.`;
      journal(director, op.operative, text, { op: op.id, victim: op.target });
      sayPublicTo(director, op.operative, "The deed is done. No one saw me.");
    } else if (op.subtype === "supply") {
      const text = `A ${target} caravan was sabotaged on the road — cargo destroyed.`;
      journal(director, op.operative, text, { op: op.id });
    } else if (op.subtype === "treasury") {
      const text = `The ${target} treasury was robbed in the night. Coins missing.`;
      journal(director, op.operative, text, { op: op.id, stolen: op.coinsStolen ?? 0 });
    }
  } else if (op.outcome === "caught") {
    awardDeed(op.operative, "burned");
    const text = `A ${prettyKingdom(op.network)} spy was caught ${op.type === "assassination" ? "with a blade" : "with sabotage tools"} in ${target}!`;
    journal(director, op.operative, text, { op: op.id, spy: op.operative });
    sayPublicTo(director, op.operative, "They caught me. Run.");
    // The crown interrogates — names come out.
    try {
      const revealed = Esp.interrogate({ spy: op.operative, by: `${target} watch`, nowMs: Date.now() });
      if (revealed.length > 0) {
        journal(director, op.operative, `Under questioning, the captured spy named ${revealed.length} operation(s).`, {
          op: op.id,
          revealed,
        });
      }
    } catch {
      // interrogation is best-effort
    }
  }
  // "failed" ops die quietly — that's the point of covert work.
}

/**
 * Counter-intel sweeps: each kingdom's counter-agents roll against enemy
 * cells and active enemy operations inside their home kingdom.
 */
function counterIntelSweeps(director, nowMs) {
  for (const kingdom of Esp.kingdoms()) {
    let agents = [];
    try {
      agents = Esp.counterAgentsOf(kingdom);
    } catch {
      continue;
    }
    if (agents.length === 0) continue;
    // Throttle: one sweep per agent per window (tracked on the agent name).
    for (const agent of agents) {
      try {
        sweepForAgent(director, kingdom, agent, nowMs);
      } catch {
        // one bad sweep never breaks the tick
      }
    }
  }
}

const _lastSweep = new Map();

function sweepForAgent(director, kingdom, agent, nowMs) {
  const key = `${kingdom}:${String(agent).toLowerCase()}`;
  const last = _lastSweep.get(key) ?? 0;
  if (nowMs - last < SWEEP_WINDOW_MS) return;
  _lastSweep.set(key, nowMs);

  // Enemy cells operating inside this kingdom.
  let cells = [];
  try {
    cells = Esp.cellsIn(kingdom);
  } catch {
    cells = [];
  }
  for (const cell of cells) {
    if (cell.homeKingdom === kingdom) continue; // own cells are not the enemy
    const roll = EspionageRoll(`sweep:${cell.id}:${Math.floor(nowMs / SWEEP_WINDOW_MS)}`);
    let chance = SWEEP_CATCH_BASE;
    if (cell.underCover) chance *= 0.5; // diplomatic cover is good cover
    if (roll < chance) {
      try {
        Esp.recallCell(cell.id);
      } catch {
        // recall is best-effort
      }
      const text = `The ${prettyKingdom(kingdom)} watch unmasked a ${prettyKingdom(cell.homeKingdom)} spy!`;
      journal(director, agent, text, { cell: cell.id, spy: cell.spy });
      awardDeed(agent, "spycatcher");
      awardDeed(cell.spy, "burned");
      sayPublicTo(director, agent, "Found one. Take them quietly.");
      try {
        const revealed = Esp.interrogate({ spy: cell.spy, by: agent, nowMs });
        if (revealed.length > 0) {
          journal(director, cell.spy, `The unmasked spy talked: ${revealed.length} operation(s) exposed.`, {
            cell: cell.id,
            revealed,
          });
        }
      } catch {
        // interrogation is best-effort
      }
    }
  }
}

function EspionageRoll(seed) {
  let h = 2166136261;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Award a reputation deed, defensively. */
function awardDeed(username, deed) {
  try {
    require("./CitizenReputation").awardDeed?.(username, deed);
  } catch {
    // reputation unavailable — the deed is lost, the event stands
  }
}

/**
 * Bridge: successful CitizenDiplomacy passive gathers feed the war-intel
 * seam. Read defensively — the diplomacy layer never knows we exist.
 */
function bridgePassiveIntel(director, nowMs) {
  void director;
  let Dip = null;
  try {
    Dip = require("./CitizenDiplomacy");
  } catch {
    return;
  }
  try {
    for (const kingdom of Esp.kingdoms()) {
      const intel = Dip.latestIntelOn?.(kingdom);
      if (!intel?.gatheredAt) continue;
      if (nowMs - intel.gatheredAt > 24 * 60 * 60 * 1000) continue; // only fresh gathers
      const missionKingdoms = intel.homeKingdom;
      if (!missionKingdoms || !Esp.isKnownKingdom(missionKingdoms)) continue;
      Esp.noteIntel(missionKingdoms, kingdom, nowMs);
    }
  } catch {
    // the bridge is best-effort
  }
}

function resetForTests() {
  _lastSweep.clear();
}

module.exports = { tickEspionage, resetForTests };
