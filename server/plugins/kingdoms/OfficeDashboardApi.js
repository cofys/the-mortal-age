"use strict";

/**
 * OfficeDashboardApi — HTTP data layer for the office-holder dashboard
 * overlay (the SEALS OF OFFICE, diegetic through the war table).
 *
 * When a player holds a kingdom office (steward, quartermaster, marshal,
 * spymaster), this endpoint feeds a React overlay with that office's live
 * data and accepts button-driven actions that call the REAL OfficeTools
 * mechanics — tax rates, petitions, supply orders, patrols, rumors. Every
 * write re-verifies the caller is the CURRENT holder; a lost seal closes
 * the tools immediately.
 *
 *   GET /api/office-status?player=<username>
 *     -> { open, heldOffices, vacantOffices, payloads }
 *
 *   ...&action=open / ...&action=close  — mark the dashboard open/closed
 *
 *   Write actions (each returns { actionResult, ...status }):
 *     Steward:
 *       action=set-tax-rate&officeId=<id>&rate=<0.5|1|1.5|2>
 *       action=approve-petition&officeId=<id>&petitionId=<id>
 *       action=deny-petition&officeId=<id>&petitionId=<id>
 *       action=grant-treasury&officeId=<id>&to=<username>&amount=<coins>
 *         (any held office may grant; the steward panel carries the buttons)
 *     Quartermaster:
 *       action=set-target-peace&officeId=<id>&value=<100-1000>
 *       action=set-target-war&officeId=<id>&value=<400-2400>
 *       action=issue-supply-order&officeId=<id>&units=<1-2000>&price=<1-25>
 *       action=cancel-supply-order&officeId=<id>
 *     Marshal:
 *       action=set-patrol&officeId=<id>&target=<kingdomId|home>&guards=<4|8|12>
 *       action=clear-patrol&officeId=<id>
 *       action=set-war-levy&officeId=<id>&levy=<1.2|1.6|2.0|2.5>
 *     Spymaster:
 *       action=plant-rumor&officeId=<id>&target=<kingdomId>&template=<0-3>
 *       action=suppress-rumor&officeId=<id>&index=<n>
 *     General:
 *       action=vacate-office&officeId=<id>      (own office only)
 *       action=petition-office&officeId=<id>   (vacant office only)
 *
 * Read-heavy by design. Plain JSON, never HTML. Every failure path
 * returns { open: false }.
 */

const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");
const OfficeTools = require("./OfficeTools.Kingdoms");
const Tension = require("./Tension.Kingdoms");
const Treasury = require("./Treasury.Kingdoms");
const WarSupply = require("./WarSupply.Kingdoms");

let Politics = null;
try {
  Politics = require("./Politics.Kingdoms");
} catch {
  Politics = null;
}

const OFFICE_OPEN_ATTRIBUTE = "office:open";

// Rumor templates (mirrors OfficeTools.Kingdoms SEED_RUMOR_TEMPLATES).
const RUMOR_TEMPLATES = [
  (city) => `They say sellswords sharpen their blades for ${city} - someone is paying.`,
  (city) => `They say the ${city} granaries stand half-empty and the court hides it.`,
  (city) => `They say ${city}'s walls will hold against any host - the gods themselves laid the stones.`,
  (city) => `They say a ${city} councillor sells secrets across the border.`,
];

const PLANT_RUMOR_COST = 200;
const SUPPRESS_RUMOR_COST = 300;

function kingdomName(id) {
  return Store.getKingdom(id)?.name ?? String(id);
}

function capitalName(id) {
  return Store.getKingdom(id)?.capital ?? kingdomName(id);
}

function formatCoins(n) {
  return Math.floor(Number(n) || 0).toLocaleString("en-US");
}

function flagOf(kingdomId, key) {
  return Store.getKingdom(kingdomId)?.flags?.[key];
}

function atWar(kingdomId) {
  return Store.getActiveWars().some(
    (w) => w.attackerId === kingdomId || w.defenderId === kingdomId
  );
}

