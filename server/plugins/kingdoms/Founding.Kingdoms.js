"use strict";

/**
 * Founding.Kingdoms — "YOU CAN TRY. YOU WILL PROBABLY DIE."
 *
 * The player-kingdom founding flow. Jon's vision is explicit: a player MAY
 * attempt to found a kingdom, but the existing powers will react violently,
 * survival is unlikely, and the attempt consumes real resources — walls,
 * food, gear, wages, soldiers, supplies.
 *
 * THE FLOW (all diegetic — the claim stake is the whole interface; ::found
 * stays registered for dev only until the stake path is verified in-game):
 *
 *   1. CHARTER (drop a Stake in unclaimed land, drive it, speak the name)
 *      The founder stands in unclaimed land (outside all great-power
 *      territories) and pays 10,000,000 coins for a charter. The name must
 *      be unique, 3-20 chars, letters and spaces. The founder becomes ruler
 *      of a FLEDGLING kingdom — not a great power, a claim. The charter is
 *      burned: gone, whatever happens.
 *
 *   2. MUSTER (at the claim stake: swear followers, fill the war chest)
 *      The founder needs followers (real players) and a war chest. But the
 *      camp EATS, every ~5 minutes, from the war chest:
 *        - walls: a one-time 5,000,000 fortification levy for the palisade
 *          (+500 host strength while it stands; half-raised walls grant
 *          nothing). Retried each tick until paid.
 *        - food and wages: 7,000 coins per sworn mouth per tick.
 *      Mouths the chest cannot feed DESERT, earliest-sworn first (the
 *      founder never deserts their own claim). Every coin is itemized in
 *      the founding:ledger flag: charter, walls, wages, battle, raid,
 *      plunder.
 *
 *   3. THE RESPONSE
 *      The nearest great power does not recognize the claim. After a grace
 *      period (60-120 min), their marshal musters AT THE CAPITAL — a
 *      visible Marshal and legionary escort, tagged courtiers of the crown
 *      — and the campaign costs the crown 100,000 coins of war steel. A
 *      realm announcement names the illegitimate claim; the pacification is
 *      declared as a real war (kingdom:war-declared, declaredBy "founding")
 *      so it shows on the war table. Thirty minutes later the host arrives.
 *
 *      The battle runs three rounds, five minutes apart, and it BLEEDS:
 *      each round costs ~15% of the sworn host (captured or fallen) and
 *      burns ~10% of the war chest (torched supply wagons). Then the
 *      decisive roll:
 *
 *        strength = followers x 50 + warChest/10_000 + founderCombat x 2
 *                   + 500 if the palisade stands
 *        force    = 10_000 + greatPowerTreasury/100_000 + strength x 18
 *        win      = strength / (strength + force)
 *
 *      The great power answers the threat you pose — eighteen spears for
 *      every one of yours, plus a standing legion of ten thousand. The odds
 *      asymptote at 1/19: a lone founder faces ~0.5%, a hundred followers
 *      and a fat war chest might reach ~5%. No effort on earth beats ~5.3%.
 *      The math is the message.
 *
 *   4. OUTCOMES
 *      Crushed (the likely): the kingdom dissolves. The remaining chest is
 *        plundered into the great power's treasury. The war ends
 *        (kingdom:war-ended). The realm is told what the attempt cost,
 *        itemized. The marshal's host stands down.
 *      Survived (the miracle): the kingdom persists as a MINOR power —
 *        fragile, breathing hard. Weekly upkeep of 500,000 coins from its
 *        coffers or the banners come down. The claim stake stands on as a
 *        banner post: the founder pays upkeep and fills the coffers there,
 *        and anyone else may raid the stores. Tension with the responding
 *        power stays hot; the neighbors watch.
 *
 *   5. RAIDING
 *      A fledgling's war chest — and a minor power's coffers — can be
 *      raided at the stake/banner post by anyone not sworn to the banner:
 *      10% of the chest (1k min, 250k max), ten minutes between raids per
 *      claim. The founder is warned. The realm hears a rumor.
 *
 * State: founding kingdoms live in KingdomStore with flags:
 *   founding:fledgling   true while the claim is contested
 *   founding:survived    true once the miracle happens
 *   founding:founded-at  timestamp
 *   founding:respond-at  when the marshal marches
 *   founding:battle-at   when the host arrives (round 1)
 *   founding:round       battle rounds resolved (0-3)
 *   founding:round-at    when the next round resolves
 *   founding:warned      march announcement sent
 *   founding:war-chest   coins committed (drains constantly)
 *   founding:followers   [usernames], founder first
 *   founding:great-power the responding kingdom id
 *   founding:walls-paid  the palisade stands
 *   founding:ledger      [{ stage, label, coins, at }] — what it all cost
 *   founding:raided-at   last raid timestamp (cooldown)
 *   founding:claim       { x, y, z } where the stake stands
 *   founding:last-upkeep last weekly upkeep timestamp (survivors)
 *
 * Out (custom events):
 *   kingdom:created { kingdomId, name, capital, ruler, rulerTitle }
 *   kingdom:war-declared { attackerId, defenderId, declaredBy: "founding", reason, resolveAt }
 *   kingdom:war-ended { attackerId, defenderId, outcome }
 *   kingdom:rumor { kingdomId, text }
 *
 * In (custom events): none. The Tension model skips founding wars
 * (declaredBy "founding") and never formally declares war on a founding
 * kingdom — great powers raid hamlets, they don't declare on them.
 */

const Store = require("./KingdomStore");
const Castle = require("./Castle.Kingdoms");
const Membership = require("./Membership.Kingdoms");
const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");

// --- tuning ---------------------------------------------------------------

const CHARTER_COST = 10_000_000;
// One-time fortification levy, taken from the war chest. Until it is paid
// the palisade stands half-raised and grants no strength.
const WALLS_COST = 5_000_000;
const FORTIFICATION_STRENGTH = 500;
// The camp eats every tick (~5 min): 2k food + 5k wages per sworn mouth.
const FOOD_PER_TICK = 2_000;
const WAGES_PER_TICK = 5_000;
const PER_MOUTH_PER_TICK = FOOD_PER_TICK + WAGES_PER_TICK;

const WEEKLY_UPKEEP = 500_000;
const UPKEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// The marshal answers the threat you pose: a standing legion of 10,000, a
// tithe of the crown's treasury, and eighteen spears for every one of
// yours. Survival odds asymptote at 1/19 (~5.3%). The math is the message.
const FOLLOWER_STRENGTH = 50;
const CHEST_STRENGTH_PER_10K = 1;
const COMBAT_STRENGTH_PER_LEVEL = 2;
const PACIFICATION_BASE = 10_000;
const RESPONSE_MULTIPLIER = 18;

