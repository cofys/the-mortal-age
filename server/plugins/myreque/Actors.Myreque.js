"use strict";

/**
 * Actors.Myreque — the people and objects of the reputation track.
 *
 * Spawned on startup (api.onServerStartup), all diegetic — no ::commands:
 *
 *   Tithe-Officer Sarev  "Man" (385) at Canifis (3496, 3472) — Drakan's side.
 *     Talk-to: pay the blood tithe (-25, 1k coins), inform on the Hollow
 *     (-120, 1k coins, needs the quest), claim the courier bounty (-80,
 *     1.5k coins), "How do I stand with the regime?", tithe brand token.
 *   The fence           "Man" (385) in the Mort Myre (3502, 3438) — Myreque.
 *     Talk-to (needs the quest): smuggling pointers, courier runs (sealed
 *     note to Polmafi, +60), black-market trade (discount garlic/stakes,
 *     premium blood runes), "How do I stand with the Hollow?", the worn
 *     silver sickle token.
 *   The courier         "Man" (385) wandering the swamp road — the regime's
 *     bounty target. Kill him (-60) and report to Sarev. Flees Oathbound
 *     players on sight.
 *   Supply caches       2x Crate (1) by the old tunnel — smuggle bread /
 *     swamp paste / planks (+40 each, cooldown).
 *   Tithe records       Closed chest (103) by Sarev — burn them (+120,
 *     needs a tinderbox, 2h world cooldown, Sarev accuses).
 *
 * Plus, from this side (no SunkenHollow edit needed — hooks run first):
 *   "Polmafi Ferdygris"/"Talk-to": Drakan-locked players are refused;
 *     carrying-word players deliver the fence's note (+60).
 *   "Tunnel"/"Enter" at the hollow mouth: Oathbound players are refused.
 *   "Worn silver sickle"/Read and "Tithe brand"/Read: the diegetic
 *     standing readout.
 *
 * In (custom events): none. Out: myreque standing changes via Reputation.
 */

const Rep = require("./Reputation.Myreque");
const Store = require("../kingdoms/KingdomStore");

let api = null;
let core = null;

// --- item ids (cache) ---------------------------------------------------------
// Custom tokens (data/definitions/custom-items.json):
const SICKLE_TOKEN = 50001; // Worn silver sickle
const BRAND_TOKEN = 50002; // Tithe brand

// --- positions ------------------------------------------------------------------

const OFFICER_POS = { x: 3496, y: 3472, z: 0 };
const TITHE_CHEST_POS = { x: 3498, y: 3470, z: 0 };
const FENCE_POS = { x: 3502, y: 3438, z: 0 };
const CACHE_POS = [
  { x: 3504, y: 3436, z: 0 },
  { x: 3511, y: 3443, z: 0 },
];
const COURIER_HOME = { x: 3505, y: 3431, z: 0 };
const HOLLOW_TUNNEL_POS = { x: 3508, y: 3440, z: 0 }; // SunkenHollow's ENTRY_TUNNEL

const NPC_SCOPE = 2; // tiles around a spawn that count as "our" NPC
const OBJ_SCOPE = 2;

// --- tuning ---------------------------------------------------------------------

const TITHE_COST = 1000;
const TITHE_COOLDOWN_MS = 10 * 60 * 1000;
const TITHE_STANDING = -25;
const PRE_QUEST_TITHE_FLOOR = -199; // the tithe is just taxes until you know better

const INFORM_COOLDOWN_MS = 30 * 60 * 1000;
const INFORM_STANDING = -120;
const INFORM_PAY = 1000;
const DEFECT_STANDING = -150;
const DEFECT_PAY = 1200;

const BOUNTY_PAY = 1500;
const BOUNTY_STANDING = -80;
const BOUNTY_WINDOW_MS = 30 * 60 * 1000;

const COURIER_KILL_STANDING = -60;
const COURIER_RESPAWN_MS = 20 * 60 * 1000;

const SMUGGLE_COOLDOWN_MS = 10 * 60 * 1000;
const SMUGGLE_STANDING = 40;

const WORD_COOLDOWN_MS = 15 * 60 * 1000;
const WORD_STANDING = 60;

