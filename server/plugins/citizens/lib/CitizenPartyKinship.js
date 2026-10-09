"use strict";

/**
 * CitizenPartyKinship — kinship consequences for activity parties.
 *
 * Real people don't march off with someone they're openly feuding with,
 * and they don't leave their spouse behind. Citizens were doing both:
 * CitizenActivityParties formed crews from CitizenBonds (friends/enemies)
 * but never consulted CitizenKinship — so two citizens in an OPEN feud
 * could happily go fishing together, and a married couple could split
 * across two parties without anyone blinking.
 *
 * Two-tier by construction, zero LLM:
 *   - Formation: open-feud candidates are excluded from the companion
 *     list (leader AND between already-picked companions), the leader's
 *     spouse/partner is moved to the front of the queue. When someone is
 *     left out and real players are watching, the leader says why —
 *     a scripted, personality-gated forceChat line.
 *   - Mid-party: if a feud escalates to "open" while the rivals share a
 *     party, the non-leader member storms off (leaveParty + clearFollow,
 *     a parting line for witnesses, journal entries both sides).
 *   - The data-tier records everything in the journal, so the LLM mouth
 *     can riff on it later ("I'm not marching with Harek. Ask him why.")
 *
 * Pure helpers (kinOrder, refusalLine, stormOffCandidate, stormOffLine)
 * take an injected kin adapter { isOpenFeud, spouseOf, partnerOf } so the
 * unit test never touches the real kinship store. The integration
 * functions (maybeRefusalLine, maybeStormOff) wire the real store and
 * are called from CitizenActivityParties.
 */

const { normalizeName } = require("./CitizenBonds");
const { warmthOf } = require("../StreetNotices");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


const REFUSAL_LINE_COOLDOWN_MS = 6 * 3600 * 1000; // a leader explains themselves at most this often
const MAX_STORMED_PAIRS = 16; // per-party bound on remembered storm-offs

const lastRefusalLineAt = new Map(); // leader key -> timestamp

// Memory-leak plug: prune the cooldown map at most hourly, drop entries
// older than a day. Party storm-off history lives on the party object,
// which dies with the party (hours), so it needs no separate pruning.
let lastKinPruneAt = 0;
function pruneKinState(nowMs) {
  if (nowMs - lastKinPruneAt < 3600 * 1000) return;
  lastKinPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastRefusalLineAt) {
    if (at < cutoff) lastRefusalLineAt.delete(k);
  }
}

/** Real CitizenKinship adapter, built lazily so pure helpers stay pure. */
function defaultKin() {
  const k = require("./CitizenKinship");
  return {
    isOpenFeud: k.isOpenFeud,
    spouseOf: k.spouseOf,
    partnerOf: k.partnerOf,
  };
}

