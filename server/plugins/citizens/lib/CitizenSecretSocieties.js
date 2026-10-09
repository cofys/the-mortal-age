"use strict";

/**
 * CitizenSecretSocieties — hidden orders in every capital.
 *
 * Three societies operate in the shadows of each kingdom:
 *   - the Gilded Ledger (merchant guild — economic: price fixing, market control)
 *   - the Shadow Circle (mysterious — whispers, secrets, quiet influence)
 *   - the Old Guard (traditionalist — veterans guarding the old ways, political sway)
 *
 * WHAT IT DOES (data tier, free):
 *   Membership is deterministic from the citizen's name hash — stable across
 *   restarts, no persistence needed. Chapters (one per society per kingdom)
 *   hold secret meetings at night; each meeting advances the chapter's agenda
 *   track, and milestones are journaled so the LLM mouth can riff on them
 *   later ("the Ledger's been buying up grain again").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   - A member whose trust in a player is high (favorite/regular standing)
 *     may extend a scripted initiation invite — whispered, deniable.
 *   - Stumble on an active meeting (night, near 2+ members of one chapter)
 *     and a member warns you off with a scripted deflection.
 *   - Initiated players are remembered; the chat/LLM layer can read
 *     societyOf()/isInitiated() to roleplay secrecy truthfully.
 *
 * Zero LLM: all visible output is scripted pools + journal quotes. The LLM
 * handles freeform secret dialogue; this module only supplies the state.
 *
 * Wired into the slow (~60s) director tick, after the relationships block.
 * Plain-node testable: CitizenSecretSocieties.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { getMemory } = require("./CitizenMemory");
const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const MEMBER_PCT = 15; // % of the roster that belongs to some society
const MEETING_INTERVAL_MS = 6 * 3600 * 1000; // a chapter meets at most this often
const MEETING_ACTIVE_MS = 10 * 60 * 1000; // a meeting "lingers" this long after firing
const AGENDA_PER_MEETING = 12; // agenda progress per meeting (0-100 scale)
const INITIATE_RADIUS = 10; // tiles — whispered, not shouted
const INITIATE_CITIZEN_COOLDOWN_MS = 24 * 3600 * 1000; // a citizen recruits at most daily
const INITIATE_PLAYER_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // a player is courted at most weekly
const INITIATE_CHANCE = 0.25; // per eligible member per ~60s tick
const DEFLECT_RADIUS = 12; // tiles — close enough to notice the gathering
const DEFLECT_CHAPTER_COOLDOWN_MS = 2 * 3600 * 1000; // a chapter warns off at most this often

// === Societies ===
const SOCIETIES = [
  {
    id: "gilded-ledger",
    name: "the Gilded Ledger",
    kind: "economic",
    blurb: "merchant princes who fix prices and buy influence",
    agenda: "corner the market",
    milestones: [
      "quietly bought up the grain contracts",
      "fixed the price of iron across the market",
      "put a ledger-man on the merchant council",
      "now sets the price of bread in the capital",
    ],
  },
  {
    id: "shadow-circle",
    name: "the Shadow Circle",
    kind: "mysterious",
    blurb: "whisper-traders in secrets and favors",
    agenda: "know everything",
    milestones: [
      "placed an ear in every tavern",
      "learned which guards take bribes",
      "traded a lord's secret for a bigger one",
      "knows something about everyone who matters",
    ],
  },
  {
    id: "old-guard",
    name: "the Old Guard",
    kind: "traditionalist",
    blurb: "veterans and traditionalists guarding the old ways",
    agenda: "restore the old order",
    milestones: [
      "drilled the young guards in the old forms",
      "blocked a reform at the council",
      "placed a veteran at the palace gate",
      "made the old oath fashionable again",
    ],
  },
];
const SOCIETY_BY_ID = new Map(SOCIETIES.map((s) => [s.id, s]));

// === State ===
const lastMeetingAt = new Map(); // chapterKey -> timestamp
const meetingActiveUntil = new Map(); // chapterKey -> timestamp
const agendaProgress = new Map(); // chapterKey -> 0..100
const lastInitiateByCitizen = new Map(); // username -> timestamp
const lastInitiateByPlayer = new Map(); // playerName -> timestamp
const initiatedPlayers = new Map(); // playerName -> societyId (they accepted... or were marked)
const lastDeflectByChapter = new Map(); // chapterKey -> timestamp

// Memory-leak plug: prune entries older than 30 days, at most hourly.
let lastPruneAt = 0;
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 30 * 24 * 3600 * 1000;
  for (const m of [
    lastMeetingAt,
    meetingActiveUntil,
    lastInitiateByCitizen,
    lastInitiateByPlayer,
    lastDeflectByChapter,
  ]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
  // Agenda progress never prunes (chapters persist); initiated players persist too.
}

// === Sky access (lazy, null-safe) — same pattern as CitizenWeatherReactions ===
let Sky = null;
function getSky() {
  if (!Sky) {
    try {
      Sky = require("../../skills/fishing/Conditions.Fishing");
    } catch {
      Sky = null;
    }
  }
  return Sky;
}
/** Test seam: inject a fake sky. */
function _setSky(fake) {
  Sky = fake;
}
function isNight() {
  try {
    const sky = getSky();
    if (!sky) return false;
    return sky.getTimeOfDay() === sky.T?.NIGHT;
  } catch {
    return false;
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash. Deterministic membership, stable across restarts. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Which society (if any) a citizen belongs to. Pure and stable: same name
 * always yields the same answer. Merchants drift toward the Gilded Ledger,
 * courtiers toward the Old Guard.
 * @returns {string|null} society id or null
 */
function societyOf(username, role) {
  if (!username) return null;
  const h = fnv1a(String(username).toLowerCase());
  if (h % 100 >= MEMBER_PCT) return null;
  let idx = (h >>> 8) % SOCIETIES.length;
  if ((h >>> 16) % 2 === 0) {
    if (role === "merchant") idx = 0;
    else if (role === "courtier") idx = 2;
  }
  return SOCIETIES[idx].id;
}

function chapterKey(kingdomId, societyId) {
  return `${kingdomId ?? "wild"}:${societyId}`;
}

/** Agenda level 0..100 for a chapter. Pure read. */
function agendaLevel(kingdomId, societyId) {
  return agendaProgress.get(chapterKey(kingdomId, societyId)) ?? 0;
}

/** True while a chapter's meeting is still "lingering". */
function meetingActive(kingdomId, societyId, nowMs = Date.now()) {
  return (meetingActiveUntil.get(chapterKey(kingdomId, societyId)) ?? 0) > nowMs;
}

/** Has this player been initiated into a society? Returns society id or null. */
function initiatedSociety(playerName) {
  if (!playerName) return null;
  return initiatedPlayers.get(normalizeName(playerName)) ?? null;
}

function isInitiated(playerName) {
  return initiatedSociety(playerName) !== null;
}

/** Standing high enough to be trusted with a secret. */
function trustedStanding(standing) {
  return standing === "favorite" || standing === "regular";
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
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
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

// === Scripted lines (zero LLM) ===
const INITIATE_LINES = {
  "gilded-ledger": [
    "*leans in* The market rewards those with... friends. We could use someone like you.",
    "Coin flows to those who know where it's going. Interested in knowing?",
    "*quietly* The Ledger always pays its friends. Think about it.",
  ],
  "shadow-circle": [
    "*voice barely above a whisper* There are things worth knowing. We know them. You could too.",
    "Everyone has secrets. We collect them. Care to be a collector?",
    "*glances around* The Circle sees you. That's... rare. Don't waste it.",
  ],
  "old-guard": [
    "The old ways are dying, friend. Men like us keep them alive. Join us.",
    "*firm nod* You carry yourself like the old stock. The Guard could use you.",
    "Tradition needs defenders. We've been watching you. We like what we see.",
  ],
};

const DEFLECT_LINES = [
  "*lowers voice* Private gathering. You saw nothing. Move along.",
  "Nothing for you here, friend. Best keep walking.",
  "*cold stare* This is not your concern. Leave.",
  "A quiet evening among friends. Nothing more. Good night.",
];

const MEETING_SPOTS = [
  "a cellar beneath the market",
  "the back room of a shuttered shop",
  "a riverside warehouse after dark",
  "the crypt under the old chapel",
  "a smoke-filled booth at the tavern's rear",
];

// ============================================================================
// Data tier: meetings + agendas. Runs on the slow (~60s) director tick.
// ============================================================================

/**
 * Advance one chapter: hold a meeting if due (night + interval elapsed),
 * journal attendees, advance the agenda, journal milestones.
 * @returns {boolean} true if a meeting was held
 */
function advanceChapter(director, kingdomId, societyId, members, nowMs, rng) {
  const key = chapterKey(kingdomId, societyId);
  const last = lastMeetingAt.get(key) ?? 0;
  if (nowMs - last < MEETING_INTERVAL_MS) return false;
  if (!isNight()) return false;
  if (members.length === 0) return false;

  lastMeetingAt.set(key, nowMs);
  meetingActiveUntil.set(key, nowMs + MEETING_ACTIVE_MS);

  const society = SOCIETY_BY_ID.get(societyId);
  const spot = pickOne(rng, MEETING_SPOTS);
  // Journal 2-3 attendees so the LLM mouth can recall meetings truthfully.
  const attendees = members.slice(0, 3);
  let journal = null;
  try {
    journal = getJournal();
  } catch {
    journal = null;
  }
  for (const m of attendees) {
    try {
      journal?.log(
        m.username,
        "society",
        `Attended a gathering of ${society.name} in ${spot}.`,
        {}
      );
    } catch {
      /* journal failures never break the tick */
    }
  }

  // Agenda progress + milestones.
  const prev = agendaProgress.get(key) ?? 0;
  const next = Math.min(100, prev + AGENDA_PER_MEETING);
  agendaProgress.set(key, next);
  const milestoneIdx = Math.floor(next / 25) - 1; // 25->0, 50->1, 75->2, 100->3
  if (next >= 25 && Math.floor(prev / 25) < Math.floor(next / 25) && journal) {
    const milestone = society.milestones[Math.min(milestoneIdx, society.milestones.length - 1)];
    const witness = attendees[0];
    if (witness && milestone) {
      try {
        journal.log(
          witness.username,
          "society",
          `${society.name} ${milestone} — the agenda advances.`,
          {}
        );
      } catch {
        /* never break the tick */
      }
    }
  }
  if (next >= 100) {
    // Agenda fulfilled: the world feels it, then the chapter starts a new scheme.
    if (journal && attendees[0]) {
      try {
        journal.log(
          attendees[0].username,
          "society",
          `${society.name} has ${society.agenda}! A new scheme begins.`,
          {}
        );
      } catch {
        /* never break the tick */
      }
    }
    agendaProgress.set(key, 0);
  }
  return true;
}

/**
 * The tick function. Called from the slow director tick.
 * Gate order: prune -> chapters (meetings/agendas, data tier) ->
 * proximity-visible: initiation invites + meeting discovery (cheap gates first).
 */
function tickSocieties(director, nowMs) {
  pruneState(nowMs);
  let rng;
  try {
    rng = require("./humanizer").agentRng;
  } catch {
    rng = Math.random;
  }

  // 1. Group member citizens by chapter (data tier — no player needed).
  const chapters = new Map(); // chapterKey -> { kingdomId, societyId, members: [] }
  let roster = [];
  try {
    roster = [...(director.roster?.values?.() ?? [])];
  } catch {
    roster = [];
  }
  for (const record of roster) {
    const sid = societyOf(record.username, record.role);
    if (!sid) continue;
    const key = chapterKey(record.kingdomId, sid);
    if (!chapters.has(key)) {
      chapters.set(key, { kingdomId: record.kingdomId, societyId: sid, members: [] });
    }
    chapters.get(key).members.push(record);
  }

  // 2. Advance chapters (meetings + agendas). Pure data tier.
  for (const { kingdomId, societyId, members } of chapters.values()) {
    try {
      advanceChapter(director, kingdomId, societyId, members, nowMs, rng);
    } catch (e) {
      console.warn("[citizen-societies] chapter advance failed:", e?.message ?? e);
    }
  }

  // 3. Proximity-visible layer: initiation invites + stumbled-upon meetings.
  let players = [];
  try {
    players = director.onlinePlayers?.() ?? [];
  } catch {
    players = [];
  }
  const realPlayers = players.filter(isRealPlayer);
  if (realPlayers.length === 0) return;

  let memory = null;
  try {
    memory = getMemory();
  } catch {
    memory = null;
  }

  for (const record of roster) {
    const sid = societyOf(record.username, record.role);
    if (!sid) continue;
    let citizen = null;
    try {
      citizen = director.playerFor?.(record);
    } catch {
      citizen = null;
    }
    if (!citizen) continue;

    // 3a. Initiation: a trusted player nearby may be quietly recruited.
    try {
      const lastInit = lastInitiateByCitizen.get(record.username) ?? 0;
      if (nowMs - lastInit >= INITIATE_CITIZEN_COOLDOWN_MS) {
        for (const p of realPlayers) {
          if (!withinTiles(citizen, p, INITIATE_RADIUS)) continue;
          const pname = p.getUsername?.();
          if (!pname || isInitiated(pname)) continue;
          if ((lastInitiateByPlayer.get(normalizeName(pname)) ?? 0) > nowMs - INITIATE_PLAYER_COOLDOWN_MS)
            continue;
          let standing = "neutral";
          try {
            standing = memory?.standing?.(record.username, pname, nowMs) ?? "neutral";
          } catch {
            standing = "neutral";
          }
          if (!trustedStanding(standing)) continue;
          if (rng() >= INITIATE_CHANCE) continue;
          const line = pickOne(rng, INITIATE_LINES[sid] ?? DEFLECT_LINES);
          try {
            { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
          } catch {
            /* visible output failures never break the tick */
          }
          lastInitiateByCitizen.set(record.username, nowMs);
          lastInitiateByPlayer.set(normalizeName(pname), nowMs);
          // Mark the player as courted — the LLM layer decides what "accepted" means.
          initiatedPlayers.set(normalizeName(pname), sid);
          try {
            getJournal()?.log(
              record.username,
              "society",
              `Quietly sounded out ${pname} for ${SOCIETY_BY_ID.get(sid).name}.`,
              {}
            );
          } catch {
            /* never break the tick */
          }
          break; // one recruitment per citizen per tick
        }
      }
    } catch (e) {
      console.warn("[citizen-societies] initiation failed:", e?.message ?? e);
    }

    // 3b. Stumbled upon: an active meeting + 2+ members near a real player.
    try {
      const key = chapterKey(record.kingdomId, sid);
      if (
        meetingActive(record.kingdomId, sid, nowMs) &&
        (lastDeflectByChapter.get(key) ?? 0) <= nowMs - DEFLECT_CHAPTER_COOLDOWN_MS
      ) {
        const membersHere = chapters.get(key)?.members ?? [];
        let memberCount = 0;
        for (const m of membersHere) {
          let mc = null;
          try {
            mc = director.playerFor?.(m);
          } catch {
            mc = null;
          }
          if (mc) memberCount++;
          if (memberCount >= 2) break;
        }
        if (memberCount >= 2) {
          for (const p of realPlayers) {
            if (!withinTiles(citizen, p, DEFLECT_RADIUS)) continue;
            if (isInitiated(p.getUsername?.())) continue; // members may watch
            try {
              { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: DEFLECT_LINES }, rng)); }
            } catch {
              /* never break the tick */
            }
            lastDeflectByChapter.set(key, nowMs);
            break;
          }
        }
      }
    } catch (e) {
      console.warn("[citizen-societies] deflect failed:", e?.message ?? e);
    }
  }
}

module.exports = {
  tickSocieties,
  // Pure helpers + state readers for tests and the LLM/chat layer:
  societyOf,
  chapterKey,
  agendaLevel,
  meetingActive,
  initiatedSociety,
  isInitiated,
  trustedStanding,
  isRealPlayer,
  withinTiles,
  pickOne,
  fnv1a,
  SOCIETIES,
  // Test seams:
  _setSky,
  _state: {
    lastMeetingAt,
    meetingActiveUntil,
    agendaProgress,
    lastInitiateByCitizen,
    lastInitiateByPlayer,
    initiatedPlayers,
    lastDeflectByChapter,
  },
};
