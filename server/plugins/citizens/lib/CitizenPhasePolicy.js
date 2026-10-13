"use strict";

/**
 * CitizenPhasePolicy — pure decision logic for the director's slow tick.
 *
 * Whether the director should force a citizen onto the phase activity.
 * Commoners run their own day via citizen_routine (the brain's utility picker
 * and interrupts own their activities); the director only sleeps them.
 * Re-asserting the static spawn activity for commoners clobbers every
 * interrupt-driven switch (routine, chop, fish, meal...) back to
 * safetynet_wander on the next 60s tick, oscillating citizens forever so
 * they never settle into visible work.
 *
 * 2026-10-13: Draynor fishing consistency fix.
 */

const { ROLE_COMMONER } = require("../constants");

function shouldReassertPhase(record, phase) {
  if (!phase.activityId || phase.activityId === record.currentActivityId) {
    return false;
  }
  return record.role !== ROLE_COMMONER;
}

module.exports = {
  shouldReassertPhase,
};
