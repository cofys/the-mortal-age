/**
 * The bone grinder upstairs in the Ectofuntus: bones go into the loader's hopper, the handle grinds
 * them into the bin, and a pot takes them out as bonemeal. Using bones on the loader runs the whole
 * round and starts the next bone after each pot, until bones or pots run out or the player clicks
 * (Wiki). The hopper and bin keep their bones between visits (ahoy_grinder_status).
 *
 * As captured (rsprox recordings 376, 377, rev 231), each part from the player's tile south of it,
 * the first one two ticks after the player arrives:
 * - Loader (3660, 3524): ahoy_bone_dump and synth 1133 (both delay 5), "You put some big bones in
 *   the grinder's hopper.", status 1. Three ticks later they step west, and two after that wind.
 * - Handle (3659, 3524): ahoy_bone_grind and synth 1131 (both delay 10), "You wind the grinder
 *   handle."; three ticks later "Some crushed big bones pour into the bin.", status 2; three more
 *   and they step west, and two after that fill a pot.
 * - Bin (3658, 3524): ahoy_fillbucket_bonedust and synth 1136 (both delay 5), "You fill a pot
 *   with crushed big bones.", the pot becomes bonemeal, status 0; five ticks later they run back
 *   to the loader and load the next bone two ticks after that.
 * - Without a pot at the bin: "You need an empty pot to put the crushed big bones into." and the
 *   round stops with the bones in the bin. Bones on the loader while the bin is full: "You need to
 *   empty the grinder's bin before you put more bones in it."
 * - Status, also two ticks after arrival: "The grinder is empty." / "There are some big bones in
 *   the hopper." / "There are some crushed big bones in the bin." Empty: "The grinder is already empty." / "You need to wind the
 *   handle to grind the big bones." Winding an empty grinder only turns the handle.
 * Not captured: bones used on the loader while the hopper is full; they're wound like the handle.
 */
const Common = require("./Common.Ectofuntus");

const LEVEL = 1;
/** Where the player stands for each part, all facing north. */
const TILES = { load: [3660, 3524], wind: [3659, 3524], fill: [3658, 3524] };
const LOAD_SOUND = 1133;
const WIND_SOUND = 1131;
const FILL_SOUND = 1136;
const POUR_TICKS = 3;
/** Each part is used, and Status and Empty answer, two ticks after the player arrives. */
const FIRST_USE_TICKS = 2;
/** Client-side delays the sequence and synth of each part carry. */
const LOAD_DELAY = 5;
const WIND_DELAY = 10;
const FILL_DELAY = 5;

/**
 * Each part's action, and what follows it: the next part, the ticks until the player steps to
 * it and until they use it. An action returns false to end the round.
 */
const STAGES = {
  load: { action: load, next: "wind", walk: 3, use: 5 },
  wind: { action: wind, next: "fill", walk: 6, use: 8 },
  fill: { action: fill, next: "load", walk: 5, use: 7 },
};

function faceNorth(player, stage) {
  const [x, y] = TILES[stage];
  player.setPositionToFace(new Common.core.Location(x, y + 1, LEVEL));
}

/** The bone the hopper takes next: `preferred` if carried, else the first that grinds. */
function nextBone(player, preferred) {
  const inventory = player.getInventory();
  if (preferred && inventory.contains(preferred) && Common.bonemealFor(preferred)) return preferred;
  for (const item of inventory.getItems()) {
    const id = item?.getId?.() ?? -1;
    if (id > 0 && item.getAmount() > 0 && Common.bonemealFor(id)) return id;
  }
  return null;
}

function load(player, round) {
  if (Common.grinderStatus(player) === Common.GRINDER_BIN) {
    player.sendMessage("You need to empty the grinder's bin before you put more bones in it.");
    return false;
  }
  const boneId = nextBone(player, round.bone);
  if (!boneId) return false;
  round.bone = boneId;
  player.getInventory().deleteNumber(boneId, 1);
  faceNorth(player, "load");
  Common.animate(player, "ahoy_bone_dump", LOAD_DELAY);
  Common.sound(player, LOAD_SOUND, LOAD_DELAY);
  Common.spam(player, `You put some ${Common.boneName(boneId)} in the grinder's hopper.`);
  Common.setGrinder(player, Common.GRINDER_HOPPER, boneId);
  return true;
}

function wind(player, round) {
  faceNorth(player, "wind");
  Common.animate(player, "ahoy_bone_grind", WIND_DELAY);
  Common.sound(player, WIND_SOUND, WIND_DELAY);
  Common.spam(player, "You wind the grinder handle.");
  if (Common.grinderStatus(player) !== Common.GRINDER_HOPPER) return false;
  round.pourAt = round.tick + POUR_TICKS;
  return true;
}

