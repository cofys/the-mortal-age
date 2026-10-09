"use strict";

/**
 * CitizenDeathRespawn — the persistent death-respawn resolver.
 *
 * When a citizen bot dies in combat (monster, player, or misadventure), their
 * record must deterministically resolve to a respawn outcome that survives
 * restarts: where they wake, who they still are, and what happens to the
 * people and offices they leave behind. A human player wakes at their
 * respawn point, keeps their identity, and the world notices — so does a
 * citizen.
 *
 * HOW IT WORKS (all data tier, zero LLM):
 *  - attachDeathRespawn(bot, record): wires the engine seam. The engine's
 *    PlayerDeathTask already revives a dead bot and teleports it to
 *    `bot.__botResolveRespawnLocation()` when set; we point it at the
 *    citizen's hearth (their home-city tile, a pure function of the roster
 *    record). Called from CitizenDirector.spawnCitizen on every
 *    materialization, so the resolver is re-attached after every restart —
 *    that is what makes it persistent.
 *  - resolveDeathOutcome(record, detail): a pure deterministic function —
 *    same record + death detail, same outcome. The hearth never changes for
 *    a citizen; the sequence number comes from the persisted death counter.
 *  - recordCitizenDeath(director, record, { cause, killerName }, nowMs):
 *    appends the outcome to the persisted ledger
 *    (data/saves/citizen-deaths.json, dirty-flag pattern like
 *    citizen-funerals.json — the slow tick flushes it), then handles
 *    continuity:
 *      * identity: the roster record is NEVER removed — personality, goal,
 *        memory, journal, kinship and bonds all survive. The death is
 *        journaled into the citizen's own journal so the LLM mouth can riff
 *        truthfully later ("died to a goblin — embarrassing").
 *      * family: spouse/partner/close friends get a journaled word and a
 *        heardAbout("death") memory. (The street's visible reaction —
 *        nearby citizens saying "rip" — already lives in StreetNotices.)
 *      * office: a held office is unbound (the dead can't hold a seat); the
 *        existing tickOffices sweep refills it via kingdom:office-seeks-holder.
 *      * the realm hears: a "death" gossip for the kingdom.
 *  - onCitizenDeath(director, player, event, nowMs): the onPlayerDeath entry
 *    point — matches the dead player to a roster record and derives the
 *    cause/killer description.
 *
 * Boundary with CitizenFunerals: that module owns PERMANENT death (old-age
 * and accident mortality rolls) with mourning and burial. Combat death is
 * temporary — the citizen comes back, like a player would. The two never
 * double-handle: funerals only fires from its own data-tier mortality rolls,
 * this only fires from the engine's onPlayerDeath for a materialized bot.
 *
 * Plain-node testable: CitizenDeathRespawn.test.js.
 */

const fs = require("fs");
const path = require("path");
const { getJournal } = require("./CitizenJournal");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-deaths.json");

// Ledger bound — oldest death records fall off (counts are kept forever).
const MAX_DEATHS = 200;
// Hearth fallback mirrors CitizenDirector.tickProximity's home fallback.
const DEFAULT_HEARTH = { x: 3200, y: 3200, z: 0 };

let loaded = false;
let dirty = false;
const deaths = []; // outcome records, oldest first
const deathCounts = {}; // normalized username -> total combat deaths ever

function normalizeName(name) {
  return String(name ?? "").toLowerCase().trim();
}

// === Persistence — same shape as citizen-funerals.json (dirty flag, saveIfDirty) ===

function toJSON() {
  return {
    savedAt: Date.now(),
    counts: { ...deathCounts },
    deaths: deaths.map((d) => ({ ...d })),
  };
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    for (const [name, count] of Object.entries(parsed.counts || {})) {
      const n = Number(count);
      if (name && Number.isFinite(n) && n > 0) deathCounts[normalizeName(name)] = n;
    }
    for (const d of parsed.deaths || []) {
      if (d && d.username) deaths.push(d);
    }
    while (deaths.length > MAX_DEATHS) deaths.shift();
  } catch {
    // Corrupt or missing save — start empty, never crash.
  }
}