// What the crown spends to muster the marshal's host.
const CAMPAIGN_COST = 100_000;

// Grace before the marshal marches: 60-120 minutes.
const RESPOND_MIN_MS = 60 * 60 * 1000;
const RESPOND_MAX_MS = 120 * 60 * 1000;
// The march itself: 30 minutes of dread.
const MARCH_MS = 30 * 60 * 1000;
// The battle: three rounds, five minutes apart.
const ROUND_MS = 5 * 60 * 1000;
const BATTLE_ROUNDS = 3;
const ROUND_FOLLOWER_LOSS = 0.15;
const ROUND_CHEST_BURN = 0.1;

// Raiding: 10% of the chest, bounded, ten minutes between raids per claim.
const RAID_CHEST_SHARE = 0.1;
const RAID_MIN = 1_000;
const RAID_MAX = 250_000;
const RAID_COOLDOWN_MS = 10 * 60 * 1000;

// Tension the claim is born into / the miracle leaves behind.
const GREAT_POWER_IDS = ["asgarnia", "misthalin", "kandarin", "morytania", "keldagrim"];
const TENSION_CLAIM_VS_RESPONDER = 80;
const TENSION_CLAIM_VS_OTHER = 30;
const TENSION_SURVIVOR_VS_RESPONDER = 85;
const TENSION_SURVIVOR_VS_OTHER = 35;

// Founding task ticks every ~5 minutes (600ms/tick).
const FOUNDING_TICK_TICKS = 500;

// Marshal muster points: the great-power capitals.
const GREAT_POWER_MUSTER = {
  asgarnia: { x: 2964, y: 3378, z: 0 },
  misthalin: { x: 3165, y: 3485, z: 0 },
  kandarin: { x: 2660, y: 3290, z: 0 },
  morytania: { x: 3495, y: 3235, z: 0 },
  keldagrim: { x: 2855, y: 10200, z: 0 },
};
const MARSHAL_ESCORT_SIZE = 4;

const FLAG_FLEDGLING = "founding:fledgling";
const FLAG_SURVIVED = "founding:survived";
const FLAG_FOUNDED_AT = "founding:founded-at";
const FLAG_RESPOND_AT = "founding:respond-at";
const FLAG_BATTLE_AT = "founding:battle-at";
const FLAG_ROUND = "founding:round";
const FLAG_ROUND_AT = "founding:round-at";
const FLAG_WARNED = "founding:warned";
const FLAG_WAR_CHEST = "founding:war-chest";
const FLAG_FOLLOWERS = "founding:followers";
const FLAG_GREAT_POWER = "founding:great-power";
const FLAG_WALLS_PAID = "founding:walls-paid";
const FLAG_LEDGER = "founding:ledger";
const FLAG_RAIDED_AT = "founding:raided-at";
const FLAG_CLAIM = "founding:claim";
const FLAG_LAST_UPKEEP = "founding:last-upkeep";

let pluginApi = null;
let Item = null;
let NpcIdentifiers = null;

// kingdomId -> [npc] — the marshal's mustered host (despawned on resolution).
const marshalHosts = new Map();
// kingdomId -> [npc] — the vanguard at the claim during the battle rounds.
const vanguards = new Map();

// --- helpers --------------------------------------------------------------

function isRealPlayer(player) {
  return player?.isPlayer?.() === true && player?.isPlayerBot?.() !== true;
}

function coinsInInventory(player) {
  try {
    return player.getInventory?.().getAmount?.(995) ?? 0;
  } catch {
    return 0;
  }
}

function takeCoins(player, amount) {
  try {
    return player.getInventory?.().delete?.(995, amount) ?? false;
  } catch {
    return false;
  }
}

function giveCoins(player, amount) {
  try {
    if (!Item || !(amount > 0)) return false;
    player.getInventory()?.add?.(new Item(995, Math.floor(amount)), true);
    return true;
  } catch {
    return false;
  }
}

function combatLevel(player) {
  try {
    return player.getSkills?.().getCombatLevel?.() ?? 3;
  } catch {
    return 3;
  }
}

function playerPos(player) {
  try {
    const p = player.getPosition?.();
    return { x: p?.getX?.() ?? 0, y: p?.getY?.() ?? 0, z: p?.getZ?.() ?? 0 };
  } catch {
    return { x: 0, y: 0, z: 0 };
  }
}

/** True if the position is outside all great-power territories. */
function isUnclaimed(pos) {
  // Great-power rects from Areas.Kingdoms (v1 approximations).
  const rects = [
    [2880, 3280, 3040, 3519], // asgarnia
    [3072, 3168, 3296, 3512], // misthalin
    [2432, 3072, 2656, 3360], // kandarin
    [3408, 3776, 3264, 3536], // morytania
    [2816, 2944, 10112, 10272], // keldagrim
  ];
  for (const [x1, x2, y1, y2] of rects) {
    if (pos.x >= x1 && pos.x <= x2 && pos.y >= y1 && pos.y <= y2) return false;
  }
  return true;
}

/** Fledgling (contested) and survived (minor power) founding kingdoms. */
function foundingKingdoms() {
  try {
    return Object.values(Store.load().kingdoms ?? {}).filter(
      (k) => k?.flags?.[FLAG_FLEDGLING] === true || k?.flags?.[FLAG_SURVIVED] === true
    );
  } catch {
    return [];
  }
}

function fledglingKingdoms() {
  return foundingKingdoms().filter((k) => k?.flags?.[FLAG_FLEDGLING] === true);
}

function isFoundingKingdom(kingdomId) {
  const k = Store.getKingdom(kingdomId);
  return k?.flags?.[FLAG_FLEDGLING] === true || k?.flags?.[FLAG_SURVIVED] === true;
}

function isSurvived(kingdom) {
  return kingdom?.flags?.[FLAG_SURVIVED] === true;
}

/** The fledgling or minor power a player rules (founder is followers[0]). */
function ruledKingdom(player) {
  const username = player?.getUsername?.()?.toLowerCase?.();
  if (!username) return null;
  return (
    foundingKingdoms().find((k) => (k.ruler ?? "").toLowerCase() === username) ?? null
  );
}

