"use strict";

/**
 * MemoryDiag — temporary diagnostic plugin for the citizen memory leak.
 *
 * Every 5 minutes, logs:
 *  - process.memoryUsage() (rss, heapUsed, heapTotal, external)
 *  - Sizes of key citizen data structures
 *  - Count of live Player objects in World.players
 *  - Count of bot runtime entries
 *
 * This is a TEMPORARY diagnostic. Remove after the leak is fixed.
 */

let pluginApi = null;
let intervalId = null;

function countWorldPlayers() {
  try {
    const World = pluginApi?.core?.World;
    if (!World?.players) return -1;
    if (typeof World.players.size === "function") return World.players.size();
    if (typeof World.players.length === "number") return World.players.length;
    let count = 0;
    try {
      for (const _ of World.players) count++;
      return count;
    } catch {
      return -2;
    }
  } catch {
    return -3;
  }
}

function safeSize(map) {
  try {
    if (!map) return -1;
    if (typeof map.size === "number") return map.size;
    if (typeof map.length === "number") return map.length;
    return -2;
  } catch {
    return -3;
  }
}

function runDiagnosis() {
  try {
    const mu = process.memoryUsage();
    const report = {
      rssMB: Math.round(mu.rss / 1048576),
      heapUsedMB: Math.round(mu.heapUsed / 1048576),
      heapTotalMB: Math.round(mu.heapTotal / 1048576),
      externalMB: Math.round(mu.external / 1048576),
      worldPlayers: countWorldPlayers(),
    };

    try {
      const { getDirector } = require("../citizens/director/CitizenDirector");
      const director = getDirector?.();
      if (director) {
        report.rosterSize = safeSize(director.roster);
        let online = 0;
        for (const record of director.roster?.values?.() ?? []) {
          if (director.isOnline?.(record)) online++;
        }
        report.citizensOnline = online;
        const runtime = director.runtime?.();
        report.botEntries = safeSize(runtime?.entriesByUsername);
        report.botStates = safeSize(runtime?.botStatesByName);
      }
    } catch (e) {
      report.directorError = String(e?.message ?? e).slice(0, 100);
    }

    try {
      const { getJournal } = require("../citizens/lib/CitizenJournal");
      const journal = getJournal?.();
      report.journalCitizens = safeSize(journal?.records ?? journal?.store);
    } catch (e) {
      report.journalError = String(e?.message ?? e).slice(0, 100);
    }

    try {
      const { getMemory } = require("../citizens/lib/CitizenMemory");
      const mem = getMemory?.();
      report.memoryCitizens = safeSize(mem?.records ?? mem?.store);
    } catch (e) {
      report.memoryError = String(e?.message ?? e).slice(0, 100);
    }

    console.log("[memory-diag] " + JSON.stringify(report));
  } catch (error) {
    try {
      console.log("[memory-diag] failed: " + String(error?.message ?? error));
    } catch {
      // Ignore.
    }
  }
}

function startDiagnostics() {
  setTimeout(runDiagnosis, 30000);
  intervalId = setInterval(runDiagnosis, 5 * 60 * 1000);
  if (intervalId.unref) intervalId.unref();
  console.log("[memory-diag] diagnostic started (5-min interval)");
}

function stopDiagnostics() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  pluginApi = null;
}

module.exports = {
  name: "MemoryDiag",
  register(api) {
    pluginApi = api;
    api.onServerStartup(startDiagnostics);
    api.onServerShutdown(stopDiagnostics);
  },
};
