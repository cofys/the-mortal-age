"use strict";

/**
 * Events.Kingdoms — the kingdom:* custom-event listeners. This is the
 * cross-plugin API of the KINGDOM SYSTEM: nothing reaches into this plugin's
 * modules; everything arrives as a small event payload (token-lean for future
 * LLM hooks). The emitter owns the name and shape; the listener owns the
 * handler — a new cross-plugin interaction means a new event name, never new
 * PluginManager surface.
 *
 * Payloads (all small, all plain data plus a mobile/player reference):
 *   kingdom:created         { kingdomId, name, capital?, ruler?, rulerTitle?, hierarchy? }
 *   kingdom:territory-entered { player, kingdomId, name }            // no core listener in v1
 *   kingdom:territory-left   { player, kingdomId, name }            // no core listener in v1
 *   kingdom:rank-granted     { player, kingdomId, rank?, title? }
 *   kingdom:tax-collected    { kingdomId, amount, source? }
 *   kingdom:war-declared     { attackerId, defenderId, declaredBy?, reason? }
 *   kingdom:war-ended        { attackerId, defenderId, outcome? }
 *   kingdom:ruler-changed    { kingdomId, newRuler, newTitle?, flag?, flagValue? }
 *   kingdom:office-assigned  { officeId, kingdomId, holder: { kind: "ai"|"player", ref } }
 *   kingdom:office-vacated   { officeId, kingdomId, previousHolder? }
 *   kingdom:office-seeks-holder { officeId, kingdomId, title }
 *
 * territory-entered/left are emitted by the Areas for external consumers
 * (future AI-citizen and LLM hooks); core needs no listener for them yet.
 * office-seeks-holder is emitted whenever an office goes vacant; the
 * citizens director (AI holder) or a ruler's decree/player claim answers
 * with office-assigned.
 */

const Store = require("./KingdomStore");
const Membership = require("./Membership.Kingdoms");
const Offices = require("./Offices.Kingdoms");

let pluginApi = null;

/** A kingdom announced itself — record it if we do not know it yet. */
function onKingdomCreated(event) {
  if (!event?.kingdomId || !event?.name) return;
  Store.upsertKingdom({
    id: event.kingdomId,
    name: event.name,
    capital: event.capital,
    ruler: event.ruler,
    rulerTitle: event.rulerTitle,
    hierarchy: event.hierarchy,
  });
  Store.save();
}

/** A player joined or was promoted: write their membership attributes. */
function onRankGranted(event) {
  const player = event?.player;
  if (!player?.setAttribute || !event?.kingdomId) return;
  player.setAttribute(Membership.KINGDOM_ID_ATTRIBUTE, event.kingdomId);
  player.setAttribute(Membership.KINGDOM_RANK_ATTRIBUTE, event.rank ?? "Subject");
  if (event.title) {
    const titles = [...(player.getAttribute(Membership.KINGDOM_TITLES_ATTRIBUTE) ?? [])];
    if (!titles.includes(event.title)) titles.push(event.title);
    player.setAttribute(Membership.KINGDOM_TITLES_ATTRIBUTE, titles);
  }
}

/** Revenue arrived: it lands in the treasury. */
function onTaxCollected(event) {
  if (!event?.kingdomId || !(event.amount > 0)) return;
  Store.grantTax(event.kingdomId, Math.floor(event.amount));
  Store.save();
}

/** A war opened between two kingdoms. */
function onWarDeclared(event) {
  if (!event?.attackerId || !event?.defenderId) return;
  Store.declareWar({
    attackerId: event.attackerId,
    defenderId: event.defenderId,
    declaredBy: event.declaredBy ?? null,
    reason: event.reason ?? null,
  });
  Store.save();
}

/** A war closed, with an outcome for the history. */
function onWarEnded(event) {
  if (!event?.attackerId || !event?.defenderId) return;
  Store.endWar(event.attackerId, event.defenderId, event.outcome ?? "unknown");
  Store.save();
}

/** The throne changed hands — succession, coup, or questline. */
function onRulerChanged(event) {
  if (!event?.kingdomId || !event?.newRuler) return;
  Store.setRuler(event.kingdomId, event.newRuler, event.newTitle ?? null);
  if (event.flag !== undefined && event.flagValue !== undefined) {
    Store.setFlag(event.kingdomId, event.flag, event.flagValue);
  }
  Store.save();
}

/** An office found its holder — AI citizen or player, the registry doesn't care. */
function onOfficeAssigned(event) {
  if (!event?.officeId || !event?.kingdomId || !Offices.isValidHolder(event.holder)) return;
  Offices.assignOffice(event.officeId, event.holder);
}

/** An office went vacant — broadcast so the director or a claimant can answer. */
function onOfficeVacated(event) {
  if (!event?.officeId) return;
  const record = Offices.getOffice(event.officeId);
  const previousHolder = Offices.vacateOffice(event.officeId);
  if (record) {
    pluginApi.emitCustomEvent("kingdom:office-seeks-holder", {
      officeId: event.officeId,
      kingdomId: record.kingdomId,
      title: record.title,
      previousHolder: previousHolder ? { ...previousHolder } : null,
    });
  }
}

module.exports = function attachEvents(api) {
  pluginApi = api;
  api.onCustomEvent("kingdom:created", onKingdomCreated);
  api.onCustomEvent("kingdom:rank-granted", onRankGranted);
  api.onCustomEvent("kingdom:tax-collected", onTaxCollected);
  api.onCustomEvent("kingdom:war-declared", onWarDeclared);
  api.onCustomEvent("kingdom:war-ended", onWarEnded);
  api.onCustomEvent("kingdom:ruler-changed", onRulerChanged);
  api.onCustomEvent("kingdom:office-assigned", onOfficeAssigned);
  api.onCustomEvent("kingdom:office-vacated", onOfficeVacated);
};

module.exports.onOfficeAssigned = onOfficeAssigned;
module.exports.onOfficeVacated = onOfficeVacated;
