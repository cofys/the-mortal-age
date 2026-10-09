"use strict";

/**
 * CitizenScienceLife — slow-tick dynamics for experimental science.
 *
 * Runs on the director's slow tick (~60s). For each kingdom it:
 *   - Auto-registers scientists: citizens whose best field skill is 30+
 *     (herblore → medicine/alchemy, farming → agriculture, smithing →
 *     metallurgy). Astronomy needs curiosity, not a skill.
 *   - Advances running experiments (real time on the slow tick). When an
 *     experiment completes, the finding is resolved: success chance scales
 *     with the scientist's skill over the requirement (40% base + 2%/level,
 *     cap 95%). Success records a persistent discovery; high-skill findings
 *     (70+) are peer-reviewed automatically.
 *   - Announces breakthroughs via sayPublic near real players, journals them
 *     (kind "discovery"), and awards the "scientist" reputation deed.
 *   - Revokes overdue grants (30 days without a publication).
 *
 * Defensive throughout: missing journal, missing sayPublic, or a broken
 * engine API degrades to silent progress, never throws.
 */

const Science = require("./CitizenScience");

const ANNOUNCE_COOLDOWN_MS = 6 * 3600 * 1000; // 6h per kingdom
const lastAnnounceByKingdom = new Map();

function journalize(kind, text) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(kind, text);
  } catch { /* journal is best-effort */ }
}

function awardDeed(username, deedKind) {
  try {
    const Rep = require("./CitizenReputation");
    Rep.awardDeed?.(username, deedKind);
  } catch { /* reputation is best-effort */ }
}

function announceNearPlayers(director, text, kingdomId) {
  try {
    const now = Date.now();
    const last = lastAnnounceByKingdom.get(kingdomId) ?? 0;
    if (now - last < ANNOUNCE_COOLDOWN_MS) return;
    const { sayPublic } = require("../chat/CitizenSayPublic");
    // Find any online scientist in this kingdom to speak the line.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (String(record.kingdomId ?? "") !== String(kingdomId)) continue;
        if (!director.isOnline?.(record)) continue;
        const bot = director.getBot?.(record);
        if (!bot) continue;
        sayPublic(bot, text);
        lastAnnounceByKingdom.set(kingdomId, now);
        return;
      } catch { /* one bad citizen never breaks the tick */ }
    }
  } catch { /* speech is best-effort */ }
}

/** Best field skill level for a record's bot, or 0 (offline = unreadable). */
function skillLevelOf(director, record, skill) {
  try {
    if (!director.isOnline?.(record)) return 0; // honest: no bot, no skill read
    const bot = director.getBot?.(record);
    if (!bot || !skill) return 0;
    return bot?.getSkills?.()?.getLevel?.(skill) ?? bot?.skills?.[skill] ?? 0;
  } catch {
    return 0;
  }
}

function kingdomIdOf(director, record) {
  try {
    return record.kingdomId ?? director.kingdomIdOf?.(record) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Curiosity check for astronomy (no skill): reads the bot's personality traits. */
function isCuriousBot(director, record) {
  try {
    if (!director.isOnline?.(record)) return false;
    const bot = director.getBot?.(record);
    if (!bot) return false;
    const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
    const p = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    const traits = p.traits ?? [];
    return traits.includes("curious") || traits.includes("adventurous");
  } catch {
    return false;
  }
}

/** Register eligible scientists from the roster (real skill levels). */
function tickScientistRegistration(director) {
  for (const record of director.roster?.values?.() ?? []) {
    try {
      const username = record.username;
      if (!username) continue;
      if (Science.scientistFor(username)) continue;
      // Pick the field matching their best eligible skill.
      let bestField = null;
      let bestLevel = 0;
      for (const field of Science.FIELD_IDS) {
        const skill = Science.FIELDS[field].skill;
        if (!skill) continue;
        const lvl = skillLevelOf(director, record, skill);
        if (lvl >= Science.SCIENTIST_MIN_LEVEL && lvl > bestLevel) {
          bestLevel = lvl;
          bestField = field;
        }
      }
      // Astronomy needs curiosity, not a skill.
      if (!bestField && isCuriousBot(director, record)) {
        bestField = Science.FIELD_ASTRONOMY;
        bestLevel = 35; // curious observers start as competent stargazers
      }
      if (bestField) {
        Science.registerScientist(username, bestField);
        Science.setSkillLevel(username, bestLevel);
      }
    } catch { /* one bad record never breaks the tick */ }
  }
}

/** Resolve a completed experiment: success roll → discovery. */
function resolveExperiment(director, exp) {
  const tmpl = Science.experiment(exp.templateId);
  if (!tmpl) {
    Science.completeExperiment(exp.id, false);
    return;
  }
  const rec = Science.scientistFor(exp.scientist);
  const level = rec?.skillLevel ?? 1;
  const chance = Math.min(0.4 + Math.max(0, level - tmpl.levelReq) * 0.02, 0.95);
  const success = Math.random() < chance;
  Science.completeExperiment(exp.id, success);
  if (!success) {
    journalize("experiment", `${exp.scientist}'s ${tmpl.name} failed — the hypothesis did not hold.`);
    return;
  }
  const verified = level >= Science.PEER_REVIEW_LEVEL;
  const disc = Science.recordDiscovery(tmpl.discoveryId, exp.scientist, exp.kingdomId, verified);
  const def = Science.DISCOVERIES[tmpl.discoveryId];
  Science.publish(exp.scientist, `${tmpl.name}: ${def?.name ?? tmpl.discoveryId}`, tmpl.field, verified);
  awardDeed(exp.scientist, "scientist");
  journalize(
    "discovery",
    `${exp.scientist} discovered ${def?.name ?? tmpl.discoveryId} (${tmpl.field})${verified ? " — peer-reviewed" : ""}.`
  );
  announceNearPlayers(
    director,
    `*rings a bell* Breakthrough! ${exp.scientist} has discovered ${def?.name ?? "something new"}!`,
    exp.kingdomId
  );
}

/** Advance all running experiments; resolve completed ones. */
function tickExperiments(director) {
  const st = Science.load();
  for (const exp of Object.values(st.experiments)) {
    try {
      if (exp.status !== "running") continue;
      Science.advanceExperiment(exp.id, 1);
      if (exp.progress >= exp.ticks) resolveExperiment(director, exp);
    } catch { /* one bad experiment never breaks the tick */ }
  }
}

/** Revoke grants whose scientist published nothing within 30 days. */
function tickGrants() {
  const st = Science.load();
  const now = Date.now();
  for (const [id, grant] of Object.entries(st.grants)) {
    try {
      if (grant.published) continue;
      if (now - grant.grantedAt > 30 * 24 * 3600 * 1000) {
        delete st.grants[id];
        journalize("grant", `${grant.scientist}'s research grant expired unfruitful — future funding will be harder.`);
      }
    } catch { /* one bad grant never breaks the tick */ }
  }
}

function tickScience(director, nowMs) {
  try {
    tickScientistRegistration(director);
    tickExperiments(director);
    tickGrants();
  } catch { /* the science tick never throws */ }
}

function resetForTests() {
  lastAnnounceByKingdom.clear();
}

module.exports = {
  tickScience,
  resetForTests,
  // test seams
  _resolveExperiment: resolveExperiment,
};
