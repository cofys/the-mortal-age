"use strict";

/**
 * OfficeTools.Kingdoms — the SEALS OF OFFICE. Player-held offices get real
 * management tools, diegetic through the War Table (never ::commands).
 *
 * When a player studies the war table, the table grows a YOUR SEALS section
 * (WarTable.Kingdoms renders sealsLines) and — if they personally hold any
 * office — a chatbox prompt offers each office's console. Only the CURRENT
 * holder (kind "player", matching username) ever sees their office's tools;
 * AI holders keep doing exactly what they do, and every console re-verifies
 * the holder on every menu, so a lost seal closes the tools immediately.
 *
 *   Steward       — treasury survey (balance, last tax, last wages, rate),
 *                   tax-rate policy (0.5x/1x/1.5x/2x; heavy rates breed
 *                   unrest rumors, light rates starve the coffers), and the
 *                   petition queue (approve spends/grants, deny risks anger).
 *   Quartermaster — stores survey, stockpile targets (peace/war), and
 *                   standing supply orders that real players fill for coin
 *                   through the donation chest (deliverSupplies).
 *   Marshal       — garrison review, patrol orders (border + guards; each
 *                   guard costs WAGE_PER_GUARD from the treasury every realm
 *                   tick, and patrolling a border calms its tension), and
 *                   the wartime levy multiplier.
 *   Spymaster     — the circulating rumor pool, planting rumors in a city
 *                   for coin, and counter-intelligence (suppress a rumor).
 *
 * Every tool writes real policy into the kingdom record (sim:* flags), and
 * the realm tick (Simulation.Kingdoms) reads those flags: tax rate changes
 * collection, patrol orders spend the treasury and move border tension,
 * planted rumors enter the pool citizens repeat. Nothing here is cosmetic.
 *
 * Out (custom events, AGENTS.md: plugins talk through events):
 *   kingdom:rumor            { kingdomId, text }          (existing; planted/unrest)
 *   kingdom:rumor-suppressed { kingdomId, text }
 *   kingdom:supply-order     { kingdomId, units, pricePer, by }
 *   kingdom:supply-delivered { kingdomId, player, itemId, qty, units, payout }
 *   kingdom:tax-rate-changed { kingdomId, rate, by }
 *   kingdom:war-levy-changed { kingdomId, levy, by }
 *   kingdom:petition-resolved { kingdomId, outcome: "approved"|"denied", text, by }
 * In:
 *   kingdom:wages-paid       { kingdomId, total }  (citizens payday -> steward ledger)
 *
 * State: all policy lives on the kingdom record via KingdomStore flags
 * (sim:*), persisted by Store.save() after every player-driven change.
 * Policy is the realm's, not the holder's: a new holder inherits it.
 */

const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");
const Membership = require("./Membership.Kingdoms");
const Tension = require("./Tension.Kingdoms");

// --- policy keys (kebab-case, namespaced; sim: is the simulation namespace) --
const TAX_RATE_FLAG = "sim:tax-rate";
const WAR_LEVY_FLAG = "sim:war-levy";
const LAST_TAX_FLAG = "sim:last-tax";
const LAST_WAGES_FLAG = "sim:last-wages";
const PETITIONS_FLAG = "sim:petitions";
const TARGET_PEACE_FLAG = "sim:stockpile-target-peace";
const TARGET_WAR_FLAG = "sim:stockpile-target-war";
const SUPPLY_ORDER_FLAG = "sim:supply-order";
const PATROL_ORDER_FLAG = "sim:patrol-order";
const PATROL_COST_FLAG = "sim:patrol-cost-last";
const RUMORS_FLAG = "sim:rumors";
const STOCKPILE_FLAG = "sim:stockpile"; // owned by Simulation.Kingdoms; read here, written there

const TAX_RATES = [0.5, 1, 1.5, 2];
const WAR_LEVIES = [1.2, 1.6, 2.0, 2.5];
const PEACE_TARGETS = [200, 400, 600];
const WAR_TARGETS = [800, 1200, 1600];
const PATROL_GUARDS = [4, 8, 12];
const WAGE_PER_GUARD = 25; // mirrors Simulation.Kingdoms
const PLANT_RUMOR_COST = 200;
const SUPPRESS_RUMOR_COST = 300;
const MAX_PETITIONS = 5;
const MAX_RUMORS = 12;
const RUMOR_TTL_MS = 24 * 60 * 60 * 1000;
const COINS_ID = 995;

// Provisions the quartermaster buys: item id -> supply units per item.
// Ids from data/definitions/item-gameplay.json (Bread 2309, Cooked meat
// 2142, Cooked chicken 2140).
const SUPPLY_ITEMS = {
  2309: { units: 2, name: "Bread" },
  2142: { units: 3, name: "Cooked meat" },
  2140: { units: 2, name: "Cooked chicken" },
};

let pluginApi = null;

