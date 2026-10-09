"use strict";

/**
 * CitizenElection — town elections for mayor, sheriff, and guild master.
 *
 * Citizens hold real elections on a slow cycle: nominations (2 days) ->
 * campaigning (5 days) -> voting (1 day) -> results (1 day) -> a 30-day term
 * in office. Each kingdom elects its own three positions, staggered so the
 * realm is always mid-election somewhere.
 *
 * WHAT IT DOES (data tier, free):
 *   Phase machine per race (kingdom x position) driven by wall-clock time
 *   on the slow (~60s) director tick. Candidate selection is weighted by
 *   role fit, personality-trait fit, incumbency, and past-loss sympathy
 *   ("losers may run again"). Voting is deterministic and data-driven:
 *   trait alignment between voter and platform, friendships via
 *   CitizenBonds, anti-incumbency grumbles, and player endorsements all
 *   move the tally. Winners pick a policy from their platform axis;
 *   losers get journaled losses so they "remember" — and the LLM mouth
 *   can riff on them later when players ask.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Candidates stump near players during campaigning (scripted, zero LLM);
 *   results and new policies are announced at the town square; endorsements
 *   ("I endorse X") travel the event bus from wherever players speak them.
 *
 * PLAYER ENDORSEMENTS: emit `election:endorse` with
 *   { kingdomId, position, playerName, candidate } — e.g. from a future
 *   ::endorse command or chat parsing. Each endorsement adds weight to the
 *   candidate's tally on voting day, and citizens who like the endorser
 *   (via CitizenMemory opinions) lean harder.
 *
 * LLM role: campaign SPEECHES. The visible stump lines are scripted pools;
 * when a player asks a candidate "what do you stand for?", the foreground
 * LLM reads the candidate's journaled platform — no LLM in this tick path.
 *
 * Wiring: CitizenDirector slow tick calls tickElections(this, nowMs) after
 * the offices block. Plain-node testable: CitizenElection.test.js.
 */

const fs = require("fs");
const path = require("path");
const { getJournal } = require("./CitizenJournal");
const { isFriend, normalizeName } = require("./CitizenBonds");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-elections.json");

// === Tuning: all magic numbers here ===
const DAY_MS = 24 * 60 * 60 * 1000;
const NOMINATIONS_MS = 2 * DAY_MS;
const CAMPAIGN_MS = 5 * DAY_MS;
const VOTING_MS = 1 * DAY_MS;
const RESULTS_MS = 1 * DAY_MS;
const TERM_MS = 30 * DAY_MS;

const CANDIDATES_PER_RACE = 3;
const STUMP_RADIUS = 14; // tiles — close enough to hear the pitch
const STUMP_COOLDOWN_MS = 2 * 60 * 60 * 1000; // a candidate stumps at most this often
const STUMP_CHANCE = 0.4; // per candidate per slow tick near a player
const ENDORSEMENT_VOTE_WEIGHT = 3; // votes added per player endorsement

