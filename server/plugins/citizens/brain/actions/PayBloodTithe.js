"use strict";

/**
 * PayBloodTithe — the debtor's trip to Sarev's tithe office. The citizen
 * walks to the tithe office (Canifis, 3496,3472 — the regime's face, owned
 * by the Myreque plugin), pays through the BloodTithe engine's collectTithe
 * (real purse debit, real ledger clear), and walks away.
 *
 * Design law (human player model): paying is a utility calculation made in
 * the scorer (debt vs purse vs personality), not a script. The trip is
 * interruptible — decisionTick re-evaluates every ~25-45s for critical
 * needs, so a debtor who gets hungry or hurt abandons the trip like a real
 * player would. Payment goes through the engine's collectTithe so the
 * ledger, the treasury split, and the events stay single-sourced.
 */

const { playerState } = require("../../../bots/brain/ActionState.PlayerBots.js");
const { requestMovement } = require("../../../bots/behaviours/navigation/Navigation.PlayerBots.js");
const {
  agentRng,
  logNormalJitter,
  humanizerProfile,
  personalSpot,
} = require("../../lib/humanizer");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");

// Sarev's tithe office — one regime face, reused, never duplicated.
const TITHE_OFFICE = { x: 3496, y: 3472, z: 0 };
const DEBT_FLAG_PREFIX = "morytania:blood-tithe:debt:";

const ARRIVE_RADIUS = 4;
const PAY_GIVE_UP_MS = 10 * 60 * 1000;

const PAY_LINES = Object.freeze({
  plain: Object.freeze([
    "Paid. The court's got its blood money — for now.",
    "There's your tithe, officer. May it choke you.",
    "Paid in full. One round bought. See you at the next.",
    "The ledger's clear. My purse isn't.",
  ]),
  terse: Object.freeze([
    "paid. there. happy?",
    "tithe's paid. leave me be.",
    "ledger's clear. purse ain't.",
  ]),
});

function debtOf(username) {
  if (!username) return 0;
  try {
    const KingdomStore = require("../../../kingdoms/KingdomStore");
    const flags = KingdomStore.getKingdom?.("morytania")?.flags ?? {};
    // The engine keys debt flags by lowercased username — match it exactly.
    return Math.max(
      0,
      Math.floor(Number(flags[DEBT_FLAG_PREFIX + String(username).toLowerCase()] ?? 0))
    );
  } catch {
    return 0;
  }
}

function distanceTo(player, tile) {
  try {
    const loc = player.getLocation?.();
    if (!loc || !tile) return Number.MAX_SAFE_INTEGER;
    const dx = loc.getX() - tile.x;
    const dy = loc.getY() - tile.y;
    return Math.sqrt(dx * dx + dy * dy);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function createPayBloodTitheAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`paytithe:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        startedAt: 0,
        walkedAt: 0,
        paid: false,
      };
    });
  }

  const action = {
    id: "payBloodTithe",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      if (!state.startedAt) state.startedAt = nowMs;
      if (nowMs - state.startedAt > PAY_GIVE_UP_MS) {
        return "failed"; // re-decidable — the citizen re-weighs it later
      }
      const username = player.getUsername?.() ?? null;
      const debt = debtOf(username);
      if (debt <= 0) {
        return "success"; // nothing owed (paid by the engine round or Sarev)
      }
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const spot = personalSpot(username ?? "debtor", TITHE_OFFICE.x, TITHE_OFFICE.y, 5, 5);

      if (distanceTo(player, spot) > ARRIVE_RADIUS) {
        // Walk to the office; re-issue occasionally in case of interruption.
        if (nowMs - state.walkedAt > 15000) {
          state.walkedAt = nowMs;
          try {
            requestMovement(player, spot.x, spot.y, {
              reason: "pay_blood_tithe",
              basicPather: true,
              z: TITHE_OFFICE.z,
            });
          } catch {
            return "failed";
          }
        }
        return "running";
      }

      if (state.paid) return "success";

      // At the office: pay through the engine — single-sourced ledger,
      // treasury split, and events. The engine handles shortfalls (refusal
      // event), so even a broke citizen's trip resolves to a real outcome.
      try {
        const BloodTithe = require("../../../kingdoms/BloodTithe.Kingdoms");
        const paid = BloodTithe.collectTithe(player, { emit: () => {} });
        state.paid = true;
        const line = voiceLine(voiceFor(personality), PAY_LINES, state.rng);
        sayPublic(player, line);
        return "success";
      } catch {
        // Engine unavailable — fail and let the scorer re-decide later.
        return "failed";
      }
    },
  };

  return action;
}

module.exports = {
  createPayBloodTitheAction,
};
