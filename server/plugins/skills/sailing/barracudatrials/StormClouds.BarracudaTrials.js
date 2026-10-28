// The Storm Tempor's lightning clouds (rsprox, recordings 3457, 3461 and others): 61 clouds, each
// within 2 tiles of its spot, there for every sailor whether in a trial or not. A cloud grows
// (8876), charges (8877) 5 ticks later and strikes (13141) 4 ticks after that, charges again and
// strikes a second time 4 ticks later, then shrinks (8879); 19 ticks after growing it walks 1 to 4
// tiles, a tile a tick, and it grows again 31-35 ticks after it last did. A strike puts the strike
// NPC (15491) on the cloud's tile for 2 ticks; a boat under it: "A lightning strike reduces the
// speed of the boat!", 3 to 5 damage to the boat and sound 10700, all on the strike's tick.
// Ours: how close counts as under one (3 tiles from the boat's centre, about the hull: live hits
// came 2-7 tiles off the centre) and how long the slow lasts (5 ticks; half a tile a tick, live's most).
const common = require("./Common.BarracudaTrials");

const CLOUD = 15490;
const IGNORE_CLIPPING_FLAG = "movement:ignore-clipping";
const STRIKE = 15491;
const SEQ_GROW = 8876;
const SEQ_CHARGE = 8877;
const SEQ_SHRINK = 8879;
const SEQ_ATTACK = 13141;
const SOUND_STRIKE = 10700;
const DAMAGE = [3, 5];
const STRIKE_RANGE = 3;
const STRIKE_TICKS = 2;
/** A strike takes half a tile a tick off (rsprox 3457: at most that). */
const SLOW = -64;
const SLOW_TICKS = 5;
const WANDER = 2;
const WALK_AT = 19;
const WALK_STEPS = [1, 4];
const STRIKE_MESSAGE = "<col=ff3045>A lightning strike reduces the speed of the boat!";
/** The cycle from a growth: [tick, sequence, strikes]. */
const CYCLE = [[0, SEQ_GROW, false], [5, SEQ_CHARGE, false], [9, SEQ_ATTACK, true], [10, SEQ_CHARGE, false], [13, SEQ_ATTACK, true], [14, SEQ_SHRINK, false]];
const CYCLE_LENGTH = [31, 35];

let pluginApi;
const clouds = [];
/** Boats slowed by a strike: boat -> ticks left. */
const slowed = new Map();

function randomBetween([low, high]) {
  return low + Math.floor(Math.random() * (high - low + 1));
}

function spawnClouds() {
  const trial = common.trialByKey("tempor_tantrum");
  const { Location } = common.core();
  for (const [x, y] of trial.stormClouds ?? []) {
    const npc = pluginApi.spawnNpc({ id: CLOUD, x, y, z: 0 });
    if (!npc) continue;
    npc.setFlag?.(common.core().NPC.WALK_THROUGH_ENTITIES_FLAG, true);
    // Clouds walk over the sea, which is blocked to anything else on foot.
    npc.setFlag?.(IGNORE_CLIPPING_FLAG, true);
    clouds.push({ npc, home: new Location(x, y, 0), tick: 0, next: Math.floor(Math.random() * 35) });
  }
}

/** Boats (owned, in play) within reach of a tile, with their players. */
function boatsUnder(x, y) {
  const { BoatManager, World } = common.core();
  const found = [];
  for (const boat of BoatManager.all()) {
    if (boat.static || Math.max(Math.abs(boat.tileX - x), Math.abs(boat.tileY - y)) > STRIKE_RANGE) continue;
    const player = World.getPlayers().get(boat.ownerPlayerId);
    if (player && common.core().Sailing.instanceAboard(player) === boat) found.push({ boat, player });
  }
  return found;
}

function strike(cloud) {
  const at = cloud.npc.getLocation();
  const bolt = pluginApi.spawnNpc({ id: STRIKE, x: at.getX(), y: at.getY(), z: 0 });
  if (bolt) {
    const { CountdownTask, TaskManager } = common.core();
    TaskManager.submit(new CountdownTask(bolt, STRIKE_TICKS, () => pluginApi.removeNpc(bolt)));
  }
  for (const { boat, player } of boatsUnder(at.getX(), at.getY())) hit(player, boat);
}

function hit(player, boat) {
  player.sendMessage(STRIKE_MESSAGE);
  require("../ShipCombat.Sailing").damagePlayerBoat(player, randomBetween(DAMAGE));
  player.getPacketSender().sendSoundEffect(SOUND_STRIKE, 1, 0);
  boat.speedBonuses.set("lightning", SLOW);
  slowed.set(boat, SLOW_TICKS);
}

/** A walk of 1-4 tiles, a tile a tick, staying within 2 tiles of the cloud's spot. */
function walk(cloud) {
  const here = cloud.npc.getLocation();
  let x = here.getX();
  let y = here.getY();
  const queue = cloud.npc.getMovementQueue();
  for (let n = randomBetween(WALK_STEPS); n > 0; n--) {
    const options = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if ((dx || dy) && Math.abs(x + dx - cloud.home.getX()) <= WANDER && Math.abs(y + dy - cloud.home.getY()) <= WANDER) options.push([dx, dy]);
      }
    }
    const [dx, dy] = options[Math.floor(Math.random() * options.length)];
    x += dx;
    y += dy;
    queue.addSteps(new (common.core().Location)(x, y, 0));
  }
}

function tickClouds() {
  const { Animation } = common.core();
  for (const cloud of clouds) {
    if (!cloud.npc.isRegistered?.()) continue;
    cloud.tick++;
    const since = cloud.tick - cloud.next;
    if (since >= 0) {
      const step = CYCLE.find(([at]) => at === since);
      if (step) {
        cloud.npc.performAnimation(new Animation(step[1]));
        if (step[2]) strike(cloud);
      }
      if (since === WALK_AT) walk(cloud);
      if (since >= CYCLE_LENGTH[0]) cloud.next = cloud.tick + randomBetween(CYCLE_LENGTH) - since;
    }
  }
  for (const [boat, left] of [...slowed]) {
    if (left <= 1) {
      boat.speedBonuses.delete("lightning");
      slowed.delete(boat);
    } else slowed.set(boat, left - 1);
  }
}

function attach(api) {
  pluginApi = api;
  common.init(api);
  require("../ShipCombat.Sailing").attach(api);
  api.onServerStartup(startClouds);
}

function startClouds() {
  spawnClouds();
  const { Task, TaskManager } = common.core();
  TaskManager.submit(new (class extends Task {
    constructor() { super(1, "barracuda-trials:storm-clouds", false); }
    execute() { tickClouds(); }
  })());
}

module.exports = attach;
module.exports.hit = hit;
module.exports.strike = strike;
module.exports.STRIKE_MESSAGE = STRIKE_MESSAGE;
