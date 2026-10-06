"use strict";

/**
 * Diplomacy.Kingdoms — the POLITICAL LAYER. Stewards negotiate, spymasters
 * scheme, and the realm's map of friends is redrawn by office actions, not
 * by fiat.
 *
 * Every ~30 minutes each great power's held offices act on the diplomatic
 * board:
 *
 *   Steward     negotiates pacts with peaceful neighbors — likelier when
 *               the two courts share a rival or a royal marriage bond.
 *   Spymaster   sabotages foreign alliances (poisoned letters), schemes
 *               against its own kingdom's allies, or quietly protects its
 *               own pacts (counter-intelligence).
 *   Quartermaster (via kingdom:war-demand) can flip an ally: a wartime
 *               demand for supplies is honored (treasury gift, stronger
 *               bond) or refused — and a refusal is a betrayal.
 *
 * Betrayals: an alliance whose betrayalRisk reaches 100 shatters. The
 * betrayed side's tension spikes (+30), the streets seethe with outrage,
 * and every other pact in the realm loses a little trust (strength -1).
 *
 * Mutual defense: when tension declares a war (declaredBy "tension" only —
 * never chained off another pact war), each ally of the defender rolls
 * loyalty. A loyal ally declares war on the attacker itself (declaredBy
 * "alliance") and the two allies bond in blood. A refusing ally betrays.
 * An ally already fighting its own war refuses without stigma — the pact
 * dissolves in absence, not anger.
 *
 * Out (custom events, AGENTS.md: plugins talk through events):
 *   kingdom:alliance-formed { a, b, pactName, broker }   (stewards)
 *   kingdom:alliance-broken { a, b, reason }             (refusals; betrayals)
 *   kingdom:betrayal { betrayer, betrayed, via, pactName?, text }
 *   kingdom:war-declared { attackerId, defenderId, declaredBy: "alliance", reason }
 *   kingdom:rumor { kingdomId, text }                    (schemes, outrage)
 * In (custom events):
 *   kingdom:war-declared  (declaredBy "tension": mutual-defense resolution)
 *   kingdom:war-demand    (quartermaster: honor-or-refuse rolls)
 *
 * Numbers live in DESIGN.md. Logging uses console.info/warn — api.log?.()
 * never reaches the log file.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");
const Tension = require("./Tension.Kingdoms");

// ~30 minutes at 600ms/tick. Diplomacy moves slower than the powder keg.
const DIPLOMACY_TICK_TICKS = 3000;

// A pact needs calm borders and two courts that can afford envoys.
const NEGOTIATE_MAX_TENSION = 40;
const NEGOTIATE_CHANCE = 0.08;
const NEGOTIATE_SHARED_RIVAL_CHANCE = 0.2;
const SHARED_RIVAL_TENSION = 60;

// Spymaster tradecraft, per held spymaster per tick.
const SCHEME_CHANCE = 0.12;
const SABOTAGE_RISK_MIN = 15;
const SABOTAGE_RISK_MAX = 30;
const OWN_SCHEME_RISK_MIN = 20;
const OWN_SCHEME_RISK_MAX = 40;
const COUNTERINTEL_RISK_RELIEF = 10;
const SCHEME_DISCOVERED_CHANCE = 0.25;

// A shattered pact spikes the betrayed side's fury.
const BETRAYAL_TENSION = 30;
const REFUSAL_TENSION = 10;

// Mutual defense: the loyalty roll.
const LOYALTY_BASE = 0.55;
const LOYALTY_PER_STRENGTH = 0.1;
const LOYALTY_HOT_ATTACKER_PENALTY = 0.2;
const LOYALTY_WEAK_GARRISON_PENALTY = 0.15;
const HOT_ATTACKER_TENSION = 50;
const WEAK_GARRISON = 20;

// A wartime supply demand is honored with this much, or refused.
const WAR_DEMAND_GIFT_MIN = 200;
const WAR_DEMAND_GIFT_MAX = 800;
const WAR_DEMAND_HONOR_CHANCE = 0.6;
const WAR_DEMAND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

let pluginApi = null;
const lastNoticeAt = new Map(); // `${kingdomId}:${kind}` -> timestamp
const lastWarDemandAt = new Map(); // kingdomId -> timestamp

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function nameOf(kingdomId) {
  return Store.getKingdom(kingdomId)?.name ?? kingdomId;
}

function capitalOf(kingdomId) {
  return Store.getKingdom(kingdomId)?.capital ?? nameOf(kingdomId);
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

function holderKind(kingdomId, office) {
  const holder = Offices.holderOf(Offices.officeIdFor(kingdomId, office));
  return holder?.kind ?? null;
}

function kingdomIds() {
  try {
    return Store.getKingdoms()
      .map((k) => k?.id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function atWar(kingdomId, wars) {
  return wars.some((w) => w.attackerId === kingdomId || w.defenderId === kingdomId);
}

function atWarWith(a, b, wars) {
  return wars.some(
    (w) =>
      (w.attackerId === a && w.defenderId === b) ||
      (w.attackerId === b && w.defenderId === a)
  );
}

function marriageBonded(a, b) {
  return (
    Store.getKingdom(a)?.flags?.[`royals:marriage-bond:${b}`] === true ||
    Store.getKingdom(b)?.flags?.[`royals:marriage-bond:${a}`] === true
  );
}

/** A third power both courts fear: the classic reason to sign a pact. */
function sharedRival(a, b) {
  for (const k of kingdomIds()) {
    if (k === a || k === b) continue;
    if (
      Tension.getTension(a, k) >= SHARED_RIVAL_TENSION &&
      Tension.getTension(b, k) >= SHARED_RIVAL_TENSION
    ) {
      return k;
    }
  }
  return null;
}