// Positions: town-scale offices (kingdom offices live in CitizenOffices and
// Politics.Kingdoms — those are appointed, these are ELECTED).
const POSITIONS = Object.freeze({
  mayor: Object.freeze({
    title: "Mayor",
    axis: "economy",
    stances: Object.freeze(["pro-trade", "pro-tradition"]),
    // trait -> stance affinity
    traitFit: Object.freeze({
      "pro-trade": ["greedy", "ambitious", "methodical", "chatty"],
      "pro-tradition": ["devout", "dutiful", "proud", "suspicious"],
    }),
    roleFit: Object.freeze({ merchant: 4, courtier: 3, commoner: 2, guard: 1 }),
    policies: Object.freeze({
      "pro-trade": "lowered the market taxes",
      "pro-tradition": "restored the old market charter",
    }),
    stumps: Object.freeze({
      "pro-trade": [
        "Trade built this town, and {name} will keep the roads busy!",
        "{name} says: lower taxes, fuller stalls, happier purses!",
      ],
      "pro-tradition": [
        "This town stood for a hundred years — {name} will keep it standing!",
        "{name} says: honor the charter, honor our founders!",
      ],
    }),
  }),
  sheriff: Object.freeze({
    title: "Sheriff",
    axis: "justice",
    stances: Object.freeze(["strict", "lenient"]),
    traitFit: Object.freeze({
      strict: ["dutiful", "gruff", "suspicious", "proud"],
      lenient: ["warm", "merciful", "chatty", "timid"],
    }),
    roleFit: Object.freeze({ guard: 5, commoner: 2, merchant: 1, courtier: 1 }),
    policies: Object.freeze({
      strict: "doubled the night patrols",
      lenient: "ended the curfew",
    }),
    stumps: Object.freeze({
      strict: [
        "Lock your doors tonight, criminals — {name} is coming!",
        "{name} says: order first, mercy later!",
      ],
      lenient: [
        "A sheriff should protect, not punish — vote {name}!",
        "{name} says: the curfew ends the day I take the badge!",
      ],
    }),
  }),
  guildmaster: Object.freeze({
    title: "Guild Master",
    axis: "craft",
    stances: Object.freeze(["innovator", "traditionalist"]),
    traitFit: Object.freeze({
      innovator: ["ambitious", "curious", "methodical", "chatty"],
      traditionalist: ["devout", "proud", "dutiful", "suspicious"],
    }),
    roleFit: Object.freeze({ merchant: 4, commoner: 3, courtier: 2, guard: 1 }),
    policies: Object.freeze({
      innovator: "opened the guildhall to new techniques",
      traditionalist: "reaffirmed the old craft codes",
    }),
    stumps: Object.freeze({
      innovator: [
        "New tools, new methods, new markets — vote {name}!",
        "{name} says: the old codes are holding us back!",
      ],
      traditionalist: [
        "A guild without tradition is just a shop — vote {name}!",
        "{name} says: the old codes made us great!",
      ],
    }),
  }),
});
const POSITION_KEYS = Object.freeze(Object.keys(POSITIONS));

// === State ===
const races = new Map(); // "kingdomId:position" -> race state
let dirty = false;
const stumpCooldowns = new Map(); // candidate username -> timestamp

