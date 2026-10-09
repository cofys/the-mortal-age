"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenBossRuns — autonomous citizen boss-run parties.
 *
 * Citizens form their own parties to take on local bosses: the Giant Mole
 * (Asgarnia), Scurrius (Misthalin), and Obor (Wanderer). From Jon's
 * perspective it looks like groups of players organizing boss trips:
 * recruitment shout, group travel, the descent, a simulated fight, loot split.
 *
 * Boss selection is data-driven: each boss has a home kingdom, and citizens
 * only run their own kingdom's boss (a Morytania party never treks to
 * Falador for the Mole). Kingdoms without a boss yet simply don't form runs.
 *
 * Data tier, zero LLM. Formation, travel, the fight, loot, and disbanding are
 * all state + journal. The foreground LLM reads the journal when a player asks
 * about the run. The only player-visible LLM-free text is the leader's shout
 * via forceChat when real players are actually nearby.
 *
 * Wiring: CitizenDirector.tick() calls tickBossRuns(this, hour) once per
 * tick, after the activity-parties block. Party travel leans on the existing
 * tickFollow (party members follow the leader); this module nudges the
 * leader and teleports the party into/out of the lair (bots take the entrance,
 * data-tier).
 *
 * Mirrors the CitizenActivityParties.js pattern: same imports, same journal
 * helpers, same party-shape extension (activity/destination/phase/bossHp).
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

// --- boss definitions --------------------------------------------------------
// Locations verified against the engine:
// - Giant Mole: mole hill (2984, 3314) / lair (1752, 5236) — GiantMole.plugin.js.
//   Loot item ids verified in npc-drops.json (giant_mole): mole claw 7416,
//   mole skin 7418.
// - Scurrius: Varrock manhole (3237, 3458) / sewer landing (3237, 9858) —
//   Misthalin.plugin.js. Loot verified in npc-drops.json (scurrius table):
//   big bones 532, raw rat meat 2134, rune gear (1147/1163/1185/1113/1373).
// - Obor: Edgeville trapdoor (3097, 3468) / lair inside (3091, 9815) —
//   Misthalin.plugin.js + giant-boss-lairs.json. Loot verified in
//   npc-drops.json (obor table) + obor_chest table: giant bones 30898,
//   rune gear (1201/1163/1147/1113/1079/1093/1373/1303/1319).

function qtyOf(picked, id) {
  const hit = picked.find((p) => p.id === id);
  return hit ? hit.qty : 0;
}

