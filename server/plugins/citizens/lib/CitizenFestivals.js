"use strict";

/**
 * CitizenFestivals — citizens organize and join seasonal festivals.
 *
 * WHAT IT DOES (data tier, free):
 *   A realm-wide festival calendar (5 annual festivals, real-world dates,
 *   3-day windows each). Every roster citizen journals their participation
 *   once per festival — that shared history feeds gossip, toasts, and the
 *   LLM when a player asks "how was Harvest Home?".
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Citizens near a player during a festival cheer, dance (emote 866),
 *   grumble (if that's their personality), and invite the player to join.
 *   Lines are personality-gated: warm citizens love festivals, gruff ones
 *   complain about the noise, everyone else is mild.
 *
 * Zero LLM: the calendar is pure date math; visible output is scripted
 * forceChat frames with personality-gated pools. The LLM only picks up
 * the journaled history later, like it does for toasts.
 *
 * Wired into the slow director tick next to CitizenToasts. Plain-node
 * testable: CitizenFestivals.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");
const { agentRng } = require("./humanizer");

// === Tuning: all magic numbers here ===
const FESTIVAL_DURATION_DAYS = 3; // each festival runs 3 days
const FESTIVAL_CHAT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // a citizen cheers at most every 2h
const FESTIVAL_DANCE_CHANCE = 0.35; // excited citizens dance on their tick
const FESTIVAL_INVITE_CHANCE = 0.25; // chance the line is a player invite instead
const FESTIVAL_RADIUS = 14; // tiles — close enough to see/hear the celebration
const DANCE_ANIMATION_ID = 866; // engine dance emote (Emotes.ts)

// === Festival calendar: month is 0-indexed (0 = January) ===
const FESTIVALS = Object.freeze([
  {
    id: "founding-day",
    name: "Founding Day",
    month: 0,
    startDay: 15,
    mood: "proud",
    blurb: "the kingdom's founding",
  },
  {
    id: "springtide",
    name: "Springtide Bloom",
    month: 3,
    startDay: 20,
    mood: "hopeful",
    blurb: "the planting season",
  },
  {
    id: "midsummer",
    name: "Midsummer Revel",
    month: 6,
    startDay: 1,
    mood: "wild",
    blurb: "the longest day",
  },
  {
    id: "harvest-home",
    name: "Harvest Home",
    month: 9,
    startDay: 7,
    mood: "grateful",
    blurb: "the harvest",
  },
  {
    id: "embernight",
    name: "Embernight",
    month: 11,
    startDay: 21,
    mood: "cozy",
    blurb: "the longest night",
  },
]);

// === Personality-gated line pools ===
const FESTIVAL_LINES = Object.freeze({
  excited: [
    "Happy {festival}! Best days of the year!",
    "*dances* {festival} at last! Come on, everyone's out!",
    "I waited all year for {festival}! Isn't it wonderful?",
    "{festival}! The square's packed — you should see the stalls!",
  ],
  grumbly: [
    "Bah. {festival} again. All this noise...",
    "*grumbles* {festival}. Can't get a moment's peace.",
    "Enjoy your {festival}. I'll be inside.",
    "{festival}, they call it. Just an excuse to drink, if you ask me.",
  ],
  mild: [
    "Happy {festival}, friend.",
    "Out for {festival}? The square's lively today.",
    "{festival} always brings the town together.",
    "Nice day for {festival}, isn't it?",
  ],
});

const FESTIVAL_INVITES = Object.freeze({
  excited: [
    "You! Yes you — come join the {festival} dancing!",
    "Don't just stand there! It's {festival} — dance with us!",
    "{festival} is better with company. Join in!",
  ],
  grumbly: [
    "Don't let me stop you. Everyone else is out for {festival}.",
    "Go on, enjoy {festival}. Someone should.",
  ],
  mild: [
    "Care to join the {festival} festivities?",
    "There's room by the fire for {festival}, if you'd like.",
  ],
});

// === Cooldown state ===
const lastChatByCitizen = new Map(); // username -> timestamp
const journaledFestivals = new Map(); // `${username}:${festivalId}:${year}` -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastChatByCitizen) {
    if (at < cutoff) lastChatByCitizen.delete(k);
  }
  for (const [k, at] of journaledFestivals) {
    if (at < cutoff) journaledFestivals.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Which festival (if any) is active right now. Pure date math — free.
 * @param {number} nowMs - Date.now()
 * @returns {object|null} the active festival def, or null
 */