// Memory-leak plug for the stump cooldown map.
let lastPruneAt = 0;
function pruneStumpCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of stumpCooldowns) {
    if (at < cutoff) stumpCooldowns.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Race key for a kingdom's position. */
function raceKey(kingdomId, position) {
  return `${kingdomId}:${position}`;
}

/** Deterministic FNV-1a hash -> [0,1) for staggering race schedules. */
function hash01(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Pick a candidate's platform stance from their personality traits.
 * Pure: (traits, position) -> stance string.
 */
function platformFor(traits, position) {
  const def = POSITIONS[position];
  if (!def) return null;
  const lower = (traits ?? []).map((t) => String(t).toLowerCase());
  let best = def.stances[0];
  let bestScore = -1;
  for (const stance of def.stances) {
    const fit = def.traitFit[stance] ?? [];
    const score = fit.filter((t) => lower.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = stance;
    }
  }
  return best;
}

/**
 * Candidate fit score for nomination weighting: role fit + trait fit +
 * incumbency + past-loss sympathy (losers remember, and voters remember).
 * Pure: (record, position, race) -> number.
 */
function candidateFit(record, position, race) {
  const def = POSITIONS[position];
  if (!def) return 0;
  const traits = record.personality?.traits ?? [];
  let score = def.roleFit[record.role] ?? 1;
  const stance = platformFor(traits, position);
  const fit = def.traitFit[stance] ?? [];
  score += fit.filter((t) => traits.map(String).map((s) => s.toLowerCase()).includes(t)).length;
  if (race?.holder === record.username) score += 3; // incumbency
  const losses = (race?.history ?? []).filter((h) => h.runnerUp === record.username).length;
  score += Math.min(losses, 3); // sympathy for past losers who run again
  return score;
}

/**
 * Pick up to CANDIDATES_PER_RACE nominees from eligible citizens.
 * Pure-ish: (rng, candidates[], race) -> chosen array of records.
 * Eligible: merchant/commoner/courtier/guard of this kingdom.
 */
function pickCandidates(rng, eligible, position, race) {
  const scored = eligible
    .filter((r) => ["merchant", "commoner", "courtier", "guard"].includes(r.role))
    .map((r) => ({ record: r, score: candidateFit(r, position, race) + rng() }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, CANDIDATES_PER_RACE).map((s) => s.record);
}

/**
 * How strongly one voter leans toward a candidate.
 * Pure: (voter, candidate, stance, endorsements, history) -> number.
 */
function voterScore(voter, candidate, stance, endorsements, history) {
  const def = POSITIONS[candidate.position];
  let score = 1;
  // Trait alignment: voters prefer platforms that match their own traits.
  const vtraits = (voter.personality?.traits ?? []).map((t) => String(t).toLowerCase());
  const fit = def?.traitFit?.[stance] ?? [];
  score += fit.filter((t) => vtraits.includes(t)).length * 2;
  // Friendship is the strongest pull.
  try {
    if (isFriend(voter.username, candidate.username)) score += 3;
  } catch { /* bonds store may be cold — fine */ }
  // Anti-incumbency grumble: past winners get a small penalty from non-friends.
  const wonBefore = (history ?? []).some((h) => h.winner === candidate.username);
  if (wonBefore) {
    let friendly = false;
    try { friendly = isFriend(voter.username, candidate.username); } catch { /* cold */ }
    if (!friendly) score -= 1;
  }
  // Player endorsements: each one adds flat weight (players are influential).
  const end = (endorsements ?? []).filter((e) => e.candidate === candidate.username).length;
  score += end * ENDORSEMENT_VOTE_WEIGHT;
  return score;
}

/**
 * Run the vote. Every citizen of the kingdom votes (candidates vote for
 * themselves). Deterministic given rng for tie-breaking only.
 * Pure: (rng, voters, candidatesWithStance, endorsements, history) ->
 *   { votes: {candidate: n}, winner }
 */
function tallyVotes(rng, voters, candidates, endorsements, history) {
  const votes = {};
  for (const c of candidates) votes[c.username] = 0;
  for (const voter of voters) {
    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const jitter = rng() * 0.001; // deterministic tie-break only
      const s = voterScore(voter, c, c.stance, endorsements, history) + jitter;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (best) votes[best.username] += 1;
  }
  let winner = candidates[0]?.username ?? null;
  let top = -1;
  for (const c of candidates) {
    if (votes[c.username] > top) {
      top = votes[c.username];
      winner = c.username;
    }
  }
  return { votes, winner };
}

/**
 * Build a fresh race in idle with a staggered first election.
 * Pure: (kingdomId, position, nowMs) -> race state.
 */
function newRace(kingdomId, position, nowMs) {
  // Stagger: each race's first election starts 0-14 days out so the realm
  // is never all mid-election at once.
  const delay = Math.floor(hash01(raceKey(kingdomId, position)) * 14 * DAY_MS);
  return {
    kingdomId,
    position,
    phase: "idle",
    phaseEndsAt: nowMs + delay,
    termEndsAt: nowMs + delay,
    holder: null,
    policy: null,
    candidates: [],
    votes: {},
    endorsements: [],
    history: [],
  };
}

/**
 * Advance one race's phase machine. Mutates race, journals, and returns
 * a list of player-visible announcements {kind, text}.
 * Pure except journaling: (rng, director, race, nowMs) -> announcements[].
 */
function advanceRace(rng, director, race, nowMs) {
  const announcements = [];
  if (nowMs < race.phaseEndsAt) return announcements;

  const def = POSITIONS[race.position];
  const voters = votersFor(director, race.kingdomId);

  if (race.phase === "idle") {
    // Term over (or first run): open nominations.
    race.phase = "nominations";
    race.phaseEndsAt = nowMs + NOMINATIONS_MS;
    race.candidates = [];
    race.votes = {};
    race.endorsements = [];
    dirty = true;
    announcements.push({
      kind: "nominations",
      text: `Nominations are open for ${def.title} of ${race.kingdomId}!`,
    });
    journalAll(director, race.kingdomId, "election",
      `Nominations opened for ${def.title}.`);
  } else if (race.phase === "nominations") {
    // Close nominations: pick the field, each with a platform.
    const eligible = voters.filter((v) =>
      ["merchant", "commoner", "courtier", "guard"].includes(v.role));
    const chosen = pickCandidates(rng, eligible, race.position, race);
    race.candidates = chosen.map((r) => ({
      username: r.username,
      position: race.position,
      stance: platformFor(r.personality?.traits ?? [], race.position),
    }));
    race.phase = "campaigning";
    race.phaseEndsAt = nowMs + CAMPAIGN_MS;
    dirty = true;
    for (const c of race.candidates) {
      journalOne(c.username, "election",
        `Declared candidacy for ${def.title} (${def.axis}: ${c.stance}).`);
    }
    if (race.candidates.length) {
      announcements.push({
        kind: "campaign",
        text: `${race.candidates.map((c) => c.username).join(", ")} are running for ${def.title}!`,
      });
    }
  } else if (race.phase === "campaigning") {
    race.phase = "voting";
    race.phaseEndsAt = nowMs + VOTING_MS;
    dirty = true;
    announcements.push({
      kind: "voting",
      text: `Voting day for ${def.title} of ${race.kingdomId} — make your voice heard!`,
    });
  } else if (race.phase === "voting") {
    // Count the votes.
    const { votes, winner } = tallyVotes(rng, voters, race.candidates, race.endorsements, race.history);
    race.votes = votes;
    race.phase = "results";
    race.phaseEndsAt = nowMs + RESULTS_MS;
    race.winner = winner;
    dirty = true;
    const sorted = race.candidates
      .map((c) => [c.username, votes[c.username] ?? 0])
      .sort((a, b) => b[1] - a[1]);
    const runnerUp = sorted[1]?.[0] ?? null;
    race.history.push({ winner, runnerUp, at: nowMs });
    for (const c of race.candidates) {
      const n = votes[c.username] ?? 0;
      if (c.username === winner) {
        journalOne(c.username, "election",
          `WON the ${def.title} election with ${n} votes.`);
      } else {
        journalOne(c.username, "election",
          `Lost the ${def.title} election to ${winner} (${n} votes). Will remember this.`);
      }
    }
    announcements.push({
      kind: "results",
      text: `${winner} wins the ${def.title} election with ${votes[winner] ?? 0} votes!`,
    });
  } else if (race.phase === "results") {
    // Seat the winner, pick their policy, start the term.
    const winner = race.winner ?? race.candidates[0]?.username ?? null;
    race.holder = winner;
    const stance = race.candidates.find((c) => c.username === winner)?.stance;
    race.policy = stance ? def.policies[stance] : null;
    race.phase = "idle";
    race.phaseEndsAt = nowMs + TERM_MS;
    race.termEndsAt = race.phaseEndsAt;
    race.candidates = [];
    race.winner = null;
    dirty = true;
    if (winner) {
      journalOne(winner, "election",
        `Took office as ${def.title}${race.policy ? ` and ${race.policy}` : ""}.`);
    }
    announcements.push({
      kind: "inauguration",
      text: winner
        ? `${winner} takes office as ${def.title}${race.policy ? ` — ${race.policy}` : ""}!`
        : `No winner declared for ${def.title}; the office stands vacant.`,
    });
  }
  return announcements;
}

/** All roster citizens of a kingdom (the electorate). */
function votersFor(director, kingdomId) {
  const out = [];
  try {
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdomId === kingdomId) out.push(record);
    }
  } catch { /* roster cold */ }
  return out;
}

function journalOne(username, kind, text) {
  try {
    getJournal().log(username, kind, text);
  } catch { /* journal cold — fine */ }
}

function journalAll(director, kingdomId, kind, text) {
  for (const v of votersFor(director, kingdomId)) journalOne(v.username, kind, text);
}

// ============================================================================
// Persistence
// ============================================================================

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    for (const [key, race] of Object.entries(data.races ?? {})) {
      if (race && race.kingdomId && race.position) races.set(key, race);
    }
  } catch { /* corrupt save — start fresh */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ races: Object.fromEntries(races) }, null, 2));
    dirty = false;
  } catch { /* disk busy — try next tick */ }
}

