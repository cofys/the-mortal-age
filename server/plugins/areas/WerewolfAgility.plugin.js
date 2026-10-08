/**
 * The Werewolf Agility Course's surroundings (the course itself is
 * plugins/skills/agility/courses/Werewolf.js):
 * - the trapdoor east of Canifis, opened and climbed down only with a ring of Charos worn, past
 *   its werewolf guard, and the ladder back up;
 * - the Agility Boss throwing the stick when a lap starts on the first stepping stone;
 * - the trainers' lines, and the with/without-ring Talk-To variants.
 * Sources: rsprox captures 366, 1849, 1858 (the trapdoor, the guard's lines, the stick's
 * projectile) and the Wiki's transcripts. Where the stick lands and the tiles either side of the
 * trapdoor are guesses (docs/agility-courses.md).
 */
const Npc = Object.freeze({
  AGILITY_BOSS: 5924, // werewolf_trainer_start
  TRAINER: 5926, // werewolf_trainer_2
  STICK_TRAINER: 5927, // werewolf_trainer_stick
  GUARD: 5928, // waa_werewolf_guard
});
const Loc = Object.freeze({
  TRAPDOOR: 11636, // waa_trapdoor
  TRAPDOOR_OPEN: 11637, // waa_trapdoor_open
  LADDER: 11635, // waa_ladder
  STEPPING_STONE: 11643, // werewolf_steping_stone
  SKULL_SLOPE: 11641, // werewolf_skull_climb_1
  ZIP_LINES: [11644, 11645, 11646], // werewolf_slide_center, _side, _side_mirror
  OBSTACLES: [11638, 11639, 11640, 11657], // the hurdles and the pipe
});
const RINGS_OF_CHAROS = [4202, 6465]; // ring_of_charos, ring_of_charos_unlocked
const STICK = 4179; // waa_stick
const STICK_PROJECTILE = 338; // waa_stick_travel
const TRAPDOOR_SOUND = 91;

const FIRST_STONE = [3538, 9875];
const BELOW_TRAPDOOR = [3549, 9865, 0];
const ABOVE_LADDER = [3543, 3463, 0];
/** Beyond the pipes, where the Agility Boss's stick lands (Wiki); the tile is a guess. */
const STICK_AREA = { x: [3536, 3546], y: [9911, 9914] };
const STICK_FLIGHT_TICKS = 5;

const GUARD_WELCOME = "Good luck down there, my friend. Remember, to the west is the main agility course, while to the east is a skullball course.";
const GUARD_REFUSAL = "You can't go down there, human. If it wasn't my duty to guard this trapdoor, I would be relieving you of the burden of your life right now.";

/** The trainers' overhead lines (Wiki transcript, Agility Trainer). */
const LINES = Object.freeze({
  obstacle: [
    "Remember - a slow wolf is a hungry wolf!!",
    "Get on with it - you need your whiskers perking!!!!",
    "Claws first - think later.",
    "Imagine the smell of blood in your nostrils!!!",
    "I never really wanted to be an agility trainer...",
    "It'll be worth it when you hunt!!",
    "Let's see those powerful backlegs at work!!",
    "Let the bloodlust take you!!",
    "You're the slowest wolf I've ever had the misfortune to witness!!",
    "When you're done there's a human with your name on it!!",
  ],
  obstacleHuman: ["You shouldn't even be here, human!"],
  zipLine: ["Give my regards to the ground...", "Don't let the spikes or the blood put you off...", "Now for a true test of teeth..."],
  zipLineHuman: ["Let's see how strong human teeth are..."],
  forgotStick: "You idiot - you've forgotten the stick!!!!",
  fetch: "FETCH!!!!!",
  stickNotHandedIn: "Why didn't you hand the stick over?!!?",
  yell: "WAAAAAARRRGGGHHHH!!!!!!",
});

let pluginApi;
let core;

function wearsRing(player) {
  const ring = player.getEquipment().getItems()[core.Equipment.RING_SLOT];
  return !!ring && RINGS_OF_CHAROS.includes(ring.getId());
}

function hasStick(player) {
  return player.getInventory().getAmount(STICK) > 0;
}

function pick(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}

function guardSays(player, text) {
  const { DialogueChainBuilder, NpcDialogue, EndDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new NpcDialogue(0, Npc.GUARD, text), new EndDialogue(1)));
}

/** The nearest of the player's visible NPCs with `npcId`. */
function nearest(player, npcId) {
  const here = player.getLocation();
  let best = null;
  for (const npc of player.getLocalNpcs?.() ?? []) {
    if (npc?.getId?.() !== npcId) continue;
    if (!best || npc.getLocation().getDistance(here) < best.getLocation().getDistance(here)) best = npc;
  }
  return best;
}

function npcSays(player, npcId, text) {
  nearest(player, npcId)?.forceChat(text);
}