const BURN_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const BURN_STANDING = 120;

// --- state ------------------------------------------------------------------------

let officerNpc = null;
let fenceNpc = null;
let courierNpc = null;
let courierRespawnAt = 0;

// --- small helpers ------------------------------------------------------------------

function isRealPlayer(p) {
  return Rep.isRealPlayer(p);
}

function near(loc, pos, radius) {
  if (!loc) return false;
  const x = loc.getX?.() ?? loc.x ?? 0;
  const y = loc.getY?.() ?? loc.y ?? 0;
  const z = loc.getZ?.() ?? loc.z ?? 0;
  return Math.abs(x - pos.x) <= radius && Math.abs(y - pos.y) <= radius && z === pos.z;
}

function npcLoc(npc) {
  try {
    return npc?.getLocation?.() ?? null;
  } catch {
    return null;
  }
}

function aliveNpc(npc) {
  try {
    return !!npc && npc.isDead?.() !== true && npc.isDying?.() !== true;
  } catch {
    return false;
  }
}

function hasItem(player, itemId, amount = 1) {
  try {
    return player.getInventory().getAmount(itemId) >= amount;
  } catch {
    return false;
  }
}

function takeItem(player, itemId, amount) {
  try {
    player.getInventory().deleteNumber(itemId, amount);
    return true;
  } catch {
    return false;
  }
}

function giveItem(player, itemId, amount = 1) {
  try {
    player.getInventory().add(new core.Item(itemId, amount), true);
    return true;
  } catch {
    return false;
  }
}

function giveCoins(player, amount) {
  return giveItem(player, core.ItemIdentifiers.COINS, amount);
}

function prompt(player, title, pairs) {
  try {
    return api.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[myreque] prompt failed", error?.message ?? error);
    player.sendMessage("They're momentarily distracted. Try again.");
    return false;
  }
}

function cooldownRemaining(player, attr, cooldownMs) {
  const last = Number(player.getAttribute?.(attr)) || 0;
  const left = cooldownMs - (Date.now() - last);
  return left > 0 ? left : 0;
}

function markCooldown(player, attr) {
  try {
    player.setAttribute(attr, Date.now());
  } catch {
    // best-effort
  }
}

// --- world setup ----------------------------------------------------------------------

function spawnNpcAt(idName, pos, wanderRadius) {
  try {
    const id = core.NpcIdentifiers[idName];
    if (!id) {
      console.warn("[myreque] unknown npc id", idName);
      return null;
    }
    return api.spawnNpc({ id, x: pos.x, y: pos.y, z: pos.z, wanderRadius });
  } catch (error) {
    console.warn("[myreque] npc spawn failed", { idName, error: error?.message });
    return null;
  }
}

function spawnWorldObject(id, x, y, z) {
  try {
    const obj = new core.GameObject(id, new core.Location(x, y, z), 10, 0, null);
    core.ObjectManager.register(obj, true);
    return obj;
  } catch (error) {
    console.warn("[myreque] object spawn failed", { id, x, y, error: error?.message });
    return null;
  }
}

function buildWorld() {
  officerNpc = spawnNpcAt("MAN", OFFICER_POS, 2);
  fenceNpc = spawnNpcAt("MAN", FENCE_POS, 2);
  ensureCourier();
  for (const pos of CACHE_POS) {
    spawnWorldObject(core.ObjectIdentifiers.CRATE, pos.x, pos.y, pos.z);
  }
  spawnWorldObject(core.ObjectIdentifiers.CLOSED_CHEST, TITHE_CHEST_POS.x, TITHE_CHEST_POS.y, TITHE_CHEST_POS.z);
  console.info("[myreque] actors placed — Sarev in Canifis, the fence in the Myre");
}

/** (Re)spawn the courier if he's dead and the timer has passed. Danger's swamp area calls this. */
function ensureCourier() {
  if (aliveNpc(courierNpc)) return;
  if (Date.now() < courierRespawnAt) return;
  courierNpc = spawnNpcAt("MAN", COURIER_HOME, 6);
}

