"use strict";

/**
 * AiWarfare.Kingdoms — the AI war council (Phase 6).
 *
 * Until now only players could work the formal war machine (Wars.Kingdoms:
 * declare war, offer peace, break vassalage) — the realm's courts sat idle
 * unless a hero walked in. The council gives every kingdom a court that
 * thinks: it declares wars, lays sieges, defends its walls, sues for peace
 * when the war turns, and breaks oaths it can no longer stomach.
 *
 * Design rules:
 * - Same gates as the player paths. declareWarAi / offerPeaceAi /
 *   acceptPeaceAi / breakVassalageAi in Wars.Kingdoms share the exact
 *   checks and record shapes — the council is a second driver, not a
 *   second ruleset.
 * - Temperament is stable per kingdom (hash of the id, not a dice roll),
 *   so courts have character: Morytania is always hungry, cautious courts
 *   never start wars. Chance gates add timing noise, never personality.
 * - Resources matter. War chests pay for mobilization and sieges; a poor
 *   court cannot afford pride. Strength is weighed before steel is drawn —
 *   only the aggressive throw themselves at citadels.
 * - Weariness ends wars. Days bleed, lost sieges sting, empty coffers
 *   panic. The council offers white peace when the war is hopeless and
 *   accepts reasonable terms — it never fights to the last coin out of
 *   spite.
 * - The tick is pure: councilTick(store, { rng }) returns events, and the
 *   attach wrapper announces the notable ones. Tests drive the pure half.
 *
 * RuneScape grounding: the realm must feel alive when no player is
 * watching. Wars the tension engine starts on its own already proved the
 * appetite — the council just lets courts fight them with the full
 * formal machinery instead of bare raids.
 */

const Castle = require("./Castle.Kingdoms");
const Siege = require("./Siege.Kingdoms");
const Wars = require("./Wars.Kingdoms");
const Relations = require("./Relations.Kingdoms");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** ~60 minutes at 600ms/tick — courts deliberate on the realm clock. */
const COUNCIL_TASK_TICKS = 6000;

/** Temperaments: stable court character per kingdom. */
const TEMPERAMENT_AGGRESSIVE = "aggressive";
const TEMPERAMENT_OPPORTUNISTIC = "opportunistic";
const TEMPERAMENT_STEADFAST = "steadfast";
const TEMPERAMENT_CAUTIOUS = "cautious";

/** Border tension at which each temperament considers a formal war. */
const DECLARE_TENSION = {
  [TEMPERAMENT_AGGRESSIVE]: 80,
  [TEMPERAMENT_OPPORTUNISTIC]: 90,
  [TEMPERAMENT_STEADFAST]: 95,
  // Cautious courts never declare — they defend, endure, and sue for peace.
};

/** Per-tick chance a willing court actually declares (timing noise). */
const DECLARE_CHANCE = {
  [TEMPERAMENT_AGGRESSIVE]: 0.35,
  [TEMPERAMENT_OPPORTUNISTIC]: 0.25,
  [TEMPERAMENT_STEADFAST]: 0.15,
};

/** Minimum war-chest balance to even consider declaring war. */
const DECLARE_MIN_WARCHEST = 10_000_000;
/** Minimum war-chest balance to consider a siege. */
const SIEGE_MIN_WARCHEST = 5_000_000;
/** War-chest reserve a court never spends below. */
const WARCHEST_RESERVE = 2_000_000;

/**
 * Worst power ratio a temperament will attack at (attacker power /
 * defender fort defense). Aggressives gamble; steadfasts need odds.
 */
const MIN_ATTACK_RATIO = {
  [TEMPERAMENT_AGGRESSIVE]: 0.6,
  [TEMPERAMENT_OPPORTUNISTIC]: 1.0,
  [TEMPERAMENT_STEADFAST]: 1.3,
};

/** Share of the war chest committed to a siege, by temperament. */
const SIEGE_INVEST_PCT = {
  [TEMPERAMENT_AGGRESSIVE]: 0.2,
  [TEMPERAMENT_OPPORTUNISTIC]: 0.12,
  [TEMPERAMENT_STEADFAST]: 0.15,
  [TEMPERAMENT_CAUTIOUS]: 0.1,
};
/** Siege investment floor/ceiling (coins). */
const SIEGE_INVEST_MIN = 2_000_000;
const SIEGE_INVEST_MAX = 25_000_000;
/** Per-tick chance a willing court lays a siege. */
const SIEGE_CHANCE = 0.3;
/** Per-tick chance an aggressive court raids without a declared war. */
const RAID_CHANCE = 0.1;

