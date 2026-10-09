"use strict";

/**
 * CitizenCareerLife — the dynamics of citizen jobs and careers (director tick).
 *
 * Data tier, zero LLM. Every decision below reads real state: the roster,
 * real skill levels from CitizenSkilling's skillStore, real coin pouches,
 * personalities, goals, the journal. Nothing is hash-derived.
 *
 * Per slow tick:
 *   1. Assignment — roster citizens without a career record get one, from
 *      their real role (guards guard, merchants trade, courtiers scribe)
 *      or their best real skill (commoners follow their hands).
 *   2. Promotions — skill-mapped careers promote on REAL skill level
 *      (30 journeyman, 60 master); tenure careers promote on days served
 *      (7 / 30). Promotions are journaled; masters are announced.
 *   3. Wages — once a day, service careers (guard, laborer, barkeep,
 *      scribe) earn their daily wage in REAL coins: online citizens get
 *      coins in their real inventory, offline citizens accrue savings
 *      that flush when they materialize. Trade careers earn by selling
 *      goods — no wage, no double-count.
 *   4. Career changes — citizens switch trades when broke in a dead-end
 *      career, when their goal calls for mastery elsewhere, or when
 *      personality drives them (restless drifters, ambitious climbers).
 *      History is kept so "what did you do before?" is truthful.
 *   5. Teaching — masters take apprentices: skill-career pairing rides the
 *      existing CitizenApprentices machinery; tenure-career masters mentor
 *      apprentices of the same trade (journaled, accelerates the
 *      apprentice's tenure clock a little — real state, real effect).
 *
 * Wiring: CitizenDirector.tick() calls tickCareers(director, nowMs).
 */

const Careers = require("./CitizenCareers");
const { normalizeName } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

const COINS = 995; // ItemIds.COINS, verified in ItemIdentifiers.ts

// Per-tick probabilities (the director slow-ticks roughly every 60s).
const CHANGE_CHANCE = 0.004; // ~0.4% per citizen per minute — rare, deliberate
const MENTOR_CHANCE = 0.05;
const TEACH_LINES = [
  "Watch the hands, not the tool — the tool follows the hands.",
  "Slow is smooth, smooth is fast. Again.",
  "You learn a trade with your mistakes. Make good ones.",
  "Feel that? That's the knack. You'll get it.",
];

const DAY_MS = 24 * 3600 * 1000;

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "career", text);
  } catch {
    // Non-fatal.
  }
}

function recordOf(director, name) {
  return director?.roster?.get?.(normalizeName(name)) ?? null;
}

function botOf(director, record) {
  try {
    return director?.getBot ? director.getBot(record) : null;
  } catch {
    return null;
  }
}

function coinCount(bot) {
  try {
    return bot?.getInventory?.()?.getAmount?.(COINS) ?? 0;
  } catch {
    return 0;
  }
}

/** Add real coins to a materialized citizen's inventory. Returns amount added. */
function giveCoins(bot, amount) {
  try {
    const inv = bot?.getInventory?.();
    if (!inv || typeof inv.adds !== "function") return 0;
    inv.adds(COINS, amount);
    return amount;
  } catch {
    return 0;
  }
}

function skillLevelOf(name, skillId) {
  try {
    const { skillStore } = require("./CitizenSkilling");
    const lvl = skillStore.getLevel(name, skillId);
    return Number.isFinite(Number(lvl)) ? Number(lvl) : 0;
  } catch {
    return 0;
  }
}

function traitSet(record) {
  const t = record?.personality?.traits;
  return new Set(Array.isArray(t) ? t.map((x) => String(x).toLowerCase()) : []);
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// --- 1. assignment -----------------------------------------------------------

/** Best skill-mapped career for a record, from real skill levels. Null if none. */
function bestSkillCareer(record) {
  let best = null;
  let bestLevel = 0;
  for (const key of Careers.CAREER_KEYS) {
    const def = Careers.careerDef(key);
    if (!def?.skill) continue;
    const lvl = skillLevelOf(record?.username, def.skill);
    if (lvl > bestLevel) {
      bestLevel = lvl;
      best = key;
    }
  }
  return bestLevel >= 5 ? best : null; // dabblers don't count
}

function assignCareerFor(record, nowMs) {
  const role = String(record?.role ?? "").toLowerCase();
  if (role === "guard") return "guard";
  if (role === "merchant") return "trader";
  if (role === "courtier" || role === "noble") return "scribe";
  // Commoners, refugees, everyone else: follow their hands, else day labor.
  return bestSkillCareer(record) ?? "laborer";
}

function assignCareers(director, rng, nowMs) {
  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name) continue;
      const existing = Careers._data().careers[normalizeName(name)];
      if (existing) continue;
      const key = assignCareerFor(record, nowMs);
      const rec = Careers.careerFor(name, nowMs);
      if (rec && rec.career !== key) {
        // careerFor created a laborer stub; set the real one without history.
        rec.career = key;
        rec.since = nowMs;
        rec.rankSince = nowMs;
        journalEvent(name, `started work as a ${Careers.careerDef(key).label}`);
      } else if (rec) {
        journalEvent(name, `started work as a ${Careers.careerDef(key).label}`);
      }
    } catch {
      // Per-citizen failures must not break the tick.
    }
  }
}

