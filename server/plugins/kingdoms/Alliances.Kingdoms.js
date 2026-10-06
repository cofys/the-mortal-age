"use strict";

/**
 * Alliances.Kingdoms — the PACT REGISTRY. Alliances are the diplomacy
 * layer's public face: mutual defense, trade bonuses, and shared rumors.
 *
 * The registry itself is dumb data in KingdomStore (getAlliances /
 * formAlliance / breakAlliance). This module owns the kingdom:alliance-*
 * event listeners: it persists the pacts, pins the new partners' tension
 * low, pays the trade bonus on tax day, and tells the realm — alliances
 * are always announced publicly, because a secret pact is just a rumor.
 *
 * Out (custom events, AGENTS.md: plugins talk through events):
 *   kingdom:rumor  { kingdomId, text }  (trade news, pact gossip)
 * In (custom events):
 *   kingdom:alliance-formed { a, b, pactName?, broker? }
 *     — a pact was signed (by Diplomacy's stewards, or a questline, or a
 *       future player command). Persisted, announced, tension pinned at 10.
 *   kingdom:alliance-broken { a, b, pactName?, reason?: "treaty"|"war"|"absence"|"betrayal" }
 *     — a pact ended by mutual agreement, because the partners went to war
 *       (the pact is ash), or because an ally could not answer a call to
 *       arms ("absence"). Betrayals travel as kingdom:betrayal and are
 *       broken here too — the outrage stays with the emitter (Diplomacy),
 *       and so does the "absence" farewell.
 *   kingdom:war-declared    { attackerId, defenderId, ... }
 *     — a war between allies voids their pact immediately.
 *   kingdom:tax-collected   { kingdomId, amount, wartime }
 *     — the trade bonus: a kingdom at peace with an ally earns a little
 *       extra on every tax collection. Open roads, full coffers.
 *
 * Numbers live in DESIGN.md. Logging uses console.info/warn — api.log?.()
 * never reaches the log file.
 */

const Store = require("./KingdomStore");

// A fresh pact cools the border between the partners almost to calm.
const TENSION_AFTER_PACT = 10;
// The trade bonus: a cut of every peacetime tax collection, for having
// open roads with an ally.
const TRADE_BONUS_RATE = 0.08;

let pluginApi = null;
const lastNoticeAt = new Map(); // `${kingdomId}:${kind}` -> timestamp

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function nameOf(kingdomId) {
  return Store.getKingdom(kingdomId)?.name ?? kingdomId;
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
    // World not ready: nothing to announce to.
  }
}

function noticeDue(kingdomId, kind, cooldownMs) {
  const key = `${kingdomId}:${kind}`;
  const last = lastNoticeAt.get(key) ?? 0;
  if (Date.now() - last < cooldownMs) return false;
  lastNoticeAt.set(key, Date.now());
  return true;
}

/** Set a pair's tension directly — the same public store seam Tension uses. */
function pinTension(a, b, score) {
  Store.setRawTension(a, b, score);
  Store.save();
}

const PACT_RUMORS = (aName, bName, pactName) => [
  `They say ${aName} and ${bName} signed ${pactName} — merchants already count the coins.`,
  `Word is the roads between ${aName} and ${bName} are safe now. Pact roads, they call them.`,
  `They say ${aName} steel flows to ${bName} markets now, and grain flows back.`,
];

/**
 * kingdom:alliance-formed — persist the pact, cool the border, tell the realm.
 */
function onAllianceFormed(event) {
  const a = event?.a;
  const b = event?.b;
  if (!a || !b || a === b || !Store.getKingdom(a) || !Store.getKingdom(b)) return;
  const record = Store.formAlliance(a, b, {
    pactName: event?.pactName ?? null,
    broker: event?.broker ?? null,
  });
  Store.save();
  pinTension(a, b, TENSION_AFTER_PACT);
  const aName = nameOf(a);
  const bName = nameOf(b);
  announceToRealm(
    `[Realm] Hear ye! ${aName} and ${bName} have sealed ${record.pactName}. ` +
      `Envoys speak of mutual defense and open roads — the realm redraws its map of friends.`
  );
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: a,
    text: pick(PACT_RUMORS(aName, bName, record.pactName)),
  });
  console.info("[alliances] pact sealed", { a, b, pactName: record.pactName });
}

