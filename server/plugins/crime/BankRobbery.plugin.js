"use strict";

/**
 * BankRobbery.plugin — the crime endgame (Jon's bank-robbery design, 2026-10-07).
 *
 * Banks are the richest buildings in every city — and now they can be hit.
 * A crew with Thieving levels, a plan, and nerves cracks the vault, grabs
 * the gold, and runs before the guards close in. Highest-risk, highest-
 * reward Thieving content, and the #1 automatic bounty generator for the
 * bounty system (Bounties.Kingdoms — markWanted "bank-robbery").
 *
 * THE LOOP (all diegetic — no player ::commands):
 *   Case the bank  "Case-bank" on a Bank booth / Banker. Standing near the
 *                   bank builds intel (0-100, Thieving-scaled). Intel reveals
 *                   guard strength, alarm speed, and crack time.
 *   Tools          Lockpick (1523) starts the job. Forged vault orders
 *                   (Papyrus on booth while casing, 60 Thieving) buy +30s of
 *                   breach time. Smoke bombs (Coal on Tinderbox, 40 Herblore)
 *                   blind pursuing guards for 30s.
 *   Breach         Disable the alarm runes ("Disable-rune", Thieving rolls —
 *                   fail and the alarm trips early). Forged orders extend the
 *                   90s breach window.
 *   Crack          "Crack-vault": a channelled crack (stand still, 30-60s by
 *                   tier). Moving or taking damage restarts it.
 *   Loot           Gold spawns as ground coin piles — grab what you carry.
 *   Escape         The alarm sounds, guards converge and chase. Teleports are
 *                   sealed mid-heist. Outrun them (48+ tiles from the bank)
 *                   or outlast the chase timer. A caught robber is tackled:
 *                   loot confiscated (gold sink), 10 minutes in the bank's
 *                   strongroom (bribable via "Pay-bail", breakable with a
 *                   lockpick), and a bounty either way.
 *   Crew           Up to 3 accomplices join via "Join-heist" during breach/
 *                   crack. Equal cut, shared bounty. (Citizen crew with
 *                   loyalty is phase 2 — citizens join heists through the
 *                   citizen interaction layer, not this pass.)
 *
 * CONSEQUENCES:
 *   - Auto-bounty: 100k + 25% of take, kingdom-funded, on EVERY crew member
 *     (escaped or caught) via Bounties.markWanted(..., "bank-robbery", amount).
 *   - Notoriety: +3 per robbery (Suspect 1-4, Outlaw 5-9, Murderer 10+).
 *   - Heat: the hit kingdom's bank security rises for a week (+guards,
 *     shorter breach window). Cooldown: 48h per bank (vault visibly empty).
 *
 * TIERS are geographic: within 60 tiles of a capital = capital vault
 * (elite), within 250 = city bank, anything further out = village bank.
 * The hit kingdom is always the nearest capital's court.
 *
 * State: heists live in memory (they never survive a restart — a reboot
 * mid-heist disperses the crew); cooldowns, heat, and casing intel persist
 * in server/plugins/crime/data/bankrobbery.json. Jail terms and notoriety
 * are persisted player attributes.
 */

const fs = require("fs");
const path = require("path");

let api = null;
let core = null;

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

/** Mirrors the capital table in DonationChest.Kingdoms (kingdomAt). */
const CAPITALS = [
  { id: "asgarnia", x: 2964, y: 3378 },
  { id: "misthalin", x: 3165, y: 3485 },
  { id: "kandarin", x: 2660, y: 3290 },
  { id: "morytania", x: 3495, y: 3235 },
  { id: "keldagrim", x: 2855, y: 10200 },
];

const TIERS = {
  village: {
    label: "village bank",
    reqThief: 40,
    runeDifficulty: 50,
    runes: 1,
    guards: 2,
    guardNpc: "village",
    lootMin: 50000,
    lootMax: 150000,
    crackMs: 30000,
    chaseMs: 90000,
    alarm: "slow",
  },
  city: {
    label: "city bank",
    reqThief: 65,
    runeDifficulty: 70,
    runes: 2,
    guards: 4,
    guardNpc: "city",
    lootMin: 300000,
    lootMax: 800000,
    crackMs: 45000,
    chaseMs: 120000,
    alarm: "medium",
  },
  capital: {
    label: "capital vault",
    reqThief: 85,
    runeDifficulty: 90,
    runes: 3,
    guards: 6,
    guardNpc: "capital",
    lootMin: 1000000,
    lootMax: 3000000,
    crackMs: 60000,
    chaseMs: 150000,
    alarm: "fast",
  },
};

const TIER_ORDER = ["village", "city", "capital"];

const COINS_ID = 995; // ItemIdentifiers.COINS
const LOCKPICK_ID = 1523; // ItemIdentifiers.LOCKPICK
const SMOKE_BOMB_ID = 50009; // custom-items.json (smoke bomb)
const VAULT_ORDERS_ID = 50010; // custom-items.json (forged vault orders)
const PAPYRUS_ID = 970; // ItemIdentifiers.PAPYRUS
const COAL_ID = 453; // ItemIdentifiers.COAL
const TINDERBOX_ID = 590; // ItemIdentifiers.TINDERBOX

