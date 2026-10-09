"use strict";

/**
 * CitizenBank — the bank hinge as a first-class activity.
 *
 * The inventory clock: 28 slots fill in 5-15 minutes of work, and then a
 * player MUST bank. The decision layer picks citizen_bank when the pack is
 * nearly full -> walk to the kingdom bank (a real sites.json anchor) -> the
 * shared bank action finds a real booth via object search and deposits ->
 * done, and the brain re-decides (usually back to work).
 *
 * Non-repeat: it completes and the brain re-decides. Banking is punctuation
 * between activities — never the point, always the hinge.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { createBankAction } = require("../../../bots/brain/actions/Bank");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

const ARRIVE_RADIUS = 8;
// If no booth is reachable the hinge still ends — never stall the day.
const GIVE_UP_MS = 4 * 60 * 1000;

function atTile(player, tile, radius) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function walkTo(player, tile, username) {
  // Personal spot near the bank — eighteen citizens banking should not
  // stand on the same tile. Stable per citizen, like a favorite booth.
  const spot = personalSpot(username, tile.x, tile.y, 4, 10);
  requestMovement(player, spot.x, spot.y, {
    reason: "citizen_bank",
    basicPather: true,
    z: tile.z ?? 0,
  });
}

function createCitizenBankAction(spec, world) {
  // until.inventoryFull:false — deposit whatever is there, don't require a
  // full pack (the decision layer already decided the hinge is due).
  const bankDelegate = createBankAction({ until: { inventoryFull: false } }, world);

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`bank:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        started: false,
      };
    });
  }

  const action = {
    id: "citizenBank",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      const bank = siteTile(player, "bank");
      if (!bank) {
        return "failed"; // no bank anchor for this kingdom
      }
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (!state.started) {
        if (!atTile(player, bank, ARRIVE_RADIUS)) {
          walkTo(player, bank, player.getUsername?.() ?? "unknown");
          return "running";
        }
        state.started = true;
      }
      if (nowMs >= state.giveUpAt) {
        bankDelegate.stop?.(ctx);
        return "success";
      }
      const result = bankDelegate.update(ctx);
      if (result === "success") {
        bankDelegate.stop?.(ctx);
        world?.log?.("citizen_bank_trip", {
          citizen: player.getUsername?.(),
          kingdom: kingdomIdOf(player),
        });
        return "success";
      }
      if (result === "failed") {
        bankDelegate.stop?.(ctx);
        return "success"; // booth unreachable — hinge ends, day goes on
      }
      return "running";
    },
    stop(ctx) {
      try {
        bankDelegate.stop?.(ctx);
      } catch {
        // Best effort.
      }
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  return action;
}

module.exports = {
  createCitizenBankAction,
};
