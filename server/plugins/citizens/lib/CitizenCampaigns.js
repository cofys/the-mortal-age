"use strict";

/**
 * CitizenCampaigns — citizen armies march to battle.
 *
 * When kingdoms go to war, the home front (CitizenWarfare's militia musters,
 * war news, refugees, war demand) is only half the story. This module is
 * the other half: each side raises an expeditionary force — guards and brave
 * volunteers under a commissioned officer — and marches it to the border to
 * fight. From Jon's perspective it looks like a player army on the move:
 * a rally at the square, a visible march across the world, a journaled
 * battle with real casualties, and survivors marching home.
 *
 * Data tier, zero LLM. Rally, march, battle, casualties, retreat, and
 * disbanding are all state + journal; the foreground LLM reads the journal
 * when a player asks about the war. The only player-visible text is the
 * officer's data-tier orders via forceChat when real players are nearby.
 *
 * Phases (party.phase):
 *   rally   — troops gather at the kingdom square under the officer.
 *   march   — the host travels leg by leg toward the battlefield.
 *   battle  — at the field: simulated clash, journaled blows, real
 *             casualties (fallen citizens are removed from the roster with
 *             a memorial entry).
 *   retreat — survivors march home; disband at the square.
 *
 * The battlefield is the midpoint between the two capitals' squares. Legs
 * longer than a day's walk (Keldagrim's under-realm) are crossed by data-tier
 * teleport, journaled as the passes — same precedent as CitizenBossRuns'
 * lair descent.
 *
 * Wiring: CitizenDirector.tick() calls tickCampaigns(this, hour) once per
 * tick, after the warfare block. Party travel leans on the existing
 * tickFollow (members follow the leader); this module nudges the leader.
 */

const KingdomStore = require("../../kingdoms/KingdomStore");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

const {
  isFriend,
  isEnemy,
  getParty,
  setParty,
  getFollow,
  setFollow,
  clearFollow,
  clearParty,
  normalizeName,
} = require("./CitizenBonds");
const { createParty, disbandParty } = require("./CitizenSocialMechanics");
const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { ATTR_KINGDOM_RANK } = require("../constants");

const CAMPAIGN_ACTIVITY = "campaign";
// Per (war, kingdom) per tick when no campaign is active yet. Wars are rare
// and long; when one starts, the host should raise within a few minutes.
const RAISE_CHANCE = 0.25;
// Don't raise a host for a war that's nearly over.
const RAISE_MIN_REMAINING_MS = 2 * 60 * 60 * 1000;
const MIN_TROOPS = 5; // companions (leader + 5 = 6)
const MAX_TROOPS = 9; // companions (leader + 9 = 10)
const MAX_GUARDS = 5;
const ARRIVE_RADIUS = 6;
const RALLY_MAX_TICKS = 5;
const RALLY_MIN_MEMBERS = 4;
// A leg longer than this is crossed by data-tier teleport (under-realm,
// sea crossing) rather than walked.
const TELEPORT_LEG_AT = 300;
// Battle tuning: ~60s ticks, ~1% casualty per member per tick.
const BATTLE_MAX_TICKS = 45;
const CASUALTY_CHANCE = 0.01;
const BREAK_AT = 0.5; // army breaks and retreats at 50% strength lost
const ROUT_AT = 0.35; // battle ends when one side is at 35% of the other
const BATTLE_FLAVOR_CHANCE = 0.3;

// Border names for the battlefield — same map as the tension engine's
// borderName (not exported there), so the war's field has a real name.
const BORDER_NAMES = {
  "asgarnia:kandarin": "the Ardougne road",
  "asgarnia:keldagrim": "the mountain passes",
  "asgarnia:misthalin": "the Wilderness ditch",
  "asgarnia:morytania": "Paterdomus and the holy river",
  "kandarin:keldagrim": "the western mines",
  "kandarin:misthalin": "the White Wolf passes",
  "kandarin:morytania": "the Mort Myre marches",
  "keldagrim:misthalin": "the northern roads",
  "keldagrim:morytania": "the Meiyerditch underways",
  "misthalin:morytania": "the River Salve",
};

function warKey(war) {
  return `${war.attackerId}:${war.defenderId}`;
}

function kingdomName(kingdomId) {
  try {
    return KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
  } catch {
    return kingdomId;
  }
}