const BREACH_MS = 90000;
const ORDERS_BONUS_MS = 30000;
const ESCAPE_TILES = 48;
const JAIL_MS = 10 * 60 * 1000;
const BAIL_COST = 50000;
const COOLDOWN_MS = 48 * 3600 * 1000;
const HEAT_MS = 7 * 24 * 3600 * 1000;
const MAX_HEAT = 3;
const MAX_CREW = 4; // leader + 3 accomplices
const BOUNTY_BASE = 100000;
const BOUNTY_TAKE_SHARE = 0.25;

const JAILED_UNTIL_ATTR = "bank-robbery:jailed-until";
const CELL_X_ATTR = "bank-robbery:cell-x";
const CELL_Y_ATTR = "bank-robbery:cell-y";
const NOTORIETY_ATTR = "bank-robbery:notoriety";

// Guard NPC ids from the cache (NpcIdentifiers.GUARD_20/38/39); guardIdFor()
// re-resolves from core.NpcIdentifiers when the engine exposes them.
const GUARD_IDS = { village: 397, city: 398, capital: 399 }; // GUARD_20/38/39

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function nearestCapital(x, y) {
  let best = null;
  let bestD = Infinity;
  for (const c of CAPITALS) {
    const d = dist2(x, y, c.x, c.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return { capital: best, distance: bestD };
}

/** village / city / capital by distance to the nearest capital. */
function tierFor(x, y) {
  const { distance } = nearestCapital(x, y);
  if (distance <= 60) return "capital";
  if (distance <= 250) return "city";
  return "village";
}

function kingdomFor(x, y) {
  return nearestCapital(x, y).capital.id;
}

function bankKey(x, y) {
  return `${Math.round(x)}_${Math.round(y)}`;
}

/**
 * Thieving success chance: 15% floor, +3% per level above requirement,
 * capped at 95%.
 */
function thieveChance(level, difficulty) {
  const c = 0.15 + (level - difficulty) * 0.03;
  return Math.max(0.15, Math.min(0.95, c));
}

/** Auto-bounty for one robber: 100k + 25% of their take. */
function bountyFor(take) {
  return BOUNTY_BASE + Math.floor(Math.max(0, take) * BOUNTY_TAKE_SHARE);
}

function notorietyTitle(n) {
  if (n >= 10) return "Murderer";
  if (n >= 5) return "Outlaw";
  if (n >= 1) return "Suspect";
  return "Clean";
}

/** Effective heat level for a kingdom as of now (0 when expired). */
function heatLevelOf(data, kingdomId, now = Date.now()) {
  const h = data.heat?.[kingdomId];
  if (!h || now >= h.until) return 0;
  return Math.max(0, Math.min(MAX_HEAT, h.level | 0));
}

// ---------------------------------------------------------------------------
// Persistent world state (cooldowns, heat, casing intel)
// ---------------------------------------------------------------------------

const DATA_PATH = path.join(__dirname, "data", "bankrobbery.json");

function emptyData() {
  return { cooldowns: {}, heat: {}, intel: {} };
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyData();
    parsed.cooldowns = parsed.cooldowns ?? {};
    parsed.heat = parsed.heat ?? {};
    parsed.intel = parsed.intel ?? {};
    return parsed;
  } catch {
    return emptyData();
  }
}

let worldData = null;

function data() {
  if (!worldData) worldData = loadData();
  return worldData;
}

function saveData() {
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(worldData ?? emptyData()));
  } catch (err) {
    console.warn("[bankrobbery] failed to save world state:", err?.message ?? err);
  }
}

function intelKey(username, key) {
  return `${String(username).toLowerCase()}|${key}`;
}

function getIntel(username, key) {
  return data().intel[intelKey(username, key)] ?? 0;
}

function addIntel(username, key, amount) {
  const k = intelKey(username, key);
  const d = data();
  d.intel[k] = Math.min(100, (d.intel[k] ?? 0) + amount);
  saveData();
  return d.intel[k];
}

function applyHeat(kingdomId, now = Date.now()) {
  const d = data();
  const prev = d.heat[kingdomId];
  const level =
    prev && now < prev.until ? Math.min(MAX_HEAT, (prev.level | 0) + 1) : 1;
  d.heat[kingdomId] = { level, until: now + HEAT_MS };
  saveData();
  return level;
}

// ---------------------------------------------------------------------------
// Runtime helpers (need api/core — only called from handlers)
// ---------------------------------------------------------------------------

function usernameOf(player) {
  try {
    return player.getUsername?.() ?? player.username ?? null;
  } catch {
    return null;
  }
}

function normName(name) {
  return String(name ?? "").toLowerCase().trim();
}

function locOf(player) {
  try {
    const l = player.getLocation?.();
    return { x: l.getX(), y: l.getY(), z: l.getZ?.() ?? 0 };
  } catch {
    return { x: 0, y: 0, z: 0 };
  }
}

function thievingOf(player) {
  try {
    return player.getSkillManager().getCurrentLevel(core.Skill.THIEVING);
  } catch {
    return 1;
  }
}

function isBot(player) {
  return player?.isPlayerBot?.() === true;
}

function tell(player, msg) {
  try {
    player.sendMessage(msg);
  } catch {
    // A disconnected player is not our problem.
  }
}

function tellCrew(heist, msg, except = null) {
  for (const m of heist.crew) {
    if (except && normName(m.username) === normName(except)) continue;
    if (m.player) tell(m.player, msg);
  }
}

