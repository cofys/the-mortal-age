"use strict";

/**
 * AiDiplomacy.Kingdoms — the AI diplomacy council (Phase 7).
 *
 * The war council (AiWarfare) taught courts to fight; this teaches them to
 * make friends — and to break them. Until now pacts only formed when a
 * player-held steward negotiated them (Diplomacy.negotiate) — empty
 * offices meant a friendless realm. The diplomacy council lets every
 * court seal its own pacts, answer calls to arms, and (for the hungry
 * ones) knife an ally in the back.
 *
 * Design rules:
 * - Same machinery as every other driver. Pacts form through the
 *   kingdom:alliance-formed event (the Alliances registry persists,
 *   pins tension, announces). Wars go through Wars.declareWarAi with
 *   the exact gates players face. Betrayals travel as kingdom:betrayal
 *   + kingdom:alliance-broken (reason "betrayal"), the same pair
 *   Diplomacy.resolveBetrayal emits — the outrage stays identical.
 * - Temperament is stable per kingdom (shared with AiWarfare): steadfast
 *   and cautious courts ally readily; opportunists ally when it pays;
 *   aggressives only trust a shared enemy. Only opportunists and
 *   aggressives backstab — a steadfast court's word is its bond.
 * - The tick is pure: councilDiplomacyTick(store, { rng }) returns
 *   events, and the attach wrapper emits/announces them. Tests drive
 *   the pure half with fixed rng.
 *
 * RuneScape grounding: the realm must redraw its map of friends while
 * no player is watching. A pact sealed in the night, a betrayal at
 * dawn — the heralds announce both, and the war table shows the rest.
 */

const Castle = require("./Castle.Kingdoms");
const Siege = require("./Siege.Kingdoms");
const Wars = require("./Wars.Kingdoms");
const Relations = require("./Relations.Kingdoms");
const AiWarfare = require("./AiWarfare.Kingdoms");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** ~60 minutes at 600ms/tick — courts deliberate on the realm clock. */
const DIPLOMACY_TASK_TICKS = 6000;

/** Calm-enough borders to sign a pact (matches Diplomacy.negotiate). */
const PACT_MAX_TENSION = 40;
/** Base per-tick chance a willing pair seals a pact. */
const PACT_CHANCE = 0.08;
/** Chance when the pair shares a rival or both run fat treasuries. */
const PACT_MOTIVATED_CHANCE = 0.2;
/** Aggressive courts distrust everyone but a shared enemy. */
const AGGRESSIVE_PACT_MULT = 0.3;
/** Cautious and steadfast courts like the safety of numbers. */
const STEADY_PACT_MULT = 1.2;
/** Embassy gifts: what each court spends from its war chest to seal a pact. */
const PACT_EMBASSY_COST = 500_000;
/** War-chest floor a court never spends below. */
const WARCHEST_RESERVE = 2_000_000;
/** Both courts this rich want pact roads (trade motivation). */
const TRADE_PACT_MIN_CHEST = 5_000_000;
/** Shared-enemy tension: both courts fear the same third power. */
const SHARED_ENEMY_TENSION = 60;
/** Days a broken pact keeps the pair from re-signing. */
const PACT_COOLDOWN_DAYS = 7;

/** Loyalty when an ally's call to arms arrives, by temperament. */
const LOYALTY_BASE = {
  aggressive: 0.65,
  opportunistic: 0.45,
  steadfast: 0.85,
  cautious: 0.6,
};
/** Stronger pacts hold better. */
const LOYALTY_PER_STRENGTH = 0.05;
/** An ally already hot with the attacker may be the real problem. */
const LOYALTY_HOT_ATTACKER_PENALTY = 0.2;
const HOT_ATTACKER_TENSION = 50;
/** Outgunned allies think twice. */
const LOYALTY_OUTGUNNED_PENALTY = 0.15;

