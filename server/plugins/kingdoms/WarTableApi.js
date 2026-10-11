"use strict";

/**
 * WarTableApi — HTTP data layer for the web client's war table overlay.
 *
 * The war table is studied diegetically (a table object in each capital's
 * war room); the overlay itself is a React HTML/CSS panel in the TMA
 * heraldic style, fed by this endpoint:
 *
 *   GET /api/wartable-status?player=<username>
 *     -> { open, playerKingdom, warCosts, warGates, kingdoms, wars,
 *          endedWars, alliances, relations, sieges, homeDetail }
 *
 *   ...&action=open    — mark the table open for this player
 *   ...&action=close   — mark the table closed for this player
 *
 * Warfare actions (Phase 5) — all require the player to hold a kingdom
 * (kingdom:id attribute); influence costs are spent from the player's own
 * standing. Each returns { actionResult, ...status } so the overlay can
 * show the outcome and refresh in one round trip:
 *
 *   action=declare-war&target=<id>&goal=<loot|territory|vassalize>
 *   action=offer-peace&target=<id>&terms=<white-peace|tribute|vassalize>&tribute=<coins>
 *   action=accept-peace&target=<id>
 *   action=break-vassalage
 *   action=envoy&target=<id>
 *   action=ultimatum&target=<id>
 *   action=declare-siege&target=<id>&investment=<coins>
 *   action=contribute-supply&cat=<food|arrows|runes|materials>
 *                             (deliver everything you carry of the category
 *                              through the donation chest's deliverSupplies)
 *   action=sally            (defender: sally forth against the besieger)
 *   action=repair           (defender: emergency wall repairs)
 *   action=lift-siege&target=<id>  (attacker: abandon the siege)
 *   action=back-claimant&target=<kingdomId>&claimant=<id>
 *                             (back a succession claimant with court influence)
 *
 * Succession payload (Phase 9): `successionCrises` (open crises with
 * claimant shares) and `civilWars` (active civil wars with sides and drain).
 *
 * Read-heavy by design: writes are the open/close flag and the warfare
 * actions above, each gated by the same checks as the underlying modules.
 */

const Store = require("./KingdomStore");
const Castle = require("./Castle.Kingdoms");
const Siege = require("./Siege.Kingdoms");
const Relations = require("./Relations.Kingdoms");
const Wars = require("./Wars.Kingdoms");
const WarSupply = require("./WarSupply.Kingdoms");
const Coalitions = require("./Coalitions.Kingdoms");
const AiDiplomacy = require("./AiDiplomacy.Kingdoms");
const Influence = require("./Influence.Kingdoms");
const Switching = require("./Switching.Kingdoms");
const WarResolution = require("./WarResolution.Kingdoms");
const Battles = require("./Battles.Kingdoms");
const Espionage = require("./Espionage.Kingdoms");

const WARTABLE_OPEN_ATTRIBUTE = "wartable:open";

function kingdomName(id) {
  const k = Store.getKingdom(id);
  return k ? k.name : String(id);
}

/** Troops under arms: staffed guards in barracks + guardhouse. */
function troopCount(castle) {
  if (!castle) return 0;
  return (
    Castle.staffingInfo(castle, "barracks").staffed +
    Castle.staffingInfo(castle, "guardhouse").staffed
  );
}

function castlePayload(kingdomId) {
  const castle = Castle.getCastle(kingdomId, Store);
  if (!castle) return null;
  const fortDef = Castle.fortTierDef(castle.fortTier);
  return {
    fortTier: castle.fortTier,
    fortName: fortDef.name,
    defense: Castle.fortDefense(castle),
    troops: troopCount(castle),
    warChest: castle.warChest ?? 0,
    buildings: Object.keys(castle.buildings ?? {}).length,
  };
}

