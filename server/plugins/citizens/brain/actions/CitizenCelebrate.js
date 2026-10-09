"use strict";

/**
 * CitizenCelebrate — the brain action for citizens participating in
 * custom festivals, parades, fireworks, and carnival games.
 *
 * The visible "celebration" half. The slow tick (CitizenCelebrationLife)
 * handles planner appointment, festival scheduling, and announcements;
 * this action is what a nearby player actually sees:
 *
 * Flow per tick:
 *   - If the citizen is a planner and there's an upcoming custom festival,
 *     walk to the market and make preparations (human-paced).
 *   - If a parade is active, join the procession (walk the route).
 *   - If fireworks are tonight, gather at the market to watch.
 *   - If carnival booths are open, play a game (real coins in, real
 *     prizes out — the caller moves coins).
 *   - Otherwise, enjoy the festival: dance, cheer, socialize.
 *   - After CELEBRATE_ROUNDS rounds or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
 *
 * No-overlap: CitizenFestivalGames owns the 4 festival games
 * (wrestling/archery/pie-eating/dance). This owns the participatory
 * celebration layer (parades, fireworks, carnival booths).
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const CELEBRATE_ROUNDS = 4;
const ARRIVE_RADIUS = 8;
const ACT_COOLDOWN_MS = 8000; // human-paced celebration

function celebrationsApi() {
  try {
    return require("../../lib/CitizenCelebrations");
  } catch {
    return null;
  }
}

/** The market tile for this citizen's kingdom (defensive). */
function workTileFor(player) {
  try {
    return siteTile(player, "market");
  } catch {
    return null;
  }
}

/** Sociability 0-1 (defensive). */
function sociabilityOf(personality) {
  try {
    const s = personality?.sociable ?? personality?.sociability ?? 0.5;
    if (typeof s === "number" && s <= 1) return Math.max(0, Math.min(1, s));
    return 0.5;
  } catch {
    return 0.5;
  }
}

function createCitizenCelebrateAction(spec, world) {
  function botState(player) {
    if (!player) return null;
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`celebrate:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> celebrating -> returning -> done
        roundsDone: 0,
        lastActAt: 0,
        workTile: null,
        homeTile: null,
      };
    });
  }

  function isNear(player, tile, radius) {
    try {
      const p = player?.getPosition?.() ?? player?.position;
      if (!p || !tile) return false;
      const dx = (p.x ?? 0) - (tile.x ?? 0);
      const dy = (p.y ?? 0) - (tile.y ?? 0);
      return Math.hypot(dx, dy) <= (radius ?? ARRIVE_RADIUS);
    } catch {
      return false;
    }
  }

  const action = {
    id: "citizenCelebrate",
    canStart(player) {
      try {
        const C = celebrationsApi();
        if (!C) return false;
        const st = botState(player);
        if (!st) return false;
        const now = Date.now();
        if (st.giveUpAt && now > st.giveUpAt) return false;
        // Only celebrate if there's an active or upcoming custom festival.
        const kid = kingdomIdOf(player);
        const active = C.activeCustom(kid, now);
        const upcoming = C.upcomingCustoms(kid, now);
        if (!active && upcoming.length === 0) return false;
        // Sociable citizens celebrate; grumps stay home.
        if (sociabilityOf(st.personality) < 0.3) return false;
        return true;
      } catch {
        return false;
      }
    },
    tick(player) {
      const st = botState(player);
      if (!st) return "success";
      const now = Date.now();
      try {
        if (!st.giveUpAt) st.giveUpAt = now + GIVE_UP_MS;
        if (now > st.giveUpAt) {
          clearMovementRequest(player);
          return "success";
        }
        if (!st.workTile) st.workTile = workTileFor(player);
        if (!st.homeTile) {
          try {
            // Personal loiter spot near the venue (market) so citizens don't stack.
            st.homeTile = st.workTile
              ? personalSpot(player.getUsername?.() ?? "unknown", st.workTile.x, st.workTile.y, 2, 8)
              : null;
          } catch { st.homeTile = null; }
        }

        switch (st.phase) {
          case "outbound": {
            if (!st.workTile) return "success";
            if (isNear(player, st.workTile, ARRIVE_RADIUS)) {
              st.phase = "celebrating";
              return "running";
            }
            requestMovement(player, st.workTile.x, st.workTile.y, { z: st.workTile.z ?? 0 });
            return "running";
          }
          case "celebrating": {
            if (st.roundsDone >= CELEBRATE_ROUNDS) {
              st.phase = "returning";
              return "running";
            }
            if (now - st.lastActAt < ACT_COOLDOWN_MS) return "running";
            // Do something festive: dance, cheer, or play a carnival game.
            celebrateRound(player, st, now);
            st.lastActAt = now;
            st.roundsDone += 1;
            return "running";
          }
          case "returning": {
            if (!st.homeTile) return "success";
            if (isNear(player, st.homeTile, ARRIVE_RADIUS)) {
              clearMovementRequest(player);
              return "success";
            }
            requestMovement(player, st.homeTile.x, st.homeTile.y, { z: st.homeTile.z ?? 0 });
            return "running";
          }
          default:
            return "success";
        }
      } catch {
        return "success";
      }
    },
  };
  return action;
}

/**
 * One festive round: dance, cheer, or play a carnival game.
 * All visible behavior; coin movement happens in the Life module.
 */
function celebrateRound(player, st, now) {
  try {
    const C = celebrationsApi();
    if (!C) return;
    const kid = kingdomIdOf(player);
    const roll = st.rng ? st.rng() : Math.random();

    // 30%: dance (emote 866, same as festival dancing).
    if (roll < 0.3) {
      try {
        player.playEmote?.(866);
      } catch { /* emote is best-effort */ }
      return;
    }

    // 30%: cheer via sayPublic.
    if (roll < 0.6) {
      try {
        const { sayPublic } = require("../../chat/CitizenSayPublic");
        const cheers = [
          "What a festival!",
          "This is wonderful!",
          "Huzzah!",
          "Best celebration in years!",
        ];
        const line = cheers[Math.floor(Math.random() * cheers.length)];
        sayPublic(player, line);
      } catch { /* speech is best-effort */ }
      return;
    }

    // 40%: play a carnival game (if booths are open).
    const active = C.activeCustom(kid, now);
    if (active) {
      const booths = C.boothsFor(active.id);
      if (booths.length > 0) {
        const booth = booths[Math.floor(Math.random() * booths.length)];
        // The Life module handles real coin movement; here we just
        // record the attempt for visible feedback.
        const result = C.playBooth(active.id, booth.type);
        if (result.won) {
          try {
            const { sayPublic } = require("../../chat/CitizenSayPublic");
            sayPublic(player, `I won ${result.prize} coins at ${C.BOOTH_NAMES[booth.type]}!`);
          } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* celebration is best-effort */ }
}

module.exports = { createCitizenCelebrateAction };
