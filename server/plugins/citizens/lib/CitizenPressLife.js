"use strict";

/**
 * CitizenPressLife — the slow-tick dynamics for the journalism layer.
 *
 * Wired into the director's slow tick (next to the other citizen systems)
 * inside try/catch so one bad tick never breaks the server. Zero LLM.
 *
 * Per tick:
 *   1. Register journalists: ONLINE citizens in the journalist career (or
 *      curious/social citizens when a kingdom has no reporter).
 *   2. Gather events: defensive reads of real module state —
 *      wars (KingdomStore), trials (CitizenJusticeLife), elections/laws
 *      (CitizenGovernment), discoveries (CitizenDiscovery), champions
 *      (CitizenTournaments). Everything guarded; missing modules degrade
 *      to whatever is available. Never throws.
 *   3. Investigate: registered journalists claim unclaimed events on their
 *      kingdom's beats and file stories (quality from real engagement).
 *   4. Special editions: major events (war declared, election held,
 *      landmark completed, champion crowned) or 3+ stories on one beat
 *      within 48h trigger an edition — printed only if the press holds
 *      real papyrus, distributed to subscribers first.
 *   5. Announce: sayPublic near real players (throttled per kingdom) so
 *      citizens can hear the newsboy's cry; everything journaled.
 *
 * Never throws: the director calls this inside its own try/catch as well.
 */

const { sayPublic } = require("../chat/CitizenSayPublic");

const ANNOUNCE_COOLDOWN_MS = 6 * 3600 * 1000; // one news cry per kingdom per 6h
const INVESTIGATE_COOLDOWN_MS = 30 * 60 * 1000; // one story per reporter per 30m

const lastAnnounceByKingdom = new Map(); // kingdomId -> ms
const lastStoryByReporter = new Map(); // norm -> ms

