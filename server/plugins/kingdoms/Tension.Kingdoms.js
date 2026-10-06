"use strict";

/**
 * Tension.Kingdoms — the powder keg. Wars never started on their own; now
 * they do.
 *
 * Every pair of great powers carries a tension score (0-100, persisted in
 * KingdomStore). Each tension tick (~2 minutes) the scores breathe:
 *
 *   decay        -1 in peace; tension never sits still
 *   incidents    border clashes, random (chance scales with current tension)
 *   skirmishes   at 70+: patrols clash, guards die, both sides escalate
 *   rumors       at 55/75/90 the streets hear about it (kingdom:rumor)
 *   war          at 100 the tension snaps: kingdom:war-declared
 *
 * Wars end on their own too: every war gets a resolveAt timestamp (6-18h),
 * and levies bleed while the war grinds (garrison attrition). A side whose
 * garrison breaks loses outright. Peace drains both treasuries, pins
 * tension at 15, and buys a 72h armistice during which tension cannot
 * re-trigger.
 *
 * The Morytania powder keg is scripted pressure, not a forced outcome:
 * Lowerniel Drakan's tithe demands and Myreque sabotage keep Morytania's
 * borders hot from day one (seeded in the 70s), but the spark is still
 * chance. It might explode. It might not.
 *
 * Player agency: cross-kingdom PK nudges tension (+5, +8 for slaying a
 * foreign guardsman) and earns the killer influence with their own kingdom
 * (+15 in peace, +25 for war service).
 *
 * Out (custom events, AGENTS.md: plugins talk through events):
 *   kingdom:war-declared { attackerId, defenderId, declaredBy: "tension",
 *                          reason, resolveAt }
 *   kingdom:war-ended    { attackerId, defenderId, outcome }  (existing shape)
 *   kingdom:skirmish     { attackerId, defenderId, location,
 *                          casualtiesA, casualtiesB }
 *   kingdom:rumor        { kingdomId, text }                   (existing shape)
 * In (custom events):
 *   kingdom:war-demand   the quartermaster's empty stores make the court
 *                        blame its hottest rival (scapegoating)
 *
 * Numbers live in DESIGN.md. Logging uses console.info/warn — api.log?.()
 * never reaches the log file.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const Store = require("./KingdomStore");
const Influence = require("./Influence.Kingdoms");
const Membership = require("./Membership.Kingdoms");
const { ATTR_CITIZEN_ROLE, ROLE_GUARD } = require("../citizens/constants");

// ~2 minutes at 600ms/tick. Faster than the realm tick: the keg should feel
// alive, not glacial.
const TENSION_TICK_TICKS = 200;

const TENSION_DEFAULT = 20;
const WAR_AT = 100;
const PEACE_DECAY = 1;

// A border incident gets likelier the hotter the border already is.
const INCIDENT_BASE_CHANCE = 0.02;
const INCIDENT_TENSION_SCALE = 0.15;
const INCIDENT_MIN = 6;
const INCIDENT_MAX = 14;
// Only some incidents are loud enough for the streets to hear.
const INCIDENT_RUMOR_CHANCE = 0.3;

// Skirmishes: patrols clash below the threshold of war.
const SKIRMISH_TENSION = 70;
const SKIRMISH_CHANCE = 0.2;
const SKIRMISH_TENSION_MIN = 6;
const SKIRMISH_TENSION_MAX = 12;

// The streets hear the keg heating: thresholds, with hysteresis so a
// hovering score doesn't spam.
const RUMOR_TIERS = [55, 75, 90];

// After a war: tension is pinned low and cannot climb back fast for a while.
const ARMISTICE_MS = 72 * 60 * 60 * 1000;
const ARMISTICE_TENSION_CAP = 40;
const ARMISTICE_DECAY = 2;
const TENSION_AFTER_WAR = 15;

// Garrisons: the levies wars are fought with. Skirmishes and war attrition
// bleed them; peace rebuilds them. A side at zero levies loses the war.
const GARRISON_FLAG = "war:garrison";
const GARRISON_MAX = 60;
const GARRISON_SEED = 60;
const GARRISON_PEACE_RECOVERY = 1;
const GARRISON_AFTER_WAR = 30;
const WAR_ATTRITION_CHANCE = 0.2;

// Wars burn 6-18 hours, then the treasuries give out.
const WAR_MIN_MS = 6 * 60 * 60 * 1000;
const WAR_MAX_MS = 18 * 60 * 60 * 1000;
const WAR_TREASURY_DRAIN = 0.15;

// Scapegoating: an empty war chest makes the court blame its hottest rival.
const SCAPEGOAT_TENSION = 4;
const SCAPEGOAT_MIN_TENSION = 30;
const SCAPEGOAT_COOLDOWN_MS = 60 * 60 * 1000;

// Player blood moves the needle.
const PK_TENSION = 5;
const GUARDKILL_TENSION = 8;
const PK_INFLUENCE = 15;
const WAR_SERVICE_INFLUENCE = 25;

// The Morytania powder keg: scripted pressure per tension tick.
const MYREQUE_SABOTAGE_CHANCE = 0.06;
const DRAKAN_TITHE_CHANCE = 0.05;
const STORY_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Seed tensions: Morytania's borders start in the 70s — live from day one.
const SEED_TENSION = [
  ["morytania", "kandarin", 74],
  ["morytania", "asgarnia", 72],
  ["morytania", "misthalin", 68],
  ["morytania", "keldagrim", 30],
  ["asgarnia", "misthalin", 35],
  ["asgarnia", "kandarin", 25],
  ["asgarnia", "keldagrim", 15],
  ["misthalin", "kandarin", 20],
  ["misthalin", "keldagrim", 12],
  ["kandarin", "keldagrim", 15],
];

let pluginApi = null;
const rumorTierAt = new Map(); // pairKey -> highest tier announced
const lastNoticeAt = new Map(); // `${kingdomId}:${kind}` -> timestamp
const lastScapegoatAt = new Map(); // kingdomId -> timestamp

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join(":");
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

function pairsOf(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
  }
  return out;
}

function nameOf(kingdomId) {
  return Store.getKingdom(kingdomId)?.name ?? kingdomId;
}

function getTension(a, b) {
  const stored = Store.getRawTension(a, b);
  return stored === null ? TENSION_DEFAULT : stored;
}

function setTension(a, b, score) {
  Store.setRawTension(a, b, score);
}

function garrisonOf(kingdomId) {
  const raw = Store.getKingdom(kingdomId)?.flags?.[GARRISON_FLAG];
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : GARRISON_SEED;
}

function setGarrison(kingdomId, value) {
  Store.setFlag(
    kingdomId,
    GARRISON_FLAG,
    Math.max(0, Math.min(GARRISON_MAX, Math.floor(value)))
  );
}

function warsBetween(a, b, wars) {
  return wars.filter(
    (w) =>
      (w.attackerId === a && w.defenderId === b) ||
      (w.attackerId === b && w.defenderId === a)
  );
}

function atWar(a, b, wars) {
  return warsBetween(a, b, wars).length > 0;
}

function warsInvolving(kingdomId, wars) {
  return wars.filter((w) => w.attackerId === kingdomId || w.defenderId === kingdomId);
}

/** A war ended between this pair recently: tension is capped and bleeds fast. */
function inArmistice(a, b) {
  const now = Date.now();
  return Store.getEndedWars().some(
    (w) =>
      warsBetween(a, b, [w]).length > 0 &&
      Number.isFinite(w.endedAt) &&
      now - w.endedAt < ARMISTICE_MS
  );
}

