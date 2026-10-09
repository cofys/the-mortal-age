"use strict";

/**
 * CitizenApprentices — masters of a trade take on apprentices.
 *
 * WHAT IT DOES (data tier, free — runs on the 60s director tick):
 *   Eligible masters (level 60+ in a trade skill) pair with one young
 *   citizen (low skill, same kingdom). Each slow tick the apprentice
 *   gains real trade XP via CitizenSkilling's skillStore — a few days of
 *   uptime to graduate. Graduation at level 40 journals both citizens and
 *   frees the master for a new apprentice. Physical following goes through
 *   the existing CitizenBonds follow system (applied by SocialMechanics).
 *
 * WHAT THE PLAYER SEES (interaction tier, fast proximity tick, only near
 * real players): the apprentice follows the master around town, and
 * occasionally the pair exchange scripted chatter — the apprentice asks
 * a trade question, the master answers with a teaching line.
 *
 * Zero LLM: pairing is roster data, XP is the skilling store, chatter is
 * scripted pools. Journals carry the story so the LLM mouth can answer
 * "who's your apprentice?" truthfully.
 *
 * Wired: slow tick next to CitizenSkilling; fast tick next to
 * CitizenCompanions. Plain-node testable: CitizenApprentices.test.js.
 */

const path = require("path");
const fs = require("fs");
const { skillStore, SKILLS, levelForXp } = require("./CitizenSkilling");
const { setFollow, clearFollow, normalizeName } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const MASTER_LEVEL = 60; // a master has truly learned the trade
const APPRENTICE_START_MAX = 25; // youths with no trade above this qualify
const GRADUATE_LEVEL = 40; // graduation threshold
const XP_PER_TICK_MIN = 6;
const XP_PER_TICK_MAX = 12; // ~11.5k XP/day at 60s ticks -> ~3 days to graduate
const MAX_PAIRS = 24; // bounded: at most this many master-apprentice pairs
const PAIRINGS_PER_TICK = 1; // form at most one new pair per slow tick
const CHATTER_CITIZEN_COOLDOWN_MS = 45 * 60 * 1000; // a pair chats at most this often
const CHATTER_RADIUS = 12; // tiles — close enough to overhear
const CHATTER_CHANCE = 0.25; // per eligible pair per ~10s proximity tick

const TRADE_TITLES = {
  woodcutting: "woodcutter",
  fishing: "fisher",
  mining: "miner",
  cooking: "cook",
};

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-apprentices.json");

// === Persistent pair state ===
// pairs: Map(normalized apprentice name -> { master, skill, since })
const pairs = new Map();
let dirty = false;
let loaded = false;

function loadPairs() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    for (const p of parsed?.pairs ?? []) {
      const a = normalizeName(p.a);
      const m = normalizeName(p.m);
      if (a && m && p.skill && SKILLS[p.skill]) {
        pairs.set(a, { master: m, skill: p.skill, since: p.since ?? 0 });
      }
    }
  } catch {
    // No save yet — start fresh.
  }
}

function savePairsIfDirty() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    const out = [];
    for (const [a, p] of pairs) out.push({ a, m: p.master, skill: p.skill, since: p.since });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ version: 1, pairs: out }, null, 1));
  } catch {
    // Non-fatal.
  }
}

// === Cooldown state (visible tier) ===
const lastChatterByApprentice = new Map(); // apprentice -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastChatterByApprentice) {
    if (at < cutoff) lastChatterByApprentice.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Trade skills a citizen has mastered (level >= MASTER_LEVEL). */
function masteredSkills(username) {
  const out = [];
  for (const key of Object.keys(SKILLS)) {
    if (skillStore.getLevel(username, key) >= MASTER_LEVEL) out.push(key);
  }
  return out;
}

/** Highest trade-skill level across all skills. */
function highestTradeLevel(username) {
  let best = 1;
  for (const key of Object.keys(SKILLS)) {
    const lvl = skillStore.getLevel(username, key);
    if (lvl > best) best = lvl;
  }
  return best;
}

/**
 * Eligible master: working role, masters a trade, not already teaching,
 * not themselves an apprentice.
 */
