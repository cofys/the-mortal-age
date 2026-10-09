"use strict";

/**
 * CitizenWarfare — war reaches the streets.
 *
 * When kingdoms go to war, citizens don't just stand around:
 *   - Militia: guards recruit brave commoners into militia parties that
 *     muster at the town square and patrol the city. Disbanded at peace.
 *   - War awareness: citizens of warring kingdoms hear war news (journaled
 *     "heard" entries), talk about it where players can hear (data-tier
 *     shout lines, no LLM), and feel it — attackers lean angry/proud,
 *     defenders lean scared.
 *   - War economy: the crown's quartermasters broadcast economy:demand for
 *     war supplies, pushing prices through the economy plugin's own
 *     machinery. War has economic teeth.
 *
 * Data tier, zero LLM. Formation, patrol, news, and demand are all state +
 * journal; the foreground LLM reads the journal when a player asks.
 *
 * Wiring: CitizenDirector.tick() calls tickWarfare(this, hour) once per
 * tick, after the boss-runs block. Party travel leans on the existing
 * tickFollow (members follow the leader); this module nudges the leader.
 */

const KingdomStore = require("../../kingdoms/KingdomStore");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

const {
  isFriend,
  isEnemy,
  getParty,
  getFollow,
  setFollow,
  clearFollow,
  normalizeName,
} = require("./CitizenBonds");
const { createParty, disbandParty, leaveParty } = require("./CitizenSocialMechanics");
const { getJournal } = require("./CitizenJournal");
const { shiftEmotion } = require("./emotions");
const { agentRng, chance } = require("./humanizer");

const MILITIA_ACTIVITY = "militia";
// Per (war, kingdom) per tick when no militia is active yet. Wars are rare;
// when one is on, the muster should form within a few minutes.
const MUSTER_CHANCE = 0.2;
const MIN_COMPANIONS = 2;
const MAX_COMPANIONS = 4;
const ARRIVE_RADIUS = 6;
const PATROL_FLAVOR_CHANCE = 0.12;
// War news lands on the streets about this often per warring kingdom.
const NEWS_INTERVAL_MS = 15 * 60 * 1000;
const lastNewsAt = new Map(); // warKey:kingdomId -> timestamp
// The crown re-posts its supply needs about this often per warring kingdom.
const DEMAND_INTERVAL_MS = 30 * 60 * 1000;
const lastDemandAt = new Map(); // warKey:kingdomId -> timestamp

function warKey(war) {
  return `${war.attackerId}:${war.defenderId}`;
}

// War throttle maps are keyed by warKey:kingdomId. Wars end; the keys
// don't. Prune entries older than a day so dead wars stop accumulating.
// Memory-leak plug, 2026-10-07.
const THROTTLE_TTL_MS = 24 * 3600 * 1000;
let lastThrottlePruneAt = 0;
function pruneThrottleMaps(now) {
  if (now - lastThrottlePruneAt < 3600 * 1000) return;
  lastThrottlePruneAt = now;
  for (const [k, at] of lastNewsAt) {
    if (now - at > THROTTLE_TTL_MS) lastNewsAt.delete(k);
  }
  for (const [k, at] of lastDemandAt) {
    if (now - at > THROTTLE_TTL_MS) lastDemandAt.delete(k);
  }
}

function kingdomName(kingdomId) {
  try {
    return KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
  } catch {
    return kingdomId;
  }
}

