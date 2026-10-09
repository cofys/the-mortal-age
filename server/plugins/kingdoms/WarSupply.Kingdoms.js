"use strict";

/**
 * WarSupply.Kingdoms — war supply demands & consumption (the war eats).
 *
 * Wars are simulated, but until now they consumed nothing real: sieges
 * were pure coin math and the generic stockpile was an abstract number.
 * This module makes war logistics concrete:
 *
 *   War demands — when a kingdom goes to war (or is besieged), it raises
 *   real supply demands per category: food for the troops, arrows for the
 *   archers, runes for the battle mages, materials for siege engines and
 *   wall repairs. Demands live on the kingdom record under the
 *   "warsupply" flag, keyed by war pair ("a:b").
 *
 *   Consumption — every realm tick, armies at war BURN supplies: food
 *   fastest, then arrows and runes (battle expenditure), then materials.
 *   Stock only grows when real players deliver real items through the
 *   donation chest (OfficeTools.deliverSupplies routes war-category items
 *   here first). Suppliers are paid real treasury coins plus a little
 *   kingdom influence.
 *
 *   Consequences — each demand carries a supply morale (0.65 starving to
 *   1.15 well-fed), a weighted average of category fulfillment. Siege
 *   resolution scales attacker power and defender power by their morale,
 *   so undersupplied armies genuinely fight worse. Citizens hear about
 *   shortages through kingdom:rumor and repeat them in the streets.
 *
 * Wiring:
 *   Simulation.Kingdoms simTick -> ensureDemands + consumeTick (per realm
 *     tick, ~10 min). Polling, not events — demands follow the wars.
 *   OfficeTools.deliverSupplies -> routeDelivery/addStock (players fill).
 *   Siege.Kingdoms tickSiege -> moraleOf (combat effectiveness).
 *   WarTableApi kingdomPayload -> supplyStatus (visible demands).
 *   OfficeDashboardApi quartermasterPayload -> supplyStatus (QM manages).
 *
 * No LLM anywhere in this module; the tick path is pure arithmetic.
 * Requires only KingdomStore — OfficeTools and Simulation require this
 * module, never the reverse (no require cycles).
 */

const Store = require("./KingdomStore");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Supply categories. */
const CATEGORIES = ["food", "arrows", "runes", "materials"];

const CATEGORY_LABELS = {
  food: "Provisions",
  arrows: "Arrows",
  runes: "Runes",
  materials: "Materials",
};

/**
 * What the war effort buys: item id -> { units, name, cat }.
 * Ids verified against data/definitions/item-gameplay.json.
 * Food overlaps OfficeTools.SUPPLY_ITEMS (bread/meat/chicken) on purpose —
 * the same loaf feeds a soldier or a standing order.
 */
const WAR_SUPPLY_ITEMS = {
  // Provisions — troops and civilians eat.
  2309: { units: 2, name: "Bread", cat: "food" },
  2142: { units: 3, name: "Cooked meat", cat: "food" },
  2140: { units: 2, name: "Cooked chicken", cat: "food" },
  // Arrows — archers loose them by the thousand.
  882: { units: 2, name: "Bronze arrow", cat: "arrows" },
  884: { units: 3, name: "Iron arrow", cat: "arrows" },
  886: { units: 5, name: "Steel arrow", cat: "arrows" },
  888: { units: 8, name: "Mithril arrow", cat: "arrows" },
  890: { units: 12, name: "Adamant arrow", cat: "arrows" },
  892: { units: 18, name: "Rune arrow", cat: "arrows" },
  // Runes — battle mages burn through them.
  556: { units: 2, name: "Air rune", cat: "runes" },
  555: { units: 2, name: "Water rune", cat: "runes" },
  557: { units: 2, name: "Earth rune", cat: "runes" },
  554: { units: 2, name: "Fire rune", cat: "runes" },
  562: { units: 6, name: "Chaos rune", cat: "runes" },
  563: { units: 8, name: "Law rune", cat: "runes" },
  560: { units: 10, name: "Death rune", cat: "runes" },
  565: { units: 12, name: "Blood rune", cat: "runes" },
  // Materials — siege engines, palisades, wall repairs.
  1511: { units: 4, name: "Logs", cat: "materials" },
  1521: { units: 6, name: "Oak logs", cat: "materials" },
  2351: { units: 6, name: "Iron bar", cat: "materials" },
  2353: { units: 10, name: "Steel bar", cat: "materials" },
  2359: { units: 16, name: "Mithril bar", cat: "materials" },
};

