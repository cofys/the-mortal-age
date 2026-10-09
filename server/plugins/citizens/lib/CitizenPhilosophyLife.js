"use strict";

/**
 * CitizenPhilosophyLife — slow-tick dynamics for the philosophy system.
 *
 * Runs in the CitizenDirector slow tick (never in the fast path):
 *   - Weekly debates: each kingdom's academy holds a public debate when
 *     the cooldown expires and 2+ eligible philosophers exist. The winner
 *     is picked by wisdom (deterministic, no RNG in tests via injectable).
 *     Announced via sayPublic near real players.
 *   - Sage announcements: when a philosopher first crosses the sage
 *     threshold (wisdom 80), announce it realm-wide near players.
 *   - Teaching: philosophers with wisdom 50+ who are online may teach
 *     in schools, granting pupils a small wisdom bonus.
 *
 * All engine access is defensive — missing modules degrade silently.
 * Never throws.
 */

const Philosophy = require("./CitizenPhilosophy");

function _journal(director, event) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(event);
  } catch {
    // Journal unavailable — skip.
  }
}

function _sayPublic(director, text) {
  try {
    if (typeof director.sayPublic === "function") {
      director.sayPublic(text);
    }
  } catch {
    // Speech unavailable — skip.
  }
}

// Pick debate participants: eligible philosophers in the kingdom, up to 4.
// Sorted by wisdom descending for deterministic selection.
function _pickDebaters(kingdomId, director) {
  try {
    const roster = director.roster ? [...director.roster.values()] : [];
    const philosophers = Philosophy.philosophersInKingdom(kingdomId, roster);
    const eligible = philosophers.filter((p) => Philosophy.canDebate(p.username));
    eligible.sort((a, b) => b.wisdom - a.wisdom);
    return eligible.slice(0, 4).map((p) => p.username);
  } catch {
    return [];
  }
}

// Debate topics per school pairing (flavor, deterministic).
const DEBATE_TOPICS = Object.freeze([
  "the nature of the good life",
  "whether virtue can be taught",
  "the role of the gods in mortal affairs",
  "whether pleasure is the highest good",
  "the meaning of justice",
  "whether wisdom brings happiness",
  "the nature of courage",
  "whether the unexamined life is worth living",
]);

function _pickTopic(debateCount) {
  return DEBATE_TOPICS[debateCount % DEBATE_TOPICS.length];
}

function tickPhilosophy(director, nowMs) {
  try {
    const now = nowMs || Date.now();
    const kingdoms = _kingdomIds(director);

    for (const kingdomId of kingdoms) {
      // Weekly debates
      if (Philosophy.shouldHoldDebate(kingdomId, now)) {
        const debaters = _pickDebaters(kingdomId, director);
        if (debaters.length >= 2) {
          const academy = Philosophy.academyFor(kingdomId);
          const topic = _pickTopic(academy.debateCount);

          // Winner: highest wisdom (deterministic). Ties broken by order.
          let winner = debaters[0];
          let bestWisdom = Philosophy.wisdomFor(winner);
          for (const debater of debaters.slice(1)) {
            const w = Philosophy.wisdomFor(debater);
            if (w > bestWisdom) {
              bestWisdom = w;
              winner = debater;
            }
          }

          const debate = Philosophy.scheduleDebate(kingdomId, debaters, topic, now);
          // Resolve immediately: record the outcome in the debate + philosopher records.
          const losers = debaters.filter((p) => p !== winner);
          Philosophy.recordDebate(winner, losers);
          debate.winner = winner;
          Philosophy.save();

          // Announce near real players
          const winnerPhil = Philosophy.philosopherFor(winner);
          const schoolName = winnerPhil
            ? (Philosophy.schoolFor(winnerPhil.school)?.name || "")
            : "";
          _sayPublic(
            director,
            `${winner} of the ${schoolName} wins the debate on ${topic}!`
          );
          _journal(director, {
            type: "philosophy-debate",
            kingdomId,
            winner,
            school: winnerPhil?.school || null,
            topic,
            participants: debaters,
            at: now,
          });

          // Fame deed for the winner
          _awardFame(director, winner, "debater", 4);
        }
      }
    }

    // Sage announcements (first crossing only — tracked via announced flag)
    _announceNewSages(director, now);
  } catch {
    // Never throw from the slow tick.
  }
}

function _announceNewSages(director, nowMs) {
  try {
    const sages = Philosophy.topSages(100);
    for (const sage of sages) {
      if (sage.wisdom >= Philosophy.WISDOM_SAGE && !sage.sageAnnounced) {
        sage.sageAnnounced = true;
        Philosophy.save(); // persist the flag via dirty mechanism
        _markSageAnnounced(sage.username);
        _sayPublic(
          director,
          `${sage.username} has attained the wisdom of a sage!`
        );
        _journal(director, {
          type: "philosophy-sage",
          username: sage.username,
          school: sage.school,
          wisdom: sage.wisdom,
          at: nowMs,
        });
        _awardFame(director, sage.username, "sage", 8);
      }
    }
  } catch {
    // Never throw.
  }
}

function _markSageAnnounced(username) {
  try {
    const phil = Philosophy.philosopherFor(username);
    if (phil) {
      phil.sageAnnounced = true;
      // Force dirty via a no-op wisdom add
      Philosophy.addWisdom(username, 0);
    }
  } catch {
    // Skip.
  }
}

function _awardFame(director, username, deedKind, points) {
  try {
    const Reputation = require("./CitizenReputation");
    if (typeof Reputation.awardDeed === "function") {
      Reputation.awardDeed(username, deedKind, points);
    }
  } catch {
    // Reputation unavailable — skip.
  }
}

function _kingdomIds(director) {
  try {
    if (director.roster) {
      const ids = new Set();
      for (const record of director.roster.values()) {
        if (record && record.kingdomId) ids.add(String(record.kingdomId));
      }
      if (ids.size) return [...ids];
    }
  } catch {
    // Fall through.
  }
  return ["default"];
}

module.exports = {
  tickPhilosophy,
};