/** Betrayal risk at which a hungry court starts eyeing its ally. */
const BETRAYAL_TEMPTATION_RISK = 60;
/** Per-tick backstab chance for a tempted court. */
const BETRAYAL_CHANCE = {
  opportunistic: 0.15,
  aggressive: 0.1,
};
/** Tension above this bleeds betrayal risk into a pact each tick. */
const BETRAYAL_DRIFT_TENSION = 40;
const BETRAYAL_DRIFT_DELTA = 5;
/** A fat ally is a tempting ally (multiple of the betrayer's chest). */
const BETRAYAL_FAT_ALLY_MULT = 3;
/** Kicking a besieged ally while they're down: siege progress threshold. */
const BETRAYAL_SIEGE_PROGRESS = 60;

/** Strong pacts earn their strength: prosperity + calm borders. */
const PACT_UPKEEP_CHANCE = 0.1;
const PACT_UPKEEP_MIN_CHEST = 10_000_000;
const PACT_UPKEEP_MAX_TENSION = 20;

/** Founding flags — fledgling claims sign no pacts. */
const FLAG_FLEDGLING = "founding:fledgling";
const FLAG_SURVIVED = "founding:survived";

/** A shattered pact spikes the betrayed side's fury. */
const BETRAYAL_TENSION = 30;
/** An ally excused in absence still leaves a chill. */
const ABSENCE_TENSION = 10;

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function pairKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

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

function tensionOf(a, b, store) {
  const v = store.load().tension?.[pairKey(a, b)];
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 20;
}

function addTension(a, b, delta, store) {
  const state = store.load();
  if (!state.tension || typeof state.tension !== "object") state.tension = {};
  const key = pairKey(a, b);
  const cur = Number.isFinite(state.tension[key]) ? state.tension[key] : 20;
  state.tension[key] = Math.max(0, Math.min(100, Math.round(cur + delta)));
}

function warChestOf(kingdomId, store) {
  return store.load().castles?.[kingdomId]?.warChest ?? 0;
}

function spendWarChest(kingdomId, amount, store) {
  const castle = store.load().castles?.[kingdomId];
  if (!castle || (castle.warChest ?? 0) < amount) return false;
  castle.warChest -= amount;
  return true;
}

function fortDefenseOf(kingdomId, store) {
  const castle = Castle.getCastle(kingdomId, store);
  return castle ? Castle.fortDefense(castle) : 0;
}

/** Crude court power: walls plus the weight of the war chest. */
function courtPower(kingdomId, store) {
  return fortDefenseOf(kingdomId, store) + Math.floor(warChestOf(kingdomId, store) / 1_000_000);
}

function temperamentOf(kingdomId) {
  return AiWarfare.temperamentOf(kingdomId);
}

function alliancesOf(store) {
  const alliances = store.load().alliances;
  return Array.isArray(alliances) ? alliances : [];
}

function pactRecord(a, b, store) {
  const [x, y] = [String(a), String(b)].sort();
  return alliancesOf(store).find((r) => r && r.a === x && r.b === y) ?? null;
}

function isAllied(a, b, store) {
  return pactRecord(a, b, store) !== null;
}

function alliesOf(kingdomId, store) {
  const id = String(kingdomId);
  return alliancesOf(store)
    .filter((r) => r && (r.a === id || r.b === id))
    .map((r) => (r.a === id ? r.b : r.a));
}

function adjustPact(a, b, { strengthDelta = 0, betrayalRiskDelta = 0 }, store) {
  const rec = pactRecord(a, b, store);
  if (!rec) return null;
  rec.betrayalRisk = Math.max(0, Math.min(100, (rec.betrayalRisk ?? 0) + betrayalRiskDelta));
  rec.strength = Math.max(1, Math.min(5, (rec.strength ?? 1) + strengthDelta));
  return rec;
}

/**
 * Remove a pact from the store. The wrapper still emits
 * kingdom:alliance-broken afterwards — the Alliances registry tolerates
 * already-removed records (no double announce), and the cooldown
 * listener still records the break.
 */
function removePact(a, b, store) {
  const [x, y] = [String(a), String(b)].sort();
  const state = store.load();
  const alliances = alliancesOf(store);
  const idx = alliances.findIndex((r) => r && r.a === x && r.b === y);
  if (idx === -1) return null;
  const [rec] = alliances.splice(idx, 1);
  return rec;
}