const BROKEN_RUMORS = (aName, bName) => [
  `They say the pact between ${aName} and ${bName} is dissolved. The merchants look nervous.`,
  `Word is ${aName} and ${bName} walk their own roads again.`,
];

/**
 * kingdom:alliance-broken — the pact is gone. Reason "treaty" is a quiet
 * parting (announced, no outrage); "war" is crowns drawing swords on each
 * other; "betrayal" arrives with its own outrage from Diplomacy and is
 * only recorded here.
 */
function onAllianceBroken(event) {
  const a = event?.a;
  const b = event?.b;
  if (!a || !b) return;
  const removed = Store.breakAlliance(a, b);
  Store.save();
  if (!removed) return;
  const reason = event?.reason ?? "treaty";
  const aName = nameOf(a);
  const bName = nameOf(b);
  if (reason === "war") {
    announceToRealm(
      `[Realm] The pact between ${aName} and ${bName} is ASH — crowns that sign ` +
        `treaties do not draw swords on each other, yet here we are.`
    );
  } else if (reason === "treaty") {
    announceToRealm(
      `[Realm] ${removed.pactName} is dissolved by mutual consent. ` +
        `${aName} and ${bName} walk their own roads again.`
    );
  }
  // "betrayal" and "absence" are announced by Diplomacy with the
  // outrage (or the regret) they deserve; this registry only records.
  if (reason !== "betrayal" && reason !== "absence") {
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: a,
      text: pick(BROKEN_RUMORS(aName, bName)),
    });
  }
  console.info("[alliances] pact broken", { a, b, reason });
}

/**
 * kingdom:war-declared — allies at war with each other have no pact left
 * to keep. The pact dissolves the moment the first sword is drawn.
 */
function onWarDeclared(event) {
  const a = event?.attackerId;
  const b = event?.defenderId;
  if (!a || !b || !Store.isAllied(a, b)) return;
  const record = Store.getAlliance(a, b);
  onAllianceBroken({
    a,
    b,
    pactName: record?.pactName,
    reason: "war",
  });
}

/**
 * kingdom:tax-collected — the trade bonus. A kingdom at peace that holds
 * an ally earns a cut on top of every tax collection: open roads, full
 * coffers. Wartime trade is blockades and seizures, not bonuses.
 */
function onTaxCollected(event) {
  const kingdomId = event?.kingdomId;
  const amount = Math.floor(event?.amount ?? 0);
  if (!kingdomId || !(amount > 0) || event?.wartime) return;
  if (Store.alliesOf(kingdomId).length === 0) return;
  const bonus = Math.max(1, Math.floor(amount * TRADE_BONUS_RATE));
  Store.grantTax(kingdomId, bonus);
  Store.save();
  if (noticeDue(kingdomId, "trade-bonus", 6 * 60 * 60 * 1000)) {
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId,
      text:
        `They say the Steward counts an extra ${bonus} coins this season — ` +
        `pact trade with ${Store.alliesOf(kingdomId).map(nameOf).join(" and ")} fills the coffers.`,
    });
  }
}

/** The realm's pacts, for ::alliances and future consumers. */
function pactSummary() {
  return Store.getAlliances().map((r) => ({
    a: r.a,
    b: r.b,
    aName: nameOf(r.a),
    bName: nameOf(r.b),
    pactName: r.pactName,
    broker: r.broker,
    strength: r.strength ?? 1,
    betrayalRisk: r.betrayalRisk ?? 0,
    formedAt: r.formedAt,
  }));
}

function attachAlliances(api) {
  pluginApi = api;
  api.onCustomEvent("kingdom:alliance-formed", onAllianceFormed);
  api.onCustomEvent("kingdom:alliance-broken", onAllianceBroken);
  api.onCustomEvent("kingdom:war-declared", onWarDeclared);
  api.onCustomEvent("kingdom:tax-collected", onTaxCollected);
}

module.exports = attachAlliances;
module.exports.attachAlliances = attachAlliances;
module.exports.pactSummary = pactSummary;
module.exports.TENSION_AFTER_PACT = TENSION_AFTER_PACT;
module.exports.TRADE_BONUS_RATE = TRADE_BONUS_RATE;