function noticeDue(kingdomId, kind, cooldownMs = STORY_COOLDOWN_MS) {
  const key = `${kingdomId}:${kind}`;
  const last = lastNoticeAt.get(key) ?? 0;
  if (Date.now() - last < cooldownMs) return false;
  lastNoticeAt.set(key, Date.now());
  return true;
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

function borderName(a, b) {
  const key = pairKey(a, b);
  return (
    {
      "asgarnia:kandarin": "the Ardougne road",
      "asgarnia:keldagrim": "the mountain passes",
      "asgarnia:misthalin": "the Wilderness ditch",
      "asgarnia:morytania": "Paterdomus and the holy river",
      "kandarin:keldagrim": "the western mines",
      "kandarin:misthalin": "the White Wolf passes",
      "kandarin:morytania": "the Mort Myre marches",
      "keldagrim:misthalin": "the northern roads",
      "keldagrim:morytania": "the Meiyerditch underways",
      "misthalin:morytania": "the River Salve",
    }[key] ?? "the border marches"
  );
}

const TIER_RUMORS = {
  55: (a, b) => `They say the court of ${a} speaks of ${b} with narrowed eyes.`,
  75: (a, b) => `Word is the ${a} levies drill at dawn — and ${b} answers in kind.`,
  90: (a, b) => `They say war with ${b} is a matter of days now. The ${a} court denies everything.`,
};

/** Threshold crossings: the streets hear the keg heating. */
function rumorTiers(a, b, tension) {
  const key = pairKey(a, b);
  const tier = tension >= 90 ? 90 : tension >= 75 ? 75 : tension >= 55 ? 55 : 0;
  const last = rumorTierAt.get(key) ?? 0;
  if (tier > last) {
    rumorTierAt.set(key, tier);
    const aName = nameOf(a);
    const bName = nameOf(b);
    pluginApi.emitCustomEvent("kingdom:rumor", { kingdomId: a, text: TIER_RUMORS[tier](aName, bName) });
    pluginApi.emitCustomEvent("kingdom:rumor", { kingdomId: b, text: TIER_RUMORS[tier](bName, aName) });
    if (tier >= 90) {
      announceToRealm(
        `[Realm] War fever grips ${aName} and ${bName}. Every tavern argues; every road is watched.`
      );
    }
  } else if (tier < last) {
    rumorTierAt.set(key, tier);
  }
}

const WAR_REASONS = (aName, bName) => [
  `The ${bName} envoy was turned away at the border — with steel.`,
  `${aName} raiders burned a ${bName} farmstead. ${aName} disavows them, and no one believes it.`,
  `The ${aName} court claims ${bName} poisons the wells. The ${bName} court claims ${aName} lies.`,
  `A ${bName} patrol crossed the marches "by mistake". The ${aName} dead disagree.`,
  `${aName} merchants were seized in ${bName} territory. The ransom note was a declaration.`,
];

/** Tension snapped: the war is real. */
function declareWarByTension(a, b) {
  if (!Store.getKingdom(a) || !Store.getKingdom(b)) return;
  // Lowerniel's Morytania is the aggressor in its own feuds; otherwise the
  // hotter-headed side strikes first.
  const attacker = a === "morytania" ? a : b === "morytania" ? b : Math.random() < 0.5 ? a : b;
  const defender = attacker === a ? b : a;
  const aName = nameOf(attacker);
  const bName = nameOf(defender);
  const reason = pick(WAR_REASONS(aName, bName));
  const resolveAt = Date.now() + WAR_MIN_MS + Math.random() * (WAR_MAX_MS - WAR_MIN_MS);
  pluginApi.emitCustomEvent("kingdom:war-declared", {
    attackerId: attacker,
    defenderId: defender,
    declaredBy: "tension",
    reason,
    resolveAt,
  });
  announceToRealm(`[Realm] WAR! ${aName} has declared war on ${bName}. ${reason}`);
  console.info("[tension] war declared", { attacker, defender, reason });
}

/**
 * Add tension between two powers. Respects war (pinned) and armistice
 * (capped); snapping at 100 declares the war. Persists.
 */
function addTension(a, b, delta, wars = null) {
  if (a === b || !(delta > 0)) return getTension(a, b);
  const live = wars ?? Store.getActiveWars();
  if (atWar(a, b, live)) return WAR_AT;
  let t = getTension(a, b);
  t = inArmistice(a, b) ? Math.min(ARMISTICE_TENSION_CAP, t + delta * 0.25) : Math.min(WAR_AT, t + delta);
  setTension(a, b, t);
  Store.save();
  rumorTiers(a, b, t);
  if (t >= WAR_AT) declareWarByTension(a, b);
  return t;
}

/** Border skirmish: patrols clash, guards die, both sides escalate. */
function doSkirmish(a, b) {
  const location = borderName(a, b);
  const aName = nameOf(a);
  const bName = nameOf(b);
  const casA = 1 + Math.floor(Math.random() * 4);
  const casB = 1 + Math.floor(Math.random() * 4);
  // Skirmishes bleed levies but cannot destroy a garrison on their own.
  setGarrison(a, Math.max(1, garrisonOf(a) - casA));
  setGarrison(b, Math.max(1, garrisonOf(b) - casB));
  pluginApi.emitCustomEvent("kingdom:skirmish", {
    attackerId: a,
    defenderId: b,
    location,
    casualtiesA: casA,
    casualtiesB: casB,
  });
  announceToRealm(
    `[Realm] Blood on ${location}: ${aName} and ${bName} patrols clashed. ` +
      `${casA + casB} guards dead. The marches hold their breath.`
  );
  console.info("[tension] skirmish", { a, b, location, casA, casB });
  return SKIRMISH_TENSION_MIN + Math.floor(Math.random() * (SKIRMISH_TENSION_MAX - SKIRMISH_TENSION_MIN + 1));
}

function emitBorderRumor(a, b) {
  const aName = nameOf(a);
  const bName = nameOf(b);
  const text = pick([
    `They say ${aName} riders harried a ${bName} patrol on the marches.`,
    `Word is ${bName} levies seized an ${aName} supply wagon — "contraband".`,
    `A burned watchtower on the ${aName} side. ${bName} torches, they whisper.`,
    `They say the border villages pay protection to both crowns now.`,
  ]);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: Math.random() < 0.5 ? a : b,
    text,
  });
}