function kingdomPayload(k, homeId) {
  const payload = {
    id: k.id,
    name: k.name,
    capital: k.capital ?? null,
    ruler: k.ruler ?? null,
    rulerTitle: k.rulerTitle ?? null,
    treasury: k.treasury ?? 0,
    situation: k.situation ?? null,
    castle: castlePayload(k.id),
  };
  if (homeId && homeId !== k.id) {
    payload.relation = Relations.relationOf(homeId, k.id, Store);
  } else if (homeId) {
    payload.relation = Relations.RELATION_SELF;
  }

  // Realm-map status: vassalage and live conflict indicators, so the war
  // table can draw the realm's fealty and battle lines at a glance.
  const state = Store.load();
  const vassals = state.vassals ?? {};
  const sieges = Object.values(state.sieges ?? {});
  const myVassalRecord = vassals[k.id];
  payload.vassalOf = myVassalRecord?.overlordId ?? null;
  payload.vassalOfName = payload.vassalOf ? kingdomName(payload.vassalOf) : null;
  payload.vassalCount = Object.values(vassals).filter(
    (r) => r && r.overlordId === k.id
  ).length;
  payload.underSiege = sieges.some(
    (s) => s && s.status === "active" && s.defenderKingdomId === k.id
  );
  payload.besiegingCount = sieges.filter(
    (s) => s && s.status === "active" && s.attackerKingdomId === k.id
  ).length;
  payload.atWar = Store.getActiveWars().some(
    (w) => w.attackerId === k.id || w.defenderId === k.id
  );
  // War supply: live demands per category with morale, so the war table
  // can show what the armies burn and how well-fed they are.
  try {
    payload.supply = WarSupply.supplyStatus(k.id, Store);
  } catch {
    payload.supply = [];
  }
  // Coalition membership, so the war table can draw the realm's blocs.
  const coalition = Coalitions.coalitionOf(k.id, Store);
  payload.coalition = coalition ? { key: coalition.key, name: coalition.name } : null;
  // Phase 10: succession flags, so the war table can mark thrones in
  // dispute and kingdoms at war with themselves.
  try {
    const SuccessionCrisis = require("./SuccessionCrisis.Kingdoms");
    payload.inCivilWar = SuccessionCrisis.inCivilWar(k.id, state);
    payload.inSuccessionCrisis = SuccessionCrisis.inSuccessionCrisis(k.id, state);
  } catch {
    payload.inCivilWar = false;
    payload.inSuccessionCrisis = false;
  }
  return payload;
}

function siegePayload(siege) {
  return {
    attackerId: siege.attackerKingdomId,
    defenderId: siege.defenderKingdomId,
    attackerName: kingdomName(siege.attackerKingdomId),
    defenderName: kingdomName(siege.defenderKingdomId),
    progress: siege.progress ?? 0,
    ticksElapsed: siege.ticksElapsed ?? 0,
    investment: siege.investment ?? 0,
    warGoal: siege.warGoal ?? null,
    declaredAt: siege.declaredAt ?? null,
    attackerMorale: siege.attackerMorale ?? null,
    defenderMorale: siege.defenderMorale ?? null,
  };
}

