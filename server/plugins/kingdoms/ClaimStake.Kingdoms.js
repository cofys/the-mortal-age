"use strict";

/**
 * ClaimStake.Kingdoms — DIEGETIC ::found replacement (no-commands migration).
 *
 * Jon's directive: no ::commands for players. Everything through the world.
 * His vision for founding is explicit: "You can try. You will probably die."
 * This module is the trigger for that flow — not the flow itself.
 *
 * The cache's "Stake" item has no inventory option but Drop, so dropping IS
 * the diegetic gesture: cast a stake upon unclaimed earth and the world asks
 * what you mean by it.
 *
 *   1. DROP — a real player drops a Stake in unclaimed land (outside all
 *      great-power territories, Founding.isUnclaimed). The drop is held and
 *      a chatbox prompt asks: drive the stake and declare your claim, or
 *      just drop it. Drops anywhere claimed pass through untouched.
 *   2. NAME — "drive it" opens a text prompt (the preset-naming pattern:
 *      setEnteredSyntaxAction + sendEnterInputPrompt). Speak the name.
 *   3. CHARTER — the name goes straight into Founding.foundKingdom, the
 *      exact function ::found <name> calls. Same 10M charter, same name
 *      rules, same grace timers, same violent response from the nearest
 *      great power. Nothing is reimplemented; a failed charter leaves the
 *      stake in your hand and tells you why.
 *   4. THE STAKE STANDS — on success the stake leaves your inventory and a
 *      Signpost (cache 1033, via ObjectIdentifiers) is spawned at the
 *      claim. It stands while the claim is contested. Clicking it reads the
 *      claim nailed to the post: name, ruler, followers, war chest, and
 *      how long until the marshal marches (Founding.claimStatusLines).
 *
 * Lifecycle: claims are reconciled on a slow task (same ~5 min cadence as
 * the founding tick) — stakes respawn for claims missing one (e.g. after a
 * restart; the claim position persists on the kingdom record's
 * founding:claim flag), and stakes are pulled when the claim resolves into
 * nothing: crushed or abandoned. A claim that SURVIVES keeps its stake as
 * a banner post — upkeep is paid there, the coffers filled there, and
 * raiders come there. The ::found command stays registered until the stake
 * is verified in-game, then it goes. Migration rule: build the world path,
 * verify it works, remove the command. Never the reverse.
 *
 * Stakes: the General Store stocks them (shops.json), and every Morytanian
 * starts with one in their origin kit.
 *
 * Verify: buy a Stake at a general store, walk into unclaimed wilds (e.g.
 * the deep Wilderness between territories), drop it, choose "drive it",
 * name the kingdom. Confirm: 10M taken, realm announcement fires, a
 * signpost stands where you dropped it, clicking it shows the claim's
 * status, and ::found status agrees. Decline the prompt and confirm the
 * stake drops normally. Drop a stake in Falador and confirm nothing happens.
 */

const Founding = require("./Founding.Kingdoms");
const Store = require("./KingdomStore");

let pluginApi = null;
let core = null;

// Resolved from api.core at attach (ItemIdentifiers / ObjectIdentifiers).
let STAKE_IDS = null;
let SIGNPOST_ID = null;
let ItemIdentifiers;
let ObjectIdentifiers;
let Item;
let ItemOnGroundManager;
let Wilderness;
let Location;
let GameObject;
let ObjectManager;
let Task;

// kingdomId -> { object, x, y, z }
const stakes = new Map();

// Reconcile on the founding tick's cadence (~5 minutes: 600ms/tick).
const STAKE_RECONCILE_TICKS = 500;

function isRealPlayer(player) {
  return player?.isPlayer?.() === true && player?.isPlayerBot?.() !== true;
}

/**
 * Chatbox option prompt: flat [text, callback] pairs, the
 * sendMultiChatboxPrompt shape. Never throws — the stake must always answer.
 */
function showPrompt(player, title, pairs) {
  try {
    const sent = pluginApi.sendMultiChatboxPrompt(player, title, ...pairs);
    if (!sent) player.sendMessage("The moment passes. The stake says nothing.");
    return sent;
  } catch (error) {
    console.warn("[claim-stake] prompt failed", error?.message ?? error);
    player.sendMessage("The stake says nothing. Try again.");
    return false;
  }
}

