"use strict";

/**
 * CitizenGovernment — city councils, elections, laws, and political unrest.
 *
 * Each kingdom with roster citizens gets a council: 1 mayor + 4 councilors,
 * elected every 14 days by the citizens who live there. Voting is honest —
 * based on real friendships, shared clans, shared careers, and personality
 * compatibility. The council passes laws from a catalog; laws carry data-only
 * effects other systems can read via getActiveLaws(). Unrest rises when
 * citizens dislike their rulers and can boil over into protests or a snapped
 * council and snap election.
 *
 * Players can run for office (if they're known in the kingdom) and endorse
 * candidates. Data tier, zero LLM. The foreground LLM reads the journal when
 * a player asks about politics.
 *
 * Wiring: CitizenDirector calls tickGovernments() (in CitizenGovernmentLife)
 * in the slow tick; save() in the save section.
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "saves",
  "citizen-government.json"
);

function _setSavePathForTests(p) {
  module.exports._saveFileOverride = p;
}
function _saveFile() {
  return module.exports._saveFileOverride || SAVE_FILE;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEATS_PER_COUNCIL = 5; // 1 mayor + 4 councilors
const TERM_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const LAW_SESSION_MS = 3 * 24 * 60 * 60 * 1000; // council sits every 3 days
const UNREST_PROTEST_AT = 70;
const UNREST_DISSOLVE_AT = 90;

// Law catalog. Effects are data other systems may read; happiness deltas are
// applied to unrest by the tick. expiresAtMs null = permanent until repealed.
const LAWS = {
  "lower-taxes": {
    name: "Lower Taxes",
    description: "Traders keep more of their coin.",
    likes: ["merchant"],
    dislikes: [],
    unrestDelta: -8,
  },
  "raise-taxes": {
    name: "War Levy",
    description: "Higher taxes to fill the war chest.",
    likes: [],
    dislikes: ["merchant", "commoner"],
    unrestDelta: 10,
  },
  "militia-drill": {
    name: "Militia Drill",
    description: "Weekly weapons drill for the town guard.",
    likes: ["guard"],
    dislikes: [],
    unrestDelta: -4,
  },
  curfew: {
    name: "Night Curfew",
    description: "No loitering in the streets after dark.",
    likes: ["guard"],
    dislikes: ["commoner"],
    unrestDelta: 6,
  },
  festival: {
    name: "Harvest Festival",
    description: "A week of feasting, music, and games.",
    likes: ["commoner", "merchant", "courtier"],
    dislikes: [],
    unrestDelta: -12,
  },
  "market-day": {
    name: "Grand Market Day",
    description: "Stalls open late; traders from afar are welcome.",
    likes: ["merchant"],
    dislikes: [],
    unrestDelta: -5,
  },
  "school-funding": {
    name: "Free Schooling",
    description: "The town covers school tuition; parents pay nothing.",
    likes: ["commoner"],
    dislikes: ["merchant"],
    unrestDelta: -6,
  },
};

const LAW_IDS = Object.keys(LAWS);

// Personality traits that make a citizen want to run for office.
const AMBITION_TRAITS = ["ambitious", "charismatic", "leader", "outspoken", "proud"];
// Traits voters find reassuring in a candidate.
const TRUST_TRAITS = ["honest", "wise", "kind", "fair", "steady", "charitable"];

// ---------------------------------------------------------------------------
// Persistence (dirty-flag pattern)
// ---------------------------------------------------------------------------

function blankState() {
  return { councils: {}, seq: 0 };
}

function load() {
  try {
    const file = _saveFile();
    if (!fs.existsSync(file)) return blankState();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return blankState();
    if (!raw.councils || typeof raw.councils !== "object") raw.councils = {};
    if (!Number.isFinite(raw.seq)) raw.seq = 0;
    return raw;
  } catch {
    return blankState();
  }
}

let cache = null;
let dirty = false;

function data() {
  if (!cache) cache = load();
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    const file = _saveFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

function resetForTests() {
  cache = null;
  dirty = false;
  delete module.exports._saveFileOverride;
}

// ---------------------------------------------------------------------------
// Journal (so the LLM mouth knows)
// ---------------------------------------------------------------------------

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, text, kind || "politics");
  } catch {
    // Journal is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Council records
// ---------------------------------------------------------------------------

function blankCouncil(kingdomId, kingdomName, nowMs) {
  return {
    kingdomId: String(kingdomId ?? ""),
    kingdomName: String(kingdomName ?? kingdomId ?? ""),
    seats: [], // [{ office, citizenName, displayName, electedAtMs, termEndsMs }]
    candidates: [], // [{ name, displayName, isPlayer, nominatedAtMs }]
    endorsements: {}, // candidateName -> [playerName]
    laws: [], // [{ id, name, passedAtMs, expiresAtMs, proposedBy }]
    unrest: 10,
    nextElectionAtMs: nowMs + TERM_MS,
    lastSessionAtMs: 0,
    dissolvedAtMs: 0,
    log: [],
  };
}

function getCouncil(kingdomId) {
  const st = data();
  return st.councils[String(kingdomId)] || null;
}

function ensureCouncil(kingdomId, kingdomName, nowMs) {
  const st = data();
  const key = String(kingdomId);
  if (!st.councils[key]) {
    st.councils[key] = blankCouncil(kingdomId, kingdomName, nowMs);
    markDirty();
  }
  return st.councils[key];
}

function allCouncils() {
  return Object.values(data().councils);
}

function councilLog(council, text) {
  council.log.push({ at: Date.now(), text });
  if (council.log.length > 40) council.log.splice(0, council.log.length - 40);
  markDirty();
}

function mayorOf(kingdomId) {
  const council = getCouncil(kingdomId);
  if (!council) return null;
  return council.seats.find((s) => s.office === "mayor") || null;
}

function isOfficeHolder(name) {
  const n = String(name ?? "").toLowerCase();
  return allCouncils().some((c) =>
    c.seats.some((s) => String(s.citizenName).toLowerCase() === n)
  );
}

function officeOf(name) {
  const n = String(name ?? "").toLowerCase();
  for (const c of allCouncils()) {
    const seat = c.seats.find((s) => String(s.citizenName).toLowerCase() === n);
    if (seat) return { kingdomId: c.kingdomId, office: seat.office };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Laws
// ---------------------------------------------------------------------------

function lawDef(id) {
  return LAWS[id] || null;
}

function activeLaws(kingdomId, nowMs) {
  const council = getCouncil(kingdomId);
  if (!council) return [];
  const now = nowMs ?? Date.now();
  return council.laws.filter((l) => !l.expiresAtMs || l.expiresAtMs > now);
}

function hasLaw(kingdomId, lawId, nowMs) {
  return activeLaws(kingdomId, nowMs).some((l) => l.id === lawId);
}

/**
 * Pass a law. Returns the law record, or null if already active.
 * Applies the unrest delta immediately.
 */
