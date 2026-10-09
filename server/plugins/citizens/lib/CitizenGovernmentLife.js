"use strict";

/**
 * CitizenGovernmentLife — director tick dynamics for councils, elections,
 * laws, and unrest. Data tier, zero LLM.
 *
 * Each slow tick:
 *  1. Ensure every kingdom with roster citizens has a council.
 *  2. Ambitious citizens nominate themselves when an election is near.
 *  3. Run elections when due.
 *  4. Seated councils hold sessions every few days and pass one law,
 *     chosen by the members' personalities (guards like drills, merchants
 *     like market days, everyone likes festivals when unrest is high).
 *  5. Unrest drifts toward calm; protests fire at 70+, dissolution at 90+.
 *
 * Wiring: CitizenDirector calls tickGovernments(this, nowMs) in the slow
 * tick inside try/catch.
 */

const Gov = require("./CitizenGovernment");
const { agentRng } = require("./humanizer");

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, text, kind || "politics");
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

// Lazy singletons for cross-module reads.
function bonds() {
  try {
    return require("./CitizenBonds");
  } catch {
    return null;
  }
}
function clans() {
  try {
    return require("./CitizenClans");
  } catch {
    return null;
  }
}
function careers() {
  try {
    return require("./CitizenCareers");
  } catch {
    return null;
  }
}

/**
 * Roster records grouped by kingdomId.
 */
