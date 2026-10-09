"use strict";

/**
 * CitizenLegalLife — director tick dynamics for the legal system.
 * Data tier, zero LLM.
 *
 * Each slow tick:
 *  1. Judges: kingdoms without a sitting judge get one appointed from
 *     eligible citizens (lawful traits, reputation >= 20). Expired terms
 *     are cleared so a new judge can be seated.
 *  2. Appeals: pending appeals within the window are re-heard. The appeal
 *     court rolls fresh guilt (base 0.35, priors count, lawyer bonus
 *     applies). Overturned convictions clear the criminal record and any
 *     active jail time; upheld convictions stand. Outcomes journaled and
 *     announced where real players can hear.
 *  3. Pardons: pending petitions are decided. The council grants a pardon
 *     when the convicted has reputation >= 40 (the reformed citizen) or a
 *     family member petitioned with the fee. Granted pardons wipe the
 *     criminal record (via CitizenLegalCode.grantPardon). Denials journaled.
 *  4. Player trials: pending player accusations are tried. Evidence weighs
 *     the same as citizen trials (witnessed? priors?). A guilty verdict puts
 *     the player on the watch's wanted list for a sentence-scaled duration
 *     (guards challenge wanted players at gates — real consequences through
 *     existing machinery). Acquittals are journaled. Players are never
 *     jailed by this system.
 *
 * Wiring: CitizenDirector calls tickLegalLife(this, nowMs) in the slow tick
 * inside try/catch. CitizenLegalCode.save() goes in the save section.
 */

const LegalCode = require("./CitizenLegalCode");
const { normalizeName } = require("./CitizenBonds");

// Personality traits that suit the bench.
const JUDICIAL_TRAITS = ["lawful", "honest", "dutiful", "just", "wise", "upstanding"];
// How often the tick runs the heavier passes (probability per slow tick).
const APPEAL_HEAR_CHANCE = 0.5;
const PARDON_DECIDE_CHANCE = 0.4;
const PLAYER_TRIAL_CHANCE = 0.6;

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, text, kind || "justice");
  } catch {
    // best-effort
  }
}

function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const player = director?.getPlayer?.(username) ?? director?.players?.get?.(username);
    if (player) sayPublic(player, text);
  } catch {
    // best-effort
  }
}

function heardByPlayer(director, username, radius) {
  try {
    const bot = director?.getBot?.({ username }) ?? null;
    if (!bot || typeof bot.getLocalPlayers !== "function") return false;
    const near = bot.getLocalPlayers(radius ?? 14) || [];
    return near.length > 0;
  } catch {
    return false;
  }
}

function rosterUsernames(director) {
  try {
    const roster = director?.roster;
    if (roster && typeof roster.values === "function") {
      return Array.from(roster.values()).map((r) => r?.username).filter(Boolean);
    }
    if (Array.isArray(roster)) return roster.map((r) => r?.username).filter(Boolean);
    return [];
  } catch {
    return [];
  }
}