/** Trust is contagious in the wrong direction: every pact trembles. */
function weakenAllPacts(store) {
  for (const r of alliancesOf(store)) {
    if (!r) continue;
    r.strength = Math.max(1, Math.min(5, (r.strength ?? 1) - 1));
  }
}

function activeWars(store) {
  const wars = store.load().wars;
  return Array.isArray(wars) ? wars.filter((w) => w && w.active) : [];
}

function atWarBetween(a, b, store) {
  return activeWars(store).some(
    (w) =>
      (w.attackerId === a && w.defenderId === b) ||
      (w.attackerId === b && w.defenderId === a)
  );
}

function atAnyWar(kingdomId, store) {
  return activeWars(store).some((w) => w.attackerId === kingdomId || w.defenderId === kingdomId);
}

function vassalBound(a, b, store) {
  return (
    Wars.getVassalOverlord(a, store) === b || Wars.getVassalOverlord(b, store) === a
  );
}

function pactCooldowns(store) {
  const state = store.load();
  if (!state.pactCooldowns || typeof state.pactCooldowns !== "object") {
    state.pactCooldowns = {};
  }
  return state.pactCooldowns;
}

function pactOnCooldown(a, b, store) {
  const since = pactCooldowns(store)[pairKey(a, b)] ?? 0;
  return Date.now() - since < PACT_COOLDOWN_DAYS * 24 * 3600 * 1000;
}

function defenseCalls(store) {
  const state = store.load();
  if (!state.defenseCalls || typeof state.defenseCalls !== "object") {
    state.defenseCalls = {};
  }
  return state.defenseCalls;
}

function warKey(war) {
  return `${war.attackerId}:${war.defenderId}:${war.declaredAt ?? 0}`;
}

/** A third power both courts fear: the classic reason to sign a pact. */
function sharedEnemy(a, b, store) {
  for (const k of councilKingdoms(store)) {
    if (k === a || k === b) continue;
    if (atWarBetween(a, k, store) || atWarBetween(b, k, store)) return k;
    if (
      tensionOf(a, k, store) >= SHARED_ENEMY_TENSION &&
      tensionOf(b, k, store) >= SHARED_ENEMY_TENSION
    ) {
      return k;
    }
  }
  return null;
}

function nameOf(kingdomId, store) {
  return store.getKingdom?.(kingdomId)?.name ?? String(kingdomId);
}

function capitalOf(kingdomId, store) {
  return store.getKingdom?.(kingdomId)?.capital ?? nameOf(kingdomId, store);
}

function pactNameFor(a, b, store, rng) {
  const capA = capitalOf(a, store);
  const capB = capitalOf(b, store);
  const names = [
    `the ${capA} Accords`,
    `the Pact of ${capA}`,
    `the ${capA}-${capB} Compact`,
    `the ${capA} Concord`,
  ];
  return names[Math.floor(rng() * names.length)];
}

// ---------------------------------------------------------------------------
// Pact formation
// ---------------------------------------------------------------------------

/**
 * Courts seal pacts on their own: calm borders, a shared enemy or fat
 * treasuries to trade with, and temperaments that can stand each other.
 * Aggressive courts only trust a shared enemy.
 */