function isCourier(npc) {
  return !!npc && aliveNpc(courierNpc) && npc === courierNpc;
}

// --- the worn tokens --------------------------------------------------------------------

function tokenProse(player, side) {
  const tier = Rep.tierOf(Rep.getStanding(player));
  if (side === "myreque") {
    switch (tier) {
      case Rep.TIER_SWORN:
        return "The sickle is warm from your hand. The Hollow knows your name — and the dark knows it too. The patrols will not let you pass unmarked.";
      case Rep.TIER_TRUSTED:
        return "The silver catches what little light the swamp allows. You are trusted in the Hollow. The regime would call it treason.";
      case Rep.TIER_WHISPER:
        return "The sickle feels heavier than it should. The Hollow has marked you as a friend — prove yourself, and it opens.";
      default:
        return "Cold silver. Whatever you were to the Hollow, the needle has moved on. The token remembers, even if they don't.";
    }
  }
  switch (tier) {
    case Rep.TIER_OATHBOUND:
      return "The brand is warm, almost alive. The patrols salute you. The Hollow would put a stake through you given half a chance.";
    case Rep.TIER_FAVORED:
      return "The brand pulses dully against your skin. Sarev pays you well and asks little. The Hollow must never learn your name.";
    case Rep.TIER_WATCHED:
      return "The brand itches. The tithe has noticed your coin and your compliance. Nothing more — yet.";
    default:
      return "Cold iron. Whatever you were to the tithe, the needle has moved on. The brand remembers, even if Sarev doesn't.";
  }
}

function readToken(player, side) {
  player.sendMessage(tokenProse(player, side));
}

/** Hand a token to the player once (re-issuable via dialogue if lost). */
function grantToken(player, itemId, attr, grantedLine) {
  if (player.getAttribute?.(attr) === true) return;
  if (hasItem(player, itemId)) {
    try {
      player.setAttribute(attr, true);
    } catch {
      // best-effort
    }
    return;
  }
  if (player.getInventory().getFreeSlots() < 1) {
    player.sendMessage("Your pack's full — make room and ask again.");
    return;
  }
  if (!giveItem(player, itemId)) return;
  try {
    player.setAttribute(attr, true);
  } catch {
    // best-effort
  }
  player.sendMessage(grantedLine);
}

// --- Tithe-Officer Sarev (Drakan's side) --------------------------------------------------

function officerGreeting(player) {
  const tier = Rep.tierOf(Rep.getStanding(player));
  const name = Rep.usernameOf(player) ? `, ${player.getUsername()}` : "";
  switch (tier) {
    case Rep.TIER_OATHBOUND:
      return `Tithe-Officer Sarev: "Oathbound${name}. The tithe runs red because of you. What do you need?"`;
    case Rep.TIER_FAVORED:
      return `Tithe-Officer Sarev: "Back again, friend of the tithe. Coin or names — which is it?"`;
    case Rep.TIER_TRUSTED:
    case Rep.TIER_SWORN:
      return `Tithe-Officer Sarev: "Careful. I know that look... Business is business, though. What do you want?"`;
    default:
      return `Tithe-Officer Sarev: "You. The tithe doesn't pay itself — what do you want?"`;
  }
}

function payTithe(player) {
  const left = cooldownRemaining(player, "myreque:tithe-at", TITHE_COOLDOWN_MS);
  if (left > 0) {
    player.sendMessage("Sarev: \"The tithe ledger's ink is still wet. Come back later.\"");
    showOfficerMenu(player);
    return;
  }
  if (!hasItem(player, core.ItemIdentifiers.COINS, TITHE_COST)) {
    player.sendMessage(`Sarev: "A thousand coin. The Blood takes its due — no less."`);
    showOfficerMenu(player);
    return;
  }
  let delta = TITHE_STANDING;
  if (!Rep.hasMetMyreque(player)) {
    // Pre-quest the tithe is just taxes: it can sour you, but only so far.
    const cur = Rep.getStanding(player);
    if (cur + delta < PRE_QUEST_TITHE_FLOOR) delta = PRE_QUEST_TITHE_FLOOR - cur;
  }
  if (delta >= 0) {
    player.sendMessage("Sarev waves you off. \"You've paid enough for one lifetime. Keep your coin.\"");
    showOfficerMenu(player);
    return;
  }
  takeItem(player, core.ItemIdentifiers.COINS, TITHE_COST);
  markCooldown(player, "myreque:tithe-at");
  Rep.addStanding(player, delta, "tithe-paid");
  player.sendMessage("You count out a thousand coin. Sarev marks his ledger. The Blood is owed, and paid.");
  showOfficerMenu(player);
}