function pairKeyLocal(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function displayOf(record) {
  return record?.displayName ?? record?.username ?? "someone";
}

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

/**
 * Real players near a bot, for witness-gated lines. Shared with
 * CitizenActivityParties (which used to define this locally).
 */
function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/**
 * Pure: reorder party-formation candidates by kinship.
 *
 * @param {string} leaderName
 * @param {Array} candidates - roster records, already preference-ordered
 * @param {object} kin - { isOpenFeud(a,b), spouseOf(name), partnerOf(name) }
 * @returns {{ kept: Array, excluded: Array }} kept is the new candidate
 *   order (spouse/partner first), excluded are records dropped over an
 *   open feud.
 */
function kinOrder(leaderName, candidates, kin = defaultKin()) {
  const list = [...(candidates ?? [])];
  const kept = [];
  const excluded = [];
  const keptNames = new Set();

  // Spouse/partner goes first — real people don't leave their other half.
  let beloved = null;
  try {
    beloved = kin.spouseOf?.(leaderName) ?? null;
    if (!beloved) {
      const partner = kin.partnerOf?.(leaderName);
      beloved = partner ? partner.other ?? partner : null;
      if (beloved && typeof beloved !== "string") beloved = null;
    }
  } catch {
    beloved = null;
  }
  const belovedKey = beloved ? normalizeName(beloved) : null;
  if (belovedKey) {
    // Even a spouse isn't dragged along mid-open-feud — the feud wins.
    let feudWithBeloved = false;
    try {
      feudWithBeloved = !!kin.isOpenFeud?.(leaderName, beloved);
    } catch {
      feudWithBeloved = false;
    }
    const idx = list.findIndex((c) => normalizeName(c?.username) === belovedKey);
    if (idx >= 0) {
      const [rec] = list.splice(idx, 1);
      if (feudWithBeloved) {
        excluded.push({ record: rec, feudWith: leaderName });
      } else {
        kept.push(rec);
        keptNames.add(normalizeName(rec.username));
      }
    }
  }

  for (const cand of list) {
    if (!cand?.username) continue;
    const cname = cand.username;
    let feudWith = null;
    try {
      if (kin.isOpenFeud?.(leaderName, cname)) {
        feudWith = leaderName;
      } else {
        for (const kn of keptNames) {
          if (kin.isOpenFeud?.(cname, kn)) {
            feudWith = kn;
            break;
          }
        }
      }
    } catch {
      feudWith = null;
    }
    if (feudWith) {
      excluded.push({ record: cand, feudWith });
    } else {
      kept.push(cand);
      keptNames.add(normalizeName(cname));
    }
  }
  return { kept, excluded };
}

// --- personality-gated lines -------------------------------------------------

const REFUSAL_LINES = {
  warm: [
    "Not bringing {feud} along. We're not speaking, and I'm not spoiling the trip.",
    "I'd rather walk alone than walk with {feud}. Another time.",
    "Me and {feud} aren't on speaking terms. Not today.",
  ],
  neutral: [
    "No {feud} this time. We have our reasons.",
    "{feud}'s not coming. Bad blood between us.",
    "I'm not marching anywhere with {feud}.",
  ],
  wry: [
    "Bringing {feud}? I'd sooner bring a goblin.",
    "{feud} can form their own party. Far from mine.",
    "Last time {feud} came, we nearly came to blows. Never again.",
  ],
};

const STORM_LINES = {
  warm: [
    "I can't do this, {other}. I'm sorry.",
    "This was a mistake. I'm done, {other}.",
    "I won't stand beside you, {other}. Not today.",
  ],
  neutral: [
    "I'm not staying in the same party as {other}.",
    "Count me out. I won't work with {other}.",
    "This crew's one person too many, {other}. It's you.",
  ],
  wry: [
    "Me and {other} in the same crew? Somebody's going home in a cart.",
    "I'd rather wrestle a hill giant than march with {other}.",
    "Enjoy the trip, {other}. I'll be anywhere else.",
  ],
};

function fillLine(line, vars) {
  let out = String(line);
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

/**
 * Pure: the leader's scripted explanation for leaving a feuding citizen
 * out of the party. Personality-gated (warm/neutral/wry).
 */
function refusalLine(record, feudDisplay, rng = Math.random) {
  const voice = warmthOf(record?.personality);
  const pool = REFUSAL_LINES[voice] ?? REFUSAL_LINES.neutral;
  return fillLine(pickOne(rng, pool), { feud: feudDisplay });
}

/**
 * Pure: the storming citizen's parting shot. Personality-gated.
 */
function stormOffLine(record, otherDisplay, rng = Math.random) {
  const voice = warmthOf(record?.personality);
  const pool = STORM_LINES[voice] ?? STORM_LINES.neutral;
  return fillLine(pickOne(rng, pool), { other: otherDisplay });
}

/**
 * Pure: pick the citizen who storms off, given the citizen member
 * usernames (leader included), or null when no open feud shares the party.
 *
 * Preference: the member openly feuding with the leader walks. Otherwise
 * the second member of the first open-feud pair. Pairs already stormed
 * (stormedPairs, pairKeys) are skipped so one feud storms off once.
 *
 * @param {string[]} memberNames - usernames, leader included
 * @param {string} leaderName
 * @param {object} kin - { isOpenFeud }
 * @param {string[]} stormedPairs - pairKeys already stormed off
 * @returns {{ stormer: string, other: string } | null}
 */
function stormOffCandidate(memberNames, leaderName, kin = defaultKin(), stormedPairs = []) {
  const names = (memberNames ?? []).filter(
    (n) => n && normalizeName(n) !== normalizeName(leaderName)
  );
  const stormed = new Set(stormedPairs ?? []);
  const pairs = [];
  const consider = (a, b) => {
    if (stormed.has(pairKeyLocal(a, b))) return;
    if (kin.isOpenFeud?.(a, b)) pairs.push([a, b]);
  };
  try {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) consider(names[i], names[j]);
      consider(leaderName, names[i]);
    }
  } catch {
    return null;
  }
  if (pairs.length === 0) return null;
  // The rival of the leader walks first; otherwise the second member of
  // the first feud pair.
  for (const [a, b] of pairs) {
    if (normalizeName(a) === normalizeName(leaderName)) return { stormer: b, other: a };
    if (normalizeName(b) === normalizeName(leaderName)) return { stormer: a, other: b };
  }
  const [a, b] = pairs[0];
  return { stormer: b, other: a };
}

// --- integration -------------------------------------------------------------

/**
 * Formation-time: apply kinship ordering to the candidate list.
 * Thin wrapper over kinOrder with the real kinship store.
 */