function pairTick(a, b, wars) {
  if (atWar(a, b, wars)) return; // war, not tension
  let t = getTension(a, b);
  if (inArmistice(a, b)) {
    setTension(a, b, Math.min(ARMISTICE_TENSION_CAP, t - ARMISTICE_DECAY));
    return;
  }
  t = Math.max(0, t - PEACE_DECAY);
  // Border incident: likelier the hotter the border already is.
  if (Math.random() < INCIDENT_BASE_CHANCE + INCIDENT_TENSION_SCALE * (t / 100)) {
    t = Math.min(WAR_AT, t + INCIDENT_MIN + Math.floor(Math.random() * (INCIDENT_MAX - INCIDENT_MIN + 1)));
    if (Math.random() < INCIDENT_RUMOR_CHANCE) emitBorderRumor(a, b);
  }
  // Boiling point: patrols clash below the threshold of war.
  if (t >= SKIRMISH_TENSION && Math.random() < SKIRMISH_CHANCE) {
    t = Math.min(WAR_AT, t + doSkirmish(a, b));
  }
  setTension(a, b, t);
  rumorTiers(a, b, t);
  if (t >= WAR_AT) declareWarByTension(a, b);
}

/** Strength for peace terms: levies plus the weight of the treasury. */
function warStrength(kingdomId) {
  const treasury = Store.getKingdom(kingdomId)?.treasury ?? 0;
  return garrisonOf(kingdomId) + treasury / 10000;
}

