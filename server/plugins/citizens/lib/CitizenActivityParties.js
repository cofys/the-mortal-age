"use strict";

/**
 * CitizenActivityParties — autonomous citizen group activities.
 *
 * Citizens form their own parties and do things together: fishing trips to
 * the docks, market runs, work details, tavern nights. Citizen-to-citizen
 * invites, group travel, shared loot — from Jon's perspective it looks like
 * a group of players doing content together.
 *
 * Data tier, zero LLM. Formation, travel, loot, and disbanding are all
 * state + journal. The foreground LLM reads the journal when a player asks
 * "what have you been up to?" and speaks truthfully about the trip.
 *
 * Wiring: CitizenDirector.tick() calls tickParties(director, hour) once per
 * tick, after the social block. Party travel leans on the existing
 * tickFollow (party members follow the leader); this module nudges the
 * leader toward the activity destination.
 */

const {
  bonds,
  isFriend,
  isEnemy,
  getParty,
  setParty,
  getFollow,
  setFollow,
  clearFollow,
  normalizeName,
} = require("./CitizenBonds");
const { createParty, disbandParty, leaveParty } = require("./CitizenSocialMechanics");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");

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
    rm(bot, x, y, { reason: "activity_party", basicPather: true, z: z ?? 0 });
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

// --- activity definitions ---------------------------------------------------
// site: key into data/sites.json. roles: who goes. hours: null = any time.

const ACTIVITIES = {
  fishing_trip: {
    site: "dock",
    roles: ["commoner"],
    minMembers: 2,
    maxMembers: 4,
    durationMin: 12,
    hours: null,
    needsDock: true,
    formLines: [
      "We're heading to the docks — lines in the water, anyone's welcome!",
      "Fishing trip! Coming to the docks with us?",
    ],
    arriveLines: ["Made it to the docks. Lines in!"],
    flavorLines: [
      "caught a fat one",
      "lost a boot to the water, everyone laughed",
      "are swapping stories while the lines soak",
      "shared the catch around",
    ],
    endLines: ["Headed home with a full net. Good day."],
    loot: { item: "RAW_SHRIMPS", min: 1, max: 3 },
  },
  market_run: {
    site: "market",
    roles: ["commoner"],
    minMembers: 2,
    maxMembers: 4,
    durationMin: 10,
    hours: null,
    formLines: [
      "Off to the market — coming with?",
      "Market run! Let's see what's selling today.",
    ],
    arriveLines: ["At the market. Let's see the stalls."],
    flavorLines: [
      "haggled a merchant down and everyone's impressed",
      "are comparing prices stall to stall",
      "found a good deal on bread",
      "got distracted by the pie stall",
    ],
    endLines: ["Back from the market, purses a little lighter."],
    loot: null,
  },
  work_detail: {
    site: "work",
    roles: ["commoner"],
    minMembers: 2,
    maxMembers: 5,
    durationMin: 14,
    hours: null,
    formLines: ["Work detail forming up — who's in?", "Heading to the work site, extra hands welcome."],
    arriveLines: ["At the work site. Let's get to it."],
    flavorLines: [
      "are working the site together",
      "took a breather and shared water",
      "got a rhythm going, the work's flying",
    ],
    endLines: ["Work detail done. Earned the day's wage."],
    loot: null,
  },
  tavern_night: {
    site: "tavern",
    roles: ["commoner", "guard", "courtier"],
    minMembers: 2,
    maxMembers: 5,
    durationMin: 15,
    hours: [18, 19, 20, 21, 22],
    formLines: ["Tavern tonight — first round's on whoever's latest!", "Heading to the tavern, join us!"],
    arriveLines: ["At the tavern. Ale all around."],
    flavorLines: [
      "are singing an old marching song, badly",
      "got into a friendly argument about the war",
      "are buying rounds for the table",
      "heard a wild rumor from a traveler",
    ],
    endLines: ["Stumbled home from the tavern. Good night."],
    loot: null,
  },
};

const ACTIVITY_IDS = Object.keys(ACTIVITIES);
const FORM_CHANCE = 0.006; // per eligible citizen per tick (~60s)
const ARRIVE_RADIUS = 6;
const FLAVOR_CHANCE = 0.15;

function activityValidForKingdom(activityId, kingdomId) {
  const def = ACTIVITIES[activityId];
  if (!def) return false;
  if (def.needsDock) {
    return !!siteTileByKingdom(kingdomId, "dock");
  }
  return !!siteTileByKingdom(kingdomId, def.site);
}