/** The fledgling or minor power a player is sworn to (ruler or follower). */
function swornKingdom(player) {
  const username = player?.getUsername?.()?.toLowerCase?.();
  if (!username) return null;
  return (
    ruledKingdom(player) ??
    foundingKingdoms().find((k) => (k.flags?.[FLAG_FOLLOWERS] ?? []).includes(username)) ??
    null
  );
}

function nearestGreatPower(pos) {
  let best = "asgarnia";
  let bestD = Infinity;
  for (const [id, c] of Object.entries(GREAT_POWER_MUSTER)) {
    const d = Math.hypot(c.x - pos.x, c.y - pos.y);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function announceToRealm(message) {
  try {
    pluginApi.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        try {
          p.sendMessage(message);
        } catch {
          // One deaf player doesn't silence the realm.
        }
      });
  } catch {
    // World not ready.
  }
}

function slugify(name) {
  return (
    "founded-" +
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
  );
}

function fmtCoins(n) {
  const v = Math.floor(n ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return `${v}`;
}

/** Itemize what the attempt has consumed: the ledger never forgets. */
function ledger(kingdom, stage, label, coins) {
  try {
    const k = Store.getKingdom(kingdom.id ?? kingdom);
    if (!k) return;
    const entries = k.flags?.[FLAG_LEDGER] ?? [];
    entries.push({ stage, label, coins: Math.floor(coins ?? 0), at: Date.now() });
    Store.setFlag(k.id, FLAG_LEDGER, entries);
  } catch {
    // The ledger is accounting, not load-bearing.
  }
}

function costSummary(kingdom) {
  const entries = kingdom.flags?.[FLAG_LEDGER] ?? [];
  const byStage = {};
  for (const e of entries) byStage[e.stage] = (byStage[e.stage] ?? 0) + (e.coins ?? 0);
  const parts = [];
  if (byStage.charter) parts.push(`${fmtCoins(byStage.charter)} charter`);
  if (byStage.walls) parts.push(`${fmtCoins(byStage.walls)} walls`);
  if (byStage.wages) parts.push(`${fmtCoins(byStage.wages)} food and wages`);
  if (byStage.battle) parts.push(`${fmtCoins(byStage.battle)} burned in battle`);
  if (byStage.raid) parts.push(`${fmtCoins(byStage.raid)} raided`);
  if (byStage.plunder) parts.push(`${fmtCoins(byStage.plunder)} plundered`);
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);
  return { total, text: parts.length > 0 ? `${fmtCoins(total)} — ${parts.join(", ")}` : "nothing yet" };
}

// --- the math -------------------------------------------------------------

/**
 * The math is the message. The great power answers the threat you pose:
 * eighteen spears for every one of yours, plus a standing legion of ten
 * thousand. A lone founder faces ~0.5%; a vast host asymptotes at ~5.3%.
 */
function founderStrength(kingdom) {
  const flags = kingdom.flags ?? {};
  const followers = flags[FLAG_FOLLOWERS] ?? [];
  const chest = flags[FLAG_WAR_CHEST] ?? 0;
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
  const combat = founder ? combatLevel(founder) : 3;
  // Followers who are offline still count — they swore the oath.
  return (
    followers.length * FOLLOWER_STRENGTH +
    Math.floor(chest / 10_000) * CHEST_STRENGTH_PER_10K +
    combat * COMBAT_STRENGTH_PER_LEVEL +
    Castle.fortStrength(kingdom.id)
  );
}

function pacificationForce(greatPowerId, strength) {
  const gp = Store.getKingdom(greatPowerId);
  const treasury = gp?.treasury ?? 0;
  return (
    PACIFICATION_BASE +
    Math.floor(treasury / 100_000) +
    Math.floor(strength * RESPONSE_MULTIPLIER)
  );
}

function survivalOdds(kingdom) {
  const strength = founderStrength(kingdom);
  const force = pacificationForce(kingdom.flags?.[FLAG_GREAT_POWER], strength);
  return { strength, force, chance: strength / (strength + force) };
}

function oddsLine(kingdom) {
  const { strength, force, chance } = survivalOdds(kingdom);
  const pct = chance * 100;
  const pctText = pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
  return (
    `  Your host: ${strength.toLocaleString()} strength. ` +
    `The marshal's answer: ${force.toLocaleString()}. The songs give you ${pctText}%.`
  );
}

// --- visible mustering ----------------------------------------------------

function spawnNpcAt(id, x, y, z, wanderRadius) {
  try {
    return pluginApi.spawnNpc({ id, x, y, z, wanderRadius }) ?? null;
  } catch {
    return null;
  }
}

/** The marshal musters AT THE CAPITAL — visible, tagged, standing in steel. */
function spawnMarshalHost(kingdom) {
  const id = kingdom.id;
  if (marshalHosts.has(id)) return;
  const gpId = kingdom.flags?.[FLAG_GREAT_POWER];
  const muster = GREAT_POWER_MUSTER[gpId];
  const marshalId = NpcIdentifiers?.ARMY_COMMANDER;
  const legionaryId = NpcIdentifiers?.GUARD;
  if (!muster || !Number.isFinite(marshalId) || !Number.isFinite(legionaryId)) {
    console.warn("[founding] cannot muster: no capital or NPC ids", { id, gpId });
    return;
  }
  const host = [];
  const marshal = spawnNpcAt(marshalId, muster.x, muster.y, muster.z, 3);
  if (marshal) {
    Membership.tagCourtier(marshal, gpId, "Marshal", "marshal");
    host.push(marshal);
  }
  for (let i = 0; i < MARSHAL_ESCORT_SIZE; i++) {
    const legionary = spawnNpcAt(
      legionaryId, muster.x + i - 2, muster.y + 2, muster.z, 3
    );
    if (legionary) {
      Membership.tagCourtier(legionary, gpId, "Legionary", "legionary");
      host.push(legionary);
    }
  }
  if (host.length > 0) marshalHosts.set(id, host);
  console.info("[founding] marshal mustered", { kingdom: id, greatPower: gpId, host: host.length });
}

/** The vanguard reaches the claim when the first round resolves. */
function spawnVanguard(kingdom) {
  const id = kingdom.id;
  if (vanguards.has(id)) return;
  const claim = kingdom.flags?.[FLAG_CLAIM];
  const gpId = kingdom.flags?.[FLAG_GREAT_POWER];
  const legionaryId = NpcIdentifiers?.GUARD;
  if (!claim || !Number.isFinite(legionaryId)) return;
  const host = [];
  for (let i = 0; i < 3; i++) {
    const legionary = spawnNpcAt(
      legionaryId, claim.x + 2 + i, claim.y - 2, claim.z ?? 0, 2
    );
    if (legionary) {
      Membership.tagCourtier(legionary, gpId, "Legionary", "legionary");
      host.push(legionary);
    }
  }
  if (host.length > 0) vanguards.set(id, host);
}