function pactNameFor(a, b) {
  const capA = capitalOf(a);
  const capB = capitalOf(b);
  return pick([
    `the ${capA} Accords`,
    `the Pact of ${capA}`,
    `the ${capA}-${capB} Compact`,
    `the ${capA} Concord`,
  ]);
}

/**
 * Stewards negotiate. Two courts at peace, both stewards seated, calm
 * borders — and a much better chance when they share a rival or a royal
 * marriage bond. The pact itself is announced by the Alliances registry.
 */
function negotiate(wars) {
  const ids = kingdomIds();
  for (const a of ids) {
    if (!holderKind(a, "steward")) continue;
    for (const b of ids) {
      if (b <= a) continue; // canonical pair order, one roll per pair
      if (!holderKind(b, "steward")) continue;
      if (Store.isAllied(a, b) || atWarWith(a, b, wars)) continue;
      const tension = Tension.getTension(a, b);
      if (tension >= NEGOTIATE_MAX_TENSION) continue;
      const rival = sharedRival(a, b);
      const bonded = marriageBonded(a, b);
      const chance = rival || bonded ? NEGOTIATE_SHARED_RIVAL_CHANCE : NEGOTIATE_CHANCE;
      if (Math.random() >= chance) continue;
      const pactName = pactNameFor(a, b);
      pluginApi.emitCustomEvent("kingdom:alliance-formed", {
        a,
        b,
        pactName,
        broker: "steward",
      });
      console.info("[diplomacy] pact negotiated", {
        a,
        b,
        pactName,
        rival,
        bonded,
      });
    }
  }
}

/** A spymaster picks its poison: sabotage a foreign pact, scheme against an
 * ally of its own court, or quietly protect its own pacts. */
function scheme() {
  for (const id of kingdomIds()) {
    if (!holderKind(id, "spymaster")) continue;
    if (Math.random() >= SCHEME_CHANCE) continue;
    const roll = Math.random();
    if (roll < 0.4) sabotageForeign(id);
    else if (roll < 0.75) schemeOwnAlly(id);
    else counterIntel(id);
  }
}

