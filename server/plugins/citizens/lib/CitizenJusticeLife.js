"use strict";

/**
 * CitizenJusticeLife — director tick dynamics for crime and punishment.
 * Data tier, zero LLM.
 *
 * Each slow tick:
 *  1. Onset: a few citizens with criminal leanings (sneaky, desperate,
 *     reckless — or broke and hungry for coin) commit petty crimes.
 *     Witnessed crimes go on the watch's wanted list; all are recorded.
 *  2. Curfew: when a council's curfew law is active, citizens out in the
 *     streets after dark risk a curfew violation (online citizens only —
 *     the watch needs to see a body, not a roster row).
 *  3. Trials: wanted citizens face the town court. The verdict weighs
 *     evidence (witnessed? priors?) — the guilty are sentenced, the
 *     innocent walk free. Trial outcomes are journaled; where real
 *     players can hear, the sentence is announced.
 *  4. Punishments: fines take REAL coins (or accrue fine debt offline),
 *     jail sentences put the citizen in the kingdom gaol (they cannot
 *     work while inside), and hardened repeat offenders are exiled.
 *     The wanted entry is cleared once sentenced.
 *  5. Jail: sentences run their course; releases are journaled.
 *
 * Wiring: CitizenDirector calls tickJustice(this, nowMs) in the slow tick
 * inside try/catch. CitizenCrime.save() goes in the save section.
 */

const Crime = require("./CitizenCrime");
const { agentRng, chance } = require("./humanizer");
const { normalizeName } = require("./CitizenBonds");

// Per slow-tick (~60s) base crime chance. Tuned so a ~170-citizen realm
// sees a crime every few days, not a crime wave.
const CRIME_PER_TICK = 0.0004;
// Witness chance for an unobserved crime: someone might have seen.
const WITNESS_CHANCE = 0.35;
// Curfew check chance per online night-owl per tick.
const CURFEW_CHECK_CHANCE = 0.02;
// Trial announcement: only where real players can hear.
const TRIAL_ANNOUNCE_RADIUS = 14;

// Personality traits that lean a citizen toward crime.
const CRIMINAL_TRAITS = ["sneaky", "desperate", "reckless", "greedy", "bitter", "violent"];
// Traits that keep a citizen honest.
const HONEST_TRAITS = ["honest", "dutiful", "lawful", "kind", "pious", "upstanding"];

const ONSET_TABLE = Object.freeze([
  ["theft", 45],
  ["vandalism", 30],
  ["assault", 15],
  ["curfew-violation", 10],
]);

function pickWeighted(rng, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = rng() * total;
  for (const [key, w] of table) {
    roll -= w;
    if (roll <= 0) return key;
  }
  return table[table.length - 1][0];
}

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

function government() {
  try {
    return require("./CitizenGovernment");
  } catch {
    return null;
  }
}

function guards() {
  try {
    return require("./CitizenGuards");
  } catch {
    return null;
  }
}

/** Roster records as an array. Defensive across director shapes. */
function rosterRecords(director) {
  try {
    const roster = director?.roster;
    if (!roster) return [];
    if (typeof roster.values === "function") return Array.from(roster.values());
    if (Array.isArray(roster)) return roster;
    return Object.values(roster);
  } catch {
    return [];
  }
}

function usernameOf(record) {
  return record?.username ?? record?.name ?? null;
}

function kingdomOf(record) {
  return record?.kingdomId ?? record?.kingdom ?? null;
}

function traitsOf(record) {
  const t = record?.personality?.traits ?? [];
  return t.map((x) => String(x).toLowerCase());
}

function onlinePlayerOf(director, username) {
  try {
    return director?.getPlayer?.(username) ?? director?.players?.get?.(username) ?? null;
  } catch {
    return null;
  }
}

function botTile(player) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

/** True when a real (non-bot) player is within radius tiles of this bot. */
function heardByPlayer(director, username, radius) {
  try {
    const bot = onlinePlayerOf(director, username);
    const me = botTile(bot);
    if (!bot || !me) return false;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot) continue;
      try {
        if (p.isPlayerBot?.() === true) continue;
        if (p.getHostAddress?.() === "bot") continue;
      } catch {
        continue;
      }
      const t = botTile(p);
      if (!t) continue;
      if (Math.max(Math.abs(me.x - t.x), Math.abs(me.y - t.y)) <= radius) return true;
    }
  } catch {
    // Non-fatal.
  }
  return false;
}

