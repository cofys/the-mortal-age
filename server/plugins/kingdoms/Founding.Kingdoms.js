"use strict";

/**
 * Founding.Kingdoms — "YOU CAN TRY. YOU WILL PROBABLY DIE."
 *
 * The player-kingdom founding flow. Jon's vision is explicit: a player MAY
 * attempt to found a kingdom, but the existing powers will react violently,
 * survival is unlikely, and the attempt consumes real resources — walls,
 * food, gear, wages, soldiers, supplies.
 *
 * The flow:
 *
 *   1. CHARTER (::found <name>)
 *      The founder stands in unclaimed land (outside all great-power
 *      territories) and pays 10,000,000 coins for a charter. The name must
 *      be unique, 3-20 chars, letters and spaces. The founder becomes ruler
 *      of a FLEDGLING kingdom — not a great power, a claim.
 *
 *   2. MUSTER (::found join <name>, ::found chest <amount>)
 *      The founder needs followers (real players) and a war chest. Followers
 *      join with ::found join. The founder (or followers) feed the war chest
 *      with ::found chest. Both feed the survival calculation.
 *
 *   3. THE RESPONSE
 *      The nearest great power does not recognize the claim. After a grace
 *      period (60-120 min), their marshal marches: a realm announcement,
 *      then 30 minutes later the pacification battle resolves.
 *
 *      Founder strength  = followers × 50 + warChest/10_000 + founderCombat × 2
 *      Pacification force = 2000 + greatPowerTreasury/100_000
 *      Win chance = strength / (strength + force) — deliberately tiny.
 *      A lone founder with an empty chest faces ~0.5%. A hundred followers
 *      and a fat war chest might reach 5%. The math is the message.
 *
 *   4. OUTCOMES
 *      Crushed (the likely): the kingdom dissolves. The charter and chest
 *        are forfeit. The realm is told. The great power's treasury grows
 *        by the seized chest (plunder).
 *      Survived (the miracle): the kingdom persists as a MINOR power. Weekly
 *        upkeep of 500,000 coins or it dissolves. No offices, no sim-tick
 *        benefits — a fragile thing, holding its breath.
 *
 * State: fledgling kingdoms live in KingdomStore with flags:
 *   founding:fledgling   true
 *   founding:founded-at   timestamp
 *   founding:respond-at   when the marshal marches
 *   founding:battle-at    when the battle resolves
 *   founding:war-chest    coins committed
 *   founding:followers    [usernames]
 *   founding:great-power  the responding kingdom id
 *   founding:warned       march announcement sent
 *
 * Out (custom events):
 *   kingdom:created { kingdomId, name, capital, ruler, rulerTitle }
 *   kingdom:war-declared { attackerId, defenderId, declaredBy: "founding", ... }
 *   kingdom:rumor { kingdomId, text }
 *
 * Commands (player):
 *   ::found <name>          charter a new kingdom (10M, unclaimed land)
 *   ::found join <name>     join a fledgling kingdom as follower
 *   ::found chest <amount>  add coins to the war chest
 *   ::found status          your kingdom's standing
 *   ::found abandon         dissolve your fledgling kingdom
 */

const Store = require("./KingdomStore");
const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");

// --- tuning ---------------------------------------------------------------

const CHARTER_COST = 10_000_000;
const WEEKLY_UPKEEP = 500_000;
const UPKEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const FOLLOWER_STRENGTH = 50;
const CHEST_STRENGTH_PER_10K = 1;
const COMBAT_STRENGTH_PER_LEVEL = 2;
const PACIFICATION_BASE = 2000;

// Grace before the marshal marches: 60-120 minutes.
const RESPOND_MIN_MS = 60 * 60 * 1000;
const RESPOND_MAX_MS = 120 * 60 * 1000;
// The march itself: 30 minutes of dread.
const MARCH_MS = 30 * 60 * 1000;

// Founding task ticks every ~5 minutes (600ms/tick).
const FOUNDING_TICK_TICKS = 500;

const FLAG_FLEDGLING = "founding:fledgling";
const FLAG_FOUNDED_AT = "founding:founded-at";
const FLAG_RESPOND_AT = "founding:respond-at";
const FLAG_BATTLE_AT = "founding:battle-at";
const FLAG_WAR_CHEST = "founding:war-chest";
const FLAG_FOLLOWERS = "founding:followers";
const FLAG_GREAT_POWER = "founding:great-power";
const FLAG_WARNED = "founding:warned";
const FLAG_LAST_UPKEEP = "founding:last-upkeep";

