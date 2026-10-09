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
 *   kingdom:war-declared     { attackerId, defenderId, declaredBy?, reason?, resolveAt? }
 *   kingdom:war-ended        { attackerId, defenderId, outcome? }
 *   kingdom:skirmish         { attackerId, defenderId, location, casualtiesA, casualtiesB }
 *     // border patrols clashed below the threshold of war (Tension.Kingdoms)
 *   kingdom:ruler-changed    { kingdomId, newRuler, newTitle?, flag?, flagValue? }
 *   kingdom:office-assigned  { officeId, kingdomId, holder: { kind: "ai"|"player", ref }, title? }
 *   kingdom:office-vacated   { officeId, kingdomId, previousHolder? }
 *   kingdom:office-seeks-holder { officeId, kingdomId, title }
 *   kingdom:donation-made    { player, kingdomId, amount }   // war-effort gift.
 *     The emitter moves the funds (e.g. ::donate takes the coins and grants
 *     them to the treasury); this listener ledgers influence and trial
 *     progress. Never grantTax here — the money is already moved.
 *   kingdom:task-completed   { player, kingdomId, task? }    // kingdom task done: influence
 *   kingdom:challenge-decided { officeId, kingdomId, petitioner, holder,
 *     outcome: "granted"|"trial"|"rejected", influence, standing, reason? }
 *     // the court's ruling on a petition/challenge (Politics.Kingdoms.js)
 *   kingdom:alliance-formed { a, b, pactName?, broker? }
 *     // two kingdoms sealed a pact (Diplomacy's stewards, or a questline).
 *     // The Alliances registry persists it, pins their tension, and tells
 *     // the realm. a/b are unordered kingdom ids.
 *   kingdom:alliance-broken { a, b, pactName?, reason?: "treaty"|"war"|"absence"|"betrayal" }
 *     // a pact ended: mutual consent, war between the partners (the pact
 *     // is ash), an ally's absence in wartime, or betrayal (which travels
 *     // with kingdom:betrayal and its own outrage — the registry only records).
 *   kingdom:betrayal { betrayer, betrayed, via: "scheme"|"war-demand"|"war-refusal",
 *     pactName?, text }
 *     // an alliance shattered in treachery (Diplomacy.Kingdoms). The
 *     // betrayed side's tension spikes; citizens react with outrage.
 *   kingdom:royal-event { kingdomId, type: "marriage"|"birth"|"death"|"coronation",
 *     text, parties? }
 *     // the royal calendar (Royals.Kingdoms): realm announcements that
 *     // shift tension. Deaths are courtiers/kin only — the great rulers
 *     // never die in ambient events (world bible: their fates are questlines).
 *     // A death anywhere can stir Succession's whispers.
 *     // Succession whispers themselves travel as kingdom:rumor to
 *     // Misthalin — rare, deniable, arc-seeding (phase 10 questline).
 *
 * A player seated in an office is granted the office title as an honorific
 * (via kingdom:rank-granted with quiet: true — no influence farmed from the
 * honor itself) and announced realm-wide, so the realm knows its officers.
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
const Influence = require("./Influence.Kingdoms");
const Politics = require("./Politics.Kingdoms");

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

/** A player joined or was promoted: write their membership attributes, and ledger the service. */
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
  Influence.onRankGranted(event);
  settleEarnedPromotion(player, event.kingdomId);
}

/**
 * The earned-promotion settle: after any influence lands (fealty, donation,
 * task), the court checks whether the player's service has crossed a rank
 * threshold and promotes them. One hop to the highest earned rank; the
 * resulting kingdom:rank-granted re-enters onRankGranted, which settles
 * again and stops when the rank is held (bounded by the ladder, so it
 * always terminates).
 */
function settleEarnedPromotion(player, kingdomId) {
  if (!pluginApi || !player?.setAttribute || !kingdomId) return null;
  const kingdom = Store.getKingdom(kingdomId);
  const rank = Influence.settlePromotion(
    player,
    kingdomId,
    kingdom?.hierarchy ?? [],
    (payload) => pluginApi.emitCustomEvent("kingdom:rank-granted", payload)
  );
  if (rank) {
    try {
      player.sendMessage(
        `[Court] Your service is weighed and found worthy — you are named ${rank} of ${kingdom?.name ?? kingdomId}.`
      );
    } catch {
      // Cosmetic; the promotion already landed.
    }
  }
  return rank;
}

/** Revenue arrived: notification only. Emitters grant the tax themselves
 * before emitting (see header) — granting here would double-count. */
function onTaxCollected(event) {
  if (!event?.kingdomId || !(event.amount > 0)) return;
}

/** A war opened between two kingdoms. */
function onWarDeclared(event) {
  if (!event?.attackerId || !event?.defenderId) return;
  Store.declareWar({
    attackerId: event.attackerId,
    defenderId: event.defenderId,
    declaredBy: event.declaredBy ?? null,
    reason: event.reason ?? null,
    resolveAt: event.resolveAt ?? null,
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
  const record = Offices.assignOffice(event.officeId, event.holder);
  if (!record || event.holder.kind !== "player") return;
  const kingdom = Store.getKingdom(event.kingdomId);
  const kingdomName = kingdom?.name ?? event.kingdomId;
  announceToRealm(
    `[Realm] Hear ye! ${event.holder.ref} has been named ${record.title} of ${kingdomName}.`
  );
  // The office title becomes an honorific (quiet: the honor itself earns no influence).
  try {
    const player = pluginApi.core.World.getPlayerByName(event.holder.ref);
    if (player?.setAttribute) {
      pluginApi.emitCustomEvent("kingdom:rank-granted", {
        player,
        kingdomId: event.kingdomId,
        rank: player.getAttribute?.(Membership.KINGDOM_RANK_ATTRIBUTE) ?? "Subject",
        title: record.title,
        quiet: true,
      });
    }
  } catch {
    // Title grant is cosmetic; the seating already happened.
  }
}

/** Send a message to every online player. Cosmetic; never throws. */
function announceToRealm(message) {
  try {
    pluginApi.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        try {
          p.sendMessage(message);
        } catch {
          // One deaf player doesn't silence the realm.
        }
      });
  } catch {
    // World not ready (e.g. seeding at startup): nothing to announce to.
  }
}

/** A war-effort donation: influence for the gift, progress for an active trial. */
function onDonationMade(event) {
  Politics.onDonationMade(event);
  if (event?.player?.setAttribute && event?.kingdomId) {
    settleEarnedPromotion(event.player, event.kingdomId);
  }
}

/** A kingdom task completed: influence for the service. */
function onTaskCompleted(event) {
  Influence.onTaskCompleted(event);
  if (event?.player?.setAttribute && event?.kingdomId) {
    settleEarnedPromotion(event.player, event.kingdomId);
  }
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
  api.onCustomEvent("kingdom:donation-made", onDonationMade);
  api.onCustomEvent("kingdom:task-completed", onTaskCompleted);
};

module.exports.onOfficeAssigned = onOfficeAssigned;
module.exports.onOfficeVacated = onOfficeVacated;
