"use strict";

/**
 * CitizenBossRuns — autonomous citizen boss-run parties.
 *
 * Guards (and the occasional brave commoner) form their own parties to take
 * on the Giant Mole in the Falador mole hole. From Jon's perspective it looks
 * like a group of players organizing a boss trip: recruitment shout, group
 * travel, the descent, a simulated fight, and loot split.
 *
 * Data tier, zero LLM. Formation, travel, the fight, loot, and disbanding are
 * all state + journal. The foreground LLM reads the journal when a player asks
 * about the run. The only player-visible LLM-free text is the leader's shout
 * via forceChat when real players are actually nearby.
 *
 * Wiring: CitizenDirector.tick() calls tickBossRuns(this, hour) once per
 * tick, after the activity-parties block. Party travel leans on the existing
 * tickFollow (party members follow the leader); this module nudges the
 * leader and teleports the party into/out of the lair (bots take the mole
 * hill, data-tier).
 *
 * Mirrors the CitizenActivityParties.js pattern: same imports, same journal
 * helpers, same party-shape extension (activity/destination/activityEndsAt).
 */

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
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");

// --- boss definition ---------------------------------------------------------
// Giant Mole (npc 5779), Falador mole hole — Asgarnia's starter boss.
// MOLE_HILL is the overworld mole hill; MOLE_LAIR is the lair entrance tile
// (see server/plugins/bosses/GiantMole.plugin.js).
// Loot item ids are verified in server/data/definitions/npc-drops.json
// (giant_mole table): mole claw 7416 (100%), mole skin 7418 (100%, 1-3).

const BOSS = {
  id: "giant_mole",
  label: "the Giant Mole",
  kingdomId: "asgarnia",
  roles: ["guard", "commoner"],
  minMembers: 3,
  maxMembers: 5,
  hp: 200, // matches the real boss
  moleHill: { x: 2984, y: 3314, z: 0 },
  lair: { x: 1752, y: 5236, z: 0 },
  travelRadius: 6,
  fightTicks: 0, // computed at fight start
  formLines: [
    "Giant Mole run forming up — who's in?!",
    "Taking a party down the mole hole. Bring a weapon!",
  ],
  descendLines: ["Down the hole! Stay close."],
  fightFlavor: [
    "landed a solid hit on the Mole",
    "dodged a claw swipe, barely",
    "the Mole burrowed — spread out, watch the dirt!",
    "took a hit and kept swinging",
    "called the Mole's resurface, everyone piled on",
  ],
  killLines: ["The Mole's down! Claws and skins for everyone."],
  endLines: ["Back from the mole hole. Good run."],
};

const FORM_CHANCE = 0.003; // per eligible citizen per tick (~60s) — boss runs are rarer than outings
const FLAVOR_CHANCE = 0.3;
const DAMAGE_PER_MEMBER = 9; // ~9/tick/member -> a 4-person party takes ~6 ticks (~6 min)
const BOSS_HITBACK_CHANCE = 0.25;

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
    rm(bot, x, y, { reason: "boss_run", basicPather: true, z: z ?? 0 });
    return true;
  } catch {
    return false;
  }
}

function makeLocation(director, x, y, z) {
  try {
    const Loc = director.api?.core?.Location;
    if (Loc) return new Loc(x, y, z ?? 0);
  } catch {
    // Non-fatal.
  }
  return null;
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
      try { bot.forceChat?.(line); } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
}

// --- formation ---------------------------------------------------------------