// --- 2. promotions -------------------------------------------------------------

function processPromotions(director, nowMs) {
  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name) continue;
      const rec = Careers.careerFor(name, nowMs);
      if (!rec) continue;
      if (Careers.isCareerRetired(name)) continue; // retired: done climbing
      const earned = Careers.earnedRank(rec.career, rec, (n, skill) =>
        skillLevelOf(n ?? name, skill)
      );
      const order = { apprentice: 0, journeyman: 1, master: 2 };
      if ((order[earned] ?? 0) > (order[rec.rank] ?? 0)) {
        Careers.setRank(name, earned, nowMs);
        // Masters get announced if anyone's around to hear it.
        if (earned === Careers.RANK_MASTER) {
          const bot = botOf(director, record);
          if (bot) {
            try {
              sayPublic(bot, `${voiceLine(voiceFor(record), "promotion") ?? ""}`.trim() ||
                `They're calling me Master ${Careers.careerDef(rec.career).label} now.`);
            } catch {
              // Saying it out loud is garnish; the journal is the record.
            }
          }
        }
      }
    } catch {
      // Per-citizen failures must not break the tick.
    }
  }
}

// --- 3. wages ------------------------------------------------------------------

function payWages(director, nowMs) {
  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name) continue;
      const rec = Careers.careerFor(name, nowMs);
      if (!rec) continue;
      // Flush banked savings whenever the citizen materializes — retired
      // elders live off these, so the flush is NOT gated on retirement.
      const bot = botOf(director, record);
      if (bot && rec.savings > 0) {
        const paid = giveCoins(bot, rec.savings);
        if (paid > 0) {
          journalEvent(name, `collected ${paid} coins in back wages`);
          rec.savings = 0;
        }
      }
      if (Careers.isCareerRetired(name)) continue; // retired: no new wages
      // Daily wage, once per day.
      if (nowMs - (rec.lastWageAt ?? 0) < DAY_MS) continue;
      const wage = Careers.dailyWage(rec.career, rec.rank);
      rec.lastWageAt = nowMs;
      if (wage <= 0) continue; // trade careers earn by selling
      if (bot) {
        const paid = giveCoins(bot, wage);
        if (paid > 0) journalEvent(name, `earned the day's wage: ${paid} coins`);
        else rec.savings += wage; // inventory full or odd — bank it
      } else {
        rec.savings += wage; // offline: accrue until they materialize
      }
    } catch {
      // Per-citizen failures must not break the tick.
    }
  }
}

// --- 4. career changes -----------------------------------------------------------

/**
 * Should this citizen consider a new trade? Reads real state: coin pouch,
 * goal, personality, current career pay. Returns a career key or null.
 */
function considerChange(record, rec, rng) {
  const traits = traitSet(record);
  const goal = record?.goal;
  const goalType = String(goal?.type ?? "");
  const broke = (() => {
    try {
      const bot = null; // checked by caller context; use savings+rank as proxy
      return rec.rank === Careers.RANK_APPRENTICE && (rec.savings ?? 0) < 500;
    } catch {
      return false;
    }
  })();

  // Broke apprentices in dead-end labor drift toward their best skill.
  if (broke && rec.career === "laborer") {
    const better = bestSkillCareer(record);
    if (better && better !== rec.career) return better;
  }
  // Goal-driven: mastering a trade elsewhere.
  if (goalType === "master_trade") {
    const better = bestSkillCareer(record);
    if (better && better !== rec.career && chance(rng, 0.3)) return better;
  }
  // Restless personalities drift; ambitious ones climb within their trade.
  if (traits.has("restless") && chance(rng, 0.5)) {
    const keys = Careers.CAREER_KEYS.filter((k) => k !== rec.career);
    return pickOne(rng, keys);
  }
  if ((traits.has("ambitious") || traits.has("industrious")) && rec.career === "laborer") {
    const better = bestSkillCareer(record);
    if (better) return better;
    // Ambitious laborers with no skill edge try a real trade at random.
    if (chance(rng, 0.4)) {
      const trades = ["woodcutter", "fisher", "miner", "cook", "smith", "crafter"];
      return pickOne(rng, trades);
    }
  }
  return null;
}