function drainTreasury(kingdomId) {
  const treasury = Store.getKingdom(kingdomId)?.treasury ?? 0;
  const loss = Math.floor(treasury * WAR_TREASURY_DRAIN);
  if (loss > 0) Store.spendTax(kingdomId, loss);
  return loss;
}

/** A war closes: peace terms, drained treasuries, and a rebuilding window. */
function endWarWithTerms(a, b, brokenLoser) {
  const aName = nameOf(a);
  const bName = nameOf(b);
  const sA = warStrength(a);
  const sB = warStrength(b);
  let outcome;
  if (brokenLoser) {
    const winner = brokenLoser === a ? b : a;
    outcome = `${nameOf(brokenLoser)}'s levies break in the field — ${nameOf(winner)} victorious`;
  } else if (Math.abs(sA - sB) < Math.max(sA, sB) * 0.1) {
    outcome = "white peace — the crowns count their dead and call it even";
  } else {
    outcome = `${sA >= sB ? aName : bName} victorious — the peace is dictated, not negotiated`;
  }
  const lostA = drainTreasury(a);
  const lostB = drainTreasury(b);
  setTension(a, b, TENSION_AFTER_WAR);
  setGarrison(a, GARRISON_AFTER_WAR);
  setGarrison(b, GARRISON_AFTER_WAR);
  pluginApi.emitCustomEvent("kingdom:war-ended", {
    attackerId: a,
    defenderId: b,
    outcome,
  });
  announceToRealm(
    `[Realm] Peace between ${aName} and ${bName}: ${outcome}. ` +
      `Both treasuries bled ${lostA + lostB} coins into the mud. The rebuilding begins.`
  );
  console.info("[tension] war ended", { a, b, outcome, lostA, lostB });
}