function statusPayload(player) {
  let homeId = null;
  let playerKingdom = null;
  if (player) {
    homeId = player.getAttribute("kingdom:id") || null;
  }

  const kingdoms = Store.getKingdoms().map((k) => kingdomPayload(k, homeId));
  const byId = new Map(kingdoms.map((k) => [k.id, k]));

  if (homeId && byId.has(homeId)) {
    const home = byId.get(homeId);
    let influence = 0;
    try {
      influence = Influence.effectiveInfluence(player, homeId) ?? 0;
    } catch {
      influence = 0;
    }
    playerKingdom = {
      id: homeId,
      name: home.name,
      rank: player.getAttribute("kingdom:rank") || null,
      influence: Math.floor(influence),
    };
  }

  const wars = Store.getActiveWars().map((w) => {
    const battle = Battles.activeBattleBetween(w.attackerId, w.defenderId, Store);
    return {
      attacker: w.attackerId,
      defender: w.defenderId,
      attackerName: kingdomName(w.attackerId),
      defenderName: kingdomName(w.defenderId),
      reason: w.reason ?? null,
      goal: w.goal ?? null,
      goalLabel: w.goal ? Wars.WAR_GOAL_LABELS[w.goal] : null,
      declaredAt: w.declaredAt ?? null,
      // The war score the fighting has produced (WarResolution).
      score: WarResolution.scoreFor(w),
      battle: battle
        ? { id: battle.id, status: battle.status, musterEndsAt: battle.musterEndsAt ?? null }
        : null,
    };
  });

  const endedWars = Store.getEndedWars()
    .slice(-6)
    .reverse()
    .map((w) => ({
      attackerName: kingdomName(w.attackerId),
      defenderName: kingdomName(w.defenderId),
      outcome: w.outcome ?? "unknown",
      endedAt: w.endedAt ?? null,
    }));

  const alliances = Store.getAlliances().map((a) => ({
    a: a.a,
    b: a.b,
    aName: kingdomName(a.a),
    bName: kingdomName(a.b),
    pactName: a.pactName ?? null,
    strength: a.strength ?? 1,
    formedAt: a.formedAt ?? null,
  }));

  // Pairwise relations across every great power: tension 0-100 + allied flag.
  const relations = [];
  for (let i = 0; i < kingdoms.length; i++) {
    for (let j = i + 1; j < kingdoms.length; j++) {
      const a = kingdoms[i].id;
      const b = kingdoms[j].id;
      relations.push({
        a,
        b,
        tension: Store.getRawTension(a, b),
        allied: Store.isAllied(a, b),
      });
    }
  }

  const state = Store.load();
  const sieges = Object.values(state.sieges ?? {})
    .filter((s) => s && s.status === "active")
    .map(siegePayload);

  // Realm-wide vassalage: every oath, so the war table can draw the
  // fealty tree (overlord -> vassals) on the realm tab.
  const vassalage = Object.entries(state.vassals ?? {})
    .filter(([, r]) => r && r.overlordId)
    .map(([vassalId, r]) => ({
      vassalId,
      vassalName: kingdomName(vassalId),
      overlordId: r.overlordId,
      overlordName: kingdomName(r.overlordId),
      since: r.since ?? null,
    }));

  // Coalitions of the realm: every league of three or more crowns, with
  // named members — drawn from the live alliance graph.
  const coalitions = Coalitions.coalitionsOf(Store).map((c) => ({
    key: c.key,
    name: c.name,
    members: c.members.map((id) => ({ id, name: kingdomName(id) })),
    pactCount: c.pactCount,
    totalStrength: c.totalStrength,
    formedAt: c.formedAt ?? null,
  }));

  // Calls to arms: allies of each war's defender and where their
  // deliberation stands (deliberating / joined / absent / refused).
  const defenseCalls = AiDiplomacy.getDefenseCalls(Store);

  // Thrones in dispute: open succession crises and active civil wars.
  // SuccessionCrisis is a pure module; guard the require for bare stores.
  let successionCrises = [];
  let civilWars = [];
  try {
    const SuccessionCrisis = require("./SuccessionCrisis.Kingdoms");
    const sstate = Store.load().succession ?? { crises: [], civilWars: [] };
    successionCrises = (sstate.crises ?? [])
      .filter((c) => c && c.status === "open")
      .map((c) => {
        const ctotal = (c.claimants ?? []).reduce(
          (n, cl) => n + ((cl.strength ?? 0) + (cl.aiSupport ?? 0)),
          0
        );
        return {
          id: c.id,
          kingdomId: c.kingdomId,
          kingdomName: kingdomName(c.kingdomId),
          lateRuler: c.lateRuler ?? null,
          ticksLeft: c.ticksLeft ?? null,
          claimants: (c.claimants ?? []).map((cl) => {
            const strength = Math.round((cl.strength ?? 0) + (cl.aiSupport ?? 0));
            return {
              id: cl.id,
              name: cl.name,
              title: cl.title ?? null,
              claim: cl.claim ?? null,
              claimLabel: SuccessionCrisis.CLAIM_LABELS[cl.claim] ?? cl.claim ?? null,
              strength,
              // Phase 10: succession odds — each claimant's share of the court.
              share: ctotal > 0 ? Math.round((strength / ctotal) * 100) : 0,
              backers: (cl.backers ?? []).length,
            };
          }),
        };
      });
    civilWars = (sstate.civilWars ?? [])
      .filter((w) => w && w.status === "active")
      .map((w) => ({
        id: w.id,
        kingdomId: w.kingdomId,
        kingdomName: kingdomName(w.kingdomId),
        sides: (w.sides ?? []).map((s) => ({ name: s.name, title: s.title ?? null, strength: Math.round(s.strength ?? 0) })),
        ticksLeft: w.ticksLeft ?? null,
        drained: w.drained ?? 0,
      }));
  } catch {
    // Succession module unavailable: thrones stay quiet.
  }

  // Home-kingdom war room: castle, vassalage, pending peace offers, wars.
  let homeDetail = null;
  if (homeId) {
    homeDetail = {
      castle: castlePayload(homeId),
      vassalOf: Wars.getVassalOverlord(homeId, Store),
      vassalOfName: null,
      vassals: Wars.getVassalsOf(homeId, Store).map((v) => ({
        vassalId: v.vassalId,
        vassalName: kingdomName(v.vassalId),
        since: v.since,
      })),
      peaceOffers: Wars.getPeaceOffers(homeId, Store).map((o) => ({
        otherId: o.a === homeId ? o.b : o.a,
        otherName: kingdomName(o.a === homeId ? o.b : o.a),
        offeredBy: o.offeredBy,
        offeredByName: kingdomName(o.offeredBy),
        terms: o.terms,
        offeredAt: o.offeredAt,
      })),
      wars: Wars.getWars(homeId, Store).map((w) => ({
        ...w,
        attackerName: kingdomName(w.attackerId),
        defenderName: kingdomName(w.defenderId),
      })),
      warGoals: Wars.WAR_GOALS.map((g) => ({ id: g, label: Wars.WAR_GOAL_LABELS[g] })),
    };
    if (homeDetail.vassalOf) {
      homeDetail.vassalOfName = kingdomName(homeDetail.vassalOf);
    }
  }

  return {
    open: player ? player.getAttribute(WARTABLE_OPEN_ATTRIBUTE) === "1" : false,
    playerKingdom,
    warCosts: {
      warDeclareInfluence: Wars.WAR_DECLARE_INFLUENCE_COST,
      siegeDeclareCoins: Siege.SIEGE_DECLARE_COST,
    },
    // Per-kingdom declare-war / declare-siege eligibility for the war
    // council buttons (same checks the actions enforce).
    warGates: warGatesFor(player, homeId, kingdoms),
    kingdoms,
    wars,
    endedWars,
    alliances,
    relations,
    sieges,
    vassalage,
    coalitions,
    defenseCalls,
    successionCrises,
    civilWars,
    homeDetail,
    // Espionage: real enemy state (garrison, supply morale, militia,
    // fort tier) for kingdoms you fight or glare at. Empty in peacetime.
    intel: homeId ? Espionage.intelFor(homeId, Store) : {},
  };
}

