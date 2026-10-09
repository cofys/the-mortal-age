"use strict";

/**
 * CitizenRetirement — elders retire, and the community honors them.
 *
 * Elderly citizens (age 60+) retire from active trade work and become
 * community elders: storytellers who share kingdom history with the young,
 * advisors whose wisdom the LLM chat layer can quote, and keepers of lore.
 *
 * Data tier (free, background): eligibility is computed from roster data
 * (personality.age, role); retirement ceremonies, stories, and deference are
 * decided on the proximity tick but journaled, so news spreads for free.
 *
 * Interaction tier (only near real players): the retirement ceremony
 * (scripted speeches + gift, nearby citizens gather in forceChat), elder
 * storytelling, wisdom lines, and younger citizens visibly deferring to
 * elders ("*bows to Elder X*").
 *
 * Zero LLM: every visible line is a scripted frame or pool pick. The LLM
 * handles deep elder wisdom dialogue in the chat layer; this module journals
 * everything so it can riff truthfully ("they retired last week").
 *
 * Wired into the director proximity tick after the apprentice block.
 * Plain-node testable: CitizenRetirement.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");
const { agentRng, chance } = require("./humanizer");
const { brainTickDue } = require("./CitizenTickLod");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning ===
const RETIREMENT_AGE = 60; // matches the "elderly" cutoff in movementStyleFor
const CEREMONY_RADIUS = 14; // tiles — close enough to witness
const STORY_RADIUS = 14;
const DEFERENCE_RADIUS = 10;
const CEREMONY_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // a citizen retires once (effectively)
const STORY_COOLDOWN_MS = 2 * 3600 * 1000; // an elder tells stories at most this often
const WISDOM_COOLDOWN_MS = 90 * 60 * 1000; // wisdom lines
const DEFERENCE_COOLDOWN_MS = 4 * 3600 * 1000; // per deferring citizen
let CEREMONY_CHANCE = 0.5; // per eligible elder per proximity tick
let STORY_CHANCE = 0.35;
let WISDOM_CHANCE = 0.3;
let DEFERENCE_CHANCE = 0.25;

// Trades citizens retire from. Courtiers advise for life; refugees have no trade.
const RETIRABLE_ROLES = new Set(["guard", "merchant", "commoner"]);

// === State ===
const lastCeremonyByCitizen = new Map(); // username -> timestamp
const lastStoryByCitizen = new Map();
const lastWisdomByCitizen = new Map();
const lastDeferenceByCitizen = new Map();
const retiredCitizens = new Set(); // normalized usernames — the elders

// Memory-leak plug: prune entries older than the longest cooldown window,
// at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 8 * 24 * 3600 * 1000;
  for (const m of [
    lastCeremonyByCitizen,
    lastStoryByCitizen,
    lastWisdomByCitizen,
    lastDeferenceByCitizen,
  ]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

// ============================================================================
// Pure helpers — testable with plain node.
// ============================================================================

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

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

/** Journal one line, never throw. */
function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

/** The citizen's age from personality data (default 35). */
function ageOf(record) {
  return Number(record?.personality?.age ?? 35);
}

/** True for citizens old enough to retire (60+, or the elderly trait). */
function isElder(record) {
  const traits = new Set(record?.personality?.traits ?? []);
  if (traits.has("elderly")) return true;
  return ageOf(record) >= RETIREMENT_AGE;
}

/** True for roles citizens actually retire from. */
function isRetirableRole(role) {
  return RETIRABLE_ROLES.has(String(role ?? "").toLowerCase());
}

/** Has this citizen already held their retirement ceremony? */
function isRetired(username) {
  return retiredCitizens.has(normalizeName(username));
}

function markRetired(username) {
  retiredCitizens.add(normalizeName(username));
}

/**
 * Chance gate on top of a cooldown: pure (rng, lastMs, nowMs, cooldown, chance).
 */
function shouldFire(rng, lastMs, nowMs, cooldownMs, fireChance) {
  if (nowMs - (lastMs || 0) < cooldownMs) return false;
  return rng() < fireChance;
}

/** Scripted kingdom-history stories for elders to tell. */
const STORIES = [
  "I was just a bairn when they raised these walls. Took nine summers, and the mortar froze twice.",
  "The winter the river froze, we hauled grain across the ice by sled. Lost two good oxen to the thaw.",
  "Before the market charter, we traded out of carts in the mud. You young ones have it easy.",
  "I fought in the border skirmishes, aye. Came home with this limp and three friends fewer.",
  "The old king once drank in that very tavern. Bought the whole room a round and sang off-key.",
  "Plague year, we rang the bell from dusk to dawn. Half the street empty by spring.",
  "My grandmother kept the lighthouse books. Every ship that ever docked, in her hand.",
  "The great fire took the east row in a night. We rebuilt it straighter, and nobody misses the old lean.",
  "I apprenticed at twelve and mastered at thirty. Slow hands, steady work — that is the whole secret.",
  "The harvest festival used to last a full week. Danced till my boots gave out, every year.",
];