function despawnAll(list) {
  for (const npc of list ?? []) {
    try {
      pluginApi.removeNpc(npc);
    } catch {
      // Already gone.
    }
  }
}

function standDown(kingdomId) {
  despawnAll(marshalHosts.get(kingdomId));
  marshalHosts.delete(kingdomId);
  despawnAll(vanguards.get(kingdomId));
  vanguards.delete(kingdomId);
}

// --- the response ---------------------------------------------------------

function seedClaimTension(kingdomId, greatPowerId, vsResponder, vsOther) {
  try {
    Store.setRawTension(kingdomId, greatPowerId, vsResponder);
    for (const id of GREAT_POWER_IDS) {
      if (id !== greatPowerId && Store.getKingdom(id)) {
        Store.setRawTension(kingdomId, id, vsOther);
      }
    }
  } catch {
    // Tension seeding is flavor, not load-bearing.
  }
}

function marchOn(kingdom) {
  const gpId = kingdom.flags[FLAG_GREAT_POWER];
  const gp = Store.getKingdom(gpId);
  const gpName = gp?.name ?? gpId;
  // The crown pays for its steel.
  const spent = Math.min(gp?.treasury ?? 0, CAMPAIGN_COST);
  if (spent > 0) Store.spendTax(gpId, spent);

  spawnMarshalHost(kingdom);

  const battleAt = Date.now() + MARCH_MS;
  Store.setFlag(kingdom.id, FLAG_WARNED, true);
  Store.setFlag(kingdom.id, FLAG_BATTLE_AT, battleAt);
  Store.setFlag(kingdom.id, FLAG_ROUND, 0);
  Store.setFlag(kingdom.id, FLAG_ROUND_AT, battleAt);
  // The pacification is a real war: it shows on the war table. The tension
  // model skips founding wars (declaredBy "founding") — this tick owns it.
  pluginApi.emitCustomEvent("kingdom:war-declared", {
    attackerId: gpId,
    defenderId: kingdom.id,
    declaredBy: "founding",
    reason: `Pacification of the upstart claim of ${kingdom.name}`,
    resolveAt: battleAt + (BATTLE_ROUNDS - 1) * ROUND_MS,
  });
  Store.save();

  announceToRealm(
    `[Realm] ${gpName} has declared the upstart claim of ${kingdom.name} illegitimate. ` +
      `Their marshal musters at ${gp?.capital ?? "the capital"} — ${fmtCoins(spent)} coins of war steel. ` +
      `The host marches. The gods watch, silent.`
  );
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: gpId,
    text: `The marshal's host is mustering — they mean to crush ${kingdom.name} before it takes root.`,
  });
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
  founder?.sendMessage?.(
    `[Found] THE MARSHAL MARCHES. Thirty minutes. Spend everything — the chest, the walls, your nerve.`
  );
  console.info("[founding] marshal marches", { kingdom: kingdom.id, greatPower: gpId, spent });
}

const ROUND_LINES = [
  null,
  (k, lost, burned) =>
    `[Realm] The marshal's vanguard hits ${k.name}'s palisade. ${lost} of the sworn fall; ` +
    `${fmtCoins(burned)} coins of supplies burn. The walls hold — for now.`,
  (k, lost, burned) =>
    `[Realm] The assault on ${k.name}. Ladders on the palisade, torches in the camp. ` +
    `${lost} more fall; ${fmtCoins(burned)} coins of the war chest go up in smoke.`,
];

function resolveBattleRound(kingdom) {
  const flags = kingdom.flags ?? {};
  const round = (flags[FLAG_ROUND] ?? 0) + 1;

  if (round >= BATTLE_ROUNDS) {
    resolveDecisive(kingdom);
    return;
  }

  // The battle bleeds: the fallen and the burned. The founder never falls
  // in the rounds — but if there are sworn to lose, the rounds take some.
  const followers = flags[FLAG_FOLLOWERS] ?? [];
  const sworn = followers.slice(1);
  const lost = Math.max(sworn.length > 0 ? 1 : 0, Math.floor(sworn.length * ROUND_FOLLOWER_LOSS));
  const kept = [followers[0], ...sworn.slice(lost)].filter(Boolean);
  const chest = flags[FLAG_WAR_CHEST] ?? 0;
  const burned = Math.floor(chest * ROUND_CHEST_BURN);
  Store.setFlag(kingdom.id, FLAG_FOLLOWERS, kept);
  Store.setFlag(kingdom.id, FLAG_WAR_CHEST, chest - burned);
  ledger(kingdom, "battle", `round ${round}: ${lost} fallen, ${fmtCoins(burned)} burned`, burned);
  Store.setFlag(kingdom.id, FLAG_ROUND, round);
  Store.setFlag(kingdom.id, FLAG_ROUND_AT, Date.now() + ROUND_MS);
  Store.save();

  if (round === 1) spawnVanguard(kingdom);
  announceToRealm(ROUND_LINES[round](kingdom, lost, burned));
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
  founder?.sendMessage?.(
    `[Found] Round ${round}: ${lost} sworn down, ${fmtCoins(burned)} of the chest burned. ` +
      `${kept.length - 1} still stand with you.`
  );
  console.info("[founding] battle round", { kingdom: kingdom.id, round, lost, burned });
}

function resolveDecisive(kingdom) {
  const gpId = kingdom.flags[FLAG_GREAT_POWER];
  const gp = Store.getKingdom(gpId);
  const gpName = gp?.name ?? gpId;
  const { strength, force, chance } = survivalOdds(kingdom);
  const survived = Math.random() < chance;

  if (survived) {
    resolveSurvived(kingdom, gpId, gpName, strength, force, chance);
  } else {
    resolveCrushed(kingdom, gpId, gpName, strength, force, chance);
  }
}

function endPacificationWar(gpId, kingdomId, outcome) {
  try {
    pluginApi.emitCustomEvent("kingdom:war-ended", {
      attackerId: gpId,
      defenderId: kingdomId,
      outcome,
    });
  } catch {
    // The war record is cosmetic next to the outcome.
  }
}