/** Verify the player is the CURRENT holder of this office. */
function checkHolder(player, officeId) {
  const username = player?.getUsername?.() ?? null;
  if (!username) return { ok: false, office: null };
  const office = Offices.getOffice(officeId);
  if (!office) return { ok: false, office: null };
  const holder = office.holder;
  if (holder?.kind !== "player" || holder.ref !== username) {
    return { ok: false, office };
  }
  return { ok: true, office, username };
}

/**
 * Office-kind gate: an action belongs to exactly one seal. checkHolder proves
 * the caller holds the office named by officeId; this proves the office is
 * the RIGHT KIND for the action — a steward cannot set patrols, a marshal
 * cannot levy taxes, etc. grant-treasury is the documented exception (any
 * held office may grant) and skips this gate.
 */
function requireKind(action, office, kind) {
  if (office && office.office === kind) return null;
  return describeAction(action, false, "Those seals are not yours to wield.");
}

// --- per-office payloads -----------------------------------------------------

function stewardPayload(kingdomId) {
  const kingdom = Store.getKingdom(kingdomId) ?? {};
  return {
    treasury: kingdom.treasury ?? 0,
    grantCap: Treasury.GRANT_MAX,
    taxRate: OfficeTools.getTaxRate(kingdomId),
    marketTaxRate: Store.getMarketTaxRate(kingdomId),
    lastTax: flagOf(kingdomId, "sim:last-tax") ?? 0,
    lastWages: flagOf(kingdomId, "sim:last-wages") ?? 0,
    atWar: atWar(kingdomId),
    warLevy: atWar(kingdomId) ? OfficeTools.getWarLevy(kingdomId) : null,
    // Every coin accounted for: lifetime income per real source, plus
    // what arrived in the last day. The crown mints nothing.
    incomeSources: Store.getIncomeTotals(kingdomId),
    incomeLastDay: Store.getRecentIncome(kingdomId, 24 * 60 * 60 * 1000),
    petitions: OfficeTools.getPetitions(kingdomId).map((p) => ({
      id: p.id,
      text: p.text,
      cost: p.cost,
    })),
  };
}

function quartermasterPayload(kingdomId) {
  const wartime = atWar(kingdomId);
  const stockpile = Math.floor(flagOf(kingdomId, "sim:stockpile") ?? 0);
  const order = OfficeTools.getSupplyOrder(kingdomId);
  return {
    stockpile,
    targetPeace: OfficeTools.stockpileTarget(kingdomId, false),
    targetWar: OfficeTools.stockpileTarget(kingdomId, true),
    wartime,
    supplyOrder: order
      ? { units: order.units, pricePer: order.pricePer, by: order.by ?? null }
      : null,
    warSupply: (() => {
      try {
        return WarSupply.supplyStatus(kingdomId, Store);
      } catch {
        return [];
      }
    })(),
    supplyCatalog: Object.entries(WarSupply.WAR_SUPPLY_ITEMS).map(([id, spec]) => ({
      id: Number(id),
      name: spec.name,
      units: spec.units,
      cat: spec.cat,
      catLabel: WarSupply.CATEGORY_LABELS[spec.cat] ?? spec.cat,
    })),
  };
}

function marshalPayload(kingdomId) {
  const order = OfficeTools.getPatrolOrder(kingdomId);
  const Militia = require("./Militia.Kingdoms");
  return {
    garrison: Tension.garrisonOf(kingdomId),
    treasury: Store.getKingdom(kingdomId)?.treasury ?? 0,
    militiaOrders: Militia.getOrders(kingdomId),
    militiaCount: Militia.militiaCount(kingdomId),
    patrolOrder: order
      ? {
          target: order.target,
          targetName:
            order.target === "home" ? "the home roads" : `${kingdomName(order.target)} border`,
          guards: order.guards,
        }
      : null,
    warLevy: OfficeTools.getWarLevy(kingdomId),
    atWar: atWar(kingdomId),
    neighbors: Store.getKingdoms()
      .filter((k) => k.id !== kingdomId)
      .slice(0, 6)
      .map((k) => ({ id: k.id, name: k.name })),
  };
}