function pickActivity(record, kingdomId, hour, rng) {
  const options = ACTIVITY_IDS.filter((id) => {
    const def = ACTIVITIES[id];
    if (!def.roles.includes(record.role)) return false;
    if (def.hours && !def.hours.includes(hour)) return false;
    return activityValidForKingdom(id, kingdomId);
  });
  if (!options.length) return null;
  return pickOne(rng, options);
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

// --- formation ---------------------------------------------------------------

function tryFormParty(record, director, hour) {
  const name = record.username;
  if (getParty(name)) return false; // already in a party
  if (getFollow(name)) return false; // already following someone
  if (record.role !== "commoner" && record.role !== "guard" && record.role !== "courtier") {
    return false;
  }
  const rng = agentRng(`actparty:${name}:${Date.now() >> 16}`);
  if (!chance(rng, FORM_CHANCE)) return false;

  const kingdomId = record.kingdomId;
  const activityId = pickActivity(record, kingdomId, hour, rng);
  if (!activityId) return false;
  const def = ACTIVITIES[activityId];
  const destination = siteTileByKingdom(kingdomId, def.site);
  if (!destination) return false;

  // Companions: prefer citizen friends, then any nearby-ish eligible citizen
  // of the same kingdom with no party and no follow.
  const companions = [];
  const seen = new Set([normalizeName(name)]);
  const candidates = [];
  for (const other of director.roster.values()) {
    if (other.username === name) continue;
    const on = normalizeName(other.username);
    if (seen.has(on)) continue;
    if (other.kingdomId !== kingdomId) continue;
    if (!def.roles.includes(other.role)) continue;
    if (getParty(other.username)) continue;
    if (getFollow(other.username)) continue;
    if (isEnemy(name, other.username) || isEnemy(other.username, name)) continue;
    if (!director.isOnline(other)) continue;
    seen.add(on);
    candidates.push(other);
  }
  // Friends first (shuffled), then the rest (shuffled).
  const friends = candidates.filter((c) => isFriend(name, c.username));
  const rest = candidates.filter((c) => !isFriend(name, c.username));
  const ordered = [...friends, ...rest];
  // Light shuffle of the non-friend tail so it's not always the same crew.
  for (let i = friends.length; i < ordered.length; i++) {
    const j = friends.length + Math.floor(rng() * (ordered.length - friends.length));
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  for (const c of ordered) {
    if (companions.length >= def.maxMembers - 1) break;
    companions.push(c.username);
  }
  if (companions.length < def.minMembers - 1) return false;

  // Form the party. createParty stores the same object ref for all members,
  // so attaching activity fields mutates everyone's copy.
  const party = createParty(name, companions);
  party.activity = activityId;
  party.destination = { x: destination.x, y: destination.y, z: destination.z ?? 0 };
  party.activityEndsAt = Date.now() + def.durationMin * 60 * 1000;
  party.arrived = false;

  for (const m of companions) {
    setFollow(m, name, "activity_party");
  }

  const displayNames = companions.map((c) => {
    const rec = director.roster.get(normalizeName(c));
    return rec?.displayName ?? c;
  });
  const leaderDisplay = record.displayName ?? name;
  journalEvent(
    name,
    `Rounded up ${displayNames.join(" and ")} for ${activityLabel(activityId)}.`,
    "social"
  );
  for (const c of companions) {
    const rec = director.roster.get(normalizeName(c));
    journalEvent(c, `Joined ${leaderDisplay}'s ${activityLabel(activityId)}.`, "social");
  }

  // Visible to nearby real players: the leader calls out (data-tier shout,
  // no LLM — the LLM can riff on it later if asked).
  try {
    const bot = director.getBot(record);
    if (bot && realPlayersNear(bot).length > 0) {
      const line = pickOne(rng, def.formLines);
      try { bot.forceChat?.(line); } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
  return true;
}

function activityLabel(activityId) {
  return activityId.replace(/_/g, " ");
}

// --- per-tick party maintenance (travel, flavor, loot, disband) --------------

function tickParties(director, hour) {
  // Collect activity parties, deduped by party id, leader-first.
  const seen = new Set();
  const parties = [];
  for (const record of director.roster.values()) {
    const party = getParty(record.username);
    if (!party || !party.activity || !ACTIVITIES[party.activity]) continue;
    if (seen.has(party.id)) continue;
    seen.add(party.id);
    if (normalizeName(party.leader) !== normalizeName(record.username)) continue;
    parties.push({ party, leader: record });
  }

  for (const { party, leader } of parties) {
    maintainParty(director, party, leader, hour);
  }

  // Formation pass: eligible citizens may start new parties.
  for (const record of director.roster.values()) {
    if (!director.isOnline(record)) continue;
    try {
      tryFormParty(record, director, hour);
    } catch {
      // Non-fatal.
    }
  }
}

function maintainParty(director, party, leader, hour) {
  const now = Date.now();
  const def = ACTIVITIES[party.activity];
  const leaderName = leader.username;
  const rng = agentRng(`actparty:${party.id}:${now >> 16}`);

  const leaderOnline = director.isOnline(leader);
  const leaderBot = leaderOnline ? director.getBot(leader) : null;

  // Leader gone (sleep/offline) — disband, everyone drifts home.
  if (!leaderOnline || !leaderBot) {
    endParty(director, party, leader, `${activityLabel(party.activity)} called off — the leader headed home.`);
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

  // Time's up — wrap up with loot split and disband.
  if (now >= (party.activityEndsAt ?? 0)) {
    splitLoot(director, party, def);
    endParty(director, party, leader, pickOne(rng, def.endLines));
    return;
  }

  const dest = party.destination;
  if (!dest) {
    endParty(director, party, leader, "called off — lost the way.");
    return;
  }

  // Nudge the leader toward the destination. Members follow via the
  // existing party-follow (tickFollow), so the group travels together.
  const tile = botTile(leaderBot);
  const dist = chebyshev(tile, dest);
  if (dist > ARRIVE_RADIUS) {
    const jx = dest.x + Math.floor(rng() * 5) - 2;
    const jy = dest.y + Math.floor(rng() * 5) - 2;
    requestMovement(leaderBot, jx, jy, dest.z ?? 0);
    return; // still traveling
  }

  // Arrived.
  if (!party.arrived) {
    party.arrived = true;
    const line = pickOne(rng, def.arriveLines);
    journalEvent(leaderName, line, "social");
    try {
      if (realPlayersNear(leaderBot).length > 0) {
        try { leaderBot.forceChat?.(line); } catch { /* non-fatal */ }
      }
    } catch { /* non-fatal */ }
  }

  // Activity flavor while on site (data-tier; the LLM reads the journal).
  if (chance(rng, FLAVOR_CHANCE)) {
    const flavor = pickOne(rng, def.flavorLines);
    const who = pickOne(rng, party.members ?? [leaderName]);
    const rec = director.roster.get(normalizeName(who));
    journalEvent(who, `On the ${activityLabel(party.activity)}: ${flavor}.`, "social");
  }
}

function splitLoot(director, party, def) {
  if (!def.loot) return;
  // Item id resolution: api.core.ItemIds first, verified cache fallback.
  // RAW_SHRIMPS = 317 is verified in ItemIdentifiers.ts — never guess others.
  let itemId = null;
  try {
    itemId = director.api?.core?.ItemIds?.[def.loot.item] ?? null;
  } catch {
    itemId = null;
  }
  if (def.loot.item === "RAW_SHRIMPS" && !itemId) itemId = 317;
  if (!itemId) return;

  const rng = agentRng(`actparty:loot:${party.id}`);
  for (const m of party.members ?? []) {
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) continue;
    const bot = director.getBot(rec);
    if (!bot) continue;
    const n = def.loot.min + Math.floor(rng() * (def.loot.max - def.loot.min + 1));
    try {
      bot.getInventory?.()?.adds?.(itemId, n);
    } catch {
      // Non-fatal.
    }
    journalEvent(m, `Split the catch: ${n} raw shrimps.`, "work");
  }
}

function endParty(director, party, leader, note) {
  const leaderName = leader.username;
  for (const m of [...(party.members ?? [])]) {
    try { clearFollow(m); } catch { /* non-fatal */ }
  }
  try {
    disbandParty(leaderName);
  } catch {
    // Non-fatal — fall back to clearing individually.
    for (const m of party.members ?? []) {
      try {
        const { clearParty } = require("./CitizenBonds");
        clearParty(m);
      } catch { /* non-fatal */ }
    }
  }
  journalEvent(leaderName, note, "social");
}

module.exports = {
  ACTIVITIES,
  tickParties,
  tryFormParty,
};