function resolveCrushed(kingdom, gpId, gpName, strength, force, chance) {
  // The chest is plunder; the dream is ash.
  const chest = kingdom.flags?.[FLAG_WAR_CHEST] ?? 0;
  if (chest > 0 && Store.getKingdom(gpId)) {
    Store.grantTax(gpId, chest);
    ledger(kingdom, "plunder", "the war chest, seized", chest);
  }
  const cost = costSummary(Store.getKingdom(kingdom.id) ?? kingdom);
  endPacificationWar(gpId, kingdom.id, `pacified — the claim of ${kingdom.name} is ash`);
  standDown(kingdom.id);
  announceToRealm(
    `[Realm] ${kingdom.name} has fallen. ${gpName}'s host broke their walls ` +
      `and scattered their followers. The attempt cost ${cost.text}. ` +
      `${kingdom.ruler} lives — barely. Let this be a lesson.`
  );
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: gpId,
    text: `They're still pulling bodies from the wreck of ${kingdom.name}. The ${gpName} marshal made an example of them.`,
  });
  // Dissolve: remove the kingdom record.
  try {
    const state = Store.load();
    delete state.kingdoms[kingdom.id];
    Store.save();
  } catch {
    // best-effort
  }
  console.info("[founding] fledgling crushed", {
    kingdom: kingdom.id,
    strength,
    force,
    winChance: chance.toFixed(4),
    cost: cost.total,
  });
}

function resolveSurvived(kingdom, gpId, gpName, strength, force, chance) {
  // A miracle. The kingdom stands — fragile, breathless, real.
  Store.setFlag(kingdom.id, FLAG_FLEDGLING, false);
  Store.setFlag(kingdom.id, FLAG_SURVIVED, true);
  Store.setFlag(kingdom.id, FLAG_LAST_UPKEEP, Date.now());
  seedClaimTension(kingdom.id, gpId, TENSION_SURVIVOR_VS_RESPONDER, TENSION_SURVIVOR_VS_OTHER);
  endPacificationWar(gpId, kingdom.id, "the upstart survived — the marshal withdrew");
  standDown(kingdom.id);
  Store.save();
  const cost = costSummary(Store.getKingdom(kingdom.id) ?? kingdom);
  announceToRealm(
    `[Realm] IMPOSSIBLE. ${kingdom.name} has held against ${gpName}'s host. ` +
      `The marshal withdraws — for now. The realm whispers the founder's name: ${kingdom.ruler}.`
  );
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
  founder?.sendMessage?.(
    `[Found] You stand. It cost ${cost.text}, and the crown will not forget. ` +
      `Your claim stake stands on as a banner post — tend it. ${fmtCoins(WEEKLY_UPKEEP)} coins of upkeep ` +
      `every week, from the coffers, or the banners come down.`
  );
  console.info("[founding] MIRACLE — fledgling survived", {
    kingdom: kingdom.id,
    strength,
    force,
    winChance: chance.toFixed(4),
    cost: cost.total,
  });
}

// --- the tick -------------------------------------------------------------

function tickContested(kingdom, flags, now) {
  let dirty = false;

  // 1. The fortification levy: 5M of timber and iron from the war chest.
  //    Retried every tick until paid; half-raised walls grant no strength.
  Castle.migrateWallsPaid(kingdom.id);
  if (flags[FLAG_WALLS_PAID] !== true && Castle.fortTier(kingdom.id) === 0) {
    const chest = flags[FLAG_WAR_CHEST] ?? 0;
    if (chest >= WALLS_COST) {
      Store.setFlag(kingdom.id, FLAG_WAR_CHEST, chest - WALLS_COST);
      Store.setFlag(kingdom.id, FLAG_WALLS_PAID, true);
      Castle.migrateWallsPaid(kingdom.id); // boolean -> fort tier 1
      ledger(kingdom, "walls", "the palisade: timber and iron", WALLS_COST);
      dirty = true;
      const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
      founder?.sendMessage?.(
        `[Found] The palisade rises — ${fmtCoins(WALLS_COST)} of timber and iron from the war chest. ` +
          `Your host stands behind real walls now.`
      );
      console.info("[founding] walls raised", { kingdom: kingdom.id });
    }
  }

  // 2. The camp eats: food and wages for every sworn mouth, from the chest.
  //    Mouths the chest cannot feed desert — earliest-sworn first.
  const followers = Store.getKingdom(kingdom.id)?.flags?.[FLAG_FOLLOWERS] ?? flags[FLAG_FOLLOWERS] ?? [];
  if (followers.length > 0) {
    const chest = Store.getKingdom(kingdom.id)?.flags?.[FLAG_WAR_CHEST] ?? flags[FLAG_WAR_CHEST] ?? 0;
    const affordable = Math.min(followers.length, Math.floor(chest / PER_MOUTH_PER_TICK));
    const kept = followers.slice(0, Math.max(affordable, 1)); // the founder never deserts
    const deserted = followers.slice(kept.length);
    const wages = kept.length * PER_MOUTH_PER_TICK;
    Store.setFlag(kingdom.id, FLAG_WAR_CHEST, Math.max(0, chest - wages));
    if (deserted.length > 0) {
      Store.setFlag(kingdom.id, FLAG_FOLLOWERS, kept);
      const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
      founder?.sendMessage?.(
        `[Found] Hungry bellies make for empty camps: ${deserted.join(", ")} ` +
          `desert${deserted.length === 1 ? "s" : ""} — the chest could not feed them.`
      );
      announceToRealm(
        `[Realm] Deserters straggle in from the wilds: ${kingdom.name}'s war chest runs dry.`
      );
      console.info("[founding] desertion", { kingdom: kingdom.id, deserted: deserted.length });
    }
    if (wages > 0) {
      ledger(kingdom, "wages", `food and wages for ${kept.length}`, wages);
    }
    dirty = true;
  }

  // 3. The response.
  const warned = (Store.getKingdom(kingdom.id)?.flags?.[FLAG_WARNED] ?? flags[FLAG_WARNED]) === true;
  if (!warned && now >= (flags[FLAG_RESPOND_AT] ?? Infinity)) {
    marchOn(Store.getKingdom(kingdom.id) ?? kingdom);
    return true;
  }
  if (warned) {
    const live = Store.getKingdom(kingdom.id) ?? kingdom;
    // Restart resilience: the host musters again if the world forgot it.
    if (!marshalHosts.has(kingdom.id) && Number.isFinite(NpcIdentifiers?.ARMY_COMMANDER)) {
      spawnMarshalHost(live);
    }
    const round = live.flags?.[FLAG_ROUND] ?? 0;
    if (round >= 1 && !vanguards.has(kingdom.id)) spawnVanguard(live);
    if (round < BATTLE_ROUNDS && now >= (live.flags?.[FLAG_ROUND_AT] ?? Infinity)) {
      resolveBattleRound(live);
      return true;
    }
  }
  return dirty;
}