function eligibleMaster(record, masterNames, apprenticeNames) {
  if (!record || (record.role !== "commoner" && record.role !== "merchant")) return null;
  const name = normalizeName(record.username);
  if (!name || masterNames.has(name) || apprenticeNames.has(name)) return null;
  const skills = masteredSkills(record.username);
  if (!skills.length) return null;
  return { name, skills };
}

/**
 * Eligible apprentice: commoner or refugee, young in every trade, not
 * already apprenticed and not a master.
 */
function eligibleApprentice(record, masterNames, apprenticeNames) {
  if (!record || (record.role !== "commoner" && record.role !== "refugee")) return null;
  const name = normalizeName(record.username);
  if (!name || masterNames.has(name) || apprenticeNames.has(name)) return null;
  if (highestTradeLevel(record.username) > APPRENTICE_START_MAX) return null;
  return { name };
}

function masterNamesOf(map) {
  return new Set([...map.values()].map((p) => p.master));
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** XP drip per slow tick (inclusive bounds). Pure. */
function xpPerTick(rng) {
  return XP_PER_TICK_MIN + Math.floor(rng() * (XP_PER_TICK_MAX - XP_PER_TICK_MIN + 1));
}

/** True when the apprentice has learned the trade. */
function hasGraduated(apprenticeName, skill) {
  return skillStore.getLevel(apprenticeName, skill) >= GRADUATE_LEVEL;
}

function tradeTitle(skill) {
  return TRADE_TITLES[skill] ?? skill;
}

// --- Scripted chatter pools (zero LLM) ---

const APPRENTICE_QUESTIONS = [
  (t) => `Why do you always ${t === "cooking" ? "taste it twice" : "check the grain first"}?`,
  (t) => `How long before I'm half as good as you at ${t}?`,
  () => "Wait — show me that part again, slower.",
  (t) => `Is it true the old ${tradeTitle(t)}s did it differently?`,
  () => "My hands hurt. Does that ever stop?",
  (t) => `What was your first ${tradeTitle(t)} job like?`,
];

const MASTER_TEACHINGS = [
  (t) => `Patience, lad. ${tradeTitle(t)}s are made, not born.`,
  () => "Watch the hands, not the tool. The hands tell you everything.",
  (t) => `A good ${tradeTitle(t)} never blames their tools. A great one sharpens them.`,
  () => "Again. Slower this time — speed comes after the habit.",
  (t) => `Remember: measure twice, cut once. The ${t} doesn't forgive.`,
  () => "You're getting there. I can see it in the work.",
];

function apprenticeQuestion(rng, skill) {
  return pickOne(rng, APPRENTICE_QUESTIONS)(skill);
}

function masterTeaching(rng, skill) {
  return pickOne(rng, MASTER_TEACHINGS)(skill);
}

// ============================================================================
// Data tier: pairing, progression, graduation. Runs on the 60s director tick.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickApprenticeships(director, nowMs) {
  loadPairs();
  try {
    const roster = [...(director.roster?.values?.() ?? [])];
    const masters = masterNamesOf(pairs);
    const apprenticed = new Set(pairs.keys());

    // 1. Progress existing pairs (cheap: one store call per pair).
    for (const [apprentice, p] of pairs) {
      skillStore.addXp(apprentice, p.skill, xpPerTick(Math.random));
      if (hasGraduated(apprentice, p.skill)) {
        graduatePair(director, apprentice, p, nowMs);
        masters.delete(p.master);
        apprenticed.delete(apprentice);
      }
    }

    // 2. Form new pairs (at most one per tick, cheapest-first ordering).
    if (pairs.size < MAX_PAIRS) {
      let formed = 0;
      const candidates = roster.filter((r) => {
        const em = eligibleMaster(r, masters, apprenticed);
        return em && r.kingdomId;
      });
      for (const masterRec of candidates) {
        if (formed >= PAIRINGS_PER_TICK) break;
        const em = eligibleMaster(masterRec, masters, apprenticed);
        if (!em) continue;
        const skill = em.skills[0];
        const youth = roster.find((r) => {
          if (!r.kingdomId || r.kingdomId !== masterRec.kingdomId) return false;
          if (normalizeName(r.username) === em.name) return false;
          return eligibleApprentice(r, masters, apprenticed);
        });
        if (!youth) continue;
        const ea = eligibleApprentice(youth, masters, apprenticed);
        pairUp(em.name, ea.name, skill, nowMs);
        masters.add(em.name);
        apprenticed.add(ea.name);
        formed++;
      }
    }

    if (dirty) {
      savePairsIfDirty();
      skillStore.saveIfDirty?.();
    }
  } catch (e) {
    console.warn("[citizen-apprentices] tick failed:", e?.message ?? e);
  }
}