let pluginApi = null;

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

function fledglingKingdoms() {
  try {
    return Object.values(Store.load().kingdoms ?? {}).filter(
      (k) => k?.flags?.[FLAG_FLEDGLING] === true
    );
  } catch {
    return [];
  }
}

function playerFledgling(player) {
  const username = player?.getUsername?.()?.toLowerCase?.();
  if (!username) return null;
  return (
    fledglingKingdoms().find(
      (k) => k.ruler?.toLowerCase?.() === username
    ) ?? null
  );
}

function nearestGreatPower(pos) {
  // Capitals of the great powers; nearest by distance.
  const capitals = [
    { id: "asgarnia", x: 2964, y: 3378 },
    { id: "misthalin", x: 3165, y: 3485 },
    { id: "kandarin", x: 2660, y: 3290 },
    { id: "morytania", x: 3495, y: 3235 },
    { id: "keldagrim", x: 2855, y: 10200 },
  ];
  let best = capitals[0];
  let bestD = Infinity;
  for (const c of capitals) {
    const d = Math.hypot(c.x - pos.x, c.y - pos.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best.id;
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

// --- the response ---------------------------------------------------------

function founderStrength(kingdom) {
  const followers = kingdom.flags?.[FLAG_FOLLOWERS] ?? [];
  const chest = kingdom.flags?.[FLAG_WAR_CHEST] ?? 0;
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
  const combat = founder ? combatLevel(founder) : 3;
  // Followers who are offline still count — they swore the oath.
  return (
    followers.length * FOLLOWER_STRENGTH +
    Math.floor(chest / 10_000) * CHEST_STRENGTH_PER_10K +
    combat * COMBAT_STRENGTH_PER_LEVEL
  );
}

function pacificationForce(greatPowerId) {
  const gp = Store.getKingdom(greatPowerId);
  const treasury = gp?.treasury ?? 0;
  return PACIFICATION_BASE + Math.floor(treasury / 100_000);
}

function marchOn(kingdom) {
  const gpId = kingdom.flags[FLAG_GREAT_POWER];
  const gp = Store.getKingdom(gpId);
  const gpName = gp?.name ?? gpId;
  Store.setFlag(kingdom.id, FLAG_WARNED, true);
  Store.setFlag(kingdom.id, FLAG_BATTLE_AT, Date.now() + MARCH_MS);
  Store.save();
  announceToRealm(
    `[Realm] ${gpName} has declared the upstart kingdom of ${kingdom.name} illegitimate. ` +
      `Their marshal marches. The gods watch, silent.`
  );
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: gpId,
    text: `The marshal's host is mustering — they mean to crush ${kingdom.name} before it takes root.`,
  });
  console.info("[founding] marshal marches", { kingdom: kingdom.id, greatPower: gpId });
}

function resolveBattle(kingdom) {
  const gpId = kingdom.flags[FLAG_GREAT_POWER];
  const gp = Store.getKingdom(gpId);
  const gpName = gp?.name ?? gpId;
  const strength = founderStrength(kingdom);
  const force = pacificationForce(gpId);
  // The math is the message: survival is a miracle.
  const winChance = strength / (strength + force);
  const survived = Math.random() < winChance;

  if (survived) {
    // A miracle. The kingdom stands — fragile, breathless, real.
    Store.setFlag(kingdom.id, FLAG_FLEDGLING, false);
    Store.setFlag(kingdom.id, "founding:survived", true);
    Store.setFlag(kingdom.id, FLAG_LAST_UPKEEP, Date.now());
    Store.save();
    announceToRealm(
      `[Realm] IMPOSSIBLE. ${kingdom.name} has held against ${gpName}'s host. ` +
        `The marshal withdraws — for now. The realm whispers the founder's name: ${kingdom.ruler}.`
    );
    console.info("[founding] MIRACLE — fledgling survived", {
      kingdom: kingdom.id,
      strength,
      force,
      winChance: winChance.toFixed(4),
    });
    return;
  }

  // Crushed. The chest is plunder; the dream is ash.
  const chest = kingdom.flags?.[FLAG_WAR_CHEST] ?? 0;
  if (chest > 0 && gp) {
    Store.grantTax(gpId, chest);
  }
  announceToRealm(
    `[Realm] ${kingdom.name} has fallen. ${gpName}'s host broke their walls ` +
      `and scattered their followers. ${kingdom.ruler} lives — barely. Let this be a lesson.`
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
    winChance: winChance.toFixed(4),
  });
}