/** Test seam. */
function resetForTests() {
  deaths.length = 0;
  for (const k of Object.keys(deathCounts)) delete deathCounts[k];
  dirty = false;
  loaded = true;
}

function saveIfDirty() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(toJSON(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

// === Pure helpers — deterministic, no engine ===

/**
 * The citizen's hearth: their home-city tile from the roster record.
 * Pure function of the record — stable across restarts by construction.
 */
function hearthFor(record) {
  const h = record?.home;
  const x = Number(h?.x);
  const y = Number(h?.y);
  const z = Number(h?.z ?? 0);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y, z: Number.isFinite(z) ? z : 0 };
  }
  return { ...DEFAULT_HEARTH };
}

/**
 * Wire the engine's persistent respawn seam for one materialized bot.
 * PlayerDeathTask.resolveBotRespawnLocation() reads
 * `bot.__botResolveRespawnLocation` after reviving the bot and teleports it
 * to the returned tile (Location.readTile accepts {x, y, z}).
 * Returns true when attached.
 */
function attachDeathRespawn(bot, record) {
  if (!bot || !record) return false;
  const hearth = hearthFor(record);
  try {
    bot.__botResolveRespawnLocation = () => ({ x: hearth.x, y: hearth.y, z: hearth.z });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministically resolve a death to its respawn outcome.
 * Same record + detail => same outcome, every time, every restart.
 * Respawn is engine-immediate (the death task revives the bot a few ticks
 * after death), so respawnAt === diedAt: the outcome is WHERE and WHO,
 * not when.
 */
function resolveDeathOutcome(record, { deathSeq, diedAt, cause, killerName }) {
  return {
    username: normalizeName(record.username),
    display: record.display || record.username,
    kingdomId: record.kingdomId ?? null,
    deathSeq,
    diedAt,
    cause: cause || "died",
    killerName: killerName || null,
    hearth: hearthFor(record),
    respawnAt: diedAt,
  };
}

/** Total combat deaths ever recorded for a citizen (0 when unknown). */
function deathCountFor(username) {
  load();
  return deathCounts[normalizeName(username)] ?? 0;
}

/** The persisted death ledger, oldest first. */
function deathHistory() {
  load();
  return deaths.map((d) => ({ ...d }));
}

// === Death bookkeeping ===

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "death", text);
  } catch {
    // Non-fatal.
  }
}

function gossipDeath(kingdomId, text, nowMs, { username, display } = {}) {
  try {
    const mem = require("./CitizenMemory").getMemory();
    // seedGossip is the canonical gossip API (spreadGossipTick walks it
    // along social links on the director tick).
    mem?.seedGossip?.({
      kingdomId,
      kind: "death",
      subject: username ?? null,
      subjectDisplay: display ?? null,
      text,
      holder: username ?? null,
    });
  } catch {
    // Gossip is best-effort.
  }
}

/** The close circle: spouse, partner, and close friends. */
function closeCircleOf(username) {
  const out = new Set();
  try {
    const kin = require("./CitizenKinship");
    const norm = normalizeName(username);
    const spouse = kin.spouseOf?.(norm);
    if (spouse) out.add(normalizeName(spouse));
    const partner = kin.partnerOf?.(norm);
    if (partner?.other) out.add(normalizeName(partner.other));
    const bonds = kin.getKinship?.()?.of?.(norm) ?? [];
    for (const { other, bond } of bonds) {
      if (bond?.type === kin.BOND_FRIEND && bond?.stage === "close" && other) {
        out.add(normalizeName(other));
      }
    }
  } catch {
    // Kinship is best-effort.
  }
  out.delete(normalizeName(username));
  return [...out];
}

function notifyKin(username, display, cause, nowMs) {
  const circle = closeCircleOf(username);
  if (circle.length === 0) return;
  let mem = null;
  try {
    mem = require("./CitizenMemory").getMemory();
  } catch {
    // Memory is best-effort.
  }
  for (const kinName of circle) {
    journalEvent(
      kinName,
      `${display} ${cause} — they'll be back, they always come back.`,
      "death"
    );
    try {
      mem?.heardAbout?.(kinName, display, "death", 2, nowMs);
    } catch {
      // Non-fatal.
    }
  }
}