function pairUp(masterName, apprenticeName, skill, nowMs) {
  pairs.set(apprenticeName, { master: masterName, skill, since: nowMs });
  dirty = true;
  // The apprentice physically follows the master (applied by SocialMechanics).
  try {
    setFollow(apprenticeName, masterName, "apprenticeship");
  } catch { /* non-fatal */ }
  const title = tradeTitle(skill);
  try {
    getJournal().log(masterName, "apprenticeship", `Took on ${apprenticeName} as an apprentice ${title}.`);
    getJournal().log(apprenticeName, "apprenticeship", `Became apprentice to ${masterName}, learning ${skill}.`);
  } catch { /* non-fatal */ }
}

function graduatePair(director, apprenticeName, p, nowMs) {
  void director;
  void nowMs;
  pairs.delete(apprenticeName);
  dirty = true;
  try {
    clearFollow(apprenticeName);
  } catch { /* non-fatal */ }
  const title = tradeTitle(p.skill);
  try {
    getJournal().log(apprenticeName, "apprenticeship", `Graduated as a ${title} under ${p.master}.`);
    getJournal().log(p.master, "apprenticeship", `${apprenticeName} graduated — a fine ${title} now.`);
  } catch { /* non-fatal */ }
}

// ============================================================================
// Visible tier: following + chatter near real players. Fast proximity tick.
// ============================================================================

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} rng - injectable rng (default Math.random)
 */
function tickApprenticeLife(director, nowMs, rng = Math.random) {
  loadPairs();
  pruneCooldowns(nowMs);
  try {
    for (const [apprentice, p] of pairs) {
      // 1. Cooldown gate — O(1), skips almost every pair.
      const last = lastChatterByApprentice.get(apprentice) || 0;
      if (nowMs - last < CHATTER_CITIZEN_COOLDOWN_MS) continue;

      // 2. Both must be materialized (near a player already).
      const rosterArr = [...(director.roster?.values?.() ?? [])];
      const apprenticeRec = rosterArr.find(
        (r) => normalizeName(r.username) === apprentice
      );
      if (!apprenticeRec) continue;
      const apprenticeBot = (director.isOnline(apprenticeRec) ? director.getBot(apprenticeRec) : null);
      if (!apprenticeBot) continue;

      // 3. A real player must be within earshot.
      if (!anyRealPlayerNear(director, apprenticeBot, CHATTER_RADIUS)) continue;

      // 4. Chance gate — then one scripted exchange (zero LLM).
      if (rng() >= CHATTER_CHANCE) continue;
      const masterRec = rosterArr.find((r) => normalizeName(r.username) === p.master);
      const masterBot = (director.isOnline(masterRec) ? director.getBot(masterRec) : null);
      try {
        { const _cvp = apprenticeBot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(apprenticeBot, voiceLine(voiceFor(_cvp), { plain: [apprenticeQuestion(rng, p.skill)] })); }
        if (masterBot) {
          // Master answers a beat later would need scheduling; same-tick
          // reply is fine — the pair reads as a conversation.
          { const _cvp = masterBot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(masterBot, voiceLine(voiceFor(_cvp), { plain: [masterTeaching(rng, p.skill)] })); }
        }
      } catch { /* non-fatal */ }
      lastChatterByApprentice.set(apprentice, nowMs);
    }
  } catch (e) {
    console.warn("[citizen-apprentices] life tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickApprenticeships,
  tickApprenticeLife,
  // Exported for tests:
  eligibleMaster,
  eligibleApprentice,
  masteredSkills,
  highestTradeLevel,
  xpPerTick,
  hasGraduated,
  tradeTitle,
  apprenticeQuestion,
  masterTeaching,
  pickOne,
  isRealPlayer,
  withinTiles,
  _pairs: pairs,
  _loadPairs: loadPairs,
};