function tryFormBossRun(record, director) {
  const name = record.username;
  if (getParty(name)) return false; // already in a party
  if (getFollow(name)) return false; // already following someone
  if (record.kingdomId !== BOSS.kingdomId) return false; // the Mole is Falador's boss
  if (!BOSS.roles.includes(record.role)) return false;
  const rng = agentRng(`bossrun:${name}:${Date.now() >> 16}`);
  if (!chance(rng, FORM_CHANCE)) return false;

  // Companions: guards first, then brave commoners; friends preferred, never enemies.
  const companions = [];
  const seen = new Set([normalizeName(name)]);
  const candidates = [];
  for (const other of director.roster.values()) {
    if (other.username === name) continue;
    const on = normalizeName(other.username);
    if (seen.has(on)) continue;
    if (other.kingdomId !== BOSS.kingdomId) continue;
    if (!BOSS.roles.includes(other.role)) continue;
    if (getParty(other.username)) continue;
    if (getFollow(other.username)) continue;
    if (isEnemy(name, other.username) || isEnemy(other.username, name)) continue;
    if (!director.isOnline(other)) continue;
    seen.add(on);
    candidates.push(other);
  }
  const rank = (c) => (c.role === "guard" ? 0 : 1);
  const friends = candidates
    .filter((c) => isFriend(name, c.username))
    .sort((a, b) => rank(a) - rank(b));
  const rest = candidates
    .filter((c) => !isFriend(name, c.username))
    .sort((a, b) => rank(a) - rank(b));
  // Light shuffle of the non-friend tail so it's not always the same crew.
  for (let i = 0; i < rest.length; i++) {
    const j = Math.floor(rng() * rest.length);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  for (const c of [...friends, ...rest]) {
    if (companions.length >= BOSS.maxMembers - 1) break;
    companions.push(c.username);
  }
  if (companions.length < BOSS.minMembers - 1) return false;

  // Form the party. createParty stores the same object ref for all members,
  // so attaching run fields mutates everyone's copy.
  const party = createParty(name, companions);
  party.activity = BOSS.id;
  party.destination = { x: BOSS.moleHill.x, y: BOSS.moleHill.y, z: BOSS.moleHill.z };
  party.phase = "travel"; // travel -> fight -> done
  party.bossHp = BOSS.hp;
  party.arrived = false;

  for (const m of companions) {
    setFollow(m, name, "boss_run");
  }

  const displayNames = companions.map((c) => {
    const rec = director.roster.get(normalizeName(c));
    return rec?.displayName ?? c;
  });
  const leaderDisplay = record.displayName ?? name;
  journalEvent(name, `Rounded up ${displayNames.join(" and ")} for a ${BOSS.label} run.`, "social");
  for (const c of companions) {
    journalEvent(c, `Joined ${leaderDisplay}'s ${BOSS.label} run.`, "social");
  }

  // Visible to nearby real players: the leader calls out (data-tier shout,
  // no LLM — the LLM can riff on it later if asked).
  shoutIfWatched(director, record, pickOne(rng, BOSS.formLines));
  return true;
}

// --- per-tick party maintenance (travel, descend, fight, loot, disband) ------

function tickBossRuns(director, hour) {
  // Collect boss-run parties, deduped by party id, leader-first.
  const seen = new Set();
  const parties = [];
  for (const record of director.roster.values()) {
    const party = getParty(record.username);
    if (!party || party.activity !== BOSS.id) continue;
    if (seen.has(party.id)) continue;
    seen.add(party.id);
    if (normalizeName(party.leader) !== normalizeName(record.username)) continue;
    parties.push({ party, leader: record });
  }

  for (const { party, leader } of parties) {
    try {
      maintainBossRun(director, party, leader, hour);
    } catch {
      // Non-fatal.
    }
  }

  // Formation pass: eligible citizens may start new boss runs.
  for (const record of director.roster.values()) {
    if (!director.isOnline(record)) continue;
    try {
      tryFormBossRun(record, director);
    } catch {
      // Non-fatal.
    }
  }
}

function maintainBossRun(director, party, leader, hour) {
  const leaderName = leader.username;
  const rng = agentRng(`bossrun:${party.id}:${Date.now() >> 16}`);
  const leaderOnline = director.isOnline(leader);
  const leaderBot = leaderOnline ? director.getBot(leader) : null;

  // Leader gone — disband, everyone heads home.
  if (!leaderOnline || !leaderBot) {
    sendHome(director, party, leader);
    endRun(director, party, leader, `The ${BOSS.label} run fell apart — the leader headed home.`);
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

  if (party.phase === "travel") {
    maintainTravel(director, party, leader, leaderBot, rng);
    return;
  }
  if (party.phase === "fight") {
    maintainFight(director, party, leader, leaderBot, rng);
    return;
  }
  // Unknown phase — clean up.
  sendHome(director, party, leader);
  endRun(director, party, leader, "called off.");
}

function maintainTravel(director, party, leader, leaderBot, rng) {
  const dest = party.destination;
  if (!dest) {
    sendHome(director, party, leader);
    endRun(director, party, leader, "called off — lost the way.");
    return;
  }
  const tile = botTile(leaderBot);
  if (chebyshev(tile, dest) > BOSS.travelRadius) {
    const jx = dest.x + Math.floor(rng() * 5) - 2;
    const jy = dest.y + Math.floor(rng() * 5) - 2;
    requestMovement(leaderBot, jx, jy, dest.z ?? 0);
    return; // still traveling
  }

  // At the mole hill — descend into the lair (data-tier; the bots "dig in").
  const lairLoc = makeLocation(director, BOSS.lair.x, BOSS.lair.y, BOSS.lair.z);
  for (const m of party.members ?? []) {
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) continue;
    const bot = director.getBot(rec);
    if (!bot || !lairLoc) continue;
    try { bot.moveTo?.(lairLoc); } catch { /* non-fatal */ }
  }
  party.phase = "fight";
  party.fightStartedAt = Date.now();
  const line = pickOne(rng, BOSS.descendLines);
  journalEvent(leader.username, `Led the party down the mole hole. ${line}`, "social");
  for (const m of party.members ?? []) {
    if (normalizeName(m) === normalizeName(leader.username)) continue;
    journalEvent(m, `Descended into the mole lair for the ${BOSS.label} run.`, "social");
  }
  shoutIfWatched(director, leader, line);
}

function maintainFight(director, party, leader, leaderBot, rng) {
  const members = (party.members ?? []).filter((m) => {
    const rec = director.roster.get(normalizeName(m));
    return rec && director.isOnline(rec);
  });
  if (members.length < 2) {
    // Party collapsed mid-fight — survivors retreat.
    journalEvent(leader.username, `The ${BOSS.label} run fell apart in the lair — retreated.`, "social");
    sendHome(director, party, leader);
    endRun(director, party, leader, "called off — not enough fighters left.");
    return;
  }

  // Data-tier combat: the party chips the boss down; the boss occasionally
  // lands a journaled hit on a random member (no real damage — data tier).
  party.bossHp = Math.max(0, (party.bossHp ?? BOSS.hp) - members.length * DAMAGE_PER_MEMBER);

  if (chance(rng, BOSS_HITBACK_CHANCE)) {
    const victim = pickOne(rng, members);
    journalEvent(victim, `Took a claw swipe from ${BOSS.label} and shook it off.`, "combat");
  }
  if (chance(rng, FLAVOR_CHANCE)) {
    const who = pickOne(rng, members);
    journalEvent(who, pickOne(rng, BOSS.fightFlavor) + ".", "combat");
  }

  if (party.bossHp > 0) return; // still fighting

  // Kill — split the loot and head home.
  const killLine = pickOne(rng, BOSS.killLines);
  journalEvent(leader.username, killLine, "combat");
  shoutIfWatched(director, leader, killLine);
  splitLoot(director, party, members, rng);
  sendHome(director, party, leader);
  endRun(director, party, leader, pickOne(rng, BOSS.endLines));
}

function splitLoot(director, party, members, rng) {
  // Verified in npc-drops.json (giant_mole table): every member gets a claw
  // and a share of the skins.
  for (const m of members) {
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) continue;
    const bot = director.getBot(rec);
    if (!bot) continue;
    const skins = 1 + Math.floor(rng() * 2); // 1-2
    try {
      bot.getInventory?.()?.adds?.(7416, 1); // mole claw
      bot.getInventory?.()?.adds?.(7418, skins); // mole skin
    } catch {
      // Non-fatal.
    }
    journalEvent(m, `Loot from ${BOSS.label}: a mole claw and ${skins} mole skins.`, "work");
  }
}

function sendHome(director, party, leader) {
  // Survivors head back to the Falador square (data-tier teleport; the normal
  // brain resumes from town).
  const home = siteTileByKingdom(BOSS.kingdomId, "square");
  if (!home) return;
  const homeLoc = makeLocation(director, home.x, home.y, home.z ?? 0);
  if (!homeLoc) return;
  for (const m of party.members ?? []) {
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) continue;
    const bot = director.getBot(rec);
    if (!bot) continue;
    try { bot.moveTo?.(homeLoc); } catch { /* non-fatal */ }
  }
}

function endRun(director, party, leader, note) {
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
  BOSS,
  tickBossRuns,
  tryFormBossRun,
};