function hasCurfewLaw(kingdomId, nowMs) {
  try {
    const G = government();
    if (!G || typeof G.hasLaw !== "function") return false;
    return G.hasLaw(kingdomId, "curfew", nowMs);
  } catch {
    return false;
  }
}

function isNight(hour) {
  return hour >= 21 || hour < 5;
}

// --- tick phases -------------------------------------------------------------

function phaseOnset(director, records, nowMs, rng) {
  for (const record of records) {
    const username = usernameOf(record);
    if (!username) continue;
    if (Crime.isJailed(username, nowMs) || Crime.isExiled(username)) continue;
    const traits = traitsOf(record);
    const leaning = traits.filter((t) => CRIMINAL_TRAITS.includes(t)).length;
    const honest = traits.filter((t) => HONEST_TRAITS.includes(t)).length;
    if (honest > 0 && leaning === 0) continue; // the honest don't steal
    let p = CRIME_PER_TICK * (1 + leaning * 2);
    if (leaning === 0) p *= 0.2; // no leaning, almost never
    if (!chance(rng, p)) continue;
    const kind = pickWeighted(rng, ONSET_TABLE);
    const witnessed = chance(rng, WITNESS_CHANCE);
    const k = kingdomOf(record);
    const crime = Crime.reportOffense(username, kind, {
      nowMs,
      witnessed,
      kingdomId: k,
      display: record?.displayName ?? record?.display ?? username,
    });
    if (crime) {
      const def = Crime.crimeDef(kind);
      journalEvent(
        username,
        witnessed
          ? `was seen ${def.description} — the watch has been told.`
          : `is suspected of ${def.label}; nobody saw it happen.`,
        "justice"
      );
    }
  }
}

function phaseCurfew(director, records, nowMs, rng) {
  const hour = new Date(nowMs).getHours();
  if (!isNight(hour)) return;
  for (const record of records) {
    const username = usernameOf(record);
    if (!username) continue;
    if (Crime.isJailed(username, nowMs) || Crime.isExiled(username)) continue;
    const k = kingdomOf(record);
    if (!k || !hasCurfewLaw(k, nowMs)) continue;
    // The watch needs a body on the street: online citizens only.
    const bot = onlinePlayerOf(director, username);
    if (!bot || !botTile(bot)) continue;
    if (!chance(rng, CURFEW_CHECK_CHANCE)) continue;
    const crime = Crime.reportOffense(username, "curfew-violation", {
      nowMs,
      witnessed: true, // the patrol caught them out
      kingdomId: k,
      display: record?.displayName ?? record?.display ?? username,
    });
    if (crime) {
      journalEvent(username, "was caught out after curfew by the night watch.", "justice");
      sayPublicTo(director, username, "Curfew's in force, friend — the watch doesn't like night owls.");
    }
  }
}

/**
 * Run the town court for wanted citizens. Evidence: witnessed crimes and
 * priors convict; unwitnessed first offenses usually walk. Returns the
 * list of verdicts for the punishment phase.
 */
function phaseTrials(director, records, nowMs, rng) {
  const G = guards();
  if (!G || typeof G.isWanted !== "function") return [];
  const verdicts = [];
  for (const record of records) {
    const username = usernameOf(record);
    if (!username) continue;
    if (!G.isWanted(username, nowMs)) continue;
    const history = Crime.crimeHistory(username);
    if (history.length === 0) {
      // Wanted with no recorded crime (e.g. a player report) — the court
      // has nothing to try. Clear it rather than hold them forever.
      try {
        G.serveSentence(username);
      } catch {
        // best-effort
      }
      continue;
    }
    const latest = history[history.length - 1];
    const priors = Crime.convictionCount(username);
    // Evidence score: witnessed counts double, priors count against.
    let guilt = 0.35; // the court starts skeptical
    if (latest.witnessed) guilt += 0.45;
    guilt += Math.min(0.3, priors * 0.15);
    const guilty = (rng() ?? Math.random()) < guilt;
    const def = Crime.crimeDef(latest.kind);
    if (guilty) {
      const sentence = Crime.convict(username, latest.kind, nowMs);
      verdicts.push({ username, kind: latest.kind, sentence, record });
      journalEvent(
        username,
        `stood trial for ${def.label} and was found guilty.`
      );
    } else {
      journalEvent(username, `stood trial for ${def.label} and was acquitted.`);
      if (heardByPlayer(director, username, TRIAL_ANNOUNCE_RADIUS)) {
        sayPublicTo(director, username, "The court found me innocent — the watch owes me an apology.");
      }
    }
    try {
      G.serveSentence(username);
    } catch {
      // best-effort
    }
  }
  return verdicts;
}