function recordsByKingdom(director) {
  const map = new Map();
  let roster = [];
  try {
    roster = [...(director?.roster?.values?.() ?? [])];
  } catch {
    return map;
  }
  for (const r of roster) {
    const k = String(r?.kingdomId ?? "");
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function kingdomNameFor(director, kingdomId, records) {
  const r = (records || []).find((x) => String(x?.kingdomId) === String(kingdomId));
  if (r?.kingdomName) return r.kingdomName;
  try {
    const KingdomStore = require("../../kingdoms/KingdomStore");
    const k = KingdomStore.getKingdom ? KingdomStore.getKingdom(kingdomId) : null;
    if (k?.name) return k.name;
  } catch {
    // fall through
  }
  return String(kingdomId);
}

/**
 * Build the voting context for voteScore().
 */
function buildCtx(director, council) {
  const B = bonds();
  const C = clans();
  const K = careers();
  const recordOf = (name) => {
    try {
      return director?.roster?.get?.(String(name).toLowerCase()) ?? null;
    } catch {
      return null;
    }
  };
  return {
    council,
    recordOf,
    isFriend: (a, b) => {
      try {
        return B ? B.isFriend(a, b) : false;
      } catch {
        return false;
      }
    },
    clanOf: (name) => {
      try {
        return C ? C.clanOf(name) : null;
      } catch {
        return null;
      }
    },
    careerOf: (name) => {
      try {
        return K && K.careerOf ? K.careerOf(name) : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Ambitious citizens nominate themselves in the 3 days before an election.
 */
function gatherNominations(director, council, records, nowMs, random) {
  const NOMINATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
  if (council.nextElectionAtMs - nowMs > NOMINATE_WINDOW_MS) return;
  if (council.seats.length > 0 && council.nextElectionAtMs - nowMs > 0) {
    // Sitting council: only nominate if there is room for challengers.
  }
  let nominated = 0;
  for (const record of records) {
    if (nominated >= 8) break; // ballot stays readable
    if (!Gov.wantsOffice(record)) continue;
    // Not everyone ambitious runs every time — some sit this one out.
    if (random() > 0.6) continue;
    const ok = Gov.nominateCandidate(
      council.kingdomId,
      record.username,
      record.displayName || record.username,
      false,
      nowMs
    );
    if (ok) nominated++;
  }
  // An empty ballot is a failed election — draft the most senior citizens.
  if (council.candidates.length === 0 && records.length > 0) {
    const drafted = records.slice(0, Math.min(3, records.length));
    for (const record of drafted) {
      Gov.nominateCandidate(
        council.kingdomId,
        record.username,
        record.displayName || record.username,
        false,
        nowMs
      );
    }
    journalEvent(
      drafted[0]?.username || "council",
      `No one stood for election in ${council.kingdomName}, so the elders were drafted.`,
      "politics"
    );
  }
}

/**
 * Choose which law the council passes. Personalities rule: count the seats
 * by role and pick the law the room wants. High unrest pushes festivals.
 */
function chooseLaw(council, director, random) {
  const roleCount = {};
  for (const seat of council.seats) {
    try {
      const rec = director?.roster?.get?.(String(seat.citizenName).toLowerCase());
      const role = String(rec?.role ?? "commoner").toLowerCase();
      roleCount[role] = (roleCount[role] || 0) + 1;
    } catch {
      roleCount.commoner = (roleCount.commoner || 0) + 1;
    }
  }
  const now = Date.now();
  const options = [];
  // Festival is the pressure valve — likely when unrest is high.
  if (!Gov.hasLaw(council.kingdomId, "festival", now)) {
    options.push({ id: "festival", weight: council.unrest >= 50 ? 5 : 1 });
  }
  if ((roleCount.guard || 0) >= 1 && !Gov.hasLaw(council.kingdomId, "militia-drill", now)) {
    options.push({ id: "militia-drill", weight: 2 + (roleCount.guard || 0) });
  }
  if ((roleCount.merchant || 0) >= 1) {
    if (!Gov.hasLaw(council.kingdomId, "market-day", now))
      options.push({ id: "market-day", weight: 2 });
    if (!Gov.hasLaw(council.kingdomId, "lower-taxes", now))
      options.push({ id: "lower-taxes", weight: 1 });
  }
  if (!Gov.hasLaw(council.kingdomId, "curfew", now) && (roleCount.guard || 0) >= 2) {
    options.push({ id: "curfew", weight: 1 });
  }
  if (options.length === 0) return null;
  const total = options.reduce((a, o) => a + o.weight, 0);
  let roll = random() * total;
  for (const o of options) {
    roll -= o.weight;
    if (roll <= 0) return o.id;
  }
  return options[0].id;
}

function tickGovernments(director, nowMs, rng) {
  const random = rng ?? agentRng("government");
  const now = nowMs ?? Date.now();
  try {
    const byKingdom = recordsByKingdom(director);
    for (const [kingdomId, records] of byKingdom) {
      try {
        const council = Gov.ensureCouncil(
          kingdomId,
          kingdomNameFor(director, kingdomId, records),
          now
        );

        // 1. Nominations before the election.
        gatherNominations(director, council, records, now, random);

        // 2. Election day.
        if (now >= council.nextElectionAtMs && council.candidates.length > 0) {
          const ctx = buildCtx(director, council);
          const seats = Gov.runElection(kingdomId, records, council.candidates, ctx, now);
          const mayor = seats[0];
          if (mayor) {
            sayPublicTo(
              director,
              mayor.citizenName,
              `The votes are counted — ${mayor.displayName} is the new mayor of ${council.kingdomName}!`
            );
          }
          council.lastSessionAtMs = now;
          continue; // fresh council sits next session
        }

        // 3. Council session every few days.
        if (
          council.seats.length > 0 &&
          now - council.lastSessionAtMs >= Gov.LAW_SESSION_MS
        ) {
          council.lastSessionAtMs = now;
          const lawId = chooseLaw(council, director, random);
          if (lawId) {
            const proposer = council.seats[Math.floor(random() * council.seats.length)];
            const law = Gov.passLaw(
              kingdomId,
              lawId,
              proposer?.citizenName,
              now,
              // Festivals and market days are seasonal (30 days); the rest stand.
              lawId === "festival" || lawId === "market-day"
                ? 30 * 24 * 60 * 60 * 1000
                : null
            );
            if (law && proposer) {
              sayPublicTo(
                director,
                proposer.citizenName,
                `Hear ye! The council has passed "${law.name}".`
              );
            }
          }
          try {
            Gov._data().councils[kingdomId] = council;
          } catch {
            // markDirty already called by passLaw paths
          }
        }

        // 4. Unrest drift + flashpoints.
        if (council.seats.length === 0 && council.dissolvedAtMs > 0) {
          // Awaiting snap election — tension simmers but doesn't boil.
          Gov.adjustUnrest(kingdomId, -1);
        } else {
          // Slow drift toward calm.
          Gov.adjustUnrest(kingdomId, -1);
          // Grumbling: tiny chance of a scandal or a good harvest.
          const roll = random();
          if (roll < 0.02) {
            Gov.adjustUnrest(kingdomId, 8);
            journalEvent(
              council.kingdomName,
              "A council scandal sets tongues wagging in the market.",
              "politics"
            );
          } else if (roll < 0.05) {
            Gov.adjustUnrest(kingdomId, -6);
            journalEvent(
              council.kingdomName,
              "A good harvest puts the town in a generous mood.",
              "politics"
            );
          }
        }

        // 5. Protests and dissolution.
        if (council.unrest >= Gov.UNREST_DISSOLVE_AT && council.seats.length > 0) {
          const mayor = Gov.mayorOf(kingdomId);
          if (mayor) {
            sayPublicTo(
              director,
              mayor.citizenName,
              "This council has lost the town's trust! We demand new elections!"
            );
          }
          journalEvent(
            council.kingdomName,
            "Unrest boiled over — the council was dissolved and a snap election called.",
            "politics"
          );
          Gov.dissolveCouncil(kingdomId, now, "unrest");
        } else if (
          council.unrest >= Gov.UNREST_PROTEST_AT &&
          random() < 0.3 &&
          council.seats.length > 0
        ) {
          const protester =
            records[Math.floor(random() * records.length)];
          if (protester) {
            sayPublicTo(
              director,
              protester.username,
              "Down with the council! We deserve better than this!"
            );
            journalEvent(
              protester.username,
              `Joined a protest against the ${council.kingdomName} council.`,
              "politics"
            );
          }
        }
      } catch {
        // One kingdom's politics must never break the loop.
      }
    }
  } catch (e) {
    try {
      director?.log?.("governments tick failed", { error: String(e?.message ?? e) });
    } catch {
      // last resort
    }
  }
}

module.exports = {
  tickGovernments,
  // test seams
  _gatherNominations: gatherNominations,
  _chooseLaw: chooseLaw,
  _recordsByKingdom: recordsByKingdom,
};