function saveIfDirty() {
  if (dirty) save();
}

/**
 * Record a player endorsement. Safe to call from the event bus at any time;
 * endorsements only count if the race is in nominations/campaigning.
 */
function handleEndorsement(director, event) {
  try {
    const kingdomId = event?.kingdomId;
    const position = event?.position;
    const playerName = event?.playerName;
    const candidate = event?.candidate;
    if (!kingdomId || !POSITIONS[position] || !playerName || !candidate) return false;
    const key = raceKey(kingdomId, position);
    const race = races.get(key);
    if (!race || !["nominations", "campaigning"].includes(race.phase)) return false;
    const running = race.candidates.some(
      (c) => normalizeName(c.username) === normalizeName(candidate));
    // During nominations there are no candidates yet — bank it anyway; it
    // applies if they make the field.
    const dup = race.endorsements.some(
      (e) => normalizeName(e.playerName) === normalizeName(playerName) &&
             normalizeName(e.candidate) === normalizeName(candidate));
    if (dup) return false;
    race.endorsements.push({ playerName, candidate, at: Date.now() });
    dirty = true;
    if (running) {
      journalOne(candidate, "election", `${playerName} endorsed their candidacy for ${POSITIONS[position].title}.`);
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// The tick — slow director tick (~60s). Gate: only races due for a phase
// transition do work; everything else is a map scan.
// ============================================================================

function ensureRaces(director, nowMs) {
  try {
    const kingdoms = new Set();
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdomId) kingdoms.add(record.kingdomId);
    }
    for (const kingdomId of kingdoms) {
      for (const position of POSITION_KEYS) {
        const key = raceKey(kingdomId, position);
        if (!races.has(key)) {
          races.set(key, newRace(kingdomId, position, nowMs));
          dirty = true;
        }
      }
    }
  } catch { /* roster cold */ }
}

function tickElections(director, nowMs) {
  pruneStumpCooldowns(nowMs);
  try {
    ensureRaces(director, nowMs);
    const rng = Math.random;
    for (const race of races.values()) {
      try {
        const announcements = advanceRace(rng, director, race, nowMs);
        for (const a of announcements) announce(director, race, a, nowMs);
      } catch (e) {
        // One bad race never breaks the tick.
        console.warn("[citizen-election] race failed:", e?.message ?? e);
      }
    }
    // Campaigning visibility: candidates stump near real players.
    stumpForCandidates(director, nowMs);
    saveIfDirty();
  } catch (e) {
    console.warn("[citizen-election] tick failed:", e?.message ?? e);
  }
}

// --- player-visible announcements -------------------------------------------

function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch { return false; }
}