function activeFestival(nowMs) {
  const d = new Date(nowMs);
  const month = d.getMonth();
  const day = d.getDate();
  for (const f of FESTIVALS) {
    if (f.month !== month) continue;
    if (day >= f.startDay && day < f.startDay + FESTIVAL_DURATION_DAYS) {
      return f;
    }
  }
  return null;
}

/**
 * Festival "voice": how this citizen feels about festivals. Pure.
 * warm traits → excited; gruff/cold/surly → grumbly; everyone else → mild.
 */
function voiceOf(personality) {
  const traits = new Set(personality?.traits ?? []);
  if (
    traits.has("cheerful") ||
    traits.has("easygoing") ||
    traits.has("proud") ||
    traits.has("devout")
  ) {
    return "excited";
  }
  if (
    traits.has("gruff") ||
    traits.has("taciturn") ||
    traits.has("suspicious") ||
    traits.has("greedy")
  ) {
    return "grumbly";
  }
  return "mild";
}

/** Fill the {festival} placeholder in a line. */
function fillLine(line, festival) {
  return String(line).replace("{festival}", festival.name);
}

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
    return (
      Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <=
      radius
    );
  } catch {
    return false;
  }
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// The tick function — called from the slow director tick.
// Gate order: festival active? → journal (cheap, data tier) → citizen exists
// → real player near → chat cooldown → visible celebration.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickFestivals(director, nowMs) {
  pruneCooldowns(nowMs);
  const festival = activeFestival(nowMs);
  if (!festival) return;
  const year = new Date(nowMs).getFullYear();

  try {
    const rng = agentRng(`festivals:${festival.id}:${year}:${Math.floor(nowMs / 3600000)}`);
    for (const record of director.roster?.values?.() ?? []) {
      const username = record?.username;
      if (!username) continue;

      // 1. Data tier (free): journal participation once per festival.
      //    This is the shared history the LLM and gossip systems read later.
      const journalKey = `${normalizeName(username)}:${festival.id}:${year}`;
      if (!journaledFestivals.has(journalKey)) {
        journaledFestivals.set(journalKey, nowMs);
        journalEvent(
          username,
          `Celebrated ${festival.name} (${festival.blurb}) in ${record.kingdomId ?? "the realm"}.`,
          "social"
        );
      }

      // 2. Interaction tier: citizen must be materialized (near a player already).
      const citizen = director.playerFor?.(record);
      if (!citizen) continue;

      // 3. A real player must be within earshot.
      if (!anyRealPlayerNear(director, citizen, FESTIVAL_RADIUS)) continue;

      // 4. Chat cooldown gate.
      const key = normalizeName(username);
      if (nowMs - (lastChatByCitizen.get(key) ?? 0) < FESTIVAL_CHAT_COOLDOWN_MS) {
        continue;
      }

      // 5. Celebrate: personality-gated line, maybe an invite, maybe a dance.
      const voice = voiceOf(record.personality);
      const useInvite = rng() < FESTIVAL_INVITE_CHANCE;
      const pool = useInvite ? FESTIVAL_INVITES[voice] : FESTIVAL_LINES[voice];
      const line = fillLine(pickOne(rng, pool ?? FESTIVAL_LINES.mild), festival);
      lastChatByCitizen.set(key, nowMs);
      try {
        citizen.forceChat?.(line.slice(0, 120));
      } catch {
        // A shy celebrant.
      }

      // Excited citizens dance. Grumbly ones never do.
      if (voice === "excited" && rng() < FESTIVAL_DANCE_CHANCE) {
        try {
          const Anim = director?.api?.core?.Animation;
          if (Anim && citizen.performAnimation) {
            citizen.performAnimation(new Anim(DANCE_ANIMATION_ID));
          }
        } catch {
          // Dancing is optional.
        }
      }
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-festivals] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** One-line status for debugging. */
function festivalStatus() {
  const out = [];
  for (const [k, at] of lastChatByCitizen) {
    out.push(`${k}: last cheer ${new Date(at).toISOString()}`);
  }
  return out;
}

function resetForTests() {
  lastChatByCitizen.clear();
  journaledFestivals.clear();
  lastPruneAt = 0;
}

module.exports = {
  tickFestivals,
  // Exported for tests:
  activeFestival,
  voiceOf,
  fillLine,
  pickOne,
  isRealPlayer,
  withinTiles,
  FESTIVALS,
  FESTIVAL_LINES,
  FESTIVAL_INVITES,
  _test: { resetForTests, festivalStatus, journaledFestivals, lastChatByCitizen },
};