/** Uniform pick from a non-empty array using an rng function. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function requestMovement(bot, x, y, z) {
  try {
    const { requestMovement: rm } = require("../../bots/behaviours/navigation/BotNavigation");
    rm(bot, x, y, { reason: "militia", basicPather: true, z: z ?? 0 });
    return true;
  } catch {
    return false;
  }
}

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

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

function shoutIfWatched(director, record, line) {
  try {
    const bot = director.getBot(record);
    if (bot && realPlayersNear(bot).length > 0) {
      try { { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); } } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
}

function warStillActive(war) {
  try {
    return KingdomStore.getActiveWars().some(
      (w) => w.attackerId === war.attackerId && w.defenderId === war.defenderId
    );
  } catch {
    return false;
  }
}

function parseWarKey(key) {
  const idx = key.indexOf(":");
  if (idx < 0) return null;
  return { attackerId: key.slice(0, idx), defenderId: key.slice(idx + 1) };
}

// --- militia ---------------------------------------------------------------

const MUSTER_LINES = [
  "Militia forming up! The levy needs blades — who's with me?",
  "To the muster field! Every able blade, now!",
  "The Marshal calls the levy — fall in!",
];

const MUSTERED_LINES = [
  "Mustered. We hold these streets.",
  "The militia stands ready. Let them come.",
];

const PATROL_FLAVOR = [
  "are walking the walls, eyes on the gates",
  "checked the market stalls for trouble — all quiet",
  "are drilling with spears in the square",
  "shared water and war stories on the patrol",
  "turned away a nervous traveler at the gate, gently",
];

function findMilitia(director, key, kingdomId) {
  const seen = new Set();
  for (const record of director.roster.values()) {
    const party = getParty(record.username);
    if (!party || party.activity !== MILITIA_ACTIVITY) continue;
    if (party.warKey !== key || party.side !== kingdomId) continue;
    if (seen.has(party.id)) continue;
    seen.add(party.id);
    if (normalizeName(party.leader) !== normalizeName(record.username)) continue;
    return { party, leader: record };
  }
  return null;
}

function tryMusterMilitia(director, war, kingdomId) {
  const key = warKey(war);
  const rng = agentRng(`militia:${key}:${kingdomId}:${Date.now() >> 16}`);
  // Fresh intelligence on the enemy musters a stronger levy — read
  // defensively from the espionage layer (never required).
  let intelAdv = 0;
  try {
    const enemyEarly = kingdomId === war.attackerId ? war.defenderId : war.attackerId;
    intelAdv = require("./CitizenEspionage").intelAdvantageFor?.(kingdomId, enemyEarly) ?? 0;
  } catch {
    intelAdv = 0;
  }
  if (!chance(rng, MUSTER_CHANCE + intelAdv * 0.15)) return false;

  // Leader: an on-duty guard of the kingdom.
  let leaderRec = null;
  for (const record of director.roster.values()) {
    if (record.kingdomId !== kingdomId) continue;
    if (record.role !== "guard") continue;
    if (!director.isOnline(record)) continue;
    if (getParty(record.username)) continue;
    if (getFollow(record.username)) continue;
    leaderRec = record;
    break;
  }
  if (!leaderRec) return false;
  const leaderName = leaderRec.username;

  // Companions: brave commoners — friends first, never enemies.
  const seen = new Set([normalizeName(leaderName)]);
  const candidates = [];
  for (const other of director.roster.values()) {
    if (other.username === leaderName) continue;
    const on = normalizeName(other.username);
    if (seen.has(on)) continue;
    if (other.kingdomId !== kingdomId) continue;
    if (other.role !== "commoner") continue;
    if (getParty(other.username)) continue;
    if (getFollow(other.username)) continue;
    if (isEnemy(leaderName, other.username) || isEnemy(other.username, leaderName)) continue;
    if (!director.isOnline(other)) continue;
    seen.add(on);
    candidates.push(other);
  }
  const friends = candidates.filter((c) => isFriend(leaderName, c.username));
  const rest = candidates.filter((c) => !isFriend(leaderName, c.username));
  for (let i = 0; i < rest.length; i++) {
    const j = Math.floor(rng() * rest.length);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const companions = [];
  const companionCap = MAX_COMPANIONS + Math.round(intelAdv * 2);
  for (const c of [...friends, ...rest]) {
    if (companions.length >= companionCap) break;
    companions.push(c.username);
  }
  if (companions.length < MIN_COMPANIONS) return false;

  const muster = siteTileByKingdom(kingdomId, "square");
  if (!muster) return false;
  const waypoints = ["square", "patrol", "market"]
    .map((site) => siteTileByKingdom(kingdomId, site))
    .filter(Boolean)
    .map((t) => ({ x: t.x, y: t.y, z: t.z ?? 0 }));
  if (waypoints.length === 0) return false;

  const party = createParty(leaderName, companions);
  party.activity = MILITIA_ACTIVITY;
  party.warKey = key;
  party.side = kingdomId;
  party.phase = "muster"; // muster -> patrol
  party.musterTile = { x: muster.x, y: muster.y, z: muster.z ?? 0 };
  party.waypoints = waypoints;
  party.patrolIdx = 0;
  party.arrived = false;

  for (const m of companions) {
    setFollow(m, leaderName, "militia");
  }

  const enemyId = kingdomId === war.attackerId ? war.defenderId : war.attackerId;
  const enemyName = kingdomName(enemyId);
  const displayNames = companions.map((c) => {
    const rec = director.roster.get(normalizeName(c));
    return rec?.displayName ?? c;
  });
  const leaderDisplay = leaderRec.displayName ?? leaderName;
  journalEvent(
    leaderName,
    `Raised the militia against ${enemyName}: ${displayNames.join(", ")}.`,
    "social"
  );
  for (const c of companions) {
    journalEvent(c, `Answered the levy against ${enemyName} under ${leaderDisplay}.`, "social");
  }
  shoutIfWatched(director, leaderRec, pickOne(rng, MUSTER_LINES));
  return true;
}

function standDown(director, party, leader, note) {
  for (const m of [...(party.members ?? [])]) {
    try { clearFollow(m); } catch { /* non-fatal */ }
  }
  try {
    disbandParty(leader.username);
  } catch {
    // Non-fatal — the follows are already cleared.
  }
  journalEvent(leader.username, note, "social");
}

