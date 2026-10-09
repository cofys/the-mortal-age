"use strict";

/**
 * CitizenAthleticsEvents — player-facing athletics: the ::athletics command.
 *
 * Mirrors the ::stage / ::dig / ::spy command pattern (PlayerRights.NONE
 * so every player can use it). Players can list stadiums and athletes,
 * register as an athlete, train, check fitness, and view records. Bots
 * are rejected: citizens train through the brain, not the command.
 */

const Athletics = require("./lib/CitizenAthletics");

const ATHLETICS_USAGE =
  "::athletics [stadiums|athletes|register <sport>|train|fitness|records [sport]]";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function isRealPlayer(player) {
  try {
    // Engine truth: Player#isPlayerBot() (server/src/main/typescript/elvarg/game/entity/impl/player/Player.ts:1084)
    // returns true for bot entities. The `?? false` fallback is deliberate: gate
    // call sites always receive a live command entity, so isPlayerBot() is always
    // callable there; the fallback preserves the legacy pass-through for anything
    // that isn't a known bot instead of silently blocking a new class of callers.
    return !(player?.isPlayerBot?.() ?? false);
  } catch {
    return true;
  }
}

function say(player, text) {
  try {
    player?.sendMessage?.(text);
  } catch {
    // messaging is best-effort
  }
}

function kingdomOf(player) {
  try {
    const { kingdomIdOf } = require("./lib/../brain/CitizenSites");
    return kingdomIdOf(player) || null;
  } catch {
    return null;
  }
}

const KINGDOM_IDS = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"];

function onAthleticsCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens train through their own discipline, not this command.");
    return;
  }
  const username = usernameOf(player);
  const kingdomId = kingdomOf(player);
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "stadiums").toLowerCase();

  switch (sub) {
    case "stadiums": {
      const lines = [];
      for (const kid of KINGDOM_IDS) {
        const s = Athletics.stadiumFor(kid);
        if (!s) continue;
        lines.push(`${kid}: ${s.capacity} seats, condition ${s.condition}%`);
      }
      say(player, lines.length ? lines.join(" | ") : "No stadiums yet.");
      return;
    }
    case "athletes": {
      const list = Athletics.athletesIn(kingdomId, 10);
      if (!list.length) { say(player, "No registered athletes."); return; }
      say(player, list.map((a) => `${a.name} (${a.sport}, fitness ${a.fitness})`).join(" | "));
      return;
    }
    case "register": {
      const sport = (parts[1] || "").toLowerCase();
      if (!Athletics.SPORTS.includes(sport)) {
        say(player, `Sports: ${Athletics.SPORTS.join(", ")}. Usage: ::athletics register <sport>`);
        return;
      }
      Athletics.registerAthlete(username, sport);
      say(player, `Registered as an athlete in ${Athletics.SPORT_LABELS[sport]}. Train at the stadium!`);
      return;
    }
    case "train": {
      if (!Athletics.isAthlete(username)) {
        say(player, "Register first: ::athletics register <sport>");
        return;
      }
      if (!kingdomId || !Athletics.stadiumFor(kingdomId)) {
        say(player, "No stadium in this kingdom yet.");
        return;
      }
      Athletics.trainAthlete(username, Date.now());
      const a = Athletics.athleteInfo(username);
      say(player, `Training complete. Fitness ${a.fitness}/${Athletics.FITNESS_MAX}, skill ${a.skill}.`);
      return;
    }
    case "fitness": {
      const f = Math.round(Athletics.fitnessFor(username) * 100);
      say(player, `Your fitness: ${f}%.`);
      return;
    }
    case "records": {
      const sport = (parts[1] || "").toLowerCase();
      const lines = [];
      const sports = sport && Athletics.SPORTS.includes(sport) ? [sport] : Athletics.SPORTS;
      for (const kid of KINGDOM_IDS) {
        for (const sp of sports) {
          const r = Athletics.recordFor(kid, sp);
          if (r) lines.push(`${kid} ${sp}: ${r.holder} (${r.mark})`);
        }
      }
      say(player, lines.length ? lines.join(" | ") : "No records set yet.");
      return;
    }
    default:
      say(player, ATHLETICS_USAGE);
  }
}

module.exports = { onAthleticsCommand, ATHLETICS_USAGE };