function spymasterPayload(kingdomId) {
  return {
    rumors: OfficeTools.getRumors(kingdomId).map((r) => ({ text: r.text })),
    plantCost: PLANT_RUMOR_COST,
    suppressCost: SUPPRESS_RUMOR_COST,
    cities: Store.getKingdoms()
      .slice(0, 6)
      .map((k) => ({ id: k.id, name: k.name, capital: capitalName(k.id) })),
    templates: RUMOR_TEMPLATES.map((_, i) => i),
  };
}

function officePayload(office) {
  const { kingdomId, office: kind } = office;
  switch (kind) {
    case "steward":
      return { kind, ...stewardPayload(kingdomId) };
    case "quartermaster":
      return { kind, ...quartermasterPayload(kingdomId) };
    case "marshal":
      return { kind, ...marshalPayload(kingdomId) };
    case "spymaster":
      return { kind, ...spymasterPayload(kingdomId) };
    default:
      return { kind };
  }
}

function statusPayload(player) {
  const held = OfficeTools.officesHeldBy(player);
  const heldOffices = held.map((o) => ({
    officeId: o.officeId,
    office: o.office,
    title: o.title,
    kingdomId: o.kingdomId,
    kingdomName: kingdomName(o.kingdomId),
    holderSince: o.holderSince ?? null,
    data: officePayload(o),
  }));
  const vacantOffices = Offices.getOffices()
    .filter((o) => !o.holder)
    .slice(0, 12)
    .map((o) => ({
      officeId: o.officeId,
      office: o.office,
      title: o.title,
      description: o.description,
      kingdomId: o.kingdomId,
      kingdomName: kingdomName(o.kingdomId),
    }));
  return {
    open: player ? player.getAttribute(OFFICE_OPEN_ATTRIBUTE) === "1" : false,
    heldOffices,
    vacantOffices,
  };
}

// --- write actions -----------------------------------------------------------

function describeAction(action, ok, detail) {
  if (ok) return { ok: true, message: detail ?? "Done." };
  return { ok: false, message: detail ?? "The order could not be carried out." };
}