function maintainMilitia(director, party, leader, war, enemyName) {
  const now = Date.now();
  const rng = agentRng(`militia:${party.id}:${now >> 16}`);
  const leaderName = leader.username;

  // The war ended while the militia stood watch.
  if (!warStillActive(war)) {
    standDown(director, party, leader, "The war is over — the militia stands down and goes home.");
    return;
  }

  const leaderOnline = director.isOnline(leader);
  const leaderBot = leaderOnline ? director.getBot(leader) : null;
  if (!leaderOnline || !leaderBot) {
    standDown(director, party, leader, "The militia scattered — their captain left the field.");
    return;
  }

  // Drop offline members.
  for (const m of [...(party.members ?? [])]) {
    if (normalizeName(m) === normalizeName(leaderName)) continue;
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) {
      try { leaveParty(m); } catch { /* non-fatal */ }
      try { clearFollow(m); } catch { /* non-fatal */ }
    }
  }

  let dest = null;
  if (party.phase === "muster") {
    dest = party.musterTile;
  } else {
    const wps = party.waypoints ?? [];
    if (wps.length === 0) {
      standDown(director, party, leader, "The militia stood down — no ground left to hold.");
      return;
    }
    dest = wps[(party.patrolIdx ?? 0) % wps.length];
  }
  if (!dest) {
    standDown(director, party, leader, "The militia stood down — lost the way.");
    return;
  }

  const tile = botTile(leaderBot);
  if (chebyshev(tile, dest) > ARRIVE_RADIUS) {
    const jx = dest.x + Math.floor(rng() * 5) - 2;
    const jy = dest.y + Math.floor(rng() * 5) - 2;
    requestMovement(leaderBot, jx, jy, dest.z ?? 0);
    return; // still moving
  }

  if (party.phase === "muster") {
    party.phase = "patrol";
    party.arrived = true;
    const line = pickOne(rng, MUSTERED_LINES);
    journalEvent(leaderName, `${line} Patrolling against ${enemyName}.`, "social");
    shoutIfWatched(director, leader, line);
    return;
  }

  // On patrol: advance the waypoint and log some flavor.
  party.patrolIdx = ((party.patrolIdx ?? 0) + 1) % (party.waypoints ?? [1]).length;
  if (chance(rng, PATROL_FLAVOR_CHANCE)) {
    const who = pickOne(rng, party.members ?? [leaderName]);
    journalEvent(who, `On militia patrol: ${pickOne(rng, PATROL_FLAVOR)}.`, "social");
  }
}

