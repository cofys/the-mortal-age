"use strict";

/**
 * Offices.Kingdoms — the OFFICE REGISTRY. Every office of the realm
 * (quartermaster, marshal, spymaster, steward) is holdable by an AI citizen
 * OR a player: the holder is data, not code.
 *
 * Holder shape: { kind: "ai" | "player", ref: string }
 *   - kind "ai":     ref is an office identity, e.g. "asgarnia:quartermaster".
 *                     The citizens director binds a living citizen to it;
 *                     until then the office speaks with the realm's voice.
 *   - kind "player":  ref is the player's username. A real human holds the
 *                     seals — and can be dismissed, challenged, or outvoted.
 *
 * Pure module: no api reference. Events.Kingdoms.js owns the api and the
 * kingdom:office-* event listeners. Cross-plugin contract:
 *   kingdom:office-assigned     { officeId, kingdomId, holder }
 *   kingdom:office-vacated      { officeId, kingdomId, previousHolder }
 *   kingdom:office-seeks-holder { officeId, kingdomId, title }
 * A vacant office emits seeks-holder; the citizens director (or a ruler's
 * decree, or a player's ::office claim) answers with office-assigned.
 *
 * v1 scope: claim vacant offices, vacate your own, OWNER force-vacates.
 * Challenge/appointment mechanics (taking an AI-held office by politics,
 * not command) are the next step — the data model already supports them.
 */

const STANDARD_OFFICES = Object.freeze([
  {
    office: "quartermaster",
    title: "Quartermaster",
    description:
      "Keeps the realm fed and armed: posts war demands, buys supplies, pays the garrison.",
  },
  {
    office: "marshal",
    title: "Marshal",
    description:
      "Commands the realm's soldiers in the field; answers to the ruler.",
  },
  {
    office: "spymaster",
    title: "Spymaster",
    description:
      "Knows what the other realms had for breakfast. Trades in secrets.",
  },
  {
    office: "steward",
    title: "Steward",
    description:
      "Keeps the ledgers: taxes in, wages out, treasury balanced.",
  },
]);

const offices = new Map(); // officeId -> { officeId, kingdomId, office, title, description, holder }

function officeIdFor(kingdomId, office) {
  return `${kingdomId}:${office}`;
}

function isValidHolder(holder) {
  return (
    !!holder &&
    (holder.kind === "ai" || holder.kind === "player") &&
    typeof holder.ref === "string" &&
    holder.ref.length > 0
  );
}

/** Define an office; idempotent. Returns the office record. */
function defineOffice({ kingdomId, office, title, description }) {
  if (!kingdomId || !office) return null;
  const officeId = officeIdFor(kingdomId, office);
  if (!offices.has(officeId)) {
    const std = STANDARD_OFFICES.find((s) => s.office === office);
    offices.set(officeId, {
      officeId,
      kingdomId,
      office,
      title: title ?? std?.title ?? office,
      description: description ?? std?.description ?? "",
      holder: null,
    });
  }
  return offices.get(officeId);
}

/** Seat a holder. Returns the office record, or null if the office is unknown or the holder is invalid. */
function assignOffice(officeId, holder) {
  const record = offices.get(officeId);
  if (!record || !isValidHolder(holder)) return null;
  record.holder = { kind: holder.kind, ref: holder.ref };
  return record;
}

/** Vacate an office. Returns the previous holder (or null). */
function vacateOffice(officeId) {
  const record = offices.get(officeId);
  if (!record) return null;
  const previous = record.holder;
  record.holder = null;
  return previous;
}

function getOffice(officeId) {
  return offices.get(officeId) ?? null;
}

/** All offices, optionally filtered to one kingdom. */
function getOffices(kingdomId) {
  const out = [];
  for (const record of offices.values()) {
    if (!kingdomId || record.kingdomId === kingdomId) out.push({ ...record });
  }
  return out;
}

/** Who holds it right now (a copy), or null when vacant. */
function holderOf(officeId) {
  const record = offices.get(officeId);
  return record?.holder ? { ...record.holder } : null;
}

function holderName(holder) {
  if (!holder) return "vacant";
  return holder.kind === "player" ? holder.ref : `AI ${holder.ref}`;
}

module.exports = {
  STANDARD_OFFICES,
  officeIdFor,
  defineOffice,
  assignOffice,
  vacateOffice,
  getOffice,
  getOffices,
  holderOf,
  holderName,
  isValidHolder,
};