function inform(player) {
  const left = cooldownRemaining(player, "myreque:inform-at", INFORM_COOLDOWN_MS);
  if (left > 0) {
    player.sendMessage("Sarev: \"You bring me scraps. Bring me something worth coin.\"");
    showOfficerMenu(player);
    return;
  }
  markCooldown(player, "myreque:inform-at");
  const tier = Rep.tierOf(Rep.getStanding(player));
  const defecting = tier === Rep.TIER_TRUSTED || tier === Rep.TIER_SWORN;
  const delta = defecting ? DEFECT_STANDING : INFORM_STANDING;
  const pay = defecting ? DEFECT_PAY : INFORM_PAY;
  Rep.addStanding(player, delta, "informed");
  giveCoins(player, pay);
  const first = player.getAttribute?.("myreque:informed-once") !== true;
  try {
    player.setAttribute("myreque:informed-once", true);
  } catch {
    // best-effort
  }
  Rep.markDeed(
    player,
    `${player.getUsername?.() ?? "Someone"} sold the Myreque's secrets to the tithe.`,
    first ? "Someone in Canifis has been talking to the tithe-officer. Names were named." : null
  );
  player.sendMessage("You tell Sarev what you know of the Hollow — the tunnel, the caches, the names. His quill scratches.");
  if (defecting) player.sendMessage("Sarev smiles thinly. \"The Hollow will miss you. I won't.\"");
  player.sendMessage(`Sarev counts out ${pay} coin. "The Blood rewards its friends."`);
  showOfficerMenu(player);
}

function claimBounty(player) {
  const killedAt = Number(player.getAttribute?.("myreque:courier-kill-at")) || 0;
  if (Date.now() - killedAt > BOUNTY_WINDOW_MS) {
    player.sendMessage("Sarev: \"The swamp's full of dead runners. Which one was yours?\"");
    showOfficerMenu(player);
    return;
  }
  try {
    player.setAttribute("myreque:courier-kill-at", 0);
  } catch {
    // best-effort
  }
  Rep.addStanding(player, BOUNTY_STANDING, "courier-bounty");
  giveCoins(player, BOUNTY_PAY);
  Rep.markDeed(player, `${player.getUsername?.() ?? "Someone"} collected the tithe's bounty for a dead runner.`, null);
  player.sendMessage(`Sarev barely looks up. "The runner's dead. Good." He slides ${BOUNTY_PAY} coin across.`);
  showOfficerMenu(player);
}

function showOfficerMenu(player) {
  const tier = Rep.tierOf(Rep.getStanding(player));
  const pairs = [
    "I'd pay the blood tithe. (1,000 coins)",
    () => payTithe(player),
  ];
  if (Rep.hasMetMyreque(player)) {
    pairs.push("I have word of the Myreque.", () => inform(player));
    const killedAt = Number(player.getAttribute?.("myreque:courier-kill-at")) || 0;
    if (Date.now() - killedAt <= BOUNTY_WINDOW_MS) {
      pairs.push("The runner's dead. I want my bounty.", () => claimBounty(player));
    }
  }
  if ((tier === Rep.TIER_FAVORED || tier === Rep.TIER_OATHBOUND) && !hasItem(player, BRAND_TOKEN)) {
    pairs.push("I lost my brand.", () => {
      grantToken(player, BRAND_TOKEN, "myreque:token-brand", "Sarev presses a dark brand into your palm. \"Wear it. Let the patrols see whose you are.\"");
      showOfficerMenu(player);
    });
  }
  pairs.push(
    "How do I stand with the regime?",
    () => {
      player.sendMessage(`Sarev studies you. "${Rep.standingProse(player)}"`);
      showOfficerMenu(player);
    },
    "Leave.",
    () => {}
  );
  prompt(player, "Tithe-Officer Sarev", pairs);
}