function traitsOf(director, username) {
  try {
    const rec = director?.roster?.get?.(username);
    const t = rec?.personality?.traits;
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

function kingdomOf(director, username) {
  try {
    const rec = director?.roster?.get?.(username);
    return rec?.kingdomId ?? null;
  } catch {
    return null;
  }
}

function reputationOf(username) {
  try {
    const Rep = require("./CitizenReputation");
    return Rep.scoreFor?.(username) ?? 0;
  } catch {
    return 0;
  }
}

// --- 1. judges ------------------------------------------------------------------

function ensureJudges(director, nowMs) {
  let kingdoms = [];
  try {
    const Gov = require("./CitizenGovernment");
    kingdoms = Gov.kingdomIds?.() ?? [];
  } catch {
    return;
  }
  if (!Array.isArray(kingdoms) || kingdoms.length === 0) return;
  for (const kingdomId of kingdoms) {
    try {
      const sitting = LegalCode.judgeFor(kingdomId, nowMs);
      if (sitting) continue; // bench is filled
      // Find an eligible citizen of this kingdom: lawful traits + reputation.
      const candidates = rosterUsernames(director).filter((u) => {
        if (kingdomOf(director, u) !== kingdomId) return false;
        if (reputationOf(u) < LegalCode.JUDGE_REPUTATION_MIN) return false;
        const traits = traitsOf(director, u);
        return traits.some((t) => JUDICIAL_TRAITS.includes(t));
      });
      if (candidates.length === 0) continue;
      // The most reputable candidate takes the bench.
      candidates.sort((a, b) => reputationOf(b) - reputationOf(a));
      const judge = candidates[0];
      LegalCode.assignJudge(kingdomId, judge, nowMs);
      journalEvent(judge, `was appointed judge of the ${kingdomId} court.`, "justice");
    } catch {
      // one bad kingdom never breaks the tick
    }
  }
}

// --- 2. appeals --------------------------------------------------------------------

function hearAppeals(director, nowMs, rng) {
  if ((rng() ?? Math.random()) >= APPEAL_HEAR_CHANCE) return;
  const appeals = LegalCode.pendingAppeals(nowMs);
  for (const appeal of appeals) {
    try {
      const username = appeal.username;
      let priors = 0;
      try {
        const Crime = require("./CitizenCrime");
        priors = Crime.convictionCount?.(username) ?? 0;
      } catch {
        // no crime module — appeal heard on bare merits
      }
      // Fresh eyes: base skepticism, priors count, lawyer bonus applies.
      let guilt = 0.35 + Math.min(0.3, priors * 0.15);
      guilt -= LegalCode.defenseBonusFor(username);
      const overturned = (rng() ?? Math.random()) >= guilt;
      LegalCode.resolveAppeal(username, overturned, nowMs);
      if (overturned) {
        // The record is wiped; any jail time ends.
        try {
          const Crime = require("./CitizenCrime");
          if (typeof Crime.clearRecord === "function") Crime.clearRecord(username);
          if (typeof Crime.releaseFromJail === "function") Crime.releaseFromJail(username);
        } catch {
          // best-effort
        }
        LegalCode.clearLawyer(username);
        journalEvent(username, "won an appeal — the conviction was overturned.", "justice");
        if (heardByPlayer(director, username, 14)) {
          sayPublicTo(director, username, "The appeal court cleared my name — justice at last.");
        }
      } else {
        journalEvent(username, "lost an appeal — the conviction stands.", "justice");
      }
    } catch {
      // one bad appeal never breaks the tick
    }
  }
}

// --- 3. pardons ---------------------------------------------------------------------

function decidePardons(director, nowMs, rng) {
  if ((rng() ?? Math.random()) >= PARDON_DECIDE_CHANCE) return;
  const pardons = LegalCode.pendingPardons();
  for (const pardon of pardons) {
    try {
      const username = pardon.username;
      const rep = reputationOf(username);
      const reformed = rep >= LegalCode.PARDON_REPUTATION_THRESHOLD;
      const familyPetition = !!pardon.petitionedBy && !!pardon.feePaid;
      if (reformed || familyPetition) {
        LegalCode.grantPardon(username, nowMs);
        journalEvent(
          username,
          `was pardoned${pardon.petitionedBy ? ` on petition of ${pardon.petitionedBy}` : ""} — the slate is clean.`,
          "justice"
        );
        if (heardByPlayer(director, username, 14)) {
          sayPublicTo(director, username, "I have been pardoned — a second chance I will not waste.");
        }
      } else {
        LegalCode.denyPardon(username, nowMs);
        journalEvent(username, "was denied a pardon.", "justice");
      }
    } catch {
      // one bad pardon never breaks the tick
    }
  }
}

// --- 4. player trials ------------------------------------------------------------------
// A guilty verdict puts the player on the watch's wanted list (30 minutes —
// the watch's standard TTL). The watch only tracks "theft" and "attack", so
// assault maps to attack; other crime kinds record the verdict but cannot
// wanted-list. Guards challenge wanted players at gates — real consequences
// through existing machinery. Players are never jailed by this system.

// CitizenCrime kinds -> watch kinds (mirrors CitizenCrime.reportOffense).
const WATCH_KIND_MAP = { theft: "theft", assault: "attack" };

function tryPlayerTrials(director, nowMs, rng) {
  if ((rng() ?? Math.random()) >= PLAYER_TRIAL_CHANCE) return;
  const accusations = LegalCode.pendingPlayerAccusations();
  if (accusations.length === 0) return;
  let guards = null;
  try {
    guards = require("./CitizenGuards");
  } catch {
    return; // no watch, no trials
  }
  for (const acc of accusations) {
    try {
      const playerName = acc.playerName;
      const def = (() => {
        try {
          const Crime = require("./CitizenCrime");
          return Crime.crimeDef(acc.crimeKind);
        } catch {
          return null;
        }
      })();
      // Evidence: witnessed counts heavily; players have no priors here.
      let guilt = 0.35;
      if (acc.reporter) guilt += 0.3; // someone named them
      const guilty = (rng() ?? Math.random()) < guilt;
      if (guilty) {
        LegalCode.resolvePlayerAccusation(playerName, acc.crimeKind, "guilty", nowMs);
        // Real consequence: wanted-listed (the watch's standard 30-min TTL).
        const watchKind = WATCH_KIND_MAP[String(acc.crimeKind).toLowerCase()];
        if (watchKind && typeof guards.reportCrime === "function") {
          try {
            guards.reportCrime("the-court", playerName, watchKind, nowMs);
          } catch {
            // best-effort
          }
        }
        journalEvent(
          playerName,
          `stood trial for ${def?.label ?? acc.crimeKind} and was found guilty — wanted by the watch.`,
          "justice"
        );
      } else {
        LegalCode.resolvePlayerAccusation(playerName, acc.crimeKind, "acquitted", nowMs);
        journalEvent(
          playerName,
          `stood trial for ${def?.label ?? acc.crimeKind} and was acquitted.`,
          "justice"
        );
      }
    } catch {
      // one bad accusation never breaks the tick
    }
  }
}

function tickLegalLife(director, nowMs, rng) {
  const now = nowMs ?? Date.now();
  const r = rng ?? Math.random;
  try {
    ensureJudges(director, now);
  } catch {
    // never throws
  }
  try {
    hearAppeals(director, now, r);
  } catch {
    // never throws
  }
  try {
    decidePardons(director, now, r);
  } catch {
    // never throws
  }
  try {
    tryPlayerTrials(director, now, r);
  } catch {
    // never throws
  }
}

module.exports = { tickLegalLife };