/** Wars burn out (resolveAt) or collapse (a side's levies break). */
function checkWarResolution(war) {
  const a = war.attackerId;
  const b = war.defenderId;
  const timeUp = Number.isFinite(war.resolveAt) && Date.now() >= war.resolveAt;
  const gA = garrisonOf(a);
  const gB = garrisonOf(b);
  if (timeUp || gA <= 0 || gB <= 0) {
    endWarWithTerms(a, b, gA <= 0 ? a : gB <= 0 ? b : null);
    return;
  }
  // Attrition: the war grinds the levies down while it lasts.
  if (Math.random() < WAR_ATTRITION_CHANCE) setGarrison(a, gA - 1);
  if (Math.random() < WAR_ATTRITION_CHANCE) setGarrison(b, gB - 1);
}

const MYREQUE_SABOTAGE_LINES = (targetName) => [
  `They say Myreque saboteurs burned a ${targetName} supply caravan by the Salve.`,
  `Word is the Myreque cut the ${targetName} tithe wagons' axles in the night.`,
  `A burned wagon in ${targetName} colors, by the river. The Myreque's work, they whisper.`,
  `They say the Myreque freed a ${targetName} blood-tax coffle and vanished into the Myre.`,
];

/**
 * The Morytania powder keg: scripted pressure, never a forced outcome.
 * Myreque sabotage and Drakan's tithe demands keep the borders hot; only
 * the tension score itself can declare the war.
 */
function storyBeats() {
  if (!Store.getKingdom("morytania")) return;
  const neighbors = kingdomIds().filter((id) => id !== "morytania");
  if (neighbors.length === 0) return;
  const wars = Store.getActiveWars();
  if (Math.random() < MYREQUE_SABOTAGE_CHANCE) {
    const target = pick(neighbors);
    addTension("morytania", target, 4 + Math.floor(Math.random() * 5), wars);
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: "morytania",
      text: pick(MYREQUE_SABOTAGE_LINES(nameOf(target))),
    });
    if (noticeDue("morytania", "myreque")) {
      announceToRealm(
        `[Realm] Myreque saboteurs struck near the Salve — ${nameOf(target)} counts its burned wagons. ` +
          `Lowerniel will not let this stand.`
      );
    }
  }
  if (Math.random() < DRAKAN_TITHE_CHANCE) {
    const target = pick(neighbors);
    addTension("morytania", target, 5 + Math.floor(Math.random() * 5), wars);
    if (noticeDue("morytania", "tithe")) {
      announceToRealm(
        `[Realm] Lowerniel Drakan demands the blood tithe of ${nameOf(target)}: ` +
          `"Pay in subjects, or pay in war."`
      );
    }
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: target,
      text: `They say Drakan's tithe-men were seen counting heads in the border villages.`,
    });
  }
}

