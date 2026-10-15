"use strict";

const { randomInRange } = require("../navigation/Navigation.PlayerBots");
const { getPvpProfile } = require("../pvp/PvpAssignment.PlayerBots");

function resolvePvpProfile(state) {
  return getPvpProfile(state?.pvp?.profileId);
}

function scheduleCombatAction(state, nowMs) {
  if (!state?.pvp) {
    return false;
  }
  const profile = resolvePvpProfile(state);
  state.pvp.nextActionAt =
    nowMs + randomInRange(profile.combatActionMs.min, profile.combatActionMs.max);
  return true;
}

function scheduleSpecReview(state, nowMs) {
  if (!state?.pvp) {
    return false;
  }
  const profile = resolvePvpProfile(state);
  state.pvp.nextSpecReviewAt =
    nowMs + randomInRange(profile.specReviewMs.min, profile.specReviewMs.max);
  return true;
}

function scheduleFreezeReview(state, nowMs) {
  if (!state?.pvp) {
    return false;
  }
  const profile = resolvePvpProfile(state);
  state.pvp.nextFreezeReviewAt =
    nowMs + randomInRange(profile.freezeReviewMs.min, profile.freezeReviewMs.max);
  return true;
}

function scheduleReviewTimers(state, nowMs) {
  if (!state?.pvp) {
    return false;
  }
  const profile = resolvePvpProfile(state);
  state.pvp.nextTargetReviewAt =
    nowMs + randomInRange(profile.targetReviewMs.min, profile.targetReviewMs.max);
  state.pvp.nextPrayerReviewAt =
    nowMs + randomInRange(profile.prayerReviewMs.min, profile.prayerReviewMs.max);
  scheduleSpecReview(state, nowMs);
  scheduleFreezeReview(state, nowMs);
  return true;
}

module.exports = {
  scheduleCombatAction,
  scheduleFreezeReview,
  scheduleSpecReview,
  scheduleReviewTimers,
};