function pickStory(rng) {
  return pickOne(rng, STORIES);
}

/** Scripted elder wisdom — short, quotable, advisory. */
const WISDOMS = [
  "Measure twice, cut once. Applies to timber, coin, and words.",
  "A full purse never bought a good night's sleep.",
  "The patient farmer outlasts the clever merchant. Every time.",
  "Listen more than you speak, and you will rarely be wrong.",
  "Debts of kindness are the only ones worth keeping.",
  "Storms pass. Roofs can be rebuilt. People cannot.",
  "If you must choose, choose the slower road with the better company.",
  "Gold spends. Reputation compounds.",
];

function pickWisdom(rng) {
  return pickOne(rng, WISDOMS);
}

const DEFERENCE_FRAMES = [
  "Evening, Elder {elder}. The town is better with you in it.",
];

function pickDeference(rng, elderName) {
  return pickOne(rng, DEFERENCE_FRAMES).replace("{elder}", elderName);
}

const CEREMONY_HOST_FRAMES = [
  "Friends! We gather to honor {elder}, who hangs up their {trade} tools after {years} years!",
  "Hear me, all! Today {elder} retires from the {trade} trade. Raise your cups!",
  "Come close, everyone — {elder} has worked this town for {years} years, and today we thank them properly.",
];

const CEREMONY_ELDER_FRAMES = [
  "I have given this town my working years, and it gave me everything back. Thank you.",
  "My hands are slower now, but my heart is full. Look after each other.",
  "I retire from the work, not from you. You will still find me by the fire, telling the old stories.",
];

const CEREMONY_GIFT_FRAMES = [
  "The town presents {elder} with a carved walking staff, that the road stays kind.",
  "We gift {elder} a bound book of the town's history — their name first on the page.",
  "The {trade} guild presents {elder} with a silver token, good for a warm meal anywhere in town, forever.",
];

const CEREMONY_CHEER_FRAMES = [
  "To Elder {elder}! *glasses raised*",
];

/**
 * Build the ceremony script: [{ speaker: "host"|"elder"|"crowd"|name, text }].
 * Pure — the tick decides who speaks which line.
 */
function ceremonyScript(rng, elderName, trade) {
  const years = 25 + Math.floor(rng() * 20);
  const tradeName = String(trade ?? "trade").toLowerCase();
  return [
    {
      speaker: "host",
      text: pickOne(rng, CEREMONY_HOST_FRAMES)
        .replace("{elder}", elderName)
        .replace("{trade}", tradeName)
        .replace("{years}", String(years)),
    },
    {
      speaker: "elder",
      text: pickOne(rng, CEREMONY_ELDER_FRAMES),
    },
    {
      speaker: "host",
      text: pickOne(rng, CEREMONY_GIFT_FRAMES)
        .replace("{elder}", elderName)
        .replace("{trade}", tradeName),
    },
    {
      speaker: "crowd",
      text: pickOne(rng, CEREMONY_CHEER_FRAMES).replace("{elder}", elderName),
    },
  ];
}

// ============================================================================
// The tick — called from the director proximity tick.
// Gate order: cooldown → materialized → real player near → work.
// ============================================================================

/** Real players within radius of the bot (engine local-player list). */
function realPlayersNear(bot, radius) {
  let locals = [];
  try {
    locals = [...(bot.getLocalPlayers?.() ?? [])];
  } catch {
    return [];
  }
  return locals.filter((p) => p !== bot && isRealPlayer(p) && withinTiles(bot, p, radius));
}

/** Other materialized citizen bots of the same kingdom within radius. */
function citizensNear(director, bot, kingdomId, radius) {
  const out = [];
  try {
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdomId !== kingdomId) continue;
      const other = director.getBot?.(record);
      if (!other || other === bot) continue;
      if (withinTiles(bot, other, radius)) out.push({ record, bot: other });
    }
  } catch {
    // Roster iteration hiccup — carry on with whoever we found.
  }
  return out;
}

function say(bot, text) {
  try {
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
  } catch {
    // A shy elder.
  }
}

/**
 * Run one retirement ceremony: host announces, elder speaks, gift given,
 * crowd cheers. Attendees are other same-kingdom citizens in earshot; the
 * real player witnesses. Journals the retirement for gossip + LLM truth.
 */