function tensionTick() {
  let wars;
  try {
    wars = Store.getActiveWars();
  } catch {
    return;
  }
  try {
    for (const war of wars) checkWarResolution(war);
    const liveWars = Store.getActiveWars();
    for (const [a, b] of pairsOf(kingdomIds())) pairTick(a, b, liveWars);
    storyBeats();
    // Peace rebuilds levies.
    for (const id of kingdomIds()) {
      if (warsInvolving(id, liveWars).length === 0) {
        const g = garrisonOf(id);
        if (g < GARRISON_MAX) setGarrison(id, g + GARRISON_PEACE_RECOVERY);
      }
    }
  } catch (error) {
    console.warn("[tension] tick failed", error?.message ?? error);
  }
  Store.save();
}

/** Seed the powder keg: Morytania's borders start hot. Idempotent. */
function seedTension() {
  const ids = kingdomIds();
  if (ids.length === 0) return;
  for (const [a, b, score] of SEED_TENSION) {
    if (Store.getKingdom(a) && Store.getKingdom(b) && Store.getRawTension(a, b) === null) {
      Store.setRawTension(a, b, score);
    }
  }
  for (const [a, b] of pairsOf(ids)) {
    if (Store.getRawTension(a, b) === null) Store.setRawTension(a, b, TENSION_DEFAULT);
  }
  for (const id of ids) {
    if (Store.getKingdom(id)?.flags?.[GARRISON_FLAG] === undefined) {
      Store.setFlag(id, GARRISON_FLAG, GARRISON_SEED);
    }
  }
  Store.save();
  console.info("[tension] seeded", { pairs: pairsOf(ids).length });
}

/**
 * kingdom:war-demand — an empty war chest makes the court blame its
 * hottest rival. Throttled: the court can only scapegoat so often.
 */
function onWarDemand(event) {
  const kingdomId = event?.kingdomId;
  if (!kingdomId || !Store.getKingdom(kingdomId)) return;
  const now = Date.now();
  if (now - (lastScapegoatAt.get(kingdomId) ?? 0) < SCAPEGOAT_COOLDOWN_MS) return;
  const wars = Store.getActiveWars();
  let best = null;
  let bestT = SCAPEGOAT_MIN_TENSION;
  for (const id of kingdomIds()) {
    if (id === kingdomId || atWar(kingdomId, id, wars)) continue;
    const t = getTension(kingdomId, id);
    if (t > bestT) {
      bestT = t;
      best = id;
    }
  }
  if (!best) return;
  lastScapegoatAt.set(kingdomId, now);
  addTension(kingdomId, best, SCAPEGOAT_TENSION, wars);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId,
    text: `They say the court blames ${nameOf(best)} for the empty stores.`,
  });
}

function kingdomOf(mobile) {
  const id = mobile?.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE);
  return typeof id === "string" && Store.getKingdom(id) ? id : null;
}

function isRealPlayer(mobile) {
  return mobile?.isPlayer?.() === true && mobile?.isPlayerBot?.() !== true;
}

function killerName(mobile) {
  try {
    return mobile?.getUsername?.() ?? "a stranger";
  } catch {
    return "a stranger";
  }
}

/**
 * Player blood moves the needle. Cross-kingdom PK raises tension between
 * the killer's and the victim's kingdoms; the killer earns influence with
 * their own court — more when the kingdoms are openly at war.
 */
