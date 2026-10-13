"use strict";

/**
 * CitizenPrayer — bot prayer usage for citizens, the RuneScape way.
 *
 * Gap #1 from the capability audit: citizens fought with prayers OFF, the
 * most visible combat tell in the game. This module is the shared prayer
 * brain for every combat action (CitizenSlayer, CitizenPker, CitizenMilitia,
 * CitizenBossRuns) plus the sustainment hinge (altar recharge, bone
 * burying, potion provisioning).
 *
 * Engine API (stable public surface of PrayerHandler — no subsystem
 * construction touched; QuickPrayers is UI orb state and bots activate
 * directly, which is the same code path the orb's toggle ends in):
 *   - PrayerHandler.activatePrayerPrayerId(bot, id) — full requirement
 *     checks inside (prayer points > 0, prayer level, defence levels for
 *     chivalry/piety/rigour/augury, red-skull protect-item block). Safe to
 *     call speculatively: a bot that can't use a prayer just gets the
 *     engine's own refusal.
 *   - PrayerHandler.deactivatePrayer(bot, id) / deactivatePrayers(bot)
 *   - PrayerHandler.getProtectingPrayer(combatType)
 *   - PrayerHandler.PROTECT_FROM_MELEE/MISSILES/MAGIC, PROTECT_ITEM,
 *     PIETY, RIGOUR, AUGURY (+ the lower-tier stat prayers)
 *   - Prayer points ARE the Prayer skill's current level; drain runs in
 *     PrayerHandler.processDrain and auto-deactivates everything at 0.
 *   - Threat style comes from CombatFactory.getMethod(threat).type()
 *     (NPC attack_type for monsters, weapon/spell resolution for players).
 *
 * Combat behavior (maintainCombatPrayer, called per tick by combat actions):
 *   - Overheads by threat: protect from the attacker's style when the
 *     threat is real (personality-gated combat-level floor — a level-3
 *     goblin gets no prayers, a hellhound gets protect + piety).
 *   - Protect Item when skulled (PKers skull via CombatFactory.handleSkull)
 *     or carrying real wealth.
 *   - Piety/Rigour/Augury (by the bot's own attack style) for DPS when the
 *     fight is worth the drain — never on trivial fights.
 *   - Points preserved: DPS drops first when points run low; overheads are
 *     the last thing to go.
 *
 * Sustainment:
 *   - drinkPrayerPotion: real dose swap + 7 + 25% (27% with holy wrench)
 *     restore, mirroring Potions.plugin's applyPrayerRestore. Prayer
 *     potions and super restores both count.
 *   - rechargeAtAltar: nearest name-verified Altar/Shrine via
 *     world.objectSearch, walk there, recharge exactly like the Altars
 *     plugin's handlePrayerAltar.
 *   - buryBones: one bone per call with a human-paced cooldown, real XP
 *     via SkillManager.addExperiences, mirroring the Prayer plugin.
 *   - offerBonesAtAltar: one bone per call at the nearest name-verified
 *     town altar, real XP at Prayer.plugin's 2.5x/3.5x offering
 *     multipliers — how players actually train Prayer.
 *   - ensureSupplies: withdraws prayer potions from the bank (shared Bank
 *     action delegate) before a fight — only when the bank actually has
 *     them, so it never stalls.
 *
 * Personality variance: not every citizen prays optimally. The devout pray
 * early and often; the greedy won't spend potions; the clumsy react late;
 * the proud keep DPS up over protection; the methodical sip early. Stable
 * per citizen (seeded by username).
 *
 * Zero LLM. Tick-safe: every engine read guarded, engine access degrades
 * to null outside a running server so the pure decision logic stays
 * unit-testable in plain node.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const { agentRng } = require("../../lib/humanizer");

// BotNavigation pulls engine TS at load; require it lazily so this module
// stays load-safe in plain node (lib consumers like CitizenBossRuns are
// unit-tested without the engine).
let navigationModule = null;
function nav() {
  if (!navigationModule) {
    try {
      navigationModule =
        require("../../../bots/behaviours/navigation/BotNavigation");
    } catch {
      navigationModule = {};
    }
  }
  return navigationModule;
}

// --- stable prayer ids (mirror of PrayerHandler's public constants) --------
const PRAY = Object.freeze({
  THICK_SKIN: 0,
  BURST_OF_STRENGTH: 1,
  CLARITY_OF_THOUGHT: 2,
  SHARP_EYE: 3,
  MYSTIC_WILL: 4,
  ROCK_SKIN: 5,
  SUPERHUMAN_STRENGTH: 6,
  IMPROVED_REFLEXES: 7,
  PROTECT_ITEM: 10,
  HAWK_EYE: 11,
  MYSTIC_LORE: 12,
  STEEL_SKIN: 13,
  ULTIMATE_STRENGTH: 14,
  INCREDIBLE_REFLEXES: 15,
  PROTECT_FROM_MAGIC: 16,
  PROTECT_FROM_MISSILES: 17,
  PROTECT_FROM_MELEE: 18,
  EAGLE_EYE: 19,
  MYSTIC_MIGHT: 20,
  CHIVALRY: 25,
  PIETY: 26,
  RIGOUR: 27,
  AUGURY: 28,
});

// PrayerData requirements (level, from the engine's PrayerData table).
const PRAY_REQ = Object.freeze({
  0: 1, 1: 4, 2: 7, 3: 8, 4: 9, 5: 10, 6: 13, 7: 16,
  10: 25, 11: 26, 12: 27, 13: 28, 14: 31, 15: 34,
  16: 37, 17: 40, 18: 43, 19: 44, 20: 45,
  25: 60, 26: 70, 27: 74, 28: 77,
});

// Defence level needed for the elite stat prayers (engine canUse).
const PRAY_DEFENCE_REQ = Object.freeze({ 25: 60, 26: 70, 27: 70, 28: 70 });

const OVERHEAD_FOR_STYLE = Object.freeze({
  melee: PRAY.PROTECT_FROM_MELEE,
  ranged: PRAY.PROTECT_FROM_MISSILES,
  magic: PRAY.PROTECT_FROM_MAGIC,
});

// Best-first DPS prayer per attack style.
const DPS_PRAYERS = Object.freeze({
  melee: Object.freeze([PRAY.PIETY, PRAY.CHIVALRY, PRAY.ULTIMATE_STRENGTH]),
  ranged: Object.freeze([PRAY.RIGOUR, PRAY.EAGLE_EYE]),
  magic: Object.freeze([PRAY.AUGURY, PRAY.MYSTIC_MIGHT]),
});
const ALL_DPS = Object.freeze([
  ...DPS_PRAYERS.melee, ...DPS_PRAYERS.ranged, ...DPS_PRAYERS.magic,
  PRAY.BURST_OF_STRENGTH, PRAY.SUPERHUMAN_STRENGTH,
  PRAY.CLARITY_OF_THOUGHT, PRAY.IMPROVED_REFLEXES, PRAY.INCREDIBLE_REFLEXES,
  PRAY.SHARP_EYE, PRAY.HAWK_EYE, PRAY.MYSTIC_WILL, PRAY.MYSTIC_LORE,
]);
const ALL_OVERHEADS = Object.freeze([
  PRAY.PROTECT_FROM_MAGIC, PRAY.PROTECT_FROM_MISSILES, PRAY.PROTECT_FROM_MELEE,
]);

// --- tuning ----------------------------------------------------------------
// Below this threat combat level, no prayers at all — a level-3 goblin
// doesn't need piety, and neither does the prayer-point bar.
const TRIVIAL_THREAT_COMBAT = 10;
// DPS prayers need this many points banked or they burn the last of the bar.
const DPS_MIN_POINTS = 8;
// Protect Item "carrying valuables" floor (skulled covers PKers).
const PROTECT_ITEM_COINS = 50000;
// Re-decide overheads/DPS at human reaction cadence, not per tick.
const DECIDE_EVERY_MS = 2500;
// Potion sip cooldown (the engine's potion timer is 3 ticks; humans sip).
const DRINK_COOLDOWN_MS = 2600;
// Bone bury cadence: the engine's bury delay is 1.2s; humans pause longer.
const BURY_COOLDOWN_MS = 3200;
// Altar search radius (regions) and interact distance.
const ALTAR_SEARCH_REGIONS = 2;
const ALTAR_ARRIVE_TILES = 2;
// Animations mirror the engine plugins.
const DRINK_ANIMATION = 829;
const BURY_ANIMATION = 827;
const ALTAR_ANIMATION = 645;

// Potion dose chains (ItemIdentifiers): prayer potions and super restores
// both restore prayer points.
const PRAYER_POTION_DOSES = Object.freeze([2434, 139, 141, 143]);
const SUPER_RESTORE_DOSES = Object.freeze([3024, 3026, 3028, 3030]);
const VIAL = 229;
const HOLY_WRENCH = 6714;
const NEXT_DOSE = new Map([
  [2434, 139], [139, 141], [141, 143], [143, VIAL],
  [3024, 3026], [3026, 3028], [3028, 3030], [3030, VIAL],
]);

// --- engine bridge (guarded; null outside a running server) -----------------

let engineCache = null;
let engineTried = false;
let engineOverride = null; // test seam: _setEngine installs a fake engine

/**
 * The engine modules this brain needs. Null when unavailable — every
 * caller degrades gracefully. Same guarded-require pattern as
 * CitizenSlayer's slayerUnits().
 */
