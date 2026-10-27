/**
 * Tai Bwo Wannai Cleanup: the gem rocks a hack can uncover (village_gem_rock1-3). The Wiki: 40
 * Mining and a pickaxe, 65 XP a gem, three gems (opal 60, jade 30, red topaz 15, sapphire 9, emerald
 * 5, ruby 5, diamond 4, out of 128) and it's gone; a charged amulet of glory triples the chance as at
 * other gem rocks. rsprox 231/03030 shows other players' rocks going 1 -> 2 -> 3 -> the jungle cut
 * back, and the normal gem rocks' "You swing your pick at the rock." / "You just mined an Opal!".
 * The chance per swing is ours (no source gives it): 28 to 70 out of 256 over Mining 1-99, the
 * swings at the pickaxe's own interval from the Mining plugin ("mining:best-pickaxe").
 */
const Common = require("./Common.TaiBwoWannaiCleanup");
const Locs = require("./Locs.TaiBwoWannaiCleanup");
const Events = require("./Events.TaiBwoWannaiCleanup");

/** By player: { location, pickaxe, tick }. */
const sessions = new Map();

const gem = () => Common.data.events.gem;
const rockIds = () => gem().locs.map(Common.locId);

function bestPickaxe(player) {
  const request = { player, pickaxe: null };
  Common.api.emitCustomEvent("mining:best-pickaxe", request);
  return request.pickaxe;
}

function wearsChargedGlory(player) {
  const neck = player.getEquipment().getItems()[Common.core.Equipment.AMULET_SLOT];
  const name = neck ? Common.core.CacheDefinitions.getItem(neck.getId())?.name ?? "" : "";
  return /^Amulet of (glory.*\((t?\d|inf)\)|eternal glory)$/i.test(name);
}

function chance(player) {
  const level = Common.level(player, "MINING");
  const lerp = (gem().low * (99 - level) + gem().high * (level - 1)) / 98;
  return Math.min(1, (lerp / 256) * (wearsChargedGlory(player) ? 3 : 1));
}

function rollGem() {
  const total = gem().table.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.floor(Math.random() * total);
  for (const entry of gem().table) {
    roll -= entry[1];
    if (roll < 0) return entry;
  }
  return gem().table[0];
}

function stop(player) {
  if (!sessions.delete(player)) return;
  player.performAnimation(Common.core.Animation.DEFAULT_RESET_ANIMATION);
}

function mine(event) {
  const { player, object } = event;
  if (!rockIds().includes(object.getId())) return false;
  event.handled = true;
  if (Common.level(player, "MINING") < gem().level) {
    player.sendMessage(gem().levelMessage);
    return true;
  }
  const pickaxe = bestPickaxe(player);
  if (!pickaxe) {
    player.sendMessage(gem().noPickaxe);
    return true;
  }
  if (player.getInventory().getFreeSlots() <= 0) {
    player.sendMessage(gem().full);
    return true;
  }
  Common.stopActions(player);
  sessions.set(player, { location: object.getLocation().clone(), pickaxe, tick: 0 });
  player.setPositionToFace(object.getLocation());
  player.sendMessage(gem().swing);
  return true;
}

function step(player, session) {
  const rock = Locs.find(rockIds(), session.location);
  if (!rock) return stop(player);
  const interval = Math.max(1, session.pickaxe.attemptIntervalTicks ?? 4);
  if (session.tick++ % interval === 0) player.performAnimation(session.pickaxe.animation);
  if (session.tick % interval !== 0 || Math.random() >= chance(player)) return;
  const [item, , name] = rollGem();
  const gemItem = new Common.core.Item(Common.objId(item), 1);
  // The bag may have filled since the last swing (a pickup): stop with the gem still in the rock.
  if (player.getInventory().getAddableAmount(gemItem) < 1) {
    player.sendMessage(gem().full);
    stop(player);
    return;
  }
  player.getInventory().add(gemItem);
  Common.xp(player, "MINING", gem().xp);
  player.sendMessage(gem().mined.replace("{gem}", name));
  const next = rockIds().indexOf(rock.getId()) + 1;
  const jungle = Events._finders.get(`${rock.getLocation().getX()},${rock.getLocation().getY()},${rock.getLocation().getZ()}`)?.jungle ?? Common.data.jungle[0];
  if (next < rockIds().length) {
    Locs.swap(rock, rockIds()[next], gem().lifeTicks, Common.locId(jungle.locs[0]));
  } else {
    Locs.swap(rock, Common.locId(jungle.locs[4]), Common.data.hack.regrowTicks, Common.locId(jungle.locs[0]));
    stop(player);
    return;
  }
  if (player.getInventory().getFreeSlots() <= 0) {
    player.sendMessage(gem().full);
    stop(player);
  }
}

function process() {
  for (const [player, session] of [...sessions]) {
    if (session.paused) continue;
    if (Common.interrupted(player, session.location)) {
      stop(player);
      continue;
    }
    step(player, session);
  }
}

function pause(event) {
  Common.pauseOnLevelUp(event, sessions, stop);
}

function forget({ player }) {
  sessions.delete(player);
}

function attachGemRock(api) {
  const { CacheDefinitions, Task, TaskManager } = Common.core;
  api.onObjectInteraction(CacheDefinitions.getObject(rockIds()[0]).name, { Mine: mine });
  Common.onStop(stop);
  api.onPlayerLogout(forget);
  api.onCustomEvent("level-up:popup-opened", pause);
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(1, "tai-bwo-wannai-cleanup:gem-rocks", false);
    }
    execute() {
      process();
    }
  })());
}

module.exports = { attachGemRock, mine, chance, rollGem, process, stop, _sessions: sessions };