function onPlayerDeath({ player, killer }) {
  try {
    const killerKingdom = kingdomOf(killer);
    const victimKingdom = kingdomOf(player);
    if (!killerKingdom || !victimKingdom || killerKingdom === victimKingdom) return;
    if (isRealPlayer(killer) && !isRealPlayer(player)) {
      // A player cut down a foreign guardsman: border killing.
      if (player?.isPlayerBot?.() === true && player?.getAttribute?.(ATTR_CITIZEN_ROLE) === ROLE_GUARD) {
        addTension(killerKingdom, victimKingdom, GUARDKILL_TENSION);
        Influence.addInfluence(killer, killerKingdom, PK_INFLUENCE);
        if (noticeDue("pk", "guardkill", 30 * 60 * 1000)) {
          announceToRealm(
            `[Realm] A ${nameOf(victimKingdom)} guardsman was cut down by ${killerName(killer)} ` +
              `of ${nameOf(killerKingdom)}. The border holds its breath.`
          );
        }
      }
      return;
    }
    if (!isRealPlayer(player) || !isRealPlayer(killer)) return;
    addTension(killerKingdom, victimKingdom, PK_TENSION);
    const wartime = atWar(killerKingdom, victimKingdom, Store.getActiveWars());
    const gained = Influence.addInfluence(
      killer,
      killerKingdom,
      wartime ? WAR_SERVICE_INFLUENCE : PK_INFLUENCE
    );
    if (gained > 0) {
      killer.sendMessage?.(
        `[War] +${wartime ? WAR_SERVICE_INFLUENCE : PK_INFLUENCE} influence with ${nameOf(killerKingdom)} ` +
          `for striking at ${nameOf(victimKingdom)}${wartime ? " in wartime" : ""}.`
      );
    }
  } catch (error) {
    console.warn("[tension] death hook failed", error?.message ?? error);
  }
}

/** The hottest border a kingdom has — for war-price merchants and ::war. */
function hottestTensionFor(kingdomId) {
  let best = 0;
  for (const id of kingdomIds()) {
    if (id === kingdomId) continue;
    best = Math.max(best, getTension(kingdomId, id));
  }
  return best;
}

/** Top-N hottest pairs, for ::war. */
function hottestPairs(n) {
  const map = Store.getTensionMap();
  return Object.entries(map)
    .map(([key, tension]) => {
      const [a, b] = key.split(":");
      return { a, b, aName: nameOf(a), bName: nameOf(b), tension };
    })
    .sort((x, y) => y.tension - x.tension)
    .slice(0, n);
}

function startTensionTask(api) {
  class TensionTask extends Task {
    execute() {
      try {
        tensionTick();
      } catch (error) {
        console.warn("[tension] tick failed", error?.message ?? error);
      }
    }
  }
  api.getTaskManager()?.submit(new TensionTask(TENSION_TICK_TICKS));
  console.info("[tension] powder keg armed", { tickTicks: TENSION_TICK_TICKS });
}

function attachTension(api) {
  pluginApi = api;
  api.onServerStartup(seedTension);
  api.onCustomEvent("kingdom:war-demand", onWarDemand);
  api.onPlayerDeath(onPlayerDeath);
  startTensionTask(api);
}

module.exports = attachTension;
module.exports.attachTension = attachTension;
module.exports.tensionTick = tensionTick;
module.exports.seedTension = seedTension;
module.exports.getTension = getTension;
module.exports.addTension = addTension;
module.exports.hottestTensionFor = hottestTensionFor;
module.exports.hottestPairs = hottestPairs;
module.exports.garrisonOf = garrisonOf;
module.exports.WAR_AT = WAR_AT;
module.exports.TENSION_TICK_TICKS = TENSION_TICK_TICKS;
module.exports.ARMISTICE_MS = ARMISTICE_MS;