/** Numeric prompt that resumes into onInput (the donation-chest pattern). */
function promptAmount(player, title, onInput) {
  try {
    player.setEnteredAmountAction({
      execute: (amount) => {
        try {
          player.setEnteredAmountAction(null);
        } catch {
          // Clearing is cosmetic.
        }
        onInput(amount);
      },
    });
    player.getPacketSender().sendEnterAmountPrompt(title);
  } catch {
    onInput(null);
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

/**
 * The Stake's only inventory verb is Drop. In unclaimed land the drop is
 * held and the player is asked whether they mean to drive a claim; anywhere
 * claimed the drop passes through untouched.
 */
function stakeDropPolicy(event) {
  const { player, itemId } = event ?? {};
  if (!isRealPlayer(player) || !STAKE_IDS?.has(itemId)) return;
  if (!Founding.isUnclaimed(playerPos(player))) return;
  event.handled = true;
  offerClaim(player, itemId);
}

function offerClaim(player, itemId) {
  const sent = pluginApi.sendMultiChatboxPrompt(
    player,
    "Drive this stake and declare your claim to these wilds?",
    "Drive it — declare my claim",
    (p) => promptClaimName(p, itemId),
    "Just drop it",
    (p) => dropStakeNormally(p, itemId)
  );
  if (!sent) {
    player.sendMessage("The moment passes. The stake stays in your hand.");
  }
}

/** The player declined: perform the ordinary drop the click asked for. */
function dropStakeNormally(player, itemId) {
  try {
    const inv = player.getInventory?.();
    if (!inv || (inv.getAmount?.(itemId) ?? 0) < 1) return;
    const toFloor = new Item(itemId, 1);
    if (Wilderness.isIn(player)) {
      ItemOnGroundManager.registerGlobal(player, toFloor);
    } else {
      ItemOnGroundManager.registers(player, toFloor);
    }
    inv.delete?.(itemId, 1);
  } catch (error) {
    console.warn("[claim-stake] manual drop failed", error?.message ?? error);
  }
}

/** Speak the kingdom's name, then run the one true founding flow. */
function promptClaimName(player, itemId) {
  player.setEnteredSyntaxAction({
    execute: (rawInput) => {
      const name = String(rawInput ?? "").trim();
      const id = Founding.foundKingdom(player, name.split(/\s+/));
      if (!id) return; // founding said why; the stake stays in hand
      if (!consumeStake(player, itemId)) {
        console.warn("[claim-stake] charter landed but no stake to consume", { id });
      }
      driveStake(id);
    },
  });
  player.getPacketSender().sendEnterInputPrompt("Speak the name of your kingdom:");
}

function consumeStake(player, itemId) {
  try {
    return player.getInventory?.().delete?.(itemId, 1) === true;
  } catch {
    return false;
  }
}

/** The charter landed: the stake leaves the hand and stands in the world. */
function driveStake(kingdomId) {
  const claim = Founding.contestedClaims().find((c) => c.id === kingdomId)?.claim;
  if (!claim) {
    console.warn("[claim-stake] no claim position for chartered kingdom", { kingdomId });
    return;
  }
  spawnStake(kingdomId, claim.x, claim.y, claim.z);
  const kingdom = Store.getKingdom(kingdomId);
  const founder = pluginApi.core.World.getPlayerByName?.(kingdom?.ruler);
  founder?.sendMessage?.(
    `You drive the stake deep into the wild earth. ${kingdom?.name ?? kingdomId}'s banner is raised — for now.`
  );
}

function spawnStake(kingdomId, x, y, z) {
  if (stakes.has(kingdomId)) return;
  try {
    const object = new GameObject(SIGNPOST_ID, new Location(x, y, z), 10, 0, null);
    ObjectManager.register(object, true);
    stakes.set(kingdomId, { object, x, y, z });
    console.info("[claim-stake] stake driven", { kingdomId, x, y, z });
  } catch (error) {
    console.warn("[claim-stake] spawn failed", { kingdomId, error: error?.message ?? error });
  }
}

function removeStake(kingdomId) {
  const stake = stakes.get(kingdomId);
  if (!stake) return;
  stakes.delete(kingdomId);
  try {
    ObjectManager.deregister(stake.object, true);
  } catch (error) {
    console.warn("[claim-stake] remove failed", { kingdomId, error: error?.message ?? error });
  }
  console.info("[claim-stake] stake pulled", { kingdomId });
}

/**
 * Stakes stand while the claim is contested — and stand on as banner posts
 * for the rare claim that survives the marshal. Respawn stakes for claims
 * missing one; pull stakes whose claim resolved into nothing.
 */
function reconcileStakes() {
  try {
    const live = new Map();
    for (const c of Founding.contestedClaims()) {
      if (c?.claim) live.set(c.id, c.claim);
    }
    for (const c of Founding.survivedKingdoms()) {
      if (c?.claim) live.set(c.id, c.claim);
    }
    for (const [id, claim] of live) {
      if (!stakes.has(id)) spawnStake(id, claim.x, claim.y, claim.z);
    }
    for (const id of [...stakes.keys()]) {
      if (!live.has(id)) removeStake(id);
    }
  } catch (error) {
    console.warn("[claim-stake] reconcile failed", error?.message ?? error);
  }
}

function matchStake(objectId, location) {
  if (objectId !== SIGNPOST_ID) return null;
  const x = location?.x ?? location?.getX?.() ?? -1;
  const y = location?.y ?? location?.getY?.() ?? -1;
  const z = location?.z ?? location?.getZ?.() ?? -1;
  for (const [kingdomId, s] of stakes) {
    if (s.x === x && s.y === y && s.z === z) return { kingdomId, ...s };
  }
  return null;
}

/** Any click on a claim stake reads the claim nailed to the post. */
function readClaim(event) {
  const { player, objectId, location } = event ?? {};
  if (!isRealPlayer(player)) return false;
  const stake = matchStake(objectId, location);
  if (!stake) return false;
  const kingdom = Store.getKingdom(stake.kingdomId);
  if (!kingdom) {
    removeStake(stake.kingdomId);
    player.sendMessage("The stake stands over nothing. The claim is gone.");
    return true;
  }
  for (const line of Founding.claimStatusLines(kingdom)) player.sendMessage(line);
  offerStakeMenu(player, kingdom);
  return true;
}

/**
 * The rest of the founding verbs, diegetic: swear to the banner, fill the
 * war chest, raid a rival claim, or — for the founder alone, behind a
 * confirmation — lower the banner. Survived claims stand on as banner
 * posts: the founder pays upkeep and fills the coffers there, and anyone
 * else may raid the stores. Every option hands straight to Founding;
 * nothing is reimplemented here.
 */
function offerStakeMenu(player, kingdom) {
  const username = player.getUsername?.()?.toLowerCase?.() ?? "";
  const isFounder =
    String(kingdom.ruler ?? "").toLowerCase() === username && username.length > 0;
  const followers = kingdom.flags?.["founding:followers"] ?? [];
  const isSworn = isFounder || followers.includes(username);
  const survived = kingdom.flags?.["founding:survived"] === true;

  if (survived) {
    offerBannerPostMenu(player, kingdom, isFounder, isSworn);
    return;
  }

  const pairs = [
    "Swear to this banner.",
    () => Founding.joinKingdom(player, [kingdom.name]),
    "Fill the war chest.",
    () =>
      promptAmount(player, "How many coins for the war chest?", (amount) => {
        if (Number(amount) > 0) Founding.fillChest(player, [String(amount)]);
      }),
  ];
  if (!isSworn) {
    pairs.push("Raid the war chest.", () => Founding.raidClaim(player, kingdom.id));
  }
  if (isFounder) {
    pairs.push("Lower the banner.", () => confirmAbandon(player, kingdom));
  }
  pairs.push("Walk away.", () => {});
  showPrompt(player, `The claim of ${kingdom.name}`, pairs);
}

/** A survived claim's banner post: upkeep, coffers, and raiders. */
function offerBannerPostMenu(player, kingdom, isFounder, isSworn) {
  const pairs = [
    "Fill the coffers.",
    () =>
      promptAmount(player, "How many coins for the coffers?", (amount) => {
        if (Number(amount) > 0) Founding.fillChest(player, [String(amount)]);
      }),
  ];
  if (isFounder) {
    pairs.unshift(
      "Pay the weekly upkeep.",
      () =>
        promptAmount(player, "How many coins toward upkeep?", (amount) => {
          if (Number(amount) > 0) Founding.fillChest(player, [String(amount)]);
        })
    );
  }
  if (!isSworn) {
    pairs.push("Raid the stores.", () => Founding.raidClaim(player, kingdom.id));
  }
  pairs.push("Walk away.", () => {});
  showPrompt(player, `The banner post of ${kingdom.name} — it stands, barely`, pairs);
}

/** Lowering the banner ends the kingdom — confirm, like resigning an office. */
function confirmAbandon(player, kingdom) {
  const pairs = [
    "Yes. Lower it.",
    () => Founding.abandonKingdom(player),
    "No — the banner stands.",
    () => {},
  ];
  showPrompt(
    player,
    `Lower the banner of ${kingdom.name}? The claim ends here.`,
    pairs
  );
}

function attachClaimStake(api) {
  pluginApi = api;
  core = api.core;
  ({
    ItemIdentifiers,
    ObjectIdentifiers,
    Item,
    ItemOnGroundManager,
    Wilderness,
    Location,
    GameObject,
    ObjectManager,
    Task,
  } = core);
  STAKE_IDS = new Set([ItemIdentifiers.STAKE, ItemIdentifiers.STAKE_2]);
  SIGNPOST_ID = ObjectIdentifiers.SIGNPOST;

  api.onItemDropPolicy(stakeDropPolicy);
  api.onObjectInteraction(readClaim);

  class ReconcileTask extends Task {
    execute() {
      reconcileStakes();
    }
  }
  class SpawnTask extends Task {
    execute() {
      // Spawn after the world is ready — delay one tick.
      reconcileStakes();
      this.stop?.();
    }
  }
  api.getTaskManager()?.submit(new SpawnTask(2));
  api.getTaskManager()?.submit(new ReconcileTask(STAKE_RECONCILE_TICKS));
  console.info("[claim-stake] diegetic ::found replacement ready — drive a stake, declare a claim");
}

module.exports = attachClaimStake;