function officerTalk(player) {
  player.sendMessage(officerGreeting(player));
  // The brand is the regime's token, handed over at Tithe-Favored.
  const tier = Rep.tierOf(Rep.getStanding(player));
  if (tier === Rep.TIER_FAVORED || tier === Rep.TIER_OATHBOUND) {
    grantToken(player, BRAND_TOKEN, "myreque:token-brand", "Sarev presses a dark brand into your palm. \"Wear it. Let the patrols see whose you are.\"");
  }
  // Sarev accuses after a burn — flavor, no lockout.
  try {
    const burnedAt = Number(Store.getKingdom("morytania")?.flags?.["morytania:records-burned-at"]) || 0;
    if (burnedAt > 0 && Date.now() - burnedAt < BURN_COOLDOWN_MS) {
      player.sendMessage("Sarev: \"Someone burned my records. Was it you? ...No. You'd not dare. Would you?\"");
    }
  } catch {
    // best-effort
  }
  showOfficerMenu(player);
}

// --- The fence (Myreque side) -----------------------------------------------------------------

function fenceTalk(player) {
  if (!Rep.hasMetMyreque(player)) {
    player.sendMessage("The traveler shrugs. \"Just passing through, friend. The swamp's no place for small talk.\"");
    return;
  }
  if (Rep.myrequeLocked(player)) {
    player.sendMessage("The man's hand drifts to his knife. \"We don't know you. Leave.\"");
    return;
  }
  const tier = Rep.tierOf(Rep.getStanding(player));
  const title = Rep.titleFor(player);
  if (title) player.sendMessage(`The fence bows his head. "${title}. The Hollow breathes easier with you in it."`);
  else if (tier === Rep.TIER_TRUSTED) player.sendMessage("The fence grins. \"Back from the dark, friend. What do you need?\"");
  else if (tier === Rep.TIER_WHISPER) player.sendMessage("The fence lowers his voice. \"Keep it down. Polmafi vouched for you once — what do you need?\"");
  else player.sendMessage("The fence eyes you. \"Polmafi vouched for you once. Don't make him regret it.\"");
  // The worn silver sickle: the Hollow's token, handed over at Hollow-Trusted.
  if (tier === Rep.TIER_TRUSTED || tier === Rep.TIER_SWORN) {
    grantToken(player, SICKLE_TOKEN, "myreque:token-sickle", "The fence presses a worn silver sickle into your hand. \"The Hollow's mark. Keep it close.\"");
  }
  showFenceMenu(player);
}

function showFenceMenu(player) {
  const tier = Rep.tierOf(Rep.getStanding(player));
  const trusted = tier === Rep.TIER_TRUSTED || tier === Rep.TIER_SWORN;
  const pairs = [
    "The cell needs supplies?",
    () => {
      player.sendMessage("The fence nods toward the old tunnel. \"Bread, swamp paste, planks — leave them in the caches. The Hollow remembers.\"");
      showFenceMenu(player);
    },
  ];
  if (trusted) {
    pairs.push(
      "Carry word to the Hollows.",
      () => carryWord(player),
      "Trade.",
      () => showTradeMenu(player)
    );
  }
  if (trusted && !hasItem(player, SICKLE_TOKEN)) {
    pairs.push("I lost my token.", () => {
      grantToken(player, SICKLE_TOKEN, "myreque:token-sickle", "The fence presses a worn silver sickle into your hand. \"The Hollow's mark. Keep it close.\"");
      showFenceMenu(player);
    });
  }
  pairs.push(
    "How do I stand with the Hollow?",
    () => {
      player.sendMessage(`The fence murmurs. "${Rep.standingProse(player)}"`);
      showFenceMenu(player);
    },
    "Leave.",
    () => {}
  );
  prompt(player, "The fence", pairs);
}

