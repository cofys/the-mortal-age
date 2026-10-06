"use strict";

/**
 * CitizenEvents — the citizens plugin's view of kingdom politics.
 *
 * The kingdoms plugin owns the canonical war state; we only listen to its
 * custom events (kingdom:war-declared / kingdom:war-ended) and keep a small
 * local alert map so brain actions can react this tick without reaching into
 * another plugin's modules. Alert = "my kingdom is at war right now".
 */

const warsByKingdom = new Map(); // kingdomId -> count of active wars

function normalizeKingdomId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function onWarDeclared(event) {
  for (const key of ["attackerId", "defenderId"]) {
    const id = normalizeKingdomId(event?.[key]);
    if (id) {
      warsByKingdom.set(id, (warsByKingdom.get(id) ?? 0) + 1);
    }
  }
}

function onWarEnded(event) {
  for (const key of ["attackerId", "defenderId"]) {
    const id = normalizeKingdomId(event?.[key]);
    if (id) {
      const remaining = (warsByKingdom.get(id) ?? 1) - 1;
      if (remaining <= 0) {
        warsByKingdom.delete(id);
      } else {
        warsByKingdom.set(id, remaining);
      }
    }
  }
}

/** True while the kingdom has at least one active war. */
function isKingdomAtWar(kingdomId) {
  const id = normalizeKingdomId(kingdomId);
  return id !== null && (warsByKingdom.get(id) ?? 0) > 0;
}

function warsFor(kingdomId) {
  return warsByKingdom.get(normalizeKingdomId(kingdomId)) ?? 0;
}

module.exports = {
  onWarDeclared,
  onWarEnded,
  isKingdomAtWar,
  warsFor,
};
