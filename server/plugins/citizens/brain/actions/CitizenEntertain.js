"use strict";

/**
 * CitizenEntertain — have a drink at the tavern, play dice, enjoy the
 * music. The RuneScape way: citizens unwind like players do.
 *
 * Citizens walk to their kingdom's tavern, buy a real ale with real coins,
 * maybe play dice (real bets, real wins/losses), and soak in the bard's
 * music if one's playing. Mood goes up; drunkenness too — too many ales
 * and the citizen gets a work penalty like the plague's little brother.
 *
 * Flow per tick:
 *   - Walk to tavern (siteTile "tavern").
 *   - Buy a drink if affordable (buyDrink — real coins).
 *   - Maybe play dice if feeling lucky (playDice — real bets).
 *   - If a bard is performing, enjoy it (enjoyPerformance).
 *   - Done after a good time -> "success" (brain re-decides).
 *   - Give up after GIVE_UP_MS so a bad night never stalls the day.
 *
 * Non-repeat: works one night out, then the brain re-decides.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

// If nothing fun happens in this long, the tavern is cursed — move on.
const GIVE_UP_MS = 10 * 60 * 1000;
const TAVERN_ARRIVE_RADIUS = 4;
// Human pacing between drinks — nobody downs five ales in a minute.
const DRINK_COOLDOWN_MS = 45000;
const DICE_COOLDOWN_MS = 60000;

function entertainLib() {
  try {
    return require("../../lib/CitizenEntertainment");
  } catch {
    return null;
  }
}

function dist(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x ?? 0) - (b.x ?? 0);
  const dy = (a.y ?? 0) - (b.y ?? 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function playerTile(player) {
  try {
    const pos = player?.getPosition?.() ?? player?.getTile?.();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      return { x: pos.x, y: pos.y, z: pos.z ?? 0 };
    }
  } catch {
    // fall through
  }
  return null;
}

function createCitizenEntertainAction(spec, world) {
  const rng = agentRng(spec?.citizen?.username ?? "tavern");
  const profile = humanizerProfile(spec?.citizen?.username ?? "tavern");
  const startedAt = Date.now();
  let lastDrinkAt = 0;
  let lastDiceAt = 0;
  let arrived = false;

  function failFast() {
    // No entertainment lib — nothing to do.
    return !entertainLib();
  }

  return {
    id: "citizenEntertain",
    tick(player, ctx) {
      const st = playerState(player);
      const Entertain = entertainLib();
      if (!Entertain) return "success";

      // Give up after a bad night.
      if (Date.now() - startedAt > GIVE_UP_MS) {
        try {
          clearMovementRequest(player);
        } catch {
          // best-effort
        }
        return "success";
      }

      // Walk to the tavern.
      const tavern = siteTile(player, "tavern");
      if (!tavern) return "success";
      const here = playerTile(player);
      if (!arrived && here && dist(here, tavern) > TAVERN_ARRIVE_RADIUS) {
        try {
          // Add a personal spot offset so citizens don't stack.
          const spot = personalSpot(player, tavern, 3);
          requestMovement(player, spot ?? tavern);
        } catch {
          // movement is best-effort
        }
        return "running";
      }
      arrived = true;
      try {
        clearMovementRequest(player);
      } catch {
        // best-effort
      }

      const now = Date.now();
      const personality = (() => {
        try {
          return player?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
        } catch {
          return {};
        }
      })();
      const sociable = personality?.sociable ?? personality?.extroverted ?? 0.5;
      const lucky = personality?.lucky ?? personality?.riskTaking ?? 0.3;

      // Buy a drink (human-paced).
      if (now - lastDrinkAt > DRINK_COOLDOWN_MS * (profile?.pace ?? 1)) {
        // Don't get too drunk — stop at 3 drinks unless very sociable.
        const drunk = Entertain.drunkennessOf(player?.getUsername?.() ?? "");
        const maxDrinks = sociable > 0.7 ? 4 : 3;
        const drinks = Math.floor(drunk / Entertain.DRUNK_PER_DRINK);
        if (drinks < maxDrinks) {
          const result = Entertain.buyDrink(player?.getUsername?.() ?? "", player);
          if (result.ok) {
            lastDrinkAt = now;
          } else if (result.reason === "broke") {
            // Can't afford drinks — maybe dice is cheaper? No, dice needs
            // 10+. Just enjoy the atmosphere.
            lastDrinkAt = now; // don't retry immediately
          }
        }
      }

      // Play dice (if feeling lucky and can afford it).
      if (now - lastDiceAt > DICE_COOLDOWN_MS && rng() < lucky) {
        const bet = Entertain.DICE_MIN_BET + Math.floor(rng() * (Entertain.DICE_MAX_BET - Entertain.DICE_MIN_BET));
        const result = Entertain.playDice(player?.getUsername?.() ?? "", player, bet, rng);
        if (result.ok) {
          lastDiceAt = now;
        }
      }

      // Done after a good time — had at least one drink or played dice.
      if (lastDrinkAt > 0 || lastDiceAt > 0) {
        // Stay a while longer if very sociable.
        if (sociable > 0.8 && now - Math.max(lastDrinkAt, lastDiceAt) < 120000) {
          return "running";
        }
        return "success";
      }

      // Nothing affordable — just soak in the atmosphere for a bit.
      if (now - startedAt > 120000) {
        return "success";
      }
      return "running";
    },
  };
}

module.exports = {
  createCitizenEntertainAction,
};