function passLaw(kingdomId, lawId, proposedBy, nowMs, durationMs) {
  const def = lawDef(lawId);
  if (!def) return null;
  const council = getCouncil(kingdomId);
  if (!council) return null;
  const now = nowMs ?? Date.now();
  if (hasLaw(kingdomId, lawId, now)) return null;
  const law = {
    id: lawId,
    name: def.name,
    passedAtMs: now,
    expiresAtMs: durationMs ? now + durationMs : null,
    proposedBy: proposedBy ?? null,
  };
  council.laws.push(law);
  council.unrest = clampUnrest(council.unrest + def.unrestDelta);
  councilLog(council, `The council passed "${def.name}".`);
  journalEvent(
    proposedBy || councilName(council),
    `Helped pass the law "${def.name}".`,
    "politics"
  );
  markDirty();
  return law;
}

function repealLaw(kingdomId, lawId) {
  const council = getCouncil(kingdomId);
  if (!council) return false;
  const idx = council.laws.findIndex((l) => l.id === lawId);
  if (idx < 0) return false;
  const [law] = council.laws.splice(idx, 1);
  councilLog(council, `The council repealed "${law.name}".`);
  markDirty();
  return true;
}

function clampUnrest(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function adjustUnrest(kingdomId, delta) {
  const council = getCouncil(kingdomId);
  if (!council) return null;
  council.unrest = clampUnrest(council.unrest + delta);
  markDirty();
  return council.unrest;
}

function councilName(council) {
  return `${council.kingdomName} council`;
}

// ---------------------------------------------------------------------------
// Candidacy (citizens + players)
// ---------------------------------------------------------------------------

/**
 * Whether a roster record would consider running for office.
 * Ambitious/leadership personalities, not retired, adult.
 */
function wantsOffice(record) {
  if (!record?.username) return false;
  try {
    const Careers = require("./CitizenCareers");
    if (Careers.isCareerRetired && Careers.isCareerRetired(record.username)) return false;
  } catch {
    // Careers module missing — don't gate on it.
  }
  const traits = record.personality?.traits ?? [];
  return traits.some((t) => AMBITION_TRAITS.includes(String(t).toLowerCase()));
}

/**
 * Nominate a citizen candidate. Returns true if added.
 */
function nominateCandidate(kingdomId, name, displayName, isPlayer, nowMs) {
  const council = getCouncil(kingdomId);
  if (!council) return false;
  const key = String(name).toLowerCase();
  if (council.candidates.some((c) => String(c.name).toLowerCase() === key)) return false;
  if (council.seats.some((s) => String(s.citizenName).toLowerCase() === key)) return false;
  council.candidates.push({
    name: String(name),
    displayName: displayName || String(name),
    isPlayer: !!isPlayer,
    nominatedAtMs: nowMs ?? Date.now(),
  });
  markDirty();
  return true;
}

/**
 * A player endorses a candidate: +5 votes weight, journaled.
 */
function endorseCandidate(kingdomId, candidateName, playerName) {
  const council = getCouncil(kingdomId);
  if (!council) return false;
  const cand = council.candidates.find(
    (c) => String(c.name).toLowerCase() === String(candidateName).toLowerCase()
  );
  if (!cand) return false;
  const key = String(cand.name).toLowerCase();
  council.endorsements[key] = council.endorsements[key] || [];
  const pname = String(playerName);
  if (!council.endorsements[key].includes(pname)) {
    council.endorsements[key].push(pname);
    journalEvent(
      cand.name,
      `Was endorsed for council by ${pname}.`,
      "politics"
    );
    markDirty();
  }
  return true;
}

function clearCandidates(council) {
  council.candidates = [];
  council.endorsements = {};
  markDirty();
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

/**
 * Score how much one voter likes a candidate. Pure function of real state:
 * friendship, shared clan, shared career, personality compatibility, trust
 * traits, incumbency.
 */
function voteScore(voterRecord, candidate, ctx) {
  // ctx: { isFriend(nameA, nameB), clanOf(name), careerOf(name), council }
  let score = 1; // everyone gets a base vote — showing up matters
  const vName = String(voterRecord?.username ?? "").toLowerCase();
  const cName = String(candidate?.name ?? "").toLowerCase();
  if (!vName || !cName || vName === cName) return vName === cName ? 2 : 0;

  try {
    if (ctx.isFriend && ctx.isFriend(voterRecord.username, candidate.name)) score += 3;
  } catch { /* no bonds */ }

  try {
    const vClan = ctx.clanOf && ctx.clanOf(voterRecord.username);
    const cClan = ctx.clanOf && ctx.clanOf(candidate.name);
    if (vClan && cClan && vClan.id === cClan.id) score += 2;
  } catch { /* no clans */ }

  try {
    const vCar = ctx.careerOf && ctx.careerOf(voterRecord.username);
    const cCar = ctx.careerOf && ctx.careerOf(candidate.name);
    if (vCar && cCar && vCar === cCar) score += 1;
  } catch { /* no careers */ }

  // Personality: voters like candidates with trust traits.
  try {
    const cRec = ctx.recordOf && ctx.recordOf(candidate.name);
    const traits = (cRec?.personality?.traits ?? []).map((t) => String(t).toLowerCase());
    if (traits.some((t) => TRUST_TRAITS.includes(t))) score += 1;
    // Shared traits warm the vote a little.
    const vTraits = (voterRecord.personality?.traits ?? []).map((t) => String(t).toLowerCase());
    const shared = traits.filter((t) => vTraits.includes(t)).length;
    score += Math.min(2, shared);
  } catch { /* no personality */ }

  // Incumbency: a sitting councilor with low unrest gets a bonus.
  try {
    const council = ctx.council;
    if (council && council.unrest < 40) {
      const incumbent = council.seats.some(
        (s) => String(s.citizenName).toLowerCase() === cName
      );
      if (incumbent) score += 1;
    }
  } catch { /* no council */ }

  // Player endorsements carry weight — a known player vouching matters.
  try {
    const endorsed = (ctx.council?.endorsements?.[cName] ?? []).length;
    score += Math.min(6, endorsed * 2);
  } catch { /* no endorsements */ }

  return score;
}

/**
 * Run an election for a kingdom. voters: roster records in the kingdom.
 * candidates: [{ name, displayName, isPlayer }]. Returns the new seats.
 */
function runElection(kingdomId, voters, candidates, ctx, nowMs) {
  const council = getCouncil(kingdomId);
  if (!council) return [];
  const now = nowMs ?? Date.now();

  const tallies = new Map(); // lowerName -> { candidate, votes }
  for (const cand of candidates) {
    tallies.set(String(cand.name).toLowerCase(), { candidate: cand, votes: 0 });
  }
  for (const voter of voters) {
    let best = null;
    let bestScore = 0;
    for (const cand of candidates) {
      const s = voteScore(voter, cand, { ...ctx, council });
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
    if (best && bestScore > 0) {
      tallies.get(String(best.name).toLowerCase()).votes += 1;
    }
  }

  const ranked = [...tallies.values()].sort((a, b) => b.votes - a.votes);
  const winners = ranked.slice(0, SEATS_PER_COUNCIL);

  const seats = winners.map((w, i) => ({
    office: i === 0 ? "mayor" : "councilor",
    citizenName: w.candidate.name,
    displayName: w.candidate.displayName,
    isPlayer: !!w.candidate.isPlayer,
    electedAtMs: now,
    termEndsMs: now + TERM_MS,
    votes: w.votes,
  }));

  council.seats = seats;
  council.nextElectionAtMs = now + TERM_MS;
  council.unrest = clampUnrest(council.unrest - 15); // elections vent pressure
  clearCandidates(council);

  const mayor = seats[0];
  if (mayor) {
    councilLog(council, `${mayor.displayName} elected mayor with ${mayor.votes} votes.`);
    journalEvent(mayor.citizenName, `Was elected mayor of ${council.kingdomName}.`, "politics");
  }
  markDirty();
  return seats;
}

/**
 * Dissolve the council (unrest boiled over). Snap election soon.
 */
function dissolveCouncil(kingdomId, nowMs, reason) {
  const council = getCouncil(kingdomId);
  if (!council) return false;
  const now = nowMs ?? Date.now();
  council.seats = [];
  council.dissolvedAtMs = now;
  council.nextElectionAtMs = now + 24 * 60 * 60 * 1000; // snap election tomorrow
  council.unrest = 45; // vented but not calm
  clearCandidates(council);
  councilLog(council, `The council was dissolved${reason ? `: ${reason}` : ""}. Snap election called.`);
  markDirty();
  return true;
}

// ---------------------------------------------------------------------------
// Summaries (for chat / LLM)
// ---------------------------------------------------------------------------

function describeCouncil(kingdomId) {
  const council = getCouncil(kingdomId);
  if (!council) return null;
  const mayor = mayorOf(kingdomId);
  const laws = activeLaws(kingdomId).map((l) => l.name);
  return {
    kingdomName: council.kingdomName,
    mayor: mayor ? mayor.displayName : "(vacant)",
    councilors: council.seats.filter((s) => s.office === "councilor").map((s) => s.displayName),
    laws,
    unrest: council.unrest,
    nextElectionIn: Math.max(0, council.nextElectionAtMs - Date.now()),
  };
}

module.exports = {
  SAVE_FILE,
  SEATS_PER_COUNCIL,
  TERM_MS,
  LAW_SESSION_MS,
  UNREST_PROTEST_AT,
  UNREST_DISSOLVE_AT,
  LAWS,
  LAW_IDS,
  // data
  getCouncil,
  ensureCouncil,
  allCouncils,
  mayorOf,
  isOfficeHolder,
  officeOf,
  describeCouncil,
  // laws
  lawDef,
  activeLaws,
  hasLaw,
  passLaw,
  repealLaw,
  adjustUnrest,
  // candidacy
  wantsOffice,
  nominateCandidate,
  endorseCandidate,
  // elections
  voteScore,
  runElection,
  dissolveCouncil,
  // persistence
  save,
  resetForTests,
  _setSavePathForTests,
  _data: data,
};