/** Spreading word: carry the fence's sealed note to Polmafi. */
function carryWord(player) {
  const left = cooldownRemaining(player, "myreque:word-at", WORD_COOLDOWN_MS);
  if (left > 0) {
    player.sendMessage("The fence shakes his head. \"No new words yet. The Hollow's couriers walk slow.\"");
    showFenceMenu(player);
    return;
  }
  if (player.getAttribute?.("myreque:carrying-word") === true) {
    player.sendMessage("The fence taps your pack. \"You've already got our words. Polmafi waits by the tunnel.\"");
    showFenceMenu(player);
    return;
  }
  if (!hasItem(player, core.ItemIdentifiers.NOTE)) {
    if (!giveItem(player, core.ItemIdentifiers.NOTE)) {
      player.sendMessage("The fence frowns at your full pack. \"Make room first.\"");
      showFenceMenu(player);
      return;
    }
  }
  try {
    player.setAttribute("myreque:carrying-word", true);
  } catch {
    // best-effort
  }
  markCooldown(player, "myreque:word-at");
  player.sendMessage("The fence presses a sealed note into your hand. \"Polmafi, by the old tunnel. Walk like you've somewhere to be.\"");
  showFenceMenu(player);
}

/** The black market: discount anti-vyre supplies, premium blood-rune buy. */
function showTradeMenu(player) {
  const pairs = [
    "Buy 5 garlic (25 coins)",
    () => {
      if (!hasItem(player, core.ItemIdentifiers.COINS, 25)) {
        player.sendMessage("The fence: \"Twenty-five coin. The Hollow doesn't run on promises.\"");
      } else {
        takeItem(player, core.ItemIdentifiers.COINS, 25);
        giveItem(player, core.ItemIdentifiers.GARLIC, 5);
        player.sendMessage("The fence slides five bulbs of garlic across. \"Vyres hate the stuff. Use it well.\"");
      }
      showTradeMenu(player);
    },
    "Buy a stake (30 coins)",
    () => {
      if (!hasItem(player, core.ItemIdentifiers.COINS, 30)) {
        player.sendMessage("The fence: \"Thirty coin. The Hollow doesn't run on promises.\"");
      } else {
        takeItem(player, core.ItemIdentifiers.COINS, 30);
        giveItem(player, core.ItemIdentifiers.STAKE, 1);
        player.sendMessage("The fence hands over a sharpened stake. \"Through the heart. Don't miss.\"");
      }
      showTradeMenu(player);
    },
    "Sell 10 blood runes (200 coins)",
    () => {
      if (!hasItem(player, core.ItemIdentifiers.BLOOD_RUNE, 10)) {
        player.sendMessage("The fence: \"Ten blood runes. The cell pays premium — no questions.\"");
      } else {
        takeItem(player, core.ItemIdentifiers.BLOOD_RUNE, 10);
        giveCoins(player, 200);
        player.sendMessage("The fence weighs the runes, nods, and counts out two hundred coin. \"No questions.\"");
      }
      showTradeMenu(player);
    },
    "Back.",
    () => showFenceMenu(player),
  ];
  prompt(player, "The fence's wares", pairs);
}

// --- Smuggling: the supply caches ---------------------------------------------------------------

const SMUGGLE_OFFERS = [
  { itemId: "BREAD", name: "bread", amount: 5, label: "Deliver 5 bread" },
  { itemId: "SWAMP_PASTE", name: "swamp paste", amount: 5, label: "Deliver 5 swamp paste" },
  { itemId: "PLANK", name: "planks", amount: 3, label: "Deliver 3 planks" },
];

function isCacheSpot(objectId, location) {
  if (objectId !== core.ObjectIdentifiers.CRATE) return false;
  return CACHE_POS.some((pos) => near(location, pos, OBJ_SCOPE));
}

function cacheSearch(player) {
  if (!Rep.hasMetMyreque(player)) {
    player.sendMessage("Old supply crates, swamp-rotted. Nothing worth taking.");
    return;
  }
  if (Rep.myrequeLocked(player)) {
    player.sendMessage("You lift the lid — empty. Or it was never yours to open.");
    return;
  }
  const pairs = SMUGGLE_OFFERS.map((offer) => [
    `${offer.label} (+${SMUGGLE_STANDING})`,
    () => deliverSupplies(player, offer),
  ]).flat();
  pairs.push("Leave.", () => {});
  prompt(player, "A hidden cache", pairs);
}