// ---------------------------------------------------------------------------
// Warfare actions
// ---------------------------------------------------------------------------

function playerKingdomId(player) {
  return player ? player.getAttribute("kingdom:id") || null : null;
}

/**
 * Machine-reason -> player-facing message, shared by the action results and
 * the war-council eligibility gates below, so the overlay's disabled reasons
 * are exactly what the API itself would refuse.
 */
const REASON_MESSAGES = {
  "missing-params": "Something was missing from the order.",
  "missing-kingdom": "That kingdom does not exist.",
  "cannot-war-self": "A kingdom cannot declare war on itself.",
  "cannot-siege-self": "A kingdom cannot besiege itself.",
  "cannot-target-self": "Choose another kingdom.",
  "allied-cannot-war": "They are your allies — pacts are not broken this way.",
  "allied-cannot-siege": "They are your allies. You cannot besiege them.",
  "allied-cannot-threaten": "Threatening an ally is betrayal, not diplomacy.",
  "vassal-cannot-declare": "A vassal cannot declare war on its overlord — break the oath first.",
  "already-at-war": "You are already at war with them.",
  "already-besieged": "That castle is already under siege.",
  "already-allied": "You are already allied.",
  "already-calm": "The border is already calm.",
  "at-war-no-envoys": "Envoys do not cross battle lines.",
  "already-at-war-ultimatum": "You are already at war.",
  "not-hostile": "The border is not hostile — escalate with an ultimatum first, or declare war.",
  "not-at-war": "You are not at war with them.",
  "no-offer": "No peace offer awaits.",
  "offer-pending": "Terms are already on the table.",
  "no-active-siege": "No siege is underway.",
  "sally-on-cooldown": "The garrison needs time to regroup.",
  "repair-on-cooldown": "The masons are still working.",
  "on-cooldown": "Too soon — the realm needs time to forget the last war.",
  "in-civil-war": "A kingdom at war with itself cannot march on others.",
  "insufficient-funds": "The war chest cannot bear it.",
  "nap-active": "A sworn non-aggression pact binds both crowns — the oath holds.",
  "battle-already-called": "A battle is already gathering on that border.",
  "battle-on-cooldown": "The field still smokes from the last battle — let it rest.",
  "no-battlefield": "No known border field joins these crowns.",
  "invalid-goal": "Choose a war goal: plunder, territory, or vassalize.",
  "invalid-terms": "Those terms make no sense.",
  "invalid-tribute": "The tribute demand is absurd.",
  "not-a-vassal": "You swear fealty to no one.",
  "too-soon": "The oath is still fresh — independence must wait.",
  "new-oath": "Your oath is still fresh — the war council will not heed the newly sworn.",
  "no-crisis": "No succession crisis grips that throne.",
  "no-claimant": "No such claimant presses a claim.",
  "already-backed": "You have already backed a claimant in this crisis.",
  "no-record": "You hold no standing in that court.",
  "insufficient": "Not enough influence in that court.",
  "bad-args": "Something was missing from the order.",
};

