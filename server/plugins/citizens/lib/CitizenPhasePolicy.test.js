"use strict";

/**
 * 2026-10-13: Draynor fishing consistency fix.
 *
 * Root cause: the director's 60s slow tick re-asserted phase.activityId
 * (always safetynet_wander for commoners, via desiredPhase) over the brain's
 * interrupt-driven switches. Citizens oscillated between citizen_routine /
 * citizen_chop / citizen_fish and safetynet_wander every ~60s, never settling
 * long enough to do visible work.
 *
 * Fix: shouldReassertPhase() returns false for commoners — the routine owns
 * their day; the director only sleeps them.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { shouldReassertPhase } = require("./CitizenPhasePolicy.js");

describe("shouldReassertPhase", () => {
  it("does NOT re-assert for commoners (brain owns their activities)", () => {
    const record = { role: "commoner", currentActivityId: "citizen_routine" };
    const phase = { online: true, activityId: "safetynet_wander" };
    assert.equal(shouldReassertPhase(record, phase), false);
  });

  it("does NOT re-assert for commoners on gather activities", () => {
    for (const activity of ["citizen_chop", "citizen_fish", "citizen_mine"]) {
      const record = { role: "commoner", currentActivityId: activity };
      const phase = { online: true, activityId: "safetynet_wander" };
      assert.equal(
        shouldReassertPhase(record, phase),
        false,
        `commoner on ${activity} should not be clobbered`
      );
    }
  });

  it("DOES re-assert for guards when phase changes (meal breaks, watches)", () => {
    const record = { role: "guard", currentActivityId: "guard_patrol" };
    const phase = { online: true, activityId: "tavern_social" };
    assert.equal(shouldReassertPhase(record, phase), true);
  });

  it("DOES re-assert for merchants when phase changes", () => {
    const record = { role: "merchant", currentActivityId: "merchant_tend" };
    const phase = { online: true, activityId: "tavern_social" };
    assert.equal(shouldReassertPhase(record, phase), true);
  });

  it("does NOT re-assert when phase matches current activity (any role)", () => {
    const record = { role: "guard", currentActivityId: "guard_patrol" };
    const phase = { online: true, activityId: "guard_patrol" };
    assert.equal(shouldReassertPhase(record, phase), false);
  });

  it("does NOT re-assert when phase has no activity (sleep)", () => {
    const record = { role: "commoner", currentActivityId: "citizen_routine" };
    const phase = { online: false, activityId: null };
    assert.equal(shouldReassertPhase(record, phase), false);
  });
});