/** Poisoned letters: raise the betrayal risk of a pact between two others. */
function sabotageForeign(id) {
  const foreign = Store.getAlliances().filter((r) => r.a !== id && r.b !== id);
  if (foreign.length === 0) return;
  const target = pick(foreign);
  const delta = SABOTAGE_RISK_MIN + Math.floor(Math.random() * (SABOTAGE_RISK_MAX - SABOTAGE_RISK_MIN + 1));
  Store.adjustAlliance(target.a, target.b, { betrayalRiskDelta: delta });
  const aName = nameOf(target.a);
  const bName = nameOf(target.b);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: target.a,
    text: `A courier carrying ${aName} letters to ${bName} was found with his throat cut — the seals forged, the words poison.`,
  });
  if (Math.random() < SCHEME_DISCOVERED_CHANCE) {
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: target.b,
      text: `They whisper ${nameOf(id)} spies were seen copying the pact ledgers. ${bName} smiles thinner these days.`,
    });
  }
}

/** The black ledger: a spymaster schemes against its own court's ally. */
function schemeOwnAlly(id) {
  const allies = Store.alliesOf(id);
  if (allies.length === 0) return;
  const ally = pick(allies);
  const delta = OWN_SCHEME_RISK_MIN + Math.floor(Math.random() * (OWN_SCHEME_RISK_MAX - OWN_SCHEME_RISK_MIN + 1));
  Store.adjustAlliance(id, ally, { betrayalRiskDelta: delta });
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: id,
    text: `They say the Spymaster's black ledger has a new page — and it names ${nameOf(ally)}.`,
  });
}

/** Quiet protection: a spymaster steadies its own court's pacts. */
function counterIntel(id) {
  const allies = Store.alliesOf(id);
  if (allies.length === 0) return;
  const ally = pick(allies);
  Store.adjustAlliance(id, ally, { betrayalRiskDelta: -COUNTERINTEL_RISK_RELIEF });
}

/** Shared rumors: allied courts trade cipher-keys, and the whispers cross
 * the pact roads. Throttled per pair — intelligence, not gossip. */
function sharedRumors() {
  for (const r of Store.getAlliances()) {
    if (!noticeDue(`${r.a}:${r.b}`, "shared-rumor", 12 * 60 * 60 * 1000)) continue;
    const aName = nameOf(r.a);
    const bName = nameOf(r.b);
    const to = Math.random() < 0.5 ? r.a : r.b;
    const fromName = to === r.a ? bName : aName;
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: to,
      text: pick([
        `Through the pact with ${fromName}, the spymasters share cipher-keys — the courts hear each other's whispers now.`,
        `Pact gossip: ${fromName} merchants bring news their court would rather you didn't hear.`,
        `They say ${fromName} warned ${to === r.a ? aName : bName} of raiders on the marches. The pact pays in whispers.`,
      ]),
    });
  }
}

/** Calm borders: allies' tension bleeds a little every diplomacy tick —
 * envoys do their quiet work. Wars are untouched. */
function dampAllyTension(wars) {
  for (const r of Store.getAlliances()) {
    if (atWarWith(r.a, r.b, wars)) continue;
    const t = Tension.getTension(r.a, r.b);
    if (t > 0) {
      Store.setRawTension(r.a, r.b, Math.max(0, t - 3));
    }
  }
}

/**
 * An alliance whose betrayal risk hit 100 shatters. The side that wanted
 * out more — the one already glaring across the border — is named the
 * betrayer. The betrayed side's tension spikes and the streets seethe.
 */
function betrayalCheck() {
  for (const r of Store.getAlliances()) {
    if ((r.betrayalRisk ?? 0) < 100) continue;
    const tAB = Tension.getTension(r.a, r.b);
    // The betrayer is the side already leaning out of the pact.
    const betrayer = Math.random() < 0.5 ? r.a : r.b;
    const betrayed = betrayer === r.a ? r.b : r.a;
    resolveBetrayal(betrayer, betrayed, r.pactName, "scheme");
    console.info("[diplomacy] pact shattered by scheme", { betrayer, betrayed, risk: tAB });
  }
}