function applyPartyKinship(leaderName, candidates) {
  try {
    return kinOrder(leaderName, candidates);
  } catch {
    return { kept: [...(candidates ?? [])], excluded: [] };
  }
}

/**
 * Formation-time: when kinship excluded someone from the party and real
 * players are watching, the leader says why (cooldown-gated). Journaled
 * either way — the data tier remembers.
 */
function maybeRefusalLine(director, record, excluded, nowMs = Date.now()) {
  if (!excluded || excluded.length === 0) return;
  pruneKinState(nowMs);
  const key = normalizeName(record?.username ?? "");
  if (!key) return;
  const first = excluded[0];
  const feudDisplay = displayOf(first.record);
  journalEvent(
    record.username,
    `Left ${feudDisplay} out of the outing — open feud, not mixing.`,
    "social"
  );
  if (nowMs - (lastRefusalLineAt.get(key) ?? 0) < REFUSAL_LINE_COOLDOWN_MS) return;
  let bot = null;
  try {
    bot = director.getBot?.(record) ?? null;
  } catch {
    bot = null;
  }
  if (!bot || realPlayersNear(bot).length === 0) return;
  lastRefusalLineAt.set(key, nowMs);
  try {
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [refusalLine(record, feudDisplay).slice(0, 120)] })); }
  } catch {
    // A silent leader.
  }
}

/**
 * Per-tick: if an open feud now shares the party, the non-leader rival
 * storms off. Real players are never stormed off. Witnesses hear the
 * parting shot; the journal records it for both citizens.
 *
 * @returns {boolean} true when someone stormed off.
 */
function maybeStormOff(director, party, leader, nowMs = Date.now()) {
  if (!party || !leader) return false;
  pruneKinState(nowMs);
  const leaderName = leader.username;

  // Citizen members only: roster-backed, online, and never real players.
  let PlayerActivities = null;
  try {
    PlayerActivities = require("./CitizenPlayerActivities");
  } catch {
    PlayerActivities = null;
  }
  const citizenNames = [leaderName];
  for (const m of party.members ?? []) {
    if (!m || normalizeName(m) === normalizeName(leaderName)) continue;
    let rec = null;
    try {
      rec = director.roster?.get?.(normalizeName(m)) ?? null;
    } catch {
      rec = null;
    }
    if (!rec || !director.isOnline?.(rec)) continue;
    if (PlayerActivities?.isOnlinePlayer?.(director, m)) continue;
    citizenNames.push(m);
  }

  const stormedPairs = Array.isArray(party.stormedPairs) ? party.stormedPairs : [];
  const pick = stormOffCandidate(citizenNames, leaderName, defaultKin(), stormedPairs);
  if (!pick) return false;

  // Remember this pair so the same feud storms off exactly once.
  const nextPairs = [...stormedPairs, pairKeyLocal(pick.stormer, pick.other)];
  party.stormedPairs = nextPairs.slice(-MAX_STORMED_PAIRS);

  const { leaveParty } = require("./CitizenSocialMechanics");
  const { clearFollow } = require("./CitizenBonds");
  try {
    leaveParty(pick.stormer);
  } catch {
    // Non-fatal.
  }
  try {
    clearFollow(pick.stormer);
  } catch {
    // Non-fatal.
  }

  let stormerRec = null;
  let otherRec = null;
  try {
    stormerRec = director.roster?.get?.(normalizeName(pick.stormer)) ?? null;
    otherRec = director.roster?.get?.(normalizeName(pick.other)) ?? null;
  } catch {
    // Non-fatal.
  }
  const stormerDisplay = displayOf(stormerRec);
  const otherDisplay = displayOf(otherRec);
  journalEvent(pick.stormer, `Stormed off the outing — refused to share it with ${otherDisplay}.`, "social");
  journalEvent(pick.other, `${stormerDisplay} stormed off rather than share the outing.`, "social");

  // Witnesses only: the parting shot lands when real players can hear it.
  let bot = null;
  try {
    bot = stormerRec ? director.getBot?.(stormerRec) : null;
  } catch {
    bot = null;
  }
  if (bot && realPlayersNear(bot).length > 0) {
    try {
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [stormOffLine(stormerRec, otherDisplay).slice(0, 120)] })); }
    } catch {
      // A silent exit.
    }
  }
  return true;
}

module.exports = {
  kinOrder,
  refusalLine,
  stormOffLine,
  stormOffCandidate,
  realPlayersNear,
  applyPartyKinship,
  maybeRefusalLine,
  maybeStormOff,
  // Test-only state reset.
  _resetStateForTests() {
    lastRefusalLineAt.clear();
    lastKinPruneAt = 0;
  },
};