/** Per-tick chance a besieged court sallies / repairs (when affordable). */
const DEFENSE_CHANCE = 0.4;
/** Sally only once the siege is this far along. */
const SALLY_PROGRESS_AT = 50;
/** Repair once the siege is this far along. */
const REPAIR_PROGRESS_AT = 30;

/** Weariness at which a court puts peace terms on the table. */
const OFFER_PEACE_WEARY = 60;
/** Weariness at which a court accepts a pending offer. */
const ACCEPT_PEACE_WEARY = 55;
/** White peace is cheap pride: accepted earlier. */
const ACCEPT_WHITE_PEACE_WEARY = 40;
/** A fresh offer needs time to travel before the council answers it. */
const PEACE_OFFER_MIN_AGE_MS = 2 * 3600 * 1000;

/** Per-tick chance a vassal past its oath-day breaks free. */
const VASSAL_BREAK_CHANCE = {
  [TEMPERAMENT_AGGRESSIVE]: 0.2,
  [TEMPERAMENT_OPPORTUNISTIC]: 0.1,
  [TEMPERAMENT_STEADFAST]: 0.05,
  [TEMPERAMENT_CAUTIOUS]: 0.03,
};

/** Founding flags — fledgling claims fight their own wars, not the realm's. */
const FLAG_FLEDGLING = "founding:fledgling";
const FLAG_SURVIVED = "founding:survived";

// ---------------------------------------------------------------------------
// Temperament
// ---------------------------------------------------------------------------