const BETRAYAL_LINES = (betrayerName, betrayedName, pactName) => [
  `BETRAYAL! ${betrayerName} has torn up ${pactName} — ${betrayedName} envoys were turned away at the border with steel.`,
  `BETRAYAL! ${pactName} is a lie — ${betrayerName} knives were found in ${betrayedName} backs. The realm will remember this.`,
];

const OUTRAGE_RUMORS = (betrayerName, betrayedCap) => [
  `They spit when they speak ${betrayerName}'s name now.`,
  `The taverns toast the day ${betrayerName} pays for this.`,
  `Recruiters can't keep up — every lad in ${betrayedCap} wants a spear.`,
  `They say the court of ${betrayedCap} burned ${betrayerName}'s banners in the square.`,
];

function resolveBetrayal(betrayer, betrayed, pactName, via) {
  const betrayerName = nameOf(betrayer);
  const betrayedName = nameOf(betrayed);
  const text = pick(BETRAYAL_LINES(betrayerName, betrayedName, pactName ?? "the pact"));
  pluginApi.emitCustomEvent("kingdom:betrayal", {
    betrayer,
    betrayed,
    via,
    pactName: pactName ?? null,
    text,
  });
  pluginApi.emitCustomEvent("kingdom:alliance-broken", {
    a: betrayer,
    b: betrayed,
    pactName: pactName ?? null,
    reason: "betrayal",
  });
  Tension.addTension(betrayer, betrayed, BETRAYAL_TENSION);
  announceToRealm(
    `[Realm] ${text} The streets of ${capitalOf(betrayed)} seethe with outrage.`
  );
  for (let i = 0; i < 2; i++) {
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: betrayed,
      text: pick(OUTRAGE_RUMORS(betrayerName, capitalOf(betrayed))),
    });
  }
  // Trust is contagious in the wrong direction: every other pact trembles.
  for (const r of Store.getAlliances()) {
    Store.adjustAlliance(r.a, r.b, { strengthDelta: -1 });
  }
  Store.save();
  console.info("[diplomacy] betrayal", { betrayer, betrayed, via });
}

/**
 * kingdom:war-demand — the quartermaster's empty stores make the court
 * demand supplies of its ally. Honored: a treasury gift crosses the pact
 * roads and the bond strengthens. Refused: the alliance shatters in
 * betrayal — the envoys came home empty-handed and furious.
 */
function onWarDemand(event) {
  const kingdomId = event?.kingdomId;
  if (!kingdomId || !Store.getKingdom(kingdomId)) return;
  const wars = Store.getActiveWars();
  if (!atWar(kingdomId, wars)) return; // peacetime demands are just rumors
  const now = Date.now();
  if (now - (lastWarDemandAt.get(kingdomId) ?? 0) < WAR_DEMAND_COOLDOWN_MS) return;
  const allies = Store.alliesOf(kingdomId).filter((a) => !atWarWith(kingdomId, a, wars));
  if (allies.length === 0) return;
  lastWarDemandAt.set(kingdomId, now);
  const ally = pick(allies);
  const record = Store.getAlliance(kingdomId, ally);
  if (Math.random() < WAR_DEMAND_HONOR_CHANCE) {
    const gift = WAR_DEMAND_GIFT_MIN + Math.floor(Math.random() * (WAR_DEMAND_GIFT_MAX - WAR_DEMAND_GIFT_MIN + 1));
    if (Store.spendTax(ally, gift)) {
      Store.grantTax(kingdomId, gift);
    }
    Store.adjustAlliance(kingdomId, ally, { strengthDelta: 1 });
    Store.setRawTension(kingdomId, ally, Math.max(0, Tension.getTension(kingdomId, ally) - 5));
    Store.save();
    announceToRealm(
      `[Realm] ${nameOf(ally)} answers ${nameOf(kingdomId)}'s war demand — ` +
        `${gift} coins of supplies cross the pact roads. The alliance holds.`
    );
  } else {
    announceToRealm(
      `[Realm] ${nameOf(ally)} REFUSED ${nameOf(kingdomId)}'s wartime demand for supplies — ` +
        `the quartermaster's envoys came home empty-handed and furious.`
    );
    resolveBetrayal(ally, kingdomId, record?.pactName, "war-demand");
  }
}