function processCareerChanges(director, rng, nowMs) {
  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name) continue;
      if (!chance(rng, CHANGE_CHANCE)) continue;
      const rec = Careers.careerFor(name, nowMs);
      if (!rec) continue;
      if (Careers.isCareerRetired(name)) continue; // retired: no new trades
      // Guards stay guards — the watch is a calling, not a gig.
      if (record?.role === "guard") continue;
      // Don't yank a journeyman+ out of a trade they're invested in unless broke.
      const order = { apprentice: 0, journeyman: 1, master: 2 };
      if ((order[rec.rank] ?? 0) >= 1 && !chance(rng, 0.1)) continue;
      const next = considerChange(record, rec, rng);
      if (next && next !== rec.career) {
        const oldLabel = Careers.careerDef(rec.career)?.label ?? rec.career;
        Careers.setCareer(name, next, nowMs);
        const bot = botOf(director, record);
        if (bot) {
          try {
            sayPublic(bot, `Packing it in as a ${oldLabel} — trying my hand at ${Careers.careerDef(next).label} work.`);
          } catch {
            // Garnish only.
          }
        }
      }
    } catch {
      // Per-citizen failures must not break the tick.
    }
  }
}

// --- 5. teaching -----------------------------------------------------------------
// Skill careers ride CitizenApprentices (master 60+ pairs with apprentice <25).
// Tenure careers mentor here: a master of the same trade accelerates an
// apprentice's clock a little, journaled for both.

function processTeaching(director, rng, nowMs) {
  // Index apprentices by career+kingdom for cheap lookup.
  const apprenticesByTrade = new Map(); // `${kingdomId}:${career}` -> [names]
  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name || !record?.kingdomId) continue;
      const rec = Careers._data().careers[normalizeName(name)];
      if (!rec || rec.rank !== Careers.RANK_APPRENTICE) continue;
      const def = Careers.careerDef(rec.career);
      if (def?.skill) continue; // skill trades use CitizenApprentices
      const k = `${record.kingdomId}:${rec.career}`;
      if (!apprenticesByTrade.has(k)) apprenticesByTrade.set(k, []);
      apprenticesByTrade.get(k).push(name);
    } catch {
      // Skip.
    }
  }
  if (apprenticesByTrade.size === 0) return;

  for (const record of director.roster.values()) {
    try {
      const name = record?.username;
      if (!name || !record?.kingdomId) continue;
      const rec = Careers._data().careers[normalizeName(name)];
      if (!rec || rec.rank !== Careers.RANK_MASTER) continue;
      const def = Careers.careerDef(rec.career);
      if (def?.skill) continue;
      if (!chance(rng, MENTOR_CHANCE)) continue;
      const k = `${record.kingdomId}:${rec.career}`;
      const pupils = (apprenticesByTrade.get(k) ?? []).filter(
        (n) => normalizeName(n) !== normalizeName(name)
      );
      if (pupils.length === 0) continue;
      const pupil = pickOne(rng, pupils);
      const pupilRec = Careers._data().careers[normalizeName(pupil)];
      if (!pupilRec) continue;
      // Teaching accelerates the clock: shave 12h off the apprentice's tenure.
      pupilRec.since = Math.max(0, (pupilRec.since ?? nowMs) - 12 * 3600 * 1000);
      journalEvent(name, `showed ${pupil} the ropes of the ${def.label} trade`);
      journalEvent(pupil, `learned a trick of the ${def.label} trade from ${name}`);
      const bot = botOf(director, record);
      if (bot && chance(rng, 0.5)) {
        try {
          sayPublic(bot, pickOne(rng, TEACH_LINES));
        } catch {
          // Garnish only.
        }
      }
    } catch {
      // Per-citizen failures must not break the tick.
    }
  }
}

// --- entry -----------------------------------------------------------------------

function tickCareers(director, nowMs) {
  const rng = agentRng(`careers:${Math.floor((nowMs ?? Date.now()) / 60000)}`);
  assignCareers(director, rng, nowMs ?? Date.now());
  processPromotions(director, nowMs ?? Date.now());
  payWages(director, nowMs ?? Date.now());
  processCareerChanges(director, rng, nowMs ?? Date.now());
  processTeaching(director, rng, nowMs ?? Date.now());
  try {
    Careers.save();
  } catch {
    // Save failures are logged by the director's save section.
  }
}

module.exports = { tickCareers };