const BOSSES = [
  {
    id: "giant_mole",
    label: "the Giant Mole",
    kingdomId: "asgarnia",
    roles: ["guard", "commoner"],
    minMembers: 3,
    maxMembers: 5,
    hp: 200, // matches the real boss
    overworld: { x: 2984, y: 3314, z: 0 },
    lair: { x: 1752, y: 5236, z: 0 },
    travelRadius: 6,
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
    loot: {
      citizen: [[7416, 1], [7418, [1, 2]]],
      citizenNote: (p) => `Loot from the Giant Mole: a mole claw and ${qtyOf(p, 7418)} mole skins.`,
      player: [[7416, 1], [7418, [1, 2]]],
      playerNote: (p) => `You loot a mole claw and ${qtyOf(p, 7418)} mole skins from the Giant Mole.`,
    },
  },
  {
    id: "scurrius",
    label: "Scurrius",
    kingdomId: "misthalin",
    roles: ["guard", "commoner"],
    minMembers: 3,
    maxMembers: 5,
    hp: 500, // public Scurrius
    overworld: { x: 3237, y: 3458, z: 0 }, // Varrock manhole
    lair: { x: 3237, y: 9858, z: 0 }, // sewer landing
    travelRadius: 6,
    formLines: [
      "Scurrius run — the sewers won't clear themselves!",
      "Rat king in the Varrock sewers. Bring a weapon, watch for rockfalls!",
    ],
    descendLines: ["Down the manhole. Stay close."],
    fightFlavor: [
      "dodged a rockfall, barely",
      "a giant rat lunged from the dark — cut it down",
      "Scurrius fed on the rat pile and healed — keep hitting!",
      "called the rockfall, everyone scattered",
      "took a magic blast and kept swinging",
    ],
    killLines: ["Scurrius is down! The sewers are safe tonight."],
    endLines: ["Back from the sewers. Good run."],
    loot: {
      citizen: [[532, 1], [2134, 1]],
      bonus: {
        chance: 0.4,
        items: [
          [1147, "rune med helm"],
          [1163, "rune full helm"],
          [1185, "rune sq shield"],
          [1113, "rune chainbody"],
          [1373, "rune battleaxe"],
        ],
      },
      citizenNote: (p, bonus) =>
        `Loot from Scurrius: big bones and raw rat meat${bonus ? `, plus a ${bonus}` : ""}.`,
      player: [[532, 1], [2134, 1]],
      playerNote: (p, bonus) =>
        `You loot big bones and raw rat meat from Scurrius${bonus ? `, plus a ${bonus}` : ""}.`,
    },
  },
  {
    id: "obor",
    label: "Obor",
    kingdomId: "wanderer",
    roles: ["guard", "commoner"],
    minMembers: 2,
    maxMembers: 4,
    hp: 120, // matches the real boss
    overworld: { x: 3097, y: 3468, z: 0 }, // Edgeville dungeon trapdoor
    lair: { x: 3091, y: 9815, z: 0 }, // Obor's lair
    travelRadius: 6,
    formLines: [
      "Obor run — the hill giant won't slay itself!",
      "Heading into the Edgeville dungeon for Obor. Who's in?",
    ],
    descendLines: ["Down the trapdoor. Watch for hill giants."],
    fightFlavor: [
      "dodged Obor's slam, barely",
      "the ground shook as Obor charged",
      "landed a solid hit on the giant",
      "a hill giant wandered in — drove it off",
      "Obor's club came down inches away",
    ],
    killLines: ["Obor's down! The chest is ours!"],
    endLines: ["Back from the dungeon. Good run."],
    loot: {
      citizen: [[30898, 1]],
      bonus: {
        chance: 0.6,
        items: [
          [1201, "rune kiteshield"],
          [1163, "rune full helm"],
          [1147, "rune med helm"],
          [1113, "rune chainbody"],
          [1079, "rune platelegs"],
          [1093, "rune plateskirt"],
          [1373, "rune battleaxe"],
          [1303, "rune longsword"],
          [1319, "rune 2h sword"],
        ],
      },
      citizenNote: (p, bonus) => `Loot from Obor: giant bones${bonus ? ` and a ${bonus}` : ""}.`,
      player: [[30898, 1]],
      playerNote: (p, bonus) =>
        `You loot giant bones from Obor${bonus ? ` and a ${bonus}` : ""}.`,
    },
  },
];

// Backward-compatible alias: the Giant Mole is the first boss.
const BOSS = BOSSES[0];

function bossById(id) {
  return BOSSES.find((b) => b.id === id) ?? null;
}

function bossForKingdom(kingdomId) {
  return BOSSES.find((b) => b.kingdomId === kingdomId) ?? null;
}

const FORM_CHANCE = 0.003; // per eligible citizen per tick (~60s) — boss runs are rarer than outings
const FLAVOR_CHANCE = 0.3;
const DAMAGE_PER_MEMBER = 9; // ~9/tick/member -> a 4-person Mole party takes ~6 ticks (~6 min)
const BOSS_HITBACK_CHANCE = 0.25;

/** Uniform pick from a non-empty array using an rng function. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Roll a loot spec ([id, qty|[min,max]] pairs) into [{id, qty}]. */
function rollLoot(rng, spec) {
  const out = [];
  for (const [id, qty] of spec ?? []) {
    const n = Array.isArray(qty)
      ? qty[0] + Math.floor(rng() * (qty[1] - qty[0] + 1))
      : qty;
    if (n > 0) out.push({ id, qty: n });
  }
  return out;
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
      try { { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); } } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
}

// --- formation ---------------------------------------------------------------

function tryFormBossRun(record, director) {
  const name = record.username;
  if (getParty(name)) return false; // already in a party
  if (getFollow(name)) return false; // already following someone
  // Citizens only run their own kingdom's boss — no cross-kingdom treks.
  const boss = bossForKingdom(record.kingdomId);
  if (!boss) return false;
  if (!boss.roles.includes(record.role)) return false;
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
    if (other.kingdomId !== boss.kingdomId) continue;
    if (!boss.roles.includes(other.role)) continue;
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
    if (companions.length >= boss.maxMembers - 1) break;
    companions.push(c.username);
  }
  if (companions.length < boss.minMembers - 1) return false;

  // Form the party. createParty stores the same object ref for all members,
  // so attaching run fields mutates everyone's copy.
  const party = createParty(name, companions);
  party.activity = boss.id;
  party.bossId = boss.id;
  party.destination = { x: boss.overworld.x, y: boss.overworld.y, z: boss.overworld.z };
  party.phase = "travel"; // travel -> fight -> done
  party.bossHp = boss.hp;
  party.arrived = false;

  for (const m of companions) {
    setFollow(m, name, "boss_run");
  }

  const displayNames = companions.map((c) => {
    const rec = director.roster.get(normalizeName(c));
    return rec?.displayName ?? c;
  });
  const leaderDisplay = record.displayName ?? name;
  journalEvent(name, `Rounded up ${displayNames.join(" and ")} for a ${boss.label} run.`, "social");
  for (const c of companions) {
    journalEvent(c, `Joined ${leaderDisplay}'s ${boss.label} run.`, "social");
  }

  // Visible to nearby real players: the leader calls out (data-tier shout,
  // no LLM) and nearby players get an activity invite ("yes" to join).
  try {
    const { offerActivityToPlayers } = require("./CitizenPlayerActivities");
    offerActivityToPlayers(director, record, party, {
      activityId: boss.id,
      label: `${boss.label} run`,
      formLines: boss.formLines,
    });
  } catch {
    // Non-fatal.
  }
  return true;
}