function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch { return false; }
}

function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch { return false; }
}

/** Speak an announcement through a citizen near a real player, else journal it. */
function announce(director, race, announcement, nowMs) {
  try {
    // Prefer the town square anchor; fall back to any citizen near a player.
    let speaker = null;
    const square = siteTileByKingdom(race.kingdomId, "square");
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdomId !== race.kingdomId) continue;
      const citizen = director.playerFor?.(record);
      if (!citizen) continue;
      if (!anyRealPlayerNear(director, citizen, STUMP_RADIUS)) continue;
      speaker = citizen;
      if (square) {
        try {
          const loc = citizen.getLocation?.();
          if (loc && Math.max(Math.abs(loc.getX() - square.x), Math.abs(loc.getY() - square.y)) <= 20) break;
        } catch { /* keep first speaker */ }
      }
      break;
    }
    if (speaker) {
      { const _cvp = speaker.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(speaker, voiceLine(voiceFor(_cvp), { plain: [announcement.text.slice(0, 120)] })); }
    }
  } catch { /* visible announcement is best-effort */ }
}

/** Campaigning candidates stump near real players (scripted, zero LLM). */
function stumpForCandidates(director, nowMs) {
  try {
    for (const race of races.values()) {
      if (race.phase !== "campaigning") continue;
      const def = POSITIONS[race.position];
      for (const c of race.candidates) {
        const last = stumpCooldowns.get(normalizeName(c.username)) || 0;
        if (nowMs - last < STUMP_COOLDOWN_MS) continue;
        const record = director.roster?.get?.(normalizeName(c.username));
        const citizen = record ? director.playerFor?.(record) : null;
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, STUMP_RADIUS)) continue;
        if (Math.random() > STUMP_CHANCE) continue;
        const pool = def.stumps[c.stance] ?? [];
        if (!pool.length) continue;
        const line = pool[Math.floor(Math.random() * pool.length)].replaceAll("{name}", c.username);
        { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line.slice(0, 120)] })); }
        stumpCooldowns.set(normalizeName(c.username), nowMs);
      }
    }
  } catch (e) {
    console.warn("[citizen-election] stumping failed:", e?.message ?? e);
  }
}

load();

module.exports = {
  tickElections,
  handleEndorsement,
  saveIfDirty,
  // Pure helpers for tests:
  POSITIONS,
  POSITION_KEYS,
  raceKey,
  hash01,
  platformFor,
  candidateFit,
  pickCandidates,
  voterScore,
  tallyVotes,
  newRace,
  advanceRace,
  votersFor,
  NOMINATIONS_MS,
  CAMPAIGN_MS,
  VOTING_MS,
  RESULTS_MS,
  TERM_MS,
  // Test seam:
  _races: races,
};