function getNotoriety(player) {
  try {
    return Number(player.getAttribute?.(NOTORIETY_ATTR) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function addNotoriety(player, amount) {
  const n = getNotoriety(player) + amount;
  try {
    player.setAttribute(NOTORIETY_ATTR, n);
  } catch {
    // Non-fatal.
  }
  return n;
}

function isJailed(player) {
  try {
    return Date.now() < Number(player.getAttribute?.(JAILED_UNTIL_ATTR) ?? 0);
  } catch {
    return false;
  }
}

// Active heists by bank key; and a reverse index by player name.
const heists = new Map();
const playerHeist = new Map();
const casings = new Map(); // username -> { bankKey, x, y, until }

function heistAt(bankKey) {
  const h = heists.get(bankKey);
  return h && h.phase !== "done" ? h : null;
}

function memberRecord(heist, username) {
  return heist.crew.find((m) => normName(m.username) === normName(username));
}

function postBounty(username, kingdomId, take) {
  try {
    const Bounties = require("../kingdoms/Bounties.Kingdoms");
    const Store = require("../kingdoms/KingdomStore");
    // Design: auto-bounty is 100k + 25% of the take, kingdom-funded.
    const rec = Bounties.markWanted(username, kingdomId, "bank-robbery", Store, bountyFor(take));
    return { ok: !!rec, amount: rec ? rec.amount : 0, funded: !!rec };
  } catch (err) {
    console.warn("[bankrobbery] bounty post failed:", err?.message ?? err);
    return { ok: false, amount: 0, funded: false };
  }
}

/** Guard NPC id for a tier, resolved from the cache identifiers (fall back to literals). */
function guardIdFor(tierKey) {
  try {
    const ids = core?.NpcIdentifiers;
    if (ids) {
      if (tierKey === "village" && ids.GUARD_20 != null) return ids.GUARD_20;
      if (tierKey === "capital" && ids.GUARD_39 != null) return ids.GUARD_39;
      if (ids.GUARD_38 != null) return ids.GUARD_38;
    }
  } catch {
    // Literals stand.
  }
  return GUARD_IDS[tierKey] ?? GUARD_IDS.city;
}

function spawnGuards(heist) {
  const tier = TIERS[heist.tier];
  const heat = heatLevelOf(data(), heist.kingdomId);
  const count = tier.guards + heat;
  const guardId = guardIdFor(tier.guardNpc);
  heist.guards = [];
  for (let i = 0; i < count; i++) {
    try {
      const gx = Math.round(heist.x + (i % 2 === 0 ? -3 : 3) + (i > 3 ? (i - 3) * 2 : 0));
      const gy = Math.round(heist.y + 4 + Math.floor(i / 2) * 2);
      const npc = api.spawnNpc({ id: guardId, x: gx, y: gy, z: 0, wanderRadius: 0 });
      if (npc) heist.guards.push(npc);
    } catch (err) {
      console.warn("[bankrobbery] guard spawn failed:", err?.message ?? err);
    }
  }
  return heist.guards.length;
}

function despawnGuards(heist) {
  for (const npc of heist.guards ?? []) {
    try {
      api.removeNpc(npc);
    } catch {
      // Already gone.
    }
  }
  heist.guards = [];
}

function guardTargets(heist) {
  return heist.crew.filter((m) => m.player).map((m) => ({ m, loc: locOf(m.player) }));
}

function nearestMember(heist, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const t of guardTargets(heist)) {
    const d = dist2(x, y, t.loc.x, t.loc.y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best ? { member: best.m, distance: Math.sqrt(bestD) } : null;
}

function npcLoc(npc) {
  try {
    const l = npc.getLocation();
    return { x: l.getX(), y: l.getY() };
  } catch {
    return null;
  }
}

function spawnLoot(heist) {
  const tier = TIERS[heist.tier];
  const total = tier.lootMin + Math.floor(Math.random() * (tier.lootMax - tier.lootMin));
  const piles = Math.max(2, heist.crew.length + 2);
  const manager = api.getItemOnGroundManager?.();
  heist.lootTotal = total;
  heist.lootItems = new Set();
  if (!manager) return total;
  let remaining = total;
  const leader = heist.crew[0]?.player;
  for (let i = 0; i < piles; i++) {
    const share =
      i === piles - 1 ? remaining : Math.floor(total / piles) + Math.floor(Math.random() * (total / piles / 2));
    remaining -= share;
    if (share <= 0) continue;
    try {
      const lx = Math.round(heist.x + (Math.random() * 10 - 5));
      const ly = Math.round(heist.y + (Math.random() * 10 - 5));
      const item = new core.Item(COINS_ID, share);
      const ground = manager.registerLocation(leader ?? heist.leaderPlayer, item, new core.Location(lx, ly, 0));
      if (ground) heist.lootItems.add(ground);
    } catch (err) {
      console.warn("[bankrobbery] loot spawn failed:", err?.message ?? err);
    }
  }
  return total;
}

function endHeist(heist, reason) {
  heist.phase = "done";
  despawnGuards(heist);
  for (const m of heist.crew) playerHeist.delete(normName(m.username));
  heists.delete(heist.bankKey);
  if (reason) tellCrew(heist, reason);
}

/** The aftermath every robber faces: bounty and notoriety per robber. */
function applyAftermath(heist, member, escaped) {
  const take = heist.take[normName(member.username)] ?? 0;
  const bounty = postBounty(member.username, heist.kingdomId, take);
  const notoriety = addNotoriety(member.player, 3);
  // Heat and the bank cooldown are per-heist, not per crew member — a full
  // crew must not quadruple the kingdom's alert level in one job.
  if (!heist.consequencesApplied) {
    heist.consequencesApplied = true;
    applyHeat(heist.kingdomId);
    data().cooldowns[heist.bankKey] = Date.now() + COOLDOWN_MS;
    saveData();
  }
  const title = notorietyTitle(notoriety);
  if (escaped) {
    tell(
      member.player,
      `You got away clean with ${take.toLocaleString()} coins. ` +
        (bounty.ok
          ? `But the ${heist.kingdomId} court posted a ${bounty.amount.toLocaleString()}-coin bounty on your head.`
          : `The ${heist.kingdomId} court's coffers are empty — no bounty this time, but they know your face.`) +
        ` Notoriety +3 (${title}).`
    );
  } else {
    tell(
      member.player,
      `Caught! The guards confiscate your ${take.toLocaleString()} coins and throw you in the strongroom. ` +
        (bounty.ok
          ? `A ${bounty.amount.toLocaleString()}-coin bounty is posted on you regardless.`
          : `No bounty — the court's coffers are empty.`) +
        ` Notoriety +3 (${title}).`
    );
  }
}

/** Tackle one crew member: confiscate, jail, bounty. */
function catchMember(heist, member) {
  const uname = normName(member.username);
  const take = heist.take[uname] ?? 0;
  // Confiscate the loot (gold sink): strip up to `take` coins from inventory.
  try {
    const inv = member.player.getInventory?.();
    const carried = inv?.getAmount?.(COINS_ID) ?? 0;
    const strip = Math.min(carried, take);
    if (strip > 0) inv.delete(COINS_ID, strip);
  } catch {
    // Confiscation is best-effort; the jail term still stands.
  }
  // Remove from the crew first so endHeist/aftermath bookkeeping is clean.
  heist.crew = heist.crew.filter((m) => normName(m.username) !== uname);
  playerHeist.delete(uname);
  applyAftermath(heist, member, false);
  // Jail: the bank's strongroom, 10 minutes. Bribable, breakable.
  try {
    const now = Date.now();
    member.player.setAttribute(JAILED_UNTIL_ATTR, now + JAIL_MS);
    member.player.setAttribute(CELL_X_ATTR, Math.round(heist.x));
    member.player.setAttribute(CELL_Y_ATTR, Math.round(heist.y));
    core.TeleportHandler.teleport(
      member.player,
      new core.Location(Math.round(heist.x), Math.round(heist.y), 0),
      core.TeleportType.NORMAL,
      false
    );
  } catch (err) {
    console.warn("[bankrobbery] jailing failed:", err?.message ?? err);
  }
  tellCrew(heist, `${member.username} was tackled by the guards!`);
  if (heist.crew.length === 0) endHeist(heist, "The heist collapses — the whole crew is in irons.");
}

function releaseFromJail(player, why) {
  try {
    player.setAttribute(JAILED_UNTIL_ATTR, 0);
  } catch {
    // Best effort.
  }
  tell(player, why ?? "Your sentence is served. The guards shove you out of the strongroom.");
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------

function boothLocation(event) {
  try {
    const obj = event.object;
    if (obj?.getLocation) {
      const l = obj.getLocation();
      return { x: l.getX(), y: l.getY(), z: l.getZ?.() ?? 0 };
    }
  } catch {
    // fall through
  }
  return locOf(event.player);
}

function guardIntelMessage(tierId, intel) {
  const tier = TIERS[tierId];
  const parts = [];
  parts.push(`Casing ${Math.round(intel)}% — this is a ${tier.label}.`);
  if (intel >= 25) parts.push(`Guard strength: ${tier.guards === 2 ? "light (a pair of sleepy guards)" : tier.guards === 4 ? "moderate (a full watch)" : "elite (the king's own guard)"}.`);
  if (intel >= 50) parts.push(`Alarm runes reset ${tier.alarm} — you will have to be quick.`);
  if (intel >= 75) parts.push(`The vault crack should take about ${Math.round(tier.crackMs / 1000)} seconds of uninterrupted work.`);
  if (intel >= 100) parts.push("You know every patrol route, every blind corner. This is as good as it gets.");
  return parts.join(" ");
}

/** "Case-bank" — begin (or continue) casing this bank. */
function caseBank(event) {
  const player = event.player;
  if (!player || isBot(player)) return;
  const username = usernameOf(player);
  if (!username) return;
  if (playerHeist.has(normName(username))) {
    tell(player, "You're mid-heist — no time for casing now.");
    return;
  }
  const { x, y } = boothLocation(event);
  const key = bankKey(x, y);
  const tierId = tierFor(x, y);
  const level = thievingOf(player);
  // Higher Thieving = faster casing: 60s at level 1 down to ~15s at 99.
  const casingMs = Math.max(15000, 60000 - level * 450);
  casings.set(normName(username), { bankKey: key, x, y, until: Date.now() + casingMs, player });
  tell(player, `You start casing the ${TIERS[tierId].label} — loiter near the bank for about ${Math.round(casingMs / 1000)} seconds.`);
}

/** Lockpick on Bank booth — start the heist (or break a crewmate out). */
function startHeist(event) {
  const player = event.player;
  if (!player || isBot(player)) return false;
  const username = usernameOf(player);
  if (!username) return false;
  const { x, y } = boothLocation(event);
  const key = bankKey(x, y);
  const tierId = tierFor(x, y);
  const tier = TIERS[tierId];
  const kingdomId = kingdomFor(x, y);
  const now = Date.now();

  // Jailbreak: a lockpick near an imprisoned player springs them instead.
  try {
    const world = api.getWorld?.();
    if (world) {
      for (const other of world.getPlayers()) {
        if (other === player || isBot(other)) continue;
        if (!isJailed(other)) continue;
        const o = locOf(other);
        if (dist2(x, y, o.x, o.y) > 12) continue;
        releaseFromJail(other, `${username} picks the strongroom lock — you're free!`);
        tell(player, `You spring ${usernameOf(other)} from the strongroom. The guards will hear of this.`);
        addNotoriety(player, 1);
        return true;
      }
    }
  } catch {
    // Fall through to the normal start path.
  }

  if (isJailed(player)) {
    tell(player, "You're behind bars. Use 'Pay-bail' on the booth — or hope a friend brings a lockpick.");
    return true;
  }
  if (playerHeist.has(normName(username))) {
    tell(player, "You're already on a job.");
    return true;
  }
  if (heistAt(key)) {
    tell(player, "Someone's already hitting this bank. Join them with 'Join-heist' — or wait your turn.");
    return true;
  }
  const cooledUntil = data().cooldowns[key] ?? 0;
  if (now < cooledUntil) {
    const hrs = Math.ceil((cooledUntil - now) / 3600000);
    tell(player, `The vault stands empty — it was cleaned out recently. Come back in about ${hrs} hours.`);
    return true;
  }
  const heat = heatLevelOf(data(), kingdomId, now);
  if (heat >= MAX_HEAT) {
    tell(player, `The ${kingdomId} banks are on maximum alert after the recent spree. Lay low for a while.`);
    return true;
  }
  const level = thievingOf(player);
  if (level < tier.reqThief) {
    tell(player, `This ${tier.label} needs ${tier.reqThief} Thieving to even attempt. You have ${level}.`);
    return true;
  }
  const inv = player.getInventory?.();
  if ((inv?.getAmount?.(LOCKPICK_ID) ?? 0) <= 0) {
    tell(player, "You need a lockpick for this.");
    return true;
  }
  const intel = getIntel(username, key);
  if (intel < 25) {
    tell(player, "You haven't cased this bank at all — this is suicide without intel. ('Case-bank' first.)");
    return true;
  }

  // Forged vault orders buy +30s of breach time.
  let breachMs = BREACH_MS - heat * 15000;
  if ((inv?.getAmount?.(VAULT_ORDERS_ID) ?? 0) > 0) {
    try {
      inv.delete(VAULT_ORDERS_ID, 1);
    } catch { /* best effort */ }
    breachMs += ORDERS_BONUS_MS;
    tell(player, "You palm the forged vault orders — the guards wave you through the first checkpoint. (+30s)");
  }

  const heist = {
    bankKey: key,
    x,
    y,
    tier: tierId,
    kingdomId,
    phase: "breach",
    leader: username,
    leaderPlayer: player,
    crew: [{ username, player }],
    runesLeft: tier.runes,
    crackEndsAt: 0,
    breachEndsAt: now + breachMs,
    guards: [],
    lootItems: new Set(),
    lootTotal: 0,
    take: {},
    alarmTripped: false,
    blindUntil: 0,
    escapeEndsAt: 0,
  };
  heists.set(key, heist);
  playerHeist.set(normName(username), heist);
  tell(
    player,
    `The lock turns. You're inside the ${tier.label}. ` +
      `Disable ${tier.runes} alarm rune${tier.runes > 1 ? "s" : ""} ('Disable-rune') before the breach window closes (~${Math.round(breachMs / 1000)}s).`
  );
  if (intel < 50) tell(player, "You wish you'd cased this place longer — you're working half-blind.");
  return true;
}

/** "Join-heist" — accomplices pile in during breach/crack. */
function joinHeist(event) {
  const player = event.player;
  if (!player || isBot(player)) return;
  const username = usernameOf(player);
  if (!username) return;
  if (isJailed(player)) {
    tell(player, "You're behind bars.");
    return;
  }
  if (playerHeist.has(normName(username))) {
    tell(player, "You're already on this job.");
    return;
  }
  const { x, y } = boothLocation(event);
  const key = bankKey(x, y);
  const heist = heistAt(key);
  if (!heist || (heist.phase !== "breach" && heist.phase !== "crack")) {
    tell(player, "No crew to join here right now.");
    return;
  }
  const p = locOf(player);
  if (dist2(x, y, p.x, p.y) > 20) {
    tell(player, "You're too far from the bank to join the crew.");
    return;
  }
  if (heist.crew.length >= MAX_CREW) {
    tell(player, "The crew is full — four's a crowd on a job like this.");
    return;
  }
  const tier = TIERS[heist.tier];
  if (thievingOf(player) < tier.reqThief - 15) {
    tell(player, `You'd only slow them down — you need at least ${tier.reqThief - 15} Thieving to keep up.`);
    return;
  }
  heist.crew.push({ username, player });
  playerHeist.set(normName(username), heist);
  tell(player, `You're in. The cut is split even — grab what you carry when the vault opens.`);
  tellCrew(heist, `${username} joins the crew.`, username);
}

/** "Disable-rune" — Thieving roll per alarm rune; fail = early alarm. */
function disableRune(event) {
  const player = event.player;
  if (!player || isBot(player)) return;
  const username = usernameOf(player);
  if (!username) return;
  const { x, y } = boothLocation(event);
  const heist = heistAt(bankKey(x, y));
  if (!heist || heist.phase !== "breach") return;
  if (!memberRecord(heist, username)) {
    tell(player, "That's the crew's business, not yours.");
    return;
  }
  const tier = TIERS[heist.tier];
  const level = thievingOf(player);
  const chance = thieveChance(level, tier.runeDifficulty);
  if (Math.random() < chance) {
    heist.runesLeft -= 1;
    if (heist.runesLeft <= 0) {
      heist.phase = "crack";
      tellCrew(heist, "The last alarm rune dies. The vault door is exposed — 'Crack-vault', quickly!");
    } else {
      tellCrew(heist, `One rune down — ${heist.runesLeft} to go.`);
    }
  } else {
    // The lockpick snaps on a fail (25%) and the alarm trips early.
    try {
      const inv = player.getInventory?.();
      if ((inv?.getAmount?.(LOCKPICK_ID) ?? 0) > 0 && Math.random() < 0.25) {
        inv.delete(LOCKPICK_ID, 1);
        tell(player, "Your lockpick snaps in the rune housing!");
      }
    } catch { /* best effort */ }
    tripAlarm(heist, "An alarm rune flares — the guards are coming! Finish the job anyway or run!");
  }
}

function tripAlarm(heist, message) {
  if (heist.alarmTripped) return;
  heist.alarmTripped = true;
  const n = spawnGuards(heist);
  tellCrew(heist, (message ?? "The alarm screams through the bank!") + ` ${n} guards converge on the building.`);
}

/** "Crack-vault" — start the channelled crack. */
function crackVault(event) {
  const player = event.player;
  if (!player || isBot(player)) return;
  const username = usernameOf(player);
  if (!username) return;
  const { x, y } = boothLocation(event);
  const heist = heistAt(bankKey(x, y));
  if (!heist || heist.phase !== "crack") return;
  if (!memberRecord(heist, username)) {
    tell(player, "That's the crew's business, not yours.");
    return;
  }
  if (heist.crackEndsAt > 0) {
    tell(player, "The crack is already underway — hold still and keep watch.");
    return;
  }
  const heat = heatLevelOf(data(), heist.kingdomId);
  const crackMs = Math.round(TIERS[heist.tier].crackMs * (1 + heat * 0.25));
  heist.crackEndsAt = Date.now() + crackMs;
  heist.crackX = x;
  heist.crackY = y;
  tellCrew(heist, `${username} starts on the vault — ${Math.round(crackMs / 1000)} seconds. Nobody move, nobody bleed.`);
}

function interruptCrack(player) {
  const username = usernameOf(player);
  if (!username) return;
  const heist = playerHeist.get(normName(username));
  if (!heist || heist.phase !== "crack" || !(heist.crackEndsAt > 0)) return;
  heist.crackEndsAt = 0;
  tellCrew(heist, "The crack is interrupted! Start over — 'Crack-vault'.");
}

/** Track heist loot pickups so the bounty reflects the real take. */
function trackLootPickup(event) {
  try {
    const player = event.player;
    // The engine's pickup event carries the ItemOnGround as `groundItem`
    // (the same object registerLocation returned into heist.lootItems).
    const ground = event.groundItem ?? event.item;
    if (!player || !ground) return;
    const username = usernameOf(player);
    if (!username) return;
    const heist = playerHeist.get(normName(username));
    if (!heist || !heist.lootItems?.has(ground)) return;
    heist.lootItems.delete(ground);
    let amount = 0;
    try {
      amount = ground.getItem?.()?.getAmount?.() ?? ground.getAmount?.() ?? 0;
    } catch {
      amount = 0;
    }
    const key = normName(username);
    heist.take[key] = (heist.take[key] ?? 0) + amount;
  } catch {
    // Pickup tracking never breaks a pickup.
  }
}

/** Smoke bomb "Use" — blinds every pursuing guard for 30s. */
function useSmokeBomb(event) {
  const player = event.player;
  if (!player || isBot(player)) return;
  const username = usernameOf(player);
  if (!username) return;
  const heist = playerHeist.get(normName(username));
  if (!heist || heist.phase !== "escape") {
    tell(player, "No point wasting a smoke bomb now.");
    return;
  }
  try {
    player.getInventory?.().delete(SMOKE_BOMB_ID, 1);
  } catch { /* best effort */ }
  heist.blindUntil = Date.now() + 30000;
  tellCrew(heist, `${username} hurls a smoke bomb — the guards lose the trail for 30 seconds!`);
}

/** Forged vault orders: Papyrus on Bank booth while casing (60 Thieving). */
function forgeOrders(event) {
  const player = event.player;
  if (!player || isBot(player)) return false;
  if (thievingOf(player) < 60) {
    tell(player, "You need 60 Thieving to forge convincing vault orders.");
    return true;
  }
  try {
    const inv = player.getInventory?.();
    if ((inv?.getAmount?.(PAPYRUS_ID) ?? 0) <= 0) return false;
    inv.delete(PAPYRUS_ID, 1);
    inv.add(new core.Item(VAULT_ORDERS_ID, 1), true);
    tell(player, "You forge a set of vault inspection orders. They'll buy you 30 seconds on the next job.");
  } catch {
    // best effort
  }
  return true;
}

/** Smoke bomb: Coal on Tinderbox (40 Herblore) — packed coal-dust bomb. */
function mixSmokeBomb(event) {
  const player = event.player;
  if (!player || isBot(player)) return false;
  let herblore = 1;
  try {
    herblore = player.getSkillManager().getCurrentLevel(core.Skill.HERBLORE);
  } catch {
    herblore = 1;
  }
  if (herblore < 40) {
    tell(player, "You need 40 Herblore to pack a smoke bomb that won't just fizzle.");
    return true;
  }
  try {
    const inv = player.getInventory?.();
    if ((inv?.getAmount?.(COAL_ID) ?? 0) <= 0) return false;
    inv.delete(COAL_ID, 1);
    inv.add(new core.Item(SMOKE_BOMB_ID, 1), true);
    tell(player, "You grind the coal to powder and pack it tight. (Smoke bomb)");
  } catch {
    // best effort
  }
  return true;
}

/** "Pay-bail" — bribe your way out of the strongroom. */
function payBail(event) {
  const player = event.player;
  if (!player || isBot(player)) return;
  if (!isJailed(player)) {
    tell(player, "You're not locked up. Yet.");
    return;
  }
  const { x, y } = boothLocation(event);
  const p = locOf(player);
  if (dist2(x, y, p.x, p.y) > 15) {
    tell(player, "You need to be at the bank to bribe the guards.");
    return;
  }
  const inv = player.getInventory?.();
  if ((inv?.getAmount?.(COINS_ID) ?? 0) < BAIL_COST) {
    tell(player, `Bail is ${BAIL_COST.toLocaleString()} coins. The guards laugh at your empty pockets.`);
    return;
  }
  try {
    inv.delete(COINS_ID, BAIL_COST);
  } catch { /* best effort */ }
  releaseFromJail(player, `You slide ${BAIL_COST.toLocaleString()} coins across the counter. The guards look the other way.`);
}

/** A guard died mid-heist — the watch sends a replacement, and remembers. */
function guardDown(event) {
  try {
    const npc = event.npc ?? event.entity;
    if (!npc) return;
    for (const heist of heists.values()) {
      const idx = (heist.guards ?? []).findIndex((g) => g === npc);
      if (idx < 0) continue;
      heist.guards.splice(idx, 1);
      tellCrew(heist, "A guard goes down — the watch will send another, and the court will remember this.");
      // Replacement guard arrives after 20s (if the heist is still hot).
      const key = heist.bankKey;
      setTimeout(() => {
        const h = heistAt(key);
        if (!h || h.phase === "done") return;
        try {
          const guardId = guardIdFor(TIERS[h.tier].guardNpc);
          const g = api.spawnNpc({ id: guardId, x: Math.round(h.x), y: Math.round(h.y) + 4, z: 0, wanderRadius: 0 });
          if (g) h.guards.push(g);
        } catch { /* best effort */ }
      }, 20000);
      // Killing a guard during a robbery: immediate notoriety.
      const killer = event.killer ?? event.player ?? null;
      if (killer && usernameOf(killer)) {
        const n = addNotoriety(killer, 1);
        tell(killer, `Notoriety +1 (${notorietyTitle(n)}). The court does not forget a dead guardsman.`);
      }
      return;
    }
  } catch {
    // Guard bookkeeping never breaks a kill.
  }
}

// ---------------------------------------------------------------------------
// The tick: casing progress, crack channel, guard chase, escape, jail
// ---------------------------------------------------------------------------

function processPlayer({ player }) {
  if (!player || isBot(player)) return;
  const username = usernameOf(player);
  if (!username) return;
  const uname = normName(username);
  const now = Date.now();
  const p = locOf(player);

  // --- jail: serve the sentence, clamped to the strongroom ---
  if (isJailed(player)) {
    const cx = Number(player.getAttribute?.(CELL_X_ATTR) ?? p.x);
    const cy = Number(player.getAttribute?.(CELL_Y_ATTR) ?? p.y);
    const until = Number(player.getAttribute?.(JAILED_UNTIL_ATTR) ?? 0);
    if (now >= until) {
      releaseFromJail(player);
    } else if (dist2(p.x, p.y, cx, cy) > 6) {
      try {
        core.TeleportHandler.teleport(player, new core.Location(cx, cy, 0), core.TeleportType.NORMAL, false);
        tell(player, "The guards drag you back to the strongroom.");
      } catch {
        // best effort
      }
    }
    return; // jailed players do nothing else
  }

  // --- casing: stand near the bank until the casing timer completes ---
  const casing = casings.get(uname);
  if (casing) {
    if (dist2(p.x, p.y, casing.x, casing.y) > 10) {
      casings.delete(uname);
      tell(player, "You lose your nerve and drift away — casing abandoned.");
    } else if (now >= casing.until) {
      casings.delete(uname);
      const intel = addIntel(username, casing.bankKey, 25);
      tell(player, guardIntelMessage(tierFor(casing.x, casing.y), intel));
    }
    // casing and heisting are mutually exclusive; fall through to heist below
  }

  // --- heist state machine ---
  const heist = playerHeist.get(uname);
  if (!heist || heist.phase === "done") return;
  if (!memberRecord(heist, username)) {
    playerHeist.delete(uname);
    return;
  }

  // Breach window expiry: the moment passes, the crew scatters.
  if (heist.phase === "breach" && now > heist.breachEndsAt) {
    tellCrew(heist, "The breach window closes — patrols change shift. The crew melts away.");
    endHeist(heist);
    return;
  }

  // Crack channel: stand still at the vault; moving restarts it.
  if (heist.phase === "crack" && heist.crackEndsAt > 0) {
    if (dist2(p.x, p.y, heist.crackX ?? heist.x, heist.crackY ?? heist.y) > 3) {
      interruptCrack(player);
    } else if (now >= heist.crackEndsAt) {
      heist.crackEndsAt = 0;
      heist.phase = "loot";
      const total = spawnLoot(heist);
      tripAlarm(heist, `The vault swings open — ${total.toLocaleString()} coins spill across the floor! Grab what you carry and RUN!`);
      heist.phase = "escape";
      heist.escapeEndsAt = now + TIERS[heist.tier].chaseMs;
    }
  }

  // Escape: guards chase the nearest crew member; catch = tackle.
  if (heist.phase === "escape") {
    const blinded = now < heist.blindUntil;
    // Guard movement (skip every other tick per guard to halve pathing churn).
    heist.guardTick = (heist.guardTick ?? 0) + 1;
    if (!blinded && heist.guardTick % 2 === 0) {
      for (const guard of heist.guards ?? []) {
        const gl = npcLoc(guard);
        if (!gl) continue;
        const near = nearestMember(heist, gl.x, gl.y);
        if (!near || !near.member.player) continue;
        const tl = locOf(near.member.player);
        try {
          guard.moveTo(new core.Location(tl.x, tl.y, 0));
        } catch {
          // A stuck guard is a lucky crew.
        }
      }
    }
    // Tackles.
    for (const guard of [...(heist.guards ?? [])]) {
      const gl = npcLoc(guard);
      if (!gl) continue;
      const near = nearestMember(heist, gl.x, gl.y);
      if (near && near.distance <= 1.5 && !blinded) {
        catchMember(heist, near.member);
        if (heist.phase === "done") return;
        break;
      }
    }
    // Escape conditions: everyone 48+ tiles out, or the chase timer expires.
    const crew = heist.crew.filter((m) => m.player);
    if (crew.length === 0) {
      endHeist(heist);
      return;
    }
    const allOut = crew.every((m) => {
      const l = locOf(m.player);
      return dist2(l.x, l.y, heist.x, heist.y) > ESCAPE_TILES;
    });
    if (allOut || now > heist.escapeEndsAt) {
      for (const m of [...heist.crew]) {
        const key = normName(m.username);
        playerHeist.delete(key);
        applyAftermath(heist, m, true);
      }
      endHeist(heist, allOut ? "The crew vanishes into the countryside — clean getaway!" : "The guards give up the chase. The crew got away!");
    }
  }
}

/** No teleporting out of a heist — the bank's wards seal shut. */
function onCanTeleport(event) {
  const player = event?.player;
  if (!player) return;
  const username = usernameOf(player);
  if (!username) return;
  if (playerHeist.has(normName(username))) {
    event.allow = false;
    tell(player, "The bank's wards seal shut around you — no teleporting out of a heist!");
  }
}

/** Logging out mid-heist abandons the crew slot (the job goes on). */
function onLogout(event) {
  try {
    const player = event?.player;
    const username = player ? usernameOf(player) : null;
    if (!username) return;
    const uname = normName(username);
    casings.delete(uname);
    const heist = playerHeist.get(uname);
    if (!heist) return;
    heist.crew = heist.crew.filter((m) => normName(m.username) !== uname);
    playerHeist.delete(uname);
    if (heist.crew.length === 0) {
      endHeist(heist);
    } else {
      tellCrew(heist, `${username} vanishes mid-job — the crew carries on without them.`);
    }
  } catch {
    // Logout bookkeeping never breaks a logout.
  }
}

/** Damage (dealt or taken) interrupts the vault crack. */
function onAttack(event) {
  try {
    const a = event?.player;
    const t = event?.target;
    if (a) interruptCrack(a);
    if (t && t !== a) interruptCrack(t);
  } catch {
    // never break combat
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function register(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;

  api.persistAttribute(JAILED_UNTIL_ATTR);
  api.persistAttribute(CELL_X_ATTR);
  api.persistAttribute(CELL_Y_ATTR);
  api.persistAttribute(NOTORIETY_ATTR);

  api.onObjectInteraction("Bank booth", {
    "Case-bank": caseBank,
    "Join-heist": joinHeist,
    "Disable-rune": disableRune,
    "Crack-vault": crackVault,
    "Pay-bail": payBail,
  });
  api.onNpcInteraction("Banker", { "Case-bank": caseBank });

  api.onItemOnObject("Lockpick", "Bank booth", startHeist);
  api.onItemOnObject("Papyrus", "Bank booth", forgeOrders);
  api.onItemOnItem("Coal", "Tinderbox", mixSmokeBomb);
  api.onItemAction("Smoke bomb", { Use: useSmokeBomb });

  api.onGroundItemPickup(trackLootPickup);
  api.onPlayerProcess(processPlayer);
  api.onCanTeleport(onCanTeleport);
  api.onPlayerLogout(onLogout);
  api.onPlayerAttack(onAttack);
  api.onNpcDeath(guardDown);

  console.info("[bankrobbery] vaults armed — casing, crews, and consequences live");
}

module.exports = { name: "BankRobbery", register };
module.exports.register = register;
module.exports._test = {
  tierFor,
  nearestCapital,
  kingdomFor,
  bankKey,
  thieveChance,
  bountyFor,
  notorietyTitle,
  heatLevelOf,
  applyHeat,
  dist2,
  TIERS,
  CAPITALS,
};