// --- per-tick party maintenance (travel, descend, fight, loot, disband) ------

function tickBossRuns(director, hour) {
  // Collect boss-run parties, deduped by party id, leader-first.
  const seen = new Set();
  const parties = [];
  for (const record of director.roster.values()) {
    const party = getParty(record.username);
    if (!party) continue;
    const bossId = party.bossId ?? party.activity; // bossId is new; activity is the legacy shape
    if (!bossById(bossId)) continue;
    // Leader check BEFORE the seen-dedup: the dedup must not swallow the
    // leader's own record when a non-leader member is iterated first.
    if (normalizeName(party.leader) !== normalizeName(record.username)) continue;
    if (seen.has(party.id)) continue;
    seen.add(party.id);
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
  const boss = bossById(party.bossId ?? party.activity);
  if (!boss) {
    sendHome(director, party, leader, BOSS);
    endRun(director, party, leader, BOSS, "called off.");
    return;
  }
  const leaderName = leader.username;
  const rng = agentRng(`bossrun:${party.id}:${Date.now() >> 16}`);
  const leaderOnline = director.isOnline(leader);
  const leaderBot = leaderOnline ? director.getBot(leader) : null;

  // Leader gone — disband, everyone heads home.
  if (!leaderOnline || !leaderBot) {
    sendHome(director, party, leader, boss);
    endRun(director, party, leader, boss, `The ${boss.label} run fell apart — the leader headed home.`);
    return;
  }

  // Drop offline members — but keep online real players; they're in the
  // party too once they accept the activity invite.
  let PlayerActivities = null;
  try {
    PlayerActivities = require("./CitizenPlayerActivities");
  } catch {
    // Non-fatal.
  }
  for (const m of [...(party.members ?? [])]) {
    if (normalizeName(m) === normalizeName(leaderName)) continue;
    const rec = director.roster.get(normalizeName(m));
    const online =
      (rec && director.isOnline(rec)) ||
      (PlayerActivities ? !!PlayerActivities.isOnlinePlayer(director, m) : false);
    if (!online) {
      try { leaveParty(m); } catch { /* non-fatal */ }
      try { clearFollow(m); } catch { /* non-fatal */ }
    }
  }

  if (party.phase === "travel") {
    maintainTravel(director, party, boss, leader, leaderBot, rng);
    return;
  }
  if (party.phase === "fight") {
    maintainFight(director, party, boss, leader, leaderBot, rng);
    return;
  }
  // Unknown phase — clean up.
  sendHome(director, party, leader, boss);
  endRun(director, party, leader, boss, "called off.");
}

function maintainTravel(director, party, boss, leader, leaderBot, rng) {
  const dest = party.destination;
  if (!dest) {
    sendHome(director, party, leader, boss);
    endRun(director, party, leader, boss, "called off — lost the way.");
    return;
  }
  const tile = botTile(leaderBot);
  if (chebyshev(tile, dest) > boss.travelRadius) {
    const jx = dest.x + Math.floor(rng() * 5) - 2;
    const jy = dest.y + Math.floor(rng() * 5) - 2;
    requestMovement(leaderBot, jx, jy, dest.z ?? 0);
    return; // still traveling
  }

  // At the entrance — descend into the lair (data-tier; the bots "go in").
  // Player members descend with the party.
  const lairLoc = makeLocation(director, boss.lair.x, boss.lair.y, boss.lair.z);
  for (const m of party.members ?? []) {
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) continue;
    const bot = director.getBot(rec);
    if (!bot || !lairLoc) continue;
    try { bot.moveTo?.(lairLoc); } catch { /* non-fatal */ }
  }
  try {
    const { movePlayerMembersTo } = require("./CitizenPlayerActivities");
    movePlayerMembersTo(director, party, boss.lair.x, boss.lair.y, boss.lair.z);
  } catch {
    // Non-fatal.
  }
  party.phase = "fight";
  party.fightStartedAt = Date.now();
  const line = pickOne(rng, boss.descendLines);
  journalEvent(leader.username, `Led the party to ${boss.label}'s lair. ${line}`, "social");
  for (const m of party.members ?? []) {
    if (normalizeName(m) === normalizeName(leader.username)) continue;
    journalEvent(m, `Went in for the ${boss.label} run.`, "social");
  }
  shoutIfWatched(director, leader, line);
}