// --- war awareness: news, talk, morale --------------------------------------

const WAR_NEWS_ATTACKER = [
  "heard the levy marched at dawn — the war goes well, they say",
  "heard our patrols took the border villages without a fight",
  "heard the Marshal promises the war will be short and glorious",
];

const WAR_NEWS_DEFENDER = [
  "heard the enemy is at the border marches — gods keep us",
  "heard the levy broke at the border and the roads choke with the fleeing",
  "heard the grain stores are being counted for a siege",
];

const WAR_TALK_ATTACKER = [
  "The levy marches! They'll pay for what they've done.",
  "Heard our boys took the border. It'll be over by winter.",
  "For the crown! The war goes well.",
];

const WAR_TALK_DEFENDER = [
  "They're at the border. Hide the grain, hide the children.",
  "Keep your head down — the war's not going our way.",
  "Pray the walls hold. Pray.",
];

function spreadWarNews(director, war) {
  const now = Date.now();
  const key = warKey(war);
  pruneThrottleMaps(now);
  const rng = agentRng(`warnews:${key}:${now >> 20}`);
  const attackerName = kingdomName(war.attackerId);
  const defenderName = kingdomName(war.defenderId);

  for (const [kingdomId, isAttacker] of [
    [war.attackerId, true],
    [war.defenderId, false],
  ]) {
    const newsKey = `${key}:${kingdomId}`;
    if (now - (lastNewsAt.get(newsKey) ?? 0) < NEWS_INTERVAL_MS) continue;
    lastNewsAt.set(newsKey, now);

    const online = [];
    for (const record of director.roster.values()) {
      if (record.kingdomId !== kingdomId) continue;
      if (!director.isOnline(record)) continue;
      online.push(record);
    }
    if (online.length === 0) continue;

    // Morale: attackers lean angry and proud; defenders lean scared.
    // Guards feel the weight of the levy, not the panic.
    for (const record of online) {
      try {
        if (isAttacker) {
          shiftEmotion(
            record,
            record.role === "guard" ? "proud" : "angry",
            record.role === "guard" ? 35 : 30,
            `the war against ${defenderName}`
          );
        } else {
          shiftEmotion(
            record,
            "scared",
            record.role === "guard" ? 25 : 40,
            `the war with ${attackerName}`
          );
        }
      } catch {
        // One citizen's feelings never break the war news.
      }
    }

    // Journaled war news — the LLM speaks truthfully when asked later.
    const newsLines = isAttacker ? WAR_NEWS_ATTACKER : WAR_NEWS_DEFENDER;
    const hearers = [...online];
    for (let i = hearers.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [hearers[i], hearers[j]] = [hearers[j], hearers[i]];
    }
    for (const record of hearers.slice(0, 4)) {
      journalEvent(record.username, pickOne(rng, newsLines) + ".", "heard");
    }

    // Data-tier war talk where players can hear it.
    const talkLines = isAttacker ? WAR_TALK_ATTACKER : WAR_TALK_DEFENDER;
    const speaker = pickOne(rng, online);
    shoutIfWatched(director, speaker, pickOne(rng, talkLines));
  }
}

// --- war economy: the crown buys for the war ---------------------------------

const WAR_SUPPLY_IDS = {
  BRONZE_SWORD: 1277,
  IRON_SWORD: 1279,
  STEEL_SWORD: 1281,
  BREAD: 2309,
};