function pressApi() {
  try {
    return require("./CitizenPress");
  } catch {
    return null;
  }
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

/** Online citizens from the director roster, defensively. */
function onlineCitizens(director) {
  try {
    const out = [];
    const roster = director?.roster;
    const values = roster?.values?.() ?? roster ?? [];
    for (const r of values) {
      try {
        if (r && director.isOnline?.(r)) out.push(r);
      } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

function kingdomIdOf(record) {
  try {
    return record?.kingdomId ?? record?.kingdom ?? null;
  } catch {
    return null;
  }
}

function careerOf(record) {
  try {
    return record?.career ?? record?.job ?? null;
  } catch {
    return null;
  }
}

function personalityOf(record) {
  try {
    return record?.personality ?? {};
  } catch {
    return {};
  }
}

/** A citizen who smells like a reporter: journalist career, or curious/social. */
function looksLikeReporter(record) {
  try {
    if (careerOf(record) === "journalist") return true;
    const p = personalityOf(record);
    return (p.curiosity ?? 0) >= 0.6 || (p.sociability ?? 0) >= 0.6;
  } catch {
    return false;
  }
}

/** Real players near a tile — for announcements. Defensive. */
function anyRealPlayerNear(director, tile, radius) {
  try {
    if (!director || !tile) return false;
    const players = director.getRealPlayersNear?.(tile, radius)
      ?? director.realPlayersNear?.(tile, radius)
      ?? [];
    return Array.isArray(players) ? players.length > 0 : !!players;
  } catch {
    return false;
  }
}

function botFor(director, record) {
  try {
    return director.isOnline?.(record) ? director.getBot?.(record) : null;
  } catch {
    return null;
  }
}

// --- event gathering (all defensive) -----------------------------------------

function gatherWarEvents(Press) {
  try {
    const path = require("path");
    const KingdomStore = require(path.join("..", "kingdoms", "KingdomStore"));
    const wars = KingdomStore.getActiveWars?.() ?? [];
    for (const w of wars) {
      const a = w?.attackerId, d = w?.defenderId;
      if (!a || !d) continue;
      Press.recordEvent(
        Press.BEAT_WAR, d,
        `war:${a}:${d}`,
        `${a} marches on ${d}`,
        Press.KIND_MAJOR
      );
    }
  } catch { /* kingdoms unavailable — skip */ }
}

function gatherDiscoveryEvents(Press) {
  try {
    const Discovery = require("./CitizenDiscovery");
    const all = Discovery.allDiscoveries?.() ?? Discovery.recentDiscoveries?.(50) ?? [];
    for (const disc of all) {
      if (!disc?.id) continue;
      Press.recordEvent(
        Press.BEAT_DISCOVERY, disc.kingdomId ?? "wanderer",
        `discovery:${disc.id}`,
        `${disc.type ?? "discovery"} found${disc.discoverer ? ` by ${disc.discoverer}` : ""}`,
        Press.KIND_ROUTINE
      );
    }
  } catch { /* discoveries unavailable — skip */ }
}

function gatherChampionEvents(Press) {
  try {
    const T = require("./CitizenTournaments");
    const champs = T.allChampions?.() ?? [];
    for (const c of champs) {
      if (!c?.tournamentId) continue;
      Press.recordEvent(
        Press.BEAT_CULTURE, c.kingdomId ?? "wanderer",
        `champion:${c.tournamentId}`,
        `${c.winner ?? "a champion"} wins the ${c.sportId ?? "tournament"}`,
        c.isChampionship ? Press.KIND_MAJOR : Press.KIND_ROUTINE
      );
    }
  } catch { /* tournaments unavailable — skip */ }
}

function gatherElectionEvents(Press) {
  try {
    const Gov = require("./CitizenGovernment");
    const recent = Gov.recentElections?.(10) ?? Gov.latestElections?.() ?? [];
    const list = Array.isArray(recent) ? recent : [recent].filter(Boolean);
    for (const e of list) {
      if (!e?.id && !e?.kingdomId) continue;
      Press.recordEvent(
        Press.BEAT_POLITICS, e.kingdomId ?? "wanderer",
        `election:${e.id ?? e.kingdomId}:${e.heldAt ?? ""}`,
        e.summary ?? `election held in ${e.kingdomId}`,
        Press.KIND_MAJOR
      );
    }
  } catch { /* government unavailable — skip */ }
}

// --- the tick -----------------------------------------------------------------

function tickPress(director, nowMs) {
  const Press = pressApi();
  if (!Press) return;
  const now = nowMs ?? Date.now();

  // 1. Register reporters from online citizens.
  try {
    for (const record of onlineCitizens(director)) {
      try {
        if (!looksLikeReporter(record)) continue;
        const kid = kingdomIdOf(record);
        if (!kid) continue;
        const name = record.username ?? record.name;
        if (!name) continue;
        Press.registerJournalist(name, kid);
      } catch { /* one bad citizen never breaks the tick */ }
    }
  } catch { /* roster unreadable — skip */ }

  // 2. Gather real events from the realm.
  gatherWarEvents(Press);
  gatherDiscoveryEvents(Press);
  gatherChampionEvents(Press);
  gatherElectionEvents(Press);

  // 3. Journalists investigate: claim unclaimed events, file stories.
  try {
    for (const record of onlineCitizens(director)) {
      try {
        const name = record.username ?? record.name;
        if (!name || !Press.isJournalist(name)) continue;
        const key = norm(name);
        const last = lastStoryByReporter.get(key) ?? 0;
        if (last > 0 && now - last < INVESTIGATE_COOLDOWN_MS) continue;
        const kid = kingdomIdOf(record);
        if (!kid) continue;
        for (const beat of Press.BEATS) {
          const open = Press.unclaimedEvents(beat, kid);
          if (!open.length) continue;
          const res = Press.fileStory(name, open[0].id);
          if (res.ok) {
            lastStoryByReporter.set(key, now);
            const deeds = Press.fameDeedsFor(name);
            try {
              const Rep = require("./CitizenReputation");
              for (const d of deeds) Rep.awardDeed?.(name, d);
            } catch { /* reputation unavailable */ }
          }
          break; // one story per tick per reporter
        }
      } catch { /* one bad citizen never breaks the tick */ }
    }
  } catch { /* investigation pass failed — skip */ }

  // 4. Special editions: major events or 3+ stories on one beat.
  try {
    const seenKingdoms = new Set();
    for (const record of onlineCitizens(director)) {
      const kid = kingdomIdOf(record);
      if (kid) seenKingdoms.add(String(kid).toLowerCase());
    }
    for (const kid of seenKingdoms) {
      try {
        Press.ensurePress(kid);
        // Major-event trigger first.
        const majors = Press.majorEventsSince(kid, 24 * 3600 * 1000);
        let trigger = null;
        if (majors.length) {
          trigger = `major:${majors[0].beat}`;
        } else {
          // Accumulation trigger: 3+ unpublished stories on one beat.
          for (const beat of Press.BEATS) {
            if (Press.storiesFor(kid, beat).length >= 3) { trigger = `beat:${beat}`; break; }
          }
        }
        if (!trigger) continue;
        const beat = trigger.startsWith("major:") ? majors[0].beat : trigger.slice(5);
        const res = Press.compileEdition(kid, beat, trigger);
        if (!res.ok) continue; // no paper / no stories — honest skip
        // Distribute to subscribers (records the read for salience).
        for (const sub of Press.subscribersIn(kid)) {
          try { Press.recordRead(sub.username, res.id); } catch { /* skip */ }
        }
        // Announce near real players.
        const last = lastAnnounceByKingdom.get(kid) ?? 0;
        if (last > 0 && now - last < ANNOUNCE_COOLDOWN_MS) continue;
        const press = Press.pressFor(kid);
        if (!anyRealPlayerNear(director, press?.tile, 30)) continue;
        const bot = (() => {
          for (const record of onlineCitizens(director)) {
            const b = botFor(director, record);
            if (b) return b;
          }
          return null;
        })();
        if (bot) {
          try {
            const ed = res.edition;
            sayPublic(bot, `Extra! Extra! Special edition — ${ed.storyIds.length} stories on ${ed.beat}. ${Press.SUBSCRIPTION_PRICE} coins a subscription!`);
            lastAnnounceByKingdom.set(kid, now);
          } catch { /* speech failed — skip */ }
        }
      } catch { /* one bad kingdom never breaks the tick */ }
    }
  } catch { /* edition pass failed — skip */ }
}

function resetForTests() {
  lastAnnounceByKingdom.clear();
  lastStoryByReporter.clear();
}

module.exports = { tickPress, resetForTests };
