/**
 * Tai Bwo Wannai Cleanup: the Hardwood Grove's doors (https://oldschool.runescape.wiki/w/Hardwood_Grove).
 *
 * Entering costs Murcaily 100 trading sticks each time and is free with the Karamja elite diary
 * (Wiki). The doors (tbwcu_bamboo_door_l/_r) stand on the west edge of x=2817, inside is east.
 * As recorded (rsprox 231/03030 ticks 2396-2401; 227/01858 tick 20692): the doorway gets an
 * inviswall at both door tiles, the open leaves (tbwcu_bamboo_door_inactive_l rotation 3, _r
 * rotation 1) stand at x=2816, sound 40 plays (after 1283 when sticks are paid, taken on the walk's
 * tick), the player walks one tile through, and two ticks later the doors are shut again.
 *
 * - Quick-Pay with the elite diary walks in free (03030). Open with it plays Murcaily's elite
 *   transcript ("...for you my friend, it's free!"); its "I'll enter for free." walks in.
 * - A player who hasn't had their first sticks from Murcaily (cleanup_progress < 5) gets his
 *   warning first (227/01757, 237/01102: either op), "I just want to go in anyway." paying 100.
 * - Otherwise both ops pay 100 and walk in (01858 Quick-Pay; Open isn't recorded and does the same).
 * - Leaving without teak or mahogany logs asks first (03030 tick 2579, 01757 tick 22020), then
 *   walks one tile west to (2816, 3083), diagonally from the north door as 01858 tick 20738 shows.
 *
 * Inside, the teak and mahogany can't be cut before the first sticks (Wiki), with the recorded
 * mesbox (01102 tick 17313). The walk happens one tick after the click or the dialogue's last
 * continue (live: the same tick for the dialogue). Fewer than 100 sticks: our own message.
 */
const Common = require("./Common.TaiBwoWannaiCleanup");

/** The step's force-movement facing (0 north, 1 east, 2 south, 3 west) and its client speed, as CooksGuild's. */
const FACING_EAST = 1;
const FACING_WEST = 3;
const STEP_SPEED = 30;

/** Players between a door's click and its closing (a second click does nothing). */
const passing = new WeakSet();

const grove = () => Common.data.grove;
const tile = ([x, y, z]) => new Common.core.Location(x, y, z);
const sticksId = () => Common.objId(Common.data.sticks.item);
const isInside = (player) => player.getLocation().getX() >= grove().insideFromX;
const murcailyId = () => Common.core.CacheDefinitions.getNpcId(grove().murcaily);

function eliteDiary(player) {
  const request = { player, diary: "karamja", tier: "elite", complete: false };
  Common.api.emitCustomEvent("diary:is-complete", request);
  return request.complete === true;
}

const helped = (player) => Common.progress(player) >= Common.data.progress.claimed;