function deliverSupplies(player, offer) {
  const left = cooldownRemaining(player, "myreque:cache-at", SMUGGLE_COOLDOWN_MS);
  if (left > 0) {
    player.sendMessage("The cache is bare for now — the cell collects on its own rhythm. Come back later.");
    return;
  }
  const itemId = core.ItemIdentifiers[offer.itemId];
  if (!hasItem(player, itemId, offer.amount)) {
    player.sendMessage(`You don't have ${offer.amount} ${offer.name} to leave.`);
    return;
  }
  takeItem(player, itemId, offer.amount);
  markCooldown(player, "myreque:cache-at");
  Rep.addStanding(player, SMUGGLE_STANDING, "smuggled");
  player.sendMessage(`You tuck the ${offer.name} into the cache and cover it with reeds. The Hollow will remember this. (+${SMUGGLE_STANDING} standing)`);
}

// --- Sabotage: burn the tithe records -------------------------------------------------------------

function isTitheChest(objectId, location) {
  return objectId === core.ObjectIdentifiers.CLOSED_CHEST && near(location, TITHE_CHEST_POS, OBJ_SCOPE);
}

function recordsBurnedAt() {
  try {
    return Number(Store.getKingdom("morytania")?.flags?.["morytania:records-burned-at"]) || 0;
  } catch {
    return 0;
  }
}

function burnRecords(player) {
  if (!Rep.hasMetMyreque(player)) {
    player.sendMessage("A tithe-chest of Lowerniel's regime, bound in black iron. Best not touched.");
    return;
  }
  if (Rep.tierOf(Rep.getStanding(player)) === Rep.TIER_OATHBOUND) {
    player.sendMessage("You'd burn your own master's ledgers? The thought alone is treason.");
    return;
  }
  if (Date.now() - recordsBurnedAt() < BURN_COOLDOWN_MS) {
    player.sendMessage("Charred paper still smoulders in the chest. Someone got here first.");
    return;
  }
  if (!hasItem(player, core.ItemIdentifiers.TINDERBOX)) {
    player.sendMessage("You need a tinderbox to set them alight.");
    return;
  }
  try {
    Store.setFlag("morytania", "morytania:records-burned-at", Date.now());
    Store.save();
  } catch {
    // best-effort
  }
  Rep.addStanding(player, BURN_STANDING, "records-burned");
  Rep.markDeed(
    player,
    `${player.getUsername?.() ?? "Someone"} burned the tithe records in Canifis.`,
    "The tithe records in Canifis went up in smoke. Sarev is asking questions."
  );
  player.sendMessage(`You tip the ledgers out and set them alight. Names, debts, blood-dues — all smoke on the swamp wind. (+${BURN_STANDING} standing)`);
}

// --- The courier (the regime's bounty target) -------------------------------------------------------

function courierTalk(player, npc) {
  const tier = Rep.tierOf(Rep.getStanding(player));
  if (tier === Rep.TIER_OATHBOUND) {
    // He knows what you are.
    try {
      api.removeNpc(npc);
    } catch {
      // best-effort
    }
    courierNpc = null;
    courierRespawnAt = Date.now() + COURIER_RESPAWN_MS;
    player.sendMessage("The runner takes one look at you and melts into the reeds. You'll not catch them today.");
    return;
  }
  if (tier === Rep.TIER_FAVORED) {
    player.sendMessage("The runner won't meet your eyes. They know what you are.");
    return;
  }
  player.sendMessage("The runner glances at you, then away. They're carrying something — and in a hurry.");
}

function onCourierDeath(event) {
  const { npc, killer } = event ?? {};
  if (!npc || npc !== courierNpc) return;
  courierNpc = null;
  courierRespawnAt = Date.now() + COURIER_RESPAWN_MS;
  if (!isRealPlayer(killer)) return;
  try {
    killer.setAttribute("myreque:courier-kill-at", Date.now());
  } catch {
    // best-effort
  }
  Rep.addStanding(killer, COURIER_KILL_STANDING, "courier-killed");
  Rep.markDeed(killer, `${killer.getUsername?.() ?? "Someone"} cut down a Myreque runner in the swamp.`, null);
  killer.sendMessage("The runner dies quietly in the reeds. The tithe will pay for this — Sarev, in Canifis.");
}