/**
 * A held office is vacated: the dead can't hold a seat. The existing
 * tickOffices sweep refills it via kingdom:office-seeks-holder — the
 * respawned citizen does not auto-reclaim it.
 * Returns the vacated office title, or null.
 */
function vacateOffice(username, display, cause, kingdomId, nowMs) {
  try {
    const CitizenOffices = require("./CitizenOffices");
    const held = CitizenOffices.officeOfCitizen?.(username);
    if (!held?.officeId) return null;
    const title = held.title || "office";
    CitizenOffices.unbindOffice?.(held.officeId);
    journalEvent(display, `${cause} — the ${title} seat stands empty.`, "death");
    gossipDeath(kingdomId, `${display} the ${title} ${cause}. The seat stands empty.`, nowMs, {
      username,
      display,
    });
    return title;
  } catch {
    return null;
  }
}

/**
 * Record a citizen's combat death and resolve its respawn outcome.
 * The roster record is deliberately left intact — identity continues.
 * Returns the outcome record, or null when the record is unusable.
 */
function recordCitizenDeath(director, record, { cause, killerName } = {}, nowMs = Date.now()) {
  if (!record?.username) return null;
  load();
  const username = normalizeName(record.username);
  const seq = (deathCounts[username] ?? 0) + 1;
  deathCounts[username] = seq;
  const outcome = resolveDeathOutcome(record, {
    deathSeq: seq,
    diedAt: nowMs,
    cause,
    killerName,
  });
  deaths.push(outcome);
  while (deaths.length > MAX_DEATHS) deaths.shift();
  dirty = true;

  const display = outcome.display;
  const deathText = `${display} ${outcome.cause}`;

  // Continuity of identity: their own journal remembers the death.
  journalEvent(
    username,
    `Died — ${outcome.cause}. Woke at the hearth, same as always.`,
    "death"
  );
  // The town hears.
  gossipDeath(record.kingdomId, `${deathText}.`, nowMs, { username, display });

  // Family and office.
  notifyKin(username, display, outcome.cause, nowMs);
  vacateOffice(username, display, outcome.cause, record.kingdomId, nowMs);

  return outcome;
}

/** Best-effort name for whatever killed the citizen (player or NPC). */
function describeKiller(killer) {
  if (!killer) return null;
  try {
    const direct =
      killer.getUsername?.() ?? killer.getName?.() ?? killer.username ?? killer.name ?? null;
    if (direct) return String(direct);
    const defName = killer.getDefinition?.()?.getName?.();
    if (defName) return String(defName);
  } catch {
    // Fall through.
  }
  return null;
}

/**
 * onPlayerDeath entry point for citizen bots. Matches the dead player to a
 * roster record and records the death; returns the outcome or null.
 * Real players (and unknown bots) pass through untouched.
 */
function onCitizenDeath(director, player, event, nowMs = Date.now()) {
  try {
    const username = player?.getUsername?.();
    if (!username || !director?.roster) return null;
    const record = director.roster.get(normalizeName(username));
    if (!record) return null;
    const killerName = describeKiller(event?.killer);
    const outcome = recordCitizenDeath(
      director,
      record,
      {
        cause: killerName ? `was slain by ${killerName}` : "died",
        killerName,
      },
      nowMs
    );
    // A killer with a name is personal: players and fellow citizens who
    // murder you earn a grudge (and a warning to your friends). NPC kills
    // are not personal — noteKill filters those out.
    try {
      require("./CitizenSocialBonds").noteKill(username, event?.killer, director, nowMs);
    } catch {
      // Grudges must never break the death path.
    }
    return outcome;
  } catch {
    return null;
  }
}

module.exports = {
  hearthFor,
  attachDeathRespawn,
  resolveDeathOutcome,
  deathCountFor,
  deathHistory,
  recordCitizenDeath,
  onCitizenDeath,
  describeKiller,
  saveIfDirty,
  // Test seams.
  _resetForTests: resetForTests,
  _saveFile: () => SAVE_FILE,
};