function tickSurvivor(kingdom, flags, now) {
  // Weekly upkeep from the coffers, or the banners come down.
  const last = flags[FLAG_LAST_UPKEEP] ?? now;
  if (now - last <= UPKEEP_INTERVAL_MS) return false;
  const chest = flags[FLAG_WAR_CHEST] ?? 0;
  if (chest >= WEEKLY_UPKEEP) {
    Store.setFlag(kingdom.id, FLAG_WAR_CHEST, chest - WEEKLY_UPKEEP);
    Store.setFlag(kingdom.id, FLAG_LAST_UPKEEP, now);
    ledger(kingdom, "wages", "a week of upkeep: food, wages, repairs", WEEKLY_UPKEEP);
    const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
    founder?.sendMessage?.(
      `[Found] ${fmtCoins(WEEKLY_UPKEEP)} coins of upkeep leave ${kingdom.name}'s coffers. ` +
        `The banners hold another week.`
    );
    console.info("[founding] upkeep paid", { kingdom: kingdom.id });
    return true;
  }
  announceToRealm(
    `[Realm] ${kingdom.name} could not pay its upkeep. The banners come down. ${kingdom.ruler}'s kingdom is no more.`
  );
  try {
    const state = Store.load();
    delete state.kingdoms[kingdom.id];
    Store.save();
  } catch {
    // best-effort
  }
  console.info("[founding] minor power dissolved — upkeep unpaid", { kingdom: kingdom.id });
  return true;
}

function foundingTick() {
  try {
    let dirty = false;
    for (const kingdom of foundingKingdoms()) {
      const flags = kingdom.flags ?? {};
      if (flags[FLAG_FLEDGLING] === true) {
        if (tickContested(kingdom, flags, Date.now())) dirty = true;
      } else if (flags[FLAG_SURVIVED] === true) {
        if (tickSurvivor(kingdom, flags, Date.now())) dirty = true;
      }
    }
    if (dirty) Store.save();
  } catch (error) {
    console.warn("[founding] tick failed", error?.message ?? error);
  }
}

// --- the claim ------------------------------------------------------------

/** Charter a kingdom. Returns the kingdom id on success, null on failure
 *  (the player is always told why). The claim stake calls this directly —
 *  same costs, same timers, same violent response. */
function foundKingdom(player, args) {
  const name = args.join(" ").trim();
  if (!isRealPlayer(player)) return null;
  if (!name || name.length < 3 || name.length > 20 || !/^[A-Za-z ]+$/.test(name)) {
    player.sendMessage("[Found] Speak the name plainly: 3-20 letters and spaces.");
    return null;
  }
  if (ruledKingdom(player)) {
    player.sendMessage("[Found] You already lead a fledgling kingdom. Read its claim stake.");
    return null;
  }
  const pos = playerPos(player);
  if (!isUnclaimed(pos)) {
    player.sendMessage(
      "[Found] This land is claimed. Found your kingdom in unclaimed territory — " +
        "the wilds between the great powers. No one will give you land; take it."
    );
    return null;
  }
  if (coinsInInventory(player) < CHARTER_COST) {
    player.sendMessage(
      `[Found] A charter costs ${CHARTER_COST.toLocaleString()} coins. ` +
        `You carry ${coinsInInventory(player).toLocaleString()}.`
    );
    return null;
  }
  const id = slugify(name);
  if (Store.getKingdom(id)) {
    player.sendMessage("[Found] That name is taken. Choose another.");
    return null;
  }
  if (!takeCoins(player, CHARTER_COST)) {
    player.sendMessage("[Found] The coins slipped through your fingers. Try again.");
    return null;
  }

  const gpId = nearestGreatPower(pos);
  const now = Date.now();
  pluginApi.emitCustomEvent("kingdom:created", {
    kingdomId: id,
    name: name,
    capital: "a war-camp",
    ruler: player.getUsername(),
    rulerTitle: "Founder",
  });
  // Flags on the fresh record.
  Store.setFlag(id, FLAG_FLEDGLING, true);
  Store.setFlag(id, FLAG_FOUNDED_AT, now);
  Store.setFlag(
    id,
    FLAG_RESPOND_AT,
    now + RESPOND_MIN_MS + Math.random() * (RESPOND_MAX_MS - RESPOND_MIN_MS)
  );
  Store.setFlag(id, FLAG_WAR_CHEST, 0);
  Store.setFlag(id, FLAG_FOLLOWERS, [player.getUsername().toLowerCase()]);
  Store.setFlag(id, FLAG_GREAT_POWER, gpId);
  Store.setFlag(id, FLAG_CLAIM, { x: pos.x, y: pos.y, z: pos.z });
  ledger({ id }, "charter", "the charter itself — burned", CHARTER_COST);
  seedClaimTension(id, gpId, TENSION_CLAIM_VS_RESPONDER, TENSION_CLAIM_VS_OTHER);
  Store.save();

  const gpName = Store.getKingdom(gpId)?.name ?? gpId;
  player.sendMessage(`[Found] ${name} is claimed. Your charter is spent — 10,000,000 coins, gone.`);
  player.sendMessage(
    `[Found] Hear me well, Founder: ${gpName} will not suffer this. Their marshal ` +
      `WILL march — within a few hours. Swear followers at your claim stake, fill the war chest. ` +
      `Walls cost ${fmtCoins(WALLS_COST)}, and every sworn mouth eats ${fmtCoins(PER_MOUTH_PER_TICK)} ` +
      `in food and wages every few minutes. You can try. You will probably die.`
  );
  announceToRealm(
    `[Realm] A new banner rises in the wilds: ${name}, founded by ${player.getUsername()}. ` +
      `The crown of ${gpName} has marked the claim.`
  );
  console.info("[founding] kingdom chartered", { id, name, founder: player.getUsername(), gpId });
  return id;
}

function joinKingdom(player, args) {
  if (!isRealPlayer(player)) return;
  const name = args.join(" ").trim().toLowerCase();
  const kingdom = fledglingKingdoms().find((k) => k.name.toLowerCase() === name);
  if (!kingdom) {
    // Minor powers take the sworn too.
    const minor = foundingKingdoms().find(
      (k) => isSurvived(k) && k.name.toLowerCase() === name
    );
    if (!minor) {
      player.sendMessage("[Found] No fledgling kingdom by that name. The great powers are not recruiting.");
      return;
    }
    return swearTo(player, minor);
  }
  return swearTo(player, kingdom);
}