function considerPacts(store, rng, events) {
  const kingdoms = councilKingdoms(store);
  for (const [a, b] of pairsOf(kingdoms)) {
    if (isAllied(a, b, store) || atWarBetween(a, b, store)) continue;
    if (vassalBound(a, b, store)) continue;
    if (pactOnCooldown(a, b, store)) continue;
    if (tensionOf(a, b, store) > PACT_MAX_TENSION) continue;

    const tempA = temperamentOf(a);
    const tempB = temperamentOf(b);
    const enemy = sharedEnemy(a, b, store);
    if (
      tempA === AiWarfare.TEMPERAMENT_AGGRESSIVE &&
      tempB === AiWarfare.TEMPERAMENT_AGGRESSIVE &&
      !enemy
    ) {
      continue; // two hungry courts sign nothing without a common fear
    }

    const trade = warChestOf(a, store) >= TRADE_PACT_MIN_CHEST && warChestOf(b, store) >= TRADE_PACT_MIN_CHEST;
    let chance = enemy || trade ? PACT_MOTIVATED_CHANCE : PACT_CHANCE;
    if (tempA === AiWarfare.TEMPERAMENT_AGGRESSIVE || tempB === AiWarfare.TEMPERAMENT_AGGRESSIVE) {
      chance *= enemy ? 1 : AGGRESSIVE_PACT_MULT;
    }
    if (
      (tempA === AiWarfare.TEMPERAMENT_STEADFAST || tempA === AiWarfare.TEMPERAMENT_CAUTIOUS) &&
      (tempB === AiWarfare.TEMPERAMENT_STEADFAST || tempB === AiWarfare.TEMPERAMENT_CAUTIOUS)
    ) {
      chance *= STEADY_PACT_MULT;
    }
    if (rng() >= chance) continue;

    // Embassy gifts: both courts pay, neither below its reserve.
    if (warChestOf(a, store) - PACT_EMBASSY_COST < WARCHEST_RESERVE) continue;
    if (warChestOf(b, store) - PACT_EMBASSY_COST < WARCHEST_RESERVE) continue;
    spendWarChest(a, PACT_EMBASSY_COST, store);
    spendWarChest(b, PACT_EMBASSY_COST, store);

    const pactName = pactNameFor(a, b, store, rng);
    events.push({ type: "pact-formed", a, b, pactName, sharedEnemy: enemy });
  }
}

/**
 * Strong pacts earn their strength: prosperous courts with calm borders
 * deepen the bond, which feeds the strength-scaled trade bonus.
 */
function considerPactUpkeep(store, rng, events) {
  for (const r of alliancesOf(store)) {
    if (!r) continue;
    if ((r.strength ?? 1) >= 5) continue;
    if (
      warChestOf(r.a, store) < PACT_UPKEEP_MIN_CHEST ||
      warChestOf(r.b, store) < PACT_UPKEEP_MIN_CHEST
    ) {
      continue;
    }
    if (tensionOf(r.a, r.b, store) > PACT_UPKEEP_MAX_TENSION) continue;
    if (rng() >= PACT_UPKEEP_CHANCE) continue;
    const rec = adjustPact(r.a, r.b, { strengthDelta: 1 }, store);
    if (rec) {
      events.push({ type: "pact-strengthened", a: r.a, b: r.b, strength: rec.strength });
    }
  }
}

// ---------------------------------------------------------------------------
// Mutual defense — allies answer calls to arms
// ---------------------------------------------------------------------------

function loyaltyOf(allyId, defenderId, attackerId, store) {
  const t = temperamentOf(allyId);
  let loyalty = LOYALTY_BASE[t] ?? 0.5;
  const rec = pactRecord(defenderId, allyId, store);
  loyalty += LOYALTY_PER_STRENGTH * ((rec?.strength ?? 1) - 1);
  if (tensionOf(allyId, attackerId, store) > HOT_ATTACKER_TENSION) {
    loyalty -= LOYALTY_HOT_ATTACKER_PENALTY;
  }
  if (courtPower(attackerId, store) > courtPower(allyId, store) * 1.5) {
    loyalty -= LOYALTY_OUTGUNNED_PENALTY;
  }
  return Math.max(0.05, Math.min(0.95, loyalty));
}

function chooseJoinGoal(allyId, defenderId, store) {
  const t = temperamentOf(allyId);
  if (t === AiWarfare.TEMPERAMENT_AGGRESSIVE) {
    return fortDefenseOf(defenderId, store) > 2000 ? "territory" : "vassalize";
  }
  return "territory";
}