function hashId(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A court's character, stable across restarts: aggressive, opportunistic,
 * steadfast, or cautious. Lowerniel Drakan's Morytania is always hungry.
 */
function temperamentOf(kingdomId) {
  if (String(kingdomId) === "morytania") return TEMPERAMENT_AGGRESSIVE;
  const all = [
    TEMPERAMENT_AGGRESSIVE,
    TEMPERAMENT_OPPORTUNISTIC,
    TEMPERAMENT_STEADFAST,
    TEMPERAMENT_CAUTIOUS,
  ];
  return all[hashId(kingdomId) % all.length];
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function isFoundingKingdomRecord(kingdom) {
  const flags = kingdom?.flags ?? {};
  return flags[FLAG_FLEDGLING] === true || flags[FLAG_SURVIVED] === true;
}

/** Kingdoms the council may move: real powers, never fledgling claims. */
function councilKingdoms(store) {
  const list = typeof store.getKingdoms === "function" ? store.getKingdoms() : [];
  return list
    .map((k) => (k && typeof k === "object" ? k.id : k))
    .filter((id) => id && !isFoundingKingdomRecord(store.getKingdom?.(id)));
}

function pairsOf(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
  }
  return out;
}

function tensionKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function tensionOf(a, b, store) {
  const v = store.load().tension?.[tensionKey(a, b)];
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 20;
}

function warChestOf(kingdomId, store) {
  return store.load().castles?.[kingdomId]?.warChest ?? 0;
}

function fortDefenseOf(kingdomId, store) {
  const castle = Castle.getCastle(kingdomId, store);
  return castle ? Castle.fortDefense(castle) : 0;
}

/** Crude court power: walls plus the weight of the war chest. */
function courtPower(kingdomId, store) {
  return fortDefenseOf(kingdomId, store) + Math.floor(warChestOf(kingdomId, store) / 1_000_000);
}

function pendingOfferBetween(a, b, store) {
  const offers = store.load().peaceOffers ?? [];
  return (
    offers.find(
      (o) => o && ((o.a === a && o.b === b) || (o.a === b && o.b === a))
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// War weariness
// ---------------------------------------------------------------------------

/**
 * How tired a kingdom is of a war, 0-100. Days bleed, lost ground stings,
 * empty coffers panic. Pure function of the war record and the treasury.
 */
function wearinessOf(kingdomId, war, store) {
  if (!war) return 0;
  const days = Math.max(0, (Date.now() - (war.declaredAt ?? Date.now())) / (24 * 3600 * 1000));
  let score = Math.min(60, days * 20);

  // Losing ground: an enemy siege grinding at your walls.
  const siege = Siege.getSiege(kingdomId, store);
  if (siege && siege.status === "active" && (siege.progress ?? 0) > 50) {
    score += 30;
  }
  // Outgunned: the enemy's walls dwarf yours.
  const foe = war.attackerId === kingdomId ? war.defenderId : war.attackerId;
  const mine = Math.max(1, fortDefenseOf(kingdomId, store));
  const theirs = fortDefenseOf(foe, store);
  if (theirs > mine * 1.5) score += 15;
  // Broke: the war chest cannot take another season.
  if (warChestOf(kingdomId, store) < 5_000_000) score += 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------
// Council considerations
// ---------------------------------------------------------------------------

function attackerFirst(a, b) {
  const rank = {
    [TEMPERAMENT_AGGRESSIVE]: 0,
    [TEMPERAMENT_OPPORTUNISTIC]: 1,
    [TEMPERAMENT_STEADFAST]: 2,
    [TEMPERAMENT_CAUTIOUS]: 3,
  };
  return rank[temperamentOf(a)] <= rank[temperamentOf(b)] ? [a, b] : [b, a];
}

function chooseGoal(attackerId, defenderId, store) {
  const t = temperamentOf(attackerId);
  if (t === TEMPERAMENT_AGGRESSIVE) {
    // Hungry courts subjugate; against hard walls they settle for ruin.
    return fortDefenseOf(defenderId, store) > 2000 ? "territory" : "vassalize";
  }
  if (t === TEMPERAMENT_OPPORTUNISTIC) return "loot";
  return "territory";
}

const WAR_REASONS_AI = [
  "The court has counted its spears and found them sufficient.",
  "Border blood unpaid for too long; the council votes for war.",
  "The enemy's weakness is an insult the court will not abide.",
];

/** A willing court declares a formal war through the shared machinery. */
function considerWar(a, b, store, rng, events) {
  const [first, second] = attackerFirst(a, b);
  for (const [attacker, defender] of [
    [first, second],
    [second, first],
  ]) {
    const temperament = temperamentOf(attacker);
    const threshold = DECLARE_TENSION[temperament];
    if (threshold === undefined) continue; // cautious courts never declare
    if (tensionOf(attacker, defender, store) < threshold) continue;
    if (warChestOf(attacker, store) < DECLARE_MIN_WARCHEST) continue;

    const ratio = courtPower(attacker, store) / Math.max(1, fortDefenseOf(defender, store));
    if (ratio < (MIN_ATTACK_RATIO[temperament] ?? 1)) continue;
    if (rng() >= (DECLARE_CHANCE[temperament] ?? 0)) continue;

    const goal = chooseGoal(attacker, defender, store);
    const res = Wars.declareWarAi(attacker, defender, goal, store, {
      reason: WAR_REASONS_AI[Math.floor(rng() * WAR_REASONS_AI.length)],
    });
    if (res.ok) {
      events.push({
        type: "war-declared",
        attackerId: attacker,
        defenderId: defender,
        goal,
        reason: res.war.reason,
      });
      return; // one war per pair per tick is plenty
    }
  }
}

/** Courts at war (or hungry and hostile) lay sieges with real investments. */
function considerSiege(a, b, store, rng, events) {
  const [first, second] = attackerFirst(a, b);
  for (const [attacker, defender] of [
    [first, second],
    [second, first],
  ]) {
    const atWar = Wars.activeWarBetween(attacker, defender, store);
    const rel = Relations.relationOf(attacker, defender, store);
    const hostileRaid =
      !atWar &&
      temperamentOf(attacker) === TEMPERAMENT_AGGRESSIVE &&
      (rel === Relations.RELATION_HOSTILE || rel === Relations.RELATION_AT_WAR) &&
      tensionOf(attacker, defender, store) >= 90;

    if (!atWar && !hostileRaid) continue;
    if (rng() >= (hostileRaid ? RAID_CHANCE : SIEGE_CHANCE)) continue;

    const chest = warChestOf(attacker, store);
    if (chest < SIEGE_MIN_WARCHEST) continue;
    const existing = Siege.getSiege(defender, store);
    if (existing && existing.status === "active") continue;

    const pct = SIEGE_INVEST_PCT[temperamentOf(attacker)] ?? 0.1;
    const investment = Math.max(
      SIEGE_INVEST_MIN,
      Math.min(SIEGE_INVEST_MAX, Math.floor(chest * pct))
    );
    if (chest - (investment + Siege.SIEGE_DECLARE_COST) < WARCHEST_RESERVE) continue;

    const res = Siege.declareSiege(attacker, defender, investment, store);
    if (res.ok) {
      events.push({ type: "siege-declared", attackerId: attacker, defenderId: defender, investment });
    }
  }
}

/** Besieged courts defend their walls: sally when desperate, repair when pressed. */
function considerDefense(kingdomId, store, rng, events) {
  const siege = Siege.getSiege(kingdomId, store);
  if (!siege || siege.status !== "active") return;
  if (rng() >= DEFENSE_CHANCE) return;

  const chest = warChestOf(kingdomId, store);
  const progress = siege.progress ?? 0;
  if (progress >= SALLY_PROGRESS_AT && chest >= Siege.SALLY_COST * 2) {
    const res = Siege.sallyForth(kingdomId, store);
    if (res.ok) {
      events.push({ type: "sally", defenderId: kingdomId, progress: res.progress });
      return;
    }
  }
  if (progress >= REPAIR_PROGRESS_AT && chest >= Siege.REPAIR_COST * 4) {
    const res = Siege.repairWalls(kingdomId, store);
    if (res.ok) {
      events.push({ type: "repair", defenderId: kingdomId, progress: res.progress });
    }
  }
}

/**
 * Weary courts sue for peace; patient courts answer old offers. Offers are
 * only answered once they've had time to travel (older than this tick), so
 * a court never signs its own dispatch.
 */
function considerPeace(a, b, store, rng, events, tickStart) {
  const war = Wars.activeWarBetween(a, b, store);
  if (!war) return;

  const wearyA = wearinessOf(a, war, store);
  const wearyB = wearinessOf(b, war, store);

  // Answer old offers first — a tired court takes the exit it is given.
  const offer = pendingOfferBetween(a, b, store);
  if (offer && (offer.offeredAt ?? 0) < tickStart) {
    const acceptor = wearyA >= wearyB ? a : b;
    const other = acceptor === a ? b : a;
    const threshold =
      offer.terms?.type === "white-peace" ? ACCEPT_WHITE_PEACE_WEARY : ACCEPT_PEACE_WEARY;
    if ((acceptor === a ? wearyA : wearyB) >= threshold) {
      const res = Wars.acceptPeaceAi(acceptor, other, store);
      if (res.ok) {
        events.push({
          type: "peace-accepted",
          byId: acceptor,
          targetId: other,
          outcome: res.outcome,
          terms: res.applied?.type ?? null,
        });
        return;
      }
    }
  }

  // No exit on the table: the wearier side puts terms down.
  if (offer) return;
  const sufferer = wearyA >= wearyB ? a : b;
  const other = sufferer === a ? b : a;
  const weary = Math.max(wearyA, wearyB);
  if (weary < OFFER_PEACE_WEARY) return;
  if (rng() >= 0.5) return; // pride delays even the tired

  const res = Wars.offerPeaceAi(sufferer, other, { type: "white-peace" }, store);
  if (res.ok) {
    events.push({ type: "peace-offered", byId: sufferer, targetId: other, terms: "white-peace" });
  }
}

/** Resentful vassals past their oath-day may break free. */
function considerVassalBreak(kingdomId, store, rng, events) {
  const overlord = Wars.getVassalOverlord(kingdomId, store);
  if (!overlord) return;
  const chance = VASSAL_BREAK_CHANCE[temperamentOf(kingdomId)] ?? 0.05;
  if (rng() >= chance) return;
  const res = Wars.breakVassalageAi(kingdomId, store);
  if (res.ok) {
    events.push({ type: "vassalage-broken", vassalId: kingdomId, formerOverlord: res.formerOverlord });
  }
}

/**
 * One council session: every court considers war, sieges, defense, peace,
 * and oaths. Returns the notable events for the attach wrapper to announce.
 * Pure — pass a fixed rng for deterministic tests.
 */
function councilTick(store, opts = {}) {
  const rng = opts.rng ?? Math.random;
  const tickStart = Date.now();
  const events = [];
  const kingdoms = councilKingdoms(store);
  const pairs = pairsOf(kingdoms);

  for (const [a, b] of pairs) considerWar(a, b, store, rng, events);
  for (const [a, b] of pairs) considerSiege(a, b, store, rng, events);
  for (const k of kingdoms) considerDefense(k, store, rng, events);
  for (const [a, b] of pairs) considerPeace(a, b, store, rng, events, tickStart);
  for (const k of kingdoms) considerVassalBreak(k, store, rng, events);

  return events;
}

// ---------------------------------------------------------------------------
// Task wiring
// ---------------------------------------------------------------------------

/** ~60 minutes at 600ms/tick — courts deliberate on the realm clock. */
function attachAiWarfare(api) {
  // Lazy: the Task class is TypeScript, only resolvable at server runtime.
  const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");

  const announceToRealm = (message) => {
    try {
      api.core.World.getPlayers()
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
  };

  const kingdomName = (id) => {
    try {
      const Store = require("./KingdomStore");
      return Store.getKingdom(id)?.name ?? String(id);
    } catch {
      return String(id);
    }
  };

  const announceEvent = (e) => {
    try {
      if (e.type === "war-declared") {
        // Persist through the shared event so every listener (refugees,
        // alliances, war consequences, realm reactions) fires exactly once.
        // Events.onWarDeclared dedupes against the record we just wrote.
        api.emitCustomEvent("kingdom:war-declared", {
          attackerId: e.attackerId,
          defenderId: e.defenderId,
          declaredBy: "ai-council",
          reason: e.reason ?? null,
          resolveAt: null,
        });
        announceToRealm(
          `[Realm] WAR! ${kingdomName(e.attackerId)} has declared war on ${kingdomName(e.defenderId)} — ` +
            `a War of ${Wars.WAR_GOAL_LABELS[e.goal] ?? e.goal}.`
        );
        console.info("[ai-warfare] war declared", e);
      } else if (e.type === "siege-declared") {
        announceToRealm(
          `[Realm] ${kingdomName(e.attackerId)} has laid siege to ${kingdomName(e.defenderId)}. ` +
            `The walls will be tested.`
        );
        console.info("[ai-warfare] siege declared", e);
      } else if (e.type === "peace-accepted") {
        api.emitCustomEvent("kingdom:war-ended", {
          attackerId: e.byId,
          defenderId: e.targetId,
          outcome: "peace-treaty",
        });
        announceToRealm(
          `[Realm] Peace between ${kingdomName(e.byId)} and ${kingdomName(e.targetId)}: ` +
            `the courts sign a treaty and the levies march home.`
        );
        console.info("[ai-warfare] peace accepted", e);
      } else if (e.type === "vassalage-broken") {
        announceToRealm(
          `[Realm] ${kingdomName(e.vassalId)} has broken its oath to ${kingdomName(e.formerOverlord)}. ` +
            `Independence — and fury.`
        );
        console.info("[ai-warfare] vassalage broken", e);
      } else if (e.type === "peace-offered") {
        console.info("[ai-warfare] peace offered", e);
      } else {
        // Sally / repair: the war table shows them; the realm needn't hear.
        console.info("[ai-warfare] defense", e);
      }
    } catch (error) {
      console.warn("[ai-warfare] announce failed", error?.message ?? error);
    }
  };

  class AiWarfareTask extends Task {
    execute() {
      try {
        const Store = require("./KingdomStore");
        const events = councilTick(Store);
        for (const e of events) announceEvent(e);
      } catch (error) {
        console.warn("[ai-warfare] council tick failed", error?.message ?? error);
      }
    }
  }
  api.getTaskManager()?.submit(new AiWarfareTask(COUNCIL_TASK_TICKS));
  console.info("[ai-warfare] war council armed", { tickTicks: COUNCIL_TASK_TICKS });
}

module.exports = attachAiWarfare;
module.exports.attachAiWarfare = attachAiWarfare;
module.exports.councilTick = councilTick;
module.exports.temperamentOf = temperamentOf;
module.exports.wearinessOf = wearinessOf;
module.exports.COUNCIL_TASK_TICKS = COUNCIL_TASK_TICKS;
module.exports.TEMPERAMENT_AGGRESSIVE = TEMPERAMENT_AGGRESSIVE;
module.exports.TEMPERAMENT_OPPORTUNISTIC = TEMPERAMENT_OPPORTUNISTIC;
module.exports.TEMPERAMENT_STEADFAST = TEMPERAMENT_STEADFAST;
module.exports.TEMPERAMENT_CAUTIOUS = TEMPERAMENT_CAUTIOUS;
