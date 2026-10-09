"use strict";

/**
 * CitizenClanLife — the dynamics of citizen-formed clans (director tick).
 *
 * Data tier, zero LLM. Every decision below reads real state: the roster,
 * the CitizenBonds friendship graph, personalities, goals, the journal.
 * Nothing is hash-derived.
 *
 * Per slow tick, for each kingdom:
 *   1. Formation — an eligible founder (leadership traits, 3+ citizen
 *      friends, clanless) may found a clan and invite mutual friends.
 *   2. Growth — members invite their friends; friends accept.
 *   3. Player invites — leaders invite trusted player friends; players
 *      accept with "yes" (handled in CitizenChat -> acceptInvite).
 *   4. Join requests — founders accept requests from player friends.
 *   5. Warmth — nearby clanmates greet each other like real clanmates.
 *   6. Outings — clan fishing trips, mining expeditions, market runs,
 *      musters and tavern nights. Members follow the leader (existing
 *      follow machinery); shared time feeds the rapport system.
 *   7. Celebrations — when a member levels (real journal achievement
 *      events), the clan celebrates.
 *   8. Moots — every 7 days, two clans per kingdom hold a friendly
 *      skill moot scored on REAL achievement events. Winner announced.
 *
 * Wiring: CitizenDirector.tick() calls tickClans(director, nowMs).
 */

const Clans = require("./CitizenClans");
const {
  bonds,
  isFriend,
  getInvites,
  sendInvite,
  setFollow,
  clearFollow,
  getFollow,
  INVITE_CLAN,
  normalizeName,
} = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");
const { noteInteraction } = require("../brain/CitizenRelationships");

// Formation / growth / invite probabilities per slow tick.
const FOUND_CHANCE = 0.02;
const GROW_CHANCE = 0.05;
const PLAYER_INVITE_CHANCE = 0.03;
const OUTING_CHANCE = 0.04;
const WARMTH_CHANCE = 0.10;