function replaceTrapdoor(object, id) {
  const { GameObject, Location, ObjectManager } = core;
  const location = object.getLocation();
  ObjectManager.deregister(object, true);
  ObjectManager.register(new GameObject(id, new Location(location.getX(), location.getY(), location.getZ()), object.getType(), object.getFace(), null), true);
}

/** Opening the trapdoor needs the ring as well (Wiki); without it the guard refuses. */
function openTrapdoor({ player, object, objectId }) {
  if (objectId !== Loc.TRAPDOOR) return false;
  if (!wearsRing(player)) {
    guardSays(player, GUARD_REFUSAL);
    return true;
  }
  player.getPacketSender().sendSoundEffect(TRAPDOOR_SOUND, 1, 0);
  player.sendMessage("The trapdoor opens...");
  replaceTrapdoor(object, Loc.TRAPDOOR_OPEN);
  return true;
}

function closeTrapdoor({ object, objectId }) {
  if (objectId !== Loc.TRAPDOOR_OPEN) return false;
  replaceTrapdoor(object, Loc.TRAPDOOR);
  return true;
}

/** The trapdoor and ladder are the Ladders plugin's names; these two go to fixed tiles. */
function claimClimb(request) {
  const { player, objectId } = request;
  if (objectId === Loc.TRAPDOOR_OPEN) {
    request.handled = true;
    if (!wearsRing(player)) {
      guardSays(player, GUARD_REFUSAL);
      return;
    }
    guardSays(player, GUARD_WELCOME);
    pluginApi.emitCustomEvent("ladders:climbDown", { player, destination: new core.Location(...BELOW_TRAPDOOR) });
  } else if (objectId === Loc.LADDER) {
    request.handled = true;
    pluginApi.emitCustomEvent("ladders:climbUp", { player, destination: new core.Location(...ABOVE_LADDER) });
  }
}

function randomStickTile() {
  const { x, y } = STICK_AREA;
  const between = ([low, high]) => low + Math.floor(Math.random() * (high - low + 1));
  return new core.Location(between(x), between(y), 0);
}

/** "I will throw your stick as soon as you jump onto the first stone." (the Agility Boss) */
function throwStick(player) {
  const boss = nearest(player, Npc.AGILITY_BOSS);
  if (hasStick(player)) {
    boss?.forceChat(LINES.stickNotHandedIn);
    return;
  }
  boss?.forceChat(LINES.fetch);
  const landing = randomStickTile();
  if (boss) {
    const { Projectile } = core;
    new Projectile(boss.getLocation(), landing, null, STICK_PROJECTILE, 30, 150, 40, 36, null).withAngle(10).withProgress(32).sendProjectile();
  }
  core.TaskManager.submit(new (class extends core.Task {
    constructor() { super(STICK_FLIGHT_TICKS, player, false); }
    execute() {
      this.stop();
      if (player.isRegistered?.()) {
        pluginApi.getItemOnGroundManager().registerNonGlobals(player, new core.Item(STICK, 1), landing);
      }
    }
  })());
}

/** The trainers react as each obstacle starts (Wiki transcripts). */
function onObstacleStart({ player, objectId, location }) {
  if (objectId === Loc.STEPPING_STONE) {
    if (location.x === FIRST_STONE[0] && location.y === FIRST_STONE[1]) throwStick(player);
    return;
  }
  const human = !wearsRing(player);
  if (Loc.ZIP_LINES.includes(objectId)) {
    npcSays(player, Npc.TRAINER, pick(human ? LINES.zipLineHuman : LINES.zipLine));
    player.forceChat(LINES.yell);
  } else if (objectId === Loc.SKULL_SLOPE && !hasStick(player)) {
    npcSays(player, Npc.TRAINER, LINES.forgotStick);
  } else if (objectId === Loc.SKULL_SLOPE || Loc.OBSTACLES.includes(objectId)) {
    npcSays(player, Npc.TRAINER, pick(human ? LINES.obstacleHuman : LINES.obstacle));
  }
}

/** Talk-To: the Wiki transcripts' with/without ring of Charos variants. */
function selectVariant({ npcId, player }) {
  const ring = wearsRing(player);
  switch (npcId) {
    case Npc.GUARD:
    case Npc.TRAINER:
    case Npc.STICK_TRAINER:
      return ring ? "standard-dialogue-with-ring-of-charos" : "standard-dialogue-without-ring-of-charos";
    case Npc.AGILITY_BOSS:
      return ring ? "standard-dialogue" : "when-not-wearing-the-ring-of-charos";
    default:
      return null;
  }
}

function init(api) {
  pluginApi = api;
  core = api.core;
}

module.exports = {
  name: "WerewolfAgility",
  members: true,
  register(api) {
    init(api);
    api.onObjectInteraction("Trapdoor", { Open: openTrapdoor, Close: closeTrapdoor });
    api.onCustomEvent("ladders:climb", claimClimb);
    api.onCustomEvent("agility:obstacle-start", onObstacleStart);
    api.onNpcDialogueVariant(selectVariant);
  },
};