/** Demand quotas (units) by war role. Attackers need engines; defenders need food. */
const ATTACKER_QUOTA = { food: 300, arrows: 250, runes: 200, materials: 150 };
const DEFENDER_QUOTA = { food: 400, arrows: 150, runes: 120, materials: 250 };
/** A siege multiplies the relevant quotas — engines and repairs devour material. */
const SIEGE_QUOTA_MULT = 1.5;
/** A raid (siege without declared war) raises smaller demands. */
const RAID_QUOTA_MULT = 0.6;
/** What share of quota the mobilization buys: armies march with some supplies. */
const INITIAL_STOCK_PCT = 0.5;

/** Units burned per realm tick (~10 min) while the demand is active. */
const CONSUME_PER_TICK = { food: 4, arrows: 2, runes: 2, materials: 1 };

/** Morale weights: an army marches on its stomach first. */
const MORALE_WEIGHTS = { food: 0.35, arrows: 0.25, runes: 0.2, materials: 0.2 };
/** Morale factor range: 0.65 (starving) to 1.15 (well-fed). */
const MORALE_MIN = 0.65;
const MORALE_RANGE = 0.5;
/** Below this morale the streets hear the troops grumble. */
const MORALE_GRUMBLE_AT = 0.8;

/** Kingdom flag holding the demand map: { [warKey]: demandRecord }. */
const WARSUPPLY_FLAG = "warsupply";

let pluginApi = null;