function maintainFight(director, party, boss, leader, leaderBot, rng) {
  const members = (party.members ?? []).filter((m) => {
    const rec = director.roster.get(normalizeName(m));
    return rec && director.isOnline(rec);
  });
  if (members.length < 2) {
    // Party collapsed mid-fight — survivors retreat.
    journalEvent(leader.username, `The ${boss.label} run fell apart in the lair — retreated.`, "social");
    sendHome(director, party, leader, boss);
    endRun(director, party, leader, boss, "called off — not enough fighters left.");
    return;
  }

  // Data-tier combat: the party chips the boss down; the boss occasionally
  // lands a journaled hit on a random member (no real damage — data tier).
  // Player members swing too — they're in the fight.
  let playerCount = 0;
  try {
    const { playerMembers } = require("./CitizenPlayerActivities");
    playerCount = playerMembers(director, party).length;
  } catch {
    // Non-fatal.
  }
  party.bossHp = Math.max(
    0,
    (party.bossHp ?? boss.hp) - (members.length + playerCount) * DAMAGE_PER_MEMBER
  );

  if (chance(rng, BOSS_HITBACK_CHANCE)) {
    const victim = pickOne(rng, members);
    journalEvent(victim, `Took a hit from ${boss.label} and shook it off.`, "combat");
  }
  if (chance(rng, FLAVOR_CHANCE)) {
    const who = pickOne(rng, members);
    journalEvent(who, pickOne(rng, boss.fightFlavor) + ".", "combat");
  }

  if (party.bossHp > 0) return; // still fighting

  // Kill — split the loot and head home.
  const killLine = pickOne(rng, boss.killLines);
  journalEvent(leader.username, killLine, "combat");
  shoutIfWatched(director, leader, killLine);
  splitLoot(director, party, boss, members, rng);
  sendHome(director, party, leader, boss);
  endRun(director, party, leader, boss, pickOne(rng, boss.endLines));
}

function splitLoot(director, party, boss, members, rng) {
  const loot = boss.loot ?? {};
  for (const m of members) {
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) continue;
    const bot = director.getBot(rec);
    if (!bot) continue;
    const picked = rollLoot(rng, loot.citizen);
    let bonusName = null;
    if (loot.bonus && chance(rng, loot.bonus.chance)) {
      const [bid, bname] = pickOne(rng, loot.bonus.items);
      picked.push({ id: bid, qty: 1 });
      bonusName = bname;
    }
    for (const { id, qty } of picked) {
      try {
        bot.getInventory?.()?.adds?.(id, qty);
      } catch {
        // Non-fatal.
      }
    }
    journalEvent(m, loot.citizenNote(picked, bonusName), "work");
  }
  // Player members loot too.
  try {
    const { grantBossLootToPlayers } = require("./CitizenPlayerActivities");
    grantBossLootToPlayers(director, party, rng, loot.player, loot.bonus, loot.playerNote);
  } catch {
    // Non-fatal.
  }
}

function sendHome(director, party, leader, boss) {
  // Survivors head back to their kingdom's square (data-tier teleport; the
  // normal brain resumes from town).
  const home = siteTileByKingdom(boss.kingdomId, "square");
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
  // Player members head home with the party.
  try {
    const { movePlayerMembersTo } = require("./CitizenPlayerActivities");
    movePlayerMembersTo(director, party, home.x, home.y, home.z ?? 0);
  } catch {
    // Non-fatal.
  }
}

function endRun(director, party, leader, boss, note) {
  const leaderName = leader.username;
  // The shared run warms every citizen member toward player members.
  try {
    const { bondAfterActivity } = require("./CitizenPlayerActivities");
    bondAfterActivity(director, party, `${boss.label} run`);
  } catch {
    // Non-fatal.
  }
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
  BOSSES,
  bossById,
  bossForKingdom,
  tickBossRuns,
  tryFormBossRun,
};
