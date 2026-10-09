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
const ELECTION_WINDOW_MS = 24 * 3600 * 1000; // only recent council-log elections count as news

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

/** Real players near a tile — canonical engine scan via a citizen bot's
 *  local-player list. Defensive: never throws, false when unknown. */
function anyRealPlayerNear(bot, tile, radius) {
  try {
    if (!bot || !tile) return false;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      try {
        if (p === bot) continue;
        if (p?.isPlayerBot?.() === true || p?.getHostAddress?.() === "bot") continue;
        const pp = p?.getPosition?.() ?? p?.position;
        if (!pp) continue;
        const dx = (pp.x ?? 0) - tile.x;
        const dy = (pp.y ?? 0) - tile.y;
        if (Math.hypot(dx, dy) <= radius) return true;
      } catch { /* one bad player never breaks the scan */ }
    }
    return false;
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
    // Module-relative require: KingdomStore lives at plugins/kingdoms/.
    const KingdomStore = require("../../kingdoms/KingdomStore");
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
      // Discovery records carry no home kingdom; claimedBy holds the
      // claiming kingdomId once a kingdom claims the discovery.
      Press.recordEvent(
        Press.BEAT_DISCOVERY, disc.claimedBy ?? "wanderer",
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
    // Canonical: topChampions(limit) -> [{ kingdomId, sportId, username,
    // season, at, tournamentId }]. There is no allChampions export.
    const champs = T.topChampions?.(50) ?? [];
    for (const c of champs) {
      if (!c?.tournamentId) continue;
      Press.recordEvent(
        Press.BEAT_CULTURE, c.kingdomId ?? "wanderer",
        `champion:${c.tournamentId}`,
        `${c.username ?? "a champion"} wins the ${c.sportId ?? "tournament"}`,
        Press.KIND_ROUTINE
      );
    }
  } catch { /* tournaments unavailable — skip */ }
}

function gatherElectionEvents(Press) {
  try {
    const Gov = require("./CitizenGovernment");
    // Canonical: allCouncils() -> council records; each council.log holds
    // { at, text } entries, including "<name> elected mayor with N votes."
    // There is no recentElections/latestElections export.
    const councils = Gov.allCouncils?.() ?? [];
    const now = Date.now();
    for (const council of councils) {
      const kid = council?.kingdomId ?? "wanderer";
      for (const entry of council?.log ?? []) {
        if (!entry || !/elected mayor/i.test(entry.text ?? "")) continue;
        if (now - (entry.at ?? 0) > ELECTION_WINDOW_MS) continue;
        Press.recordEvent(
          Press.BEAT_POLITICS, kid,
          `election:${kid}:${entry.at}`,
          entry.text,
          Press.KIND_MAJOR
        );
      }
    }
  } catch { /* government unavailable — skip */ }
}

// --- the tick -----------------------------------------------------------------

function tickPress(director, nowMs) {
  const Press = pressApi();
  if (!Press) return;
  const now = nowMs ?? Date.now();

  // LOD: one roster scan, reused by every pass below. With no citizens
  // online there is nobody to register, nobody to investigate, and no
  // kingdom audience — skip the whole tick (including event gathering).
  let online = [];
  try {
    online = onlineCitizens(director);
  } catch { /* roster unreadable — skip */ }
  if (!online.length) return;

  // 1. Register reporters from online citizens.
  try {
    for (const record of online) {
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
    for (const record of online) {
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
    for (const record of online) {
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
        // Announce near real players: find a newsboy bot first, then check
        // for real players near the press via the canonical engine scan.
        const last = lastAnnounceByKingdom.get(kid) ?? 0;
        if (last > 0 && now - last < ANNOUNCE_COOLDOWN_MS) continue;
        let bot = null;
        for (const record of online) {
          bot = botFor(director, record);
          if (bot) break;
        }
        if (!bot) continue;
        const press = Press.pressFor(kid);
        if (!anyRealPlayerNear(bot, press?.tile, 30)) continue;
        try {
          const ed = res.edition;
          sayPublic(bot, `Extra! Extra! Special edition — ${ed.storyIds.length} stories on ${ed.beat}. ${Press.SUBSCRIPTION_PRICE} coins a subscription!`);
          lastAnnounceByKingdom.set(kid, now);
        } catch { /* speech failed — skip */ }
      } catch { /* one bad kingdom never breaks the tick */ }
    }
  } catch { /* edition pass failed — skip */ }
}

function resetForTests() {
  lastAnnounceByKingdom.clear();
  lastStoryByReporter.clear();
}

module.exports = { tickPress, resetForTests };