function runCeremony(director, record, bot, nowMs) {
  const rng = agentRng(`retire:${record.username}:${nowMs}`);
  const elderName = record.username;
  const script = ceremonyScript(rng, elderName, record.role);

  const attendees = citizensNear(director, bot, record.kingdomId, CEREMONY_RADIUS).slice(0, 4);
  const host = attendees.length > 0 ? attendees[0].bot : bot;

  for (const line of script) {
    if (line.speaker === "elder") say(bot, line.text);
    else if (line.speaker === "host") say(host, line.text);
    else {
      // crowd: a random attendee, or the host if the elder stands alone
      const voice = attendees.length > 1 ? pickOne(random, attendees.slice(1)).bot : host;
      say(voice, line.text);
    }
  }

  markRetired(elderName);
  lastCeremonyByCitizen.set(normalizeName(elderName), nowMs);
  journalEvent(
    elderName,
    `Retired from the ${record.role} trade in a town ceremony; now a community elder.`,
    "social"
  );
  for (const a of attendees) {
    journalEvent(
      a.record.username,
      `Attended Elder ${elderName}'s retirement ceremony.`,
      "social",
      { with: elderName }
    );
  }
}

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional {tick, spread} from CitizenTimingDesync
 * @param {function} [rng] - optional rng (test seam; defaults to Math.random)
 */
function tickRetirement(director, nowMs, desync, rng) {
  const random = rng ?? Math.random;
  pruneCooldowns(nowMs);
  let desyncGate = null;
  try {
    desyncGate = desync ? require("./CitizenTimingDesync").isCitizenDue : null;
  } catch {
    desyncGate = null;
  }

  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // LOD brain gate: distant citizens process retirement less often
        // (near-band and unclassified always due: unchanged).
        if (!brainTickDue(director, record, desync?.tick)) continue;
        // Desync: spread citizen processing across the tick cycle.
        if (desyncGate && !desyncGate(record, desync.tick, desync.spread)) continue;

        const bot = (director.isOnline(record) ? director.getBot(record) : null) ?? director.getBot?.(record);
        if (!bot) continue;

        const key = normalizeName(record.username);
        const retired = isRetired(record.username);
        const elder = retired || isElder(record);
        const players = realPlayersNear(bot, STORY_RADIUS);
        const witnessed = players.length > 0;

        // 1. Retirement ceremony — once per citizen, needs a witness.
        if (
          !retired &&
          isElder(record) &&
          isRetirableRole(record.role) &&
          witnessed &&
          shouldFire(random, lastCeremonyByCitizen.get(key) || 0, nowMs, CEREMONY_COOLDOWN_MS, CEREMONY_CHANCE)
        ) {
          runCeremony(director, record, bot, nowMs);
          continue;
        }

        // 2. Elder storytelling — elders share history where players can hear.
        if (
          elder &&
          witnessed &&
          shouldFire(random, lastStoryByCitizen.get(key) || 0, nowMs, STORY_COOLDOWN_MS, STORY_CHANCE)
        ) {
          say(bot, pickStory(random));
          lastStoryByCitizen.set(key, nowMs);
          journalEvent(record.username, "Told a story of the old days.", "social");
          continue;
        }

        // 3. Elder wisdom — short advisory lines near players.
        if (
          elder &&
          witnessed &&
          shouldFire(random, lastWisdomByCitizen.get(key) || 0, nowMs, WISDOM_COOLDOWN_MS, WISDOM_CHANCE)
        ) {
          say(bot, pickWisdom(random));
          lastWisdomByCitizen.set(key, nowMs);
          continue;
        }

        // 4. Deference — younger citizens visibly respect nearby elders.
        if (
          !elder &&
          shouldFire(random, lastDeferenceByCitizen.get(key) || 0, nowMs, DEFERENCE_COOLDOWN_MS, DEFERENCE_CHANCE)
        ) {
          const elders = citizensNear(director, bot, record.kingdomId, DEFERENCE_RADIUS).filter((c) =>
            isRetired(c.record.username)
          );
          if (elders.length > 0 && witnessed) {
            const honored = elders[0].record.username;
            say(bot, pickDeference(random, honored));
            lastDeferenceByCitizen.set(key, nowMs);
          }
        }
      } catch {
        // One citizen's retirement must never break the loop.
      }
    }
  } catch (e) {
    console.warn("[citizen-retirement] tick failed:", e?.message ?? e);
  }
}

/** One-line status for debugging. */
function retirementStatus() {
  const out = [];
  for (const name of retiredCitizens) out.push(`elder: ${name}`);
  return out.join(", ") || "no elders yet";
}

function resetForTests() {
  lastCeremonyByCitizen.clear();
  lastStoryByCitizen.clear();
  lastWisdomByCitizen.clear();
  lastDeferenceByCitizen.clear();
  retiredCitizens.clear();
  lastPruneAt = 0;
  CEREMONY_CHANCE = 0.5;
  STORY_CHANCE = 0.35;
  WISDOM_CHANCE = 0.3;
  DEFERENCE_CHANCE = 0.25;
}

module.exports = {
  tickRetirement,
  retirementStatus,
  // Pure helpers for tests:
  ageOf,
  isElder,
  isRetirableRole,
  isRetired,
  markRetired,
  shouldFire,
  pickStory,
  pickWisdom,
  pickDeference,
  ceremonyScript,
  isRealPlayer,
  withinTiles,
  // Test seam:
  resetForTests,
};