function swearTo(player, kingdom) {
  const followers = kingdom.flags?.[FLAG_FOLLOWERS] ?? [];
  const username = player.getUsername().toLowerCase();
  if (followers.includes(username)) {
    player.sendMessage(`[Found] You already march under ${kingdom.name}'s banner.`);
    return;
  }
  followers.push(username);
  Store.setFlag(kingdom.id, FLAG_FOLLOWERS, followers);
  Store.save();
  const perTick = PER_MOUTH_PER_TICK.toLocaleString();
  player.sendMessage(
    `[Found] You kneel and swear to ${kingdom.name}. ${kingdom.ruler} is your liege. ` +
      `Your mouth costs the war chest ${perTick} coins in food and wages every few minutes — ` +
      `if the chest runs dry, you will walk, like the others. When the marshal comes — ` +
      `and they will come — you stand the line.`
  );
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
  founder?.sendMessage?.(`[Found] ${player.getUsername()} has sworn to ${kingdom.name}. Your host grows — and eats.`);
}

function fillChest(player, args) {
  if (!isRealPlayer(player)) return;
  const kingdom = swornKingdom(player);
  if (!kingdom) {
    player.sendMessage("[Found] You belong to no fledgling kingdom. Find a claim stake and swear to its banner.");
    return;
  }
  return fillChestFor(player, kingdom, args);
}

function fillChestFor(player, kingdom, args) {
  const amount = Math.floor(Number(args[0]));
  if (!Number.isFinite(amount) || amount <= 0) {
    player.sendMessage("[Found] Name an amount of coins for the war chest.");
    return;
  }
  if (coinsInInventory(player) < amount) {
    player.sendMessage(`[Found] You carry ${coinsInInventory(player).toLocaleString()} coins.`);
    return;
  }
  if (!takeCoins(player, amount)) {
    player.sendMessage("[Found] The coins slipped through your fingers.");
    return;
  }
  const chest = (kingdom.flags?.[FLAG_WAR_CHEST] ?? 0) + amount;
  Store.setFlag(kingdom.id, FLAG_WAR_CHEST, chest);
  Store.save();
  const survived = isSurvived(kingdom);
  player.sendMessage(
    `[Found] ${amount.toLocaleString()} coins into ${kingdom.name}'s ${survived ? "coffers" : "war chest"}. ` +
      `Total: ${chest.toLocaleString()}. ` +
      (survived
        ? `The weekly upkeep is ${WEEKLY_UPKEEP.toLocaleString()} — keep the coffers fed.`
        : `Every coin is a stone in the wall — and a meal in a sworn belly.`)
  );
}

/**
 * Raid a claim's war chest (or a minor power's coffers) at the stake.
 * Ten percent, bounded, ten minutes between raids per claim. The founder
 * is warned; the realm hears a rumor.
 */
function raidClaim(player, kingdomId) {
  if (!isRealPlayer(player)) return;
  const kingdom = Store.getKingdom(kingdomId);
  if (!kingdom || !isFoundingKingdom(kingdom.id)) return;
  const username = player.getUsername().toLowerCase();
  const followers = kingdom.flags?.[FLAG_FOLLOWERS] ?? [];
  if ((kingdom.ruler ?? "").toLowerCase() === username || followers.includes(username)) {
    player.sendMessage("[Raid] You don't raid your own banner.");
    return;
  }
  const now = Date.now();
  if (now - (kingdom.flags?.[FLAG_RAIDED_AT] ?? 0) < RAID_COOLDOWN_MS) {
    player.sendMessage("[Raid] The camp is still on edge from the last raid. Come back later.");
    return;
  }
  const chest = kingdom.flags?.[FLAG_WAR_CHEST] ?? 0;
  if (chest < RAID_MIN) {
    player.sendMessage("[Raid] The chest is bare — nothing worth the risk.");
    return;
  }
  const take = Math.min(RAID_MAX, Math.max(RAID_MIN, Math.floor(chest * RAID_CHEST_SHARE)));
  if (!giveCoins(player, take)) {
    player.sendMessage("[Raid] Your hands are full — make room first.");
    return;
  }
  Store.setFlag(kingdom.id, FLAG_WAR_CHEST, chest - take);
  Store.setFlag(kingdom.id, FLAG_RAIDED_AT, now);
  ledger(kingdom, "raid", `raided by ${player.getUsername()}`, take);
  Store.save();
  player.sendMessage(
    `[Raid] You slip through the camp's edge and lift ${take.toLocaleString()} coins ` +
      `from ${kingdom.name}'s ${isSurvived(kingdom) ? "coffers" : "war chest"}. Run.`
  );
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
  founder?.sendMessage?.(
    `[Raid] Raiders hit ${kingdom.name} — ${take.toLocaleString()} coins gone from the chest.`
  );
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: kingdom.id,
    text: `Raiders lifted ${take.toLocaleString()} coins from ${kingdom.name}'s stores in the night.`,
  });
  console.info("[founding] raid", { kingdom: kingdom.id, raider: player.getUsername(), take });
}

function foundStatus(player) {
  if (!isRealPlayer(player)) return;
  const kingdom = swornKingdom(player);
  if (!kingdom) {
    player.sendMessage("[Found] You belong to no fledgling kingdom.");
    return;
  }
  for (const line of claimStatusLines(kingdom)) player.sendMessage(line);
}

/**
 * A founding kingdom's standing as plain lines — the ::found status
 * content, refactored for reuse. Claim stakes show these when read, so any
 * traveller can see how the claim fares against the coming marshal.
 */