function inGrove(location) {
  const [minX, minY, maxX, maxY] = grove().bounds;
  const x = location.getX();
  const y = location.getY();
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

/** The doorway as it stands open: inviswalls in the doors' places, the leaves swung out west. */
function openDoors(player) {
  const { GameObject, MapObjects } = Common.core;
  const sender = player.getPacketSender();
  const closed = grove().doorTiles.map((at, index) => MapObjects.get(Common.locId(grove().doors[index]), tile(at), null)).filter(Boolean);
  for (const door of closed) {
    sender.sendObject(new GameObject(Common.locId(grove().wall), door.getLocation().clone(), door.getType(), door.getFace(), null));
  }
  const type = closed[0]?.getType?.() ?? 0;
  const leaves = grove().open.map((leaf) => new GameObject(Common.locId(leaf.loc), tile(leaf.at), type, leaf.rotation, null));
  for (const leaf of leaves) sender.sendObject(leaf);
  return () => {
    for (const leaf of leaves) sender.sendObjectRemoval(leaf);
    for (const door of closed) sender.sendObject(door);
  };
}

/** One tile through the doorway, in or out; `fee` sticks are taken as the player steps in. */
function walkThrough(player, fee = 0) {
  if (passing.has(player)) return false;
  passing.add(player);
  const movement = player.getMovementQueue();
  movement.setBlockMovement(true).reset();
  Common.later(player, 1, () => {
    const done = () => {
      movement.setBlockMovement(false);
      passing.delete(player);
    };
    // Moved off by something else (a teleport) since the click: no fee, no pull back.
    const start = player.getLocation();
    const atDoor = start.getZ() === grove().doorTiles[0][2] && grove().doorTiles.some(([x, y]) =>
      Math.abs(start.getX() - x) <= 1 && Math.abs(start.getY() - y) <= 1);
    if (!atDoor) return done();
    const inventory = player.getInventory();
    if (fee > 0) {
      if (inventory.getAmount(sticksId()) < fee) {
        player.sendMessage(Common.message("groveFee"));
        return done();
      }
      inventory.deleteNumber(sticksId(), fee);
      inventory.refreshItems();
      Common.sound(player, grove().sounds.pay);
    }
    Common.sound(player, grove().sounds.door);
    const close = openDoors(player);
    const leaving = isInside(player);
    const here = player.getLocation();
    const y = Math.max(grove().doorTiles[0][1], Math.min(grove().doorTiles[1][1], here.getY()));
    const from = leaving ? tile([grove().insideFromX, y, here.getZ()]) : tile([grove().insideFromX - 1, y, here.getZ()]);
    const to = leaving ? tile(grove().exit) : tile([grove().insideFromX, y, here.getZ()]);
    if (!here.equals(from)) player.moveTo(from.clone());
    const { ForceMovement, ForceMovementTask, Location, TaskManager } = Common.core;
    const offset = new Location(to.getX() - from.getX(), to.getY() - from.getY());
    TaskManager.submit(new ForceMovementTask(player, 1, new ForceMovement(from.clone(), offset, 0, STEP_SPEED, leaving ? FACING_WEST : FACING_EAST, Common.seqId("human_walk_f"))));
    Common.later(player, grove().closeTicks, () => {
      close();
      done();
    });
  });
  return true;
}

/** Pays the fee and walks in, or says it can't be paid. */
function payAndEnter(player) {
  if (player.getInventory().getAmount(sticksId()) < grove().fee) {
    player.sendMessage(Common.message("groveFee"));
    return;
  }
  walkThrough(player, grove().fee);
}

/** A two-option menu after the box before it (the chat's own reset first, as transcripts do). */
function menu(player, ...pairs) {
  player.getDialogueManager().reset();
  Common.api.sendMultiChatboxPrompt(player, Common.message("selectOption"), ...pairs);
}

/** Murcaily's warning to a player who hasn't helped the village yet (01757). */
function warn(player) {
  const { ActionDialogue, DialogueChainBuilder, NpcDialogue, PlayerDialogue, EndDialogue } = Common.core;
  const manager = player.getDialogueManager();
  const say = (text, then) => manager.startDialogues(new DialogueChainBuilder().add(
    new PlayerDialogue(0, text),
    then ? new ActionDialogue(1, { execute: then }) : new EndDialogue(1),
  ));
  manager.startDialogues(new DialogueChainBuilder().add(
    new NpcDialogue(0, murcailyId(), Common.message("groveWarn")),
    new ActionDialogue(1, { execute: () => menu(player,
      Common.message("groveAnyway"), () => say(Common.message("groveAnyway"), () => {
        manager.reset();
        player.getPacketSender().sendInterfaceRemoval();
        payAndEnter(player);
      }),
      Common.message("groveStayOut"), () => say(Common.message("groveStayOut"))) }),
  ));
}

function hasHardwood(player) {
  return grove().logs.some((log) => player.getInventory().contains(Common.objId(log)));
}

/** Leaving: straight out with logs, otherwise asked first. */
function leave(player) {
  if (hasHardwood(player)) return walkThrough(player);
  const { ActionDialogue, DialogueChainBuilder, DoubleItemStatementDialogue } = Common.core;
  const [teak, mahogany] = grove().logs.map(Common.objId);
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new DoubleItemStatementDialogue(0, teak, mahogany, Common.message("groveLeave")),
    new ActionDialogue(1, { execute: () => menu(player,
      Common.message("groveLeaveYes"), () => {
        player.getPacketSender().sendInterfaceRemoval();
        walkThrough(player);
      },
      Common.message("groveLeaveNo"), () => player.getPacketSender().sendInterfaceRemoval()) }),
  ));
  return true;
}

function useDoor(event, quickPay) {
  const { player } = event;
  event.handled = true;
  if (passing.has(player)) return true;
  if (isInside(player)) return leave(player);
  if (eliteDiary(player)) {
    if (quickPay) return walkThrough(player);
    Common.api.emitCustomEvent("npc-dialogue:start", { player, npcId: murcailyId(), variant: grove().eliteVariant, exact: true, handled: false });
    return true;
  }
  if (!helped(player)) {
    warn(player);
    return true;
  }
  payAndEnter(player);
  return true;
}

const open = (event) => useDoor(event, false);
const quickPay = (event) => useDoor(event, true);

/** The elite transcript's "The player enters the Hardwood Grove." */
function onAction(event) {
  if (event.stepId !== grove().eliteEnter || event.definition?.getName?.() !== "Murcaily") return;
  event.handled = true;
  event.end = true;
  if (!isInside(event.player)) walkThrough(event.player);
}

/** The grove's teak and mahogany wait for the first sticks (Wiki), with the recorded mesbox. */
function validateTree(request) {
  const { player, object } = request;
  if (!request.allow || !object || !inGrove(object.getLocation()) || helped(player)) return;
  const name = String(object.getDefinition?.()?.getName?.() ?? "");
  if (!grove().trees.some((tree) => name.startsWith(tree))) return;
  request.allow = false;
  if (!player.getDialogueManager().isActive()) Common.statement(player, Common.message("groveChop"));
}

function attachGrove(api) {
  api.onObjectInteraction("Hardwood Grove Doors", { Open: open, "Quick-Pay(100)": quickPay });
  api.onCustomEvent("npc-dialogue:action", onAction);
  api.onCustomEvent("woodcutting:validate-tree", validateTree);
}

module.exports = { attachGrove, useDoor, walkThrough, validateTree, inGrove, eliteDiary, _passing: passing };
