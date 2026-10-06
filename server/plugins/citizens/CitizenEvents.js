"use strict";

/**
 * CitizenEvents — the citizens plugin's view of kingdom politics.
 *
 * The kingdoms plugin owns the canonical war state; we only listen to its
 * custom events (kingdom:war-declared / kingdom:war-ended) and keep a small
 * local alert map so brain actions can react this tick without reaching into
 * another plugin's modules. Alert = "my kingdom is at war right now".
 *
 * Same pattern for offices: kingdom:office-assigned / kingdom:office-vacated
 * keep a local map of PLAYER office-holders (AI holders are the director's
 * business), so guards and courtiers can address a player by their title.
 */

const warsByKingdom = new Map(); // kingdomId -> count of active wars
const playerOffices = new Map(); // `${kingdomId}:${office}` -> { kingdomId, office, title, username }

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

/**
 * A player took (or left) an office. Only player holders are tracked here —
 * AI holders are bound to living citizens by the director, not the map.
 */
function onOfficeAssigned(event) {
  const officeId = event?.officeId;
  if (!officeId || !event?.kingdomId) return;
  if (event?.holder?.kind === "player" && event.holder.ref) {
    const office = String(officeId).split(":").pop();
    playerOffices.set(officeId, {
      kingdomId: event.kingdomId,
      office,
      // The title arrives on seeks-holder / assigned payloads when the
      // emitter includes it; fall back to a title-cased office key.
      title: event.title ?? office.charAt(0).toUpperCase() + office.slice(1),
      username: event.holder.ref,
    });
  } else {
    // An AI holder (or anyone else) took the seals: no player to address.
    playerOffices.delete(officeId);
  }
}

function onOfficeVacated(event) {
  if (event?.officeId) playerOffices.delete(event.officeId);
}

/** Offices a player holds in a kingdom: [{ office, title }]. */
function officesHeldBy(username, kingdomId) {
  const out = [];
  for (const record of playerOffices.values()) {
    if (record.username === username && record.kingdomId === kingdomId) out.push(record);
  }
  return out;
}

module.exports = {
  onWarDeclared,
  onWarEnded,
  isKingdomAtWar,
  warsFor,
  onOfficeAssigned,
  onOfficeVacated,
  officesHeldBy,
};