function foundingTick() {
  try {
    const now = Date.now();
    for (const kingdom of fledglingKingdoms()) {
      const flags = kingdom.flags ?? {};
      // Upkeep for survivors.
      if (flags["founding:survived"] === true) {
        const last = flags[FLAG_LAST_UPKEEP] ?? now;
        if (now - last > UPKEEP_INTERVAL_MS) {
          // Upkeep is collected via ::found chest; without it, the dream dies.
          const chest = flags[FLAG_WAR_CHEST] ?? 0;
          if (chest >= WEEKLY_UPKEEP) {
            Store.setFlag(kingdom.id, FLAG_WAR_CHEST, chest - WEEKLY_UPKEEP);
            Store.setFlag(kingdom.id, FLAG_LAST_UPKEEP, now);
            Store.save();
          } else {
            announceToRealm(
              `[Realm] ${kingdom.name} could not pay its upkeep. The banners come down. ${kingdom.ruler}'s kingdom is no more.`
            );
            const state = Store.load();
            delete state.kingdoms[kingdom.id];
            Store.save();
          }
        }
        continue;
      }
      // The response.
      if (!flags[FLAG_WARNED] && now >= (flags[FLAG_RESPOND_AT] ?? Infinity)) {
        marchOn(kingdom);
      } else if (flags[FLAG_WARNED] && now >= (flags[FLAG_BATTLE_AT] ?? Infinity)) {
        resolveBattle(kingdom);
      }
    }
  } catch (error) {
    console.warn("[founding] tick failed", error?.message ?? error);
  }
}

// --- commands -------------------------------------------------------------

function foundKingdom(player, args) {
  const name = args.join(" ").trim();
  if (!isRealPlayer(player)) return;
  if (!name || name.length < 3 || name.length > 20 || !/^[A-Za-z ]+$/.test(name)) {
    player.sendMessage("[Found] Name your kingdom: 3-20 letters and spaces. ::found <name>");
    return;
  }
  if (playerFledgling(player)) {
    player.sendMessage("[Found] You already lead a fledgling kingdom. See ::found status");
    return;
  }
  const pos = playerPos(player);
  if (!isUnclaimed(pos)) {
    player.sendMessage(
      "[Found] This land is claimed. Found your kingdom in unclaimed territory — " +
        "the wilds between the great powers. No one will give you land; take it."
    );
    return;
  }
  if (coinsInInventory(player) < CHARTER_COST) {
    player.sendMessage(
      `[Found] A charter costs ${CHARTER_COST.toLocaleString()} coins. ` +
        `You carry ${coinsInInventory(player).toLocaleString()}.`
    );
    return;
  }
  const id = slugify(name);
  if (Store.getKingdom(id)) {
    player.sendMessage("[Found] That name is taken. Choose another.");
    return;
  }
  if (!takeCoins(player, CHARTER_COST)) {
    player.sendMessage("[Found] The coins slipped through your fingers. Try again.");
    return;
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
  Store.setFlag(id, "founding:claim", { x: pos.x, y: pos.y, z: pos.z });
  Store.save();

  const gpName = Store.getKingdom(gpId)?.name ?? gpId;
  player.sendMessage(
    `[Found] ${name} is claimed. Your charter is spent — 10,000,000 coins, gone.`
  );
  player.sendMessage(
    `[Found] Hear me well, Founder: ${gpName} will not suffer this. ` +
      `Their marshal WILL march. Muster followers (::found join ${name}), ` +
      `fill your war chest (::found chest <amount>). You can try. You will probably die.`
  );
  announceToRealm(
    `[Realm] A new banner rises in the wilds: ${name}, founded by ${player.getUsername()}. ` +
      `The great powers have taken notice.`
  );
  console.info("[founding] kingdom chartered", { id, name, founder: player.getUsername(), gpId });
}

function joinKingdom(player, args) {
  if (!isRealPlayer(player)) return;
  const name = args.join(" ").trim().toLowerCase();
  const kingdom = fledglingKingdoms().find((k) => k.name.toLowerCase() === name);
  if (!kingdom) {
    player.sendMessage("[Found] No fledgling kingdom by that name. The great powers are not recruiting.");
    return;
  }
  const followers = kingdom.flags?.[FLAG_FOLLOWERS] ?? [];
  const username = player.getUsername().toLowerCase();
  if (followers.includes(username)) {
    player.sendMessage(`[Found] You already march under ${kingdom.name}'s banner.`);
    return;
  }
  followers.push(username);
  Store.setFlag(kingdom.id, FLAG_FOLLOWERS, followers);
  Store.save();
  player.sendMessage(
    `[Found] You kneel and swear to ${kingdom.name}. ${kingdom.ruler} is your liege. ` +
      `When the marshal comes — and they will come — you stand the line.`
  );
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom.ruler);
  founder?.sendMessage?.(`[Found] ${player.getUsername()} has sworn to ${kingdom.name}. Your host grows.`);
}