function reasonMessage(reason, result = {}) {
  if (reason === "insufficient-influence") {
    return `Not enough influence (have ${result.available ?? 0}, need ${result.cost ?? 0}).`;
  }
  return REASON_MESSAGES[reason] ?? `The order failed (${reason ?? "unknown"}).`;
}

function describeResult(action, result) {
  if (!result) return { ok: false, message: "Nothing happened." };
  if (result.ok) {
    switch (action) {
      case "declare-war":
        return {
          ok: true,
          message: `War declared — a War of ${result.goalLabel}. The realm will remember this.`,
        };
      case "offer-peace":
        return { ok: true, message: "Peace terms laid on the table. Await their answer." };
      case "accept-peace":
        return { ok: true, message: "Peace ratified. The border cools to an armistice." };
      case "surrender":
        return { ok: true, message: "The white banner rises. The war ends — on their terms." };
      case "give-battle":
        return { ok: true, message: "The call to battle goes out. Hosts muster at the border field." };
      case "break-vassalage":
        return { ok: true, message: "The oath is broken. Independence — and the overlord's fury." };
      case "envoy":
        return { ok: true, message: `Envoys return smiling. Tension now ${result.tension}.` };
      case "ultimatum":
        return { ok: true, message: `The ultimatum lands. Tension now ${result.tension}.` };
      case "declare-siege":
        return { ok: true, message: "The siege is laid. The walls will be tested." };
      case "sally":
        return { ok: true, message: `Sally forth! Siege progress pushed back to ${result.progress}.` };
      case "repair":
        return { ok: true, message: `Masons work through the night. Progress now ${result.progress}.` };
      case "lift-siege":
        return { ok: true, message: "The siege is lifted. The army marches home." };
      case "back-claimant":
        return { ok: true, message: "Your backing is noted in the court. The claimant grows stronger." };
      case "contribute-supply":
        // deliverSupplies already speaks plainly — pass its line through.
        return { ok: true, message: result.message ?? "Delivered to the war effort." };
      default:
        return { ok: true, message: "Done." };
    }
  }
  return {
    ok: false,
    // deliverSupplies-style results carry a plain message and no reason code.
    message: result.message ?? reasonMessage(result.reason, result),
    reason: result.reason,
  };
}

/**
 * War-council eligibility gates, computed with the SAME checks the declare
 * actions themselves run (Wars.canDeclareWar / Siege.canDeclareSiege, plus
 * the influence spend declareWar charges). The overlay disables the buttons
 * with the gate's message when ineligible, so a disabled button never
 * surprises the player — and a lost seal/empty purse is caught server-side
 * again on the action itself.
 */