/**
 * kingdom:war-declared — mutual defense. Only tension-declared wars trigger
 * the roll (declaredBy "tension"); pact wars never chain. Each ally of the
 * defender rolls loyalty: march to the defense, or betray.
 */
function onWarDeclared(event) {
  if (event?.declaredBy !== "tension") return;
  const attacker = event?.attackerId;
  const defender = event?.defenderId;
  if (!attacker || !defender) return;
  const wars = Store.getActiveWars();
  for (const ally of Store.alliesOf(defender)) {
    if (ally === attacker || atWarWith(ally, attacker, wars)) continue;
    const record = Store.getAlliance(defender, ally);
    if (atWar(ally, wars)) {
      // Its own war consumes every blade: the pact dissolves in absence,
      // not anger.
      pluginApi.emitCustomEvent("kingdom:alliance-broken", {
        a: defender,
        b: ally,
        pactName: record?.pactName ?? null,
        reason: "absence",
      });
      Tension.addTension(defender, ally, REFUSAL_TENSION);
      announceToRealm(
        `[Realm] ${nameOf(ally)} could not answer ${nameOf(defender)}'s call — ` +
          `its own war consumes every blade. The pact dissolves, not in anger but in absence.`
      );
      continue;
    }
    let loyalty = LOYALTY_BASE + LOYALTY_PER_STRENGTH * ((record?.strength ?? 1) - 1);
    if (Tension.getTension(ally, attacker) > HOT_ATTACKER_TENSION) loyalty -= LOYALTY_HOT_ATTACKER_PENALTY;
    if (Tension.garrisonOf(ally) < WEAK_GARRISON) loyalty -= LOYALTY_WEAK_GARRISON_PENALTY;
    if (Math.random() < loyalty) {
      // The ally marches. Blood bonds the two courts.
      Store.adjustAlliance(defender, ally, { strengthDelta: 1 });
      Store.setRawTension(defender, ally, 5);
      Store.save();
      pluginApi.emitCustomEvent("kingdom:war-declared", {
        attackerId: ally,
        defenderId: attacker,
        declaredBy: "alliance",
        reason: `${nameOf(ally)} honors its pact — marches to ${nameOf(defender)}'s defense against ${nameOf(attacker)}`,
      });
      announceToRealm(
        `[Realm] ${nameOf(ally)} HONORS its pact — marches to ${nameOf(defender)}'s defense ` +
          `against ${nameOf(attacker)}!`
      );
      console.info("[diplomacy] mutual defense", { ally, defender, attacker });
    } else {
      resolveBetrayal(ally, defender, record?.pactName, "war-refusal");
    }
  }
}

function diplomacyTick() {
  let wars;
  try {
    wars = Store.getActiveWars();
  } catch {
    return;
  }
  try {
    negotiate(wars);
    scheme();
    betrayalCheck();
    sharedRumors();
    dampAllyTension(wars);
  } catch (error) {
    console.warn("[diplomacy] tick failed", error?.message ?? error);
  }
  Store.save();
}

function startDiplomacyTask(api) {
  class DiplomacyTask extends Task {
    execute() {
      try {
        diplomacyTick();
      } catch (error) {
        console.warn("[diplomacy] tick failed", error?.message ?? error);
      }
    }
  }
  api.getTaskManager()?.submit(new DiplomacyTask(DIPLOMACY_TICK_TICKS));
  console.info("[diplomacy] political layer armed", { tickTicks: DIPLOMACY_TICK_TICKS });
}

function attachDiplomacy(api) {
  pluginApi = api;
  api.onCustomEvent("kingdom:war-declared", onWarDeclared);
  api.onCustomEvent("kingdom:war-demand", onWarDemand);
  startDiplomacyTask(api);
}

module.exports = attachDiplomacy;
module.exports.attachDiplomacy = attachDiplomacy;
module.exports.diplomacyTick = diplomacyTick;
module.exports.DIPLOMACY_TICK_TICKS = DIPLOMACY_TICK_TICKS;