function emit(name, payload) {
  try {
    pluginApi?.emitCustomEvent(name, payload);
  } catch {
    // The tick runs without a bus; the numbers still land.
  }
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/** Canonical war key: "a:b" with a < b. */
function warKeyFor(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function supplyMapOf(kingdomId, store) {
  const s = store ?? Store;
  const kingdom = s.getKingdom(kingdomId);
  if (!kingdom) return null;
  if (!kingdom.flags || typeof kingdom.flags !== "object") return {};
  const raw = kingdom.flags[WARSUPPLY_FLAG];
  return raw && typeof raw === "object" ? raw : {};
}

function saveSupplyMap(kingdomId, map, store) {
  const s = store ?? Store;
  s.setFlag(kingdomId, WARSUPPLY_FLAG, map);
}

function kingdomName(kingdomId, store) {
  try {
    return (store ?? Store).getKingdom(kingdomId)?.name ?? String(kingdomId);
  } catch {
    return String(kingdomId);
  }
}

function activeSiegesInvolving(kingdomId, store) {
  const s = store ?? Store;
  let sieges = {};
  try {
    sieges = s.load().sieges ?? {};
  } catch {
    return [];
  }
  return Object.values(sieges).filter(
    (sg) =>
      sg &&
      sg.status === "active" &&
      (sg.attackerKingdomId === kingdomId || sg.defenderKingdomId === kingdomId)
  );
}

// ---------------------------------------------------------------------------
// Demand generation
// ---------------------------------------------------------------------------

function quotasFor(role, siegesHere) {
  const base = role === "attacker" ? ATTACKER_QUOTA : DEFENDER_QUOTA;
  const quotas = { ...base };
  for (const sg of siegesHere) {
    const attacking = sg.attackerKingdomId && role === "attacker";
    const defending = sg.defenderKingdomId && role === "defender";
    if (attacking) {
      quotas.materials = Math.floor(quotas.materials * SIEGE_QUOTA_MULT);
      quotas.food = Math.floor(quotas.food * 1.25);
    } else if (defending) {
      quotas.food = Math.floor(quotas.food * SIEGE_QUOTA_MULT);
      quotas.materials = Math.floor(quotas.materials * SIEGE_QUOTA_MULT);
    }
  }
  return quotas;
}

function makeDemand(kingdomId, foeId, role, siegesHere, isRaid, store) {
  const quotas = quotasFor(role, siegesHere);
  if (isRaid) {
    for (const cat of CATEGORIES) quotas[cat] = Math.max(20, Math.floor(quotas[cat] * RAID_QUOTA_MULT));
  }
  const categories = {};
  for (const cat of CATEGORIES) {
    const quota = Math.max(1, quotas[cat]);
    categories[cat] = { quota, stock: Math.floor(quota * INITIAL_STOCK_PCT) };
  }
  return {
    foe: String(foeId),
    role,
    raid: !!isRaid,
    since: Date.now(),
    categories,
    morale: recomputeMoraleValue(categories),
    announcedDry: {},
    announcedGrumble: false,
  };
}

/**
 * Ensure every active war (or active siege-raid) involving the kingdom has
 * a demand record; retire records for wars that ended. Called from the
 * realm tick — polling, so records can never drift from the wars.
 *
 * @returns the demand records now active for this kingdom
 */
function ensureDemands(kingdomId, warsHere, store) {
  const s = store ?? Store;
  if (!kingdomId) return [];
  const map = supplyMapOf(kingdomId, s);
  if (!map) return [];
  const siegesHere = activeSiegesInvolving(kingdomId, s);
  const liveKeys = new Set();
  const created = [];

  for (const war of warsHere ?? []) {
    const foe = war.attackerId === kingdomId ? war.defenderId : war.attackerId;
    if (!foe) continue;
    const key = warKeyFor(kingdomId, foe);
    liveKeys.add(key);
    if (!map[key]) {
      const role = war.attackerId === kingdomId ? "attacker" : "defender";
      map[key] = makeDemand(kingdomId, foe, role, siegesHere, false, s);
      created.push({ key, foe, role });
    }
  }
  // Sieges without a declared war are raids — smaller demands, still real.
  for (const sg of siegesHere) {
    const foe =
      sg.attackerKingdomId === kingdomId ? sg.defenderKingdomId : sg.attackerKingdomId;
    if (!foe) continue;
    const key = warKeyFor(kingdomId, foe);
    if (liveKeys.has(key)) continue; // a declared war already covers it
    liveKeys.add(key);
    if (!map[key]) {
      const role = sg.attackerKingdomId === kingdomId ? "attacker" : "defender";
      map[key] = makeDemand(kingdomId, foe, role, [sg], true, s);
      created.push({ key, foe, role, raid: true });
    }
  }
  // Retire demands for ended wars.
  for (const key of Object.keys(map)) {
    if (!liveKeys.has(key)) delete map[key];
  }
  if (created.length > 0 || Object.keys(map).length >= 0) {
    saveSupplyMap(kingdomId, map, s);
  }
  for (const c of created) {
    const foeName = kingdomName(c.foe, s);
    const myName = kingdomName(kingdomId, s);
    emit("kingdom:rumor", {
      kingdomId,
      text: c.raid
        ? `They say raiders harry ${myName} — the quartermaster calls for grain, shafts and iron.`
        : `They say the war with ${foeName} eats everything — the quartermaster of ${myName} calls for provisions, arrows, runes and timber.`,
    });
  }
  return Object.entries(map).map(([key, rec]) => ({ warKey: key, ...rec }));
}

// ---------------------------------------------------------------------------
// Morale
// ---------------------------------------------------------------------------

function fulfillmentOf(cat, categories) {
  const c = categories[cat];
  if (!c || !(c.quota > 0)) return 1;
  return Math.max(0, Math.min(1, c.stock / c.quota));
}

function recomputeMoraleValue(categories) {
  let avg = 0;
  for (const cat of CATEGORIES) {
    avg += (MORALE_WEIGHTS[cat] ?? 0) * fulfillmentOf(cat, categories);
  }
  return MORALE_MIN + MORALE_RANGE * Math.max(0, Math.min(1, avg));
}

/** Supply morale factor for a kingdom's war: 0.65 (starving) → 1.15 (well-fed). 1 when no demand. */
function moraleOf(kingdomId, warKey, store) {
  const s = store ?? Store;
  const rec = supplyMapOf(kingdomId, s)?.[warKey];
  if (!rec) return 1;
  return recomputeMoraleValue(rec.categories);
}

function moraleLabel(factor) {
  if (factor >= 1.05) return "Well-supplied";
  if (factor >= 0.9) return "Adequate";
  if (factor >= 0.78) return "Strained";
  return "Starving";
}

// ---------------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------------

const SHORTAGE_RUMORS = {
  food: [
    "They say the soldiers grumble on empty bellies — the granaries stand low.",
    "Word is the camp cooks water the stew twice now. The men notice.",
  ],
  arrows: [
    "They say the archers count their shafts like misers — the fletchers can't keep up.",
    "Word is the bowmen are ordered to hold their fire. The quivers run thin.",
  ],
  runes: [
    "They say the battle mages ration their castings — the rune pouches run light.",
    "Word is the war-casters mutter about empty satchels and uncast spells.",
  ],
  materials: [
    "They say the siege engines creak unrepaired — no timber, no iron for the works.",
    "Word is the engineers patch walls with green wood. It won't hold.",
  ],
};

function pickLine(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * Burn supplies for every active demand. When a category runs dry, the
 * streets hear about it (kingdom:rumor); when morale sags, the troops
 * grumble audibly. Pure arithmetic — no LLM in the tick path.
 */
function consumeTick(kingdomId, store) {
  const s = store ?? Store;
  const map = supplyMapOf(kingdomId, s);
  if (!map) return [];
  const myName = kingdomName(kingdomId, s);
  const events = [];
  let dirty = false;
  for (const [key, rec] of Object.entries(map)) {
    if (!rec || !rec.categories) continue;
    for (const cat of CATEGORIES) {
      const c = rec.categories[cat];
      if (!c) continue;
      const before = c.stock;
      c.stock = Math.max(0, c.stock - (CONSUME_PER_TICK[cat] ?? 0));
      if (c.stock !== before) dirty = true;
      if (c.stock <= 0 && before > 0 && !rec.announcedDry?.[cat]) {
        rec.announcedDry = { ...(rec.announcedDry ?? {}), [cat]: true };
        dirty = true;
        const text = pickLine(SHORTAGE_RUMORS[cat]).replace("The soldiers", `The soldiers of ${myName}`);
        emit("kingdom:rumor", { kingdomId, text });
        events.push({ warKey: key, kind: "dry", cat });
      } else if (c.stock > 0 && rec.announcedDry?.[cat]) {
        // Resupplied: the street can worry again later.
        const dry = { ...(rec.announcedDry ?? {}) };
        delete dry[cat];
        rec.announcedDry = dry;
        dirty = true;
      }
    }
    const morale = recomputeMoraleValue(rec.categories);
    if (morale !== rec.morale) {
      rec.morale = morale;
      dirty = true;
    }
    if (morale < MORALE_GRUMBLE_AT && !rec.announcedGrumble) {
      rec.announcedGrumble = true;
      dirty = true;
      emit("kingdom:rumor", {
        kingdomId,
        text: `They say the ${myName} host marches hungry — deserters whisper the war chest is fat but the wagons are empty.`,
      });
      events.push({ warKey: key, kind: "grumble", morale });
    } else if (morale >= MORALE_GRUMBLE_AT + 0.05 && rec.announcedGrumble) {
      rec.announcedGrumble = false;
      dirty = true;
    }
  }
  if (dirty) {
    saveSupplyMap(kingdomId, map, s);
    try {
      s.save();
    } catch {
      // The realm tick saves anyway.
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Player deliveries
// ---------------------------------------------------------------------------

/**
 * Route a delivery: if the kingdom has an active demand whose category
 * still wants units, the war effort takes it first. Returns the war key
 * and remaining units wanted, or null when no demand applies.
 */
function routeDelivery(kingdomId, cat, store) {
  const s = store ?? Store;
  const map = supplyMapOf(kingdomId, s);
  if (!map) return null;
  let best = null;
  for (const [key, rec] of Object.entries(map)) {
    if (!rec || !rec.categories?.[cat]) continue;
    const c = rec.categories[cat];
    const remaining = Math.max(0, c.quota - c.stock);
    if (remaining <= 0) continue;
    if (!best || remaining > best.remaining) {
      best = { warKey: key, remaining, foe: rec.foe, foeName: kingdomName(rec.foe, s) };
    }
  }
  return best;
}

/**
 * Credit delivered units to a demand's category stock (capped at quota).
 * @returns units actually credited
 */
function addStock(kingdomId, warKey, cat, units, store) {
  const s = store ?? Store;
  const map = supplyMapOf(kingdomId, s);
  const rec = map?.[warKey];
  const c = rec?.categories?.[cat];
  if (!c) return 0;
  const room = Math.max(0, c.quota - c.stock);
  const credited = Math.min(room, Math.max(0, Math.floor(units)));
  if (credited > 0) {
    c.stock += credited;
    rec.morale = recomputeMoraleValue(rec.categories);
    saveSupplyMap(kingdomId, map, s);
  }
  return credited;
}

/** Read model for the war table, the office dashboard, and the chest. */
function supplyStatus(kingdomId, store) {
  const s = store ?? Store;
  const map = supplyMapOf(kingdomId, s);
  if (!map) return [];
  return Object.entries(map).map(([warKey, rec]) => {
    const morale = recomputeMoraleValue(rec.categories);
    return {
      warKey,
      foe: rec.foe,
      foeName: kingdomName(rec.foe, s),
      role: rec.role,
      raid: !!rec.raid,
      morale: Math.round(morale * 100) / 100,
      moraleLabel: moraleLabel(morale),
      categories: CATEGORIES.map((cat) => {
        const c = rec.categories[cat] ?? { quota: 0, stock: 0 };
        const pct = c.quota > 0 ? Math.round((100 * c.stock) / c.quota) : 100;
        return {
          cat,
          label: CATEGORY_LABELS[cat],
          quota: c.quota,
          stock: c.stock,
          pct: Math.max(0, Math.min(100, pct)),
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

function attachWarSupply(api) {
  pluginApi = api;
  console.info("[war-supply] war demands & consumption armed");
}

module.exports = attachWarSupply;
module.exports.attachWarSupply = attachWarSupply;
module.exports.CATEGORIES = CATEGORIES;
module.exports.CATEGORY_LABELS = CATEGORY_LABELS;
module.exports.WAR_SUPPLY_ITEMS = WAR_SUPPLY_ITEMS;
module.exports.ATTACKER_QUOTA = ATTACKER_QUOTA;
module.exports.DEFENDER_QUOTA = DEFENDER_QUOTA;
module.exports.CONSUME_PER_TICK = CONSUME_PER_TICK;
module.exports.MORALE_MIN = MORALE_MIN;
module.exports.MORALE_RANGE = MORALE_RANGE;
module.exports.WARSUPPLY_FLAG = WARSUPPLY_FLAG;
module.exports.warKeyFor = warKeyFor;
module.exports.ensureDemands = ensureDemands;
module.exports.consumeTick = consumeTick;
module.exports.moraleOf = moraleOf;
module.exports.moraleLabel = moraleLabel;
module.exports.routeDelivery = routeDelivery;
module.exports.addStock = addStock;
module.exports.supplyStatus = supplyStatus;