function gatePayload(check) {
  if (check && check.ok) return { ok: true, reason: null, message: null };
  const reason = check?.reason ?? "unknown";
  return { ok: false, reason, message: reasonMessage(reason, check ?? {}) };
}

function warGatesFor(player, homeId, kingdoms) {
  if (!homeId) return null;
  let influence = 0;
  try {
    influence = Influence.effectiveInfluence(player, homeId) ?? 0;
  } catch {
    influence = 0;
  }
  // New-member limit: no strategic war powers until the tenure threshold.
  // Defense (sally, repair) and service (supply contributions) stay open —
  // they are every subject's duty.
  const tenured = Switching.hasTenure(player, homeId);
  const warCost = Wars.WAR_DECLARE_INFLUENCE_COST;
  const gates = {};
  for (const k of kingdoms) {
    if (!k || k.id === homeId) continue;
    let warCheck = Wars.canDeclareWar(homeId, k.id, Store);
    if (!tenured) {
      warCheck = { ok: false, reason: "new-oath" };
    } else if (warCheck.ok && influence < warCost) {
      warCheck = { ok: false, reason: "insufficient-influence", available: Math.floor(influence), cost: warCost };
    }
    let siegeCheck = Siege.canDeclareSiege(homeId, k.id, Store);
    if (!tenured) {
      siegeCheck = { ok: false, reason: "new-oath" };
    }
    gates[k.id] = {
      declareWar: gatePayload(warCheck),
      declareSiege: gatePayload(siegeCheck),
    };
  }
  return gates;
}

/**
 * One-click war supply contribution: find the first catalog item of the
 * requested category the player actually carries, and run it through the
 * donation chest's deliverSupplies — same war-demand routing, same coin
 * payout, same influence. One click delivers everything carried of that
 * category (the chest caps it at what the demand still wants).
 */
function contributeSupplyToWar(player, homeId, cat) {
  if (!homeId) return { ok: false, message: "You swear fealty to no kingdom." };
  if (!cat) return { ok: false, message: "Choose a supply category." };
  // Lazy: OfficeTools pulls Tension -> TS core, which only resolves under ts-node.
  let OfficeTools;
  try {
    OfficeTools = require("./OfficeTools.Kingdoms");
  } catch {
    return { ok: false, message: "The quartermaster could not be reached." };
  }
  const catalog = { ...OfficeTools.SUPPLY_ITEMS, ...WarSupply.WAR_SUPPLY_ITEMS };
  const inventory = player.getInventory?.();
  for (const [id, spec] of Object.entries(catalog)) {
    if ((spec?.cat ?? "food") !== cat) continue;
    const itemId = Number(id);
    const have = inventory?.getAmount?.(itemId) ?? 0;
    if (have > 0) {
      return OfficeTools.deliverSupplies(player, homeId, itemId, have);
    }
  }
  return { ok: false, message: `You carry no war ${cat} to contribute.` };
}

/**
 * Strategic war-council powers: the newly sworn may not wield them. Service
 * actions (contribute-supply) and battlefield defense (sally, repair,
 * lift-siege) stay open to every subject — strategy is the council's
 * privilege, defense is everyone's duty.
 */
const STRATEGIC_WAR_ACTIONS = new Set([
  "declare-war",
  "declare-siege",
  "offer-peace",
  "accept-peace",
  "break-vassalage",
  "envoy",
  "ultimatum",
  "back-claimant",
  "give-battle",
]);