/**
 * Every active war: each ally of the defender that hasn't answered the
 * call rolls loyalty. It marches (declares war on the attacker through
 * the shared machinery — the war council's siege logic then picks the
 * new pair up on its own tick, so joint sieges emerge for free), is
 * excused in absence when its own war consumes every blade, or refuses
 * — and a refusal is a betrayal.
 *
 * Tension-declared wars are answered by Diplomacy's own listener; pact
 * wars never chain. This council answers the rest.
 */
function considerDefenseCalls(store, rng, events) {
  const calls = defenseCalls(store);
  for (const war of activeWars(store)) {
    if (war.declaredBy === "tension" || war.declaredBy === "alliance") continue;
    const { attackerId, defenderId } = war;
    if (!attackerId || !defenderId) continue;
    const key = warKey(war);
    if (!calls[key] || typeof calls[key] !== "object") calls[key] = {};
    const answered = calls[key];

    for (const ally of alliesOf(defenderId, store)) {
      if (ally === attackerId || answered[ally]) continue;
      if (atWarBetween(ally, attackerId, store)) {
        answered[ally] = "joined"; // already fighting them: no call needed
        continue;
      }
      const rec = pactRecord(defenderId, ally, store);

      if (atAnyWar(ally, store)) {
        // Its own war consumes every blade: the pact dissolves in
        // absence, not anger.
        answered[ally] = "absent";
        removePact(defenderId, ally, store);
        addTension(defenderId, ally, ABSENCE_TENSION, store);
        events.push({
          type: "defense-absent",
          ally,
          defender: defenderId,
          attacker: attackerId,
          pactName: rec?.pactName ?? null,
        });
        continue;
      }

      if (rng() < loyaltyOf(ally, defenderId, attackerId, store)) {
        const goal = chooseJoinGoal(ally, defenderId, store);
        const res = Wars.declareWarAi(ally, attackerId, goal, store, {
          reason: `${nameOf(ally, store)} honors its pact — marches to ${nameOf(defenderId, store)}'s defense`,
        });
        if (res.ok) {
          answered[ally] = "joined";
          adjustPact(defenderId, ally, { strengthDelta: 1 }, store);
          addTension(defenderId, ally, -5, store);
          events.push({
            type: "defense-joined",
            ally,
            defender: defenderId,
            attacker: attackerId,
            goal,
          });
        }
        // If the gates refuse (cooldown, etc.), the call stays
        // unanswered — the court tries again next tick.
      } else {
        // A refusal is a betrayal: the pact shatters here so the
        // outrage and the record agree.
        answered[ally] = "refused";
        removePact(defenderId, ally, store);
        addTension(ally, defenderId, BETRAYAL_TENSION, store);
        weakenAllPacts(store);
        events.push({
          type: "defense-refused",
          betrayer: ally,
          betrayed: defenderId,
          pactName: rec?.pactName ?? null,
          via: "war-refusal",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Betrayal — the hungry knife their friends
// ---------------------------------------------------------------------------

function betrayalTempted(betrayer, ally, store) {
  const rec = pactRecord(betrayer, ally, store);
  if ((rec?.betrayalRisk ?? 0) >= BETRAYAL_TEMPTATION_RISK) return "schemes";
  if (warChestOf(ally, store) > warChestOf(betrayer, store) * BETRAYAL_FAT_ALLY_MULT) {
    return "rich-ally";
  }
  const siege = Siege.getSiege(ally, store);
  if (siege && siege.status === "active" && (siege.progress ?? 0) >= BETRAYAL_SIEGE_PROGRESS) {
    return "wounded-ally";
  }
  return null;
}

/**
 * Opportunistic and aggressive courts — and only them — may backstab a
 * tempting ally: the pact shatters in betrayal, then steel follows. One
 * backstab per tick is plenty of drama.
 */
function considerBetrayals(store, rng, events) {
  for (const r of alliancesOf(store)) {
    if (!r) continue;
    for (const [betrayer, betrayed] of [
      [r.a, r.b],
      [r.b, r.a],
    ]) {
      const t = temperamentOf(betrayer);
      if (
        t !== AiWarfare.TEMPERAMENT_OPPORTUNISTIC &&
        t !== AiWarfare.TEMPERAMENT_AGGRESSIVE
      ) {
        continue; // steadfast and cautious courts keep their word
      }
      const via = betrayalTempted(betrayer, betrayed, store);
      if (!via) continue;
      if (rng() >= (BETRAYAL_CHANCE[t] ?? 0)) continue;

      const goal = t === AiWarfare.TEMPERAMENT_AGGRESSIVE ? "vassalize" : "loot";
      // Shatter the pact first — the gates refuse wars on allies, and a
      // backstab is no declaration until the knives are out.
      removePact(betrayer, betrayed, store);
      addTension(betrayer, betrayed, BETRAYAL_TENSION, store);
      weakenAllPacts(store);
      events.push({
        type: "betrayal",
        betrayer,
        betrayed,
        pactName: r.pactName ?? null,
        via: `backstab-${via}`,
      });
      const res = Wars.declareWarAi(betrayer, betrayed, goal, store, {
        reason: `${nameOf(betrayer, store)} tore up ${r.pactName ?? "the pact"} — the knives were already out`,
      });
      events[events.length - 1].warDeclared = res.ok === true;
      return; // one backstab per tick
    }
  }
}

/**
 * Diverging interests poison pacts slowly: courts glaring across the
 * border anyway see their betrayal risk climb, until schemes or a
 * hungry court finish the job.
 */
function considerBetrayalDrift(store) {
  for (const r of alliancesOf(store)) {
    if (!r) continue;
    if (tensionOf(r.a, r.b, store) > BETRAYAL_DRIFT_TENSION) {
      adjustPact(r.a, r.b, { betrayalRiskDelta: BETRAYAL_DRIFT_DELTA }, store);
    }
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * One diplomacy session: courts seal pacts, deepen them, answer calls to
 * arms, and knife their friends. Returns the notable events for the
 * attach wrapper to emit and announce. Pure — pass a fixed rng for
 * deterministic tests.
 */
function councilDiplomacyTick(store, opts = {}) {
  const rng = opts.rng ?? Math.random;
  const events = [];

  considerPacts(store, rng, events);
  considerPactUpkeep(store, rng, events);
  considerDefenseCalls(store, rng, events);
  considerBetrayalDrift(store);
  considerBetrayals(store, rng, events);

  return events;
}

// ---------------------------------------------------------------------------
// Task wiring
// ---------------------------------------------------------------------------

const BETRAYAL_LINES = (betrayerName, betrayedName, pactName) => [
  `BETRAYAL! ${betrayerName} has torn up ${pactName} — ${betrayedName} envoys were turned away at the border with steel.`,
  `BETRAYAL! ${pactName} is a lie — ${betrayerName} knives were found in ${betrayedName} backs. The realm will remember this.`,
];

/** A broken pact keeps the pair from re-signing for a season. */
function recordPactCooldown(event) {
  try {
    const a = event?.a;
    const b = event?.b;
    if (!a || !b) return;
    const Store = require("./KingdomStore");
    const state = Store.load();
    if (!state.pactCooldowns || typeof state.pactCooldowns !== "object") {
      state.pactCooldowns = {};
    }
    state.pactCooldowns[pairKey(a, b)] = Date.now();
    Store.save();
  } catch (error) {
    console.warn("[ai-diplomacy] pact cooldown failed", error?.message ?? error);
  }
}

function attachAiDiplomacy(api) {
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

  /**
   * Mirror of Diplomacy.resolveBetrayal: same events, same outrage. State
   * (pact removal, tension spike, weakened pacts) is already settled in
   * the tick — this only emits and announces.
   */
  const resolveBetrayal = (betrayer, betrayed, pactName, via) => {
    const betrayerName = kingdomName(betrayer);
    const betrayedName = kingdomName(betrayed);
    const pactLabel = pactName ?? "the pact";
    const lines = BETRAYAL_LINES(betrayerName, betrayedName, pactLabel);
    const text = lines[Math.floor(Math.random() * lines.length)];
    api.emitCustomEvent("kingdom:betrayal", {
      betrayer,
      betrayed,
      via,
      pactName: pactName ?? null,
      text,
    });
    api.emitCustomEvent("kingdom:alliance-broken", {
      a: betrayer,
      b: betrayed,
      pactName: pactName ?? null,
      reason: "betrayal",
    });
    announceToRealm(`[Realm] ${text}`);
    console.info("[ai-diplomacy] betrayal", { betrayer, betrayed, via });
  };

  const announceEvent = (e) => {
    try {
      if (e.type === "pact-formed") {
        // The Alliances registry persists, pins tension, and announces —
        // this is the same event stewards and questlines emit.
        api.emitCustomEvent("kingdom:alliance-formed", {
          a: e.a,
          b: e.b,
          pactName: e.pactName,
          broker: "ai-council",
        });
        console.info("[ai-diplomacy] pact formed", e);
      } else if (e.type === "pact-strengthened") {
        console.info("[ai-diplomacy] pact strengthened", e);
      } else if (e.type === "defense-joined") {
        // The war record is already written by declareWarAi; the event
        // lets every listener (alliances, war table, refugees) fire once.
        api.emitCustomEvent("kingdom:war-declared", {
          attackerId: e.ally,
          defenderId: e.attacker,
          declaredBy: "alliance",
          reason: `${kingdomName(e.ally)} honors its pact — marches to ${kingdomName(e.defender)}'s defense`,
        });
        announceToRealm(
          `[Realm] ${kingdomName(e.ally)} HONORS its pact — marches to ` +
            `${kingdomName(e.defender)}'s defense against ${kingdomName(e.attacker)}!`
        );
        console.info("[ai-diplomacy] mutual defense", e);
      } else if (e.type === "defense-absent") {
        // State (pact removal, tension chill) is settled in the tick —
        // this only emits and announces.
        api.emitCustomEvent("kingdom:alliance-broken", {
          a: e.defender,
          b: e.ally,
          pactName: e.pactName,
          reason: "absence",
        });
        announceToRealm(
          `[Realm] ${kingdomName(e.ally)} could not answer ${kingdomName(e.defender)}'s call — ` +
            `its own war consumes every blade. The pact dissolves, not in anger but in absence.`
        );
        console.info("[ai-diplomacy] defense absent", e);
      } else if (e.type === "defense-refused" || e.type === "betrayal") {
        resolveBetrayal(e.betrayer, e.betrayed, e.pactName, e.via);
        if (e.type === "betrayal" && e.warDeclared) {
          api.emitCustomEvent("kingdom:war-declared", {
            attackerId: e.betrayer,
            defenderId: e.betrayed,
            declaredBy: "ai-council",
            reason: "backstab",
            resolveAt: null,
          });
        }
      } else {
        console.info("[ai-diplomacy] event", e);
      }
    } catch (error) {
      console.warn("[ai-diplomacy] announce failed", error?.message ?? error);
    }
  };

  api.onCustomEvent("kingdom:alliance-broken", recordPactCooldown);

  class AiDiplomacyTask extends Task {
    execute() {
      try {
        const Store = require("./KingdomStore");
        const events = councilDiplomacyTick(Store);
        for (const e of events) announceEvent(e);
        Store.save();
      } catch (error) {
        console.warn("[ai-diplomacy] council tick failed", error?.message ?? error);
      }
    }
  }
  api.getTaskManager()?.submit(new AiDiplomacyTask(DIPLOMACY_TASK_TICKS));
  console.info("[ai-diplomacy] diplomacy council armed", { tickTicks: DIPLOMACY_TASK_TICKS });
}

module.exports = attachAiDiplomacy;
module.exports.attachAiDiplomacy = attachAiDiplomacy;
module.exports.councilDiplomacyTick = councilDiplomacyTick;
module.exports.loyaltyOf = loyaltyOf;
module.exports.temperamentOf = temperamentOf;
module.exports.DIPLOMACY_TASK_TICKS = DIPLOMACY_TASK_TICKS;
module.exports.PACT_MAX_TENSION = PACT_MAX_TENSION;
module.exports.PACT_EMBASSY_COST = PACT_EMBASSY_COST;