// --- Polmafi: the Hollow's door (no SunkenHollow edit — this hook runs first) ------------------------

function onPolmafiTalk(event) {
  const { player } = event ?? {};
  if (!isRealPlayer(player)) return false;
  // Drakan's friends get the cold shoulder — and never the word-run.
  if (Rep.myrequeLocked(player)) {
    player.sendMessage("Polmafi Ferdygris: \"The regime's hound. Leave, before I forget the old road.\"");
    return; // handled — SunkenHollow's talkToPolmafi never fires
  }
  if (player.getAttribute?.("myreque:carrying-word") === true) {
    const noteId = core.ItemIdentifiers.NOTE;
    if (hasItem(player, noteId)) takeItem(player, noteId, 1);
    try {
      player.setAttribute("myreque:carrying-word", false);
    } catch {
      // best-effort
    }
    Rep.addStanding(player, WORD_STANDING, "word-delivered");
    player.sendMessage("Polmafi breaks the seal, reads, and burns the note. \"The cell hears you. We won't forget.\"");
    player.sendMessage(`(+${WORD_STANDING} standing)`);
    return; // handled
  }
  return false; // not ours — let SunkenHollow's handler run
}

// --- The hollow mouth: Oathbound need not apply -------------------------------------------------------

function onTunnelEnter(event) {
  const { player, location } = event ?? {};
  if (!isRealPlayer(player)) return false;
  if (!near(location, HOLLOW_TUNNEL_POS, 4)) return false; // not our tunnel
  if (Rep.getStanding(player) <= -600) {
    player.sendMessage("A cold breath rises from the tunnel. Polmafi's voice hisses from the dark: \"Not you. Never you. The Hollow remembers what you are.\"");
    return; // handled — SunkenHollow's climbDown never fires
  }
  return false;
}

// --- routing --------------------------------------------------------------------------------------------

function onManTalk(event) {
  const { player, npc } = event ?? {};
  if (!isRealPlayer(player)) return false;
  // Ref checks first: the courier wanders and can stray into the fence's
  // radius — identity by reference is exact, position is approximate.
  if (isCourier(npc)) {
    courierTalk(player, npc);
    return;
  }
  const loc = npcLoc(npc);
  if (near(loc, OFFICER_POS, NPC_SCOPE)) {
    officerTalk(player);
    return;
  }
  if (near(loc, FENCE_POS, NPC_SCOPE)) {
    fenceTalk(player);
    return;
  }
  return false; // some other Man — not ours
}

function onObjectGlobal(event) {
  const { player, objectId, location } = event ?? {};
  if (!player || player.isPlayerBot?.() === true) return;
  if (isCacheSpot(objectId, location)) {
    event.handled = true;
    if (isRealPlayer(player)) cacheSearch(player);
    return;
  }
  if (isTitheChest(objectId, location)) {
    event.handled = true;
    if (isRealPlayer(player)) burnRecords(player);
  }
}

// --- wiring -----------------------------------------------------------------------------------------------

function registerActors(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;

  api.onServerStartup(buildWorld);

  api.onNpcInteraction("Man", { "Talk-to": onManTalk });
  api.onNpcInteraction("Polmafi Ferdygris", { "Talk-to": onPolmafiTalk });
  api.onObjectInteraction("Tunnel", { Enter: onTunnelEnter });
  api.onObjectInteraction(onObjectGlobal);

  api.onItemAction("Worn silver sickle", { Read: ({ player }) => readToken(player, "myreque") });
  api.onItemAction("Tithe brand", { Read: ({ player }) => readToken(player, "drakan") });

  api.onNpcDeath(onCourierDeath);

  console.info("[myreque] actors wired — Sarev, the fence, the courier, caches, tithe records");
}

module.exports = registerActors;
module.exports.ensureCourier = ensureCourier;
module.exports.isCourier = isCourier;
