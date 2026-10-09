"use strict";

/**
 * CitizenBankGuild — the brain action for bankers'-association hall sessions.
 *
 * Complements (does not duplicate):
 *   - CitizenBankerWork (brain): walks to the bank branch and serves real
 *     customers — deposits, withdrawals, loans.
 *   - This action: guild MEMBERS walk to the kingdom's bankers'-association
 *     hall and hold hall sessions in human-paced rounds — auditors review
 *     the standards code and teach classes, clerks study. Non-members and
 *     suspended members honestly return home (the hall is members-only).
 *
 * Flow per tick:
 *   - Only guild members in good standing proceed. Others return home.
 *   - Walk to the guild-hall tile (near the bank branch).
 *   - Session rounds (human-paced 8s): auditors conduct review rounds;
 *     clerks study. Rounds are the visible social layer — real economics
 *     (dues, premiums, audits, claims) run on the slow life tick.
 *   - After SESSION_ROUNDS or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
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
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const SESSION_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const ROUND_COOLDOWN_MS = 8000; // human-paced sessions

function guildsApi() {
  try {
    return require("../../lib/CitizenBankGuilds");
  } catch {
    return null;
  }
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  try {
    const p = player.getPosition?.() ?? player.position;
    if (!p || !tile) return false;
    const dx = (p.x ?? 0) - tile.x;
    const dy = (p.y ?? 0) - tile.y;
    return Math.hypot(dx, dy) <= radius;
  } catch {
    return false;
  }
}

function walkTo(player, tile) {
  try {
    requestMovement(player, { x: tile.x, y: tile.y, z: tile.z ?? 0 });
  } catch {}
}

function stopWalking(player) {
  try {
    clearMovementRequest(player);
  } catch {}
}

function homeTileFor(player) {
  try {
    return siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
  } catch {
    return { x: 3200, y: 3200, z: 0 };
  }
}

function createCitizenBankGuildAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`bankguild:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> session -> returning -> done
        roundsDone: 0,
        lastRoundAt: 0,
        hallTile: null,
        homeTile: null,
        kingdomId: null,
        isMember: false,
        rank: null,
      };
    });
  }

  const action = {
    id: "citizenBankGuild",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Guilds = guildsApi();
      if (!Guilds) return "success"; // no guild system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        state.isMember = Guilds.isGuildMember(username);
        state.rank = Guilds.guildRankOf(username);
        if (!state.kingdomId || !state.isMember) {
          state.phase = "returning"; // members in good standing only
        } else {
          const guild = Guilds.ensureGuild(state.kingdomId);
          state.hallTile = guild?.hallTile ?? null;
          if (!state.hallTile) state.phase = "returning";
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.hallTile)) {
            stopWalking(player);
            state.phase = "session";
            state.lastRoundAt = nowMs - ROUND_COOLDOWN_MS; // first round immediately
            return "running";
          }
          walkTo(player, state.hallTile);
          return "running";
        }
        case "session": {
          if (state.roundsDone >= SESSION_ROUNDS) {
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastRoundAt < ROUND_COOLDOWN_MS) return "running";
          state.lastRoundAt = nowMs;
          state.roundsDone++;
          // Session content is the visible social layer: auditors review the
          // standards code and teach; clerks study. Real economics run on
          // the life tick.
          try {
            if (state.roundsDone === SESSION_ROUNDS && state.rank === Guilds.RANK_AUDITOR) {
              const { getJournal } = require("../../lib/CitizenJournal");
              getJournal().log?.("bankguild-session", {
                auditor: username, kingdomId: state.kingdomId,
              });
            }
          } catch { /* journaling is optional */ }
          return "running";
        }
        case "returning": {
          if (atTile(player, state.homeTile)) {
            stopWalking(player);
            return "success";
          }
          walkTo(player, state.homeTile);
          return "running";
        }
        default: {
          stopWalking(player);
          return "success";
        }
      }
    },
  };

  return action;
}

module.exports = { createCitizenBankGuildAction };