function fillChest(player, args) {
  if (!isRealPlayer(player)) return;
  const kingdom = playerFledgling(player);
  if (!kingdom) {
    // Followers can also contribute.
    const username = player.getUsername().toLowerCase();
    const joined = fledglingKingdoms().find((k) =>
      (k.flags?.[FLAG_FOLLOWERS] ?? []).includes(username)
    );
    if (!joined) {
      player.sendMessage("[Found] You belong to no fledgling kingdom. ::found join <name>");
      return;
    }
    return fillChestFor(player, joined, args);
  }
  return fillChestFor(player, kingdom, args);
}

function fillChestFor(player, kingdom, args) {
  const amount = Math.floor(Number(args[0]));
  if (!Number.isFinite(amount) || amount <= 0) {
    player.sendMessage("[Found] ::found chest <amount> — coins for the war chest.");
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
  player.sendMessage(
    `[Found] ${amount.toLocaleString()} coins into ${kingdom.name}'s war chest. ` +
      `Total: ${chest.toLocaleString()}. Every coin is a stone in the wall.`
  );
}

function foundStatus(player) {
  if (!isRealPlayer(player)) return;
  const username = player.getUsername().toLowerCase();
  const kingdom =
    playerFledgling(player) ??
    fledglingKingdoms().find((k) => (k.flags?.[FLAG_FOLLOWERS] ?? []).includes(username));
  if (!kingdom) {
    player.sendMessage("[Found] You belong to no fledgling kingdom.");
    return;
  }
  const flags = kingdom.flags ?? {};
  const followers = flags[FLAG_FOLLOWERS] ?? [];
  const chest = flags[FLAG_WAR_CHEST] ?? 0;
  const survived = flags["founding:survived"] === true;
  player.sendMessage(`[Found] ${kingdom.name} — ruled by ${kingdom.ruler}`);
  player.sendMessage(`  Followers: ${followers.length} | War chest: ${chest.toLocaleString()} coins`);
  if (survived) {
    player.sendMessage(`  It stands. A miracle. Weekly upkeep: ${WEEKLY_UPKEEP.toLocaleString()} coins.`);
  } else if (flags[FLAG_WARNED]) {
    player.sendMessage(`  THE MARSHAL MARCHES. Steel yourself.`);
  } else {
    const mins = Math.max(0, Math.round(((flags[FLAG_RESPOND_AT] ?? 0) - Date.now()) / 60000));
    player.sendMessage(`  The great powers have noticed. Expect steel within ~${mins} minutes.`);
  }
}

function abandonKingdom(player) {
  if (!isRealPlayer(player)) return;
  const kingdom = playerFledgling(player);
  if (!kingdom) {
    player.sendMessage("[Found] You lead no fledgling kingdom.");
    return;
  }
  try {
    const state = Store.load();
    delete state.kingdoms[kingdom.id];
    Store.save();
  } catch {
    // best-effort
  }
  player.sendMessage(`[Found] You lower the banner of ${kingdom.name} yourself. Perhaps wisdom. Perhaps cowardice.`);
  announceToRealm(`[Realm] ${kingdom.name} is no more — its founder lowered the banner.`);
}

function onFoundCommand({ player, parts }) {
  const sub = (parts[1] ?? "").toLowerCase();
  const args = parts.slice(2);
  if (sub === "join") return joinKingdom(player, args);
  if (sub === "chest") return fillChest(player, args);
  if (sub === "status") return foundStatus(player);
  if (sub === "abandon") return abandonKingdom(player);
  // Default: ::found <name> charters.
  if (!sub) {
    player.sendMessage("[Found] ::found <name> — charter a kingdom (10M, unclaimed land)");
    player.sendMessage("  ::found join <name> | ::found chest <amount> | ::found status | ::found abandon");
    return;
  }
  return foundKingdom(player, [parts[1], ...args]);
}

// --- wiring ---------------------------------------------------------------

function attachFounding(api) {
  pluginApi = api;
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
