"use strict";

/**
 * CitizenChoose — immediately fails so the brain's utility scorer picks
 * the real activity. Used at spawn to unpin commoners from citizen_routine.
 */
function createCitizenChooseAction(spec, world) {
  return {
    id: "citizenChoose",
    update(ctx) {
      return "failed"; // Trigger scorer immediately
    },
    stop(ctx) {},
  };
}

module.exports = { createCitizenChooseAction };