function warItemId(director, name) {
  try {
    const fromCore = director.api?.core?.ItemIds?.[name];
    if (Number.isFinite(fromCore) && fromCore > 0) return fromCore;
  } catch {
    // Fall through to the verified cache fallback.
  }
  return WAR_SUPPLY_IDS[name] ?? null;
}

/**
 * The quartermasters buy for the war: weapons and bread, in bulk. This is
 * the economy plugin's own demand seam — pressure on reference prices,
 * which flows to citizen merchant stalls via economy:price-query. War has
 * economic teeth without touching anyone's price fields.
 */
function broadcastWarDemand(director, war) {
  const now = Date.now();
  const key = warKey(war);
  const attackerName = kingdomName(war.attackerId);
  const defenderName = kingdomName(war.defenderId);
  for (const [kingdomId, enemyName] of [
    [war.attackerId, defenderName],
    [war.defenderId, attackerName],
  ]) {
    const demandKey = `${key}:${kingdomId}`;
    if (now - (lastDemandAt.get(demandKey) ?? 0) < DEMAND_INTERVAL_MS) continue;
    lastDemandAt.set(demandKey, now);
    const items = [];
    for (const [name, amount] of [
      ["IRON_SWORD", 40],
      ["STEEL_SWORD", 20],
      ["BRONZE_SWORD", 60],
      ["BREAD", 500],
    ]) {
      const id = warItemId(director, name);
      if (id) items.push({ itemId: id, amount });
    }
    if (items.length === 0) continue;
    try {
      director.api?.emitCustomEvent?.("economy:demand", {
        source: `${kingdomName(kingdomId)} war effort`,
        sourceKind: "kingdom",
        kingdomId,
        items,
        reason: `war with ${enemyName}`,
        ttlMs: DEMAND_INTERVAL_MS,
      });
    } catch {
      // The economy plugin may be absent; the war still happened.
    }
  }
}

// --- tick --------------------------------------------------------------------

function tickWarfare(director, hour) {
  let wars = [];
  try {
    wars = KingdomStore.getActiveWars() ?? [];
  } catch {
    wars = [];
  }

  // Peace or war's end: stand down every militia whose war is over.
  const activeKeys = new Set(wars.map(warKey));
  for (const record of director.roster.values()) {
    const party = getParty(record.username);
    if (!party || party.activity !== MILITIA_ACTIVITY) continue;
    if (normalizeName(party.leader) !== normalizeName(record.username)) continue;
    if (!activeKeys.has(party.warKey)) {
      const parsed = parseWarKey(party.warKey);
      const war = parsed
        ? { attackerId: parsed.attackerId, defenderId: parsed.defenderId }
        : null;
      // warStillActive double-checks the store (cheap, and safe).
      if (!war || !warStillActive(war)) {
        try {
          standDown(director, party, record, "The war is over — the militia stands down and goes home.");
        } catch {
          // Non-fatal.
        }
      }
    }
  }

  for (const war of wars) {
    const key = warKey(war);
    for (const kingdomId of [war.attackerId, war.defenderId]) {
      const enemyId = kingdomId === war.attackerId ? war.defenderId : war.attackerId;
      const enemyName = kingdomName(enemyId);
      const existing = findMilitia(director, key, kingdomId);
      if (existing) {
        try {
          maintainMilitia(director, existing.party, existing.leader, war, enemyName);
        } catch {
          // Non-fatal.
        }
      } else {
        try {
          tryMusterMilitia(director, war, kingdomId);
        } catch {
          // Non-fatal.
        }
      }
    }
    try {
      spreadWarNews(director, war);
    } catch {
      // Non-fatal.
    }
    try {
      broadcastWarDemand(director, war);
    } catch {
      // Non-fatal.
    }
  }
}

module.exports = {
  tickWarfare,
  tryMusterMilitia,
  findMilitia,
  warKey,
};
