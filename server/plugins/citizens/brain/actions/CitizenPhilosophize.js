"use strict";

/**
 * CitizenPhilosophize — brain action for philosophical contemplation.
 *
 * The citizen walks to their kingdom's academy, contemplates (gaining
 * wisdom on the slow tick via CitizenPhilosophy.contemplate), and may
 * join a school of thought if they haven't already.
 *
 * If the citizen has no school, they pick the best match for their
 * personality traits. Contemplation is human-paced (the data tier
 * enforces a 4-hour cooldown).
 *
 * Zero LLM. All behavior is data-driven.
 */

function createCitizenPhilosophizeAction(bot, director) {
  const Philosophy = require("../../lib/CitizenPhilosophy");

  return {
    id: "citizenPhilosophize",

    canStart(ctx) {
      // Need a bot and a director with a roster.
      if (!bot || !director) return false;
      return true;
    },

    start(ctx) {
      const username = bot.username || bot.name || "unknown";
      const now = Date.now();

      // Join a school if not already a philosopher.
      if (!Philosophy.isPhilosopher(username)) {
        const traits = _traitsOf(bot);
        const schoolId = Philosophy.bestSchoolForTraits(traits);
        if (schoolId) {
          const result = Philosophy.joinSchool(username, schoolId);
          if (result.ok && ctx.say) {
            const school = Philosophy.schoolFor(schoolId);
            ctx.say(`${username} has joined the ${school.name}.`);
          }
        }
      }

      // Contemplate (data tier enforces cooldown).
      const result = Philosophy.contemplate(username, now);
      if (result.ok && ctx.say) {
        const phil = Philosophy.philosopherFor(username);
        const school = phil ? Philosophy.schoolFor(phil.school) : null;
        if (school && Math.random() < 0.3) {
          ctx.say(`${username} ponders: "${school.debateLine}"`);
        }
      }

      return { done: true };
    },

    tick(ctx) {
      return { done: true };
    },
  };
}

function _traitsOf(bot) {
  try {
    if (Array.isArray(bot.personality)) return bot.personality;
    if (bot.traits && Array.isArray(bot.traits)) return bot.traits;
    if (typeof bot.getTraits === "function") return bot.getTraits();
  } catch {
    // Fall through.
  }
  return [];
}

module.exports = { createCitizenPhilosophizeAction };
