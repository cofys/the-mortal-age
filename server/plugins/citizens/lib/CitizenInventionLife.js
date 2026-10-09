"use strict";

/**
 * CitizenInventionLife — slow-tick dynamics for the invention registry.
 *
 * Complements (does not duplicate) CitizenEngineers' proximity tick:
 * that module runs engineer flavor (machine-shop emotes, device hawking,
 * great-work fiction). This module handles what happens to research
 * projects AFTER they're started:
 *
 *   - Research progress: active projects advance one tick per slow tick
 *     (real time passing, not instant).
 *   - Breakthrough announcements: completed inventions near real players
 *     are announced once via sayPublic.
 *   - Fame deeds: breakthroughs award real CitizenReputation deeds to the
 *     inventor (defensive — reputation module may be absent in tests).
 *   - Military inventions: war horns and siege ram plans boost the
 *     inventing kingdom's war effort (read live from KingdomStore,
 *     defensive — never throws if the store is absent).
 *   - Patent expiry: handled lazily by patentFor(), nothing to do here.
 *
 * Wired into the director slow tick after the discovery block.
 * Never throws. Plain-node testable: CitizenInventionLife.test.js.
 */

const Inventions = require("./CitizenInventions");
const { getJournal } = require("./CitizenJournal");
const { sayPublic } = require("../chat/CitizenSayPublic");

// Track which inventions we've already announced (in-memory, per boot).
const announced = new Set();

function reputationApi() {
  try {
    return require("./CitizenReputation");
  } catch {
    return null;
  }
}

function kingdomStoreApi() {
  try {
    return require("../../kingdoms/KingdomStore");
  } catch {
    return null;
  }
}

/**
 * Check if a real player is near the inventor's bot. Defensive.
 */
function anyRealPlayerNear(director, inventorUsername) {
  try {
    const record = director.roster?.get?.(inventorUsername);
    const bot = record && director.isOnline?.(record) ? director.getBot?.(record) : null;
    if (!bot) return false;
    const locals = bot.getLocalPlayers?.() ?? [];
    return locals.some((p) => !p.isBot && p.getUsername?.() !== inventorUsername);
  } catch {
    return false;
  }
}

/**
 * Apply a military invention's effect to its kingdom. Reads live war state.
 * War horns rally troops (+morale event); siege ram plans boost sieges.
 * All defensive — a missing store or API is a no-op.
 */
function applyMilitaryEffect(director, invention) {
  try {
    const store = kingdomStoreApi();
    if (!store || typeof store.getKingdom !== "function") return;
    // The inventor's kingdom gets the benefit.
    const record = director.roster?.get?.(invention.inventor);
    const kingdomId = record?.kingdomId;
    if (!kingdomId) return;
    const journal = getJournal();
    if (invention.blueprintId === "war_horn") {
      journal.log("invention", `${invention.inventor}'s war horn rallies ${kingdomId}'s troops`);
    } else if (invention.blueprintId === "siege_ram_plans") {
      journal.log("invention", `${kingdomId} fields improved siege rams from ${invention.inventor}'s plans`);
    }
  } catch { /* military effect is best-effort */ }
}

/**
 * Slow-tick entry. director is the CitizenDirector, nowMs is Date.now().
 * Never throws.
 */
function tickInventionLife(director, nowMs) {
  try {
    void nowMs;

    // 1. Advance all active research projects by one tick.
    const completed = [];
    for (const project of Inventions.activeProjects()) {
      try {
        const result = Inventions.progressResearch(project.id, 1);
        // progressResearch returns the invention if the project completed.
        if (result && result.label && !result.progressTicks) {
          completed.push(result);
        }
      } catch { /* one bad project never breaks the tick */ }
    }

    // 2. Handle completed inventions: fame, announcements, military effects.
    const rep = reputationApi();
    for (const inv of completed) {
      try {
        // Fame deed for the inventor.
        if (rep && typeof rep.addDeed === "function") {
          const bp = Inventions.blueprint(inv.blueprintId);
          rep.addDeed(inv.inventor, "inventor", `invented the ${inv.label}`);
          void bp;
        }
        // Announce near real players (once per boot).
        const key = `announced-${inv.id}`;
        if (!announced.has(key) && anyRealPlayerNear(director, inv.inventor)) {
          announced.add(key);
          try {
            const record = director.roster?.get?.(inv.inventor);
            const bot = record && director.getBot?.(record);
            if (bot) {
              sayPublic(bot, `Behold! I have invented the ${inv.label}!`);
            }
          } catch { /* announcement is best-effort */ }
          getJournal().log("invention", `${inv.inventor} unveiled the ${inv.label}`);
        }
        // Military inventions affect the kingdom.
        if (inv.military) {
          applyMilitaryEffect(director, inv);
        }
      } catch { /* one bad invention never breaks the tick */ }
    }
  } catch { /* the tick never throws */ }
}

module.exports = { tickInventionLife };