function runOfficeAction(api, player, action, query) {
  const officeId = (query.get("officeId") || "").trim();
  const username = player?.getUsername?.() ?? null;

  switch (action) {
    // --- steward ---
    case "set-tax-rate": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "steward");
      if (kindGate) return kindGate;
      const rate = Number(query.get("rate"));
      if (OfficeTools.setTaxRate(office.kingdomId, rate, username)) {
        return describeAction(action, true, `The levy is set at ${rate}x.`);
      }
      return describeAction(action, false, "That rate is not permitted.");
    }
    case "approve-petition": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "steward");
      if (kindGate) return kindGate;
      const petitionId = (query.get("petitionId") || "").trim();
      if (OfficeTools.approvePetition(office.kingdomId, petitionId, username)) {
        return describeAction(action, true, "Granted. The petition leaves the queue.");
      }
      return describeAction(action, false, "The coffers cannot bear it, or the petition is gone.");
    }
    case "deny-petition": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "steward");
      if (kindGate) return kindGate;
      const petitionId = (query.get("petitionId") || "").trim();
      if (OfficeTools.denyPetition(office.kingdomId, petitionId, username)) {
        return describeAction(action, true, "Denied. The petitioner leaves - the street may talk.");
      }
      return describeAction(action, false, "That petition is already gone.");
    }
    case "grant-treasury": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const to = (query.get("to") || "").trim();
      const amount = Math.floor(Number(query.get("amount")) || 0);
      const target = findPlayer(api, to);
      const result = Treasury.grantFromTreasury(office.kingdomId, player, target, amount);
      if (result.ok) {
        const targetName = target?.getUsername?.() ?? to;
        try {
          target.sendMessage(
            `[Court] The court of ${kingdomName(office.kingdomId)} grants you ${formatCoins(result.granted)}c.`
          );
          player.sendMessage(
            `[Court] ${formatCoins(result.granted)}c leaves the treasury for ${targetName}.`
          );
        } catch {
          // The coins already moved; the messages are courtesy.
        }
        return describeAction(
          action,
          true,
          `${formatCoins(result.granted)}c leaves the treasury for ${targetName}.`
        );
      }
      return describeAction(action, false, result.message ?? "The order could not be carried out.");
    }

    // --- quartermaster ---
    case "set-target-peace": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "quartermaster");
      if (kindGate) return kindGate;
      const value = Math.floor(Number(query.get("value")) || 0);
      if (OfficeTools.setStockpileTarget(office.kingdomId, false, value)) {
        return describeAction(action, true, `Peacetime stores target: ${formatCoins(value)} units.`);
      }
      return describeAction(action, false, "That target is out of range (100-1000).");
    }
    case "set-target-war": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "quartermaster");
      if (kindGate) return kindGate;
      const value = Math.floor(Number(query.get("value")) || 0);
      if (OfficeTools.setStockpileTarget(office.kingdomId, true, value)) {
        return describeAction(action, true, `Wartime stores target: ${formatCoins(value)} units.`);
      }
      return describeAction(action, false, "That target is out of range (400-2400).");
    }
    case "issue-supply-order": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "quartermaster");
      if (kindGate) return kindGate;
      const units = Math.floor(Number(query.get("units")) || 0);
      const price = Math.floor(Number(query.get("price")) || 0);
      if (OfficeTools.setSupplyOrder(office.kingdomId, { units, pricePer: price, by: username })) {
        return describeAction(
          action,
          true,
          `The order goes out: ${formatCoins(units)} units at ${price}c each.`
        );
      }
      return describeAction(action, false, "Units must be 1-2000, price 1-25.");
    }
    case "cancel-supply-order": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "quartermaster");
      if (kindGate) return kindGate;
      OfficeTools.clearSupplyOrder(office.kingdomId);
      return describeAction(action, true, "The supply order is withdrawn.");
    }

    // --- marshal ---
    case "set-patrol": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "marshal");
      if (kindGate) return kindGate;
      const target = (query.get("target") || "home").trim();
      const guards = Math.floor(Number(query.get("guards")) || 0);
      if (OfficeTools.setPatrolOrder(office.kingdomId, { target, guards, by: username })) {
        const where = target === "home" ? "the home roads" : `the ${kingdomName(target)} border`;
        return describeAction(
          action,
          true,
          `${guards} guards to ${where}, ${formatCoins(guards * 25)}c per realm tick.`
        );
      }
      return describeAction(action, false, "Patrols come in 4, 8, or 12 guards.");
    }
    case "clear-patrol": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "marshal");
      if (kindGate) return kindGate;
      OfficeTools.clearPatrolOrder(office.kingdomId);
      return describeAction(action, true, "The patrols stand down.");
    }
    case "set-militia-orders": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "marshal");
      if (kindGate) return kindGate;
      const order = (query.get("order") || "").trim().toLowerCase();
      const Militia = require("./Militia.Kingdoms");
      const result = Militia.setOrders(office.kingdomId, order, username);
      if (!result.ok) {
        return describeAction(action, false, "Orders are attack, defend, or fallback.");
      }
      const label =
        order === "attack"
          ? "The militia marches to meet the enemy."
          : order === "defend"
            ? "The militia holds the walls."
            : "The militia falls back to the muster point.";
      return describeAction(action, true, label);
    }
    case "set-war-levy": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "marshal");
      if (kindGate) return kindGate;
      const levy = Number(query.get("levy"));
      if (OfficeTools.setWarLevy(office.kingdomId, levy, username)) {
        return describeAction(action, true, `The war levy stands at ${levy}x.`);
      }
      return describeAction(action, false, "That levy is not permitted.");
    }

    // --- spymaster ---
    case "plant-rumor": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "spymaster");
      if (kindGate) return kindGate;
      const target = (query.get("target") || "").trim();
      const templateIdx = Math.floor(Number(query.get("template")) || 0);
      const make = RUMOR_TEMPLATES[templateIdx];
      if (!make || !target) {
        return describeAction(action, false, "Choose a city and a whisper.");
      }
      if (!Store.spendTax(office.kingdomId, PLANT_RUMOR_COST)) {
        return describeAction(action, false, "The coffers cannot fund this whisper.");
      }
      Store.save();
      const text = make(capitalName(target));
      OfficeTools.recordRumor(target, text);
      try {
        api.emitCustomEvent("kingdom:rumor", { kingdomId: target, text });
      } catch {
        // Policy still landed.
      }
      return describeAction(
        action,
        true,
        `${formatCoins(PLANT_RUMOR_COST)}c buys a whisper in ${capitalName(target)}.`
      );
    }
    case "suppress-rumor": {
      const { ok, office } = checkHolder(player, officeId);
      if (!ok) return describeAction(action, false, "The seals have passed to another.");
      const kindGate = requireKind(action, office, "spymaster");
      if (kindGate) return kindGate;
      const index = Math.floor(Number(query.get("index")) || 0);
      // Validate BEFORE spending: a bad index must not cost the treasury.
      const circulating = OfficeTools.getRumors(office.kingdomId);
      if (index < 0 || index >= circulating.length) {
        return describeAction(action, false, "That whisper is already gone.");
      }
      if (!Store.spendTax(office.kingdomId, SUPPRESS_RUMOR_COST)) {
        return describeAction(action, false, "The coffers cannot fund this silence.");
      }
      const buried = OfficeTools.suppressRumor(office.kingdomId, index, username);
      Store.save();
      if (buried) {
        return describeAction(action, true, "The whisper dies in the streets.");
      }
      return describeAction(action, false, "The whisper slipped away.");
    }

    // --- general ---
    case "vacate-office": {
      const office = Offices.getOffice(officeId);
      if (!office) return describeAction(action, false, "No such office.");
      const holder = office.holder;
      const ownOffice = holder?.kind === "player" && holder.ref === username;
      const isOwner = player.getRights?.()?.getId?.() >= 3;
      if (!ownOffice && !isOwner) {
        return describeAction(action, false, "You don't hold that office.");
      }
      try {
        api.emitCustomEvent("kingdom:office-vacated", {
          officeId,
          kingdomId: office.kingdomId,
        });
      } catch {
        // Still vacated locally.
        Offices.vacateOffice(officeId);
      }
      return describeAction(
        action,
        true,
        `The office of ${office.title} (${kingdomName(office.kingdomId)}) is vacant.`
      );
    }
    case "petition-office": {
      const office = Offices.getOffice(officeId);
      if (!office) return describeAction(action, false, "No such office.");
      if (office.holder) {
        return describeAction(action, false, "That office is already held.");
      }
      if (Politics?.petition) {
        try {
          Politics.petition(player, [officeId]);
          return describeAction(action, true, "Your petition is before the court.");
        } catch {
          return describeAction(action, false, "The court could not be reached.");
        }
      }
      return describeAction(action, false, "The court could not be reached.");
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
  console.info("[office-api] registering office-status endpoint");
  api.registerContentEndpoint("office-status", (query) => {
    try {
      const player = findPlayer(api, query.get("player"));
      const action = (query.get("action") || "").trim().toLowerCase();

      if (player && (action === "open" || action === "close")) {
        try {
          player.setAttribute(OFFICE_OPEN_ATTRIBUTE, action === "open" ? "1" : "");
        } catch (e) {
          console.warn("[office-api] flag update failed", e?.message ?? e);
        }
        return statusPayload(player);
      }

      if (player && action) {
        let actionResult = null;
        try {
          actionResult = runOfficeAction(api, player, action, query);
        } catch (error) {
          console.warn("[office-api] office action failed", action, error?.message ?? error);
          actionResult = { ok: false, message: "The order could not be carried out." };
        }
        return { ...statusPayload(player), actionResult };
      }

      return statusPayload(player);
    } catch (error) {
      console.warn("[office-api] status failed", error?.message ?? error);
      return { open: false };
    }
  });
}

module.exports = attach;
module.exports.attach = attach;
module.exports.OFFICE_OPEN_ATTRIBUTE = OFFICE_OPEN_ATTRIBUTE;