function engine() {
  if (engineOverride) return engineOverride;
  if (engineTried) return engineCache;
  engineTried = true;
  try {
    const PrayerHandler =
      require("../../../../src/main/typescript/elvarg/game/content/PrayerHandler")
        .PrayerHandler;
    const Skill =
      require("../../../../src/main/typescript/elvarg/game/model/Skill").Skill;
    const CombatFactory =
      require("../../../../src/main/typescript/elvarg/game/content/combat/CombatFactory")
        .CombatFactory;
    const CombatType =
      require("../../../../src/main/typescript/elvarg/game/content/combat/CombatType")
        .CombatType;
    const Animation =
      require("../../../../src/main/typescript/elvarg/game/model/Animation")
        .Animation;
    const Item =
      require("../../../../src/main/typescript/elvarg/game/model/Item").Item;
    const { Sound } =
      require("../../../../src/main/typescript/elvarg/game/Sound");
    const { Sounds } =
      require("../../../../src/main/typescript/elvarg/game/Sounds");
    const { ItemDefinition } =
      require("../../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
    const ItemIdentifiers =
      require("../../../../src/main/typescript/elvarg/util/ItemIdentifiers")
        .ItemIdentifiers;
    const ObjectIdentifiers =
      require("../../../../src/main/typescript/elvarg/util/ObjectIdentifiers")
        .ObjectIdentifiers;
    let BONE_XP = null;
    try {
      BONE_XP =
        require("../../../../src/main/typescript/elvarg/game/content/combat/magic/ArceuusOfferings")
          .BONE_XP ?? null;
    } catch {
      BONE_XP = null;
    }
    if (!PrayerHandler || !Skill || !CombatFactory || !CombatType) return null;
    engineCache = {
      PrayerHandler, Skill, CombatFactory, CombatType, Animation, Item,
      Sound, Sounds, ItemDefinition, ItemIdentifiers, ObjectIdentifiers,
      BONE_XP, altarIds: null,
    };
    return engineCache;
  } catch {
    return null;
  }
}

/** Altar/Shrine object ids, derived from ObjectIdentifiers (not hardcoded). */
function altarObjectIds(eng) {
  if (eng.altarIds) return eng.altarIds;
  const ids = [];
  try {
    for (const key of Object.keys(eng.ObjectIdentifiers ?? {})) {
      if (/^(ALTAR(_\d+)?|SHRINE(_\d+)?)$/.test(key)) {
        const id = eng.ObjectIdentifiers[key];
        if (Number.isInteger(id)) ids.push(id);
      }
    }
  } catch {
    // no altar list — recharge degrades to "no-altar"
  }
  eng.altarIds = ids;
  return ids;
}

/** Bone item ids -> bury XP, from the engine's own BONE_XP table. */
function boneXp(eng) {
  if (eng.BONE_XP instanceof Map && eng.BONE_XP.size > 0) return eng.BONE_XP;
  return new Map([[526, 5], [532, 15]]); // bones, big bones
}

// --- pure decision logic (engine-free, unit-tested) -------------------------

/**
 * Per-citizen prayer personality. Stable per username (seeded RNG) so a
 * citizen prays like themselves every fight, and varied across the
 * population so not everyone prays optimally.
 */
function prayerProfile(personality, username) {
  const traits = new Set(personality?.traits ?? []);
  const rng = agentRng(`prayer:${username ?? "unknown"}`);
  const profile = {
    // 0..1 overall prayerfulness.
    piety: 0.45 + (rng() - 0.5) * 0.2,
    // Threat combat level at which overheads / DPS kick in.
    overheadFloor: 20,
    dpsFloor: 30,
    // Drink a potion when points fall below this fraction of max.
    drinkAt: 0.35,
    // Will detour to the bank for prayer potions before a fight.
    bringPotions: true,
    // 0..1 preference for DPS over protection when points run low.
    dpsBias: 0.4,
  };
  if (traits.has("devout")) {
    profile.piety = 0.9 + rng() * 0.1;
    profile.overheadFloor = 12;
    profile.dpsFloor = 18;
    profile.drinkAt = 0.5;
  }
  if (traits.has("methodical")) {
    profile.drinkAt = Math.max(profile.drinkAt, 0.5);
    profile.overheadFloor -= 3;
  }
  if (traits.has("greedy")) {
    // Won't spend potions; prays only when it really matters.
    profile.piety *= 0.5;
    profile.bringPotions = false;
    profile.drinkAt = 0.15;
    profile.overheadFloor += 8;
    profile.dpsFloor += 10;
  }
  if (traits.has("clumsy")) {
    // Slow reactions: overheads go up late, sips come late.
    profile.overheadFloor += 6;
    profile.drinkAt = Math.min(profile.drinkAt, 0.25);
  }
  if (traits.has("proud")) {
    profile.dpsBias = 0.9;
    profile.dpsFloor -= 6;
  }
  if (traits.has("dutiful")) {
    profile.bringPotions = true;
    profile.drinkAt = Math.max(profile.drinkAt, 0.4);
  }
  if (traits.has("suspicious")) {
    // Doesn't trust the gods much, but protects the loot.
    profile.piety = Math.min(profile.piety, 0.35);
  }
  profile.piety = Math.min(1, Math.max(0.05, profile.piety));
  profile.overheadFloor = Math.max(5, Math.round(profile.overheadFloor));
  profile.dpsFloor = Math.max(8, Math.round(profile.dpsFloor));
  profile.drinkAt = Math.min(0.8, Math.max(0.1, profile.drinkAt));
  return profile;
}

/**
 * Best DPS prayer for an attack style the bot can actually use, or null.
 * Pure: prayerLevel/defenceLevel are max levels.
 */
function bestDpsPrayer(botStyle, prayerLevel, defenceLevel) {
  const chain = DPS_PRAYERS[botStyle] ?? [];
  for (const id of chain) {
    if ((prayerLevel ?? 0) < (PRAY_REQ[id] ?? 99)) continue;
    if ((defenceLevel ?? 0) < (PRAY_DEFENCE_REQ[id] ?? 0)) continue;
    return id;
  }
  return null;
}

/**
 * Which prayers should be up, given the threat and the citizen. Pure.
 *
 * input: { style: 'melee'|'magic'|'ranged'|null (threat's attack style),
 *   threatCombat, prayerLevel (max), defenceLevel (max), points (current),
 *   max (prayer max), skulled, coins, botStyle, profile }
 * returns: { overhead: id|null, dps: id|null, protectItem: bool }
 */
function decidePrayers(input) {
  const none = { overhead: null, dps: null, protectItem: false };
  const {
    style = null,
    threatCombat = 0,
    prayerLevel = 0,
    points = 0,
    max = 0,
    profile = null,
  } = input ?? {};
  if (prayerLevel < 1 || points <= 0) return none;
  // Trivial fights get nothing — preserve the bar. A level-3 goblin
  // doesn't need piety, and neither does Protect from Melee.
  if (threatCombat < TRIVIAL_THREAT_COMBAT) return none;

  const p = profile ?? {
    overheadFloor: 20, dpsFloor: 30, dpsBias: 0.4, piety: 0.5,
  };
  const out = { overhead: null, dps: null, protectItem: false };

  // Overhead by threat style, when the threat is real and we qualify.
  const overheadId = OVERHEAD_FOR_STYLE[style] ?? null;
  if (
    overheadId != null &&
    threatCombat >= p.overheadFloor &&
    prayerLevel >= (PRAY_REQ[overheadId] ?? 99)
  ) {
    out.overhead = overheadId;
  }

  // DPS when the fight is worth the drain — never on trivial fights, and
  // never burning the last of the bar on damage.
  if (
    threatCombat >= p.dpsFloor &&
    points > DPS_MIN_POINTS &&
    prayerLevel >= 4
  ) {
    out.dps = bestDpsPrayer(
      input.botStyle, prayerLevel, input.defenceLevel ?? 0
    );
  }

  // Protect Item: skulled (PK) or carrying real wealth.
  if (
    prayerLevel >= (PRAY_REQ[PRAY.PROTECT_ITEM] ?? 99) &&
    (input.skulled === true || (input.coins ?? 0) >= PROTECT_ITEM_COINS)
  ) {
    out.protectItem = true;
  }

  // The proud keep DPS up over protection when the bar runs low.
  if (
    out.overhead != null && out.dps != null &&
    (p.dpsBias ?? 0) > 0.7 && points < (max ?? 0) * 0.3
  ) {
    out.overhead = null;
  }
  return out;
}

// --- per-bot memory ---------------------------------------------------------

const COMBAT_MEM = new WeakMap();
const DRINK_AT = new WeakMap();
const BURY_AT = new WeakMap();

function combatMem(bot) {
  let mem = COMBAT_MEM.get(bot);
  if (!mem) {
    mem = { lastAt: 0, lastKey: null, lastDecision: null };
    COMBAT_MEM.set(bot, mem);
  }
  return mem;
}

// --- engine reads ------------------------------------------------------------

function prayerLevels(bot, eng) {
  try {
    const sm = bot.getSkillManager?.();
    if (!sm) return null;
    const points = sm.getCurrentLevel(eng.Skill.PRAYER);
    const max = sm.getMaxLevel(eng.Skill.PRAYER);
    const defence = sm.getMaxLevel(eng.Skill.DEFENCE);
    if (!Number.isFinite(points) || !Number.isFinite(max) || max < 1) return null;
    return { points, max, defence: Number.isFinite(defence) ? defence : 1 };
  } catch {
    return null;
  }
}

function isPrayerActive(bot, id) {
  try {
    return bot.getPrayerActive?.()[id] === true;
  } catch {
    return false;
  }
}

function combatStyleOf(eng, entity) {
  try {
    if (!entity || typeof entity.isNpc !== "function") return null;
    const type = eng.CombatFactory.getMethod(entity).type();
    if (type === eng.CombatType.MELEE) return "melee";
    if (type === eng.CombatType.RANGED) return "ranged";
    if (type === eng.CombatType.MAGIC) return "magic";
    return null;
  } catch {
    return null;
  }
}

function combatLevelOf(entity) {
  try {
    if (!entity || typeof entity.isNpc !== "function") return 0;
    if (entity.isNpc()) {
      const lvl = entity.getCurrentDefinition?.()?.getCombatLevel?.();
      return Number.isFinite(lvl) ? lvl : 0;
    }
    const lvl = entity.getSkillManager?.()?.getCombatLevel?.();
    return Number.isFinite(lvl) ? lvl : 0;
  } catch {
    return 0;
  }
}

/** The threat: whoever's hitting the bot, else whoever the bot's hitting. */
function currentThreat(bot) {
  try {
    const combat = bot.getCombat?.();
    return combat?.getAttacker?.() ?? combat?.getTarget?.() ?? null;
  } catch {
    return null;
  }
}

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

// --- combat prayer tick -------------------------------------------------------

function activatePrayer(bot, eng, id) {
  try {
    eng.PrayerHandler.activatePrayerPrayerId(bot, id);
    return isPrayerActive(bot, id);
  } catch {
    return false;
  }
}

function deactivatePrayer(bot, eng, id) {
  try {
    eng.PrayerHandler.deactivatePrayer(bot, id);
  } catch {
    // non-fatal
  }
}

/**
 * Per-tick prayer maintenance for a bot in combat. Idempotent and cheap:
 * the decision re-runs at human cadence (2.5s) or when the threat changes;
 * potion sips happen at the citizen's personality threshold.
 *
 * threat: the enemy entity (fallback when the engine doesn't know who's
 *   fighting yet). Whoever is actually hitting the bot always wins for
 *   overheads: attacker ?? bot's target ?? threat.
 * Returns { activated, deactivated, drank, decision } or null without engine.
 */
function maintainCombatPrayer(bot, threat = null, opts = {}) {
  const eng = engine();
  if (!eng || !bot) return null;
  const now = opts.nowMs ?? Date.now();
  const mem = combatMem(bot);

  const foe = currentThreat(bot) ?? threat ?? null;
  let lv = prayerLevels(bot, eng);
  if (!lv) return { activated: [], deactivated: [], drank: false, decision: null };

  // Sip at the personality threshold even between re-decisions.
  let drank = false;
  const profile = prayerProfile(
    bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {},
    bot.getUsername?.() ?? "unknown"
  );
  if (lv.points > 0 && lv.points < lv.max * profile.drinkAt) {
    drank = drinkPrayerPotion(bot, eng, now);
    if (drank) lv = prayerLevels(bot, eng) ?? lv; // the sip moved the bar
  }

  // Out of points: the engine already dropped everything; nothing to decide.
  if (lv.points <= 0 && !drank) {
    return { activated: [], deactivated: [], drank, decision: null };
  }

  const foeKey = (() => {
    try {
      if (!foe) return "none";
      if (foe.isNpc?.()) return `n:${foe.getId?.() ?? "?"}:${foe.getIndex?.() ?? "?"}`;
      return `p:${foe.getUsername?.() ?? "?"}`;
    } catch {
      return "unknown";
    }
  })();
  const due = now - mem.lastAt >= DECIDE_EVERY_MS;
  if (!due && mem.lastKey === foeKey && mem.lastDecision) {
    return { activated: [], deactivated: [], drank, decision: mem.lastDecision };
  }
  mem.lastAt = now;
  mem.lastKey = foeKey;

  let skulled = false;
  let coins = 0;
  try { skulled = bot.isSkulled?.() === true; } catch { /* best effort */ }
  try { coins = bot.getInventory?.()?.getAmount?.(995) ?? 0; } catch { /* best effort */ }

  const decision = decidePrayers({
    style: combatStyleOf(eng, foe),
    threatCombat: combatLevelOf(foe),
    prayerLevel: lv.max,
    defenceLevel: lv.defence,
    points: lv.points,
    max: lv.max,
    skulled,
    coins,
    botStyle: combatStyleOf(eng, bot),
    profile,
  });
  mem.lastDecision = decision;

  const activated = [];
  const deactivated = [];
  for (const id of [decision.overhead, decision.dps]) {
    if (id != null && !isPrayerActive(bot, id) && activatePrayer(bot, eng, id)) {
      activated.push(id);
    }
  }
  if (decision.protectItem && !isPrayerActive(bot, PRAY.PROTECT_ITEM)) {
    if (activatePrayer(bot, eng, PRAY.PROTECT_ITEM)) activated.push(PRAY.PROTECT_ITEM);
  }
  // Threat changed or calmed: drop prayers the decision no longer wants.
  for (const id of ALL_OVERHEADS) {
    if (id !== decision.overhead && isPrayerActive(bot, id)) {
      deactivatePrayer(bot, eng, id);
      deactivated.push(id);
    }
  }
  for (const id of ALL_DPS) {
    if (id !== decision.dps && isPrayerActive(bot, id)) {
      deactivatePrayer(bot, eng, id);
      deactivated.push(id);
    }
  }
  if (!decision.protectItem && isPrayerActive(bot, PRAY.PROTECT_ITEM)) {
    deactivatePrayer(bot, eng, PRAY.PROTECT_ITEM);
    deactivated.push(PRAY.PROTECT_ITEM);
  }
  return { activated, deactivated, drank, decision };
}

/** Drop combat prayers when the fight ends (action stop / kill confirmed). */
function releaseCombatPrayers(bot) {
  const eng = engine();
  if (!eng || !bot) return 0;
  let n = 0;
  try {
    for (const id of [...ALL_OVERHEADS, ...ALL_DPS, PRAY.PROTECT_ITEM]) {
      if (isPrayerActive(bot, id)) {
        deactivatePrayer(bot, eng, id);
        n++;
      }
    }
  } catch {
    // non-fatal
  }
  try { COMBAT_MEM.delete(bot); } catch { /* best effort */ }
  return n;
}

// --- sustainment: potions -------------------------------------------------------

/** Total prayer-potion + super-restore doses in the inventory. */
function prayerPotionDoses(bot) {
  try {
    const inv = bot.getInventory?.();
    if (!inv) return 0;
    let n = 0;
    for (const id of [...PRAYER_POTION_DOSES, ...SUPER_RESTORE_DOSES]) {
      n += inv.getAmount?.(id) ?? 0;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * Drink one dose of prayer potion / super restore. Real dose swap and the
 * real restore formula (7 + 25%, 27% with a holy wrench — Potions.plugin's
 * applyPrayerRestore; super restores use the 8 + 25% formula). Returns true
 * when a dose was drunk.
 */
function drinkPrayerPotion(bot, engArg = null, nowMs = null) {
  const eng = engArg ?? engine();
  if (!eng || !bot) return false;
  const now = nowMs ?? Date.now();
  const last = DRINK_AT.get(bot) ?? 0;
  if (now - last < DRINK_COOLDOWN_MS) return false;

  let inv = null;
  try { inv = bot.getInventory?.(); } catch { return false; }
  if (!inv) return false;

  for (const id of [...PRAYER_POTION_DOSES, ...SUPER_RESTORE_DOSES]) {
    let slot = -1;
    try { slot = inv.getSlotForItemId?.(id) ?? -1; } catch { slot = -1; }
    if (slot < 0) continue;
    try {
      if (inv.getItems?.()[slot]?.getId?.() !== id) continue;
    } catch {
      continue;
    }
    const nextId = NEXT_DOSE.get(id) ?? VIAL;
    try {
      inv.setItem(slot, new eng.Item(nextId, 1)).refreshItems();
      const lv = prayerLevels(bot, eng);
      const max = lv?.max ?? 1;
      const flat = SUPER_RESTORE_DOSES.includes(id) ? 8 : 7;
      const bonus = inv.contains?.(HOLY_WRENCH) === true;
      const restored = Math.floor(flat + max * (bonus ? 0.27 : 0.25));
      bot.getSkillManager?.().increaseCurrentLevel(eng.Skill.PRAYER, restored, max);
      try { bot.performAnimation?.(new eng.Animation(DRINK_ANIMATION)); } catch { /* cosmetic */ }
      try { eng.Sounds.sendSound(bot, eng.Sound.PRAYER_RECHARGE); } catch { /* cosmetic */ }
      DRINK_AT.set(bot, now);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Provisioning gate for combat actions: withdraw prayer potions from the
 * bank before a fight. Returns a bank delegate action, or null when
 * already stocked / prayer too low to matter / unwilling / bank empty.
 * Never stalls: null means "go fight".
 */
function ensureSupplies(bot, world) {
  const eng = engine();
  if (!eng || !bot || !world) return null;
  const lv = prayerLevels(bot, eng);
  if (!lv || lv.max < (PRAY_REQ[PRAY.PROTECT_ITEM] ?? 25)) return null;
  const profile = prayerProfile(
    bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {},
    bot.getUsername?.() ?? "unknown"
  );
  if (!profile.bringPotions) return null;
  if (prayerPotionDoses(bot) >= 2) return null; // already stocked

  // Only promise a bank run the bank can fulfill.
  let doseId = 0;
  try {
    for (const id of [...PRAYER_POTION_DOSES, ...SUPER_RESTORE_DOSES]) {
      for (let tab = 0; tab < 9; tab++) {
        const bank = bot.getBank?.(tab);
        if (!bank) continue;
        if ((bank.getSlotForItemId?.(id) ?? -1) >= 0) { doseId = id; break; }
      }
      if (doseId) break;
    }
  } catch {
    return null;
  }
  if (!doseId) return null;
  try {
    const { createBankAction } = require("../../../bots/brain/actions/Bank");
    return createBankAction({ withdraw: [{ item: doseId, amount: 2 }] }, world);
  } catch {
    return null;
  }
}

/**
 * Tick a provisioning delegate stored on the action's state. Returns true
 * when provisioning is done (or unnecessary/failed — never stalls).
 */
function tickSupplies(state, bot, world, ctx) {
  if (!state || state.prayerSupplied) return true;
  try {
    if (state.supplyDelegate === undefined) {
      state.supplyDelegate = ensureSupplies(bot, world);
    }
    const delegate = state.supplyDelegate;
    if (!delegate) {
      state.prayerSupplied = true;
      return true;
    }
    const res = delegate.update(ctx);
    if (res !== "running") {
      try { delegate.stop?.(ctx); } catch { /* non-fatal */ }
      state.supplyDelegate = null;
      state.prayerSupplied = true;
      return true;
    }
    return false;
  } catch {
    state.prayerSupplied = true;
    return true;
  }
}

// --- sustainment: altar recharge --------------------------------------------------

/**
 * Nearest name-verified prayer altar. `allowedNames` defaults to the
 * objects the Altars plugin recharges at ("Altar"/"Shrine"); callers
 * pass their own set (bone offering also works at gilded altars).
 * Returns { obj, dist, name } or null.
 */
function findAltar(bot, world, allowedNames = null) {
  const eng = engine();
  if (!eng || !bot || !world) return null;
  const allowed = new Set(allowedNames ?? ["Altar", "Shrine"]);
  const ids = altarObjectIds(eng);
  if (ids.length === 0) return null;
  const bt = botTile(bot);
  if (!bt) return null;

  let candidates = [];
  try {
    candidates =
      world.objectSearch?.findCandidatesByIds?.(bot, ids, {
        regionRadius: ALTAR_SEARCH_REGIONS,
        z: bt.z,
      }) ?? [];
  } catch {
    return null;
  }
  let best = null;
  let bestDist = Infinity;
  let bestName = null;
  for (const obj of candidates) {
    let name = null;
    try { name = obj?.getDefinition?.()?.getName?.(); } catch { /* skip */ }
    // Name-verified: only altar objects the caller asked for.
    if (!allowed.has(name)) continue;
    let ot = null;
    try {
      const loc = obj.getLocation?.();
      ot = loc ? { x: loc.getX(), y: loc.getY() } : null;
    } catch { /* skip */ }
    if (!ot) continue;
    const d = chebyshev(bt.x, bt.y, ot.x, ot.y);
    if (d < bestDist) { best = obj; bestDist = d; bestName = name; }
  }
  if (!best) return null;
  return { obj: best, dist: bestDist, name: bestName };
}

/** Walk the bot to an altar object; returns "walking" or null on failure. */
function walkToAltar(bot, altar, bt) {
  try {
    const loc = altar.obj.getLocation();
    nav().requestMovement?.(bot, loc.getX(), loc.getY(), {
      reason: "citizen_prayer_altar",
      basicPather: true,
      z: bt.z,
    });
    return "walking";
  } catch {
    return null;
  }
}

/**
 * Walk to the nearest prayer altar and recharge, exactly like the Altars
 * plugin's handlePrayerAltar (animation 645, full restore, the same
 * message). Returns 'recharged' | 'walking' | 'full' | 'no-altar' |
 * 'in-combat' | null (no engine/world).
 */
function rechargeAtAltar(bot, world) {
  const eng = engine();
  if (!eng || !bot || !world) return null;
  try {
    if (bot.getCombat?.()?.getTarget?.() || bot.getCombat?.()?.getAttacker?.()) {
      return "in-combat";
    }
  } catch {
    return null;
  }
  const altar = findAltar(bot, world);
  if (!altar) return "no-altar";
  const bt = botTile(bot);
  if (!bt) return null;
  if (altar.dist > ALTAR_ARRIVE_TILES) return walkToAltar(bot, altar, bt);
  try {
    const sm = bot.getSkillManager?.();
    const cur = sm.getCurrentLevel(eng.Skill.PRAYER);
    const max = sm.getMaxLevel(eng.Skill.PRAYER);
    if (cur >= max) return "full";
    try { bot.performAnimation?.(new eng.Animation(ALTAR_ANIMATION)); } catch { /* cosmetic */ }
    try { eng.Sounds.sendSound(bot, eng.Sound.PRAYER_RECHARGE); } catch { /* cosmetic */ }
    sm.setCurrentLevels(eng.Skill.PRAYER, max);
    sm.updateSkill(eng.Skill.PRAYER);
    try { bot.sendMessage?.("You recharge your Prayer points."); } catch { /* best effort */ }
    return "recharged";
  } catch {
    return null;
  }
}

// --- sustainment: bone burying -------------------------------------------------------

/** Bones in the inventory (burial candidates). */
function boneCount(bot) {
  const eng = engine();
  if (!eng || !bot) return 0;
  try {
    const inv = bot.getInventory?.();
    if (!inv) return 0;
    let n = 0;
    for (const id of boneXp(eng).keys()) n += inv.getAmount?.(id) ?? 0;
    return n;
  } catch {
    return 0;
  }
}

/**
 * Bury a single bone for real Prayer XP (engine formula from BONE_XP),
 * with a human-paced cooldown between burials. Returns 1 when a bone was
 * buried, 0 otherwise.
 */
function buryBones(bot, engArg = null, nowMs = null) {
  const eng = engArg ?? engine();
  if (!eng || !bot) return 0;
  const now = nowMs ?? Date.now();
  if (now - (BURY_AT.get(bot) ?? 0) < BURY_COOLDOWN_MS) return 0;

  let inv = null;
  try { inv = bot.getInventory?.(); } catch { return 0; }
  if (!inv) return 0;
  const bones = boneXp(eng);

  for (const [id, xp] of bones) {
    let slot = -1;
    try { slot = inv.getSlotForItemId?.(id) ?? -1; } catch { slot = -1; }
    if (slot < 0) continue;
    try {
      if (inv.getItems?.()[slot]?.getId?.() !== id) continue;
      let boneName = "bones";
      try {
        boneName = eng.ItemDefinition?.forId?.(id)?.getName?.() ?? boneName;
      } catch { /* keep default */ }
      inv.deleteAtSlot(slot, 1);
      try { bot.performAnimation?.(new eng.Animation(BURY_ANIMATION)); } catch { /* cosmetic */ }
      try { eng.Sounds.sendSound(bot, eng.Sound.BURY_BONES); } catch { /* cosmetic */ }
      bot.getSkillManager?.().addExperiences(eng.Skill.PRAYER, xp);
      try { bot.sendMessage?.("You dig a hole in the ground.."); } catch { /* best effort */ }
      try { bot.sendMessage?.(`..and bury the ${boneName}.`); } catch { /* best effort */ }
      BURY_AT.set(bot, now);
      return 1;
    } catch {
      return 0;
    }
  }
  return 0;
}

// --- sustainment: bone offering at altars ---------------------------------------

// Mirrors Prayer.plugin's ALTAR_MULTIPLIERS (OSRS: plain altar 2.5x, gilded 3.5x).
const ALTAR_XP_MULTIPLIERS = new Map([
  ["Altar", 2.5],
  ["Gilded altar", 3.5],
]);
// Human-paced offering cadence (the engine's own offer delay is 1800ms).
const OFFER_COOLDOWN_MS = 4000;
const OFFER_AT = new WeakMap();

/**
 * Prayer XP for offering one bone at a named altar. Pure: null when the
 * altar or bone has no offering table entry.
 */
function offerXp(eng, boneId, altarName) {
  const mult = ALTAR_XP_MULTIPLIERS.get(altarName);
  if (!mult) return null;
  const base = boneXp(eng).get(boneId);
  if (!Number.isFinite(base)) return null;
  return Math.floor(base * mult);
}

/**
 * Offer one bone at the nearest town altar for real Prayer XP, exactly the
 * way a player trains Prayer (walk to the altar, use bones on it). Mirrors
 * Prayer.plugin's offerBone: same multipliers, same messages, same XP —
 * without the packet path, which bots don't have.
 *
 * Returns 'offered' | 'walking' | 'no-altar' | null (no engine/world).
 * Gated by having bones: 0 bones means nothing to offer.
 */
function offerBonesAtAltar(bot, world, engArg = null, nowMs = null) {
  const eng = engArg ?? engine();
  if (!eng || !bot || !world) return null;
  if (boneCount(bot) <= 0) return null;
  const now = nowMs ?? Date.now();
  if (now - (OFFER_AT.get(bot) ?? 0) < OFFER_COOLDOWN_MS) return "offered";

  const altar = findAltar(bot, world, [...ALTAR_XP_MULTIPLIERS.keys()]);
  if (!altar) return "no-altar";
  const bt = botTile(bot);
  if (!bt) return null;
  if (altar.dist > ALTAR_ARRIVE_TILES) return walkToAltar(bot, altar, bt);

  let inv = null;
  try { inv = bot.getInventory?.(); } catch { return null; }
  if (!inv) return null;
  const bones = boneXp(eng);
  for (const [id] of bones) {
    let slot = -1;
    try { slot = inv.getSlotForItemId?.(id) ?? -1; } catch { slot = -1; }
    if (slot < 0) continue;
    const xp = offerXp(eng, id, altar.name);
    if (xp == null) continue;
    try {
      if (inv.getItems?.()[slot]?.getId?.() !== id) continue;
      let boneName = "bones";
      try {
        boneName = eng.ItemDefinition?.forId?.(id)?.getName?.() ?? boneName;
      } catch { /* keep default */ }
      inv.deleteAtSlot(slot, 1);
      try { bot.performAnimation?.(new eng.Animation(BURY_ANIMATION)); } catch { /* cosmetic */ }
      try { eng.Sounds.sendSound(bot, eng.Sound.BURY_BONES); } catch { /* cosmetic */ }
      bot.getSkillManager?.().addExperiences(eng.Skill.PRAYER, xp);
      if (altar.name === "Gilded altar") {
        try { bot.sendMessage?.(`You offer the ${boneName} at the gilded altar.`); } catch { /* best effort */ }
        try { bot.sendMessage?.("The gods are pleased with your offering."); } catch { /* best effort */ }
      } else {
        try { bot.sendMessage?.(`You offer the ${boneName} at the altar.`); } catch { /* best effort */ }
      }
      OFFER_AT.set(bot, now);
      return "offered";
    } catch {
      return null;
    }
  }
  return null;
}

// --- the sustainment hinge action --------------------------------------------------

const PRAYER_GIVE_UP_MS = 5 * 60 * 1000;

/**
 * citizenPrayer — the prayer hinge. Scored by the decision layer when the
 * bar is low or bones are piling up: offer bones at the nearest town
 * altar for real Prayer XP when one is reachable, otherwise bury bones
 * for XP on the spot; then walk to the nearest altar and recharge. Never
 * interrupts combat — the combat actions own prayers mid-fight.
 */
function createCitizenPrayerAction(spec, world) {
  const action = {
    id: "citizenPrayer",

    update(ctx) {
      const bot = ctx?.player;
      if (!bot) return "failed";
      const nowMs = ctx?.nowMs ?? Date.now();
      const state = playerState(action, bot, () => ({
        startedAt: nowMs,
      }));
      if (nowMs - state.startedAt > PRAYER_GIVE_UP_MS) return "success";

      // Combat owns prayers mid-fight — never barge in.
      try {
        if (bot.getCombat?.()?.getTarget?.() || bot.getCombat?.()?.getAttacker?.()) {
          return "success";
        }
      } catch {
        return "failed";
      }

      const eng = engine();
      if (!eng) return "failed";
      const w = world ?? ctx?.world ?? null;

      // 1. Bones are Prayer XP. A reachable town altar multiplies the XP
      //    (2.5x plain altar, 3.5x gilded) — offer there the way a player
      //    trains Prayer; with no altar in reach, bury where we stand.
      if (boneCount(bot) > 0) {
        const offered = offerBonesAtAltar(bot, w, eng, nowMs);
        if (offered === "offered" || offered === "walking") return "running";
        const buried = buryBones(bot, eng, nowMs);
        if (buried > 0) return "running";
        // Cooldown between offerings/burials: linger, don't spin the decision layer.
        return "running";
      }

      // 2. Bar low — walk to an altar and recharge.
      const lv = prayerLevels(bot, eng);
      if (lv && lv.max >= 10 && lv.points < lv.max * 0.6) {
        const res = rechargeAtAltar(bot, w);
        if (res === "walking") return "running";
        if (res === "recharged" || res === "full") return "success";
        // no-altar / in-combat: nothing to do here.
        return "success";
      }

      return "success";
    },

    stop(ctx) {
      try {
        nav().clearMovementRequest?.(ctx?.player);
      } catch {
        // non-fatal
      }
    },
  };
  return action;
}

module.exports = {
  createCitizenPrayerAction,
  // Pure decision logic (unit-tested, engine-free):
  decidePrayers,
  prayerProfile,
  bestDpsPrayer,
  PRAY,
  PRAY_REQ,
  // Engine-backed helpers:
  maintainCombatPrayer,
  releaseCombatPrayers,
  drinkPrayerPotion,
  prayerPotionDoses,
  ensureSupplies,
  tickSupplies,
  rechargeAtAltar,
  offerBonesAtAltar,
  offerXp,
  ALTAR_XP_MULTIPLIERS,
  buryBones,
  boneCount,
  prayerLevels,
  // Test seams:
  _engine: engine,
  _setEngine: (eng) => { engineOverride = eng; },
  _clearEngine: () => { engineOverride = null; },
  _altarObjectIds: altarObjectIds,
  _combatStyleOf: combatStyleOf,
  _combatLevelOf: combatLevelOf,
};