const OUTING_MINUTES = 30;
const NUDGE_MS = 30 * 1000;
const MOOT_MS = 7 * 24 * 3600 * 1000;
const ARRIVE_TILES = 3;

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function botTile(bot) {
  try {
    const loc = bot?.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function isMoving(bot) {
  try {
    return (bot?.getMovementQueue?.()?.size?.() ?? 0) > 0;
  } catch {
    return false;
  }
}

function moveBot(bot, tile, reason) {
  try {
    const { requestMovement } = require("../../bots/behaviours/navigation/BotNavigation");
    requestMovement(bot, tile.x, tile.y, { reason, basicPather: true, z: tile.z ?? 0 });
    return true;
  } catch {
    return false;
  }
}

function findPlayerByName(director, playerName) {
  try {
    const world = director?.api?.core?.World ?? null;
    return world?.getPlayerByName?.(playerName) ?? null;
  } catch {
    return null;
  }
}

function notifyPlayer(director, playerName, text) {
  try {
    const p = findPlayerByName(director, playerName);
    p?.sendMessage?.(text);
    return !!p;
  } catch {
    return false;
  }
}

function speak(record, bot, pool, rng) {
  if (!bot) return false;
  try {
    const voice = voiceFor(record?.personality);
    const line = voiceLine(voice, pool, rng);
    if (!line) return false;
    sayPublic(bot, line.slice(0, 80));
    return true;
  } catch {
    return false;
  }
}

function isRosterCitizen(director, name) {
  try {
    return director?.roster?.has?.(normalizeName(name)) ?? false;
  } catch {
    return false;
  }
}

function recordFor(director, name) {
  try {
    return director?.roster?.get?.(normalizeName(name)) ?? null;
  } catch {
    return null;
  }
}

function displayOf(record, fallback) {
  return record?.displayName ?? fallback ?? record?.username ?? "someone";
}

// --- 1. formation --------------------------------------------------------------

const FOUND_LINES = Object.freeze({
  plain: Object.freeze([
    "right — we're a clan now. {name}. stick together, yeah?",
    "started a clan: {name}. friends first, always.",
    "{name} is official. we've got each other.",
  ]),
  terse: Object.freeze(["clan's formed. {name}.", "{name}. we're in this together."]),
});

function maybeFoundClan(director, record, rng) {
  const name = record.username;
  if (!Clans.founderEligible(record, (n) => isRosterCitizen(director, n))) return false;
  if (!chance(rng, FOUND_CHANCE)) return false;
  // Cap clans per kingdom so the map doesn't drown in them.
  if (Clans.clansInKingdom(record.kingdomId).length >= Clans.MAX_CLANS_PER_KINGDOM) return false;

  const kind = Clans.kindForRecord(record);
  const clan = Clans.createClan(name, displayOf(record, name), record.kingdomId, kind);
  if (!clan) return false;

  // Seed with mutual friends: founder's friends who share the kind (or are
  // just close), up to 4. Friends accept — that's what friends do.
  const candidates = [];
  try {
    for (const f of bonds(name).friends ?? []) {
      if (!isRosterCitizen(director, f)) continue;
      if (Clans.clanOf(f)) continue;
      const fr = recordFor(director, f);
      if (!fr || String(fr.kingdomId) !== String(record.kingdomId)) continue;
      candidates.push({ name: f, sameKind: Clans.kindForRecord(fr) === kind });
    }
  } catch {
    // No candidates — founder goes solo for now.
  }
  candidates.sort((a, b) => (b.sameKind ? 1 : 0) - (a.sameKind ? 1 : 0));
  for (const c of candidates.slice(0, 4)) {
    try {
      const id = Clans.inviteCitizen(name, c.name, clan.id);
      if (id) {
        // acceptClanInvite resolves the pending invite AND adds the member.
        Clans.acceptClanInvite(c.name, clan.id, true);
      }
    } catch {
      // One bad invite never breaks formation.
    }
  }

  const bot = director.getBot ? director.getBot(record) : null;
  speak(
    record,
    bot,
    {
      plain: FOUND_LINES.plain.map((l) => l.replace("{name}", clan.name)),
      terse: FOUND_LINES.terse.map((l) => l.replace("{name}", clan.name)),
    },
    rng
  );
  return true;
}

// --- 2. growth -----------------------------------------------------------------

function maybeGrowClan(director, clan, rng) {
  if (!chance(rng, GROW_CHANCE)) return false;
  if ((clan.members?.length ?? 0) >= Clans.MAX_MEMBERS) return false;
  const members = clan.members ?? [];
  if (members.length === 0) return false;
  const inviter = pickOne(rng, members);
  const inviterRecord = recordFor(director, inviter);
  if (!inviterRecord) return false;

  // Invite a friend of a member: prefer same-kind, same kingdom, clanless.
  const seen = new Set(members);
  const candidates = [];
  try {
    for (const m of members) {
      for (const f of bonds(m).friends ?? []) {
        if (seen.has(normalizeName(f))) continue;
        seen.add(normalizeName(f));
        if (!isRosterCitizen(director, f)) continue;
        if (Clans.clanOf(f)) continue;
        const fr = recordFor(director, f);
        if (!fr || String(fr.kingdomId) !== String(clan.kingdomId)) continue;
        candidates.push({ name: f, sameKind: Clans.kindForRecord(fr) === clan.kind });
      }
    }
  } catch {
    return false;
  }
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => (b.sameKind ? 1 : 0) - (a.sameKind ? 1 : 0));
  const target = candidates[0];
  try {
    const id = Clans.inviteCitizen(inviter, target.name, clan.id);
    if (!id) return false;
    // acceptClanInvite resolves the pending invite AND adds the member.
    const ok = Clans.acceptClanInvite(target.name, clan.id, true);
    if (ok) {
      journalEvent(inviter, `Invited ${target.name} into the clan '${clan.name}'.`, "social");
      return true;
    }
  } catch {
    // Non-fatal.
  }
  return false;
}

// --- 3. player invites ------------------------------------------------------------

const PLAYER_INVITE_LINES = Object.freeze({
  plain: Object.freeze([
    "hey — you'd fit right in with {name}. join us?",
    "{name} could use someone like you. interested?",
  ]),
  terse: Object.freeze(["{name}. you'd fit. join?"]),
});

function maybeInvitePlayer(director, clan, rng) {
  if (!chance(rng, PLAYER_INVITE_CHANCE)) return false;
  if ((clan.playerMembers?.length ?? 0) >= Clans.MAX_PLAYER_MEMBERS) return false;
  const members = clan.members ?? [];
  if (members.length === 0) return false;
  const inviter = pickOne(rng, members);
  const inviterRecord = recordFor(director, inviter);
  if (!inviterRecord) return false;

  // Player friends of the inviter: friends not on the citizen roster.
  let playerFriends = [];
  try {
    playerFriends = (bonds(inviter).friends ?? []).filter(
      (f) => !isRosterCitizen(director, f) && !Clans.clanOfPlayer(f)
    );
  } catch {
    return false;
  }
  if (playerFriends.length === 0) return false;
  const playerName = pickOne(rng, playerFriends);
  const id = Clans.invitePlayer(inviter, playerName, clan.id);
  if (!id) return false;
  journalEvent(inviter, `Invited ${playerName} to join the clan '${clan.name}'.`, "social");
  notifyPlayer(
    director,
    playerName,
    `${displayOf(inviterRecord, inviter)} invited you to join their clan '${clan.name}'. Reply "yes" to accept.`
  );
  const bot = director.getBot ? director.getBot(inviterRecord) : null;
  speak(
    inviterRecord,
    bot,
    {
      plain: PLAYER_INVITE_LINES.plain.map((l) => l.replace("{name}", clan.name)),
      terse: PLAYER_INVITE_LINES.terse.map((l) => l.replace("{name}", clan.name)),
    },
    rng
  );
  return true;
}

// --- 5. warmth: nearby clanmates greet --------------------------------------------

const GREET_LINES = Object.freeze({
  plain: Object.freeze([
    "oi oi, clanmate!",
    "good to see you, {name}.",
    "{name}! how's the {kind} life?",
  ]),
  terse: Object.freeze(["oi.", "{name}."]),
});

const KIND_NOUNS = Object.freeze({
  craft: "crafting",
  trade: "trading",
  guard: "watch",
  skill: "grind",
  social: "rounds",
});

function tickWarmth(director, clan, rng) {
  const members = clan.members ?? [];
  if (members.length < 2) return;
  // Sample up to 3 random pairs per tick — cheap.
  for (let i = 0; i < 3; i++) {
    const a = pickOne(rng, members);
    let b = pickOne(rng, members);
    if (normalizeName(a) === normalizeName(b)) continue;
    const ra = recordFor(director, a);
    const rb = recordFor(director, b);
    if (!ra || !rb) continue;
    const botA = director.getBot ? director.getBot(ra) : null;
    const botB = director.getBot ? director.getBot(rb) : null;
    if (!botA || !botB) continue;
    const ta = botTile(botA);
    const tb = botTile(botB);
    if (!ta || !tb || (ta.z ?? 0) !== (tb.z ?? 0)) continue;
    if (chebyshev(ta, tb) > 8) continue;
    if (!chance(rng, WARMTH_CHANCE)) continue;
    speak(
      ra,
      botA,
      {
        plain: GREET_LINES.plain.map((l) =>
          l.replace("{name}", displayOf(rb, b)).replace("{kind}", KIND_NOUNS[clan.kind] ?? "day")
        ),
        terse: GREET_LINES.terse.map((l) => l.replace("{name}", displayOf(rb, b))),
      },
      rng
    );
    return; // one greeting per clan per tick is plenty
  }
}

// --- 6. outings -------------------------------------------------------------------

const OUTINGS = Object.freeze({
  skill: [
    { activity: "fishing", label: "fishing trip", site: "dock" },
    { activity: "mining", label: "mining expedition", site: "rocks" },
  ],
  trade: [{ activity: "market", label: "market run", site: "market" }],
  guard: [{ activity: "muster", label: "muster", site: "square" }],
  craft: [{ activity: "work", label: "work detail", site: "work" }],
  social: [{ activity: "tavern", label: "tavern night", site: "tavern" }],
});

const OUTING_START_LINES = Object.freeze({
  plain: Object.freeze([
    "clan outing — {label}! who's coming?",
    "{label} time, {name}. let's go!",
  ]),
  terse: Object.freeze(["{label}. move out.", "clan {label}. now."]),
});

const OUTING_END_LINES = Object.freeze({
  plain: Object.freeze([
    "good {label}, everyone. same time next week?",
    "that's the {label} done. well worked.",
  ]),
  terse: Object.freeze(["done. good work.", "{label} over."]),
});

function outingSiteFor(clan, rng) {
  const defs = OUTINGS[clan.kind] ?? OUTINGS.social;
  const def = pickOne(rng, defs);
  const tile = siteTileByKingdom(clan.kingdomId, def.site) ??
    siteTileByKingdom(clan.kingdomId, "square") ??
    siteTileByKingdom(clan.kingdomId, "market");
  if (!tile) return null;
  return { ...def, tile };
}

function onlineMembers(director, clan) {
  const out = [];
  for (const m of clan.members ?? []) {
    const rec = recordFor(director, m);
    if (!rec) continue;
    let bot = null;
    try {
      bot = director.getBot ? director.getBot(rec) : null;
    } catch {
      bot = null;
    }
    if (bot) out.push({ name: m, record: rec, bot });
  }
  return out;
}

function maybeStartOuting(director, clan, rng, nowMs) {
  if (clan.activeOuting) return false;
  if (!chance(rng, OUTING_CHANCE)) return false;
  const online = onlineMembers(director, clan);
  if (online.length < 2) return false;
  const outing = outingSiteFor(clan, rng);
  if (!outing) return false;
  const leaderEntry = online.find((e) => normalizeName(e.name) === normalizeName(clan.leader)) ?? online[0];
  clan.activeOuting = {
    activity: outing.activity,
    label: outing.label,
    dest: outing.tile,
    leaderName: leaderEntry.name,
    startedAt: nowMs,
    endsAt: nowMs + OUTING_MINUTES * 60 * 1000,
    lastNudgeAt: 0,
  };
  for (const e of online) {
    if (normalizeName(e.name) === normalizeName(leaderEntry.name)) continue;
    try {
      setFollow(e.name, leaderEntry.name, "clan_outing");
    } catch {
      // Non-fatal.
    }
    journalEvent(e.name, `Joined the clan ${outing.label} to ${labelDest(outing)}.`, "social");
  }
  journalEvent(leaderEntry.name, `Led the clan ${outing.label}.`, "social");
  Clans.recordActivity(clan, `Clan ${outing.label} began.`);
  // Head out immediately — no reason to wait for the next tick.
  clan.activeOuting.lastNudgeAt = nowMs;
  moveBot(leaderEntry.bot, clan.activeOuting.dest, "clan_outing");
  speak(
    leaderEntry.record,
    leaderEntry.bot,
    {
      plain: OUTING_START_LINES.plain.map((l) =>
        l.replace("{label}", outing.label).replace("{name}", clan.name)
      ),
      terse: OUTING_START_LINES.terse.map((l) => l.replace("{label}", outing.label)),
    },
    rng
  );
  return true;
}

function labelDest(outing) {
  return outing.site === "dock" ? "the docks"
    : outing.site === "rocks" ? "the mines"
    : outing.site === "market" ? "the market"
    : outing.site === "tavern" ? "the tavern"
    : "the square";
}

function maintainOuting(director, clan, rng, nowMs) {
  const outing = clan.activeOuting;
  if (!outing) return;
  const end = (note) => {
    for (const m of clan.members ?? []) {
      try {
        if (getFollow(m)?.reason === "clan_outing") clearFollow(m);
      } catch {
        // Non-fatal.
      }
    }
    clan.activeOuting = null;
    Clans.recordActivity(clan, `Clan ${outing.label} ended (${note}).`);
    // Shared time builds real rapport — the relationship system notices.
    const online = onlineMembers(director, clan);
    for (const e of online) {
      if (normalizeName(e.name) === normalizeName(outing.leaderName)) continue;
      try {
        noteInteraction(e.name, outing.leaderName, "workedAlongside");
      } catch {
        // Non-fatal.
      }
    }
    const leaderRec = recordFor(director, outing.leaderName);
    const leaderBot = leaderRec && director.getBot ? director.getBot(leaderRec) : null;
    speak(
      leaderRec,
      leaderBot,
      {
        plain: OUTING_END_LINES.plain.map((l) => l.replace("{label}", outing.label)),
        terse: OUTING_END_LINES.terse.map((l) => l.replace("{label}", outing.label)),
      },
      rng
    );
  };

  if (nowMs >= outing.endsAt) {
    end("time");
    return;
  }
  const leaderRec = recordFor(director, outing.leaderName);
  const leaderBot = leaderRec && director.getBot ? director.getBot(leaderRec) : null;
  if (!leaderBot) return; // leader offline — outing idles until they return or time out
  if (isMoving(leaderBot)) return;
  const tile = botTile(leaderBot);
  if (tile && outing.dest && chebyshev(tile, outing.dest) <= ARRIVE_TILES) return; // arrived
  if (nowMs - (outing.lastNudgeAt ?? 0) < NUDGE_MS) return;
  outing.lastNudgeAt = nowMs;
  moveBot(leaderBot, outing.dest, "clan_outing");
}

// --- 7. celebrations ----------------------------------------------------------------

const CELEBRATE_LINES = Object.freeze({
  plain: Object.freeze([
    "big gz, {name}! {clan} proud!",
    "{name} just hit {level} {skill}! drinks are on... someone!",
    "that's our clanmate! gz {name}!",
  ]),
  terse: Object.freeze(["gz {name}.", "nice one, {name}."]),
});

function tickCelebrations(director, clan, rng, nowMs) {
  let best = null; // { member, level, skill, at }
  for (const m of clan.members ?? []) {
    let events = [];
    try {
      events = getJournal().recent(m, 25) ?? [];
    } catch {
      continue;
    }
    for (const e of events) {
      const at = Number(e?.at ?? 0);
      if (at <= (clan.lastCelebScan ?? 0)) continue;
      if (String(e?.kind ?? "").toLowerCase() !== "achievement") continue;
      const level = Number(e?.data?.level ?? 0);
      const skill = String(e?.data?.skill ?? "");
      if (!best || at > best.at) best = { member: m, level, skill, at };
    }
  }
  if (!best) return;
  clan.lastCelebScan = best.at;

  const achieverRec = recordFor(director, best.member);
  const achieverDisplay = displayOf(achieverRec, best.member);
  // Up to two online clanmates congratulate.
  const online = onlineMembers(director, clan).filter(
    (e) => normalizeName(e.name) !== normalizeName(best.member)
  );
  let cheered = 0;
  for (const e of online.slice(0, 2)) {
    const ok = speak(
      e.record,
      e.bot,
      {
        plain: CELEBRATE_LINES.plain.map((l) =>
          l
            .replace("{name}", achieverDisplay)
            .replace("{clan}", clan.name)
            .replace("{level}", String(best.level || ""))
            .replace("{skill}", best.skill || "that skill")
        ),
        terse: CELEBRATE_LINES.terse.map((l) => l.replace("{name}", achieverDisplay)),
      },
      rng
    );
    if (ok) cheered += 1;
  }
  const note = cheered > 0
    ? `The clan celebrated ${achieverDisplay}'s level ${best.level} ${best.skill}.`
    : `${achieverDisplay} reached level ${best.level} ${best.skill} — the clan will hear of it.`;
  for (const m of clan.members ?? []) journalEvent(m, note, "social");
  Clans.recordActivity(clan, note);
}

// --- 8. moots: clan vs clan ------------------------------------------------------------

const MOOT_WIN_LINES = Object.freeze({
  plain: Object.freeze([
    "{us} takes the moot! {score} to {theirScore}. well earned, all of you.",
  ]),
  terse: Object.freeze(["moot won. {score}-{theirScore}."]),
});

function achievementScore(memberNames, sinceMs) {
  let score = 0;
  for (const m of memberNames) {
    let events = [];
    try {
      events = getJournal().recent(m, 60) ?? [];
    } catch {
      continue;
    }
    for (const e of events) {
      if (String(e?.kind ?? "").toLowerCase() !== "achievement") continue;
      if (Number(e?.at ?? 0) >= sinceMs) score += 1;
    }
  }
  return score;
}

function tickMoots(director, rng, nowMs) {
  // Group clans by kingdom.
  const byKingdom = new Map();
  for (const clan of Clans.allClans()) {
    if ((clan.members?.length ?? 0) < 2) continue;
    const kid = String(clan.kingdomId ?? "");
    if (!byKingdom.has(kid)) byKingdom.set(kid, []);
    byKingdom.get(kid).push(clan);
  }
  for (const [kid, clans] of byKingdom) {
    if (clans.length < 2) continue;
    if (nowMs - Clans.lastMootAt(kid) < MOOT_MS) continue;
    // Two contenders: the two largest clans (stable, legible rivalry).
    const sorted = [...clans].sort(
      (a, b) => (b.members?.length ?? 0) - (a.members?.length ?? 0)
    );
    const [a, b] = sorted;
    const since = nowMs - MOOT_MS;
    const scoreA = achievementScore(a.members, since);
    const scoreB = achievementScore(b.members, since);
    Clans.stampMoot(kid, nowMs);

    let resultLine;
    let winner = null;
    if (scoreA === scoreB) {
      resultLine = `The skill moot between '${a.name}' and '${b.name}' ended in an honorable draw, ${scoreA} apiece.`;
    } else {
      winner = scoreA > scoreB ? a : b;
      const loser = scoreA > scoreB ? b : a;
      const ws = Math.max(scoreA, scoreB);
      const ls = Math.min(scoreA, scoreB);
      resultLine = `'${winner.name}' won the skill moot against '${loser.name}', ${ws} to ${ls}.`;
    }
    for (const m of [...(a.members ?? []), ...(b.members ?? [])]) {
      journalEvent(m, resultLine, "social");
    }
    Clans.recordActivity(a, resultLine);
    Clans.recordActivity(b, resultLine);
    if (winner) {
      const wRec = recordFor(director, winner.leader);
      const wBot = wRec && director.getBot ? director.getBot(wRec) : null;
      const loser = winner === a ? b : a;
      const ws = Math.max(scoreA, scoreB);
      const ls = Math.min(scoreA, scoreB);
      speak(
        wRec,
        wBot,
        {
          plain: MOOT_WIN_LINES.plain.map((l) =>
            l
              .replace("{us}", winner.name)
              .replace("{score}", String(ws))
              .replace("{theirScore}", String(ls))
          ),
          terse: MOOT_WIN_LINES.terse.map((l) =>
            l.replace("{score}", String(ws)).replace("{theirScore}", String(ls))
          ),
        },
        rng
      );
    } else {
      // Draw: both founders get a word if online.
      for (const clan of [a, b]) {
        const rec = recordFor(director, clan.leader);
        const bot = rec && director.getBot ? director.getBot(rec) : null;
        speak(
          rec,
          bot,
          {
            plain: [`draw! '${a.name}' and '${b.name}' — rematch soon.`],
            terse: ["draw. rematch soon."],
          },
          rng
        );
      }
    }
  }
}

// --- main tick --------------------------------------------------------------------------

function tickClans(director, nowMs = Date.now()) {
  if (!director?.roster) return;
  const rng = agentRng(`clans:${nowMs >> 18}`);

  // Join requests first — players waiting on a founder shouldn't wait a tick cycle.
  try {
    Clans.processJoinRequests();
  } catch {
    // Non-fatal.
  }

  // Formation: scan roster citizens for founders.
  try {
    for (const record of director.roster.values()) {
      maybeFoundClan(director, record, rng);
    }
  } catch {
    // Non-fatal.
  }

  const clans = Clans.allClans();
  for (const clan of clans) {
    try {
      maybeGrowClan(director, clan, rng);
    } catch {
      // Non-fatal.
    }
    try {
      maybeInvitePlayer(director, clan, rng);
    } catch {
      // Non-fatal.
    }
    try {
      tickWarmth(director, clan, rng);
    } catch {
      // Non-fatal.
    }
    try {
      if (clan.activeOuting) maintainOuting(director, clan, rng, nowMs);
      else maybeStartOuting(director, clan, rng, nowMs);
    } catch {
      // Non-fatal.
    }
    try {
      tickCelebrations(director, clan, rng, nowMs);
    } catch {
      // Non-fatal.
    }
  }

  try {
    tickMoots(director, rng, nowMs);
  } catch {
    // Non-fatal.
  }
}

module.exports = {
  tickClans,
  // Test seams (pure-ish helpers).
  achievementScore,
  outingSiteFor,
  KIND_NOUNS,
  maybeFoundClan,
  maybeGrowClan,
  maybeInvitePlayer,
  maybeStartOuting,
  maintainOuting,
  tickCelebrations,
  tickMoots,
  tickWarmth,
};