function runWarfareAction(api, player, action, query) {
  const homeId = playerKingdomId(player);
  if (!homeId) {
    return { ok: false, message: "You swear fealty to no kingdom." };
  }
  if (STRATEGIC_WAR_ACTIONS.has(action) && !Switching.hasTenure(player, homeId)) {
    return { ok: false, message: reasonMessage("new-oath"), reason: "new-oath" };
  }
  const target = (query.get("target") || "").trim() || null;

  switch (action) {
    case "declare-war": {
      const goal = (query.get("goal") || "").trim();
      const result = Wars.declareWar(player, homeId, target, goal, Store);
      if (result.ok && result.war) {
        // Player declarations join the event bus like every other path,
        // so refugees, battlefield sites, alliances, and diplomacy all
        // react. Store.declareWar dedupes against the record just made.
        try {
          api.emitCustomEvent("kingdom:war-declared", {
            attackerId: homeId,
            defenderId: target,
            declaredBy: player.getUsername?.() ?? "player",
            reason: result.war.reason ?? null,
            resolveAt: result.war.resolveAt ?? null,
          });
        } catch {
          // Bus unavailable: the war record still stands.
        }
      }
      return describeResult(action, result);
    }
    case "offer-peace": {
      const termsType = (query.get("terms") || "white-peace").trim();
      const terms =
        termsType === "tribute"
          ? { type: "tribute", amount: Math.floor(Number(query.get("tribute")) || 0) }
          : termsType === "nap"
            ? { type: "nap", days: Math.floor(Number(query.get("days")) || 0) || undefined }
            : { type: termsType };
      return describeResult(action, Wars.offerPeace(player, homeId, target, terms, Store));
    }
    case "accept-peace": {
      return describeResult(action, Wars.acceptPeace(player, homeId, target, Store));
    }
    case "surrender": {
      return describeResult(action, WarResolution.surrender(player, homeId, target, Store));
    }
    case "give-battle": {
      return describeResult(
        action,
        Battles.callBattle(homeId, target, Store, {
          calledBy: player.getUsername?.() ?? null,
        })
      );
    }
    case "break-vassalage": {
      return describeResult(action, Wars.breakVassalage(player, homeId, Store));
    }
    case "envoy": {
      return describeResult(action, Relations.sendEnvoy(player, homeId, target, Store));
    }
    case "ultimatum": {
      return describeResult(action, Relations.issueUltimatum(player, homeId, target, Store));
    }
    case "declare-siege": {
      const investment = Math.max(0, Math.floor(Number(query.get("investment")) || 0));
      return describeResult(action, Siege.declareSiege(homeId, target, investment, Store));
    }
    case "sally": {
      return describeResult(action, Siege.sallyForth(homeId, Store));
    }
    case "repair": {
      return describeResult(action, Siege.repairWalls(homeId, Store));
    }
    case "lift-siege": {
      return describeResult(action, Siege.liftSiege(homeId, target, Store));
    }
    case "contribute-supply": {
      const cat = (query.get("cat") || "").trim();
      return describeResult(action, contributeSupplyToWar(player, homeId, cat));
    }
    case "back-claimant": {
      const claimantId = (query.get("claimant") || "").trim();
      try {
        const SuccessionCrisis = require("./SuccessionCrisis.Kingdoms");
        // Influence is spent in the crisis kingdom's court, not the player's home.
        return describeResult(action, SuccessionCrisis.backClaimant(player, target, claimantId, Store));
      } catch {
        return { ok: false, message: "The succession council could not be reached." };
      }
    }
    default:
      return null;
  }
}

function findPlayer(api, username) {
  const name = (username || "").trim();
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function attach(api) {
  console.info("[wartable-api] registering wartable-status endpoint");
  api.registerContentEndpoint("wartable-status", (query) => {
    const player = findPlayer(api, query.get("player"));
    const action = (query.get("action") || "").trim().toLowerCase();

    if (player && (action === "open" || action === "close")) {
      try {
        player.setAttribute(WARTABLE_OPEN_ATTRIBUTE, action === "open" ? "1" : "0");
      } catch (e) {
        console.warn("[wartable-api] flag update failed", e?.message ?? e);
      }
      return statusPayload(player);
    }

    if (player && action) {
      let actionResult = null;
      try {
        actionResult = runWarfareAction(api, player, action, query);
      } catch (error) {
        console.warn("[wartable-api] warfare action failed", action, error?.message ?? error);
        actionResult = { ok: false, message: "The order could not be carried out." };
      }
      return { ...statusPayload(player), actionResult };
    }

    return statusPayload(player);
  });
}

module.exports = attach;
module.exports.attach = attach;
module.exports.WARTABLE_OPEN_ATTRIBUTE = WARTABLE_OPEN_ATTRIBUTE;
// Test seams: the action dispatcher and the council-button gates, without
// the full status payload.
module.exports._test = { runWarfareAction, warGatesFor };
