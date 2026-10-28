// Lost supplies (rsprox, every trial): crates on the course, sailed past with no click. The crate
// goes as the boat's centre comes within about 4 tiles (4-8 seen, with the boat moving 1-3 tiles a
// tick): its objective varbit 1->0, the crate thrown to the player (3497), sound 10703 and the
// trial's XP for it (15, 25, 35). In the Tempor Tantrum a crate holds an oak plank sawmill coupon
// about 1 time in 7.5 ("You find something inside the crate: Sawmill coupon (oak plank)!").
// Objective k's crate is the trial's k-th collectable loc in the cache map.
const common = require("./Common.BarracudaTrials");

const PICKUP_RANGE = 4;
const PROJECTILE_CRATE = 3497;
const SOUND_CRATE = 10703;
/** Path samples between last tick's position and this one (a fast boat moves up to 3 tiles). */
const PATH_SAMPLES = 4;

/** The tiles the boat's centre passed this tick. */
function pathTiles(boat) {
  const tiles = [];
  for (let i = 0; i <= PATH_SAMPLES; i++) {
    const fineX = boat.prevFineX + ((boat.fineX - boat.prevFineX) * i) / PATH_SAMPLES;
    const fineY = boat.prevFineY + ((boat.fineY - boat.prevFineY) * i) / PATH_SAMPLES;
    tiles.push([Math.floor(fineX / 128), Math.floor(fineY / 128)]);
  }
  return tiles;
}

function inReach(tiles, crate) {
  return tiles.some(([x, y]) => Math.max(Math.abs(x - crate.x), Math.abs(y - crate.y)) <= PICKUP_RANGE);
}

function collect(player, run, boat) {
  if (run.remaining.size === 0) return;
  const crates = common.crateTiles(run.trial);
  const tiles = pathTiles(boat);
  for (const k of [...run.remaining]) {
    const crate = crates[k];
    if (!crate || !inReach(tiles, crate)) continue;
    take(player, run, k, crate);
  }
}

function take(player, run, k, crate) {
  const { Location, Skill, Item, ChatType } = common.core();
  const out = player.getPacketSender();
  run.remaining.delete(k);
  run.crates++;
  out.sendVarbit(common.varbit(`sailing_bt_objective${k}`), 0);
  const to = common.core().BoatManager.rootLocation(player);
  out.sendProjectile(new Location(crate.x, crate.y, 0), to, 0, 60, PROJECTILE_CRATE, 5, 32, player, 0, 30, 10);
  out.sendSoundEffect(SOUND_CRATE, 1, 0);
  player.getSkillManager().addExperiences(Skill.SAILING, run.trial.crateXp);
  const coupon = run.trial.coupon;
  if (coupon && Math.random() < coupon.chance) {
    const name = common.core().CacheDefinitions.getItem(coupon.item)?.name ?? "Sawmill coupon";
    out.sendTypedMessage(ChatType.SPAM, `You find something inside the crate: ${name}!`);
    player.getInventory().addItem(new Item(coupon.item, 1));
  }
}

function attach(api) {
  common.init(api);
}

module.exports = attach;
module.exports.collect = collect;
module.exports.pathTiles = pathTiles;
module.exports.PICKUP_RANGE = PICKUP_RANGE;