function claimStatusLines(kingdom) {
  const flags = kingdom.flags ?? {};
  const followers = flags[FLAG_FOLLOWERS] ?? [];
  const chest = flags[FLAG_WAR_CHEST] ?? 0;
  const survived = isSurvived(kingdom);
  const cost = costSummary(kingdom);
  const lines = [
    `[Found] ${kingdom.name} — ruled by ${kingdom.ruler}`,
    `  Followers: ${followers.length} | War chest: ${chest.toLocaleString()} coins | ` +
      `Walls: ${flags[FLAG_WALLS_PAID] === true ? "raised" : "half-raised"}`,
    `  What it has cost: ${cost.text}`,
  ];
  if (survived) {
    const last = flags[FLAG_LAST_UPKEEP] ?? Date.now();
    const dueMs = Math.max(0, UPKEEP_INTERVAL_MS - (Date.now() - last));
    const dueDays = Math.floor(dueMs / (24 * 60 * 60 * 1000));
    const dueHours = Math.floor((dueMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    lines.push(
      `  It stands. A miracle. Upkeep ${WEEKLY_UPKEEP.toLocaleString()} coins weekly — ` +
        `due in ${dueDays}d ${dueHours}h.`
    );
  } else {
    lines.push(oddsLine(kingdom));
    if (flags[FLAG_WARNED]) {
      const round = flags[FLAG_ROUND] ?? 0;
      lines.push(`  THE MARSHAL MARCHES — the battle is joined (round ${Math.min(round + 1, BATTLE_ROUNDS)} of ${BATTLE_ROUNDS}). Steel yourself.`);
    } else {
      const mins = Math.max(0, Math.round(((flags[FLAG_RESPOND_AT] ?? 0) - Date.now()) / 60000));
      lines.push(`  The great powers have noticed. Expect steel within ~${mins} minutes.`);
    }
  }
  return lines;
}

/**
 * One line for the war table's realm listing: fledglings read as claims,
 * survivors as fragile minor powers — never as ordinary kingdoms.
 */
function foundingStatusLine(kingdom) {
  const flags = kingdom.flags ?? {};
  const followers = flags[FLAG_FOLLOWERS] ?? [];
  const chest = flags[FLAG_WAR_CHEST] ?? 0;
  if (isSurvived(kingdom)) {
    return (
      `${kingdom.name}: MINOR POWER, fragile — ${chest.toLocaleString()}c in the coffers, ` +
      `${WEEKLY_UPKEEP.toLocaleString()}c upkeep weekly`
    );
  }
  const warned = flags[FLAG_WARNED] === true;
  return (
    `${kingdom.name}: FLEDGLING CLAIM — ${followers.length} sworn, ` +
    `${chest.toLocaleString()}c in the war chest` +
    (warned ? " — THE MARSHAL MARCHES" : " — contested")
  );
}

/**
 * Fledgling kingdoms whose claim is still contested — not yet crushed by
 * the marshal, not yet standing as a recognized minor power. These are the
 * claims that need a stake standing in the wild earth.
 */
function contestedClaims() {
  return fledglingKingdoms().map((k) => ({
    id: k.id,
    name: k.name,
    claim: k.flags?.[FLAG_CLAIM] ?? null,
  }));
}

/** Minor powers that survived the marshal — their banner posts stand on. */
function survivedKingdoms() {
  return foundingKingdoms()
    .filter(isSurvived)
    .map((k) => ({ id: k.id, name: k.name, claim: k.flags?.[FLAG_CLAIM] ?? null }));
}

function abandonKingdom(player) {
  if (!isRealPlayer(player)) return;
  const kingdom = ruledKingdom(player);
  if (!kingdom) {
    player.sendMessage("[Found] You lead no fledgling kingdom.");
    return;
  }
  const flags = kingdom.flags ?? {};
  const chest = flags[FLAG_WAR_CHEST] ?? 0;
  // The founder walks away with what is left; what was spent is gone.
  if (chest > 0) giveCoins(player, chest);
  if (flags[FLAG_WARNED] === true) {
    endPacificationWar(flags[FLAG_GREAT_POWER], kingdom.id, "the founder lowered the banner");
    standDown(kingdom.id);
  }
  try {
    const state = Store.load();
    delete state.kingdoms[kingdom.id];
    Store.save();
  } catch {
    // best-effort
  }
  const cost = costSummary(kingdom);
  player.sendMessage(
    `[Found] You lower the banner of ${kingdom.name} yourself. ` +
      `${chest > 0 ? `${chest.toLocaleString()} coins of the chest come home with you. ` : ""}` +
      `The rest — ${cost.text} — is gone. Perhaps wisdom. Perhaps cowardice.`
  );
  announceToRealm(`[Realm] ${kingdom.name} is no more — its founder lowered the banner.`);
  console.info("[founding] abandoned", { kingdom: kingdom.id, refunded: chest });
}

// --- commands (dev only) --------------------------------------------------

function onFoundCommand({ player, parts }) {
  const sub = (parts[1] ?? "").toLowerCase();
  const args = parts.slice(2);
  if (sub === "join") return joinKingdom(player, args);
  if (sub === "chest") return fillChest(player, args);
  if (sub === "status") return foundStatus(player);
  if (sub === "abandon") return abandonKingdom(player);
  // Default: ::found <name> charters.
  if (!sub) {
    player.sendMessage("[Found] ::found <name> — charter a kingdom (10M, unclaimed land) [dev]");
    player.sendMessage("  ::found join <name> | ::found chest <amount> | ::found status | ::found abandon");
    return;
  }
  return foundKingdom(player, [parts[1], ...args]);
}

// --- wiring ---------------------------------------------------------------

function attachFounding(api) {
  pluginApi = api;
  Item = api.core.Item ?? null;
  NpcIdentifiers = api.core.NpcIdentifiers ?? null;
  api.registerCommand("found", onFoundCommand, api.core.PlayerRights.NONE);

  class FoundingTask extends Task {
    execute() {
      foundingTick();
    }
  }
  api.getTaskManager()?.submit(new FoundingTask(FOUNDING_TICK_TICKS));
  console.info("[founding] armed — you can try. You will probably die.");
}

module.exports = attachFounding;
module.exports.attachFounding = attachFounding;
module.exports.foundKingdom = foundKingdom;
module.exports.isUnclaimed = isUnclaimed;
module.exports.claimStatusLines = claimStatusLines;
module.exports.contestedClaims = contestedClaims;
module.exports.survivedKingdoms = survivedKingdoms;
module.exports.isFoundingKingdom = isFoundingKingdom;
module.exports.foundingStatusLine = foundingStatusLine;
module.exports.raidClaim = raidClaim;
// Diegetic exports for the claim stake (no-commands migration): the stake's
// menu drives these instead of ::found join / chest / abandon.
module.exports.joinKingdom = joinKingdom;
module.exports.fillChest = fillChest;
module.exports.abandonKingdom = abandonKingdom;
// Tuning exports for tests and the war table's honesty.
module.exports.TUNING = {
  CHARTER_COST,
  WALLS_COST,
  FORTIFICATION_STRENGTH,
  PER_MOUTH_PER_TICK,
  WEEKLY_UPKEEP,
  PACIFICATION_BASE,
  RESPONSE_MULTIPLIER,
};
// The core loop, exported for tests (cf. Store.resetForTests).
module.exports.foundingTick = foundingTick;