function phasePunishments(director, verdicts, nowMs) {
  for (const v of verdicts) {
    const { username, kind, sentence, record } = v;
    if (!sentence) continue;
    const k = kingdomOf(record);
    const display = record?.displayName ?? record?.display ?? username;
    const def = Crime.crimeDef(kind);
    if (sentence.type === "fine") {
      const player = onlinePlayerOf(director, username);
      const { paid, debted } = Crime.applyFine(username, sentence.fine, player);
      journalEvent(
        username,
        paid > 0
          ? `was fined ${paid} coins for ${def.label}${debted > 0 ? ` (${debted} owed)` : ""}.`
          : `was fined ${sentence.fine} coins for ${def.label} (debt recorded).`
      );
      if (heardByPlayer(director, username, TRIAL_ANNOUNCE_RADIUS)) {
        sayPublicTo(director, username, `Fined ${paid > 0 ? paid : sentence.fine} coins. It won't happen again.`);
      }
    } else if (sentence.type === "jail") {
      const until = nowMs + sentence.jailDays * 24 * 3600 * 1000;
      const locked = k ? Crime.imprison(username, k, until, kind, display) : false;
      if (locked) {
        journalEvent(username, `was sentenced to ${sentence.jailDays} day(s) in the gaol for ${def.label}.`);
        if (heardByPlayer(director, username, TRIAL_ANNOUNCE_RADIUS)) {
          sayPublicTo(director, username, "The gaol it is. I'll serve my time.");
        }
      } else {
        // No gaol (or full) — fall back to a heavy fine.
        const player = onlinePlayerOf(director, username);
        const { paid } = Crime.applyFine(username, def.fineBase * 3, player);
        journalEvent(username, `could not be gaoled (no room) — fined ${paid} coins instead for ${def.label}.`);
      }
    } else if (sentence.type === "exile") {
      Crime.exileCitizen(username, k, nowMs);
      journalEvent(username, `was exiled from ${k ?? "town"} for repeated ${def.label}.`);
      if (heardByPlayer(director, username, TRIAL_ANNOUNCE_RADIUS)) {
        sayPublicTo(director, username, "Exiled... I'll find somewhere that wants me.");
      }
    }
  }
}

function phaseJail(director, nowMs) {
  const st = Crime.load();
  for (const prison of Object.values(st.prisons ?? {})) {
    for (const inmate of prison.inmates.slice()) {
      if (inmate.until > nowMs) continue;
      Crime.release(inmate.username);
      journalEvent(inmate.username, "has served their sentence and walks free.");
      if (heardByPlayer(director, inmate.username, TRIAL_ANNOUNCE_RADIUS)) {
        sayPublicTo(director, inmate.username, "Free at last. Keeping my nose clean from here on.");
      }
    }
  }
}

/**
 * The slow-tick entry point. director: CitizenDirector. nowMs: Date.now().
 * Phases are individually guarded — one failing must not starve the others.
 */
function tickJustice(director, nowMs) {
  if (!director) return;
  const rng = agentRng(`justice:${Math.floor(nowMs / 60000)}`);
  const records = rosterRecords(director);
  if (records.length === 0) return;
  try {
    phaseOnset(director, records, nowMs, rng);
  } catch {
    // fall through
  }
  try {
    phaseCurfew(director, records, nowMs, rng);
  } catch {
    // fall through
  }
  let verdicts = [];
  try {
    verdicts = phaseTrials(director, records, nowMs, rng) ?? [];
  } catch {
    // fall through
  }
  try {
    phasePunishments(director, verdicts, nowMs);
  } catch {
    // fall through
  }
  try {
    phaseJail(director, nowMs);
  } catch {
    // fall through
  }
}

module.exports = {
  tickJustice,
  // Exported for tests:
  _phaseOnset: phaseOnset,
  _phaseCurfew: phaseCurfew,
  _phaseTrials: phaseTrials,
  _phasePunishments: phasePunishments,
  _phaseJail: phaseJail,
};