function emit(name, payload) {
  try {
    pluginApi?.emitCustomEvent(name, payload);
  } catch {
    // The realm tick runs without a listener; policy still lands.
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function kingdomName(kingdomId) {
  return Store.getKingdom(kingdomId)?.name ?? kingdomId;
}

function capitalName(kingdomId) {
  return Store.getKingdom(kingdomId)?.capital ?? kingdomName(kingdomId);
}

function formatCoins(n) {
  return Math.floor(n).toLocaleString("en-US");
}

function flagOf(kingdomId, key) {
  return Store.getKingdom(kingdomId)?.flags?.[key];
}

// --- tax & levy policy -----------------------------------------------------

function getTaxRate(kingdomId) {
  const raw = flagOf(kingdomId, TAX_RATE_FLAG);
  return TAX_RATES.includes(raw) ? raw : 1;
}

function setTaxRate(kingdomId, rate, by) {
  if (!TAX_RATES.includes(rate)) return false;
  Store.setFlag(kingdomId, TAX_RATE_FLAG, rate);
  Store.save();
  emit("kingdom:tax-rate-changed", { kingdomId, rate, by: by ?? null });
  return true;
}

function getWarLevy(kingdomId) {
  const raw = flagOf(kingdomId, WAR_LEVY_FLAG);
  return WAR_LEVIES.includes(raw) ? raw : 1.6;
}

function setWarLevy(kingdomId, levy, by) {
  if (!WAR_LEVIES.includes(levy)) return false;
  Store.setFlag(kingdomId, WAR_LEVY_FLAG, levy);
  Store.save();
  emit("kingdom:war-levy-changed", { kingdomId, levy, by: by ?? null });
  return true;
}

// --- stockpile targets -----------------------------------------------------

function stockpileTarget(kingdomId, wartime) {
  const key = wartime ? TARGET_WAR_FLAG : TARGET_PEACE_FLAG;
  const raw = flagOf(kingdomId, key);
  const lo = wartime ? 400 : 100;
  const hi = wartime ? 2400 : 1000;
  if (Number.isFinite(raw) && raw >= lo && raw <= hi) return Math.floor(raw);
  return wartime ? 1200 : 400;
}

function setStockpileTarget(kingdomId, wartime, value) {
  const lo = wartime ? 400 : 100;
  const hi = wartime ? 2400 : 1000;
  const v = Math.floor(Number(value));
  if (!Number.isFinite(v) || v < lo || v > hi) return false;
  Store.setFlag(kingdomId, wartime ? TARGET_WAR_FLAG : TARGET_PEACE_FLAG, v);
  Store.save();
  return true;
}

// --- patrol & supply orders --------------------------------------------------

function getPatrolOrder(kingdomId) {
  const raw = flagOf(kingdomId, PATROL_ORDER_FLAG);
  if (!raw || typeof raw !== "object") return null;
  if (!Number.isFinite(raw.guards) || raw.guards <= 0) return null;
  return raw;
}

function setPatrolOrder(kingdomId, { target, guards, by }) {
  if (!PATROL_GUARDS.includes(guards)) return false;
  Store.setFlag(kingdomId, PATROL_ORDER_FLAG, {
    target: target ?? "home",
    guards,
    by: by ?? null,
    at: Date.now(),
  });
  Store.save();
  return true;
}

function clearPatrolOrder(kingdomId) {
  Store.setFlag(kingdomId, PATROL_ORDER_FLAG, null);
  Store.save();
}

function getSupplyOrder(kingdomId) {
  const raw = flagOf(kingdomId, SUPPLY_ORDER_FLAG);
  if (!raw || typeof raw !== "object") return null;
  if (!Number.isFinite(raw.units) || raw.units <= 0) return null;
  return raw;
}

function setSupplyOrder(kingdomId, { units, pricePer, by }) {
  const u = Math.floor(Number(units));
  const p = Math.floor(Number(pricePer));
  if (!Number.isFinite(u) || u <= 0 || u > 2000) return false;
  if (!Number.isFinite(p) || p <= 0 || p > 25) return false;
  Store.setFlag(kingdomId, SUPPLY_ORDER_FLAG, { units: u, pricePer: p, by: by ?? null, at: Date.now() });
  Store.save();
  emit("kingdom:supply-order", { kingdomId, units: u, pricePer: p, by: by ?? null });
  return true;
}

function clearSupplyOrder(kingdomId) {
  Store.setFlag(kingdomId, SUPPLY_ORDER_FLAG, null);
  Store.save();
}

// --- rumor pool --------------------------------------------------------------

function getRumors(kingdomId) {
  const raw = flagOf(kingdomId, RUMORS_FLAG);
  if (!Array.isArray(raw)) return [];
  const cutoff = Date.now() - RUMOR_TTL_MS;
  return raw.filter((r) => r && typeof r.text === "string" && r.at > cutoff);
}

/** Record a circulating rumor (cap + TTL). Emitting it is the caller's job. */
function recordRumor(kingdomId, text) {
  if (!text) return;
  const pool = getRumors(kingdomId);
  pool.push({ text: String(text).slice(0, 160), at: Date.now() });
  Store.setFlag(kingdomId, RUMORS_FLAG, pool.slice(-MAX_RUMORS));
}

function suppressRumor(kingdomId, index, by) {
  const pool = getRumors(kingdomId);
  if (index < 0 || index >= pool.length) return null;
  const [removed] = pool.splice(index, 1);
  Store.setFlag(kingdomId, RUMORS_FLAG, pool);
  Store.save();
  emit("kingdom:rumor-suppressed", { kingdomId, text: removed.text, by: by ?? null });
  return removed.text;
}

const UNREST_RUMORS = {
  taxes: [
    "They say the tax collectors take double in {kingdom} and the smallfolk go hungry.",
    "They say {capital} mutters against the Steward's heavy levy.",
  ],
  denied: [
    "They say the Steward of {kingdom} turned a beggar from the gates, and the street noticed.",
  ],
  ignored: [
    "They say petitions rot unanswered at the {capital} court, and patience wears thin.",
  ],
  empty: [
    "They say the patrols of {kingdom} stand down - the coffers are empty.",
  ],
};

function unrestRumor(kingdom, kind) {
  const lines = UNREST_RUMORS[kind] ?? UNREST_RUMORS.taxes;
  const text = lines[Math.floor(Math.random() * lines.length)];
  return text
    .replace("{kingdom}", kingdom.name)
    .replace("{capital}", capitalName(kingdom.id));
}

/** Emit an unrest rumor AND record it in the pool. */
function emitUnrest(kingdomId, kind) {
  const kingdom = Store.getKingdom(kingdomId);
  if (!kingdom) return;
  const text = unrestRumor(kingdom, kind);
  recordRumor(kingdomId, text);
  emit("kingdom:rumor", { kingdomId, text });
}

// --- petitions ---------------------------------------------------------------

const PETITION_TEMPLATES = [
  {
    kind: "relief",
    text: () => `A miller of ${"{capital}"} begs relief from the grain tithe.`,
    cost: () => 0,
  },
  {
    kind: "grant",
    text: () => `The ${"{capital}"} orphanhouse seeks {amt} coins for winter stores.`,
    cost: () => 80 + Math.floor(Math.random() * 5) * 20, // 80-160
  },
  {
    kind: "road",
    text: () => `Villagers ask {amt} coins to mend the ${"{capital}"} road.`,
    cost: () => 150 + Math.floor(Math.random() * 4) * 50, // 150-300
  },
  {
    kind: "well",
    text: () => `A hamlet near ${"{capital}"} needs {amt} coins for a new well.`,
    cost: () => 100 + Math.floor(Math.random() * 3) * 50, // 100-200
  },
  {
    kind: "charter",
    text: () => `A guildmaster seeks a trading charter in ${"{capital}"} — honor, not coin.`,
    cost: () => 0, // Charters grant prestige, never coins: the crown mints nothing.
  },
];

function getPetitions(kingdomId) {
  const raw = flagOf(kingdomId, PETITIONS_FLAG);
  return Array.isArray(raw) ? raw.filter((p) => p && p.id && p.text) : [];
}

function savePetitions(kingdomId, petitions) {
  Store.setFlag(kingdomId, PETITIONS_FLAG, petitions.slice(0, MAX_PETITIONS));
}

function makePetition(kingdom) {
  const template = PETITION_TEMPLATES[Math.floor(Math.random() * PETITION_TEMPLATES.length)];
  const cost = template.cost();
  const amt = Math.abs(cost);
  const text = template
    .text()
    .replace("{capital}", capitalName(kingdom.id))
    .replace("{amt}", formatCoins(amt));
  return {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    kind: template.kind,
    text,
    cost,
    filedAt: Date.now(),
  };
}

function removePetition(kingdomId, petitionId) {
  const queue = getPetitions(kingdomId);
  const idx = queue.findIndex((p) => p.id === petitionId);
  if (idx < 0) return null;
  const [removed] = queue.splice(idx, 1);
  savePetitions(kingdomId, queue);
  return removed;
}

/**
 * Approve a petition: grants pay INTO the treasury, relief costs it.
 * Returns true when the petition left the queue.
 */
function approvePetition(kingdomId, petitionId, by) {
  const queue = getPetitions(kingdomId);
  const petition = queue.find((p) => p.id === petitionId);
  if (!petition) return false;
  if (petition.cost > 0 && !Store.spendTax(kingdomId, petition.cost)) return false;
  if (petition.cost < 0) Store.grantTax(kingdomId, -petition.cost);
  removePetition(kingdomId, petitionId);
  Store.save();
  emit("kingdom:petition-resolved", {
    kingdomId,
    outcome: "approved",
    text: petition.text,
    by: by ?? null,
  });
  return true;
}

/** Deny a petition: it leaves the queue, and the street may notice. */
function denyPetition(kingdomId, petitionId, by) {
  const petition = removePetition(kingdomId, petitionId);
  if (!petition) return false;
  Store.save();
  emit("kingdom:petition-resolved", {
    kingdomId,
    outcome: "denied",
    text: petition.text,
    by: by ?? null,
  });
  if (Math.random() < 0.4) emitUnrest(kingdomId, "denied");
  return true;
}

/**
 * The petition queue ticks with the realm. Citizens file petitions whether
 * or not anyone reads them; only a present steward resolves them.
 *   player holder -> the queue waits for their hand (the console).
 *   ai holder     -> the AI steward works the queue: funds cheap relief and
 *                    profitable charters, refuses the dear ones.
 *   vacant        -> petitions fester; the oldest sometimes curdles into
 *                    street anger.
 */
function tickPetitions(kingdom, holderKind) {
  const queue = getPetitions(kingdom.id);
  if (queue.length < MAX_PETITIONS && Math.random() < 0.3) {
    queue.push(makePetition(kingdom));
    savePetitions(kingdom.id, queue);
  }
  if (holderKind === "player") return;
  const pending = getPetitions(kingdom.id);
  if (pending.length === 0) return;
  if (holderKind === "ai") {
    const petition = pending[0];
    if (petition.cost <= 150) approvePetition(kingdom.id, petition.id, "ai");
    else denyPetition(kingdom.id, petition.id, "ai");
  } else if (Math.random() < 0.2) {
    removePetition(kingdom.id, pending[0].id);
    Store.save();
    emitUnrest(kingdom.id, "ignored");
  }
}

// --- access control ----------------------------------------------------------

function officesHeldBy(player) {
  const username = usernameOf(player);
  if (!username) return [];
  return Offices.getOffices().filter(
    (o) => o.holder?.kind === "player" && o.holder.ref === username
  );
}

/** True only while THIS player is the CURRENT holder of the office. */
function holdsOffice(player, kingdomId, office) {
  const username = usernameOf(player);
  if (!username) return false;
  const holder = Offices.holderOf(Offices.officeIdFor(kingdomId, office));
  return holder?.kind === "player" && holder.ref === username;
}

// --- dialogue plumbing --------------------------------------------------------

function showPrompt(player, title, pairs) {
  try {
    return pluginApi.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[office-tools] prompt failed", error?.message ?? error);
    player.sendMessage("The war room falls quiet. Try again.");
    return false;
  }
}

function say(player, lines) {
  for (const line of lines) {
    try {
      player.sendMessage(line);
    } catch {
      break;
    }
  }
}

function backTo(player, kingdomId, office) {
  return () => openConsole(player, kingdomId, office);
}

// --- Steward -----------------------------------------------------------------

const TAX_RATE_LABELS = {
  0.5: "Halve the levy (0.5x) - quiet streets, thin coffers.",
  1: "The customary rate (1x).",
  1.5: "A heavy hand (1.5x) - full coffers, grumbling streets.",
  2: "War footing (2x) - the realm will curse your name.",
};

function stewardSurvey(player, kingdomId) {
  const kingdom = Store.getKingdom(kingdomId);
  const treasury = kingdom?.treasury ?? 0;
  const petitions = getPetitions(kingdomId);
  say(player, [
    `[Steward] Treasury of ${kingdomName(kingdomId)}: ${formatCoins(treasury)}c.`,
    `  Last tax collected: ${formatCoins(flagOf(kingdomId, LAST_TAX_FLAG) ?? 0)}c at rate ${getTaxRate(kingdomId)}x` +
      (Store.getActiveWars().some((w) => w.attackerId === kingdomId || w.defenderId === kingdomId)
        ? `, war levy ${getWarLevy(kingdomId)}x.` : "."),
    `  Last wages paid: ${formatCoins(flagOf(kingdomId, LAST_WAGES_FLAG) ?? 0)}c.`,
    `  Petitions awaiting your seal: ${petitions.length}.`,
  ]);
}

function stewardSetRate(player, kingdomId) {
  const pairs = [];
  for (const rate of TAX_RATES) {
    const current = rate === getTaxRate(kingdomId) ? " (current)" : "";
    pairs.push(`${TAX_RATE_LABELS[rate]}${current}`, () => {
      if (!holdsOffice(player, kingdomId, "steward")) return sealLost(player);
      setTaxRate(kingdomId, rate, usernameOf(player));
      say(player, [
        `[Steward] The levy is set at ${rate}x. ` +
          (rate >= 1.5
            ? "The collectors smile; the streets will not."
            : rate <= 0.5
              ? "The streets breathe easier - and the coffers will feel it."
              : "The customary rate. None love it, none starve."),
      ]);
      openConsole(player, kingdomId, "steward");
    });
  }
  pairs.push("On reflection, no change.", backTo(player, kingdomId, "steward"));
  showPrompt(player, "Set the tax levy - " + kingdomName(kingdomId), pairs);
}

function stewardPetitions(player, kingdomId) {
  const queue = getPetitions(kingdomId);
  if (queue.length === 0) {
    say(player, ["[Steward] No petitions await. The court is quiet - for now."]);
    openConsole(player, kingdomId, "steward");
    return;
  }
  const pairs = [];
  for (const petition of queue.slice(0, 5)) {
    const terms =
      petition.cost > 0
        ? `costs ${formatCoins(petition.cost)}c`
        : petition.cost < 0
          ? `pays ${formatCoins(-petition.cost)}c`
          : "costs nothing";
    pairs.push(`Approve: ${petition.text} (${terms})`, () => {
      if (!holdsOffice(player, kingdomId, "steward")) return sealLost(player);
      if (approvePetition(kingdomId, petition.id, usernameOf(player))) {
        say(player, [`[Steward] Granted. ${petition.cost > 0 ? "The treasury is lighter." : petition.cost < 0 ? "The treasury grows." : "It costs the realm nothing."}`]);
      } else {
        say(player, ["[Steward] The coffers cannot bear it. The petition waits."]);
      }
      stewardPetitions(player, kingdomId);
    });
    pairs.push(`Deny: ${petition.text.slice(0, 48)}...`, () => {
      if (!holdsOffice(player, kingdomId, "steward")) return sealLost(player);
      denyPetition(kingdomId, petition.id, usernameOf(player));
      say(player, ["[Steward] Denied. The petitioner leaves - the street may talk."]);
      stewardPetitions(player, kingdomId);
    });
  }
  pairs.push("The rest can wait.", backTo(player, kingdomId, "steward"));
  showPrompt(player, `Petitions before the Steward (${queue.length})`, pairs);
}

function stewardConsole(player, kingdomId) {
  const petitions = getPetitions(kingdomId).length;
  showPrompt(player, `The Steward's seals - ${kingdomName(kingdomId)}`, [
    "Survey the treasury.",
    () => { stewardSurvey(player, kingdomId); stewardConsole(player, kingdomId); },
    "Set the tax levy.",
    () => stewardSetRate(player, kingdomId),
    `Hear petitions (${petitions}).`,
    () => stewardPetitions(player, kingdomId),
    "Return to the table.",
    () => {},
  ]);
}

// --- Quartermaster -----------------------------------------------------------

function quartermasterSurvey(player, kingdomId) {
  const wartime = Store.getActiveWars().some((w) => w.attackerId === kingdomId || w.defenderId === kingdomId);
  const stockpile = Number.isFinite(flagOf(kingdomId, STOCKPILE_FLAG))
    ? Math.floor(flagOf(kingdomId, STOCKPILE_FLAG)) : 0;
  const target = stockpileTarget(kingdomId, wartime);
  const order = getSupplyOrder(kingdomId);
  say(player, [
    `[Quartermaster] Stores of ${kingdomName(kingdomId)}: ${formatCoins(stockpile)} / ${formatCoins(target)} units` +
      (wartime ? " (wartime target)." : " (peacetime target)."),
    order
      ? `  Standing supply order: ${formatCoins(order.units)} units wanted at ${order.pricePer}c each. Deliver to the donation chest.`
      : "  No standing supply order. The merchants wait.",
  ]);
}

function quartermasterTargets(player, kingdomId) {
  const pairs = [];
  for (const t of PEACE_TARGETS) {
    const current = t === stockpileTarget(kingdomId, false) ? " (current)" : "";
    pairs.push(`Peacetime target: ${t} units${current}`, () => {
      if (!holdsOffice(player, kingdomId, "quartermaster")) return sealLost(player);
      setStockpileTarget(kingdomId, false, t);
      say(player, [`[Quartermaster] Peacetime stores target: ${t} units.`]);
      openConsole(player, kingdomId, "quartermaster");
    });
  }
  for (const t of WAR_TARGETS) {
    const current = t === stockpileTarget(kingdomId, true) ? " (current)" : "";
    pairs.push(`Wartime target: ${t} units${current}`, () => {
      if (!holdsOffice(player, kingdomId, "quartermaster")) return sealLost(player);
      setStockpileTarget(kingdomId, true, t);
      say(player, [`[Quartermaster] Wartime stores target: ${t} units.`]);
      openConsole(player, kingdomId, "quartermaster");
    });
  }
  pairs.push("Leave the targets.", backTo(player, kingdomId, "quartermaster"));
  showPrompt(player, "Set the stockpile targets", pairs);
}

const SUPPLY_BUNDLES = [
  { units: 100, pricePer: 2 },
  { units: 250, pricePer: 2 },
  { units: 500, pricePer: 3 },
];

function quartermasterOrder(player, kingdomId) {
  const existing = getSupplyOrder(kingdomId);
  const pairs = [];
  for (const b of SUPPLY_BUNDLES) {
    pairs.push(
      `Seek ${b.units} units at ${b.pricePer}c each (${formatCoins(b.units * b.pricePer)}c when filled).`,
      () => {
        if (!holdsOffice(player, kingdomId, "quartermaster")) return sealLost(player);
        setSupplyOrder(kingdomId, { units: b.units, pricePer: b.pricePer, by: usernameOf(player) });
        say(player, [
          `[Quartermaster] The order goes out: ${b.units} units of provisions at ${b.pricePer}c each. ` +
            "Any subject may deliver bread, cooked meat or cooked chicken to the donation chest and be paid from the treasury.",
        ]);
        openConsole(player, kingdomId, "quartermaster");
      }
    );
  }
  if (existing) {
    pairs.push("Cancel the standing order.", () => {
      if (!holdsOffice(player, kingdomId, "quartermaster")) return sealLost(player);
      clearSupplyOrder(kingdomId);
      say(player, ["[Quartermaster] The order is withdrawn."]);
      openConsole(player, kingdomId, "quartermaster");
    });
  }
  pairs.push("No order.", backTo(player, kingdomId, "quartermaster"));
  showPrompt(player, "Issue a supply order - paid from the treasury on delivery", pairs);
}

function quartermasterConsole(player, kingdomId) {
  showPrompt(player, `The Quartermaster's seals - ${kingdomName(kingdomId)}`, [
    "Survey the stores.",
    () => { quartermasterSurvey(player, kingdomId); quartermasterConsole(player, kingdomId); },
    "Set stockpile targets.",
    () => quartermasterTargets(player, kingdomId),
    "Issue a supply order.",
    () => quartermasterOrder(player, kingdomId),
    "Return to the table.",
    () => {},
  ]);
}

// --- Marshal -----------------------------------------------------------------

function marshalSurvey(player, kingdomId) {
  const garrison = Tension.garrisonOf(kingdomId);
  const order = getPatrolOrder(kingdomId);
  const treasury = Store.getKingdom(kingdomId)?.treasury ?? 0;
  say(player, [
    `[Marshal] Garrison of ${kingdomName(kingdomId)}: ${garrison}/60 blades.`,
    `  Treasury: ${formatCoins(treasury)}c.`,
    order
      ? `  Standing patrol order: ${order.guards} guards on the ` +
        `${order.target === "home" ? "home roads" : kingdomName(order.target) + " border"}, ` +
        `${formatCoins(order.guards * WAGE_PER_GUARD)}c per realm tick.` +
        (flagOf(kingdomId, PATROL_COST_FLAG) ? ` Last tick cost ${formatCoins(flagOf(kingdomId, PATROL_COST_FLAG))}c.` : "")
      : "  No standing patrol order - the roads are watched only by habit.",
  ]);
}

function marshalPatrols(player, kingdomId) {
  const neighbors = Store.getKingdoms()
    .filter((k) => k.id !== kingdomId)
    .slice(0, 6);
  const pairs = [];
  const chooseGuards = (target) => {
    const gpairs = [];
    for (const guards of PATROL_GUARDS) {
      const cost = guards * WAGE_PER_GUARD;
      gpairs.push(`${guards} guards - ${formatCoins(cost)}c per realm tick.`, () => {
        if (!holdsOffice(player, kingdomId, "marshal")) return sealLost(player);
        setPatrolOrder(kingdomId, { target, guards, by: usernameOf(player) });
        const where = target === "home" ? "the home roads" : `the ${kingdomName(target)} border`;
        say(player, [
          `[Marshal] ${guards} guards to ${where}. ${formatCoins(cost)}c per realm tick, from the treasury. ` +
            (target !== "home" ? "A watched border is a calmer border." : "The home roads will sleep safer."),
        ]);
        openConsole(player, kingdomId, "marshal");
      });
    }
    gpairs.push("Choose another border.", () => marshalPatrols(player, kingdomId));
    const where = target === "home" ? "the home roads" : `the ${kingdomName(target)} border`;
    showPrompt(player, `How many guards for ${where}?`, gpairs);
  };
  pairs.push("The home roads.", () => chooseGuards("home"));
  for (const n of neighbors) {
    pairs.push(`The ${n.name} border.`, () => chooseGuards(n.id));
  }
  if (getPatrolOrder(kingdomId)) {
    pairs.push("Stand the patrols down.", () => {
      if (!holdsOffice(player, kingdomId, "marshal")) return sealLost(player);
      clearPatrolOrder(kingdomId);
      say(player, ["[Marshal] The patrols stand down. The roads grow quieter - and less safe."]);
      openConsole(player, kingdomId, "marshal");
    });
  }
  pairs.push("No orders.", backTo(player, kingdomId, "marshal"));
  showPrompt(player, "Order patrols - which border?", pairs);
}

const LEVY_LABELS = {
  1.2: "Ease the levy (1.2x) - spare the smallfolk.",
  1.6: "The customary war levy (1.6x).",
  2.0: "A hard levy (2x) - the war chest swells.",
  2.5: "Bleed them dry (2.5x) - victory at any price.",
};

function marshalLevy(player, kingdomId) {
  const pairs = [];
  for (const levy of WAR_LEVIES) {
    const current = levy === getWarLevy(kingdomId) ? " (current)" : "";
    pairs.push(`${LEVY_LABELS[levy]}${current}`, () => {
      if (!holdsOffice(player, kingdomId, "marshal")) return sealLost(player);
      setWarLevy(kingdomId, levy, usernameOf(player));
      say(player, [
        `[Marshal] The war levy stands at ${levy}x. It bites only while the realm is at war` +
          (levy >= 2 ? " - and the smallfolk will remember who set it." : "."),
      ]);
      openConsole(player, kingdomId, "marshal");
    });
  }
  pairs.push("Leave the levy.", backTo(player, kingdomId, "marshal"));
  showPrompt(player, "Set the war levy - paid in wartime taxes", pairs);
}

function marshalConsole(player, kingdomId) {
  showPrompt(player, `The Marshal's seals - ${kingdomName(kingdomId)}`, [
    "Review the garrison.",
    () => { marshalSurvey(player, kingdomId); marshalConsole(player, kingdomId); },
    "Order patrols.",
    () => marshalPatrols(player, kingdomId),
    "Set the war levy.",
    () => marshalLevy(player, kingdomId),
    "Return to the table.",
    () => {},
  ]);
}

// --- Spymaster ---------------------------------------------------------------

const SEED_RUMOR_TEMPLATES = [
  (city) => `They say sellswords sharpen their blades for ${city} - someone is paying.`,
  (city) => `They say the ${city} granaries stand half-empty and the court hides it.`,
  (city) => `They say ${city}'s walls will hold against any host - the gods themselves laid the stones.`,
  (city) => `They say a ${city} councillor sells secrets across the border.`,
];

function spymasterSurvey(player, kingdomId) {
  const rumors = getRumors(kingdomId);
  say(player, [`[Spymaster] ${rumors.length} whisper${rumors.length === 1 ? "" : "s"} circulate in ${kingdomName(kingdomId)}:`]);
  if (rumors.length === 0) {
    say(player, ["  The streets are quiet. Too quiet."]);
  }
  for (const rumor of rumors.slice(-6)) {
    say(player, [`  "${rumor.text}"`]);
  }
}

function spymasterPlant(player, kingdomId) {
  const cities = Store.getKingdoms().slice(0, 6);
  const pairs = [];
  const chooseRumor = (targetId) => {
    const city = capitalName(targetId);
    const rpairs = [];
    for (const make of SEED_RUMOR_TEMPLATES) {
      const text = make(city);
      rpairs.push(`"${text.slice(0, 52)}..."`, () => {
        if (!holdsOffice(player, kingdomId, "spymaster")) return sealLost(player);
        if (!Store.spendTax(kingdomId, PLANT_RUMOR_COST)) {
          say(player, ["[Spymaster] The coffers cannot fund this whisper."]);
          openConsole(player, kingdomId, "spymaster");
          return;
        }
        Store.save();
        recordRumor(targetId, text);
        emit("kingdom:rumor", { kingdomId: targetId, text });
        say(player, [`[Spymaster] ${formatCoins(PLANT_RUMOR_COST)}c buys a whisper in ${city}. By dusk, every tavern repeats it.`]);
        openConsole(player, kingdomId, "spymaster");
      });
    }
    rpairs.push("Another city.", () => spymasterPlant(player, kingdomId));
    showPrompt(player, `What whisper for ${city}? (${formatCoins(PLANT_RUMOR_COST)}c)`, rpairs);
  };
  for (const k of cities) {
    pairs.push(`Whisper in ${capitalName(k.id)} (${k.name}).`, () => chooseRumor(k.id));
  }
  pairs.push("No whisper.", backTo(player, kingdomId, "spymaster"));
  showPrompt(player, "Plant a rumor - where?", pairs);
}

function spymasterSuppress(player, kingdomId) {
  const rumors = getRumors(kingdomId);
  if (rumors.length === 0) {
    say(player, ["[Spymaster] Nothing circulates. Nothing to bury."]);
    openConsole(player, kingdomId, "spymaster");
    return;
  }
  const pairs = [];
  rumors.slice(-5).forEach((rumor) => {
    const index = rumors.indexOf(rumor);
    pairs.push(`Bury: "${rumor.text.slice(0, 48)}..."`, () => {
      if (!holdsOffice(player, kingdomId, "spymaster")) return sealLost(player);
      if (!Store.spendTax(kingdomId, SUPPRESS_RUMOR_COST)) {
        say(player, ["[Spymaster] The coffers cannot fund this silence."]);
        openConsole(player, kingdomId, "spymaster");
        return;
      }
      const buried = suppressRumor(kingdomId, index, usernameOf(player));
      say(player, [
        buried
          ? `[Spymaster] ${formatCoins(SUPPRESS_RUMOR_COST)}c, and the whisper dies in the streets. None will repeat it now.`
          : "[Spymaster] The whisper slipped away before your knives found it.",
      ]);
      openConsole(player, kingdomId, "spymaster");
    });
  });
  pairs.push("Let them talk.", backTo(player, kingdomId, "spymaster"));
  showPrompt(player, `Counter-intelligence - bury a whisper (${formatCoins(SUPPRESS_RUMOR_COST)}c each)`, pairs);
}

function spymasterConsole(player, kingdomId) {
  showPrompt(player, `The Spymaster's seals - ${kingdomName(kingdomId)}`, [
    "Hear what circulates.",
    () => { spymasterSurvey(player, kingdomId); spymasterConsole(player, kingdomId); },
    `Plant a rumor (${formatCoins(PLANT_RUMOR_COST)}c).`,
    () => spymasterPlant(player, kingdomId),
    `Suppress a rumor (${formatCoins(SUPPRESS_RUMOR_COST)}c).`,
    () => spymasterSuppress(player, kingdomId),
    "Return to the table.",
    () => {},
  ]);
}

// --- console entry -------------------------------------------------------------

const CONSOLES = {
  steward: stewardConsole,
  quartermaster: quartermasterConsole,
  marshal: marshalConsole,
  spymaster: spymasterConsole,
};

function sealLost(player) {
  say(player, ["The seals have passed to another. The war table shows you nothing more."]);
}

function openConsole(player, kingdomId, office) {
  if (!holdsOffice(player, kingdomId, office)) return sealLost(player);
  const officeRec = Offices.getOffice(Offices.officeIdFor(kingdomId, office));
  if (!officeRec) return;
  CONSOLES[office](player, kingdomId);
}

/**
 * Offered when a player studies the war table: one door per seal they hold.
 * AI-held and vacant offices open nothing.
 */
function offerConsoles(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  const held = officesHeldBy(player);
  if (held.length === 0) return;
  const pairs = [];
  for (const office of held) {
    const label = `Take up the ${office.title} seals - ${kingdomName(office.kingdomId)}.`;
    pairs.push(label, () => openConsole(player, office.kingdomId, office.office));
  }
  pairs.push("Return to the table.", () => {});
  showPrompt(player, "Your seals of office lie heavy. Take them up?", pairs);
}

/** YOUR SEALS section lines for the war table (2 rows). */
function sealsLines(player) {
  const held = officesHeldBy(player);
  if (held.length === 0) return ["You hold no seals of office."];
  const lines = [];
  for (const office of held.slice(0, 2)) {
    const k = Store.getKingdom(office.kingdomId);
    const treasury = formatCoins(k?.treasury ?? 0);
    if (office.office === "steward") {
      lines.push(
        `Steward of ${k?.name ?? office.kingdomId} - treasury ${treasury}c, ` +
        `tax ${getTaxRate(office.kingdomId)}x, ${getPetitions(office.kingdomId).length} petitions await.`
      );
    } else if (office.office === "quartermaster") {
      const wartime = Store.getActiveWars().some(
        (w) => w.attackerId === office.kingdomId || w.defenderId === office.kingdomId
      );
      const stockpile = Math.floor(flagOf(office.kingdomId, STOCKPILE_FLAG) ?? 0);
      const order = getSupplyOrder(office.kingdomId);
      lines.push(
        `Quartermaster of ${k?.name ?? office.kingdomId} - stores ${formatCoins(stockpile)}/` +
        `${formatCoins(stockpileTarget(office.kingdomId, wartime))}` +
        (order ? `, order: ${formatCoins(order.units)}u at ${order.pricePer}c.` : ", no supply order.")
      );
    } else if (office.office === "marshal") {
      const order = getPatrolOrder(office.kingdomId);
      lines.push(
        `Marshal of ${k?.name ?? office.kingdomId} - garrison ${Tension.garrisonOf(office.kingdomId)}/60, ` +
        (order
          ? `${order.guards} guards on the ${order.target === "home" ? "home roads" : kingdomName(order.target) + " border"}.`
          : "no patrol orders.")
      );
    } else if (office.office === "spymaster") {
      lines.push(
        `Spymaster of ${k?.name ?? office.kingdomId} - ` +
        `${getRumors(office.kingdomId).length} whispers circulate.`
      );
    }
  }
  return lines;
}

// --- supply delivery (the donation chest calls this) ---------------------------

/**
 * A player delivers provisions against the quartermaster's standing order.
 * Real transfers: items leave the player's inventory, the treasury pays the
 * posted price per unit, the war stockpile grows, and the order shrinks.
 * Only subjects of the kingdom may supply its war effort.
 */
function deliverSupplies(player, kingdomId, itemId, qty) {
  const fail = (message) => ({ ok: false, message });
  const order = getSupplyOrder(kingdomId);
  if (!order) return fail("The quartermaster seeks no supplies just now.");
  const spec = SUPPLY_ITEMS[itemId];
  if (!spec) return fail("The quartermaster buys bread, cooked meat and cooked chicken - nothing else.");
  if ((player.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE) ?? null) !== kingdomId) {
    return fail(`You must serve ${kingdomName(kingdomId)} to supply its war effort.`);
  }
  const inventory = player.getInventory?.();
  const have = inventory?.getAmount?.(itemId) ?? 0;
  let count = Math.min(Math.floor(Number(qty)) || 0, have);
  if (count <= 0) return fail(`You carry no ${spec.name.toLowerCase()}.`);
  // Never over-deliver past the order.
  count = Math.min(count, Math.floor(order.units / spec.units));
  if (count <= 0) return fail("The order wants fewer provisions than one more delivery.");
  // The treasury pays only what it holds.
  const treasury = Store.getKingdom(kingdomId)?.treasury ?? 0;
  const affordable = Math.floor(treasury / (spec.units * order.pricePer));
  count = Math.min(count, affordable);
  if (count <= 0) return fail("The coffers cannot pay for this delivery.");
  const units = count * spec.units;
  const payout = units * order.pricePer;
  if (!Store.spendTax(kingdomId, payout)) return fail("The coffers cannot pay for this delivery.");
  inventory.delete(itemId, count);
  inventory.refreshItems?.();
  // NOTE: ItemContainer.add takes an Item object, NOT (id, amount) —
  // the id/amount form is adds(). Using add() here threw, so the supplier
  // lost their goods AND the payout — items and coins both destroyed.
  inventory.adds(COINS_ID, payout);
  const stockpile = Math.floor(flagOf(kingdomId, STOCKPILE_FLAG) ?? 0);
  Store.setFlag(kingdomId, STOCKPILE_FLAG, stockpile + units);
  const remaining = order.units - units;
  if (remaining <= 0) {
    clearSupplyOrder(kingdomId);
    emit("kingdom:supply-delivered", { kingdomId, player, itemId, qty: count, units, payout, filled: true });
    Store.save();
    return {
      ok: true,
      message:
        `You deliver ${count} ${spec.name.toLowerCase()} (${formatCoins(units)} units) for ${formatCoins(payout)}c. ` +
        "The quartermaster's order is FILLED - the stores are fat.",
    };
  }
  Store.setFlag(kingdomId, SUPPLY_ORDER_FLAG, { ...order, units: remaining });
  Store.save();
  emit("kingdom:supply-delivered", { kingdomId, player, itemId, qty: count, units, payout, filled: false });
  return {
    ok: true,
    message:
      `You deliver ${count} ${spec.name.toLowerCase()} (${formatCoins(units)} units) for ${formatCoins(payout)}c. ` +
      `${formatCoins(remaining)} units still wanted.`,
  };
}

// --- wages ledger --------------------------------------------------------------

function onWagesPaid(event) {
  const kingdomId = event?.kingdomId;
  const total = Math.floor(Number(event?.total) ?? 0);
  if (!kingdomId || !(total > 0)) return;
  Store.setFlag(kingdomId, LAST_WAGES_FLAG, total);
  Store.save();
}

// --- attach --------------------------------------------------------------------

function attachOfficeTools(api) {
  pluginApi = api;
  api.onCustomEvent("kingdom:wages-paid", onWagesPaid);
  console.info("[office-tools] seals of office ready - the war table commands the realm");
}

module.exports = attachOfficeTools;
module.exports.getTaxRate = getTaxRate;
module.exports.setTaxRate = setTaxRate;
module.exports.getWarLevy = getWarLevy;
module.exports.setWarLevy = setWarLevy;
module.exports.stockpileTarget = stockpileTarget;
module.exports.setStockpileTarget = setStockpileTarget;
module.exports.getPatrolOrder = getPatrolOrder;
module.exports.setPatrolOrder = setPatrolOrder;
module.exports.clearPatrolOrder = clearPatrolOrder;
module.exports.getSupplyOrder = getSupplyOrder;
module.exports.setSupplyOrder = setSupplyOrder;
module.exports.clearSupplyOrder = clearSupplyOrder;
module.exports.getRumors = getRumors;
module.exports.recordRumor = recordRumor;
module.exports.suppressRumor = suppressRumor;
module.exports.emitUnrest = emitUnrest;
module.exports.getPetitions = getPetitions;
module.exports.tickPetitions = tickPetitions;
module.exports.approvePetition = approvePetition;
module.exports.denyPetition = denyPetition;
module.exports.holdsOffice = holdsOffice;
module.exports.officesHeldBy = officesHeldBy;
module.exports.offerConsoles = offerConsoles;
module.exports.sealsLines = sealsLines;
module.exports.deliverSupplies = deliverSupplies;
module.exports.SUPPLY_ITEMS = SUPPLY_ITEMS;
module.exports.WAGE_PER_GUARD = WAGE_PER_GUARD;