function pour(player) {
  const boneId = Common.grinderBone(player);
  Common.spam(player, `Some crushed ${Common.boneName(boneId)} pour into the bin.`);
  Common.setGrinder(player, Common.GRINDER_BIN, boneId);
}

function fill(player, round) {
  if (Common.grinderStatus(player) !== Common.GRINDER_BIN) return false;
  const boneId = Common.grinderBone(player);
  const inventory = player.getInventory();
  const { ItemIdentifiers } = Common.core;
  if (!inventory.contains(ItemIdentifiers.POT)) {
    player.sendMessage(`You need an empty pot to put the crushed ${Common.boneName(boneId)} into.`);
    return false;
  }
  faceNorth(player, "fill");
  inventory.deleteNumber(ItemIdentifiers.POT, 1);
  inventory.adds(Common.bonemealFor(boneId), 1);
  Common.animate(player, "ahoy_fillbucket_bonedust", FILL_DELAY);
  Common.sound(player, FILL_SOUND, FILL_DELAY);
  Common.spam(player, `You fill a pot with crushed ${Common.boneName(boneId)}.`);
  Common.setGrinder(player, Common.GRINDER_EMPTY, 0);
  round.bone ??= boneId;
  return nextBone(player, round.bone) !== null;
}

function walkTo(player, stage) {
  const [x, y] = TILES[stage];
  const at = player.getLocation();
  if (at.getX() === x && at.getY() === y) return;
  player.getMovementQueue().addSteps(new Common.core.Location(x, y, LEVEL));
}

/** Runs the round from `stage`, using it two ticks after the click, as the server answers it. */
function grind(player, stage, bone = null) {
  faceNorth(player, stage);
  const round = { stage, bone, tick: 0, useAt: FIRST_USE_TICKS, walkAt: -1, pourAt: -1 };
  Common.run(player, (tick) => {
    round.tick = tick;
    if (tick === round.pourAt) pour(player);
    if (tick === round.walkAt) walkTo(player, round.stage);
    if (tick !== round.useAt) return true;
    const current = STAGES[round.stage];
    if (!current.action(player, round)) return round.pourAt > tick;
    round.stage = current.next;
    round.walkAt = tick + current.walk;
    round.useAt = tick + current.use;
    return true;
  });
}

function useOnLoader(event) {
  const { player, objectId, itemId } = event;
  if (objectId !== Common.core.ObjectIdentifiers.LOADER || !Common.bonemealFor(itemId)) return;
  event.handled = true;
  if (Common.grinderStatus(player) === Common.GRINDER_HOPPER) grind(player, "wind");
  else grind(player, "load", itemId);
}

function windHandle({ player }) {
  grind(player, "wind");
}

/** Answers a Status or Empty click two ticks later, unless a walk or click cancels it. */
function answer(player, respond) {
  Common.run(player, (tick) => {
    if (tick < FIRST_USE_TICKS) return true;
    respond();
    return false;
  });
}

function status({ player }) {
  answer(player, () => statusMessage(player));
}

function statusMessage(player) {
  const boneId = Common.grinderBone(player);
  switch (Common.grinderStatus(player)) {
    case Common.GRINDER_HOPPER:
      player.sendMessage(`There are some ${Common.boneName(boneId)} in the hopper.`);
      break;
    case Common.GRINDER_BIN:
      player.sendMessage(`There are some crushed ${Common.boneName(boneId)} in the bin.`);
      break;
    default:
      player.sendMessage("The grinder is empty.");
  }
}

function emptyBin({ player, objectId }) {
  if (objectId !== Common.core.ObjectIdentifiers.BIN) return false;
  const boneId = Common.grinderBone(player);
  switch (Common.grinderStatus(player)) {
    case Common.GRINDER_HOPPER:
      answer(player, () => player.sendMessage(`You need to wind the handle to grind the ${Common.boneName(boneId)}.`));
      break;
    case Common.GRINDER_BIN:
      grind(player, "fill");
      break;
    default:
      answer(player, () => player.sendMessage("The grinder is already empty."));
  }
  return true;
}

module.exports = function attachGrinder(api) {
  api.onItemOnObject(useOnLoader, { noted: false });
  api.onObjectInteraction("Bone grinder", { Wind: windHandle, Status: status });
  api.onObjectInteraction("Bin", { Empty: emptyBin });
  api.onItemOnObject("Pot", "Bin", emptyBin);
};