function borderName(a, b) {
  const key = [String(a), String(b)].sort().join(":");
  return BORDER_NAMES[key] ?? "the border marches";
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "war", text);
  } catch {
    // Non-fatal.
  }
}

function requestMovement(bot, x, y, z) {
  try {
    const { requestMovement: rm } = require("../../bots/behaviours/navigation/BotNavigation");
    rm(bot, x, y, { reason: "campaign", basicPather: true, z: z ?? 0 });
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

// --- battlefield ------------------------------------------------------------

function battlefieldTile(war) {
  const a = siteTileByKingdom(war.attackerId, "square");
  const b = siteTileByKingdom(war.defenderId, "square");
  if (!a || !b) return null;
  return {
    x: Math.round((a.x + b.x) / 2),
    y: Math.round((a.y + b.y) / 2),
    z: 0,
  };
}

/** Legs from the home square to the battlefield: quarter, half, field. */
function marchLegs(homeSquare, field) {
  const legs = [];
  for (const t of [0.33, 0.66, 1]) {
    legs.push({
      x: Math.round(homeSquare.x + (field.x - homeSquare.x) * t),
      y: Math.round(homeSquare.y + (field.y - homeSquare.y) * t),
      z: 0,
    });
  }
  return legs;
}

// --- lines -------------------------------------------------------------------

const RALLY_LINES = [
  "The host marches! Who'll fight for the crown?!",
  "To arms! The war host gathers — fall in!",
  "The officer calls the levy — blades to the square, NOW!",
];

const MARCH_LINES = [
  "Onward! They'll rue the day they crossed us!",
  "Keep step! The field is ahead!",
  "For the crown! March!",
];

const BATTLE_ORDER_LINES = [
  "Shields up! Spears forward!",
  "Hold the line! HOLD!",
  "For the crown — CHARGE!",
  "Steady... steady... NOW!",
];

const RETREAT_LINES = [
  "Fall back! The field is lost — fall back!",
  "Sound the retreat! Save who you can!",
  "We're done here — home, lads, HOME!",
];

const VICTORY_LINES = [
  "The field is ours! The enemy breaks and runs!",
  "Victory! They flee like beaten dogs!",
];

const BATTLE_FLAVOR = [
  "the lines clash — spear meets shield, and the field shakes",
  "arrows fall like black rain over the host",
  "the officer's banner dips, rises, dips again in the press",
  "a wedge of guards punches through the enemy line and wheels",
  "the fighting devolves into a grinding shield-wall",
  "war horns answer each other across the field",
];

const MEMORIAL_LINES = [
  "fell with spear in hand, and will be sung of in the taverns",
  "died holding the line, and the crown owes a debt",
  "fell bravely, and their name is carved on the war stone",
];

// --- find / raise --------------------------------------------------------------

function findCampaign(director, key, kingdomId) {
  let orphan = null;
  for (const record of director.roster.values()) {
    const party = getParty(record.username);
    if (!party || party.activity !== CAMPAIGN_ACTIVITY) continue;
    if (party.warKey !== key || party.side !== kingdomId) continue;
    if (normalizeName(party.leader) === normalizeName(record.username)) {
      return { party, leader: record };
    }
    // The officer fell (record gone) — a survivor's copy still names the host.
    if (!orphan) orphan = { party, leader: record, orphaned: true };
  }
  return orphan;
}

function isBrave(record) {
  try {
    const e = record.emotion;
    if (!e) return true;
    return !(e.state === "scared" && (e.intensity ?? 0) > 50);
  } catch {
    return true;
  }
}

function guardRank(director, record) {
  try {
    const bot = director.getBot(record);
    return bot?.getAttribute?.(ATTR_KINGDOM_RANK) ?? null;
  } catch {
    return null;
  }
}

/**
 * Raise the host: an officer (high-standing guard first) plus guards and
 * brave volunteers, 6-10 strong. Never enemies of the officer.
 */
function tryRaiseArmy(director, war, kingdomId) {
  const key = warKey(war);
  // Don't raise for a war that's nearly over.
  try {
    const remaining = (war.resolveAt ?? Infinity) - Date.now();
    if (remaining < RAISE_MIN_REMAINING_MS) return false;
  } catch {
    // resolveAt unknown — raise anyway.
  }
  const rng = agentRng(`campaign:${key}:${kingdomId}:${Date.now() >> 16}`);
  if (!chance(rng, RAISE_CHANCE)) return false;

  const enemyId = kingdomId === war.attackerId ? war.defenderId : war.attackerId;
  const enemyName = kingdomName(enemyId);
  const ownName = kingdomName(kingdomId);

  // Officer: high-standing guard first (Knight/Lord), then any guard.
  let officer = null;
  let fallbackGuard = null;
  for (const record of director.roster.values()) {
    if (record.kingdomId !== kingdomId) continue;
    if (record.role !== "guard") continue;
    if (!director.isOnline(record)) continue;
    if (getParty(record.username)) continue;
    if (getFollow(record.username)) continue;
    const rank = guardRank(director, record);
    if (rank === "Knight" || rank === "Lord") {
      officer = record;
      break;
    }
    if (!fallbackGuard) fallbackGuard = record;
  }
  if (!officer) officer = fallbackGuard;
  if (!officer) return false;
  const officerName = officer.username;

  // Troops: guards first, then brave commoners. Friends preferred, never enemies.
  const seen = new Set([normalizeName(officerName)]);
  const guardPool = [];
  const commonerPool = [];
  for (const other of director.roster.values()) {
    if (other.kingdomId !== kingdomId) continue;
    if (getParty(other.username)) continue;
    if (getFollow(other.username)) continue;
    if (!director.isOnline(other)) continue;
    const on = normalizeName(other.username);
    if (seen.has(on)) continue;
    if (isEnemy(officerName, other.username) || isEnemy(other.username, officerName)) continue;
    seen.add(on);
    if (other.role === "guard") guardPool.push(other);
    else if (other.role === "commoner" && isBrave(other)) commonerPool.push(other);
  }
  const troops = [];
  const guardFriends = guardPool.filter((c) => isFriend(officerName, c.username));
  const guardRest = guardPool.filter((c) => !isFriend(officerName, c.username));
  for (const c of [...guardFriends, ...guardRest]) {
    if (troops.length >= MAX_GUARDS) break;
    troops.push(c.username);
  }
  const commonerFriends = commonerPool.filter((c) => isFriend(officerName, c.username));
  const commonerRest = commonerPool.filter((c) => !isFriend(officerName, c.username));
  for (const c of [...commonerFriends, ...commonerRest]) {
    if (troops.length >= MAX_TROOPS) break;
    troops.push(c.username);
  }
  if (troops.length < MIN_TROOPS) return false;

  const homeSquare = siteTileByKingdom(kingdomId, "square");
  const field = battlefieldTile(war);
  if (!homeSquare || !field) return false;
  const legs = marchLegs(homeSquare, field);

  const party = createParty(officerName, troops);
  party.activity = CAMPAIGN_ACTIVITY;
  party.warKey = key;
  party.side = kingdomId;
  party.enemyId = enemyId;
  party.phase = "rally";
  party.rallyTicks = 0;
  party.legs = legs;
  party.homeSquare = homeSquare;
  party.legIdx = 0;
  party.battleTicks = 0;
  party.fieldName = borderName(kingdomId, enemyId);
  party.startStrength = troops.length + 1;

  for (const m of troops) {
    setFollow(m, officerName, "campaign");
  }

  const troopDisplays = troops.map((c) => {
    const rec = director.roster.get(normalizeName(c));
    return rec?.displayName ?? c;
  });
  const officerDisplay = officer.displayName ?? officerName;
  journalEvent(
    officerName,
    `Commissioned officer of the war host against ${enemyName}. Raised ${troops.length} troops: ${troopDisplays.join(", ")}.`,
    "war"
  );
  for (const t of troops) {
    journalEvent(t, `Marched to war against ${enemyName} under officer ${officerDisplay}.`, "war");
  }
  shoutIfWatched(director, officer, pickOne(rng, RALLY_LINES).replace("the crown", ownName));
  return true;
}

// --- casualties ------------------------------------------------------------------

/**
 * A citizen falls in battle: memorial journal, bot logged out, record
 * removed from the roster (the war has real stakes). The name stays in
 * usedNames so no ghost reuses it.
 */
function recordCasualty(director, record, party, fieldName, rng) {
  const name = record.username;
  const display = record.displayName ?? name;
  const memorial = pickOne(rng, MEMORIAL_LINES);
  journalEvent(name, `${display} ${memorial} — at ${fieldName}.`, "memorial");
  const officerRec = director.roster.get(normalizeName(party.leader));
  if (officerRec) {
    journalEvent(
      party.leader,
      `Lost ${display} at ${fieldName}. The host mourns.`,
      "war"
    );
  }
  // Remove the fallen from the host WITHOUT leaveParty: leaveParty spreads
  // the leaver's (possibly stale) party copy over every member's bonds,
  // which would rewind battleTicks/phase on the authoritative copy.
  try { clearParty(name); } catch { /* non-fatal */ }
  try { clearFollow(name); } catch { /* non-fatal */ }
  // Full cleanup (journal, memory, needs, kinship, chat registration)
  // goes through the director's single choke point.
  try { director.removeCitizen(record); } catch { /* non-fatal */ }
  // Keep the authoritative party copy honest, then push it to all survivors.
  if (Array.isArray(party.members)) {
    party.members = party.members.filter((m) => normalizeName(m) !== normalizeName(name));
  }
  syncParty(director, party);
}

/** Re-share the authoritative party object with every surviving member.
 * Uses the same reference (not a spread copy) so the host's state stays
 * universally fresh — the invariant createParty establishes. */
function syncParty(director, party) {
  try {
    for (const m of party.members ?? []) {
      const rec = director.roster.get(normalizeName(m));
      if (rec) setParty(rec.username, party);
    }
  } catch {
    // Non-fatal.
  }
}

// --- phase maintenance --------------------------------------------------------------

function onlineMembers(director, party, excludeLeader) {
  const out = [];
  for (const m of party.members ?? []) {
    if (excludeLeader && normalizeName(m) === normalizeName(party.leader)) continue;
    const rec = director.roster.get(normalizeName(m));
    if (rec && director.isOnline(rec)) out.push(rec);
  }
  return out;
}

function ensureOfficer(director, party, rng) {
  // The officer fell or logged off — the highest-ranking survivor takes
  // command. Returns the new leader record, or null if the host is gone.
  let leader = director.roster.get(normalizeName(party.leader)) ?? null;
  if (leader && director.isOnline(leader)) return leader;
  const survivors = onlineMembers(director, party, false);
  if (survivors.length === 0) return null;
  const guards = survivors.filter((r) => r.role === "guard");
  const pool = guards.length > 0 ? guards : survivors;
  // Prefer high-standing guards.
  let next = pool[0];
  for (const r of pool) {
    const rank = guardRank(director, r);
    if (rank === "Lord" || rank === "Knight") {
      next = r;
      break;
    }
  }
  party.leader = normalizeName(next.username);
  syncParty(director, party);
  const fieldName = party.fieldName ?? "the field";
  journalEvent(
    next.username,
    `Took command of the host at ${fieldName} after the officer fell.`,
    "war"
  );
  shoutIfWatched(director, next, "The officer's down — I have command! Hold the line!");
  return next;
}

function teleportParty(director, party, tile, note) {
  const loc = makeLocation(director, tile.x, tile.y, tile.z ?? 0);
  if (!loc) return false;
  for (const m of party.members ?? []) {
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) continue;
    const bot = director.getBot(rec);
    if (!bot) continue;
    try { bot.moveTo?.(loc); } catch { /* non-fatal */ }
  }
  return true;
}

function maintainRally(director, party, leader, rng) {
  party.rallyTicks = (party.rallyTicks ?? 0) + 1;
  // Rally AT the square — not at legs[0], which is a third of the way to
  // the field. (party.legs holds march waypoints only.)
  const homeSquare = party.homeSquare ?? party.legs?.[0];
  const leaderBot = director.getBot(leader);
  const tile = leaderBot ? botTile(leaderBot) : null;
  if (homeSquare && tile && chebyshev(tile, homeSquare) > ARRIVE_RADIUS) {
    const jx = homeSquare.x + Math.floor(rng() * 5) - 2;
    const jy = homeSquare.y + Math.floor(rng() * 5) - 2;
    requestMovement(leaderBot, jx, jy, homeSquare.z ?? 0);
  }
  const online = onlineMembers(director, party, false);
  const gathered = online.length >= RALLY_MIN_MEMBERS &&
    (!homeSquare || !tile || chebyshev(tile, homeSquare) <= ARRIVE_RADIUS);
  if (gathered || party.rallyTicks >= RALLY_MAX_TICKS) {
    if (online.length < 2) {
      endCampaign(director, party, leader, "The host melted away before it ever marched.");
      return;
    }
    party.phase = "march";
    party.legIdx = 0;
    const enemyName = kingdomName(party.enemyId ?? "");
    journalEvent(
      leader.username,
      `The host marches on ${enemyName} — ${online.length} strong, bound for ${party.fieldName ?? "the border"}.`,
      "war"
    );
    shoutIfWatched(director, leader, pickOne(rng, MARCH_LINES));
  }
}

function advanceMarch(director, party, leader, rng) {
  const legs = party.legs ?? [];
  const legIdx = party.legIdx ?? 0;
  if (legIdx >= legs.length) {
    // Reached the field.
    party.phase = "battle";
    party.battleTicks = 0;
    const enemyName = kingdomName(party.enemyId ?? "");
    journalEvent(
      leader.username,
      `The host has reached ${party.fieldName ?? "the border"}. Battle is joined against ${enemyName}.`,
      "war"
    );
    shoutIfWatched(director, leader, pickOne(rng, BATTLE_ORDER_LINES));
    return;
  }
  const dest = legs[legIdx];
  const leaderBot = director.getBot(leader);
  const tile = leaderBot ? botTile(leaderBot) : null;
  if (tile && chebyshev(tile, dest) > ARRIVE_RADIUS) {
    const dist = chebyshev(tile, dest);
    if (dist > TELEPORT_LEG_AT) {
      // Cross-region leg (the under-realm, a sea crossing): the whole host
      // crosses data-tier, journaled as the passage.
      if (teleportParty(director, party, dest)) {
        journalEvent(
          leader.username,
          `The host crossed the long dark between — through passes no map names — and marches on.`,
          "war"
        );
      }
    } else {
      const jx = dest.x + Math.floor(rng() * 5) - 2;
      const jy = dest.y + Math.floor(rng() * 5) - 2;
      requestMovement(leaderBot, jx, jy, dest.z ?? 0);
    }
    return; // still traveling
  }
  // Leg reached.
  party.legIdx = legIdx + 1;
  if (party.legIdx < legs.length) {
    journalEvent(
      leader.username,
      `The host makes good time — past the ${party.legIdx === 1 ? "first" : "second"} waypoint, the field ahead.`,
      "war"
    );
  }
}

function maintainBattle(director, party, leader, war, rng) {
  party.battleTicks = (party.battleTicks ?? 0) + 1;
  const key = party.warKey;
  const fieldName = party.fieldName ?? "the border";
  const enemyName = kingdomName(party.enemyId ?? "");

  // Own strength: online survivors.
  const own = onlineMembers(director, party, false);
  if (own.length < 2) {
    journalEvent(leader.username, `The host broke at ${fieldName} — too few left to hold.`, "war");
    beginRetreat(director, party, leader, rng, "broken");
    return;
  }

  // The enemy host, if it has reached the field.
  const enemyCampaign = findCampaign(director, key, party.enemyId);
  const enemyOnField = !!(enemyCampaign && enemyCampaign.party.phase === "battle");

  // Casualties: the field takes its toll.
  const fallen = [];
  for (const rec of own) {
    if (chance(rng, CASUALTY_CHANCE)) fallen.push(rec);
  }
  for (const rec of fallen) {
    recordCasualty(director, rec, party, fieldName, rng);
  }

  if (!enemyOnField) {
    // No enemy host on the field — skirmish with their border patrols and
    // hold the ground. If they never come, torch the border farms and go home.
    if (chance(rng, BATTLE_FLAVOR_CHANCE)) {
      journalEvent(
        leader.username,
        `At ${fieldName}: ${pickOne(rng, BATTLE_FLAVOR)}. No sign of the ${enemyName} host yet.`,
        "war"
      );
    }
    if ((party.battleTicks ?? 0) >= BATTLE_MAX_TICKS) {
      journalEvent(
        leader.username,
        `The ${enemyName} host never came to ${fieldName} — the host put their border farms to the torch and marches home.`,
        "war"
      );
      shoutIfWatched(director, leader, "They wouldn't face us! Burn it all — we march home!");
      beginRetreat(director, party, leader, rng, "raid");
    }
    return;
  }

  // Pitched battle against the enemy host.
  const enemyParty = enemyCampaign.party;
  const enemyStrength = onlineMembers(director, enemyParty, false).length;
  if (chance(rng, 0.5)) {
    // The enemy host bleeds too — journaled here; their own tick buries theirs.
    const foe = pickOne(rng, onlineMembers(director, enemyParty, false));
    if (foe) {
      journalEvent(
        leader.username,
        `Our spears found ${foe.displayName ?? foe.username} of the ${enemyName} host at ${fieldName}.`,
        "war"
      );
    }
  }

  if (chance(rng, BATTLE_FLAVOR_CHANCE)) {
    journalEvent(leader.username, `At ${fieldName}: ${pickOne(rng, BATTLE_FLAVOR)}.`, "war");
  }
  if (chance(rng, 0.25)) {
    shoutIfWatched(director, leader, pickOne(rng, BATTLE_ORDER_LINES));
  }

  const remaining = onlineMembers(director, party, false).length;
  const startStrength = party.startStrength ?? remaining;

  // Broken: too many fallen.
  if (remaining < Math.max(2, Math.ceil(startStrength * (1 - BREAK_AT)))) {
    journalEvent(
      leader.username,
      `The host breaks at ${fieldName} — the fallen are too many. The survivors fall back.`,
      "war"
    );
    shoutIfWatched(director, leader, pickOne(rng, RETREAT_LINES));
    beginRetreat(director, party, leader, rng, "broken");
    return;
  }
  // Routed the enemy host: they drop below 35% of our strength.
  if (remaining > 0 && enemyStrength > 0 && enemyStrength <= Math.ceil(remaining * ROUT_AT)) {
    const line = pickOne(rng, VICTORY_LINES);
    journalEvent(leader.username, `${line} The ${enemyName} host flees ${fieldName}.`, "war");
    shoutIfWatched(director, leader, line);
    beginRetreat(director, party, leader, rng, "victorious");
    return;
  }
  // Stalemate: the field grinds to a halt.
  if ((party.battleTicks ?? 0) >= BATTLE_MAX_TICKS) {
    journalEvent(
      leader.username,
      `The battle at ${fieldName} grinds to a bloody halt — neither host will yield. The survivors withdraw.`,
      "war"
    );
    beginRetreat(director, party, leader, rng, "stalemate");
  }
}

function beginRetreat(director, party, leader, rng, kind) {
  if (party.phase === "retreat") return;
  party.phase = "retreat";
  const legs = party.legs ?? [];
  // Walk the legs home in reverse, ending at the square — the host
  // disbands there, not at the first march waypoint.
  party.retreatLegs = [...legs].reverse();
  if (party.homeSquare) party.retreatLegs.push(party.homeSquare);
  party.retreatIdx = 0;
  const fieldName = party.fieldName ?? "the field";
  if (kind === "victorious") {
    journalEvent(leader.username, `Victorious at ${fieldName}, the host marches home.`, "war");
  } else if (kind === "broken") {
    journalEvent(leader.username, `Broken at ${fieldName}, the survivors limp home.`, "war");
  } else if (kind === "peace") {
    journalEvent(leader.username, `The war is over — the host marches home from ${fieldName}.`, "war");
  } else if (kind === "raid") {
    journalEvent(leader.username, `Raid complete at ${fieldName} — the host marches home with full packs.`, "war");
  } else {
    journalEvent(leader.username, `The host withdraws from ${fieldName} and marches home.`, "war");
  }
}

function maintainRetreat(director, party, leader, rng) {
  const legs = party.retreatLegs ?? [];
  const idx = party.retreatIdx ?? 0;
  if (idx >= legs.length) {
    const survivors = onlineMembers(director, party, false).length;
    endCampaign(
      director,
      party,
      leader,
      `The host came home — ${survivors} of ${party.startStrength ?? survivors} who marched out.`
    );
    return;
  }
  const dest = legs[idx];
  const leaderBot = director.getBot(leader);
  const tile = leaderBot ? botTile(leaderBot) : null;
  if (tile && chebyshev(tile, dest) > ARRIVE_RADIUS) {
    const dist = chebyshev(tile, dest);
    if (dist > TELEPORT_LEG_AT) {
      teleportParty(director, party, dest);
    } else {
      const jx = dest.x + Math.floor(rng() * 5) - 2;
      const jy = dest.y + Math.floor(rng() * 5) - 2;
      requestMovement(leaderBot, jx, jy, dest.z ?? 0);
    }
    return; // still traveling
  }
  party.retreatIdx = idx + 1;
}

function endCampaign(director, party, leader, note) {
  for (const m of [...(party.members ?? [])]) {
    try { clearFollow(m); } catch { /* non-fatal */ }
  }
  try {
    disbandParty(leader.username);
  } catch {
    // Non-fatal — the follows are already cleared.
  }
  journalEvent(leader.username, note, "war");
}

function maintainCampaign(director, party, leader, rng) {
  // The officer fell or logged off mid-campaign — succession.
  const officer = ensureOfficer(director, party, rng);
  if (!officer) {
    endCampaign(director, party, leader, "The host dissolved — no one left to lead it.");
    return;
  }
  leader = officer;

  // Drop offline members from the party (direct removal, not leaveParty —
  // leaveParty would spread a stale party copy over the survivors' bonds).
  let pruned = false;
  for (const m of [...(party.members ?? [])]) {
    if (normalizeName(m) === normalizeName(leader.username)) continue;
    const rec = director.roster.get(normalizeName(m));
    if (!rec || !director.isOnline(rec)) {
      try { clearParty(m); } catch { /* non-fatal */ }
      try { clearFollow(m); } catch { /* non-fatal */ }
      party.members = (party.members ?? []).filter((x) => normalizeName(x) !== normalizeName(m));
      pruned = true;
    }
  }
  if (pruned) syncParty(director, party);

  switch (party.phase) {
    case "rally":
      maintainRally(director, party, leader, rng);
      break;
    case "march":
      advanceMarch(director, party, leader, rng);
      break;
    case "battle": {
      const parsed = parseWarKey(party.warKey);
      const war = parsed
        ? { attackerId: parsed.attackerId, defenderId: parsed.defenderId }
        : null;
      maintainBattle(director, party, leader, war, rng);
      break;
    }
    case "retreat":
      maintainRetreat(director, party, leader, rng);
      break;
    default:
      // Unknown phase — march home rather than strand the host.
      beginRetreat(director, party, leader, rng, "peace");
      break;
  }
}

// --- tick --------------------------------------------------------------------

function tickCampaigns(director, hour) {
  let wars = [];
  try {
    wars = KingdomStore.getActiveWars() ?? [];
  } catch {
    wars = [];
  }

  // 1. Existing hosts: maintain, or march home when their war is over.
  // A retreating host still needs its march-home ticks — never skip
  // maintainCampaign after beginRetreat.
  const activeKeys = new Set(wars.map(warKey));
  const seen = new Set();
  const leaders = [];
  for (const record of director.roster.values()) {
    const party = getParty(record.username);
    if (!party || party.activity !== CAMPAIGN_ACTIVITY) continue;
    if (normalizeName(party.leader) !== normalizeName(record.username)) continue;
    if (seen.has(party.id)) continue;
    seen.add(party.id);
    leaders.push({ party, leader: record });
  }
  // Orphaned hosts: the officer fell and their record is gone. Adopt via a
  // survivor's copy so ensureOfficer can promote a new commander.
  for (const record of director.roster.values()) {
    const party = getParty(record.username);
    if (!party || party.activity !== CAMPAIGN_ACTIVITY) continue;
    if (seen.has(party.id)) continue;
    seen.add(party.id);
    leaders.push({ party, leader: record, orphaned: true });
  }
  for (const { party, leader } of leaders) {
    const rng = agentRng(`campaign:${party.id}:${Date.now() >> 16}`);
    try {
      if (!activeKeys.has(party.warKey)) {
        const parsed = parseWarKey(party.warKey);
        const war = parsed
          ? { attackerId: parsed.attackerId, defenderId: parsed.defenderId }
          : null;
        if (!war || !warStillActive(war)) {
          beginRetreat(director, party, leader, rng, "peace");
        }
      }
      maintainCampaign(director, party, leader, rng);
    } catch {
      // One host's trouble never breaks the campaign tick.
    }
  }

  // 2. New wars: raise the hosts.
  for (const war of wars) {
    const key = warKey(war);
    for (const kingdomId of [war.attackerId, war.defenderId]) {
      if (findCampaign(director, key, kingdomId)) continue;
      try {
        tryRaiseArmy(director, war, kingdomId);
      } catch {
        // Non-fatal.
      }
    }
  }
}

module.exports = {
  tickCampaigns,
  tryRaiseArmy,
  findCampaign,
  warKey,
  CAMPAIGN_ACTIVITY,
};
